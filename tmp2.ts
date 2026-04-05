import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  const shopifyOrderId = "gid://shopify/Order/12008564818079";
  
  try {
    const rawOrderResult = await db.execute(sql`
      SELECT shop_domain FROM shopify_orders WHERE id = ${shopifyOrderId}
    `);
    console.log(rawOrderResult.rows);
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
