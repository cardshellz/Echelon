import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  try {
    console.log("Adding columns to oms.oms_orders...");
    await db.execute(sql`
      ALTER TABLE oms.oms_orders ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT false;
    `);

    console.log("Adding columns to oms.oms_order_lines...");
    await db.execute(sql`
      ALTER TABLE oms.oms_order_lines
        ADD COLUMN IF NOT EXISTS discount_allocations JSONB,
        ADD COLUMN IF NOT EXISTS taxable BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS tax_lines JSONB,
        ADD COLUMN IF NOT EXISTS requires_shipping BOOLEAN DEFAULT true,
        ADD COLUMN IF NOT EXISTS gift_card BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS fulfillable_quantity INTEGER,
        ADD COLUMN IF NOT EXISTS fulfillment_service VARCHAR(100),
        ADD COLUMN IF NOT EXISTS properties JSONB,
        ADD COLUMN IF NOT EXISTS compare_at_price_cents INTEGER;
    `);

    console.log("Migration successful!");
  } catch (error) {
    console.error("Migration failed:", error);
  } finally {
    process.exit(0);
  }
}

run();
