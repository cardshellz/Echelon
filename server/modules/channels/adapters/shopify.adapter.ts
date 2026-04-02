/**
 * Shopify Channel Adapter
 *
 * Implements IChannelAdapter for Shopify stores.
 * Handles all Shopify-specific API calls, payload formatting,
 * and response parsing.
 *
 * Uses Shopify REST Admin API (2024-01).
 */

import { eq } from "drizzle-orm";
import {
  channelConnections,
  warehouses,
  type ChannelConnection,
  type Warehouse,
} from "@shared/schema";
import type {
  IChannelAdapter,
  ChannelListingPayload,
  ListingPushResult,
  InventoryPushItem,
  InventoryPushResult,
  PricingPushItem,
  PricingPushResult,
  ChannelOrder,
  ChannelOrderLineItem,
  OrderIngestionResult,
  FulfillmentPayload,
  FulfillmentPushResult,
  CancellationPayload,
  CancellationPushResult,
} from "../channel-adapter.interface";

import crypto from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

interface ShopifyCredentials {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  webhookSecret: string | null;
  shopifyLocationId: string | null;
}

const DEFAULT_API_VERSION = "2024-01";
const MAX_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Shopify Adapter
// ---------------------------------------------------------------------------

export class ShopifyAdapter implements IChannelAdapter {
  readonly adapterName = "Shopify";
  readonly providerKey = "shopify";

  constructor(private readonly db: DrizzleDb) {}

  // -------------------------------------------------------------------------
  // Listings
  // -------------------------------------------------------------------------

  async pushListings(
    channelId: number,
    listings: ChannelListingPayload[],
  ): Promise<ListingPushResult[]> {
    const creds = await this.getCredentials(channelId);
    const results: ListingPushResult[] = [];

    for (const listing of listings) {
      try {
        const result = await this.pushSingleListing(creds, listing);
        results.push(result);
        // Rate limiting
        await this.delay(300);
      } catch (err: any) {
        results.push({
          productId: listing.productId,
          status: "error",
          error: err.message,
        });
      }
    }

    return results;
  }

