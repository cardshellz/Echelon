import { z } from "zod";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import { freightInvoiceIdSchema, type FreightInvoiceCharge } from "@shared/procurement/freight-invoice-costs";
import { invoiceSourceCapabilitiesSchema } from "@shared/procurement/shipment-billing-ownership";

const id = freightInvoiceIdSchema;
const cents = z.number().int().nonnegative().safe();
export const freightInvoiceFactsSchema = z.object({
  invoice: z.object({
    id, number: z.string(), vendorId: id, shipmentId: id.nullable(), currency: z.string(), status: z.string(),
    amountCents: cents, paidCents: cents, balanceCents: z.number().int().safe(),
  }).strict(),
  lines: z.array(z.object({
    id, freightCostId: id.nullable(), purchaseOrderLineId: id.nullable(), productVariantId: id.nullable(),
    quantity: z.number().int().positive().safe(), unitMills: cents, amountCents: cents,
  }).strict()).min(1).max(1000),
  charges: z.array(z.object({
    id, shipmentId: id, vendorId: id.nullable(), invoiceId: id.nullable(), currency: z.string().nullable(),
    label: z.string(), estimatedCents: cents.nullable(), actualCents: cents.nullable(),
  }).strict()).min(1).max(500),
  capabilities: invoiceSourceCapabilitiesSchema,
  hasCreditHistory: z.boolean(),
  hasPurchaseOrderLinks: z.boolean(),
}).strict();
export type FreightInvoiceFacts = z.infer<typeof freightInvoiceFactsSchema>;
export class FreightInvoiceCostError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) {
    super(message); this.name = "FreightInvoiceCostError";
  }
}
function reject(message: string, code: string): never {
  throw new FreightInvoiceCostError(message, code);
}
/** Accept only the invoice's explicit charge links. Quantity/unit-price checks
 * follow the existing AP cent rounding rule; no header remainder is invented. */
export function planFreightInvoiceCosts(value: unknown): { charges: FreightInvoiceCharge[]; requiresChange: boolean } {
  const parsed = freightInvoiceFactsSchema.safeParse(value);
  if (!parsed.success) return reject("The complete invoice and shipment charge evidence is invalid. Review the source records.", "FREIGHT_INVOICE_EVIDENCE_INVALID");
  const { invoice, lines, charges, capabilities, hasCreditHistory, hasPurchaseOrderLinks } = parsed.data;
  if (invoice.currency !== "USD" || charges.some(charge => charge.currency !== "USD"))
    return reject("This review requires explicit USD invoice and charge amounts. No currency conversion will be guessed.", "FREIGHT_INVOICE_CURRENCY_REVIEW");
  if (!["received", "disputed", "approved", "partially_paid", "paid"].includes(invoice.status))
    return reject("Receive the invoice before reviewing its shipment costs. Voided invoices require their replacement workflow.", "FREIGHT_INVOICE_STATUS_REVIEW");
  if (hasCreditHistory) return reject("This invoice has supplier credits. Review their original charge allocations before changing its cost authority.", "FREIGHT_INVOICE_CREDIT_REVIEW");
  if (hasPurchaseOrderLinks) return reject("This shipment invoice also has manual PO billing links. Review that mixed billing scope before replacing its charge amounts.", "FREIGHT_INVOICE_SCOPE_REVIEW");
  if (!capabilities.approval.allowed) return reject(capabilities.approval.reason, "FREIGHT_INVOICE_OWNERSHIP_REVIEW");
  if (invoice.shipmentId === null || lines.some(line => line.freightCostId === null || line.purchaseOrderLineId !== null || line.productVariantId !== null))
    return reject("This review requires shipment-charge lines only. Mixed product bills or unassigned header amounts need their owning source review.", "FREIGHT_INVOICE_SCOPE_REVIEW");
  if (new Set(lines.map(line => line.id)).size !== lines.length || new Set(charges.map(charge => charge.id)).size !== charges.length)
    return reject("Invoice or charge identities are duplicated.", "FREIGHT_INVOICE_EVIDENCE_INVALID");
  const verifiedLineIds = new Set(capabilities.freightSourceLineIds);
  if (verifiedLineIds.size !== lines.length || capabilities.freightSourceLineIds.length !== verifiedLineIds.size
    || lines.some(line => !verifiedLineIds.has(line.id)))
    return reject("The AP ownership check does not cover the complete invoice line set.", "FREIGHT_INVOICE_OWNERSHIP_REVIEW");
  if (charges.some(charge => charge.invoiceId !== invoice.id || charge.vendorId !== invoice.vendorId || charge.shipmentId !== invoice.shipmentId))
    return reject("The invoice and shipment charge supplier or source identities disagree.", "FREIGHT_INVOICE_OWNERSHIP_REVIEW");
  const chargeIds = new Set(charges.map(charge => charge.id));
  if (lines.some(line => !chargeIds.has(line.freightCostId!)) || charges.some(charge => !lines.some(line => line.freightCostId === charge.id)))
    return reject("Every invoice line must identify its exact shipment charge, and every associated charge needs a line.", "FREIGHT_INVOICE_SCOPE_REVIEW");
  const total = lines.reduce((sum, line) => {
    const extended = (BigInt(readIntegerMills(line.unitMills)) * BigInt(line.quantity) + BigInt(50)) / BigInt(100);
    if (extended !== BigInt(line.amountCents)) return reject("Invoice quantity, unit price and line amount do not reconcile.", "FREIGHT_INVOICE_TOTAL_REVIEW");
    return sum + BigInt(line.amountCents);
  }, BigInt(0));
  if (total !== BigInt(invoice.amountCents)) return reject("The invoice total must equal its explicit charge lines. Classify any remaining amount first.", "FREIGHT_INVOICE_TOTAL_REVIEW");
  const result = charges.map(charge => ({
    chargeId: charge.id, shipmentId: charge.shipmentId, label: charge.label,
    estimatedCents: charge.estimatedCents, actualCents: charge.actualCents,
    invoiceCents: readIntegerCents(lines.filter(line => line.freightCostId === charge.id).reduce((sum, line) => sum + BigInt(line.amountCents), BigInt(0))),
  })).sort((left, right) => left.chargeId - right.chargeId);
  return { charges: result, requiresChange: !["approved", "partially_paid", "paid"].includes(invoice.status)
    || result.some(charge => charge.actualCents !== charge.invoiceCents) };
}
