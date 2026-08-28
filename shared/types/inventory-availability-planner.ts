import { z } from "zod";

import { PRODUCT_INVENTORY_STRATEGIES } from "../catalog/inventory-strategy";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const POSTGRES_BIGINT_MIN = -POSTGRES_BIGINT_MAX - BigInt(1);
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const plannerNonnegativeQuantitySchema = z.string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= POSTGRES_BIGINT_MAX, {
    message: "Must be a nonnegative PostgreSQL bigint decimal string",
  });

export const plannerPositiveQuantitySchema = plannerNonnegativeQuantitySchema.refine(
  (value) => BigInt(value) > BigInt(0),
  { message: "Must be a positive PostgreSQL bigint decimal string" },
);

export const plannerSignedQuantitySchema = z.string()
  .regex(/^(0|[1-9]\d{0,18}|-[1-9]\d{0,18})$/)
  .refine((value) => {
    const parsed = BigInt(value);
    return parsed >= POSTGRES_BIGINT_MIN && parsed <= POSTGRES_BIGINT_MAX;
  }, {
    message: "Must be a PostgreSQL bigint decimal string",
  });

export const plannerLifecycleSelectionSchema = z.enum(["draft_head", "active_head"]);

export const plannerVariantSchema = z.object({
  id: positiveInteger,
  productId: positiveInteger,
  sku: z.string().max(100).nullable(),
  name: z.string(),
  unitsPerVariant: positiveInteger,
  isActive: z.boolean(),
}).strict();

export const plannerWarehouseSchema = z.object({
  id: positiveInteger,
  code: nonblank(20),
  isActive: z.boolean(),
  hubWarehouseId: positiveInteger.nullable(),
}).strict();

export const plannerLocationPolicySchema = z.object({
  policyId: positiveInteger,
  version: positiveInteger,
  lifecycleSelection: plannerLifecycleSelectionSchema,
  eligibilityMode: z.enum(["inherit", "eligible", "ineligible"]),
  definitionHash: sha256Hex,
}).strict();

export const plannerLocationSchema = z.object({
  id: positiveInteger,
  warehouseId: positiveInteger.nullable(),
  code: nonblank(50),
  locationType: nonblank(30),
  isPickable: z.boolean(),
  isActive: z.boolean(),
  isFrozen: z.boolean(),
  promisePolicy: plannerLocationPolicySchema.nullable(),
}).strict();

export const plannerInventoryPositionSchema = z.object({
  inventoryLevelId: positiveInteger,
  warehouseLocationId: positiveInteger,
  productVariantId: positiveInteger,
  variantQty: plannerSignedQuantitySchema,
  reservedQty: plannerSignedQuantitySchema,
  pickedQty: plannerSignedQuantitySchema,
  packedQty: plannerSignedQuantitySchema,
}).strict();

export const plannerSafetyPolicySchema = z.object({
  policyId: positiveInteger,
  version: positiveInteger,
  lifecycleSelection: plannerLifecycleSelectionSchema,
  scopeKey: nonblank(160),
  scopeType: z.enum(["business", "network_variant", "warehouse_variant"]),
  productVariantId: positiveInteger.nullable(),
  warehouseId: positiveInteger.nullable(),
  policyMode: z.enum(["inherit", "off", "fixed_units", "days_of_cover"]),
  fixedUnits: plannerNonnegativeQuantitySchema.nullable(),
  daysOfCoverMilliDays: plannerPositiveQuantitySchema.nullable(),
  untrustedDemandFallbackUnits: plannerNonnegativeQuantitySchema.nullable(),
  demandMethodVersion: z.string().max(60).nullable(),
  definitionHash: sha256Hex,
}).strict();

export const plannerDemandEvidenceSchema = z.object({
  evidenceId: plannerPositiveQuantitySchema,
  productVariantId: positiveInteger,
  warehouseId: positiveInteger.nullable(),
  dailyDemandMilliUnits: plannerNonnegativeQuantitySchema,
  trustStatus: z.enum(["trusted", "untrusted", "overridden"]),
  trustReasons: z.array(nonblank(500)),
  methodVersion: nonblank(60),
  inputFingerprint: sha256Hex,
  overrideExpiresAt: z.string().datetime().nullable(),
  calculatedAt: z.string().datetime(),
}).strict();

