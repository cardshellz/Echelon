import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { inventoryTrackingEvidenceRecordSchema, MAX_INVENTORY_TRACKING_EVIDENCE_RECORDS,
  type InventoryTrackingEvidence } from "@shared/catalog/bulk-inventory-tracking";
import type { InventoryTrackingTransaction } from "./bulk-inventory-tracking.repository";

type EvidenceCode = "stock" | "lots" | "open_orders" | "oms_orders" | "claims" | "resources" | "publication";
const rowSchema = z.object({ variantId: z.number().int().positive().safe(), totalCount: z.number().int().positive().safe(),
  detail: inventoryTrackingEvidenceRecordSchema });

/** Bound the returned records per variant; counts disclose omitted records.
 * Claim quantities/IDs and publication IDs use decimal strings. Catalog and
 * order IDs follow their existing API contract, validated as safe integers. */
function evidenceQuery(code: EvidenceCode, variantIds: readonly number[]): SQL {
  const ids = sql.join(variantIds.map(id => sql`${id}`), sql`, `);
  switch (code) {
    case "stock": return sql`SELECT l.product_variant_id AS variant_id, l.id,
      jsonb_build_object('kind','stock','recordId',l.id,'locationId',l.warehouse_location_id,'locationCode',w.code,
        'onHand',l.variant_qty,'reserved',l.reserved_qty,'picked',l.picked_qty,'packed',l.packed_qty,'backorder',l.backorder_qty) AS detail
      FROM inventory.inventory_levels l LEFT JOIN warehouse.warehouse_locations w ON w.id=l.warehouse_location_id
      WHERE l.product_variant_id IN (${ids}) AND (l.variant_qty<>0 OR l.reserved_qty<>0 OR l.picked_qty<>0 OR l.packed_qty<>0 OR l.backorder_qty<>0)`;
    case "lots": return sql`SELECT l.product_variant_id AS variant_id, l.id,
      jsonb_build_object('kind','lots','recordId',l.id,'lotNumber',l.lot_number,
        'locationId',l.warehouse_location_id,'locationCode',w.code,
        'onHand',l.qty_on_hand,'reserved',l.qty_reserved,'picked',l.qty_picked,'packed',l.qty_packed) AS detail
      FROM inventory.inventory_lots l LEFT JOIN warehouse.warehouse_locations w ON w.id=l.warehouse_location_id
      WHERE l.product_variant_id IN (${ids}) AND (l.qty_on_hand<>0 OR l.qty_reserved<>0 OR l.qty_picked<>0 OR l.qty_packed<>0)`;
    case "open_orders": return sql`SELECT v.id AS variant_id, i.id,
      jsonb_build_object('kind','open_orders','recordId',i.id,'orderId',o.id,'orderNumber',o.order_number,
        'status',o.warehouse_status,'itemStatus',i.status,'quantity',i.quantity,'picked',i.picked_quantity,'fulfilled',i.fulfilled_quantity) AS detail
      FROM catalog.product_variants v JOIN wms.order_items i ON (i.product_id=v.id OR (i.product_id IS NULL AND i.sku=v.sku))
      JOIN wms.orders o ON o.id=i.order_id WHERE v.id IN (${ids})
        AND o.warehouse_status NOT IN ('shipped','completed','cancelled','voided') AND i.status<>'cancelled' AND i.fulfilled_quantity<i.quantity`;
    case "oms_orders": return sql`SELECT i.product_variant_id AS variant_id, i.id,
      jsonb_build_object('kind','oms_orders','recordId',i.id,'orderId',o.id,'orderNumber',o.external_order_number,
        'status',o.status,'fulfillmentStatus',o.fulfillment_status,'quantity',i.quantity,
        'warehouseOrders',COALESCE(w.orders,'[]'::jsonb),'warehouseOrderCount',COALESCE(w.total,0)) AS detail
      FROM oms.oms_order_lines i JOIN oms.oms_orders o ON o.id=i.order_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('orderId',linked.id,'orderNumber',linked.order_number,'status',linked.warehouse_status)
          ORDER BY linked.id) FILTER (WHERE linked.position<=${MAX_INVENTORY_TRACKING_EVIDENCE_RECORDS}) AS orders,
          count(*)::integer AS total
        FROM (SELECT DISTINCT wo.id, wo.order_number, wo.warehouse_status, dense_rank() OVER (ORDER BY wo.id) AS position
          FROM wms.order_items wi JOIN wms.orders wo ON wo.id=wi.order_id WHERE wi.oms_order_line_id=i.id) linked
      ) w ON true
      WHERE i.product_variant_id IN (${ids}) AND o.status NOT IN ('shipped','delivered','cancelled','refunded')`;
    case "claims": return sql`SELECT l.target_variant_id AS variant_id, l.id,
      jsonb_build_object('kind','claims','recordId',l.id::text,'claimId',l.claim_id::text,'orderItemId',l.order_item_id,
        'planned',l.planned_qty::text,'released',l.released_target_qty::text,'consumed',l.consumed_target_qty::text) AS detail
      FROM inventory.availability_claim_lines l WHERE l.target_variant_id IN (${ids}) AND l.planned_qty>l.released_target_qty+l.consumed_target_qty`;
    case "resources": return sql`SELECT l.source_variant_id AS variant_id, l.id,
      jsonb_build_object('kind','resources','recordId',l.id::text,'claimId',l.claim_id::text,
        'locationId',l.warehouse_location_id,'locationCode',w.code,
        'claimed',l.claimed_qty::text,'released',l.released_qty::text,'consumed',l.consumed_qty::text) AS detail
      FROM inventory.availability_claim_resources l LEFT JOIN warehouse.warehouse_locations w ON w.id=l.warehouse_location_id
      WHERE l.source_variant_id IN (${ids}) AND l.claimed_qty>l.released_qty+l.consumed_qty`;
    case "publication": return sql`SELECT product_variant_id AS variant_id, id,
      jsonb_build_object('kind','publication','recordId',id::text,'state',state) AS detail
      FROM inventory.inventory_publication_outbox WHERE product_variant_id IN (${ids})
        AND state NOT IN ('verified','dead_letter','superseded','cancelled')`;
  }
}

