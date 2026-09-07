import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { interpretInventoryShipmentQuantity } from "@shared/inventory/shipment-quantity";
import { shipmentQuantityEvidenceProjection } from "../../infrastructure/shipment-quantity-evidence.sql";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";
import { PostgresCanonicalClaimDispatchRepository } from "../../../inventory-planning/infrastructure/inventory-availability-dispatch.repository";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../../wms/canonical-claim-dispatch-source";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../fixtures/inventory-cutover-database";
import { DISPATCH_TIME, dispatchPlan } from "../fixtures/canonical-claim-dispatch";
import {
  dispatchRuntimeFixtureSql,
  dispatchRuntimeSeedSql,
  dispatchRuntimeTables,
} from "../../../inventory-planning/__tests__/fixtures/inventory-availability-dispatch-runtime-fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migration = readFileSync(resolve(process.cwd(), "migrations/0662_inventory_availability_claim_dispatch.sql"), "utf8");
const dialect = new PgDialect();

/**
 * Actual PostgreSQL projection + interpreter, actual0662 dispatch migration and
 * actual dispatch repository/owners. Earlier tables are reduced real-column
 * prerequisites, not a replay of every historical migration or provider flow.
 * Invalid deferred journals are inspected only inside disposable uncommitted
 * transactions and are then rejected by actual0662, without disabling triggers.
 */
