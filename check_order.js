import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const oResult = await pool.query("SELECT id, legacy_order_id, member_id, shopify_customer_id FROM shopify_orders WHERE order_number = '55521' OR legacy_order_id = '55521'");
  
  console.log("ORDER:", oResult.rows);
  
  if (oResult.rows.length > 0) {
    const orderId = oResult.rows[0].id;
    const iResult = await pool.query("SELECT title, sku, shopify_product_id, shopify_variant_id FROM shopify_order_items WHERE order_id = $1", [orderId]);
    console.table(iResult.rows);
  } else {
    console.log("No order found with number 55521 in Postgres!");
  }
  process.exit(0);
}
run();
