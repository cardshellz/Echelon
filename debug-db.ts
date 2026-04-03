import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  const res = await db.execute(sql`SELECT id, name, provider, shop_domain, access_token FROM channel_connections`);
  console.log("Connects:", res.rows);
  process.exit(0);
}
run();
