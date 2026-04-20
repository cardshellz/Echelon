import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

/**
 * P1-18 Backfill Script: Fix dangling completed order items.
 * 
 * Execution:
 * npx tsx scripts/backfill/fix-dangling-order-items.ts
 */
async function runBackfill() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL environment variable is required.");
    process.exit(1);
  }

  console.log("Connecting to database...");
  const pool = new pg.Pool({ connectionString: dbUrl });
  const db = drizzle(pool);

  try {
    console.log("Running backfill for dangling 0/x completed line items...");
    
    // Extracted from original server/index.ts boot sequence
    const fixRes = await db.execute(
      sql`UPDATE wms.order_items SET picked_quantity = quantity, fulfilled_quantity = quantity WHERE status = 'completed' AND quantity > 0 AND picked_quantity = 0`
    );
    
    if ((fixRes as any).rowCount > 0) {
      console.log(`[Success] Fixed ${(fixRes as any).rowCount} dangling 0/x completed line items.`);
    } else {
      console.log("[Notice] No dangling order items found. Script executed successfully.");
    }
  } catch (error: any) {
    console.error("[Error] Backfill failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runBackfill().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
