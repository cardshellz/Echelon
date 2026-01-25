import crypto from "crypto";

// Use existing variable names from user's Shopify app setup
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET; // shpss_ prefix, used for webhook HMAC verification

export interface ShopifyVariant {
  id: number;
  sku: string;
  title: string;
  product_id: number;
  image_id?: number;
  barcode?: string;
}

export interface ShopifyImage {
  id: number;
  src: string;
  variant_ids?: number[];
}

export interface ShopifyProduct {
  id: number;
  title: string;
  status: "active" | "draft" | "archived";
  variants: ShopifyVariant[];
  images?: ShopifyImage[];
  image?: { src: string };
}

export interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

function getShopifyConfig() {
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
    throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN environment variables are required");
  }
  // Handle both formats: "card-shellz" or "card-shellz.myshopify.com"
  const store = SHOPIFY_SHOP_DOMAIN.replace(/\.myshopify\.com$/, "");
  return {
    store,
    accessToken: SHOPIFY_ACCESS_TOKEN,
  };
}

export async function fetchAllShopifyProducts(): Promise<{ sku: string; name: string; status: string; imageUrl?: string; barcode?: string }[]> {
  const config = getShopifyConfig();
  const allSkus: { sku: string; name: string; status: string; imageUrl?: string; barcode?: string }[] = [];
  let pageInfo: string | null = null;
  
  do {
    const url: string = pageInfo
      ? `https://${config.store}.myshopify.com/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
      : `https://${config.store}.myshopify.com/admin/api/2024-01/products.json?limit=250`;
    
    const response: Response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${error}`);
    }
    
    const data: ShopifyProductsResponse = await response.json();
    
    for (const product of data.products) {
      // Build a map of image_id to src for quick lookup
      const imageMap = new Map<number, string>();
      if (product.images) {
        for (const img of product.images) {
          imageMap.set(img.id, img.src);
        }
      }
      // Get the default product image
      const defaultImage = product.image?.src || (product.images && product.images[0]?.src);
      
      for (const variant of product.variants) {
        if (variant.sku && variant.sku.trim()) {
          const variantTitle = variant.title !== "Default Title" ? ` - ${variant.title}` : "";
          // Try to get variant-specific image, fall back to product image
          const imageUrl = variant.image_id ? imageMap.get(variant.image_id) : defaultImage;
          allSkus.push({
            sku: variant.sku.trim().toUpperCase(),
            name: `${product.title}${variantTitle}`,
            status: product.status,
            imageUrl,
            barcode: variant.barcode?.trim() || undefined,
          });
        }
      }
    }
    
    // Handle pagination via Link header
    const linkHeader: string | null = response.headers.get("Link");
    pageInfo = null;
    if (linkHeader) {
      const nextMatch: RegExpMatchArray | null = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
      }
    }
  } while (pageInfo);
  
  return allSkus;
}

export function verifyShopifyWebhook(rawBody: Buffer, hmacHeader: string): boolean {
  if (!SHOPIFY_API_SECRET) {
    throw new Error("SHOPIFY_API_SECRET is required for webhook verification");
  }
  
  if (!hmacHeader) {
    return false;
  }
  
  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(rawBody)
    .digest("base64");
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(generatedHash),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}

export function extractSkusFromWebhookPayload(payload: any): { sku: string; name: string; status: string }[] {
  const skus: { sku: string; name: string; status: string }[] = [];
  const productStatus = payload.status || "active";
  
  if (payload.variants) {
    for (const variant of payload.variants) {
      if (variant.sku && variant.sku.trim()) {
        const variantTitle = variant.title !== "Default Title" ? ` - ${variant.title}` : "";
        skus.push({
          sku: variant.sku.trim().toUpperCase(),
          name: `${payload.title}${variantTitle}`,
          status: productStatus,
        });
      }
    }
  }
  
  return skus;
}

// Order webhook types
export interface ShopifyOrderLineItem {
  id: number;
  sku: string;
  name: string;
  title: string;
  quantity: number;
  variant_title: string;
  variant_id: number | null;
  product_id: number;
  requires_shipping: boolean;
  gift_card: boolean;
  vendor: string | null;
  price: string;
  grams: number | null;
  image?: {
    src: string;
  };
  properties?: Record<string, unknown>[];
  tax_lines?: Array<{ price: string; rate: number; title: string }>;
  discount_allocations?: Array<{ amount: string; discount_application_index: number }>;
}

export interface ShopifyAddress {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
  country_code: string | null;
  phone: string | null;
}

export interface ShopifyShippingLine {
  title: string;
  price: string;
  code: string;
  source: string;
}

export interface ShopifyDiscountCode {
  code: string;
  amount: string;
  type: string;
}

export interface ShopifyOrderCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
}

export interface ShopifyOrder {
  id: number;
  order_number: number;
  name: string;
  email: string;
  customer: ShopifyOrderCustomer | null;
  line_items: ShopifyOrderLineItem[];
  fulfillment_status: string | null;
  financial_status: string;
  tags: string;
  note: string | null;
  created_at: string;
  cancelled_at: string | null;
  // Financial fields
  currency: string;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  total_discounts: string;
  // Addresses
  shipping_address: ShopifyAddress | null;
  billing_address: ShopifyAddress | null;
  // Shipping
  shipping_lines: ShopifyShippingLine[];
  // Discounts
  discount_codes: ShopifyDiscountCode[];
}

export interface ExtractedOrderItem {
  shopifyLineItemId: string;
  sku: string;
  name: string;
  quantity: number;
  imageUrl?: string;
  // Enhanced fields for multi-channel support
  variantTitle?: string;
  variantId?: string;
  productId?: string;
  vendor?: string;
  unitPriceCents?: number;
  totalPriceCents?: number;
  discountCents?: number;
  taxCents?: number;
  giftCard?: boolean;
  requiresShipping?: boolean;
  weight?: number;
  properties?: Record<string, unknown>[];
}

export interface ExtractedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerId: string | null;
  priority: "rush" | "high" | "normal";
  shopifyCreatedAt: string;
  items: ExtractedOrderItem[];
  // Financial fields (in cents)
  currency: string;
  totalPriceCents: number;
  subtotalPriceCents: number;
  totalTaxCents: number;
  totalShippingCents: number;
  totalDiscountsCents: number;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  // Shipping address
  shippingName: string | null;
  shippingCompany: string | null;
  shippingAddress1: string | null;
  shippingAddress2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  shippingCountry: string | null;
  shippingCountryCode: string | null;
  // Billing address
  billingName: string | null;
  billingAddress1: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;
  // Shipping method
  shippingMethod: string | null;
  // Customer notes and tags
  customerNote: string | null;
  tags: string[];
  discountCodes: string[];
}

export interface ShopifyOrdersResponse {
  orders: ShopifyOrder[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchUnfulfilledOrders(): Promise<ExtractedOrder[]> {
  const config = getShopifyConfig();
  const allOrders: ExtractedOrder[] = [];
  let pageInfo: string | null = null;
  let pageCount = 0;
  
  console.log("[SHOPIFY SYNC] Starting to fetch unfulfilled orders...");
  
  do {
    pageCount++;
    // Use status=any to catch all orders, then filter client-side
    // The fulfillment_status filter sometimes misses orders with null status (Shopify API quirk)
    const url: string = pageInfo
      ? `https://${config.store}.myshopify.com/admin/api/2024-01/orders.json?limit=250&page_info=${pageInfo}`
      : `https://${config.store}.myshopify.com/admin/api/2024-01/orders.json?limit=250&status=any&fulfillment_status=unfulfilled,partial,null`;
    
    console.log(`[SHOPIFY SYNC] Fetching page ${pageCount}...`);
    
    const response: Response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      if (response.status === 429) {
        console.log("[SHOPIFY SYNC] Rate limited, waiting 2s...");
        await delay(2000);
        continue;
      }
      const error = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${error}`);
    }
    
    const data: ShopifyOrdersResponse = await response.json();
    console.log(`[SHOPIFY SYNC] Page ${pageCount}: Got ${data.orders.length} orders`);
    
    for (const order of data.orders) {
      if (!order.cancelled_at) {
        allOrders.push(extractOrderFromWebhookPayload(order));
      }
    }
    
    const linkHeader: string | null = response.headers.get("Link");
    pageInfo = null;
    if (linkHeader) {
      const nextMatch: RegExpMatchArray | null = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
      if (nextMatch) {
        pageInfo = nextMatch[1];
        console.log(`[SHOPIFY SYNC] Found next page cursor`);
      }
    }
    
    if (pageInfo) {
      await delay(600);
    }
  } while (pageInfo);
  
  console.log(`[SHOPIFY SYNC] Complete: Fetched ${allOrders.length} total orders across ${pageCount} pages`);
  
  return allOrders;
}

// Helper to convert dollar amount to cents
function dollarsToCents(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const numValue = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(numValue)) return 0;
  return Math.round(numValue * 100);
}

export function extractOrderFromWebhookPayload(payload: ShopifyOrder): ExtractedOrder {
  const customerName = payload.customer 
    ? `${payload.customer.first_name} ${payload.customer.last_name}`.trim()
    : "Guest Customer";
  
  // Priority from tags
  const tagsRaw = payload.tags || "";
  const tagsLower = tagsRaw.toLowerCase();
  let priority: "rush" | "high" | "normal" = "normal";
  if (tagsLower.includes("rush") || tagsLower.includes("express")) {
    priority = "rush";
  } else if (tagsLower.includes("priority") || tagsLower.includes("high")) {
    priority = "high";
  }
  
  // Parse tags array
  const tags = tagsRaw ? tagsRaw.split(",").map(t => t.trim()).filter(t => t) : [];
  
  // Extract discount codes
  const discountCodes = payload.discount_codes?.map(dc => dc.code) || [];
  
  // Extract line items with enhanced data
  const items: ExtractedOrderItem[] = [];
  for (const lineItem of payload.line_items) {
    // Include all items that require shipping OR are gift cards
    const isGiftCard = lineItem.gift_card === true;
    const requiresShipping = lineItem.requires_shipping === true;
    
    if (requiresShipping || isGiftCard) {
      const sku = lineItem.sku && lineItem.sku.trim() 
        ? lineItem.sku.trim().toUpperCase() 
        : `NO-SKU-${lineItem.id}`;
      
      // Calculate total line discount from discount_allocations
      const lineDiscountCents = lineItem.discount_allocations?.reduce(
        (sum: number, da: any) => sum + dollarsToCents(da.amount), 
        0
      ) || 0;
      
      // Calculate tax for this line item from tax_lines
      const lineTaxCents = lineItem.tax_lines?.reduce(
        (sum: number, tl: any) => sum + dollarsToCents(tl.price), 
        0
      ) || 0;
      
      items.push({
        shopifyLineItemId: String(lineItem.id),
        sku,
        name: lineItem.name || lineItem.title,
        quantity: lineItem.quantity,
        imageUrl: lineItem.image?.src || undefined,
        // Enhanced fields
        variantTitle: lineItem.variant_title || undefined,
        variantId: lineItem.variant_id ? String(lineItem.variant_id) : undefined,
        productId: lineItem.product_id ? String(lineItem.product_id) : undefined,
        vendor: lineItem.vendor || undefined,
        unitPriceCents: dollarsToCents(lineItem.price),
        totalPriceCents: dollarsToCents(lineItem.price) * lineItem.quantity,
        discountCents: lineDiscountCents,
        taxCents: lineTaxCents,
        giftCard: isGiftCard,
        requiresShipping: requiresShipping,
        weight: lineItem.grams || undefined,
        properties: lineItem.properties || undefined,
      });
    }
  }
  
  // Use payload.name (e.g., "#1234") if available, otherwise format order_number
  const orderNumber = payload.name 
    ? payload.name 
    : `#${payload.order_number}`;
  
  // Extract shipping address
  const shipping = payload.shipping_address;
  const shippingName = shipping 
    ? `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim() || null
    : null;
  
  // Extract billing address
  const billing = payload.billing_address;
  const billingName = billing 
    ? `${billing.first_name || ''} ${billing.last_name || ''}`.trim() || null
    : null;
  
  // Extract shipping method from shipping_lines
  const shippingMethod = payload.shipping_lines?.[0]?.title || null;
  
  // Calculate total shipping cost
  const totalShippingCents = payload.shipping_lines?.reduce(
    (sum: number, sl: any) => sum + dollarsToCents(sl.price), 
    0
  ) || 0;
  
  // Calculate total discounts
  const totalDiscountsCents = dollarsToCents(payload.total_discounts);
  
  return {
    shopifyOrderId: String(payload.id),
    orderNumber,
    customerName,
    customerEmail: payload.email || payload.customer?.email || null,
    customerPhone: shipping?.phone || payload.customer?.phone || null,
    customerId: payload.customer?.id ? String(payload.customer.id) : null,
    priority,
    shopifyCreatedAt: payload.created_at,
    items,
    // Financial fields
    currency: payload.currency || "USD",
    totalPriceCents: dollarsToCents(payload.total_price),
    subtotalPriceCents: dollarsToCents(payload.subtotal_price),
    totalTaxCents: dollarsToCents(payload.total_tax),
    totalShippingCents,
    totalDiscountsCents,
    financialStatus: payload.financial_status || null,
    fulfillmentStatus: payload.fulfillment_status || null,
    // Shipping address
    shippingName,
    shippingCompany: shipping?.company || null,
    shippingAddress1: shipping?.address1 || null,
    shippingAddress2: shipping?.address2 || null,
    shippingCity: shipping?.city || null,
    shippingState: shipping?.province || null,
    shippingPostalCode: shipping?.zip || null,
    shippingCountry: shipping?.country || null,
    shippingCountryCode: shipping?.country_code || null,
    // Billing address
    billingName,
    billingAddress1: billing?.address1 || null,
    billingCity: billing?.city || null,
    billingState: billing?.province || null,
    billingPostalCode: billing?.zip || null,
    billingCountry: billing?.country || null,
    // Shipping method
    shippingMethod,
    // Notes and tags
    customerNote: payload.note || null,
    tags,
    discountCodes,
  };
}

// ============================================
// INVENTORY SYNC TO SHOPIFY
// ============================================

export interface InventoryLevelUpdate {
  shopifyVariantId: string;
  available: number;
}

export async function updateShopifyInventoryLevel(
  shopifyVariantId: string,
  available: number
): Promise<boolean> {
  const config = getShopifyConfig();
  
  try {
    // First, we need to get the inventory_item_id for this variant
    const variantUrl = `https://${config.store}.myshopify.com/admin/api/2024-01/variants/${shopifyVariantId}.json`;
    const variantResponse = await fetch(variantUrl, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
    });
    
    if (!variantResponse.ok) {
      console.error(`[SHOPIFY INVENTORY] Failed to fetch variant ${shopifyVariantId}: ${variantResponse.status}`);
      return false;
    }
    
    const variantData = await variantResponse.json();
    const inventoryItemId = variantData.variant?.inventory_item_id;
    
    if (!inventoryItemId) {
      console.error(`[SHOPIFY INVENTORY] No inventory_item_id found for variant ${shopifyVariantId}`);
      return false;
    }
    
    // Get the location ID (we need at least one location to set inventory)
    const locationsUrl = `https://${config.store}.myshopify.com/admin/api/2024-01/locations.json`;
    const locationsResponse = await fetch(locationsUrl, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
    });
    
    if (!locationsResponse.ok) {
      console.error(`[SHOPIFY INVENTORY] Failed to fetch locations: ${locationsResponse.status}`);
      return false;
    }
    
    const locationsData = await locationsResponse.json();
    const locationId = locationsData.locations?.[0]?.id;
    
    if (!locationId) {
      console.error(`[SHOPIFY INVENTORY] No locations found in Shopify`);
      return false;
    }
    
    // Set the inventory level
    const setUrl = `https://${config.store}.myshopify.com/admin/api/2024-01/inventory_levels/set.json`;
    const setResponse = await fetch(setUrl, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
        available: Math.max(0, available), // Shopify doesn't allow negative
      }),
    });
    
    if (!setResponse.ok) {
      const error = await setResponse.text();
      console.error(`[SHOPIFY INVENTORY] Failed to set inventory: ${setResponse.status} - ${error}`);
      return false;
    }
    
    console.log(`[SHOPIFY INVENTORY] Updated variant ${shopifyVariantId} to ${available} available`);
    return true;
  } catch (error) {
    console.error(`[SHOPIFY INVENTORY] Error updating variant ${shopifyVariantId}:`, error);
    return false;
  }
}

