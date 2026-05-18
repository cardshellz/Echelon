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

export type ReceivingReconciliationFailureInput = {
  purchaseOrderId: number;
  receivingOrderId: number;
  userId?: string | null;
  message: string;
  details?: Record<string, unknown>;
};

export type ReceivingReconciliationFailureReporter = (
  input: ReceivingReconciliationFailureInput,
) => Promise<unknown>;

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
  userId?: string | null;
  recordReconciliationFailure?: ReceivingReconciliationFailureReporter | null;
}): Promise<ReceivingCloseReconciliation> {
  const {
    receivingOrderId,
    receivingOrder,
    receivingLines,
    purchasing,
    userId,
    recordReconciliationFailure,
  } = params;
  if (!receivingOrder.purchaseOrderId) {
    return { required: false, reason: "not_po_linked" };
  }
  if (!purchasing) {
    return await failReconciliation({
      receivingOrderId,
      purchaseOrderId: receivingOrder.purchaseOrderId,
      message: "PO reconciliation service is unavailable for this receiving close.",
      userId,
      details: { reason: "purchasing_unavailable" },
      recordReconciliationFailure,
    });
  }

  const reconciliationLines = buildPoReconciliationLines(receivingLines).filter(
    (line) => (line.receivedQty || 0) > 0 || (line.damagedQty || 0) > 0,
  );
  if (reconciliationLines.length === 0) {
    return { required: false, reason: "no_received_lines" };
  }

  let result: ReceiptReconciliationResult | void;
  try {
    result = await purchasing.onReceivingOrderClosed(
      receivingOrderId,
      reconciliationLines,
    );
  } catch (error: any) {
    return await failReconciliation({
      receivingOrderId,
      purchaseOrderId: receivingOrder.purchaseOrderId,
      message: error?.message || "PO reconciliation failed for this receiving close.",
      userId,
      details: {
        expectedReceiptLines: reconciliationLines.length,
        errorName: error?.name,
        cause: error?.message,
      },
      recordReconciliationFailure,
    });
  }

  if (!result) {
    return await failReconciliation({
      receivingOrderId,
      purchaseOrderId: receivingOrder.purchaseOrderId,
      message: "PO reconciliation did not return a result for this receiving close.",
      userId,
      details: { expectedReceiptLines: reconciliationLines.length },
      recordReconciliationFailure,
    });
  }

  const reconciledLines = result.appliedLines + result.existingReceiptLines;
  if (result.skippedLines > 0 || result.issues.length > 0 || reconciledLines < reconciliationLines.length) {
    return await failReconciliation({
      receivingOrderId,
      purchaseOrderId: receivingOrder.purchaseOrderId,
      message: "PO reconciliation is incomplete for this receiving close.",
      userId,
      details: {
        expectedReceiptLines: reconciliationLines.length,
        reconciledLines,
        reconciliation: result,
      },
      recordReconciliationFailure,
    });
  }

  return {
    ...result,
    required: true,
    expectedReceiptLines: reconciliationLines.length,
  };
}

async function failReconciliation(params: {
  receivingOrderId: number;
  purchaseOrderId: number;
  message: string;
  userId?: string | null;
  details?: Record<string, unknown>;
  recordReconciliationFailure?: ReceivingReconciliationFailureReporter | null;
}): Promise<never> {
  const details = {
    receivingOrderId: params.receivingOrderId,
    purchaseOrderId: params.purchaseOrderId,
    ...(params.details ?? {}),
  };

  if (params.recordReconciliationFailure) {
    try {
      await params.recordReconciliationFailure({
        purchaseOrderId: params.purchaseOrderId,
        receivingOrderId: params.receivingOrderId,
        userId: params.userId,
        message: params.message,
        details,
      });
    } catch (error) {
      console.warn(
        `[Receiving] Failed to record PO reconciliation exception for receiving order ${params.receivingOrderId}:`,
        error,
      );
    }
  }

  throw new ReceivingOrchestrationError(params.message, details);
}
