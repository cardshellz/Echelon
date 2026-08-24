import { sql } from "drizzle-orm";

import {
  calculateRecipeCapacity,
  planRecipeDemand,
  RecipeCapacityError,
  type RecipeDefinition,
  type RecipeDemandPlan,
  type WarehouseRecipeSnapshot,
} from "./domain/recipe-capacity.domain";

type QueryExecutor = {
  execute: (query: unknown) => Promise<{ rows: any[] }>;
};

type RecipeGraph = {
  recipes: RecipeDefinition[];
  variantIds: number[];
  productIds: number[];
  outputProductIds: number[];
};

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RecipeCapacityError("INVALID_RECIPE_DATA", `${field} must be a positive safe integer`, {
      field,
      value,
    });
  }
  return parsed;
}

function rowsOf(result: { rows: any[] }): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

export class RecipeCapacityService {
  constructor(private readonly db: QueryExecutor) {}

  private async loadGraph(targetVariantId: number, executor: QueryExecutor): Promise<RecipeGraph> {
    const recipeRows = rowsOf(await executor.execute(sql`
      SELECT recipe.id AS recipe_id,
             recipe.output_variant_id,
             recipe.output_product_id,
             recipe.output_qty,
             component.component_variant_id,
             component.component_product_id,
             component.qty
      FROM inventory.build_recipes recipe
      JOIN catalog.product_variants output_variant
        ON output_variant.id = recipe.output_variant_id
       AND output_variant.is_active = true
      JOIN catalog.products output_product
        ON output_product.id = recipe.output_product_id
       AND output_product.inventory_strategy = 'recipe_managed'
      JOIN inventory.build_recipe_components component ON component.recipe_id = recipe.id
      JOIN catalog.product_variants component_variant
        ON component_variant.id = component.component_variant_id
       AND component_variant.is_active = true
      WHERE recipe.status = 'active'
      ORDER BY recipe.output_variant_id, recipe.id, component.component_variant_id
    `));

    const recipesById = new Map<number, RecipeDefinition>();
    for (const row of recipeRows) {
      const recipeId = positiveInteger(row.recipe_id, "recipe_id");
      const recipe = recipesById.get(recipeId) ?? {
        id: recipeId,
        outputVariantId: positiveInteger(row.output_variant_id, "output_variant_id"),
        outputProductId: positiveInteger(row.output_product_id, "output_product_id"),
        outputQty: positiveInteger(row.output_qty, "output_qty"),
        components: [],
      };
      recipe.components.push({
        variantId: positiveInteger(row.component_variant_id, "component_variant_id"),
        productId: positiveInteger(row.component_product_id, "component_product_id"),
        qtyPerBuild: positiveInteger(row.qty, "component_qty"),
      });
      recipesById.set(recipeId, recipe);
    }

    const candidatesByOutput = new Map<number, RecipeDefinition[]>();
    for (const recipe of recipesById.values()) {
      const candidates = candidatesByOutput.get(recipe.outputVariantId) ?? [];
      candidates.push(recipe);
      candidatesByOutput.set(recipe.outputVariantId, candidates);
    }
    const targetFacts = rowsOf(await executor.execute(sql`
      SELECT id, product_id
      FROM catalog.product_variants
      WHERE id = ${targetVariantId}
        AND is_active = true
    `))[0];
    if (!targetFacts) {
      throw new RecipeCapacityError("TARGET_VARIANT_NOT_FOUND", `Active variant ${targetVariantId} was not found`, {
        targetVariantId,
      });
    }

    const selectedRecipes: RecipeDefinition[] = [];
    const selectedRecipeIds = new Set<number>();
    const variantIds = new Set<number>([targetVariantId]);
    const targetProductId = positiveInteger(targetFacts.product_id, "target_product_id");
    const productIds = new Set<number>([targetProductId]);
    const outputProductIds = new Set<number>([targetProductId]);
    const visit = (variantId: number, stack: ReadonlySet<number>): void => {
      if (stack.has(variantId)) {
        throw new RecipeCapacityError("RECIPE_CYCLE", `Recipe graph contains a cycle at variant ${variantId}`, {
          targetVariantId,
          variantId,
        });
      }
      const candidates = candidatesByOutput.get(variantId) ?? [];
      if (candidates.length > 1) {
        throw new RecipeCapacityError("AMBIGUOUS_ACTIVE_RECIPE", `Variant ${variantId} has more than one active recipe`, {
          variantId,
          recipeIds: candidates.map((recipe) => recipe.id),
        });
      }
      if (candidates.length === 0) return;
      const recipe = candidates[0];
      if (selectedRecipeIds.has(recipe.id)) return;
      selectedRecipeIds.add(recipe.id);
      selectedRecipes.push(recipe);
      productIds.add(recipe.outputProductId);
      outputProductIds.add(recipe.outputProductId);
      const nextStack = new Set(stack);
      nextStack.add(variantId);
      for (const component of recipe.components) {
        variantIds.add(component.variantId);
        productIds.add(component.productId);
        visit(component.variantId, nextStack);
      }
    };
    visit(targetVariantId, new Set<number>());
    return {
      recipes: selectedRecipes,
      variantIds: [...variantIds].sort((left, right) => left - right),
      productIds: [...productIds].sort((left, right) => left - right),
      outputProductIds: [...outputProductIds].sort((left, right) => left - right),
    };
  }

