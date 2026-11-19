import type { ShipmentHistoryContext, ShipmentHistoryInput, ShipmentHistoryReview } from "@shared/procurement/shipment-history-correction";
import { shipmentHistoryReviewSchema } from "@shared/procurement/shipment-history-correction";
import { shipmentQuantityStage } from "@shared/procurement/purchase-line-shipping";

export class ShipmentHistoryCorrectionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}

export function historyCorrectionBlock(status: string, lineCount: number): string | null {
  if (!["draft", "booked", "in_transit", "at_port", "customs_clearance"].includes(status)) {
    return "History correction is available before delivery. Delivered, costing, closed and cancelled shipments retain their completed history.";
  }
  return lineCount === 0 ? "Add the documented shipment lines before correcting its history." : null;
}

export function shipmentHistoryIssues(lines: ShipmentHistoryContext["lines"], receipts: ShipmentHistoryContext["receipts"], shipmentId: number): string[] {
  const issues: string[] = [];
  const unlinked = new Set(receipts.filter(row => row.shipmentId === null).map(row => row.number));
  if (unlinked.size) issues.push(`${[...unlinked].join(", ")}: receipt membership is unverified. These PO receipts are not evidence of this shipment's quantity.`);
  for (const line of lines) {
    if (line.purchaseOrderLineId === null) issues.push(`${line.sku}: the shipment line has no PO line link.`);
    if (line.postedReceiptPieces !== null && line.receivedPieces !== null && line.postedReceiptPieces !== line.receivedPieces) {
      issues.push(`${line.sku}: receipt postings record ${line.postedReceiptPieces.toLocaleString("en-US")} pieces, but the PO received counter is ${line.receivedPieces.toLocaleString("en-US")}. Check the receiving documents before correcting quantities.`);
    }
    if (line.receivedPieces !== null && line.otherShippedPieces !== null && line.receivedPieces > line.pieces + line.otherShippedPieces) {
      issues.push(`${line.sku}: the PO received count exceeds this manifest plus its other recorded shipments. Correcting status will not resolve that quantity difference.`);
    }
  }
  if (receipts.some(row => row.shipmentId === shipmentId && row.piecesPerUnit === null)) {
    issues.push("A linked receipt has no saved pieces-per-unit conversion. This review preserves its received count.");
  }
  return issues;
}

export function planShipmentHistoryCorrection(context: ShipmentHistoryContext, input: ShipmentHistoryInput, protectedRecordsVersion: string, now: Date): ShipmentHistoryReview {
  if (!context.canApprove) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_ADMIN_REQUIRED", "A current Administrator with purchasing approval permission must approve this correction.", 403);
  if (context.blockedReason) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_STATE", context.blockedReason);
  if (context.sourceVersion !== input.sourceVersion) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_STALE", "The shipment, receipts or costs changed. Reload and review the new before and after.");
  const today = now.toISOString().slice(0, 10);
  if (input.departedOn > today || (input.deliveredOn !== null && (input.deliveredOn > today || input.deliveredOn < input.departedOn))) {
    throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_DATES", "Document dates must be in the past, with delivery on or after departure.", 400);
  }
  if ((input.status === "delivered") !== (input.deliveredOn !== null)) {
    throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_DATES", "Enter the delivery date only when confirming delivery.", 400);
  }
  if (input.status === "in_transit" && !["draft", "booked"].includes(context.current.status)) {
    throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_STATE", "This shipment has already departed. Review its delivery evidence instead of moving it backwards.");
  }
  // Only reclassify the recorded manifest. No receipt or catalog conversion is
  // authoritative enough to manufacture a different shipped piece count.
  const total = context.lines.reduce((sum, line) => sum + BigInt(line.pieces), BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new ShipmentHistoryCorrectionError("SHIPMENT_HISTORY_QUANTITY_RANGE", "The manifest exceeds the supported piece count.");
  const wasPlanned = shipmentQuantityStage(context.current.status) === "planned";
  return shipmentHistoryReviewSchema.parse({
    before: context.current,
    after: { status: input.status, departedOn: input.departedOn, deliveredOn: input.deliveredOn },
    lines: context.lines, receipts: context.receipts, charges: context.charges, issues: context.issues,
    plannedPiecesBefore: wasPlanned ? Number(total) : 0, shippedPiecesBefore: wasPlanned ? 0 : Number(total),
    plannedPiecesAfter: 0, shippedPiecesAfter: Number(total), protectedRecordsVersion,
  });
}
