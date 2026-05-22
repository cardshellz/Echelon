import { db } from "../../../server/db";
import { sql } from "drizzle-orm";

async function cancelShipStationAwaitingOrder(
  baseUrl: string,
  encodedAuth: string,
  order: any,
): Promise<void> {
  const res = await fetch(`${baseUrl}/orders/createorder`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${encodedAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...order,
      orderStatus: "cancelled",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ShipStation cancel failed (${res.status}): ${body}`);
  }
}

/**
 * Sweeps the ShipStation awaiting_shipment queue and handles duplicate or
 * stale Echelon-owned orders.
 *
 * Final Echelon orders (shipped/cancelled) must not remain live in
 * ShipStation. For those, the sweeper actively cancels the awaiting SS
 * copy and mirrors the WMS shipment to cancelled when it is still pre-label.
 * Non-final duplicate cleanup remains review-only because those can still be
 * legitimate operator-created recovery orders.
 */
export async function sweepShipStationQueue(apiKey: string, apiSecret: string) {
  const baseUrl = "https://ssapi.shipstation.com";
  const encodedAuth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  console.log("[ShipStation Sweeper] Fetching all awaiting_shipment orders...");
  
  let page = 1;
  const pageSize = 100;
  let totalFlagged = 0;
  let totalCancelled = 0;
  
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
      //    Echelon-owned awaiting_shipment copy is stale and must be
      //    cancelled in ShipStation so it cannot ship later.
      // 2. If the order is not shipped and multiple Echelon-owned copies
      //    exist, flag the older OMS-level duplicates for review. Do not
      //    touch manual/user-created ShipStation orders.
      
      let toReview: any[] = [];
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

        if (isShippedOrCancelled) {
          try {
            await cancelShipStationAwaitingOrder(baseUrl, encodedAuth, o);
            totalCancelled++;

            console.warn(
              `[ShipStation Sweeper] Cancelled stale SS awaiting order ${o.orderId} (${o.orderNumber}, key=${orderKey})`,
            );

            if (wmsMatch) {
              const shipmentId = Number(wmsMatch[1]);
              await db.execute(sql`
                UPDATE wms.outbound_shipments
                SET status = CASE
                      WHEN status IN ('planned', 'queued', 'on_hold') THEN 'cancelled'
                      ELSE status
                    END,
                    cancelled_at = CASE
                      WHEN status IN ('planned', 'queued', 'on_hold') THEN NOW()
                      ELSE cancelled_at
                    END,
                    requires_review = CASE
                      WHEN status IN ('planned', 'queued', 'on_hold') THEN false
                      ELSE requires_review
                    END,
                    review_reason = CASE
                      WHEN status IN ('planned', 'queued', 'on_hold') THEN NULL
                      ELSE review_reason
                    END,
                    updated_at = NOW()
                WHERE id = ${shipmentId}
              `);
              continue;
            }

            if (omsMatch) {
              const omsOrderId = Number(omsMatch[1]);
              await db.execute(sql`
                INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
                VALUES (
                  ${omsOrderId},
                  'shipstation_stale_queue_order_cancelled',
                  ${JSON.stringify(details)}::jsonb,
                  NOW()
                )
              `);
              continue;
            }
          } catch (err: any) {
            console.error(
              `[ShipStation Sweeper] Failed to cancel stale SS order ${o.orderId} (${o.orderNumber}, key=${orderKey}): ${err?.message ?? err}`,
            );
            details.reason = "stale_shipstation_cancel_failed";
          }
        }

        if (wmsMatch) {
          const shipmentId = Number(wmsMatch[1]);
          await db.execute(sql`
            UPDATE wms.outbound_shipments
            SET requires_review = true,
                review_reason = ${isShippedOrCancelled ? "shipstation_cancel_failed" : "shipstation_queue_review"},
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

  if (totalFlagged > 0 || totalCancelled > 0) {
    console.log(
      `[ShipStation Sweeper] Done. Cancelled ${totalCancelled} stale order(s); flagged ${totalFlagged} straggler/duplicate order(s) for review.`,
    );
  }
}
