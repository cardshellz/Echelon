import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { installUnopenedQuantityLedgerFixture } from "../../../inventory/__tests__/fixtures/pre-opening-quantity-authority.fixture";
import { PostgresInventoryCutoverReconstructionRepository } from "../../infrastructure/inventory-cutover-reconstruction.repository";
import { planCutoverReconstruction } from "../../domain/inventory-cutover-reconstruction";
import { planFreshCutoverClaims } from "../../domain/inventory-cutover-reconstruction-planning";
import { reconstructionSupply } from "../fixtures/inventory-cutover-reconstruction.fixture";
import { reconstructionDatabaseFixtureSql, reconstructionDatabaseSeedSql } from "../fixtures/inventory-cutover-reconstruction-database.fixture";
import { captureActiveClaimSupplySnapshotInsideTransaction } from "../../infrastructure/inventory-availability-shadow.repository";
import { PostgresInventoryAvailabilityClaimRepository } from "../../infrastructure/inventory-availability-claim.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { PostgresInventoryCutoverLegacyPromiseRepository } from "../../../inventory/infrastructure/inventory-cutover-legacy-promise.repository";

vi.mock("../../infrastructure/inventory-availability-shadow.repository", () => ({ captureActiveClaimSupplySnapshotInsideTransaction: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;

dbDescribe.sequential("reviewed reconstruction with real claim DDL and inventory owner", () => {
  let database: InventoryCutoverTestDatabase;
  const repository = new PostgresInventoryCutoverReconstructionRepository();
  it("completes a NULL journal order from its exact item FK and leaves the journal unchanged", async () => transaction(async (client) => {
    await client.query("UPDATE inventory.inventory_transactions SET order_id=NULL WHERE transaction_type='pick'");
    const evidence = await repository.capture(client);
    expect(evidence.journals).toMatchObject([{ orderId: 1, orderItemId: 11, reservedQty: "3", pickedQty: "2",
      identityCompletedCount: "1", unknownCount: "0", journalCount: "2", issues: [] }]);
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready: true, blockers: [] });
    expect((await client.query("SELECT order_id FROM inventory.inventory_transactions WHERE transaction_type='pick'")).rows[0].order_id).toBeNull();
  }));
  it("completes NULL source-journal owners through exact customer source FKs without supplying cost or quantity", async () => transaction(async (client) => {
    await client.query(`INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(50,1,'planned');
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,product_variant_id,qty,from_location_id)
        VALUES(51,50,11,101,6,100);
      UPDATE inventory.inventory_transactions SET order_id=NULL,order_item_id=NULL,shipment_id=50,shipment_item_id=51 WHERE transaction_type='pick'`);
    const evidence = await repository.capture(client);
    expect(evidence.journals).toMatchObject([{ orderId: 1, orderItemId: 11, reservedQty: "3", pickedQty: "2", identityCompletedCount: "1", issues: [] }]);
    expect(planCutoverReconstruction(evidence)).toMatchObject({ ready: true, blockers: [] });
    const originalHash = evidence.journals[0].journalHash;
    await client.query("UPDATE inventory.inventory_transactions SET notes='Additional original evidence' WHERE transaction_type='pick'");
    const rawChanged = (await repository.capture(client)).journals[0].journalHash;
    expect(rawChanged).not.toBe(originalHash);
    await client.query("UPDATE wms.outbound_shipment_items SET qty=5 WHERE id=51");
    expect((await repository.capture(client)).journals[0].journalHash).not.toBe(rawChanged);
    expect((await client.query("SELECT order_id,order_item_id FROM inventory.inventory_transactions WHERE transaction_type='pick'")).rows[0])
      .toEqual({ order_id: null, order_item_id: null });
    await client.query("UPDATE inventory.inventory_transactions SET reserved_qty_delta=NULL WHERE transaction_type='pick'");
    const missingDelta = await repository.capture(client);
    expect(missingDelta.journals[0]).toMatchObject({ orderId: 1, orderItemId: 11, reservedQty: "5", identityCompletedCount: "1",
      unknownCount: "1", issues: [{ code: "RESERVATION_DELTA_MISSING", transactionCount: "1" }] });
    expect(planCutoverReconstruction(missingDelta).blockers).toContainEqual(expect.objectContaining({ code: "JOURNAL_CUSTODY_UNKNOWN",
      message: expect.stringContaining("RESERVATION_DELTA_MISSING") }));
    await client.query("UPDATE inventory.inventory_transactions SET reserved_qty_delta=-2 WHERE transaction_type='pick'; DELETE FROM oms.order_item_costs");
    expect(planCutoverReconstruction(await repository.capture(client)).blockers.map((blocker) => blocker.code)).toContain("PICK_COST_CUSTODY_MISMATCH");
  }));
  it("does not complete an item owner across a conflicting directly recorded shipment header", async () => transaction(async (client) => {
    await client.query(`INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(50,99,'planned');
      UPDATE inventory.inventory_transactions SET order_id=NULL,shipment_id=50 WHERE transaction_type='pick'`);
    const evidence = await repository.capture(client);
    expect(evidence.journals.find((journal) => journal.orderId === null)).toMatchObject({ orderItemId: 11,
      identityCompletedCount: "0", unknownCount: "1", issues: [{ code: "OWNER_FOREIGN_KEY_CONFLICT" }] });
    expect(planCutoverReconstruction(evidence).ready).toBe(false);
  }));
  it.each([1, null])("keeps the actual legacy replacement journal association blocked without misreporting a customer FK conflict (order: %s)", async (orderId) => transaction(async (client) => {
    // ShipStation's loader uses COALESCE(order_item_id,replacement_for_order_item_id)
    // as inventory_order_item_id; the replacement recorder persists that direct ID.
    await client.query(`INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(50,1,'shipped');
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,replacement_for_order_item_id,
        product_variant_id,qty,from_location_id,shipment_item_purpose) VALUES(51,50,NULL,11,101,2,100,'replacement')`);
    await client.query(`INSERT INTO inventory.inventory_transactions(order_id,order_item_id,product_variant_id,
      from_location_id,transaction_type,variant_qty_delta,reserved_qty_delta,source_state,shipment_id,shipment_item_id)
      VALUES($1,11,101,100,'ship',-2,NULL,'picked',50,51)`, [orderId]);
    const evidence = await repository.capture(client);
    const blockedJournal = evidence.journals.find((journal) => journal.unknownCount !== "0");
    expect(blockedJournal).toMatchObject({ orderId, orderItemId: 11, identityCompletedCount: "0", unknownCount: "1",
      issues: [{ code: "SOURCE_PURPOSE_UNSUPPORTED", transactionCount: "1" }] });
    const plan = planCutoverReconstruction(evidence);
    expect(plan.ready).toBe(false);
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "JOURNAL_CUSTODY_UNKNOWN",
      message: expect.stringContaining("SOURCE_PURPOSE_UNSUPPORTED") }));
    expect(plan.legacyPromiseReleases).toEqual([]);
  }));
  it.each([
    ["recorded order conflict", "UPDATE inventory.inventory_transactions SET order_id=99 WHERE transaction_type='pick'", "OWNER_FOREIGN_KEY_CONFLICT"],
    ["source variant conflict", "UPDATE wms.outbound_shipment_items SET product_variant_id=999 WHERE id=51", "OWNER_FOREIGN_KEY_CONFLICT"],
    ["replacement", "UPDATE wms.outbound_shipment_items SET shipment_item_purpose='replacement' WHERE id=51", "SOURCE_PURPOSE_UNSUPPORTED"],
    ["voided source", "UPDATE wms.outbound_shipments SET status='voided' WHERE id=50", "SOURCE_LIFECYCLE_UNSAFE"],
    ["review source", "UPDATE wms.outbound_shipments SET requires_review=true WHERE id=50", "SOURCE_LIFECYCLE_UNSAFE"],
    ["source bin conflict", "UPDATE wms.outbound_shipment_items SET from_location_id=999 WHERE id=51", "LOCATION_IDENTITY_UNRESOLVED"],
    ["orphan source", "DELETE FROM wms.outbound_shipment_items WHERE id=51", "OWNER_FOREIGN_KEY_MISSING"],
  ])("retains %s instead of using a conflicting source identity", async (_name, mutation, code) => transaction(async (client) => {
    await client.query(`INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(50,1,'planned');
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,order_item_id,product_variant_id,qty,from_location_id) VALUES(51,50,11,101,6,100);
      UPDATE inventory.inventory_transactions SET order_id=NULL,order_item_id=NULL,shipment_id=50,shipment_item_id=51 WHERE transaction_type='pick'`);
    await client.query(mutation);
    const evidence = await repository.capture(client);
    const unresolved = evidence.journals.find((journal) => journal.orderItemId === null)!;
    expect(unresolved).toMatchObject({ orderItemId: null, identityCompletedCount: "0", unknownCount: "1", issues: [{ code }] });
    expect(planCutoverReconstruction(evidence).ready).toBe(false);
  }));
  it("excludes voided and canonical journals without treating them as historical owner evidence", async () => transaction(async (client) => {
    await client.query(`INSERT INTO inventory.inventory_transactions(order_id,order_item_id,product_variant_id,from_location_id,transaction_type,variant_qty_delta,reserved_qty_delta,source_state,voided_at,reference_type)
      VALUES(NULL,NULL,101,100,'ship',-9,NULL,'on_hand',now(),NULL),(NULL,NULL,101,100,'ship',-9,NULL,'on_hand',NULL,'availability_claim_dispatch')`);
    const evidence = await repository.capture(client);
    expect(evidence.journals).toMatchObject([{ journalCount: "2", unknownCount: "0", issues: [] }]);
    expect(planCutoverReconstruction(evidence).ready).toBe(true);
  }));
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, reconstructionDatabaseFixtureSql);
    await installUnopenedQuantityLedgerFixture(database.pool);
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
  async function seedEmptyBinPromise(client: PoolClient, supplyQty = 20) {
    await client.query(`DELETE FROM oms.order_item_costs; DELETE FROM inventory.inventory_transactions;
      UPDATE wms.order_items SET picked_quantity=0;
      UPDATE inventory.inventory_levels SET variant_qty=0,reserved_qty=6,picked_qty=0;
      UPDATE inventory.inventory_lots SET qty_on_hand=0,qty_reserved=0,qty_picked=0;
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id) VALUES(200,1);
      INSERT INTO inventory.inventory_transactions
        (order_id,order_item_id,product_variant_id,to_location_id,transaction_type,variant_qty_delta,
         variant_qty_before,variant_qty_after,reserved_qty_delta,source_state,target_state)
        VALUES(1,11,101,100,'reserve',0,0,0,6,'on_hand','committed')`);
    await client.query(`INSERT INTO inventory.inventory_levels
      (id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
      VALUES(20,200,101,$1,0,0,0)`, [supplyQty]);
    await client.query(`INSERT INTO inventory.inventory_lots
      (id,warehouse_location_id,product_variant_id,qty_on_hand,qty_reserved,qty_picked,status,received_at,
       unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills)
      VALUES(5,200,101,$1,0,0,'active','2026-09-01T00:00:00Z',1000,1000,0,0,1000)`, [supplyQty]);
  }
  it("hands off an exact empty-bin promise and replays without double release or double reservation", async () => transaction(async (client) => {
    await seedEmptyBinPromise(client);
    const { plan, planning, command } = await prepared(client);
    expect(plan.legacyPromiseReleases).toHaveLength(1);
    const physicalBefore = (await client.query("SELECT id,variant_qty,picked_qty,packed_qty FROM inventory.inventory_levels ORDER BY id")).rows;
    const lotsBefore = (await client.query("SELECT id,qty_on_hand,qty_picked,total_unit_cost_mills FROM inventory.inventory_lots ORDER BY id")).rows;
    const originalBinLot = (await client.query("SELECT * FROM inventory.inventory_lots WHERE id=4")).rows;
    const receipt = await repository.persistReviewed(client, command, planning.impactHash);
    expect(receipt.legacyPromiseReleases).toEqual(plan.legacyPromiseReleases);
    expect(receipt.legacyPromiseReleaseTransactionIds).toHaveLength(1);
    expect((await client.query("SELECT id,reserved_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id: 10, reserved_qty: 0 }, { id: 20, reserved_qty: 6 }]);
    expect((await client.query("SELECT id,variant_qty,picked_qty,packed_qty FROM inventory.inventory_levels ORDER BY id")).rows).toEqual(physicalBefore);
    expect((await client.query("SELECT id,qty_on_hand,qty_picked,total_unit_cost_mills FROM inventory.inventory_lots ORDER BY id")).rows).toEqual(lotsBefore);
    expect((await client.query("SELECT * FROM inventory.inventory_lots WHERE id=4")).rows).toEqual(originalBinLot);
    expect((await client.query("SELECT * FROM oms.order_item_costs")).rows).toEqual([]);
    expect((await client.query("SELECT requested_qty::text,planned_qty::text,shortfall_qty::text FROM inventory.availability_claim_lines")).rows)
      .toEqual([{ requested_qty: "6", planned_qty: "6", shortfall_qty: "0" }]);
    expect((await client.query("SELECT inventory_level_id,claimed_qty::text FROM inventory.availability_claim_resources")).rows)
      .toEqual([{ inventory_level_id: 20, claimed_qty: "6" }]);
    expect((await client.query(`SELECT order_id,order_item_id,variant_qty_delta,reserved_qty_delta,reference_id,user_id
      FROM inventory.inventory_transactions WHERE id=ANY($1::integer[])`, [receipt.legacyPromiseReleaseTransactionIds])).rows)
      .toEqual([{ order_id: 1, order_item_id: 11, variant_qty_delta: 0, reserved_qty_delta: -6,
        reference_id: "cutover:1:item:11", user_id: "cutover-operator" }]);
    expect(await repository.persistReviewed(client, { ...command, actor: "retry-worker" }, planning.impactHash)).toEqual(receipt);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows[0].count).toBe(1);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE reference_type='availability_claim'")).rows[0].count).toBe(1);
  }));
  it("keeps unmet promised demand as an explicit canonical shortfall", async () => transaction(async (client) => {
    await seedEmptyBinPromise(client, 2);
    const { planning, command } = await prepared(client);
    await repository.persistReviewed(client, command, planning.impactHash);
    expect((await client.query("SELECT requested_qty::text,planned_qty::text,shortfall_qty::text FROM inventory.availability_claim_lines")).rows)
      .toEqual([{ requested_qty: "6", planned_qty: "2", shortfall_qty: "4" }]);
    expect((await client.query("SELECT id,reserved_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id: 10, reserved_qty: 0 }, { id: 20, reserved_qty: 2 }]);
  }));
  it("retains ownerless reserve_move uncertainty at both source and destination positions", async () => transaction(async (client) => {
    await seedEmptyBinPromise(client);
    await client.query(`INSERT INTO inventory.inventory_transactions
      (product_variant_id,from_location_id,to_location_id,transaction_type,variant_qty_delta,reserved_qty_delta)
      VALUES(101,100,200,'reserve_move',1,NULL)`);
    const evidence = await repository.capture(client);
    const moves = evidence.journals.filter((journal) => journal.orderId === null);
    expect(moves.map((row) => ({ location: row.warehouseLocationId, unknown: row.unknownCount, reserved: row.reservedQty })))
      .toEqual([{ location: 100, unknown: "1", reserved: "0" }, { location: 200, unknown: "1", reserved: "0" }]);
    expect(moves[0].journalHash).toBe(moves[1].journalHash);
    const plan = planCutoverReconstruction(evidence);
    expect(plan.ready).toBe(false); expect(plan.legacyPromiseReleases).toEqual([]);
    expect(plan.blockers.filter((blocker) => blocker.code === "JOURNAL_CUSTODY_UNKNOWN")).toHaveLength(2);
  }));
  it.each(["counter", "owner", "lot"])("owner API rejects %s drift before its first write", async (kind) => transaction(async (client) => {
    await seedEmptyBinPromise(client);
    const { plan, command } = await prepared(client);
    if (kind === "counter") await client.query("UPDATE inventory.inventory_levels SET reserved_qty=5 WHERE id=10");
    if (kind === "owner") await client.query("UPDATE inventory.inventory_transactions SET notes='changed reviewed evidence' WHERE order_item_id=11");
    if (kind === "lot") await client.query("UPDATE inventory.inventory_lots SET qty_reserved=1 WHERE id=4");
    await expect(new PostgresInventoryCutoverLegacyPromiseRepository().releaseForReplanning({ client, command, releases: plan.legacyPromiseReleases }))
      .rejects.toMatchObject({ code: kind === "counter" ? "CUTOVER_PROMISE_POSITION_CHANGED"
        : kind === "owner" ? "CUTOVER_PROMISE_OWNER_CHANGED" : "CUTOVER_PROMISE_LOT_HOLD_CHANGED" });
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows[0].count).toBe(0);
  }));
  it("rolls back the handoff and claim headers if exact fresh allocation fails", async () => transaction(async (client) => {
    await seedEmptyBinPromise(client);
    const { planning, command } = await prepared(client);
    const writer = new PostgresCanonicalClaimInventoryRepository();
    vi.spyOn(writer, "reserveResource").mockRejectedValue(new Error("PROMISE_TEST_ALLOCATION_FAILURE"));
    await client.query("SAVEPOINT promise_handoff");
    await expect(new PostgresInventoryCutoverReconstructionRepository(writer).persistReviewed(client, command, planning.impactHash))
      .rejects.toThrow("PROMISE_TEST_ALLOCATION_FAILURE");
    await client.query("ROLLBACK TO SAVEPOINT promise_handoff");
    expect((await client.query("SELECT id,reserved_qty FROM inventory.inventory_levels ORDER BY id")).rows)
      .toEqual([{ id: 10, reserved_qty: 6 }, { id: 20, reserved_qty: 0 }]);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions WHERE reference_type='inventory_cutover_promise'")).rows[0].count).toBe(0);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.availability_claims")).rows[0].count).toBe(0);
    expect((await client.query("SELECT count(*)::int AS count FROM inventory.availability_cutover_reconstruction_receipts")).rows[0].count).toBe(0);
  }));
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
  it.each(["shipped", "completed", "cancelled"])("keeps %s outbound and physical reviews outside ordinary demand", async (status) => transaction(async (client) => {
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
    await client.query("UPDATE wms.orders SET warehouse_status=$1 WHERE id=ANY($2::integer[])", [status, [90,91]]);
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
  it.each(["shipped", "completed", "cancelled"])("censuses %s residual custody and ignored receipts without filtering", async (status) => transaction(async (client) => {
    await client.query("UPDATE wms.orders SET warehouse_status=$1", [status]);
    await client.query("INSERT INTO oms.channel_fulfillment_receipts(id,processing_status) VALUES(8,'ignored')");
    const plan = await repository.preview(client);
    expect(plan.blockers.map((row) => row.code)).toContain("TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW");
    expect(plan.blockers.map((row) => row.code)).toContain("SHIPMENT_RECEIPT_REQUIRES_REVIEW");
  }));
  it("does not recreate completed historical demand, but keeps null and unknown order states visible", async () => transaction(async (client) => {
    await client.query(`INSERT INTO wms.orders VALUES
      (90,NULL,'completed',0,36,'shopify','historical-90','fo-90','default'),
      (91,1,NULL,0,36,'shopify','unknown-91','fo-91','default'),
      (92,1,'invented',0,36,'shopify','unknown-92','fo-92','default');
      INSERT INTO wms.order_items
      (id,order_id,sku,product_id,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping)
      VALUES(900,90,'P5',101,6,0,0,'pending',false,1),
        (910,91,'P5',101,6,0,0,'pending',false,1),(920,92,'P5',101,6,0,0,'pending',false,1)`);
    const evidence = await repository.capture(client);
    expect(evidence.orders.map((order) => order.id)).toEqual([1,91,92]);
    expect(evidence.items.map((item) => item.id)).toEqual([11,910,920]);
    const plan = planCutoverReconstruction(evidence);
    expect(plan.orders.map((order) => order.orderId)).toEqual([1]);
    expect(plan.blockers).toEqual([
      { code: "ORDER_STATE_REQUIRES_REVIEW", subject: "order-item:910", message: expect.any(String) },
      { code: "ORDER_STATE_REQUIRES_REVIEW", subject: "order-item:920", message: expect.any(String) },
    ]);
    expect((await client.query("SELECT warehouse_id,warehouse_status FROM wms.orders WHERE id=90")).rows)
      .toEqual([{ warehouse_id: null, warehouse_status: "completed" }]);
  }));
  it.each([null, 999])("retains a completed residual item's real parent when journal order identity is %s", async (journalOrderId) => transaction(async (client) => {
    await client.query("UPDATE wms.orders SET warehouse_status='completed'; UPDATE wms.order_items SET picked_quantity=0");
    await client.query("UPDATE inventory.inventory_transactions SET order_id=$1", [journalOrderId]);
    const evidence = await repository.capture(client);
    expect(evidence.orders).toMatchObject([{ id: 1, status: "completed" }]);
    expect(evidence.items.map((item) => item.id)).toEqual([11]);
    expect(evidence.costs.map((cost) => cost.id)).toEqual([9]);
    const plan = planCutoverReconstruction(evidence);
    expect(plan.orders).toEqual([]);
    expect(plan.legacyPromiseReleases).toEqual([]);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("TERMINAL_ORDER_RESIDUAL_REQUIRES_REVIEW");
    expect(plan.blockers.map((blocker) => blocker.code)).not.toContain("DEMAND_OWNER_MISSING");
    // Main's exact-FK resolver may complete a NULL in captured evidence, but
    // neither that completion nor this census repairs stored or conflicting IDs.
    expect(evidence.journals.every((journal) => journal.orderId === (journalOrderId ?? 1))).toBe(true);
    const storedJournals = (await client.query("SELECT order_id FROM inventory.inventory_transactions")).rows;
    expect(storedJournals.every((journal) => journal.order_id === journalOrderId)).toBe(true);
    if (journalOrderId !== null) expect(evidence.journals[0].issues).toEqual([
      expect.objectContaining({ code: "OWNER_FOREIGN_KEY_CONFLICT" }),
    ]);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("ENCUMBRANCE_OWNER_UNRESOLVED");
  }));
  it("requires an admitted writer transaction", async () => {
    const client = await database.pool.connect();
    try { await client.query("BEGIN"); await expect(repository.capture(client)).rejects.toMatchObject({
      code: "CUTOVER_EVIDENCE_CAPTURE_FAILED", stage: "transaction_guard", cause: expect.objectContaining({ message: "exclusive fence required" }),
    }); }
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
