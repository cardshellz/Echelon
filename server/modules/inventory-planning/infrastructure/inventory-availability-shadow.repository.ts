import type { Pool, PoolClient } from "pg";

import { pool } from "../../../db";
import {
  plannerShadowResultSchema,
  plannerShadowRunSchema,
  type PlannerShadowResultDto,
  type PlannerShadowRunDto,
  type SupplySnapshotContentDto,
  type SupplySnapshotDto,
} from "@shared/types/inventory-availability-planner";
import {
  calculateLegacyAtpBaseFromSnapshot,
  parseSupplySnapshot,
  sealSupplySnapshot,
} from "../domain/inventory-availability-planner";

type QueryResult = { rows: any[] };
type QueryClient = Pick<PoolClient, "query">;
type ClientPool = Pick<Pool, "connect">;

// Defensive corruption/abuse bound: a package/build graph spanning this many products
// cannot be reviewed or calculated safely inside a synchronous admin shadow request.
const MAX_TRANSFORMATION_GRAPH_PRODUCTS = 1_000;
// Nine bind parameters per row keeps each insert far below PostgreSQL's parameter limit.
const SHADOW_RESULT_INSERT_BATCH_SIZE = 250;

export type PersistPlannerShadowRunInput = {
  snapshot: SupplySnapshotDto;
  results: PlannerShadowResultDto[];
  requestedBy: string;
  idempotencyKey: string;
  completedAt: Date;
};

export interface InventoryAvailabilityShadowStore {
  captureSupplySnapshot(productId: number): Promise<SupplySnapshotDto>;
  persistShadowRun(input: PersistPlannerShadowRunInput): Promise<PlannerShadowRunDto>;
  getLatestShadowRun(productId: number): Promise<PlannerShadowRunDto | null>;
}

export class InventoryAvailabilityShadowRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityShadowRepositoryError";
  }
}

function rows(result: QueryResult): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function integer(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value == null ? null : integer(value, field);
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t";
}