export const plannerTransformationPathSchema = z.object({
  pathId: positiveInteger,
  sourceVariantId: positiveInteger,
  destinationVariantId: positiveInteger,
  inputQty: plannerPositiveQuantitySchema,
  outputQty: plannerPositiveQuantitySchema,
  sourceUnitsPerVariant: positiveInteger,
  destinationUnitsPerVariant: positiveInteger,
  operationType: z.enum(["break_pack", "assemble_pack", "directed_conversion"]),
  authorityState: z.enum(["allowed", "blocked"]),
  validationState: z.enum(["valid", "invalid"]),
  validationErrors: z.array(z.unknown()),
  transformationRecipeBindingId: positiveInteger.nullable(),
}).strict();

export const plannerRecipeComponentSchema = z.object({
  componentVariantId: positiveInteger,
  componentProductId: positiveInteger,
  componentUnitsPerVariant: positiveInteger,
  componentQty: plannerPositiveQuantitySchema,
}).strict();

export const plannerRecipeBindingSchema = z.object({
  bindingId: positiveInteger,
  recipeId: positiveInteger,
  relationshipRole: z.enum(["component_build", "directional_conversion", "disassembly"]),
  warehouseId: positiveInteger.nullable(),
  recipeCodeSnapshot: nonblank(50),
  recipeVersionSnapshot: positiveInteger,
  recipeDefinitionHash: sha256Hex,
  outputProductId: positiveInteger,
  outputVariantId: positiveInteger,
  outputUnitsPerVariant: positiveInteger,
  outputQty: plannerPositiveQuantitySchema,
  validationState: z.enum(["valid", "invalid"]),
  validationErrors: z.array(z.unknown()),
  components: z.array(plannerRecipeComponentSchema).min(1),
}).strict();

export const plannerTransformationModelSchema = z.object({
  modelId: positiveInteger,
  productId: positiveInteger,
  version: positiveInteger,
  lifecycleSelection: plannerLifecycleSelectionSchema,
  lifecycleStatus: z.enum(["draft", "sealed", "retired"]),
  buildToPromiseEnabled: z.boolean(),
  definitionHash: sha256Hex,
  validationState: z.enum(["valid", "invalid"]),
  validationErrors: z.array(z.unknown()),
  paths: z.array(plannerTransformationPathSchema),
  recipeBindings: z.array(plannerRecipeBindingSchema),
}).strict();

export const plannerLegacyRecipeSchema = z.object({
  recipeId: positiveInteger,
  outputProductId: positiveInteger,
  outputVariantId: positiveInteger,
  outputQty: plannerPositiveQuantitySchema,
  components: z.array(z.object({
    componentProductId: positiveInteger,
    componentVariantId: positiveInteger,
    componentQty: plannerPositiveQuantitySchema,
  }).strict()).min(1),
}).strict();

export const plannerOutputLocationSchema = z.object({
  productVariantId: positiveInteger,
  warehouseId: positiveInteger,
  warehouseLocationId: positiveInteger,
}).strict();

export const supplySnapshotContentSchema = z.object({
  schemaVersion: z.literal("inventory_availability_snapshot_v1"),
  capturedAt: z.string().datetime(),
  productId: positiveInteger,
  legacyInventoryStrategy: z.enum(PRODUCT_INVENTORY_STRATEGIES),
  variants: z.array(plannerVariantSchema),
  warehouses: z.array(plannerWarehouseSchema),
  locations: z.array(plannerLocationSchema),
  inventoryPositions: z.array(plannerInventoryPositionSchema),
  safetyPolicies: z.array(plannerSafetyPolicySchema),
  demandEvidence: z.array(plannerDemandEvidenceSchema),
  transformationModels: z.array(plannerTransformationModelSchema),
  legacyRecipes: z.array(plannerLegacyRecipeSchema),
  outputLocations: z.array(plannerOutputLocationSchema),
  claimProjectionSource: z.literal("inventory_levels.reserved_qty"),
}).strict();

export const supplySnapshotSchema = supplySnapshotContentSchema.extend({
  snapshotFingerprint: sha256Hex,
}).strict();

export const fulfillmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("warehouse"), warehouseId: positiveInteger }).strict(),
  z.object({ kind: z.literal("network") }).strict(),
]);

export const atpProjectionRequestSchema = z.object({
  targetVariantId: positiveInteger,
  scope: fulfillmentScopeSchema,
}).strict();

export const plannerBlockerSchema = z.object({
  code: nonblank(100),
  message: nonblank(1000),
  context: z.record(z.unknown()),
}).strict();

