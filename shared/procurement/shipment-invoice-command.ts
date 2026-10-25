import { z } from "zod";
import { centsToMills, millsToCents, computeLineTotalCentsFromMills } from "../utils/money";

export const shipmentInvoiceIdSchema = z.number().int().min(1).max(2_147_483_647);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !value.startsWith("0000-") && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date");
// Keep the existing timestamp contract compatible. The separate payment-date
// workstream owns any broader change to accounting calendar-date semantics.
const date = z.union([dateOnly, z.string().datetime({ offset: true })]);
const override = z.object({
  freightCostId: shipmentInvoiceIdSchema,
  qtyInvoiced: shipmentInvoiceIdSchema,
  unitCostCents: cents.optional(),
  unitCostMills: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  description: z.string().trim().max(10_000).optional(),
}).strict().refine(value => value.unitCostCents !== undefined || value.unitCostMills !== undefined,
  "An overridden line requires an exact unit cost").superRefine((line, context) => {
  try {
    const mills = line.unitCostMills ?? centsToMills(line.unitCostCents!);
    if (line.unitCostCents !== undefined && millsToCents(mills) !== line.unitCostCents) {
      context.addIssue({ code: "custom", message: "Unit cents and mills must describe the same price" });
    }
    computeLineTotalCentsFromMills(mills, line.qtyInvoiced);
  } catch {
    context.addIssue({ code: "custom", message: "The line amount exceeds the supported exact money range" });
  }
});

export const createShipmentInvoiceCommandSchema = z.object({
  vendorId: shipmentInvoiceIdSchema,
  invoiceNumber: z.string().trim().min(1).max(100),
  invoiceDate: date.optional(),
  dueDate: date.optional(),
  // An explicit selection makes a saved retry stable when new charges appear.
  costRowIds: z.array(shipmentInvoiceIdSchema).min(1),
  lineOverrides: z.array(override).optional(),
  notes: z.string().trim().max(10_000).optional(),
}).strict().superRefine((value, context) => {
  const ids = new Set(value.costRowIds);
  if (ids.size !== value.costRowIds.length) context.addIssue({ code: "custom", path: ["costRowIds"], message: "Choose each charge once" });
  const overridden = new Set<number>();
  for (const [index, line] of (value.lineOverrides ?? []).entries()) {
    if (!ids.has(line.freightCostId) || overridden.has(line.freightCostId)) context.addIssue({ code: "custom", path: ["lineOverrides", index], message: "Overrides must reference distinct selected charges" });
    overridden.add(line.freightCostId);
  }
});

const identity = {
  shipmentId: shipmentInvoiceIdSchema,
  actorId: z.string().min(1).max(100),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/),
};
// The legacy flat invoice fields remain in the response. These fields establish
// the exact identity required before a client may clear saved recovery intent.
export const shipmentInvoiceCommandResponseSchema = z.object({
  ...identity,
  id: shipmentInvoiceIdSchema,
  invoiceId: shipmentInvoiceIdSchema,
  inboundShipmentId: shipmentInvoiceIdSchema,
  vendorId: shipmentInvoiceIdSchema,
  invoiceNumber: z.string().trim().min(1).max(100),
  costRowIds: z.array(shipmentInvoiceIdSchema).min(1),
  totalCents: cents,
  currency: z.literal("USD"),
}).passthrough().superRefine((value, context) => {
  if (value.id !== value.invoiceId || value.shipmentId !== value.inboundShipmentId
    || new Set(value.costRowIds).size !== value.costRowIds.length) context.addIssue({ code: "custom", message: "Invoice creation identity is inconsistent" });
});
export const shipmentInvoiceCommandRejectionSchema = z.object({
  ...identity,
  code: z.string().min(1), error: z.string().min(1), commandOutcome: z.literal("rejected"),
}).passthrough();
export type CreateShipmentInvoiceCommandInput = z.infer<typeof createShipmentInvoiceCommandSchema>;
export type ShipmentInvoiceCommandResponse = z.infer<typeof shipmentInvoiceCommandResponseSchema>;

/** For a validated, fully explicit selection, derive the exact reviewed total
 * using the same line rounding rule as the invoice owner. Sparse legacy inputs
 * do not establish an expected total; never invent their missing amounts. */
export function expectedShipmentInvoiceTotal(input: CreateShipmentInvoiceCommandInput): bigint | null {
  const lines = input.lineOverrides ?? [];
  if (lines.length !== input.costRowIds.length) return null;
  return lines.reduce((sum, line) => sum + BigInt(computeLineTotalCentsFromMills(
    line.unitCostMills ?? centsToMills(line.unitCostCents!), line.qtyInvoiced,
  )), BigInt(0));
}
