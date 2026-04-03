import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const feeds = await db.execute(sql`SELECT count(distinct channel_product_id) FROM channel_feeds WHERE channel_type = 'shopify'`);
    const listings = await db.execute(sql`SELECT count(distinct external_product_id) FROM channel_listings cl JOIN channels c ON cl.channel_id = c.id WHERE c.provider = 'shopify'`);
    console.log("Shopify Mappings:");
    console.log("channel_feeds:", feeds.rows[0]);
    console.log("channel_listings:", listings.rows[0]);
  } catch (e) {
    console.error("DEBUG ERROR", e);
  }
  process.exit(0);
}
run();
