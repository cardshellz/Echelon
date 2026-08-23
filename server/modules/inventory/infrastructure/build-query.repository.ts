import { sql } from "drizzle-orm";
import { BuildDomainError } from "../domain/build.domain";

type QueryDb = {
  execute: (query: unknown) => Promise<{ rows: any[] }>;
};

export type BuildRecipeComponentView = {
  id: number;
  componentVariantId: number;
  componentProductId: number;
  componentUnitsPerVariant: number;
  sku: string | null;
  name: string;
  qtyPerBuild: number;
};

export type BuildRecipeView = {
  id: number;
  code: string;
  name: string;
  version: number;
  status: string;
  recipeType: string;
  outputVariantId: number;
  outputProductId: number;
  outputUnitsPerVariant: number;
  outputSku: string | null;
  outputName: string;
  outputQty: number;
  notes: string | null;
  components: BuildRecipeComponentView[];
  createdAt: string;
};

export type BuildRecipeRelationshipView = {
  recipeId: number;
  code: string;
  name: string;
  version: number;
  status: string;
  recipeType: string;
  quantityPerBuild: number;
  outputVariantId: number;
  outputSku: string | null;
  outputName: string;
  outputQty: number;
};

export type ProductVariantBuildRelationshipsView = {
  variantId: number;
  sku: string | null;
  name: string;
  isActive: boolean;
  producedBy: BuildRecipeRelationshipView[];
  usedIn: BuildRecipeRelationshipView[];
};
export type BuildOrderComponentView = {
  id: number;
  componentVariantId: number;
  componentProductId: number;
  componentUnitsPerVariant: number;
  sku: string | null;
  name: string;
  qtyPerBuild: number;
  plannedQty: number;
  consumedQty: number;
  reservedQty: number;
  sourceLocationId: number | null;
  sourceLocationCode: string | null;
};

export type BuildRunView = {
  id: number;
  runNumber: number;
  status: string;
  buildsCompleted: number;
  outputQty: number;
  outputQtyOnHand: number;
  totalComponentCostMills: string;
  postedBy: string | null;
  postedAt: string | null;
  createdAt: string;
  reversalId: number | null;
  reversalReason: string | null;
  reversedAt: string | null;
  canReverse: boolean;
  reversalBlocker: string | null;
};

export type BuildOrderDemandView = {
  id: number;
  orderId: number;
  orderNumber: string;
  orderItemId: number;
  sku: string;
  requestedQty: number;
  promisedQty: number;
  status: string;
  rootBuildOrderId: number;
  dependencyDepth: number;
};

export type BuildOrderView = {
  id: number;
  systemNumber: string;
  recipeId: number;
  recipeCode: string;
  recipeVersion: number;
  recipeType: string;
  outputProductId: number;
  outputUnitsPerVariant: number;
  outputVariantId: number;
  outputSku: string | null;
  outputName: string;
  outputQtyPerBuild: number;
  plannedBuilds: number;
  completedBuilds: number;
  remainingBuilds: number;
  warehouseId: number;
  warehouseName: string;
  outputLocationId: number;
  outputLocationCode: string;
  status: string;
  totalComponentCostMills: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  failureCount: number;
  lastFailureAt: string | null;
  cancellationReason: string | null;
  cancelledReservationQty: number | null;
  demand: BuildOrderDemandView | null;
  components: BuildOrderComponentView[];
  runs: BuildRunView[];
  createdAt: string;
  releasedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};

function recipeFromRow(row: any): BuildRecipeView {
  return {
    id: Number(row.id),
    code: String(row.code),
    name: String(row.name),
    version: Number(row.version),
    status: String(row.status),
    recipeType: String(row.recipe_type),
    outputProductId: Number(row.output_product_id),
    outputUnitsPerVariant: Number(row.output_units_per_variant),
    outputVariantId: Number(row.output_variant_id),
    outputSku: row.output_sku ?? null,
    outputName: String(row.output_name),
    outputQty: Number(row.output_qty),
    notes: row.notes ?? null,
    components: [],
    createdAt: String(row.created_at),
  };
}

