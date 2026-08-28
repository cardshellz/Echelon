import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import {
  atpProjectionRequestSchema,
  atpProjectionSchema,
  claimSupplySnapshotContentSchema,
  claimSupplySnapshotSchema,
  claimPlanRequestSchema,
  claimPlanSchema,
  supplySnapshotContentSchema,
  supplySnapshotSchema,
  type AtpProjectionDto,
  type AtpProjectionRequestDto,
  type ClaimSupplySnapshotContentDto,
  type ClaimSupplySnapshotDto,
  type ClaimPlanDto,
  type ClaimPlanRequestDto,
  type PlannerBlockerDto,
  type PlannerShadowClassification,
  type SupplySnapshotContentDto,
  type SupplySnapshotDto,
} from "@shared/types/inventory-availability-planner";
import {
  calculateRecipeCapacity,
  type RecipeDefinition,
  type WarehouseRecipeSnapshot,
} from "../../inventory/domain/recipe-capacity.domain";

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
const MILLI_UNITS_SQUARED = BigInt(1_000_000);
const PROMISE_ELIGIBLE_LOCATION_TYPES = new Set(["pick", "reserve"]);
const HARD_INELIGIBLE_LOCATION_TYPES = new Set(["receiving", "staging", "quarantine"]);

type Scope = AtpProjectionRequestDto["scope"];
type Variant = SupplySnapshotDto["variants"][number];
type Location = SupplySnapshotDto["locations"][number];
type Position = SupplySnapshotDto["inventoryPositions"][number];
type Model = SupplySnapshotDto["transformationModels"][number];
type Path = Model["paths"][number];
type Recipe = Model["recipeBindings"][number];
type SafetyEvidence = AtpProjectionDto["safetyEvidence"][number];
type PlannerSupplySnapshot = SupplySnapshotDto | ClaimSupplySnapshotDto;

type Resource = {
  inventoryLevelId: number;
  warehouseLocationId: number;
  variantId: number;
  remainingQty: bigint;
};

type ResourceClaim = {
  lineKey: string;
  warehouseId: number;
  warehouseLocationId: number;
  inventoryLevelId: number;
  sourceVariantId: number;
  claimedQty: bigint;
};

type PlannedOperation = {
  lineKey: string;
  warehouseId: number;
  operationKey: string;
  operationType: "break_pack" | "assemble_pack" | "directed_conversion" | "component_build";
  authorityId: number;
  sourceVariantIds: number[];
  destinationVariantId: number;
  plannedExecutions: bigint;
  outputQty: bigint;
  outputLocationId: number | null;
};

type Breakdown = { total: bigint; direct: bigint; convertible: bigint; buildable: bigint };

type Context = {
  snapshot: PlannerSupplySnapshot;
  warehouseId: number;
  variantsById: ReadonlyMap<number, Variant>;
  resourcesByVariant: Map<number, Resource[]>;
  pathsByDestination: ReadonlyMap<number, Path[]>;
  recipesByOutput: ReadonlyMap<number, Recipe[]>;
  outputLocations: ReadonlyMap<number, number>;
  blockers: PlannerBlockerDto[];
  safetyEvidence: SafetyEvidence[];
  resourceClaims: ResourceClaim[];
  operations: PlannedOperation[];
  directEvidence: ReadonlyMap<number, { exactPhysical: bigint; claims: bigint; protected: bigint }>;
  simulation: boolean;
};

export class InventoryAvailabilityPlannerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "InventoryAvailabilityPlannerError";
  }
}

