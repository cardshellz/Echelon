import { sql } from "drizzle-orm";
import {
  allocateBuildCostLayers,
  assertBuildRunOutputUntouched,
  assertBuildVariantSnapshotsCurrent,
  BuildDomainError,
  calculateBuildReversalProgress,
  calculateBuildRunQuantities,
  validateBuildRecipeDefinition,
  type BuildCostTotals,
  type BuildVariantFacts,
} from "../domain/build.domain";

type Db = {
  execute: (query: unknown) => Promise<{ rows: any[] }>;
  transaction: <T>(work: (tx: Db) => Promise<T>) => Promise<T>;
};

type NormalizedLotCosts = BuildCostTotals & { totalMills: bigint };

export type BuildExecutionDependencies = {
  loadActiveBuildVariantFacts: (
    tx: Pick<Db, "execute">,
    variantIds: number[],
    context?: Record<string, unknown>,
  ) => Promise<Map<number, BuildVariantFacts>>;
  normalizeBuildLotCosts: (lot: any) => NormalizedLotCosts;
  buildMillsToRoundedCents: (value: bigint) => bigint;
};

export type ExecuteBuildRunInput = {
  buildOrderId: number;
  buildsCompleted: number;
  idempotencyKey: string;
  actorId?: string;
};

export type CancelBuildOrderInput = {
  buildOrderId: number;
  reason: string;
  actorId?: string;
};

export type ReverseBuildRunInput = {
  buildOrderId: number;
  buildRunId: number;
  idempotencyKey: string;
  reason: string;
  actorId?: string;
};

export type BuildExecutionResult = {
  buildOrderId: number;
  buildRunId: number;
  runNumber: number;
  systemNumber: string;
  status: "released" | "in_progress" | "completed" | "failed" | "cancelled";
  runStatus: "posted" | "reversed";
  buildsCompleted: number;
  completedBuilds: number;
  plannedBuilds: number;
  outputVariantId: number;
  outputQty: number;
  totalComponentCostMills: string;
  alreadyPosted: boolean;
};

export type BuildCancellationResult = {
  buildOrderId: number;
  systemNumber: string;
  status: "cancelled";
  releasedReservationQty: number;
  alreadyCancelled: boolean;
};

export type BuildReversalResult = {
  buildOrderId: number;
  buildRunId: number;
  reversalId: number;
  systemNumber: string;
  status: "released" | "in_progress";
  restoredComponentQty: number;
  removedOutputQty: number;
  alreadyReversed: boolean;
};

type CostAccumulator = BuildCostTotals & { totalMills: bigint };

function emptyCost(): CostAccumulator {
  return {
    poMills: BigInt(0),
    packagingMills: BigInt(0),
    landedMills: BigInt(0),
    totalMills: BigInt(0),
  };
}

function addCost(total: CostAccumulator, unit: NormalizedLotCosts, qty: number): void {
  const multiplier = BigInt(qty);
  total.poMills += unit.poMills * multiplier;
  total.packagingMills += unit.packagingMills * multiplier;
  total.landedMills += unit.landedMills * multiplier;
  total.totalMills += unit.totalMills * multiplier;
}

function asInteger(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized)) {
    throw new BuildDomainError("INVALID_BUILD_STATE", `${field} is not a safe integer`, {
      field,
      value,
    });
  }
  return normalized;
}

function asBigInt(value: unknown, field: string): bigint {
  try {
    return BigInt(value == null ? 0 : String(value));
  } catch {
    throw new BuildDomainError("INVALID_BUILD_COST", `${field} is not an integer mill value`, {
      field,
      value,
    });
  }
}

