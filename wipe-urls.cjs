require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query("UPDATE wms.order_items SET image_url = NULL WHERE image_url LIKE '%cdn.shopify.com%'");
    console.log('Fixed', res.rowCount, 'broken shopify image links!');
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
