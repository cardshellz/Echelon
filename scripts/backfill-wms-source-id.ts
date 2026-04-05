import * as dotenv from "dotenv";
dotenv.config();
process.env.PGSSLMODE = "require"; // Heroku DB requires SSL
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function run() {
  console.log("Starting backfill for wms.orders source_table_id...");
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");

  try {
    const result = await db.execute(sql`
      UPDATE wms.orders w
      SET source_table_id = CAST(o.id AS TEXT)
      FROM oms.oms_orders o
      WHERE w.order_number = o.external_order_number
        AND w.source_table_id IS NULL;
    `);
    console.log("Backfill completed successfully. Rows affected:", result.rowCount);
  } catch (error) {
    console.error("Backfill failed:", error);
  }
  process.exit(0);
}

run();
