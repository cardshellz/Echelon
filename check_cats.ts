import { pool } from "./server/db/pool";

async function run() {
  const res = await pool.query(`SELECT DISTINCT category FROM catalog.products WHERE is_active = true AND category IS NOT NULL AND category != '' LIMIT 10`);
  console.log("Categories:", res.rows);
  const types = await pool.query(`SELECT DISTINCT product_type FROM catalog.products LIMIT 5`);
  console.log("Product Types:", types.rows);
  process.exit(0);
}

run();
