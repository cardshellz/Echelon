import type {
  ReceiptReconciliationResult,
  ReceivingReconciliationLine,
} from "./purchase-order-receipt-reconciliation.service";

export type ReceivingOrchestrationPurchasing = {
  onReceivingOrderClosed(
    receivingOrderId: number,
    receivingLines: ReceivingReconciliationLine[],
  ): Promise<ReceiptReconciliationResult | void>;
};

export type ReceivingCloseReconciliationResult = ReceiptReconciliationResult & {
  required: true;
  expectedReceiptLines: number;
};

export type ReceivingCloseReconciliationSkipped = {
  required: false;
  reason: "not_po_linked" | "no_received_lines";
};

export type ReceivingCloseReconciliation =
  | ReceivingCloseReconciliationResult
  | ReceivingCloseReconciliationSkipped;

export class ReceivingOrchestrationError extends Error {
  statusCode = 409;

  constructor(message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = "ReceivingOrchestrationError";
  }
}

export function buildPoReconciliationLines(lines: any[]): ReceivingReconciliationLine[] {
  return lines.map((line: any) => ({
    receivingLineId: line.id,
    purchaseOrderLineId: line.purchaseOrderLineId || undefined,
    receivedQty: line.receivedQty || 0,
    damagedQty: line.damagedQty || 0,
    unitCost: line.unitCost ?? undefined,
    unitCostMills: line.unitCostMills ?? undefined,
  }));
}

export async function reconcileLinkedPurchaseOrder(params: {
  receivingOrderId: number;
  receivingOrder: Record<string, any>;
  receivingLines: any[];
  purchasing: ReceivingOrchestrationPurchasing | null;
}): Promise<ReceivingCloseReconciliation> {
  const { receivingOrderId, receivingOrder, receivingLines, purchasing } = params;
  if (!receivingOrder.purchaseOrderId) {
    return { required: false, reason: "not_po_linked" };
  }
  if (!purchasing) {
    throw new ReceivingOrchestrationError(
      "PO reconciliation service is unavailable for this receiving close.",
      { receivingOrderId, purchaseOrderId: receivingOrder.purchaseOrderId },
    );
  }

  const reconciliationLines = buildPoReconciliationLines(receivingLines).filter(
    (line) => (line.receivedQty || 0) > 0 || (line.damagedQty || 0) > 0,
  );
  if (reconciliationLines.length === 0) {
    return { required: false, reason: "no_received_lines" };
  }

  const result = await purchasing.onReceivingOrderClosed(
    receivingOrderId,
    reconciliationLines,
  );

  if (!result) {
    throw new ReceivingOrchestrationError(
      "PO reconciliation did not return a result for this receiving close.",
      { receivingOrderId, purchaseOrderId: receivingOrder.purchaseOrderId },
    );
  }

  const reconciledLines = result.appliedLines + result.existingReceiptLines;
  if (result.skippedLines > 0 || result.issues.length > 0 || reconciledLines < reconciliationLines.length) {
    throw new ReceivingOrchestrationError(
      "PO reconciliation is incomplete for this receiving close.",
      {
        receivingOrderId,
        purchaseOrderId: receivingOrder.purchaseOrderId,
        expectedReceiptLines: reconciliationLines.length,
        reconciledLines,
        reconciliation: result,
      },
    );
  }

  return {
    ...result,
    required: true,
    expectedReceiptLines: reconciliationLines.length,
  };
}
