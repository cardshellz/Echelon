import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalClaimDispatchBeforeCommit } from "../../application/inventory-availability-dispatch.port";
import { PostgresCanonicalClaimDispatchRepository } from "../../infrastructure/inventory-availability-dispatch.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../../wms/canonical-claim-dispatch-source";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { DISPATCH_TIME, dispatchPlan } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";
import { dispatchRuntimeFixtureSql, dispatchRuntimeSeedSql, dispatchRuntimeTables } from "../fixtures/inventory-availability-dispatch-runtime-fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migration = readFileSync(resolve(process.cwd(), "migrations/0662_inventory_availability_claim_dispatch.sql"), "utf8");

/**
 * Real PostgreSQL + actual0662 + actual dispatch store, domain and both owners.
 * Core tables are reduced real-query fixtures, not all prior migrations. The
 * mandatory beforeCommit seam is exercised for same-transaction/rollback proof;
 * it is NOT a fake claim of runtime publication, provider or full unpick wiring.
 */
describeDatabase.sequential("canonical dispatch connected PostgreSQL lifecycle", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  const command = () => dispatchPlan().command;
  const otherSource = () => ({ ...command(), outboundShipmentId: 91, sourceShipmentItemId: 102, idempotencyKey: "dispatch:91:102" });
  const store = (beforeCommit: CanonicalClaimDispatchBeforeCommit = async () => undefined) =>
    new PostgresCanonicalClaimDispatchRepository(pool, new WmsCanonicalClaimDispatchSourceOwner(),
      new PostgresCanonicalClaimInventoryRepository(), beforeCommit, () => DISPATCH_TIME);

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, dispatchRuntimeFixtureSql);
    pool = database.pool;
    await pool.query(migration);
  });
  beforeEach(async () => { await pool.query(dispatchRuntimeSeedSql); });
  afterAll(async () => { await database?.close(); });

  async function snapshot() {
    const result: Record<string, unknown[]> = {};
    for (const table of dispatchRuntimeTables) {
      // Names are a closed fixture constant, never user/provider input.
      result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY ${table.endsWith("availability_runtime_authority") ? "singleton_key" : "id"}`)).rows;
    }
    return result;
  }
  async function custody() {
    return {
      line: (await pool.query("SELECT picked_target_qty::text AS picked,consumed_target_qty::text AS consumed FROM inventory.availability_claim_lines WHERE id=20")).rows[0],
      resource: (await pool.query("SELECT picked_qty::text AS picked,consumed_qty::text AS consumed FROM inventory.availability_claim_resources WHERE id=30")).rows[0],
      lots: (await pool.query("SELECT id::text,picked_qty::text AS picked,consumed_qty::text AS consumed FROM inventory.availability_claim_lot_allocations ORDER BY id")).rows,
      level: (await pool.query("SELECT variant_qty,reserved_qty,picked_qty,packed_qty FROM inventory.inventory_levels WHERE id=60")).rows[0],
      physicalLots: (await pool.query("SELECT id,qty_on_hand,qty_reserved,qty_picked,qty_consumed FROM inventory.inventory_lots ORDER BY id")).rows,
    };
  }

  it("commits exact claim+lot picked-to-consumed custody and one ship journal, preserving original costs and lineage", async () => {
    const before = await snapshot();
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async ({ client, receipt, inventoryTransactionId }) => {
      expect(receipt.plan.quantity).toBe("5"); expect(inventoryTransactionId).toBe(1);
      expect((await client.query("SELECT count(*)::integer AS total FROM inventory.availability_claim_dispatch_receipts")).rows[0].total).toBe(1);
      expect((await pool.query("SELECT count(*)::integer AS total FROM inventory.availability_claim_dispatch_receipts")).rows[0].total).toBe(0);
      expect((await client.query("SELECT current_setting('transaction_isolation') AS isolation")).rows[0].isolation).toBe("serializable");
    });
    const result = await store(hook).dispatch(command());
    expect(hook).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ occurredAt: DISPATCH_TIME.toISOString(), plan: { quantity: "5", physicalOnHandDelta: "0", reservedQuantityDelta: "0", createsCogs: false } });
    expect(await custody()).toEqual({
      line: { picked: "0", consumed: "5" }, resource: { picked: "0", consumed: "5" },
      lots: [{ id: "40", picked: "0", consumed: "3" }, { id: "41", picked: "0", consumed: "2" }],
      level: { variant_qty: 10, reserved_qty: 4, picked_qty: 3, packed_qty: 2 },
      physicalLots: [{ id: 401, qty_on_hand: 4, qty_reserved: 1, qty_picked: 1, qty_consumed: 7 },
        { id: 402, qty_on_hand: 6, qty_reserved: 3, qty_picked: 0, qty_consumed: 8 },
        { id: 403, qty_on_hand: 0, qty_reserved: 0, qty_picked: 2, qty_consumed: 9 }],
    });
    const after = await snapshot();
    expect(after["inventory.availability_claim_pick_movements"]).toEqual(before["inventory.availability_claim_pick_movements"]);
    expect(after["oms.order_item_costs"]).toEqual(before["oms.order_item_costs"]);
    expect(after["inventory.availability_claim_dispatch_movements"]).toMatchObject([
      { pick_movement_id: "50", quantity: "3" }, { pick_movement_id: "51", quantity: "2" },
    ]);
    expect(after["inventory.availability_claim_dispatch_receipts"]).toHaveLength(1);
    expect(after["inventory.inventory_transactions"]).toMatchObject([{ transaction_type: "ship", variant_qty_delta: 0, shipment_item_id: 101 }]);
  });
  it("partially fulfills a claim through separate complete source shipments, never a repeated partial source", async () => {
    await pool.query("UPDATE wms.outbound_shipment_items SET qty=CASE id WHEN 101 THEN 3 ELSE 2 END");
    const repository = store();
    const first = await repository.dispatch({ ...command(), quantity: "3" });
    expect(first.plan).toMatchObject({ pickedTargetQtyAfter: "2", consumedTargetQtyAfter: "3", sourceRemainingQuantity: "0" });
    const second = await repository.dispatch({ ...otherSource(), quantity: "2" });
    expect(second.plan.resources[0].lots).toMatchObject([{ inventoryLotId: 402, picks: [{ pickMovementId: "51", quantity: "2" }] }]);
    expect((await custody()).line).toEqual({ picked: "0", consumed: "5" });
    expect((await pool.query("SELECT count(*)::integer AS total FROM inventory.inventory_transactions WHERE transaction_type='ship'")).rows[0].total).toBe(2);
  });
  it("replays the exact immutable result without repeating owner mutations or downstream hooks", async () => {
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async () => undefined);
    const repository = store(hook); const original = await repository.dispatch(command()); const once = await snapshot();
    expect(await repository.dispatch(command())).toEqual(original);
    expect(await snapshot()).toEqual(once); expect(hook).toHaveBeenCalledOnce();
  });
  it.each(["actor", "reason", "quantity", "sourceShipmentItemId"] as const)("rejects idempotency-key reuse with different %s", async (field) => {
    const repository = store(); await repository.dispatch(command()); const once = await snapshot();
    const changed = { ...command(), [field]: field === "sourceShipmentItemId" ? 102 : field === "quantity" ? "4" : "another-value" };
    await expect(repository.dispatch(changed)).rejects.toMatchObject({ code: "CLAIM_DISPATCH_IDEMPOTENCY_CONFLICT" });
    expect(await snapshot()).toEqual(once);
  });
  it("rejects a new key for the same spent source without deducting unrelated picked units", async () => {
    const repository = store(); await repository.dispatch(command()); const once = await snapshot();
    await expect(repository.dispatch({ ...command(), idempotencyKey: "different-key" })).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_ALREADY_DISPATCHED" });
    expect(await snapshot()).toEqual(once);
  });
  it("blocks new dispatch while legacy authority is active", async () => {
    await pool.query("UPDATE inventory.availability_runtime_authority SET authority='legacy',activation_run_id=NULL");
    const before = await snapshot(); await expect(store().dispatch(command())).rejects.toMatchObject({ code: "CANONICAL_AUTHORITY_NOT_ACTIVE" });
    expect(await snapshot()).toEqual(before);
  });
  it.each(["order_hold", "source_hold", "label_only", "missing_bin", "nonshipping"])("blocks unauthorized real WMS evidence: %s", async (kind) => {
    const changes: Record<string, string> = {
      order_hold: "UPDATE wms.orders SET on_hold=1", source_hold: "UPDATE wms.outbound_shipments SET held=true",
      label_only: "UPDATE wms.outbound_shipments SET status='labeled'", missing_bin: "UPDATE wms.outbound_shipment_items SET from_location_id=NULL",
      nonshipping: "UPDATE wms.order_items SET requires_shipping=0",
    };
    await pool.query(changes[kind]); const before = await snapshot();
    await expect(store().dispatch(command())).rejects.toMatchObject({ code: expect.stringMatching(/^WMS_DISPATCH_/) });
    expect(await snapshot()).toEqual(before);
  });
  it("rejects legacy ship evidence before attaching a canonical receipt or another physical deduction", async () => {
    await pool.query("INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,shipment_id,shipment_item_id,order_id,order_item_id) VALUES('ship',-5,90,101,70,71)");
    const before = await snapshot(); await expect(store().dispatch(command())).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_ALREADY_POSTED" });
    expect(await snapshot()).toEqual(before);
  });
  it("rolls back all owner state, claim counters, journal, command and events if downstream composition fails", async () => {
    const before = await snapshot();
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async () => { throw new Error("publication owner failed"); });
    await expect(store(hook).dispatch(command())).rejects.toThrow("publication owner failed");
    expect(hook).toHaveBeenCalledOnce(); expect(await snapshot()).toEqual(before);
    await expect(store().dispatch(command())).resolves.toMatchObject({ plan: { quantity: "5" } });
  });
  it("a real deferred0662 integrity failure at COMMIT rolls back all earlier stock and claim changes", async () => {
    const before = await snapshot();
    await expect(store(async ({ client }) => {
      await client.query("INSERT INTO inventory.availability_claim_pick_movements VALUES(52,10,20,30,40,401,301,'unpick',1,50)");
      await client.query("INSERT INTO inventory.availability_claim_dispatch_movements(receipt_id,claim_id,claim_line_id,pick_movement_id,quantity) SELECT id,claim_id,claim_line_id,52,1 FROM inventory.availability_claim_dispatch_receipts");
    }).dispatch(command())).rejects.toMatchObject({ code: "23514" });
    expect(await snapshot()).toEqual(before);
  });
  it("binds real physical shipment identity and refuses to infer it from a source's label", async () => {
    await pool.query("INSERT INTO wms.physical_shipments VALUES(700,'shipped'); INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,legacy_wms_shipment_item_id,wms_order_item_id,product_variant_id,quantity_shipped) VALUES(701,700,101,71,105,5)");
    const before = await snapshot(); await expect(store().dispatch(command())).rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CONFLICT" });
    expect(await snapshot()).toEqual(before);
    const receipt = await store().dispatch({ ...command(), physicalShipmentId: "700", physicalShipmentItemId: "701" });
    expect(receipt.plan.command.physicalShipmentItemId).toBe("701");
  });
  it("retains corrected physical history as a blocker instead of silently accepting its positive base quantity", async () => {
    await pool.query("INSERT INTO wms.physical_shipments VALUES(700,'shipped'); INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,legacy_wms_shipment_item_id,wms_order_item_id,product_variant_id,quantity_shipped) VALUES(701,700,101,71,105,5); INSERT INTO wms.physical_shipment_item_quantity_adjustments VALUES(1,701)");
    const before = await snapshot();
    await expect(store().dispatch({ ...command(), physicalShipmentId: "700", physicalShipmentItemId: "701" }))
      .rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CORRECTION" }); expect(await snapshot()).toEqual(before);
  });
  it("serializes two real source commands competing for one exact picked claim without double spending", async () => {
    let releaseWinner!: () => void; let reachedHook!: () => void;
    const release = new Promise<void>((resolve) => { releaseWinner = resolve; });
    const arrived = new Promise<void>((resolve) => { reachedHook = resolve; });
    const winner = store(async () => { reachedHook(); await release; }).dispatch(command());
    let contender: ReturnType<PostgresCanonicalClaimDispatchRepository["dispatch"]> | undefined;
    let observed: Promise<unknown> | undefined;
    try {
      await arrived;
      contender = store().dispatch(otherSource());
      observed = contender.then((value) => ({ value }), (error: unknown) => ({ error }));
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const row = (await pool.query("SELECT count(*)::integer AS total FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0];
        if (row.total > 0) { blocked = true; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      releaseWinner(); await winner;
      expect(await observed).toMatchObject({ error: { code: "CLAIM_DISPATCH_PICKED_SHORTFALL" } });
      expect((await custody()).line).toEqual({ picked: "0", consumed: "5" });
      expect((await pool.query("SELECT count(*)::integer AS total FROM inventory.availability_claim_dispatch_receipts")).rows[0].total).toBe(1);
      expect((await pool.query("SELECT count(*)::integer AS total FROM inventory.inventory_transactions WHERE transaction_type='ship'")).rows[0].total).toBe(1);
    } finally { releaseWinner(); await winner; await observed; }
  });
});
