import { db } from "../../../server/db";
import { sql } from "drizzle-orm";

/**
 * Sweeps the ShipStation awaiting_shipment queue to aggressively clear out
 * any stranded duplicates or zombie orders that Echelon already shipped.
 */
export async function sweepShipStationQueue(apiKey: string, apiSecret: string) {
  const baseUrl = "https://ssapi.shipstation.com";
  const encodedAuth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");

  console.log("[ShipStation Sweeper] Fetching all awaiting_shipment orders...");
  
  let page = 1;
  const pageSize = 100;
  let totalCleared = 0;
  
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

      // 1. If the order is fully shipped/cancelled in Echelon, ALL SS copies are garbage.
      // 2. If the order is NOT shipped (ready_to_ship), we should only have ONE SS copy.
      //    If there are duplicates, we keep the wms one (`echelon-wms-shp-`) and nuke the oms one.
      
      let toClear = [];
      if (isShippedOrCancelled) {
        toClear = orders; // Clear everything
      } else if (orders.length > 1) {
        // Sort to find the 'best' one to keep. The 'echelon-wms-shp-' key is preferred.
        // If neither have it, just keep the first one.
        const wmsOrder = orders.find(o => o.orderKey?.startsWith("echelon-wms-shp-"));
        if (wmsOrder) {
          toClear = orders.filter(o => o.orderId !== wmsOrder.orderId);
        } else {
          // If no wms order, just keep the latest order ID
          orders.sort((a, b) => b.orderId - a.orderId);
          toClear = orders.slice(1);
        }
      }

      for (const o of toClear) {
        console.log(`[ShipStation Sweeper] DELETING mismatch/duplicate SS Order ${o.orderId} (${o.orderNumber})`);
        const mRes = await fetch(`${baseUrl}/orders/${o.orderId}`, {
          method: "DELETE",
          headers: {
            "Authorization": `Basic ${encodedAuth}`
          }
        });

        if (mRes.ok) {
          totalCleared++;
        } else {
          console.warn(`[ShipStation Sweeper] Failed to delete SS Order ${o.orderId}:`, await mRes.text());
        }
      }
    }
    
    if (data.page >= data.pages) break;
    page++;
  }

  if (totalCleared > 0) {
    console.log(`[ShipStation Sweeper] Done. Cleared ${totalCleared} straggler/duplicate orders from SS queue.`);
  }
}
