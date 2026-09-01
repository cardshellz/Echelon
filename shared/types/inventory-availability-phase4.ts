import { z } from "zod";

import { inventoryAvailabilityBackfillQueueStateSchema } from "./inventory-availability-backfill";
import {
  claimPlanRequestSchema,
  claimPlanSchema,
  plannerBlockerSchema,
  plannerNonnegativeQuantitySchema,
  plannerPositiveQuantitySchema,
} from "./inventory-availability-planner";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativeInteger = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const runPlannerClaimSimulationRequestSchema = z.object({
  idempotencyKey: nonblank(120),
  reason: nonblank(1000),
  claim: claimPlanRequestSchema,
}).strict();

export const plannerClaimSimulationRunSchema = z.object({
  simulationRunId: plannerPositiveQuantitySchema,
  requestHash: sha256Hex,
  requestedBy: nonblank(100),
  reason: nonblank(1000),
  capturedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  claim: claimPlanRequestSchema,
  plan: claimPlanSchema,
  legacyLivePathRetained: z.literal(true),
  operationalWriteAttempted: z.literal(false),
  alreadyApplied: z.boolean(),
}).strict().superRefine((run, context) => {
  if (run.claim.requestKey !== run.plan.requestKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plan", "requestKey"],
      message: "Claim plan must belong to the recorded claim request",
    });
  }
  if (Date.parse(run.completedAt) < Date.parse(run.capturedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedAt"],
      message: "Completion time cannot precede snapshot capture time",
    });
  }
});

export const runInventoryActivationDryRunRequestSchema = z.object({
  expectedCatalogInputHash: sha256Hex,
  expectedCatalogResultHash: sha256Hex,
  idempotencyKey: nonblank(120),
  reason: nonblank(1000),
}).strict();

export const activationDryRunBlockerSchema = plannerBlockerSchema.extend({
  severity: z.enum(["review", "blocking"]),
  productId: positiveInteger.nullable(),
}).strict();

export const currentPublicationEvidenceSchema = z.object({
  channelId: positiveInteger,
  productVariantId: positiveInteger,
  feedId: positiveInteger.nullable(),
  mappingState: z.enum(["missing", "inactive", "active", "quarantined"]),
  channelInventoryItemId: z.string().max(240).nullable(),
  lastAcknowledgedUnits: plannerNonnegativeQuantitySchema.nullable(),
  lastAcknowledgedAt: z.string().datetime().nullable(),
  configuredTargets: z.array(z.object({
    publicationTargetId: positiveInteger,
    channelConnectionId: positiveInteger,
    fulfillmentNodeId: positiveInteger,
    warehouseId: positiveInteger,
    providerScopeType: z.enum(["account", "location"]),
    externalScopeId: nonblank(240),
    publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
    state: z.enum(["disabled", "preview", "live"]),
    revision: z.string().regex(/^[1-9]\d*$/),
    mapping: z.object({
      mappingId: positiveInteger,
      version: positiveInteger,
      definitionHash: sha256Hex,
      authority: z.enum(["draft", "active"]),
      externalInventoryItemId: nonblank(240),
      externalSku: z.string().trim().min(1).max(100).nullable(),
    }).strict().nullable(),
    latestReadbackUnits: plannerNonnegativeQuantitySchema.nullable(),
    latestReadbackAt: z.string().datetime().nullable(),
    latestReadbackExternalInventoryItemId: nonblank(240).nullable(),
  }).strict()),
}).strict();

