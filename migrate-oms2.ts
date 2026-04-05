import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    console.log("Adding ALL missing columns to oms.oms_orders...");
    await db.execute(sql`
      ALTER TABLE oms.oms_orders 
        ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS shipping_method VARCHAR(200),
        ADD COLUMN IF NOT EXISTS shipping_method_code VARCHAR(100),
        ADD COLUMN IF NOT EXISTS tags TEXT,
        ADD COLUMN IF NOT EXISTS notes TEXT,
        ADD COLUMN IF NOT EXISTS raw_payload JSONB;
    `);

    console.log("Migration successful!");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    process.exit(0);
  }
}

run();
