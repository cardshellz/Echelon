/**
 * Push products with eBay images to Shopify.
 * 
 * Only pushes products that have eBay-sourced images (i.ebayimg.com URLs).
 * This restores images on Shopify that were lost during the bad sync.
 *
 * Usage:
 *   EXTERNAL_DATABASE_URL=... npx tsx scripts/push-ebay-images-to-shopify.ts [--dry-run]
 *
 * Requires: SHOPIFY_ACCESS_TOKEN, SHOPIFY_SHOP_DOMAIN env vars
 */

import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Set EXTERNAL_DATABASE_URL or DATABASE_URL");
  process.exit(1);
}

const SHOPIFY_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
  console.error("Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN");
  process.exit(1);
}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function shopifyApi(method: string, path: string, body?: any): Promise<any> {
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // Handle rate limiting
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get("Retry-After") || "2");
    console.log(`  Rate limited, waiting ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return shopifyApi(method, path, body);
  }

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Shopify ${method} ${path} (${res.status}): ${error}`);
  }

  return res.json();
}

async function main() {
  console.log(`[Push Images] Starting (dry_run: ${DRY_RUN})`);

  // Find products that have eBay images and a Shopify product ID
  const result = await pool.query(`
    SELECT DISTINCT
      p.id as product_id,
      p.title,
      p.shopify_product_id,
      ARRAY_AGG(pa.url ORDER BY pa.position) as image_urls,
      ARRAY_AGG(pa.position ORDER BY pa.position) as positions
    FROM products p
    JOIN product_assets pa ON pa.product_id = p.id
    WHERE pa.url LIKE '%i.ebayimg.com%'
      AND p.shopify_product_id IS NOT NULL
    GROUP BY p.id, p.title, p.shopify_product_id
  `);

  const products = result.rows;
  console.log(`[Push Images] Found ${products.length} products with eBay images to push\n`);

  let pushed = 0;
  let errors = 0;

  for (const product of products) {
    const { product_id, title, shopify_product_id, image_urls, positions } = product;

    try {
      // Build Shopify image objects
      const images = image_urls.map((url: string, i: number) => ({
        src: url,
        position: positions[i] + 1, // Shopify is 1-based
        alt: title,
      }));

      if (DRY_RUN) {
        console.log(`  [DRY] ${title}: would push ${images.length} images to Shopify product ${shopify_product_id}`);
        pushed++;
        continue;
      }

      // Update the Shopify product with images
      await shopifyApi("PUT", `products/${shopify_product_id}.json`, {
        product: {
          id: shopify_product_id,
          images,
        },
      });

      console.log(`  [OK] ${title}: pushed ${images.length} images to Shopify`);
      pushed++;

      // Rate limit: Shopify allows ~2 requests/second
      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      console.error(`  [ERR] ${title}: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n[Push Images] Complete: ${pushed} pushed, ${errors} errors`);
  await pool.end();
}

main().catch((err) => {
  console.error("[Push Images] Fatal error:", err);
  process.exit(1);
});
