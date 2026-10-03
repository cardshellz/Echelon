import { sql } from "drizzle-orm";
import { z } from "zod";
import { RecipeCapacityService } from "../../inventory/recipe-capacity.service";
import type { InventorySupplyDependencyReader } from "../application/inventory-supply-dependency-read.port";
import type { InventoryAvailabilityRuntimeAtpExecutor } from "../application/inventory-availability-runtime-atp.service";
import {
  PostgresInventoryAvailabilityRuntimeAtpExecutor,
  type PostgresInventoryAvailabilityRuntimeTransaction,
} from "./inventory-availability-runtime-atp.repository";

const productIdSchema = z.number().int().positive().max(2_147_483_647);
const MAX_DEPENDENT_PRODUCTS = 1_000;

/** Component changes invalidate the sealed dependency graph, not today's editable
 * recipe catalog. Product-level closure deliberately includes sibling packages:
 * their allowed conversions can supply a recipe consuming another exact SKU. */
export class PostgresInventorySupplyDependencyReader implements InventorySupplyDependencyReader {
  constructor(private readonly runtime: InventoryAvailabilityRuntimeAtpExecutor<PostgresInventoryAvailabilityRuntimeTransaction>
    = new PostgresInventoryAvailabilityRuntimeAtpExecutor()) {}

  async getAffectedProductIds(changedVariantId: number): Promise<readonly number[]> {
    productIdSchema.parse(changedVariantId);
    return this.runtime.execute(async (context, transaction) => {
      const productId = (await context.getProductIdsByVariantIds([changedVariantId])).get(changedVariantId);
      if (productId === undefined) return [];
      productIdSchema.parse(productId);
      if (context.authority === "legacy") {
        const dependentIds = await new RecipeCapacityService(transaction).getAffectedOutputProductIds(changedVariantId);
        return [...new Set([productId, ...dependentIds])].sort((left, right) => left - right);
      }
      const result = await transaction.execute(sql`
        WITH RECURSIVE affected(product_id) AS (
          SELECT ${productId}::integer
          UNION
          SELECT model.product_id FROM affected
          JOIN inventory.transformation_recipe_component_snapshots component
            ON component.component_product_id = affected.product_id
          JOIN inventory.transformation_recipe_bindings binding
            ON binding.id = component.transformation_recipe_binding_id AND binding.model_id = component.model_id
          JOIN inventory.transformation_model_heads head ON head.active_model_id = binding.model_id
          JOIN inventory.transformation_model_versions model ON model.id = head.active_model_id AND model.product_id = head.product_id
          WHERE model.lifecycle_status = 'sealed' AND model.validation_state = 'valid'
            AND binding.validation_state = 'valid'
            AND (model.inventory_behavior IS NULL OR model.inventory_behavior = 'build_managed')
        ) SELECT product_id FROM affected ORDER BY product_id LIMIT ${MAX_DEPENDENT_PRODUCTS + 1}
      `);
      const products = z.array(z.object({ product_id: productIdSchema })).parse(result.rows);
      if (products.length > MAX_DEPENDENT_PRODUCTS) {
        throw new InventorySupplyDependencyError("INVENTORY_SUPPLY_DEPENDENCY_LIMIT",
          "The complete inventory-change dependency graph exceeds the supported product limit.", { changedVariantId });
      }
      return products.map(row => row.product_id);
    });
  }
}

export class InventorySupplyDependencyError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown>) {
    super(message);
    this.name = "InventorySupplyDependencyError";
  }
}
