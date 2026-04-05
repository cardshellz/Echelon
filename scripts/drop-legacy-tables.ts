import * as dotenv from "dotenv";
dotenv.config();
process.env.PGSSLMODE = "require";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function run() {
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");

  console.log("Dropping redundant legacy logic tables from public schema...");

  const drops = [
    `DROP TABLE IF EXISTS public.order_items CASCADE;`,
    `DROP TABLE IF EXISTS public.orders CASCADE;`,
    `DROP TABLE IF EXISTS public.oms_order_events CASCADE;`,
    `DROP TABLE IF EXISTS public.oms_order_lines CASCADE;`,
    `DROP TABLE IF EXISTS public.oms_orders CASCADE;`,
  ];

  for (const query of drops) {
    try {
      console.log(`Executing: ${query}`);
      await db.execute(sql.raw(query));
      console.log("Success.");
    } catch (e: any) {
      console.error(`Failed: ${e.message}`);
    }
  }

  process.exit();
}

run();
