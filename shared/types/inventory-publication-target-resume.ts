import { z } from "zod";

import { inventoryChannelExposureRuntimeTargetSchema } from "./inventory-channel-exposure";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const positiveBigintString = z.string().regex(/^[1-9]\d*$/);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const reviewInventoryPublicationTargetResumeRequestSchema = z.object({
  publicationTargetId: positiveInteger,
  expectedRevision: positiveBigintString,
  idempotencyKey: nonblank(120),
  reason: nonblank(1000),
}).strict();

export const resumeInventoryPublicationTargetRequestSchema = z.object({
  publicationTargetId: positiveInteger,
  expectedRevision: positiveBigintString,
  resumeReviewId: positiveBigintString,
  expectedEvidenceHash: sha256Hex,
  idempotencyKey: nonblank(120),
  reason: nonblank(1000),
}).strict();

export const inventoryPublicationTargetResumeBlockerSchema = z.object({
  code: nonblank(100),
  message: nonblank(1000),
  context: z.record(z.unknown()),
}).strict();

export const inventoryPublicationTargetResumeReadbackSchema = z.object({
  productVariantId: positiveInteger,
  externalInventoryItemId: nonblank(240),
  observedQuantity: positiveBigintString.or(z.literal("0")),
  observedAt: z.string().datetime(),
  evidenceHash: sha256Hex,
}).strict();

export const inventoryPublicationTargetResumeIdentitySchema = z.object({
  productVariantId: positiveInteger,
  productId: positiveInteger.nullable(),
  externalInventoryItemId: nonblank(240),
  evidenceSources: z.array(z.enum(["active_mapping", "outbox", "readback"]))
    .min(1)
    .max(3),
  coveredByCurrentMapping: z.boolean(),
}).strict();

const resumeProductSchema = z.object({
  productId: positiveInteger,
  snapshotFingerprint: sha256Hex,
  target: inventoryChannelExposureRuntimeTargetSchema,
  readbacks: z.array(inventoryPublicationTargetResumeReadbackSchema),
}).strict();

export const inventoryPublicationTargetResumeReviewSchema = z.object({
  resumeReviewId: positiveBigintString,
  publicationTargetId: positiveInteger,
  publicationTargetRevision: positiveBigintString,
  authorityRevision: positiveBigintString,
  activationRunId: positiveBigintString,
  state: z.enum(["blocked", "ready"]),
  configurationHash: sha256Hex,
  readinessHash: sha256Hex,
  evidenceHash: sha256Hex,
  requestedBy: nonblank(100),
  reason: nonblank(1000),
  capturedAt: z.string().datetime(),
  identityCensus: z.array(inventoryPublicationTargetResumeIdentitySchema).max(100_000),
  products: z.array(resumeProductSchema).max(10_000),
  blockers: z.array(inventoryPublicationTargetResumeBlockerSchema),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(false),
  alreadyApplied: z.boolean(),
}).strict().superRefine((review, context) => {
  const targetIds = review.products.map((product) => product.target.publicationTargetId);
  if (targetIds.some((targetId) => targetId !== review.publicationTargetId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["products"],
      message: "Every resume-review product must belong to the exact publication target.",
    });
  }
  const productIds = review.products.map((product) => product.productId);
  if (new Set(productIds).size !== productIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["products"],
      message: "A product may appear only once in a target resume review.",
    });
  }
  const ready = review.blockers.length === 0
    && review.identityCensus.length > 0
    && review.identityCensus.every((identity) => identity.coveredByCurrentMapping)
    && review.products.length > 0
    && review.products.every((product) => product.target.publishable);
  if ((review.state === "ready") !== ready) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state"],
      message: "Resume readiness must match the complete exact-target evidence.",
    });
  }
});

export const inventoryPublicationTargetResumeResultSchema = z.object({
  publicationTargetId: positiveInteger,
  revision: positiveBigintString,
  state: z.literal("live"),
  activationRunId: positiveBigintString,
  authorityRevision: positiveBigintString,
  resumeReviewId: positiveBigintString,
  evidenceHash: sha256Hex,
  publicationRows: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  alreadyApplied: z.boolean(),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(true),
}).strict();

export type ReviewInventoryPublicationTargetResumeRequest = z.infer<
  typeof reviewInventoryPublicationTargetResumeRequestSchema
>;
export type ResumeInventoryPublicationTargetRequest = z.infer<
  typeof resumeInventoryPublicationTargetRequestSchema
>;
export type InventoryPublicationTargetResumeReview = z.infer<
  typeof inventoryPublicationTargetResumeReviewSchema
>;
export type InventoryPublicationTargetResumeResult = z.infer<
  typeof inventoryPublicationTargetResumeResultSchema
>;
export type InventoryPublicationTargetResumeBlocker = z.infer<
  typeof inventoryPublicationTargetResumeBlockerSchema
>;
