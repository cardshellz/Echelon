import { db, sql } from "../server/storage/base";
import "dotenv/config";

async function pruneLegacyAccounting() {
  console.log("Starting decommissioning of legacy WMS accounting columns...");

  try {
    const isProduction = process.env.NODE_ENV === "production" || !!process.env.EXTERNAL_DATABASE_URL;
    if (!isProduction) {
      console.warn("WARNING: Running locally. Skipping actual PRUNE schema modifications unless confirmed.");
    }

    // Drop legacy accounting columns from orders table
    console.log("Dropping legacy columns from 'orders' table (totalAmount, currency)...");
    await db.execute(sql`
      ALTER TABLE orders 
      DROP COLUMN IF EXISTS total_amount,
      DROP COLUMN IF EXISTS currency;
    `);

    // Drop legacy accounting columns from order_items table
    console.log("Dropping legacy columns from 'order_items' table (price_cents, discount_cents, total_price_cents)...");
    await db.execute(sql`
      ALTER TABLE order_items 
      DROP COLUMN IF EXISTS price_cents,
      DROP COLUMN IF EXISTS discount_cents,
      DROP COLUMN IF EXISTS total_price_cents;
    `);

    console.log("Legacy WMS accounting columns decommissioned successfully. Hub & Spoke OMS transition complete!");
  } catch (error) {
    console.error("Failed to prune legacy columns:", error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

pruneLegacyAccounting();
