import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativeInteger = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const nonblank = (max: number) => z.string().trim().min(1).max(max);

export const inventoryDefinitionLifecycleSchema = z.enum(["draft", "sealed", "retired"]);
export const transformationOperationSchema = z.enum([
  "break_pack",
  "assemble_pack",
  "directed_conversion",
]);
export const transformationAuthoritySchema = z.enum(["allowed", "blocked"]);
export const recipeRelationshipRoleSchema = z.enum([
  "component_build",
  "directional_conversion",
  "disassembly",
]);

export const auditedDraftCommandSchema = z.object({
  actorId: nonblank(100),
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
  requestHash: sha256Hex,
}).strict();

export const transformationBackfillEvidenceSchema = z.object({
  inputHash: sha256Hex,
  resultHash: sha256Hex,
}).strict();

export const locationPromisePolicyDraftSchema = z.object({
  warehouseLocationId: positiveInteger,
  eligibilityMode: z.enum(["inherit", "eligible", "ineligible"]),
}).strict();

export const recipeComponentSnapshotSchema = z.object({
  componentVariantId: positiveInteger,
  componentProductId: positiveInteger,
  componentUnitsPerVariant: positiveInteger,
  componentQty: positiveInteger,
}).strict();

export const transformationRecipeBindingDraftSchema = z.object({
  bindingKey: nonblank(120),
  recipeId: positiveInteger,
  relationshipRole: recipeRelationshipRoleSchema,
  warehouseId: positiveInteger.nullable(),
  recipeCodeSnapshot: nonblank(50),
  recipeVersionSnapshot: positiveInteger,
  recipeDefinitionHash: sha256Hex,
  outputProductIdSnapshot: positiveInteger,
  outputVariantIdSnapshot: positiveInteger,
  outputUnitsPerVariantSnapshot: positiveInteger,
  outputQtySnapshot: positiveInteger,
  components: z.array(recipeComponentSnapshotSchema).min(1),
}).strict();

export const transformationPathDraftSchema = z.object({
  sourceProductId: positiveInteger,
  sourceVariantId: positiveInteger,
  destinationProductId: positiveInteger,
  destinationVariantId: positiveInteger,
  inputQty: positiveInteger,
  outputQty: positiveInteger,
  sourceUnitsPerVariant: positiveInteger,
  destinationUnitsPerVariant: positiveInteger,
  operationType: transformationOperationSchema,
  authorityState: transformationAuthoritySchema,
  transformationRecipeBindingKey: nonblank(120).nullable(),
}).strict();

function compareIntegerTuple(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (leftValue === rightValue) continue;
    return leftValue < rightValue ? -1 : 1;
  }
  return 0;
}

