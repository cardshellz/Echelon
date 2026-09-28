import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const revision = z.string().regex(/^[1-9]\d*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(id).refine(values => new Set(values).size === values.length, "Duplicate variant identity");
const exclusions = z.array(z.object({
  productVariantId: id,
  reason: z.literal("unsupported_bundle"),
}).strict()).max(1_000).refine(values => new Set(values.map(value => value.productVariantId)).size === values.length,
  "Duplicate excluded variant identity");
export const reviewInitialPublicationScopeSchema = z.object({
  publicationTargetId: id, expectedTargetRevision: revision,
  excludedVariants: exclusions.optional(),
}).strict();
export const prepareInitialPublicationScopeSchema = reviewInitialPublicationScopeSchema.extend({
  expectedReviewHash: hash, idempotencyKey: z.string().trim().min(1).max(120),
}).strict();
export const initialPublicationScopeReviewSchema = z.object({
  publicationTargetId: id, targetRevision: revision, authorityRevision: revision,
  reviewHash: hash, ready: z.boolean(), includedVariantIds: ids,
  excludedNonStockVariantIds: ids,
  excludedVariants: exclusions.optional(),
  blockers: z.array(z.object({ code: z.string().min(1), message: z.string().min(1), productVariantId: id.nullable() }).strict()),
  runtimeAuthorityChanged: z.literal(false), providerWriteAttempted: z.literal(false), outboxEnqueued: z.literal(false),
}).strict();
export const initialPublicationScopeReceiptSchema = z.object({
  publicationTargetId: id, previousRevision: revision, revision, reviewHash: hash,
  includedVariantIds: ids, preparedBy: z.string().trim().min(1).max(100), preparedAt: z.string().datetime(),
  excludedVariants: exclusions.optional(),
  alreadyApplied: z.boolean(), runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false), outboxEnqueued: z.literal(false),
}).strict();
export type ReviewInitialPublicationScope = z.infer<typeof reviewInitialPublicationScopeSchema>;
export type PrepareInitialPublicationScope = z.infer<typeof prepareInitialPublicationScopeSchema>;
export type InitialPublicationScopeReview = z.infer<typeof initialPublicationScopeReviewSchema>;
export type InitialPublicationScopeReceipt = z.infer<typeof initialPublicationScopeReceiptSchema>;
