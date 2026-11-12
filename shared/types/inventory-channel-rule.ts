import { z } from "zod";
import { inventoryCutoverDefinitionSelectionSchema } from "./inventory-cutover-commit";
import { channelDefinitionReceiptSchema } from "./inventory-channel-definition";
import { channelExposurePolicyValueSchema } from "./inventory-channel-exposure";
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

/** One row a rule apply publishes. `current` is the quantity under the active rules. */
const channelRuleQuantitySchema = z.object({
  targetId: id,
  channelName: z.string(),
  variantId: id,
  sku: z.string().nullable(),
  current: quantity.nullable(),
  proposed: quantity,
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
  quantities: z.array(channelRuleQuantitySchema).max(10_000),
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

/**
 * Setting ONE product or SKU rule so that it takes effect (owner decision
 * 2026-11-07: a single-SKU save simply takes effect, with one visible state).
 * The value is saved as a new version, reviewed and applied in one database
 * transaction: either all of it commits, or nothing is written. There is no
 * review hash to send because no saved version exists before the command runs;
 * the head fence (revision, plus the saved version being replaced when one is
 * waiting) pins what the operator was looking at.
 */
export const setChannelRuleSchema = z.object({
  scope: channelRuleScopeSchema,
  value: channelExposurePolicyValueSchema,
  expectedHeadRevision: headRevision,
  expectedDraftPolicyId: id.nullable(),
  expectedDraftDefinitionHash: hash.nullable(),
  changeReason: z.string().trim().max(1000).nullable().optional().transform(value => (value ? value : null)),
  /** 100, not 120: the version row stores it behind a fixed prefix in a 120-character column. */
  idempotencyKey: z.string().trim().min(1).max(100),
}).strict().superRefine((command, context) => {
  if ((command.expectedDraftPolicyId === null) !== (command.expectedDraftDefinitionHash === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedDraftPolicyId"],
      message: "Expected saved version id and definition hash must be both present or both absent." });
  }
});

/** What a committed set did: the same receipt an apply returns, plus the quantities it published. */
export const channelRuleSetResultSchema = z.object({
  receipt: channelRuleReceiptSchema,
  quantities: z.array(channelRuleQuantitySchema).max(10_000),
  skippedDestinations: z.array(z.string()),
  warnings: z.array(z.string()),
}).strict();

export type ChannelRuleScope = z.infer<typeof channelRuleScopeSchema>;
export type ChannelRuleSelection = z.infer<typeof channelRuleSelectionSchema>;
export type ChannelRuleReview = z.infer<typeof channelRuleReviewSchema>;
export type ApplyChannelRule = z.infer<typeof applyChannelRuleSchema>;
export type ChannelRuleReceipt = z.infer<typeof channelRuleReceiptSchema>;
export type ChannelRuleProgress = z.infer<typeof channelRuleProgressSchema>;
export type SetChannelRule = z.infer<typeof setChannelRuleSchema>;
export type ChannelRuleSetResult = z.infer<typeof channelRuleSetResultSchema>;
