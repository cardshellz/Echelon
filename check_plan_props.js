import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const result = await pool.query('SELECT name, billing_interval, tier FROM membership.plans');
  console.log(JSON.stringify(result.rows, null, 2));
  process.exit(0);
}
run();
