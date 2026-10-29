import type { PoShipmentCosts } from "./po-shipment-costs";
import { isShipmentCostLinePosted, type ShipmentCostReview } from "./shipment-cost-workflow";
import type { CostReviewShipmentLine } from "./cost-review-tasks";

/** Adapt existing read contracts, preserving their shared posting decision. */
export function poCostReviewShipments(costs: PoShipmentCosts): CostReviewShipmentLine[] {
  return costs.lines.map(line => ({
    lineId: line.lineId, purchaseOrderLineId: line.purchaseOrderLineId ?? null, shipmentId: line.shipmentId,
    shipmentNumber: line.shipmentNumber, sku: line.sku, posted: line.status === "applied", amountCents: line.allocatedCents,
    currency: costs.summary.currency, recordedAt: line.recordedAt, issues: line.issues, exceptionReview: line.exceptionReview,
  }));
}

export function shipmentCostReviewLines(review: ShipmentCostReview): CostReviewShipmentLine[] {
  return review.lines.map(line => ({
    lineId: line.lineId, purchaseOrderLineId: line.purchaseOrderLineId ?? null, shipmentId: review.shipmentId,
    shipmentNumber: null, sku: line.sku, posted: isShipmentCostLinePosted(line), amountCents: line.allocatedCents ?? null,
    currency: line.currency ?? null, recordedAt: line.application?.recordedAt ?? null,
    issues: [...(line.sourceIssue ? [line.sourceIssue] : []), ...(line.application?.issues ?? [])], exceptionReview: line.exceptionReview,
  }));
}
