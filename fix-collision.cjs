require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    // 1. Advance the sequences safely so no future collisions happen
    await pool.query("SELECT setval('wms.orders_id_seq', (SELECT GREATEST(MAX(id) + 1000, 200000) FROM public.orders));");
    await pool.query("SELECT setval('wms.order_items_id_seq', (SELECT GREATEST(MAX(id) + 1000, 300000) FROM public.order_items));");

    // 2. Fix the corrupted ones natively
    const res = await pool.query(`
      UPDATE wms.orders 
      SET warehouse_status = 'ready'
      WHERE id BETWEEN 34 AND 41
      RETURNING order_number;
    `);
    
    console.log("Restored the following to Ready:", res.rows.map(r => r.order_number));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
