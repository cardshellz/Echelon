import { sql } from "drizzle-orm";
import {
  allocateBuildCostLayers,
  BuildDomainError,
  calculateBuildQuantities,
  type BuildCostTotals,
} from "../domain/build.domain";

type Db = {
  execute: (query: unknown) => Promise<{ rows: any[] }>;
  transaction: <T>(work: (tx: Db) => Promise<T>) => Promise<T>;
};

export type BuildRecipeComponentInput = {
  componentVariantId: number;
  qtyPerBuild: number;
};

export type CreateBuildRecipeInput = {
  code: string;
  name: string;
  outputVariantId: number;
  outputQty: number;
  components: BuildRecipeComponentInput[];
  status: "draft" | "active";
  notes?: string;
  actorId?: string;
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

export type BuildExecutionResult = {
  buildOrderId: number;
  systemNumber: string;
  status: "completed";
  outputVariantId: number;
  outputQty: number;
  totalComponentCostMills: string;
  alreadyCompleted: boolean;
};

type CostAccumulator = BuildCostTotals & { totalMills: bigint };

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

export async function assertBuildVariantsActive(
  tx: Pick<Db, "execute">,
  variantIds: number[],
  context: Record<string, unknown> = {},
): Promise<void> {
  const uniqueVariantIds = [...new Set(variantIds)];
  if (uniqueVariantIds.length === 0) {
    throw new BuildDomainError("INVALID_BUILD_INPUT", "A build requires at least one catalog variant");
  }

  const variants = await tx.execute(sql`
    SELECT id, is_active
    FROM catalog.product_variants
    WHERE id IN (${sql.join(uniqueVariantIds.map((id) => sql`${id}`), sql`, `)})
    FOR SHARE
  `);
  const activeIds = new Set(
    variants.rows.filter((row) => row.is_active === true).map((row) => Number(row.id)),
  );
  const unavailableVariantIds = uniqueVariantIds.filter((id) => !activeIds.has(id));
  if (unavailableVariantIds.length > 0) {
    throw new BuildDomainError("BUILD_VARIANT_UNAVAILABLE", "All build variants must exist and be active", {
      ...context,
      variantIds: unavailableVariantIds,
    });
  }
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

function addConsumedCost(total: CostAccumulator, unit: ReturnType<typeof normalizeBuildLotCosts>, qty: number): void {
  const multiplier = BigInt(qty);
  total.poMills += unit.poMills * multiplier;
  total.packagingMills += unit.packagingMills * multiplier;
  total.landedMills += unit.landedMills * multiplier;
  total.totalMills += unit.totalMills * multiplier;
}

export class BuildRepository {
  constructor(private readonly db: Db) {}
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
    const quantities = calculateBuildQuantities({
      plannedBuilds: 1,
      outputQtyPerBuild: input.outputQty,
      components: input.components,
    });
    if (quantities.components.some((component) => component.componentVariantId === input.outputVariantId)) {
      throw new BuildDomainError(
        "BUILD_OUTPUT_IS_COMPONENT",
        "A build output cannot also be one of its own components",
        { outputVariantId: input.outputVariantId },
      );
    }

    return this.db.transaction(async (tx) => {
      await assertBuildVariantsActive(
        tx,
        [input.outputVariantId, ...input.components.map((item) => item.componentVariantId)],
      );

      const recipeResult = await tx.execute(sql`
        INSERT INTO inventory.build_recipes
          (code, name, version, status, output_variant_id, output_qty, notes, created_by)
        VALUES
          (${input.code}, ${input.name}, 1, ${input.status}, ${input.outputVariantId},
           ${input.outputQty}, ${input.notes ?? null}, ${input.actorId ?? null})
        RETURNING *
      `);
      const recipe = recipeResult.rows[0];
      for (const component of input.components) {
        await tx.execute(sql`
          INSERT INTO inventory.build_recipe_components
            (recipe_id, component_variant_id, qty)
          VALUES (${recipe.id}, ${component.componentVariantId}, ${component.qtyPerBuild})
        `);
      }
      return recipe;
    });
  }

  async createOrder(input: CreateBuildOrderInput): Promise<any> {
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
    return this.db.transaction(async (tx) => {
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

      const componentResult = await tx.execute(sql`
        SELECT id, component_variant_id, qty
        FROM inventory.build_recipe_components
        WHERE recipe_id = ${input.recipeId}
        ORDER BY component_variant_id
      `);
      await assertBuildVariantsActive(
        tx,
        [
          Number(recipe.output_variant_id),
          ...componentResult.rows.map((row) => Number(row.component_variant_id)),
        ],
        { recipeId: input.recipeId },
      );
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
          (recipe_id, recipe_code, recipe_version, output_variant_id, output_qty_per_build,
           planned_builds, warehouse_id, output_location_id, idempotency_key, created_by)
        VALUES
          (${recipe.id}, ${recipe.code}, ${recipe.version}, ${recipe.output_variant_id},
           ${recipe.output_qty}, ${input.plannedBuilds}, ${input.warehouseId},
           ${input.outputLocationId}, ${input.idempotencyKey}, ${input.actorId ?? null})
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
            (build_order_id, recipe_component_id, component_variant_id, qty_per_build,
             planned_qty, source_location_id)
          VALUES
            (${order.id}, ${component.id}, ${componentVariantId}, ${qtyPerBuild},
             ${qtyPerBuild * input.plannedBuilds}, ${sourceLocationMap.get(componentVariantId)!})
        `);
      }
      return order;
    });
  }

  async releaseOrder(buildOrderId: number, actorId?: string): Promise<any> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT * FROM inventory.build_orders WHERE id = ${buildOrderId} FOR UPDATE
      `);
      const order = locked.rows[0];
      if (!order) throw new BuildDomainError("BUILD_ORDER_NOT_FOUND", `Build order ${buildOrderId} was not found`);
      if (order.status === "released" || order.status === "completed") return order;
      if (order.status !== "draft") {
        throw new BuildDomainError("INVALID_BUILD_STATUS", `Build order ${buildOrderId} cannot be released`, {
          status: order.status,
        });
      }
      const missing = await tx.execute(sql`
        SELECT id FROM inventory.build_order_components
        WHERE build_order_id = ${buildOrderId} AND source_location_id IS NULL
        LIMIT 1
      `);
      if (missing.rows.length > 0) {
        throw new BuildDomainError("BUILD_SOURCE_LOCATION_REQUIRED", "Every component requires a source location");
      }
      const updated = await tx.execute(sql`
        UPDATE inventory.build_orders
        SET status = 'released', released_by = ${actorId ?? null}, released_at = now(), updated_at = now()
        WHERE id = ${buildOrderId}
        RETURNING *
      `);
      return updated.rows[0];
    });
  }

  async executeOrder(buildOrderId: number, actorId?: string): Promise<BuildExecutionResult> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT * FROM inventory.build_orders WHERE id = ${buildOrderId} FOR UPDATE
      `);
      const order = locked.rows[0];
      if (!order) throw new BuildDomainError("BUILD_ORDER_NOT_FOUND", `Build order ${buildOrderId} was not found`);
      const outputQty = Number(order.output_qty_per_build) * Number(order.planned_builds);
      if (order.status === "completed") {
        return {
          buildOrderId,
          systemNumber: order.system_number,
          status: "completed",
          outputVariantId: Number(order.output_variant_id),
          outputQty,
          totalComponentCostMills: String(order.total_component_cost_mills ?? 0),
          alreadyCompleted: true,
        };
      }
      if (order.status !== "released") {
        throw new BuildDomainError("INVALID_BUILD_STATUS", `Build order ${buildOrderId} is not released`, {
          status: order.status,
        });
      }

      const components = await tx.execute(sql`
        SELECT * FROM inventory.build_order_components
        WHERE build_order_id = ${buildOrderId}
        ORDER BY component_variant_id, source_location_id
        FOR UPDATE
      `);
      await assertBuildVariantsActive(
        tx,
        [
          Number(order.output_variant_id),
          ...components.rows.map((row) => Number(row.component_variant_id)),
        ],
        { buildOrderId },
      );
      await tx.execute(sql`
        UPDATE inventory.build_orders
        SET status = 'in_progress', started_at = now(), updated_at = now()
        WHERE id = ${buildOrderId}
      `);
      const consumedCost: CostAccumulator = {
        poMills: BigInt(0),
        packagingMills: BigInt(0),
        landedMills: BigInt(0),
        totalMills: BigInt(0),
      };

      for (const component of components.rows) {
        const requiredQty = Number(component.planned_qty) - Number(component.consumed_qty);
        const variantId = Number(component.component_variant_id);
        const locationId = Number(component.source_location_id);
        const levelResult = await tx.execute(sql`
          SELECT id, variant_qty, reserved_qty
          FROM inventory.inventory_levels
          WHERE product_variant_id = ${variantId}
            AND warehouse_location_id = ${locationId}
          FOR UPDATE
        `);
        const level = levelResult.rows[0];
        const availableQty = level ? Number(level.variant_qty) - Number(level.reserved_qty) : 0;
        if (requiredQty <= 0 || availableQty < requiredQty) {
          throw new BuildDomainError(
            "INSUFFICIENT_BUILD_COMPONENT",
            `Component variant ${variantId} has ${availableQty} unreserved units but requires ${requiredQty}`,
            { buildOrderId, componentVariantId: variantId, locationId, availableQty, requiredQty },
          );
        }

        const lots = await tx.execute(sql`
          SELECT id, qty_on_hand, qty_reserved,
                 unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
                 landed_cost_cents, total_unit_cost_cents,
                 unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
                 landed_cost_mills, total_unit_cost_mills
          FROM inventory.inventory_lots
          WHERE product_variant_id = ${variantId}
            AND warehouse_location_id = ${locationId}
            AND status = 'active'
            AND qty_on_hand > qty_reserved
          ORDER BY received_at, id
          FOR UPDATE
        `);
        let remaining = requiredQty;
        let levelQtyAfterConsumption = Number(level.variant_qty);
        for (const lot of lots.rows) {
          if (remaining === 0) break;
          const available = Number(lot.qty_on_hand) - Number(lot.qty_reserved);
          const take = Math.min(available, remaining);
          if (take <= 0) continue;
          const lotCosts = normalizeBuildLotCosts(lot);
          addConsumedCost(consumedCost, lotCosts, take);
          await tx.execute(sql`
            UPDATE inventory.inventory_lots
            SET qty_on_hand = qty_on_hand - ${take},
                qty_consumed = COALESCE(qty_consumed, 0) + ${take},
                status = CASE
                  WHEN qty_on_hand - ${take} = 0 AND qty_reserved = 0 AND qty_picked = 0
                    THEN 'depleted'
                  ELSE status
                END
            WHERE id = ${lot.id}
          `);
          const unitCostCents = buildMillsToRoundedCents(lotCosts.totalMills);
          await tx.execute(sql`
            INSERT INTO inventory.inventory_transactions
              (product_variant_id, from_location_id, transaction_type, variant_qty_delta,
               variant_qty_before, variant_qty_after, batch_id, source_state, target_state,
               unit_cost_cents, inventory_lot_id, reference_type, reference_id,
               build_order_id, build_order_component_id, notes, user_id)
            VALUES
              (${variantId}, ${locationId}, 'assemble', ${-take}, ${levelQtyAfterConsumption},
               ${levelQtyAfterConsumption - take}, ${order.system_number}, 'on_hand', 'consumed',
               ${unitCostCents}, ${lot.id}, 'build_order', ${order.system_number},
               ${buildOrderId}, ${component.id}, ${`Consumed by build ${order.system_number}`},
               ${actorId ?? null})
          `);
          levelQtyAfterConsumption -= take;
          remaining -= take;
        }
        if (remaining !== 0) {
          throw new BuildDomainError(
            "BUILD_LOT_LEVEL_MISMATCH",
            `Inventory levels show sufficient component ${variantId}, but FIFO lots are short by ${remaining}`,
            { buildOrderId, componentVariantId: variantId, locationId, remaining },
          );
        }

        await tx.execute(sql`
          UPDATE inventory.inventory_levels
          SET variant_qty = variant_qty - ${requiredQty}, updated_at = now()
          WHERE id = ${level.id}
        `);
        await tx.execute(sql`
          UPDATE inventory.build_order_components
          SET consumed_qty = planned_qty, updated_at = now()
          WHERE id = ${component.id}
        `);
      }

      if (consumedCost.totalMills !== consumedCost.poMills + consumedCost.packagingMills + consumedCost.landedMills) {
        throw new BuildDomainError("BUILD_COST_NOT_CONSERVED", "Consumed cost breakdown does not reconcile");
      }
      const outputLayers = allocateBuildCostLayers(consumedCost, outputQty);
      const outputLevel = await tx.execute(sql`
        INSERT INTO inventory.inventory_levels
          (product_variant_id, warehouse_location_id, variant_qty, reserved_qty, picked_qty,
           packed_qty, backorder_qty, updated_at)
        VALUES (${order.output_variant_id}, ${order.output_location_id}, 0, 0, 0, 0, 0, now())
        ON CONFLICT (product_variant_id, warehouse_location_id) DO UPDATE SET updated_at = now()
        RETURNING id, variant_qty
      `);
      let outputBefore = Number(outputLevel.rows[0].variant_qty);
      await tx.execute(sql`
        UPDATE inventory.inventory_levels
        SET variant_qty = variant_qty + ${outputQty}, updated_at = now()
        WHERE id = ${outputLevel.rows[0].id}
      `);

      for (let index = 0; index < outputLayers.length; index += 1) {
        const layer = outputLayers[index];
        const lotNumber = `${order.system_number}-${String(index + 1).padStart(2, "0")}`;
        const totalCostCents = buildMillsToRoundedCents(layer.totalMills);
        const poCostCents = buildMillsToRoundedCents(layer.poMills);
        const packagingCostCents = buildMillsToRoundedCents(layer.packagingMills);
        const landedCostCents = buildMillsToRoundedCents(layer.landedMills);
        const lot = await tx.execute(sql`
          INSERT INTO inventory.inventory_lots
            (lot_number, product_variant_id, warehouse_location_id, build_order_id,
             unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
             landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
             po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
             total_unit_cost_mills, qty_received, qty_on_hand, qty_reserved,
             qty_picked, received_at, status, cost_provisional, cost_source, notes)
          VALUES
            (${lotNumber}, ${order.output_variant_id}, ${order.output_location_id}, ${buildOrderId},
             ${totalCostCents}, ${poCostCents}, ${packagingCostCents}, ${landedCostCents},
             ${totalCostCents}, ${layer.totalMills.toString()}::bigint,
             ${layer.poMills.toString()}::bigint, ${layer.packagingMills.toString()}::bigint,
             ${layer.landedMills.toString()}::bigint, ${layer.totalMills.toString()}::bigint,
             ${layer.qty}, ${layer.qty}, 0, 0, now(), 'active', 0, 'build',
             ${`Output from build ${order.system_number}`})
          RETURNING id
        `);
        await tx.execute(sql`
          INSERT INTO inventory.inventory_transactions
            (product_variant_id, to_location_id, transaction_type, variant_qty_delta,
             variant_qty_before, variant_qty_after, batch_id, source_state, target_state,
             unit_cost_cents, inventory_lot_id, reference_type, reference_id,
             build_order_id, notes, user_id)
          VALUES
            (${order.output_variant_id}, ${order.output_location_id}, 'assemble', ${layer.qty},
             ${outputBefore}, ${outputBefore + layer.qty}, ${order.system_number}, 'built', 'on_hand',
             ${totalCostCents}, ${lot.rows[0].id}, 'build_order',
             ${order.system_number}, ${buildOrderId}, ${`Produced by build ${order.system_number}`},
             ${actorId ?? null})
        `);
        outputBefore += layer.qty;
      }

      await tx.execute(sql`
        UPDATE inventory.build_orders
        SET status = 'completed', completed_builds = planned_builds,
            total_component_cost_mills = ${consumedCost.totalMills.toString()}::bigint,
            completed_by = ${actorId ?? null}, completed_at = now(), updated_at = now()
        WHERE id = ${buildOrderId}
      `);
      return {
        buildOrderId,
        systemNumber: order.system_number,
        status: "completed",
        outputVariantId: Number(order.output_variant_id),
        outputQty,
        totalComponentCostMills: consumedCost.totalMills.toString(),
        alreadyCompleted: false,
      };
    });
  }
}

export function createBuildRepository(db: Db): BuildRepository {
  return new BuildRepository(db);
}
