import type { PoolClient } from "pg";
import { captureInventoryCutoverEncumbranceAfterAdmission } from "./inventory-cutover-encumbrance.repository";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { aggregateCutoverJournalEvidence, MAX_CUTOVER_JOURNAL_ROWS } from "../domain/inventory-cutover-journal-evidence";

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
  // A SINGLE statement keeps all identity links in the same snapshot, including
  // commit's READ COMMITTED transaction. Do not keyset-page this census.
  // Only compact facts and database-computed digests cross the connection. The
  // inventory domain completes exact NULL IDs and retains every unknown cause.
  const rawJournals = (await client.query(`SELECT journal.id, journal.order_id AS "orderId", journal.order_item_id AS "orderItemId",
    journal.product_variant_id AS "productVariantId", journal.from_location_id AS "fromLocationId", journal.to_location_id AS "toLocationId",
    journal.transaction_type AS "transactionType", journal.variant_qty_delta AS "variantQtyDelta",
    journal.reserved_qty_delta AS "reservedQtyDelta", journal.source_state AS "sourceState",
    journal.shipment_id AS "shipmentId", journal.shipment_item_id AS "shipmentItemId",
    direct_shipment.id AS "directShipmentId", direct_shipment.order_id AS "directShipmentOrderId", direct_shipment.status AS "directShipmentStatus",
    item.id AS "itemId", item.order_id AS "itemOrderId", item_order.warehouse_id AS "itemOrderWarehouseId",
    source.id AS "sourceId", source.shipment_id AS "sourceShipmentId", source.order_item_id AS "sourceOrderItemId",
    source_item.id AS "sourceItemId", source_item.order_id AS "sourceItemOrderId",
    source_header.id AS "sourceHeaderId", source_header.order_id AS "sourceHeaderOrderId", source_order.warehouse_id AS "sourceOrderWarehouseId",
    source.product_variant_id AS "sourceVariantId", source.from_location_id AS "sourceLocationId", source.qty AS "sourceQty",
    source.shipment_item_purpose AS "sourcePurpose", source.replacement_for_order_item_id AS "sourceReplacementItemId",
    source.correction_for_shipment_item_id AS "sourceCorrectionItemId", source_header.status AS "sourceStatus",
    source_header.requires_review AS "sourceRequiresReview", from_location.warehouse_id AS "fromWarehouseId", to_location.warehouse_id AS "toWarehouseId",
    encode(sha256(convert_to(to_jsonb(journal.*)::text,'UTF8')),'hex') AS "journalHash",
    encode(sha256(convert_to(jsonb_build_object('item',to_jsonb(item.*),'directShipment',to_jsonb(direct_shipment.*),'itemOrder',jsonb_build_object('id',item_order.id,'warehouseId',item_order.warehouse_id),
      'source',to_jsonb(source.*),'sourceItem',to_jsonb(source_item.*),'sourceHeader',to_jsonb(source_header.*),
      'sourceOrder',jsonb_build_object('id',source_order.id,'warehouseId',source_order.warehouse_id),
      'from',jsonb_build_object('id',from_location.id,'warehouseId',from_location.warehouse_id),
      'to',jsonb_build_object('id',to_location.id,'warehouseId',to_location.warehouse_id))::text,'UTF8')),'hex') AS "linkHash"
    FROM inventory.inventory_transactions journal
    LEFT JOIN wms.order_items item ON item.id=journal.order_item_id
    LEFT JOIN wms.orders item_order ON item_order.id=item.order_id
    LEFT JOIN wms.outbound_shipments direct_shipment ON direct_shipment.id=journal.shipment_id
    LEFT JOIN wms.outbound_shipment_items source ON source.id=journal.shipment_item_id
    LEFT JOIN wms.order_items source_item ON source_item.id=source.order_item_id
    LEFT JOIN wms.outbound_shipments source_header ON source_header.id=source.shipment_id
    LEFT JOIN wms.orders source_order ON source_order.id=source_item.order_id
    LEFT JOIN warehouse.warehouse_locations from_location ON from_location.id=journal.from_location_id
    LEFT JOIN warehouse.warehouse_locations to_location ON to_location.id=journal.to_location_id
    WHERE journal.voided_at IS NULL AND journal.transaction_type IN ('reserve','unreserve','pick','unpick','ship','reserve_move')
      AND COALESCE(journal.reference_type,'') NOT LIKE 'availability_claim%'
    ORDER BY journal.id LIMIT $1`, [MAX_CUTOVER_JOURNAL_ROWS + 1])).rows;
  const journals = aggregateCutoverJournalEvidence(rawJournals);
  const claims = (await client.query(`SELECT count(*)::text AS count,
    encode(sha256(convert_to(COALESCE(string_agg(to_jsonb(claim)::text,',' ORDER BY id),''),'UTF8')),'hex') AS digest
    FROM inventory.availability_claims claim`)).rows[0];
  return { levels, lots, journals,
    buildReservations: capture.buildReservations, canonicalResources: capture.canonicalResources,
    canonicalClaimCount: claims.count, canonicalClaimHash: claims.digest } as Pick<CutoverReconstructionEvidence,
      "levels" | "lots" | "journals" | "buildReservations" | "canonicalResources" | "canonicalClaimCount" | "canonicalClaimHash">;
}
