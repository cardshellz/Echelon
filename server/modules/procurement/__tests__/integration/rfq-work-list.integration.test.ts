import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { listRequestForQuotes } from "../../purchasing-rfq.service";
import type { RfqWorkListDatabase } from "../../rfq-work-list.repository";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const tables = [schema.vendors, schema.vendorProducts, schema.purchaseRecommendationRuns, schema.purchaseRecommendationLines,
  schema.requestForQuotes, schema.requestForQuoteLines, schema.purchaseOrders, schema.purchaseOrderLines];
suite.sequential("RFQ work-list PostgreSQL paging and retained conversion evidence", () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle>;
  let ownsSchema = false;
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url)) throw new Error("Requires an explicitly disposable separate local database");
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 5, statement_timeout: 10000 });
    await pool.query("CREATE SCHEMA procurement"); ownsSchema = true;
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
    // Use the real immutable quote/link DDL and identity guards. The allocation
    // writer is outside this read-only owner's fixture and is tested separately.
    const migration = readFileSync(resolve(process.cwd(), "migrations/224_rfq_quote_revisions_and_purchase_links.sql"), "utf8");
    const start = migration.indexOf("CREATE TABLE procurement.rfq_quote_revisions");
    const end = migration.indexOf("-- Preserve the allocation guard");
    if (start < 0 || end <= start) throw new Error("RFQ quote/link migration boundary changed");
    await pool.query(migration.slice(start, end));
    database = drizzle(pool);
  });
  afterAll(async () => { try { if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE"); } finally { await pool?.end(); } });
  beforeEach(async () => {
    await pool.query(`TRUNCATE procurement.rfq_purchase_order_line_links,procurement.rfq_quote_revisions,${tables.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO procurement.vendors(id,code,name) VALUES(1,'MAIN','Current supplier'),(2,'OLD','Older supplier needle');
      INSERT INTO procurement.vendor_products(id,vendor_id,product_id,vendor_sku) VALUES(1,1,101,'MAIN-SKU'),(2,2,102,'OLD-VENDOR-SKU');
      INSERT INTO procurement.purchase_recommendation_runs(id,calculation_version,as_of,lookback_days,policy_snapshot) VALUES(1,'rfq-list','2026-10-21',90,'{}');
      INSERT INTO procurement.purchase_recommendation_lines(id,run_id,recommendation_key,product_id,sku,product_name,recommended_pieces,evidence_snapshot)
        SELECT n,1,'recommendation-'||n,100+n,'SKU-'||n,'Product '||n,10,'{}' FROM generate_series(1,205) n;
      INSERT INTO procurement.request_for_quotes(id,rfq_number,vendor_id,idempotency_key,request_hash,status,created_at,updated_at)
        SELECT n,'RFQ-'||n,CASE WHEN n=1 THEN 2 ELSE 1 END,'rfq-key-'||n,repeat('a',64),CASE WHEN n%2=0 THEN 'quoted' ELSE 'draft' END,'2026-10-21','2026-10-21' FROM generate_series(1,205) n;
      INSERT INTO procurement.request_for_quote_lines(id,rfq_id,recommendation_line_id,vendor_product_id,requested_pieces,status)
        SELECT n,n,n,CASE WHEN n=1 THEN 2 ELSE 1 END,10,CASE WHEN n%2=0 THEN 'quoted' ELSE 'draft' END FROM generate_series(1,205) n;
    `);
  });
  const list = (query: unknown = {}) => listRequestForQuotes(database, query);
  async function linkPurchase(rfqId: number, status = "draft") {
    const vendorId = rfqId === 1 ? 2 : 1;
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status) VALUES($1,$2,$3,$4)`, [rfqId, `PO-${rfqId}`, vendorId, status]);
    await pool.query(`INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,product_id,order_qty) VALUES($1,$1,1,$2,10)`, [rfqId, 100 + rfqId]);
    await pool.query(`INSERT INTO procurement.rfq_quote_revisions(id,rfq_id,rfq_line_id,revision,fingerprint,currency,quoted_pieces,quoted_unit_cost_mills,product_total_mills,pricing_remainder_mills,quote_data,created_by,created_at)
      OVERRIDING SYSTEM VALUE VALUES($1,$1,$1,1,repeat('b',64),'USD',10,100,1000,0,'{}','reviewer','2026-10-21')`, [rfqId]);
    await pool.query(`INSERT INTO procurement.rfq_purchase_order_line_links(rfq_id,rfq_line_id,quote_revision_id,purchase_order_id,purchase_order_line_id,quoted_pieces,quoted_unit_cost_mills,quote_reference,conversion_idempotency_key,created_by,created_at)
      VALUES($1,$1,$1,$1,$1,10,100,'Supplier quote','original-conversion','reviewer','2026-10-21')`, [rfqId]);
    await pool.query("UPDATE procurement.request_for_quote_lines SET status='ordered' WHERE id=$1", [rfqId]);
  }
  it("reaches all 205 records with tied timestamps and no duplicate/missing IDs", async () => {
    const ids: number[] = [];
    for (const offset of [0,100,200]) {
      const page = await list({ limit: 100, offset });
      expect(page.page).toEqual({ total: 205, limit: 100, offset, nextOffset: offset === 200 ? null : offset + 100 });
      expect(page.count).toBe(page.rfqs.length); ids.push(...page.rfqs.map(rfq => rfq.id));
    }
    expect(ids).toEqual(Array.from({ length: 205 }, (_, index) => 205-index));
  });
  it("applies stored-status and search filters before count and paging", async () => {
    const page = await list({ status: "quoted", limit: 100, offset: 100 });
    expect(page.page.total).toBe(102); expect(page.rfqs.map(rfq => rfq.id)).toEqual([4,2]); expect(page.statusCounts).toEqual({ quoted: 2 });
    expect((await list({ search: "OLDER supplier" })).rfqs.map(rfq => rfq.id)).toEqual([1]);
    expect((await list({ search: "OLD-VENDOR-SKU" })).rfqs.map(rfq => rfq.id)).toEqual([1]);
    expect((await list({ search: "sku-1", status: "quoted" })).rfqs.every(rfq => rfq.status === "quoted")).toBe(true);
    expect((await list({ search: "RFQ-205" })).rfqs.map(rfq => rfq.id)).toEqual([205]);
  });
  it("treats SQL wildcard and escape characters as literal search text", async () => {
    await pool.query("UPDATE procurement.purchase_recommendation_lines SET sku=$1 WHERE id=1", ["100%_literal\\path"]);
    expect((await list({ search: "%_" })).rfqs.map(rfq => rfq.id)).toEqual([1]);
    expect((await list({ search: "\\path" })).rfqs.map(rfq => rfq.id)).toEqual([1]);
    expect((await list({ search: "' OR 1=1 --" })).page.total).toBe(0);
    expect((await list({ search: "NO-MATCH" })).statusCounts).toEqual({});
  });
  it("retains the matching total when a requested page is past the end", async () => {
    expect(await list({ offset: 500 })).toMatchObject({ count: 0, statusCounts: {}, rfqs: [], page: { total: 205, limit: 25, offset: 500, nextOffset: null } });
  });
  it("uses immutable conversion links and preserves cancelled purchases without claiming active supply", async () => {
    await linkPurchase(2, "cancelled");
    const converted = (await list({ search: "RFQ-2", limit: 100 })).rfqs.find(rfq => rfq.id === 2)!;
    expect(converted.status).toBe("quoted"); expect(converted.handoff).toMatchObject({ state: "converted", linkedLineCount: 1, remainingLineCount: 0, purchaseOrders: [{ id: 2, poNumber: "PO-2", status: "cancelled" }] });
    await pool.query("INSERT INTO procurement.request_for_quote_lines(id,rfq_id,recommendation_line_id,vendor_product_id,requested_pieces,status) VALUES(999,2,3,1,10,'draft')");
    const partial = (await list({ search: "RFQ-2", limit: 100 })).rfqs.find(rfq => rfq.id === 2)!;
    expect(partial.handoff).toMatchObject({ state: "partially_converted", linkedLineCount: 1, remainingLineCount: 1 });
    await pool.query("UPDATE procurement.request_for_quotes SET status='cancelled' WHERE id=2; UPDATE procurement.request_for_quote_lines SET status='cancelled' WHERE id=999");
    expect((await list({ search: "RFQ-2", status: "cancelled" })).rfqs[0].handoff).toMatchObject({ state: "partially_converted", remainingLineCount: 0 });
  });
  it("does not infer conversion from an ordered line lacking retained evidence", async () => {
    await pool.query("UPDATE procurement.request_for_quote_lines SET status='ordered' WHERE id=205");
    expect((await list()).rfqs[0].handoff).toMatchObject({ state: "review_required", linkedLineCount: 0, purchaseOrders: [], issues: [{ code: "RFQ_ORDERED_LINE_UNVERIFIED" }] });
  });
  it("refuses a link whose purchase line now points to a different purchase order", async () => {
    await linkPurchase(205);
    await pool.query("INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status) VALUES(999,'PO-other',1,'draft'); UPDATE procurement.purchase_order_lines SET purchase_order_id=999 WHERE id=205");
    expect((await list()).rfqs[0].handoff).toMatchObject({ state: "review_required", linkedLineCount: 0, purchaseOrders: [] });
  });
  it("surfaces a cross-request line conflict on both affected RFQs", async () => {
    await linkPurchase(205);
    await pool.query("UPDATE procurement.request_for_quote_lines SET rfq_id=204 WHERE id=205");
    const result = await list();
    for (const id of [205,204]) expect(result.rfqs.find(rfq => rfq.id === id)!.handoff).toMatchObject({ state: "review_required", linkedLineCount: 0 });
  });
  it("keeps count, header, line and purchase-link reads coherent during a concurrent conversion", async () => {
    let changed = false;
    const interrupted: RfqWorkListDatabase = { transaction: (work, options) => database.transaction(tx => work({ execute: async query => {
      const result = await tx.execute(query);
      const text = new PgDialect().sqlToQuery(query).sql;
      if (!changed && text.includes('h.rfq_number AS "rfqNumber"')) {
        changed = true; await linkPurchase(205); await pool.query("UPDATE procurement.request_for_quotes SET status='quoted' WHERE id=205");
      }
      return result;
    } }), options) };
    const before = await listRequestForQuotes(interrupted);
    expect(changed).toBe(true); expect(before.page.total).toBe(205);
    expect(before.rfqs[0]).toMatchObject({ id: 205, status: "draft", lines: [{ status: "draft" }], handoff: { state: "not_started" } });
    expect((await list()).rfqs[0]).toMatchObject({ id: 205, status: "quoted", handoff: { state: "converted" } });
  });
  it("keeps count and page coherent when a concurrent matching row is removed", async () => {
    let changed = false;
    const interrupted: RfqWorkListDatabase = { transaction: (work, options) => database.transaction(tx => work({ execute: async query => {
      const result = await tx.execute(query);
      if (!changed && new PgDialect().sqlToQuery(query).sql.includes("count(*)")) {
        changed = true; await pool.query("DELETE FROM procurement.request_for_quote_lines WHERE rfq_id=205; DELETE FROM procurement.request_for_quotes WHERE id=205");
      }
      return result;
    } }), options) };
    const before = await listRequestForQuotes(interrupted);
    expect(changed).toBe(true); expect(before.page.total).toBe(205); expect(before.rfqs[0].id).toBe(205);
    expect((await list()).page.total).toBe(204);
  });
  it("fails closed instead of rounding legacy quoted bigint money", async () => {
    await pool.query("UPDATE procurement.request_for_quote_lines SET quoted_unit_cost_mills=9007199254740993 WHERE id=205");
    await expect(list()).rejects.toThrow();
  });
});
