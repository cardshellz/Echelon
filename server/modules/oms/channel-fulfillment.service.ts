/**
 * Channel Fulfillment Service
 *
 * Handles fulfillments that originate outside ShipStation — e.g. a label
 * bought directly in Shopify or a fulfillment recorded on eBay. Runs the
 * same WMS shipment → rollup → OMS derive cascade that SHIP_NOTIFY V2
 * uses, so all fulfillment sources converge on the same state machine.
 */

import { sql, eq } from "drizzle-orm";
import { omsOrders, omsOrderLines, omsOrderEvents } from "@shared/schema/oms.schema";
import {
  dispatchShipmentEvent,
  recomputeOrderStatusFromShipments,
  type ShipmentEvent,
} from "../orders/shipment-rollup";
import { deriveOmsFromWms } from "@shared/enums/order-status";

const LOG_PREFIX = "[ChannelFulfillment]";

export interface ChannelFulfillmentInput {
  trackingNumber: string;
  carrier: string;
  shipDate?: Date;
  trackingUrl?: string | null;
  source: string;
  sourceFulfillmentId?: string | null;
}

export interface ChannelFulfillmentResult {
  processed: boolean;
  shipmentsMarked: number;
}

/**
 * Mark a WMS order as shipped from a channel-side fulfillment.
 *
 * Finds all planned/ready shipments for the WMS order, marks each shipped
 * with the provided tracking, rolls up order status, and derives the OMS
 * state. Idempotent — already-shipped shipments with matching tracking
 * are no-ops.
 */
export async function applyChannelFulfillment(
  db: any,
  wmsOrderId: number,
  input: ChannelFulfillmentInput,
): Promise<ChannelFulfillmentResult> {
  const now = input.shipDate ?? new Date();

  const shipmentResult: any = await db.execute(sql`
    SELECT id, status, tracking_number
    FROM wms.outbound_shipments
    WHERE order_id = ${wmsOrderId}
    ORDER BY id
  `);
  const shipments: Array<{ id: number; status: string; tracking_number: string | null }> =
    shipmentResult?.rows ?? [];

  if (shipments.length === 0) {
    console.warn(
      `${LOG_PREFIX} WMS order ${wmsOrderId} has no shipment rows — marking order directly`,
    );
    await db.execute(sql`
      UPDATE wms.orders SET
        warehouse_status = CASE
          WHEN warehouse_status NOT IN ('shipped', 'cancelled') THEN 'shipped'
          ELSE warehouse_status
        END,
        updated_at = NOW()
      WHERE id = ${wmsOrderId}
    `);
    return { processed: true, shipmentsMarked: 0 };
  }

  const event: ShipmentEvent = {
    kind: "shipped",
    trackingNumber: input.trackingNumber,
    carrier: input.carrier,
    shipDate: now,
    trackingUrl: input.trackingUrl ?? null,
  };

  let marked = 0;
  for (const shipment of shipments) {
    if (shipment.status === "shipped" && shipment.tracking_number === input.trackingNumber) {
      continue;
    }
    if (shipment.status === "cancelled" || shipment.status === "voided") {
      continue;
    }

    try {
      const fulfillmentPush = (db as any).__fulfillmentPush;
      const { changed } = await dispatchShipmentEvent(db, shipment.id, event, {
        now,
        fulfillmentPush,
      });
      if (changed) marked++;
    } catch (err: any) {
      console.error(
        `${LOG_PREFIX} Failed to mark shipment ${shipment.id} shipped: ${err.message}`,
      );
    }
  }

  const rollup = await recomputeOrderStatusFromShipments(db, wmsOrderId);
  console.log(
    `${LOG_PREFIX} WMS order ${wmsOrderId} rollup → ${rollup.warehouseStatus} (marked=${marked}, source=${input.source})`,
  );

  const omsOrderId = await resolveOmsOrderId(db, wmsOrderId);
  if (omsOrderId !== null) {
    await updateOmsFromRollup(db, omsOrderId, wmsOrderId, event, rollup.warehouseStatus);

    await db.insert(omsOrderEvents).values({
      orderId: omsOrderId,
      eventType: "shipped",
      details: {
        source: input.source,
        trackingNumber: input.trackingNumber,
        carrier: input.carrier,
        fulfillmentId: input.sourceFulfillmentId ?? null,
        wmsOrderId,
        shipmentsMarked: marked,
      },
    });
  }

  return { processed: true, shipmentsMarked: marked };
}

async function resolveOmsOrderId(db: any, wmsOrderId: number): Promise<number | null> {
  const result: any = await db.execute(sql`
    SELECT oms_fulfillment_order_id
    FROM wms.orders
    WHERE id = ${wmsOrderId}
    LIMIT 1
  `);
  const raw = result?.rows?.[0]?.oms_fulfillment_order_id;
  if (!raw) return null;
  const id = parseInt(String(raw), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function updateOmsFromRollup(
  db: any,
  omsOrderId: number,
  wmsOrderId: number,
  event: ShipmentEvent & { kind: "shipped" },
  warehouseStatus: string,
): Promise<void> {
  const derivedStatus = deriveOmsFromWms(warehouseStatus as any) ?? "shipped";
  const fulfillmentStatus =
    derivedStatus === "partially_shipped" ? "partial" : "fulfilled";

  await db
    .update(omsOrders)
    .set({
      status: derivedStatus,
      fulfillmentStatus,
      trackingNumber: event.trackingNumber,
      trackingCarrier: event.carrier,
      shippedAt: event.shipDate,
      updatedAt: new Date(),
    })
    .where(eq(omsOrders.id, omsOrderId));

  await db.execute(sql`
    WITH shipped_by_line AS (
      SELECT
        wi.oms_order_line_id,
        SUM(COALESCE(si.qty, 0))::int AS shipped_qty
      FROM wms.outbound_shipment_items si
      JOIN wms.outbound_shipments os ON os.id = si.shipment_id
      JOIN wms.order_items wi ON wi.id = si.order_item_id
      WHERE os.order_id = ${wmsOrderId}
        AND os.status = 'shipped'
      GROUP BY wi.oms_order_line_id
    )
    UPDATE oms.oms_order_lines ol
    SET fulfillment_status = CASE
          WHEN COALESCE(sbl.shipped_qty, 0) >= ol.quantity THEN 'fulfilled'
          WHEN COALESCE(sbl.shipped_qty, 0) > 0 THEN 'partial'
          ELSE ol.fulfillment_status
        END,
        updated_at = NOW()
    FROM (SELECT id, quantity FROM oms.oms_order_lines WHERE order_id = ${omsOrderId}) AS ol_src
    LEFT JOIN shipped_by_line sbl ON sbl.oms_order_line_id = ol_src.id
    WHERE ol.id = ol_src.id
      AND ol.fulfillment_status IS DISTINCT FROM CASE
          WHEN COALESCE(sbl.shipped_qty, 0) >= ol_src.quantity THEN 'fulfilled'
          WHEN COALESCE(sbl.shipped_qty, 0) > 0 THEN 'partial'
          ELSE ol.fulfillment_status
        END
  `);
}
