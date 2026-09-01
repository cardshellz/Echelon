import { z } from "zod";

import { PRODUCT_INVENTORY_STRATEGIES } from "../catalog/inventory-strategy";
import {
  createTransformationModelDraftResultSchema,
  postgresBigintStringSchema,
  transformationDraftBindingInputSchema,
  transformationDraftPathInputSchema,
} from "./inventory-availability-admin";
import { plannerNonnegativeQuantitySchema } from "./inventory-availability-planner";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativeInteger = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
const nonnegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION =
  "inventory_availability_backfill_v3" as const;

export const inventoryAvailabilityBackfillClassificationSchema = z.enum([
  "exact_only",
  "legacy_fungible_directed_pool",
  "recipe_managed_explicit_review",
  "excluded_unmanaged",
  "excluded_internal_supply_only",
  "blocked",
]);

export const inventoryAvailabilityBackfillIssueSchema = z.object({
  code: nonblank(100),
  severity: z.enum(["review", "blocking"]),
  message: nonblank(1000),
  context: z.record(z.unknown()),
}).strict();

export const inventoryAvailabilityBackfillDefinitionSchema = z.object({
  buildToPromiseEnabled: z.boolean(),
  paths: z.array(transformationDraftPathInputSchema).max(500),
  recipeBindings: z.array(transformationDraftBindingInputSchema).max(200),
}).strict();

export const inventoryAvailabilityBackfillDraftSchema = z.object({
  modelId: positiveInteger,
  version: positiveInteger,
  definitionHash: sha256Hex,
  headRevision: postgresBigintStringSchema,
  origin: z.enum(["operator", "phase3_backfill"]),
  originInputHash: sha256Hex.nullable(),
  originResultHash: sha256Hex.nullable(),
  definitionMatch: z.boolean(),
  provenanceMatch: z.boolean(),
  candidateMatch: z.boolean(),
}).strict().superRefine((draft, context) => {
  const hasBackfillHashes = draft.originInputHash !== null && draft.originResultHash !== null;
  if ((draft.origin === "phase3_backfill") !== hasBackfillHashes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["originInputHash"],
      message: "Phase 3 backfill drafts require both origin hashes; operator drafts require neither",
    });
  }
});

export const inventoryAvailabilityBackfillReviewSchema = z.object({
  reviewId: plannerNonnegativeQuantitySchema.refine((value) => value !== "0"),
  decision: z.enum(["approved", "changes_required"]),
  reason: nonblank(1000),
  reviewedBy: nonblank(100),
  reviewedAt: z.string().datetime(),
  modelId: positiveInteger,
  modelVersion: positiveInteger,
  modelDefinitionHash: sha256Hex,
}).strict();

export const inventoryAvailabilityBackfillQueueStateSchema = z.enum([
  "blocked",
  "excluded",
  "not_backfilled",
  "conflicting_draft",
  "awaiting_review",
  "changes_required",
  "approved",
]);

export const inventoryAvailabilityBackfillQueueRowSchema = z.object({
  productId: positiveInteger,
  productSku: z.string().max(100).nullable(),
  productName: z.string(),
  legacyInventoryStrategy: z.enum(PRODUCT_INVENTORY_STRATEGIES),
  activeVariantCount: nonnegativeInteger,
  activeRecipeCount: nonnegativeInteger,
  classification: inventoryAvailabilityBackfillClassificationSchema,
  inputHash: sha256Hex,
  resultHash: sha256Hex,
  candidateDefinitionHash: sha256Hex.nullable(),
  candidateDefinition: inventoryAvailabilityBackfillDefinitionSchema.nullable(),
  issues: z.array(inventoryAvailabilityBackfillIssueSchema),
  queueState: inventoryAvailabilityBackfillQueueStateSchema,
  draft: inventoryAvailabilityBackfillDraftSchema.nullable(),
  review: inventoryAvailabilityBackfillReviewSchema.nullable(),
  latestShadow: z.object({
    runId: plannerNonnegativeQuantitySchema.refine((value) => value !== "0"),
    status: z.enum(["completed", "blocked"]),
    snapshotFingerprint: sha256Hex,
    modelDefinitionHash: sha256Hex.nullable(),
    capturedAt: z.string().datetime(),
  }).strict().nullable(),
}).strict();

export const inventoryAvailabilityBackfillQueueResponseSchema = z.object({
  algorithmVersion: z.literal(INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION),
  capturedAt: z.string().datetime(),
  catalogInputHash: sha256Hex,
  catalogResultHash: sha256Hex,
  summary: z.object({
    totalActiveProducts: nonnegativeInteger,
    blocked: nonnegativeInteger,
    excluded: nonnegativeInteger,
    notBackfilled: nonnegativeInteger,
    conflictingDraft: nonnegativeInteger,
    awaitingReview: nonnegativeInteger,
    changesRequired: nonnegativeInteger,
    approved: nonnegativeInteger,
  }).strict(),
  products: z.array(inventoryAvailabilityBackfillQueueRowSchema).max(10_000),
}).strict();

