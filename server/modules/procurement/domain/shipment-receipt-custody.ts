import { custodyQuantities } from "./receiving-quarantine";
import { computeClosedShipmentReceivedBaseQtyByLine, ShipmentReceiptCoverageError,
  type ShipmentReceiptCoverageEvidence } from "../receiving-shipment-coverage";

export interface ShipmentCustodyObservationEvidence {
  id: number; receivingOrderId: number; receivingLineId: number | null;
  purchaseOrderId: number | null; inboundShipmentId: number | null; receiptStatus: string;
  purchaseOrderLineId: number | null; inboundShipmentLineId: number | null;
  productId: number | null; unitsPerVariant: number | null;
  observedQty: number; awaitingReceiptQty: number; receivedQty: number; returnedQty: number; version: number;
  sourceReceivingOrderId: number | null; sourcePurchaseOrderLineId: number | null; sourceShipmentLineId: number | null;
  sourceProductId: number | null; sourceUnitsPerVariant: number | null; sourceReceivedQty: number | null;
  purchaseProductId: number | null;
}

export interface ShipmentCustodyAcceptanceEvidence {
  id: number; observationId: number; observationQty: number; receivingOrderId: number; receivingLineId: number;
  acceptedVariantQty: number; unitsPerVariant: number; status: string;
  receiptStatus: string | null; receiptPurchaseOrderId: number | null; receiptShipmentId: number | null;
  lineReceivingOrderId: number | null; linePurchaseOrderLineId: number | null; lineShipmentLineId: number | null;
  lineUnitsPerVariant: number | null; lineReceivedQty: number | null;
}

export interface ShipmentReceiptCustodyEvidence extends ShipmentReceiptCoverageEvidence {
  custodyObservations: readonly ShipmentCustodyObservationEvidence[];
  custodyAcceptances: readonly ShipmentCustodyAcceptanceEvidence[];
}

export interface ShipmentLineReceiptCoverage {
  receivedBaseQty: number;
  /** Already physically observed, but not posted by an acceptance receipt. */
  custodyBaseQty: number;
  heldBaseQty: number;
  returnedBaseQty: number;
  custodyReceiptIds: number[];
}

export interface ShipmentReceiptCustodyCoverage {
  lines: Map<number, ShipmentLineReceiptCoverage>;
  custodySourceLineIds: Set<number>;
  /** Credits only an exact awaiting-acceptance line when that receipt closes. */
  acceptanceBaseQtyByReceivingLine: Map<number, number>;
  /** Original accepted counts on an open custody source are physical evidence,
   * too. They prevent a different old draft taking those goods before close. */
  unpostedSourceLines: Array<{ receivingLineId: number; receivingOrderId: number; shipmentLineId: number; baseQty: number }>;
}

const MAX_ROWS = 10_000;
const MAX_INTEGER = 2_147_483_647;
const MUTABLE_RECEIPT_STATUSES = new Set(["draft", "open", "receiving", "verified"]);
function validInteger(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= (positive ? 1 : 0) && value <= MAX_INTEGER;
}
function invalid(reason: string, context: Record<string, unknown>): never {
  throw new ShipmentReceiptCoverageError(reason, context);
}
function exactPieces(quantity: number, factor: number, context: Record<string, unknown>): number {
  if (!validInteger(quantity) || !validInteger(factor, true)) invalid("custody units or quantities are invalid", context);
  const pieces = BigInt(quantity) * BigInt(factor);
  if (pieces > BigInt(Number.MAX_SAFE_INTEGER)) invalid("custody base pieces exceed the supported exact range", context);
  return Number(pieces);
}
function addExact(left: number, right: number, context: Record<string, unknown>): number {
  if (!Number.isSafeInteger(left + right)) invalid("custody totals exceed the supported exact range", context);
  return left + right;
}

/** Accepted stock and physical custody are different facts. A returned case was
 * still delivered by this shipment; it does not become a fresh arrival again.
 * Acceptance replaces custody coverage with posted coverage in one transaction.
 * Receipt reversals keep their existing net-posting semantics. */
