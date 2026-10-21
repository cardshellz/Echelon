import type {
  QuantityCorrectionInput,
  QuantityCorrectionPurpose,
} from "@shared/procurement/receipt-shipment-quantity-correction";

const MAX_QUANTITY = 2_147_483_647;
export class QuantityCorrectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
export function correctionInteger(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  const text = String(value);
  if (!/^\d+$/.test(text))
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_SOURCE",
      `Recorded ${field} is invalid.`,
    );
  const result = Number(text);
  if (
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > MAX_QUANTITY
  )
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_SOURCE",
      `Recorded ${field} is outside the supported range.`,
    );
  return result;
}
export interface QuantityReceiptFact {
  id: number;
  receiptId: number;
  receiptNumber: string;
  receivedUnits: number;
  receivedPieces: number;
  piecesPerUnit: number;
  unitWasRecorded: boolean;
  variantId: number;
}
export interface QuantityOriginFact {
  inventoryLotId: number;
  receiptLineId: number;
  shipmentLineId: number | null;
  receivedUnits: number;
  piecesPerUnit: number;
  purchaseStart: number;
  shipmentStart: number | null;
}
export interface QuantityCorrectionFacts {
  shipmentLineId: number;
  shippedPieces: number;
  orderPieces: number;
  poReceivedPieces: number;
  cancelledPieces: number;
  otherShippedPieces: number;
  receipts: QuantityReceiptFact[];
  origins: QuantityOriginFact[];
  pendingReceipts?: PendingShipmentReceipt[];
}
export interface PendingShipmentReceipt {
  receiptId: number;
  receiptNumber: string;
  receiptLineId: number;
  expectedUnits: number;
  receivedUnits: number;
  piecesPerUnit: number;
}
export interface QuantityCorrectionPlan {
  shippedPieces: number;
  poReceivedPieces: number;
  receipts: Array<
    QuantityReceiptFact & { afterPieces: number; afterPiecesPerUnit: number }
  >;
  origins: QuantityOriginFact[];
  pendingReceipts: Array<
    PendingShipmentReceipt & { afterExpectedUnits: number }
  >;
}
export function correctedReceiptLifecycle(input: {
  closed: boolean;
  status: string;
  physicalStatus: string | null;
  targetId: number;
  targetReceived: number;
  targetOrdered: number;
  targetCancelled: number;
  lines: Array<{ id: number; status: string; lineType: string | null }>;
}) {
  const targetComplete =
    BigInt(input.targetReceived) + BigInt(input.targetCancelled) >=
    BigInt(input.targetOrdered);
  const active = input.lines.filter(
    (line) =>
      line.status !== "cancelled" && (line.lineType ?? "product") === "product",
  );
  const receivedLineCount = active.filter((line) =>
    line.id === input.targetId ? targetComplete : line.status === "received",
  ).length;
  const complete = active.length > 0 && receivedLineCount === active.length;
  return {
    lineStatus: targetComplete ? "received" : "partially_received",
    receivedLineCount,
    status: input.closed
      ? input.status
      : complete
        ? "received"
        : "partially_received",
    physicalStatus: input.closed
      ? input.physicalStatus
      : complete
        ? "received"
        : "receiving",
  };
}
function bounded(value: bigint, field: string): number {
  if (value < BigInt(0) || value > BigInt(MAX_QUANTITY))
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_RANGE",
      `${field} is outside the supported quantity range.`,
    );
  return Number(value);
}
/** Correct the piece meaning of already handled units; never invent a physical
 * receipt, sale, transfer, or current-catalog interpretation of historical stock. */
