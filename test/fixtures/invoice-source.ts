import type { InvoiceSourceCapabilities, ShipmentCostBillingOwnership } from "../../shared/procurement/shipment-billing-ownership";
export function invoiceSourceFixture(kind: "ordinary" | "shipment" | "review" = "ordinary"): InvoiceSourceCapabilities {
  const verified = { allowed: true, code: "AP_INVOICE_SOURCE_VERIFIED" as const, reason: "Invoice source evidence is verified." };
  const review = { allowed: false, code: "AP_INVOICE_BILLING_REVIEW_REQUIRED" as const, reason: "Shipment charge ownership needs review before approval or payment." };
  return { purchaseOrderLinks: kind === "ordinary" ? verified : { allowed: false, code: "AP_INVOICE_SHIPMENT_SOURCE_OWNED", reason: "Shipment charge invoices cannot import or remove purchase order lines." }, approval: kind === "review" ? review : verified, payment: kind === "review" ? review : verified, freightSourceLineIds: kind === "ordinary" ? [] : [51] };
}
export function unbilledOwnershipFixture(): ShipmentCostBillingOwnership {
  return { state: "unbilled", activeInvoiceId: null, activeInvoiceLineId: null, activeInvoiceLineIds: [], referencedInvoiceIds: [], issueCode: null, message: "This charge has no invoice source.", canCreateInvoice: true, canUnlink: false, canLinkExistingLine: true };
}
export function voidedOwnershipFixture(invoiceId = 71): ShipmentCostBillingOwnership {
  return { ...unbilledOwnershipFixture(), state: "voided", referencedInvoiceIds: [invoiceId], canCreateInvoice: false, canLinkExistingLine: false, message: "The original invoice is voided; review replacement." };
}
