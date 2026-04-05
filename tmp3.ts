import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";
import { bridgeShopifyOrderToOms } from "./server/modules/oms/shopify-bridge";
import { createOmsService } from "./server/modules/oms/oms.service";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'shopify_orders'`);
    console.log("shopify_orders columns:", res.rows.map((r: any) => r.column_name).join(", "));
    
    // Now call the bridge
    const omsService = createOmsService(db, null as any);
    await bridgeShopifyOrderToOms(db, omsService, "gid://shopify/Order/12008564818079");
  } catch (e) {
    console.error("DEBUG ERROR", e);
  }
  process.exit(0);
}
run();
