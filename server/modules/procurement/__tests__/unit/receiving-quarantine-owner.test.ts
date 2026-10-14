import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReceivingService } from "../../receiving.service";
import { receivingUnitVersion } from "../../receiving-unit-contract";
import { ReceivingQuarantineError } from "../../domain/receiving-quarantine";
import type { PrepareReceivingQuarantineAcceptanceInput } from "../../receiving-quarantine-receiving.port";
import { receivingQuarantineSourceVersion } from "../../receiving-quarantine-receiving.port";

const guards = vi.hoisted(() => ({
  history: vi.fn(), editable: vi.fn(), presence: vi.fn(), complete: vi.fn(),
}));
vi.mock("../../receiving-quarantine.repository", () => ({
  assertNoReceivingCustodyHistory: guards.history,
  assertReceivingQuarantineLineEditable: guards.editable,
  readReceiptCustodyPresence: guards.presence,
  completeReceivingQuarantineAcceptances: guards.complete,
}));
vi.mock("../../receiving-custody-public", () => ({ lockReceivingCustodyFence: vi.fn(async () => undefined) }));
vi.mock("../../receipt-cost-queue.service", () => ({
  enqueueReceiptCostRequests: vi.fn(async () => undefined),
  processReceiptCostRequests: vi.fn(async () => ({ status: "complete" })),
}));

const NOW = new Date("2026-10-14T15:00:00.000Z");
const dialect = new PgDialect();
const ACTOR = "custody-operator";

function order() {
  return { id: 10, receiptNumber: "RCV-10", status: "open", sourceType: "blind", warehouseId: 1,
    purchaseOrderId: null as number | null, inboundShipmentId: null as number | null,
    vendorId: null, poNumber: null, asnNumber: null, receivedLineCount: 0, receivedTotalUnits: 0 };
}
function line() {
  return { id: 11, receivingOrderId: 10, productId: 1, productVariantId: 100,
    unitsPerVariantSnapshot: 10 as number | null, sku: "PACK-10", productName: "Pack",
    expectedQty: 5, receivedQty: 3, damagedQty: 2, status: "partial",
    putawayLocationId: 99, putawayComplete: 0, purchaseOrderLineId: null as number | null,
    inboundShipmentLineId: null as number | null, updatedAt: NOW,
    unitCost: null as number | null, unitCostMills: null as number | null,
    costSourceKind: null as string | null, costSourceEvidence: null as Record<string, unknown> | null };
}
type TestOrder = ReturnType<typeof order>;
type TestLine = ReturnType<typeof line>;

/** These tests exercise receiving owner boundaries. Real database custody
 * constraints, replay and rollback are exercised by the integration suite. */
