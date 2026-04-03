require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    // 1. Demote shopify assets from primary
    const r1 = await pool.query("UPDATE catalog.product_assets SET is_primary = 0 WHERE url LIKE '%cdn.shopify.com%' AND is_primary = 1");
    console.log("Demoted Shopify links:", r1.rowCount);

    // 2. Delete shopify links entirely
    const r2 = await pool.query("DELETE FROM catalog.product_assets WHERE url LIKE '%cdn.shopify.com%'");
    console.log("Deleted Shopify links:", r2.rowCount);

    // 3. Promote eBay product images to primary
    const r3 = await pool.query(`
      WITH first_assets AS (
        SELECT id,
               ROW_NUMBER() OVER(PARTITION BY product_id ORDER BY id ASC) as rn
        FROM catalog.product_assets
        WHERE product_variant_id IS NULL AND is_primary = 0
          AND product_id NOT IN (SELECT product_id FROM catalog.product_assets WHERE is_primary = 1 AND product_variant_id IS NULL AND product_id IS NOT NULL)
      )
      UPDATE catalog.product_assets pa
      SET is_primary = 1
      FROM first_assets fa
      WHERE pa.id = fa.id AND fa.rn = 1
    `);
    console.log("Promoted product assets:", r3.rowCount);

    // 4. Promote eBay variant images to primary
    const r4 = await pool.query(`
      WITH first_assets AS (
        SELECT id,
               ROW_NUMBER() OVER(PARTITION BY product_variant_id ORDER BY id ASC) as rn
        FROM catalog.product_assets
        WHERE product_variant_id IS NOT NULL AND is_primary = 0
          AND product_variant_id NOT IN (SELECT product_variant_id FROM catalog.product_assets WHERE is_primary = 1 AND product_variant_id IS NOT NULL)
      )
      UPDATE catalog.product_assets pa
      SET is_primary = 1
      FROM first_assets fa
      WHERE pa.id = fa.id AND fa.rn = 1
    `);
    console.log("Promoted variant assets:", r4.rowCount);

    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
}
run();
