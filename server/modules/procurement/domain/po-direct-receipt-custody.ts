import { custodyQuantities } from "./receiving-quarantine";

export interface PoDirectCustodyObservation {
  id: number; receivingOrderId: number; receivingLineId: number | null;
  purchaseOrderId: number | null; inboundShipmentId: number | null; receiptStatus: string | null;
  purchaseOrderLineId: number | null; inboundShipmentLineId: number | null;
  productId: number | null; productVariantId: number | null; unitsPerVariant: number | null;
  observedQty: number; awaitingReceiptQty: number; receivedQty: number; returnedQty: number; version: number;
  sourceReceivingOrderId: number | null; sourcePurchaseOrderLineId: number | null; sourceShipmentLineId: number | null;
  sourceProductId: number | null; sourceProductVariantId: number | null; sourceUnitsPerVariant: number | null; sourceReceivedQty: number | null;
  purchaseLineOrderId: number | null; purchaseProductId: number | null;
  shipmentLineOrderId: number | null; shipmentLinePurchaseOrderId: number | null; shipmentLinePurchaseLineId: number | null;
}

export interface PoDirectCustodyAcceptance {
  id: number; observationId: number; observationQty: number; receivingOrderId: number; receivingLineId: number;
  productId: number; productVariantId: number; unitsPerVariant: number; acceptedVariantQty: number; status: string;
  receiptStatus: string | null; receiptPurchaseOrderId: number | null; receiptShipmentId: number | null;
  lineReceivingOrderId: number | null; linePurchaseOrderLineId: number | null; lineShipmentLineId: number | null;
  lineProductId: number | null; lineProductVariantId: number | null; lineUnitsPerVariant: number | null; lineReceivedQty: number | null;
}

export interface PoDirectCustodyEvidence {
  purchaseOrderId: number;
  observations: readonly PoDirectCustodyObservation[];
  acceptances: readonly PoDirectCustodyAcceptance[];
  unidentifiedAcceptances?: readonly PoDirectUnidentifiedAcceptance[];
}

export interface PoDirectUnidentifiedAcceptance extends PoDirectCustodyAcceptance {
  observationReceivingOrderId: number; observationReceivingLineId: number | null;
  observationProductId: number | null; observationProductVariantId: number | null; observationUnitsPerVariant: number | null;
  observationPurchaseOrderLineId: number | null; observationShipmentLineId: number | null;
  observationObservedQty: number; observationAwaitingReceiptQty: number; observationReceivedQty: number;
  observationReturnedQty: number; observationVersion: number;
  observationWarehouseId: number; sourceReceiptWarehouseId: number | null; receiptWarehouseId: number | null;
  sourceReceiptStatus: string | null;
  targetPurchaseOrderId: number | null; targetPurchaseProductId: number | null;
}

export interface PoDirectReceiptLine {
  id: number; purchaseOrderLineId: number | null; inboundShipmentLineId: number | null;
  productId: number | null; productVariantId: number | null; receivedQty: number; unitsPerVariantSnapshot: number | null;
}

export class PoDirectCustodySourceError extends Error {
  readonly statusCode = 409;
  readonly details: Readonly<{
    code: "PO_DIRECT_CUSTODY_SOURCE_REQUIRED"; purchaseOrderId: number;
    purchaseOrderLineIds: number[]; custodyReceiptIds: number[]; reason: string;
  }>;
  constructor(purchaseOrderId: number, sources: ReadonlyMap<number, readonly number[]>,
    reason = "These purchase lines already have recorded physical custody.") {
    super(`${reason} Open the original receipt or a reviewed quarantine acceptance; ordinary PO-direct receiving cannot establish a new arrival for those goods.`);
    this.name = "PoDirectCustodySourceError";
    this.details = { code: "PO_DIRECT_CUSTODY_SOURCE_REQUIRED", purchaseOrderId,
      purchaseOrderLineIds: [...sources.keys()].sort((a, b) => a - b),
      custodyReceiptIds: [...new Set([...sources.values()].flat())].sort((a, b) => a - b), reason };
  }
}

const MUTABLE_RECEIPTS = new Set(["draft", "open", "receiving", "verified"]);
const MAX_INTEGER = 2_147_483_647;
export const MAX_PO_DIRECT_CUSTODY_ROWS = 10_000;
function integer(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= (positive ? 1 : 0) && value <= MAX_INTEGER;
}

