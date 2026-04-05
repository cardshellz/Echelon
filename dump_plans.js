import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const result = await pool.query('SELECT name, shopify_product_id, shopify_variant_id FROM membership.plans');
  fs.writeFileSync('c:/Users/owner/Echelon/plans_dump.json', JSON.stringify(result.rows, null, 2));
  process.exit(0);
}
run();
