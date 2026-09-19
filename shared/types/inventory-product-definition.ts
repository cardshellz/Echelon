import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const quantity = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const productDefinitionSelectionSchema = z.object({
  productId: id, draftModelId: id, expectedHeadRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/), expectedDefinitionHash: hash,
}).strict();
export const productDefinitionReviewSchema = z.object({
  selection: productDefinitionSelectionSchema, reviewHash: hash, ready: z.boolean(),
  authorityRevision: revision, activationRunId: revision,
  previousModel: z.object({ id, definitionHash: hash }).strict().nullable(),
  affectedProductIds: z.array(id).min(1).max(1000),
  blockers: z.array(z.string()),
  atp: z.array(z.object({ productId: id, variantId: id, sku: z.string().nullable(),
    warehouseId: id, warehouseName: z.string(), current: quantity, proposed: quantity,
  }).strict()).max(100000),
  channels: z.array(z.object({ productId: id, targetId: id, channelName: z.string(),
    variantId: id, sku: z.string().nullable(), current: quantity.nullable(), proposed: quantity,
  }).strict()).max(100000),
}).strict();
export const applyProductDefinitionSchema = productDefinitionSelectionSchema.extend({
  expectedReviewHash: hash, idempotencyKey: z.string().trim().min(1).max(120),
}).strict();
export const productDefinitionReceiptSchema = z.object({
  productId: id, modelId: id, appliedAt: z.string().datetime(), appliedBy: z.string(),
  reviewHash: hash, publicationIds: z.array(revision), alreadyApplied: z.boolean(),
}).strict();
export const productDefinitionProgressSchema = z.object({
  receipt: productDefinitionReceiptSchema,
  publications: z.array(z.object({ id: revision, targetId: id, variantId: id,
    state: z.enum(["desired", "queued", "leased", "published", "acknowledged", "verified", "retryable", "drifted", "dead_letter", "cancelled", "superseded"]),
    desiredQuantity: quantity, errorCode: z.string().nullable(),
  }).strict()),
}).strict();
export type ProductDefinitionSelection = z.infer<typeof productDefinitionSelectionSchema>;
export type ProductDefinitionReview = z.infer<typeof productDefinitionReviewSchema>;
export type ApplyProductDefinition = z.infer<typeof applyProductDefinitionSchema>;
export type ProductDefinitionReceipt = z.infer<typeof productDefinitionReceiptSchema>;
export type ProductDefinitionProgress = z.infer<typeof productDefinitionProgressSchema>;
