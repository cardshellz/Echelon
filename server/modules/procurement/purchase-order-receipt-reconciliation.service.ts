import { centsToMills, millsToCents } from "@shared/utils/money";

export type ReceivingReconciliationLine = {
  receivingLineId: number;
  purchaseOrderLineId?: number;
  receivedQty: number;
  damagedQty?: number;
  unitCost?: number | null;
  unitCostMills?: number | null;
};

export type PoReceiptReconciliationStorage = {
  getPurchaseOrderById(id: number, executor?: any): Promise<any>;
  getPurchaseOrderLines(purchaseOrderId: number, executor?: any): Promise<any[]>;
  getPurchaseOrderLineById(id: number, executor?: any): Promise<any>;
  getReceivingOrderById(id: number, executor?: any): Promise<any>;
  getReceivingLineById(id: number, executor?: any): Promise<any>;
  getProductVariantById(id: number, executor?: any): Promise<any>;
  reconcilePoReceiptLine(input: {
    purchaseOrderLineId: number;
    receivingLineId: number;
    lineUpdates: Record<string, unknown>;
    receipt: Record<string, unknown>;
  }, executor?: any): Promise<{ applied: boolean; receipt?: any; purchaseOrderLine?: any }>;
  updatePurchaseOrderStatusWithHistory(id: number, updates: any, historyData: any, executor?: any): Promise<any>;
};

export type ReceiptReconciliationIssueReason =
  | "purchase_order_not_found"
  | "missing_receiving_product"
  | "auto_match_unresolved"
  | "unlinked_receiving_line"
  | "invalid_purchase_order_line"
  | "missing_receiving_line"
  | "invalid_receive_configuration"
  | "receipt_not_applied";

export type ReceiptReconciliationIssue = {
  receivingLineId?: number;
  purchaseOrderLineId?: number;
  reason: ReceiptReconciliationIssueReason;
  detail: string;
};

export type ReceiptReconciliationResult = {
  purchaseOrderId: number | null;
  appliedLines: number;
  existingReceiptLines: number;
  skippedLines: number;
  autoMatchedLines: number;
  issues: ReceiptReconciliationIssue[];
  poStatusUpdate?: {
    legacyStatus: "partially_received" | "received";
    physicalStatus: "receiving" | "received";
  } | null;
};

function nonNegativeSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function findOpenPoLineByProduct(
  storage: Pick<PoReceiptReconciliationStorage, "getPurchaseOrderLines">,
  poId: number,
  productId: number,
  executor?: any,
): Promise<any | null> {
  const lines = await storage.getPurchaseOrderLines(poId, executor);
  const candidates = lines.filter((line: any) => {
    if ((line.lineType ?? "product") !== "product") return false;
    if (line.productId !== productId) return false;
    if (line.status === "cancelled" || line.status === "received" || line.status === "closed") return false;
    const remaining = (Number(line.orderQty) || 0)
      - (Number(line.receivedQty) || 0)
      - (Number(line.cancelledQty) || 0);
    return remaining > 0;
  });

  if (candidates.length === 1) return candidates[0];
  return null;
}

