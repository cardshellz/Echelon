import { describe, expect, it, vi } from "vitest";
import { reconcilePurchaseOrderReceipt, type ReceivingReconciliationLine } from "../../purchase-order-receipt-reconciliation.service";

function harness(recorded = { receivedQty: 2, damagedQty: 1 }) {
  const poLine = { id: 21, purchaseOrderId: 10, lineType: "product", productId: 100,
    orderQty: 1000, receivedQty: 0, damagedQty: 0, cancelledQty: 0, status: "open", unitCostCents: 4, unitCostMills: 375 };
  const storage = {
    getReceivingOrderById: vi.fn(async () => ({ id: 50, purchaseOrderId: 10, status: "closed" })),
    getReceivingLineById: vi.fn(async () => ({ id: 51, receivingOrderId: 50, purchaseOrderLineId: 21,
      productVariantId: 200, productId: 100, unitsPerVariantSnapshot: 250, ...recorded })),
    getPurchaseOrderById: vi.fn(async () => ({ id: 10, status: "sent" })),
    getPurchaseOrderLineById: vi.fn(async () => poLine),
    getPurchaseOrderLines: vi.fn(async () => [poLine]),
    getProductVariantById: vi.fn(async () => ({ id: 200, productId: 100, unitsPerVariant: 500 })),
    reconcilePoReceiptLine: vi.fn(async () => ({ applied: true })),
    updatePurchaseOrderStatusWithHistory: vi.fn(),
  };
  const executor = { execute: vi.fn(async () => ({ rows: [] })) };
  const recalculateTotals = vi.fn();
  const run = (patch: Partial<ReceivingReconciliationLine> = {}) => reconcilePurchaseOrderReceipt({
    storage, executor, recalculateTotals, receivingOrderId: 50,
    receivingLines: [{ receivingLineId: 51, purchaseOrderLineId: 21, receivedQty: 2, damagedQty: 1, ...patch }],
    now: () => new Date("2026-09-06T12:00:00.000Z"),
  });
  return { storage, executor, recalculateTotals, run };
}

describe("PO receipt reconciliation frozen counts", () => {
  it("uses frozen received and damaged counts without reading a mutable catalog factor", async () => {
    const test = harness();
    await test.run();
    expect(test.storage.reconcilePoReceiptLine).toHaveBeenCalledWith(expect.objectContaining({
      lineUpdates: expect.objectContaining({ receivedQty: 500, damagedQty: 250 }),
      receipt: expect.objectContaining({ qtyReceived: 500, poUnitCostMills: 375 }),
    }), test.executor);
    expect(test.storage.getProductVariantById).not.toHaveBeenCalled();
  });

  it.each([{ receivedQty: 3 }, { damagedQty: 0 }, { damagedQty: 2 }, { damagedQty: undefined }])(
    "rejects a stale payload %j before PO or aggregate writes", async (patch) => {
      const test = harness();
      await expect(test.run(patch)).rejects.toMatchObject({ statusCode: 409,
        details: { code: "RECEIVING_UNIT_SNAPSHOT_REVIEW_REQUIRED", receivingLineId: 51 } });
      expect(test.storage.reconcilePoReceiptLine).not.toHaveBeenCalled();
      expect(test.storage.updatePurchaseOrderStatusWithHistory).not.toHaveBeenCalled();
      expect(test.recalculateTotals).not.toHaveBeenCalled();
    });

  it("preserves an explicitly recorded zero damaged count", async () => {
    const test = harness({ receivedQty: 2, damagedQty: 0 });
    await test.run({ damagedQty: 0 });
    expect(test.storage.reconcilePoReceiptLine).toHaveBeenCalledWith(expect.objectContaining({
      lineUpdates: expect.objectContaining({ receivedQty: 500, damagedQty: 0 }),
    }), test.executor);
  });
});
