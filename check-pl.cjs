require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT sku, image_url 
      FROM product_locations 
      WHERE sku IN ('SHLZ-SLV-TM-P100', 'SHLZ-TOP-100PT-P20', 'SHLZ-TOP-75PT-P25', 'SHLZ-TOP-55PT-BLU-P25', 'SHLZ-TOP-35PT-CLR-P25', 'ARM-ENV-SGL-P50')
    `);
    console.log(JSON.stringify(res.rows, null, 2));

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
