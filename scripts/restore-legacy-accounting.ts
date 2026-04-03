import { db, sql } from "../server/storage/base";
import "dotenv/config";

async function restore() {
  console.log("Restoring legacy DB columns...");
  try {
    await db.execute(sql`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10, 2);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'USD';
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS price_cents INTEGER;
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS discount_cents INTEGER;
      ALTER TABLE order_items ADD COLUMN IF NOT EXISTS total_price_cents INTEGER;
    `);
    console.log("Fixed DB");
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

restore();