export async function syncInventoryToShopify(
  updates: InventoryLevelUpdate[]
): Promise<{ success: number; failed: number }> {
  let success = 0;
  let failed = 0;
  
  for (const update of updates) {
    // Rate limit between updates
    await delay(300);
    
    const result = await updateShopifyInventoryLevel(update.shopifyVariantId, update.available);
    if (result) {
      success++;
    } else {
      failed++;
    }
  }
  
  console.log(`[SHOPIFY INVENTORY] Sync complete: ${success} succeeded, ${failed} failed`);
  return { success, failed };
}

/**
 * Sync inventory levels to Shopify for all variants of an inventory item
 * Uses channel feeds to map our variants to Shopify variant IDs
 * Returns the number of variants successfully synced
 */
export async function syncInventoryItemToShopify(
  inventoryItemId: number,
  storage: any // Using any to avoid circular import
): Promise<{ synced: number; skipped: number }> {
  let synced = 0;
  let skipped = 0;
  
  try {
    // Get all variants for this inventory item
    const variants = await storage.getUomVariantsByInventoryItemId(inventoryItemId);
    
    // Calculate total ATP for this item
    const onHand = await storage.getTotalOnHandByItemId(inventoryItemId, true);
    const reserved = await storage.getTotalReservedByItemId(inventoryItemId);
    const atp = onHand - reserved;
    
    for (const variant of variants) {
      // Get channel feed for this variant
      const feeds = await storage.getChannelFeedsByVariantId(variant.id);
      const shopifyFeed = feeds.find((f: any) => f.channelType === "shopify" && f.isActive);
      
      if (!shopifyFeed) {
        skipped++;
        continue;
      }
      
      // Calculate available quantity for this variant
      const available = Math.floor(atp / variant.unitsPerVariant);
      
      // Skip if no change from last sync
      if (shopifyFeed.lastSyncedQty === available) {
        skipped++;
        continue;
      }
      
      // Rate limit
      await delay(300);
      
      // Update Shopify
      const success = await updateShopifyInventoryLevel(shopifyFeed.channelVariantId, available);
      
      if (success) {
        // Update last synced in channel feed
        await storage.updateChannelFeedSyncStatus(shopifyFeed.id, available);
        synced++;
      }
    }
    
    console.log(`[SHOPIFY SYNC] Item ${inventoryItemId}: synced ${synced}, skipped ${skipped}`);
  } catch (error) {
    console.error(`[SHOPIFY SYNC] Error syncing item ${inventoryItemId}:`, error);
  }
  
  return { synced, skipped };
}

