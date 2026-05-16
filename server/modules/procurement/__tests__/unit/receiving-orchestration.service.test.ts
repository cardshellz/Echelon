import { describe, expect, it, vi } from "vitest";
import {
  buildPoReconciliationLines,
  reconcileLinkedPurchaseOrder,
} from "../../receiving-orchestration.service";

describe("receiving-orchestration.service", () => {
  it("maps receiving lines into PO reconciliation lines without dropping zero cost", () => {
    expect(buildPoReconciliationLines([
      {
        id: 10,
        purchaseOrderLineId: 20,
        receivedQty: 3,
        damagedQty: 0,
        unitCost: 0,
        unitCostMills: 0,
      },
    ])).toEqual([
      {
        receivingLineId: 10,
        purchaseOrderLineId: 20,
        receivedQty: 3,
        damagedQty: 0,
        unitCost: 0,
        unitCostMills: 0,
      },
    ]);
  });

  it("delegates PO-linked receiving orders to purchasing reconciliation", async () => {
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileLinkedPurchaseOrder({
      receivingOrderId: 9,
      receivingOrder: { id: 9, purchaseOrderId: 1 },
      receivingLines: [{ id: 10, purchaseOrderLineId: 20, receivedQty: 3 }],
      purchasing,
    });

    expect(purchasing.onReceivingOrderClosed).toHaveBeenCalledWith(9, [
      expect.objectContaining({
        receivingLineId: 10,
        purchaseOrderLineId: 20,
        receivedQty: 3,
      }),
    ]);
  });

  it("skips reconciliation when the receipt is not PO-linked", async () => {
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileLinkedPurchaseOrder({
      receivingOrderId: 9,
      receivingOrder: { id: 9, purchaseOrderId: null },
      receivingLines: [{ id: 10, receivedQty: 3 }],
      purchasing,
    });

    expect(purchasing.onReceivingOrderClosed).not.toHaveBeenCalled();
  });
});
