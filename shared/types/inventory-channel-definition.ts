import { z } from "zod";
import { inventoryCutoverDefinitionSelectionSchema } from "./inventory-cutover-commit";
import { productDefinitionProgressSchema } from "./inventory-product-definition";

const id = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const quantity = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const channelDefinitionSelectionSchema = z.object({ channelId: id }).strict();
export const channelDefinitionReviewSchema = z.object({
  channelId: id,
  channelName: z.string(),
  authorityRevision: revision,
  activationRunId: revision,
  reviewHash: hash,
  ready: z.boolean(),
  blockers: z.array(z.string()),
  affectedProductIds: z.array(id).max(1000),
  changes: z.array(z.object({
    selection: inventoryCutoverDefinitionSelectionSchema.extend({ kind: z.enum(["channel_policy", "source_binding", "variant_mapping"]) }),
    headRevision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
    label: z.string(),
    before: z.record(z.unknown()).nullable(),
    after: z.record(z.unknown()),
  }).strict()).min(1).max(10000),
  destinations: z.array(z.object({ id, state: z.enum(["disabled", "preview", "live"]),
    authority: z.enum(["echelon", "external_provider", "manual"]), scope: z.string(),
  }).strict()),
  quantities: z.array(z.object({ productId: id, variantId: id, sku: z.string().nullable(),
    targetId: id, channelName: z.string(), current: quantity.nullable(), proposed: quantity,
    warehouses: z.array(z.object({ warehouseId: id, available: quantity }).strict()),
  }).strict()).max(100000),
}).strict().superRefine((review, context) => {
  if (review.ready !== (review.blockers.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ready"], message: "Readiness must match the complete blocking evidence." });
  }
  const quantities = review.quantities.map(row => `${row.targetId}:${row.variantId}`);
  const definitions = review.changes.map(change => `${change.selection.kind}:${change.selection.key}`);
  if (new Set(quantities).size !== quantities.length || new Set(definitions).size !== definitions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each affected definition and destination/SKU must appear only once." });
  }
});
export const applyChannelDefinitionSchema = channelDefinitionSelectionSchema.extend({
  expectedReviewHash: hash, idempotencyKey: z.string().trim().min(1).max(120),
}).strict();
export const channelDefinitionReceiptSchema = z.object({
  channelId: id, appliedAt: z.string().datetime(), appliedBy: z.string().min(1), reviewHash: hash,
  publicationIds: z.array(revision), changedDefinitions: z.number().int().positive(), alreadyApplied: z.boolean(),
}).strict();
export const channelDefinitionProgressSchema = z.object({
  receipt: channelDefinitionReceiptSchema, publications: productDefinitionProgressSchema.shape.publications,
}).strict();
export type ChannelDefinitionReview = z.infer<typeof channelDefinitionReviewSchema>;
export type ApplyChannelDefinition = z.infer<typeof applyChannelDefinitionSchema>;
export type ChannelDefinitionReceipt = z.infer<typeof channelDefinitionReceiptSchema>;
export type ChannelDefinitionProgress = z.infer<typeof channelDefinitionProgressSchema>;