function harness() {
  const orders: TestOrder[] = [order()];
  const lines: TestLine[] = [line()];
  const events: string[] = [];
  const state = { catalogFactor: 10, acceptanceExists: true, templateAcceptanceHistory: false, activeShipmentReceipt: false };
  let nextOrderId = 20;
  let nextLineId = 30;
  const tx = { execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const { sql, params } = dialect.sqlToQuery(query);
    if (sql.includes("inventory.cost_graph")) return { rows: [] };
    if (sql.includes("INSERT INTO public.audit_events")) { events.push("audit"); return { rows: [] }; }
    if (sql.includes("FROM warehouse.warehouses")) return { rows: [{ isActive: 1 }] };
    if (sql.includes("FROM warehouse.warehouse_locations")) return { rows: [{ id: 99, warehouseId: 1, isActive: 1 }] };
    if (sql.includes("FROM catalog.product_variants")) return { rows: [{ id: 100, product_id: 1, units_per_variant: state.catalogFactor, is_active: true }] };
    if (sql.includes("FROM procurement.receiving_quarantine_acceptances")) return { rows:
      (sql.includes("WHERE receiving_line_id=") ? state.templateAcceptanceHistory : state.acceptanceExists) ? [{ id: 7 }] : [] };
    if (sql.includes("SELECT receiving_order_id")) return { rows: lines.filter(item => item.id === params[0]).map(item => ({ receiving_order_id: item.receivingOrderId })) };
    if (sql.includes("FROM procurement.receiving_orders") && sql.includes("AND status IN")) return { rows: state.activeShipmentReceipt ? [{ id: 88 }] : [] };
    if (sql.includes("FROM procurement.receiving_orders")) return { rows: orders.filter(item => item.id === params[0]).map(item => ({ id: item.id })) };
    if (sql.includes("FROM procurement.receiving_lines")) return { rows: lines.map(item => ({ id: item.id })) };
    if (sql.includes("SELECT status FROM procurement.purchase_orders")) return { rows: [{ status: "sent" }] };
    if (sql.includes("FROM procurement.purchase_order_lines") && sql.includes('AS "purchaseOrderId"')) return { rows: [{ id: 5, purchaseOrderId: 4,
      productId: 1, lineType: "product", status: "open", orderQty: 100, receivedQty: 0, cancelledQty: 0 }] };
    if (sql.includes("FROM procurement.purchase_orders") || sql.includes("FROM procurement.purchase_order_lines")) return { rows: [{ id: 4 }] };
    if (sql.includes("SELECT status FROM procurement.inbound_shipments")) return { rows: [{ status: "delivered" }] };
    if (sql.includes("FROM procurement.inbound_shipment_lines") && sql.includes('AS "inboundShipmentId"')) return { rows: [{ id: 6, inboundShipmentId: 8, purchaseOrderId: 4, purchaseOrderLineId: 5 }] };
    if (sql.includes("FROM procurement.inbound_shipment_lines")) return { rows: [{ inbound_shipment_id: 8, purchase_order_id: 4, purchase_order_line_id: 5, qty_shipped: 100 }] };
    throw new Error(`Unimplemented owner fixture query: ${sql}`);
  }) };
  const storage = {
    getReceivingOrderById: vi.fn(async (id: number) => { const found = orders.find(item => item.id === id); return found ? { ...found } : undefined; }),
    getReceivingLines: vi.fn(async (id: number) => lines.filter(item => item.receivingOrderId === id).map(item => ({ ...item }))),
    getReceivingLineById: vi.fn(async (id: number) => { const found = lines.find(item => item.id === id); return found ? { ...found } : undefined; }),
    getProductVariantById: vi.fn(async () => ({ id: 100, productId: 1, sku: "PACK-10", name: "Pack", unitsPerVariant: state.catalogFactor })),
    getPurchaseOrderLineById: vi.fn(async () => ({ id: 5, purchaseOrderId: 4, productId: 1, lineType: "product" })),
    generateReceiptNumber: vi.fn(async () => `RCV-${nextOrderId}`),
    createReceivingOrder: vi.fn(async (data: Partial<TestOrder>, executor: unknown) => {
      expect(executor).toBe(tx);
      const created = { ...order(), ...data, id: nextOrderId++ }; orders.push(created); return { ...created };
    }),
    createReceivingLine: vi.fn(async (data: Partial<TestLine>, executor: unknown) => {
      expect(executor).toBe(tx);
      const created = { ...line(), ...data, id: nextLineId++ }; lines.push(created); return { ...created };
    }),
    updateReceivingLine: vi.fn(async (id: number, patch: Partial<TestLine>, executor: unknown) => {
      expect(executor).toBe(tx);
      const index = lines.findIndex(item => item.id === id); lines[index] = { ...lines[index], ...patch }; return { ...lines[index] };
    }),
    updateReceivingOrder: vi.fn(async (id: number, patch: Partial<TestOrder>, executor: unknown) => {
      expect(executor).toBe(tx);
      const index = orders.findIndex(item => item.id === id); orders[index] = { ...orders[index], ...patch }; return { ...orders[index] };
    }),
    deleteReceivingLine: vi.fn(async () => true), deleteReceivingOrder: vi.fn(async () => true),
  };
  const db = { execute: tx.execute, transaction: vi.fn(async <T>(work: (executor: typeof tx) => Promise<T>) => work(tx)) };
  const inventory = { receiveInventory: vi.fn() };
  const publication = { queueSyncAfterInventoryChange: vi.fn(async () => undefined) };
  const service = new ReceivingService(db as any, inventory as any, publication, storage as any,
    null, null, null, null, null, null, () => NOW);
  return { service, db, tx, storage, orders, lines, inventory, publication, events, state };
}