/** Exact purchase-line identities only. Custody history remains a source
 * restriction after acceptance or return; neither event proves a new arrival. */
export function inspectPoDirectCustodyEvidence(evidence: PoDirectCustodyEvidence): {
  sources: Map<number, number[]>;
  observationsByLine: Map<number, PoDirectCustodyObservation[]>;
  pendingAcceptances: Map<number, PoDirectCustodyAcceptance>;
} {
  const sources = new Map<number, number[]>();
  function fail(reason: string): never { throw new PoDirectCustodySourceError(evidence.purchaseOrderId, sources, reason); }
  if (!integer(evidence.purchaseOrderId, true) || !Array.isArray(evidence.observations) || !Array.isArray(evidence.acceptances)
    || evidence.observations.length > MAX_PO_DIRECT_CUSTODY_ROWS || evidence.acceptances.length > MAX_PO_DIRECT_CUSTODY_ROWS) {
    fail("Custody source evidence is incomplete or exceeds the supported limit.");
  }
  const observations = new Map<number, PoDirectCustodyObservation>();
  const sourceLines = new Set<number>();
  const observationsByLine = new Map<number, PoDirectCustodyObservation[]>();
  for (const row of evidence.observations) {
    if (integer(row.purchaseOrderLineId, true) && integer(row.receivingOrderId, true)) {
      const receipts = sources.get(row.purchaseOrderLineId) ?? [];
      if (!receipts.includes(row.receivingOrderId)) receipts.push(row.receivingOrderId);
      sources.set(row.purchaseOrderLineId, receipts);
    }
    if (!integer(row.id, true) || observations.has(row.id) || !integer(row.receivingOrderId, true)
      || !integer(row.receivingLineId, true) || sourceLines.has(row.receivingLineId)
      || !integer(row.purchaseOrderLineId, true) || !integer(row.productId, true) || !integer(row.productVariantId, true)
      || !integer(row.unitsPerVariant, true) || !integer(row.sourceReceivedQty)
      || row.purchaseOrderId !== evidence.purchaseOrderId || row.purchaseLineOrderId !== evidence.purchaseOrderId
      || row.purchaseProductId !== row.productId || row.sourceReceivingOrderId !== row.receivingOrderId
      || row.sourcePurchaseOrderLineId !== row.purchaseOrderLineId || row.sourceShipmentLineId !== row.inboundShipmentLineId
      || row.sourceProductId !== row.productId || row.sourceProductVariantId !== row.productVariantId
      || row.sourceUnitsPerVariant !== row.unitsPerVariant
      || !(row.receiptStatus === "closed" || MUTABLE_RECEIPTS.has(row.receiptStatus ?? ""))) {
      fail("Custody does not prove an exact original purchase and receiving source.");
    }
    if (row.inboundShipmentId === null ? row.inboundShipmentLineId !== null
      : !integer(row.inboundShipmentId, true) || !integer(row.inboundShipmentLineId, true)
        || row.shipmentLineOrderId !== row.inboundShipmentId || row.shipmentLinePurchaseOrderId !== evidence.purchaseOrderId
        || row.shipmentLinePurchaseLineId !== row.purchaseOrderLineId) {
      fail("Custody shipment identity disagrees with its original purchase source.");
    }
    try { custodyQuantities(row); } catch { fail("Custody quantities or dispositions do not reconcile."); }
    observations.set(row.id, row);
    sourceLines.add(row.receivingLineId);
    observationsByLine.set(row.purchaseOrderLineId, [...(observationsByLine.get(row.purchaseOrderLineId) ?? []), row]);
  }

  const pendingAcceptances = new Map<number, PoDirectCustodyAcceptance>();
  const seenAcceptances = new Set<number>();
  const acceptanceLines = new Set<number>();
  const totals = new Map<number, { awaiting: number; received: number }>();
  for (const row of evidence.acceptances) {
    const observation = observations.get(row.observationId);
    if (!observation || !integer(row.id, true) || seenAcceptances.has(row.id) || !integer(row.observationQty, true)
      || !integer(row.receivingOrderId, true) || !integer(row.receivingLineId, true) || acceptanceLines.has(row.receivingLineId)
      || !integer(row.productId, true) || !integer(row.productVariantId, true) || !integer(row.unitsPerVariant, true)
      || !integer(row.acceptedVariantQty, true) || !["awaiting_receipt", "received", "cancelled"].includes(row.status)
      || row.productId !== observation.productId || row.receiptPurchaseOrderId !== evidence.purchaseOrderId
      || row.receiptShipmentId !== observation.inboundShipmentId || row.lineReceivingOrderId !== row.receivingOrderId
      || row.linePurchaseOrderLineId !== observation.purchaseOrderLineId || row.lineShipmentLineId !== observation.inboundShipmentLineId
      || row.lineProductId !== row.productId || row.lineProductVariantId !== row.productVariantId || row.lineUnitsPerVariant !== row.unitsPerVariant
      || BigInt(row.acceptedVariantQty) * BigInt(row.unitsPerVariant) !== BigInt(row.observationQty) * BigInt(observation.unitsPerVariant!)) {
      fail("Custody acceptance does not preserve its exact purchase source, product and piece count.");
    }
    seenAcceptances.add(row.id);
    acceptanceLines.add(row.receivingLineId);
    if (row.status === "cancelled") continue;
    if (row.lineReceivedQty !== row.acceptedVariantQty || (row.status === "received" ? row.receiptStatus !== "closed"
      : !MUTABLE_RECEIPTS.has(row.receiptStatus ?? ""))) fail("Custody acceptance and its receipt disagree.");
    const total = totals.get(row.observationId) ?? { awaiting: 0, received: 0 };
    if (row.status === "received") total.received += row.observationQty;
    else { total.awaiting += row.observationQty; pendingAcceptances.set(row.receivingLineId, row); }
    totals.set(row.observationId, total);
  }
  for (const row of observations.values()) {
    const total = totals.get(row.id) ?? { awaiting: 0, received: 0 };
    if (total.awaiting !== row.awaitingReceiptQty || total.received !== row.receivedQty) {
      fail("Custody counters have no matching acceptance evidence.");
    }
  }
  const unidentified = evidence.unidentifiedAcceptances ?? [];
  if (!Array.isArray(unidentified) || unidentified.length > MAX_PO_DIRECT_CUSTODY_ROWS) fail("Unidentified-package acceptance evidence is incomplete.");
  const unidentifiedTotals = new Map<number, { balance: string; awaiting: number }>();
  for (const row of unidentified) {
    if (!integer(row.id, true) || seenAcceptances.has(row.id) || !integer(row.observationId, true) || observations.has(row.observationId)
      || !integer(row.observationReceivingOrderId, true) || !integer(row.receivingOrderId, true)
      || !integer(row.receivingLineId, true) || acceptanceLines.has(row.receivingLineId)
      || !integer(row.observationQty, true) || !integer(row.productId, true) || !integer(row.productVariantId, true)
      || !integer(row.acceptedVariantQty, true) || !integer(row.unitsPerVariant, true)
      || !integer(row.linePurchaseOrderLineId, true) || !integer(row.observationWarehouseId, true)
      || row.status !== "awaiting_receipt" || !MUTABLE_RECEIPTS.has(row.receiptStatus ?? "")
      || row.observationReceivingLineId !== null || row.observationProductId !== null || row.observationProductVariantId !== null
      || row.observationUnitsPerVariant !== null || row.observationPurchaseOrderLineId !== null || row.observationShipmentLineId !== null
      || row.receiptPurchaseOrderId !== evidence.purchaseOrderId || row.targetPurchaseOrderId !== evidence.purchaseOrderId
      || row.receiptShipmentId !== null || row.lineShipmentLineId !== null || row.lineReceivingOrderId !== row.receivingOrderId
      || row.lineProductId !== row.productId || row.targetPurchaseProductId !== row.productId
      || row.lineProductVariantId !== row.productVariantId || row.lineUnitsPerVariant !== row.unitsPerVariant
      || row.lineReceivedQty !== row.acceptedVariantQty || row.sourceReceiptWarehouseId !== row.observationWarehouseId
      || row.receiptWarehouseId !== row.observationWarehouseId
      || !(row.sourceReceiptStatus === "closed" || MUTABLE_RECEIPTS.has(row.sourceReceiptStatus ?? ""))
      || BigInt(row.acceptedVariantQty) * BigInt(row.unitsPerVariant) > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail("An unidentified-package acceptance lacks its exact reviewed target, frozen units or physical custody source.");
    }
    const quantities = { observedQty: row.observationObservedQty, awaitingReceiptQty: row.observationAwaitingReceiptQty,
      receivedQty: row.observationReceivedQty, returnedQty: row.observationReturnedQty, version: row.observationVersion };
    try { custodyQuantities(quantities); } catch { fail("Unidentified-package custody quantities do not reconcile."); }
    const balance = JSON.stringify(quantities);
    const total = unidentifiedTotals.get(row.observationId) ?? { balance, awaiting: 0 };
    total.awaiting += row.observationQty;
    if (total.balance !== balance || total.awaiting > row.observationAwaitingReceiptQty) {
      fail("Pending unidentified-package acceptances exceed their recorded custody.");
    }
    unidentifiedTotals.set(row.observationId, total);
    seenAcceptances.add(row.id);
    acceptanceLines.add(row.receivingLineId);
    // Unknown package counts do not establish a purchase-line quantity. Only
    // this explicit approver-created receiving line gets an admission exception;
    // no ordinary row or PO-direct creation inherits its reviewed conversion.
    pendingAcceptances.set(row.receivingLineId, row);
  }
  for (const receiptIds of sources.values()) receiptIds.sort((a, b) => a - b);
  return { sources, observationsByLine, pendingAcceptances };
}

