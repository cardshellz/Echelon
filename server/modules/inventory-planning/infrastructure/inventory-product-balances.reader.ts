import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";
import { inventoryProductBalancesSchema, type InventoryProductBalances } from "../application/inventory-product-balances";

/** Uses the caller's pinned transaction; no recipe reads or availability calculation. */
export async function readInventoryProductBalances(
  client: InventoryAvailabilityTransactionQueryClient,
  productId: number,
): Promise<InventoryProductBalances | null> {
  const result = await client.query(`SELECT p.id AS "productId", COALESCE(p.sku, '') AS sku,
      p.name, p.inventory_strategy AS "inventoryStrategy",
      COALESCE((SELECT jsonb_agg(row_to_json(v) ORDER BY v."productVariantId") FROM (
        SELECT pv.id AS "productVariantId", COALESCE(pv.sku, '') AS sku, pv.name,
          pv.is_active AS "isActive", pv.units_per_variant AS "unitsPerVariant",
          COALESCE(SUM(il.variant_qty), 0)::text AS "physicalQty",
          COALESCE(SUM(il.reserved_qty), 0)::text AS "reservedQty",
          COALESCE(SUM(il.picked_qty), 0)::text AS "pickedQty"
        FROM catalog.product_variants pv
        LEFT JOIN inventory.inventory_levels il ON il.product_variant_id = pv.id
        WHERE pv.product_id = p.id AND pv.requires_shipping = true
          AND COALESCE(pv.track_inventory, true) = true
        GROUP BY pv.id
      ) v), '[]'::jsonb) AS variants
    FROM catalog.products p WHERE p.id = $1`, [productId]);
  return result.rows.length === 0 ? null : inventoryProductBalancesSchema.parse(result.rows[0]);
}
