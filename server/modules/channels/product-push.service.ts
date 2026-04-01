/**
 * Channel Product Push Service
 *
 * Pushes product data (title, description, images, pricing, variants) from
 * Echelon to external channels (Shopify, Amazon, eBay, etc.).
 *
 * Resolution: products (master) → overlay channelProductOverrides →
 *   productVariants → overlay channelVariantOverrides →
 *   channelPricing fallback → product_assets → apply channelAssetOverrides →
 *   build API payload
 */

import { eq, and, sql } from "drizzle-orm";
import {
  products,
  productVariants,
  productAssets,
  channelProductOverrides,
  channelVariantOverrides,
  channelPricing,
  channelAssetOverrides,
  channelListings,
  channelConnections,
  channels,
  type Product,
  type ProductVariant,
  type ProductAsset,
  type ChannelProductOverride,
  type ChannelVariantOverride,
  type ChannelPricing,
  type ChannelAssetOverride,
  type ChannelListing,
} from "@shared/schema";
import { catalogStorage } from "../catalog";
import { channelsStorage } from "../channels";
const storage = { ...catalogStorage, ...channelsStorage };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedImage {
  url: string;
  altText: string | null;
  position: number;
  variantSku: string | null;
}

export interface ResolvedVariant {
  id: number;
  sku: string | null;
  name: string;
  barcode: string | null;
  gtin: string | null;
  mpn: string | null;
  weight: number | null;
  price: number | null;
  compareAtPrice: number | null;
  shopifyVariantId: string | null;
  isListed: boolean;
}

export interface ResolvedChannelProduct {
  productId: number;
  title: string;
  description: string | null;
  category: string | null;
  tags: string[] | null;
  status: string;
  isListed: boolean;
  variants: ResolvedVariant[];
  images: ResolvedImage[];
  shopifyProductId: string | null;
}

export interface ProductPushResult {
  productId: number;
  channelId: number;
  status: "created" | "updated" | "skipped" | "error";
  externalProductId?: string;
  error?: string;
}

