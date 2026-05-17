import { describe, expect, it, vi } from "vitest";
import {
  buildPoReconciliationLines,
  ReceivingOrchestrationError,
  reconcileLinkedPurchaseOrder,
} from "../../receiving-orchestration.service";

function successfulReconciliation(overrides: Record<string, unknown> = {}) {
  return {
    purchaseOrderId: 1,
    appliedLines: 1,
    existingReceiptLines: 0,
    skippedLines: 0,
    autoMatchedLines: 0,
    issues: [],
    ...overrides,
  };
}

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
      onReceivingOrderClosed: vi.fn().mockResolvedValue(successfulReconciliation()),
    };

    const result = await reconcileLinkedPurchaseOrder({
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
    expect(result).toMatchObject({
      required: true,
      purchaseOrderId: 1,
      expectedReceiptLines: 1,
    });
  });

  it("skips reconciliation when the receipt is not PO-linked", async () => {
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reconcileLinkedPurchaseOrder({
      receivingOrderId: 9,
      receivingOrder: { id: 9, purchaseOrderId: null },
      receivingLines: [{ id: 10, receivedQty: 3 }],
      purchasing,
    });

    expect(purchasing.onReceivingOrderClosed).not.toHaveBeenCalled();
    expect(result).toEqual({ required: false, reason: "not_po_linked" });
  });

  it("rejects incomplete PO reconciliation instead of hiding unmatched receipt lines", async () => {
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockResolvedValue(successfulReconciliation({
        appliedLines: 0,
        skippedLines: 1,
        issues: [{
          receivingLineId: 10,
          reason: "unlinked_receiving_line",
          detail: "Receiving line 10 is not linked to a purchase order line",
        }],
      })),
    };

    await expect(reconcileLinkedPurchaseOrder({
      receivingOrderId: 9,
      receivingOrder: { id: 9, purchaseOrderId: 1 },
      receivingLines: [{ id: 10, receivedQty: 3 }],
      purchasing,
    })).rejects.toBeInstanceOf(ReceivingOrchestrationError);
  });

  it("rejects PO-linked receipt close when purchasing reconciliation is unavailable", async () => {
    await expect(reconcileLinkedPurchaseOrder({
      receivingOrderId: 9,
      receivingOrder: { id: 9, purchaseOrderId: 1 },
      receivingLines: [{ id: 10, purchaseOrderLineId: 20, receivedQty: 3 }],
      purchasing: null,
    })).rejects.toBeInstanceOf(ReceivingOrchestrationError);
  });

  it("treats an existing PO receipt as reconciled for idempotent close retry", async () => {
    const purchasing = {
      onReceivingOrderClosed: vi.fn().mockResolvedValue(successfulReconciliation({
        appliedLines: 0,
        existingReceiptLines: 1,
      })),
    };

    const result = await reconcileLinkedPurchaseOrder({
      receivingOrderId: 9,
      receivingOrder: { id: 9, purchaseOrderId: 1 },
      receivingLines: [{ id: 10, purchaseOrderLineId: 20, receivedQty: 3 }],
      purchasing,
    });

    expect(result).toMatchObject({
      required: true,
      existingReceiptLines: 1,
      expectedReceiptLines: 1,
    });
  });
});