export async function reconcilePurchaseOrderReceipt(params: {
  storage: PoReceiptReconciliationStorage;
  receivingOrderId: number;
  receivingLines: ReceivingReconciliationLine[];
  recalculateTotals: (purchaseOrderId: number, executor?: any) => Promise<void>;
  executor?: any;
  changedBy?: string;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<ReceiptReconciliationResult> {
  const {
    storage,
    receivingOrderId,
    receivingLines,
    recalculateTotals,
    executor,
    changedBy,
    now = () => new Date(),
    logger = console,
  } = params;
  const resolvedReceivingLines = receivingLines.map((line) => ({ ...line }));
  const reconciledAt = now();
  const poId = await resolvePurchaseOrderId(storage, receivingOrderId, resolvedReceivingLines, executor);

  if (!poId) {
    return {
      purchaseOrderId: null,
      appliedLines: 0,
      existingReceiptLines: 0,
      skippedLines: 0,
      autoMatchedLines: 0,
      issues: [],
    };
  }

  const po = await storage.getPurchaseOrderById(poId, executor);
  if (!po) {
    return {
      purchaseOrderId: poId,
      appliedLines: 0,
      existingReceiptLines: 0,
      skippedLines: resolvedReceivingLines.length,
      autoMatchedLines: 0,
      issues: [{
        reason: "purchase_order_not_found",
        detail: `Purchase order ${poId} no longer exists for receiving order ${receivingOrderId}`,
      }],
    };
  }

  let autoMatchedLines = 0;
  const issues: ReceiptReconciliationIssue[] = [];
  for (const receivingLine of resolvedReceivingLines) {
    if (receivingLine.purchaseOrderLineId) continue;

    const receivingLineRecord = await storage.getReceivingLineById(receivingLine.receivingLineId, executor);
    if (!receivingLineRecord) continue;

    let productId: number | null = receivingLineRecord.productId ?? null;
    if (!productId && receivingLineRecord.productVariantId) {
      const variant = await storage.getProductVariantById(receivingLineRecord.productVariantId, executor);
      productId = variant?.productId ?? null;
    }

    if (!productId) {
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        reason: "missing_receiving_product",
        detail: `Receiving line ${receivingLine.receivingLineId} has no product_id resolvable for PO auto-match`,
      });
      logger.warn(
        `[Receiving] Auto-match skipped for receiving line ${receivingLine.receivingLineId}: no product_id resolvable`,
      );
      continue;
    }

    const matchedLine = await findOpenPoLineByProduct(storage, poId, productId, executor);
    if (matchedLine) {
      receivingLine.purchaseOrderLineId = matchedLine.id;
      autoMatchedLines++;
      logger.info(
        `[Receiving] Auto-matched receiving line ${receivingLine.receivingLineId} to PO line ${matchedLine.id} (product_id=${productId})`,
      );
    } else {
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        reason: "auto_match_unresolved",
        detail: `Receiving line ${receivingLine.receivingLineId} could not be auto-matched to exactly one open PO line for product_id=${productId}`,
      });
      logger.warn(
        `[Receiving] Auto-match failed for receiving line ${receivingLine.receivingLineId}: ` +
        `zero or multiple open PO lines for product_id=${productId} on PO ${poId}. Leaving unlinked.`,
      );
    }
  }

  let appliedLines = 0;
  let existingReceiptLines = 0;
  let skippedLines = 0;

  for (const receivingLine of resolvedReceivingLines) {
    if (!receivingLine.purchaseOrderLineId) {
      skippedLines++;
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        reason: "unlinked_receiving_line",
        detail: `Receiving line ${receivingLine.receivingLineId} is not linked to a purchase order line`,
      });
      continue;
    }

    const poLine = await storage.getPurchaseOrderLineById(receivingLine.purchaseOrderLineId, executor);
    if (!poLine || (poLine.lineType ?? "product") !== "product") {
      skippedLines++;
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        purchaseOrderLineId: receivingLine.purchaseOrderLineId,
        reason: "invalid_purchase_order_line",
        detail: `PO line ${receivingLine.purchaseOrderLineId} is missing or not physically receivable`,
      });
      continue;
    }

    const receivingLineRecord = await storage.getReceivingLineById(receivingLine.receivingLineId, executor);
    if (!receivingLineRecord) {
      skippedLines++;
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        purchaseOrderLineId: receivingLine.purchaseOrderLineId,
        reason: "missing_receiving_line",
        detail: `Receiving line ${receivingLine.receivingLineId} no longer exists during PO reconciliation`,
      });
      continue;
    }

    const receivedQty = nonNegativeSafeInteger(receivingLine.receivedQty);
    const damagedQty = nonNegativeSafeInteger(receivingLine.damagedQty ?? 0);
    const productVariantId = positiveSafeInteger(receivingLineRecord.productVariantId);
    const receivedVariant = productVariantId
      ? await storage.getProductVariantById(productVariantId, executor)
      : null;
    const receivedUnitsPerVariant = positiveSafeInteger(receivedVariant?.unitsPerVariant);
    if (receivedQty === null || damagedQty === null || !productVariantId || !receivedVariant || !receivedUnitsPerVariant) {
      skippedLines++;
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        purchaseOrderLineId: receivingLine.purchaseOrderLineId,
        reason: "invalid_receive_configuration",
        detail: `Receiving line ${receivingLine.receivingLineId} has invalid quantity or receive-variant configuration`,
      });
      continue;
    }

    const baseUnitsReceived = receivedQty * receivedUnitsPerVariant;
    const damagedBaseUnits = damagedQty * receivedUnitsPerVariant;
    const currentReceivedQty = nonNegativeSafeInteger(poLine.receivedQty ?? 0);
    const currentDamagedQty = nonNegativeSafeInteger(poLine.damagedQty ?? 0);
    const orderQty = nonNegativeSafeInteger(poLine.orderQty);
    const cancelledQty = nonNegativeSafeInteger(poLine.cancelledQty ?? 0);
    if (
      !Number.isSafeInteger(baseUnitsReceived) ||
      !Number.isSafeInteger(damagedBaseUnits) ||
      currentReceivedQty === null ||
      currentDamagedQty === null ||
      orderQty === null ||
      cancelledQty === null
    ) {
      skippedLines++;
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        purchaseOrderLineId: receivingLine.purchaseOrderLineId,
        reason: "invalid_receive_configuration",
        detail: `Receiving line ${receivingLine.receivingLineId} exceeds safe quantity limits or references invalid PO quantities`,
      });
      continue;
    }

    const poLineUnitsReceived = baseUnitsReceived;
    const poLineDamagedReceived = damagedBaseUnits;

    const newReceivedQty = currentReceivedQty + poLineUnitsReceived;
    const newDamagedQty = currentDamagedQty + poLineDamagedReceived;
    const remaining = orderQty - newReceivedQty - cancelledQty;
    if (!Number.isSafeInteger(newReceivedQty) || !Number.isSafeInteger(newDamagedQty) || !Number.isSafeInteger(remaining)) {
      skippedLines++;
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        purchaseOrderLineId: receivingLine.purchaseOrderLineId,
        reason: "invalid_receive_configuration",
        detail: `Receiving line ${receivingLine.receivingLineId} would overflow PO receipt quantities`,
      });
      continue;
    }

    const lineUpdates: Record<string, unknown> = {
      receivedQty: newReceivedQty,
      damagedQty: newDamagedQty,
      lastReceivedAt: reconciledAt,
    };

    if (!poLine.receivedDate) {
      lineUpdates.receivedDate = reconciledAt;
    }

    if (remaining <= 0) {
      lineUpdates.status = "received";
      lineUpdates.fullyReceivedDate = reconciledAt;
    } else if (newReceivedQty > 0) {
      lineUpdates.status = "partially_received";
    }

    const unitCosts = resolveReceiptUnitCosts(receivingLine, poLine);
    const result = await storage.reconcilePoReceiptLine({
      purchaseOrderLineId: poLine.id,
      receivingLineId: receivingLine.receivingLineId,
      lineUpdates,
      receipt: {
        purchaseOrderId: poId,
        purchaseOrderLineId: poLine.id,
        receivingOrderId,
        receivingLineId: receivingLine.receivingLineId,
        qtyReceived: poLineUnitsReceived,
        poUnitCostCents: unitCosts.poUnitCostCents,
        poUnitCostMills: unitCosts.poUnitCostMills,
        actualUnitCostCents: unitCosts.actualUnitCostCents,
        actualUnitCostMills: unitCosts.actualUnitCostMills,
        varianceCents: unitCosts.actualUnitCostCents - unitCosts.poUnitCostCents,
      },
    }, executor);

    if (result.applied) {
      appliedLines++;
    } else if (result.receipt) {
      existingReceiptLines++;
    } else {
      skippedLines++;
      issues.push({
        receivingLineId: receivingLine.receivingLineId,
        purchaseOrderLineId: poLine.id,
        reason: "receipt_not_applied",
        detail: `PO receipt was not applied for receiving line ${receivingLine.receivingLineId}`,
      });
    }
  }

  await recalculateTotals(poId, executor);
  const poStatusUpdate = await updatePurchaseOrderReceiptStatus(
    storage,
    poId,
    po,
    executor,
    reconciledAt,
    changedBy,
  );

  return {
    purchaseOrderId: poId,
    appliedLines,
    existingReceiptLines,
    skippedLines,
    autoMatchedLines,
    issues,
    poStatusUpdate,
  };
}

