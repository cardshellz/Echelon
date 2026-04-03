require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const ordersRes = await pool.query("SELECT id, order_number, warehouse_status FROM wms.orders ORDER BY id DESC LIMIT 5");
    console.log("WMS Orders:");
    console.table(ordersRes.rows);

    const pubRes = await pool.query("SELECT id, order_number, warehouse_status FROM public.orders ORDER BY id DESC LIMIT 5");
    console.log("PUB Orders:");
    console.table(pubRes.rows);

    const wmsReady = await pool.query("SELECT COUNT(*) as c FROM wms.orders WHERE warehouse_status IN ('ready', 'in_progress')");
    console.log("wms.orders ready count:", wmsReady.rows[0].c);

    const imgRes = await pool.query(`
      SELECT pv.sku, COALESCE(pva.url, pa.url) as image_url 
      FROM catalog.product_variants pv 
      LEFT JOIN catalog.product_assets pva ON pva.product_variant_id = pv.id AND pva.is_primary = 1 
      LEFT JOIN catalog.product_assets pa ON pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 
      WHERE UPPER(pv.sku) IN ('GLV-GRD-PSA-P50', 'EG-SLV-STD-P100')
    `);
    console.log("Images:", imgRes.rows);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
