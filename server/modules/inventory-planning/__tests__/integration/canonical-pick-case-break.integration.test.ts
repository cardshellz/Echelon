import { createHash, randomUUID } from "node:crypto";
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
import { PostgresCanonicalClaimDispatchRepository } from "../../infrastructure/inventory-availability-dispatch.repository";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../../wms/canonical-claim-dispatch-source";
import { installWarehouseOperationMigration } from "../../../orders/__tests__/fixtures/install-warehouse-operation-migration";
import { preparePickingCommand, pickingCommandKey, readPickingCommand } from "../../../wms/picking-command.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe : describe.skip;
const now = new Date("2026-09-30T14:00:00Z");
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

suite.sequential("canonical picker case conversions with active quantity authority", () => {
  let context: QuantityLedgerTestContext;
  let owner: PostgresInventoryAvailabilityClaimRepository;
  let claimId: string;
  let packagingPathId: number;
  beforeEach(async () => {
    context = await createQuantityLedgerTestContext(url, disposable);
    await prepareQuantityLotCreationMetadata(context.pool);
    // The admission fixture's SQL-only dispatch tables have no posting columns.
    // Replace those empty stubs with the real receipt/FK/deferred-journal schema.
    await context.pool.query("DROP TABLE inventory.availability_claim_dispatch_movements; DROP TABLE inventory.availability_claim_dispatch_receipts");
    await context.pool.query(readFileSync("migrations/0662_inventory_availability_claim_dispatch.sql","utf8"));
    for (const table of ["availability_claim_dispatch_movements","availability_claim_dispatch_receipts"]) {
      await context.pool.query(`CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON inventory.${table}
        FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission()`);
    }
    await context.pool.query(readFileSync("migrations/0703_corrective_picking.sql", "utf8"));
    for (const table of [replenRules, replenTierDefaults, warehouseSettings]) {
      const definition = getTableConfig(table);
      // Policy reads need their actual schema columns, not substituted decisions.
      await context.pool.query(`CREATE TABLE IF NOT EXISTS inventory.${definition.name} (${definition.columns
        .map(column => `"${column.name}" ${column.getSQLType()}`).join(",")})`);
    }
    // Catalog/location configuration precedes opening; no new order demand yet.
    await context.pool.query(`INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code) VALUES(200,1,'CASE');
      INSERT INTO catalog.product_variants(id,product_id,sku,units_per_variant,hierarchy_level) VALUES(102,20,'C200',200,2);
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(20,200,102,0,0,0,0);
      INSERT INTO inventory.inventory_lots(id,warehouse_location_id,product_variant_id,qty_received,qty_on_hand,qty_reserved,qty_picked,qty_packed,
        status,received_at,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_provisional,cost_source,qty_consumed)
        VALUES(5,200,102,2,0,0,0,0,'active','2026-09-29',4000,4000,0,0,4000,0,'purchase_order',0);
      INSERT INTO inventory.warehouse_settings(id,warehouse_id,warehouse_code,replen_mode,inline_replen_max_units)
        VALUES(1,1,'MAIN','inline',50);`);
    await seedRepackagingConfiguration();
    await context.open();
    await context.pool.query(`INSERT INTO wms.orders(id,order_number,warehouse_id,warehouse_status,on_hold) VALUES(2,'#CASE-PICK',1,'ready',0);
      INSERT INTO wms.order_items(id,order_id,sku,name,location,product_id,catalog_product_id,inventory_tracking,
        quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(21,2,'P5','Pack of five','PICK',101,20,true,2,0,0,'pending',false,1);`);
    await context.transaction(async client => {
      for (const [kind, delta] of [
        ["receive", { onHand: 2, reserved: 0, picked: 0, packed: 0 }],
        ["reserve", { onHand: 0, reserved: 1, picked: 0, packed: 0 }],
      ] as const) await context.ledger.postInsideTransaction(client, {
        contractVersion: "inventory_quantity_v1", kind, idempotencyKey: `seed-case-${kind}`, actor: "fixture",
        reason: "Known physical case stock", occurredAt: now.toISOString(),
        reference: { type: "test", id: kind }, reversesCommandId: null,
        movements: [{ inventoryLotId: 5, inventoryLevelId: 20, warehouseLocationId: 200,
          warehouseId: 1, productVariantId: 102, delta }],
      });
    });
    const plan = claimPlanSchema.parse({ requestKey: "case-pick", scope: { kind: "warehouse", warehouseId: 1 }, status: "satisfied",
      lines: [{ lineKey: "order-item:21", targetVariantId: 101, requestedQty: "2", plannedQty: "2", shortfallQty: "0" }],
      resourceClaims: [{ lineKey: "order-item:21", consumerOperationKey: "case-pack", warehouseId: 1,
        warehouseLocationId: 200, inventoryLevelId: 20, sourceVariantId: 102, claimedQty: "1" }],
      operations: [{ lineKey: "order-item:21", warehouseId: 1, operationKey: "case-pack", parentOperationKey: null,
        operationType: "break_pack", authorityId: 1, sourceVariantIds: [102], inputs: [{ sourceVariantId: 102, requiredQty: "1" }],
        destinationVariantId: 101, plannedExecutions: "1", outputQty: "40", committedOutputQty: "2", outputLocationId: 100 }],
      fulfillmentGroups: [{ groupKey: "case-pick:warehouse:1", warehouseId: 1,
        lineAllocations: [{ lineKey: "order-item:21", targetVariantId: 101, plannedQty: "2" }] }], modelEvidence: [], blockers: [], snapshotFingerprint: "a".repeat(64) });
    await context.transaction(async client => {
      claimId = (await client.query(`INSERT INTO inventory.availability_claims(claim_key,order_id,revision,status,plan_status,scope_kind,scope_warehouse_id,
        activation_run_id,runtime_authority_revision,request_hash,plan_hash,snapshot_fingerprint,request_payload,plan_payload,model_evidence,requested_by,reason,reserved_at)
        SELECT 'case-pick',2,1,'active','satisfied','warehouse',1,activation_run_id,revision,$1,$1,$2,$3,$3,'[]','picker','Fixture claim',$4
        FROM inventory.availability_runtime_authority RETURNING id`, [hash(plan), plan.snapshotFingerprint, JSON.stringify(plan), now])).rows[0].id;
      const lineId = (await client.query(`INSERT INTO inventory.availability_claim_lines(claim_id,line_key,order_item_id,target_variant_id,requested_qty,planned_qty,shortfall_qty)
        VALUES($1,'order-item:21',21,101,2,2,0) RETURNING id`, [claimId])).rows[0].id;
      const operationId = (await client.query(`INSERT INTO inventory.availability_claim_operations(claim_id,claim_line_id,operation_key,warehouse_id,operation_type,authority_id,
        destination_variant_id,planned_executions,output_qty,committed_output_qty,output_location_id)
        VALUES($1,$2,'case-pack',1,'break_pack',1,101,1,40,2,100) RETURNING id`, [claimId,lineId])).rows[0].id;
      await client.query(`INSERT INTO inventory.availability_claim_operation_inputs(claim_operation_id,claim_id,source_variant_id,required_qty,input_ordinal)
        VALUES($1,$2,102,1,0)`, [operationId,claimId]);
      const resourceId = (await client.query(`INSERT INTO inventory.availability_claim_resources(claim_id,claim_line_id,consumer_operation_key,warehouse_id,
        warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty) VALUES($1,$2,'case-pack',1,200,20,102,1) RETURNING id`, [claimId,lineId])).rows[0].id;
      await client.query(`INSERT INTO inventory.availability_claim_lot_allocations(claim_id,claim_resource_id,inventory_lot_id,claimed_qty,
        unit_cost_mills,po_unit_cost_mills,packaging_unit_cost_mills,landed_unit_cost_mills) VALUES($1,$2,5,1,4000,4000,0,0)`, [claimId,resourceId]);
    });
    owner = new PostgresInventoryAvailabilityClaimRepository(new PostgresCanonicalClaimInventoryRepository(), context.pool, () => now);
  }, 30_000);
  afterEach(async () => { await context?.close(); });

  const command = (overrides: Partial<CanonicalAvailabilityClaimPickCommand> = {}): CanonicalAvailabilityClaimPickCommand => ({
    claimId, orderItemId: 21, warehouseLocationId: 100, quantity: "2", locationStrategy: "strict",
    idempotencyKey: "case-pick-command", actor: "picker", reason: "Pick claimed packs from a case",
    wmsProgress: { expectedStatus: "pending", expectedPickedQuantity: 0, expectedFulfilledQuantity: 0, targetStatus: "completed", targetPickedQuantity: 2 },
    ...overrides,
  } as CanonicalAvailabilityClaimPickCommand);
  async function evidence() {
    return { quantity: await context.state(),
      operations: (await context.pool.query("SELECT * FROM inventory.availability_claim_operations ORDER BY id")).rows,
      resources: (await context.pool.query("SELECT * FROM inventory.availability_claim_resources ORDER BY id")).rows,
      receipts: (await context.pool.query("SELECT * FROM inventory.availability_claim_commands ORDER BY id")).rows,
      movements: (await context.pool.query("SELECT * FROM inventory.availability_claim_pick_movements ORDER BY id")).rows,
      costs: (await context.pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows,
      item: (await context.pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows };
  }

  it("couples the WMS command receipt to exact canonical movement and replays concurrent requests once", async () => {
    await installWarehouseOperationMigration(context.pool);
    await context.pool.query("UPDATE wms.order_items SET unit_price_cents=100,paid_price_cents=100,total_price_cents=200,zone='P' WHERE id=21");
    const key=pickingCommandKey("pick",randomUUID());
    const orm=drizzle(context.pool);
    await preparePickingCommand(orm as any,key,{action:"pick",itemId:21,actor:"picker",params:{pickedQuantity:2,status:"completed"}},()=>now);
    const input=command({idempotencyKey:key});
    const attempts=await Promise.allSettled([owner.pickClaimLine(input),owner.pickClaimLine(input)]);
    expect(attempts.some(attempt=>attempt.status === "fulfilled")).toBe(true);
    const receipt=await readPickingCommand(orm as any,key);
    expect(receipt?.physical_receipt?.canonicalResult).toMatchObject({orderId:2,orderItemId:21,quantity:"2"});
    const beforeReplay=await evidence();
    await owner.pickClaimLine(input);
    expect(await evidence()).toEqual(beforeReplay);
    expect((await context.pool.query("SELECT picked_quantity FROM wms.order_items WHERE id=21")).rows[0].picked_quantity).toBe(2);
  });

  it("rolls conversion, lot costs, quantity journal and command receipt back if receipt persistence fails", async () => {
    await installWarehouseOperationMigration(context.pool);
    await context.pool.query("UPDATE wms.order_items SET unit_price_cents=100,paid_price_cents=100,total_price_cents=200,zone='P' WHERE id=21");
    const key=pickingCommandKey("pick",randomUUID());
    const orm=drizzle(context.pool);
    await preparePickingCommand(orm as any,key,{action:"pick",itemId:21,actor:"picker",params:{pickedQuantity:2,status:"completed"}},()=>now);
    await context.pool.query(`CREATE FUNCTION wms.fail_command_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.physical_receipt IS NOT NULL THEN RAISE EXCEPTION 'receipt commit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_command_receipt BEFORE UPDATE ON wms.picking_commands FOR EACH ROW EXECUTE FUNCTION wms.fail_command_receipt()`);
    const before=await evidence();
    const input=command({idempotencyKey:key});
    await expect(owner.pickClaimLine(input)).rejects.toThrow("receipt commit failure");
    expect(await evidence()).toEqual(before);
    expect((await readPickingCommand(orm as any,key))?.physical_receipt).toBeNull();
    await context.pool.query("DROP TRIGGER fail_command_receipt ON wms.picking_commands");
    await expect(owner.pickClaimLine(input)).resolves.toMatchObject({quantity:"2",outcome:"picked"});
    expect((await readPickingCommand(orm as any,key))?.physical_receipt).not.toBeNull();
  });

  async function seedRepackagingConfiguration() {
    await context.pool.query(`INSERT INTO catalog.product_variants(id,product_id,sku,units_per_variant,hierarchy_level)
        VALUES(103,20,'EA',1,0);
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(30,100,103,0,0,0,0);
      INSERT INTO inventory.inventory_lots(id,warehouse_location_id,product_variant_id,qty_received,qty_on_hand,qty_reserved,qty_picked,qty_packed,
        status,received_at,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills,cost_provisional,cost_source,qty_consumed)
        VALUES(6,100,103,25,0,0,0,0,'active','2026-09-29',31800,31800,0,0,31800,0,'purchase_order',0);`);
    // Define the conversion in the initial draft before opening freezes it.
    packagingPathId = (await context.pool.query(`INSERT INTO inventory.transformation_model_paths
      (model_id,source_variant_id,destination_variant_id,input_qty,output_qty,source_units_per_variant,destination_units_per_variant,
       operation_type,authority_state,validation_state)
      SELECT id,103,101,5,1,1,5,'directed_conversion','allowed','valid'
      FROM inventory.transformation_model_versions WHERE product_id=20 AND version=1 RETURNING id`)).rows[0].id;
    await context.pool.query("UPDATE inventory.transformation_model_versions SET validation_state='valid',validation_errors='[]' WHERE product_id=20 AND version=1");
  }

  async function repackagingScenario() {
    await context.pool.query(`INSERT INTO wms.orders(id,order_number,warehouse_id,warehouse_status,on_hold) VALUES(3,'#REPACK-PICK',1,'ready',0);
      INSERT INTO wms.order_items(id,order_id,sku,name,location,product_id,catalog_product_id,inventory_tracking,
        quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(31,3,'P5','Pack of five','PICK',101,20,true,3,0,0,'pending',false,1);`);
    const authorityId = packagingPathId;
    const operationType = "directed_conversion";
    const plan = claimPlanSchema.parse({ requestKey:"repack-pick",scope:{ kind:"warehouse",warehouseId:1 },status:"satisfied",
      lines:[{ lineKey:"order-item:31",targetVariantId:101,requestedQty:"3",plannedQty:"3",shortfallQty:"0" }],
      resourceClaims:[
        { lineKey:"order-item:31",consumerOperationKey:null,warehouseId:1,warehouseLocationId:100,inventoryLevelId:10,sourceVariantId:101,claimedQty:"2" },
        { lineKey:"order-item:31",consumerOperationKey:"eaches-pack",warehouseId:1,warehouseLocationId:100,inventoryLevelId:30,sourceVariantId:103,claimedQty:"5" },
      ],operations:[{ lineKey:"order-item:31",warehouseId:1,operationKey:"eaches-pack",parentOperationKey:null,
        operationType,authorityId,sourceVariantIds:[103],inputs:[{ sourceVariantId:103,requiredQty:"5" }],
        destinationVariantId:101,plannedExecutions:"1",outputQty:"1",committedOutputQty:"1",outputLocationId:100 }],
      fulfillmentGroups:[{ groupKey:"repack:warehouse:1",warehouseId:1,lineAllocations:[{ lineKey:"order-item:31",targetVariantId:101,plannedQty:"3" }] }],
      modelEvidence:[],blockers:[],snapshotFingerprint:"b".repeat(64) });
    await context.transaction(async client => {
      await context.ledger.postInsideTransaction(client, {
        contractVersion:"inventory_quantity_v1",kind:"receive",idempotencyKey:"seed-eaches",actor:"fixture",
        reason:"Known physical eaches",occurredAt:now.toISOString(),reference:{ type:"test",id:"seed-eaches" },reversesCommandId:null,
        movements:[{ inventoryLotId:6,inventoryLevelId:30,warehouseLocationId:100,warehouseId:1,productVariantId:103,
          delta:{ onHand:25,reserved:0,picked:0,packed:0 } }],
      });
      claimId = (await client.query(`INSERT INTO inventory.availability_claims(claim_key,order_id,revision,status,plan_status,scope_kind,scope_warehouse_id,
        activation_run_id,runtime_authority_revision,request_hash,plan_hash,snapshot_fingerprint,request_payload,plan_payload,model_evidence,requested_by,reason,reserved_at)
        SELECT 'repack-pick',3,1,'active','satisfied','warehouse',1,activation_run_id,revision,$1,$1,$2,$3,$3,'[]','picker','Repack fixture',$4
        FROM inventory.availability_runtime_authority RETURNING id`,[hash(plan),plan.snapshotFingerprint,JSON.stringify(plan),now])).rows[0].id;
      const lineId = (await client.query(`INSERT INTO inventory.availability_claim_lines(claim_id,line_key,order_item_id,target_variant_id,requested_qty,planned_qty,shortfall_qty)
        VALUES($1,'order-item:31',31,101,3,3,0) RETURNING id`,[claimId])).rows[0].id;
      const operationId = (await client.query(`INSERT INTO inventory.availability_claim_operations(claim_id,claim_line_id,operation_key,warehouse_id,operation_type,authority_id,
        destination_variant_id,planned_executions,output_qty,committed_output_qty,output_location_id)
        VALUES($1,$2,'eaches-pack',1,$3,$4,101,1,1,1,100) RETURNING id`,[claimId,lineId,operationType,authorityId])).rows[0].id;
      await client.query(`INSERT INTO inventory.availability_claim_operation_inputs(claim_operation_id,claim_id,source_variant_id,required_qty,input_ordinal)
        VALUES($1,$2,103,5,0)`,[operationId,claimId]);
      const writer = new PostgresCanonicalClaimInventoryRepository();
      for (const resource of plan.resourceClaims) {
        const resourceId = (await client.query(`INSERT INTO inventory.availability_claim_resources(claim_id,claim_line_id,consumer_operation_key,warehouse_id,
          warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty) VALUES($1,$2,$3,1,100,$4,$5,$6) RETURNING id`,
        [claimId,lineId,resource.consumerOperationKey,resource.inventoryLevelId,resource.sourceVariantId,resource.claimedQty])).rows[0].id;
        const allocations = await writer.reserveResource({ client,commandKey:`repack-reserve:${resource.sourceVariantId}`,
          claimId:BigInt(claimId),claimResourceId:BigInt(resourceId),inventoryLevelId:resource.inventoryLevelId,
          warehouseLocationId:100,sourceVariantId:resource.sourceVariantId,claimedQty:Number(resource.claimedQty),
          orderId:3,orderItemId:31,consumerOperationKey:resource.consumerOperationKey,actor:"fixture",occurredAt:now });
        for (const allocation of allocations) await client.query(`INSERT INTO inventory.availability_claim_lot_allocations
          (claim_id,claim_resource_id,inventory_lot_id,claimed_qty,unit_cost_mills,po_unit_cost_mills,packaging_unit_cost_mills,landed_unit_cost_mills)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[claimId,resourceId,allocation.inventoryLotId,allocation.qty,
          allocation.unitCostMills.toString(),allocation.poUnitCostMills.toString(),allocation.packagingUnitCostMills.toString(),allocation.landedUnitCostMills.toString()]);
      }
    });
    await owner.pickClaimLine(command({ orderItemId:31,idempotencyKey:"repack-first-two",wmsProgress:{
      expectedStatus:"pending",expectedPickedQuantity:0,expectedFulfilledQuantity:0,targetStatus:"in_progress",targetPickedQuantity:2 } }));
    return command({ orderItemId:31,quantity:"1",idempotencyKey:"repack-third",reason:"Record the remaining P5 from five eaches",wmsProgress:{
      expectedStatus:"in_progress",expectedPickedQuantity:2,expectedFulfilledQuantity:0,targetStatus:"completed",targetPickedQuantity:3 } });
  }

  it("picks a third P5 from five reserved eaches through directed conversion exactly once", async () => {
    const remaining = await repackagingScenario();
    const earlierPicks = (await context.pool.query("SELECT * FROM inventory.availability_claim_pick_movements ORDER BY id")).rows;
    const earlierCosts = (await context.pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows;
    const results = await Promise.all([owner.pickClaimLine(remaining),owner.pickClaimLine(remaining)]);
    expect(results.map(result => result.idempotentReplay).sort()).toEqual([false,true]);
    expect((await context.pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels WHERE id=30")).rows)
      .toEqual([{ variant_qty:20,reserved_qty:0,picked_qty:0 }]);
    expect((await context.pool.query("SELECT status,executed_executions::text FROM inventory.availability_claim_operations WHERE claim_id=$1",[claimId])).rows)
      .toEqual([{ status:"completed",executed_executions:"1" }]);
    expect((await context.pool.query("SELECT picked_quantity,fulfilled_quantity,status FROM wms.order_items WHERE id=31")).rows)
      .toEqual([{ picked_quantity:3,fulfilled_quantity:0,status:"completed" }]);
    const picks = (await context.pool.query("SELECT * FROM inventory.availability_claim_pick_movements ORDER BY id")).rows;
    expect(picks.slice(0,earlierPicks.length)).toEqual(earlierPicks);
    expect(picks.slice(earlierPicks.length).map(row => row.quantity)).toEqual(["1"]);
    const costs = (await context.pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows;
    expect(costs.slice(0,earlierCosts.length)).toEqual(earlierCosts);
    expect(costs.slice(earlierCosts.length)).toMatchObject([{ qty:1,total_cost_mills:"159000" }]);
    const beforeReplay = await evidence();
    await owner.pickClaimLine(remaining);
    expect(await evidence()).toEqual(beforeReplay);
  });

  it("preserves two already-dispatched P5 packs while converting and recording only the remaining one", async () => {
    const remaining = await repackagingScenario();
    // Reduced fixture columns for the real WMS dispatch-source reader.
    await context.pool.query(`ALTER TABLE wms.orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
      ALTER TABLE wms.outbound_shipments ADD COLUMN IF NOT EXISTS shipment_purpose text DEFAULT 'customer_fulfillment',
        ADD COLUMN IF NOT EXISTS replaces_shipment_id integer, ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
        ADD COLUMN IF NOT EXISTS voided_at timestamptz;
      ALTER TABLE wms.outbound_shipment_items ADD COLUMN IF NOT EXISTS provider_membership_state text DEFAULT 'authoritative';
      INSERT INTO wms.outbound_shipments(id,order_id,status,held,requires_review,shipment_purpose)
        VALUES(31,3,'shipped',false,false,'customer_fulfillment');
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,product_variant_id,qty,from_location_id,shipment_item_purpose,provider_membership_state)
        VALUES(31,31,31,101,2,100,'customer_fulfillment','authoritative');`);
    const dispatch = new PostgresCanonicalClaimDispatchRepository(context.pool,new WmsCanonicalClaimDispatchSourceOwner(),
      new PostgresCanonicalClaimInventoryRepository(),async ({ client }) => {
        await client.query("UPDATE wms.order_items SET fulfilled_quantity=2 WHERE id=31");
      },() => now);
    await dispatch.dispatch({ claimId,orderId:3,orderItemId:31,warehouseId:1,warehouseLocationId:100,productVariantId:101,
      outboundShipmentId:31,sourceShipmentItemId:31,physicalShipmentId:null,physicalShipmentItemId:null,quantity:"2",
      idempotencyKey:"dispatch-first-two",actor:"shipping",reason:"Provider-declared first two packs" });
    const beforeCosts = (await context.pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows;
    const beforeShipments = (await context.pool.query("SELECT * FROM wms.outbound_shipment_items ORDER BY id")).rows;
    await owner.pickClaimLine({ ...remaining,wmsProgress:{ ...remaining.wmsProgress!,expectedFulfilledQuantity:2 } });
    expect((await context.pool.query("SELECT consumed_target_qty::text,picked_target_qty::text FROM inventory.availability_claim_lines WHERE claim_id=$1",[claimId])).rows)
      .toEqual([{ consumed_target_qty:"2",picked_target_qty:"1" }]);
    expect((await context.pool.query("SELECT picked_quantity,fulfilled_quantity FROM wms.order_items WHERE id=31")).rows)
      .toEqual([{ picked_quantity:3,fulfilled_quantity:2 }]);
    expect((await context.pool.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows.slice(0,beforeCosts.length)).toEqual(beforeCosts);
    expect((await context.pool.query("SELECT * FROM wms.outbound_shipment_items ORDER BY id")).rows).toEqual(beforeShipments);
  });

  it("rolls repackaging, source consumption and cost lineage back if final pick progress fails", async () => {
    const remaining = await repackagingScenario();
    const before = await evidence();
    await context.pool.query(`CREATE FUNCTION wms.fail_repack_pick() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected repack pick failure'; END $$;
      CREATE TRIGGER fail_repack_pick BEFORE UPDATE ON wms.order_items FOR EACH ROW EXECUTE FUNCTION wms.fail_repack_pick()`);
    await expect(owner.pickClaimLine(remaining)).rejects.toThrow("injected repack pick failure");
    expect(await evidence()).toEqual(before);
    await context.pool.query("DROP TRIGGER fail_repack_pick ON wms.order_items");
    await expect(owner.pickClaimLine(remaining)).resolves.toMatchObject({ outcome:"picked",quantity:"1" });
  });

  it("keeps a manual or queued repackaging choice authoritative without falling through to bin rebinding", async () => {
    const remaining = await repackagingScenario();
    await context.pool.query("INSERT INTO inventory.replen_rules(id,pick_product_variant_id,is_active,auto_replen) VALUES(1,101,1,2)");
    const before = await evidence();
    await expect(owner.pickClaimLine(remaining)).rejects.toMatchObject({ code:"CLAIM_PICK_REPLENISHMENT_REQUIRED" });
    expect(await evidence()).toEqual(before);
  });

  it.each(["missing_path","component_build"] as const)("does not turn %s into an implicit packaging pick", async fault => {
    const remaining = await repackagingScenario();
    // Corrupt only this synthetic claim, not an immutable live model. The claim
    // hash and operation row agree, so the packaging/work guard must reject it.
    const row = (await context.pool.query("SELECT plan_payload FROM inventory.availability_claims WHERE id=$1",[claimId])).rows[0];
    const plan = claimPlanSchema.parse(row.plan_payload);
    const operation = plan.operations[0];
    if (fault === "missing_path") operation.authorityId = 2147483647;
    else operation.operationType = "component_build";
    await context.pool.query("UPDATE inventory.availability_claims SET plan_payload=$2,plan_hash=$3 WHERE id=$1",[claimId,JSON.stringify(plan),hash(plan)]);
    await context.pool.query("UPDATE inventory.availability_claim_operations SET authority_id=$2,operation_type=$3 WHERE claim_id=$1",
      [claimId,operation.authorityId,operation.operationType]);
    const before = await evidence();
    await expect(owner.pickClaimLine(remaining)).rejects.toMatchObject({ code:"CLAIM_PICK_OPERATION_REQUIRES_WORK" });
    expect(await evidence()).toEqual(before);
  });

  it("prevents two distinct pick commands from spending the remaining repackaging inputs twice", async () => {
    const remaining = await repackagingScenario();
    const results = await Promise.allSettled([owner.pickClaimLine(remaining),
      owner.pickClaimLine({ ...remaining,idempotencyKey:"competing-repack-pick" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await context.pool.query("SELECT variant_qty,reserved_qty FROM inventory.inventory_levels WHERE id=30")).rows)
      .toEqual([{ variant_qty:20,reserved_qty:0 }]);
    expect((await context.pool.query("SELECT count(*)::int AS n FROM inventory.availability_claim_commands WHERE claim_id=$1 AND command_type='execute'",[claimId])).rows[0].n).toBe(1);
  });
  it("atomically opens one case, picks two packs, retains 38 surplus packs and replays exactly once", async () => {
    const results = await Promise.all([owner.pickClaimLine(command()), owner.pickClaimLine(command())]);
    expect(results.map(result => result.idempotentReplay).sort()).toEqual([false,true]);
    expect((await context.pool.query("SELECT id,variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id:10,variant_qty:58,reserved_qty:3,picked_qty:4 }, { id:20,variant_qty:1,reserved_qty:0,picked_qty:0 },
        { id:30,variant_qty:0,reserved_qty:0,picked_qty:0 }]);
    expect((await context.pool.query("SELECT status,executed_executions::text FROM inventory.availability_claim_operations")).rows)
      .toEqual([{ status:"completed",executed_executions:"1" }]);
    expect((await context.pool.query("SELECT qty,total_cost_mills::text FROM oms.order_item_costs WHERE order_item_id=21")).rows)
      .toEqual([{ qty:2,total_cost_mills:"200" }]);
    const before = await evidence();
    await expect(owner.pickClaimLine(command())).resolves.toMatchObject({ idempotentReplay:true });
    expect(await evidence()).toEqual(before);
    // The actual ledger's denormalized views can be rebuilt from its entries.
    expect((await context.pool.query(`SELECT count(*)::int AS bad FROM inventory.quantity_lot_balances balance
      JOIN inventory.inventory_lots lot ON lot.id=balance.inventory_lot_id
      WHERE lot.qty_on_hand<>balance.on_hand OR lot.qty_reserved<>balance.reserved OR lot.qty_picked<>balance.picked`)).rows[0].bad).toBe(0);
  });
  it("rolls conversion, lot/cost lineage and journals back when final WMS progress fails", async () => {
    const before = await evidence();
    await context.pool.query(`CREATE FUNCTION wms.fail_case_pick() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected final pick failure'; END $$;
      CREATE TRIGGER fail_case_pick BEFORE UPDATE ON wms.order_items FOR EACH ROW EXECUTE FUNCTION wms.fail_case_pick()`);
    await expect(owner.pickClaimLine(command())).rejects.toThrow("injected final pick failure");
    expect(await evidence()).toEqual(before);
    await context.pool.query("DROP TRIGGER fail_case_pick ON wms.order_items");
    await expect(owner.pickClaimLine(command())).resolves.toMatchObject({ outcome:"picked" });
  });
  it("uses the completed conversion for later partial picks without opening another case", async () => {
    await owner.pickClaimLine(command({ quantity:"1", wmsProgress:{ expectedStatus:"pending",expectedPickedQuantity:0,
      targetStatus:"in_progress",targetPickedQuantity:1 } }));
    await owner.pickClaimLine(command({ quantity:"1",idempotencyKey:"second-pack",wmsProgress:{ expectedStatus:"in_progress",expectedPickedQuantity:1,
      targetStatus:"completed",targetPickedQuantity:2 } }));
    expect((await context.pool.query("SELECT count(*)::int AS n FROM inventory.availability_claim_commands WHERE command_type='execute'")).rows[0].n).toBe(1);
  });
  it("rejects a competing new command after one picker consumes the claim", async () => {
    const results = await Promise.allSettled([owner.pickClaimLine(command()), owner.pickClaimLine(command({ idempotencyKey:"competing-pick" }))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await context.pool.query("SELECT count(*)::int AS n FROM inventory.availability_claim_commands WHERE command_type='execute'")).rows[0].n).toBe(1);
    expect((await context.pool.query("SELECT picked_quantity FROM wms.order_items WHERE id=21")).rows[0].picked_quantity).toBe(2);
  });
  it("preserves twelve existing picks and materializes only the remaining case-backed two", async () => {
    // Seed a reviewed mixed claim: twelve ready packs plus two from a case.
    // The physical reservation and both picks still use the real owners.
    await context.transaction(async client => {
      const stored = (await client.query("SELECT plan_payload FROM inventory.availability_claims WHERE id=$1", [claimId])).rows[0];
      const plan = claimPlanSchema.parse(stored.plan_payload);
      plan.lines[0] = { ...plan.lines[0], requestedQty:"14",plannedQty:"14" };
      plan.fulfillmentGroups[0].lineAllocations[0].plannedQty = "14";
      plan.resourceClaims.push({ lineKey:"order-item:21",consumerOperationKey:null,warehouseId:1,
        warehouseLocationId:100,inventoryLevelId:10,sourceVariantId:101,claimedQty:"12" });
      await client.query("UPDATE inventory.availability_claims SET plan_payload=$2,plan_hash=$3 WHERE id=$1", [claimId,JSON.stringify(plan),hash(plan)]);
      await client.query("UPDATE inventory.availability_claim_lines SET requested_qty=14,planned_qty=14 WHERE claim_id=$1", [claimId]);
      await client.query("UPDATE wms.order_items SET quantity=14 WHERE id=21");
      const resource = (await client.query(`INSERT INTO inventory.availability_claim_resources(claim_id,claim_line_id,warehouse_id,
        warehouse_location_id,inventory_level_id,source_variant_id,claimed_qty)
        SELECT claim_id,id,1,100,10,101,12 FROM inventory.availability_claim_lines WHERE claim_id=$1 RETURNING id`, [claimId])).rows[0];
      const allocations = await new PostgresCanonicalClaimInventoryRepository().reserveResource({
        client,commandKey:"seed-ready-packs",claimId:BigInt(claimId),claimResourceId:BigInt(resource.id),
        inventoryLevelId:10,warehouseLocationId:100,sourceVariantId:101,claimedQty:12,orderId:2,orderItemId:21,
        consumerOperationKey:null,actor:"fixture",occurredAt:now,
      });
      for (const allocation of allocations) await client.query(`INSERT INTO inventory.availability_claim_lot_allocations
        (claim_id,claim_resource_id,inventory_lot_id,claimed_qty,unit_cost_mills,po_unit_cost_mills,packaging_unit_cost_mills,landed_unit_cost_mills)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [claimId,resource.id,allocation.inventoryLotId,allocation.qty,
        allocation.unitCostMills.toString(),allocation.poUnitCostMills.toString(),allocation.packagingUnitCostMills.toString(),allocation.landedUnitCostMills.toString()]);
    });
    await owner.pickClaimLine(command({ quantity:"12",idempotencyKey:"twelve-ready-packs",wmsProgress:{
      expectedStatus:"pending",expectedPickedQuantity:0,targetStatus:"in_progress",targetPickedQuantity:12 } }));
    expect((await context.pool.query("SELECT status FROM inventory.availability_claim_operations")).rows[0].status).toBe("pending");
    const earlier = (await context.pool.query("SELECT * FROM inventory.availability_claim_pick_movements ORDER BY id")).rows;
    await owner.pickClaimLine(command({ wmsProgress:{ expectedStatus:"in_progress",expectedPickedQuantity:12,
      targetStatus:"completed",targetPickedQuantity:14 } }));
    expect((await context.pool.query("SELECT picked_quantity FROM wms.order_items WHERE id=21")).rows[0].picked_quantity).toBe(14);
    const movements = (await context.pool.query("SELECT * FROM inventory.availability_claim_pick_movements ORDER BY id")).rows;
    expect(movements.slice(0,earlier.length)).toEqual(earlier);
    expect(movements.slice(earlier.length).map(row => row.quantity)).toEqual(["2"]);
  });
  it.each(["shipped","cancelled","held"])("does not convert stock for an unauthorized %s order", async status => {
    await context.pool.query("UPDATE wms.orders SET warehouse_status=$1,on_hold=$2 WHERE id=2", [status === "held" ? "ready" : status, status === "held" ? 1 : 0]);
    const before = await evidence();
    await expect(owner.pickClaimLine(command())).rejects.toMatchObject({ code:"CLAIM_ORDER_NOT_PICKABLE" });
    expect(await evidence()).toEqual(before);
  });
  it("honors queued replenishment instead of auto-opening cases", async () => {
    await context.pool.query("UPDATE inventory.warehouse_settings SET replen_mode='queue'");
    const before = await evidence();
    await expect(owner.pickClaimLine(command())).rejects.toMatchObject({ code:"CLAIM_PICK_REPLENISHMENT_REQUIRED" });
    expect(await evidence()).toEqual(before);
  });
  it("uses warehouse-code and DEFAULT fallback but respects the SKU manual override", async () => {
    await context.pool.query("UPDATE inventory.warehouse_settings SET warehouse_id=NULL");
    await context.pool.query("INSERT INTO inventory.replen_rules(id,pick_product_variant_id,is_active,auto_replen) VALUES(1,101,1,2)");
    const before = await evidence();
    await expect(owner.pickClaimLine(command())).rejects.toMatchObject({ code:"CLAIM_PICK_REPLENISHMENT_REQUIRED" });
    expect(await evidence()).toEqual(before);
    await context.pool.query("UPDATE inventory.replen_rules SET auto_replen=0; UPDATE inventory.warehouse_settings SET warehouse_code='DEFAULT'");
    await expect(owner.pickClaimLine(command())).resolves.toMatchObject({ outcome:"picked" });
  });
  it("recovers an already-confirmed Yes on a shipped order through the real correction and inventory owners", async () => {
    await context.pool.query(`UPDATE wms.orders SET warehouse_status='shipped' WHERE id=2;
      UPDATE wms.order_items SET fulfilled_quantity=2 WHERE id=21;
      INSERT INTO wms.physical_shipments(id,provider,provider_physical_shipment_id,status) VALUES(20,'shipstation','test-case-shipment','shipped');`);
    const db = drizzle(context.pool);
    await observeMissingPick(db, { orderItemId:21,physicalShipmentId:20,declaredQuantity:2,pickedQuantity:0,occurredAt:now });
    const id = (await context.pool.query("SELECT id FROM wms.pick_corrections")).rows[0].id;
    const service = new PickCorrectionService(db, async ({ correction, actor, targetQuantity }) => {
      await owner.pickClaimLine(command({ actor, wmsProgress: { expectedStatus:"pending", expectedPickedQuantity:0,
        expectedFulfilledQuantity:2,pickCorrectionId:id,pickCorrectionRevision:correction.revision,
        targetStatus:"completed",targetPickedQuantity:targetQuantity } }));
    }, () => now);
    const accepted = { commandId:"526b2451-c6c1-464f-bf55-d4e144c12c69",expectedRevision:1,answer:"yes" };
    await context.pool.query("UPDATE inventory.warehouse_settings SET replen_mode='queue'");
    await expect(service.answer(id, accepted, "picker")).rejects.toMatchObject({ code:"CLAIM_PICK_REPLENISHMENT_REQUIRED" });
    await context.pool.query("UPDATE inventory.warehouse_settings SET replen_mode='inline'");
    await expect(service.answer(id, accepted, "picker")).resolves.toMatchObject({ state:"resolved",pickedQuantity:2,answer:"yes" });
    const before = await evidence();
    await service.answer(id, accepted, "picker");
    expect(await evidence()).toEqual(before);
    expect((await context.pool.query("SELECT warehouse_status FROM wms.orders WHERE id=2")).rows[0].warehouse_status).toBe("shipped");
    expect((await context.pool.query("SELECT fulfilled_quantity FROM wms.order_items WHERE id=21")).rows[0].fulfilled_quantity).toBe(2);
  });
});
