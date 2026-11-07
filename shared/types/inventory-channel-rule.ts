import { z } from "zod";
import { inventoryCutoverDefinitionSelectionSchema } from "./inventory-cutover-commit";
import { channelDefinitionReceiptSchema } from "./inventory-channel-definition";
import { productDefinitionProgressSchema } from "./inventory-product-definition";

/**
 * Applying ONE saved product or SKU rule on one channel (owner decision
 * 2026-11-07: saving one SKU must not pull in every pending change on the
 * channel). Only the selected draft is promoted and only its product is
 * replanned, on every destination. Channel defaults affect every product on
 * the channel, so they stay on the whole-channel review.
 */
const id = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const headRevision = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const quantity = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** channelExposurePolicyScopeKey of a product or SKU rule. */
export const channelRuleScopeKeySchema = z.string().max(200)
  .regex(/^channel:[1-9][0-9]{0,9}:(product|variant):[1-9][0-9]{0,9}$/);

export const channelRuleScopeSchema = z.discriminatedUnion("scopeType", [
  z.object({ scopeType: z.literal("product"), channelId: id, productId: id }).strict(),
  z.object({ scopeType: z.literal("variant"), channelId: id, productId: id, productVariantId: id }).strict(),
]);

/** Pins the exact saved draft the operator is looking at. */
export const channelRuleSelectionSchema = z.object({
  scope: channelRuleScopeSchema,
  draftPolicyId: id,
  expectedHeadRevision: headRevision,
  expectedDefinitionHash: hash,
}).strict();

export const channelRuleReviewSchema = z.object({
  selection: channelRuleSelectionSchema,
  scopeKey: channelRuleScopeKeySchema,
  channelId: id,
  channelName: z.string(),
  productId: id,
  authorityRevision: revision,
  activationRunId: revision,
  reviewHash: hash,
  ready: z.boolean(),
  /** Problems this rule would create. Any one blocks Apply. */
  blockers: z.array(z.string()),
  /** Problems that already exist under the current rules. Shown, never enforced. */
  warnings: z.array(z.string()),
  /** Destinations or rows that will not receive this product's stock until their listing is fixed. */
  skippedDestinations: z.array(z.string()),
  change: z.object({
    selection: inventoryCutoverDefinitionSelectionSchema.extend({ kind: z.literal("channel_policy") }),
    headRevision,
    label: z.string(),
    before: z.record(z.unknown()).nullable(),
    after: z.record(z.unknown()),
  }).strict(),
  /** Every row this apply publishes. `current` is the quantity under the active rules. */
  quantities: z.array(z.object({
    targetId: id,
    channelName: z.string(),
    variantId: id,
    sku: z.string().nullable(),
    current: quantity.nullable(),
    proposed: quantity,
  }).strict()).max(10_000),
}).strict().superRefine((review, context) => {
  if (review.ready !== (review.blockers.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ready"], message: "Readiness must match the blocking evidence." });
  }
  const rows = review.quantities.map(row => `${row.targetId}:${row.variantId}`);
  if (new Set(rows).size !== rows.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["quantities"], message: "Each destination/SKU must appear only once." });
  }
  const { scope } = review.selection;
  const scopeKey = scope.scopeType === "variant"
    ? `channel:${scope.channelId}:variant:${scope.productVariantId}`
    : `channel:${scope.channelId}:product:${scope.productId}`;
  if (review.change.selection.definitionId !== review.selection.draftPolicyId
    || review.change.selection.definitionHash !== review.selection.expectedDefinitionHash
    || review.change.selection.key !== scopeKey || review.scopeKey !== scopeKey
    || review.channelId !== scope.channelId || review.productId !== scope.productId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["change"], message: "The reviewed change must be the selected draft." });
  }
});

export const applyChannelRuleSchema = channelRuleSelectionSchema.extend({
  expectedReviewHash: hash,
  idempotencyKey: z.string().trim().min(1).max(120),
}).strict();

/** The stored receipt keeps the channel receipt shape (same append-only table);
 * the response adds which rule it was. */
export const channelRuleReceiptSchema = channelDefinitionReceiptSchema.extend({
  scopeKey: channelRuleScopeKeySchema,
  productId: id,
  policyId: id,
}).strict();

export const channelRuleProgressSchema = z.object({
  receipt: channelRuleReceiptSchema,
  publications: productDefinitionProgressSchema.shape.publications,
}).strict();

export type ChannelRuleScope = z.infer<typeof channelRuleScopeSchema>;
export type ChannelRuleSelection = z.infer<typeof channelRuleSelectionSchema>;
export type ChannelRuleReview = z.infer<typeof channelRuleReviewSchema>;
export type ApplyChannelRule = z.infer<typeof applyChannelRuleSchema>;
export type ChannelRuleReceipt = z.infer<typeof channelRuleReceiptSchema>;
export type ChannelRuleProgress = z.infer<typeof channelRuleProgressSchema>;
