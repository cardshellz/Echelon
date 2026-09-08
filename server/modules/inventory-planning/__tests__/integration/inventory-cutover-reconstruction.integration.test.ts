import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresInventoryCutoverReconstructionRepository } from "../../infrastructure/inventory-cutover-reconstruction.repository";
import { planCutoverReconstruction } from "../../domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims } from "../../domain/inventory-cutover-reconstruction-planning";
import { reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { reconstructionDatabaseFixtureSql, reconstructionDatabaseSeedSql } from "../fixtures/inventory-cutover-reconstruction-database.fixture";
import { captureActiveClaimSupplySnapshotInsideTransaction } from "../../infrastructure/inventory-availability-shadow.repository";
import { PostgresInventoryAvailabilityClaimRepository } from "../../infrastructure/inventory-availability-claim.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";

vi.mock("../../infrastructure/inventory-availability-shadow.repository", () => ({ captureActiveClaimSupplySnapshotInsideTransaction: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe.sequential("reviewed reconstruction with real claim DDL and inventory owner", () => {
  let database: InventoryCutoverTestDatabase;
  const repository = new PostgresInventoryCutoverReconstructionRepository();
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, reconstructionDatabaseFixtureSql);
    for (const file of ["0640_inventory_availability_claim_lineage.sql","0642_inventory_availability_claim_execution_contract.sql",
      "0647_inventory_availability_claim_pick_lineage.sql","0649_inventory_availability_claim_replacement.sql","233_inventory_cutover_reconstruction.sql"]) {
      await database.pool.query(readFileSync(resolve(process.cwd(),"migrations",file),"utf8"));
    }
    await database.pool.query(reconstructionDatabaseSeedSql);
  });
  afterAll(async () => { await database?.close(); });
  async function transaction(work: (client: PoolClient) => Promise<void>) {
    const client = await database.pool.connect();
    try { await client.query("BEGIN; SET LOCAL test.cutover_admitted='yes'"); await work(client); }
    finally { await client.query("ROLLBACK"); client.release(); }
  }
  async function prepared(client: PoolClient) {
    const evidence = await repository.capture(client); const plan = planCutoverReconstruction(evidence);
    expect(plan.blockers).toEqual([]);
    const snapshot = reconstructionSupply(evidence); vi.mocked(captureActiveClaimSupplySnapshotInsideTransaction).mockResolvedValue(snapshot);
    const planning = planFreshCutoverClaims(snapshot,plan);
    const command = { expectedEvidenceHash: plan.evidenceHash, activationRunId: "1", runtimeAuthorityRevision: "2",
      actor: "cutover-operator", reason: "Reviewed exact legacy ownership", occurredAt: "2026-09-07T12:00:00.000Z" };
    return { evidence, plan, planning, command };
  }
  it("captures stable exact signed evidence in a caller read-only preview", async () => {
    const client = await database.pool.connect();
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const first = await repository.preview(client); const second = await repository.preview(client);
      expect(first).toEqual(second); expect(first.ready).toBe(true);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it.each(["planned", "queued", "labeled"])("recognizes genuine %s customer-fulfillment source rows", async (status) => transaction(async (client) => {
    await client.query("INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(90,1,$1)", [status]);
    // Use the production default instead of inventing a test-only purpose.
    await client.query(`INSERT INTO wms.outbound_shipment_items
      (id,shipment_id,order_item_id,product_variant_id,qty,from_location_id) VALUES(91,90,11,101,6,100)`);
    const evidence = await repository.capture(client);
    expect(evidence.sourceItems).toMatchObject([{ id:91, purpose:"customer_fulfillment", shipmentStatus:status }]);
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready:true, blockers:[] });
  }));
  it("keeps terminal-linked outbound and physical reviews outside the ordinary demand census", async () => transaction(async (client) => {
    await client.query(`
      INSERT INTO wms.orders VALUES
        (90,1,'shipped',0,36,'shopify','terminal-90','fo-90','default'),
        (91,1,'shipped',0,36,'shopify','terminal-91','fo-91','default');
      INSERT INTO wms.order_items
        (id,order_id,sku,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
        VALUES(900,90,'P5',1,1,1,'completed',false,1),(910,91,'P5',1,1,1,'completed',false,1);
      INSERT INTO wms.outbound_shipments(id,order_id,status,requires_review)
        VALUES(901,90,'shipped',true),(911,91,'shipped',false);
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,product_variant_id,qty)
        VALUES(902,901,900,101,1),(912,911,910,101,1);
      INSERT INTO wms.physical_shipments(id,status) VALUES(903,'review'),(913,'shipped');
      INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,wms_order_item_id,product_variant_id,sku,quantity_shipped)
        VALUES(904,903,900,101,'P5',1),(914,913,910,101,'P5',1);
    `);
    // Both owners exist, but neither has current demand or residual custody.
    // Physical rows have no legacy source link. Only the review predicates can
    // include 902/904; the structurally identical non-review controls stay out.
    const evidence = await repository.capture(client);
    expect(evidence.orders.map((row) => row.id)).toEqual([1]);
    expect(evidence.items.map((row) => row.id)).toEqual([11]);
    expect(evidence.sourceItems.map((row) => row.id)).toEqual([902]);
    expect(evidence.physicalItems.map((row) => row.id)).toEqual(["904"]);
    expect(evidence.shipmentReviewEvidence).toMatchObject([
      { id:"901", kind:"outbound_shipment_review", status:"shipped" },
    ]);
    const plan = planCutoverReconstruction(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code:"SHIPMENT_SOURCE_REQUIRES_REVIEW", subject:"source:902" }),
      expect.objectContaining({ code:"PHYSICAL_SHIPMENT_REQUIRES_REVIEW", subject:"physical:904" }),
      expect.objectContaining({ code:"SHIPMENT_RECEIPT_REQUIRES_REVIEW", subject:"outbound_shipment_review:901" }),
    ]));
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);

    await client.query("UPDATE wms.outbound_shipments SET requires_review=false WHERE id=901; UPDATE wms.physical_shipments SET status='shipped' WHERE id=903");
    const resolved = await repository.capture(client);
    expect(resolved.sourceItems).toEqual([]);
    expect(resolved.physicalItems).toEqual([]);
    expect(resolved.shipmentReviewEvidence).toEqual([]);
    expect(planCutoverReconstruction(resolved)).toMatchObject({ ready:true, blockers:[] });
  }));
  it.each(["requires_review", "ignored"])("rejects invented outbound lifecycle %s in the real enum fixture", async (status) => transaction(async (client) => {
    await expect(client.query("INSERT INTO wms.outbound_shipments(id,status) VALUES(90,$1)", [status]))
      .rejects.toMatchObject({ code:"22P02" });
  }));
  it.each(["requires_review", "ignored"])("rejects invented physical lifecycle %s in the production check fixture", async (status) => transaction(async (client) => {
    await expect(client.query("INSERT INTO wms.physical_shipments(id,status) VALUES(90,$1)", [status]))
      .rejects.toMatchObject({ code:"23514", constraint:"physical_shipments_status_chk" });
  }));
  it("rejects the invented ordered source purpose in the production check fixture", async () => transaction(async (client) => {
    await expect(client.query("INSERT INTO wms.outbound_shipment_items(id,shipment_item_purpose) VALUES(90,'ordered')"))
      .rejects.toMatchObject({ code:"23514", constraint:"outbound_shipment_items_purpose_chk" });
  }));
  it("adopts original pick/lot/mills lineage and reserves only the fresh remainder", async () => transaction(async (client) => {
    const { planning, command } = await prepared(client);
    const beforeCosts = (await client.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows;
    const receipt = await repository.persistReviewed(client,command,planning.impactHash);
    expect(receipt.claimIds).toHaveLength(1);
    expect((await client.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels")).rows).toEqual([{ variant_qty:20,reserved_qty:4,picked_qty:2 }]);
    expect((await client.query("SELECT qty_on_hand,qty_reserved,qty_picked FROM inventory.inventory_lots")).rows).toEqual([{ qty_on_hand:20,qty_reserved:4,qty_picked:2 }]);
    expect((await client.query("SELECT * FROM oms.order_item_costs ORDER BY id")).rows).toEqual(beforeCosts);
    expect((await client.query("SELECT requested_qty::text,planned_qty::text,picked_target_qty::text FROM inventory.availability_claim_lines")).rows)
      .toEqual([{ requested_qty:"6",planned_qty:"6",picked_target_qty:"2" }]);
    expect((await client.query("SELECT quantity::text,unit_cost_mills::text,total_cost_mills::text,order_item_cost_id FROM inventory.availability_claim_pick_movements")).rows)
      .toEqual([{ quantity:"2",unit_cost_mills:"9007199254740995",total_cost_mills:"18014398509481990",order_item_cost_id:9 }]);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE reference_type='availability_claim'")).rows[0].count).toBe(1);
    const replay = await repository.persistReviewed(client,{ ...command,actor:"retry-worker",reason:"later retry" },planning.impactHash);
    expect(replay).toEqual(receipt);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(1);
    expect((await client.query("SELECT DISTINCT actor FROM inventory.availability_claim_commands")).rows).toEqual([{ actor:"cutover-operator" }]);
  }));
  it("rejects evidence drift before inserting claims or modifying stock", async () => transaction(async (client) => {
    const { planning,command } = await prepared(client);
    await client.query("UPDATE inventory.inventory_lots SET qty_reserved=4 WHERE id=4");
    await expect(repository.persistReviewed(client,command,planning.impactHash)).rejects.toMatchObject({ code:"CUTOVER_RECONSTRUCTION_EVIDENCE_CHANGED" });
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
  }));
  it("ordinary short demand survives adoption and actual runtime demand comparison", async () => transaction(async (client) => {
    await client.query("UPDATE wms.order_items SET status='short',short_reason='out_of_stock'");
    const { planning,command }=await prepared(client);
    await repository.persistReviewed(client,command,planning.impactHash);
    expect((await client.query("SELECT requested_qty::text,shortfall_qty::text FROM inventory.availability_claim_lines")).rows)
      .toEqual([{ requested_qty:"6",shortfall_qty:"0" }]);
  }));
  it("refund-after-pick cannot restore refunded demand", async () => transaction(async (client) => {
    await client.query("UPDATE wms.order_items SET status='short',short_reason='refund_after_pick',on_hold=true");
    const plan=await repository.preview(client);
    expect(plan.blockers.map((row) => row.code)).toContain("REFUND_AFTER_PICK_CUSTODY_REQUIRES_REVIEW");
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
  }));
  it("retains independent build holds across actual fresh allocation", async () => transaction(async (client) => {
    await client.query("INSERT INTO inventory.build_orders VALUES(3,'released',1); INSERT INTO inventory.build_order_components VALUES(2,3,101,100); INSERT INTO inventory.build_component_reservations VALUES(1,2,4,3,0,0,'build_order',NULL,NULL); UPDATE inventory.inventory_levels SET reserved_qty=6; UPDATE inventory.inventory_lots SET qty_reserved=6");
    const { planning,command } = await prepared(client);
    const receipt = await repository.persistReviewed(client,command,planning.impactHash);
    expect(receipt.retainedIndependentBuildReservationIds).toEqual([1]);
    expect((await client.query("SELECT reserved_qty FROM inventory.inventory_levels")).rows[0].reserved_qty).toBe(7);
    expect((await client.query("SELECT reserved_qty FROM inventory.build_component_reservations")).rows[0].reserved_qty).toBe(3);
  }));
  it("censuses historical terminal demand, orphan lots and ignored receipts without filtering", async () => transaction(async (client) => {
    await client.query("UPDATE wms.orders SET warehouse_status='shipped'; INSERT INTO oms.channel_fulfillment_receipts VALUES(8,'ignored')");
    const plan = await repository.preview(client);
    expect(plan.blockers.map((row) => row.code)).toContain("TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW");
    expect(plan.blockers.map((row) => row.code)).toContain("SHIPMENT_RECEIPT_REQUIRES_REVIEW");
  }));
  it("requires an admitted writer transaction", async () => {
    const client = await database.pool.connect();
    try { await client.query("BEGIN"); await expect(repository.capture(client)).rejects.toThrow("exclusive fence required"); }
    finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("rolls back every adoption/fresh hold when the caller fails after persistence", async () => {
    await transaction(async (client) => { const { planning,command } = await prepared(client); await repository.persistReviewed(client,command,planning.impactHash); });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT reserved_qty FROM inventory.inventory_levels")).rows[0].reserved_qty).toBe(3);
  });
  it("commits imported partial custody then picks only the four remaining units with real owners", async () => {
    const client=await database.pool.connect(); let claimId: string;
    try { await client.query("BEGIN; SET LOCAL test.cutover_admitted='yes'");
      const { planning,command }=await prepared(client);
      const receipt=await repository.persistReviewed(client,command,planning.impactHash); claimId=receipt.claimIds[0];
      await client.query("COMMIT");
    } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    const picker=new PostgresInventoryAvailabilityClaimRepository(new PostgresCanonicalClaimInventoryRepository(),database.pool,() => new Date("2026-09-07T12:10:00Z"));
    const command={ claimId,orderItemId:11,warehouseLocationId:100,quantity:"4",locationStrategy:"strict" as const,
      idempotencyKey:"cutover-partial-pick-remaining",actor:"picker",reason:"Complete remaining physical units",
      wmsProgress:{ expectedStatus:"pending" as const,expectedPickedQuantity:2,targetStatus:"completed" as const,targetPickedQuantity:6 } };
    await picker.pickClaimLine(command);
    expect((await database.pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels")).rows)
      .toEqual([{ variant_qty:16,reserved_qty:0,picked_qty:6 }]);
    expect((await database.pool.query("SELECT status,picked_quantity FROM wms.order_items")).rows).toEqual([{ status:"completed",picked_quantity:6 }]);
    expect((await database.pool.query("SELECT id,qty,total_cost_mills::text FROM oms.order_item_costs ORDER BY id")).rows)
      .toEqual([{ id:9,qty:2,total_cost_mills:"18014398509481990" },{ id:100,qty:4,total_cost_mills:"36028797018963980" }]);
    await expect(picker.pickClaimLine(command)).resolves.toMatchObject({ idempotentReplay:true });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_item_costs")).rows[0].count).toBe(2);
  });
});
