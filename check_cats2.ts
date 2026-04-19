import { db } from "./server/db/index";
import { sql } from "drizzle-orm";

async function run() {
  try {
    const cats = await db.execute(sql`SELECT DISTINCT category FROM catalog.products WHERE is_active = true`);
    console.log("Categories in DB:", cats.rows);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

run();
