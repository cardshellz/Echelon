require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT o.order_number, e.event_type, e.details, e.created_at
      FROM wms.orders o
      LEFT JOIN oms_orders oms ON oms.id::text = o.source_table_id AND o.source = 'oms'
      LEFT JOIN oms_order_events e ON e.order_id = oms.id
      WHERE o.order_number IN ('#55554', '#55555', '#55558', '#55566')
      ORDER BY e.id ASC
    `);
    console.log(JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
