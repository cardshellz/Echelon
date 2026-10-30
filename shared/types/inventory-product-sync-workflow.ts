import { z } from "zod";
import { inventoryProductSyncProgressSchema, inventoryProductSyncRequestSchema, inventoryProductSyncReviewSchema,
  PRODUCT_SYNC_MAX_ROWS, PRODUCT_SYNC_MAX_TARGETS, PRODUCT_SYNC_MAX_VARIANTS } from "./inventory-product-sync";

const id = z.number().int().positive().max(2_147_483_647);
export const productSyncStartSchema = z.object({ productId: id, idempotencyKey: z.string().uuid() }).strict();
export const productSyncLinkScopeSchema = z.object({ productId: id, targets: z.array(z.object({
  publicationTargetId: id, productVariantIds: z.array(id).min(1).max(PRODUCT_SYNC_MAX_VARIANTS),
}).strict()).max(PRODUCT_SYNC_MAX_TARGETS) }).strict().superRefine((scope, context) => {
  if (new Set(scope.targets.map(target => target.publicationTargetId)).size !== scope.targets.length
    || scope.targets.some(target => new Set(target.productVariantIds).size !== target.productVariantIds.length)
    || scope.targets.reduce((count, target) => count + target.productVariantIds.length, 0) > PRODUCT_SYNC_MAX_ROWS)
    context.addIssue({ code: "custom", message: "A product check requires unique, bounded destination and variant scopes." });
});
export const productSyncWorkflowSchema = z.object({
  ...productSyncStartSchema.shape,
  requestedBy: z.string().trim().min(1).max(100), requestedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  state: z.enum(["checking_links", "publishing", "queued", "blocked", "failed"]),
  message: z.string().min(1), review: inventoryProductSyncReviewSchema,
  delivery: inventoryProductSyncProgressSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.review.productId !== value.productId || (value.state === "queued") !== (value.delivery !== null)
    || value.delivery && (value.delivery.receipt.productId !== value.productId
      || value.delivery.receipt.idempotencyKey !== value.idempotencyKey || value.delivery.receipt.requestedBy !== value.requestedBy))
    context.addIssue({ code: "custom", message: "Product sync status must match the recorded actor, product and command." });
});
/** Internal durable command; an uncertain publication always replays this exact body. */
export const productSyncSavedCommandSchema = inventoryProductSyncRequestSchema.nullable();
export type ProductSyncStart = z.infer<typeof productSyncStartSchema>;
export type ProductSyncLinkScope = z.infer<typeof productSyncLinkScopeSchema>;
export type ProductSyncWorkflow = z.infer<typeof productSyncWorkflowSchema>;
