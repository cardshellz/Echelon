import "dotenv/config";
import { db, sql } from "./server/storage/base";
async function run() {
  try {
    await db.execute(sql`ALTER TABLE membership.plans DROP COLUMN IF EXISTS price CASCADE`);
    console.log('Drop price column successful!');
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
run();
