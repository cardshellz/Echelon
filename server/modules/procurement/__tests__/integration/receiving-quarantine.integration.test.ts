import { verifiedCustodyResultSchema } from "@shared/procurement/receiving-quarantine-command";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { type ReceivingQuarantineCommandResult } from "@shared/procurement/receiving-quarantine";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { fixtureTable, fixtureForeignKeys } from "./shipment-line-fixture";
import { createFlowCostHarness, seedFlowMasterData, FLOW_AT, type FlowCostHarness } from "./procurement-flow-cost.fixture";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import type { ReceivingCustodyCommand } from "../../receiving-quarantine.service";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const run = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const ACTOR = "custody-approver";
const REFERENCE = "Inspected physical goods, photo evidence 42";
run.sequential("real receiving custody commands and normal inventory recognition", () => {
  let harness: FlowCostHarness;
  let commands: ReturnType<typeof import("../../receiving-quarantine.commands").createReceivingCustodyCommands>;
  let identityHash: typeof import("../../receiving-quarantine.commands").hashCustodyCommandIdentity;
  let scope: typeof import("../../receiving-quarantine.commands").custodyCommandScope;
  let options: typeof import("../../receiving-quarantine-options.repository").readQuarantineAcceptanceOptions;
  let readView: typeof import("../../receiving-quarantine.service").readReceivingQuarantineView;
  let ownsIdentity = false;
  beforeAll(async () => {
    harness = await createFlowCostHarness(url!);
    await seedFlowMasterData(harness);
    await harness.pool.query("CREATE SCHEMA identity");
    ownsIdentity = true;
    const tables = [schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions];
    for (const table of tables) await harness.pool.query(fixtureTable(table));
    for (const ddl of fixtureForeignKeys(tables)) await harness.pool.query(ddl);
    await harness.pool.query(`INSERT INTO identity.users(id,username,password,role,active) VALUES
      ('custody-approver','custody-approver','unused','picker',1),('custody-inventory','custody-inventory','unused','admin',1),
      ('custody-inactive','custody-inactive','unused','admin',0),('custody-scoped','custody-scoped','unused','admin',1);
      INSERT INTO identity.auth_roles(id,name,is_system) VALUES(1,'Approver',0),(2,'Inventory',0),(3,'Scoped',0);
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(1,'inventory','adjust','inventory'),(2,'purchasing','approve','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('custody-approver',1),('custody-inventory',2),('custody-inactive',1),('custody-scoped',3);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,1,NULL),(1,2,NULL),(2,1,NULL),(3,1,'{"warehouseId":1}'),(3,2,'{"warehouseId":1}')`);
    const commandModule = await import("../../receiving-quarantine.commands");
    const repository = await import("../../../../platform/commands/command-results.repository");
    commands = commandModule.createReceivingCustodyCommands(harness.receiving, repository.createDrizzleFinancialCommandRepository(harness.database), () => FLOW_AT);
    scope = commandModule.custodyCommandScope;
    identityHash = commandModule.hashCustodyCommandIdentity;
    options = (await import("../../receiving-quarantine-options.repository")).readQuarantineAcceptanceOptions;
    readView = (await import("../../receiving-quarantine.service")).readReceivingQuarantineView;
  });
  afterAll(async () => {
    try { if (ownsIdentity) await harness.pool.query("DROP SCHEMA identity CASCADE"); }
    finally { await harness?.dispose(); }
  });
  function descriptor(command: ReceivingCustodyCommand, id: number, body: unknown, key: string, actorId: string): FinancialCommandDescriptor {
    return { ...scope(), actorType: "service", actorId: "procurement.receiving-custody", idempotencyKey: key,
      requestHash: identityHash({ command, resourceId: id, body, actorId }), contractVersion: 1 };
  }
  async function execute(command: ReceivingCustodyCommand, id: number, body: unknown, key: string = randomUUID(), actorId = ACTOR) {
    return commands.execute(command, id, body, actorId, descriptor(command, id, body, key, actorId));
  }
  async function success(command: ReceivingCustodyCommand, id: number, body: unknown, key?: string): Promise<ReceivingQuarantineCommandResult> {
    const result = await execute(command, id, body, key);
    expect(result, JSON.stringify(result.body)).toMatchObject({ httpStatus: 200, terminalState: "succeeded" });
    return verifiedCustodyResultSchema.parse(result.body);
  }
  async function receipt() {
    const created = await harness.receiving.createOrder({ sourceType: "blind", warehouseId: 1 }, ACTOR);
    await harness.receiving.addLine(created.id, { productId: 100, productVariantId: 201, expectedUnitsPerVariant: 1,
      sku: "PROC-UAT-FLOW-A-EACH", productName: "A piece", expectedQty: 10, receivedQty: 10,
      damagedQty: 0, putawayLocationId: 99, unitCostMills: 12340, unitCost: 123 });
    const line = (await harness.storage.getReceivingLines(created.id, harness.database))[0];
    return { order: created, line };
  }
  const unknownBody = (quantity = 5) => ({ kind: "unidentified", quantity, unitLabel: "sealed bag",
    description: "Unidentified delivery", observedSku: null, condition: "unexpected", holdingLocationId: 100,
    reason: REFERENCE, evidenceReference: "photo-42" });
  async function unknown() {
    const source = await receipt();
    const result = await success("intake", source.order.id, unknownBody());
    return { ...source, result };
  }
  async function acceptanceBody(receiptId: number, version = 0, observationQty = 2, acceptedVariantQty = 3) {
    const source = await harness.database.transaction(tx => options(tx, receiptId, ACTOR, { q: "" }));
    const option = source.items.find(item => item.targetReceivingOrderId === null)!;
    expect(option).toBeDefined();
    return { expectedVersion: version, observationQty, targetReceivingOrderId: option.targetReceivingOrderId,
      targetSourceReceivingLineId: option.receivingLineId, expectedTargetUnitVersion: option.unitVersion,
      productVariantId: option.productVariantId, expectedUnitsPerVariant: option.unitsPerVariant, acceptedVariantQty,
      purchaseOrderLineId: option.purchaseOrderLineId, inboundShipmentLineId: option.inboundShipmentLineId,
      putawayLocationId: 99, reason: REFERENCE, countConversionReviewed: true };
  }
  async function stock() {
    return (await harness.pool.query(`SELECT (SELECT count(*)::int FROM inventory.inventory_transactions) AS transactions,
      (SELECT count(*)::int FROM inventory.inventory_lots) AS lots,
      (SELECT coalesce(sum(variant_qty),0)::text FROM inventory.inventory_levels) AS quantity,
      (SELECT count(*)::int FROM procurement.ap_payments) AS payments`)).rows[0];
  }
  it("records explicit accepted/held counts, clears ambiguous legacy damage and posts only accepted goods", async () => {
    const source = await receipt();
    await harness.pool.query("UPDATE procurement.receiving_lines SET damaged_qty=2 WHERE id=$1", [source.line.id]);
    const before = (await harness.storage.getReceivingLines(source.order.id, harness.database))[0];
    const physicalBefore = await stock();
    const result = await success("intake", source.order.id, { kind: "receipt_line", receivingLineId: before.id,
      expectedUnitVersion: receivingUnitVersion(before), acceptedQty: 8, heldQty: 2, countsReviewed: true,
      condition: "damaged", holdingLocationId: 100, reason: REFERENCE, evidenceReference: "photo-42" });
    expect(result.observation).toMatchObject({ observedQty: 2, physicalHeldQty: 2, productId: 100, unitsPerVariant: 1 });
    expect(await stock()).toEqual(physicalBefore);
    expect((await harness.pool.query("SELECT received_qty,damaged_qty FROM procurement.receiving_lines WHERE id=$1", [before.id])).rows[0])
      .toEqual({ received_qty: 8, damaged_qty: 0 });
    await harness.receiving.close(source.order.id, ACTOR);
    const posted = (await harness.pool.query("SELECT variant_qty_delta FROM inventory.inventory_transactions WHERE receiving_order_id=$1 AND transaction_type='receipt'", [source.order.id])).rows;
    expect(posted).toEqual([{ variant_qty_delta: 8 }]);
    const view = await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR));
    expect(view.observations[0].physicalHeldQty).toBe(2);
    await expect(harness.receiving.completeAllLines(source.order.id, {})).rejects.toThrow();
  });
  it("replays an intake once and refuses changed payload for its key", async () => {
    const source = await receipt(); const key = randomUUID(); const body = unknownBody();
    const first = await execute("intake", source.order.id, body, key);
    const replay = await execute("intake", source.order.id, body, key);
    expect(replay).toMatchObject({ replayed: true, body: first.body });
    await expect(execute("intake", source.order.id, unknownBody(6), key)).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
    expect((await harness.pool.query("SELECT count(*)::int AS n FROM procurement.receiving_quarantine_observations WHERE receiving_order_id=$1", [source.order.id])).rows[0].n).toBe(1);
  });
  it("prevents another authorized actor from executing the same unidentified-intake key", async () => {
    const source = await receipt(); const key = randomUUID(); const body = unknownBody();
    const before = await stock();
    const first = await execute("intake", source.order.id, body, key, ACTOR);
    await expect(execute("intake", source.order.id, body, key, "custody-inventory")).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
    expect(await execute("intake", source.order.id, body, key, ACTOR)).toMatchObject({ replayed: true, body: first.body });
    expect((await harness.pool.query("SELECT count(*)::int AS n FROM procurement.receiving_quarantine_observations WHERE receiving_order_id=$1", [source.order.id])).rows[0].n).toBe(1);
    expect(await stock()).toEqual(before);
  });
  it("rejects legacy observation evidence under a reused key without another intake", async () => {
    const source = await receipt(); const key = randomUUID(); const body = unknownBody();
    const { executeReceivingCustodyCommand } = await import("../../receiving-quarantine.service");
    await harness.database.transaction(tx => executeReceivingCustodyCommand(tx, harness.receiving, { command: "intake", resourceId: source.order.id, body,
      actorId: ACTOR, at: FLOW_AT, commandKey: key }));
    await expect(execute("intake", source.order.id, body, key, "custody-inventory")).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_LEGACY_RECOVERY_REQUIRED" });
    expect((await harness.pool.query("SELECT count(*)::int AS n FROM procurement.receiving_quarantine_observations WHERE receiving_order_id=$1", [source.order.id])).rows[0].n).toBe(1);
  });
  it("prepares partial unidentified acceptance without stock, then cancels it without deleting its source", async () => {
    const source = await unknown(); const before = await stock();
    const result = await success("prepare-acceptance", source.result.observation.id, await acceptanceBody(source.order.id));
    expect(result.observation).toMatchObject({ unallocatedQty: 3, awaitingReceiptQty: 2, physicalHeldQty: 5, receivedQty: 0 });
    expect(await stock()).toEqual(before);
    const cancelled = await success("cancel-acceptance", result.observation.id, { expectedVersion: 1, acceptanceId: result.acceptance!.id, reason: "Inspection needs another review" });
    expect(cancelled.observation).toMatchObject({ unallocatedQty: 5, awaitingReceiptQty: 0, physicalHeldQty: 5, version: 2 });
    expect((await harness.pool.query("SELECT received_qty,expected_qty FROM procurement.receiving_lines WHERE id=$1", [result.acceptance!.receivingLineId])).rows)
      .toEqual([{ received_qty: 0, expected_qty: 0 }]);
    await expect(harness.receiving.deleteLine(result.acceptance!.receivingLineId)).rejects.toThrow(/custody history/);
  });
  it("moves pending custody to received only with normal close and preserves reviewed manual cost", async () => {
    const source = await unknown();
    const prepared = await success("prepare-acceptance", source.result.observation.id, await acceptanceBody(source.order.id));
    await harness.receiving.close(source.order.id, ACTOR);
    const view = await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR));
    expect(view.observations[0]).toMatchObject({ awaitingReceiptQty: 0, receivedQty: 2, physicalHeldQty: 3, version: 2 });
    const transaction = (await harness.pool.query(`SELECT t.variant_qty_delta,l.total_unit_cost_mills::text AS cost
      FROM inventory.inventory_transactions t JOIN inventory.inventory_lots l ON l.id=t.inventory_lot_id
      WHERE t.receiving_line_id=$1 AND t.transaction_type='receipt'`, [prepared.acceptance!.receivingLineId])).rows;
    expect(transaction).toEqual([{ variant_qty_delta: 3, cost: "12340" }]);
    await harness.receiving.close(source.order.id, ACTOR);
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0].version).toBe(2);
  });
  it("keeps pending custody and inventory unchanged when receipt close fails", async () => {
    const source = await unknown();
    const prepared = await success("prepare-acceptance", source.result.observation.id, await acceptanceBody(source.order.id));
    const before = await stock();
    await harness.pool.query("UPDATE warehouse.warehouse_locations SET is_active=0 WHERE id=99");
    try { await expect(harness.receiving.close(source.order.id, ACTOR)).rejects.toThrow(); }
    finally { await harness.pool.query("UPDATE warehouse.warehouse_locations SET is_active=1 WHERE id=99"); }
    expect(await stock()).toEqual(before);
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0])
      .toMatchObject({ awaitingReceiptQty: 2, receivedQty: 0, physicalHeldQty: 5, version: 1 });
    await success("cancel-acceptance", prepared.observation.id, { expectedVersion: 1, acceptanceId: prepared.acceptance!.id, reason: "Release failed; retain custody" });
  });
  it("records physical return without stock, supplier payment or credit effects", async () => {
    const source = await unknown(); const before = await stock();
    const returned = await success("return", source.result.observation.id, { expectedVersion: 0, observationQty: 2, reason: "Collected by supplier", evidenceReference: "signed-collection-44" });
    expect(returned.observation).toMatchObject({ physicalHeldQty: 3, returnedQty: 2, unallocatedQty: 3, version: 1 });
    expect(await stock()).toEqual(before);
    const stale = await execute("return", returned.observation.id, { expectedVersion: 0, observationQty: 1, reason: "Stale return", evidenceReference: "collection" });
    expect(stale).toMatchObject({ httpStatus: 409, body: { code: "RECEIVING_CUSTODY_STALE" } });
  });
  it.each(["custody-inactive","custody-scoped"])("rejects intake for current inactive/scoped identity %s", async actor => {
    const source = await receipt(); const before = await stock();
    expect(await execute("intake", source.order.id, unknownBody(), randomUUID(), actor)).toMatchObject({ httpStatus: 403 });
    expect(await stock()).toEqual(before);
  });
  it("requires current purchasing approval authority for resolution", async () => {
    const source = await unknown();
    const result = await execute("return", source.result.observation.id, { expectedVersion: 0, observationQty: 1, reason: "Collected", evidenceReference: "collection" }, randomUUID(), "custody-inventory");
    expect(result).toMatchObject({ httpStatus: 403, body: { code: "RECEIVING_CUSTODY_FORBIDDEN" } });
  });
  it("serializes concurrent partial returns against the same custody revision", async () => {
    const source = await unknown();
    const body = { expectedVersion: 0, observationQty: 3, reason: "Collected", evidenceReference: "collection" };
    const results = await Promise.all([execute("return", source.result.observation.id, body), execute("return", source.result.observation.id, body)]);
    expect(results.map(result => result.httpStatus).sort()).toEqual([200,409]);
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0]).toMatchObject({ returnedQty: 3, physicalHeldQty: 2 });
  });
  it("rejects direct projection tampering and immutable evidence changes", async () => {
    const source = await unknown();
    await expect(harness.pool.query("UPDATE procurement.receiving_quarantine_observations SET returned_qty=1 WHERE id=$1", [source.result.observation.id])).rejects.toMatchObject({ code: "23514" });
    await expect(harness.pool.query("UPDATE procurement.receiving_quarantine_observations SET observed_qty=6 WHERE id=$1", [source.result.observation.id])).rejects.toMatchObject({ code: "23514" });
    await expect(harness.pool.query("DELETE FROM procurement.receiving_quarantine_observations WHERE id=$1", [source.result.observation.id])).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps pending acceptances unavailable for a physical return", async () => {
    const source = await unknown();
    const prepared = await success("prepare-acceptance", source.result.observation.id, await acceptanceBody(source.order.id, 0, 4, 6));
    const result = await execute("return", prepared.observation.id, { expectedVersion: 1, observationQty: 2,
      reason: "Cannot return allocated units", evidenceReference: "collection" });
    expect(result).toMatchObject({ httpStatus: 409, body: { code: "RECEIVING_CUSTODY_QUANTITY_UNAVAILABLE" } });
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0])
      .toMatchObject({ physicalHeldQty: 5, unallocatedQty: 1, awaitingReceiptQty: 4, returnedQty: 0 });
  });
  it("creates normal acceptance after source close and exposes its origin on the target receipt", async () => {
    const source = await unknown();
    await harness.receiving.close(source.order.id, ACTOR);
    const prepared = await success("prepare-acceptance", source.result.observation.id, await acceptanceBody(source.order.id));
    expect(prepared.acceptance!.receivingOrderId).not.toBe(source.order.id);
    const target = await harness.database.transaction(tx => readView(tx, prepared.acceptance!.receivingOrderId, ACTOR));
    expect(target.observations[0].receivingOrderId).toBe(source.order.id);
    expect(target.canAcceptAll.allowed).toBe(false);
    await harness.receiving.close(prepared.acceptance!.receivingOrderId, ACTOR);
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0])
      .toMatchObject({ physicalHeldQty: 3, receivedQty: 2 });
  });
  it("closes all-held known goods without creating a lot or voidable empty receipt", async () => {
    const source = await receipt(); const before = await stock();
    const result = await success("intake", source.order.id, { kind: "receipt_line", receivingLineId: source.line.id,
      expectedUnitVersion: receivingUnitVersion(source.line), acceptedQty: 0, heldQty: 10, countsReviewed: true,
      condition: "damaged", holdingLocationId: 100, reason: REFERENCE, evidenceReference: "photo-42" });
    await harness.receiving.close(source.order.id, ACTOR);
    expect(await stock()).toEqual(before);
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0].physicalHeldQty).toBe(10);
    await expect(harness.receiving.deleteOrder(source.order.id)).rejects.toThrow();
    expect(result.observation.receivingLineId).toBe(source.line.id);
  });
  it("rejects a cost edit after source selection even when updated_at is unchanged", async () => {
    const source = await unknown();
    const body = await acceptanceBody(source.order.id);
    await harness.pool.query("UPDATE procurement.receiving_lines SET unit_cost_mills=12440,unit_cost=124 WHERE id=$1", [source.line.id]);
    const result = await execute("prepare-acceptance", source.result.observation.id, body);
    expect(result).toMatchObject({ httpStatus: 409, body: { code: "RECEIVING_CUSTODY_TARGET_CHANGED" } });
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0].awaitingReceiptQty).toBe(0);
  });
  it("rolls back acceptance line creation when exact known-unit conversion fails", async () => {
    const source = await receipt();
    const held = await success("intake", source.order.id, { kind: "receipt_line", receivingLineId: source.line.id,
      expectedUnitVersion: receivingUnitVersion(source.line), acceptedQty: 8, heldQty: 2, countsReviewed: true,
      condition: "damaged", holdingLocationId: 100, reason: REFERENCE, evidenceReference: "photo-42" });
    const result = await execute("prepare-acceptance", held.observation.id, await acceptanceBody(source.order.id, 0, 2, 3));
    expect(result).toMatchObject({ httpStatus: 409, body: { code: "RECEIVING_CUSTODY_UNIT_MISMATCH" } });
    expect((await harness.storage.getReceivingLines(source.order.id, harness.database))).toHaveLength(1);
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0]).toMatchObject({ version: 0, physicalHeldQty: 2 });
  });
  it.each([0, 8])("pins the unique legacy purchase source before custody with %i accepted, then closes and resolves held goods", async acceptedQty => {
    const source = await receipt();
    const purchase = (await harness.pool.query(`INSERT INTO procurement.purchase_orders(po_number,vendor_id,status,warehouse_id)
      VALUES($1,5,'sent',1) RETURNING id`, [`CUSTODY-${source.order.id}-${acceptedQty}`])).rows[0];
    const purchaseLine = (await harness.pool.query(`INSERT INTO procurement.purchase_order_lines
      (purchase_order_id,line_number,product_id,product_variant_id,sku,order_qty,unit_cost_cents,unit_cost_mills,status)
      VALUES($1,1,100,201,'PROC-UAT-FLOW-A-EACH',100,123,12340,'open') RETURNING id`, [purchase.id])).rows[0];
    await harness.pool.query("UPDATE procurement.receiving_orders SET source_type='po',purchase_order_id=$1 WHERE id=$2", [purchase.id, source.order.id]);
    const held = await success("intake", source.order.id, { kind: "receipt_line", receivingLineId: source.line.id,
      expectedUnitVersion: receivingUnitVersion(source.line), acceptedQty, heldQty: 10 - acceptedQty, countsReviewed: true,
      condition: "damaged", holdingLocationId: 100, reason: REFERENCE, evidenceReference: "legacy-source-photo" });
    expect(held.observation.purchaseOrderLineId).toBe(purchaseLine.id);
    expect((await harness.pool.query("SELECT purchase_order_line_id FROM procurement.receiving_lines WHERE id=$1", [source.line.id])).rows)
      .toEqual([{ purchase_order_line_id: purchaseLine.id }]);
    await harness.receiving.close(source.order.id, ACTOR);
    const prepared = await success("prepare-acceptance", held.observation.id, await acceptanceBody(source.order.id, 0, 2, 2));
    await harness.receiving.close(prepared.acceptance!.receivingOrderId, ACTOR);
    expect((await harness.pool.query("SELECT received_qty FROM procurement.purchase_order_lines WHERE id=$1", [purchaseLine.id])).rows)
      .toEqual([{ received_qty: acceptedQty + 2 }]);
    expect((await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).observations[0])
      .toMatchObject({ receivedQty: 2, physicalHeldQty: 8 - acceptedQty, purchaseOrderLineId: purchaseLine.id });
  });
  it("preserves accepted custody history through an exact-once normal receipt reversal", async () => {
    const source = await unknown();
    const prepared = await success("prepare-acceptance", source.result.observation.id, await acceptanceBody(source.order.id));
    await harness.receiving.close(source.order.id, ACTOR);
    const before = await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR));
    const { ReceiptReversalService } = await import("../../receipt-reversal.service");
    const reversal = new ReceiptReversalService(harness.database, harness.inventory);
    const input = { receivingLineId: prepared.acceptance!.receivingLineId, qty: 1,
      reason: "Correct one previously accepted unit", idempotencyKey: `custody-reversal-${randomUUID()}`, userId: ACTOR };
    const first = await reversal.reverseReceivingLine(input);
    expect(first).toMatchObject({ qty: 1, baseUnitsReversed: 1, lotUnitCostMills: 12340, idempotentReplay: false });
    expect(await reversal.reverseReceivingLine(input)).toEqual({ ...first, idempotentReplay: true });
    expect((await harness.pool.query("SELECT received_qty,reversed_qty,putaway_complete FROM procurement.receiving_lines WHERE id=$1", [input.receivingLineId])).rows)
      .toEqual([{ received_qty: 3, reversed_qty: 1, putaway_complete: 1 }]);
    expect((await harness.pool.query(`SELECT transaction_type,variant_qty_delta FROM inventory.inventory_transactions
      WHERE receiving_line_id=$1 ORDER BY id`, [input.receivingLineId])).rows)
      .toEqual([{ transaction_type: "receipt", variant_qty_delta: 3 }, { transaction_type: "receipt_reversal", variant_qty_delta: -1 }]);
    expect(await harness.database.transaction(tx => readView(tx, source.order.id, ACTOR))).toEqual(before);
  });
  it("rejects direct reassignment of a prepared acceptance's receipt and product source", async () => {
    const source = await unknown(); const other = await receipt();
    const prepared = await success("prepare-acceptance", source.result.observation.id, await acceptanceBody(source.order.id));
    const lineId = prepared.acceptance!.receivingLineId;
    await expect(harness.pool.query("UPDATE procurement.receiving_lines SET receiving_order_id=$1 WHERE id=$2", [other.order.id, lineId]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(harness.pool.query("UPDATE procurement.receiving_lines SET product_id=101,product_variant_id=203 WHERE id=$1", [lineId]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await harness.pool.query("SELECT receiving_order_id,product_id,product_variant_id FROM procurement.receiving_lines WHERE id=$1", [lineId])).rows)
      .toEqual([{ receiving_order_id: source.order.id, product_id: 100, product_variant_id: 201 }]);
  });
});