  async getGraphProductIds(targetVariantId: number, executor: QueryExecutor = this.db): Promise<number[]> {
    return (await this.loadGraph(targetVariantId, executor)).productIds;
  }

  private async loadSnapshots(
    targetVariantId: number,
    warehouseId: number | undefined,
    executor: QueryExecutor,
  ): Promise<WarehouseRecipeSnapshot[]> {
    const graph = await this.loadGraph(targetVariantId, executor);
    const outputProductSql = sql.join(graph.outputProductIds.map((id) => sql`${id}`), sql`, `);
    const finishedVariantRows = rowsOf(await executor.execute(sql`
      SELECT variant.id,
             variant.product_id,
             variant.units_per_variant
      FROM catalog.product_variants variant
      WHERE variant.product_id IN (${outputProductSql})
        AND variant.is_active = true
      ORDER BY variant.product_id, variant.id
    `));
    const finishedVariants = finishedVariantRows.map((row) => ({
      variantId: positiveInteger(row.id, "finished_variant.id"),
      productId: positiveInteger(row.product_id, "finished_variant.product_id"),
      unitsPerVariant: positiveInteger(row.units_per_variant, "finished_variant.units_per_variant"),
    }));
    const finishedVariantsById = new Map(
      finishedVariants.map((variant) => [variant.variantId, variant]),
    );
    const finishedVariantIds = new Set(finishedVariantsById.keys());
    const snapshotVariantIds = [...new Set([...graph.variantIds, ...finishedVariantIds])]
      .sort((left, right) => left - right);
    const variantSql = sql.join(snapshotVariantIds.map((id) => sql`${id}`), sql`, `);
    const stockRows = rowsOf(await executor.execute(sql`
      SELECT level.product_variant_id,
             location.warehouse_id,
             level.warehouse_location_id,
             (level.variant_qty - level.reserved_qty - level.picked_qty - level.packed_qty)::bigint AS available_qty
      FROM inventory.inventory_levels level
      JOIN warehouse.warehouse_locations location
        ON location.id = level.warehouse_location_id
       AND location.is_active = 1
       AND location.cycle_count_freeze_id IS NULL
      WHERE level.product_variant_id IN (${variantSql})
        AND (${warehouseId ?? null}::int IS NULL OR location.warehouse_id = ${warehouseId ?? null})
      ORDER BY location.warehouse_id, level.product_variant_id, level.warehouse_location_id
    `));
    const assignmentRows = rowsOf(await executor.execute(sql`
      SELECT DISTINCT ON (assignment.product_variant_id, location.warehouse_id)
             assignment.product_variant_id,
             location.warehouse_id,
             assignment.warehouse_location_id
      FROM warehouse.product_locations assignment
      JOIN warehouse.warehouse_locations location
        ON location.id = assignment.warehouse_location_id
       AND location.is_active = 1
       AND location.cycle_count_freeze_id IS NULL
      WHERE assignment.product_variant_id IN (${variantSql})
        AND assignment.status = 'active'
        AND (${warehouseId ?? null}::int IS NULL OR location.warehouse_id = ${warehouseId ?? null})
      ORDER BY assignment.product_variant_id, location.warehouse_id,
               assignment.is_primary DESC, assignment.id
    `));
    const warehouseIds = new Set<number>();
    if (warehouseId != null) warehouseIds.add(warehouseId);
    for (const row of [...stockRows, ...assignmentRows]) {
      warehouseIds.add(positiveInteger(row.warehouse_id, "warehouse_id"));
    }
    return [...warehouseIds]
      .sort((left, right) => left - right)
      .map((currentWarehouseId) => ({
        warehouseId: currentWarehouseId,
        recipes: graph.recipes,
        stock: stockRows
          .filter((row) => Number(row.warehouse_id) === currentWarehouseId)
          .filter((row) => !finishedVariantIds.has(Number(row.product_variant_id)))
          .filter((row) => Number(row.available_qty) > 0)
          .map((row) => ({
            variantId: positiveInteger(row.product_variant_id, "stock.product_variant_id"),
            locationId: positiveInteger(row.warehouse_location_id, "stock.warehouse_location_id"),
            availableQty: Number(row.available_qty),
          })),
        finishedVariants,
        finishedStock: stockRows
          .filter((row) => Number(row.warehouse_id) === currentWarehouseId)
          .filter((row) => finishedVariantIds.has(Number(row.product_variant_id)))
          .map((row) => {
            const variantId = positiveInteger(row.product_variant_id, "finished_stock.product_variant_id");
            const variant = finishedVariantsById.get(variantId);
            if (!variant) {
              throw new RecipeCapacityError("FINISHED_VARIANT_NOT_FOUND", `Finished variant ${variantId} was not loaded`, {
                variantId,
              });
            }
            const availableQty = Number(row.available_qty);
            if (!Number.isSafeInteger(availableQty)) {
              throw new RecipeCapacityError("INVALID_FINISHED_STOCK", "Finished inventory must be a signed safe integer", {
                variantId,
                availableQty: row.available_qty,
              });
            }
            return {
              variantId,
              productId: variant.productId,
              unitsPerVariant: variant.unitsPerVariant,
              availableQty,
            };
          }),
        outputLocations: new Map(
          assignmentRows
            .filter((row) => Number(row.warehouse_id) === currentWarehouseId)
            .map((row) => [
              positiveInteger(row.product_variant_id, "assignment.product_variant_id"),
              positiveInteger(row.warehouse_location_id, "assignment.warehouse_location_id"),
            ]),
        ),
      }));
  }

