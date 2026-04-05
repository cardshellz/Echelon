require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT pa.id, pv.sku, pa.url, pa.is_primary, pa.asset_type
      FROM catalog.product_variants pv
      JOIN catalog.product_assets pa ON pa.product_variant_id = pv.id OR (pa.product_id = pv.product_id AND pa.product_variant_id IS NULL)
      WHERE UPPER(pv.sku) = 'EG-SLV-STD-P100'
      ORDER BY pa.id ASC
    `);
    res.rows.forEach(r => {
      console.log("ID: " + r.id + " | Primary: " + r.is_primary + " | URL: " + r.url);
    });
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