export const activationDryRunProductSchema = z.object({
  productId: positiveInteger,
  queueState: inventoryAvailabilityBackfillQueueStateSchema,
  status: z.enum(["ready", "blocked"]),
  draftModelId: positiveInteger.nullable(),
  draftModelVersion: positiveInteger.nullable(),
  draftDefinitionHash: sha256Hex.nullable(),
  reviewId: plannerPositiveQuantitySchema.nullable(),
  shadowRunId: plannerPositiveQuantitySchema.nullable(),
  shadowSnapshotFingerprint: sha256Hex.nullable(),
  channelPreviewHash: sha256Hex.nullable(),
  proposedPublications: z.array(z.object({
    publicationTargetId: positiveInteger,
    channelId: positiveInteger,
    channelConnectionId: positiveInteger,
    channelProvider: nonblank(60),
    providerScopeType: z.enum(["account", "location"]),
    externalScopeId: nonblank(240),
    publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
    publicationTargetRevision: z.string().regex(/^[1-9]\d*$/),
    disposition: z.enum(["publish", "observe_only", "skip_ineligible", "blocked"]),
    productVariantId: positiveInteger,
    canonicalAtpUnits: plannerNonnegativeQuantitySchema,
    legacyCalculatedUnits: plannerNonnegativeQuantitySchema,
    desiredUnits: plannerNonnegativeQuantitySchema,
    differenceFromLastAcknowledgedUnits: z.string().regex(/^(0|-?[1-9]\d*)$/).nullable(),
    sourceBindingId: positiveInteger.nullable(),
    sourceBindingVersion: positiveInteger.nullable(),
    sourceBindingDefinitionHash: sha256Hex.nullable(),
    sourceWarehouseIds: z.array(positiveInteger),
    sourceWarehouseBreakdown: z.array(z.object({
      warehouseId: positiveInteger,
      canonicalAtpUnits: plannerNonnegativeQuantitySchema,
    }).strict()),
    mappingId: positiveInteger.nullable(),
    mappingVersion: positiveInteger.nullable(),
    mappingDefinitionHash: sha256Hex.nullable(),
    externalInventoryItemId: nonblank(240).nullable(),
    externalSku: z.string().trim().min(1).max(100).nullable(),
  }).strict()),
  publicationEvidence: z.array(currentPublicationEvidenceSchema),
  blockers: z.array(activationDryRunBlockerSchema),
}).strict().superRefine((product, context) => {
  product.proposedPublications.forEach((publication, index) => {
    const sourceEvidence = [
      publication.sourceBindingId,
      publication.sourceBindingVersion,
      publication.sourceBindingDefinitionHash,
    ];
    if (![0, 3].includes(sourceEvidence.filter((value) => value !== null).length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedPublications", index, "sourceBindingId"],
        message: "Publication source-binding evidence must be all present or all absent",
      });
    }
    const mappingEvidence = [
      publication.mappingId,
      publication.mappingVersion,
      publication.mappingDefinitionHash,
      publication.externalInventoryItemId,
    ];
    if (![0, 4].includes(mappingEvidence.filter((value) => value !== null).length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedPublications", index, "mappingId"],
        message: "Publication target/SKU mapping evidence must be all present or all absent",
      });
    }
    const warehouseIds = publication.sourceWarehouseBreakdown.map((entry) => entry.warehouseId);
    const warehouseTotal = publication.sourceWarehouseBreakdown.reduce(
      (total, entry) => total + BigInt(entry.canonicalAtpUnits),
      BigInt(0),
    );
    if (new Set(warehouseIds).size !== warehouseIds.length
      || warehouseTotal !== BigInt(publication.canonicalAtpUnits)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedPublications", index, "sourceWarehouseBreakdown"],
        message: "Warehouse ATP rows must be unique and sum to target canonical ATP",
      });
    }
    if (publication.disposition === "publish" && (
      publication.publicationAuthority !== "echelon"
      || publication.sourceBindingId === null
      || publication.mappingId === null
    )) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedPublications", index, "disposition"],
        message: "Publish disposition requires Echelon authority plus complete source and mapping evidence",
      });
    }
    if (publication.disposition === "observe_only"
      && publication.publicationAuthority === "echelon") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedPublications", index, "disposition"],
        message: "Observe-only disposition is reserved for non-Echelon publication authority",
      });
    }
    if (publication.disposition === "skip_ineligible" && publication.desiredUnits !== "0") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposedPublications", index, "desiredUnits"],
        message: "An ineligible target/SKU must have zero desired units",
      });
    }
  });
});

export const inventoryActivationDryRunSchema = z.object({
  activationRunId: plannerPositiveQuantitySchema,
  mode: z.literal("dry_run"),
  scope: z.literal("full_catalog"),
  state: z.enum(["blocked", "ready_for_publication"]),
  requestHash: sha256Hex,
  resultHash: sha256Hex,
  catalogInputHash: sha256Hex,
  catalogResultHash: sha256Hex,
  requestedBy: nonblank(100),
  reason: nonblank(1000),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  summary: z.object({
    totalProducts: nonnegativeInteger,
    readyProducts: nonnegativeInteger,
    blockedProducts: nonnegativeInteger,
    publicationRows: nonnegativeInteger,
  }).strict(),
  products: z.array(activationDryRunProductSchema).max(10_000),
  blockers: z.array(activationDryRunBlockerSchema),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(false),
  alreadyApplied: z.boolean(),
}).strict().superRefine((run, context) => {
  const blockedProducts = run.products.filter((product) => product.status === "blocked").length;
  const readyProducts = run.products.length - blockedProducts;
  if (
    run.summary.totalProducts !== run.products.length
    || run.summary.blockedProducts !== blockedProducts
    || run.summary.readyProducts !== readyProducts
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message: "Activation summary must match product evidence",
    });
  }
  const expectedState = run.blockers.some((blocker) => blocker.severity === "blocking")
    || blockedProducts > 0
    ? "blocked"
    : "ready_for_publication";
  if (run.state !== expectedState) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["state"],
      message: "Activation state must match blocking evidence",
    });
  }
  if (Date.parse(run.completedAt) < Date.parse(run.startedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedAt"],
      message: "Completion time cannot precede start time",
    });
  }
});

export type RunPlannerClaimSimulationRequest = z.infer<
  typeof runPlannerClaimSimulationRequestSchema
>;
export type PlannerClaimSimulationRun = z.infer<typeof plannerClaimSimulationRunSchema>;
export type RunInventoryActivationDryRunRequest = z.infer<
  typeof runInventoryActivationDryRunRequestSchema
>;
export type ActivationDryRunBlocker = z.infer<typeof activationDryRunBlockerSchema>;
export type CurrentPublicationEvidence = z.infer<typeof currentPublicationEvidenceSchema>;
export type ActivationDryRunProduct = z.infer<typeof activationDryRunProductSchema>;
export type InventoryActivationDryRun = z.infer<typeof inventoryActivationDryRunSchema>;
