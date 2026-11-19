import { z } from "zod";

export const PRODUCT_SYNC_MAX_VARIANTS = 1_000;
export const PRODUCT_SYNC_MAX_TARGETS = 1_000;
export const PRODUCT_SYNC_MAX_ROWS = 10_000;
const id = z.number().int().positive().max(2_147_483_647);
const quantity = z.string().regex(/^(0|[1-9][0-9]*)$/).max(19);
const recordId = quantity.refine(value => value !== "0", "A positive record identity is required.");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const destination = z.object({ publicationTargetId: id, channelId: id, channelName: z.string(),
  providerKey: z.string().min(1), externalScopeId: z.string().min(1) }).strict();
const target = destination.extend({ status: z.enum(["ready", "blocked", "skipped"]), blockers: z.array(z.string()) }).strict();
const row = destination.extend({ productVariantId: id, sku: z.string().nullable(), quantity: quantity.nullable(),
  externalInventoryItemId: z.string().min(1).nullable(), status: z.enum(["ready", "blocked"]), blockers: z.array(z.string()), warnings: z.array(z.string()).optional() }).strict();
const readyRow = destination.extend({ productVariantId: id, sku: z.string().nullable(), quantity,
  externalInventoryItemId: z.string().min(1), status: z.literal("ready"), blockers: z.array(z.string()).length(0), warnings: z.array(z.string()).optional() }).strict();
const product = { productId: id, productName: z.string(), sku: z.string().nullable() };
const rowKey = (value: { publicationTargetId: number; productVariantId: number }) => `${value.publicationTargetId}:${value.productVariantId}`;

export const inventoryProductSyncReviewRequestSchema = z.object({ productId: id }).strict();
export const inventoryProductSyncRequestSchema = inventoryProductSyncReviewRequestSchema.extend({ expectedReviewHash: hash,
  idempotencyKey: z.string().uuid() }).strict();
export const inventoryProductSyncReviewSchema = z.object({ ...product, reviewHash: hash, ready: z.boolean(), blockers: z.array(z.string()),
  rows: z.array(row).max(PRODUCT_SYNC_MAX_ROWS), targets: z.array(target).max(PRODUCT_SYNC_MAX_TARGETS) }).strict().superRefine((value, context) => {
  const ready = value.rows.filter(candidate => candidate.status === "ready");
  if (value.ready !== (value.blockers.length === 0 && ready.length > 0)
    || ready.some(candidate => candidate.quantity === null || candidate.externalInventoryItemId === null || candidate.blockers.length > 0)
    || new Set(value.rows.map(rowKey)).size !== value.rows.length
    || new Set(value.targets.map(candidate => candidate.publicationTargetId)).size !== value.targets.length
    || value.targets.some(target => (target.status === "ready") !== ready.some(candidate => candidate.publicationTargetId === target.publicationTargetId)
      || target.status === "skipped" && value.rows.some(candidate => candidate.publicationTargetId === target.publicationTargetId))
    || value.rows.some(candidate => !value.targets.some(target => target.publicationTargetId === candidate.publicationTargetId
      && target.channelId === candidate.channelId && target.channelName === candidate.channelName
      && target.providerKey === candidate.providerKey && target.externalScopeId === candidate.externalScopeId)))
    context.addIssue({ code: "custom", message: "The product review must cover each exact destination and SKU once, with complete ready quantities." });
});
export const inventoryProductSyncReceiptSchema = z.object({ ...product, idempotencyKey: z.string().uuid(), reviewHash: hash,
  requestedAt: timestamp, requestedBy: z.string().min(1), targets: z.array(target).max(PRODUCT_SYNC_MAX_TARGETS),
  rows: z.array(readyRow.extend({ outboxId: recordId, revision: recordId }).strict()).min(1).max(PRODUCT_SYNC_MAX_ROWS),
  blockedRows: z.array(row.extend({ status: z.literal("blocked") })).max(PRODUCT_SYNC_MAX_ROWS).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.rows.map(rowKey)).size !== value.rows.length || new Set(value.rows.map(candidate => candidate.outboxId)).size !== value.rows.length
    || new Set(value.targets.map(candidate => candidate.publicationTargetId)).size !== value.targets.length
    || value.targets.some(target => (target.status === "ready") !== value.rows.some(candidate => candidate.publicationTargetId === target.publicationTargetId))
    || new Set([...value.rows, ...(value.blockedRows ?? [])].map(rowKey)).size !== value.rows.length + (value.blockedRows?.length ?? 0)
    || value.rows.some(candidate => !value.targets.some(target => target.status === "ready" && target.publicationTargetId === candidate.publicationTargetId
      && target.channelId === candidate.channelId && target.channelName === candidate.channelName
      && target.providerKey === candidate.providerKey && target.externalScopeId === candidate.externalScopeId))
    || value.blockedRows?.some(candidate => !value.targets.some(target => target.publicationTargetId === candidate.publicationTargetId
      && target.channelId === candidate.channelId && target.channelName === candidate.channelName
      && target.providerKey === candidate.providerKey && target.externalScopeId === candidate.externalScopeId)))
    context.addIssue({ code: "custom", message: "A receipt requires unique delivery records for the exact ready destinations and SKUs." });
});
export const inventoryProductSyncResultSchema = z.object({ receipt: inventoryProductSyncReceiptSchema, replayed: z.boolean() }).strict();
export const inventoryProductSyncProgressSchema = z.object({ receipt: inventoryProductSyncReceiptSchema,
  rows: z.array(z.object({ publicationTargetId: id, productVariantId: id, outboxId: recordId,
    state: z.enum(["desired", "queued", "leased", "acknowledged", "verified", "drifted", "retryable", "dead_letter", "superseded", "cancelled"]),
    errorCode: z.string().nullable(), errorMessage: z.string().nullable(), observedQuantity: quantity.nullable(), observedAt: timestamp.nullable(),
  }).strict()).max(PRODUCT_SYNC_MAX_ROWS),
}).strict().superRefine((value, context) => {
  if (value.rows.length !== value.receipt.rows.length || new Set(value.rows.map(candidate => candidate.outboxId)).size !== value.rows.length
    || value.rows.some(candidate => !value.receipt.rows.some(expected => expected.outboxId === candidate.outboxId && rowKey(expected) === rowKey(candidate))))
    context.addIssue({ code: "custom", message: "Delivery status must match every exact receipt row." });
});

export type InventoryProductSyncReviewRequest = z.infer<typeof inventoryProductSyncReviewRequestSchema>;
export type InventoryProductSyncRequest = z.infer<typeof inventoryProductSyncRequestSchema>;
export type InventoryProductSyncReview = z.infer<typeof inventoryProductSyncReviewSchema>;
export type InventoryProductSyncReceipt = z.infer<typeof inventoryProductSyncReceiptSchema>;
export type InventoryProductSyncResult = z.infer<typeof inventoryProductSyncResultSchema>;
export type InventoryProductSyncProgress = z.infer<typeof inventoryProductSyncProgressSchema>;
