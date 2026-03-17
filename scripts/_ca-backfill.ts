/**
 * Shopify-Canada catalog backfill
 * 1. Fetches products from CA store
 * 2. Updates channel_feeds with correct CA shopify variant/product IDs
 * 3. Adds channel_inventory_item_id column if missing
 * 4. Stores CA inventory_item_ids in channel_feeds
 */
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Ensure channel_inventory_item_id column exists
  await pool.query(`
    ALTER TABLE channel_feeds 
    ADD COLUMN IF NOT EXISTS channel_inventory_item_id TEXT
  `);
  console.log("✅ channel_inventory_item_id column ready");

  // Get CA store creds
  const connRes = await pool.query("SELECT * FROM channel_connections WHERE channel_id = 37");
  const conn = connRes.rows[0];
  if (!conn) throw new Error("No CA connection found");

  const domain = conn.shop_domain || "cardshellz-ca.myshopify.com";
  const token = conn.access_token;
  console.log(`CA store: ${domain}\n`);

  // Fetch all products from CA Shopify
  const resp = await fetch(`https://${domain}/admin/api/2024-01/products.json?limit=250`, {
    headers: { "X-Shopify-Access-Token": token },
  });
  if (!resp.ok) throw new Error(`Shopify API error: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  console.log(`Found ${data.products.length} products in CA store`);

  // Build SKU → CA Shopify mapping
  const caMap = new Map<string, { productId: string; variantId: string; inventoryItemId: string }>();
  for (const p of data.products) {
    for (const v of p.variants) {
      if (v.sku) {
        caMap.set(v.sku, {
          productId: String(p.id),
          variantId: String(v.id),
          inventoryItemId: String(v.inventory_item_id),
        });
        console.log(`  ${v.sku} → product=${p.id}, variant=${v.id}, inv_item=${v.inventory_item_id}`);
      }
    }
  }

  // Get existing CA channel_feeds
  const feedsRes = await pool.query(
    `SELECT cf.id, cf.channel_variant_id, cf.channel_product_id, cf.channel_sku, cf.product_variant_id, pv.sku
     FROM channel_feeds cf 
     JOIN product_variants pv ON pv.id = cf.product_variant_id 
     WHERE cf.channel_id = 37`
  );
  console.log(`\nCA channel_feeds: ${feedsRes.rows.length} entries`);

  let updated = 0;
  let notInCa = 0;

  for (const feed of feedsRes.rows) {
    const caData = caMap.get(feed.sku);
    if (!caData) {
      notInCa++;
      continue;
    }

    // Update channel_feeds with correct CA Shopify IDs
    await pool.query(
      `UPDATE channel_feeds 
       SET channel_product_id = $1, 
           channel_variant_id = $2, 
           channel_inventory_item_id = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [caData.productId, caData.variantId, caData.inventoryItemId, feed.id]
    );
    console.log(`  ✅ ${feed.sku}: product=${caData.productId}, variant=${caData.variantId}, inv_item=${caData.inventoryItemId}`);
    updated++;
  }

  // Also backfill US channel_feeds with inventory item IDs from product_variants
  console.log("\n--- Backfilling US channel_feeds inventory item IDs ---");
  const usRes = await pool.query(
    `UPDATE channel_feeds cf
     SET channel_inventory_item_id = pv.shopify_inventory_item_id
     FROM product_variants pv
     WHERE cf.product_variant_id = pv.id
       AND cf.channel_id = 36
       AND pv.shopify_inventory_item_id IS NOT NULL
       AND (cf.channel_inventory_item_id IS NULL OR cf.channel_inventory_item_id != pv.shopify_inventory_item_id)
     RETURNING cf.id`
  );
  console.log(`  US feeds updated: ${usRes.rows.length}`);

  console.log(`\n=== RESULTS ===`);
  console.log(`CA feeds updated with correct IDs: ${updated}`);
  console.log(`CA feeds - SKU not in CA store: ${notInCa} (expected)`);

  await pool.end();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
