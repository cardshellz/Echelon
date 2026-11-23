import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import { replenRules, replenTierDefaults, warehouseSettings } from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { claimPlanSchema } from "@shared/types/inventory-availability-planner";
import type { CanonicalAvailabilityClaimPickCommand } from "@shared/types/inventory-availability-claims";
import { createQuantityLedgerTestContext, prepareQuantityLotCreationMetadata,
  type QuantityLedgerTestContext } from "../../../inventory/__tests__/fixtures/quantity-ledger-database";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { PostgresInventoryAvailabilityClaimRepository } from "../../infrastructure/inventory-availability-claim.repository";
import { PickCorrectionService } from "../../../orders/pick-correction.service";
import { observeMissingPick } from "../../../wms/pick-correction.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe : describe.skip;
const now = new Date("2026-11-23T14:00:00Z");
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

// Prod shape (LEON order #65758, 2026-11-18): the order ships from warehouse 1,
// but its claim planned the finished pack by breaking a case held in warehouse 2.
// The order's picker can only take finished packs from a warehouse-1 bin.
const PICK_LOCATION = 100; // warehouse 1 pick face; fixture level 10 holds 20 P5 (3 reserved, 2 picked)
const REMOTE_LOCATION = 300; // warehouse 2 reserve bin holding the planned C200 case
const REMOTE_LEVEL = 40;
const REMOTE_LOT = 7;
const OPERATION_KEY = "order-item:21:warehouse:2:path:1:operation:1";

