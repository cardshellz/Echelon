import { db } from './server/db.js';
import { sql } from 'drizzle-orm';

async function f() {
  const r = await db.execute(sql`
    SELECT order_id, quantity, paid_price_cents, total_price_cents, plan_discount_cents, coupon_discount_cents, discount_allocations FROM shopify_order_items 
    WHERE discount_allocations IS NOT NULL 
      AND jsonb_array_length(discount_allocations) > 0 
    LIMIT 1
  `);
  console.log("Item allocations:", JSON.stringify(r.rows[0], null, 2));

  // Let's also check if discount_codes in shopify_orders is populated
  const orderId = r.rows[0]?.order_id;
  if(orderId) {
    const o = await db.execute(sql`SELECT discount_codes FROM shopify_orders WHERE id = ${orderId}`);
    console.log("Order discount codes:", o.rows[0]?.discount_codes);
  }
  process.exit(0);
}
f();