function orderFromRow(row: any): BuildOrderView {
  return {
    id: Number(row.id),
    systemNumber: String(row.system_number),
    recipeId: Number(row.recipe_id),
    recipeCode: String(row.recipe_code),
    recipeVersion: Number(row.recipe_version),
    recipeType: String(row.recipe_type),
    outputProductId: Number(row.output_product_id),
    outputUnitsPerVariant: Number(row.output_units_per_variant),
    outputVariantId: Number(row.output_variant_id),
    outputSku: row.output_sku ?? null,
    outputName: String(row.output_name),
    outputQtyPerBuild: Number(row.output_qty_per_build),
    plannedBuilds: Number(row.planned_builds),
    completedBuilds: Number(row.completed_builds),
    remainingBuilds: Number(row.planned_builds) - Number(row.completed_builds),
    warehouseId: Number(row.warehouse_id),
    warehouseName: String(row.warehouse_name),
    outputLocationId: Number(row.output_location_id),
    outputLocationCode: String(row.output_location_code),
    status: String(row.status),
    totalComponentCostMills: row.total_component_cost_mills == null
      ? null
      : String(row.total_component_cost_mills),
    failureCode: row.failure_code ?? null,
    failureMessage: row.failure_message ?? null,
    failureCount: Number(row.failure_count ?? 0),
    lastFailureAt: row.last_failure_at == null ? null : String(row.last_failure_at),
    cancellationReason: row.cancellation_reason ?? null,
    cancelledReservationQty: row.cancelled_reservation_qty == null
      ? null
      : Number(row.cancelled_reservation_qty),
    demand: null,
    components: [],
    runs: [],
    createdAt: String(row.created_at),
    releasedAt: row.released_at == null ? null : String(row.released_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    cancelledAt: row.cancelled_at == null ? null : String(row.cancelled_at),
  };
}

function componentFromRow(row: any): BuildOrderComponentView {
  return {
    id: Number(row.id),
    componentVariantId: Number(row.component_variant_id),
    componentProductId: Number(row.component_product_id),
    componentUnitsPerVariant: Number(row.component_units_per_variant),
    sku: row.sku ?? null,
    name: String(row.name),
    qtyPerBuild: Number(row.qty_per_build),
    plannedQty: Number(row.planned_qty),
    consumedQty: Number(row.consumed_qty),
    reservedQty: Number(row.active_reserved_qty ?? 0),
    sourceLocationId: row.source_location_id == null ? null : Number(row.source_location_id),
    sourceLocationCode: row.source_location_code ?? null,
  };
}

function runFromRow(row: any): BuildRunView {
  return {
    id: Number(row.id),
    runNumber: Number(row.run_number),
    status: String(row.status),
    buildsCompleted: Number(row.builds_completed),
    outputQty: Number(row.output_qty),
    outputQtyOnHand: Number(row.output_qty_on_hand ?? 0),
    totalComponentCostMills: String(row.total_component_cost_mills ?? 0),
    postedBy: row.posted_by ?? null,
    postedAt: row.posted_at == null ? null : String(row.posted_at),
    createdAt: String(row.created_at),
    reversalId: row.reversal_id == null ? null : Number(row.reversal_id),
    reversalReason: row.reversal_reason ?? null,
    reversedAt: row.reversed_at == null ? null : String(row.reversed_at),
    canReverse: row.can_reverse === true,
    reversalBlocker: row.reversal_blocker ?? null,
  };
}

export class BuildQueryRepository {
  constructor(private readonly db: QueryDb) {}

  async listRecipes(): Promise<BuildRecipeView[]> {
    const result = await this.db.execute(sql`
      SELECT br.*, output.sku AS output_sku, output.name AS output_name
      FROM inventory.build_recipes br
      JOIN catalog.product_variants output ON output.id = br.output_variant_id
      ORDER BY br.code, br.version DESC
    `);
    const recipes = result.rows.map(recipeFromRow);
    if (recipes.length === 0) return [];

    const components = await this.db.execute(sql`
      SELECT brc.id, brc.recipe_id, brc.component_variant_id, brc.qty,
             brc.component_product_id, brc.component_units_per_variant,
             component.sku, component.name
      FROM inventory.build_recipe_components brc
      JOIN catalog.product_variants component ON component.id = brc.component_variant_id
      WHERE brc.recipe_id IN (${sql.join(recipes.map((recipe) => sql`${recipe.id}`), sql`, `)})
      ORDER BY brc.recipe_id, component.sku NULLS LAST, component.name
    `);
    const byRecipe = new Map<number, BuildRecipeComponentView[]>();
    for (const row of components.rows) {
      const recipeId = Number(row.recipe_id);
      const items = byRecipe.get(recipeId) ?? [];
      items.push({
        id: Number(row.id),
        componentVariantId: Number(row.component_variant_id),
        componentProductId: Number(row.component_product_id),
        componentUnitsPerVariant: Number(row.component_units_per_variant),
        sku: row.sku ?? null,
        name: String(row.name),
        qtyPerBuild: Number(row.qty),
      });
      byRecipe.set(recipeId, items);
    }
    return recipes.map((recipe) => ({ ...recipe, components: byRecipe.get(recipe.id) ?? [] }));
  }

  async listProductRelationships(productId: number): Promise<ProductVariantBuildRelationshipsView[]> {
    const variantsResult = await this.db.execute(sql`
      SELECT id, sku, name, is_active
      FROM catalog.product_variants
      WHERE product_id = ${productId}
      ORDER BY is_active DESC, hierarchy_level, units_per_variant, id
    `);
    const relationships = new Map<number, ProductVariantBuildRelationshipsView>(
      variantsResult.rows.map((row) => [
        Number(row.id),
        {
          variantId: Number(row.id),
          sku: row.sku ?? null,
          name: String(row.name),
          isActive: row.is_active === true || Number(row.is_active) === 1,
          producedBy: [],
          usedIn: [],
        },
      ]),
    );
    if (relationships.size === 0) return [];

    const relationshipResult = await this.db.execute(sql`
      SELECT 'produced_by'::text AS relationship_kind,
             br.output_variant_id AS subject_variant_id,
             br.output_qty AS quantity_per_build,
             br.id AS recipe_id, br.code AS recipe_code, br.name AS recipe_name,
             br.version AS recipe_version, br.status AS recipe_status,
             br.recipe_type,
             br.output_variant_id, output.sku AS output_sku,
             output.name AS output_name, br.output_qty
      FROM inventory.build_recipes br
      JOIN catalog.product_variants output ON output.id = br.output_variant_id
      WHERE output.product_id = ${productId}

      UNION ALL

      SELECT 'used_in'::text AS relationship_kind,
             component.id AS subject_variant_id,
             brc.qty AS quantity_per_build,
             br.id AS recipe_id, br.code AS recipe_code, br.name AS recipe_name,
             br.version AS recipe_version, br.status AS recipe_status,
             br.recipe_type,
             br.output_variant_id, output.sku AS output_sku,
             output.name AS output_name, br.output_qty
      FROM inventory.build_recipe_components brc
      JOIN inventory.build_recipes br ON br.id = brc.recipe_id
      JOIN catalog.product_variants component ON component.id = brc.component_variant_id
      JOIN catalog.product_variants output ON output.id = br.output_variant_id
      WHERE component.product_id = ${productId}

      ORDER BY subject_variant_id, relationship_kind, recipe_code, recipe_version DESC
    `);

    for (const row of relationshipResult.rows) {
      const variantId = Number(row.subject_variant_id);
      const variant = relationships.get(variantId);
      if (!variant) {
        throw new Error(`Build relationship references product variant ${variantId} outside product ${productId}`);
      }
      const reference: BuildRecipeRelationshipView = {
        recipeId: Number(row.recipe_id),
        code: String(row.recipe_code),
        name: String(row.recipe_name),
        version: Number(row.recipe_version),
        status: String(row.recipe_status),
        recipeType: String(row.recipe_type),
        quantityPerBuild: Number(row.quantity_per_build),
        outputVariantId: Number(row.output_variant_id),
        outputSku: row.output_sku ?? null,
        outputName: String(row.output_name),
        outputQty: Number(row.output_qty),
      };
      if (row.relationship_kind === 'produced_by') {
        variant.producedBy.push(reference);
      } else if (row.relationship_kind === 'used_in') {
        variant.usedIn.push(reference);
      } else {
        throw new Error(`Unknown build relationship kind: ${String(row.relationship_kind)}`);
      }
    }

    return [...relationships.values()];
  }
  private async loadOrderComponents(
    orderIds: number[],
  ): Promise<Map<number, BuildOrderComponentView[]>> {
    if (orderIds.length === 0) return new Map();
    const components = await this.db.execute(sql`
      SELECT boc.*, component.sku, component.name,
             source_location.code AS source_location_code,
             COALESCE(reservations.active_reserved_qty, 0) AS active_reserved_qty
      FROM inventory.build_order_components boc
      JOIN catalog.product_variants component ON component.id = boc.component_variant_id
      LEFT JOIN warehouse.warehouse_locations source_location ON source_location.id = boc.source_location_id
      LEFT JOIN (
        SELECT build_order_component_id,
               SUM(reserved_qty - consumed_qty - released_qty) AS active_reserved_qty
        FROM inventory.build_component_reservations
        GROUP BY build_order_component_id
      ) reservations ON reservations.build_order_component_id = boc.id
      WHERE boc.build_order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY boc.build_order_id, component.sku NULLS LAST, component.name
    `);
    const byOrder = new Map<number, BuildOrderComponentView[]>();
    for (const row of components.rows) {
      const orderId = Number(row.build_order_id);
      const items = byOrder.get(orderId) ?? [];
      items.push(componentFromRow(row));
      byOrder.set(orderId, items);
    }
    return byOrder;
  }

  private async loadOrderRuns(orderIds: number[]): Promise<Map<number, BuildRunView[]>> {
    if (orderIds.length === 0) return new Map();
    const runs = await this.db.execute(sql`
      WITH latest_posted AS (
        SELECT build_order_id, MAX(run_number) AS latest_run_number
        FROM inventory.build_runs
        WHERE status = 'posted'
          AND build_order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
        GROUP BY build_order_id
      ),
      lot_evidence AS (
        SELECT lot.build_run_id,
               COUNT(*) AS lot_count,
               COALESCE(SUM(lot.qty_on_hand), 0) AS output_qty_on_hand,
               COUNT(*) FILTER (
                 WHERE lot.warehouse_location_id <> bo.output_location_id
                    OR lot.qty_on_hand <> lot.qty_received
                    OR lot.qty_reserved <> 0
                    OR lot.qty_picked <> 0
               ) AS changed_lot_count
        FROM inventory.inventory_lots lot
        JOIN inventory.build_runs run ON run.id = lot.build_run_id
        JOIN inventory.build_orders bo ON bo.id = run.build_order_id
        WHERE run.build_order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
        GROUP BY lot.build_run_id
      )
      SELECT run.*,
             reversal.id AS reversal_id,
             reversal.reason AS reversal_reason,
             reversal.created_at AS reversed_at,
             COALESCE(lot_evidence.output_qty_on_hand, 0) AS output_qty_on_hand,
             (
               run.status = 'posted'
               AND run.run_number = latest_posted.latest_run_number
               AND COALESCE(lot_evidence.lot_count, 0) > 0
               AND COALESCE(lot_evidence.changed_lot_count, 0) = 0
             ) AS can_reverse,
             CASE
               WHEN run.status = 'reversed' THEN 'Run already reversed'
               WHEN run.status <> 'posted' THEN 'Run posting is incomplete'
               WHEN run.run_number <> latest_posted.latest_run_number
                 THEN 'Only the latest posted run can be reversed'
               WHEN COALESCE(lot_evidence.lot_count, 0) = 0 THEN 'Output lots are missing'
               WHEN COALESCE(lot_evidence.changed_lot_count, 0) > 0
                 THEN 'Output inventory was moved, reserved, picked, or consumed'
               ELSE NULL
             END AS reversal_blocker
      FROM inventory.build_runs run
      LEFT JOIN latest_posted ON latest_posted.build_order_id = run.build_order_id
      LEFT JOIN lot_evidence ON lot_evidence.build_run_id = run.id
      LEFT JOIN inventory.build_run_reversals reversal ON reversal.build_run_id = run.id
      WHERE run.build_order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY run.build_order_id, run.run_number DESC
    `);
    const byOrder = new Map<number, BuildRunView[]>();
    for (const row of runs.rows) {
      const orderId = Number(row.build_order_id);
      const items = byOrder.get(orderId) ?? [];
      items.push(runFromRow(row));
      byOrder.set(orderId, items);
    }
    return byOrder;
  }

  private async loadOrderDemands(
    orderIds: number[],
  ): Promise<Map<number, BuildOrderDemandView>> {
    if (orderIds.length === 0) return new Map();
    const demands = await this.db.execute(sql`
      WITH RECURSIVE demand_builds AS (
        SELECT demand.id AS demand_id,
               demand.root_build_order_id AS build_order_id,
               0 AS dependency_depth,
               ARRAY[demand.root_build_order_id]::integer[] AS path
        FROM wms.order_build_demands demand
        WHERE demand.root_build_order_id IS NOT NULL

        UNION ALL

        SELECT graph.demand_id,
               dependency.prerequisite_build_order_id,
               graph.dependency_depth + 1,
               graph.path || dependency.prerequisite_build_order_id
        FROM demand_builds graph
        JOIN inventory.build_order_dependencies dependency
          ON dependency.dependent_build_order_id = graph.build_order_id
        WHERE NOT dependency.prerequisite_build_order_id = ANY(graph.path)
      )
      SELECT graph.build_order_id,
             graph.dependency_depth,
             demand.id,
             demand.order_id,
             order_row.order_number,
             demand.order_item_id,
             item.sku,
             demand.requested_qty,
             demand.promised_qty,
             demand.status,
             demand.root_build_order_id
      FROM demand_builds graph
      JOIN wms.order_build_demands demand ON demand.id = graph.demand_id
      JOIN wms.orders order_row ON order_row.id = demand.order_id
      JOIN wms.order_items item ON item.id = demand.order_item_id
      WHERE graph.build_order_id IN (${sql.join(orderIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY graph.build_order_id, demand.id
    `);
    const byOrder = new Map<number, BuildOrderDemandView>();
    for (const row of demands.rows) {
      const buildOrderId = Number(row.build_order_id);
      if (byOrder.has(buildOrderId)) {
        throw new BuildDomainError(
          "BUILD_ORDER_DEMAND_CONFLICT",
          `Build order ${buildOrderId} is linked to more than one order demand`,
        );
      }
      byOrder.set(buildOrderId, {
        id: Number(row.id),
        orderId: Number(row.order_id),
        orderNumber: String(row.order_number),
        orderItemId: Number(row.order_item_id),
        sku: String(row.sku),
        requestedQty: Number(row.requested_qty),
        promisedQty: Number(row.promised_qty),
        status: String(row.status),
        rootBuildOrderId: Number(row.root_build_order_id),
        dependencyDepth: Number(row.dependency_depth),
      });
    }
    return byOrder;
  }

  private async hydrateOrders(orders: BuildOrderView[]): Promise<BuildOrderView[]> {
    if (orders.length === 0) return [];
    const orderIds = orders.map((order) => order.id);
    // This repository can be backed by one pg client. Keep its queries sequential
    // so hydration remains compatible with pg@9's single-query client contract.
    const componentsByOrder = await this.loadOrderComponents(orderIds);
    const runsByOrder = await this.loadOrderRuns(orderIds);
    const demandsByOrder = await this.loadOrderDemands(orderIds);
    return orders.map((order) => ({
      ...order,
      demand: demandsByOrder.get(order.id) ?? null,
      components: componentsByOrder.get(order.id) ?? [],
      runs: runsByOrder.get(order.id) ?? [],
    }));
  }

  async getOrder(buildOrderId: number): Promise<BuildOrderView> {
    const result = await this.db.execute(sql`
      SELECT bo.*, output.sku AS output_sku, output.name AS output_name,
             warehouse.name AS warehouse_name, output_location.code AS output_location_code
      FROM inventory.build_orders bo
      JOIN catalog.product_variants output ON output.id = bo.output_variant_id
      JOIN warehouse.warehouses warehouse ON warehouse.id = bo.warehouse_id
      JOIN warehouse.warehouse_locations output_location ON output_location.id = bo.output_location_id
      WHERE bo.id = ${buildOrderId}
    `);
    const row = result.rows[0];
    if (!row) {
      throw new BuildDomainError("BUILD_ORDER_NOT_FOUND", `Build order ${buildOrderId} was not found`);
    }
    const [order] = await this.hydrateOrders([orderFromRow(row)]);
    return order;
  }

  async listOrders(warehouseId?: number): Promise<BuildOrderView[]> {
    const result = await this.db.execute(sql`
      SELECT bo.*, output.sku AS output_sku, output.name AS output_name,
             warehouse.name AS warehouse_name, output_location.code AS output_location_code
      FROM inventory.build_orders bo
      JOIN catalog.product_variants output ON output.id = bo.output_variant_id
      JOIN warehouse.warehouses warehouse ON warehouse.id = bo.warehouse_id
      JOIN warehouse.warehouse_locations output_location ON output_location.id = bo.output_location_id
      WHERE (${warehouseId ?? null}::integer IS NULL OR bo.warehouse_id = ${warehouseId ?? null})
      ORDER BY bo.created_at DESC, bo.id DESC
      LIMIT 200
    `);
    return this.hydrateOrders(result.rows.map(orderFromRow));
  }

}

export function createBuildQueryRepository(db: QueryDb): BuildQueryRepository {
  return new BuildQueryRepository(db);
}
