import "dotenv/config";
import { db } from "./server/db.js";
import { sql } from "drizzle-orm";
import { createOmsService } from "./server/modules/oms/oms.service.js";
import { bridgeShopifyOrderToOms } from "./server/modules/oms/shopify-bridge.js";

async function run() {
  const omsService = createOmsService(db);
  const r = await db.execute(sql`
    SELECT id, shop_domain FROM shopify_orders 
    WHERE discount_codes IS NOT NULL
    LIMIT 1
  `);
  if (!r.rows[0]) {
    console.log("No CA orders found");
    process.exit(0);
  }
  const orderId = String(r.rows[0].id);
  console.log("Testing bridge for order:", orderId, r.rows[0].shop_domain);
  await bridgeShopifyOrderToOms(db, omsService, orderId);
  console.log("Success! Checking oms_orders...");
  const oms = await db.execute(sql`SELECT external_order_id, channel_id, total_cents FROM oms_orders WHERE external_order_id = ${orderId}`);
  console.log(oms.rows[0]);
  process.exit(0);
}
run();
