import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const counts = await db.execute(sql`
      SELECT 
        (SELECT count(*) FROM product_assets) as assets_count,
        (SELECT count(*) FROM channel_listings) as listings_count,
        (SELECT count(*) FROM products) as products_count,
        (SELECT count(*) FROM product_variants) as variants_count
    `);
    console.log("DB Counts:", counts.rows[0]);
  } catch (e) {
    console.error("DEBUG ERROR", e);
  }
  process.exit(0);
}
run();
