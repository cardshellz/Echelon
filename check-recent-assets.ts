import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const assets = await db.execute(sql`SELECT id, product_id, url FROM product_assets ORDER BY id DESC LIMIT 5`);
    console.log("Recent assets:", assets.rows);
  } catch (e) {
    console.error("DEBUG ERROR", e);
  }
  process.exit(0);
}
run();
