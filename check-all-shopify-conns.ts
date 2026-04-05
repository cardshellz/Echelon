import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const conns = await db.execute(sql`SELECT * FROM channel_connections JOIN channels ON channel_connections.channel_id = channels.id WHERE channels.provider = 'shopify'`);
    console.log(`Found ${conns.rows.length} Shopify connections.`);
    for (const c of conns.rows) {
      console.log(`ID: ${c.channel_id}, Domain: ${c.shop_domain}, Token: ${c.access_token}, Active: ${c.status}`);
    }
  } catch (e) {
    console.error("DEBUG ERROR", e);
  }
  process.exit(0);
}
run();