function iso(value: unknown, field: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a timestamp`,
      { field, value },
    );
  }
  return parsed.toISOString();
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // The classified repository error below preserves the field name.
    }
  }
  throw new InventoryAvailabilityShadowRepositoryError(
    "INVALID_DATABASE_EVIDENCE",
    `${field} must be a JSON object`,
    { field },
  );
}

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function validateProductId(productId: number): number {
  if (!Number.isSafeInteger(productId) || productId <= 0 || productId > 2_147_483_647) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INVALID_PRODUCT_ID",
      "Product identifier must be a positive PostgreSQL integer.",
      { productId },
    );
  }
  return productId;
}

type LoadedModel = SupplySnapshotDto["transformationModels"][number];

async function loadSelectedModel(client: QueryClient, productId: number): Promise<LoadedModel | null> {
  const modelRow = rows(await client.query(
    `SELECT head.product_id,
            head.draft_model_id,
            head.active_model_id,
            model.id AS model_id,
            model.version,
            model.lifecycle_status,
            model.build_to_promise_enabled,
            model.definition_hash,
            model.validation_state,
            model.validation_errors
     FROM inventory.transformation_model_heads AS head
     JOIN inventory.transformation_model_versions AS model
       ON model.id = COALESCE(head.draft_model_id, head.active_model_id)
      AND model.product_id = head.product_id
     WHERE head.product_id = $1`,
    [productId],
  ))[0];
  if (!modelRow) return null;
  const modelId = integer(modelRow.model_id, "model.id");
  const pathRows = rows(await client.query(
    `SELECT id, source_variant_id, destination_variant_id,
            input_qty, output_qty, source_units_per_variant, destination_units_per_variant,
            operation_type, authority_state, validation_state, validation_errors,
            transformation_recipe_binding_id
     FROM inventory.transformation_model_paths
     WHERE model_id = $1
     ORDER BY source_variant_id, destination_variant_id, id`,
    [modelId],
  ));
  const bindingRows = rows(await client.query(
    `SELECT binding.id AS binding_id,
            binding.recipe_id,
            binding.relationship_role,
            binding.warehouse_id,
            binding.recipe_code_snapshot,
            binding.recipe_version_snapshot,
            binding.recipe_definition_hash,
            binding.output_product_id_snapshot,
            binding.output_variant_id_snapshot,
            binding.output_units_per_variant_snapshot,
            binding.output_qty_snapshot,
            binding.validation_state,
            binding.validation_errors,
            component.component_variant_id,
            component.component_product_id,
            component.component_units_per_variant,
            component.component_qty
     FROM inventory.transformation_recipe_bindings AS binding
     JOIN inventory.transformation_recipe_component_snapshots AS component
       ON component.transformation_recipe_binding_id = binding.id
      AND component.model_id = binding.model_id
     WHERE binding.model_id = $1
     ORDER BY binding.id, component.component_variant_id`,
    [modelId],
  ));
  const bindingById = new Map<number, LoadedModel["recipeBindings"][number]>();
  for (const row of bindingRows) {
    const bindingId = integer(row.binding_id, "binding.id");
    const binding: LoadedModel["recipeBindings"][number] = bindingById.get(bindingId) ?? {
      bindingId,
      recipeId: integer(row.recipe_id, "binding.recipeId"),
      relationshipRole: row.relationship_role,
      warehouseId: nullableInteger(row.warehouse_id, "binding.warehouseId"),
      recipeCodeSnapshot: String(row.recipe_code_snapshot),
      recipeVersionSnapshot: integer(row.recipe_version_snapshot, "binding.recipeVersion"),
      recipeDefinitionHash: String(row.recipe_definition_hash),
      outputProductId: integer(row.output_product_id_snapshot, "binding.outputProductId"),
      outputVariantId: integer(row.output_variant_id_snapshot, "binding.outputVariantId"),
      outputUnitsPerVariant: integer(row.output_units_per_variant_snapshot, "binding.outputUnitsPerVariant"),
      outputQty: String(row.output_qty_snapshot),
      validationState: row.validation_state,
      validationErrors: jsonArray(row.validation_errors),
      components: [],
    };
    binding.components.push({
      componentVariantId: integer(row.component_variant_id, "binding.componentVariantId"),
      componentProductId: integer(row.component_product_id, "binding.componentProductId"),
      componentUnitsPerVariant: integer(row.component_units_per_variant, "binding.componentUnitsPerVariant"),
      componentQty: String(row.component_qty),
    });
    bindingById.set(bindingId, binding);
  }
  return {
    modelId,
    productId,
    version: integer(modelRow.version, "model.version"),
    lifecycleSelection: modelRow.draft_model_id == null ? "active_head" : "draft_head",
    lifecycleStatus: modelRow.lifecycle_status,
    buildToPromiseEnabled: bool(modelRow.build_to_promise_enabled),
    definitionHash: String(modelRow.definition_hash),
    validationState: modelRow.validation_state,
    validationErrors: jsonArray(modelRow.validation_errors),
    paths: pathRows.map((row) => ({
      pathId: integer(row.id, "path.id"),
      sourceVariantId: integer(row.source_variant_id, "path.sourceVariantId"),
      destinationVariantId: integer(row.destination_variant_id, "path.destinationVariantId"),
      inputQty: String(row.input_qty),
      outputQty: String(row.output_qty),
      sourceUnitsPerVariant: integer(row.source_units_per_variant, "path.sourceUnitsPerVariant"),
      destinationUnitsPerVariant: integer(row.destination_units_per_variant, "path.destinationUnitsPerVariant"),
      operationType: row.operation_type,
      authorityState: row.authority_state,
      validationState: row.validation_state,
      validationErrors: jsonArray(row.validation_errors),
      transformationRecipeBindingId: nullableInteger(
        row.transformation_recipe_binding_id,
        "path.transformationRecipeBindingId",
      ),
    })),
    recipeBindings: [...bindingById.values()],
  };
}

async function loadModelGraph(client: QueryClient, productId: number): Promise<LoadedModel[]> {
  const queue = [productId];
  const visited = new Set<number>();
  const models: LoadedModel[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (visited.size > MAX_TRANSFORMATION_GRAPH_PRODUCTS) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "TRANSFORMATION_GRAPH_TOO_LARGE",
        "Transformation model graph exceeded the bounded product limit.",
        { productId, limit: MAX_TRANSFORMATION_GRAPH_PRODUCTS },
      );
    }
    const model = await loadSelectedModel(client, current);
    if (!model) continue;
    models.push(model);
    for (const componentProductId of model.recipeBindings.flatMap((binding) =>
      binding.components.map((component) => component.componentProductId))) {
      if (!visited.has(componentProductId)) queue.push(componentProductId);
    }
  }
  return models.sort((left, right) => left.productId - right.productId);
}

async function loadLegacyRecipes(
  client: QueryClient,
  targetVariantIds: readonly number[],
): Promise<SupplySnapshotDto["legacyRecipes"]> {
  const recipeRows = rows(await client.query(
    `WITH RECURSIVE relevant_variants(variant_id) AS (
       SELECT unnest($1::integer[])
       UNION
       SELECT component.component_variant_id
       FROM relevant_variants AS relevant
       JOIN inventory.build_recipes AS recipe
         ON recipe.output_variant_id = relevant.variant_id
        AND recipe.status = 'active'
       JOIN catalog.products AS output_product
         ON output_product.id = recipe.output_product_id
        AND output_product.inventory_strategy = 'recipe_managed'
       JOIN catalog.product_variants AS output_variant
         ON output_variant.id = recipe.output_variant_id
        AND output_variant.is_active = true
       JOIN inventory.build_recipe_components AS component ON component.recipe_id = recipe.id
       JOIN catalog.product_variants AS component_variant
         ON component_variant.id = component.component_variant_id
        AND component_variant.is_active = true
     )
     SELECT recipe.id AS recipe_id,
            recipe.output_product_id,
            recipe.output_variant_id,
            recipe.output_qty,
            component.component_product_id,
            component.component_variant_id,
            component.qty AS component_qty
     FROM inventory.build_recipes AS recipe
     JOIN catalog.products AS output_product
       ON output_product.id = recipe.output_product_id
      AND output_product.inventory_strategy = 'recipe_managed'
     JOIN catalog.product_variants AS output_variant
       ON output_variant.id = recipe.output_variant_id
      AND output_variant.is_active = true
     JOIN inventory.build_recipe_components AS component ON component.recipe_id = recipe.id
     JOIN relevant_variants AS relevant ON relevant.variant_id = recipe.output_variant_id
     JOIN catalog.product_variants AS component_variant
       ON component_variant.id = component.component_variant_id
      AND component_variant.is_active = true
     WHERE recipe.status = 'active'
     ORDER BY recipe.output_variant_id, recipe.id, component.component_variant_id`,
    [targetVariantIds],
  ));
  const byId = new Map<number, SupplySnapshotDto["legacyRecipes"][number]>();
  for (const row of recipeRows) {
    const recipeId = integer(row.recipe_id, "legacyRecipe.id");
    const recipe = byId.get(recipeId) ?? {
      recipeId,
      outputProductId: integer(row.output_product_id, "legacyRecipe.outputProductId"),
      outputVariantId: integer(row.output_variant_id, "legacyRecipe.outputVariantId"),
      outputQty: String(row.output_qty),
      components: [],
    };
    recipe.components.push({
      componentProductId: integer(row.component_product_id, "legacyRecipe.componentProductId"),
      componentVariantId: integer(row.component_variant_id, "legacyRecipe.componentVariantId"),
      componentQty: String(row.component_qty),
    });
    byId.set(recipeId, recipe);
  }
  return [...byId.values()];
}

async function captureInsideTransaction(client: QueryClient, productId: number): Promise<SupplySnapshotDto> {
  const snapshotRow = rows(await client.query(
    `SELECT transaction_timestamp() AS captured_at`,
  ))[0];
  const product = rows(await client.query(
    `SELECT id, inventory_strategy
     FROM catalog.products
     WHERE id = $1`,
    [productId],
  ))[0];
  if (!product) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "PRODUCT_NOT_FOUND",
      "Inventory-planning product was not found.",
      { productId },
    );
  }

  const models = await loadModelGraph(client, productId);
  const modelProductIds = new Set<number>([productId]);
  for (const model of models) {
    modelProductIds.add(model.productId);
    for (const binding of model.recipeBindings) {
      modelProductIds.add(binding.outputProductId);
      for (const component of binding.components) modelProductIds.add(component.componentProductId);
    }
  }
  const initialVariants = rows(await client.query(
    `SELECT id, product_id, sku, name, units_per_variant, is_active
     FROM catalog.product_variants
     WHERE product_id = ANY($1::integer[])
     ORDER BY product_id, id`,
    [uniqueSorted(modelProductIds)],
  ));
  const targetVariantIds = initialVariants
    .filter((row) => Number(row.product_id) === productId && bool(row.is_active))
    .map((row) => integer(row.id, "targetVariant.id"));
  const legacyRecipes = await loadLegacyRecipes(client, targetVariantIds);
  const relevantProductIds = new Set(modelProductIds);
  for (const recipe of legacyRecipes) {
    relevantProductIds.add(recipe.outputProductId);
    for (const component of recipe.components) relevantProductIds.add(component.componentProductId);
  }
  const variantRows = rows(await client.query(
    `SELECT id, product_id, sku, name, units_per_variant, is_active
     FROM catalog.product_variants
     WHERE product_id = ANY($1::integer[])
     ORDER BY product_id, id`,
    [uniqueSorted(relevantProductIds)],
  ));
  const variants: SupplySnapshotDto["variants"] = variantRows.map((row) => ({
    id: integer(row.id, "variant.id"),
    productId: integer(row.product_id, "variant.productId"),
    sku: row.sku == null ? null : String(row.sku),
    name: String(row.name),
    unitsPerVariant: integer(row.units_per_variant, "variant.unitsPerVariant"),
    isActive: bool(row.is_active),
  }));
  const variantIds = variants.map((variant) => variant.id);

  const warehouseRows = rows(await client.query(
    `SELECT id, code, is_active, hub_warehouse_id
     FROM warehouse.warehouses
     ORDER BY id`,
  ));
  const warehouses: SupplySnapshotDto["warehouses"] = warehouseRows.map((row) => ({
    id: integer(row.id, "warehouse.id"),
    code: String(row.code),
    isActive: bool(row.is_active),
    hubWarehouseId: nullableInteger(row.hub_warehouse_id, "warehouse.hubWarehouseId"),
  }));

  const positionRows = rows(await client.query(
    `SELECT id, warehouse_location_id, product_variant_id,
            variant_qty, reserved_qty, picked_qty, packed_qty
     FROM inventory.inventory_levels
     WHERE product_variant_id = ANY($1::integer[])
     ORDER BY warehouse_location_id, product_variant_id, id`,
    [variantIds],
  ));
  const inventoryPositions: SupplySnapshotDto["inventoryPositions"] = positionRows.map((row) => ({
    inventoryLevelId: integer(row.id, "inventoryLevel.id"),
    warehouseLocationId: integer(row.warehouse_location_id, "inventoryLevel.locationId"),
    productVariantId: integer(row.product_variant_id, "inventoryLevel.variantId"),
    variantQty: String(row.variant_qty),
    reservedQty: String(row.reserved_qty),
    pickedQty: String(row.picked_qty),
    packedQty: String(row.packed_qty),
  }));
  const outputRows = rows(await client.query(
    `SELECT DISTINCT ON (assignment.product_variant_id, location.warehouse_id)
            assignment.product_variant_id,
            location.warehouse_id,
            assignment.warehouse_location_id
     FROM warehouse.product_locations AS assignment
     JOIN warehouse.warehouse_locations AS location
       ON location.id = assignment.warehouse_location_id
      AND location.is_active = 1
      AND location.cycle_count_freeze_id IS NULL
     WHERE assignment.product_variant_id = ANY($1::integer[])
       AND assignment.status = 'active'
       AND location.warehouse_id IS NOT NULL
     ORDER BY assignment.product_variant_id, location.warehouse_id,
              assignment.is_primary DESC, assignment.id`,
    [variantIds],
  ));
  const outputLocations: SupplySnapshotDto["outputLocations"] = outputRows.map((row) => ({
    productVariantId: integer(row.product_variant_id, "outputLocation.variantId"),
    warehouseId: integer(row.warehouse_id, "outputLocation.warehouseId"),
    warehouseLocationId: integer(row.warehouse_location_id, "outputLocation.locationId"),
  }));
  const locationIds = uniqueSorted([
    ...inventoryPositions.map((entry) => entry.warehouseLocationId),
    ...outputLocations.map((entry) => entry.warehouseLocationId),
  ]);
  const locationRows = locationIds.length === 0 ? [] : rows(await client.query(
    `SELECT location.id,
            location.warehouse_id,
            location.code,
            location.location_type,
            location.is_pickable,
            location.is_active,
            location.cycle_count_freeze_id,
            head.draft_policy_id,
            policy.id AS policy_id,
            policy.version AS policy_version,
            policy.eligibility_mode,
            policy.definition_hash
     FROM warehouse.warehouse_locations AS location
     LEFT JOIN inventory.location_promise_policy_heads AS head
       ON head.warehouse_location_id = location.id
     LEFT JOIN inventory.location_promise_policy_versions AS policy
       ON policy.id = COALESCE(head.draft_policy_id, head.active_policy_id)
      AND policy.warehouse_location_id = location.id
     WHERE location.id = ANY($1::integer[])
     ORDER BY location.id`,
    [locationIds],
  ));
  const locations: SupplySnapshotDto["locations"] = locationRows.map((row) => ({
    id: integer(row.id, "location.id"),
    warehouseId: nullableInteger(row.warehouse_id, "location.warehouseId"),
    code: String(row.code),
    locationType: String(row.location_type),
    isPickable: bool(row.is_pickable),
    isActive: bool(row.is_active),
    isFrozen: row.cycle_count_freeze_id != null,
    promisePolicy: row.policy_id == null ? null : {
      policyId: integer(row.policy_id, "locationPolicy.id"),
      version: integer(row.policy_version, "locationPolicy.version"),
      lifecycleSelection: row.draft_policy_id == null ? "active_head" : "draft_head",
      eligibilityMode: row.eligibility_mode,
      definitionHash: String(row.definition_hash),
    },
  }));

  const safetyRows = rows(await client.query(
    `SELECT head.draft_policy_id,
            policy.id AS policy_id,
            policy.version,
            policy.scope_key,
            policy.scope_type,
            policy.product_variant_id,
            policy.warehouse_id,
            policy.policy_mode,
            policy.fixed_units,
            policy.days_of_cover_milli_days,
            policy.untrusted_demand_fallback_units,
            policy.demand_method_version,
            policy.definition_hash
     FROM inventory.promise_safety_policy_heads AS head
     JOIN inventory.promise_safety_policy_versions AS policy
       ON policy.id = COALESCE(head.draft_policy_id, head.active_policy_id)
      AND policy.scope_key = head.scope_key
     WHERE policy.scope_key = 'business'
        OR policy.product_variant_id = ANY($1::integer[])
     ORDER BY policy.scope_key`,
    [variantIds],
  ));
  const safetyPolicies: SupplySnapshotDto["safetyPolicies"] = safetyRows.map((row) => ({
    policyId: integer(row.policy_id, "safetyPolicy.id"),
    version: integer(row.version, "safetyPolicy.version"),
    lifecycleSelection: row.draft_policy_id == null ? "active_head" : "draft_head",
    scopeKey: String(row.scope_key),
    scopeType: row.scope_type,
    productVariantId: nullableInteger(row.product_variant_id, "safetyPolicy.productVariantId"),
    warehouseId: nullableInteger(row.warehouse_id, "safetyPolicy.warehouseId"),
    policyMode: row.policy_mode,
    fixedUnits: row.fixed_units == null ? null : String(row.fixed_units),
    daysOfCoverMilliDays: row.days_of_cover_milli_days == null
      ? null
      : String(row.days_of_cover_milli_days),
    untrustedDemandFallbackUnits: row.untrusted_demand_fallback_units == null
      ? null
      : String(row.untrusted_demand_fallback_units),
    demandMethodVersion: row.demand_method_version == null ? null : String(row.demand_method_version),
    definitionHash: String(row.definition_hash),
  }));

  const demandRows = rows(await client.query(
    `SELECT DISTINCT ON (
            evidence.product_variant_id,
            COALESCE(evidence.warehouse_id, 0),
            evidence.method_version
          )
            evidence.id,
            evidence.product_variant_id,
            evidence.warehouse_id,
            evidence.daily_demand_milli_units,
            evidence.trust_status,
            evidence.trust_reasons,
            evidence.method_version,
            evidence.input_fingerprint,
            evidence.override_expires_at,
            evidence.calculated_at
     FROM inventory.demand_evidence_snapshots AS evidence
     WHERE evidence.product_variant_id = ANY($1::integer[])
     ORDER BY evidence.product_variant_id,
              COALESCE(evidence.warehouse_id, 0),
              evidence.method_version,
              evidence.calculated_at DESC,
              evidence.id DESC`,
    [variantIds],
  ));
  const demandEvidence: SupplySnapshotDto["demandEvidence"] = demandRows.map((row) => ({
    evidenceId: String(row.id),
    productVariantId: integer(row.product_variant_id, "demandEvidence.productVariantId"),
    warehouseId: nullableInteger(row.warehouse_id, "demandEvidence.warehouseId"),
    dailyDemandMilliUnits: String(row.daily_demand_milli_units),
    trustStatus: row.trust_status,
    trustReasons: jsonArray(row.trust_reasons).map((reason) => String(reason)),
    methodVersion: String(row.method_version),
    inputFingerprint: String(row.input_fingerprint),
    overrideExpiresAt: row.override_expires_at == null
      ? null
      : iso(row.override_expires_at, "demandEvidence.overrideExpiresAt"),
    calculatedAt: iso(row.calculated_at, "demandEvidence.calculatedAt"),
  }));

  const content: SupplySnapshotContentDto = {
    schemaVersion: "inventory_availability_snapshot_v1",
    capturedAt: iso(snapshotRow?.captured_at, "snapshot.capturedAt"),
    productId,
    legacyInventoryStrategy: product.inventory_strategy,
    variants,
    warehouses,
    locations,
    inventoryPositions,
    safetyPolicies,
    demandEvidence,
    transformationModels: models,
    legacyRecipes,
    outputLocations,
    claimProjectionSource: "inventory_levels.reserved_qty",
  };
  return sealSupplySnapshot(content);
}

function validatePersistenceInput(input: PersistPlannerShadowRunInput): {
  snapshot: SupplySnapshotDto;
  results: PlannerShadowResultDto[];
  requestedBy: string;
  idempotencyKey: string;
} {
  if (!(input.completedAt instanceof Date) || Number.isNaN(input.completedAt.getTime())) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INVALID_COMPLETION_TIME",
      "Shadow-run completion time must be a valid Date.",
    );
  }
  const snapshot = parseSupplySnapshot(input.snapshot);
  const results = input.results.map((result) => plannerShadowResultSchema.parse(result));
  const requestedBy = input.requestedBy.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (requestedBy.length === 0 || requestedBy.length > 100) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INVALID_ACTOR",
      "Shadow-run actor must contain 1 to 100 characters.",
      { requestedByLength: requestedBy.length },
    );
  }
  if (idempotencyKey.length === 0 || idempotencyKey.length > 120) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INVALID_IDEMPOTENCY_KEY",
      "Shadow-run idempotency key must contain 1 to 120 characters.",
      { idempotencyKeyLength: idempotencyKey.length },
    );
  }
  if (input.completedAt.getTime() < Date.parse(snapshot.capturedAt)) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INVALID_COMPLETION_TIME",
      "Shadow-run completion time cannot precede the captured snapshot.",
      { capturedAt: snapshot.capturedAt, completedAt: input.completedAt.toISOString() },
    );
  }
  const targetVariants = new Set(snapshot.variants
    .filter((variant) => variant.productId === snapshot.productId && variant.isActive)
    .map((variant) => variant.id));
  const activeWarehouseIds = new Set(snapshot.warehouses
    .filter((warehouse) => warehouse.isActive)
    .map((warehouse) => warehouse.id));
  const warehouseCodes = new Map(snapshot.warehouses.map((warehouse) =>
    [warehouse.id, warehouse.code] as const));
  const variantsById = new Map(snapshot.variants.map((variant) => [variant.id, variant] as const));
  if (targetVariants.size === 0) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "NO_ACTIVE_PRODUCT_VARIANTS",
      "A shadow run requires at least one active target-product variant.",
      { productId: snapshot.productId },
    );
  }
  const resultKeys = new Set<string>();
  for (const result of results) {
    if (!targetVariants.has(result.productVariantId)) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "INVALID_SHADOW_RESULT_VARIANT",
        "Every shadow result must reference an active variant of the target product.",
        { productId: snapshot.productId, productVariantId: result.productVariantId },
      );
    }
    if (result.proposedProjection.snapshotFingerprint !== snapshot.snapshotFingerprint) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "SHADOW_EVIDENCE_MISMATCH",
        "Shadow result and supply snapshot fingerprints must match.",
        { productVariantId: result.productVariantId },
      );
    }
    const scopeMatches = result.warehouseId === null
      ? result.proposedProjection.scope.kind === "network"
      : result.proposedProjection.scope.kind === "warehouse"
        && result.proposedProjection.scope.warehouseId === result.warehouseId;
    if (!scopeMatches || result.proposedProjection.targetVariantId !== result.productVariantId) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "SHADOW_EVIDENCE_SCOPE_MISMATCH",
        "Shadow result keys and proposed projection scope must match.",
        { warehouseId: result.warehouseId, productVariantId: result.productVariantId },
      );
    }
    if (result.warehouseId !== null && !activeWarehouseIds.has(result.warehouseId)) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "INVALID_SHADOW_RESULT_WAREHOUSE",
        "Warehouse shadow results must reference an active snapshot warehouse.",
        { warehouseId: result.warehouseId },
      );
    }
    const variant = variantsById.get(result.productVariantId)!;
    const expectedWarehouseCode = result.warehouseId === null
      ? null
      : warehouseCodes.get(result.warehouseId) ?? null;
    if (result.warehouseCodeSnapshot !== expectedWarehouseCode
      || result.productVariantSkuSnapshot !== variant.sku
      || result.productVariantNameSnapshot !== variant.name
      || result.productVariantUnitsPerVariantSnapshot !== variant.unitsPerVariant) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "SHADOW_EVIDENCE_LABEL_MISMATCH",
        "Shadow result labels must match the sealed supply snapshot.",
        { warehouseId: result.warehouseId, productVariantId: result.productVariantId },
      );
    }
    const expectedLegacyAtpBase = calculateLegacyAtpBaseFromSnapshot(snapshot, {
      targetVariantId: result.productVariantId,
      scope: result.warehouseId === null
        ? { kind: "network" }
        : { kind: "warehouse", warehouseId: result.warehouseId },
    });
    if (BigInt(result.legacyAtpBaseUnits) !== expectedLegacyAtpBase) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "INVALID_SHADOW_LEGACY_BASE",
        "Legacy ATP base units must match the sealed supply snapshot.",
        { warehouseId: result.warehouseId, productVariantId: result.productVariantId },
      );
    }
    if (BigInt(result.differenceUnits) !== BigInt(result.proposedAtpUnits) - BigInt(result.legacyAtpUnits)) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "INVALID_SHADOW_RESULT_DIFFERENCE",
        "Shadow result difference must equal proposed ATP minus legacy ATP.",
        { warehouseId: result.warehouseId, productVariantId: result.productVariantId },
      );
    }
    const key = `${result.warehouseId ?? "network"}:${result.productVariantId}`;
    if (resultKeys.has(key)) {
      throw new InventoryAvailabilityShadowRepositoryError(
        "DUPLICATE_SHADOW_RESULT",
        "Shadow results cannot repeat a scope and product variant.",
        { key },
      );
    }
    resultKeys.add(key);
  }
  const expectedResultCount = targetVariants.size * (activeWarehouseIds.size + 1);
  if (resultKeys.size !== expectedResultCount) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "INCOMPLETE_SHADOW_EVIDENCE",
      "A shadow run must include every active target variant for every active warehouse and the network scope.",
      { expectedResultCount, actualResultCount: resultKeys.size },
    );
  }
  for (const variantId of targetVariants) {
    for (const warehouseId of [null, ...activeWarehouseIds]) {
      const key = `${warehouseId ?? "network"}:${variantId}`;
      if (!resultKeys.has(key)) {
        throw new InventoryAvailabilityShadowRepositoryError(
          "INCOMPLETE_SHADOW_EVIDENCE",
          "A required warehouse/variant shadow result is missing.",
          { warehouseId, productVariantId: variantId },
        );
      }
    }
  }
  return { snapshot, results, requestedBy, idempotencyKey };
}

async function loadShadowRun(
  client: QueryClient,
  whereSql: string,
  parameters: unknown[],
  alreadyApplied: boolean,
): Promise<PlannerShadowRunDto | null> {
  const run = rows(await client.query(
    `SELECT id, product_id, model_id, model_version, model_definition_hash,
            legacy_inventory_strategy, status, snapshot_fingerprint, blocker_codes,
            snapshot_payload, requested_by, captured_at, completed_at
     FROM inventory.planner_shadow_runs
     WHERE ${whereSql}
     ORDER BY completed_at DESC, id DESC
     LIMIT 1`,
    parameters,
  ))[0];
  if (!run) return null;
  const snapshot = parseSupplySnapshot(jsonObject(run.snapshot_payload, "shadowRun.snapshotPayload"));
  const runProductId = integer(run.product_id, "shadowRun.productId");
  if (snapshot.productId !== runProductId
    || snapshot.snapshotFingerprint !== String(run.snapshot_fingerprint)
    || snapshot.legacyInventoryStrategy !== run.legacy_inventory_strategy) {
    throw new InventoryAvailabilityShadowRepositoryError(
      "SHADOW_RUN_SNAPSHOT_MISMATCH",
      "Stored shadow-run columns do not match the sealed snapshot payload.",
      { runId: String(run.id) },
    );
  }
  const warehouseCodes = new Map(snapshot.warehouses.map((warehouse) =>
    [warehouse.id, warehouse.code] as const));
  const variants = new Map(snapshot.variants.map((variant) => [variant.id, variant] as const));
  const resultRows = rows(await client.query(
    `SELECT warehouse_id, product_variant_id, legacy_atp_units, proposed_atp_units,
            difference_units, readiness_state, classifications, proposed_projection
     FROM inventory.planner_shadow_results
     WHERE run_id = $1
     ORDER BY warehouse_id NULLS FIRST, product_variant_id`,
    [run.id],
  ));
  return plannerShadowRunSchema.parse({
    runId: String(run.id),
    productId: runProductId,
    legacyInventoryStrategy: run.legacy_inventory_strategy,
    status: run.status,
    snapshotFingerprint: String(run.snapshot_fingerprint),
    capturedAt: iso(run.captured_at, "shadowRun.capturedAt"),
    completedAt: iso(run.completed_at, "shadowRun.completedAt"),
    requestedBy: String(run.requested_by),
    modelId: nullableInteger(run.model_id, "shadowRun.modelId"),
    modelVersion: nullableInteger(run.model_version, "shadowRun.modelVersion"),
    modelDefinitionHash: run.model_definition_hash == null ? null : String(run.model_definition_hash),
    blockerCodes: jsonArray(run.blocker_codes).map((code) => String(code)),
    results: resultRows.map((result) => {
      const warehouseId = nullableInteger(result.warehouse_id, "shadowResult.warehouseId");
      const productVariantId = integer(result.product_variant_id, "shadowResult.productVariantId");
      const variant = variants.get(productVariantId);
      if (!variant || (warehouseId !== null && !warehouseCodes.has(warehouseId))) {
        throw new InventoryAvailabilityShadowRepositoryError(
          "SHADOW_RESULT_SNAPSHOT_MISMATCH",
          "Stored shadow result references evidence absent from its sealed snapshot.",
          { warehouseId, productVariantId },
        );
      }
      return {
        warehouseId,
        warehouseCodeSnapshot: warehouseId === null ? null : warehouseCodes.get(warehouseId)!,
        productVariantId,
        productVariantSkuSnapshot: variant.sku,
        productVariantNameSnapshot: variant.name,
        productVariantUnitsPerVariantSnapshot: variant.unitsPerVariant,
        legacyAtpUnits: String(result.legacy_atp_units),
        legacyAtpBaseUnits: calculateLegacyAtpBaseFromSnapshot(snapshot, {
          targetVariantId: productVariantId,
          scope: warehouseId === null
            ? { kind: "network" }
            : { kind: "warehouse", warehouseId },
        }).toString(),
        proposedAtpUnits: String(result.proposed_atp_units),
        differenceUnits: String(result.difference_units),
        readinessState: result.readiness_state,
        classifications: jsonArray(result.classifications).map((classification) => String(classification)),
        proposedProjection: jsonObject(result.proposed_projection, "shadowResult.proposedProjection"),
      };
    }),
    alreadyApplied,
  });
}

async function inTransaction<T>(
  connectionPool: ClientPool,
  beginStatement: "BEGIN" | "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connectionPool.connect();
  let began = false;
  try {
    await client.query(beginStatement);
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    began = false;
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Inventory availability shadow transaction and rollback both failed.",
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

export class PostgresInventoryAvailabilityShadowRepository implements InventoryAvailabilityShadowStore {
  constructor(private readonly connectionPool: ClientPool = pool) {}

  async captureSupplySnapshot(productId: number): Promise<SupplySnapshotDto> {
    const validatedProductId = validateProductId(productId);
    return inTransaction(
      this.connectionPool,
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      (client) => captureInsideTransaction(client, validatedProductId),
    );
  }

  async persistShadowRun(input: PersistPlannerShadowRunInput): Promise<PlannerShadowRunDto> {
    const validated = validatePersistenceInput(input);
    const targetModel = validated.snapshot.transformationModels.find(
      (model) => model.productId === validated.snapshot.productId,
    ) ?? null;
    const blockerCodes = [...new Set(validated.results.flatMap((result) =>
      result.proposedProjection.blockers.map((blocker) => blocker.code)))].sort();
    const status = validated.results.some((result) => result.readinessState === "blocked")
      ? "blocked"
      : "completed";

    return inTransaction(this.connectionPool, "BEGIN", async (client) => {
      const inserted = rows(await client.query(
        `INSERT INTO inventory.planner_shadow_runs (
           product_id, model_id, model_version, model_definition_hash,
           legacy_inventory_strategy, snapshot_fingerprint, snapshot_payload,
           status, blocker_codes, idempotency_key, requested_by, captured_at, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13
         )
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          validated.snapshot.productId,
          targetModel?.modelId ?? null,
          targetModel?.version ?? null,
          targetModel?.definitionHash ?? null,
          validated.snapshot.legacyInventoryStrategy,
          validated.snapshot.snapshotFingerprint,
          JSON.stringify(validated.snapshot),
          status,
          JSON.stringify(blockerCodes),
          validated.idempotencyKey,
          validated.requestedBy,
          validated.snapshot.capturedAt,
          input.completedAt.toISOString(),
        ],
      ))[0];

      if (!inserted) {
        const conflict = rows(await client.query(
          `SELECT product_id
           FROM inventory.planner_shadow_runs
           WHERE idempotency_key = $1`,
          [validated.idempotencyKey],
        ))[0];
        if (!conflict) {
          throw new InventoryAvailabilityShadowRepositoryError(
            "IDEMPOTENCY_CONFLICT_NOT_VISIBLE",
            "The idempotency key conflicted but the existing shadow run could not be found.",
            { idempotencyKey: validated.idempotencyKey },
          );
        }
        const existingProductId = integer(conflict.product_id, "shadowRun.productId");
        if (existingProductId !== validated.snapshot.productId) {
          throw new InventoryAvailabilityShadowRepositoryError(
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key already belongs to a different product.",
            {
              idempotencyKey: validated.idempotencyKey,
              existingProductId,
              requestedProductId: validated.snapshot.productId,
            },
          );
        }
        const existing = await loadShadowRun(
          client,
          "idempotency_key = $1",
          [validated.idempotencyKey],
          true,
        );
        if (!existing) {
          throw new InventoryAvailabilityShadowRepositoryError(
            "IDEMPOTENCY_CONFLICT_NOT_VISIBLE",
            "The idempotency key conflicted but the existing shadow run could not be loaded.",
            { idempotencyKey: validated.idempotencyKey },
          );
        }
        return existing;
      }

      const runId = String(inserted.id);
      for (const batch of chunks(validated.results, SHADOW_RESULT_INSERT_BATCH_SIZE)) {
        const parameters: unknown[] = [];
        const valueRows = batch.map((result, index) => {
          const base = index * 9;
          parameters.push(
            runId,
            result.warehouseId,
            result.productVariantId,
            result.legacyAtpUnits,
            result.proposedAtpUnits,
            result.differenceUnits,
            result.readinessState,
            JSON.stringify(result.classifications),
            JSON.stringify(result.proposedProjection),
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, `
            + `$${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9}::jsonb)`;
        });
        await client.query(
          `INSERT INTO inventory.planner_shadow_results (
             run_id, warehouse_id, product_variant_id, legacy_atp_units,
             proposed_atp_units, difference_units, readiness_state,
             classifications, proposed_projection
           ) VALUES ${valueRows.join(", ")}`,
          parameters,
        );
      }

      const persisted = await loadShadowRun(client, "id = $1", [runId], false);
      if (!persisted) {
        throw new InventoryAvailabilityShadowRepositoryError(
          "PERSISTED_SHADOW_RUN_NOT_VISIBLE",
          "The inserted shadow run could not be reloaded in its transaction.",
          { runId },
        );
      }
      return persisted;
    });
  }

  async getLatestShadowRun(productId: number): Promise<PlannerShadowRunDto | null> {
    const validatedProductId = validateProductId(productId);
    const client = await this.connectionPool.connect();
    try {
      return await loadShadowRun(client, "product_id = $1", [validatedProductId], false);
    } finally {
      client.release();
    }
  }
}
