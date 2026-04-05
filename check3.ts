import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  const res = await db.execute(sql`SELECT COUNT(*) FROM channel_connections`);
  console.log("Channel connections: ", res.rows);
  const shopifyRow = await db.execute(sql`SELECT shop_domain FROM shopify_orders LIMIT 1`);
  console.log("First shopify order domain: ", shopifyRow.rows);
  process.exit(0);
}
run();