function resolveReceiptUnitCosts(receivingLine: ReceivingReconciliationLine, poLine: any) {
  const poUnitCostMills = typeof poLine.unitCostMills === "number"
    ? poLine.unitCostMills
    : centsToMills(Number(poLine.unitCostCents ?? 0));
  const poUnitCostCents = typeof poLine.unitCostCents === "number"
    ? poLine.unitCostCents
    : millsToCents(poUnitCostMills);

  if (typeof receivingLine.unitCostMills === "number") {
    return {
      poUnitCostCents,
      poUnitCostMills,
      actualUnitCostCents: millsToCents(receivingLine.unitCostMills),
      actualUnitCostMills: receivingLine.unitCostMills,
    };
  }

  if (typeof receivingLine.unitCost === "number") {
    return {
      poUnitCostCents,
      poUnitCostMills,
      actualUnitCostCents: receivingLine.unitCost,
      actualUnitCostMills: centsToMills(receivingLine.unitCost),
    };
  }

  return {
    poUnitCostCents,
    poUnitCostMills,
    actualUnitCostCents: poUnitCostCents,
    actualUnitCostMills: poUnitCostMills,
  };
}

async function resolvePurchaseOrderId(
  storage: Pick<PoReceiptReconciliationStorage, "getPurchaseOrderLineById" | "getReceivingOrderById">,
  receivingOrderId: number,
  receivingLines: ReceivingReconciliationLine[],
  executor?: any,
): Promise<number | null> {
  const poLineIds = receivingLines
    .map((line) => line.purchaseOrderLineId)
    .filter(Boolean) as number[];

  if (poLineIds.length > 0) {
    const firstPoLine = await storage.getPurchaseOrderLineById(poLineIds[0], executor);
    if (firstPoLine) return firstPoLine.purchaseOrderId;
  }

  const receivingOrder = await storage.getReceivingOrderById(receivingOrderId, executor);
  return receivingOrder?.purchaseOrderId ?? null;
}