export function computeShipmentReceiptCustodyCoverage(input: ShipmentReceiptCustodyEvidence): ShipmentReceiptCustodyCoverage {
  const posted = computeClosedShipmentReceivedBaseQtyByLine(input);
  const context = { purchaseOrderId: input.purchaseOrderId, inboundShipmentId: input.inboundShipmentId };
  if (!Array.isArray(input.custodyObservations) || !Array.isArray(input.custodyAcceptances)
    || input.custodyObservations.length > MAX_ROWS || input.custodyAcceptances.length > MAX_ROWS) {
    invalid("custody evidence is incomplete or exceeds the supported limit", context);
  }
  const sourceById = new Map(input.shipmentLines.map(line => [line.id, line]));
  const lines = new Map<number, ShipmentLineReceiptCoverage>(input.shipmentLines.map(line => [line.id, {
    receivedBaseQty: posted.get(line.id) ?? 0, custodyBaseQty: 0, heldBaseQty: 0, returnedBaseQty: 0, custodyReceiptIds: [],
  }]));
  const observationById = new Map<number, ShipmentCustodyObservationEvidence>();
  const custodySourceLineIds = new Set<number>();
  const unpostedSourceLines: ShipmentReceiptCustodyCoverage["unpostedSourceLines"] = [];
  const seenSourceLines = new Set<number>();
  for (const observation of input.custodyObservations) {
    const rowContext = { ...context, custodyObservationId: observation.id, receivingOrderId: observation.receivingOrderId };
    if (!validInteger(observation.id, true) || observationById.has(observation.id)) invalid("custody identities are invalid or duplicated", rowContext);
    observationById.set(observation.id, observation);
    // Unidentified packages have no piece conversion or exact purchase source.
    // They cannot be assigned to a shipment line by SKU, catalog or a ratio.
    if (observation.productId === null) {
      if (observation.receivingLineId !== null || observation.inboundShipmentLineId !== null || observation.purchaseOrderLineId !== null
        || observation.unitsPerVariant !== null) invalid("unidentified custody has contradictory source evidence", rowContext);
      continue;
    }
    const source = observation.inboundShipmentLineId === null ? undefined : sourceById.get(observation.inboundShipmentLineId);
    if (!source || !validInteger(observation.receivingLineId, true) || !validInteger(observation.productId, true)
      || !validInteger(observation.receivingOrderId, true) || observation.purchaseOrderId !== input.purchaseOrderId
      || observation.inboundShipmentId !== input.inboundShipmentId || observation.purchaseOrderLineId !== source.purchaseOrderLineId
      || observation.sourceReceivingOrderId !== observation.receivingOrderId || observation.sourceShipmentLineId !== source.id
      || observation.sourcePurchaseOrderLineId !== source.purchaseOrderLineId || observation.sourceProductId !== observation.productId
      || observation.purchaseProductId !== observation.productId || observation.sourceUnitsPerVariant !== observation.unitsPerVariant
      || !validInteger(observation.sourceReceivedQty) || !validInteger(observation.unitsPerVariant, true)
      || !(observation.receiptStatus === "closed" || MUTABLE_RECEIPT_STATUSES.has(observation.receiptStatus))) {
      invalid("custody does not prove an exact original purchase and shipment source", rowContext);
    }
    if (seenSourceLines.has(observation.receivingLineId)) invalid("custody observations duplicate an original receiving line", rowContext);
    seenSourceLines.add(observation.receivingLineId);
    let quantities: ReturnType<typeof custodyQuantities>;
    try { quantities = custodyQuantities(observation); }
    catch { invalid("custody quantities or dispositions do not reconcile", rowContext); }
    const line = lines.get(source.id)!;
    custodySourceLineIds.add(source.id);
    const custodyBaseQty = exactPieces(observation.observedQty - observation.receivedQty, observation.unitsPerVariant, rowContext);
    line.custodyBaseQty = addExact(line.custodyBaseQty, custodyBaseQty, rowContext);
    line.heldBaseQty = addExact(line.heldBaseQty, exactPieces(quantities.physicalHeldQty, observation.unitsPerVariant, rowContext), rowContext);
    line.returnedBaseQty = addExact(line.returnedBaseQty, exactPieces(observation.returnedQty, observation.unitsPerVariant, rowContext), rowContext);
    if (custodyBaseQty > 0 && !line.custodyReceiptIds.includes(observation.receivingOrderId)) line.custodyReceiptIds.push(observation.receivingOrderId);
    if (observation.receiptStatus !== "closed") {
      unpostedSourceLines.push({ receivingLineId: observation.receivingLineId, receivingOrderId: observation.receivingOrderId,
        shipmentLineId: source.id, baseQty: exactPieces(observation.sourceReceivedQty, observation.unitsPerVariant, rowContext) });
    }
  }
  const acceptanceBaseQtyByReceivingLine = new Map<number, number>();
  const totalsByObservation = new Map<number, { awaiting: number; received: number }>();
  const acceptanceIds = new Set<number>();
  for (const acceptance of input.custodyAcceptances) {
    const observation = observationById.get(acceptance.observationId);
    const rowContext = { ...context, custodyAcceptanceId: acceptance.id, receivingLineId: acceptance.receivingLineId };
    if (!observation || !validInteger(acceptance.id, true) || acceptanceIds.has(acceptance.id)
      || !validInteger(acceptance.observationQty, true) || !validInteger(acceptance.receivingOrderId, true)
      || !validInteger(acceptance.receivingLineId, true) || !["awaiting_receipt", "received", "cancelled"].includes(acceptance.status)) {
      invalid("custody acceptance identities or quantities are invalid", rowContext);
    }
    acceptanceIds.add(acceptance.id);
    if (observation.productId === null) continue;
    if (acceptance.lineReceivingOrderId !== acceptance.receivingOrderId || acceptance.receiptPurchaseOrderId !== input.purchaseOrderId
      || acceptance.receiptShipmentId !== input.inboundShipmentId || acceptance.linePurchaseOrderLineId !== observation.purchaseOrderLineId
      || acceptance.lineShipmentLineId !== observation.inboundShipmentLineId || acceptance.lineUnitsPerVariant !== acceptance.unitsPerVariant
      || exactPieces(acceptance.acceptedVariantQty, acceptance.unitsPerVariant, rowContext)
        !== exactPieces(acceptance.observationQty, observation.unitsPerVariant!, rowContext)) {
      invalid("custody acceptance does not preserve the original source and exact pieces", rowContext);
    }
    if (acceptance.status === "cancelled") continue;
    if (acceptance.lineReceivedQty !== acceptance.acceptedVariantQty
      || (acceptance.status === "received" ? acceptance.receiptStatus !== "closed"
        : !MUTABLE_RECEIPT_STATUSES.has(acceptance.receiptStatus ?? ""))) {
      invalid("custody acceptance and its physical receipt disagree", rowContext);
    }
    const total = totalsByObservation.get(observation.id) ?? { awaiting: 0, received: 0 };
    if (acceptance.status === "received") total.received = addExact(total.received, acceptance.observationQty, rowContext);
    else {
      total.awaiting = addExact(total.awaiting, acceptance.observationQty, rowContext);
      if (acceptanceBaseQtyByReceivingLine.has(acceptance.receivingLineId)) invalid("custody acceptances share a receiving line", rowContext);
      acceptanceBaseQtyByReceivingLine.set(acceptance.receivingLineId, exactPieces(acceptance.acceptedVariantQty, acceptance.unitsPerVariant, rowContext));
    }
    totalsByObservation.set(observation.id, total);
  }
  for (const observation of input.custodyObservations) {
    if (observation.productId === null) continue;
    const totals = totalsByObservation.get(observation.id) ?? { awaiting: 0, received: 0 };
    if (totals.awaiting !== observation.awaitingReceiptQty || totals.received !== observation.receivedQty) {
      invalid("custody receipt counters have no matching acceptance evidence", { ...context, custodyObservationId: observation.id });
    }
  }
  for (const line of lines.values()) line.custodyReceiptIds.sort((left, right) => left - right);
  return { lines, custodySourceLineIds, acceptanceBaseQtyByReceivingLine, unpostedSourceLines };
}

