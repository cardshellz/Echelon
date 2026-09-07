import { sql, type SQL } from "drizzle-orm";

/** Bulk procurement inventory position. Quarantine is hard-ineligible in the
 * inventory availability planner. Nonpickable reserve stock still contributes:
 * procurement needs warehouse supply, not only immediately pickable ATP. */
export function purchaseInventorySnapshotQuery(): SQL {
  return sql`
    SELECT pv.product_id,
      SUM(il.variant_qty::bigint * pv.units_per_variant::bigint)
        FILTER (WHERE location.location_type IS DISTINCT FROM 'quarantine') AS total_pieces,
      SUM(il.reserved_qty::bigint * pv.units_per_variant::bigint)
        FILTER (WHERE location.location_type IS DISTINCT FROM 'quarantine') AS total_reserved_pieces,
      SUM(il.variant_qty::bigint * pv.units_per_variant::bigint)
        FILTER (WHERE location.location_type = 'quarantine') AS excluded_quarantine_pieces,
      COUNT(DISTINCT pv.id) AS variant_count
    FROM inventory.inventory_levels il
    JOIN catalog.product_variants pv ON pv.id = il.product_variant_id
    LEFT JOIN warehouse.warehouse_locations location ON location.id = il.warehouse_location_id
    WHERE pv.is_active = true
    GROUP BY pv.product_id
  `;
}
