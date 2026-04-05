require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    const r = await pool.query(
      `UPDATE inventory_levels 
       SET reserved_qty = 0 
       WHERE product_variant_id IN (
         SELECT id FROM product_variants WHERE sku IN ('SHLZ-SEMI-OVR-B200', 'SHLZ-SEMI-OVR-C2000')
       )`
    );
    console.log(`Cleared legacy reservations for ${r.rowCount} bins`);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
