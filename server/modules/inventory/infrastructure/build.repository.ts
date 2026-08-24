import { sql } from "drizzle-orm";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  assertBuildVariantSnapshotsCurrent,
  BuildDomainError,
  calculateBuildQuantities,
  validateBuildRecipeDefinition,
  type BuildCostTotals,
  type BuildRecipeType,
  type BuildVariantFacts,
} from "../domain/build.domain";
import {
  BuildExecutionRepository,
  type BuildCancellationResult,
  type BuildOrderCompletedContext,
  type BuildExecutionResult,
  type BuildReversalResult,
  type CancelBuildOrderInput,
  type ExecuteBuildRunInput,
  type ReverseBuildRunInput,
} from "./build-execution.repository";

export type {
  BuildCancellationResult,
  BuildOrderCompletedContext,
  BuildExecutionResult,
  BuildReversalResult,
  CancelBuildOrderInput,
  ExecuteBuildRunInput,
  ReverseBuildRunInput,
} from "./build-execution.repository";

type Db = {
  execute: (query: unknown) => Promise<{ rows: any[] }>;
  update: (...args: any[]) => any;
  transaction: <T>(work: (tx: Db) => Promise<T>) => Promise<T>;
};

export type BuildRecipeComponentInput = {
  componentVariantId: number;
  qtyPerBuild: number;
};

export type CreateBuildRecipeInput = {
  code: string;
  name: string;
  recipeType: BuildRecipeType;
  outputVariantId: number;
  outputQty: number;
  components: BuildRecipeComponentInput[];
  status: "draft" | "active";
  notes?: string;
  actorId?: string;
};

export type UpdateBuildRecipeInput = Omit<CreateBuildRecipeInput, "code" | "actorId"> & {
  recipeId: number;
  expectedVersion: number;
  changeReason: string;
  idempotencyKey: string;
  changeRequestHash: string;
  actorId: string;
  changedAt: Date;
};
export type BuildRecipeVersionResult = Record<string, unknown> & {
  id: number;
  code: string;
  version: number;
  output_variant_id: number;
  alreadyApplied: boolean;
  previousOutputVariantId?: number;
};

export type CreateBuildOrderInput = {
  recipeId: number;
  plannedBuilds: number;
  warehouseId: number;
  outputLocationId: number;
  sourceLocations: Array<{ componentVariantId: number; sourceLocationId: number }>;
  idempotencyKey: string;
  actorId?: string;
};


function toBigInt(value: unknown, field: string): bigint {
  try {
    return BigInt(value == null ? 0 : String(value));
  } catch {
    throw new BuildDomainError("INVALID_BUILD_COST", `${field} is not an integer mill value`, {
      field,
      value,
    });
  }
}
function centsToMills(value: unknown, field: string): bigint {
  return toBigInt(value, field) * BigInt(100);
}

function preferredMills(
  mills: unknown,
  cents: unknown,
  millsField: string,
  centsField: string,
): bigint {
  const exactMills = toBigInt(mills, millsField);
  return exactMills > BigInt(0) ? exactMills : centsToMills(cents, centsField);
}

export function buildMillsToRoundedCents(value: bigint): bigint {
  return (value + BigInt(50)) / BigInt(100);
}

export async function loadActiveBuildVariantFacts(
  tx: Pick<Db, "execute">,
  variantIds: number[],
  context: Record<string, unknown> = {},
): Promise<Map<number, BuildVariantFacts>> {
  const uniqueVariantIds = [...new Set(variantIds)];
  if (uniqueVariantIds.length === 0) {
    throw new BuildDomainError("INVALID_BUILD_INPUT", "A build requires at least one catalog variant");
  }

  const variants = await tx.execute(sql`
    SELECT id, is_active, product_id, units_per_variant
    FROM catalog.product_variants
    WHERE id IN (${sql.join(uniqueVariantIds.map((id) => sql`${id}`), sql`, `)})
    FOR SHARE
  `);
  const activeRows = variants.rows.filter(
    (row) => row.is_active === true || Number(row.is_active) === 1,
  );
  const activeIds = new Set(activeRows.map((row) => Number(row.id)));
  const unavailableVariantIds = uniqueVariantIds.filter((id) => !activeIds.has(id));
  if (unavailableVariantIds.length > 0) {
    throw new BuildDomainError("BUILD_VARIANT_UNAVAILABLE", "All build variants must exist and be active", {
      ...context,
      variantIds: unavailableVariantIds,
    });
  }

  return new Map(activeRows.map((row) => {
    const facts: BuildVariantFacts = {
      variantId: Number(row.id),
      productId: Number(row.product_id),
      unitsPerVariant: Number(row.units_per_variant),
    };
    return [facts.variantId, facts];
  }));
}

