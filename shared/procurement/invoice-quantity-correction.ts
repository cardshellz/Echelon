import { z } from "zod";

export const invoiceQuantityIdSchema = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative().safe();
const money = z.number().int().nonnegative().safe();
const version = z.string().regex(/^[a-f0-9]{64}$/);
const match = z.enum(["pending", "matched", "po_line_missing", "price_discrepancy", "qty_discrepancy", "over_billed"]);
const amountPerPiece = z.string().regex(/^\d+\.\d{6}$/);

export const invoiceQuantityPreviewRequestSchema = z.object({
  sourceVersion: version,
  quantityPieces: invoiceQuantityIdSchema,
}).strict();
export const invoiceQuantityApprovalRequestSchema = invoiceQuantityPreviewRequestSchema.extend({
  reason: z.string().trim().min(10).max(2000),
  approvalConfirmed: z.literal(true),
}).strict();
export const invoiceQuantityPreviewSchema = z.object({
  invoiceId: invoiceQuantityIdSchema,
  invoiceLineId: invoiceQuantityIdSchema,
  purchaseOrderId: invoiceQuantityIdSchema,
  sourceVersion: version,
  beforeQuantity: invoiceQuantityIdSchema,
  afterQuantity: invoiceQuantityIdSchema,
  orderedQuantity: count,
  receivedQuantity: count,
  otherInvoicedQuantity: count,
  invoiceLineAmountCents: money,
  invoiceAmountCents: money,
  paidAmountCents: money,
  balanceCents: money,
  recordedUnitCostMills: money,
  beforeAmountPerPiece: amountPerPiece,
  afterAmountPerPiece: amountPerPiece,
  beforeMatch: match,
  afterMatch: match,
  remainingIssues: z.array(z.object({ invoiceId: invoiceQuantityIdSchema, lineId: invoiceQuantityIdSchema, status: match }).strict()),
  warnings: z.array(z.string()),
}).strict();
export const invoiceQuantityContextSchema = z.object({
  invoiceId: invoiceQuantityIdSchema,
  invoiceLineId: invoiceQuantityIdSchema,
  purchaseOrderId: invoiceQuantityIdSchema,
  lineNumber: invoiceQuantityIdSchema,
  name: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  sourceVersion: version,
  canApprove: z.boolean(),
  blockedReason: z.string().nullable(),
  suggestedQuantity: invoiceQuantityIdSchema.nullable(),
  suggestionReason: z.string(),
  current: invoiceQuantityPreviewSchema,
  suggested: invoiceQuantityPreviewSchema.nullable(),
}).strict();
export const invoiceQuantityResultSchema = z.object({
  invoiceLineId: invoiceQuantityIdSchema,
  auditEventId: z.number().int().positive().safe(),
  preview: invoiceQuantityPreviewSchema,
}).strict();
export type InvoiceQuantityPreviewRequest = z.infer<typeof invoiceQuantityPreviewRequestSchema>;
export type InvoiceQuantityApprovalRequest = z.infer<typeof invoiceQuantityApprovalRequestSchema>;
export type InvoiceQuantityPreview = z.infer<typeof invoiceQuantityPreviewSchema>;
export type InvoiceQuantityContext = z.infer<typeof invoiceQuantityContextSchema>;
export type InvoiceQuantityResult = z.infer<typeof invoiceQuantityResultSchema>;

/** Display-only average of the complete line amount, not an asserted product price.
 * Six decimal places use integer half-up rounding; no ledger price is rewritten. */
export function invoiceAmountPerPiece(amountCents: number, quantity: number): string {
  money.parse(amountCents);
  invoiceQuantityIdSchema.parse(quantity);
  const divisor = BigInt(quantity);
  const micros = (BigInt(amountCents) * BigInt(10000) + divisor / BigInt(2)) / divisor;
  return `${micros / BigInt(1000000)}.${String(micros % BigInt(1000000)).padStart(6, "0")}`;
}