export async function loadInventoryTrackingEvidence(
  tx: InventoryTrackingTransaction, dependencies: ReadonlyArray<{ variantId: number; blockers: readonly string[] }>,
): Promise<Map<number, Record<string, InventoryTrackingEvidence>>> {
  const evidence = new Map<number, Record<string, InventoryTrackingEvidence>>();
  const codes: EvidenceCode[] = ["stock", "lots", "open_orders", "oms_orders", "claims", "resources", "publication"];
  for (const code of codes) {
    const variantIds = [...new Set(dependencies.filter(d => d.blockers.includes(code)).map(d => d.variantId))].sort((a, b) => a - b);
    if (!variantIds.length) continue;
    for (const id of variantIds) {
      const variant = evidence.get(id) ?? {};
      variant[code] = { totalCount: 0, records: [] };
      evidence.set(id, variant);
    }
    const result = await tx.execute(sql`SELECT variant_id AS "variantId", total_count AS "totalCount", detail FROM (
      SELECT source.*, count(*) OVER (PARTITION BY variant_id)::integer AS total_count,
        row_number() OVER (PARTITION BY variant_id ORDER BY id) AS position
      FROM (${evidenceQuery(code, variantIds)}) source
    ) ranked WHERE position<=${MAX_INVENTORY_TRACKING_EVIDENCE_RECORDS} ORDER BY variant_id,id`);
    for (const raw of result.rows) {
      const row = rowSchema.parse(raw);
      const group = evidence.get(row.variantId)?.[code];
      if (!group || row.detail.kind !== code) throw new Error("Inventory policy evidence did not match the requested dependency");
      group.totalCount = row.totalCount;
      group.records.push(row.detail);
    }
  }
  return evidence;
}