export interface BulkPushResult {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  results: ProductPushResult[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createChannelProductPushService(db: any) {
  /**
   * Resolve master product data with channel-specific overrides merged.
   * NULL override fields = use master value.
   */
  async function getResolvedProductForChannel(
    productId: number,
    channelId: number,
  ): Promise<ResolvedChannelProduct | null> {
    const product = await storage.getProductById(productId);
    if (!product) return null;

    // Get channel overrides
    const productOverride = await storage.getChannelProductOverride(channelId, productId);
    const variants = await storage.getProductVariantsByProductId(productId);
    const assets = await storage.getProductAssetsByProductId(productId);
    const variantOverrides = await storage.getChannelVariantOverridesByProduct(channelId, productId);
    const pricingOverrides = await storage.getChannelPricingByProduct(channelId, productId);
    const assetOverrides = await storage.getChannelAssetOverridesByProduct(channelId, productId);

    // Build override maps
    const voMap = new Map(variantOverrides.map((vo) => [vo.productVariantId, vo]));
    const prMap = new Map(pricingOverrides.map((p) => [p.productVariantId, p]));
    const aoMap = new Map(assetOverrides.map((ao) => [ao.productAssetId, ao]));

    // Resolve product-level fields
    const title = productOverride?.titleOverride || product.title || product.name;
    const description = productOverride?.descriptionOverride || product.description;
    const category = productOverride?.categoryOverride || product.category;
    const tags = productOverride?.tagsOverride as string[] | null || product.tags as string[] | null;
    const isListed = productOverride ? productOverride.isListed === 1 : true;

    // Resolve variants
    const resolvedVariants: ResolvedVariant[] = variants.map((v) => {
      const vo = voMap.get(v.id);
      const pr = prMap.get(v.id);
      return {
        id: v.id,
        sku: vo?.skuOverride || v.sku,
        name: vo?.nameOverride || v.name,
        barcode: vo?.barcodeOverride || v.barcode,
        gtin: v.gtin || null,
        mpn: v.mpn || null,
        weight: vo?.weightOverride || null,
        price: pr?.price ?? v.priceCents ?? null,
        compareAtPrice: pr?.compareAtPrice ?? v.compareAtPriceCents ?? null,
        shopifyVariantId: v.shopifyVariantId,
        isListed: vo ? vo.isListed === 1 : true,
      };
    });

    // Resolve images
    const resolvedImages: ResolvedImage[] = assets
      .map((a) => {
        const ao = aoMap.get(a.id);
        if (ao && ao.isIncluded === 0) return null; // Excluded from this channel
        const matchedVariant = a.productVariantId
          ? variants.find((v) => v.id === a.productVariantId)
          : null;
        return {
          url: ao?.urlOverride || a.url,
          altText: ao?.altTextOverride || a.altText,
          position: ao?.positionOverride ?? a.position,
          variantSku: matchedVariant?.sku || null,
        };
      })
      .filter(Boolean) as ResolvedImage[];

    resolvedImages.sort((a, b) => a.position - b.position);

    return {
      productId,
      title,
      description,
      category,
      tags,
      status: product.status || "active",
      isListed,
      variants: resolvedVariants,
      images: resolvedImages,
      shopifyProductId: product.shopifyProductId,
    };
  }

  /**
   * Push a single product to a specific channel.
   */
  async function pushProduct(
    productId: number,
    channelId: number,
  ): Promise<ProductPushResult> {
    const resolved = await getResolvedProductForChannel(productId, channelId);
    if (!resolved) {
      return { productId, channelId, status: "error", error: "Product not found" };
    }

    if (!resolved.isListed) {
      return { productId, channelId, status: "skipped", error: "Product not listed on this channel" };
    }

    // Get channel info
    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (!channel) {
      return { productId, channelId, status: "error", error: "Channel not found" };
    }

    if (channel.provider === "shopify") {
      // Validate: all listed variants must have a price
      const missingPrice = resolved.variants.filter((v) => v.isListed && (v.price == null || v.price < 0));
      if (missingPrice.length > 0) {
        const skus = missingPrice.map((v) => v.sku || v.name).join(", ");
        return {
          productId,
          channelId,
          status: "error",
          error: `Cannot push to Shopify — missing price on variant${missingPrice.length > 1 ? "s" : ""}: ${skus}. Set prices in the product variants.`,
        };
      }
      return await pushToShopify(resolved, channelId);
    }

    // Future: Amazon, eBay, etc.
    return { productId, channelId, status: "skipped", error: `Provider ${channel.provider} not yet supported` };
  }

  /**
   * Push a product to all active channels.
   */
  async function pushProductToAllChannels(
    productId: number,
  ): Promise<ProductPushResult[]> {
    const activeChannels = await db
      .select()
      .from(channels)
      .where(eq(channels.status, "active"));

    const results: ProductPushResult[] = [];
    for (const channel of activeChannels) {
      const result = await pushProduct(productId, channel.id);
      results.push(result);
    }
    return results;
  }

  /**
   * Push all products to a specific channel (bulk).
   */
  async function pushAllProducts(channelId: number): Promise<BulkPushResult> {
    const allProducts = await storage.getAllProducts();
    const results: ProductPushResult[] = [];

    for (const product of allProducts) {
      const result = await pushProduct(product.id, channelId);
      results.push(result);
    }

    return {
      total: results.length,
      created: results.filter((r) => r.status === "created").length,
      updated: results.filter((r) => r.status === "updated").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
    };
  }

  // ---------------------------------------------------------------------------
  // Shopify-specific push
  // ---------------------------------------------------------------------------

  async function pushToShopify(
    resolved: ResolvedChannelProduct,
    channelId: number,
  ): Promise<ProductPushResult> {
    // Get connection credentials
    const [conn] = await db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .limit(1);

    if (!conn?.shopDomain || !conn?.accessToken) {
      return {
        productId: resolved.productId,
        channelId,
        status: "error",
        error: "No Shopify credentials configured for this channel",
      };
    }

    const apiVersion = conn.apiVersion || "2024-01";

    // Check if product already exists on Shopify via channelListings
    const existingListings = await storage.getChannelListingsByProduct(channelId, resolved.productId);
    const existingListing = existingListings[0];

    // Also check by shopifyProductId
    const externalProductId = existingListing?.externalProductId || resolved.shopifyProductId;

    try {
      if (externalProductId) {
        // UPDATE existing product
        await updateShopifyProduct(
          conn.shopDomain,
          conn.accessToken,
          apiVersion,
          externalProductId,
          resolved,
        );

        // Update listing sync status
        if (existingListing) {
          await storage.upsertChannelListing({
            channelId,
            productVariantId: existingListing.productVariantId,
            externalProductId,
            syncStatus: "synced",
            lastSyncedAt: new Date(),
            syncError: null,
          });
        }

        // Ensure channel feeds exist for all listed variants (in case they were added after initial push)
        for (const variant of resolved.variants) {
          if (!variant.isListed) continue;
          const existingFeed = await storage.getChannelFeedByChannelAndVariant(channelId, variant.id);
          if (existingFeed) {
            if (existingFeed.isActive !== 1) await storage.reactivateChannelFeed(existingFeed.id);
          } else {
            const shopifyVariantId = variant.shopifyVariantId || null;
            await storage.createChannelFeedDirect({
              channelId,
              productVariantId: variant.id,
              channelType: "shopify",
              channelVariantId: shopifyVariantId || variant.sku || String(variant.id),
              channelProductId: externalProductId,
              channelSku: variant.sku || null,
              isActive: 1,
            });
          }
        }

        // Update product lastPushedAt
        await storage.updateProduct(resolved.productId, {
          lastPushedAt: new Date(),
        });

        return {
          productId: resolved.productId,
          channelId,
          status: "updated",
          externalProductId,
        };
      } else {
        // CREATE new product on Shopify
        const shopifyProduct = await createShopifyProduct(
          conn.shopDomain,
          conn.accessToken,
          apiVersion,
          resolved,
        );

        const newExternalProductId = String(shopifyProduct.id);

        // Create channel listings + channel feeds for all variants
        for (const variant of resolved.variants) {
          const shopifyVariant = shopifyProduct.variants?.find(
            (sv: any) => sv.sku === variant.sku,
          );
          if (shopifyVariant) {
            const shopifyVariantId = String(shopifyVariant.id);

            await storage.upsertChannelListing({
              channelId,
              productVariantId: variant.id,
              externalProductId: newExternalProductId,
              externalVariantId: shopifyVariantId,
              externalSku: variant.sku,
              syncStatus: "synced",
              lastSyncedAt: new Date(),
            });

            // Ensure channel feed exists so inventory sync picks this variant up
            const existingFeed = await storage.getChannelFeedByChannelAndVariant(channelId, variant.id);
            if (existingFeed) {
              if (existingFeed.isActive !== 1) {
                await storage.reactivateChannelFeed(existingFeed.id);
              }
            } else {
              await storage.createChannelFeedDirect({
                channelId,
                productVariantId: variant.id,
                channelType: "shopify",
                channelVariantId: shopifyVariantId,
                channelProductId: newExternalProductId,
                channelSku: variant.sku || null,
                isActive: 1,
              });
            }
          }
        }

        // Update product shopifyProductId and lastPushedAt
        await storage.updateProduct(resolved.productId, {
          shopifyProductId: newExternalProductId,
          lastPushedAt: new Date(),
        });

        return {
          productId: resolved.productId,
          channelId,
          status: "created",
          externalProductId: newExternalProductId,
        };
      }
    } catch (error: any) {
      console.error(`[ChannelPush] Shopify push failed for product ${resolved.productId}:`, error.message);

      // Record error in listing
      if (existingListing) {
        await storage.upsertChannelListing({
          channelId,
          productVariantId: existingListing.productVariantId,
          externalProductId: existingListing.externalProductId,
          syncStatus: "error",
          syncError: error.message,
          lastSyncedAt: new Date(),
        });
      }

      return {
        productId: resolved.productId,
        channelId,
        status: "error",
        error: error.message,
      };
    }
  }

  async function createShopifyProduct(
    shopDomain: string,
    accessToken: string,
    apiVersion: string,
    resolved: ResolvedChannelProduct,
  ): Promise<any> {
    const payload = buildShopifyProductPayload(resolved);

    const url = `https://${shopDomain}/admin/api/${apiVersion}/products.json`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ product: payload }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Shopify create product failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    return data.product;
  }

  async function updateShopifyProduct(
    shopDomain: string,
    accessToken: string,
    apiVersion: string,
    externalProductId: string,
    resolved: ResolvedChannelProduct,
  ): Promise<any> {
    const payload = buildShopifyProductPayload(resolved);

    const url = `https://${shopDomain}/admin/api/${apiVersion}/products/${externalProductId}.json`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ product: { ...payload, id: Number(externalProductId) } }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Shopify update product failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    return data.product;
  }

