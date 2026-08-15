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
  sourceLocationId: number | null;
  sourceLocationCode: string | null;
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
  warehouseId: number;
  warehouseName: string;
  outputLocationId: number;
  outputLocationCode: string;
  status: string;
  totalComponentCostMills: string | null;
  components: BuildOrderComponentView[];
  createdAt: string;
  releasedAt: string | null;
  completedAt: string | null;
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
    warehouseId: Number(row.warehouse_id),
    warehouseName: String(row.warehouse_name),
    outputLocationId: Number(row.output_location_id),
    outputLocationCode: String(row.output_location_code),
    status: String(row.status),
    totalComponentCostMills: row.total_component_cost_mills == null
      ? null
      : String(row.total_component_cost_mills),
    components: [],
    createdAt: String(row.created_at),
    releasedAt: row.released_at == null ? null : String(row.released_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
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
    const order = orderFromRow(row);
    const components = await this.db.execute(sql`
      SELECT boc.*, component.sku, component.name,
             source_location.code AS source_location_code
      FROM inventory.build_order_components boc
      JOIN catalog.product_variants component ON component.id = boc.component_variant_id
      LEFT JOIN warehouse.warehouse_locations source_location ON source_location.id = boc.source_location_id
      WHERE boc.build_order_id = ${buildOrderId}
      ORDER BY component.sku NULLS LAST, component.name
    `);
    order.components = components.rows.map((component) => ({
      id: Number(component.id),
      componentVariantId: Number(component.component_variant_id),
      componentProductId: Number(component.component_product_id),
      componentUnitsPerVariant: Number(component.component_units_per_variant),
      sku: component.sku ?? null,
      name: String(component.name),
      qtyPerBuild: Number(component.qty_per_build),
      plannedQty: Number(component.planned_qty),
      consumedQty: Number(component.consumed_qty),
      sourceLocationId: component.source_location_id == null ? null : Number(component.source_location_id),
      sourceLocationCode: component.source_location_code ?? null,
    }));
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
    const orders = result.rows.map(orderFromRow);
    if (orders.length === 0) return [];
    const components = await this.db.execute(sql`
      SELECT boc.*, component.sku, component.name,
             source_location.code AS source_location_code
      FROM inventory.build_order_components boc
      JOIN catalog.product_variants component ON component.id = boc.component_variant_id
      LEFT JOIN warehouse.warehouse_locations source_location ON source_location.id = boc.source_location_id
      WHERE boc.build_order_id IN (${sql.join(orders.map((order) => sql`${order.id}`), sql`, `)})
      ORDER BY boc.build_order_id, component.sku NULLS LAST, component.name
    `);
    const byOrder = new Map<number, BuildOrderComponentView[]>();
    for (const component of components.rows) {
      const orderId = Number(component.build_order_id);
      const items = byOrder.get(orderId) ?? [];
      items.push({
        id: Number(component.id),
        componentVariantId: Number(component.component_variant_id),
        componentProductId: Number(component.component_product_id),
        componentUnitsPerVariant: Number(component.component_units_per_variant),
        sku: component.sku ?? null,
        name: String(component.name),
        qtyPerBuild: Number(component.qty_per_build),
        plannedQty: Number(component.planned_qty),
        consumedQty: Number(component.consumed_qty),
        sourceLocationId: component.source_location_id == null ? null : Number(component.source_location_id),
        sourceLocationCode: component.source_location_code ?? null,
      });
      byOrder.set(orderId, items);
    }
    return orders.map((order) => ({ ...order, components: byOrder.get(order.id) ?? [] }));
  }
}

export function createBuildQueryRepository(db: QueryDb): BuildQueryRepository {
  return new BuildQueryRepository(db);
}
