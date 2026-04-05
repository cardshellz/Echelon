import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { channelConnections, channels } from "./shared/schema";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const conns = await db.execute(sql`SELECT * FROM channel_connections JOIN channels ON channel_connections.channel_id = channels.id WHERE channels.provider = 'shopify'`);
    console.log(conns.rows);
  } catch (e) {
    console.error("DEBUG ERROR", e);
  }
  process.exit(0);
}
run();
