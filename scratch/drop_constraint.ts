import { db } from '../server/db';
import { sql } from 'drizzle-orm';
async function run() {
  try {
    await db.execute(sql`ALTER TABLE inventory_levels DROP CONSTRAINT IF EXISTS chk_reserved_lte_onhand`);
    console.log('Dropped constraint!');
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
