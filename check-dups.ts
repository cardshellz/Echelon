import { pool } from "./server/db";

async function run() {
  const r = await pool.query(`
    SELECT vendor_id, invoice_number, COUNT(*) 
    FROM vendor_invoices 
    GROUP BY 1, 2 
    HAVING COUNT(*) > 1
  `);
  console.log("DUPLICATES:", r.rows);
  process.exit(0);
}

run().catch(console.error);
