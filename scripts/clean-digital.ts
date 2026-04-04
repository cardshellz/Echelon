import * as dotenv from "dotenv";
dotenv.config();
process.env.PGSSLMODE = "require";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function checkOrders() {
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");
  try {
    const res = await db.execute(sql`
      SELECT o.id, o.order_number 
      FROM wms.orders o
      WHERE o.warehouse_status IN ('ready', 'in_progress')
      AND NOT EXISTS (
        SELECT 1 FROM wms.order_items i 
        WHERE i.order_id = o.id AND i.requires_shipping = 1
      )
    `);
    console.log(`Digital-only orders stuck in queue: ${res.rows.length}`);
    if (res.rows.length > 0) {
      const ids = res.rows.map((r: any) => r.id).join(",");
      console.log(`Clearing orders: ${ids}`);
      await db.execute(sql`
        UPDATE wms.orders
        SET warehouse_status = 'completed'
        WHERE id = ANY(ARRAY[${sql.raw(ids)}]::int[])
      `);
    }
  } catch (error) {
    console.error(error);
  }
  process.exit();
}

checkOrders();
