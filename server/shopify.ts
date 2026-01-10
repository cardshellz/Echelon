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

export async function fetchAllShopifyProducts(): Promise<{ sku: string; name: string; status: string; imageUrl?: string }[]> {
  const config = getShopifyConfig();
  const allSkus: { sku: string; name: string; status: string; imageUrl?: string }[] = [];
  let pageInfo: string | null = null;
  
  do {
    const url = pageInfo
      ? `https://${config.store}.myshopify.com/admin/api/2024-01/products.json?limit=250&page_info=${pageInfo}`
      : `https://${config.store}.myshopify.com/admin/api/2024-01/products.json?limit=250`;
    
    const response = await fetch(url, {
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
          });
        }
      }
    }
    
    // Handle pagination via Link header
    const linkHeader = response.headers.get("Link");
    pageInfo = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
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
  product_id: number;
  requires_shipping: boolean;
  image?: {
    src: string;
  };
}

export interface ShopifyOrderCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
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
}

export interface ExtractedOrderItem {
  shopifyLineItemId: string;
  sku: string;
  name: string;
  quantity: number;
  imageUrl?: string;
}

export interface ExtractedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string | null;
  priority: "rush" | "high" | "normal";
  items: ExtractedOrderItem[];
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
  
  do {
    const url: string = pageInfo
      ? `https://${config.store}.myshopify.com/admin/api/2024-01/orders.json?limit=250&page_info=${pageInfo}`
      : `https://${config.store}.myshopify.com/admin/api/2024-01/orders.json?limit=250&status=open&fulfillment_status=unfulfilled,partial`;
    
    const response: Response = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": config.accessToken,
        "Content-Type": "application/json",
      },
    });
    
    if (!response.ok) {
      if (response.status === 429) {
        await delay(2000);
        continue;
      }
      const error = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${error}`);
    }
    
    const data: ShopifyOrdersResponse = await response.json();
    
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
      }
    }
    
    if (pageInfo) {
      await delay(600);
    }
  } while (pageInfo);
  
  return allOrders;
}

export function extractOrderFromWebhookPayload(payload: ShopifyOrder): ExtractedOrder {
  const customerName = payload.customer 
    ? `${payload.customer.first_name} ${payload.customer.last_name}`.trim()
    : "Guest Customer";
  
  const tags = (payload.tags || "").toLowerCase();
  let priority: "rush" | "high" | "normal" = "normal";
  if (tags.includes("rush") || tags.includes("express")) {
    priority = "rush";
  } else if (tags.includes("priority") || tags.includes("high")) {
    priority = "high";
  }
  
  const items: ExtractedOrderItem[] = [];
  for (const lineItem of payload.line_items) {
    // Only import items that require shipping and have a SKU
    if (lineItem.requires_shipping === true && lineItem.sku && lineItem.sku.trim()) {
      items.push({
        shopifyLineItemId: String(lineItem.id),
        sku: lineItem.sku.trim().toUpperCase(),
        name: lineItem.name || lineItem.title,
        quantity: lineItem.quantity,
        imageUrl: lineItem.image?.src || undefined,
      });
    }
  }
  
  // Use payload.name (e.g., "#1234") if available, otherwise format order_number
  const orderNumber = payload.name 
    ? payload.name 
    : `#${payload.order_number}`;
  
  return {
    shopifyOrderId: String(payload.id),
    orderNumber,
    customerName,
    customerEmail: payload.email || payload.customer?.email || null,
    priority,
    items,
  };
}
