import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  const result = await db.execute(sql`
    SELECT 
      id, 
      sku,
      total_discount_cents, 
      plan_discount_cents, 
      coupon_discount_cents,
      discount_allocations
    FROM oms_order_lines 
    WHERE total_discount_cents > 0 
    LIMIT 2
  `);
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit(0);
}
run().catch(console.error);
