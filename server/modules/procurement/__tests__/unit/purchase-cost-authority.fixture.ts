import type { PurchaseCostAmount, PurchaseCostAuthorityInput, PurchaseCostInvoice } from "@shared/procurement/purchase-cost-authority";

export function authorityAmount(goodsMills: number, productMills: number | null = null): PurchaseCostAmount {
  return { documentTotalMills: goodsMills, goodsMills,
    breakdown: productMills === null ? null : { productMills, packagingMills: goodsMills - productMills }, adjustments: [] };
}

export function authorityInvoice(pieces = 100, goodsMills = 12_000_000): PurchaseCostInvoice {
  return { reference: { kind: "vendor_invoice_line", documentId: 20, lineId: 2 }, purchaseOrderLineId: 1,
    currency: "USD", pieces, status: "approved", amount: authorityAmount(goodsMills), receiptCoverage: null,
    sourceRevisionId: 8, approval: { actorId: "synthetic-admin", recordedAt: "2026-10-30T12:00:00Z", reference: "invoice:20:approval" } };
}

export function authorityInput(): PurchaseCostAuthorityInput {
  return { contractVersion: 1, scope: { purchaseOrderId: 10, purchaseOrderLineId: 1, currency: "USD", basePieces: 100 },
    quote: { reference: { kind: "purchase_order_line", documentId: 10, lineId: 1 }, basePieces: 100,
      amount: authorityAmount(10_000_000, 9_000_000), sourceRevisionId: 7, approval: null },
    invoices: [], shipmentCostCoverage: "not_applicable", shipmentShares: [], receiptAllocationPolicy: "unresolved", application: null };
}

export function authorityFreight(): PurchaseCostAuthorityInput["shipmentShares"][number] {
  return { shipmentId: 50, shipmentLineId: 30, chargeId: 40, category: "freight",
    reference: { kind: "shipment_cost", documentId: 50, lineId: 40 }, currency: "USD",
    sourceAmountMills: 2_000_000, allocatedMills: 2_000_000, allocationSourceAmountMills: 2_000_000,
    evidence: "confirmed", sourceRevisionId: 9, approval: null };
}
