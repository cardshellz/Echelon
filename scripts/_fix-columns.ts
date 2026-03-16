import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  
  const fixes = [
    `ALTER TABLE channel_feeds RENAME COLUMN variant_id TO product_variant_id`,
    `ALTER TABLE channel_listings RENAME COLUMN variant_id TO product_variant_id`,
    `ALTER TABLE channel_pricing RENAME COLUMN variant_id TO product_variant_id`,
    `ALTER TABLE channel_variant_overrides RENAME COLUMN variant_id TO product_variant_id`,
  ];
  
  for (const sql of fixes) {
    try {
      await pool.query(sql);
      console.log("✅", sql);
    } catch (err: any) {
      console.log("⚠️", sql, "→", err.message);
    }
  }
  
  await pool.end();
}
main();
