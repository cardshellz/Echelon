import { z } from "zod";
import { inventoryAvailabilityBackfillQueueRowSchema } from "./inventory-availability-backfill";

// Small, serial batches bound request size and leave a useful per-product retry boundary.
export const INVENTORY_CATALOG_BATCH_LIMIT = 25;
const productId = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const mode = z.enum(["drafts", "reviews"]);
const uniqueIds = z.array(productId).min(1).max(INVENTORY_CATALOG_BATCH_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate products are not allowed");

export const inventoryCatalogBatchPreviewRequestSchema = z.object({
  mode,
  productIds: uniqueIds,
}).strict();

export const inventoryCatalogBatchPreviewSchema = z.object({
  version: z.literal("inventory_catalog_batch_v1"),
  mode,
  products: z.array(inventoryAvailabilityBackfillQueueRowSchema).min(1).max(INVENTORY_CATALOG_BATCH_LIMIT)
    .refine((rows) => new Set(rows.map((row) => row.productId)).size === rows.length,
      "Duplicate products are not allowed"),
  previewHash: hash,
}).strict();

const executionProductSchema = inventoryAvailabilityBackfillQueueRowSchema.pick({
  productId: true, inputHash: true, resultHash: true, candidateDefinitionHash: true,
  queueState: true, draft: true,
}).extend({ action: z.enum(["create", "refresh", "review", "skip"]),
  expectedLatestReviewId: z.string().regex(/^[1-9]\d*$/).max(19).nullable(),
}).strict();

export const inventoryCatalogBatchExecutionPreviewSchema = inventoryCatalogBatchPreviewSchema.extend({
  products: z.array(executionProductSchema).min(1).max(INVENTORY_CATALOG_BATCH_LIMIT)
    .refine((rows) => new Set(rows.map((row) => row.productId)).size === rows.length,
      "Duplicate products are not allowed"),
}).strict();

export const inventoryCatalogBatchExecuteRequestSchema = z.object({
  preview: inventoryCatalogBatchExecutionPreviewSchema,
  reason: z.string().trim().min(1).max(1000),
  decision: z.enum(["approved", "changes_required"]).nullable(),
}).strict().superRefine((request, ctx) => {
  if ((request.preview.mode === "reviews") !== (request.decision !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["decision"],
      message: "Review batches require an explicit decision; draft batches cannot record reviews" });
  }
  for (const [index, row] of request.preview.products.entries()) {
    const valid = row.action === "skip" || (row.candidateDefinitionHash !== null && (
      request.preview.mode === "drafts"
        ? (row.action === "create" && row.draft === null && row.queueState === "not_backfilled")
          || (row.action === "refresh" && row.draft?.origin === "phase3_backfill"
            && row.queueState === "conflicting_draft")
        : row.action === "review" && row.draft?.origin === "phase3_backfill" && row.draft.candidateMatch
          && row.draft.definitionHash === row.candidateDefinitionHash
          && (row.queueState === "awaiting_review" || row.queueState === "changes_required")
    ));
    if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["preview", "products", index],
      message: "Batch action is not eligible for this evidence and phase" });
  }
});

export const inventoryCatalogBatchResultSchema = z.object({
  previewHash: hash,
  runtimeAuthorityChanged: z.literal(false),
  inventoryWriteAttempted: z.literal(false),
  providerWriteAttempted: z.literal(false),
  rows: z.array(z.object({
    productId,
    action: z.enum(["create", "refresh", "review", "skip"]),
    status: z.enum(["applied", "already_current", "replayed", "skipped", "failed", "not_attempted"]),
    code: z.string(),
    message: z.string(),
    failureClass: z.enum(["transient", "permanent", "fatal"]).nullable(),
    modelId: productId.nullable(),
    reviewId: z.string().regex(/^[1-9]\d*$/).nullable(),
  }).strict()).min(1).max(INVENTORY_CATALOG_BATCH_LIMIT),
}).strict();

export type InventoryCatalogBatchPreview = z.infer<typeof inventoryCatalogBatchPreviewSchema>;
export type InventoryCatalogBatchExecuteRequest = z.infer<typeof inventoryCatalogBatchExecuteRequestSchema>;
export type InventoryCatalogBatchResult = z.infer<typeof inventoryCatalogBatchResultSchema>;

/** Submit only optimistic-concurrency evidence, not large recipe graphs or diagnostic text.
 * The definition hash and source hashes bind the exact graph shown in the full preview.
 */
export function catalogBatchExecutionPreview(preview: InventoryCatalogBatchPreview):
  z.infer<typeof inventoryCatalogBatchExecutionPreviewSchema> {
  return { version: preview.version, mode: preview.mode, previewHash: preview.previewHash,
    products: preview.products.map((row) => ({ productId: row.productId, inputHash: row.inputHash,
      resultHash: row.resultHash, candidateDefinitionHash: row.candidateDefinitionHash,
      queueState: row.queueState, draft: row.draft, expectedLatestReviewId: row.review?.reviewId ?? null,
      action: catalogBatchAction(preview.mode, row) })) };
}

/** Shared deterministic presentation rule; the existing writers still revalidate under locks. */
export function catalogBatchAction(mode: InventoryCatalogBatchPreview["mode"],
  row: InventoryCatalogBatchPreview["products"][number]): "create" | "refresh" | "review" | "skip" {
  if (!row.candidateDefinition || !row.candidateDefinitionHash
    || row.queueState === "blocked" || row.queueState === "excluded") return "skip";
  if (mode === "reviews") {
    return row.draft?.origin === "phase3_backfill" && row.draft.candidateMatch
      && (row.queueState === "awaiting_review" || row.queueState === "changes_required")
      ? "review" : "skip";
  }
  if (!row.draft && row.queueState === "not_backfilled") return "create";
  return row.queueState === "conflicting_draft" && row.draft?.origin === "phase3_backfill"
    && row.draft.originInputHash !== null && row.draft.originResultHash !== null ? "refresh" : "skip";
}