export async function assertRecipeManagedOutputProduct(
  tx: Pick<Db, "execute">,
  productId: number,
  context: Record<string, unknown> = {},
): Promise<void> {
  const productResult = await tx.execute(sql`
    SELECT id, inventory_strategy
    FROM catalog.products
    WHERE id = ${productId}
    FOR SHARE
  `);
  const product = productResult.rows[0];
  if (!product) {
    throw new BuildDomainError("BUILD_OUTPUT_PRODUCT_NOT_FOUND", `Build output product ${productId} was not found`, {
      ...context,
      productId,
    });
  }
  if (product.inventory_strategy !== "recipe_managed") {
    throw new BuildDomainError(
      "BUILD_OUTPUT_STRATEGY_REQUIRED",
      "Build recipes require the output product to use build-managed inventory",
      {
        ...context,
        productId,
        inventoryStrategy: product.inventory_strategy,
      },
    );
  }
}

export async function assertBuildVariantsActive(
  tx: Pick<Db, "execute">,
  variantIds: number[],
  context: Record<string, unknown> = {},
): Promise<void> {
  await loadActiveBuildVariantFacts(tx, variantIds, context);
}

function getVariantFacts(
  variants: ReadonlyMap<number, BuildVariantFacts>,
  variantId: number,
  context: Record<string, unknown> = {},
): BuildVariantFacts {
  const facts = variants.get(variantId);
  if (!facts) {
    throw new BuildDomainError("BUILD_VARIANT_UNAVAILABLE", "Build variant is unavailable", {
      ...context,
      variantId,
    });
  }
  return facts;
}


export function normalizeBuildLotCosts(lot: any): BuildCostTotals & { totalMills: bigint } {
  const totalMills = preferredMills(
    toBigInt(lot.total_unit_cost_mills, "total_unit_cost_mills") > BigInt(0)
      ? lot.total_unit_cost_mills
      : lot.unit_cost_mills,
    toBigInt(lot.total_unit_cost_cents, "total_unit_cost_cents") > BigInt(0)
      ? lot.total_unit_cost_cents
      : lot.unit_cost_cents,
    "total_unit_cost_mills",
    "total_unit_cost_cents",
  );
  const packagingMills = preferredMills(
    lot.packaging_cost_mills,
    lot.packaging_cost_cents,
    "packaging_cost_mills",
    "packaging_cost_cents",
  );
  const landedMills = preferredMills(
    lot.landed_cost_mills,
    lot.landed_cost_cents,
    "landed_cost_mills",
    "landed_cost_cents",
  );
  const recordedPoMills = preferredMills(
    lot.po_unit_cost_mills,
    lot.po_unit_cost_cents,
    "po_unit_cost_mills",
    "po_unit_cost_cents",
  );
  const negativeField = [
    ["total_unit_cost_mills", totalMills],
    ["po_unit_cost_mills", recordedPoMills],
    ["packaging_cost_mills", packagingMills],
    ["landed_cost_mills", landedMills],
  ].find(([, value]) => (value as bigint) < BigInt(0));
  if (negativeField) {
    throw new BuildDomainError(
      "INVALID_SOURCE_LOT_COST",
      `Lot ${lot.id} has a negative ${negativeField[0]} value`,
      { lotId: Number(lot.id), field: negativeField[0] },
    );
  }
  const nonPoMills = packagingMills + landedMills;
  if (nonPoMills > totalMills) {
    throw new BuildDomainError(
      "INVALID_SOURCE_LOT_COST",
      `Lot ${lot.id} has packaging plus landed cost greater than total cost`,
      { lotId: Number(lot.id) },
    );
  }
  const poMills = recordedPoMills + nonPoMills === totalMills
    ? recordedPoMills
    : totalMills - nonPoMills;
  return { poMills, packagingMills, landedMills, totalMills };
}


export class BuildRepository {
  private readonly execution: BuildExecutionRepository;

