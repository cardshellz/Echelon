import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { createPurchasingService } from "../../purchasing.service";

type Existing = "none" | "active" | "empty" | "zero" | "closed";
const dialect = new PgDialect();

function harness(options: {
  existing?: Existing;
  reuseAfterLock?: boolean;
  coverageFailure?: Error;
  frozenMismatch?: boolean;
  multipleShipments?: boolean;
} = {}) {
  const sourceLines = [
    { id: 11, inboundShipmentId: 1, purchaseOrderId: 10, purchaseOrderLineId: 21, productVariantId: 201, qtyShipped: 100, sku: "ONE" },
    { id: 12, inboundShipmentId: options.multipleShipments ? 2 : 1,
      purchaseOrderId: options.multipleShipments ? 10 : 20, purchaseOrderLineId: 22, productVariantId: 201, qtyShipped: 100, sku: "TWO" },
  ];
  const priorReceipt = { id: 54, purchaseOrderId: 10, inboundShipmentId: 1, status: "closed" };
  const activeReceipt = { id: 55, purchaseOrderId: 10, inboundShipmentId: 1, status: options.existing === "empty" ? "draft" : "open" };
  const coverageReads: unknown[] = [];
  const execute = vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
    const { sql, params } = dialect.sqlToQuery(query);
    if (sql.includes("FROM procurement.inbound_shipments") && sql.includes("FOR UPDATE")) return { rows: [{ id: 1 }] };
    if (sql.includes("rl.units_per_variant_snapshot")) {
      coverageReads.push(query);
      if (options.coverageFailure) throw options.coverageFailure;
      if (options.reuseAfterLock || params[0] !== 1 || params[1] !== 10) return { rows: [] };
      return { rows: [{ id: 501, receivingOrderId: 54, purchaseOrderId: 10, inboundShipmentId: 1,
        purchaseOrderLineId: 21, inboundShipmentLineId: options.frozenMismatch ? 11 : null, unitsPerVariantSnapshot: options.frozenMismatch ? 100 : null,
        receivedQty: 1, reversedQty: 0, receiptStatus: "closed" }] };
    }
    if (options.frozenMismatch && sql.includes("FROM procurement.po_receipts") && !sql.includes("AS line_count")) return { rows: [{ receivingLineId: 501, receivingOrderId: 54, purchaseOrderId: 10, purchaseOrderLineId: 21, qtyReceived: 50 }] };
    if (sql.includes("AS line_count")) return { rows: [{ line_count: 1, expected_qty: 1,
      received_qty: options.existing === "zero" ? 0 : 1,
      po_receipt_count: options.existing === "zero" ? 0 : 1,
      inventory_lot_count: options.existing === "zero" ? 0 : 1,
      inventory_transaction_count: options.existing === "zero" ? 0 : 1 }] };
    return { rows: [] };
  });
  const tx = { execute };
  const db = { execute, transaction: vi.fn(async (work: (executor: typeof tx) => Promise<unknown>) => work(tx)),
    select: vi.fn(), insert: vi.fn(), update: vi.fn() };
  const storage = {
    getInboundShipmentById: vi.fn(async (id: number) => ({ id, status: "customs_clearance", shipmentNumber: `SHIP-${id}` })),
    getInboundShipmentLines: vi.fn(async (id: number) => sourceLines.filter((line) => line.inboundShipmentId === id)),
    getInboundShipmentLinesByPo: vi.fn(async (id: number) => sourceLines.filter((line) => line.purchaseOrderId === id)),
    getPurchaseOrderById: vi.fn(async (id: number) => ({ id, poNumber: `PO-${id}`, status: "sent", vendorId: null })),
    getPurchaseOrderLines: vi.fn(async (id: number) => sourceLines.filter((line) => line.purchaseOrderId === id)
      .map((line) => ({ id: line.purchaseOrderLineId, purchaseOrderId: id, productId: 100, productVariantId: 201,
        expectedReceiveVariantId: 201, expectedReceiveUnitsPerVariant: 1, unitCostCents: 4, unitCostMills: 375 }))),
    getProductVariantsByProductId: vi.fn(async () => [{ id: 201, productId: 100, unitsPerVariant: 1, isActive: true }]),
    getReceivingOrdersForPurchaseOrder: vi.fn(async (id: number, executor?: unknown) => {
      if (id !== 10) return [];
      if (options.reuseAfterLock) return executor ? [activeReceipt] : [];
      if (options.existing === "none") return [];
      if (options.existing === "active" || options.existing === "empty") return [activeReceipt, priorReceipt];
      return [priorReceipt];
    }),
    getReceivingLines: vi.fn(async () => options.existing === "empty" ? [] : [{ id: 502 }]),
    getAllProductLocations: vi.fn(async () => []),
    generateReceiptNumber: vi.fn(), createReceivingOrder: vi.fn(), bulkCreateReceivingLines: vi.fn(),
  };
  return { service: createPurchasingService(db as any, storage as any), storage, db, tx, coverageReads };
}