function qty(value: string, field: string): bigint {
  try {
    return BigInt(value);
  } catch (cause) {
    throw new InventoryAvailabilityPlannerError(
      "INVALID_PLANNER_QUANTITY",
      `${field} must be an integer decimal string`,
      { field, value, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function clamp(value: bigint): bigint {
  return value < BigInt(0) ? BigInt(0) : value;
}

function add(left: bigint, right: bigint, field: string): bigint {
  const result = left + right;
  if (result < BigInt(0) || result > POSTGRES_BIGINT_MAX) {
    throw new InventoryAvailabilityPlannerError(
      "PLANNER_QUANTITY_OVERFLOW",
      `${field} exceeds the supported quantity range`,
      { left: left.toString(), right: right.toString() },
    );
  }
  return result;
}

function multiply(left: bigint, right: bigint, field: string): bigint {
  if (left < BigInt(0) || right < BigInt(0) || left * right > POSTGRES_BIGINT_MAX) {
    throw new InventoryAvailabilityPlannerError(
      "PLANNER_QUANTITY_OVERFLOW",
      `${field} exceeds the supported quantity range`,
      { left: left.toString(), right: right.toString() },
    );
  }
  return left * right;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) {
    throw new InventoryAvailabilityPlannerError(
      "INVALID_TRANSFORMATION_RATIO",
      "Transformation denominator must be positive",
      { denominator: denominator.toString() },
    );
  }
  return numerator === BigInt(0) ? BigInt(0) : ((numerator - BigInt(1)) / denominator) + BigInt(1);
}

function problem(code: string, message: string, context: Record<string, unknown> = {}): PlannerBlockerDto {
  return { code, message, context };
}

function uniqueProblems(problems: readonly PlannerBlockerDto[]): PlannerBlockerDto[] {
  const byKey = new Map<string, PlannerBlockerDto>();
  for (const entry of problems) {
    const key = `${entry.code}:${canonicalJson(entry.context)}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((left, right) =>
    left.code.localeCompare(right.code)
    || canonicalJson(left.context).localeCompare(canonicalJson(right.context)));
}

export function calculateSupplySnapshotFingerprint(raw: SupplySnapshotContentDto): string {
  const content = supplySnapshotContentSchema.parse(raw);
  const { capturedAt: _capturedAt, ...state } = content;
  return createHash("sha256").update(canonicalJson(state), "utf8").digest("hex");
}

export function sealSupplySnapshot(raw: SupplySnapshotContentDto): SupplySnapshotDto {
  const content = supplySnapshotContentSchema.parse(raw);
  return supplySnapshotSchema.parse({
    ...content,
    snapshotFingerprint: calculateSupplySnapshotFingerprint(content),
  });
}

export function calculateClaimSupplySnapshotFingerprint(
  raw: ClaimSupplySnapshotContentDto,
): string {
  const content = claimSupplySnapshotContentSchema.parse(raw);
  const { capturedAt: _capturedAt, ...state } = content;
  return createHash("sha256").update(canonicalJson(state), "utf8").digest("hex");
}

export function sealClaimSupplySnapshot(
  raw: ClaimSupplySnapshotContentDto,
): ClaimSupplySnapshotDto {
  const content = claimSupplySnapshotContentSchema.parse(raw);
  return claimSupplySnapshotSchema.parse({
    ...content,
    snapshotFingerprint: calculateClaimSupplySnapshotFingerprint(content),
  });
}

function assertUnique(values: readonly (number | string)[], field: string): void {
  const seen = new Set<number | string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new InventoryAvailabilityPlannerError(
        "SUPPLY_SNAPSHOT_DUPLICATE_EVIDENCE",
        `${field} contains duplicate evidence.`,
        { field, value },
      );
    }
    seen.add(value);
  }
}

function rootProductIds(snapshot: PlannerSupplySnapshot): number[] {
  return snapshot.schemaVersion === "inventory_availability_snapshot_v1"
    ? [snapshot.productId]
    : snapshot.rootProducts.map((root) => root.productId);
}

function assertSnapshotReferences(snapshot: PlannerSupplySnapshot): void {
  assertUnique(snapshot.variants.map((entry) => entry.id), "variants.id");
  assertUnique(snapshot.warehouses.map((entry) => entry.id), "warehouses.id");
  assertUnique(snapshot.locations.map((entry) => entry.id), "locations.id");
  assertUnique(snapshot.inventoryPositions.map((entry) => entry.inventoryLevelId), "inventoryPositions.id");
  assertUnique(snapshot.safetyPolicies.map((entry) => entry.policyId), "safetyPolicies.id");
  assertUnique(snapshot.safetyPolicies.map((entry) => entry.scopeKey), "safetyPolicies.scopeKey");
  assertUnique(snapshot.demandEvidence.map((entry) => entry.evidenceId), "demandEvidence.id");
  assertUnique(snapshot.transformationModels.map((entry) => entry.modelId), "transformationModels.id");
  assertUnique(snapshot.legacyRecipes.map((entry) => entry.recipeId), "legacyRecipes.id");
  assertUnique(snapshot.outputLocations.map((entry) =>
    `${entry.warehouseId}:${entry.productVariantId}`), "outputLocations.scopeVariant");
  const roots = rootProductIds(snapshot);
  assertUnique(roots, "rootProducts.productId");

  const variants = new Map(snapshot.variants.map((entry) => [entry.id, entry] as const));
  const warehouses = new Set(snapshot.warehouses.map((entry) => entry.id));
  const locations = new Map(snapshot.locations.map((entry) => [entry.id, entry] as const));
  const invalid = (field: string, value: unknown, message: string): never => {
    throw new InventoryAvailabilityPlannerError(
      "SUPPLY_SNAPSHOT_REFERENCE_INVALID",
      message,
      { field, value },
    );
  };

  for (const productId of roots) {
    if (!snapshot.variants.some((variant) => variant.productId === productId && variant.isActive)) {
      invalid(
        "rootProducts.productId",
        productId,
        "A claim snapshot root product must contain at least one active target variant.",
      );
    }
  }

  for (const location of snapshot.locations) {
    if (location.warehouseId !== null && !warehouses.has(location.warehouseId)) {
      invalid("locations.warehouseId", location.warehouseId, "A location references an unknown warehouse.");
    }
  }
  for (const position of snapshot.inventoryPositions) {
    if (!variants.has(position.productVariantId)) {
      invalid(
        "inventoryPositions.productVariantId",
        position.productVariantId,
        "An inventory position references an unknown variant.",
      );
    }
    if (!locations.has(position.warehouseLocationId)) {
      invalid(
        "inventoryPositions.warehouseLocationId",
        position.warehouseLocationId,
        "An inventory position references an unknown location.",
      );
    }
  }
  for (const policy of snapshot.safetyPolicies) {
    if (policy.productVariantId !== null && !variants.has(policy.productVariantId)) {
      invalid("safetyPolicies.productVariantId", policy.productVariantId, "A safety policy references an unknown variant.");
    }
    if (policy.warehouseId !== null && !warehouses.has(policy.warehouseId)) {
      invalid("safetyPolicies.warehouseId", policy.warehouseId, "A safety policy references an unknown warehouse.");
    }
  }
  for (const evidence of snapshot.demandEvidence) {
    if (!variants.has(evidence.productVariantId)) {
      invalid("demandEvidence.productVariantId", evidence.productVariantId, "Demand evidence references an unknown variant.");
    }
    if (evidence.warehouseId !== null && !warehouses.has(evidence.warehouseId)) {
      invalid("demandEvidence.warehouseId", evidence.warehouseId, "Demand evidence references an unknown warehouse.");
    }
  }
  for (const model of snapshot.transformationModels) {
    const bindingIds = new Set(model.recipeBindings.map((binding) => binding.bindingId));
    assertUnique(model.paths.map((entry) => entry.pathId), `transformationModels.${model.modelId}.paths.id`);
    assertUnique(
      model.recipeBindings.map((binding) => binding.bindingId),
      `transformationModels.${model.modelId}.bindings.id`,
    );
    for (const path of model.paths) {
      const source = variants.get(path.sourceVariantId);
      const destination = variants.get(path.destinationVariantId);
      if (!source || source.productId !== model.productId) {
        invalid("transformationPaths.sourceVariantId", path.sourceVariantId, "A path source is outside its model product.");
      }
      if (!destination || destination.productId !== model.productId) {
        invalid("transformationPaths.destinationVariantId", path.destinationVariantId, "A path destination is outside its model product.");
      }
      if (path.transformationRecipeBindingId !== null
        && !bindingIds.has(path.transformationRecipeBindingId)) {
        invalid(
          "transformationPaths.transformationRecipeBindingId",
          path.transformationRecipeBindingId,
          "A path references an unknown model recipe binding.",
        );
      }
    }
    for (const binding of model.recipeBindings) {
      assertUnique(
        binding.components.map((component) => component.componentVariantId),
        `transformationModels.${model.modelId}.bindings.${binding.bindingId}.componentVariantId`,
      );
      const output = variants.get(binding.outputVariantId);
      if (!output || output.productId !== binding.outputProductId) {
        invalid("recipeBindings.outputVariantId", binding.outputVariantId, "A recipe binding output snapshot is inconsistent.");
      }
      if (binding.warehouseId !== null && !warehouses.has(binding.warehouseId)) {
        invalid("recipeBindings.warehouseId", binding.warehouseId, "A recipe binding references an unknown warehouse.");
      }
      for (const component of binding.components) {
        const variant = variants.get(component.componentVariantId);
        if (!variant || variant.productId !== component.componentProductId) {
          invalid(
            "recipeBindings.components.componentVariantId",
            component.componentVariantId,
            "A recipe component snapshot is inconsistent.",
          );
        }
      }
    }
  }
  for (const recipe of snapshot.legacyRecipes) {
    const output = variants.get(recipe.outputVariantId);
    if (!output || output.productId !== recipe.outputProductId) {
      invalid("legacyRecipes.outputVariantId", recipe.outputVariantId, "A legacy recipe output is inconsistent.");
    }
    for (const component of recipe.components) {
      const variant = variants.get(component.componentVariantId);
      if (!variant || variant.productId !== component.componentProductId) {
        invalid("legacyRecipes.componentVariantId", component.componentVariantId, "A legacy recipe component is inconsistent.");
      }
    }
  }
  for (const assignment of snapshot.outputLocations) {
    const location = locations.get(assignment.warehouseLocationId);
    if (!variants.has(assignment.productVariantId)) {
      invalid("outputLocations.productVariantId", assignment.productVariantId, "An output assignment references an unknown variant.");
    }
    if (!location || location.warehouseId !== assignment.warehouseId) {
      invalid("outputLocations.warehouseLocationId", assignment.warehouseLocationId, "An output assignment location is outside its warehouse.");
    }
  }
}

export function parseSupplySnapshot(raw: unknown): SupplySnapshotDto {
  const snapshot = supplySnapshotSchema.parse(raw);
  const { snapshotFingerprint, ...content } = snapshot;
  const expectedFingerprint = calculateSupplySnapshotFingerprint(content);
  if (snapshotFingerprint !== expectedFingerprint) {
    throw new InventoryAvailabilityPlannerError(
      "SUPPLY_SNAPSHOT_FINGERPRINT_MISMATCH",
      "The supply snapshot content does not match its fingerprint.",
      { snapshotFingerprint, expectedFingerprint },
    );
  }
  assertSnapshotReferences(snapshot);
  return snapshot;
}

export function parseClaimSupplySnapshot(raw: unknown): ClaimSupplySnapshotDto {
  const snapshot = claimSupplySnapshotSchema.parse(raw);
  const { snapshotFingerprint, ...content } = snapshot;
  const expectedFingerprint = calculateClaimSupplySnapshotFingerprint(content);
  if (snapshotFingerprint !== expectedFingerprint) {
    throw new InventoryAvailabilityPlannerError(
      "SUPPLY_SNAPSHOT_FINGERPRINT_MISMATCH",
      "The claim supply snapshot content does not match its fingerprint.",
      { snapshotFingerprint, expectedFingerprint },
    );
  }
  assertSnapshotReferences(snapshot);
  return snapshot;
}

function parseClaimPlannerSnapshot(raw: unknown): PlannerSupplySnapshot {
  if (
    raw
    && typeof raw === "object"
    && "schemaVersion" in raw
    && raw.schemaVersion === "inventory_availability_claim_snapshot_v1"
  ) {
    return parseClaimSupplySnapshot(raw);
  }
  return parseSupplySnapshot(raw);
}

export function isPromiseEligibleLocation(location: Location, warehouseIsActive: boolean): boolean {
  if (!warehouseIsActive || !location.isActive || location.isFrozen || location.warehouseId === null) {
    return false;
  }
  if (HARD_INELIGIBLE_LOCATION_TYPES.has(location.locationType)) return false;
  if (location.promisePolicy?.eligibilityMode === "eligible") return true;
  if (location.promisePolicy?.eligibilityMode === "ineligible") return false;
  return PROMISE_ELIGIBLE_LOCATION_TYPES.has(location.locationType);
}

function resolveSafety(snapshot: PlannerSupplySnapshot, warehouseId: number, variantId: number): {
  protectedQty: bigint;
  evidence: SafetyEvidence;
  blockers: PlannerBlockerDto[];
} {
  const policies = new Map(snapshot.safetyPolicies.map((policy) => [policy.scopeKey, policy] as const));
  const policy = [
    policies.get(`warehouse:${warehouseId}:variant:${variantId}`),
    policies.get(`network:variant:${variantId}`),
    policies.get("business"),
  ].find((candidate) => candidate && candidate.policyMode !== "inherit") ?? null;
  if (!policy) {
    return {
      protectedQty: BigInt(0),
      evidence: {
        warehouseId,
        productVariantId: variantId,
        policyId: null,
        policyMode: "implicit_off",
        protectedUnits: "0",
        demandEvidenceId: null,
      },
      blockers: [problem(
        "MISSING_PROMISE_SAFETY_POLICY",
        "No business, SKU, or warehouse/SKU promise-safety policy resolves for this resource.",
        { warehouseId, productVariantId: variantId },
      )],
    };
  }
  if (policy.policyMode === "off") {
    return {
      protectedQty: BigInt(0),
      evidence: {
        warehouseId,
        productVariantId: variantId,
        policyId: policy.policyId,
        policyMode: "off",
        protectedUnits: "0",
        demandEvidenceId: null,
      },
      blockers: [],
    };
  }
  if (policy.policyMode === "fixed_units") {
    const protectedQty = qty(policy.fixedUnits ?? "0", "safety.fixedUnits");
    return {
      protectedQty,
      evidence: {
        warehouseId,
        productVariantId: variantId,
        policyId: policy.policyId,
        policyMode: "fixed_units",
        protectedUnits: protectedQty.toString(),
        demandEvidenceId: null,
      },
      blockers: [],
    };
  }
  const demand = snapshot.demandEvidence.find((candidate) =>
    candidate.productVariantId === variantId
    && candidate.warehouseId === warehouseId
    && candidate.methodVersion === policy.demandMethodVersion);
  const overrideValid = demand?.trustStatus === "overridden"
    && demand.overrideExpiresAt !== null
    && Date.parse(demand.overrideExpiresAt) > Date.parse(snapshot.capturedAt);
  const trusted = demand?.trustStatus === "trusted" || overrideValid;
  const protectedQty = trusted && demand
    ? ceilDivide(
        multiply(
          qty(demand.dailyDemandMilliUnits, "demand.dailyDemandMilliUnits"),
          qty(policy.daysOfCoverMilliDays ?? "0", "safety.daysOfCoverMilliDays"),
          "safety.daysOfCover",
        ),
        MILLI_UNITS_SQUARED,
      )
    : qty(policy.untrustedDemandFallbackUnits ?? "0", "safety.untrustedDemandFallbackUnits");
  return {
    protectedQty,
    evidence: {
      warehouseId,
      productVariantId: variantId,
      policyId: policy.policyId,
      policyMode: "days_of_cover",
      protectedUnits: protectedQty.toString(),
      demandEvidenceId: trusted && demand ? demand.evidenceId : null,
    },
    blockers: [],
  };
}

function resourceOrder(left: Resource, right: Resource): number {
  return left.warehouseLocationId - right.warehouseLocationId
    || left.inventoryLevelId - right.inventoryLevelId;
}

function consumeAcross(resources: Resource[], requestedQty: bigint): bigint {
  let remaining = requestedQty;
  for (const resource of resources) {
    if (remaining === BigInt(0)) break;
    const take = resource.remainingQty < remaining ? resource.remainingQty : remaining;
    resource.remainingQty -= take;
    remaining -= take;
  }
  return requestedQty - remaining;
}

function buildContext(snapshot: PlannerSupplySnapshot, warehouseId: number, simulation = false): Context {
  const variantsById = new Map(snapshot.variants.map((variant) => [variant.id, variant] as const));
  const warehousesById = new Map(snapshot.warehouses.map((warehouse) => [warehouse.id, warehouse] as const));
  const locationsById = new Map(snapshot.locations.map((location) => [location.id, location] as const));
  const warehouse = warehousesById.get(warehouseId);
  const blockers: PlannerBlockerDto[] = [];
  if (!warehouse?.isActive) {
    blockers.push(problem("WAREHOUSE_NOT_ACTIVE", "The requested warehouse is missing or inactive.", { warehouseId }));
  }

  const positionsByVariant = new Map<number, Array<{ position: Position; resource: Resource }>>();
  for (const position of snapshot.inventoryPositions) {
    const location = locationsById.get(position.warehouseLocationId);
    if (!location || location.warehouseId !== warehouseId
      || !isPromiseEligibleLocation(location, warehouse?.isActive ?? false)) continue;
    if (!variantsById.get(position.productVariantId)?.isActive) continue;
    const physical = qty(position.variantQty, "inventoryPosition.variantQty");
    const claimed = qty(position.reservedQty, "inventoryPosition.reservedQty");
    if (physical < BigInt(0)) {
      blockers.push(problem(
        "NEGATIVE_PHYSICAL_INVENTORY",
        "A promise-eligible inventory position has negative physical on-hand.",
        { inventoryLevelId: position.inventoryLevelId, variantQty: position.variantQty },
      ));
    }
    if (claimed < BigInt(0)) {
      blockers.push(problem(
        "NEGATIVE_LEGACY_CLAIM_PROJECTION",
        "A promise-eligible inventory position has a negative reserved quantity.",
        { inventoryLevelId: position.inventoryLevelId, reservedQty: position.reservedQty },
      ));
    }
    const entries = positionsByVariant.get(position.productVariantId) ?? [];
    entries.push({
      position,
      resource: {
        inventoryLevelId: position.inventoryLevelId,
        warehouseLocationId: position.warehouseLocationId,
        variantId: position.productVariantId,
        remainingQty: clamp(physical),
      },
    });
    positionsByVariant.set(position.productVariantId, entries);
  }

  const resourcesByVariant = new Map<number, Resource[]>();
  const directEvidence = new Map<number, { exactPhysical: bigint; claims: bigint; protected: bigint }>();
  const safetyEvidence: SafetyEvidence[] = [];
  for (const variant of snapshot.variants.filter((candidate) => candidate.isActive)) {
    const entries = (positionsByVariant.get(variant.id) ?? [])
      .slice()
      .sort((left, right) => resourceOrder(left.resource, right.resource));
    const resources = entries.map((entry) => entry.resource);
    const exactPhysical = resources.reduce((sum, entry) => add(sum, entry.remainingQty, "exactPhysical"), BigInt(0));
    let claimDeficit = BigInt(0);
    let totalClaims = BigInt(0);
    for (const entry of entries) {
      const claim = clamp(qty(entry.position.reservedQty, "inventoryPosition.reservedQty"));
      totalClaims = add(totalClaims, claim, "activeClaims");
      const directClaim = entry.resource.remainingQty < claim ? entry.resource.remainingQty : claim;
      entry.resource.remainingQty -= directClaim;
      claimDeficit = add(claimDeficit, claim - directClaim, "claimDeficit");
    }
    consumeAcross(resources, claimDeficit);
    const safety = resolveSafety(snapshot, warehouseId, variant.id);
    blockers.push(...safety.blockers);
    safetyEvidence.push(safety.evidence);
    consumeAcross(resources, safety.protectedQty);
    resourcesByVariant.set(variant.id, resources);
    directEvidence.set(variant.id, { exactPhysical, claims: totalClaims, protected: safety.protectedQty });
  }

  const pathsByDestination = new Map<number, Path[]>();
  const recipesByOutput = new Map<number, Recipe[]>();
  for (const model of snapshot.transformationModels) {
    if (model.validationState !== "valid") {
      blockers.push(problem(
        "INVALID_TRANSFORMATION_MODEL",
        "The selected shadow transformation model is invalid; only exact physical supply can contribute.",
        { productId: model.productId, modelId: model.modelId },
      ));
      continue;
    }
    for (const path of model.paths) {
      if (path.authorityState !== "allowed" || path.validationState !== "valid") continue;
      const candidates = pathsByDestination.get(path.destinationVariantId) ?? [];
      candidates.push(path);
      pathsByDestination.set(path.destinationVariantId, candidates);
    }
    if (!model.buildToPromiseEnabled) continue;
    for (const recipe of model.recipeBindings) {
      if (recipe.relationshipRole !== "component_build" || recipe.validationState !== "valid"
        || (recipe.warehouseId !== null && recipe.warehouseId !== warehouseId)) continue;
      const candidates = recipesByOutput.get(recipe.outputVariantId) ?? [];
      candidates.push(recipe);
      recipesByOutput.set(recipe.outputVariantId, candidates);
    }
  }
  for (const productId of rootProductIds(snapshot)) {
    if (!snapshot.transformationModels.some((model) => model.productId === productId)) {
      blockers.push(problem(
        "MISSING_TRANSFORMATION_MODEL",
        "No draft or active transformation model was captured for a target product.",
        { productId },
      ));
    }
  }
  for (const paths of pathsByDestination.values()) {
    paths.sort((left, right) => left.sourceVariantId - right.sourceVariantId || left.pathId - right.pathId);
  }
  for (const [outputVariantId, recipes] of recipesByOutput) {
    recipes.sort((left, right) => Number(right.warehouseId === warehouseId)
      - Number(left.warehouseId === warehouseId) || left.bindingId - right.bindingId);
    if (recipes.length > 1) {
      blockers.push(problem(
        "AMBIGUOUS_COMPONENT_BUILD_AUTHORITY",
        "More than one component-build recipe resolves for an output variant and warehouse.",
        { warehouseId, outputVariantId, bindingIds: recipes.map((recipe) => recipe.bindingId) },
      ));
      recipesByOutput.set(outputVariantId, []);
    }
  }
  return {
    snapshot,
    warehouseId,
    variantsById,
    resourcesByVariant,
    pathsByDestination,
    recipesByOutput,
    outputLocations: new Map(snapshot.outputLocations
      .filter((entry) => entry.warehouseId === warehouseId)
      .map((entry) => [entry.productVariantId, entry.warehouseLocationId] as const)),
    blockers,
    safetyEvidence,
    resourceClaims: [],
    operations: [],
    directEvidence,
    simulation,
  };
}

function cloneContext(context: Context): Context {
  return {
    ...context,
    resourcesByVariant: new Map([...context.resourcesByVariant].map(([variantId, resources]) => [
      variantId,
      resources.map((resource) => ({ ...resource })),
    ])),
    blockers: [...context.blockers],
    safetyEvidence: [...context.safetyEvidence],
    resourceClaims: [],
    operations: [],
    simulation: true,
  };
}

function consumeDirect(context: Context, variantId: number, requestedQty: bigint, lineKey: string): bigint {
  let remaining = requestedQty;
  for (const resource of context.resourcesByVariant.get(variantId) ?? []) {
    if (remaining === BigInt(0)) break;
    const take = resource.remainingQty < remaining ? resource.remainingQty : remaining;
    if (take === BigInt(0)) continue;
    resource.remainingQty -= take;
    remaining -= take;
    if (!context.simulation) {
      context.resourceClaims.push({
        lineKey,
        warehouseId: context.warehouseId,
        warehouseLocationId: resource.warehouseLocationId,
        inventoryLevelId: resource.inventoryLevelId,
        sourceVariantId: resource.variantId,
        claimedQty: take,
      });
    }
  }
  return requestedQty - remaining;
}

function emptyBreakdown(): Breakdown {
  return { total: BigInt(0), direct: BigInt(0), convertible: BigInt(0), buildable: BigInt(0) };
}

function maxBuilds(
  context: Context,
  recipe: Recipe,
  maximumBuilds: bigint,
  lineKey: string,
  stack: ReadonlySet<number>,
): bigint {
  let low = BigInt(0);
  let high = maximumBuilds;
  while (low < high) {
    const middle = low + ((high - low + BigInt(1)) / BigInt(2));
    const trial = cloneContext(context);
    let possible = true;
    for (const component of recipe.components.slice().sort((left, right) =>
      left.componentVariantId - right.componentVariantId)) {
      const required = multiply(
        middle,
        qty(component.componentQty, "recipe.componentQty"),
        "recipe.componentRequired",
      );
      if (fulfillUpTo(trial, component.componentVariantId, required, lineKey, stack).total !== required) {
        possible = false;
        break;
      }
    }
    if (possible) low = middle;
    else high = middle - BigInt(1);
  }
  return low;
}

function maxFulfillableQty(
  context: Context,
  targetVariantId: number,
  maximumQty: bigint,
  lineKey: string,
  stack: ReadonlySet<number> = new Set<number>(),
): bigint {
  if (maximumQty <= BigInt(0)) return BigInt(0);
  const feasible = (quantity: bigint): boolean => {
    try {
      const trial = cloneContext(context);
      return fulfillUpTo(trial, targetVariantId, quantity, lineKey, stack).total === quantity;
    } catch (error) {
      if (error instanceof InventoryAvailabilityPlannerError
        && error.code === "PLANNER_QUANTITY_OVERFLOW") return false;
      throw error;
    }
  };
  let low = BigInt(0);
  let high = BigInt(1);
  while (high < maximumQty && feasible(high)) {
    low = high;
    high = high > maximumQty / BigInt(2) ? maximumQty : high * BigInt(2);
  }
  if (high === maximumQty && feasible(high)) return high;
  high -= BigInt(1);
  while (low < high) {
    const middle = low + ((high - low + BigInt(1)) / BigInt(2));
    if (feasible(middle)) low = middle;
    else high = middle - BigInt(1);
  }
  return low;
}

function fulfillUpTo(
  context: Context,
  targetVariantId: number,
  requestedQty: bigint,
  lineKey: string,
  stack: ReadonlySet<number>,
): Breakdown {
  if (requestedQty <= BigInt(0) || !context.variantsById.get(targetVariantId)?.isActive
    || stack.has(targetVariantId)) return emptyBreakdown();
  const nextStack = new Set(stack);
  nextStack.add(targetVariantId);
  const result = emptyBreakdown();
  const direct = consumeDirect(context, targetVariantId, requestedQty, lineKey);
  result.total += direct;
  result.direct += direct;
  let remaining = requestedQty - direct;

  for (const path of context.pathsByDestination.get(targetVariantId) ?? []) {
    if (remaining === BigInt(0)) break;
    if (nextStack.has(path.sourceVariantId)) continue;
    const inputQty = qty(path.inputQty, "path.inputQty");
    const outputQty = qty(path.outputQty, "path.outputQty");
    if (inputQty <= BigInt(0) || outputQty <= BigInt(0)) continue;
    const requestedExecutions = ceilDivide(remaining, outputQty);
    const maxInput = multiply(requestedExecutions, inputQty, "path.requestedInput");
    const sourceCapacity = maxFulfillableQty(
      context,
      path.sourceVariantId,
      maxInput,
      lineKey,
      nextStack,
    );
    const executions = sourceCapacity / inputQty;
    if (executions === BigInt(0)) continue;
    const sourceRequired = multiply(executions, inputQty, "path.sourceRequired");
    const sourcePlan = fulfillUpTo(
      context,
      path.sourceVariantId,
      sourceRequired,
      lineKey,
      nextStack,
    );
    if (sourcePlan.total !== sourceRequired) {
      throw new InventoryAvailabilityPlannerError(
        "NONDETERMINISTIC_TRANSFORMATION_PLAN",
        "A transformation source changed between feasibility and planning.",
        { pathId: path.pathId },
      );
    }
    const produced = multiply(executions, outputQty, "path.output");
    const fulfilled = produced < remaining ? produced : remaining;
    result.total += fulfilled;
    result.convertible += fulfilled;
    remaining -= fulfilled;
    if (!context.simulation) {
      context.operations.push({
        lineKey,
        warehouseId: context.warehouseId,
        operationKey: `${lineKey}:path:${path.pathId}:${context.operations.length + 1}`,
        operationType: path.operationType,
        authorityId: path.pathId,
        sourceVariantIds: [path.sourceVariantId],
        destinationVariantId: path.destinationVariantId,
        plannedExecutions: executions,
        outputQty: produced,
        outputLocationId: context.outputLocations.get(path.destinationVariantId) ?? null,
      });
    }
  }

  if (remaining > BigInt(0)) {
    const recipe = (context.recipesByOutput.get(targetVariantId) ?? [])[0];
    if (recipe && !recipe.components.some((component) => nextStack.has(component.componentVariantId))) {
      const outputQty = qty(recipe.outputQty, "recipe.outputQty");
      if (outputQty > BigInt(0)) {
        const requestedBuilds = ceilDivide(remaining, outputQty);
        const builds = maxBuilds(context, recipe, requestedBuilds, lineKey, nextStack);
        if (builds > BigInt(0)) {
          for (const component of recipe.components.slice().sort((left, right) =>
            left.componentVariantId - right.componentVariantId)) {
            const required = multiply(
              builds,
              qty(component.componentQty, "recipe.componentQty"),
              "recipe.componentRequired",
            );
            if (fulfillUpTo(
              context,
              component.componentVariantId,
              required,
              lineKey,
              nextStack,
            ).total !== required) {
              throw new InventoryAvailabilityPlannerError(
                "NONDETERMINISTIC_BUILD_PLAN",
                "A build component changed between feasibility and planning.",
                { bindingId: recipe.bindingId, componentVariantId: component.componentVariantId },
              );
            }
          }
          const produced = multiply(builds, outputQty, "recipe.output");
          const fulfilled = produced < remaining ? produced : remaining;
          result.total += fulfilled;
          result.buildable += fulfilled;
          if (!context.simulation) {
            context.operations.push({
              lineKey,
              warehouseId: context.warehouseId,
              operationKey: `${lineKey}:recipe:${recipe.bindingId}:${context.operations.length + 1}`,
              operationType: "component_build",
              authorityId: recipe.bindingId,
              sourceVariantIds: recipe.components
                .map((component) => component.componentVariantId)
                .sort((left, right) => left - right),
              destinationVariantId: recipe.outputVariantId,
              plannedExecutions: builds,
              outputQty: produced,
              outputLocationId: context.outputLocations.get(recipe.outputVariantId) ?? null,
            });
          }
        }
      }
    }
  }
  return result;
}

function warehouseIds(snapshot: PlannerSupplySnapshot, scope: Scope): number[] {
  return scope.kind === "warehouse"
    ? [scope.warehouseId]
    : snapshot.warehouses
        .filter((warehouse) => warehouse.isActive)
        .map((warehouse) => warehouse.id)
        .sort((left, right) => left - right);
}

function modelEvidence(snapshot: PlannerSupplySnapshot): AtpProjectionDto["modelEvidence"] {
  return snapshot.transformationModels
    .map((model) => ({
      productId: model.productId,
      modelId: model.modelId,
      version: model.version,
      definitionHash: model.definitionHash,
      lifecycleSelection: model.lifecycleSelection,
    }))
    .sort((left, right) => left.productId - right.productId || left.modelId - right.modelId);
}

export function projectCanonicalAtp(
  rawSnapshot: SupplySnapshotDto,
  rawRequest: AtpProjectionRequestDto,
): AtpProjectionDto {
  const snapshot = parseSupplySnapshot(rawSnapshot);
  const request = atpProjectionRequestSchema.parse(rawRequest);
  const target = snapshot.variants.find((variant) => variant.id === request.targetVariantId);
  if (!target || target.productId !== snapshot.productId || !target.isActive) {
    throw new InventoryAvailabilityPlannerError(
      "TARGET_VARIANT_NOT_FOUND",
      "The requested active target variant does not belong to the snapshot product.",
      { productId: snapshot.productId, targetVariantId: request.targetVariantId },
    );
  }

  let atp = BigInt(0);
  let exact = BigInt(0);
  let claims = BigInt(0);
  let protectedQty = BigInt(0);
  let direct = BigInt(0);
  let convertible = BigInt(0);
  let buildable = BigInt(0);
  const blockers: PlannerBlockerDto[] = [];
  const safetyEvidence: SafetyEvidence[] = [];
  for (const warehouseId of warehouseIds(snapshot, request.scope)) {
    const context = buildContext(snapshot, warehouseId);
    const capacity = maxFulfillableQty(
      context,
      target.id,
      POSTGRES_BIGINT_MAX,
      `projection:${target.id}`,
    );
    const planned = fulfillUpTo(context, target.id, capacity, `projection:${target.id}`, new Set<number>());
    const evidence = context.directEvidence.get(target.id) ?? {
      exactPhysical: BigInt(0),
      claims: BigInt(0),
      protected: BigInt(0),
    };
    atp = add(atp, planned.total, "projection.atpUnits");
    direct = add(direct, planned.direct, "projection.directUnits");
    convertible = add(convertible, planned.convertible, "projection.convertibleUnits");
    buildable = add(buildable, planned.buildable, "projection.buildableUnits");
    exact = add(exact, evidence.exactPhysical, "projection.exactPhysicalUnits");
    claims = add(claims, evidence.claims, "projection.claimedUnits");
    protectedQty = add(protectedQty, evidence.protected, "projection.protectedUnits");
    blockers.push(...context.blockers);
    safetyEvidence.push(...context.safetyEvidence.filter((entry) => entry.productVariantId === target.id));
  }
  const resolvedBlockers = uniqueProblems(blockers);
  return atpProjectionSchema.parse({
    targetVariantId: target.id,
    scope: request.scope,
    status: resolvedBlockers.length === 0 ? "ready" : "blocked",
    atpUnits: atp.toString(),
    atpBaseUnits: multiply(atp, BigInt(target.unitsPerVariant), "projection.atpBaseUnits").toString(),
    exactPhysicalUnits: exact.toString(),
    claimedUnits: claims.toString(),
    protectedUnits: protectedQty.toString(),
    directUnits: direct.toString(),
    convertibleUnits: convertible.toString(),
    buildableUnits: buildable.toString(),
    snapshotFingerprint: snapshot.snapshotFingerprint,
    modelEvidence: modelEvidence(snapshot),
    safetyEvidence,
    blockers: resolvedBlockers,
  });
}

function mergeClaims(claims: readonly ResourceClaim[]): ResourceClaim[] {
  const byKey = new Map<string, ResourceClaim>();
  for (const claim of claims) {
    const key = [
      claim.lineKey,
      claim.warehouseId,
      claim.warehouseLocationId,
      claim.inventoryLevelId,
      claim.sourceVariantId,
    ].join(":");
    const existing = byKey.get(key);
    if (existing) existing.claimedQty = add(existing.claimedQty, claim.claimedQty, "claimSegment.claimedQty");
    else byKey.set(key, { ...claim });
  }
  return [...byKey.values()].sort((left, right) =>
    left.lineKey.localeCompare(right.lineKey)
    || left.warehouseId - right.warehouseId
    || left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId);
}

export function planCanonicalClaim(
  rawSnapshot: SupplySnapshotDto | ClaimSupplySnapshotDto,
  rawRequest: ClaimPlanRequestDto,
): ClaimPlanDto {
  const snapshot = parseClaimPlannerSnapshot(rawSnapshot);
  const request = claimPlanRequestSchema.parse(rawRequest);
  const roots = new Set(rootProductIds(snapshot));
  const variantsById = new Map(snapshot.variants.map((variant) => [variant.id, variant] as const));
  for (const line of request.lines) {
    const target = variantsById.get(line.targetVariantId);
    if (!target?.isActive || !roots.has(target.productId)) {
      throw new InventoryAvailabilityPlannerError(
        "TARGET_VARIANT_NOT_FOUND",
        "A requested active target variant does not belong to a claim snapshot root product.",
        { lineKey: line.lineKey, targetVariantId: line.targetVariantId, rootProductIds: [...roots].sort() },
      );
    }
  }
  const contexts = warehouseIds(snapshot, request.scope)
    .map((warehouseId) => buildContext(snapshot, warehouseId));
  const blockers = contexts.flatMap((context) => context.blockers);
  const lines: ClaimPlanDto["lines"] = [];
  const lineAllocationsByWarehouse = new Map<
    number,
    ClaimPlanDto["fulfillmentGroups"][number]["lineAllocations"]
  >();
  for (const line of request.lines) {
    let remaining = qty(line.requestedQty, "claimLine.requestedQty");
    let plannedQty = BigInt(0);
    for (const context of contexts) {
      if (remaining === BigInt(0)) break;
      const available = maxFulfillableQty(context, line.targetVariantId, remaining, line.lineKey);
      if (available === BigInt(0)) continue;
      const planned = fulfillUpTo(
        context,
        line.targetVariantId,
        available,
        line.lineKey,
        new Set<number>(),
      );
      plannedQty = add(plannedQty, planned.total, "claimLine.plannedQty");
      remaining -= planned.total;
      if (planned.total > BigInt(0)) {
        const allocations = lineAllocationsByWarehouse.get(context.warehouseId) ?? [];
        allocations.push({
          lineKey: line.lineKey,
          targetVariantId: line.targetVariantId,
          plannedQty: planned.total.toString(),
        });
        lineAllocationsByWarehouse.set(context.warehouseId, allocations);
      }
    }
    lines.push({
      lineKey: line.lineKey,
      targetVariantId: line.targetVariantId,
      requestedQty: line.requestedQty,
      plannedQty: plannedQty.toString(),
      shortfallQty: remaining.toString(),
    });
  }
  const resolvedBlockers = uniqueProblems(blockers);
  return claimPlanSchema.parse({
    requestKey: request.requestKey,
    scope: request.scope,
    status: resolvedBlockers.length > 0
      ? "blocked"
      : lines.some((line) => line.shortfallQty !== "0") ? "partial" : "satisfied",
    lines,
    resourceClaims: mergeClaims(contexts.flatMap((context) => context.resourceClaims))
      .map((claim) => ({ ...claim, claimedQty: claim.claimedQty.toString() })),
    operations: contexts.flatMap((context) => context.operations).map((operation) => ({
      ...operation,
      plannedExecutions: operation.plannedExecutions.toString(),
      outputQty: operation.outputQty.toString(),
    })),
    fulfillmentGroups: [...lineAllocationsByWarehouse]
      .sort(([left], [right]) => left - right)
      .map(([warehouseId, lineAllocations]) => ({
        groupKey: `${request.requestKey}:warehouse:${warehouseId}`,
        warehouseId,
        lineAllocations,
      })),
    modelEvidence: modelEvidence(snapshot),
    blockers: resolvedBlockers,
    snapshotFingerprint: snapshot.snapshotFingerprint,
  });
}

function legacyPositionInScope(snapshot: SupplySnapshotDto, position: Position, scope: Scope): boolean {
  if (scope.kind === "network") return true;
  const location = snapshot.locations.find((candidate) => candidate.id === position.warehouseLocationId);
  if (!location?.warehouseId) return false;
  const warehouse = snapshot.warehouses.find((candidate) => candidate.id === location.warehouseId);
  return location.warehouseId === scope.warehouseId || warehouse?.hubWarehouseId === scope.warehouseId;
}

function legacyRecipeGraph(snapshot: SupplySnapshotDto, targetVariantId: number): {
  recipes: RecipeDefinition[];
  variantIds: Set<number>;
  outputProductIds: Set<number>;
} {
  const byOutput = new Map<number, SupplySnapshotDto["legacyRecipes"]>();
  for (const recipe of snapshot.legacyRecipes) {
    const candidates = byOutput.get(recipe.outputVariantId) ?? [];
    candidates.push(recipe);
    byOutput.set(recipe.outputVariantId, candidates);
  }
  const recipes: RecipeDefinition[] = [];
  const selected = new Set<number>();
  const variantIds = new Set<number>([targetVariantId]);
  const target = snapshot.variants.find((variant) => variant.id === targetVariantId);
  const outputProductIds = new Set<number>(target ? [target.productId] : []);
  const visit = (variantId: number, stack: ReadonlySet<number>): void => {
    if (stack.has(variantId)) throw new Error("legacy recipe cycle");
    const candidates = byOutput.get(variantId) ?? [];
    if (candidates.length > 1) throw new Error("ambiguous legacy recipe");
    const recipe = candidates[0];
    if (!recipe || selected.has(recipe.recipeId)) return;
    selected.add(recipe.recipeId);
    outputProductIds.add(recipe.outputProductId);
    const nextStack = new Set(stack);
    nextStack.add(variantId);
    recipes.push({
      id: recipe.recipeId,
      outputVariantId: recipe.outputVariantId,
      outputProductId: recipe.outputProductId,
      outputQty: Number(qty(recipe.outputQty, "legacyRecipe.outputQty")),
      components: recipe.components.map((component) => ({
        variantId: component.componentVariantId,
        productId: component.componentProductId,
        qtyPerBuild: Number(qty(component.componentQty, "legacyRecipe.componentQty")),
      })),
    });
    for (const component of recipe.components) {
      variantIds.add(component.componentVariantId);
      visit(component.componentVariantId, nextStack);
    }
  };
  visit(targetVariantId, new Set<number>());
  return { recipes, variantIds, outputProductIds };
}

function legacyRecipeAtpForWarehouse(
  snapshot: SupplySnapshotDto,
  targetVariantId: number,
  warehouseId: number,
): bigint {
  try {
    const graph = legacyRecipeGraph(snapshot, targetVariantId);
    const locations = new Map(snapshot.locations.map((location) => [location.id, location] as const));
    const finishedVariants = snapshot.variants.filter((variant) =>
      variant.isActive && graph.outputProductIds.has(variant.productId));
    const finishedIds = new Set(finishedVariants.map((variant) => variant.id));
    const positions = snapshot.inventoryPositions.filter((position) => {
      const location = locations.get(position.warehouseLocationId);
      return location?.warehouseId === warehouseId && location.isActive && !location.isFrozen;
    });
    const available = (position: Position): number => Number(
      qty(position.variantQty, "legacy.variantQty")
      - qty(position.reservedQty, "legacy.reservedQty")
      - qty(position.pickedQty, "legacy.pickedQty")
      - qty(position.packedQty, "legacy.packedQty"),
    );
    const legacySnapshot: WarehouseRecipeSnapshot = {
      warehouseId,
      recipes: graph.recipes,
      stock: positions
        .filter((position) => graph.variantIds.has(position.productVariantId))
        .filter((position) => !finishedIds.has(position.productVariantId))
        .map((position) => ({
          variantId: position.productVariantId,
          locationId: position.warehouseLocationId,
          availableQty: available(position),
        }))
        .filter((position) => position.availableQty > 0),
      finishedVariants: finishedVariants.map((variant) => ({
        variantId: variant.id,
        productId: variant.productId,
        unitsPerVariant: variant.unitsPerVariant,
      })),
      finishedStock: positions
        .filter((position) => finishedIds.has(position.productVariantId))
        .map((position) => {
          const variant = snapshot.variants.find((candidate) => candidate.id === position.productVariantId)!;
          return {
            variantId: variant.id,
            productId: variant.productId,
            unitsPerVariant: variant.unitsPerVariant,
            availableQty: available(position),
          };
        }),
      outputLocations: new Map(snapshot.outputLocations
        .filter((assignment) => assignment.warehouseId === warehouseId)
        .map((assignment) => [assignment.productVariantId, assignment.warehouseLocationId] as const)),
    };
    return BigInt(calculateRecipeCapacity(legacySnapshot, targetVariantId));
  } catch {
    // InventoryAtpService.getRecipeVariantAtp catches recipe errors and returns zero.
    return BigInt(0);
  }
}

export function calculateLegacyAtpFromSnapshot(
  rawSnapshot: SupplySnapshotDto,
  rawRequest: AtpProjectionRequestDto,
): bigint {
  const snapshot = parseSupplySnapshot(rawSnapshot);
  const request = atpProjectionRequestSchema.parse(rawRequest);
  const target = snapshot.variants.find((variant) => variant.id === request.targetVariantId);
  if (!target || target.productId !== snapshot.productId || !target.isActive) return BigInt(0);
  const productVariants = new Set(snapshot.variants
    .filter((variant) => variant.productId === snapshot.productId && variant.isActive)
    .map((variant) => variant.id));
  const positions = snapshot.inventoryPositions.filter((position) =>
    productVariants.has(position.productVariantId)
    && legacyPositionInScope(snapshot, position, request.scope));
  if (snapshot.legacyInventoryStrategy === "physical_fungible") {
    let base = BigInt(0);
    for (const position of positions) {
      const variant = snapshot.variants.find((candidate) => candidate.id === position.productVariantId)!;
      base += (qty(position.variantQty, "legacy.variantQty")
        - qty(position.reservedQty, "legacy.reservedQty")) * BigInt(variant.unitsPerVariant);
    }
    return clamp(base) / BigInt(target.unitsPerVariant);
  }
  if (snapshot.legacyInventoryStrategy === "physical_only") {
    return positions
      .filter((position) => position.productVariantId === target.id)
      .reduce((sum, position) => sum + clamp(
        qty(position.variantQty, "legacy.variantQty")
        - qty(position.reservedQty, "legacy.reservedQty"),
      ), BigInt(0));
  }
  return warehouseIds(snapshot, request.scope).reduce(
    (sum, warehouseId) => sum + legacyRecipeAtpForWarehouse(snapshot, target.id, warehouseId),
    BigInt(0),
  );
}

/**
 * Reconstruct the base-unit capacity returned by the deployed legacy ATP
 * service from the same sealed shadow snapshot. Fungible products retain the
 * unrounded shared pool; exact and recipe-managed products expose the capacity
 * represented by their sellable variant quantity.
 */
export function calculateLegacyAtpBaseFromSnapshot(
  rawSnapshot: SupplySnapshotDto,
  rawRequest: AtpProjectionRequestDto,
): bigint {
  const snapshot = parseSupplySnapshot(rawSnapshot);
  const request = atpProjectionRequestSchema.parse(rawRequest);
  const target = snapshot.variants.find((variant) => variant.id === request.targetVariantId);
  if (!target || target.productId !== snapshot.productId || !target.isActive) return BigInt(0);
  if (snapshot.legacyInventoryStrategy !== "physical_fungible") {
    return calculateLegacyAtpFromSnapshot(snapshot, request) * BigInt(target.unitsPerVariant);
  }
  const productVariants = new Set(snapshot.variants
    .filter((variant) => variant.productId === snapshot.productId && variant.isActive)
    .map((variant) => variant.id));
  const positions = snapshot.inventoryPositions.filter((position) =>
    productVariants.has(position.productVariantId)
    && legacyPositionInScope(snapshot, position, request.scope));
  const base = positions.reduce((sum, position) => {
    const variant = snapshot.variants.find((candidate) => candidate.id === position.productVariantId)!;
    return sum + (qty(position.variantQty, "legacy.variantQty")
      - qty(position.reservedQty, "legacy.reservedQty")) * BigInt(variant.unitsPerVariant);
  }, BigInt(0));
  return clamp(base);
}

function hasExcludedPhysical(snapshot: SupplySnapshotDto, variantId: number, scope: Scope): boolean {
  const locations = new Map(snapshot.locations.map((location) => [location.id, location] as const));
  const warehouses = new Map(snapshot.warehouses.map((warehouse) => [warehouse.id, warehouse] as const));
  return snapshot.inventoryPositions.some((position) => {
    if (position.productVariantId !== variantId || qty(position.variantQty, "variantQty") <= BigInt(0)) return false;
    const location = locations.get(position.warehouseLocationId);
    if (!location?.warehouseId) return scope.kind === "network";
    if (scope.kind === "warehouse" && location.warehouseId !== scope.warehouseId) return false;
    return !isPromiseEligibleLocation(location, warehouses.get(location.warehouseId)?.isActive ?? false);
  });
}

export function classifyShadowDifference(
  snapshot: SupplySnapshotDto,
  request: AtpProjectionRequestDto,
  legacyAtp: bigint,
  proposed: AtpProjectionDto,
): PlannerShadowClassification[] {
  const classifications = new Set<PlannerShadowClassification>();
  const proposedAtp = qty(proposed.atpUnits, "proposed.atpUnits");
  if (legacyAtp === proposedAtp) classifications.add("match");
  if (proposed.blockers.length > 0) classifications.add("configuration_blocker");
  if (legacyAtp !== proposedAtp) {
    if (hasExcludedPhysical(snapshot, request.targetVariantId, request.scope)) {
      classifications.add("location_eligibility");
    }
    if (qty(proposed.protectedUnits, "proposed.protectedUnits") > BigInt(0)) {
      classifications.add("promise_safety_stock");
    }
    if (qty(proposed.convertibleUnits, "proposed.convertibleUnits") > BigInt(0)) {
      classifications.add("directed_transformation");
    }
    if (qty(proposed.buildableUnits, "proposed.buildableUnits") > BigInt(0)) {
      classifications.add("build_to_promise");
    }
    if (snapshot.legacyInventoryStrategy === "physical_fungible") {
      classifications.add("legacy_strategy_pooling");
    }
    const positions = snapshot.inventoryPositions.filter((position) =>
      position.productVariantId === request.targetVariantId
      && legacyPositionInScope(snapshot, position, request.scope));
    if (positions.some((position) =>
      qty(position.pickedQty, "pickedQty") > BigInt(0) || qty(position.packedQty, "packedQty") > BigInt(0))) {
      classifications.add("legacy_double_subtract_custody");
    }
    if (positions.some((position) =>
      qty(position.reservedQty, "reservedQty") > qty(position.variantQty, "variantQty"))) {
      classifications.add("aggregate_claim_clamp");
    }
    if (classifications.size === 0) classifications.add("unexplained");
  }
  return [...classifications].sort();
}
