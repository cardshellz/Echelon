/** Canonical shipment policy shared by readiness, creation and close. */
export const RECEIVABLE_SHIPMENT_STATUSES: ReadonlySet<string> = new Set(["at_port", "customs_clearance", "delivered", "costing", "closed"]);

export interface ReceivingIntegrityIssue {
  code: string;
  message: string;
  receivingLineId?: number;
  warehouseId?: number;
  locationId?: number;
  purchaseOrderLineId?: number;
}

export class ReceivingCloseIntegrityError extends Error {
  readonly statusCode = 409;
  readonly details: { code: "RECEIVING_CLOSE_INTEGRITY_REVIEW_REQUIRED"; receivingOrderId: number; issues: ReceivingIntegrityIssue[] };
  constructor(receivingOrderId: number, issues: ReceivingIntegrityIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "ReceivingCloseIntegrityError";
    this.details = { code: "RECEIVING_CLOSE_INTEGRITY_REVIEW_REQUIRED", receivingOrderId, issues };
  }
}

export interface ReceivingSourceLine {
  id: number;
  productId: number | null;
  purchaseOrderLineId: number | null;
  inboundShipmentLineId: number | null;
  receivedQty: number;
  damagedQty: number;
}
export interface ReceiptPurchaseSource {
  id: number;
  purchaseOrderId: number;
  productId: number | null;
  lineType: string;
  status: string;
  orderQty: number;
  receivedQty: number;
  cancelledQty: number;
}
export interface ReceiptShipmentSource {
  id: number;
  inboundShipmentId: number;
  purchaseOrderId: number | null;
  purchaseOrderLineId: number | null;
}
export interface ResolvedReceivingSource {
  receivingLineId: number;
  purchaseOrderLineId: number;
  inboundShipmentLineId: number | null;
}

/** Inferred sources require exactly one remaining product line. Explicit links
 * are validated separately, never silently reassigned. */
export function isOpenReceiptProductSource(line: ReceiptPurchaseSource, productId: number): boolean {
  return (line.lineType ?? "product") === "product" && line.productId === productId &&
    !["cancelled", "received", "closed"].includes(line.status) &&
    line.orderQty - line.receivedQty - line.cancelledQty > 0;
}