  function buildShopifyProductPayload(resolved: ResolvedChannelProduct) {
    const listedVariants = resolved.variants.filter((v) => v.isListed);

    // Shopify requires options on the product and option1/option2 on variants.
    // If there's only one variant and its name matches the product title, use "Default Title".
    const isSingleDefaultVariant =
      listedVariants.length === 1 &&
      (listedVariants[0].name === "Default Title" ||
        listedVariants[0].name === resolved.title ||
        !listedVariants[0].name);

    const productOptions = isSingleDefaultVariant
      ? [{ name: "Title" }]
      : [{ name: "Variant" }];

    const variants = listedVariants.map((v) => {
      const variant: any = {
        sku: v.sku,
        // Shopify REST API uses option1/option2/option3, NOT title
        option1: isSingleDefaultVariant ? "Default Title" : (v.name || v.sku || "Default"),
        barcode: v.barcode || v.gtin || undefined,
        price: (v.price! / 100).toFixed(2),
      };
      if (v.compareAtPrice != null) {
        variant.compare_at_price = (v.compareAtPrice / 100).toFixed(2);
      }
      if (v.weight != null) {
        variant.weight = v.weight;
        variant.weight_unit = "g";
      }
      if (v.shopifyVariantId) {
        variant.id = Number(v.shopifyVariantId);
      }
      return variant;
    });

    const images = resolved.images.map((img) => {
      const image: any = {
        src: img.url,
        position: img.position + 1, // Shopify positions are 1-based
      };
      if (img.altText) {
        image.alt = img.altText;
      }
      return image;
    });

    const payload: Record<string, any> = {
      title: resolved.title,
      body_html: resolved.description || "",
      product_type: resolved.category || "",
      tags: resolved.tags?.join(", ") || "",
      status: resolved.status === "active" ? "active" : "draft",
      options: productOptions,
      variants,
    };

    // IMPORTANT: Only include images if we actually have some.
    // Sending images:[] to Shopify deletes all existing images on the listing.
    // If product_assets is empty, omit the images key entirely so Shopify
    // keeps whatever images it already has.
    if (images.length > 0) {
      payload.images = images;
    }

    return payload;
  }

  return {
    getResolvedProductForChannel,
    pushProduct,
    pushProductToAllChannels,
    pushAllProducts,
  };
}

export type ChannelProductPushService = ReturnType<typeof createChannelProductPushService>;
