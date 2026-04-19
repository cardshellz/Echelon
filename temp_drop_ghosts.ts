import "dotenv/config";
import pkg from "pg";
const pool = new pkg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TABLES_TO_DROP = [
  "ebay_category_aspects",
  "ebay_category_mappings",
  "ebay_listing_rules",
  "ebay_product_aspect_overrides",
  "ebay_type_aspect_defaults",
  "dropship_vendor_products",
  "dropship_vendors",
  "dropship_wallet_ledger",
  "oms_order_events",
  "oms_order_lines",
  "oms_orders",
  "combined_order_groups"
];

async function executeDrops() {
  const c = await pool.connect();
  try {
    for (const table of TABLES_TO_DROP) {
      console.log(`Dropping public.${table}...`);
      await c.query(`DROP TABLE IF EXISTS public.${table} CASCADE;`);
    }
    console.log("Successfully dropped all ghost tables from public schema.");
  } catch(e) {
    console.error('Error', e.message);
  } finally {
    c.release();
    pool.end();
  }
}
executeDrops();
