import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await db.execute(sql`SELECT count(*) FROM product_assets`);
    console.log("Total product assets in DB:", res.rows[0].count);
    
    const sample = await db.execute(sql`SELECT * FROM product_assets LIMIT 5`);
    console.log("Sample assets:", sample.rows);
  } catch (e) {
    console.error("DEBUG ERROR", e);
  }
  process.exit(0);
}
run();