  private async pushSingleListing(
    creds: ShopifyCredentials,
    listing: ChannelListingPayload,
  ): Promise<ListingPushResult> {
    // Build Shopify product payload
    const variants = listing.variants
      .filter((v) => v.isListed)
      .map((v) => {
        const variant: any = {
          sku: v.sku,
          title: v.name,
          barcode: v.barcode || v.gtin,
        };
        if (v.priceCents != null) {
          variant.price = (v.priceCents / 100).toFixed(2);
        }
        if (v.compareAtPriceCents != null) {
          variant.compare_at_price = (v.compareAtPriceCents / 100).toFixed(2);
        }
        if (v.weightGrams != null) {
          variant.weight = v.weightGrams;
          variant.weight_unit = "g";
        }
        if (v.externalVariantId) {
          variant.id = Number(v.externalVariantId);
        }
        return variant;
      });

    const images = listing.images.map((img) => {
      const image: any = {
        src: img.url,
        position: img.position + 1, // Shopify is 1-based
      };
      if (img.altText) image.alt = img.altText;
      return image;
    });

    const payload = {
      title: listing.title,
      body_html: listing.description || "",
      product_type: listing.category || "",
      tags: listing.tags?.join(", ") || "",
      status: listing.status === "active" ? "active" : "draft",
      variants,
      images,
    };

    // Determine if create or update
    const hasExternalIds = listing.variants.some((v) => v.externalVariantId);

    if (hasExternalIds) {
      // Find the Shopify product ID from any variant
      // In Shopify, all variants share a product ID — use metadata or first variant
      const existingVariant = listing.variants.find((v) => v.externalVariantId);
      if (!existingVariant?.externalVariantId) {
        return { productId: listing.productId, status: "error", error: "No external variant ID for update" };
      }

      // Get product ID from Shopify by fetching the variant
      const variantData = await this.shopifyGet(
        creds,
        `/variants/${existingVariant.externalVariantId}.json`,
      );
      const shopifyProductId = String(variantData?.variant?.product_id);

      if (!shopifyProductId) {
        return { productId: listing.productId, status: "error", error: "Could not resolve Shopify product ID" };
      }

      // UPDATE
      const response = await this.shopifyPut(
        creds,
        `/products/${shopifyProductId}.json`,
        { product: { ...payload, id: Number(shopifyProductId) } },
      );

      const variantIdMap: Record<number, string> = {};
      for (const v of listing.variants) {
        const shopifyVariant = response?.product?.variants?.find(
          (sv: any) => sv.sku === v.sku,
        );
        if (shopifyVariant) {
          variantIdMap[v.variantId] = String(shopifyVariant.id);
        }
      }

      return {
        productId: listing.productId,
        status: "updated",
        externalProductId: shopifyProductId,
        externalVariantIds: variantIdMap,
      };
    } else {
      // CREATE
      const response = await this.shopifyPost(
        creds,
        "/products.json",
        { product: payload },
      );

      const shopifyProduct = response?.product;
      if (!shopifyProduct) {
        return { productId: listing.productId, status: "error", error: "No product in Shopify response" };
      }

      const variantIdMap: Record<number, string> = {};
      for (const v of listing.variants) {
        const shopifyVariant = shopifyProduct.variants?.find(
          (sv: any) => sv.sku === v.sku,
        );
        if (shopifyVariant) {
          variantIdMap[v.variantId] = String(shopifyVariant.id);
        }
      }

      return {
        productId: listing.productId,
        status: "created",
        externalProductId: String(shopifyProduct.id),
        externalVariantIds: variantIdMap,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async pushInventory(
    channelId: number,
    items: InventoryPushItem[],
  ): Promise<InventoryPushResult[]> {
    const creds = await this.getCredentials(channelId);
    const results: InventoryPushResult[] = [];

    for (const item of items) {
      try {
        if (!item.externalInventoryItemId) {
          results.push({
            variantId: item.variantId,
            pushedQty: 0,
            status: "error",
            error: "No externalInventoryItemId — run product sync first",
          });
          continue;
        }

        // If warehouse breakdown is provided, push per-location
        if (item.warehouseBreakdown && item.warehouseBreakdown.length > 0) {
          for (const wh of item.warehouseBreakdown) {
            await this.setInventoryLevel(
              creds,
              item.externalInventoryItemId,
              wh.externalLocationId,
              wh.qty,
            );
          }
        } else {
          // Use connection's location ID, fall back to env var
          const locationId = creds.shopifyLocationId || process.env.SHOPIFY_LOCATION_ID;
          if (!locationId) {
            results.push({
              variantId: item.variantId,
              pushedQty: 0,
              status: "error",
              error: "No shopify_location_id on channel connection and no SHOPIFY_LOCATION_ID env var",
            });
            continue;
          }
          await this.setInventoryLevel(
            creds,
            item.externalInventoryItemId,
            locationId,
            item.allocatedQty,
          );
        }

        results.push({
          variantId: item.variantId,
          pushedQty: item.allocatedQty,
          status: "success",
        });
      } catch (err: any) {
        results.push({
          variantId: item.variantId,
          pushedQty: 0,
          status: "error",
          error: err.message,
        });
      }

      // Rate limiting between items
      await this.delay(200);
    }

    return results;
  }

  private async setInventoryLevel(
    creds: ShopifyCredentials,
    inventoryItemId: string,
    locationId: string,
    available: number,
  ): Promise<void> {
    await this.shopifyPost(creds, "/inventory_levels/set.json", {
      location_id: Number(locationId),
      inventory_item_id: Number(inventoryItemId),
      available,
    });
  }

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  async pushPricing(
    channelId: number,
    items: PricingPushItem[],
  ): Promise<PricingPushResult[]> {
    const creds = await this.getCredentials(channelId);
    const results: PricingPushResult[] = [];

    for (const item of items) {
      try {
        if (!item.externalVariantId) {
          results.push({
            variantId: item.variantId,
            status: "error",
            error: "No externalVariantId — run product sync first",
          });
          continue;
        }

        const payload: any = {
          variant: {
            id: Number(item.externalVariantId),
            price: (item.priceCents / 100).toFixed(2),
          },
        };
        if (item.compareAtPriceCents != null) {
          payload.variant.compare_at_price = (item.compareAtPriceCents / 100).toFixed(2);
        }

        await this.shopifyPut(
          creds,
          `/variants/${item.externalVariantId}.json`,
          payload,
        );

        results.push({ variantId: item.variantId, status: "success" });
      } catch (err: any) {
        results.push({
          variantId: item.variantId,
          status: "error",
          error: err.message,
        });
      }

      await this.delay(200);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async pullOrders(
    channelId: number,
    since: Date,
  ): Promise<ChannelOrder[]> {
    const creds = await this.getCredentials(channelId);
    const orders: ChannelOrder[] = [];
    let pageInfo: string | null = null;

    do {
      const url = pageInfo
        ? `/orders.json?limit=250&page_info=${pageInfo}`
        : `/orders.json?limit=250&status=any&created_at_min=${since.toISOString()}`;

      const data = await this.shopifyGet(creds, url);
      if (!data?.orders) break;

      for (const order of data.orders) {
        orders.push(this.mapShopifyOrder(order, channelId));
      }

      // Pagination
      pageInfo = null;
      // Note: shopifyGet would need to return headers for pagination
      // For now, we break after first page; full pagination would use Link header
      break;
    } while (pageInfo);

    return orders;
  }

  async receiveOrder(
    channelId: number,
    rawPayload: unknown,
    headers: Record<string, string>,
  ): Promise<ChannelOrder | null> {
    // Verify webhook signature
    const creds = await this.getCredentials(channelId);
    if (creds.webhookSecret) {
      const hmacHeader = headers["x-shopify-hmac-sha256"] || headers["X-Shopify-Hmac-Sha256"];
      if (!hmacHeader) return null;

      const body = typeof rawPayload === "string"
        ? rawPayload
        : JSON.stringify(rawPayload);

      const computed = crypto
        .createHmac("sha256", creds.webhookSecret)
        .update(body, "utf8")
        .digest("base64");

      if (!crypto.timingSafeEqual(Buffer.from(hmacHeader), Buffer.from(computed))) {
        throw new Error("Shopify webhook HMAC verification failed");
      }
    }

    const payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;

    // Check if this is an order payload
    if (!payload || typeof payload !== "object" || !("id" in (payload as any))) {
      return null;
    }

    return this.mapShopifyOrder(payload as any, channelId);
  }

  private mapShopifyOrder(shopifyOrder: any, channelId: number): ChannelOrder {
    const lineItems: ChannelOrderLineItem[] = (shopifyOrder.line_items || []).map((item: any) => ({
      externalLineItemId: String(item.id),
      sku: item.sku || "",
      title: item.title || item.name || "",
      quantity: item.quantity,
      priceCents: Math.round(parseFloat(item.price || "0") * 100),
      discountCents: Math.round(
        (item.discount_allocations || []).reduce(
          (sum: number, d: any) => sum + parseFloat(d.amount || "0"),
          0,
        ) * 100,
      ),
      taxCents: Math.round(
        (item.tax_lines || []).reduce(
          (sum: number, t: any) => sum + parseFloat(t.price || "0"),
          0,
        ) * 100,
      ),
      totalCents: Math.round(parseFloat(item.price || "0") * item.quantity * 100),
    }));

    const shipping = shopifyOrder.shipping_address || {};

    return {
      externalOrderId: String(shopifyOrder.id),
      channelId,
      source: "shopify",
      customerEmail: shopifyOrder.email || shopifyOrder.contact_email || null,
      customerName: shopifyOrder.customer
        ? `${shopifyOrder.customer.first_name || ""} ${shopifyOrder.customer.last_name || ""}`.trim()
        : null,
      shippingAddress: {
        name: shipping.name || null,
        address1: shipping.address1 || null,
        address2: shipping.address2 || null,
        city: shipping.city || null,
        province: shipping.province || null,
        zip: shipping.zip || null,
        country: shipping.country_code || shipping.country || null,
        phone: shipping.phone || null,
      },
      lineItems,
      subtotalCents: Math.round(parseFloat(shopifyOrder.subtotal_price || "0") * 100),
      taxCents: Math.round(parseFloat(shopifyOrder.total_tax || "0") * 100),
      shippingCents: Math.round(
        (shopifyOrder.shipping_lines || []).reduce(
          (sum: number, sl: any) => sum + parseFloat(sl.price || "0"),
          0,
        ) * 100,
      ),
      discountCents: Math.round(parseFloat(shopifyOrder.total_discounts || "0") * 100),
      totalCents: Math.round(parseFloat(shopifyOrder.total_price || "0") * 100),
      currency: shopifyOrder.currency || "USD",
      financialStatus: shopifyOrder.financial_status || null,
      fulfillmentStatus: shopifyOrder.fulfillment_status || null,
      notes: shopifyOrder.note || null,
      tags: shopifyOrder.tags ? shopifyOrder.tags.split(",").map((t: string) => t.trim()) : null,
      orderDate: new Date(shopifyOrder.created_at || Date.now()),
      rawPayload: shopifyOrder,
    };
  }

  // -------------------------------------------------------------------------
  // Fulfillment
  // -------------------------------------------------------------------------

  async pushFulfillment(
    channelId: number,
    fulfillments: FulfillmentPayload[],
  ): Promise<FulfillmentPushResult[]> {
    const creds = await this.getCredentials(channelId);
    const results: FulfillmentPushResult[] = [];

    for (const fulfillment of fulfillments) {
      try {
        const payload: any = {
          fulfillment: {
            tracking_number: fulfillment.trackingNumber,
            tracking_url: fulfillment.trackingUrl,
            tracking_company: fulfillment.carrier,
            notify_customer: fulfillment.notifyCustomer,
            line_items: fulfillment.lineItems.map((li) => ({
              id: Number(li.externalLineItemId),
              quantity: li.quantity,
            })),
          },
        };

        const response = await this.shopifyPost(
          creds,
          `/orders/${fulfillment.externalOrderId}/fulfillments.json`,
          payload,
        );

        results.push({
          externalOrderId: fulfillment.externalOrderId,
          externalFulfillmentId: response?.fulfillment?.id
            ? String(response.fulfillment.id)
            : undefined,
          status: "success",
        });
      } catch (err: any) {
        results.push({
          externalOrderId: fulfillment.externalOrderId,
          status: "error",
          error: err.message,
        });
      }

      await this.delay(300);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Cancellations (stub)
  // -------------------------------------------------------------------------

  async pushCancellation(
    _channelId: number,
    cancellations: CancellationPayload[],
  ): Promise<CancellationPushResult[]> {
    // Stub — cancellation push is a future feature
    return cancellations.map((c) => ({
      externalOrderId: c.externalOrderId,
      status: "not_supported" as const,
      error: "Shopify order cancellation push not yet implemented",
    }));
  }

  // -------------------------------------------------------------------------
  // Push images only — does NOT touch variants, title, price, or any other field
  // -------------------------------------------------------------------------

  async pushImagesOnly(
    channelId: number,
    shopifyProductId: string,
    images: Array<{ url: string; altText?: string | null; position: number; fileData?: string | null; mimeType?: string | null }>,
  ): Promise<void> {
    const creds = await this.getCredentials(channelId);

    // Download each image and send as base64 attachment.
    // Shopify silently rejects CDN/eBay URLs passed as `src` — needs actual bytes.
    // Use pre-stored file_data if available to avoid re-downloading.
    const shopifyImages: Array<Record<string, any>> = [];
    for (const img of images.filter((i) => i.url)) {
      try {
        let base64: string;
        const filename = img.url.split("/").pop()?.split("?")[0] || `image_${shopifyImages.length + 1}.jpg`;

        if (img.fileData) {
          // Already downloaded and stored in DB — use directly
          base64 = img.fileData;
          console.log(`[pushImagesOnly] Using stored file_data for ${filename}`);
        } else {
          // Download now
          const resp = await fetch(img.url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          });
          if (!resp.ok) {
            console.warn(`[pushImagesOnly] Failed to download image ${img.url}: ${resp.status}`);
            continue;
          }
          const buffer = Buffer.from(await resp.arrayBuffer());
          base64 = buffer.toString("base64");
          console.log(`[pushImagesOnly] Downloaded ${filename} (${buffer.length} bytes)`);
        }

        shopifyImages.push({
          attachment: base64,
          filename,
          position: shopifyImages.length + 1,
          ...(img.altText ? { alt: img.altText } : {}),
        });
      } catch (err: any) {
        console.warn(`[pushImagesOnly] Error processing image ${img.url}:`, err.message);
      }
    }

    if (shopifyImages.length === 0) return;

    // Fetch existing images so we don't overwrite them — POST each new image individually
    const existing = await this.shopifyGet(creds, `/products/${shopifyProductId}/images.json`);
    const existingFilenames = new Set<string>(
      (existing?.images || []).map((img: any) => {
        // Shopify stores src like https://cdn.shopify.com/.../filename.jpg?v=123
        const src: string = img.src || "";
        return src.split("/").pop()?.split("?")[0] || "";
      })
    );

    let position = (existing?.images?.length || 0) + 1;
    for (const img of shopifyImages) {
      if (existingFilenames.has(img.filename)) {
        console.log(`[pushImagesOnly] Skipping existing image: ${img.filename}`);
        continue;
      }
      await this.shopifyPost(
        creds,
        `/products/${shopifyProductId}/images.json`,
        { image: { ...img, position } },
      );
      position++;
    }
  }

  // -------------------------------------------------------------------------
  // Shopify API Helpers
  // -------------------------------------------------------------------------

  private async getCredentials(channelId: number): Promise<ShopifyCredentials> {
    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .limit(1);

    if (!conn?.shopDomain || !conn?.accessToken) {
      throw new Error(`No Shopify credentials configured for channel ${channelId}`);
    }

    return {
      shopDomain: conn.shopDomain,
      accessToken: conn.accessToken,
      apiVersion: conn.apiVersion || DEFAULT_API_VERSION,
      webhookSecret: conn.webhookSecret,
      shopifyLocationId: (conn as any).shopifyLocationId || null,
    };
  }

  private async shopifyGet(creds: ShopifyCredentials, path: string): Promise<any> {
    return this.shopifyRequest(creds, "GET", path);
  }

  private async shopifyPost(creds: ShopifyCredentials, path: string, body: any): Promise<any> {
    return this.shopifyRequest(creds, "POST", path, body);
  }

  private async shopifyPut(creds: ShopifyCredentials, path: string, body: any): Promise<any> {
    return this.shopifyRequest(creds, "PUT", path, body);
  }

  private async shopifyRequest(
    creds: ShopifyCredentials,
    method: string,
    path: string,
    body?: any,
  ): Promise<any> {
    const baseUrl = `https://${creds.shopDomain}/admin/api/${creds.apiVersion}`;
    const url = path.startsWith("/") ? `${baseUrl}${path}` : `${baseUrl}/${path}`;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method,
        headers: {
          "X-Shopify-Access-Token": creds.accessToken,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Rate limit handling
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Retry-After") || "2", 10);
        console.warn(`[ShopifyAdapter] Rate limited, retrying in ${retryAfter}s (attempt ${attempt})`);
        await this.delay(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        if (attempt < MAX_RETRIES && response.status >= 500) {
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.warn(`[ShopifyAdapter] Server error ${response.status}, retrying in ${backoff}ms`);
          await this.delay(backoff);
          continue;
        }
        throw new Error(`Shopify API ${method} ${path} failed (${response.status}): ${errorBody}`);
      }

      return response.json();
    }

    throw new Error(`Shopify API ${method} ${path} failed after ${MAX_RETRIES} retries`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createShopifyAdapter(db: any): ShopifyAdapter {
  return new ShopifyAdapter(db);
}
