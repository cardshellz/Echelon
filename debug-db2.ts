import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  try {
    const res = await db.execute(sql`SELECT * FROM channel_connections LIMIT 1`);
    console.log(res.rows);
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
