require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT oi.sku, COALESCE(pva.url, pa.url) as url 
      FROM wms.order_items oi 
      JOIN wms.orders o ON oi.order_id = o.id 
      LEFT JOIN catalog.product_variants pv ON UPPER(pv.sku) = UPPER(oi.sku) 
      LEFT JOIN catalog.product_assets pva ON pva.product_variant_id = pv.id AND pva.is_primary = 1 
      LEFT JOIN catalog.product_assets pa ON pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 
      WHERE o.order_number = '#55553'
    `);
    console.log(JSON.stringify(res.rows, null, 2));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