describe("existing receiving navigation with unprovable historical coverage", () => {
  it("reuses an active receipt without inspecting ambiguous older quantities", async () => {
    const test = harness({ existing: "active" });
    expect(await test.service.createReceiptFromShipment(1, "operator", { purchaseOrderId: 10 }))
      .toMatchObject({ id: 55, reusedExisting: true });
    expect(test.coverageReads).toHaveLength(0);
    expect(test.storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(test.db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["active", "open_existing_receipt", 55],
    ["empty", "repair_empty_receipt", 55],
    ["zero", "void_zero_post_receipt", 54],
  ] as const)("keeps %s receipt actions visible without claiming known quantities", async (existing, action, id) => {
    const test = harness({ existing });
    const result = await test.service.getPurchaseOrderReceiveOptions(10);
    expect(result.shipmentOptions).toEqual([expect.objectContaining({ action, existingReceiptId: id,
      receivedBaseQty: null, remainingBaseQty: null })]);
    expect(test.coverageReads).toHaveLength(0);
  });

  it.each([
    ["empty", "EMPTY_SHIPMENT_RECEIPT"], ["zero", "ZERO_POST_SHIPMENT_RECEIPT"],
  ] as const)("preserves the actionable %s receipt command error before historical coverage", async (existing, code) => {
    const test = harness({ existing });
    await expect(test.service.createReceiptFromShipment(1, "operator", { purchaseOrderId: 10 }))
      .rejects.toMatchObject({ details: { code } });
    expect(test.coverageReads).toHaveLength(0);
    expect(test.storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("blocks only the PO with unprovable coverage while another PO remains receivable", async () => {
    const test = harness({ existing: "closed" });
    const result = await test.service.getShipmentPoReceiveOptions(1);
    expect(result.purchaseOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ purchaseOrderId: 10, action: "blocked", receivable: false,
        receivedBaseQty: null, remainingBaseQty: null, reason: expect.stringContaining("a legacy receipt cannot be attributed") }),
      expect.objectContaining({ purchaseOrderId: 20, action: "create_receipt", receivable: true,
        receivedBaseQty: 0, remainingBaseQty: 100 }),
    ]));
    expect(result.purchaseOrders).toHaveLength(2);
    await expect(test.service.createReceiptFromShipment(1, "operator", { purchaseOrderId: 10 }))
      .rejects.toMatchObject({ details: { code: "SHIPMENT_RECEIPT_COVERAGE_REVIEW_REQUIRED" } });
    expect(test.storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("keeps other shipments visible when one shipment on the PO needs coverage review", async () => {
    const test = harness({ existing: "closed", multipleShipments: true });
    const result = await test.service.getPurchaseOrderReceiveOptions(10);
    expect(result.shipmentOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ shipmentId: 1, action: "blocked", remainingBaseQty: null }),
      expect.objectContaining({ shipmentId: 2, action: "create_receipt", remainingBaseQty: 100 }),
    ]));
    expect(result.shipmentOptions).toHaveLength(2);
  });

  it("does not hide unexpected database failures as receipt-data warnings", async () => {
    const failure = new Error("fixture database unavailable");
    const test = harness({ existing: "closed", coverageFailure: failure });
    await expect(test.service.getShipmentPoReceiveOptions(1)).rejects.toBe(failure);
  });

  it("forwards the transaction to the active receipt line read after a concurrent creation", async () => {
    const test = harness({ reuseAfterLock: true });
    expect(await test.service.createReceiptFromShipment(1, "operator", { purchaseOrderId: 10 }))
      .toMatchObject({ id: 55, reusedExisting: true });
    expect(test.storage.getReceivingLines).toHaveBeenCalledWith(55, test.tx);
    expect(test.storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("shows the exact frozen/posting mismatch as a blocked option", async () => {
    const test = harness({ existing: "closed", frozenMismatch: true });
    const result = await test.service.getShipmentPoReceiveOptions(1);
    expect(result.purchaseOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ purchaseOrderId: 10, action: "blocked", receivedBaseQty: null, remainingBaseQty: null,
        reason: expect.stringContaining("the frozen pack size disagrees with the original PO posting") }),
      expect.objectContaining({ purchaseOrderId: 20, action: "create_receipt", remainingBaseQty: 100 }),
    ]));
  });

});
