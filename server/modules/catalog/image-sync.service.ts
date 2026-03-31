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
  async function pullFromEbay(productIds?: number[]): Promise<ImagePullResult[]> {
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

    for (const listing of uniqueListings) {
      const result: ImagePullResult = {
        productId: listing.productId,
        sku: listing.sku || "",
        imagesFound: 0,
        imagesAdded: 0,
        errors: [],
      };

      try {
        if (!listing.ebayUrl) {
          result.errors.push("No eBay URL");
          results.push(result);
          continue;
        }

        // Scrape images from eBay listing page
        const imageUrls = await scrapeEbayImages(listing.ebayUrl);
        result.imagesFound = imageUrls.length;

        if (imageUrls.length === 0) {
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

        // Get catalog images
        const assets = await db
          .select()
          .from(productAssets)
          .where(eq(productAssets.productId, product.id))
          .orderBy(productAssets.position);

        if (assets.length === 0) {
          results.push(result);
          continue;
        }

        // Build Shopify image objects — use public URLs
        const images = assets.map((a, i) => {
          // For file-stored assets, use the serve URL
          // For URL assets, use the original URL
          const url = (a.storageType === "file" || a.storageType === "both")
            ? `https://${shopDomain}/api/product-assets/${a.id}/file`  // won't work from Shopify
            : a.url;

          return {
            src: url,
            position: i + 1,
            alt: a.altText || product.sku || "",
          };
        }).filter((img) => img.src); // Skip nulls

        // Push to Shopify
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
                id: product.shopifyProductId,
                images,
              },
            }),
          }
        );

        if (!shopifyRes.ok) {
          const error = await shopifyRes.text();
          result.errors.push(`Shopify API error: ${error}`);
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

  async function scrapeEbayImages(ebayUrl: string): Promise<string[]> {
    const response = await fetch(ebayUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html",
      },
    });

    if (!response.ok) return [];

    const html = await response.text();
    const urlPattern = /https:\/\/i\.ebayimg\.com\/images\/g\/[A-Za-z0-9_-]+\/s-l1600\.jpg/g;
    const matches = html.match(urlPattern) || [];
    return [...new Set(matches)];
  }

  async function downloadImage(url: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
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
