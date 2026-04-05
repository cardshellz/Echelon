import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    console.log("Adding ALL missing columns to wms.outbound_shipment_items...");
    await db.execute(sql`
      ALTER TABLE wms.outbound_shipment_items 
        ADD COLUMN IF NOT EXISTS box_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS weight_oz INTEGER,
        ADD COLUMN IF NOT EXISTS tracking_id VARCHAR(200);
    `);

    console.log("Migration successful!");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    process.exit(0);
  }
}

run();