export const atpProjectionSchema = z.object({
  targetVariantId: positiveInteger,
  scope: fulfillmentScopeSchema,
  status: z.enum(["ready", "blocked"]),
  atpUnits: plannerNonnegativeQuantitySchema,
  atpBaseUnits: plannerNonnegativeQuantitySchema,
  exactPhysicalUnits: plannerNonnegativeQuantitySchema,
  claimedUnits: plannerNonnegativeQuantitySchema,
  protectedUnits: plannerNonnegativeQuantitySchema,
  directUnits: plannerNonnegativeQuantitySchema,
  convertibleUnits: plannerNonnegativeQuantitySchema,
  buildableUnits: plannerNonnegativeQuantitySchema,
  snapshotFingerprint: sha256Hex,
  modelEvidence: z.array(z.object({
    productId: positiveInteger,
    modelId: positiveInteger,
    version: positiveInteger,
    definitionHash: sha256Hex,
    lifecycleSelection: plannerLifecycleSelectionSchema,
  }).strict()),
  safetyEvidence: z.array(z.object({
    warehouseId: positiveInteger,
    productVariantId: positiveInteger,
    policyId: positiveInteger.nullable(),
    policyMode: z.enum(["implicit_off", "off", "fixed_units", "days_of_cover"]),
    protectedUnits: plannerNonnegativeQuantitySchema,
    demandEvidenceId: plannerPositiveQuantitySchema.nullable(),
  }).strict()),
  blockers: z.array(plannerBlockerSchema),
}).strict();

export const claimPlanRequestSchema = z.object({
  requestKey: nonblank(200),
  scope: fulfillmentScopeSchema,
  lines: z.array(z.object({
    lineKey: nonblank(200),
    targetVariantId: positiveInteger,
    requestedQty: plannerPositiveQuantitySchema,
  }).strict()).min(1).max(500),
}).strict();

export const resourceClaimSegmentSchema = z.object({
  lineKey: nonblank(200),
  warehouseId: positiveInteger,
  warehouseLocationId: positiveInteger,
  inventoryLevelId: positiveInteger,
  sourceVariantId: positiveInteger,
  claimedQty: plannerPositiveQuantitySchema,
}).strict();

export const plannerOperationSchema = z.object({
  lineKey: nonblank(200),
  warehouseId: positiveInteger,
  operationKey: nonblank(300),
  operationType: z.enum(["break_pack", "assemble_pack", "directed_conversion", "component_build"]),
  authorityId: positiveInteger,
  sourceVariantIds: z.array(positiveInteger).min(1),
  destinationVariantId: positiveInteger,
  plannedExecutions: plannerPositiveQuantitySchema,
  outputQty: plannerPositiveQuantitySchema,
  outputLocationId: positiveInteger.nullable(),
}).strict();

export const claimPlanSchema = z.object({
  requestKey: nonblank(200),
  scope: fulfillmentScopeSchema,
  status: z.enum(["satisfied", "partial", "blocked"]),
  lines: z.array(z.object({
    lineKey: nonblank(200),
    targetVariantId: positiveInteger,
    requestedQty: plannerPositiveQuantitySchema,
    plannedQty: plannerNonnegativeQuantitySchema,
    shortfallQty: plannerNonnegativeQuantitySchema,
  }).strict()),
  resourceClaims: z.array(resourceClaimSegmentSchema),
  operations: z.array(plannerOperationSchema),
  blockers: z.array(plannerBlockerSchema),
  snapshotFingerprint: sha256Hex,
}).strict();

export const plannerShadowClassificationSchema = z.enum([
  "match",
  "legacy_double_subtract_custody",
  "location_eligibility",
  "aggregate_claim_clamp",
  "directed_transformation",
  "build_to_promise",
  "promise_safety_stock",
  "legacy_strategy_pooling",
  "configuration_blocker",
  "unexplained",
]);