function compareOrdinal(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareRecipeComponents(
  left: z.infer<typeof recipeComponentSnapshotSchema>,
  right: z.infer<typeof recipeComponentSnapshotSchema>,
): number {
  return compareIntegerTuple(
    [
      left.componentVariantId,
      left.componentProductId,
      left.componentUnitsPerVariant,
      left.componentQty,
    ],
    [
      right.componentVariantId,
      right.componentProductId,
      right.componentUnitsPerVariant,
      right.componentQty,
    ],
  );
}

function recipeBindingScopeKey(
  binding: z.infer<typeof transformationRecipeBindingDraftSchema>,
): string {
  return `${binding.recipeId}:${binding.warehouseId ?? "network"}`;
}

function compareRecipeBindings(
  left: z.infer<typeof transformationRecipeBindingDraftSchema>,
  right: z.infer<typeof transformationRecipeBindingDraftSchema>,
): number {
  const recipeOrder = compareIntegerTuple([left.recipeId], [right.recipeId]);
  if (recipeOrder !== 0) return recipeOrder;
  if (left.warehouseId === right.warehouseId) return 0;
  if (left.warehouseId === null) return -1;
  if (right.warehouseId === null) return 1;
  return compareIntegerTuple([left.warehouseId], [right.warehouseId]);
}

function normalizeRecipeBinding(
  binding: z.infer<typeof transformationRecipeBindingDraftSchema>,
): Record<string, unknown> {
  const { bindingKey: _transientBindingKey, ...persistedBinding } = binding;
  return {
    ...persistedBinding,
    components: [...binding.components]
      .sort(compareRecipeComponents),
  };
}

export function calculateRecipeDefinitionHash(
  binding: z.infer<typeof transformationRecipeBindingDraftSchema>,
): string {
  const projection = normalizeRecipeBinding(binding);
  delete projection.recipeDefinitionHash;
  return createHash("sha256").update(canonicalJson(projection), "utf8").digest("hex");
}

function comparePaths(
  left: z.infer<typeof transformationPathDraftSchema>,
  right: z.infer<typeof transformationPathDraftSchema>,
): number {
  const variantOrder = compareIntegerTuple(
    [left.sourceVariantId, left.destinationVariantId],
    [right.sourceVariantId, right.destinationVariantId],
  );
  return variantOrder === 0
    ? compareOrdinal(left.operationType, right.operationType)
    : variantOrder;
}

function pathIdentity(path: z.infer<typeof transformationPathDraftSchema>): string {
  return `${path.sourceVariantId}:${path.destinationVariantId}`;
}

export const transformationModelDefinitionSchema = z.object({
  productId: positiveInteger,
  buildToPromiseEnabled: z.boolean(),
  paths: z.array(transformationPathDraftSchema),
  recipeBindings: z.array(transformationRecipeBindingDraftSchema),
}).strict().superRefine((definition, context) => {
  const bindingsByKey = new Map<string, z.infer<typeof transformationRecipeBindingDraftSchema>>();
  const bindingScopes = new Set<string>();
  definition.recipeBindings.forEach((binding, bindingIndex) => {
    if (bindingsByKey.has(binding.bindingKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipeBindings", bindingIndex, "bindingKey"],
        message: "Recipe binding keys must be unique within a model draft.",
      });
    }
    bindingsByKey.set(binding.bindingKey, binding);

    const bindingScope = recipeBindingScopeKey(binding);
    if (bindingScopes.has(bindingScope)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipeBindings", bindingIndex, "warehouseId"],
        message: "A recipe and warehouse scope may be bound only once within a model draft.",
      });
    }
    bindingScopes.add(bindingScope);

    const componentVariantIds = new Set<number>();
    binding.components.forEach((component, componentIndex) => {
      if (componentVariantIds.has(component.componentVariantId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recipeBindings", bindingIndex, "components", componentIndex, "componentVariantId"],
          message: "A recipe binding may snapshot each component variant only once.",
        });
      }
      componentVariantIds.add(component.componentVariantId);
    });

    if (binding.outputProductIdSnapshot !== definition.productId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipeBindings", bindingIndex, "outputProductIdSnapshot"],
        message: "Recipe output must belong to the model product.",
      });
    }
    if (calculateRecipeDefinitionHash(binding) !== binding.recipeDefinitionHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipeBindings", bindingIndex, "recipeDefinitionHash"],
        message: "Recipe definition hash does not match its immutable scalar and BOM snapshots.",
      });
    }
  });

  if (
    definition.buildToPromiseEnabled
    && !definition.recipeBindings.some((binding) => binding.relationshipRole === "component_build")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["buildToPromiseEnabled"],
      message: "Build-to-promise requires at least one component-build recipe binding.",
    });
  }

  const pathIdentities = new Set<string>();
  definition.paths.forEach((path, pathIndex) => {
    const identity = pathIdentity(path);
    if (pathIdentities.has(identity)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex],
        message: "A directed source/destination pair may have only one authority path.",
      });
    }
    pathIdentities.add(identity);

    if (path.sourceVariantId === path.destinationVariantId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex, "destinationVariantId"],
        message: "A transformation path must connect two different variants.",
      });
    }
    if (
      path.sourceProductId !== definition.productId
      || path.destinationProductId !== definition.productId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex],
        message: "Packaging paths must remain within the model product.",
      });
    }

    const inputBaseUnits = BigInt(path.inputQty) * BigInt(path.sourceUnitsPerVariant);
    const outputBaseUnits = BigInt(path.outputQty) * BigInt(path.destinationUnitsPerVariant);
    const conservesBaseUnits = inputBaseUnits === outputBaseUnits;
    const binding = path.transformationRecipeBindingKey === null
      ? undefined
      : bindingsByKey.get(path.transformationRecipeBindingKey);

    if (
      path.operationType === "break_pack"
      && path.sourceUnitsPerVariant <= path.destinationUnitsPerVariant
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex, "operationType"],
        message: "Break-pack paths must move from a larger package to a smaller package.",
      });
    }
    if (
      path.operationType === "assemble_pack"
      && path.sourceUnitsPerVariant >= path.destinationUnitsPerVariant
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex, "operationType"],
        message: "Assemble-pack paths must move from a smaller package to a larger package.",
      });
    }

    if (path.transformationRecipeBindingKey !== null && !binding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex, "transformationRecipeBindingKey"],
        message: "Transformation path references an unknown recipe binding.",
      });
      return;
    }
    if (path.operationType !== "directed_conversion" && path.transformationRecipeBindingKey !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex, "transformationRecipeBindingKey"],
        message: "Packaging paths cannot acquire recipe authority implicitly.",
      });
    }
    if (path.authorityState === "allowed" && !conservesBaseUnits && !binding) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex],
        message: "An allowed non-conserving path requires an explicit recipe binding.",
      });
    }
    if (!binding) return;

    if (
      binding.relationshipRole !== "directional_conversion"
      || binding.outputVariantIdSnapshot !== path.destinationVariantId
      || binding.outputUnitsPerVariantSnapshot !== path.destinationUnitsPerVariant
      || binding.outputQtySnapshot !== path.outputQty
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex, "transformationRecipeBindingKey"],
        message: "Directed path output does not match its directional recipe binding.",
      });
    }
    if (
      binding.components.length !== 1
      || binding.components[0]?.componentVariantId !== path.sourceVariantId
      || binding.components[0]?.componentUnitsPerVariant !== path.sourceUnitsPerVariant
      || binding.components[0]?.componentQty !== path.inputQty
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths", pathIndex, "transformationRecipeBindingKey"],
        message: "A directional conversion must snapshot exactly its declared source input.",
      });
    }
  });
});

