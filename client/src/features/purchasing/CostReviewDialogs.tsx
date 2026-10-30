import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ShipmentCostException } from "@shared/procurement/shipment-cost-exception";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { CostOriginRepair } from "./CostOriginRepair";
import { InvoiceCostReviewAction } from "./InvoiceCostReviewAction";
import { InvoiceQuantityCorrection } from "./InvoiceQuantityCorrection";
import { ShipmentCostExceptionReview } from "./ShipmentCostExceptionReview";
import { ShipmentCostLinkReview } from "./ReceiptShipmentQuantityCorrection";
import { ShipmentMeasurementCorrection } from "./ShipmentMeasurementCorrection";

export type CostReviewDialog =
  | { kind: "invoice_amounts"; invoiceId: number; lineId: number }
  | { kind: "invoice_quantity"; lineId: number; lineNumber: number }
  | { kind: "origin"; lotId: number }
  | { kind: "reconciliation"; lineId: number; review: ShipmentCostException }
  | { kind: "links"; shipmentId: number; lineId: number; sku: string | null }
  | { kind: "measurements"; shipmentId: number };

export type OpenCostReview = (review: CostReviewDialog) => void;

/** A task can disappear as soon as its command commits. Keep the active editor
 * outside that derived list so refetching cannot discard its result, ambiguous
 * retry key or approval details. Each existing owner still validates fresh data. */
export function CostReviewDialogs({ review, onClose }: {
  review: CostReviewDialog; onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const control = { open: true, hideTrigger: true, onOpenChange: (open: boolean) => { if (!open) onClose(); } };
  const refresh = () => { void invalidatePurchaseCosts(queryClient); };
  switch (review.kind) {
    case "invoice_amounts": return <InvoiceCostReviewAction {...control} invoiceId={review.invoiceId} lineId={review.lineId} onSaved={refresh} />;
    case "invoice_quantity": return <InvoiceQuantityCorrection {...control} lineId={review.lineId} lineNumber={review.lineNumber} needsCorrection allowMatched onSaved={refresh} />;
    case "origin": return <CostOriginRepair {...control} lotId={review.lotId} />;
    case "reconciliation": return <ShipmentCostExceptionReview {...control} compact lineId={review.lineId} review={review.review} />;
    case "links": return <ShipmentCostLinkReview {...control} shipmentId={review.shipmentId} lineId={review.lineId} sku={review.sku} />;
    case "measurements": return <ShipmentMeasurementCorrection {...control} shipmentId={review.shipmentId} />;
  }
}
