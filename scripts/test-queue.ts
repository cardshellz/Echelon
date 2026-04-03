import { db } from "../server/db";
import { sql } from "drizzle-orm";

async function run() {
  console.log("Testing getPickQueueOrders raw SQL...");
  try {
    const orderList = await db.execute(sql`
      SELECT o.*
      FROM wms.orders o
      LEFT JOIN echelon_settings s ON s.key = CONCAT('warehouse_', o.warehouse_id, '_fifo_mode')
      WHERE o.warehouse_status NOT IN ('shipped', 'ready_to_ship', 'cancelled')
        AND (
          o.warehouse_status IN ('ready', 'in_progress')
          OR (o.warehouse_status = 'completed' AND o.completed_at >= NOW() - INTERVAL '24 hours')
        )
      ORDER BY
        o.on_hold ASC, 
        CASE WHEN o.priority >= 9999 THEN 1 ELSE 0 END DESC,
        CASE WHEN s.value = 'true' THEN 0 ELSE o.priority END DESC,
        o.sla_due_at ASC NULLS LAST,
        COALESCE(o.order_placed_at, o.shopify_created_at, o.created_at) ASC
      LIMIT 10
    `);
    
    console.log(`Found ${orderList.rows.length} orders.`);
    
    if (orderList.rows.length === 0) {
      console.log("No orders found.");
      process.exit(0);
    }
    
    const ids = orderList.rows.map((r: any) => r.id);
    const idList = sql.join(ids.map((id: number) => sql`${id}`), sql`, `);
    
    const itemsResult = await db.execute(sql`
      SELECT * FROM wms.order_items 
      WHERE order_id IN (${idList})
    `);
    
    console.log(`Found ${itemsResult.rows.length} items for those orders.`);
    
    console.log("Perfect! No errors.");
    process.exit(0);
  } catch (err) {
    console.error("Queue query failed:", err);
    process.exit(1);
  }
}

run();
