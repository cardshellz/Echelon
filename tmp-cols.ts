import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  const q1 = await db.execute(sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'shopify_orders'`);
  console.log("shopify_orders:", JSON.stringify(q1.rows, null, 2));
  const q2 = await db.execute(sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'shopify_order_items'`);
  console.log("shopify_order_items:", JSON.stringify(q2.rows, null, 2));
  process.exit(0);
}
run();
