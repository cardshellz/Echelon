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
      LEFT JOIN catalog.product_assets pa ON pa.product_variant_id = pv.id OR (pa.product_id = pv.product_id AND pa.product_variant_id IS NULL)
      WHERE UPPER(pv.sku) IN ('SHLZ-SLV-TM-P100', 'SHLZ-TOP-100PT-P20', 'SHLZ-TOP-75PT-P25', 'ARM-ENV-SGL-P50')
      ORDER BY pv.sku, pa.id ASC
    `);
    
    const rows = res.rows.map(r => r ? r.sku + " -> primary:" + r.is_primary + " url:" + String(r.url).substring(0, 40) + "..." : "null");
    console.log(rows.join("\\n"));

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