function errorCode(error: unknown): string {
  return error instanceof BuildDomainError ? error.code : "BUILD_EXECUTION_FAILED";
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

const NON_EXECUTION_FAILURE_CODES = new Set([
  "BUILD_ORDER_NOT_FOUND",
  "BUILD_RUN_EXCEEDS_REMAINING",
  "BUILD_RUN_INCOMPLETE",
  "IDEMPOTENCY_KEY_REUSED",
  "INVALID_BUILD_INPUT",
  "INVALID_BUILD_PROGRESS",
  "INVALID_BUILD_STATUS",
]);

export class BuildExecutionRepository {
  constructor(
    private readonly db: Db,
    private readonly dependencies: BuildExecutionDependencies,
  ) {}

  private async lockOrder(tx: Db, buildOrderId: number): Promise<any> {
    const result = await tx.execute(sql`
      SELECT *
      FROM inventory.build_orders
      WHERE id = ${buildOrderId}
      FOR UPDATE
    `);
    const order = result.rows[0];
    if (!order) {
      throw new BuildDomainError(
        "BUILD_ORDER_NOT_FOUND",
        `Build order ${buildOrderId} was not found`,
      );
    }
    return order;
  }

  private async lockComponents(tx: Db, buildOrderId: number): Promise<any[]> {
    const result = await tx.execute(sql`
      SELECT *
      FROM inventory.build_order_components
      WHERE build_order_id = ${buildOrderId}
      ORDER BY component_variant_id, source_location_id
      FOR UPDATE
    `);
    if (result.rows.length === 0) {
      throw new BuildDomainError(
        "BUILD_RECIPE_EMPTY",
        `Build order ${buildOrderId} has no component snapshots`,
        { buildOrderId },
      );
    }
    return result.rows;
  }

  private async assertConfigurationCurrent(tx: Db, order: any, components: any[]): Promise<void> {
    const buildOrderId = Number(order.id);
    const variantFacts = await this.dependencies.loadActiveBuildVariantFacts(
      tx,
      [
        Number(order.output_variant_id),
        ...components.map((row) => Number(row.component_variant_id)),
      ],
      { buildOrderId },
    );
    const outputSnapshot: BuildVariantFacts & { qtyPerBuild: number } = {
      variantId: Number(order.output_variant_id),
      productId: Number(order.output_product_id),
      unitsPerVariant: Number(order.output_units_per_variant),
      qtyPerBuild: Number(order.output_qty_per_build),
    };
    const componentDefinitions = components.map((component) => ({
      variantId: Number(component.component_variant_id),
      productId: Number(component.component_product_id),
      unitsPerVariant: Number(component.component_units_per_variant),
      qtyPerBuild: Number(component.qty_per_build),
    }));
    assertBuildVariantSnapshotsCurrent({
      snapshots: [outputSnapshot, ...componentDefinitions],
      currentVariants: variantFacts,
      context: { buildOrderId },
    });
    validateBuildRecipeDefinition({
      recipeType: order.recipe_type,
      output: outputSnapshot,
      components: componentDefinitions,
    });
  }

  private async reserveOutstandingComponents(
    tx: Db,
    order: any,
    components: any[],
    actorId?: string,
  ): Promise<number> {
    let newlyReservedQty = 0;
    for (const component of components) {
      const componentId = Number(component.id);
      const variantId = Number(component.component_variant_id);
      const locationId = Number(component.source_location_id);
      if (!Number.isSafeInteger(locationId) || locationId <= 0) {
        throw new BuildDomainError(
          "BUILD_SOURCE_LOCATION_REQUIRED",
          `Component variant ${variantId} requires a source location`,
          { buildOrderId: Number(order.id), componentVariantId: variantId },
        );
      }

      const activeReservation = await tx.execute(sql`
        SELECT COALESCE(SUM(reserved_qty - consumed_qty - released_qty), 0) AS active_qty
        FROM inventory.build_component_reservations
        WHERE build_order_component_id = ${componentId}
      `);
      const requiredOpenQty = asInteger(component.planned_qty, "planned_qty")
        - asInteger(component.consumed_qty, "consumed_qty");
      const activeQty = asInteger(activeReservation.rows[0]?.active_qty ?? 0, "active_reservation_qty");
      const missingQty = requiredOpenQty - activeQty;
      if (missingQty < 0) {
        throw new BuildDomainError(
          "BUILD_RESERVATION_OVERALLOCATED",
          `Component variant ${variantId} has more build reservations than remaining demand`,
          {
            buildOrderId: Number(order.id),
            componentVariantId: variantId,
            requiredOpenQty,
            activeQty,
          },
        );
      }
      if (missingQty === 0) continue;

      const levelResult = await tx.execute(sql`
        SELECT id, variant_qty, reserved_qty
        FROM inventory.inventory_levels
        WHERE product_variant_id = ${variantId}
          AND warehouse_location_id = ${locationId}
        FOR UPDATE
      `);
      const level = levelResult.rows[0];
      const availableQty = level
        ? asInteger(level.variant_qty, "variant_qty") - asInteger(level.reserved_qty, "reserved_qty")
        : 0;
      if (!level || availableQty < missingQty) {
        throw new BuildDomainError(
          "INSUFFICIENT_BUILD_COMPONENT",
          `Component variant ${variantId} has ${availableQty} available units but requires ${missingQty}`,
          {
            buildOrderId: Number(order.id),
            componentVariantId: variantId,
            locationId,
            availableQty,
            requiredQty: missingQty,
          },
        );
      }

      const lots = await tx.execute(sql`
        SELECT id, qty_on_hand, qty_reserved
        FROM inventory.inventory_lots
        WHERE product_variant_id = ${variantId}
          AND warehouse_location_id = ${locationId}
          AND status = 'active'
          AND qty_on_hand > qty_reserved
        ORDER BY received_at, id
        FOR UPDATE
      `);
      let remaining = missingQty;
      for (const lot of lots.rows) {
        if (remaining === 0) break;
        const lotAvailable = asInteger(lot.qty_on_hand, "lot.qty_on_hand")
          - asInteger(lot.qty_reserved, "lot.qty_reserved");
        const take = Math.min(lotAvailable, remaining);
        if (take <= 0) continue;

        await tx.execute(sql`
          UPDATE inventory.inventory_lots
          SET qty_reserved = qty_reserved + ${take}
          WHERE id = ${lot.id}
        `);
        await tx.execute(sql`
          INSERT INTO inventory.build_component_reservations
            (build_order_component_id, inventory_lot_id, reserved_qty)
          VALUES (${componentId}, ${lot.id}, ${take})
          ON CONFLICT (build_order_component_id, inventory_lot_id)
          DO UPDATE SET
            reserved_qty = inventory.build_component_reservations.reserved_qty + EXCLUDED.reserved_qty,
            updated_at = now()
        `);
        await tx.execute(sql`
          INSERT INTO inventory.inventory_transactions
            (product_variant_id, from_location_id, transaction_type, variant_qty_delta,
             variant_qty_before, variant_qty_after, reserved_qty_delta, batch_id,
             source_state, target_state, inventory_lot_id, reference_type, reference_id,
             build_order_id, build_order_component_id, notes, user_id)
          VALUES
            (${variantId}, ${locationId}, 'reserve', 0, ${level.variant_qty}, ${level.variant_qty},
             ${take}, ${String(order.system_number) + "-RESERVE"}, 'on_hand', 'reserved',
             ${lot.id}, 'build_order', ${order.system_number}, ${order.id}, ${componentId},
             ${`Reserved for build ${order.system_number}`}, ${actorId ?? null})
        `);
        remaining -= take;
        newlyReservedQty += take;
      }
      if (remaining !== 0) {
        throw new BuildDomainError(
          "BUILD_LOT_LEVEL_MISMATCH",
          `Inventory levels show sufficient component ${variantId}, but FIFO lots are short by ${remaining}`,
          {
            buildOrderId: Number(order.id),
            componentVariantId: variantId,
            locationId,
            remaining,
          },
        );
      }
      await tx.execute(sql`
        UPDATE inventory.inventory_levels
        SET reserved_qty = reserved_qty + ${missingQty}, updated_at = now()
        WHERE id = ${level.id}
      `);
    }
    return newlyReservedQty;
  }

  private executionResult(order: any, run: any, alreadyPosted: boolean): BuildExecutionResult {
    return {
      buildOrderId: Number(order.id),
      buildRunId: Number(run.id),
      runNumber: Number(run.run_number),
      systemNumber: String(order.system_number),
      status: order.status,
      runStatus: run.status,
      buildsCompleted: Number(run.builds_completed),
      completedBuilds: Number(order.completed_builds),
      plannedBuilds: Number(order.planned_builds),
      outputVariantId: Number(order.output_variant_id),
      outputQty: Number(run.output_qty),
      totalComponentCostMills: String(run.total_component_cost_mills ?? 0),
      alreadyPosted,
    };
  }

  async releaseOrder(buildOrderId: number, actorId?: string): Promise<any> {
    return this.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, buildOrderId);
      if (order.status === "completed") return order;
      if (order.status !== "draft" && order.status !== "released") {
        throw new BuildDomainError(
          "INVALID_BUILD_STATUS",
          `Build order ${buildOrderId} cannot be released`,
          { status: order.status },
        );
      }
      const components = await this.lockComponents(tx, buildOrderId);
      await this.assertConfigurationCurrent(tx, order, components);
      await this.reserveOutstandingComponents(tx, order, components, actorId);
      if (order.status === "released") return order;

      const updated = await tx.execute(sql`
        UPDATE inventory.build_orders
        SET status = 'released',
            released_by = ${actorId ?? null},
            released_at = now(),
            failure_code = NULL,
            failure_message = NULL,
            updated_at = now()
        WHERE id = ${buildOrderId}
        RETURNING *
      `);
      return updated.rows[0];
    });
  }

  async executeOrder(input: ExecuteBuildRunInput): Promise<BuildExecutionResult> {
    try {
      return await this.db.transaction((tx) => this.executeInTransaction(tx, input));
    } catch (error) {
      await this.recordFailure(input.buildOrderId, error);
      throw error;
    }
  }

  private async executeInTransaction(tx: Db, input: ExecuteBuildRunInput): Promise<BuildExecutionResult> {
    const order = await this.lockOrder(tx, input.buildOrderId);
    const existingResult = await tx.execute(sql`
      SELECT *
      FROM inventory.build_runs
      WHERE idempotency_key = ${input.idempotencyKey}
      FOR SHARE
    `);
    const existingRun = existingResult.rows[0];
    if (existingRun) {
      const sameCommand = Number(existingRun.build_order_id) === input.buildOrderId
        && Number(existingRun.builds_completed) === input.buildsCompleted;
      if (!sameCommand) {
        throw new BuildDomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key already belongs to a different build run",
          { idempotencyKey: input.idempotencyKey },
        );
      }
      if (existingRun.status === "posting") {
        throw new BuildDomainError(
          "BUILD_RUN_INCOMPLETE",
          "The existing build run has not reached a terminal state",
          { buildRunId: Number(existingRun.id) },
        );
      }
      return this.executionResult(order, existingRun, true);
    }

    if (!["released", "in_progress", "failed"].includes(String(order.status))) {
      throw new BuildDomainError(
        "INVALID_BUILD_STATUS",
        `Build order ${input.buildOrderId} cannot post inventory from status ${order.status}`,
        { status: order.status },
      );
    }

    const components = await this.lockComponents(tx, input.buildOrderId);
    await this.assertConfigurationCurrent(tx, order, components);
    const quantities = calculateBuildRunQuantities({
      plannedBuilds: Number(order.planned_builds),
      completedBuilds: Number(order.completed_builds),
      requestedBuilds: input.buildsCompleted,
      outputQtyPerBuild: Number(order.output_qty_per_build),
      components: components.map((component) => ({
        componentVariantId: Number(component.component_variant_id),
        qtyPerBuild: Number(component.qty_per_build),
      })),
    });
    await this.reserveOutstandingComponents(tx, order, components, input.actorId);

    const runResult = await tx.execute(sql`
      INSERT INTO inventory.build_runs
        (build_order_id, run_number, idempotency_key, builds_completed, output_qty, posted_by)
      SELECT ${input.buildOrderId},
             COALESCE(MAX(run_number), 0) + 1,
             ${input.idempotencyKey},
             ${input.buildsCompleted},
             ${quantities.outputQty},
             ${input.actorId ?? null}
      FROM inventory.build_runs
      WHERE build_order_id = ${input.buildOrderId}
      RETURNING *
    `);
    const run = runResult.rows[0];
    const consumedCost = emptyCost();
    const requiredByVariant = new Map(
      quantities.components.map((item) => [item.componentVariantId, item.requiredQty]),
    );

    for (const component of components) {
      const componentId = Number(component.id);
      const variantId = Number(component.component_variant_id);
      const locationId = Number(component.source_location_id);
      const requiredQty = requiredByVariant.get(variantId);
      if (!requiredQty) {
        throw new BuildDomainError(
          "INVALID_BUILD_STATE",
          `Build run has no computed requirement for component ${variantId}`,
          { buildOrderId: input.buildOrderId, componentVariantId: variantId },
        );
      }
      const levelResult = await tx.execute(sql`
        SELECT id, variant_qty, reserved_qty
        FROM inventory.inventory_levels
        WHERE product_variant_id = ${variantId}
          AND warehouse_location_id = ${locationId}
        FOR UPDATE
      `);
      const level = levelResult.rows[0];
      if (
        !level
        || asInteger(level.variant_qty, "variant_qty") < requiredQty
        || asInteger(level.reserved_qty, "reserved_qty") < requiredQty
      ) {
        throw new BuildDomainError(
          "BUILD_RESERVATION_MISSING",
          `Component variant ${variantId} does not have the required locked reservation`,
          {
            buildOrderId: input.buildOrderId,
            componentVariantId: variantId,
            requiredQty,
          },
        );
      }

      const reservations = await tx.execute(sql`
        SELECT reservation.id AS reservation_id,
               reservation.reserved_qty,
               reservation.consumed_qty,
               reservation.released_qty,
               lot.id,
               lot.qty_on_hand,
               lot.qty_reserved,
               lot.unit_cost_cents,
               lot.total_unit_cost_cents,
               lot.po_unit_cost_cents,
               lot.packaging_cost_cents,
               lot.landed_cost_cents,
               lot.unit_cost_mills,
               lot.total_unit_cost_mills,
               lot.po_unit_cost_mills,
               lot.packaging_cost_mills,
               lot.landed_cost_mills
        FROM inventory.build_component_reservations reservation
        JOIN inventory.inventory_lots lot ON lot.id = reservation.inventory_lot_id
        WHERE reservation.build_order_component_id = ${componentId}
          AND reservation.reserved_qty > reservation.consumed_qty + reservation.released_qty
        ORDER BY lot.received_at, lot.id
        FOR UPDATE OF reservation, lot
      `);
      let remaining = requiredQty;
      let levelQtyAfter = asInteger(level.variant_qty, "variant_qty");
      for (const reservation of reservations.rows) {
        if (remaining === 0) break;
        const reservedAvailable = asInteger(reservation.reserved_qty, "reservation.reserved_qty")
          - asInteger(reservation.consumed_qty, "reservation.consumed_qty")
          - asInteger(reservation.released_qty, "reservation.released_qty");
        const take = Math.min(reservedAvailable, remaining);
        if (take <= 0) continue;
        if (
          asInteger(reservation.qty_on_hand, "lot.qty_on_hand") < take
          || asInteger(reservation.qty_reserved, "lot.qty_reserved") < take
        ) {
          throw new BuildDomainError(
            "BUILD_RESERVATION_DRIFT",
            `Reserved lot ${reservation.id} cannot satisfy its build allocation`,
            {
              buildOrderId: input.buildOrderId,
              componentVariantId: variantId,
              lotId: Number(reservation.id),
              requiredQty: take,
            },
          );
        }

        const costs = this.dependencies.normalizeBuildLotCosts(reservation);
        addCost(consumedCost, costs, take);
        await tx.execute(sql`
          INSERT INTO inventory.build_run_consumptions
            (build_run_id, build_order_component_id, inventory_lot_id, qty,
             po_unit_cost_mills, packaging_unit_cost_mills,
             landed_unit_cost_mills, total_unit_cost_mills)
          VALUES
            (${run.id}, ${componentId}, ${reservation.id}, ${take},
             ${costs.poMills.toString()}::bigint,
             ${costs.packagingMills.toString()}::bigint,
             ${costs.landedMills.toString()}::bigint,
             ${costs.totalMills.toString()}::bigint)
        `);
        await tx.execute(sql`
          UPDATE inventory.build_component_reservations
          SET consumed_qty = consumed_qty + ${take}, updated_at = now()
          WHERE id = ${reservation.reservation_id}
        `);
        await tx.execute(sql`
          UPDATE inventory.inventory_lots
          SET qty_on_hand = qty_on_hand - ${take},
              qty_reserved = qty_reserved - ${take},
              qty_consumed = COALESCE(qty_consumed, 0) + ${take},
              status = CASE
                WHEN qty_on_hand - ${take} = 0
                  AND qty_reserved - ${take} = 0
                  AND qty_picked = 0
                THEN 'depleted'
                ELSE status
              END
          WHERE id = ${reservation.id}
        `);
        const unitCostCents = this.dependencies.buildMillsToRoundedCents(costs.totalMills);
        await tx.execute(sql`
          INSERT INTO inventory.inventory_transactions
            (product_variant_id, from_location_id, transaction_type, variant_qty_delta,
             variant_qty_before, variant_qty_after, reserved_qty_delta, batch_id,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             reference_type, reference_id, build_order_id, build_order_component_id,
             build_run_id, notes, user_id)
          VALUES
            (${variantId}, ${locationId}, 'assemble', ${-take}, ${levelQtyAfter},
             ${levelQtyAfter - take}, ${-take},
             ${String(order.system_number) + "-R" + String(run.run_number)},
             'reserved', 'consumed', ${unitCostCents}, ${reservation.id},
             'build_run', ${String(run.id)}, ${input.buildOrderId}, ${componentId},
             ${run.id}, ${`Consumed by build ${order.system_number} run ${run.run_number}`},
             ${input.actorId ?? null})
        `);
        levelQtyAfter -= take;
        remaining -= take;
      }
      if (remaining !== 0) {
        throw new BuildDomainError(
          "BUILD_RESERVATION_MISSING",
          `Build reservations for component ${variantId} are short by ${remaining}`,
          {
            buildOrderId: input.buildOrderId,
            componentVariantId: variantId,
            remaining,
          },
        );
      }
      await tx.execute(sql`
        UPDATE inventory.inventory_levels
        SET variant_qty = variant_qty - ${requiredQty},
            reserved_qty = reserved_qty - ${requiredQty},
            updated_at = now()
        WHERE id = ${level.id}
      `);
      await tx.execute(sql`
        UPDATE inventory.build_order_components
        SET consumed_qty = consumed_qty + ${requiredQty}, updated_at = now()
        WHERE id = ${componentId}
      `);
    }

    if (
      consumedCost.totalMills
      !== consumedCost.poMills + consumedCost.packagingMills + consumedCost.landedMills
    ) {
      throw new BuildDomainError(
        "BUILD_COST_NOT_CONSERVED",
        "Consumed component cost breakdown does not reconcile",
      );
    }

    const outputLayers = allocateBuildCostLayers(consumedCost, quantities.outputQty);
    const outputLevelResult = await tx.execute(sql`
      INSERT INTO inventory.inventory_levels
        (product_variant_id, warehouse_location_id, variant_qty, reserved_qty, picked_qty,
         packed_qty, backorder_qty, updated_at)
      VALUES (${order.output_variant_id}, ${order.output_location_id}, 0, 0, 0, 0, 0, now())
      ON CONFLICT (product_variant_id, warehouse_location_id)
      DO UPDATE SET updated_at = now()
      RETURNING id, variant_qty
    `);
    const outputLevel = outputLevelResult.rows[0];
    let outputBefore = asInteger(outputLevel.variant_qty, "output.variant_qty");
    await tx.execute(sql`
      UPDATE inventory.inventory_levels
      SET variant_qty = variant_qty + ${quantities.outputQty}, updated_at = now()
      WHERE id = ${outputLevel.id}
    `);

    for (let index = 0; index < outputLayers.length; index += 1) {
      const layer = outputLayers[index];
      const lotNumber = `${order.system_number}-R${run.run_number}-${String(index + 1).padStart(2, "0")}`;
      const totalCostCents = this.dependencies.buildMillsToRoundedCents(layer.totalMills);
      const poCostCents = this.dependencies.buildMillsToRoundedCents(layer.poMills);
      const packagingCostCents = this.dependencies.buildMillsToRoundedCents(layer.packagingMills);
      const landedCostCents = this.dependencies.buildMillsToRoundedCents(layer.landedMills);
      const outputLot = await tx.execute(sql`
        INSERT INTO inventory.inventory_lots
          (lot_number, product_variant_id, warehouse_location_id, build_order_id, build_run_id,
           unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
           landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
           po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
           total_unit_cost_mills, qty_received, qty_on_hand, qty_reserved,
           qty_picked, received_at, status, cost_provisional, cost_source, notes)
        VALUES
          (${lotNumber}, ${order.output_variant_id}, ${order.output_location_id},
           ${input.buildOrderId}, ${run.id}, ${totalCostCents}, ${poCostCents},
           ${packagingCostCents}, ${landedCostCents}, ${totalCostCents},
           ${layer.totalMills.toString()}::bigint, ${layer.poMills.toString()}::bigint,
           ${layer.packagingMills.toString()}::bigint, ${layer.landedMills.toString()}::bigint,
           ${layer.totalMills.toString()}::bigint, ${layer.qty}, ${layer.qty}, 0, 0,
           now(), 'active', 0, 'build',
           ${`Output from build ${order.system_number} run ${run.run_number}`})
        RETURNING id
      `);
      await tx.execute(sql`
        INSERT INTO inventory.inventory_transactions
          (product_variant_id, to_location_id, transaction_type, variant_qty_delta,
           variant_qty_before, variant_qty_after, batch_id, source_state, target_state,
           unit_cost_cents, inventory_lot_id, reference_type, reference_id,
           build_order_id, build_run_id, notes, user_id)
        VALUES
          (${order.output_variant_id}, ${order.output_location_id}, 'assemble', ${layer.qty},
           ${outputBefore}, ${outputBefore + layer.qty},
           ${String(order.system_number) + "-R" + String(run.run_number)}, 'built', 'on_hand',
           ${totalCostCents}, ${outputLot.rows[0].id}, 'build_run', ${String(run.id)},
           ${input.buildOrderId}, ${run.id},
           ${`Produced by build ${order.system_number} run ${run.run_number}`},
           ${input.actorId ?? null})
      `);
      outputBefore += layer.qty;
    }

    await tx.execute(sql`
      UPDATE inventory.build_runs
      SET status = 'posted',
          total_component_cost_mills = ${consumedCost.totalMills.toString()}::bigint,
          posted_at = now()
      WHERE id = ${run.id}
    `);
    const newCompletedBuilds = Number(order.completed_builds) + input.buildsCompleted;
    const orderStatus = newCompletedBuilds === Number(order.planned_builds)
      ? "completed"
      : "in_progress";
    const newTotalCost = asBigInt(
      order.total_component_cost_mills,
      "total_component_cost_mills",
    ) + consumedCost.totalMills;
    const updatedOrder = await tx.execute(sql`
      UPDATE inventory.build_orders
      SET status = ${orderStatus},
          completed_builds = ${newCompletedBuilds},
          total_component_cost_mills = ${newTotalCost.toString()}::bigint,
          failure_code = NULL,
          failure_message = NULL,
          started_at = COALESCE(started_at, now()),
          completed_by = CASE WHEN ${orderStatus} = 'completed' THEN ${input.actorId ?? null} ELSE NULL END,
          completed_at = CASE WHEN ${orderStatus} = 'completed' THEN now() ELSE NULL END,
          updated_at = now()
      WHERE id = ${input.buildOrderId}
      RETURNING *
    `);
    return this.executionResult(
      updatedOrder.rows[0],
      {
        ...run,
        status: "posted",
        total_component_cost_mills: consumedCost.totalMills.toString(),
      },
      false,
    );
  }

  private async recordFailure(buildOrderId: number, error: unknown): Promise<void> {
    if (
      error instanceof BuildDomainError
      && NON_EXECUTION_FAILURE_CODES.has(error.code)
    ) {
      return;
    }
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE inventory.build_orders
          SET status = 'failed',
              failure_code = ${errorCode(error)},
              failure_message = ${errorMessage(error)},
              failure_count = failure_count + 1,
              last_failure_at = now(),
              updated_at = now()
          WHERE id = ${buildOrderId}
            AND status IN ('released', 'in_progress', 'failed')
        `);
      });
    } catch (recordingError) {
      console.error(JSON.stringify({
        event: "build_execution_failure_recording_failed",
        buildOrderId,
        originalError: errorMessage(error),
        recordingError: errorMessage(recordingError),
      }));
    }
  }

  private async releaseOpenReservations(
    tx: Db,
    order: any,
    actorId?: string,
  ): Promise<number> {
    const reservations = await tx.execute(sql`
      SELECT reservation.id AS reservation_id,
             reservation.reserved_qty,
             reservation.consumed_qty,
             reservation.released_qty,
             lot.id AS lot_id,
             lot.qty_reserved AS lot_reserved_qty,
             component.id AS component_id,
             component.component_variant_id,
             component.source_location_id,
             level.id AS level_id,
             level.variant_qty,
             level.reserved_qty AS level_reserved_qty
      FROM inventory.build_component_reservations reservation
      JOIN inventory.build_order_components component
        ON component.id = reservation.build_order_component_id
      JOIN inventory.inventory_lots lot ON lot.id = reservation.inventory_lot_id
      JOIN inventory.inventory_levels level
        ON level.product_variant_id = component.component_variant_id
       AND level.warehouse_location_id = component.source_location_id
      WHERE component.build_order_id = ${order.id}
        AND reservation.reserved_qty > reservation.consumed_qty + reservation.released_qty
      ORDER BY component.id, lot.received_at, lot.id
      FOR UPDATE OF reservation, lot, level
    `);
    let releasedQty = 0;
    for (const row of reservations.rows) {
      const openQty = Number(row.reserved_qty) - Number(row.consumed_qty) - Number(row.released_qty);
      if (openQty <= 0) continue;
      if (Number(row.lot_reserved_qty) < openQty || Number(row.level_reserved_qty) < openQty) {
        throw new BuildDomainError(
          "BUILD_RESERVATION_DRIFT",
          `Build reservation ${row.reservation_id} exceeds inventory reservation balances`,
          { buildOrderId: Number(order.id), reservationId: Number(row.reservation_id) },
        );
      }
      await tx.execute(sql`
        UPDATE inventory.build_component_reservations
        SET released_qty = released_qty + ${openQty}, updated_at = now()
        WHERE id = ${row.reservation_id}
      `);
      await tx.execute(sql`
        UPDATE inventory.inventory_lots
        SET qty_reserved = qty_reserved - ${openQty}
        WHERE id = ${row.lot_id}
      `);
      await tx.execute(sql`
        UPDATE inventory.inventory_levels
        SET reserved_qty = reserved_qty - ${openQty}, updated_at = now()
        WHERE id = ${row.level_id}
      `);
      await tx.execute(sql`
        INSERT INTO inventory.inventory_transactions
          (product_variant_id, from_location_id, transaction_type, variant_qty_delta,
           variant_qty_before, variant_qty_after, reserved_qty_delta, batch_id,
           source_state, target_state, inventory_lot_id, reference_type, reference_id,
           build_order_id, build_order_component_id, notes, user_id)
        VALUES
          (${row.component_variant_id}, ${row.source_location_id}, 'unreserve', 0,
           ${row.variant_qty}, ${row.variant_qty}, ${-openQty},
           ${String(order.system_number) + "-CANCEL"}, 'reserved', 'on_hand', ${row.lot_id},
           'build_order', ${order.system_number}, ${order.id}, ${row.component_id},
           ${`Released by cancellation of build ${order.system_number}`}, ${actorId ?? null})
      `);
      releasedQty += openQty;
    }
    return releasedQty;
  }

  async cancelOrder(input: CancelBuildOrderInput): Promise<BuildCancellationResult> {
    return this.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, input.buildOrderId);
      if (order.status === "cancelled") {
        if (String(order.cancellation_reason ?? "") !== input.reason) {
          throw new BuildDomainError(
            "BUILD_CANCELLATION_CONFLICT",
            "Build order " + input.buildOrderId + " was already cancelled with a different reason",
            {
              cancellationReason: order.cancellation_reason ?? null,
            },
          );
        }
        return {
          buildOrderId: input.buildOrderId,
          systemNumber: String(order.system_number),
          status: "cancelled",
          releasedReservationQty: Number(order.cancelled_reservation_qty ?? 0),
          alreadyCancelled: true,
        };
      }
      if (!["draft", "released", "in_progress", "failed"].includes(String(order.status))) {
        throw new BuildDomainError(
          "INVALID_BUILD_STATUS",
          `Build order ${input.buildOrderId} cannot be cancelled from status ${order.status}`,
          { status: order.status },
        );
      }
      const releasedReservationQty = await this.releaseOpenReservations(tx, order, input.actorId);
      await tx.execute(sql`
        UPDATE inventory.build_orders
        SET status = 'cancelled',
            cancelled_by = ${input.actorId ?? null},
            cancellation_reason = ${input.reason},
            cancelled_reservation_qty = ${releasedReservationQty},
            cancelled_at = now(),
            failure_code = NULL,
            failure_message = NULL,
            updated_at = now()
        WHERE id = ${input.buildOrderId}
      `);
      return {
        buildOrderId: input.buildOrderId,
        systemNumber: String(order.system_number),
        status: "cancelled",
        releasedReservationQty,
        alreadyCancelled: false,
      };
    });
  }

  async reverseRun(input: ReverseBuildRunInput): Promise<BuildReversalResult> {
    return this.db.transaction(async (tx) => {
      const order = await this.lockOrder(tx, input.buildOrderId);
      if (order.status === "cancelled") {
        throw new BuildDomainError(
          "INVALID_BUILD_STATUS",
          "A cancelled build order cannot reverse a run",
          { buildOrderId: input.buildOrderId },
        );
      }

      const idempotent = await tx.execute(sql`
        SELECT reversal.*, run.build_order_id,
               COALESCE((
                 SELECT SUM(consumption.qty)
                 FROM inventory.build_run_consumptions consumption
                 WHERE consumption.build_run_id = run.id
               ), 0) AS restored_component_qty,
               COALESCE((
                 SELECT SUM(lot.qty_received)
                 FROM inventory.inventory_lots lot
                 WHERE lot.build_run_id = run.id
               ), 0) AS removed_output_qty
        FROM inventory.build_run_reversals reversal
        JOIN inventory.build_runs run ON run.id = reversal.build_run_id
        WHERE reversal.idempotency_key = ${input.idempotencyKey}
        FOR SHARE
      `);
      const existingReversal = idempotent.rows[0];
      if (existingReversal) {
        const sameCommand = Number(existingReversal.build_run_id) === input.buildRunId
          && Number(existingReversal.build_order_id) === input.buildOrderId
          && String(existingReversal.reason) === input.reason;
        if (!sameCommand) {
          throw new BuildDomainError(
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key already belongs to a different build reversal",
            { idempotencyKey: input.idempotencyKey },
          );
        }
        return {
          buildOrderId: input.buildOrderId,
          buildRunId: input.buildRunId,
          reversalId: Number(existingReversal.id),
          systemNumber: String(order.system_number),
          status: String(existingReversal.resulting_order_status) === "in_progress"
            ? "in_progress"
            : "released",
          restoredComponentQty: Number(existingReversal.restored_component_qty),
          removedOutputQty: Number(existingReversal.removed_output_qty),
          alreadyReversed: true,
        };
      }

      const runResult = await tx.execute(sql`
        SELECT *
        FROM inventory.build_runs
        WHERE id = ${input.buildRunId}
          AND build_order_id = ${input.buildOrderId}
        FOR UPDATE
      `);
      const run = runResult.rows[0];
      if (!run) {
        throw new BuildDomainError(
          "BUILD_RUN_NOT_FOUND",
          `Build run ${input.buildRunId} was not found on order ${input.buildOrderId}`,
        );
      }
      if (run.status === "reversed") {
        throw new BuildDomainError(
          "BUILD_RUN_ALREADY_REVERSED",
          `Build run ${input.buildRunId} has already been reversed`,
        );
      }
      if (run.status !== "posted") {
        throw new BuildDomainError(
          "BUILD_RUN_INCOMPLETE",
          `Build run ${input.buildRunId} is not posted`,
          { status: run.status },
        );
      }

      const reversalProgress = calculateBuildReversalProgress({
        completedBuilds: Number(order.completed_builds),
        reversedBuilds: Number(run.builds_completed),
      });
      const resultingCompletedBuilds = reversalProgress.completedBuilds;
      const resultingOrderStatus = reversalProgress.status;

      const latestRun = await tx.execute(sql`
        SELECT id
        FROM inventory.build_runs
        WHERE build_order_id = ${input.buildOrderId}
          AND status = 'posted'
        ORDER BY run_number DESC
        LIMIT 1
        FOR UPDATE
      `);
      const latestPostedRun = latestRun.rows[0];
      if (!latestPostedRun) {
        throw new BuildDomainError(
          "BUILD_RUN_INCOMPLETE",
          `Build order ${input.buildOrderId} has no posted run to reverse`,
          { buildOrderId: input.buildOrderId, buildRunId: input.buildRunId },
        );
      }
      const outputLotsResult = await tx.execute(sql`
        SELECT id, warehouse_location_id, qty_received, qty_on_hand, qty_reserved, qty_picked
        FROM inventory.inventory_lots
        WHERE build_run_id = ${input.buildRunId}
        ORDER BY id
        FOR UPDATE
      `);
      if (outputLotsResult.rows.length === 0) {
        throw new BuildDomainError(
          "BUILD_OUTPUT_LOTS_MISSING",
          `Build run ${input.buildRunId} has no output lots`,
        );
      }
      assertBuildRunOutputUntouched({
        buildRunId: input.buildRunId,
        latestPostedRunId: Number(latestPostedRun.id),
        outputLocationId: Number(order.output_location_id),
        outputLots: outputLotsResult.rows.map((lot) => ({
          lotId: Number(lot.id),
          warehouseLocationId: Number(lot.warehouse_location_id),
          qtyReceived: Number(lot.qty_received),
          qtyOnHand: Number(lot.qty_on_hand),
          qtyReserved: Number(lot.qty_reserved),
          qtyPicked: Number(lot.qty_picked),
        })),
      });

      const reversalResult = await tx.execute(sql`
        INSERT INTO inventory.build_run_reversals
          (build_run_id, idempotency_key, reason, resulting_completed_builds,
           resulting_order_status, created_by)
        VALUES (${input.buildRunId}, ${input.idempotencyKey}, ${input.reason},
                ${resultingCompletedBuilds}, ${resultingOrderStatus}, ${input.actorId ?? null})
        RETURNING *
      `);
      const reversal = reversalResult.rows[0];
      const consumptions = await tx.execute(sql`
        SELECT consumption.*, component.component_variant_id, component.source_location_id,
               reservation.id AS reservation_id, reservation.consumed_qty AS reservation_consumed_qty,
               lot.qty_consumed AS lot_consumed_qty
        FROM inventory.build_run_consumptions consumption
        JOIN inventory.build_order_components component
          ON component.id = consumption.build_order_component_id
        JOIN inventory.build_component_reservations reservation
          ON reservation.build_order_component_id = consumption.build_order_component_id
         AND reservation.inventory_lot_id = consumption.inventory_lot_id
        JOIN inventory.inventory_lots lot ON lot.id = consumption.inventory_lot_id
        WHERE consumption.build_run_id = ${input.buildRunId}
        ORDER BY consumption.id
        FOR UPDATE OF reservation, lot
      `);
      let restoredComponentQty = 0;
      const restoredByComponent = new Map<number, number>();
      for (const consumption of consumptions.rows) {
        const qty = Number(consumption.qty);
        if (
          Number(consumption.reservation_consumed_qty) < qty
          || Number(consumption.lot_consumed_qty ?? 0) < qty
        ) {
          throw new BuildDomainError(
            "BUILD_REVERSAL_SOURCE_DRIFT",
            "Build source evidence cannot support an exact reversal",
            {
              buildRunId: input.buildRunId,
              inventoryLotId: Number(consumption.inventory_lot_id),
            },
          );
        }
        const levelResult = await tx.execute(sql`
          SELECT id, variant_qty, reserved_qty
          FROM inventory.inventory_levels
          WHERE product_variant_id = ${consumption.component_variant_id}
            AND warehouse_location_id = ${consumption.source_location_id}
          FOR UPDATE
        `);
        const level = levelResult.rows[0];
        if (!level) {
          throw new BuildDomainError(
            "BUILD_REVERSAL_LEVEL_MISSING",
            "Build source inventory level is missing",
            {
              buildRunId: input.buildRunId,
              productVariantId: Number(consumption.component_variant_id),
              locationId: Number(consumption.source_location_id),
            },
          );
        }
        await tx.execute(sql`
          UPDATE inventory.build_component_reservations
          SET consumed_qty = consumed_qty - ${qty}, updated_at = now()
          WHERE id = ${consumption.reservation_id}
        `);
        await tx.execute(sql`
          UPDATE inventory.inventory_lots
          SET qty_on_hand = qty_on_hand + ${qty},
              qty_reserved = qty_reserved + ${qty},
              qty_consumed = qty_consumed - ${qty},
              status = 'active'
          WHERE id = ${consumption.inventory_lot_id}
        `);
        await tx.execute(sql`
          UPDATE inventory.inventory_levels
          SET variant_qty = variant_qty + ${qty},
              reserved_qty = reserved_qty + ${qty},
              updated_at = now()
          WHERE id = ${level.id}
        `);
        const unitCostCents = this.dependencies.buildMillsToRoundedCents(
          asBigInt(consumption.total_unit_cost_mills, "total_unit_cost_mills"),
        );
        await tx.execute(sql`
          INSERT INTO inventory.inventory_transactions
            (product_variant_id, to_location_id, transaction_type, variant_qty_delta,
             variant_qty_before, variant_qty_after, reserved_qty_delta, batch_id,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             reference_type, reference_id, build_order_id, build_order_component_id,
             build_run_id, build_reversal_id, notes, user_id)
          VALUES
            (${consumption.component_variant_id}, ${consumption.source_location_id},
             'build_reversal', ${qty}, ${level.variant_qty}, ${Number(level.variant_qty) + qty},
             ${qty}, ${String(order.system_number) + "-REV-" + String(reversal.id)}, 'consumed', 'reserved',
             ${unitCostCents}, ${consumption.inventory_lot_id}, 'build_reversal',
             ${String(reversal.id)}, ${input.buildOrderId}, ${consumption.build_order_component_id},
             ${input.buildRunId}, ${reversal.id},
             ${`Restored by reversal of build ${order.system_number} run ${run.run_number}`},
             ${input.actorId ?? null})
        `);
        restoredComponentQty += qty;
        const componentId = Number(consumption.build_order_component_id);
        restoredByComponent.set(componentId, (restoredByComponent.get(componentId) ?? 0) + qty);
      }

      for (const [componentId, qty] of restoredByComponent) {
        await tx.execute(sql`
          UPDATE inventory.build_order_components
          SET consumed_qty = consumed_qty - ${qty}, updated_at = now()
          WHERE id = ${componentId}
        `);
      }

      const outputLevelResult = await tx.execute(sql`
        SELECT id, variant_qty
        FROM inventory.inventory_levels
        WHERE product_variant_id = ${order.output_variant_id}
          AND warehouse_location_id = ${order.output_location_id}
        FOR UPDATE
      `);
      const outputLevel = outputLevelResult.rows[0];
      const removedOutputQty = outputLotsResult.rows.reduce(
        (sum, lot) => sum + Number(lot.qty_received),
        0,
      );
      if (!outputLevel || Number(outputLevel.variant_qty) < removedOutputQty) {
        throw new BuildDomainError(
          "BUILD_OUTPUT_LEVEL_DRIFT",
          "Build output level cannot support the exact reversal",
          { buildRunId: input.buildRunId, removedOutputQty },
        );
      }
      let outputBefore = Number(outputLevel.variant_qty);
      for (const lot of outputLotsResult.rows) {
        const qty = Number(lot.qty_received);
        await tx.execute(sql`
          UPDATE inventory.inventory_lots
          SET qty_on_hand = 0,
              qty_consumed = COALESCE(qty_consumed, 0) + ${qty},
              status = 'depleted'
          WHERE id = ${lot.id}
        `);
        await tx.execute(sql`
          INSERT INTO inventory.inventory_transactions
            (product_variant_id, from_location_id, transaction_type, variant_qty_delta,
             variant_qty_before, variant_qty_after, batch_id, source_state, target_state,
             inventory_lot_id, reference_type, reference_id, build_order_id,
             build_run_id, build_reversal_id, notes, user_id)
          VALUES
            (${order.output_variant_id}, ${order.output_location_id}, 'build_reversal',
             ${-qty}, ${outputBefore}, ${outputBefore - qty},
             ${String(order.system_number) + "-REV-" + String(reversal.id)}, 'on_hand', 'reversed',
             ${lot.id}, 'build_reversal', ${String(reversal.id)}, ${input.buildOrderId},
             ${input.buildRunId}, ${reversal.id},
             ${`Removed by reversal of build ${order.system_number} run ${run.run_number}`},
             ${input.actorId ?? null})
        `);
        outputBefore -= qty;
      }
      await tx.execute(sql`
        UPDATE inventory.inventory_levels
        SET variant_qty = variant_qty - ${removedOutputQty}, updated_at = now()
        WHERE id = ${outputLevel.id}
      `);
      await tx.execute(sql`
        UPDATE inventory.build_runs
        SET status = 'reversed'
        WHERE id = ${input.buildRunId}
      `);
      const updatedCost = asBigInt(order.total_component_cost_mills, "total_component_cost_mills")
        - asBigInt(run.total_component_cost_mills, "run.total_component_cost_mills");
      if (updatedCost < BigInt(0)) {
        throw new BuildDomainError(
          "BUILD_COST_NOT_CONSERVED",
          "Build order cost would become negative during reversal",
          { buildOrderId: input.buildOrderId, buildRunId: input.buildRunId },
        );
      }
      await tx.execute(sql`
        UPDATE inventory.build_orders
        SET status = ${resultingOrderStatus},
            completed_builds = ${resultingCompletedBuilds},
            total_component_cost_mills = ${updatedCost.toString()}::bigint,
            completed_by = NULL,
            completed_at = NULL,
            failure_code = NULL,
            failure_message = NULL,
            updated_at = now()
        WHERE id = ${input.buildOrderId}
      `);
      return {
        buildOrderId: input.buildOrderId,
        buildRunId: input.buildRunId,
        reversalId: Number(reversal.id),
        systemNumber: String(order.system_number),
        status: resultingOrderStatus,
        restoredComponentQty,
        removedOutputQty,
        alreadyReversed: false,
      };
    });
  }
}