export function assertPoDirectCustodyAdmission(evidence: PoDirectCustodyEvidence, input: {
  receivingOrderId: number; lines: readonly PoDirectReceiptLine[];
}): void {
  const { sources, observationsByLine, pendingAcceptances } = inspectPoDirectCustodyEvidence(evidence);
  function fail(reason: string, purchaseLineId?: number): never {
    throw new PoDirectCustodySourceError(evidence.purchaseOrderId,
      purchaseLineId === undefined ? sources : new Map([[purchaseLineId, sources.get(purchaseLineId) ?? []]]), reason);
  }
  if (!integer(input.receivingOrderId, true) || !Array.isArray(input.lines) || input.lines.length > MAX_PO_DIRECT_CUSTODY_ROWS) {
    fail("Receipt identity or counted lines are invalid.");
  }
  const seen = new Set<number>();
  for (const line of input.lines) {
    if (!integer(line.id, true) || seen.has(line.id) || !integer(line.receivedQty)) fail("Receipt count identities are invalid or duplicated.");
    seen.add(line.id);
    if (line.receivedQty === 0) continue;
    if (!integer(line.purchaseOrderLineId, true)) fail("A counted PO-direct line has incomplete purchase source evidence.");
    const observed = observationsByLine.get(line.purchaseOrderLineId);
    if (!observed) continue;
    if (line.inboundShipmentLineId !== null || !integer(line.productId, true)
      || !integer(line.productVariantId, true) || !integer(line.unitsPerVariantSnapshot, true)) fail("A counted PO-direct line has incomplete custody source evidence.");
    const acceptance = pendingAcceptances.get(line.id);
    if (acceptance && acceptance.receivingOrderId === input.receivingOrderId && acceptance.receiptShipmentId === null
      && acceptance.linePurchaseOrderLineId === line.purchaseOrderLineId && acceptance.productId === line.productId
      && acceptance.productVariantId === line.productVariantId && acceptance.unitsPerVariant === line.unitsPerVariantSnapshot
      && acceptance.acceptedVariantQty === line.receivedQty) continue;
    // An original intake freezes accepted counts. A second observation on this
    // PO line removes that exemption: a new intake cannot relabel an old draft
    // as its own authority for goods already recorded by another receipt.
    const original = observed.length === 1 ? observed[0] : undefined;
    if (original && original.receivingOrderId === input.receivingOrderId && original.receivingLineId === line.id
      && original.inboundShipmentId === null && original.inboundShipmentLineId === null
      && MUTABLE_RECEIPTS.has(original.receiptStatus ?? "") && original.productId === line.productId
      && original.productVariantId === line.productVariantId && original.unitsPerVariant === line.unitsPerVariantSnapshot
      && original.sourceReceivedQty === line.receivedQty) continue;
    fail("This counted line has no unambiguous original custody count or reviewed acceptance.", line.purchaseOrderLineId);
  }
}