export type TransformationModelDefinition = z.infer<typeof transformationModelDefinitionSchema>;

function persistentPathProjection(
  path: z.infer<typeof transformationPathDraftSchema>,
  bindingsByKey: ReadonlyMap<string, z.infer<typeof transformationRecipeBindingDraftSchema>>,
): Record<string, unknown> {
  const { transformationRecipeBindingKey, ...persistedPath } = path;
  const binding = transformationRecipeBindingKey === null
    ? undefined
    : bindingsByKey.get(transformationRecipeBindingKey);
  return {
    ...persistedPath,
    transformationRecipeBinding: binding
      ? { recipeId: binding.recipeId, warehouseId: binding.warehouseId }
      : null,
  };
}

export function calculateTransformationModelDefinitionHash(
  input: TransformationModelDefinition,
): string {
  const definition = transformationModelDefinitionSchema.parse(input);
  const bindingsByKey = new Map(
    definition.recipeBindings.map((binding) => [binding.bindingKey, binding] as const),
  );
  const projection = {
    productId: definition.productId,
    buildToPromiseEnabled: definition.buildToPromiseEnabled,
    paths: [...definition.paths]
      .sort(comparePaths)
      .map((path) => persistentPathProjection(path, bindingsByKey)),
    recipeBindings: [...definition.recipeBindings]
      .sort(compareRecipeBindings)
      .map(normalizeRecipeBinding),
  };
  return createHash("sha256").update(canonicalJson(projection), "utf8").digest("hex");
}

export function calculateLocationPromisePolicyDefinitionHash(
  input: z.infer<typeof locationPromisePolicyDraftSchema>,
): string {
  const definition = locationPromisePolicyDraftSchema.parse(input);
  return createHash("sha256").update(canonicalJson(definition), "utf8").digest("hex");
}

export const safetyPolicyScopeSchema = z.discriminatedUnion("scopeType", [
  z.object({ scopeType: z.literal("business") }).strict(),
  z.object({ scopeType: z.literal("network_variant"), productVariantId: positiveInteger }).strict(),
  z.object({
    scopeType: z.literal("warehouse_variant"),
    warehouseId: positiveInteger,
    productVariantId: positiveInteger,
  }).strict(),
]);

export function safetyPolicyScopeKey(scope: z.infer<typeof safetyPolicyScopeSchema>): string {
  switch (scope.scopeType) {
    case "business":
      return "business";
    case "network_variant":
      return `network:variant:${scope.productVariantId}`;
    case "warehouse_variant":
      return `warehouse:${scope.warehouseId}:variant:${scope.productVariantId}`;
  }
}

export const safetyPolicyValueSchema = z.discriminatedUnion("policyMode", [
  z.object({ policyMode: z.literal("inherit") }).strict(),
  z.object({ policyMode: z.literal("off") }).strict(),
  z.object({ policyMode: z.literal("fixed_units"), fixedUnits: nonnegativeInteger }).strict(),
  z.object({
    policyMode: z.literal("days_of_cover"),
    daysOfCoverMilliDays: positiveInteger,
    untrustedDemandFallbackUnits: nonnegativeInteger,
    demandMethodVersion: nonblank(60),
  }).strict(),
]);

export const promiseSafetyPolicyDraftSchema = z.object({
  scope: safetyPolicyScopeSchema,
  value: safetyPolicyValueSchema,
}).strict().superRefine((draft, context) => {
  if (draft.scope.scopeType === "business" && draft.value.policyMode === "inherit") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value", "policyMode"],
      message: "The business safety policy cannot inherit from another scope.",
    });
  }
});

