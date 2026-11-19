import { z } from "zod";

// Bound one review/command and one selection view; oversized inputs fail rather
// than silently truncating the stock that an operator intended to send.
export const STOCK_SEND_MAX_SELECTED_VARIANTS = 250;
export const STOCK_SEND_MAX_PRODUCT_VARIANTS = 1_000;
export const STOCK_SEND_MAX_TARGETS = 1_000;

const id = z.number().int().positive().max(2_147_483_647);
const integer = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19);
const positiveInteger = integer.refine(value => value !== "0", "A positive record identity is required.");
const timestamp = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const variantIds = z.array(id).min(1).max(STOCK_SEND_MAX_SELECTED_VARIANTS).refine(ids => new Set(ids).size === ids.length, "Select each variant only once.");

export const inventoryStockSendContextRequestSchema = z.object({ productId: id, channelId: id.optional() }).strict();
export const inventoryStockSendSelectionSchema = z.object({
  productId: id, publicationTargetId: id, productVariantIds: variantIds,
}).strict();
export const inventoryStockSendRequestSchema = inventoryStockSendSelectionSchema.extend({
  expectedReviewHash: hash, idempotencyKey: z.string().uuid(),
}).strict();
export const inventoryStockSendContextSchema = z.object({
  productId: id, productName: z.string(),
  variants: z.array(z.object({ id, sku: z.string().nullable(), name: z.string(), eligible: z.boolean() }).strict()).max(STOCK_SEND_MAX_PRODUCT_VARIANTS),
  targets: z.array(z.object({
    id, channelId: id, channelName: z.string(), externalScopeId: z.string(), label: z.string(), blockers: z.array(z.string()),
  }).strict()).max(STOCK_SEND_MAX_TARGETS),
  blockers: z.array(z.string()),
}).strict();
const quantity = z.object({ productVariantId: id, sku: z.string().nullable(), quantity: integer,
  externalInventoryItemId: z.string().min(1),
}).strict();
export const inventoryStockSendReviewSchema = inventoryStockSendSelectionSchema.extend({
  reviewHash: hash, ready: z.boolean(), blockers: z.array(z.string()), rows: z.array(quantity).max(STOCK_SEND_MAX_SELECTED_VARIANTS),
}).strict().superRefine((value, context) => {
  if (value.ready && (value.blockers.length > 0 || value.rows.length !== value.productVariantIds.length))
    context.addIssue({ code: "custom", message: "A ready review must cover the complete unblocked selection." });
  if (new Set(value.rows.map(row => row.productVariantId)).size !== value.rows.length
    || value.rows.some(row => !value.productVariantIds.includes(row.productVariantId)))
    context.addIssue({ code: "custom", message: "Review rows must belong to the selected variants exactly once." });
});
export const inventoryStockSendReceiptSchema = inventoryStockSendSelectionSchema.extend({
  idempotencyKey: z.string().uuid(), reviewHash: hash, requestedAt: timestamp, requestedBy: z.string().min(1),
  channelId: id, channelName: z.string(), location: z.string(),
  rows: z.array(quantity.extend({ outboxId: positiveInteger, revision: positiveInteger })).min(1).max(STOCK_SEND_MAX_SELECTED_VARIANTS),
}).strict().superRefine((value, context) => {
  if (value.rows.length !== value.productVariantIds.length || new Set(value.rows.map(row => row.productVariantId)).size !== value.rows.length
    || new Set(value.rows.map(row => row.outboxId)).size !== value.rows.length
    || value.rows.some(row => !value.productVariantIds.includes(row.productVariantId)))
    context.addIssue({ code: "custom", message: "A receipt must contain one delivery record for every selected variant." });
});
export const inventoryStockSendResultSchema = z.object({ receipt: inventoryStockSendReceiptSchema, replayed: z.boolean() }).strict();
export const inventoryStockSendProgressSchema = z.object({
  receipt: inventoryStockSendReceiptSchema,
  rows: z.array(z.object({
    productVariantId: id, outboxId: positiveInteger,
    state: z.enum(["desired", "queued", "leased", "acknowledged", "verified", "drifted", "retryable", "dead_letter", "superseded", "cancelled"]),
    errorCode: z.string().nullable(), errorMessage: z.string().nullable(),
    observedQuantity: integer.nullable(), observedAt: timestamp.nullable(),
  }).strict()).max(STOCK_SEND_MAX_SELECTED_VARIANTS),
}).strict().superRefine((value, context) => {
  if (value.rows.length !== value.receipt.rows.length || new Set(value.rows.map(row => row.outboxId)).size !== value.rows.length
    || value.rows.some(row => !value.receipt.rows.some(expected => expected.outboxId === row.outboxId && expected.productVariantId === row.productVariantId)))
    context.addIssue({ code: "custom", message: "Delivery status must match every exact receipt row." });
});

export type InventoryStockSendContextRequest = z.infer<typeof inventoryStockSendContextRequestSchema>;
export type InventoryStockSendContext = z.infer<typeof inventoryStockSendContextSchema>;
export type InventoryStockSendSelection = z.infer<typeof inventoryStockSendSelectionSchema>;
export type InventoryStockSendRequest = z.infer<typeof inventoryStockSendRequestSchema>;
export type InventoryStockSendReview = z.infer<typeof inventoryStockSendReviewSchema>;
export type InventoryStockSendReceipt = z.infer<typeof inventoryStockSendReceiptSchema>;
export type InventoryStockSendResult = z.infer<typeof inventoryStockSendResultSchema>;
export type InventoryStockSendProgress = z.infer<typeof inventoryStockSendProgressSchema>;

/** Transport order does not change the selected set; neither input is mutated. */
export function matchesStockSendSelection(left: Readonly<Omit<InventoryStockSendSelection, "productVariantIds">> & { productVariantIds: readonly number[] },
  right: Readonly<Omit<InventoryStockSendSelection, "productVariantIds">> & { productVariantIds: readonly number[] }): boolean {
  const ids = [...right.productVariantIds].sort((a, b) => a - b);
  return left.productId === right.productId && left.publicationTargetId === right.publicationTargetId
    && left.productVariantIds.length === ids.length && [...left.productVariantIds].sort((a, b) => a - b).every((id, index) => id === ids[index]);
}