suite.sequential("canonical picks replace a conversion planned in another warehouse", () => {
  let context: QuantityLedgerTestContext;
  let owner: PostgresInventoryAvailabilityClaimRepository;
  let claimId: string;

  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(url, disposable);
    await prepareQuantityLotCreationMetadata(context.pool);
    await context.pool.query(readFileSync("migrations/0703_corrective_picking.sql", "utf8"));
    for (const table of [replenRules, replenTierDefaults, warehouseSettings]) {
      const definition = getTableConfig(table);
      await context.pool.query(`CREATE TABLE IF NOT EXISTS inventory.${definition.name} (${definition.columns
        .map(column => `"${column.name}" ${column.getSQLType()}`).join(",")})`);
    }
    // Catalog/location configuration precedes opening; no new order demand yet.
    await context.pool.query(`INSERT INTO warehouse.warehouses(id,code) VALUES(2,'RTE');
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,location_type,is_pickable)
        VALUES(${REMOTE_LOCATION},2,'FLOOR-01','reserve',0);
      INSERT INTO catalog.product_variants(id,product_id,sku,units_per_variant,hierarchy_level) VALUES(102,20,'C200',200,2);
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(${REMOTE_LEVEL},${REMOTE_LOCATION},102,0,0,0,0);
      INSERT INTO inventory.inventory_lots(id,warehouse_location_id,product_variant_id,qty_received,qty_on_hand,qty_reserved,qty_picked,qty_packed,
        status,received_at,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_provisional,cost_source,qty_consumed)
        VALUES(${REMOTE_LOT},${REMOTE_LOCATION},102,2,0,0,0,0,'active','2026-11-01',4000,4000,0,0,4000,0,'purchase_order',0);
      INSERT INTO inventory.warehouse_settings(id,warehouse_id,warehouse_code,replen_mode,inline_replen_max_units)
        VALUES(1,1,'MAIN','inline',50);`);
    await context.open();
    await context.pool.query(`INSERT INTO wms.orders(id,order_number,warehouse_id,warehouse_status,on_hold) VALUES(2,'#REMOTE-PICK',1,'ready',0);
      INSERT INTO wms.order_items(id,order_id,sku,name,location,product_id,catalog_product_id,inventory_tracking,
        quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(21,2,'P5','Pack of five','PICK',101,20,true,2,0,0,'pending',false,1);`);
    await context.transaction(async client => {
      for (const [kind, delta] of [
        ["receive", { onHand: 2, reserved: 0, picked: 0, packed: 0 }],
        ["reserve", { onHand: 0, reserved: 1, picked: 0, packed: 0 }],
      ] as const) await context.ledger.postInsideTransaction(client, {
        contractVersion: "inventory_quantity_v1", kind, idempotencyKey: `seed-remote-case-${kind}`, actor: "fixture",
        reason: "Known physical case stock in the other warehouse", occurredAt: now.toISOString(),
        reference: { type: "test", id: kind }, reversesCommandId: null,
        movements: [{ inventoryLotId: REMOTE_LOT, inventoryLevelId: REMOTE_LEVEL, warehouseLocationId: REMOTE_LOCATION,
          warehouseId: 2, productVariantId: 102, delta }],
      });
    });
    const plan = claimPlanSchema.parse({ requestKey: "remote-pick", scope: { kind: "warehouse", warehouseId: 1 }, status: "satisfied",
      lines: [{ lineKey: "order-item:21", targetVariantId: 101, requestedQty: "2", plannedQty: "2", shortfallQty: "0" }],
      resourceClaims: [{ lineKey: "order-item:21", consumerOperationKey: OPERATION_KEY, warehouseId: 2,
        warehouseLocationId: REMOTE_LOCATION, inventoryLevelId: REMOTE_LEVEL, sourceVariantId: 102, claimedQty: "1" }],
      operations: [{ lineKey: "order-item:21", warehouseId: 2, operationKey: OPERATION_KEY, parentOperationKey: null,
        operationType: "break_pack", authorityId: 1, sourceVariantIds: [102], inputs: [{ sourceVariantId: 102, requiredQty: "1" }],
        destinationVariantId: 101, plannedExecutions: "1", outputQty: "40", committedOutputQty: "2", outputLocationId: null }],
      fulfillmentGroups: [{ groupKey: "remote-pick:warehouse:1", warehouseId: 1,
        lineAllocations: [{ lineKey: "order-item:21", targetVariantId: 101, plannedQty: "2" }] }],
      modelEvidence: [], blockers: [], snapshotFingerprint: "c".repeat(64) });
    await context.transaction(async client => {
      claimId = (await client.query(`INSERT INTO inventory.availability_claims(claim_key,order_id,revision,status,plan_status,scope_kind,scope_warehouse_id,
        activation_run_id,runtime_authority_revision,request_hash,plan_hash,snapshot_fingerprint,request_payload,plan_payload,model_evidence,requested_by,reason,reserved_at)
        SELECT 'remote-pick',2,1,'active','satisfied','warehouse',1,activation_run_id,revision,$1,$1,$2,$3,$3,'[]','planner','Fixture claim',$4
        FROM inventory.availability_runtime_authority RETURNING id`, [hash(plan), plan.snapshotFingerprint, JSON.stringify(plan), now])).rows[0].id;
      const lineId = (await client.query(`INSERT INTO inventory.availability_claim_lines(claim_id,line_key,order_item_id,target_variant_id,requested_qty,planned_qty,shortfall_qty)
        VALUES($1,'order-item:21',21,101,2,2,0) RETURNING id`, [claimId])).rows[0].id;
      const operationId = (await client.query(`INSERT INTO inventory.availability_claim_operations(claim_id,claim_line_id,operation_key,warehouse_id,operation_type,authority_id,
        destination_variant_id,planned_executions,output_qty,committed_output_qty,output_location_id)
        VALUES($1,$2,$3,2,'break_pack',1,101,1,40,2,NULL) RETURNING id`, [claimId, lineId, OPERATION_KEY])).rows[0].id;
      await client.query(`INSERT INTO inventory.availability_claim_operation_inputs(claim_operation_id,claim_id,source_variant_id,required_qty,input_ordinal)
        VALUES($1,$2,102,1,0)`, [operationId, claimId]);
      const resourceId = (await client.query(`INSERT INTO inventory.availability_claim_resources(claim_id,claim_line_id,consumer_operation_key,warehouse_id,
        warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty) VALUES($1,$2,$3,2,$4,$5,102,1) RETURNING id`,
      [claimId, lineId, OPERATION_KEY, REMOTE_LOCATION, REMOTE_LEVEL])).rows[0].id;
      await client.query(`INSERT INTO inventory.availability_claim_lot_allocations(claim_id,claim_resource_id,inventory_lot_id,claimed_qty,
        unit_cost_mills,po_unit_cost_mills,packaging_unit_cost_mills,landed_unit_cost_mills) VALUES($1,$2,$3,1,4000,4000,0,0)`,
      [claimId, resourceId, REMOTE_LOT]);
    });
    owner = new PostgresInventoryAvailabilityClaimRepository(new PostgresCanonicalClaimInventoryRepository(), context.pool, () => now);
  }, 30_000);
  afterEach(async () => { await context?.close(); });

  const command = (overrides: Partial<CanonicalAvailabilityClaimPickCommand> = {}): CanonicalAvailabilityClaimPickCommand => ({
    claimId, orderItemId: 21, warehouseLocationId: PICK_LOCATION, quantity: "2", locationStrategy: "reconcile_recorded_stock",
    idempotencyKey: "remote-pick-command", actor: "picker", reason: "Picked finished packs from the pick face",
    wmsProgress: { expectedStatus: "pending", expectedPickedQuantity: 0, expectedFulfilledQuantity: 0, targetStatus: "completed", targetPickedQuantity: 2 },
    ...overrides,
  } as CanonicalAvailabilityClaimPickCommand);

  async function evidence() {
    return { quantity: await context.state(),
      operations: (await context.pool.query("SELECT * FROM inventory.availability_claim_operations ORDER BY id")).rows,
      resources: (await context.pool.query("SELECT * FROM inventory.availability_claim_resources ORDER BY id")).rows,
      lots: (await context.pool.query("SELECT * FROM inventory.availability_claim_lot_allocations ORDER BY id")).rows,
      lines: (await context.pool.query("SELECT * FROM inventory.availability_claim_lines ORDER BY id")).rows,
      events: (await context.pool.query("SELECT event_type FROM inventory.availability_claim_events ORDER BY id")).rows,
      receipts: (await context.pool.query("SELECT * FROM inventory.availability_claim_commands ORDER BY id")).rows,
      movements: (await context.pool.query("SELECT * FROM inventory.availability_claim_pick_movements ORDER BY id")).rows,
      item: (await context.pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows };
  }
  const levels = async () => (await context.pool.query(
    "SELECT id,variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE id IN (10,$1) ORDER BY id", [REMOTE_LEVEL])).rows;

  it("releases the remote case and records the finished packs from the order's own warehouse, exactly once", async () => {
    const results = await Promise.all([owner.pickClaimLine(command()), owner.pickClaimLine(command())]);
    expect(results.map(result => result.idempotentReplay).sort()).toEqual([false, true]);
    expect(results[0]).toMatchObject({ outcome: "picked", quantity: "2" });

    // The case in the other warehouse is free again; the packs left the pick face.
    expect(await levels()).toEqual([
      { id: 10, variant_qty: 18, reserved_qty: 3, picked_qty: 4 },
      { id: REMOTE_LEVEL, variant_qty: 2, reserved_qty: 0, picked_qty: 0 },
    ]);
    expect((await context.pool.query(
      "SELECT status,executed_executions::text,released_executions::text FROM inventory.availability_claim_operations WHERE claim_id=$1", [claimId])).rows)
      .toEqual([{ status: "released", executed_executions: "0", released_executions: "1" }]);
    expect((await context.pool.query(`SELECT consumer_operation_key,warehouse_location_id,source_variant_id,
        claimed_qty::text,released_qty::text,picked_qty::text
      FROM inventory.availability_claim_resources WHERE claim_id=$1 ORDER BY id`, [claimId])).rows).toEqual([
      { consumer_operation_key: OPERATION_KEY, warehouse_location_id: REMOTE_LOCATION, source_variant_id: 102,
        claimed_qty: "1", released_qty: "1", picked_qty: "0" },
      { consumer_operation_key: null, warehouse_location_id: PICK_LOCATION, source_variant_id: 101,
        claimed_qty: "2", released_qty: "0", picked_qty: "2" },
    ]);
    expect((await context.pool.query("SELECT picked_target_qty::text,released_target_qty::text FROM inventory.availability_claim_lines WHERE claim_id=$1", [claimId])).rows)
      .toEqual([{ picked_target_qty: "2", released_target_qty: "0" }]);
    expect((await context.pool.query("SELECT picked_quantity,status FROM wms.order_items WHERE id=21")).rows)
      .toEqual([{ picked_quantity: 2, status: "completed" }]);

    const replaced = (await context.pool.query(
      "SELECT evidence_payload FROM inventory.availability_claim_events WHERE claim_id=$1 AND event_type='claim_remote_conversion_replaced'", [claimId])).rows;
    expect(replaced).toHaveLength(1);
    expect(replaced[0].evidence_payload).toMatchObject({
      replacedTargetQty: "2", requestedPickQty: "2", pickWarehouseId: 1, targetWarehouseLocationId: PICK_LOCATION,
      releasedOperations: [{ operationKey: OPERATION_KEY, warehouseId: 2, operationType: "break_pack", committedOutputQty: "2" }],
    });

    // Every unreserve/reserve went through the quantity ledger; projections rebuild exactly.
    expect((await context.pool.query(`SELECT count(*)::int AS bad FROM inventory.quantity_lot_balances balance
      JOIN inventory.inventory_lots lot ON lot.id=balance.inventory_lot_id
      WHERE lot.qty_on_hand<>balance.on_hand OR lot.qty_reserved<>balance.reserved OR lot.qty_picked<>balance.picked`)).rows[0].bad).toBe(0);

    const committed = await evidence();
    await expect(owner.pickClaimLine(command())).resolves.toMatchObject({ idempotentReplay: true });
    expect(await evidence()).toEqual(committed);
  });

  it("writes nothing and says which bin to count when the pick face lacks free finished stock", async () => {
    // Hold 16 of the 17 free packs for other demand: only one free pack remains.
    await context.transaction(async client => context.ledger.postInsideTransaction(client, {
      contractVersion: "inventory_quantity_v1", kind: "reserve", idempotencyKey: "seed-other-demand", actor: "fixture",
      reason: "Other orders hold the pick face", occurredAt: now.toISOString(), reference: { type: "test", id: "other-demand" },
      reversesCommandId: null, movements: [{ inventoryLotId: 4, inventoryLevelId: 10, warehouseLocationId: PICK_LOCATION,
        warehouseId: 1, productVariantId: 101, delta: { onHand: 0, reserved: 16, picked: 0, packed: 0 } }],
    }));
    const before = await evidence();
    await expect(owner.pickClaimLine(command())).rejects.toMatchObject({
      code: "CLAIM_PICK_TARGET_STOCK_SHORTFALL",
      message: expect.stringContaining("Count or receive PICK, then retry."),
    });
    expect(await evidence()).toEqual(before);
  });

  it.each([
    ["executing", "UPDATE inventory.availability_claim_operations SET status='executing' WHERE claim_id=$1"],
    ["planned in the pick warehouse", "UPDATE inventory.availability_claim_operations SET warehouse_id=1 WHERE claim_id=$1"],
  ])("keeps the existing shortfall for a conversion that is %s", async (_label, sql) => {
    await context.pool.query(sql, [claimId]);
    const before = await evidence();
    await expect(owner.pickClaimLine(command())).rejects.toMatchObject({ code: "CLAIM_RECONCILIATION_SOURCE_SHORTFALL" });
    expect(await evidence()).toEqual(before);
  });

  it("never lets two different pick commands release the same remote case twice", async () => {
    const results = await Promise.allSettled([
      owner.pickClaimLine(command()),
      owner.pickClaimLine(command({ idempotencyKey: "competing-remote-pick" })),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await levels()).toEqual([
      { id: 10, variant_qty: 18, reserved_qty: 3, picked_qty: 4 },
      { id: REMOTE_LEVEL, variant_qty: 2, reserved_qty: 0, picked_qty: 0 },
    ]);
    expect((await context.pool.query(
      "SELECT count(*)::int AS n FROM inventory.availability_claim_events WHERE claim_id=$1 AND event_type='claim_remote_conversion_replaced'", [claimId])).rows[0].n)
      .toBe(1);
  });

  it("resolves a confirmed missed-pick Yes on an already shipped order (the stuck-correction case)", async () => {
    await context.pool.query(`UPDATE wms.orders SET warehouse_status='shipped' WHERE id=2;
      UPDATE wms.order_items SET fulfilled_quantity=2 WHERE id=21;
      INSERT INTO wms.physical_shipments(id,provider,provider_physical_shipment_id,status) VALUES(20,'shipstation','test-remote-shipment','shipped');`);
    const db = drizzle(context.pool);
    await observeMissingPick(db, { orderItemId: 21, physicalShipmentId: 20, declaredQuantity: 2, pickedQuantity: 0, occurredAt: now });
    const id = (await context.pool.query("SELECT id FROM wms.pick_corrections")).rows[0].id;
    const service = new PickCorrectionService(db, async ({ correction, actor, targetQuantity }) => {
      await owner.pickClaimLine(command({ actor, wmsProgress: { expectedStatus: "pending", expectedPickedQuantity: 0,
        expectedFulfilledQuantity: 2, pickCorrectionId: id, pickCorrectionRevision: correction.revision,
        targetStatus: "completed", targetPickedQuantity: targetQuantity } }));
    }, () => now);
    const accepted = { commandId: "8d3f1f0e-5a8c-4f5c-9b5c-3f1d2e4a6b7c", expectedRevision: 1, answer: "yes" };
    await expect(service.answer(id, accepted, "picker")).resolves.toMatchObject({ state: "resolved", pickedQuantity: 2, answer: "yes" });
    expect((await context.pool.query("SELECT status FROM inventory.availability_claim_operations WHERE claim_id=$1", [claimId])).rows)
      .toEqual([{ status: "released" }]);
    expect((await context.pool.query("SELECT reserved_qty FROM inventory.inventory_levels WHERE id=$1", [REMOTE_LEVEL])).rows)
      .toEqual([{ reserved_qty: 0 }]);
    expect((await context.pool.query("SELECT warehouse_status FROM wms.orders WHERE id=2")).rows[0].warehouse_status).toBe("shipped");
    const before = await evidence();
    await service.answer(id, accepted, "picker");
    expect(await evidence()).toEqual(before);
  });
});