function intake(test: ReturnType<typeof harness>) {
  return { receivingOrderId: 10, receivingLineId: 11, expectedUnitVersion: receivingUnitVersion(test.lines[0]),
    acceptedQty: 1, heldQty: 4, holdingLocationId: 99 };
}
function acceptance(test?: ReturnType<typeof harness>): PrepareReceivingQuarantineAcceptanceInput {
  return { sourceReceivingOrderId: 10, targetReceivingOrderId: null, productVariantId: 100,
    targetSourceReceivingLineId: 11, expectedTargetUnitVersion: receivingQuarantineSourceVersion(test?.lines[0] ?? line()),
    expectedUnitsPerVariant: 10, acceptedVariantQty: 2, purchaseOrderLineId: null,
    inboundShipmentLineId: null, putawayLocationId: 99, observationId: 2, reason: "Reviewed and accepted" };
}
function custodyConflict() { return new ReceivingQuarantineError("RECEIVING_CUSTODY_HISTORY_EXISTS", "Custody history must be preserved"); }

beforeEach(() => {
  for (const guard of Object.values(guards)) guard.mockReset();
  guards.history.mockResolvedValue(undefined); guards.editable.mockResolvedValue(undefined);
  guards.presence.mockResolvedValue(false); guards.complete.mockResolvedValue(undefined);
});

