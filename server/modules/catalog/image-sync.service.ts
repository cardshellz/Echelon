/**
 * Image Sync Service
 *
 * Echelon is the source of truth for product images. This service provides:
 * - Pull: fetch images from channels (eBay, Shopify) and store in Echelon catalog
 * - Push: send catalog images to channels (Shopify, eBay)
 *
 * Flow: Channel → Echelon (pull) or Echelon → Channel (push)
 * Never: Channel → Channel
 */

import { db } from "../../db";
import { sql, eq, and } from "drizzle-orm";
import { productAssets, productVariants, products, channelListings } from "@shared/schema";

const EBAY_CHANNEL_ID = 67;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelImage {
  url: string;
  position: number;
  altText?: string;
  variantSku?: string;
}

export interface ImagePullResult {
  productId: number;
  sku: string;
  imagesFound: number;
  imagesAdded: number;
  errors: string[];
}

export interface ImagePushResult {
  productId: number;
  sku: string;
  imagesPushed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Image Sync Service
// ---------------------------------------------------------------------------

export function createImageSyncService() {

  // =========================================================================
  // PULL — Channel → Echelon
  // =========================================================================

  /**
   * Pull images from eBay listings and store in Echelon catalog.
   * Scrapes eBay listing pages for i.ebayimg.com image URLs.
   */
  async function pullFromEbay(productIds?: number[], ebayAccessToken?: string): Promise<ImagePullResult[]> {
    const results: ImagePullResult[] = [];

    // Get eBay listings to process
    const conditions = [eq(channelListings.channelId, EBAY_CHANNEL_ID)];
    if (productIds?.length) {
      conditions.push(sql`${products.id} = ANY(${productIds})`);
    }

    const listings = await db
      .select({
        productId: products.id,
        sku: productVariants.sku,
        ebayItemId: channelListings.externalProductId,
        ebayUrl: channelListings.externalUrl,
      })
      .from(channelListings)
      .innerJoin(productVariants, eq(productVariants.id, channelListings.productVariantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(...conditions));

    // Deduplicate by product
    const seen = new Set<number>();
    const uniqueListings = listings.filter((l) => {
      if (seen.has(l.productId)) return false;
      seen.add(l.productId);
      return true;
    });

    console.log(`[ImageSync] pullFromEbay: processing ${uniqueListings.length} unique products`);

    for (const listing of uniqueListings) {
      const result: ImagePullResult = {
        productId: listing.productId,
        sku: listing.sku || "",
        imagesFound: 0,
        imagesAdded: 0,
        errors: [],
      };

      console.log(`[ImageSync] Processing product ${listing.productId} (${listing.sku}) - ${listing.ebayUrl || 'NO URL'}`);

      try {
        if (!listing.ebayUrl) {
          result.errors.push("No eBay URL");
          results.push(result);
          continue;
        }

        // Use eBay Browse API if we have an access token, otherwise fall back to scraping
        let imageUrls: string[] = [];
        if (ebayAccessToken && listing.ebayItemId) {
          imageUrls = await fetchEbayImagesViaApi(listing.ebayItemId, ebayAccessToken);
        }
        if (imageUrls.length === 0) {
          imageUrls = await scrapeEbayImages(listing.ebayUrl);
        }
        result.imagesFound = imageUrls.length;

        if (imageUrls.length === 0) {
          result.errors.push("No images found on eBay page (blocked or listing changed)");
          results.push(result);
          continue;
        }

        // Check existing images
        const existing = await db
          .select({ url: productAssets.url })
          .from(productAssets)
          .where(eq(productAssets.productId, listing.productId));

        const existingUrls = new Set(existing.filter((r) => r.url).map((r) => r.url!));
        const newUrls = imageUrls.filter((url) => !existingUrls.has(url));

        // Download and store each new image
        for (let i = 0; i < newUrls.length; i++) {
          const url = newUrls[i];
          const position = existing.length + i;
          const isPrimary = existing.length === 0 && i === 0;

          const downloaded = await downloadImage(url);

          const [asset] = await db
            .insert(productAssets)
            .values({
              productId: listing.productId,
              assetType: "image",
              url,
              altText: `${listing.sku} - image ${position + 1}`,
              position,
              isPrimary: isPrimary ? 1 : 0,
              fileSize: downloaded?.buffer.length || null,
              mimeType: downloaded?.mimeType || null,
              storageType: downloaded ? "both" : "url",
            })
            .returning();

          if (downloaded) {
            await db.execute(sql`
              UPDATE product_assets SET file_data = ${downloaded.buffer} WHERE id = ${asset.id}
            `);
          }

          result.imagesAdded++;
        }

        // Rate limit
        await new Promise((r) => setTimeout(r, 300));
      } catch (err: any) {
        result.errors.push(err.message);
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Normalize a Shopify shop domain to just the store name.
   * Accepts: "cardshellz", "cardshellz.myshopify.com", "https://cardshellz.myshopify.com"
   * Returns: "cardshellz.myshopify.com"
   */
  function normalizeShopDomain(domain: string): string {
    let d = domain.trim();
    d = d.replace(/^https?:\/\//, "");
    d = d.replace(/\/.*$/, "");
    if (!d.includes(".myshopify.com")) {
      d = `${d}.myshopify.com`;
    }
    return d;
  }

  /**
   * Pull images from Shopify products and store in Echelon catalog.
   * Uses the Shopify Admin API to fetch product images.
   */
  async function pullFromShopify(
    shopDomain: string,
    accessToken: string,
    productIds?: number[]
  ): Promise<ImagePullResult[]> {
    const domain = normalizeShopDomain(shopDomain);
    const results: ImagePullResult[] = [];

    const shopifyConditions = [sql`${products.shopifyProductId} IS NOT NULL`];
    if (productIds?.length) {
      shopifyConditions.push(sql`${products.id} = ANY(${productIds})`);
    }

    const productList = await db
      .select({
        id: products.id,
        sku: products.sku,
        shopifyProductId: products.shopifyProductId,
      })
      .from(products)
      .where(and(...shopifyConditions));

    for (const product of productList) {
      const result: ImagePullResult = {
        productId: product.id,
        sku: product.sku || "",
        imagesFound: 0,
        imagesAdded: 0,
        errors: [],
      };

      try {
        if (!product.shopifyProductId) {
          result.errors.push("No Shopify product ID");
          results.push(result);
          continue;
        }

        // Fetch from Shopify
        const shopifyRes = await fetch(
          `https://${domain}/admin/api/2024-01/products/${product.shopifyProductId}.json`,
          {
            headers: {
              "X-Shopify-Access-Token": accessToken,
              "Content-Type": "application/json",
            },
          }
        );

        if (!shopifyRes.ok) {
          result.errors.push(`Shopify API error: ${shopifyRes.status}`);
          results.push(result);
          continue;
        }

        const { product: shopifyProduct } = await shopifyRes.json();
        const shopifyImages: any[] = shopifyProduct.images || [];
        result.imagesFound = shopifyImages.length;

        if (shopifyImages.length === 0) {
          results.push(result);
          continue;
        }

        // Check existing images
        const existing = await db
          .select({ url: productAssets.url })
          .from(productAssets)
          .where(eq(productAssets.productId, product.id));

        const existingUrls = new Set(existing.filter((r) => r.url).map((r) => r.url!));
        const newImages = shopifyImages.filter((img: any) => !existingUrls.has(img.src));

        // Store each new image
        for (let i = 0; i < newImages.length; i++) {
          const img = newImages[i];
          const position = existing.length + i;
          const isPrimary = existing.length === 0 && i === 0;

          const downloaded = await downloadImage(img.src);

          const [asset] = await db
            .insert(productAssets)
            .values({
              productId: product.id,
              assetType: "image",
              url: img.src,
              altText: img.alt || `${product.sku} - image ${position + 1}`,
              position,
              isPrimary: isPrimary ? 1 : 0,
              fileSize: downloaded?.buffer.length || null,
              mimeType: downloaded?.mimeType || null,
              storageType: downloaded ? "both" : "url",
            })
            .returning();

          if (downloaded) {
            await db.execute(sql`
              UPDATE product_assets SET file_data = ${downloaded.buffer} WHERE id = ${asset.id}
            `);
          }

          result.imagesAdded++;
        }

        // Rate limit
        await new Promise((r) => setTimeout(r, 500));
      } catch (err: any) {
        result.errors.push(err.message);
      }

      results.push(result);
    }

    return results;
  }

  // =========================================================================
  // PUSH — Echelon → Channel
  // =========================================================================

  /**
   * Push catalog images to Shopify.
   * Updates Shopify product images with URLs from Echelon catalog.
   */
  async function pushToShopify(
    shopDomain: string,
    accessToken: string,
    productIds?: number[]
  ): Promise<ImagePushResult[]> {
    const domain = normalizeShopDomain(shopDomain);
    const results: ImagePushResult[] = [];

    // Get products with images and Shopify product IDs
    const pushConditions = [sql`${products.shopifyProductId} IS NOT NULL`];
    if (productIds?.length) {
      pushConditions.push(sql`${products.id} = ANY(${productIds})`);
    }

    const productList = await db
      .select({
        id: products.id,
        sku: products.sku,
        shopifyProductId: products.shopifyProductId,
      })
      .from(products)
      .where(and(...pushConditions));

    for (const product of productList) {
      const result: ImagePushResult = {
        productId: product.id,
        sku: product.sku || "",
        imagesPushed: 0,
        errors: [],
      };

      try {
        if (!product.shopifyProductId) {
          result.errors.push("No Shopify product ID");
          results.push(result);
          continue;
        }

        // Get catalog images (use raw SQL to ensure file_data is included)
        const assetResult = await db.execute(sql`
          SELECT id, url, alt_text, position, storage_type, file_data, mime_type
          FROM product_assets
          WHERE product_id = ${product.id}
          ORDER BY position
        `);
        const assets = assetResult.rows as any[];

        if (assets.length === 0) {
          results.push(result);
          continue;
        }

        // Push images to Shopify using URL-based approach (src)
        // Shopify fetches the URL and stores the image on its own CDN.
        // Use original URLs (eBay CDN, etc.) — Shopify can fetch them.
        const images = assets.map((a, i) => {
          if (!a.url) return null;
          return {
            src: a.url,
            position: i + 1,
            alt: a.alt_text || product.sku || "",
          };
        }).filter(Boolean) as { src: string; position: number; alt: string }[];

        if (images.length === 0) {
          results.push(result);
          continue;
        }

        // Push all images at once via product update
        const shopifyRes = await fetch(
          `https://${domain}/admin/api/2024-01/products/${product.shopifyProductId}.json`,
          {
            method: "PUT",
            headers: {
              "X-Shopify-Access-Token": accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              product: {
                id: Number(product.shopifyProductId),
                images,
              },
            }),
          }
        );

        if (shopifyRes.status === 429) {
          const retryAfter = parseInt(shopifyRes.headers.get("Retry-After") || "2");
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!shopifyRes.ok) {
          const error = await shopifyRes.text();
          result.errors.push(`Shopify API error: ${error.substring(0, 300)}`);
          results.push(result);
          continue;
        }

        result.imagesPushed = images.length;

        // Rate limit
        await new Promise((r) => setTimeout(r, 500));
      } catch (err: any) {
        result.errors.push(err.message);
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Push catalog images to eBay listings.
   * Uploads images to eBay Picture Services and updates listings.
   */
  async function pushToEbay(
    accessToken: string,
    productIds?: number[]
  ): Promise<ImagePushResult[]> {
    // eBay push is handled through the existing listing push flow
    // in ebay-channel.routes.ts which reads from product_assets.
    // This is a placeholder for a dedicated image-only push.
    const results: ImagePushResult[] = [];

    const ebayConditions = [eq(channelListings.channelId, EBAY_CHANNEL_ID)];
    if (productIds?.length) {
      ebayConditions.push(sql`${products.id} = ANY(${productIds})`);
    }

    const listings = await db
      .select({
        productId: products.id,
        sku: productVariants.sku,
        ebayItemId: channelListings.externalProductId,
      })
      .from(channelListings)
      .innerJoin(productVariants, eq(productVariants.id, channelListings.productVariantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(...ebayConditions));

    // eBay image push requires uploading to eBay Picture Services first
    // then revising the listing. This is complex and should use the
    // existing ebay-channel.routes.ts listing push flow.
    // For now, return a note that the full listing push should be used.

    for (const listing of listings) {
      results.push({
        productId: listing.productId,
        sku: listing.sku || "",
        imagesPushed: 0,
        errors: ["Use the eBay listing push endpoint for image updates — eBay requires Picture Services upload + ReviseItem"],
      });
    }

    return results;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  async function fetchEbayImagesViaApi(ebayItemId: string, accessToken: string): Promise<string[]> {
    // Try Sell Inventory API first (seller token has access to this)
    // The inventory item SKU is needed — but we can also try the Trading API GetItem call
    // which works with seller OAuth tokens and returns PictureURL array
    try {
      console.log(`[ImageSync] Fetching images via eBay Trading API GetItem for item ${ebayItemId}`);
      const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${accessToken}</eBayAuthToken>
  </RequesterCredentials>
  <ItemID>${ebayItemId}</ItemID>
  <IncludeItemSpecifics>false</IncludeItemSpecifics>
  <OutputSelector>PictureDetails</OutputSelector>
</GetItemRequest>`;

      const response = await fetch("https://api.ebay.com/ws/api.dll", {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
          "X-EBAY-API-CALL-NAME": "GetItem",
          "X-EBAY-API-IAF-TOKEN": accessToken,
        },
        body: xmlBody,
      });

      if (!response.ok) {
        console.warn(`[ImageSync] Trading API GetItem failed: ${response.status} for item ${ebayItemId}`);
        return [];
      }

      const xml = await response.text();
      // Extract PictureURL values from XML
      const matches = xml.match(/<PictureURL>(.*?)<\/PictureURL>/g) || [];
      const urls = matches.map(m => m.replace(/<\/?PictureURL>/g, "").trim());
      console.log(`[ImageSync] Trading API found ${urls.length} images for item ${ebayItemId}`);
      return urls;
    } catch (err: any) {
      console.warn(`[ImageSync] Trading API error for item ${ebayItemId}: ${err.message}`);
      return [];
    }
  }

  async function scrapeEbayImages(ebayUrl: string): Promise<string[]> {
    console.log(`[ImageSync] Scraping eBay page: ${ebayUrl}`);
    try {
      const response = await fetch(ebayUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        console.warn(`[ImageSync] eBay page fetch failed: ${response.status} for ${ebayUrl}`);
        return [];
      }

      const html = await response.text();
      // Match both s-l1600 and s-l500 variants
      const urlPattern = /https:\/\/i\.ebayimg\.com\/images\/g\/[A-Za-z0-9~_-]+\/s-l(?:1600|500|400|300)\.(?:jpg|png|webp)/g;
      const matches = html.match(urlPattern) || [];
      const unique = [...new Set(matches)];
      // Prefer highest resolution: upgrade any lower-res to s-l1600
      const upgraded = unique.map(u => u.replace(/s-l(?:500|400|300)\./, 's-l1600.'));
      const deduped = [...new Set(upgraded)];
      console.log(`[ImageSync] Found ${deduped.length} images at ${ebayUrl}`);
      return deduped;
    } catch (err: any) {
      console.warn(`[ImageSync] Error scraping ${ebayUrl}: ${err.message}`);
      return [];
    }
  }

  async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      });
      if (!response.ok) {
        console.warn(`[ImageSync] Failed to download image ${url}: ${response.status}`);
        return null;
      }
      const arrayBuf = await response.arrayBuffer();
      return {
        buffer: Buffer.from(arrayBuf),
        mimeType: response.headers.get("content-type") || "image/jpeg",
      };
    } catch {
      return null;
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  return {
    pullFromEbay,
    pullFromShopify,
    pushToShopify,
    pushToEbay,
  };
}

export type ImageSyncService = ReturnType<typeof createImageSyncService>;
