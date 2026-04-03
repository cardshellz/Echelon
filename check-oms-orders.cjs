require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT o.id, o.external_order_id, o.shipstation_order_id, o.status, e.event_type, e.details
      FROM oms_orders o
      LEFT JOIN oms_order_events e ON e.order_id = o.id
      WHERE o.id IN (34, 35, 36, 37, 38, 39, 40)
      ORDER BY o.id ASC, e.id ASC
    `);
    console.log(JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
