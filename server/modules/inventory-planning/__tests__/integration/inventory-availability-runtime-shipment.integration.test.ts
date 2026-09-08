import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { DISPATCH_TIME } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../../wms/canonical-claim-dispatch-source";
import type { CanonicalClaimDispatchBeforeCommit } from "../../application/inventory-availability-dispatch.port";
import { PostgresCanonicalClaimDispatchRepository } from "../../infrastructure/inventory-availability-dispatch.repository";
import { PostgresCanonicalClaimDispatchSourceCommandResolver } from "../../infrastructure/inventory-availability-dispatch-source-command.repository";
import { createAuthorityAwareInventoryShipmentRecorder } from "../../infrastructure/inventory-availability-runtime-shipment.repository";
import { PostgresTransactionScopedInventoryPublicationExecutor } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { dispatchRuntimeFixtureSql, dispatchRuntimeSeedSql } from "../fixtures/inventory-availability-dispatch-runtime-fixture";
import { shipmentPublicationFixtureSql, shipmentPublicationIntent } from "../fixtures/shipment-publication.fixture";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migration = readFileSync(resolve(process.cwd(), "migrations/0662_inventory_availability_claim_dispatch.sql"), "utf8");
const input = { productVariantId: 105, warehouseLocationId: null, qty: 5, orderId: 70, orderItemId: 71,
  shipmentId: "90", shipmentItemId: 101, userId: "system:shipstation:v2", deductFromOnHandOnly: true };

