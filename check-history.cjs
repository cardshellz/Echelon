require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT order_number, warehouse_status
      FROM public.orders 
      WHERE order_number IN ('#55554', '#55555', '#55558', '#55566')
      ORDER BY id ASC
    `);
    console.log(JSON.stringify(res.rows, null, 2));

    const res3 = await pool.query(`
      SELECT e.event_type, e.details, e.created_at
      FROM oms_order_events e
      JOIN oms_orders o ON o.id = e.order_id
      WHERE o.order_number IN ('#55554', '#55555')
      ORDER BY e.id ASC
    `);
    console.log("Events:\n", JSON.stringify(res3.rows, null, 2));

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
