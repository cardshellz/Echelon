import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { setWmsOrderItemHoldState } from "../order-item-commands";
import type { BuildUseCases } from "../../inventory/application/build.use-cases";
import type { BuildOrderCompletedContext } from "../../inventory/infrastructure/build-execution.repository";
import {
  RecipeCapacityError,
  type RecipeDemandPlan,
} from "../../inventory/domain/recipe-capacity.domain";
import type { RecipeCapacityService } from "../../inventory/recipe-capacity.service";

// Shared with physical reservations so a component cannot be promised to a
// direct order while the same stock is being committed to a recipe build.
const RECIPE_PROMISE_LOCK_NS = 918410;
const AUTOMATION_ACTOR = "recipe-atp";

type TransactionExecutor = {
  execute: (query: unknown) => Promise<{ rows: any[] }>;
  update: (...args: any[]) => any;
};

type RecipePromiseDb = TransactionExecutor & {
  transaction: <T>(work: (tx: TransactionExecutor) => Promise<T>) => Promise<T>;
};

type InventoryReservationPort = {
  reserveForOrder: (params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    userId?: string;
    referenceType?: string;
    referenceId?: string;
  }, txOverride?: TransactionExecutor) => Promise<boolean>;
};

export type RecipeBuildClaimInput = {
  productId: number;
  variantId: number;
  orderQty: number;
  orderId: number;
  orderItemId: number;
  actorId?: string;
};

export type RecipeBuildClaimResult = {
  reserved: number;
  promised: number;
  shortfall: number;
};

export type RecipeBuildCancellationResult = {
  cancelledDemands: number;
  cancelledBuildOrders: number;
  failures: Array<{ buildOrderId: number; reason: string }>;
};

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RecipeCapacityError("INVALID_RECIPE_PROMISE_INPUT", `${field} must be a positive safe integer`, {
      field,
      value,
    });
  }
  return parsed;
}

function rowsOf(result: { rows: any[] }): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function idempotencyKey(input: RecipeBuildClaimInput, nodeKey: string): string {
  const digest = createHash("sha256")
    .update(`${input.orderId}:${input.orderItemId}:${nodeKey}`)
    .digest("hex")
    .slice(0, 24);
  return `recipe-promise:${input.orderId}:${input.orderItemId}:${digest}`;
}

function holdReason(orderItemId: number): string {
  return `recipe_build_required:order_item:${orderItemId}`;
}

function directReservationReference(orderItemId: number, locationId: number): string {
  return `${orderItemId}:${locationId}`;
}

export class RecipeBuildPromiseService {
  constructor(
    private readonly db: RecipePromiseDb,
    private readonly recipeCapacity: RecipeCapacityService,
    private readonly builds: BuildUseCases,
    private readonly inventoryCore: InventoryReservationPort,
  ) {}