/** Real routing/source/dispatch/queue owners; full planner separately proven by foundation integration. */
describeDatabase.sequential("authority-aware shipment connected PostgreSQL runtime", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  const enqueue: CanonicalClaimDispatchBeforeCommit = async ({ client }) => {
    await new PostgresTransactionScopedInventoryPublicationExecutor(client).execute(context =>
      context.enqueueFullPublications("1", [shipmentPublicationIntent()]));
  };
  function recorder(hook: CanonicalClaimDispatchBeforeCommit = enqueue) {
    const owner = new WmsCanonicalClaimDispatchSourceOwner();
    const legacy = vi.fn(async () => { throw new Error("Legacy fallback must never run"); });
    return { legacy, service: createAuthorityAwareInventoryShipmentRecorder({
      connectionPool: pool, legacyOwner: { recordShipmentInsideTransaction: legacy },
      dispatcher: new PostgresCanonicalClaimDispatchRepository(pool, owner,
        new PostgresCanonicalClaimInventoryRepository(), hook, () => DISPATCH_TIME),
      sourceCommands: new PostgresCanonicalClaimDispatchSourceCommandResolver(owner),
    }) };
  }
  async function state() {
    return {
      level: (await pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE id=60")).rows[0],
      claim: (await pool.query("SELECT picked_target_qty::text,consumed_target_qty::text FROM inventory.availability_claim_lines WHERE id=20")).rows[0],
      sources: (await pool.query("SELECT id,from_location_id FROM wms.outbound_shipment_items ORDER BY id")).rows,
      receipts: (await pool.query("SELECT source_shipment_item_id,quantity::text,physical_shipment_id::text FROM inventory.availability_claim_dispatch_receipts ORDER BY id")).rows,
      outbox: (await pool.query("SELECT desired_quantity::text,desired_revision::text FROM inventory.inventory_publication_outbox ORDER BY id")).rows,
      costs: (await pool.query("SELECT id,qty,total_cost_mills::text FROM oms.order_item_costs ORDER BY id")).rows,
    };
  }
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, dispatchRuntimeFixtureSql + shipmentPublicationFixtureSql);
    pool = database.pool;
    await pool.query(migration);
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE inventory.inventory_publication_attempts,inventory.inventory_publication_readbacks,
      inventory.inventory_publication_outbox,inventory.availability_activation_runs RESTART IDENTITY;
      ${dispatchRuntimeSeedSql}
      INSERT INTO inventory.availability_activation_runs(id,mode,state) VALUES(1,'activation','active');
      UPDATE wms.outbound_shipment_items SET from_location_id=NULL;`);
  });
  afterAll(async () => { await database?.close(); });

  it.each([false, true])("routes one source and replays across physical materialization, physicalFirst=%s", async (physicalFirst) => {
    const materialize = () => pool.query(`INSERT INTO wms.physical_shipments VALUES(700,'shipped');
      INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,legacy_wms_shipment_item_id,wms_order_item_id,product_variant_id,quantity_shipped)
      VALUES(701,700,101,71,105,5)`);
    if (physicalFirst) await materialize();
    const f = recorder();
    const before = await state();
    await f.service.recordShipment(input);
    if (!physicalFirst) await materialize();
    const committed = await state();
    await f.service.recordShipment({ ...input, userId: "system:channel-fulfillment-ingress", warehouseLocationId: 999 });
    expect(await state()).toEqual(committed);
    expect(committed).toMatchObject({ level: { variant_qty: before.level.variant_qty, picked_qty: before.level.picked_qty - 5 },
      claim: { picked_target_qty: "0", consumed_target_qty: "5" },
      receipts: [{ source_shipment_item_id: 101, quantity: "5", physical_shipment_id: physicalFirst ? "700" : null }],
      outbox: [{ desired_quantity: "6", desired_revision: "1" }], costs: before.costs });
    expect(f.legacy).not.toHaveBeenCalled();
  });
  it("recovers a partial multi-line package without reposting its committed first source", async () => {
    await pool.query(`UPDATE wms.outbound_shipment_items SET qty=3 WHERE id=101;
      INSERT INTO wms.order_items(id,order_id,product_id) VALUES(72,70,105);
      UPDATE wms.outbound_shipment_items SET shipment_id=90,order_item_id=72,qty=2 WHERE id=102;
      UPDATE inventory.availability_claim_lines SET planned_qty=3,picked_target_qty=3 WHERE id=20;
      INSERT INTO inventory.availability_claim_lines(id,claim_id,order_item_id,target_variant_id,planned_qty,picked_target_qty)
        VALUES(21,10,72,105,2,2);
      UPDATE inventory.availability_claim_resources SET claimed_qty=3,picked_qty=3 WHERE id=30;
      INSERT INTO inventory.availability_claim_resources(id,claim_id,claim_line_id,warehouse_id,warehouse_location_id,
        inventory_level_id,source_variant_id,claimed_qty,picked_qty) VALUES(31,10,21,1,50,60,105,2,2);
      UPDATE inventory.availability_claim_lot_allocations SET claim_resource_id=31 WHERE id=41;
      TRUNCATE inventory.availability_claim_dispatch_movements,inventory.availability_claim_pick_movements;
      INSERT INTO inventory.availability_claim_pick_movements
        VALUES(50,10,20,30,40,401,301,'pick',3,NULL),(51,10,21,31,41,402,302,'pick',2,NULL);
      UPDATE oms.order_item_costs SET order_item_id=72 WHERE id=302;`);
    let rejectSecond = true;
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async event => {
      await enqueue(event);
      if (event.receipt.plan.command.sourceShipmentItemId === 102 && rejectSecond) throw new Error("second-source publication failed");
    });
    const f = recorder(hook);
    const costs = (await state()).costs;
    await f.service.recordShipment({ ...input, qty: 3 });
    const first = await state();
    await expect(f.service.recordShipment({ ...input, qty: 2, orderItemId: 72, shipmentItemId: 102 })).rejects.toThrow("second-source publication failed");
    expect(await state()).toEqual(first);
    rejectSecond = false;
    await f.service.recordShipment({ ...input, qty: 3 });
    expect(hook).toHaveBeenCalledTimes(2);
    await f.service.recordShipment({ ...input, qty: 2, orderItemId: 72, shipmentItemId: 102 });
    expect((await state())).toMatchObject({ claim: { picked_target_qty: "0", consumed_target_qty: "3" },
      receipts: [{ source_shipment_item_id: 101, quantity: "3" }, { source_shipment_item_id: 102, quantity: "2" }], costs });
    expect(f.legacy).not.toHaveBeenCalled();
  });
  it("retries a classified publication lock conflict by rerunning the entire source transaction", async () => {
    const hook = vi.fn<CanonicalClaimDispatchBeforeCommit>(async event => {
      if (hook.mock.calls.length === 1) throw Object.assign(new Error("target busy"), { code: "INVENTORY_PUBLICATION_TARGET_BUSY" });
      await enqueue(event);
    });
    await recorder(hook).service.recordShipment(input);
    expect(hook).toHaveBeenCalledTimes(2);
    expect((await state()).receipts).toHaveLength(1);
    expect((await state()).outbox).toHaveLength(1);
  });
  it("does not fall back for inactive activation or unsupported source purpose", async () => {
    const f = recorder();
    await pool.query("UPDATE inventory.availability_activation_runs SET state='activating'");
    let before = await state();
    await expect(f.service.recordShipment(input)).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ACTIVATION_NOT_ACTIVE" });
    expect(await state()).toEqual(before);
    await pool.query("UPDATE inventory.availability_activation_runs SET state='active'; UPDATE wms.outbound_shipment_items SET shipment_item_purpose='concession'");
    before = await state();
    await expect(f.service.recordShipment(input)).rejects.toMatchObject({ code: "WMS_DISPATCH_NOT_AUTHORIZED" });
    expect(await state()).toEqual(before);
    expect(f.legacy).not.toHaveBeenCalled();
  });
});