  constructor(
    private readonly db: Db,
    options: { onBuildOrderCompleted?: (tx: Db, context: BuildOrderCompletedContext) => Promise<void> } = {},
  ) {
    this.execution = new BuildExecutionRepository(db, {
      loadActiveBuildVariantFacts,
      normalizeBuildLotCosts,
      buildMillsToRoundedCents,
      onBuildOrderCompleted: options.onBuildOrderCompleted,
    });
  }
  private async findIdempotentOrder(
    tx: Db,
    input: CreateBuildOrderInput,
    sourceLocationMap: Map<number, number>,
  ): Promise<any | null> {
    const existingResult = await tx.execute(sql`
      SELECT * FROM inventory.build_orders WHERE idempotency_key = ${input.idempotencyKey}
    `);
    const existing = existingResult.rows[0];
    if (!existing) return null;

    const componentResult = await tx.execute(sql`
      SELECT component_variant_id, source_location_id
      FROM inventory.build_order_components
      WHERE build_order_id = ${existing.id}
    `);
    const persistedSources = new Map(
      componentResult.rows.map((row) => [Number(row.component_variant_id), Number(row.source_location_id)]),
    );
    const sameSources = persistedSources.size === sourceLocationMap.size
      && [...sourceLocationMap.entries()].every(
        ([variantId, locationId]) => persistedSources.get(variantId) === locationId,
      );
    const sameCommand = Number(existing.recipe_id) === input.recipeId
      && Number(existing.planned_builds) === input.plannedBuilds
      && Number(existing.warehouse_id) === input.warehouseId
      && Number(existing.output_location_id) === input.outputLocationId
      && sameSources;
    if (!sameCommand) {
      throw new BuildDomainError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency key already belongs to a different build command",
        { idempotencyKey: input.idempotencyKey },
      );
    }
    return existing;
  }


  async createRecipe(input: CreateBuildRecipeInput): Promise<any> {
    calculateBuildQuantities({
      plannedBuilds: 1,
      outputQtyPerBuild: input.outputQty,
      components: input.components,
    });

    return this.db.transaction(async (tx) => {
      const variantFacts = await loadActiveBuildVariantFacts(
        tx,
        [input.outputVariantId, ...input.components.map((item) => item.componentVariantId)],
      );
      const outputFacts = getVariantFacts(variantFacts, input.outputVariantId);
      await assertRecipeManagedOutputProduct(tx, outputFacts.productId, { outputVariantId: input.outputVariantId });
      const componentDefinitions = input.components.map((component) => ({
        ...getVariantFacts(variantFacts, component.componentVariantId),
        qtyPerBuild: component.qtyPerBuild,
      }));
      validateBuildRecipeDefinition({
        recipeType: input.recipeType,
        output: { ...outputFacts, qtyPerBuild: input.outputQty },
        components: componentDefinitions,
      });

      if (input.status === "active") {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext('inventory.build_recipe_output'), ${input.outputVariantId})
        `);
        const outputConflict = await tx.execute(sql`
          SELECT id, code, version
          FROM inventory.build_recipes
          WHERE output_variant_id = ${input.outputVariantId}
            AND status = 'active'
          LIMIT 1
        `);
        if (outputConflict.rows[0]) {
          throw new BuildDomainError(
            "BUILD_OUTPUT_RECIPE_CONFLICT",
            "The output variant already has an active build recipe",
            {
              outputVariantId: input.outputVariantId,
              recipeId: Number(outputConflict.rows[0].id),
              recipeCode: String(outputConflict.rows[0].code),
              recipeVersion: Number(outputConflict.rows[0].version),
            },
          );
        }
      }

      const recipeResult = await tx.execute(sql`
        INSERT INTO inventory.build_recipes
          (code, name, version, status, recipe_type, output_variant_id,
           output_product_id, output_units_per_variant, output_qty, notes, created_by)
        VALUES
          (${input.code}, ${input.name}, 1, ${input.status}, ${input.recipeType},
           ${input.outputVariantId}, ${outputFacts.productId}, ${outputFacts.unitsPerVariant},
           ${input.outputQty}, ${input.notes ?? null}, ${input.actorId ?? null})
        RETURNING *
      `);
      const recipe = recipeResult.rows[0];
      for (const component of componentDefinitions) {
        await tx.execute(sql`
          INSERT INTO inventory.build_recipe_components
            (recipe_id, component_variant_id, component_product_id,
             component_units_per_variant, qty)
          VALUES
            (${recipe.id}, ${component.variantId}, ${component.productId},
             ${component.unitsPerVariant}, ${component.qtyPerBuild})
        `);
      }
      return recipe;
    });
  }

  async updateRecipe(input: UpdateBuildRecipeInput): Promise<BuildRecipeVersionResult> {
    calculateBuildQuantities({
      plannedBuilds: 1,
      outputQtyPerBuild: input.outputQty,
      components: input.components,
    });

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('inventory.build_recipe_edit'),
          hashtext(${input.idempotencyKey})
        )
      `);
      const idempotentResult = await tx.execute(sql`
        SELECT *
        FROM inventory.build_recipes
        WHERE change_idempotency_key = ${input.idempotencyKey}
        FOR UPDATE
      `);
      const idempotentRecipe = idempotentResult.rows[0];
      if (idempotentRecipe) {
        if (String(idempotentRecipe.change_request_hash) !== input.changeRequestHash) {
          throw new BuildDomainError(
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key already belongs to a different recipe edit",
            { idempotencyKey: input.idempotencyKey },
          );
        }
        return {
          ...idempotentRecipe,
          id: Number(idempotentRecipe.id),
          code: String(idempotentRecipe.code),
          version: Number(idempotentRecipe.version),
          output_variant_id: Number(idempotentRecipe.output_variant_id),
          alreadyApplied: true,
        };
      }

      const currentResult = await tx.execute(sql`
        SELECT *
        FROM inventory.build_recipes
        WHERE id = ${input.recipeId}
        FOR UPDATE
      `);
      const current = currentResult.rows[0];
      if (!current) {
        throw new BuildDomainError(
          "BUILD_RECIPE_NOT_FOUND",
          `Build recipe ${input.recipeId} was not found`,
        );
      }

      const versionsResult = await tx.execute(sql`
        SELECT id, version, status
        FROM inventory.build_recipes
        WHERE code = ${current.code}
        ORDER BY version DESC
        FOR UPDATE
      `);
      const latest = versionsResult.rows[0];
      if (
        current.status === "retired"
        || Number(current.version) !== input.expectedVersion
        || Number(latest?.id) !== Number(current.id)
      ) {
        throw new BuildDomainError(
          "BUILD_RECIPE_VERSION_CONFLICT",
          "This recipe changed after the edit screen was loaded",
          {
            recipeId: input.recipeId,
            expectedVersion: input.expectedVersion,
            actualVersion: Number(current.version),
            latestRecipeId: latest == null ? null : Number(latest.id),
            latestVersion: latest == null ? null : Number(latest.version),
            status: String(current.status),
          },
        );
      }

      const currentComponentsResult = await tx.execute(sql`
        SELECT component_variant_id, component_product_id, component_units_per_variant, qty
        FROM inventory.build_recipe_components
        WHERE recipe_id = ${current.id}
        ORDER BY component_variant_id
      `);
      const before = {
        recipeId: Number(current.id),
        code: String(current.code),
        name: String(current.name),
        version: Number(current.version),
        status: String(current.status),
        recipeType: String(current.recipe_type),
        outputVariantId: Number(current.output_variant_id),
        outputProductId: Number(current.output_product_id),
        outputUnitsPerVariant: Number(current.output_units_per_variant),
        outputQty: Number(current.output_qty),
        notes: current.notes ?? null,
        components: currentComponentsResult.rows.map((component) => ({
          componentVariantId: Number(component.component_variant_id),
          componentProductId: Number(component.component_product_id),
          componentUnitsPerVariant: Number(component.component_units_per_variant),
          qtyPerBuild: Number(component.qty),
        })),
      };

      const variantFacts = await loadActiveBuildVariantFacts(
        tx,
        [input.outputVariantId, ...input.components.map((item) => item.componentVariantId)],
        { recipeId: input.recipeId },
      );
      const outputFacts = getVariantFacts(variantFacts, input.outputVariantId, {
        recipeId: input.recipeId,
      });
      await assertRecipeManagedOutputProduct(tx, outputFacts.productId, {
        recipeId: input.recipeId,
        outputVariantId: input.outputVariantId,
      });
      const componentDefinitions = input.components.map((component) => ({
        ...getVariantFacts(variantFacts, component.componentVariantId, {
          recipeId: input.recipeId,
        }),
        qtyPerBuild: component.qtyPerBuild,
      }));
      validateBuildRecipeDefinition({
        recipeType: input.recipeType,
        output: { ...outputFacts, qtyPerBuild: input.outputQty },
        components: componentDefinitions,
      });

      if (input.status === "active") {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtext('inventory.build_recipe_output'), ${input.outputVariantId})
        `);
        const outputConflict = await tx.execute(sql`
          SELECT id, code, version
          FROM inventory.build_recipes
          WHERE output_variant_id = ${input.outputVariantId}
            AND status = 'active'
            AND code <> ${current.code}
          LIMIT 1
        `);
        if (outputConflict.rows[0]) {
          throw new BuildDomainError(
            "BUILD_OUTPUT_RECIPE_CONFLICT",
            "The output variant already has an active build recipe",
            {
              outputVariantId: input.outputVariantId,
              recipeId: Number(outputConflict.rows[0].id),
              recipeCode: String(outputConflict.rows[0].code),
              recipeVersion: Number(outputConflict.rows[0].version),
            },
          );
        }
      }

      if (input.status === "active") {
        await tx.execute(sql`
          UPDATE inventory.build_recipes
          SET status = 'retired',
              retired_by = ${input.actorId},
              retired_at = ${input.changedAt},
              updated_at = ${input.changedAt}
          WHERE code = ${current.code}
            AND status IN ('active', 'draft')
        `);
      } else if (current.status === "draft") {
        await tx.execute(sql`
          UPDATE inventory.build_recipes
          SET status = 'retired',
              retired_by = ${input.actorId},
              retired_at = ${input.changedAt},
              updated_at = ${input.changedAt}
          WHERE id = ${current.id}
        `);
      }

      const nextVersion = Number(latest.version) + 1;
      const recipeResult = await tx.execute(sql`
        INSERT INTO inventory.build_recipes
          (code, name, version, status, recipe_type, output_variant_id,
           output_product_id, output_units_per_variant, output_qty, notes, created_by,
           supersedes_recipe_id, change_reason, change_idempotency_key, change_request_hash,
           created_at, updated_at)
        VALUES
          (${current.code}, ${input.name}, ${nextVersion}, ${input.status}, ${input.recipeType},
           ${input.outputVariantId}, ${outputFacts.productId}, ${outputFacts.unitsPerVariant},
           ${input.outputQty}, ${input.notes ?? null}, ${input.actorId}, ${current.id},
           ${input.changeReason}, ${input.idempotencyKey}, ${input.changeRequestHash},
           ${input.changedAt}, ${input.changedAt})
        RETURNING *
      `);
      const recipe = recipeResult.rows[0];
      for (const component of componentDefinitions) {
        await tx.execute(sql`
          INSERT INTO inventory.build_recipe_components
            (recipe_id, component_variant_id, component_product_id,
             component_units_per_variant, qty)
          VALUES
            (${recipe.id}, ${component.variantId}, ${component.productId},
             ${component.unitsPerVariant}, ${component.qtyPerBuild})
        `);
      }

      const after = {
        recipeId: Number(recipe.id),
        code: String(recipe.code),
        name: String(recipe.name),
        version: Number(recipe.version),
        status: String(recipe.status),
        recipeType: String(recipe.recipe_type),
        outputVariantId: Number(recipe.output_variant_id),
        outputProductId: Number(recipe.output_product_id),
        outputUnitsPerVariant: Number(recipe.output_units_per_variant),
        outputQty: Number(recipe.output_qty),
        notes: recipe.notes ?? null,
        components: componentDefinitions.map((component) => ({
          componentVariantId: component.variantId,
          componentProductId: component.productId,
          componentUnitsPerVariant: component.unitsPerVariant,
          qtyPerBuild: component.qtyPerBuild,
        })),
      };
      await persistAuditEvent(tx as unknown as Parameters<typeof persistAuditEvent>[0], {
        actor: input.actorId,
        action: "inventory.build_recipe.version_created",
        target: `inventory.build_recipe:${current.code}`,
        changes: { before, after },
        context: {
          changeReason: input.changeReason,
          sourceRecipeId: Number(current.id),
          sourceVersion: Number(current.version),
          newRecipeId: Number(recipe.id),
          newVersion: Number(recipe.version),
          requestedStatus: input.status,
        },
      }, { timestamp: input.changedAt, emitStructuredLog: false });

      return {
        ...recipe,
        id: Number(recipe.id),
        code: String(recipe.code),
        version: Number(recipe.version),
        output_variant_id: Number(recipe.output_variant_id),
        alreadyApplied: false,
        previousOutputVariantId: Number(current.output_variant_id),
      };
    });
  }

  async createOrder(input: CreateBuildOrderInput, txOverride?: Db): Promise<any> {
    const sourceLocationMap = new Map<number, number>();
    for (const source of input.sourceLocations) {
      if (sourceLocationMap.has(source.componentVariantId)) {
        throw new BuildDomainError(
          "DUPLICATE_BUILD_SOURCE",
          `Component variant ${source.componentVariantId} has more than one source location`,
          { componentVariantId: source.componentVariantId },
        );
      }
      sourceLocationMap.set(source.componentVariantId, source.sourceLocationId);
    }
    const work = async (tx: Db) => {
      const existing = await this.findIdempotentOrder(tx, input, sourceLocationMap);
      if (existing) return existing;

      const recipeResult = await tx.execute(sql`
        SELECT * FROM inventory.build_recipes
        WHERE id = ${input.recipeId}
        FOR SHARE
      `);
      const recipe = recipeResult.rows[0];
      if (!recipe) {
        throw new BuildDomainError("BUILD_RECIPE_NOT_FOUND", `Build recipe ${input.recipeId} was not found`);
      }
      if (recipe.status !== "active") {
        throw new BuildDomainError("BUILD_RECIPE_NOT_ACTIVE", `Build recipe ${input.recipeId} is not active`, {
          status: recipe.status,
        });
      }
      await assertRecipeManagedOutputProduct(tx, Number(recipe.output_product_id), { recipeId: input.recipeId });

      const componentResult = await tx.execute(sql`
        SELECT id, component_variant_id, component_product_id,
               component_units_per_variant, qty
        FROM inventory.build_recipe_components
        WHERE recipe_id = ${input.recipeId}
        ORDER BY component_variant_id
      `);
      const variantFacts = await loadActiveBuildVariantFacts(
        tx,
        [
          Number(recipe.output_variant_id),
          ...componentResult.rows.map((row) => Number(row.component_variant_id)),
        ],
        { recipeId: input.recipeId },
      );
      const outputSnapshot: BuildVariantFacts & { qtyPerBuild: number } = {
        variantId: Number(recipe.output_variant_id),
        productId: Number(recipe.output_product_id),
        unitsPerVariant: Number(recipe.output_units_per_variant),
        qtyPerBuild: Number(recipe.output_qty),
      };
      const componentDefinitions = componentResult.rows.map((row) => ({
        variantId: Number(row.component_variant_id),
        productId: Number(row.component_product_id),
        unitsPerVariant: Number(row.component_units_per_variant),
        qtyPerBuild: Number(row.qty),
      }));
      assertBuildVariantSnapshotsCurrent({
        snapshots: [outputSnapshot, ...componentDefinitions],
        currentVariants: variantFacts,
        context: { recipeId: input.recipeId },
      });
      validateBuildRecipeDefinition({
        recipeType: recipe.recipe_type,
        output: outputSnapshot,
        components: componentDefinitions,
      });
      const quantities = calculateBuildQuantities({
        plannedBuilds: input.plannedBuilds,
        outputQtyPerBuild: Number(recipe.output_qty),
        components: componentResult.rows.map((row) => ({
          componentVariantId: Number(row.component_variant_id),
          qtyPerBuild: Number(row.qty),
        })),
      });
      const componentVariantIds = new Set(
        quantities.components.map((component) => component.componentVariantId),
      );
      const unknownSources = [...sourceLocationMap.keys()].filter((variantId) => !componentVariantIds.has(variantId));
      if (unknownSources.length > 0) {
        throw new BuildDomainError(
          "BUILD_SOURCE_NOT_IN_RECIPE",
          "Source locations may only be supplied for recipe components",
          { componentVariantIds: unknownSources },
        );
      }
      const missingLocations = quantities.components
        .filter((component) => !sourceLocationMap.has(component.componentVariantId))
        .map((component) => component.componentVariantId);
      if (missingLocations.length > 0) {
        throw new BuildDomainError("BUILD_SOURCE_LOCATION_REQUIRED", "Every component requires a source location", {
          componentVariantIds: missingLocations,
        });
      }

      const locationIds = [input.outputLocationId, ...input.sourceLocations.map((item) => item.sourceLocationId)];
      const locations = await tx.execute(sql`
        SELECT id FROM warehouse.warehouse_locations
        WHERE warehouse_id = ${input.warehouseId}
          AND id IN (${sql.join(locationIds.map((id) => sql`${id}`), sql`, `)})
          AND is_active = 1
      `);
      const validLocationIds = new Set(locations.rows.map((row) => Number(row.id)));
      const invalidLocationIds = [...new Set(locationIds.filter((id) => !validLocationIds.has(id)))];
      if (invalidLocationIds.length > 0) {
        throw new BuildDomainError(
          "BUILD_LOCATION_INVALID",
          "All build locations must be active and belong to the selected warehouse",
          { warehouseId: input.warehouseId, locationIds: invalidLocationIds },
        );
      }

      const inserted = await tx.execute(sql`
        INSERT INTO inventory.build_orders
          (recipe_id, recipe_code, recipe_version, recipe_type, output_variant_id,
           output_product_id, output_units_per_variant, output_qty_per_build,
           planned_builds, warehouse_id, output_location_id, idempotency_key, created_by)
        VALUES
          (${recipe.id}, ${recipe.code}, ${recipe.version}, ${recipe.recipe_type},
           ${recipe.output_variant_id}, ${recipe.output_product_id},
           ${recipe.output_units_per_variant}, ${recipe.output_qty},
           ${input.plannedBuilds}, ${input.warehouseId}, ${input.outputLocationId},
           ${input.idempotencyKey}, ${input.actorId ?? null})
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *
      `);
      if (inserted.rows.length === 0) {
        const concurrentOrder = await this.findIdempotentOrder(tx, input, sourceLocationMap);
        if (concurrentOrder) return concurrentOrder;
        throw new BuildDomainError("BUILD_CONFLICT", "Build order creation conflicted without a persisted order");
      }

      const order = inserted.rows[0];
      for (const component of componentResult.rows) {
        const componentVariantId = Number(component.component_variant_id);
        const qtyPerBuild = Number(component.qty);
        await tx.execute(sql`
          INSERT INTO inventory.build_order_components
            (build_order_id, recipe_component_id, component_variant_id,
             component_product_id, component_units_per_variant, qty_per_build,
             planned_qty, source_location_id)
          VALUES
            (${order.id}, ${component.id}, ${componentVariantId},
             ${component.component_product_id}, ${component.component_units_per_variant},
             ${qtyPerBuild}, ${qtyPerBuild * input.plannedBuilds},
             ${sourceLocationMap.get(componentVariantId)!})
        `);
      }
      return order;
    };
    return txOverride ? work(txOverride) : this.db.transaction(work);
  }

  async linkDependency(input: {
    dependentBuildOrderId: number;
    prerequisiteBuildOrderId: number;
    componentVariantId: number;
    requiredQty: number;
  }, tx: Db): Promise<void> {
    await tx.execute(sql`
      INSERT INTO inventory.build_order_dependencies
        (dependent_build_order_id, prerequisite_build_order_id, component_variant_id, required_qty)
      VALUES
        (${input.dependentBuildOrderId}, ${input.prerequisiteBuildOrderId},
         ${input.componentVariantId}, ${input.requiredQty})
      ON CONFLICT (dependent_build_order_id, prerequisite_build_order_id, component_variant_id)
      DO UPDATE SET required_qty = EXCLUDED.required_qty
    `);
  }

  async releaseOrder(buildOrderId: number, actorId?: string, txOverride?: Db): Promise<any> {
    return this.execution.releaseOrder(buildOrderId, actorId, txOverride);
  }

  async executeOrder(input: ExecuteBuildRunInput): Promise<BuildExecutionResult> {
    return this.execution.executeOrder(input);
  }

  async cancelOrder(input: CancelBuildOrderInput, txOverride?: Db): Promise<BuildCancellationResult> {
    return this.execution.cancelOrder(input, txOverride);
  }

  async reverseRun(input: ReverseBuildRunInput): Promise<BuildReversalResult> {
    return this.execution.reverseRun(input);
  }
}

export function createBuildRepository(
  db: Db,
  options: { onBuildOrderCompleted?: (tx: Db, context: BuildOrderCompletedContext) => Promise<void> } = {},
): BuildRepository {
  return new BuildRepository(db, options);
}