describe("quarantine intake through receiving owner", () => {
  it("records explicitly recounted accepted units without adding or subtracting old damage", async () => {
    const test = harness();
    const result = await test.service.reviewQuarantineIntakeInTransaction(test.tx, intake(test), ACTOR, NOW);
    expect(result.lineBefore).toMatchObject({ receivedQty: 3, damagedQty: 2 });
    expect(result.lineAfter).toMatchObject({ receivedQty: 1, damagedQty: 0 });
    expect(result).toMatchObject({ productId: 1, productVariantId: 100, unitsPerVariantSnapshot: 10 });
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
    expect(test.publication.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
    expect(test.db.transaction).not.toHaveBeenCalled();
    expect(test.events).toEqual(["audit"]);
  });
  it.each([0, 1])("resolves a unique legacy purchase source before freezing custody with %i accepted", async acceptedQty => {
    const test = harness(); test.orders[0].purchaseOrderId = 4; test.orders[0].sourceType = "po";
    const result = await test.service.reviewQuarantineIntakeInTransaction(test.tx, { ...intake(test), acceptedQty }, ACTOR, NOW);
    expect(result.lineBefore.purchaseOrderLineId).toBeNull();
    expect(result.lineAfter).toMatchObject({ purchaseOrderLineId: 5, receivedQty: acceptedQty, damagedQty: 0 });
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  });
  it.each(["closed", "cancelled"])("rejects known stock reclassification on a %s receipt", async status => {
    const test = harness(); test.orders[0].status = status;
    await expect(test.service.reviewQuarantineIntakeInTransaction(test.tx, intake(test), ACTOR, NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
  });
  it("rejects a stale count review", async () => {
    const test = harness(); const input = intake(test); test.lines[0].receivedQty++;
    await expect(test.service.reviewQuarantineIntakeInTransaction(test.tx, input, ACTOR, NOW)).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_STALE" });
    expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
  });
  it("rejects a changed catalog factor", async () => {
    const test = harness(); test.state.catalogFactor = 20;
    await expect(test.service.reviewQuarantineIntakeInTransaction(test.tx, intake(test), ACTOR, NOW)).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_UNIT_CHANGED" });
    expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
  });
  it("requires damage disposition before any close posting", async () => {
    const test = harness();
    await expect(test.service.close(10, ACTOR)).rejects.toMatchObject({ code: "RECEIVING_DAMAGE_CUSTODY_REQUIRED" });
    expect(test.db.transaction).not.toHaveBeenCalled();
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  });
  it("closes a custody-only shipment without stock or publication", async () => {
    const test = harness(); test.orders[0].sourceType = "shipment";
    test.lines[0].receivedQty = 0; test.lines[0].damagedQty = 0;
    guards.presence.mockResolvedValue(true);
    await test.service.close(10, ACTOR);
    expect(test.orders[0].status).toBe("closed");
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
    expect(test.publication.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
    expect(guards.complete).toHaveBeenCalledWith(test.tx, { receivingOrderId: 10, actorId: ACTOR, recordedAt: NOW });
  });
});

describe("quarantine acceptance preparation", () => {
  it("appends a dedicated protected line to the still-open source receipt without recognition", async () => {
    const test = harness(); const result = await test.service.prepareQuarantineAcceptanceInTransaction(test.tx, acceptance(), ACTOR, NOW);
    expect(result).toMatchObject({ receivingOrderId: 10, receivingLineId: 30, productId: 1, acceptedVariantQty: 2 });
    expect(test.lines[0]).toMatchObject({ receivedQty: 3, damagedQty: 2 });
    expect(test.lines[1]).toMatchObject({ receivedQty: 2, damagedQty: 0, unitsPerVariantSnapshot: 10, putawayComplete: 0 });
    expect(test.storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled(); expect(test.db.transaction).not.toHaveBeenCalled();
  });
  it("creates a new ordinary draft after the source receipt closed", async () => {
    const test = harness(); test.orders[0].status = "closed";
    const result = await test.service.prepareQuarantineAcceptanceInTransaction(test.tx, acceptance(), ACTOR, NOW);
    expect(result).toMatchObject({ receivingOrderId: 20, receivingLineId: 30 });
    expect(test.orders[0].status).toBe("closed");
    expect(test.orders[1]).toMatchObject({ status: "draft", sourceType: "blind", warehouseId: 1 });
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  });
  it("keeps an exact PO source for the normal cost owner without copying a cost", async () => {
    const test = harness(); test.orders[0].purchaseOrderId = 4; test.orders[0].sourceType = "po";
    test.lines[0].purchaseOrderLineId = 5;
    test.lines[0].costSourceKind = "purchase_order_line";
    await test.service.prepareQuarantineAcceptanceInTransaction(test.tx, { ...acceptance(test), purchaseOrderLineId: 5 }, ACTOR, NOW);
    expect(test.storage.createReceivingLine).toHaveBeenCalledWith(expect.objectContaining({ purchaseOrderLineId: 5,
      costSourceKind: "purchase_order_line", unitCost: null, unitCostMills: null }), test.tx);
  });
  it("preserves reviewed manual per-piece cost and its provisional provenance", async () => {
    const test = harness(); Object.assign(test.lines[0], { unitCost: 4, unitCostMills: 375,
      costSourceKind: "manual_override", costSourceEvidence: { actorId: ACTOR, state: "review_required" } });
    await test.service.prepareQuarantineAcceptanceInTransaction(test.tx, acceptance(test), ACTOR, NOW);
    expect(test.storage.createReceivingLine).toHaveBeenCalledWith(expect.objectContaining({
      unitCost: 4, unitCostMills: 375, costSourceKind: "manual_override",
      costSourceEvidence: { actorId: ACTOR, state: "review_required" },
    }), test.tx);
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  });
  it("rejects a changed source cost even when count units and timestamp did not change", async () => {
    const test = harness(); Object.assign(test.lines[0], { unitCost: 4, unitCostMills: 375 });
    const input = acceptance(test); test.lines[0].unitCostMills = 400;
    await expect(test.service.prepareQuarantineAcceptanceInTransaction(test.tx, input, ACTOR, NOW))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_TARGET_CHANGED" });
    expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  });
  it("rejects direct reuse of an acceptance-history line as the reviewed source", async () => {
    const test = harness(); test.state.templateAcceptanceHistory = true;
    await expect(test.service.prepareQuarantineAcceptanceInTransaction(test.tx, acceptance(test), ACTOR, NOW))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_TARGET_PROTECTED" });
    expect(test.storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  });
  it("requires explicit selection when another active shipment receipt exists", async () => {
    const test = harness(); Object.assign(test.orders[0], { status: "closed", purchaseOrderId: 4, inboundShipmentId: 8, sourceType: "shipment" });
    Object.assign(test.lines[0], { purchaseOrderLineId: 5, inboundShipmentLineId: 6 });
    test.state.activeShipmentReceipt = true;
    await expect(test.service.prepareQuarantineAcceptanceInTransaction(test.tx, { ...acceptance(test), purchaseOrderLineId: 5,
      inboundShipmentLineId: 6 }, ACTOR, NOW)).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_TARGET_REQUIRED" });
    expect(test.storage.createReceivingOrder).not.toHaveBeenCalled(); expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  });
  it("rejects a different warehouse", async () => {
    const test = harness(); test.orders.push({ ...order(), id: 20, warehouseId: 2 });
    test.lines.push({ ...line(), id: 21, receivingOrderId: 20 });
    await expect(test.service.prepareQuarantineAcceptanceInTransaction(test.tx, { ...acceptance(), targetReceivingOrderId: 20,
      targetSourceReceivingLineId: 21, expectedTargetUnitVersion: receivingQuarantineSourceVersion(test.lines[1]) }, ACTOR, NOW))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_WAREHOUSE_MISMATCH" });
    expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  });
  it("rejects stale reviewed source counts even when the SKU and pack remain unchanged", async () => {
    const test = harness(); const input = acceptance(test); test.lines[0].receivedQty++;
    await expect(test.service.prepareQuarantineAcceptanceInTransaction(test.tx, input, ACTOR, NOW))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_TARGET_CHANGED" });
    expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  });
  it("rejects a different purchase source on the same receive SKU", async () => {
    const test = harness(); test.orders[0].purchaseOrderId = 4; test.lines[0].purchaseOrderLineId = 5;
    await expect(test.service.prepareQuarantineAcceptanceInTransaction(test.tx, { ...acceptance(test), purchaseOrderLineId: 6 }, ACTOR, NOW))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_TARGET_CHANGED" });
    expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  });
  it("does not permit a PO line on an unlinked receipt header", async () => {
    const test = harness();
    test.lines[0].purchaseOrderLineId = 5;
    await expect(test.service.prepareQuarantineAcceptanceInTransaction(test.tx, { ...acceptance(test), purchaseOrderLineId: 5 }, ACTOR, NOW))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_SOURCE_MISMATCH" });
    expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  });
  it("cancels unposted acceptance by zeroing counts while retaining its source line", async () => {
    const test = harness();
    await test.service.cancelQuarantineAcceptanceInTransaction(test.tx, { receivingOrderId: 10, receivingLineId: 11, acceptanceId: 7 }, ACTOR, NOW);
    expect(test.lines[0]).toMatchObject({ id: 11, receivedQty: 0, expectedQty: 0, damagedQty: 0 });
    expect(test.storage.deleteReceivingLine).not.toHaveBeenCalled();
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  });
  it("cannot cancel an acceptance no longer awaiting receipt", async () => {
    const test = harness(); test.state.acceptanceExists = false;
    await expect(test.service.cancelQuarantineAcceptanceInTransaction(test.tx, { receivingOrderId: 10, receivingLineId: 11, acceptanceId: 7 }, ACTOR, NOW))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_ACCEPTANCE_CHANGED" });
    expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
  });
});

describe("ordinary receiving cannot bypass custody", () => {
  it("blocks count patches through the shared owner", async () => {
    const test = harness(); guards.editable.mockRejectedValue(custodyConflict());
    await expect(test.service.updateLine(11, { receivedQty: 5, expectedUnitVersion: receivingUnitVersion(test.lines[0]) }, ACTOR)).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_HISTORY_EXISTS" });
    expect(guards.editable).toHaveBeenCalledWith(test.tx, 11, ["receivedQty"]);
    expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
  });
  it.each(["line", "order", "discard", "complete_all", "warehouse"])("protects custody during %s actions", async action => {
    const test = harness(); guards.history.mockRejectedValue(custodyConflict());
    if (action === "discard") test.orders[0].status = "draft";
    const operation = action === "line" ? test.service.deleteLine(11)
      : action === "order" ? test.service.deleteOrder(10)
      : action === "discard" ? test.service.discardDraftReceivingOrder(10, ACTOR)
      : action === "warehouse" ? test.service.updateOrderDetails(10, { warehouseId: 2 }, ACTOR)
      : test.service.completeAllLines(10, {}, ACTOR);
    await expect(operation).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_HISTORY_EXISTS" });
    expect(test.storage.deleteReceivingLine).not.toHaveBeenCalled(); expect(test.storage.deleteReceivingOrder).not.toHaveBeenCalled();
    expect(test.storage.updateReceivingLine).not.toHaveBeenCalled(); expect(test.storage.updateReceivingOrder).not.toHaveBeenCalled();
  });
});
