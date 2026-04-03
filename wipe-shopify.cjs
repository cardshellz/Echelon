require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      UPDATE product_locations SET image_url = NULL WHERE image_url LIKE '%cdn.shopify.com%'
    `);
    console.log("Wiped cdn.shopify.com from product_locations:", res.rowCount);

    // Also just forcefully make sure NO order_items have it either (just in case they were synced over from legacy recently)
    const res2 = await pool.query(`
      UPDATE wms.order_items SET image_url = NULL WHERE image_url LIKE '%cdn.shopify.com%'
    `);
    console.log("Wiped cdn.shopify.com from wms.order_items:", res2.rowCount);

    const res3 = await pool.query(`
      UPDATE public.order_items SET image_url = NULL WHERE image_url LIKE '%cdn.shopify.com%'
    `);
    console.log("Wiped cdn.shopify.com from public.order_items:", res3.rowCount);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
