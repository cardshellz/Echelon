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
      // Duplicate detection: if multiple echelon-owned copies exist for the
      // same order number and the order is NOT final, flag old OMS-level
      // duplicates for review.
      if (orders.length > 1) {
        const wmsOrder = orders.find((o: any) => o.orderKey?.startsWith("echelon-wms-shp-"));
        if (wmsOrder) {
          const dupes = orders.filter((o: any) => o.orderKey?.startsWith("echelon-oms-"));
          for (const o of dupes) {
            const orderKey = String(o.orderKey || "");
            const omsMatch = /^echelon-oms-([1-9][0-9]*)$/.exec(orderKey);
            if (omsMatch) {
              const omsOrderId = Number(omsMatch[1]);
              await db.execute(sql`
                INSERT INTO oms.oms_order_events (order_id, event_type, details, created_at)
                VALUES (
                  ${omsOrderId},
                  'shipstation_queue_review_required',
                  ${JSON.stringify({
                    shipStationOrderId: o.orderId ?? null,
                    shipStationOrderNumber: o.orderNumber ?? null,
                    orderKey,
                    queueStatus: o.orderStatus ?? "awaiting_shipment",
                    reason: "duplicate_echelon_shipstation_order",
                  })}::jsonb,
                  NOW()
                )
              `);
              totalFlagged++;
            }
          }
        }
      }

      // Per-order finality check: only cancel a ShipStation order when the
      // SPECIFIC linked shipment or OMS order is final — never based on a
      // loose order_number match that can hit the wrong WMS row.
      for (const o of orders) {
        const orderKey = String(o.orderKey || "");
        if (!orderKey.startsWith("echelon-oms-") && !orderKey.startsWith("echelon-wms-shp-")) {
          continue;
        }

        const wmsMatch = /^echelon-wms-shp-([1-9][0-9]*)$/.exec(orderKey);
        const omsMatch = /^echelon-oms-([1-9][0-9]*)$/.exec(orderKey);

        let isFinal = false;

        if (wmsMatch) {
          const shipmentId = Number(wmsMatch[1]);
          const shipmentQuery = await db.execute(sql`
            SELECT os.status AS shipment_status,
                   wo.warehouse_status
            FROM wms.outbound_shipments os
            JOIN wms.orders wo ON wo.id = os.order_id
            WHERE os.id = ${shipmentId}
            LIMIT 1
          `);
          const row = shipmentQuery.rows[0] as any;
          if (row) {
            isFinal = row.warehouse_status === 'shipped' || row.warehouse_status === 'cancelled';
          }
        } else if (omsMatch) {
          const omsOrderId = Number(omsMatch[1]);
          const omsQuery = await db.execute(sql`
            SELECT status, fulfillment_status FROM oms.oms_orders
            WHERE id = ${omsOrderId}
            LIMIT 1
          `);
          const row = omsQuery.rows[0] as any;
          if (row && (row.fulfillment_status === 'fulfilled' || row.status === 'cancelled' || row.status === 'shipped')) {
            isFinal = true;
          }
        }

        if (!isFinal) continue;

        const details = {
          shipStationOrderId: o.orderId ?? null,
          shipStationOrderNumber: o.orderNumber ?? null,
          orderKey,
          queueStatus: o.orderStatus ?? "awaiting_shipment",
          reason: "echelon_shipped_or_cancelled_but_shipstation_awaiting",
        };

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
          } else if (omsMatch) {
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
          }
        } catch (err: any) {
          console.error(
            `[ShipStation Sweeper] Failed to cancel stale SS order ${o.orderId} (${o.orderNumber}, key=${orderKey}): ${err?.message ?? err}`,
          );

          if (wmsMatch) {
            const shipmentId = Number(wmsMatch[1]);
            await db.execute(sql`
              UPDATE wms.outbound_shipments
              SET requires_review = true,
                  review_reason = 'shipstation_cancel_failed',
                  updated_at = NOW()
              WHERE id = ${shipmentId}
            `);
          }
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