export function assertShipmentCustodyAdmission(input: {
  receivingOrderId: number; coverage: ShipmentReceiptCustodyCoverage;
  shipmentLines: ShipmentReceiptCoverageEvidence["shipmentLines"];
  receivingLines: readonly { id: number; inboundShipmentLineId: number | null; receivedQty: number; unitsPerVariantSnapshot: number | null }[];
}): void {
  const proposed = new Map<number, number>();
  for (const line of input.receivingLines) {
    if (line.receivedQty === 0 || line.inboundShipmentLineId === null) continue;
    const context = { receivingOrderId: input.receivingOrderId, receivingLineId: line.id };
    const pieces = exactPieces(line.receivedQty, line.unitsPerVariantSnapshot!, context);
    const approved = input.coverage.acceptanceBaseQtyByReceivingLine.get(line.id) ?? 0;
    if (approved !== 0 && approved !== pieces) invalid("the reviewed custody acceptance quantity changed", context);
    proposed.set(line.inboundShipmentLineId, addExact(proposed.get(line.inboundShipmentLineId) ?? 0, pieces - approved, context));
  }
  for (const source of input.shipmentLines) {
    const coverage = input.coverage.lines.get(source.id)!;
    const otherPending = input.coverage.unpostedSourceLines.filter(line => line.shipmentLineId === source.id && line.receivingOrderId !== input.receivingOrderId)
      .reduce((sum, line) => addExact(sum, line.baseQty, { shipmentLineId: source.id }), 0);
    // Preserve ordinary, explicitly reviewed over-receipt when the source has
    // no custody history. That flag can never release held or returned goods.
    if (!input.coverage.custodySourceLineIds.has(source.id)) continue;
    const available = Math.max(0, source.qtyShipped - coverage.receivedBaseQty - coverage.custodyBaseQty - otherPending);
    if ((proposed.get(source.id) ?? 0) > available) {
      throw new ShipmentReceiptCoverageError("this receipt would re-admit goods already recorded in quarantine; resolve their custody explicitly", {
        receivingOrderId: input.receivingOrderId, inboundShipmentLineId: source.id, availableBaseQty: available,
        custodyBaseQty: coverage.custodyBaseQty, custodyReceiptIds: coverage.custodyReceiptIds,
      });
    }
  }
}

