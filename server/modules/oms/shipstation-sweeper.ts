import { db } from "../../../server/db";
import { sql } from "drizzle-orm";

/**
 * Sweeps the ShipStation awaiting_shipment queue and flags duplicate or
 * stale Echelon-owned orders for review.
 *
 * This deliberately does not delete ShipStation orders. Manual splits and
 * operator-created recovery orders are too easy to misclassify from a broad
 * queue sweep; deletion belongs behind an explicit operator action.
 */
export async function sweepShipStationQueue(apiKey: string, apiSecret: string) {
  const baseUrl = "https://ssapi.shipstation.com";
  const encodedAuth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  console.log("[ShipStation Sweeper] Fetching all awaiting_shipment orders...");
  
  let page = 1;
  const pageSize = 100;
  let totalFlagged = 0;
  
  while (true) {
    const res = await fetch(`${baseUrl}/orders?orderStatus=awaiting_shipment&pageSize=${pageSize}&page=${page}`, {
      method: "GET",
      headers: { "Authorization": `Basic ${encodedAuth}` }
    });
    
    if (!res.ok) {
      console.warn("[ShipStation Sweeper] Failed to fetch SS queue", await res.text());
      break;
    }

    const data = await res.json();
    const ssOrders = data.orders || [];
    
    if (ssOrders.length === 0) break;

    // Group by order number to detect duplicates
    const byOrderNumber = new Map<string, any[]>();
    for (const o of ssOrders) {
      let searchOrderNum = o.orderNumber;
      if (searchOrderNum.startsWith("EB-")) {
        searchOrderNum = searchOrderNum.replace("EB-", "");
      }
      if (!byOrderNumber.has(searchOrderNum)) byOrderNumber.set(searchOrderNum, []);
      byOrderNumber.get(searchOrderNum)!.push(o);
    }

    for (const [orderNumber, orders] of byOrderNumber.entries()) {
      const wmsQuery = await db.execute(sql`
        SELECT warehouse_status FROM wms.orders 
        WHERE order_number = ${orderNumber} 
           OR order_number = ${'#' + orderNumber}
        LIMIT 1
      `);
      const wmsStatus = wmsQuery.rows[0]?.warehouse_status;

      let isShippedOrCancelled = false;
      if (wmsStatus === 'shipped' || wmsStatus === 'cancelled') {
        isShippedOrCancelled = true;
      } else if (!wmsStatus) {
        const omsQuery = await db.execute(sql`
          SELECT fulfillment_status, status FROM oms.oms_orders
          WHERE external_order_id = ${orderNumber}
             OR external_order_id = ${'#' + orderNumber}
          LIMIT 1
        `);
        const row = omsQuery.rows[0] as any;
        if (row && (row.fulfillment_status === 'fulfilled' || row.status === 'cancelled')) {
          isShippedOrCancelled = true;
        }
      }

      // 1. If the order is fully shipped/cancelled in Echelon, any
      //    Echelon-owned awaiting_shipment copy is stale and needs review.
      // 2. If the order is not shipped and multiple Echelon-owned copies
      //    exist, flag the older OMS-level duplicates for review. Do not
      //    touch manual/user-created ShipStation orders.
      
      let toReview = [];
      if (isShippedOrCancelled) {
        toReview = orders.filter(o => o.orderKey?.startsWith("echelon-oms-") || o.orderKey?.startsWith("echelon-wms-shp-"));
      } else if (orders.length > 1) {
        // Find the wms order
        const wmsOrder = orders.find(o => o.orderKey?.startsWith("echelon-wms-shp-"));
        if (wmsOrder) {
          toReview = orders.filter(o => o.orderKey?.startsWith("echelon-oms-"));
        }
      }

      for (const o of toReview) {
        const orderKey = String(o.orderKey || "");
        const wmsMatch = /^echelon-wms-shp-([1-9][0-9]*)$/.exec(orderKey);
        const omsMatch = /^echelon-oms-([1-9][0-9]*)$/.exec(orderKey);
        const details = {
          shipStationOrderId: o.orderId ?? null,
          shipStationOrderNumber: o.orderNumber ?? null,
          orderKey,
          queueStatus: o.orderStatus ?? "awaiting_shipment",
          reason: isShippedOrCancelled
            ? "echelon_shipped_or_cancelled_but_shipstation_awaiting"
            : "duplicate_echelon_shipstation_order",
        };

        console.warn(
          `[ShipStation Sweeper] Flagging SS queue review for ${o.orderId} (${o.orderNumber}, key=${orderKey})`,
        );

        if (wmsMatch) {
          const shipmentId = Number(wmsMatch[1]);
          await db.execute(sql`
            UPDATE wms.outbound_shipments
            SET requires_review = true,
                review_reason = 'shipstation_queue_review',
                updated_at = NOW()
            WHERE id = ${shipmentId}
          `);
          totalFlagged++;
          continue;
        }

        if (omsMatch) {
          const omsOrderId = Number(omsMatch[1]);
          await db.execute(sql`
            INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
            VALUES (
              ${omsOrderId},
              'shipstation_queue_review_required',
              ${JSON.stringify(details)}::jsonb,
              NOW()
            )
          `);
          totalFlagged++;
        }
      }
    }
    
    if (data.page >= data.pages) break;
    page++;
  }

  if (totalFlagged > 0) {
    console.log(`[ShipStation Sweeper] Done. Flagged ${totalFlagged} straggler/duplicate orders for review.`);
  }
}