export function planQuantityCorrection(
  facts: QuantityCorrectionFacts,
  input: QuantityCorrectionInput,
  purpose: QuantityCorrectionPurpose = "receipt",
): QuantityCorrectionPlan {
  if (
    new Set(input.receipts.map((row) => row.receiptLineId)).size !==
      input.receipts.length ||
    input.receipts.length !== facts.receipts.length ||
    input.receipts.some(
      (row) =>
        !facts.receipts.some((receipt) => receipt.id === row.receiptLineId),
    )
  )
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_RECEIPTS",
      "Review every linked receipt exactly once.",
    );
  let delta = BigInt(0);
  const receipts = facts.receipts.map((receipt) => {
    const requested = input.receipts.find(
      (row) => row.receiptLineId === receipt.id,
    )!;
    if (
      purpose === "shipment" &&
      requested.receivedPieces !== receipt.receivedPieces
    )
      throw new QuantityCorrectionError(
        "SHIPMENT_EDIT_RECEIPT_IMMUTABLE",
        "A shipment edit cannot change received quantities. Correct the receipt from receiving.",
      );
    if (requested.receivedPieces % receipt.receivedUnits !== 0)
      throw new QuantityCorrectionError(
        "QUANTITY_CORRECTION_WHOLE_UNITS",
        `Receipt ${receipt.receiptNumber} has ${receipt.receivedUnits} handled units. Enter a whole number of pieces per unit. Physical count changes use receipt reversal and receiving.`,
      );
    delta += BigInt(requested.receivedPieces) - BigInt(receipt.receivedPieces);
    return {
      ...receipt,
      afterPieces: requested.receivedPieces,
      afterPiecesPerUnit: requested.receivedPieces / receipt.receivedUnits,
    };
  });
  const poReceivedPieces = bounded(
    BigInt(facts.poReceivedPieces) + delta,
    "PO received quantity",
  );
  if (
    BigInt(input.shippedPieces) +
      BigInt(facts.otherShippedPieces) +
      BigInt(facts.cancelledPieces) >
    BigInt(facts.orderPieces)
  )
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_PO_CAPACITY",
      "The corrected shipment exceeds the available PO quantity. Amend the PO quantity first.",
    );
  if (
    BigInt(poReceivedPieces) + BigInt(facts.cancelledPieces) >
    BigInt(facts.orderPieces)
  )
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_PO_RECEIPTS",
      "The corrected receipts exceed the PO quantity. Amend the PO quantity first.",
    );
  if (
    receipts.reduce(
      (sum, receipt) => sum + BigInt(receipt.afterPieces),
      BigInt(0),
    ) > BigInt(input.shippedPieces)
  )
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_SHIPPED",
      "Received pieces cannot exceed the corrected shipment quantity.",
    );
  if (
    !input.repairCostLinks &&
    input.shippedPieces === facts.shippedPieces &&
    receipts.every(
      (receipt) =>
        receipt.afterPieces === receipt.receivedPieces &&
        (purpose === "shipment" || receipt.unitWasRecorded),
    )
  )
    throw new QuantityCorrectionError(
      "QUANTITY_CORRECTION_NO_CHANGE",
      purpose === "shipment"
        ? "The shipped quantity is unchanged. Enter the corrected number of pieces."
        : "These quantities and receiving units are already recorded.",
    );

  const origins = facts.origins.map((origin) => ({ ...origin }));
  for (const receipt of receipts) {
    const roots = origins.filter(
      (origin) => origin.receiptLineId === receipt.id,
    );
    if (
      roots.some(
        (root) =>
          root.piecesPerUnit !== receipt.piecesPerUnit ||
          (root.shipmentLineId !== null &&
            root.shipmentLineId !== facts.shipmentLineId),
      )
    )
      throw new QuantityCorrectionError(
        "QUANTITY_CORRECTION_ORIGIN_CONFLICT",
        "The recorded lot origin and receipt disagree about their unit or shipment. Reconcile that source history first.",
      );
    if (
      roots.length &&
      roots.reduce(
        (sum, root) => sum + BigInt(root.receivedUnits),
        BigInt(0),
      ) !== BigInt(receipt.receivedUnits)
    )
      throw new QuantityCorrectionError(
        "QUANTITY_CORRECTION_ORIGIN_COVERAGE",
        "Recorded lot origins do not cover the exact handled receipt quantity. Reconcile that receipt history first.",
      );
    for (const root of roots) root.piecesPerUnit = receipt.afterPiecesPerUnit;
  }
  // Shift subsequent source intervals by the exact changed quantity, preserving
  // existing gaps and immutable original origins. The repository appends overrides.
  function shift(
    scope: QuantityOriginFact[],
    field: "purchaseStart" | "shipmentStart",
  ) {
    let change = BigInt(0);
    let priorEnd = BigInt(0);
    for (const next of [...scope].sort(
      (a, b) =>
        (a[field] ?? 0) - (b[field] ?? 0) ||
        a.inventoryLotId - b.inventoryLotId,
    )) {
      const before = facts.origins.find(
        (origin) => origin.inventoryLotId === next.inventoryLotId,
      )!;
      const start = BigInt(before[field]!);
      if (start < priorEnd)
        throw new QuantityCorrectionError(
          "QUANTITY_CORRECTION_ORIGIN_OVERLAP",
          "Existing receipt cost intervals overlap. Resolve their source history first.",
        );
      next[field] = bounded(start + change, "Receipt cost interval");
      priorEnd =
        start + BigInt(before.receivedUnits) * BigInt(before.piecesPerUnit);
      change +=
        BigInt(next.receivedUnits) *
        BigInt(next.piecesPerUnit - before.piecesPerUnit);
    }
  }
  shift(origins, "purchaseStart");
  for (const shipmentLineId of new Set(
    origins.map((origin) => origin.shipmentLineId).filter((id) => id !== null),
  )) {
    shift(
      origins.filter((origin) => origin.shipmentLineId === shipmentLineId),
      "shipmentStart",
    );
  }
  return {
    shippedPieces: input.shippedPieces,
    poReceivedPieces,
    receipts,
    origins,
    pendingReceipts: planShipmentReceiptExpectations(
      facts.pendingReceipts ?? [],
      input.shippedPieces,
      receipts.reduce((sum, row) => sum + BigInt(row.afterPieces), BigInt(0)),
    ),
  };
}

/** A single open receipt plans the remaining shipment. Multiple open receipts
 * have no recorded split authority, so require that work to be resolved first. */
export function planShipmentReceiptExpectations(
  receipts: PendingShipmentReceipt[],
  shippedPieces: number,
  postedPieces: bigint,
): Array<PendingShipmentReceipt & { afterExpectedUnits: number }> {
  if (receipts.length > 1)
    throw new QuantityCorrectionError(
      "SHIPMENT_EDIT_OPEN_RECEIPTS",
      "More than one open receipt covers this line. Finish or cancel the duplicate receiving work before editing the shipment.",
    );
  return receipts.map((receipt) => {
    const remaining = BigInt(shippedPieces) - postedPieces;
    if (
      remaining < BigInt(0) ||
      remaining % BigInt(receipt.piecesPerUnit) !== BigInt(0)
    )
      throw new QuantityCorrectionError(
        "SHIPMENT_EDIT_RECEIVING_UNIT",
        `The remaining pieces cannot be expressed in the receiving unit on ${receipt.receiptNumber}. Review that receipt's unit before editing the shipment.`,
      );
    return {
      ...receipt,
      afterExpectedUnits: bounded(
        remaining / BigInt(receipt.piecesPerUnit),
        "Expected receipt units",
      ),
    };
  });
}
