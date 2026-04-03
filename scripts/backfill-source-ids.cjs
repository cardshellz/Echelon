require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const checknulls = await pool.query(`SELECT COUNT(*) FROM wms.orders WHERE source_table_id IS NULL AND order_number IS NOT NULL`);
    console.log("Missing source_table_id in WMS:", checknulls.rows[0].count);

    // Update statement using correct oms payload and order_number mappings
    const res = await pool.query(`
      UPDATE wms.orders w
      SET source_table_id = CAST(o.id AS varchar),
          source = 'shopify'
      FROM oms.oms_orders o
      WHERE w.order_number = o.external_order_number
        AND w.source_table_id IS NULL;
    `);

    console.log("Updated rows:", res.rowCount);
    
    // Check missing again
    const checknulls2 = await pool.query(`SELECT COUNT(*) FROM wms.orders WHERE source_table_id IS NULL AND order_number IS NOT NULL`);
    console.log("Missing source_table_id after update:", checknulls2.rows[0].count);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