export const plannerShadowResultSchema = z.object({
  warehouseId: positiveInteger.nullable(),
  warehouseCodeSnapshot: z.string().trim().min(1).max(20).nullable(),
  productVariantId: positiveInteger,
  productVariantSkuSnapshot: z.string().max(100).nullable(),
  productVariantNameSnapshot: z.string(),
  productVariantUnitsPerVariantSnapshot: positiveInteger,
  legacyAtpUnits: plannerNonnegativeQuantitySchema,
  legacyAtpBaseUnits: plannerNonnegativeQuantitySchema,
  proposedAtpUnits: plannerNonnegativeQuantitySchema,
  differenceUnits: plannerSignedQuantitySchema,
  readinessState: z.enum(["ready", "blocked"]),
  classifications: z.array(plannerShadowClassificationSchema).min(1),
  proposedProjection: atpProjectionSchema,
}).strict().superRefine((result, context) => {
  if ((result.warehouseId === null) !== (result.warehouseCodeSnapshot === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["warehouseCodeSnapshot"],
      message: "Network results have no warehouse code; warehouse results require one",
    });
  }
  if (result.productVariantId !== result.proposedProjection.targetVariantId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["productVariantId"],
      message: "Result variant must match the proposed projection",
    });
  }
  const scopeMatches = result.warehouseId === null
    ? result.proposedProjection.scope.kind === "network"
    : result.proposedProjection.scope.kind === "warehouse"
      && result.proposedProjection.scope.warehouseId === result.warehouseId;
  if (!scopeMatches) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["warehouseId"],
      message: "Result warehouse must match the proposed projection scope",
    });
  }
  if (result.proposedAtpUnits !== result.proposedProjection.atpUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["proposedAtpUnits"],
      message: "Result proposed ATP must match the proposed projection",
    });
  }
  if (result.readinessState !== result.proposedProjection.status) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["readinessState"],
      message: "Result readiness must match the proposed projection",
    });
  }
  if (BigInt(result.differenceUnits) !== BigInt(result.proposedAtpUnits) - BigInt(result.legacyAtpUnits)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["differenceUnits"],
      message: "Difference must equal proposed ATP minus legacy ATP",
    });
  }
});

export const plannerShadowRunSchema = z.object({
  runId: plannerPositiveQuantitySchema,
  productId: positiveInteger,
  legacyInventoryStrategy: z.enum(PRODUCT_INVENTORY_STRATEGIES),
  status: z.enum(["completed", "blocked"]),
  snapshotFingerprint: sha256Hex,
  capturedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  requestedBy: nonblank(100),
  modelId: positiveInteger.nullable(),
  modelVersion: positiveInteger.nullable(),
  modelDefinitionHash: sha256Hex.nullable(),
  blockerCodes: z.array(nonblank(100)),
  results: z.array(plannerShadowResultSchema),
  alreadyApplied: z.boolean(),
}).strict().superRefine((run, context) => {
  if (Date.parse(run.completedAt) < Date.parse(run.capturedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedAt"],
      message: "Completion time cannot precede snapshot capture time",
    });
  }
  const modelFields = [run.modelId, run.modelVersion, run.modelDefinitionHash];
  const modelFieldCount = modelFields.filter((value) => value !== null).length;
  if (modelFieldCount !== 0 && modelFieldCount !== modelFields.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelId"],
      message: "Model id, version, and definition hash must be all present or all absent",
    });
  }
  const expectedBlockerCodes = [...new Set(run.results.flatMap((result) =>
    result.proposedProjection.blockers.map((blocker) => blocker.code)))].sort();
  if (run.results.some((result) =>
    result.proposedProjection.snapshotFingerprint !== run.snapshotFingerprint)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["results"],
      message: "Every result must reference the run snapshot fingerprint",
    });
  }
  if (JSON.stringify([...run.blockerCodes].sort()) !== JSON.stringify(expectedBlockerCodes)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blockerCodes"],
      message: "Run blocker codes must equal the projection blocker evidence",
    });
  }
  const expectedStatus = run.results.some((result) => result.readinessState === "blocked")
    ? "blocked"
    : "completed";
  if (run.status !== expectedStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Run status must match result readiness",
    });
  }
});

export const runPlannerShadowRequestSchema = z.object({
  idempotencyKey: nonblank(120),
}).strict();

export type SupplySnapshotContentDto = z.infer<typeof supplySnapshotContentSchema>;
export type SupplySnapshotDto = z.infer<typeof supplySnapshotSchema>;
export type AtpProjectionRequestDto = z.infer<typeof atpProjectionRequestSchema>;
export type AtpProjectionDto = z.infer<typeof atpProjectionSchema>;
export type ClaimPlanRequestDto = z.infer<typeof claimPlanRequestSchema>;
export type ClaimPlanDto = z.infer<typeof claimPlanSchema>;
export type PlannerBlockerDto = z.infer<typeof plannerBlockerSchema>;
export type PlannerShadowClassification = z.infer<typeof plannerShadowClassificationSchema>;
export type PlannerShadowResultDto = z.infer<typeof plannerShadowResultSchema>;
export type PlannerShadowRunDto = z.infer<typeof plannerShadowRunSchema>;
export type RunPlannerShadowRequest = z.infer<typeof runPlannerShadowRequestSchema>;
