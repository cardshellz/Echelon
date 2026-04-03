require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT o.order_number, o.warehouse_status, oi.sku, oi.requires_shipping, o.id as oid, oi.order_id
      FROM wms.orders o
      LEFT JOIN wms.order_items oi ON oi.order_id = o.id
      WHERE o.order_number IN ('#55554', '#55555', '#55558', '#55566')
    `);
    console.log(JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
