require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const r1 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='wms' AND table_name='order_items'");
    const r2 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items'");
    console.log('WMS:', r1.rows.map(r=>r.column_name).join(', '));
    console.log('PUB:', r2.rows.map(r=>r.column_name).join(', '));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
