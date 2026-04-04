import * as schema from './shared/schema/index';
import { db } from './server/db';
import { sql } from 'drizzle-orm';

async function run() {
  const result = await db.execute(sql.raw('SELECT id, name, shopify_product_id, shopify_variant_id FROM membership.plans'));
  console.table(result.rows);
  process.exit(0);
}
run();
