import type { PoolClient } from "pg";
import type { CutoverReconstructionCost } from "@shared/types/inventory-cutover-reconstruction";

/** Extant original COGS only. Adoption must not update/delete or re-cost these rows. */
export async function readCutoverOriginalCosts(client: PoolClient, orderItemIds: number[]): Promise<CutoverReconstructionCost[]> {
  const result = await client.query(`SELECT id, order_id AS "orderId", order_item_id AS "orderItemId",
    inventory_lot_id AS "inventoryLotId", product_variant_id AS "productVariantId", qty::text AS quantity,
    unit_cost_mills::text AS "unitCostMills", total_cost_mills::text AS "totalCostMills", created_at AS "occurredAt"
    FROM oms.order_item_costs WHERE order_item_id=ANY($1::integer[]) ORDER BY id LIMIT 100001`, [orderItemIds]);
  if (result.rows.length > 100_000) throw new Error("CUTOVER_ORIGINAL_COST_CENSUS_LIMIT_EXCEEDED");
  return result.rows.map((row) => ({ ...row, occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt }));
}
