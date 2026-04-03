require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log("Fixing priority column type...");
    await pool.query(`ALTER TABLE wms.orders ALTER COLUMN priority TYPE integer USING priority::integer`);
    console.log("Fixed priority");
  } catch (err) {
    console.warn("Priority may already be an integer or failed:", err.message);
  }

  try {
    console.log("Fixing on_hold column type...");
    await pool.query(`ALTER TABLE wms.orders ALTER COLUMN on_hold TYPE integer USING on_hold::integer`);
    console.log("Fixed on_hold");
  } catch (err) {
    console.warn("on_hold may already be an integer or failed:", err.message);
  }
  
  try {
    console.log("Fixing requires_shipping column type...");
    await pool.query(`ALTER TABLE wms.order_items ALTER COLUMN requires_shipping TYPE integer USING requires_shipping::integer`);
    console.log("Fixed requires_shipping");
  } catch (err) {
    console.warn("requires_shipping may already be an integer or failed:", err.message);
  }

  console.log("Done database cast patches.");
  process.exit(0);
}

run();