export function calculatePromiseSafetyPolicyDefinitionHash(
  input: z.infer<typeof promiseSafetyPolicyDraftSchema>,
): string {
  const definition = promiseSafetyPolicyDraftSchema.parse(input);
  return createHash("sha256").update(canonicalJson(definition), "utf8").digest("hex");
}

export function calculateMasterDataDraftRequestHash(
  commandType:
    | "transformation_model"
    | "transformation_model_backfill_refresh"
    | "transformation_model_draft_update"
    | "location_promise_policy"
    | "promise_safety_policy",
  input: {
    actorId: string;
    changeReason: string;
    definition: unknown;
  },
): string {
  return createHash("sha256")
    .update(canonicalJson({ commandType, ...input }), "utf8")
    .digest("hex");
}

export class InventoryAvailabilityMasterDataError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "InventoryAvailabilityMasterDataError";
  }
}

export const demandEvidenceSnapshotSchema = z.object({
  productVariantId: positiveInteger,
  warehouseId: positiveInteger.nullable(),
  windowStartedAt: z.coerce.date(),
  windowEndedAt: z.coerce.date(),
  irreversibleConsumptionUnits: z.bigint().nonnegative(),
  observedDays: positiveInteger,
  dailyDemandMilliUnits: z.bigint().nonnegative(),
  trustStatus: z.enum(["trusted", "untrusted", "overridden"]),
  trustReasons: z.array(nonblank(500)),
  methodVersion: nonblank(60),
  inputFingerprint: sha256Hex,
  calculatedAt: z.coerce.date(),
  override: z.object({
    actorId: nonblank(100),
    reason: nonblank(1000),
    expiresAt: z.coerce.date(),
  }).strict().nullable(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.windowEndedAt <= snapshot.windowStartedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["windowEndedAt"],
      message: "Demand evidence window must end after it starts.",
    });
  }
  if (snapshot.calculatedAt < snapshot.windowEndedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["calculatedAt"],
      message: "Demand evidence cannot be calculated before its observation window ends.",
    });
  }
  if (snapshot.trustStatus === "overridden") {
    if (!snapshot.override || snapshot.override.expiresAt <= snapshot.calculatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["override"],
        message: "Overridden demand evidence requires a future-expiring override.",
      });
    }
  } else if (snapshot.override !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["override"],
      message: "Only overridden demand evidence may carry override evidence.",
    });
  }
});

export interface InventoryAvailabilityMasterDataRepository {
  createTransformationModelDraft(
    command: z.infer<typeof auditedDraftCommandSchema> & {
      definition: TransformationModelDefinition;
      backfillEvidence?: z.infer<typeof transformationBackfillEvidenceSchema>;
      occurredAt: Date;
    },
  ): Promise<{ modelId: number; version: number; definitionHash: string; alreadyApplied: boolean }>;
  updateTransformationModelDraft(
    command: z.infer<typeof auditedDraftCommandSchema> & {
      productId: number;
      draftModelId: number;
      expectedVersion: number;
      expectedDefinitionHash: string;
      expectedHeadRevision: string;
      definition: TransformationModelDefinition;
      occurredAt: Date;
    },
  ): Promise<{ modelId: number; version: number; definitionHash: string; alreadyApplied: boolean }>;
  supersedeTransformationModelBackfillDraft(
    command: z.infer<typeof auditedDraftCommandSchema> & {
      productId: number;
      draftModelId: number;
      expectedDraftVersion: number;
      expectedDraftDefinitionHash: string;
      expectedDraftHeadRevision: string;
      expectedDraftOriginInputHash: string;
      expectedDraftOriginResultHash: string;
      definition: TransformationModelDefinition;
      backfillEvidence: z.infer<typeof transformationBackfillEvidenceSchema>;
      occurredAt: Date;
    },
  ): Promise<{
    modelId: number;
    version: number;
    definitionHash: string;
    supersededModelId: number;
    alreadyApplied: boolean;
  }>;
  createLocationPromisePolicyDraft(
    command: z.infer<typeof auditedDraftCommandSchema>
      & z.infer<typeof locationPromisePolicyDraftSchema>
      & { occurredAt: Date },
  ): Promise<{ policyId: number; version: number; alreadyApplied: boolean }>;
  createPromiseSafetyPolicyDraft(
    command: z.infer<typeof auditedDraftCommandSchema>
      & z.infer<typeof promiseSafetyPolicyDraftSchema>
      & { occurredAt: Date },
  ): Promise<{ policyId: number; version: number; scopeKey: string; alreadyApplied: boolean }>;
}
