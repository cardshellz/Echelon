import { db } from "./server/db/index.js";
import { sql } from "drizzle-orm";

async function run() {
  const result = await db.execute(sql`SELECT DISTINCT category AS value FROM catalog.products WHERE is_active = true AND category IS NOT NULL LIMIT 2`);
  console.log("Keys:", Object.keys(result));
  console.log("Result:", result);
  process.exit(0);
}

run();
