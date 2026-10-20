import { z } from "zod";
import type { ShipmentCostBillingOwnership } from "@shared/procurement/shipment-billing-ownership";

const id = z.number().int().positive().max(2_147_483_647);
export const billingCostEvidenceSchema = z.object({
  id, shipmentId: id, vendorId: id.nullable(), invoiceId: id.nullable(), currency: z.string().nullable(),amountCents:z.number().int().safe().optional(),
});
export const billingInvoiceEvidenceSchema = z.object({
  id, vendorId: id, shipmentId: id.nullable(), currency: z.string(), status: z.string(),
  invoiceNumber: z.string(), replacesInvoiceId: id.nullable(), hasProductSources: z.boolean().optional().default(false),
});
export const billingLineEvidenceSchema = z.object({
  id, invoiceId: id, freightCostId: id, purchaseOrderLineId: id.nullable(), productVariantId: id.nullable(),
});
export type BillingCostEvidence = z.infer<typeof billingCostEvidenceSchema>;
export type BillingInvoiceEvidence = z.infer<typeof billingInvoiceEvidenceSchema>;
export type BillingLineEvidence = z.infer<typeof billingLineEvidenceSchema>;
const evidenceSchema = z.object({ cost: billingCostEvidenceSchema, invoices: z.array(billingInvoiceEvidenceSchema), lines: z.array(billingLineEvidenceSchema) });
const activeStatuses = new Set(["draft", "received", "approved", "disputed", "partially_paid", "paid"]);

/** Billing ownership is distinct from approved cost or payment allocation. Never
 * infer an owner by summing matching amounts or selecting the latest document. */
export function resolveShipmentBillingOwnership(input: unknown): ShipmentCostBillingOwnership {
  const parsed = evidenceSchema.safeParse(input);
  const invoiceIds = parsed.success ? [...new Set([
    ...(parsed.data.cost.invoiceId === null ? [] : [parsed.data.cost.invoiceId]),
    ...parsed.data.lines.filter(line => line.freightCostId === parsed.data.cost.id).map(line => line.invoiceId),
  ])].sort((a, b) => a - b) : [];
  const base = { activeInvoiceId: null, activeInvoiceLineId: null, activeInvoiceLineIds: [], referencedInvoiceIds: invoiceIds,
    canCreateInvoice: false, canUnlink: false, canLinkExistingLine: false };
  const review = (code: string, message: string): ShipmentCostBillingOwnership => ({ ...base, state: "review_required", issueCode: code, message });
  if (!parsed.success) return review("AP_SHIPMENT_BILLING_EVIDENCE_INVALID", "Shipment billing evidence is incomplete or invalid. Review the original invoice and charge records.");
  const { cost, invoices } = parsed.data;
  // AP documents currently post USD only. A historical missing or foreign
  // currency cannot be silently relabeled USD when the invoice is created.
  if (cost.currency !== "USD") return review("AP_SHIPMENT_BILLING_CURRENCY_UNSUPPORTED", "This charge does not have supported USD billing evidence. Review its recorded currency before invoicing or payment.");
  const lines = parsed.data.lines.filter(line => line.freightCostId === cost.id);
  if (lines.length === 0 && cost.invoiceId === null && cost.amountCents !== undefined && cost.amountCents < 0) return review("AP_SUPPLIER_CREDIT_DOCUMENT_REQUIRED","A negative charge requires an explicit supplier credit against its original invoice; it cannot create a negative payable.");
  if (lines.length === 0 && cost.invoiceId === null) return { ...base, state: "unbilled", issueCode: null,
    message: "This charge has no recorded invoice ownership.", canCreateInvoice: true, canLinkExistingLine: true };
  if (lines.length === 0) return { ...review("AP_SHIPMENT_BILLING_LINE_REQUIRED", "The invoice association has no recorded charge line. Select its exact invoice line before approval or payment."),
    canLinkExistingLine: true };
  const headers = new Map(invoices.map(invoice => [invoice.id, invoice]));
  if (headers.size !== invoices.length || invoiceIds.some(invoiceId => !headers.has(invoiceId))) {
    return review("AP_SHIPMENT_BILLING_DOCUMENT_MISSING", "Shipment billing references a missing or duplicate invoice document.");
  }
  const owners = [...new Set(lines.map(line => line.invoiceId))];
  if (lines.some(line => line.purchaseOrderLineId !== null || line.productVariantId !== null)
    || owners.some(invoiceId => {
      const invoice = headers.get(invoiceId)!;
      return invoice.hasProductSources || invoice.vendorId !== cost.vendorId || invoice.shipmentId !== cost.shipmentId || invoice.currency !== cost.currency
        || (!activeStatuses.has(invoice.status) && invoice.status !== "voided");
    })) return review("AP_SHIPMENT_BILLING_SOURCE_MISMATCH", "Charge and invoice supplier, shipment, currency or source identity disagree.");
  const active = owners.filter(invoiceId => headers.get(invoiceId)!.status !== "voided");
  if (active.length > 1) return review("AP_SHIPMENT_BILLING_MULTIPLE_OWNERS", "More than one active invoice bills this charge. Review the original invoices before continuing.");
  const currentId = active[0] ?? cost.invoiceId;
  if (currentId === null || cost.invoiceId !== currentId || !owners.includes(currentId)) {
    return review("AP_SHIPMENT_BILLING_POINTER_MISMATCH", "The charge's invoice association disagrees with its recorded invoice lines.");
  }
  const current = headers.get(currentId)!;
  const seen = new Set<number>();
  let cursor: BillingInvoiceEvidence | undefined = current;
  while (cursor) {
    if (seen.has(cursor.id) || !owners.includes(cursor.id)
      || (cursor.id !== currentId && cursor.status !== "voided") || cursor.invoiceNumber !== current.invoiceNumber) {
      return review("AP_SHIPMENT_BILLING_REPLACEMENT_REVIEW", "The charge has incomplete or competing invoice replacement history.");
    }
    seen.add(cursor.id);
    if (cursor.replacesInvoiceId === null) break;
    cursor = headers.get(cursor.replacesInvoiceId);
    if (!cursor) return review("AP_SHIPMENT_BILLING_REPLACEMENT_REVIEW", "The charge's invoice replacement predecessor is missing.");
  }
  if (seen.size !== owners.length) return review("AP_SHIPMENT_BILLING_REPLACEMENT_REVIEW", "Historical charge invoices are not an explicit replacement chain.");
  if (active.length === 0) return { ...base, state: "voided", issueCode: null,
    message: "The source invoice is voided. Use its reviewed replacement workflow; the charge remains historical evidence." };
  const activeInvoiceLineIds = lines.filter(line => line.invoiceId === currentId).map(line => line.id).sort((a, b) => a - b);
  if (new Set(activeInvoiceLineIds).size !== activeInvoiceLineIds.length) return review("AP_SHIPMENT_BILLING_EVIDENCE_INVALID", "Invoice source line identities are duplicated.");
  return { ...base, state: "billed", activeInvoiceId: currentId, activeInvoiceLineIds,
    activeInvoiceLineId: activeInvoiceLineIds.length === 1 ? activeInvoiceLineIds[0] : null, issueCode: null,
    message: "One invoice owns this charge; retained predecessor lines are historical evidence." };
}