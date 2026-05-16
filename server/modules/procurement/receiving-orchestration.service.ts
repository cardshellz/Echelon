import type { ReceivingReconciliationLine } from "./purchase-order-receipt-reconciliation.service";

export type ReceivingOrchestrationPurchasing = {
  onReceivingOrderClosed(
    receivingOrderId: number,
    receivingLines: ReceivingReconciliationLine[],
  ): Promise<void>;
};

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
}): Promise<void> {
  const { receivingOrderId, receivingOrder, receivingLines, purchasing } = params;
  if (!receivingOrder.purchaseOrderId || !purchasing) return;

  await purchasing.onReceivingOrderClosed(
    receivingOrderId,
    buildPoReconciliationLines(receivingLines),
  );
}