async function updatePurchaseOrderReceiptStatus(
  storage: PoReceiptReconciliationStorage,
  poId: number,
  po: any,
  executor: any,
  reconciledAt: Date,
  changedBy?: string,
): Promise<ReceiptReconciliationResult["poStatusUpdate"]> {
  const allLines = await storage.getPurchaseOrderLines(poId, executor);
  const activeLines = allLines.filter(
    (line: any) =>
      line.status !== "cancelled" && ((line.lineType ?? "product") === "product"),
  );
  const allReceived = activeLines.every((line: any) => line.status === "received");
  const someReceived = activeLines.some((line: any) =>
    line.status === "received" || line.status === "partially_received",
  );
  const physicalStatus = po.physicalStatus ?? null;

  if (
    activeLines.length > 0 &&
    allReceived &&
    (po.status !== "received" || physicalStatus !== "received") &&
    po.status !== "closed"
  ) {
    await storage.updatePurchaseOrderStatusWithHistory(poId, {
      status: "received",
      physicalStatus: "received",
      actualDeliveryDate: reconciledAt,
    }, {
      fromStatus: po.status,
      toStatus: "received",
      changedBy,
      notes: "All lines fully received",
    }, executor);
    return { legacyStatus: "received", physicalStatus: "received" };
  }

  if (
    someReceived &&
    (
      po.status !== "partially_received" ||
      !["receiving", "received"].includes(physicalStatus)
    ) &&
    !["received", "closed", "cancelled"].includes(po.status)
  ) {
    await storage.updatePurchaseOrderStatusWithHistory(poId, {
      status: "partially_received",
      physicalStatus: "receiving",
    }, {
      fromStatus: po.status,
      toStatus: "partially_received",
      changedBy,
      notes: "Partial receipt",
    }, executor);
    return { legacyStatus: "partially_received", physicalStatus: "receiving" };
  }

  return null;
}