export function resolveReceivingSources(input: {
  receivingOrderId: number;
  purchaseOrderId: number | null;
  inboundShipmentId: number | null;
  purchaseStatus: string | null;
  shipmentStatus: string | null;
  lines: readonly ReceivingSourceLine[];
  purchaseLines: readonly ReceiptPurchaseSource[];
  shipmentLines: readonly ReceiptShipmentSource[];
}): ResolvedReceivingSource[] {
  const issues: ReceivingIntegrityIssue[] = [];
  const resolved: ResolvedReceivingSource[] = [];
  const counted = input.lines.filter((line) => line.receivedQty > 0 || line.damagedQty > 0);
  if (counted.length === 0) return resolved;
  if (!input.purchaseOrderId) {
    if (input.inboundShipmentId || counted.some((line) => line.purchaseOrderLineId || line.inboundShipmentLineId)) {
      issues.push({ code: "RECEIVING_SOURCE_MISMATCH", message: "The receipt source is incomplete. Review its purchase and shipment links before closing." });
    }
  } else if (!input.purchaseStatus || input.purchaseStatus === "cancelled") {
    issues.push({ code: "RECEIVING_SOURCE_TERMINAL", message: "The purchase is missing or cancelled. Resolve its source before closing." });
  }
  if (input.inboundShipmentId && (!input.shipmentStatus || !RECEIVABLE_SHIPMENT_STATUSES.has(input.shipmentStatus))) {
    issues.push({ code: "RECEIVING_SOURCE_TERMINAL", message: "The shipment is unavailable or not yet physically receivable. Review its current status before closing." });
  }
  if (issues.length) throw new ReceivingCloseIntegrityError(input.receivingOrderId, issues);
  if (!input.purchaseOrderId) return resolved;
  for (const line of counted) {
    const context = { receivingLineId: line.id };
    const candidates = line.purchaseOrderLineId
      ? input.purchaseLines.filter((candidate) => candidate.id === line.purchaseOrderLineId)
      : input.purchaseLines.filter((candidate) => line.productId !== null && isOpenReceiptProductSource(candidate, line.productId));
    if (candidates.length !== 1) {
      issues.push({ ...context, code: candidates.length > 1 ? "RECEIVING_SOURCE_AMBIGUOUS" : "RECEIVING_SOURCE_UNMATCHED",
        message: candidates.length > 1
          ? "A counted receipt line matches multiple purchase lines. Resolve its exact source before closing."
          : "A counted receipt line has no receivable purchase source. Resolve unexpected goods before closing." });
      continue;
    }
    const source = candidates[0];
    if (source.purchaseOrderId !== input.purchaseOrderId || source.productId !== line.productId ||
        source.lineType !== "product" || ["cancelled", "closed"].includes(source.status)) {
      issues.push({ ...context, purchaseOrderLineId: source.id, code: "RECEIVING_SOURCE_MISMATCH",
        message: "A counted receipt line does not match its current purchase product or source status." });
      continue;
    }
    let shipmentLineId: number | null = null;
    if (input.inboundShipmentId) {
      const shipments = input.shipmentLines.filter((candidate) => candidate.inboundShipmentId === input.inboundShipmentId &&
        candidate.purchaseOrderId === input.purchaseOrderId && candidate.purchaseOrderLineId === source.id &&
        (line.inboundShipmentLineId === null || candidate.id === line.inboundShipmentLineId));
      if (shipments.length !== 1) {
        issues.push({ ...context, purchaseOrderLineId: source.id,
          code: shipments.length > 1 ? "RECEIVING_SOURCE_AMBIGUOUS" : "RECEIVING_SOURCE_MISMATCH",
          message: "A counted receipt line needs one exact shipment-line source before closing." });
        continue;
      }
      shipmentLineId = shipments[0].id;
    } else if (line.inboundShipmentLineId !== null) {
      issues.push({ ...context, code: "RECEIVING_SOURCE_MISMATCH", message: "A receipt line has a shipment source without a matching receipt shipment." });
      continue;
    }
    resolved.push({ receivingLineId: line.id, purchaseOrderLineId: source.id, inboundShipmentLineId: shipmentLineId });
  }
  if (issues.length) throw new ReceivingCloseIntegrityError(input.receivingOrderId, issues);
  return resolved;
}

export interface ReceivingLocationEvidence { id: number; warehouseId: number; isActive: number }
export function assertReceivingLocations(input: {
  receivingOrderId: number;
  warehouseId: number | null;
  warehouseActive: number | null;
  references: readonly { receivingLineId?: number; locationId: number }[];
  locations: readonly ReceivingLocationEvidence[];
}): void {
  if (!input.warehouseId) throw new ReceivingCloseIntegrityError(input.receivingOrderId, [{
    code: "RECEIVING_WAREHOUSE_REQUIRED", message: "Select the receiving warehouse before assigning locations or closing this receipt.",
  }]);
  const issues: ReceivingIntegrityIssue[] = [];
  if (input.warehouseActive !== 1) issues.push({ warehouseId: input.warehouseId,
    code: "RECEIVING_WAREHOUSE_UNAVAILABLE", message: "The receiving warehouse is missing or inactive. Select an active warehouse." });
  const byId = new Map(input.locations.map((location) => [location.id, location]));
  for (const reference of input.references) {
    const location = byId.get(reference.locationId);
    const context = { ...reference, warehouseId: input.warehouseId };
    if (!location || location.isActive !== 1) issues.push({ ...context, code: "RECEIVING_LOCATION_UNAVAILABLE",
      message: "A receipt location is missing or inactive. Review the affected line or default location." });
    else if (location.warehouseId !== input.warehouseId) issues.push({ ...context, code: "RECEIVING_LOCATION_WAREHOUSE_MISMATCH",
      message: "A receipt location belongs to another warehouse. Review existing line locations before changing the warehouse or closing." });
  }
  if (issues.length) throw new ReceivingCloseIntegrityError(input.receivingOrderId, issues);
}
