import type { PoolClient } from "pg";
import { captureInventoryCutoverEncumbranceAfterAdmission } from "./inventory-cutover-encumbrance.repository";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";

const MAX_EVIDENCE_ROWS = 50_000;
export async function readInventoryCutoverReconstruction(client: PoolClient): Promise<Pick<CutoverReconstructionEvidence,
  "levels" | "lots" | "journals" | "buildReservations" | "canonicalResources" | "canonicalClaimCount" | "canonicalClaimHash">> {
  const bounded = async (query: string) => {
    const rows = (await client.query(query, [MAX_EVIDENCE_ROWS + 1])).rows;
    if (rows.length > MAX_EVIDENCE_ROWS) throw new Error("INVENTORY_CUTOVER_RECONSTRUCTION_CENSUS_LIMIT_EXCEEDED");
    return rows;
  };
  const capture = await captureInventoryCutoverEncumbranceAfterAdmission(client, MAX_EVIDENCE_ROWS);
  const levels = await bounded(`SELECT level.id, level.warehouse_location_id AS "warehouseLocationId",
    location.warehouse_id AS "warehouseId", level.product_variant_id AS "productVariantId",
    level.variant_qty::text AS "variantQty", level.reserved_qty::text AS "reservedQty",
    level.picked_qty::text AS "pickedQty", level.packed_qty::text AS "packedQty"
    FROM inventory.inventory_levels level LEFT JOIN warehouse.warehouse_locations location ON location.id=level.warehouse_location_id
    ORDER BY level.id LIMIT $1`);
  const lots = await bounded(`SELECT id, warehouse_location_id AS "warehouseLocationId", product_variant_id AS "productVariantId",
    qty_on_hand::text AS "onHandQty", qty_reserved::text AS "reservedQty", qty_picked::text AS "pickedQty", status,
    total_unit_cost_mills::text AS "unitCostMills", po_unit_cost_mills::text AS "poUnitCostMills",
    packaging_cost_mills::text AS "packagingUnitCostMills", landed_cost_mills::text AS "landedUnitCostMills"
    FROM inventory.inventory_lots ORDER BY id LIMIT $1`);
  // Group globally BEFORE selecting orders: terminal/orphan ownership must not
  // disappear through an order-status filter. Mixed ship quantities are unknown:
  // the legacy source_state is on_hand even when some picked units were consumed.
  const journals = await bounded(`SELECT order_id AS "orderId", order_item_id AS "orderItemId",
    product_variant_id AS "productVariantId", COALESCE(to_location_id,from_location_id) AS "warehouseLocationId",
    COALESCE(sum(reserved_qty_delta),0)::text AS "reservedQty",
    COALESCE(sum(CASE WHEN transaction_type='pick' THEN -variant_qty_delta
      WHEN transaction_type='unpick' THEN -variant_qty_delta
      WHEN transaction_type='ship' AND source_state='picked' THEN variant_qty_delta ELSE 0 END),0)::text AS "pickedQty",
    COALESCE(sum(CASE WHEN transaction_type='ship' THEN -variant_qty_delta ELSE 0 END),0)::text AS "shippedQty",
    count(*) FILTER (WHERE (transaction_type IN ('reserve','unreserve','pick') AND reserved_qty_delta IS NULL)
      OR (transaction_type IN ('pick','unpick','ship') AND variant_qty_delta IS NULL)
      OR (transaction_type='ship' AND source_state IS DISTINCT FROM 'picked'))::text AS "unknownCount",
    count(*)::text AS "journalCount",
    encode(sha256(convert_to(string_agg(to_jsonb(journal)::text, ',' ORDER BY id),'UTF8')),'hex') AS "journalHash"
    FROM inventory.inventory_transactions journal
    WHERE voided_at IS NULL AND transaction_type IN ('reserve','unreserve','pick','unpick','ship')
      AND COALESCE(reference_type,'') NOT LIKE 'availability_claim%'
    GROUP BY order_id, order_item_id, product_variant_id, COALESCE(to_location_id,from_location_id)
    ORDER BY order_id NULLS FIRST,order_item_id NULLS FIRST,product_variant_id NULLS FIRST,COALESCE(to_location_id,from_location_id) NULLS FIRST
    LIMIT $1`);
  const claims = (await client.query(`SELECT count(*)::text AS count,
    encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(claim)::text,',' ORDER BY id),''),'UTF8')),'hex') AS digest
    FROM inventory.availability_claims claim`)).rows[0];
  return { levels, lots, journals,
    buildReservations: capture.buildReservations, canonicalResources: capture.canonicalResources,
    canonicalClaimCount: claims.count, canonicalClaimHash: claims.digest } as Pick<CutoverReconstructionEvidence,
      "levels" | "lots" | "journals" | "buildReservations" | "canonicalResources" | "canonicalClaimCount" | "canonicalClaimHash">;
}
