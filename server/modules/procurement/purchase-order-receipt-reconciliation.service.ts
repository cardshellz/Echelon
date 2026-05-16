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
  getPurchaseOrderById(id: number): Promise<any>;
  getPurchaseOrderLines(purchaseOrderId: number): Promise<any[]>;
  getPurchaseOrderLineById(id: number): Promise<any>;
  getReceivingOrderById(id: number): Promise<any>;
  getReceivingLineById(id: number): Promise<any>;
  getProductVariantById(id: number): Promise<any>;
  reconcilePoReceiptLine(input: {
    purchaseOrderLineId: number;
    receivingLineId: number;
    lineUpdates: Record<string, unknown>;
    receipt: Record<string, unknown>;
  }): Promise<{ applied: boolean; receipt?: any; purchaseOrderLine?: any }>;
  updatePurchaseOrderStatusWithHistory(id: number, updates: any, historyData: any): Promise<any>;
};

export type ReceiptReconciliationResult = {
  purchaseOrderId: number | null;
  appliedLines: number;
  skippedLines: number;
  autoMatchedLines: number;
};

export async function findOpenPoLineByProduct(
  storage: Pick<PoReceiptReconciliationStorage, "getPurchaseOrderLines">,
  poId: number,
  productId: number,
): Promise<any | null> {
  const lines = await storage.getPurchaseOrderLines(poId);
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
  recalculateTotals: (purchaseOrderId: number) => Promise<void>;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<ReceiptReconciliationResult> {
  const { storage, receivingOrderId, receivingLines, recalculateTotals, logger = console } = params;
  const poId = await resolvePurchaseOrderId(storage, receivingOrderId, receivingLines);

  if (!poId) {
    return { purchaseOrderId: null, appliedLines: 0, skippedLines: 0, autoMatchedLines: 0 };
  }

  const po = await storage.getPurchaseOrderById(poId);
  if (!po) {
    return { purchaseOrderId: poId, appliedLines: 0, skippedLines: 0, autoMatchedLines: 0 };
  }

  let autoMatchedLines = 0;
  for (const receivingLine of receivingLines) {
    if (receivingLine.purchaseOrderLineId) continue;

    const receivingLineRecord = await storage.getReceivingLineById(receivingLine.receivingLineId);
    if (!receivingLineRecord) continue;

    let productId: number | null = receivingLineRecord.productId ?? null;
    if (!productId && receivingLineRecord.productVariantId) {
      const variant = await storage.getProductVariantById(receivingLineRecord.productVariantId);
      productId = variant?.productId ?? null;
    }

    if (!productId) {
      logger.warn(
        `[Receiving] Auto-match skipped for receiving line ${receivingLine.receivingLineId}: no product_id resolvable`,
      );
      continue;
    }

    const matchedLine = await findOpenPoLineByProduct(storage, poId, productId);
    if (matchedLine) {
      receivingLine.purchaseOrderLineId = matchedLine.id;
      autoMatchedLines++;
      logger.info(
        `[Receiving] Auto-matched receiving line ${receivingLine.receivingLineId} to PO line ${matchedLine.id} (product_id=${productId})`,
      );
    } else {
      logger.warn(
        `[Receiving] Auto-match failed for receiving line ${receivingLine.receivingLineId}: ` +
        `zero or multiple open PO lines for product_id=${productId} on PO ${poId}. Leaving unlinked.`,
      );
    }
  }

  let appliedLines = 0;
  let skippedLines = 0;

  for (const receivingLine of receivingLines) {
    if (!receivingLine.purchaseOrderLineId) {
      skippedLines++;
      continue;
    }

    const poLine = await storage.getPurchaseOrderLineById(receivingLine.purchaseOrderLineId);
    if (!poLine || (poLine.lineType ?? "product") !== "product") {
      skippedLines++;
      continue;
    }

    const receivingLineRecord = await storage.getReceivingLineById(receivingLine.receivingLineId);
    if (!receivingLineRecord) {
      skippedLines++;
      continue;
    }

    const poVariant = await storage.getProductVariantById(poLine.productVariantId as number);
    const receivedVariant = await storage.getProductVariantById(receivingLineRecord.productVariantId as number);

    const poUnitsPerVariant = poVariant?.unitsPerVariant || poLine.unitsPerUom || 1;
    const receivedUnitsPerVariant = receivedVariant?.unitsPerVariant || 1;

    const baseUnitsReceived = receivingLine.receivedQty * receivedUnitsPerVariant;
    const damagedBaseUnits = (receivingLine.damagedQty || 0) * receivedUnitsPerVariant;

    const poLineUnitsReceived = Math.floor(baseUnitsReceived / poUnitsPerVariant);
    const poLineDamagedReceived = Math.floor(damagedBaseUnits / poUnitsPerVariant);

    const newReceivedQty = (poLine.receivedQty || 0) + poLineUnitsReceived;
    const newDamagedQty = (poLine.damagedQty || 0) + poLineDamagedReceived;
    const remaining = poLine.orderQty - newReceivedQty - (poLine.cancelledQty || 0);

    const lineUpdates: Record<string, unknown> = {
      receivedQty: newReceivedQty,
      damagedQty: newDamagedQty,
      lastReceivedAt: new Date(),
    };

    if (!poLine.receivedDate) {
      lineUpdates.receivedDate = new Date();
    }

    if (remaining <= 0) {
      lineUpdates.status = "received";
      lineUpdates.fullyReceivedDate = new Date();
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
    });

    if (result.applied) {
      appliedLines++;
    } else {
      skippedLines++;
    }
  }

  await recalculateTotals(poId);
  await updatePurchaseOrderReceiptStatus(storage, poId, po);

  return { purchaseOrderId: poId, appliedLines, skippedLines, autoMatchedLines };
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
): Promise<number | null> {
  const poLineIds = receivingLines
    .map((line) => line.purchaseOrderLineId)
    .filter(Boolean) as number[];

  if (poLineIds.length > 0) {
    const firstPoLine = await storage.getPurchaseOrderLineById(poLineIds[0]);
    if (firstPoLine) return firstPoLine.purchaseOrderId;
  }

  const receivingOrder = await storage.getReceivingOrderById(receivingOrderId);
  return receivingOrder?.purchaseOrderId ?? null;
}

async function updatePurchaseOrderReceiptStatus(
  storage: PoReceiptReconciliationStorage,
  poId: number,
  po: any,
) {
  const allLines = await storage.getPurchaseOrderLines(poId);
  const activeLines = allLines.filter(
    (line: any) =>
      line.status !== "cancelled" && ((line.lineType ?? "product") === "product"),
  );
  const allReceived = activeLines.every((line: any) => line.status === "received");
  const someReceived = activeLines.some((line: any) =>
    line.status === "received" || line.status === "partially_received",
  );

  if (allReceived && po.status !== "received" && po.status !== "closed") {
    await storage.updatePurchaseOrderStatusWithHistory(poId, {
      status: "received",
      actualDeliveryDate: new Date(),
    }, {
      fromStatus: po.status,
      toStatus: "received",
      changedBy: undefined,
      notes: "All lines fully received",
    });
  } else if (
    someReceived &&
    po.status !== "partially_received" &&
    po.status !== "received" &&
    po.status !== "closed"
  ) {
    await storage.updatePurchaseOrderStatusWithHistory(poId, { status: "partially_received" }, {
      fromStatus: po.status,
      toStatus: "partially_received",
      changedBy: undefined,
      notes: "Partial receipt",
    });
  }
}
