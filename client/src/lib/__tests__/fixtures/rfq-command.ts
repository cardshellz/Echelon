import type { RfqCommandIntent, RfqCommandReceipt } from "@shared/procurement/rfq-command";
import { reviewRfqQuantity } from "@shared/procurement/rfq-quantity-review";
import type { RfqQuoteEvidence, RfqWorkflowDetail } from "@shared/procurement/rfq-workflow";
export const rfqVersion = "a".repeat(64);
export const rfqQuote: RfqQuoteEvidence = { pricing: { basis: "per_piece", quantityPieces: 3, unitCostMills: 2900 },
  packagingTreatment: "separate", packagingCostCents: 0, quoteReference: "QUOTE-1", quoteValidUntil: null,
  quotedAt: "2026-10-20T12:00:00.000Z", leadTimeDays: null, reason: "Confirmed vendor quote" };
const rules = { vendorProductId: 20, minimumOrderPieces: 1, piecesPerPurchaseUom: 1, packSize: 1 };
export function rfqWorkflow(): RfqWorkflowDetail {
  return { id: 42, rfqNumber: "RFQ-42", vendorId: 2, currency: "USD", status: "draft", version: rfqVersion,
    lines: [{ id: 9, status: "draft", productId: 3, productVariantId: null, warehouseId: 1, vendorProductId: 20,
      sku: "TEST-SKU", productName: "Test product", requestedPieces: 3,
      quantityReview: reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces: 3 }), latestQuote: null, purchaseOrder: null }] };
}
export const rfqIntents: RfqCommandIntent[] = [
  { operation: "capture_quote", rfqId: 42, lineId: 9, payload: { expectedVersion: rfqVersion, quote: rfqQuote } },
  { operation: "release", rfqId: 42, payload: { expectedVersion: rfqVersion, reason: "Supplier unavailable" } },
  { operation: "convert", rfqId: 42, payload: { expectedVersion: rfqVersion, lines: [{ rfqLineId: 9, quoteRevisionId: 7 }], quantityOverrideReason: null } },
];
export function rfqReceipt(intent: RfqCommandIntent): RfqCommandReceipt {
  if (intent.operation === "convert") return { version: 1, actorId: "operator-a", idempotencyKey: "rfq-request-1", intent,
    result: { rfqId: 42, purchaseOrderId: 71, poNumber: "PO-71", status: "draft", lines: [{ rfqLineId: 9, quoteRevisionId: 7, purchaseOrderLineId: 72 }] } };
  const result = rfqWorkflow(); result.version = "b".repeat(64);
  result.status = intent.operation === "release" ? "cancelled" : "quoted";
  result.lines[0].status = result.status;
  if (intent.operation === "capture_quote") result.lines[0].latestQuote = { id: 7, rfqLineId: 9, revision: 1,
    fingerprint: "c".repeat(64), currency: "USD", quotedPieces: 3, quotedUnitCostMills: 2900, productTotalMills: 8700,
    pricingRemainderMills: 0, quote: rfqQuote, createdBy: "operator-a", createdAt: "2026-10-20T13:00:00.000Z" };
  return { version: 1, actorId: "operator-a", idempotencyKey: "rfq-request-1", intent, result };
}