  private async lockRecipeGraph(
    variantId: number,
    tx: TransactionExecutor,
  ): Promise<void> {
    const productIds = await this.recipeCapacity.getGraphProductIds(variantId, tx);
    for (const productId of productIds.slice().sort((left, right) => left - right)) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECIPE_PROMISE_LOCK_NS}, ${productId})`);
    }
  }

  private async getExistingDemand(
    orderItemId: number,
    tx: TransactionExecutor,
  ): Promise<any | null> {
    const result = await tx.execute(sql`
      SELECT *
      FROM wms.order_build_demands
      WHERE order_item_id = ${orderItemId}
      FOR UPDATE
    `);
    return rowsOf(result)[0] ?? null;
  }

  private async getLedgerReservedQty(orderItemId: number, tx: TransactionExecutor): Promise<number> {
    const result = await tx.execute(sql`
      SELECT COALESCE(SUM(reserved_qty_delta), 0)::int AS reserved_qty
      FROM inventory.inventory_transactions
      WHERE order_item_id = ${orderItemId}
        AND voided_at IS NULL
    `);
    return Math.max(0, Number(rowsOf(result)[0]?.reserved_qty ?? 0));
  }

  private directQty(plan: RecipeDemandPlan): number {
    const directQty = plan.directAllocations.reduce((total, allocation) => {
      positiveInteger(allocation.sourceLocationId, "directAllocation.sourceLocationId");
      return total + positiveInteger(allocation.qty, "directAllocation.qty");
    }, 0);
    if (!Number.isSafeInteger(directQty) || directQty > plan.requestedQty) {
      throw new RecipeCapacityError("RECIPE_PROMISE_PLAN_INVALID", "Direct allocations exceed requested demand", {
        requestedQty: plan.requestedQty,
        directQty,
      });
    }
    return directQty;
  }

  private validateExistingDemand(existing: any, input: RecipeBuildClaimInput): RecipeBuildClaimResult {
    const sameCommand = Number(existing.order_id) === input.orderId
      && Number(existing.order_item_id) === input.orderItemId
      && Number(existing.target_variant_id) === input.variantId
      && Number(existing.requested_qty) === input.orderQty;
    if (!sameCommand) {
      throw new RecipeCapacityError(
        "RECIPE_PROMISE_IDEMPOTENCY_CONFLICT",
        "The order item already belongs to a different recipe build demand",
        { orderItemId: input.orderItemId, demandId: Number(existing.id) },
      );
    }
    const promisedQty = positiveInteger(existing.promised_qty, "existingDemand.promisedQty");
    if (promisedQty > input.orderQty) {
      throw new RecipeCapacityError(
        "RECIPE_PROMISE_DATA_INVALID",
        "The persisted promised quantity exceeds the order-item quantity",
        {
          demandId: Number(existing.id),
          orderItemId: input.orderItemId,
          promisedQty,
          orderQty: input.orderQty,
        },
      );
    }
    const directQty = input.orderQty - promisedQty;
    if (existing.status === "awaiting_build") {
      return { reserved: directQty, promised: promisedQty, shortfall: 0 };
    }
    if (existing.status === "fulfilled") {
      return { reserved: input.orderQty, promised: 0, shortfall: 0 };
    }
    throw new RecipeCapacityError(
      "RECIPE_PROMISE_NOT_RETRYABLE",
      `Recipe build demand ${existing.id} is ${existing.status}`,
      { demandId: Number(existing.id), status: existing.status },
    );
  }

  async claimOrderItem(
    rawInput: RecipeBuildClaimInput,
    tx: TransactionExecutor,
  ): Promise<RecipeBuildClaimResult> {
    const input: RecipeBuildClaimInput = {
      ...rawInput,
      productId: positiveInteger(rawInput.productId, "productId"),
      variantId: positiveInteger(rawInput.variantId, "variantId"),
      orderQty: positiveInteger(rawInput.orderQty, "orderQty"),
      orderId: positiveInteger(rawInput.orderId, "orderId"),
      orderItemId: positiveInteger(rawInput.orderItemId, "orderItemId"),
    };
    const orderResult = await tx.execute(sql`
      SELECT order_row.id AS order_id,
             order_row.warehouse_id,
             order_row.warehouse_status,
             item.id AS order_item_id,
             item.sku,
             item.product_id AS persisted_variant_id,
             item.quantity,
             item.on_hold,
             item.hold_reason,
             variant.product_id AS catalog_product_id,
             variant.is_active AS variant_is_active
      FROM wms.orders order_row
      JOIN wms.order_items item ON item.order_id = order_row.id
      JOIN catalog.product_variants variant ON variant.id = ${input.variantId}
      WHERE order_row.id = ${input.orderId}
        AND item.id = ${input.orderItemId}
      FOR UPDATE OF order_row, item
    `);
    const order = rowsOf(orderResult)[0];
    if (!order) {
      throw new RecipeCapacityError("RECIPE_PROMISE_ORDER_ITEM_NOT_FOUND", "The WMS order item was not found", {
        orderId: input.orderId,
        orderItemId: input.orderItemId,
      });
    }
    const variantIsActive = order.variant_is_active === true || Number(order.variant_is_active) === 1;
    if (
      Number(order.persisted_variant_id) !== input.variantId
      || Number(order.catalog_product_id) !== input.productId
      || !variantIsActive
    ) {
      throw new RecipeCapacityError("RECIPE_PROMISE_VARIANT_MISMATCH", "The active variant does not match the order item product", {
        orderItemId: input.orderItemId,
        productId: input.productId,
        variantId: input.variantId,
      });
    }
    if (Number(order.quantity) !== input.orderQty) {
      throw new RecipeCapacityError("RECIPE_PROMISE_QUANTITY_MISMATCH", "The persisted order quantity changed before reservation", {
        orderItemId: input.orderItemId,
        expectedQty: input.orderQty,
        persistedQty: Number(order.quantity),
      });
    }

    // The order-item row lock serializes retries. Re-read the demand only
    // after that lock so a concurrent first attempt is observed idempotently.
    const existing = await this.getExistingDemand(input.orderItemId, tx);
    if (existing) return this.validateExistingDemand(existing, input);
    const existingReservedQty = await this.getLedgerReservedQty(input.orderItemId, tx);
    if (existingReservedQty === input.orderQty) {
      return { reserved: input.orderQty, promised: 0, shortfall: 0 };
    }
    if (existingReservedQty !== 0) {
      throw new RecipeCapacityError(
        "RECIPE_PROMISE_PARTIAL_RESERVATION",
        "A recipe-managed order item has a partial physical reservation without a build demand",
        {
          orderItemId: input.orderItemId,
          requestedQty: input.orderQty,
          reservedQty: existingReservedQty,
        },
      );
    }

    const warehouseId = positiveInteger(order.warehouse_id, "order.warehouseId");

    await this.lockRecipeGraph(input.variantId, tx);
    let plan: RecipeDemandPlan;
    try {
      plan = await this.recipeCapacity.planDemand(input.variantId, input.orderQty, warehouseId, tx);
    } catch (error) {
      if (error instanceof RecipeCapacityError && error.code === "RECIPE_CAPACITY_INSUFFICIENT") {
        return { reserved: 0, promised: 0, shortfall: input.orderQty };
      }
      throw error;
    }

    if (
      plan.targetVariantId !== input.variantId
      || plan.requestedQty !== input.orderQty
      || plan.warehouseId !== warehouseId
    ) {
      throw new RecipeCapacityError(
        "RECIPE_PROMISE_PLAN_INVALID",
        "The recipe planner returned a plan for different demand",
        {
          orderItemId: input.orderItemId,
          expected: { variantId: input.variantId, requestedQty: input.orderQty, warehouseId },
          actual: {
            variantId: plan.targetVariantId,
            requestedQty: plan.requestedQty,
            warehouseId: plan.warehouseId,
          },
        },
      );
    }

    const directQty = this.directQty(plan);
    for (const allocation of plan.directAllocations) {
      const reserved = await this.inventoryCore.reserveForOrder({
        productVariantId: input.variantId,
        warehouseLocationId: allocation.sourceLocationId,
        qty: allocation.qty,
        orderId: input.orderId,
        orderItemId: input.orderItemId,
        userId: input.actorId,
        referenceType: "recipe_direct",
        referenceId: directReservationReference(input.orderItemId, allocation.sourceLocationId),
      }, tx);
      if (!reserved) {
        throw new RecipeCapacityError(
          "RECIPE_DIRECT_RESERVATION_FAILED",
          "Finished recipe output could not be reserved for its owning order item",
          { orderItemId: input.orderItemId, sourceLocationId: allocation.sourceLocationId, qty: allocation.qty },
        );
      }
    }

    if (plan.nodes.length === 0) {
      if (directQty !== input.orderQty) {
        throw new RecipeCapacityError("RECIPE_PROMISE_PLAN_INVALID", "A direct-only plan does not cover the requested demand", {
          orderItemId: input.orderItemId,
          requestedQty: input.orderQty,
          directQty,
        });
      }
      return { reserved: directQty, promised: 0, shortfall: 0 };
    }

    const promisedQty = input.orderQty - directQty;
    positiveInteger(promisedQty, "promisedQty");
    const reason = holdReason(input.orderItemId);
    const demandResult = await tx.execute(sql`
      INSERT INTO wms.order_build_demands
        (order_id, order_item_id, target_variant_id, warehouse_id,
         requested_qty, promised_qty, status, hold_applied, hold_reason, created_by)
      VALUES
        (${input.orderId}, ${input.orderItemId}, ${input.variantId}, ${warehouseId},
         ${input.orderQty}, ${promisedQty}, 'planning', false, ${reason},
         ${input.actorId ?? AUTOMATION_ACTOR})
      RETURNING *
    `);
    const demand = rowsOf(demandResult)[0];
    const buildOrderByNode = new Map<string, number>();

    for (const node of plan.nodes) {
      const buildOrder = await this.builds.createOrder({
        recipeId: node.recipeId,
        plannedBuilds: node.plannedBuilds,
        warehouseId,
        outputLocationId: node.outputLocationId,
        sourceLocations: node.components.map((component) => ({
          componentVariantId: component.variantId,
          sourceLocationId: component.sourceLocationId,
        })),
        idempotencyKey: idempotencyKey(input, node.nodeKey),
        actorId: input.actorId ?? AUTOMATION_ACTOR,
      }, tx as any);
      buildOrderByNode.set(node.nodeKey, Number(buildOrder.id));
    }

    for (const node of plan.nodes) {
      const dependentBuildOrderId = buildOrderByNode.get(node.nodeKey)!;
      for (const component of node.components) {
        if (!component.prerequisiteNodeKey) continue;
        const prerequisiteBuildOrderId = buildOrderByNode.get(component.prerequisiteNodeKey);
        if (!prerequisiteBuildOrderId) {
          throw new RecipeCapacityError(
            "RECIPE_PROMISE_GRAPH_INVALID",
            "A planned prerequisite build order was not created",
            { nodeKey: node.nodeKey, prerequisiteNodeKey: component.prerequisiteNodeKey },
          );
        }
        await this.builds.linkDependency({
          dependentBuildOrderId,
          prerequisiteBuildOrderId,
          componentVariantId: component.variantId,
          requiredQty: component.requiredQty,
        }, tx as any);
      }
    }

    const rootBuildOrderId = plan.rootNodeKey
      ? buildOrderByNode.get(plan.rootNodeKey)
      : undefined;
    if (!rootBuildOrderId) {
      throw new RecipeCapacityError("RECIPE_PROMISE_GRAPH_INVALID", "The root build order was not created", {
        orderItemId: input.orderItemId,
      });
    }
    const applyHold = !Boolean(order.on_hold);
    if (applyHold) {
      await setWmsOrderItemHoldState(tx as any, {
        itemId: input.orderItemId,
        onHold: true,
        reason,
      });
    }
    await tx.execute(sql`
      UPDATE wms.order_build_demands
      SET root_build_order_id = ${rootBuildOrderId},
          status = 'awaiting_build',
          hold_applied = ${applyHold},
          updated_at = now()
      WHERE id = ${demand.id}
    `);

    for (const node of plan.nodes) {
      if (node.components.some((component) => component.prerequisiteNodeKey != null)) continue;
      await this.builds.releaseOrder(
        buildOrderByNode.get(node.nodeKey)!,
        input.actorId ?? AUTOMATION_ACTOR,
        tx as any,
      );
    }
    console.info(JSON.stringify({
      event: "recipe_build_demand_created",
      demandId: Number(demand.id),
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      targetVariantId: input.variantId,
      directReservedQty: directQty,
      promisedQty,
      rootBuildOrderId,
      buildOrderCount: plan.nodes.length,
    }));
    return { reserved: directQty, promised: promisedQty, shortfall: 0 };
  }

  async reconcileBuildCompletion(
    tx: TransactionExecutor,
    context: BuildOrderCompletedContext,
  ): Promise<void> {
    const dependentResult = await tx.execute(sql`
      SELECT DISTINCT dependency.dependent_build_order_id
      FROM inventory.build_order_dependencies dependency
      WHERE dependency.prerequisite_build_order_id = ${context.buildOrderId}
      ORDER BY dependency.dependent_build_order_id
    `);
    for (const row of rowsOf(dependentResult)) {
      const dependentBuildOrderId = Number(row.dependent_build_order_id);
      const incompleteResult = await tx.execute(sql`
        SELECT COUNT(*)::int AS incomplete_count
        FROM inventory.build_order_dependencies dependency
        JOIN inventory.build_orders prerequisite
          ON prerequisite.id = dependency.prerequisite_build_order_id
        WHERE dependency.dependent_build_order_id = ${dependentBuildOrderId}
          AND prerequisite.status <> 'completed'
      `);
      if (Number(rowsOf(incompleteResult)[0]?.incomplete_count ?? 0) === 0) {
        await this.builds.releaseOrder(dependentBuildOrderId, AUTOMATION_ACTOR, tx as any);
      }
    }

    const demandResult = await tx.execute(sql`
      SELECT demand.*,
             demand.hold_reason AS demand_hold_reason,
             item.on_hold,
             item.hold_reason AS item_hold_reason
      FROM wms.order_build_demands demand
      JOIN wms.order_items item ON item.id = demand.order_item_id
      WHERE demand.root_build_order_id = ${context.buildOrderId}
        AND demand.status = 'awaiting_build'
      FOR UPDATE OF demand, item
    `);
    const demand = rowsOf(demandResult)[0];
    if (!demand) return;
    if (Number(demand.target_variant_id) !== context.outputVariantId) {
      throw new RecipeCapacityError(
        "RECIPE_PROMISE_OUTPUT_MISMATCH",
        "The completed root build output does not match its order demand",
        { demandId: Number(demand.id), buildOrderId: context.buildOrderId },
      );
    }
    const promisedQty = positiveInteger(demand.promised_qty, "demand.promisedQty");
    const reserved = await this.inventoryCore.reserveForOrder({
      productVariantId: context.outputVariantId,
      warehouseLocationId: context.outputLocationId,
      qty: promisedQty,
      orderId: Number(demand.order_id),
      orderItemId: Number(demand.order_item_id),
      userId: AUTOMATION_ACTOR,
      referenceType: "recipe_build",
      referenceId: String(demand.id),
    }, tx);
    if (!reserved) {
      throw new RecipeCapacityError(
        "RECIPE_PROMISE_FINAL_RESERVATION_FAILED",
        "The completed build output could not be reserved for its owning order item",
        { demandId: Number(demand.id), buildOrderId: context.buildOrderId },
      );
    }
    await tx.execute(sql`
      UPDATE wms.order_build_demands
      SET status = 'fulfilled', fulfilled_at = now(), updated_at = now()
      WHERE id = ${demand.id}
    `);
    if (
      Boolean(demand.hold_applied)
      && Boolean(demand.on_hold)
      && String(demand.item_hold_reason ?? "") === String(demand.demand_hold_reason)
    ) {
      await setWmsOrderItemHoldState(tx as any, {
        itemId: Number(demand.order_item_id),
        onHold: false,
      });
    }
    console.info(JSON.stringify({
      event: "recipe_build_demand_fulfilled",
      demandId: Number(demand.id),
      orderId: Number(demand.order_id),
      orderItemId: Number(demand.order_item_id),
      buildOrderId: context.buildOrderId,
      reservedQty: promisedQty,
    }));
  }

  async cancelOrderDemands(
    orderId: number,
    reason: string,
    actorId?: string,
  ): Promise<RecipeBuildCancellationResult> {
    positiveInteger(orderId, "orderId");
    const cancellationReason = String(reason ?? "").trim();
    if (!cancellationReason) {
      throw new RecipeCapacityError("INVALID_RECIPE_PROMISE_INPUT", "Cancellation reason is required");
    }
    const claimed = await this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT demand.*,
               demand.hold_reason AS demand_hold_reason,
               item.on_hold,
               item.hold_reason AS item_hold_reason
        FROM wms.order_build_demands demand
        JOIN wms.order_items item ON item.id = demand.order_item_id
        WHERE demand.order_id = ${orderId}
          AND demand.status IN ('planning', 'awaiting_build')
        ORDER BY demand.id
        FOR UPDATE OF demand, item
      `);
      const demands = rowsOf(result);
      for (const demand of demands) {
        await tx.execute(sql`
          UPDATE wms.order_build_demands
          SET status = 'cancelled',
              failure_code = 'ORDER_CANCELLED',
              failure_message = ${cancellationReason.slice(0, 2000)},
              cancelled_at = now(),
              updated_at = now()
          WHERE id = ${demand.id}
        `);
        if (
          Boolean(demand.hold_applied)
          && Boolean(demand.on_hold)
          && String(demand.item_hold_reason ?? "") === String(demand.demand_hold_reason)
        ) {
          await setWmsOrderItemHoldState(tx as any, {
            itemId: Number(demand.order_item_id),
            onHold: false,
          });
        }
      }
      return demands.map((demand) => ({
        demandId: Number(demand.id),
        rootBuildOrderId: demand.root_build_order_id == null ? null : Number(demand.root_build_order_id),
      }));
    });

    const result: RecipeBuildCancellationResult = {
      cancelledDemands: claimed.length,
      cancelledBuildOrders: 0,
      failures: [],
    };
    for (const demand of claimed) {
      if (!demand.rootBuildOrderId) continue;
      const graph = await this.db.execute(sql`
        WITH RECURSIVE build_graph AS (
          SELECT id, 0 AS depth
          FROM inventory.build_orders
          WHERE id = ${demand.rootBuildOrderId}
          UNION ALL
          SELECT dependency.prerequisite_build_order_id, graph.depth + 1
          FROM build_graph graph
          JOIN inventory.build_order_dependencies dependency
            ON dependency.dependent_build_order_id = graph.id
        )
        SELECT DISTINCT id, MAX(depth) AS depth
        FROM build_graph
        GROUP BY id
        ORDER BY depth, id
      `);
      for (const row of rowsOf(graph)) {
        const buildOrderId = Number(row.id);
        try {
          await this.builds.cancelOrder({
            buildOrderId,
            reason: `Order ${orderId} cancelled: ${cancellationReason}`.slice(0, 2000),
            actorId: actorId ?? AUTOMATION_ACTOR,
          });
          result.cancelledBuildOrders += 1;
        } catch (error: any) {
          if (error?.code === "INVALID_BUILD_STATUS") continue;
          result.failures.push({
            buildOrderId,
            reason: error?.message ?? String(error),
          });
        }
      }
    }
    if (result.failures.length > 0) {
      console.error(JSON.stringify({
        event: "recipe_build_cancellation_incomplete",
        orderId,
        failures: result.failures,
      }));
    }
    return result;
  }
}

export function createRecipeBuildPromiseService(
  db: RecipePromiseDb,
  recipeCapacity: RecipeCapacityService,
  builds: BuildUseCases,
  inventoryCore: InventoryReservationPort,
): RecipeBuildPromiseService {
  return new RecipeBuildPromiseService(db, recipeCapacity, builds, inventoryCore);
}
