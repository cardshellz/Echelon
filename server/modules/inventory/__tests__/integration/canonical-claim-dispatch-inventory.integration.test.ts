import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../fixtures/inventory-cutover-database";
import { DISPATCH_TIME, dispatchOwnerFixtureSql, dispatchOwnerSeedSql, dispatchPlan } from "../fixtures/canonical-claim-dispatch";
import { ledgerRowToCellDeltas } from "../../reconcile/ledger-replay";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

/**
 * Real owner SQL, PostgreSQL row/advisory locks and current ship unique indexes.
 * Reduced named-schema fixture: does NOT claim end-to-end dispatch authority,
 * claim receipts/counters, runtime publication triggers or full migration proof.
 */
describeDatabase.sequential("canonical dispatch physical inventory PostgreSQL owner", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  const repository = new PostgresCanonicalClaimInventoryRepository();

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, dispatchOwnerFixtureSql);
    pool = database.pool;
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE inventory.inventory_transactions, oms.order_item_costs,
      inventory.inventory_lots, inventory.inventory_levels, wms.outbound_shipment_items,
      wms.outbound_shipments, wms.order_items, wms.orders,
      warehouse.warehouse_locations, warehouse.warehouses RESTART IDENTITY;
      ${dispatchOwnerSeedSql}`);
  });
  afterAll(async () => { await database?.close(); });

  async function snapshot() {
    return {
      levels: (await pool.query("SELECT * FROM inventory.inventory_levels ORDER BY id")).rows,
      lots: (await pool.query("SELECT * FROM inventory.inventory_lots ORDER BY id")).rows,
      costs: (await pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows,
      transactions: (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows,
    };
  }
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  const dispatch = (client: PoolClient) => repository.dispatchPickedResources({ client, plan: dispatchPlan(), occurredAt: DISPATCH_TIME });

  it("clears only picked custody on exact claim lots, retaining unrelated picked units, reservations, stock and COGS", async () => {
    const before = await snapshot();
    const result = await transaction(dispatch);
    const after = await snapshot();
    expect(result).toEqual({ inventoryTransactionId: 1, quantity: "5", pickedQuantityDelta: "-5", physicalOnHandDelta: "0", reservedQuantityDelta: "0" });
    expect(after.levels).toEqual([{ ...before.levels[0], picked_qty: 3, updated_at: DISPATCH_TIME }]);
    expect(after.lots).toEqual([{ ...before.lots[0], qty_picked: 1 }, { ...before.lots[1], qty_picked: 0 }, before.lots[2]]);
    expect(after.costs).toEqual(before.costs);
    expect(after.transactions).toHaveLength(1);
    expect(after.transactions[0]).toMatchObject({ id: 1, transaction_type: "ship", variant_qty_delta: 0,
      variant_qty_before: 10, variant_qty_after: 10, reserved_qty_delta: 0, source_state: "picked", target_state: "shipped",
      shipment_id: 90, shipment_item_id: 101, order_id: 70, order_item_id: 71,
      unit_cost_mills: null, total_cost_mills: null, inventory_lot_id: null, reference_type: "availability_claim_dispatch",
      reference_id: dispatchPlan().commandHash, created_at: DISPATCH_TIME });
    expect(ledgerRowToCellDeltas({ transactionType: "ship", variantQtyDelta: 0,
      productVariantId: 105, fromLocationId: 50, toLocationId: null })).toEqual([]);
  });
  it("leaves original immutable pick journal and cost lineage untouched", async () => {
    await pool.query(`INSERT INTO inventory.inventory_transactions
      (product_variant_id,from_location_id,transaction_type,variant_qty_delta,inventory_lot_id,order_id,order_item_id,reference_type,reference_id)
      VALUES(105,50,'pick',-3,401,70,71,'availability_claim_pick','claim:10:line:20:resource:30'),
            (105,50,'pick',-2,402,70,71,'availability_claim_pick','claim:10:line:20:resource:30')`);
    const before = await snapshot(); await transaction(dispatch); const after = await snapshot();
    expect(after.transactions.slice(0, 2)).toEqual(before.transactions); expect(after.costs).toEqual(before.costs);
    expect(after.transactions).toHaveLength(3);
  });
  it("rolls back exact lot, level and ship journal mutations when later receipt work fails, then permits retry", async () => {
    const before = await snapshot();
    await expect(transaction(async (client) => { await dispatch(client); throw new Error("receipt persistence failed"); }))
      .rejects.toThrow("receipt persistence failed");
    expect(await snapshot()).toEqual(before);
    await expect(transaction(dispatch)).resolves.toMatchObject({ quantity: "5" });
    expect((await snapshot()).transactions).toHaveLength(1);
  });
  it("fails closed on direct writer reentry instead of mutating another order's remaining picked custody", async () => {
    await transaction(dispatch); const once = await snapshot();
    await expect(transaction(dispatch)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_ALREADY_POSTED" });
    expect(await snapshot()).toEqual(once);
  });
  it.each(["exact_source", "legacy_without_source"])("rejects prior legacy ship evidence: %s", async (mode) => {
    await pool.query(`INSERT INTO inventory.inventory_transactions
      (transaction_type,variant_qty_delta,shipment_id,shipment_item_id,order_id,order_item_id)
      VALUES('ship',-5,90,$1,70,71)`, [mode === "exact_source" ? 101 : null]);
    const before = await snapshot();
    await expect(transaction(dispatch)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_ALREADY_POSTED" });
    expect(await snapshot()).toEqual(before);
  });
  it("never substitutes older unrelated picked lots when an exact claim lot is short", async () => {
    await pool.query("UPDATE inventory.inventory_lots SET qty_picked=1 WHERE id=402");
    const before = await snapshot();
    await expect(transaction(dispatch)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_PICKED_SHORTFALL" });
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a physically different warehouse even if the claim and source agree on the wrong warehouse tag", async () => {
    await pool.query("INSERT INTO warehouse.warehouses VALUES(2); UPDATE warehouse.warehouse_locations SET warehouse_id=2 WHERE id=50");
    const before = await snapshot();
    await expect(transaction(dispatch)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_LEVEL_IDENTITY_MISMATCH" });
    expect(await snapshot()).toEqual(before);
  });
  it("validates the entire original cost identity before mutations, without using newer current lot costs", async () => {
    await pool.query("UPDATE oms.order_item_costs SET inventory_lot_id=403 WHERE id=301");
    const before = await snapshot();
    await expect(transaction(dispatch)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_COST_IDENTITY_MISMATCH" });
    expect(await snapshot()).toEqual(before);
  });
  it("rolls back earlier mutations on a real journal FK failure", async () => {
    const plan = dispatchPlan(); plan.command.sourceShipmentItemId = 999;
    const before = await snapshot();
    await expect(transaction((client) => repository.dispatchPickedResources({ client, plan, occurredAt: DISPATCH_TIME })))
      .rejects.toMatchObject({ code: "23503" });
    expect(await snapshot()).toEqual(before);
  });
  it("serializes two commands for the same explicit source through real PostgreSQL fences", async () => {
    const first = await pool.connect(); const second = await pool.connect();
    let contender: Promise<unknown> | undefined;
    try {
      await first.query("BEGIN"); await second.query("BEGIN");
      await dispatch(first);
      let signal!: () => void;
      const reachedFence = new Promise<void>((resolve) => { signal = resolve; });
      contender = repository.dispatchPickedResources({
        client: { query: async (sql, values) => {
          if (sql.startsWith("SELECT pg_advisory")) signal();
          return second.query(sql, values);
        } }, plan: dispatchPlan(), occurredAt: DISPATCH_TIME,
      }).then((result) => ({ result }), (error: unknown) => ({ error }));
      await reachedFence;
      await first.query("COMMIT");
      expect(await contender).toMatchObject({ error: { code: "CLAIM_DISPATCH_SOURCE_ALREADY_POSTED" } });
      await second.query("ROLLBACK");
      const after = await snapshot();
      expect(after.levels[0].picked_qty).toBe(3); expect(after.transactions).toHaveLength(1);
    } finally {
      await first.query("ROLLBACK"); await contender; await second.query("ROLLBACK");
      first.release(); second.release();
    }
  });
  it("marks an exhausted active lot depleted without inventing a shipped or consumed counter", async () => {
    await pool.query("UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_reserved=0 WHERE id=402");
    await transaction(dispatch);
    expect((await pool.query("SELECT * FROM inventory.inventory_lots WHERE id=402")).rows[0])
      .toMatchObject({ qty_picked: 0, qty_consumed: 8, status: "depleted" });
  });
});