export const applyInventoryAvailabilityBackfillDraftRequestSchema = z.object({
  expectedInputHash: sha256Hex,
  expectedResultHash: sha256Hex,
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const applyInventoryAvailabilityBackfillDraftResultSchema =
  createTransformationModelDraftResultSchema.extend({
    inputHash: sha256Hex,
    resultHash: sha256Hex,
  }).strict();

export const refreshInventoryAvailabilityBackfillDraftRequestSchema = z.object({
  expectedInputHash: sha256Hex,
  expectedResultHash: sha256Hex,
  expectedDraftVersion: positiveInteger,
  expectedDraftDefinitionHash: sha256Hex,
  expectedDraftHeadRevision: postgresBigintStringSchema,
  expectedDraftOriginInputHash: sha256Hex,
  expectedDraftOriginResultHash: sha256Hex,
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const refreshInventoryAvailabilityBackfillDraftResultSchema =
  createTransformationModelDraftResultSchema.extend({
    supersededModelId: positiveInteger,
    inputHash: sha256Hex,
    resultHash: sha256Hex,
  }).strict();

export const reviewInventoryAvailabilityBackfillDraftRequestSchema = z.object({
  expectedModelId: positiveInteger,
  expectedModelVersion: positiveInteger,
  expectedDefinitionHash: sha256Hex,
  expectedHeadRevision: postgresBigintStringSchema,
  decision: z.enum(["approved", "changes_required"]),
  reason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const reviewInventoryAvailabilityBackfillDraftResultSchema = z.object({
  review: inventoryAvailabilityBackfillReviewSchema,
  alreadyApplied: z.boolean(),
}).strict();

export const inventoryAvailabilityChannelPreviewRowSchema = z.object({
  channelId: positiveInteger,
  channelName: z.string(),
  channelProvider: z.string(),
  productVariantId: positiveInteger,
  sku: z.string().max(100).nullable(),
  unitsPerVariant: positiveInteger,
  warehouseScopeSource: z.enum(["explicit", "legacy_all_active_fallback"]),
  legacyAtpUnits: plannerNonnegativeQuantitySchema,
  proposedAtpUnits: plannerNonnegativeQuantitySchema,
  legacyPublishedUnits: plannerNonnegativeQuantitySchema,
  proposedPublishedUnits: plannerNonnegativeQuantitySchema,
  differenceUnits: z.string().regex(/^(0|-?[1-9]\d*)$/),
  allocationMethod: z.string(),
  allocationReason: z.string(),
  warehouseBreakdown: z.array(z.object({
    warehouseId: positiveInteger,
    legacyQty: nonnegativeSafeInteger,
    proposedQty: nonnegativeSafeInteger,
  }).strict()),
}).strict();

export const inventoryAvailabilityChannelPreviewSchema = z.object({
  productId: positiveInteger,
  shadowRunId: plannerNonnegativeQuantitySchema.refine((value) => value !== "0"),
  snapshotFingerprint: sha256Hex,
  shadowCapturedAt: z.string().datetime(),
  modelId: positiveInteger.nullable(),
  modelVersion: positiveInteger.nullable(),
  modelDefinitionHash: sha256Hex.nullable(),
  policyAuthority: z.literal("legacy_channel_allocation_rules"),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  allocationAuditWritten: z.literal(false),
  blockers: z.array(inventoryAvailabilityBackfillIssueSchema),
  rows: z.array(inventoryAvailabilityChannelPreviewRowSchema),
}).strict().superRefine((preview, context) => {
  const modelEvidenceCount = [
    preview.modelId,
    preview.modelVersion,
    preview.modelDefinitionHash,
  ].filter((value) => value !== null).length;
  if (modelEvidenceCount !== 0 && modelEvidenceCount !== 3) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelId"],
      message: "Model id, version, and definition hash must be all present or all absent",
    });
  }
});

export type InventoryAvailabilityBackfillDefinition = z.infer<
  typeof inventoryAvailabilityBackfillDefinitionSchema
>;
export type InventoryAvailabilityBackfillIssue = z.infer<
  typeof inventoryAvailabilityBackfillIssueSchema
>;
export type InventoryAvailabilityBackfillQueueRow = z.infer<
  typeof inventoryAvailabilityBackfillQueueRowSchema
>;
export type InventoryAvailabilityBackfillReview = z.infer<
  typeof inventoryAvailabilityBackfillReviewSchema
>;
export type InventoryAvailabilityBackfillQueueResponse = z.infer<
  typeof inventoryAvailabilityBackfillQueueResponseSchema
>;
export type ApplyInventoryAvailabilityBackfillDraftRequest = z.infer<
  typeof applyInventoryAvailabilityBackfillDraftRequestSchema
>;
export type ApplyInventoryAvailabilityBackfillDraftResult = z.infer<
  typeof applyInventoryAvailabilityBackfillDraftResultSchema
>;
export type RefreshInventoryAvailabilityBackfillDraftRequest = z.infer<
  typeof refreshInventoryAvailabilityBackfillDraftRequestSchema
>;
export type RefreshInventoryAvailabilityBackfillDraftResult = z.infer<
  typeof refreshInventoryAvailabilityBackfillDraftResultSchema
>;
export type ReviewInventoryAvailabilityBackfillDraftRequest = z.infer<
  typeof reviewInventoryAvailabilityBackfillDraftRequestSchema
>;
export type InventoryAvailabilityChannelPreview = z.infer<
  typeof inventoryAvailabilityChannelPreviewSchema
>;
