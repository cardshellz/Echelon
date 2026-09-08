import { z } from "zod";
import type { OperationalShipmentSourceOwner } from "../inventory/application/operational-shipment-dispatch.port";
import { OperationalShipmentError, operationalShipmentRequestSchema, type OperationalShipmentSource } from "../inventory/domain/operational-shipment-dispatch";

const id = z.number().int().positive().max(2_147_483_647);
const sourceSchema = z.object({ id, shipment_id: id, order_item_id: id.nullable(),
  product_variant_id: id, qty: id, shipment_item_purpose: z.enum(["replacement", "concession"]),
  replacement_for_order_item_id: id.nullable(), correction_for_shipment_item_id: id.nullable(),
  provider_membership_state: z.literal("authoritative") });
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new OperationalShipmentError("OPERATIONAL_SHIPMENT_SOURCE_UNAUTHORIZED", message);
}

/** Existing WMS replacement authorization owns purpose; caller flags never do. */
export class WmsOperationalShipmentSourceOwner implements OperationalShipmentSourceOwner {
  async lockSource(client: Parameters<OperationalShipmentSourceOwner["lockSource"]>[0],
    raw: Parameters<OperationalShipmentSourceOwner["lockSource"]>[1]): Promise<OperationalShipmentSource> {
    const request = operationalShipmentRequestSchema.parse(raw);
    const order = (await client.query(`SELECT id,warehouse_id,on_hold,cancelled_at,warehouse_status
      FROM wms.orders WHERE id=$1 FOR UPDATE`, [request.orderId])).rows[0];
    ensure(!!order && id.safeParse(order.warehouse_id).success && order.on_hold === 0
      && order.cancelled_at == null && !["cancelled","on_hold","awaiting_3pl","exception"].includes(String(order.warehouse_status)),
      "Operational shipment requires an unheld local warehouse order.");
    const header = (await client.query(`SELECT id,order_id,status,held,requires_review,review_reason,
      shipment_purpose,replaces_shipment_id,cancelled_at,voided_at,replacement_authorized_at,replacement_authorized_by
      FROM wms.outbound_shipments WHERE id=$1 FOR UPDATE`, [request.outboundShipmentId])).rows[0];
    ensure(!!header && header.order_id === request.orderId && header.status === "shipped"
      && header.held === false && header.cancelled_at == null && header.voided_at == null
      && header.shipment_purpose === "replacement" && id.safeParse(header.replaces_shipment_id).success
      && header.replacement_authorized_at instanceof Date && Number.isFinite(header.replacement_authorized_at.getTime())
      && typeof header.replacement_authorized_by === "string" && header.replacement_authorized_by.trim().length > 0
      && (header.requires_review === false || header.review_reason === "shipstation_reship_adoption_pending"),
      "Operational shipment requires the existing exact authorized replacement/adoption header.");
    const parsed = sourceSchema.safeParse((await client.query(`SELECT id,shipment_id,order_item_id,
      product_variant_id,qty,shipment_item_purpose,replacement_for_order_item_id,
      correction_for_shipment_item_id,provider_membership_state
      FROM wms.outbound_shipment_items WHERE id=$1 FOR UPDATE`, [request.sourceShipmentItemId])).rows[0]);
    ensure(parsed.success, "Operational source has invalid purpose or source lineage.");
    const source = parsed.data;
    ensure(source.shipment_id === request.outboundShipmentId && source.product_variant_id === request.productVariantId
      && source.qty === request.quantity && source.order_item_id === null && source.correction_for_shipment_item_id === null,
      "Operational source must match the complete immutable source quantity and variant.");
    if (source.shipment_item_purpose === "replacement") {
      ensure(source.replacement_for_order_item_id !== null, "Replacement source requires its original order-line authority.");
      const original = (await client.query(`SELECT id,order_id FROM wms.order_items WHERE id=$1 FOR SHARE`,
        [source.replacement_for_order_item_id])).rows[0];
      ensure(!!original && original.order_id === request.orderId, "Replacement lineage belongs to another order.");
    } else {
      ensure(source.replacement_for_order_item_id === null, "Concession may not claim customer order-line authority.");
    }
    const originalHeader = (await client.query("SELECT id,order_id FROM wms.outbound_shipments WHERE id=$1 FOR SHARE",
      [header.replaces_shipment_id])).rows[0];
    ensure(!!originalHeader && originalHeader.order_id === request.orderId
      && originalHeader.id !== header.id, "Replacement header must reference another exact shipment on the same order.");
    const physical = (await client.query(`SELECT id::text,physical_shipment_id::text
      FROM wms.physical_shipment_items WHERE legacy_wms_shipment_item_id=$1 ORDER BY id LIMIT 2`, [source.id])).rows;
    ensure(physical.length <= 1, "Multiple physical lines claim this operational source.");
    let physicalShipmentItemId: string | null = null;
    if (physical.length === 1) {
      const physicalHeader = (await client.query("SELECT id,status FROM wms.physical_shipments WHERE id=$1::bigint FOR UPDATE",
        [physical[0].physical_shipment_id])).rows[0];
      const item = (await client.query(`SELECT * FROM wms.physical_shipment_items WHERE id=$1::bigint FOR UPDATE`,
        [physical[0].id])).rows[0];
      ensure(!!physicalHeader && physicalHeader.status === "shipped" && !!item
        && item.legacy_wms_shipment_item_id === source.id && item.wms_order_item_id === null
        && item.product_variant_id === source.product_variant_id && item.quantity_shipped === source.qty
        && item.shipment_item_purpose === source.shipment_item_purpose
        && item.replacement_for_order_item_id === source.replacement_for_order_item_id
        && item.correction_for_physical_shipment_item_id === null && item.package_allocation_entry_id === null,
        "Existing physical package conflicts with the exact operational source.");
      ensure((await client.query("SELECT id FROM wms.physical_shipment_item_quantity_adjustments WHERE physical_shipment_item_id=$1::bigint LIMIT 1",
        [physical[0].id])).rows.length === 0, "Corrected physical evidence cannot authorize new stock consumption.");
      physicalShipmentItemId = String(physical[0].id);
    }
    return Object.freeze({ warehouseId: Number(order.warehouse_id), purpose: source.shipment_item_purpose,
      replacementForOrderItemId: source.replacement_for_order_item_id, physicalShipmentItemId });
  }
}
