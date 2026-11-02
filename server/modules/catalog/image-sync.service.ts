/**
 * Image Sync Service
 *
 * Echelon is the source of truth for product images. This service provides:
 * - Pull: fetch images from channels (eBay, Shopify) and store in Echelon catalog
 * - Push: send catalog originals to Shopify. eBay publishing uses channel Sync.
 *
 * Flow: Channel → Echelon (pull) or Echelon → Channel (push)
 * Never: Channel → Channel
 */

import { db, pool } from "../../db";
import { sql, eq, and } from "drizzle-orm";
import { productAssets, productVariants, products, channelListings } from "@shared/schema";
import { readEbayPublishedContent } from "../channels/adapters/ebay/ebay-published-content.reader";
import { createSharedProductPhotoImporter, type SharedImportedPhoto } from "./shared-product-photos.service";
import { PgCatalogVariantPublicationPhotoReader, readCatalogPublicationImageIds, readCatalogPublicationImages,
  resolveCatalogPublicationPhotos } from "./catalog-publication-images.reader";
import { createCatalogPublicImageUrl } from "./catalog-public-image";

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
  const importer = createSharedProductPhotoImporter(db, () => new Date());
  const publicUrl = createCatalogPublicImageUrl(process.env);
  const publicationPhotos = new PgCatalogVariantPublicationPhotoReader(pool, publicUrl);

  // =========================================================================
  // PULL — Channel → Echelon
  // =========================================================================

  /**
   * Pull images from eBay listings and store in Echelon catalog.
   * Reads only the authenticated listing gallery; page recommendations are not product media.
   */
  async function pullFromEbay(productIds?: number[], ebayAccessToken?: string, environment?: "production" | "sandbox"): Promise<ImagePullResult[]> {
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
        externalSku: channelListings.externalSku,
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
        if (!listing.ebayItemId) {
          result.errors.push("No exact eBay listing identity");
          results.push(result);
          continue;
        }

        if (!ebayAccessToken || !environment || !listing.ebayItemId)
          throw new Error("Reconnect the exact eBay account before importing this listing's photos.");
        const published = await readEbayPublishedContent({ listingId: listing.ebayItemId, accessToken: ebayAccessToken, environment });
        const expectedSku = listing.externalSku || listing.sku;
        if (!expectedSku || !published.skus.includes(expectedSku))
          throw new Error("The eBay gallery does not match this product's saved SKU. Review its channel mapping before importing photos.");
        const imageSources: SharedImportedPhoto[] = published.photos.map((photo, position) => ({ url: photo.url, position, sourceAliases: photo.sourceAliases }));
        result.imagesFound = imageSources.length;

        if (imageSources.length === 0) {
          result.errors.push("The verified eBay listing has no available gallery photos");
          results.push(result);
          continue;
        }

        result.imagesAdded = (await importer.append({ productId: listing.productId, photos: imageSources,
          actor: "service:ebay_image_import" })).created;

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

        result.imagesAdded = (await importer.append({ productId: product.id,
          photos: shopifyImages.map((image: { src: string; alt?: string }, position: number) => ({
            url: image.src, position, altText: image.alt ?? null,
          })), actor: "service:shopify_image_import" })).created;

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

        const assetIds = await readCatalogPublicationImageIds(pool, [product.id]);
        if (assetIds.length === 0) {
          results.push(result);
          continue;
        }
        const variants = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, product.id));
        let selectedPhotos: readonly {assetId:number|null;url:string}[];
        if (variants.length) {
          const plan = await publicationPhotos.listPublicationPlan({ productId: product.id,
            productVariantIds: variants.map(variant => variant.id), maxPhotosPerVariant: assetIds.length, maxGroupPhotos: assetIds.length });
          const blocked = plan.group.omissions.find(omission => omission.blocking);
          if (blocked) throw new Error(blocked.message ?? "A Catalog original is unavailable. Repair it before pushing photos.");
          selectedPhotos = plan.group.selected;
        } else {
          // Catalog can have a product gallery before variants are created.
          // Use its normal source resolver; do not invent a variant identity.
          const gallery = resolveCatalogPublicationPhotos(await readCatalogPublicationImages(pool,[product.id]),publicUrl);
          if (gallery.issues.length) throw new Error(gallery.issues[0].message);
          selectedPhotos = gallery.photos;
        }
        const captions = await db.select({ id: productAssets.id, altText: productAssets.altText }).from(productAssets).where(eq(productAssets.productId, product.id));
        const altById = new Map(captions.map(asset => [asset.id, asset.altText]));
        const images = selectedPhotos.map((photo, position) => ({ src: photo.url, position: position + 1,
          alt: photo.assetId === null ? product.sku ?? "" : altById.get(photo.assetId) ?? product.sku ?? "" }));

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

  // =========================================================================
  // Helpers
  // =========================================================================

  // Public API
  return {
    pullFromEbay,
    pullFromShopify,
    pushToShopify,
  };
}

export type ImageSyncService = ReturnType<typeof createImageSyncService>;
