import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
export const shipmentCostBillingOwnershipSchema = z.object({
  state: z.enum(["unbilled", "billed", "voided", "review_required"]),
  activeInvoiceId: id.nullable(),
  activeInvoiceLineId: id.nullable(),
  activeInvoiceLineIds: z.array(id),
  referencedInvoiceIds: z.array(id),
  issueCode: z.string().min(1).nullable(),
  message: z.string().min(1),
  canCreateInvoice: z.boolean(),
  canUnlink: z.boolean(),
  canLinkExistingLine: z.boolean(),
}).superRefine((value, context) => {
  const associationOnly = value.state === "review_required" && value.issueCode === "AP_SHIPMENT_BILLING_LINE_REQUIRED";
  if ((value.state === "billed") !== (value.activeInvoiceId !== null && value.activeInvoiceLineIds.length > 0)
    || (value.state !== "billed" && (value.activeInvoiceId !== null || value.activeInvoiceLineId !== null || value.activeInvoiceLineIds.length > 0))
    || value.activeInvoiceLineId !== (value.activeInvoiceLineIds.length === 1 ? value.activeInvoiceLineIds[0] : null)
    || new Set(value.activeInvoiceLineIds).size !== value.activeInvoiceLineIds.length
    || value.canCreateInvoice !== (value.state === "unbilled")
    || value.canUnlink
    || value.canLinkExistingLine !== (value.state === "unbilled" || associationOnly)
    || (value.state === "review_required") !== (value.issueCode !== null)
    || new Set(value.referencedInvoiceIds).size !== value.referencedInvoiceIds.length
    || (value.state === "unbilled" && value.referencedInvoiceIds.length !== 0)
    || (value.state === "billed" && !value.referencedInvoiceIds.includes(value.activeInvoiceId!))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Billing ownership capabilities disagree with their recorded state." });
  }
});
export type ShipmentCostBillingOwnership = z.infer<typeof shipmentCostBillingOwnershipSchema>;

export const invoiceSourceCapabilitySchema = z.object({ allowed: z.boolean(),
  code: z.enum(["AP_INVOICE_SOURCE_VERIFIED", "AP_INVOICE_SHIPMENT_SOURCE_OWNED", "AP_INVOICE_BILLING_REVIEW_REQUIRED"]), reason: z.string().min(1) })
  .refine(value => value.allowed === (value.code === "AP_INVOICE_SOURCE_VERIFIED"), "Invoice source capability disagrees with its evidence code.");
export const invoiceSourceCapabilitiesSchema = z.object({
  purchaseOrderLinks: invoiceSourceCapabilitySchema,
  approval: invoiceSourceCapabilitySchema,
  payment: invoiceSourceCapabilitySchema,
  freightSourceLineIds: z.array(id).refine(ids => new Set(ids).size === ids.length, "Freight source line IDs must be unique."),
});
export type InvoiceSourceCapabilities = z.infer<typeof invoiceSourceCapabilitiesSchema>;