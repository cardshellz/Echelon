import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalClaimDispatchBeforeCommit } from "../../application/inventory-availability-dispatch.port";
import { PostgresCanonicalClaimDispatchRepository } from "../../infrastructure/inventory-availability-dispatch.repository";
import { PostgresCanonicalClaimDispatchSourceCommandResolver } from "../../infrastructure/inventory-availability-dispatch-source-command.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../../wms/canonical-claim-dispatch-source";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { DISPATCH_TIME, dispatchPlan } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";
import { dispatchRuntimeFixtureSql, dispatchRuntimeSeedSql } from "../fixtures/inventory-availability-dispatch-runtime-fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migration = readFileSync(resolve(process.cwd(), "migrations/0662_inventory_availability_claim_dispatch.sql"), "utf8");
function request() {
  const { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity, actor, reason } = dispatchPlan().command;
  return { orderId, orderItemId, outboundShipmentId, sourceShipmentItemId, productVariantId, quantity, actor, reason };
}

/** Actual resolver, WMS/inventory owners and0662 in a dedicated disposable database. */
describeDatabase.sequential("canonical source command preparation PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  const owner = new WmsCanonicalClaimDispatchSourceOwner();
  const resolver = new PostgresCanonicalClaimDispatchSourceCommandResolver(owner);
  const store = (hook: CanonicalClaimDispatchBeforeCommit = async () => undefined) =>
    new PostgresCanonicalClaimDispatchRepository(pool, owner, new PostgresCanonicalClaimInventoryRepository(), hook, () => DISPATCH_TIME);
  const dispatch = (input = request(), hook?: CanonicalClaimDispatchBeforeCommit) =>
    store(hook).dispatchPrepared((client) => resolver.resolve(client, input));
  const materialize = () => pool.query(`INSERT INTO wms.physical_shipments VALUES(700,'shipped');
    INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,legacy_wms_shipment_item_id,wms_order_item_id,product_variant_id,quantity_shipped)
    VALUES(701,700,101,71,105,5)`);

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, dispatchRuntimeFixtureSql);
    pool = database.pool; await pool.query(migration);
  });
  beforeEach(async () => { await pool.query(dispatchRuntimeSeedSql); });
  afterAll(async () => { await database?.close(); });
  async function state() {
    return {
      bins: (await pool.query("SELECT id,from_location_id FROM wms.outbound_shipment_items ORDER BY id")).rows,
      claim: (await pool.query("SELECT id::text,picked_target_qty::text,consumed_target_qty::text FROM inventory.availability_claim_lines ORDER BY id")).rows,
      levels: (await pool.query("SELECT id,variant_qty,picked_qty FROM inventory.inventory_levels ORDER BY id")).rows,
      receipts: (await pool.query("SELECT * FROM inventory.availability_claim_dispatch_receipts ORDER BY id")).rows,
      commands: (await pool.query("SELECT * FROM inventory.availability_claim_commands ORDER BY id")).rows,
    };
  }
  it("fills only a NULL source bin from exact picked lineage and dispatches in the same transaction", async () => {
    await pool.query("UPDATE wms.outbound_shipment_items SET from_location_id=NULL WHERE id=101");
    const receipt = await dispatch(request(), async ({ client }) => {
      expect((await client.query("SELECT from_location_id FROM wms.outbound_shipment_items WHERE id=101")).rows[0].from_location_id).toBe(50);
      expect((await pool.query("SELECT from_location_id FROM wms.outbound_shipment_items WHERE id=101")).rows[0].from_location_id).toBeNull();
    });
    expect(receipt.plan.command).toMatchObject({ claimId: "10", warehouseId: 1, warehouseLocationId: 50,
      physicalShipmentId: null, physicalShipmentItemId: null, idempotencyKey: "canonical-dispatch:source:101:v1" });
    expect((await state()).bins[0].from_location_id).toBe(50);
  });
  it.each([false, true])("replays original actor/reason and physical identity, physical first=%s", async (physicalFirst) => {
    if (physicalFirst) await materialize();
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async () => undefined);
    const original = await dispatch(request(), hook);
    if (!physicalFirst) await materialize();
    await pool.query("UPDATE wms.orders SET on_hold=1; UPDATE inventory.availability_runtime_authority SET authority='legacy',activation_run_id=NULL");
    const before = await state();
    expect(await dispatch({ ...request(), actor: "other-ingress-retry", reason: "Physical projection now exists" }, hook)).toEqual(original);
    expect(original.plan.command.physicalShipmentItemId).toBe(physicalFirst ? "701" : null);
    expect(await state()).toEqual(before); expect(hook).toHaveBeenCalledOnce();
  });
  it("recovers the original committed source command with an older caller's different key", async () => {
    const original = await store().dispatch(dispatchPlan().command);
    expect(await dispatch({ ...request(), actor: "new-worker" })).toEqual(original);
    expect((await state()).commands).toHaveLength(1);
  });
  it("fails source quantity replay changes without reauthorizing or changing custody", async () => {
    await dispatch(); const before = await state();
    await expect(dispatch({ ...request(), quantity: "4" })).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_REPLAY_CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it("rolls back inferred source bin and every dispatch change on downstream failure", async () => {
    await pool.query("UPDATE wms.outbound_shipment_items SET from_location_id=NULL WHERE id=101"); const before = await state();
    await expect(dispatch(request(), async () => { throw new Error("outbox unavailable"); })).rejects.toThrow("outbox unavailable");
    expect(await state()).toEqual(before);
    await expect(dispatch()).resolves.toMatchObject({ plan: { quantity: "5" } });
  });
  it("reruns source preparation after a serialization failure, without persisting an intermediate bin or command", async () => {
    await pool.query("UPDATE wms.outbound_shipment_items SET from_location_id=NULL WHERE id=101");
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async () => {
      if (hook.mock.calls.length === 1) throw Object.assign(new Error("serializable conflict"), { code: "40001" });
    });
    await dispatch(request(), hook);
    expect(hook).toHaveBeenCalledTimes(2); expect((await state()).commands).toHaveLength(1);
    expect((await state()).bins[0].from_location_id).toBe(50);
  });
  it("does not overwrite a stale persisted source bin when picked custody belongs elsewhere", async () => {
    await pool.query("INSERT INTO warehouse.warehouse_locations VALUES(51,1); UPDATE wms.outbound_shipment_items SET from_location_id=51 WHERE id=101");
    const before = await state();
    await expect(dispatch()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_BIN_MISMATCH" }); expect(await state()).toEqual(before);
  });
  it("recognizes complete unpick as no remaining owner despite historic picks and source bin", async () => {
    await pool.query(`INSERT INTO inventory.availability_claim_pick_movements VALUES
      (52,10,20,30,40,401,301,'unpick',3,50),(53,10,20,30,41,402,302,'unpick',2,51);
      UPDATE inventory.availability_claim_lot_allocations SET picked_qty=0;
      UPDATE inventory.availability_claim_resources SET picked_qty=0;
      UPDATE inventory.availability_claim_lines SET picked_target_qty=0`);
    const before = await state();
    await expect(dispatch()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_PICKED_MISSING" }); expect(await state()).toEqual(before);
  });
  it("rejects the reproduced pick-A, unpick-A, repick-B lineage without rewriting persisted source A", async () => {
    await pool.query(`INSERT INTO warehouse.warehouse_locations VALUES(51,1);
      INSERT INTO inventory.inventory_levels VALUES(61,51,105,0,0,5,0,0,'2026-09-07T12:00:00Z');
      INSERT INTO inventory.inventory_lots VALUES(404,51,105,0,0,5,0,'active','2026-09-01T00:00:00Z',100,100);
      INSERT INTO oms.order_item_costs VALUES(303,70,71,105,404,5,1,5,100,500,'2026-09-07T12:00:00Z');
      INSERT INTO inventory.availability_claim_pick_movements VALUES
        (52,10,20,30,40,401,301,'unpick',3,50),(53,10,20,30,41,402,302,'unpick',2,51);
      UPDATE inventory.availability_claim_lot_allocations SET picked_qty=0;
      UPDATE inventory.availability_claim_resources SET picked_qty=0;
      INSERT INTO inventory.availability_claim_resources(id,claim_id,claim_line_id,warehouse_id,warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty,picked_qty)
        VALUES(31,10,20,1,51,61,105,5,5);
      INSERT INTO inventory.availability_claim_lot_allocations(id,claim_id,claim_resource_id,inventory_lot_id,claimed_qty,picked_qty) VALUES(42,10,31,404,5,5);
      INSERT INTO inventory.availability_claim_pick_movements VALUES(54,10,20,31,42,404,303,'pick',5,NULL)`);
    const before = await state();
    await expect(dispatch()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_BIN_MISMATCH" }); expect(await state()).toEqual(before);
  });
  it("serializes duplicate source arrivals and replays the winning original command on the losing retry", async () => {
    let releaseWinner!: () => void; let arrived!: () => void;
    const release = new Promise<void>((done) => { releaseWinner = done; });
    const reached = new Promise<void>((done) => { arrived = done; });
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async () => { arrived(); await release; });
    const winner = dispatch(request(), hook);
    let observed: Promise<{ receipt?: Awaited<ReturnType<typeof dispatch>>; error?: unknown }> | undefined;
    try {
      await reached;
      observed = dispatch({ ...request(), actor: "second-arrival", reason: "Concurrent retry" }, hook)
        .then((receipt) => ({ receipt }), (error: unknown) => ({ error }));
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = (await pool.query("SELECT count(*)::integer AS total FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0];
        if (result.total > 0) { blocked = true; break; }
        await new Promise<void>((done) => setTimeout(done, 10));
      }
      expect(blocked).toBe(true); releaseWinner();
      const original = await winner; expect(await observed).toEqual({ receipt: original });
      expect(hook).toHaveBeenCalledOnce(); expect((await state()).commands).toHaveLength(1);
    } finally { releaseWinner(); await winner.catch(() => undefined); await observed; }
  });
  it("rejects two remaining picked claims instead of choosing the latest or the first sufficient claim", async () => {
    await pool.query(`INSERT INTO inventory.availability_claims VALUES(11,70,'active');
      INSERT INTO inventory.availability_claim_lines(id,claim_id,order_item_id,target_variant_id,planned_qty,picked_target_qty) VALUES(21,11,71,105,1,1);
      INSERT INTO inventory.availability_claim_resources(id,claim_id,claim_line_id,warehouse_id,warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty,picked_qty)
        VALUES(31,11,21,1,50,60,105,1,1);
      INSERT INTO inventory.availability_claim_lot_allocations(id,claim_id,claim_resource_id,inventory_lot_id,claimed_qty,picked_qty) VALUES(42,11,31,401,1,1);
      INSERT INTO inventory.availability_claim_pick_movements VALUES(52,11,21,31,42,401,301,'pick',1,NULL)`);
    const before = await state();
    await expect(dispatch()).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_PICKED_AMBIGUOUS" }); expect(await state()).toEqual(before);
  });
  it.each(["reship", "concession", "omission_correction"])("rejects unsupported source purpose %s before any inferred bin write", async (purpose) => {
    await pool.query("UPDATE wms.outbound_shipment_items SET shipment_item_purpose=$1,from_location_id=NULL WHERE id=101", [purpose]);
    const before = await state();
    await expect(dispatch()).rejects.toMatchObject({ code: "WMS_DISPATCH_NOT_AUTHORIZED" }); expect(await state()).toEqual(before);
  });
  it("rejects new dispatch under legacy authority before a NULL source bin can be assigned", async () => {
    await pool.query("UPDATE inventory.availability_runtime_authority SET authority='legacy',activation_run_id=NULL; UPDATE wms.outbound_shipment_items SET from_location_id=NULL WHERE id=101");
    const before = await state();
    await expect(dispatch()).rejects.toMatchObject({ code: "CANONICAL_AUTHORITY_NOT_ACTIVE" }); expect(await state()).toEqual(before);
  });
  it("requires caller-owned SERIALIZABLE transaction even for source preparation", async () => {
    const client = await pool.connect();
    try { await expect(resolver.resolve(client, request())).rejects.toMatchObject({ code: "CLAIM_DISPATCH_SOURCE_TRANSACTION_REQUIRED" }); }
    finally { client.release(); }
  });
});
