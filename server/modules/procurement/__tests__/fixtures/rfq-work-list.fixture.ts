import type { RfqWorkListHeader, RfqWorkListLine } from "@shared/procurement/rfq-work-list";
import type { RfqHandoffLinkEvidence } from "../../domain/rfq-work-list";
export function rfqListHeader(overrides: Partial<RfqWorkListHeader> = {}): RfqWorkListHeader {
  return { id: 42, rfqNumber: "RFQ-2026-0042", status: "draft", vendorId: 7, vendorName: "Supply Co", requestNote: null,
    currency: "USD", responseDueDate: "2026-07-30", createdBy: "buyer-17", createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z", sentAt: null, respondedAt: null, cancelledAt: null, ...overrides };
}
export function rfqListLine(overrides: Partial<RfqWorkListLine> = {}): RfqWorkListLine {
  return { id: 501, rfqId: 42, recommendationLineId: 11, recommendationRunId: 3, vendorProductId: 44, vendorSku: "SUP-302",
    sku: "SKU-RED", productName: "Red Card Shell", status: "draft", requestedPieces: 96, recommendedPieces: 96,
    purchaseUom: null, piecesPerPurchaseUom: null, quantityOverrideReason: null, allocationOverrideReason: null,
    allocationOverrideApprovedBy: null, allocationOverrideApprovedAt: null, allocationOverrideBaselinePieces: null,
    allocationOverrideExcessPieces: null, quotedPieces: null, quotedUnitCostMills: null, quoteReference: null,
    quoteValidUntil: null, quotedAt: null, ...overrides };
}
export function rfqListLink(overrides: Partial<RfqHandoffLinkEvidence> = {}): RfqHandoffLinkEvidence {
  return { id: 1, rfqId: 42, rfqLineId: 501, quoteRevisionId: 8, purchaseOrderId: 19, purchaseOrderLineId: 29,
    actualRfqId: 42, quoteRfqId: 42, quoteRfqLineId: 501, quoteCurrency: "USD", actualPurchaseOrderId: 19,
    purchaseOrderVendorId: 7, poNumber: "PO-19", purchaseOrderStatus: "draft", ...overrides };
}
