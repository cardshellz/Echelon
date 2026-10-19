import type { InboundFreightCost, InboundShipment, VendorInvoice, VendorInvoiceLine, VendorInvoicePoLink } from "@shared/schema";
import { invoiceReplacementCapabilitySchema, type InvoiceReplacementCapability } from "@shared/procurement/invoice-replacement";

export interface InvoiceReplacementSource {
  readonly invoice: Pick<VendorInvoice, "id" | "status" | "paidAmountCents" | "inboundShipmentId" | "currency" | "invoiceNumber" | "invoicedAmountCents" | "balanceCents" | "vendorId">;
  readonly lines: readonly Pick<VendorInvoiceLine, "id" | "freightCostId" | "purchaseOrderLineId" | "productVariantId" | "unitCostMills" | "unitCostCents" | "qtyInvoiced" | "lineTotalCents">[];
  readonly costs: readonly Pick<InboundFreightCost, "id" | "vendorInvoiceId" | "vendorId" | "inboundShipmentId" | "currency" | "actualCents" | "estimatedCents">[];
  readonly links: readonly Pick<VendorInvoicePoLink, "purchaseOrderId" | "allocatedAmountCents">[];
  readonly paymentHistory: readonly { readonly id: number }[];
  readonly successorInvoiceId: number | null;
  readonly shipment: Pick<InboundShipment, "status"> | null;
  readonly shipmentPoIds: readonly number[];
}
const safeMoney = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;

/** No policy is inferred from money alone: the complete original footprint must agree. */
export function evaluateInvoiceReplacement(source: InvoiceReplacementSource, expectedVersion: string): InvoiceReplacementCapability {
  const { invoice, lines, costs, links } = source;
  const result = (code: string | null, message: string): InvoiceReplacementCapability => invoiceReplacementCapabilitySchema.parse({
    allowed: code === null, code, message, expectedVersion, successorInvoiceId: source.successorInvoiceId,
  });
  if (source.successorInvoiceId !== null) return result("AP_INVOICE_REPLACEMENT_EXISTS", "This document already has a replacement. Open its successor to continue.");
  if (invoice.status !== "voided") return result("AP_INVOICE_REPLACEMENT_NOT_VOIDED", "Only a voided shipment invoice can be replaced.");
  if (!safeMoney(invoice.paidAmountCents) || invoice.paidAmountCents !== 0 || source.paymentHistory.length > 0) {
    return result("AP_INVOICE_REPLACEMENT_PAYMENT_HISTORY", "This invoice has payment history or invalid paid amounts. Accounting review is required; this replacement action cannot recover it.");
  }
  if (invoice.inboundShipmentId === null || !source.shipment || source.shipment.status === "cancelled") {
    return result("AP_INVOICE_REPLACEMENT_SHIPMENT_REVIEW", "Replacement requires the original, non-cancelled shipment.");
  }
  if (invoice.currency !== "USD" || !invoice.invoiceNumber.trim() || !safeMoney(invoice.invoicedAmountCents)
    || invoice.balanceCents !== invoice.invoicedAmountCents) {
    return result("AP_INVOICE_REPLACEMENT_TOTAL_REVIEW", "The original invoice currency, total or unpaid balance needs accounting review.");
  }
  if (lines.length === 0 || lines.some(line => line.freightCostId === null || line.purchaseOrderLineId !== null || line.productVariantId !== null)) {
    return result("AP_INVOICE_REPLACEMENT_SOURCE_REVIEW", "Only complete shipment-charge invoices can be replaced here. Product, mixed or unmapped lines need accounting review.");
  }
  const chargeIds = new Set(lines.map(line => line.freightCostId!));
  const sourceLineIds = new Set(lines.map(line => line.id));
  const costsById = new Map(costs.map(cost => [cost.id, cost]));
  if (sourceLineIds.size !== lines.length || costsById.size !== costs.length || costsById.size !== chargeIds.size
    || lines.some(line => !Number.isSafeInteger(line.id) || line.id <= 0 || !Number.isSafeInteger(line.freightCostId) || line.freightCostId! <= 0)
    || costs.some(cost => !chargeIds.has(cost.id) || cost.vendorInvoiceId !== invoice.id || cost.vendorId !== invoice.vendorId
      || cost.inboundShipmentId !== invoice.inboundShipmentId || cost.currency !== invoice.currency)) {
    return result("AP_INVOICE_REPLACEMENT_SOURCE_REVIEW", "Every original line must identify a recorded charge still assigned to this supplier, shipment and invoice; duplicate source records need review.");
  }
  // Several distinct source lines may bill one charge. Preserve those exact
  // lines and reconcile their sum; do not invent or redistribute any amount.
  const totalsByCharge = new Map<number, bigint>(costs.map(cost => [cost.id, BigInt(0)]));
  let total = BigInt(0);
  for (const line of lines) {
    const unitMills = line.unitCostMills === null ? (safeMoney(line.unitCostCents) ? BigInt(line.unitCostCents) * BigInt(100) : null)
      : safeMoney(line.unitCostMills) ? BigInt(line.unitCostMills) : null;
    if (!Number.isSafeInteger(line.qtyInvoiced) || line.qtyInvoiced <= 0 || !safeMoney(line.lineTotalCents) || !safeMoney(line.unitCostCents) || unitMills === null
      || (unitMills + BigInt(50)) / BigInt(100) !== BigInt(line.unitCostCents)
      || (unitMills * BigInt(line.qtyInvoiced) + BigInt(50)) / BigInt(100) !== BigInt(line.lineTotalCents)) {
      return result("AP_INVOICE_REPLACEMENT_TOTAL_REVIEW", "Invoice quantities, prices, totals and current shipment charges must reconcile before replacement.");
    }
    const lineTotal = BigInt(line.lineTotalCents);
    totalsByCharge.set(line.freightCostId!, totalsByCharge.get(line.freightCostId!)! + lineTotal);
    total += lineTotal;
  }
  for (const [costId, charge] of costsById) {
    const chargeAmount = charge.actualCents ?? charge.estimatedCents;
    if (!safeMoney(chargeAmount) || totalsByCharge.get(costId) !== BigInt(chargeAmount)) {
      return result("AP_INVOICE_REPLACEMENT_TOTAL_REVIEW", "The sum of each charge's original invoice lines must reconcile to its recorded shipment amount before replacement.");
    }
  }
  if (total !== BigInt(invoice.invoicedAmountCents)) return result("AP_INVOICE_REPLACEMENT_TOTAL_REVIEW", "Original invoice lines do not reconcile to its recorded total.");
  if (links.some(link => !source.shipmentPoIds.includes(link.purchaseOrderId)
    || (link.allocatedAmountCents !== null && !safeMoney(link.allocatedAmountCents)))
    || links.reduce((sum, link) => sum + BigInt(link.allocatedAmountCents ?? 0), BigInt(0)) > total) {
    return result("AP_INVOICE_REPLACEMENT_PO_LINK_REVIEW", "Original purchase-order links need review before they can be retained on the replacement.");
  }
  return result(null, "Create an editable received replacement with the same supplier number. The original remains voided; ordinary review and approval are still required.");
}