describeDatabase.sequential("shipment quantity evidence PostgreSQL read contract", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable,
      `${dispatchRuntimeFixtureSql}\nALTER TABLE inventory.inventory_transactions ADD COLUMN voided_at timestamp;`);
    pool = database.pool;
    await pool.query(migration);
  });
  beforeEach(async () => {
    await pool.query(dispatchRuntimeSeedSql);
    await pool.query("UPDATE wms.outbound_shipment_items SET qty=3 WHERE id=101");
  });
  afterAll(async () => { await database?.close(); });

  async function snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    for (const table of dispatchRuntimeTables) {
      // Closed, imported fixture identifiers; no caller-supplied SQL identifier.
      const orderBy = table.endsWith("availability_runtime_authority") ? "singleton_key" : "id";
      result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy}`)).rows;
    }
    return result;
  }

  async function readEvidence(client: PoolClient, transactionId: number) {
    const query = dialect.sqlToQuery(sql`
      SELECT ${shipmentQuantityEvidenceProjection(sql.identifier("shipment_tx"))} AS evidence,
             shipment_tx.voided_at AS "voidedAt"
      FROM inventory.inventory_transactions AS shipment_tx
      WHERE shipment_tx.id = ${transactionId}
    `);
    const rows = (await client.query<{ evidence: unknown; voidedAt: Date | null }>(query.sql, query.params)).rows;
    expect(rows).toHaveLength(1);
    return { ...rows[0], interpreted: interpretInventoryShipmentQuantity(rows[0].evidence) };
  }

  async function readFromPool(transactionId = 1) {
    const client = await pool.connect();
    try { return await readEvidence(client, transactionId); }
    finally { client.release(); }
  }

  async function createCanonicalShipment(): Promise<void> {
    const repository = new PostgresCanonicalClaimDispatchRepository(pool,
      new WmsCanonicalClaimDispatchSourceOwner(), new PostgresCanonicalClaimInventoryRepository(),
      async () => undefined, () => DISPATCH_TIME);
    await repository.dispatch({ ...dispatchPlan().command, quantity: "3" });
  }

  async function insertLegacyShipment(quantity = 4): Promise<void> {
    await pool.query(`INSERT INTO inventory.inventory_transactions (
      transaction_type, variant_qty_delta, order_id, order_item_id, shipment_id, shipment_item_id,
      product_variant_id, from_location_id, reference_type, source_state, target_state
    ) VALUES ('ship',$1,70,71,90,101,105,50,'order','picked','shipped')`, [-quantity]);
  }

  it("reads three shipped units from an actual committed canonical receipt despite its zero on-hand delta", async () => {
    await createCanonicalShipment();
    const before = await snapshot();
    const result = await readFromPool();
    expect(result.evidence).toMatchObject({ variantQtyDelta: 0, reservedQtyDelta: 0,
      receipt: { quantity: "3", movementQuantity: "3", invalidMovementCount: "0" } });
    expect(result.interpreted).toEqual({ status: "verified", quantity: 3,
      source: "canonical_dispatch_receipt", receiptId: "1" });
    expect(await snapshot()).toEqual(before);
  });

  it("preserves valid legacy negative-delta quantities without inventing a canonical receipt", async () => {
    await insertLegacyShipment();
    const before = await snapshot();
    expect((await readFromPool()).interpreted).toEqual({ status: "verified", quantity: 4,
      source: "legacy_on_hand_delta", receiptId: null });
    expect(await snapshot()).toEqual(before);
  });

  it("executes one SELECT on a READ ONLY transaction with no follow-up query or state mutation", async () => {
    await createCanonicalShipment();
    const before = await snapshot();
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      const querySpy = vi.spyOn(client, "query");
      try {
        expect((await readEvidence(client, 1)).interpreted).toMatchObject({ status: "verified", quantity: 3 });
        expect(querySpy).toHaveBeenCalledOnce();
        expect(querySpy.mock.calls[0][0]).toEqual(expect.stringMatching(/^\s*SELECT\s/));
      } finally { querySpy.mockRestore(); }
      await client.query("COMMIT");
      inTransaction = false;
    } finally {
      if (inTransaction) await client.query("ROLLBACK");
      client.release();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a canonical marker without its receipt instead of trusting a legacy-looking debit", async () => {
    await insertLegacyShipment(3);
    await pool.query("UPDATE inventory.inventory_transactions SET reference_type='availability_claim_dispatch'");
    const before = await snapshot();
    expect((await readFromPool()).interpreted).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects a receipt whose inventory transaction has lost its canonical marker", async () => {
    await createCanonicalShipment();
    await pool.query("UPDATE inventory.inventory_transactions SET reference_type='order'");
    const before = await snapshot();
    expect((await readFromPool()).interpreted).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
    expect(await snapshot()).toEqual(before);
  });

  it("does not turn an unexplained zero-delta legacy shipment into verified zero demand", async () => {
    await insertLegacyShipment(0);
    expect((await readFromPool()).interpreted).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
  });

  it.each([
    ["order", "order_id=NULL"],
    ["order item", "order_item_id=NULL"],
    ["shipment", "shipment_id=91"],
    ["shipment item", "shipment_item_id=102"],
    ["variant", "product_variant_id=106"],
    ["source bin", "from_location_id=51"],
  ])("rejects receipt versus ledger %s identity mismatch", async (_label, assignment) => {
    await createCanonicalShipment();
    // Closed fixture mutations model corrupt historical ledger evidence, not an
    // authorized application repair and not a production mutation path.
    await pool.query(`UPDATE inventory.inventory_transactions SET ${assignment}`);
    const before = await snapshot();
    expect((await readFromPool()).interpreted).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["on-hand debit", "variant_qty_delta=-3"],
    ["reservation debit", "reserved_qty_delta=-3"],
    ["source state", "source_state='on_hand'"],
    ["target state", "target_state='packed'"],
    ["transaction kind", "transaction_type='pick'"],
  ])("rejects canonical receipt with incompatible %s", async (_label, assignment) => {
    await createCanonicalShipment();
    await pool.query(`UPDATE inventory.inventory_transactions SET ${assignment}`);
    expect((await readFromPool()).interpreted).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
  });

  it.each(["legacy", "canonical"] as const)("retains original %s shipment units while exposing void history separately", async (kind) => {
    if (kind === "canonical") await createCanonicalShipment();
    else await insertLegacyShipment(3);
    await pool.query("UPDATE inventory.inventory_transactions SET voided_at=$1", [DISPATCH_TIME]);
    const before = await snapshot();
    const result = await readFromPool();
    expect(result.voidedAt).toEqual(DISPATCH_TIME);
    expect(result.interpreted).toMatchObject({ status: "verified", quantity: 3 });
    expect(await snapshot()).toEqual(before);
  });

  it("holds the same quantity evidence in a REPEATABLE READ snapshot across a concurrent committed change", async () => {
    await insertLegacyShipment(3);
    const reader = await pool.connect();
    let inTransaction = false;
    try {
      await reader.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      expect((await readEvidence(reader, 1)).interpreted).toMatchObject({ status: "verified", quantity: 3 });
      await pool.query("UPDATE inventory.inventory_transactions SET variant_qty_delta=-7 WHERE id=1");
      const afterExplicitWriter = await snapshot();
      expect((await readEvidence(reader, 1)).interpreted).toMatchObject({ status: "verified", quantity: 3 });
      expect((await readFromPool()).interpreted).toMatchObject({ status: "verified", quantity: 7 });
      expect(await snapshot()).toEqual(afterExplicitWriter);
      await reader.query("COMMIT");
      inTransaction = false;
    } finally {
      if (inTransaction) await reader.query("ROLLBACK");
      reader.release();
    }
  });

  it.each([
    ["missing original-pick journal", "missing"],
    ["movement quantity mismatch", "quantity"],
    ["non-pick original movement", "kind"],
  ] as const)("rejects %s in the projection and the actual deferred migration constraint", async (_label, defect) => {
    const before = await snapshot();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await insertPendingReceipt(client, defect);
      const projected = await readEvidence(client, 1);
      expect(projected.interpreted).toMatchObject({ status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID" });
      if (defect === "kind") {
        expect(projected.evidence).toMatchObject({ receipt: { movementQuantity: "3", invalidMovementCount: "1" } });
      }
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await snapshot()).toEqual(before);
  });
});

/** Invalid evidence exists only until this test transaction is rolled back. */
async function insertPendingReceipt(client: PoolClient, defect: "missing" | "quantity" | "kind"): Promise<void> {
  await client.query(`INSERT INTO inventory.inventory_transactions (
    transaction_type,variant_qty_delta,reserved_qty_delta,order_id,order_item_id,shipment_id,shipment_item_id,
    product_variant_id,from_location_id,reference_type,source_state,target_state
  ) VALUES ('ship',0,0,70,71,90,101,105,50,'availability_claim_dispatch','picked','shipped')`);
  await client.query(`INSERT INTO inventory.availability_claim_commands (
    claim_id,order_id,command_type,idempotency_key,request_hash,result_hash,request_payload,result_payload,actor,reason,occurred_at
  ) VALUES (10,70,'dispatch','pending-invalid-journal',$1,$2,'{}','{}','fixture','Deferred integrity fixture',$3)`,
  ["a".repeat(64), "b".repeat(64), DISPATCH_TIME]);
  await client.query(`INSERT INTO inventory.availability_claim_dispatch_receipts (
    command_id,claim_id,claim_line_id,order_id,order_item_id,warehouse_id,warehouse_location_id,product_variant_id,
    outbound_shipment_id,source_shipment_item_id,quantity,inventory_transaction_id,occurred_at
  ) VALUES (1,10,20,70,71,1,50,105,90,101,3,1,$1)`, [DISPATCH_TIME]);
  if (defect === "missing") return;
  if (defect === "kind") {
    await client.query(`INSERT INTO inventory.availability_claim_pick_movements
      VALUES (52,10,20,30,40,401,301,'unpick',3,50)`);
  }
  await client.query(`INSERT INTO inventory.availability_claim_dispatch_movements
    (receipt_id,claim_id,claim_line_id,pick_movement_id,quantity) VALUES (1,10,20,$1,$2)`,
  [defect === "kind" ? 52 : 50, defect === "quantity" ? 2 : 3]);
}
