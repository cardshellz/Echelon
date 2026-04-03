import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  await db.execute(sql`ALTER TABLE shopify_orders ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN DEFAULT false;`);
  console.log("Migration applied.");
  process.exit(0);
}
run();
