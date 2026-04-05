require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT p.sku, pa.id, pa.url, pa.is_primary, pa.asset_type, pa.product_variant_id
      FROM catalog.products p
      JOIN catalog.product_assets pa ON pa.product_id = p.id
      WHERE p.sku = 'ARM-ENV-SGL'
      ORDER BY pa.id ASC
    `);
    
    res.rows.forEach(r => {
      console.log("ID: " + r.id + " | Primary: " + r.is_primary + " | Variant: " + r.product_variant_id + " | URL: " + (r.url ? "exists" : "null"));
    });

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