// Fetch fulfillment status for specific order IDs from Shopify
export interface OrderFulfillmentStatus {
  shopifyOrderId: string;
  fulfillmentStatus: string | null;
  cancelledAt: string | null;
}

export async function fetchOrdersFulfillmentStatus(shopifyOrderIds: string[]): Promise<OrderFulfillmentStatus[]> {
  const config = getShopifyConfig();
  const results: OrderFulfillmentStatus[] = [];
  
  // Shopify API allows fetching by IDs in batches
  const batchSize = 50;
  for (let i = 0; i < shopifyOrderIds.length; i += batchSize) {
    const batch = shopifyOrderIds.slice(i, i + batchSize);
    const idsParam = batch.join(",");
    
    const url = `https://${config.store}.myshopify.com/admin/api/2024-01/orders.json?ids=${idsParam}&status=any&fields=id,fulfillment_status,cancelled_at`;
    
    const response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      if (response.status === 429) {
        await delay(2000);
        i -= batchSize; // Retry this batch
        continue;
      }
      const error = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${error}`);
    }
    
    const data: { orders: Array<{ id: number; fulfillment_status: string | null; cancelled_at: string | null }> } = await response.json();
    
    for (const order of data.orders) {
      results.push({
        shopifyOrderId: String(order.id),
        fulfillmentStatus: order.fulfillment_status,
        cancelledAt: order.cancelled_at,
      });
    }
    
    // Rate limiting
    if (i + batchSize < shopifyOrderIds.length) {
      await delay(500);
    }
  }
  
  return results;
}
