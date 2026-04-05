import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  const res = await db.execute(sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'channel_connections'
  `);
  console.log(res.rows);
  process.exit(0);
}
run();