export function summarizeShipmentReceiptCustodyCoverage(
  shipmentLines: ShipmentReceiptCoverageEvidence["shipmentLines"], coverage: ShipmentReceiptCustodyCoverage,
) {
  let totalExpectedBaseQty = 0;
  let totalReceivedBaseQty = 0;
  let totalCustodyBaseQty = 0;
  let totalHeldBaseQty = 0;
  let totalReturnedBaseQty = 0;
  let totalRemainingBaseQty = 0;
  let totalExcessBaseQty = 0;
  const custodyReceiptIds = new Set<number>();
  const remainingBaseQtyByLine = new Map<number, number>();
  for (const source of shipmentLines) {
    const line = coverage.lines.get(source.id);
    if (!line) invalid("the source coverage snapshot is incomplete", { shipmentLineId: source.id });
    const context = { shipmentLineId: source.id };
    totalExpectedBaseQty = addExact(totalExpectedBaseQty, source.qtyShipped, context);
    totalReceivedBaseQty = addExact(totalReceivedBaseQty, line.receivedBaseQty, context);
    totalCustodyBaseQty = addExact(totalCustodyBaseQty, line.custodyBaseQty, context);
    totalHeldBaseQty = addExact(totalHeldBaseQty, line.heldBaseQty, context);
    totalReturnedBaseQty = addExact(totalReturnedBaseQty, line.returnedBaseQty, context);
    const accounted = addExact(line.receivedBaseQty, line.custodyBaseQty, context);
    const remaining = Math.max(0, source.qtyShipped - accounted);
    const excess = Math.max(0, accounted - source.qtyShipped);
    remainingBaseQtyByLine.set(source.id, remaining);
    totalRemainingBaseQty = addExact(totalRemainingBaseQty, remaining, context);
    totalExcessBaseQty = addExact(totalExcessBaseQty, excess, context);
    for (const receiptId of line.custodyReceiptIds) custodyReceiptIds.add(receiptId);
  }
  return { totalExpectedBaseQty, totalReceivedBaseQty, totalCustodyBaseQty, totalHeldBaseQty, totalReturnedBaseQty,
    totalRemainingBaseQty, totalExcessBaseQty, custodyReceiptIds: [...custodyReceiptIds].sort((left, right) => left - right), remainingBaseQtyByLine };
}
