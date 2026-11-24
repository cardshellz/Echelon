import type { PoolClient } from "pg";
import type { CutoverReconstructionCost } from "@shared/types/inventory-cutover-reconstruction";

/** Extant original COGS only. Adoption must not update/delete or re-cost these rows. */
export async function readCutoverOriginalCosts(client: PoolClient, orderItemIds: number[]): Promise<CutoverReconstructionCost[]> {
  const result = await client.query(`SELECT id, order_id AS "orderId", order_item_id AS "orderItemId",
    inventory_lot_id AS "inventoryLotId", product_variant_id AS "productVariantId", qty::text AS quantity,
    unit_cost_mills::text AS "unitCostMills", total_cost_mills::text AS "totalCostMills", created_at AS "occurredAt",
    CASE WHEN to_jsonb(cost)->>'cost_quantity_allocation_id' IS NULL THEN NULL
      ELSE jsonb_build_object('quantityAllocationId',to_jsonb(cost)->>'cost_quantity_allocation_id',
        'productMills',to_jsonb(cost)->>'product_total_cost_mills','packagingMills',to_jsonb(cost)->>'packaging_total_cost_mills',
        'landedMills',to_jsonb(cost)->>'landed_total_cost_mills') END AS "exactTotals"
    FROM oms.order_item_costs cost WHERE order_item_id=ANY($1::integer[]) ORDER BY id LIMIT 100001`, [orderItemIds]);
  if (result.rows.length > 100_000) throw new Error("CUTOVER_ORIGINAL_COST_CENSUS_LIMIT_EXCEEDED");
  return result.rows.map((row) => {
    const { exactTotals, ...legacy } = row;
    return { ...legacy, ...(exactTotals == null ? {} : {exactTotals}),
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt };
  });
}
