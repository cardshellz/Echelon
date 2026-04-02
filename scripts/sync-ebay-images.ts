/**
 * Pull images from eBay listings and store them in the catalog.
 *
 * Scrapes eBay listing pages to extract image URLs (i.ebayimg.com),
 * downloads them, and stores in product_assets with both URL and cached file.
 *
 * Usage:
 *   EXTERNAL_DATABASE_URL=... npx tsx scripts/sync-ebay-images.ts [--dry-run] [--limit=50]
 */

import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const LIMIT_ARG = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1], 10) : 500;

const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Set EXTERNAL_DATABASE_URL or DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

const EBAY_CHANNEL_ID = 67;

/**
 * Extract unique image URLs from an eBay listing page.
 * Returns highest resolution versions (s-l1600).
 */
async function extractEbayImages(ebayUrl: string): Promise<string[]> {
  const response = await fetch(ebayUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${ebayUrl}: ${response.status}`);
  }

  const html = await response.text();

  // Extract all i.ebayimg.com image URLs, prefer s-l1600 (highest res)
  const urlPattern = /https:\/\/i\.ebayimg\.com\/images\/g\/[A-Za-z0-9_-]+\/s-l1600\.jpg/g;
  const matches = html.match(urlPattern) || [];

  // Deduplicate
  return [...new Set(matches)];
}

/**
 * Download an image and return buffer + mime type.
 */
async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const arrayBuf = await response.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuf),
      mimeType: response.headers.get("content-type") || "image/jpeg",
    };
  } catch (err: any) {
    console.warn(`    Download failed: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`[eBay Image Sync] Starting (limit: ${LIMIT}, dry_run: ${DRY_RUN})`);

  // Get all active eBay listings with product mapping
  // Group by external_product_id (same listing can have multiple variants)
  const listings = await pool.query(`
    SELECT DISTINCT ON (cl.external_product_id)
      cl.external_product_id as ebay_item_id,
      cl.external_url,
      cl.product_variant_id,
      pv.sku,
      pv.product_id,
      p.title
    FROM channel_listings cl
    JOIN product_variants pv ON pv.id = cl.product_variant_id
    JOIN products p ON p.id = pv.product_id
    WHERE cl.channel_id = $1
      AND cl.external_product_id IS NOT NULL
      AND cl.external_url IS NOT NULL
    ORDER BY cl.external_product_id, cl.id
    LIMIT $2
  `, [EBAY_CHANNEL_ID, LIMIT]);

  const items = listings.rows;
  console.log(`[eBay Image Sync] Found ${items.length} eBay listings to process\n`);

  let processed = 0;
  let imagesAdded = 0;
  let errors = 0;
  let skipped = 0;

  for (const item of items) {
    const { ebay_item_id, external_url, product_id, product_variant_id, sku, title } = item;

    try {
      // Check existing images for this product
      const existingImages = await pool.query(`
        SELECT url FROM product_assets WHERE product_id = $1
      `, [product_id]);

      const existingUrls = new Set(
        existingImages.rows.filter((r: any) => r.url).map((r: any) => r.url)
      );

      // Scrape images from eBay listing
      const imageUrls = await extractEbayImages(external_url);

      if (imageUrls.length === 0) {
        console.log(`  [${sku}] No images found on ${external_url}`);
        skipped++;
        continue;
      }

      // Filter to only new images
      const newUrls = imageUrls.filter((url) => !existingUrls.has(url));

      if (newUrls.length === 0) {
        console.log(`  [${sku}] All ${imageUrls.length} images already in catalog`);
        skipped++;
        continue;
      }

      console.log(`  [${sku}] ${newUrls.length} new images (${imageUrls.length} total on eBay, ${existingImages.rows.length} in catalog)`);

      if (DRY_RUN) {
        for (const url of newUrls) {
          console.log(`    [DRY] Would add: ${url}`);
        }
        imagesAdded += newUrls.length;
        processed++;
        continue;
      }

      // Download and store each new image
      for (let i = 0; i < newUrls.length; i++) {
        const url = newUrls[i];
        const position = existingImages.rows.length + i;
        const isPrimary = existingImages.rows.length === 0 && i === 0;

        const downloaded = await downloadImage(url);

        const assetResult = await pool.query(`
          INSERT INTO product_assets (
            product_id, product_variant_id, asset_type, url, alt_text,
            position, is_primary, file_size, mime_type, storage_type
          ) VALUES ($1, $2, 'image', $3, $4, $5, $6, $7, $8, $9)
          RETURNING id
        `, [
          product_id,
          product_variant_id,
          url,
          `${title || sku} - image ${position + 1}`,
          position,
          isPrimary ? 1 : 0,
          downloaded?.buffer.length || null,
          downloaded?.mimeType || null,
          downloaded ? "both" : "url",
        ]);

        if (downloaded) {
          await pool.query(
            `UPDATE product_assets SET file_data = $1 WHERE id = $2`,
            [downloaded.buffer, assetResult.rows[0].id]
          );
        }

        imagesAdded++;
        console.log(`    Added ${i + 1}/${newUrls.length}: ${url.substring(50)}...`);
      }

      processed++;

      // Rate limit — be nice to eBay
      await new Promise((r) => setTimeout(r, 500));
    } catch (err: any) {
      console.error(`  [${sku}] Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n[eBay Image Sync] Complete: ${processed} processed, ${imagesAdded} images added, ${skipped} skipped, ${errors} errors`);
  await pool.end();
}

main().catch((err) => {
  console.error("[eBay Image Sync] Fatal error:", err);
  process.exit(1);
});
