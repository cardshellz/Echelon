import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await db.execute(sql`SELECT json_payload FROM shopify_orders ORDER BY created_at DESC LIMIT 5`);
    const fs = require('fs');
    fs.writeFileSync('insp-direct.json', JSON.stringify(res.rows, null, 2));
    console.log("Written to insp-direct.json");
  } catch (e) {
  }
  process.exit(0);
}
run();
