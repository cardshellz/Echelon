require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT UPPER(sku) as sku, image_url FROM (
        SELECT pl.sku, pl.image_url FROM product_locations pl
        WHERE UPPER(pl.sku) IN ('SHLZ-SLV-TM-P100', 'SHLZ-TOP-100PT-P20', 'SHLZ-TOP-75PT-P25', 'SHLZ-TOP-55PT-BLU-P25', 'SHLZ-TOP-35PT-CLR-P25', 'ARM-ENV-SGL-P50') AND pl.image_url IS NOT NULL
        UNION ALL
        SELECT pv.sku, COALESCE(pva.url, pa.url) as image_url
        FROM catalog.product_variants pv
        LEFT JOIN catalog.product_assets pva ON pva.product_variant_id = pv.id AND pva.is_primary = 1
        LEFT JOIN catalog.product_assets pa ON pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1
        WHERE UPPER(pv.sku) IN ('SHLZ-SLV-TM-P100', 'SHLZ-TOP-100PT-P20', 'SHLZ-TOP-75PT-P25', 'SHLZ-TOP-55PT-BLU-P25', 'SHLZ-TOP-35PT-CLR-P25', 'ARM-ENV-SGL-P50')
          AND COALESCE(pva.url, pa.url) IS NOT NULL
      ) sub
    `);
    console.log(JSON.stringify(res.rows, null, 2));

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