  async getAffectedOutputProductIds(
    changedVariantId: number,
    executor: QueryExecutor = this.db,
  ): Promise<number[]> {
    positiveInteger(changedVariantId, "changedVariantId");
    const result = await executor.execute(sql`
      WITH RECURSIVE affected_outputs AS (
        SELECT recipe.output_variant_id,
               ARRAY[${changedVariantId}, recipe.output_variant_id]::integer[] AS path
        FROM inventory.build_recipe_components component
        JOIN inventory.build_recipes recipe
          ON recipe.id = component.recipe_id
         AND recipe.status = 'active'
        JOIN catalog.product_variants output_variant
          ON output_variant.id = recipe.output_variant_id
         AND output_variant.is_active = true
        JOIN catalog.products output_product
          ON output_product.id = output_variant.product_id
         AND output_product.inventory_strategy = 'recipe_managed'
        WHERE component.component_variant_id = ${changedVariantId}

        UNION ALL

        SELECT recipe.output_variant_id,
               affected.path || recipe.output_variant_id
        FROM affected_outputs affected
        JOIN inventory.build_recipe_components component
          ON component.component_variant_id = affected.output_variant_id
        JOIN inventory.build_recipes recipe
          ON recipe.id = component.recipe_id
         AND recipe.status = 'active'
        JOIN catalog.product_variants output_variant
          ON output_variant.id = recipe.output_variant_id
         AND output_variant.is_active = true
        JOIN catalog.products output_product
          ON output_product.id = output_variant.product_id
         AND output_product.inventory_strategy = 'recipe_managed'
        WHERE NOT recipe.output_variant_id = ANY(affected.path)
      )
      SELECT DISTINCT output_variant.product_id
      FROM affected_outputs affected
      JOIN catalog.product_variants output_variant
        ON output_variant.id = affected.output_variant_id
      ORDER BY output_variant.product_id
    `);
    return rowsOf(result).map((row) => positiveInteger(row.product_id, "affected.product_id"));
  }

  async getVariantCapacity(
    targetVariantId: number,
    warehouseId?: number,
    executor: QueryExecutor = this.db,
  ): Promise<number> {
    const snapshots = await this.loadSnapshots(targetVariantId, warehouseId, executor);
    return snapshots.reduce(
      (total, snapshot) => total + calculateRecipeCapacity(snapshot, targetVariantId),
      0,
    );
  }

  async planDemand(
    targetVariantId: number,
    requestedQty: number,
    warehouseId?: number,
    executor: QueryExecutor = this.db,
  ): Promise<RecipeDemandPlan> {
    const snapshots = await this.loadSnapshots(targetVariantId, warehouseId, executor);
    const candidates = snapshots
      .map((snapshot) => ({
        snapshot,
        capacity: calculateRecipeCapacity(snapshot, targetVariantId),
      }))
      .filter((candidate) => candidate.capacity >= requestedQty)
      .sort((left, right) => right.capacity - left.capacity
        || left.snapshot.warehouseId - right.snapshot.warehouseId);
    if (candidates.length === 0) {
      throw new RecipeCapacityError("RECIPE_CAPACITY_INSUFFICIENT", `Recipe capacity cannot satisfy ${requestedQty} units of variant ${targetVariantId}`, {
        targetVariantId,
        requestedQty,
        warehouseId: warehouseId ?? null,
      });
    }
    return planRecipeDemand(candidates[0].snapshot, targetVariantId, requestedQty);
  }
}

export function createRecipeCapacityService(db: QueryExecutor): RecipeCapacityService {
  return new RecipeCapacityService(db);
}
