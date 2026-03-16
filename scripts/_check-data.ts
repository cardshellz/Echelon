import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  const tables = [
    "channels", "channel_feeds", "channel_pricing", "channel_listings",
    "channel_allocation_rules", "channel_warehouse_assignments", 
    "channel_product_allocation", "channel_reservations",
    "products", "product_variants", "inventory_items", "inventory_levels",
    "source_lock_config", "catalog_products"
  ];
  
  for (const t of tables) {
    try {
      const res = await pool.query(`SELECT count(*) as cnt FROM "${t}"`);
      console.log(`${t}: ${res.rows[0].cnt} rows`);
    } catch (err: any) {
      console.log(`${t}: ERROR - ${err.message}`);
    }
  }
  
  // Show channels
  const ch = await pool.query("SELECT id, name, type, provider, status FROM channels ORDER BY id");
  console.log("\nChannels:");
  for (const r of ch.rows) console.log(`  ${r.id}: ${r.name} (${r.type}/${r.provider}) - ${r.status}`);
  
  await pool.end();
}
main();
