import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  try {
    const res = await db.execute(sql`SELECT name, tier, billing_interval, price_cents FROM membership.plans`);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
