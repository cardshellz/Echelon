require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT pv.sku, COALESCE(pva.url, pa.url) as image_url 
      FROM public.product_variants pv 
      LEFT JOIN public.product_assets pva ON pva.product_variant_id = pv.id AND pva.is_primary = 1 
      LEFT JOIN public.product_assets pa ON pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 
      WHERE UPPER(pv.sku) IN ('GLV-GRD-PSA-P50', 'EG-SLV-STD-P100')
    `);
    console.log(res.rows);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
run();
