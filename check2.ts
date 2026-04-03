import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  try {
    const res = await db.execute(sql`SELECT COUNT(*) as count FROM oms_order_lines WHERE total_discount_cents > 0`);
    console.log("Discount Rows:", res.rows[0]);
    
    // Also check oms_orders for ANY non-zero discounts
    const resOrders = await db.execute(sql`SELECT COUNT(*) as count FROM oms_orders WHERE discount_cents > 0`);
    console.log("Order level discount Rows:", resOrders.rows[0]);
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
