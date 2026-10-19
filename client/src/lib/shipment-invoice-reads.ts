import { z } from "zod";
import { shipmentCostBillingOwnershipSchema } from "@shared/procurement/shipment-billing-ownership";

const id = z.number().int().positive().max(2_147_483_647);
const money = z.number().int().safe();
export const shipmentInvoiceVendorsSchema = z.object({ vendors: z.array(z.object({
  vendorId: id, vendorName: z.string().min(1), unbilledCostCount: z.number().int().positive(), unbilledTotalCents: money,
})) }).superRefine(({ vendors }, context) => {
  if (new Set(vendors.map(row => row.vendorId)).size !== vendors.length) context.addIssue({ code: "custom", message: "Duplicate invoice suppliers." });
});
export const shipmentInvoiceCostsSchema = z.object({ costs: z.array(z.object({
  id, inboundShipmentId: id, vendorId: id, costType: z.string().min(1), description: z.string().nullable(),
  performedByName: z.string().nullable(), actualCents: money.nullable(), estimatedCents: money.nullable(),
  billingOwnership: shipmentCostBillingOwnershipSchema,
}).passthrough()) });
export function parseShipmentInvoiceCosts(raw: unknown, shipmentId: number, vendorId: number) {
  const parsed = shipmentInvoiceCostsSchema.parse(raw);
  if (new Set(parsed.costs.map(cost => cost.id)).size !== parsed.costs.length || parsed.costs.some(cost =>
    cost.inboundShipmentId !== shipmentId || cost.vendorId !== vendorId || !cost.billingOwnership.canCreateInvoice
    || cost.billingOwnership.state !== "unbilled" || cost.actualCents === null && cost.estimatedCents === null)) {
    throw new Error("The selected shipment charges no longer have verified unbilled ownership. Reload the charges.");
  }
  return parsed;
}
const invoiceSchema = z.object({
  id, inboundShipmentId: id, invoiceNumber: z.string().min(1), vendorName: z.string().nullable(),
  status: z.enum(["draft", "received", "approved", "partially_paid", "paid", "disputed", "voided"]),
  currency: z.string().regex(/^[A-Z]{3}$/), invoiceDate: z.string().datetime({ offset: true }).nullable(),
  invoicedAmountCents: money, paidAmountCents: money.nonnegative(),
}).passthrough();
export const shipmentInvoicesSchema = z.object({ invoices: z.array(invoiceSchema), summary: z.object({
  totalInvoicedCents: money, totalPaidCents: money.nonnegative(), outstandingCents: money.nonnegative(),
  invoiceCount: z.number().int().nonnegative(), activeInvoiceCount: z.number().int().nonnegative(),
}) });
export function parseShipmentInvoices(raw: unknown, shipmentId: number) {
  const parsed = shipmentInvoicesSchema.parse(raw);
  if (parsed.invoices.some(invoice => invoice.inboundShipmentId !== shipmentId) || new Set(parsed.invoices.map(invoice => invoice.id)).size !== parsed.invoices.length
    || parsed.summary.invoiceCount !== parsed.invoices.length || parsed.summary.activeInvoiceCount !== parsed.invoices.filter(invoice => invoice.status !== "voided").length) {
    throw new Error("Shipment invoice ownership could not be verified. Reload the invoice list.");
  }
  return parsed;
}
