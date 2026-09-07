import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { fixtureTable } from "./shipment-line-fixture";
import { recordCostRevision } from "../../cost-source-revision.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = Boolean(url) && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const NOW = new Date("2026-09-07T12:00:00.000Z");
const migration = readFileSync(resolve(process.cwd(), "migrations/222_procurement_cost_evidence.sql"), "utf8");

(enabled ? describe : describe.skip).sequential("cost evidence additive release foundation", () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle>;
  const owned: string[] = [];
  const input = (totalMills: number) => ({
    contractVersion: 1 as const, component: "product" as const,
    scope: { kind: "purchase_order_line" as const, purchaseOrderId: 10, purchaseOrderLineId: 21 },
    sources: [{ kind: "purchase_order_line" as const, documentId: 10, lineId: 21, version: "a".repeat(64) }],
    currency: "USD" as const, totalMills, basePieces: 100, evidence: "estimated" as const,
    packagingTreatment: "separate" as const, issue: null, manualOverride: null,
  });
  beforeAll(async () => {
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url!)) {
      throw new Error("Cost evidence tests require a separate explicitly disposable database");
    }
    pool = new pg.Pool({ connectionString: url, ssl: /localhost|127\.0\.0\.1/.test(url!) ? false : { rejectUnauthorized: false } });
    for (const name of ["procurement", "inventory"]) {
      await pool.query(`CREATE SCHEMA ${name}`); owned.push(name);
    }
    for (const table of [schema.purchaseOrders, schema.purchaseOrderLines, schema.inboundShipmentLines,
      schema.receivingOrders, schema.receivingLines, schema.vendorInvoiceLines, schema.inventoryLots]) {
      await pool.query(fixtureTable(table));
    }
    await pool.query(`
      ALTER TABLE procurement.receiving_lines DROP COLUMN cost_source_kind, DROP COLUMN cost_source_evidence;
      ALTER TABLE procurement.vendor_invoice_lines DROP COLUMN cost_component_evidence;
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id) VALUES(10,'FOUNDATION',5);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,sku,order_qty,unit_cost_cents,line_total_cents) VALUES(21,10,1,'FOUNDATION',100,100,10000);
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status) VALUES(40,'OLD-RECEIPT','purchase_order','closed');
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,sku,expected_qty,received_qty,unit_cost_mills) VALUES(51,40,'FOUNDATION',100,100,10000);
    `);
    await pool.query(migration);
    database = drizzle(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE procurement.cost_source_revisions RESTART IDENTITY CASCADE");
  });
  afterAll(async () => {
    if (!pool) return;
    try { for (const name of owned.reverse()) await pool.query(`DROP SCHEMA ${name} CASCADE`); }
    finally { await pool.end(); }
  });
  it("replays the additive migration without repricing or inventing historical evidence", async () => {
    const before = (await pool.query("SELECT * FROM procurement.receiving_lines WHERE id=51")).rows[0];
    await pool.query(migration);
    expect((await pool.query("SELECT * FROM procurement.receiving_lines WHERE id=51")).rows[0]).toEqual(before);
    expect(before).toMatchObject({ unit_cost_mills: "10000", cost_source_kind: null, cost_source_evidence: null });
    expect((await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_origins")).rows[0].count).toBe(0);
  });
  it("records the exact raw source and replays only the latest identical revision", async () => {
    const raw = { invoiceNumber: "SOURCE-1", productMills: "1000000" };
    const first = await database.transaction((tx) => recordCostRevision(tx, input(1_000_000), "operator", NOW, raw));
    const replay = await database.transaction((tx) => recordCostRevision(tx, input(1_000_000), "operator", NOW, raw));
    expect(replay).toEqual(first);
    expect((await pool.query("SELECT source_evidence,recorded_by,recorded_at FROM procurement.cost_source_revisions")).rows).toEqual([
      { source_evidence: raw, recorded_by: "operator", recorded_at: NOW },
    ]);
  });
  it("keeps A to B to A as three immutable economic revisions", async () => {
    for (const value of [10000, 11000, 10000]) await database.transaction((tx) => recordCostRevision(tx, input(value), "operator", NOW));
    expect((await pool.query("SELECT revision,contract->>'totalMills' AS total FROM procurement.cost_source_revisions ORDER BY id")).rows).toEqual([
      { revision: 1, total: "10000" }, { revision: 2, total: "11000" }, { revision: 3, total: "10000" },
    ]);
  });
  it("serializes concurrent retries to one source revision", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => database.transaction((tx) => recordCostRevision(tx, input(10000), "operator", NOW))));
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.cost_source_revisions")).rows[0].count).toBe(1);
  });
  it("rejects updates and deletes and rolls back a failed owning transaction", async () => {
    await database.transaction((tx) => recordCostRevision(tx, input(10000), "operator", NOW));
    await expect(pool.query("UPDATE procurement.cost_source_revisions SET recorded_by='replacement'")).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM procurement.cost_source_revisions")).rejects.toMatchObject({ code: "55000" });
    await expect(database.transaction(async (tx) => {
      await recordCostRevision(tx, input(11000), "operator", NOW);
      throw new Error("Injected owning transaction failure");
    })).rejects.toThrow("Injected owning transaction failure");
    expect((await pool.query("SELECT count(*)::int AS count FROM procurement.cost_source_revisions")).rows[0].count).toBe(1);
  });
});
