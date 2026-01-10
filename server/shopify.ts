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
}

export interface ShopifyProduct {
  id: number;
  title: string;
  status: "active" | "draft" | "archived";
  variants: ShopifyVariant[];
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

export async function fetchAllShopifyProducts(): Promise<{ sku: string; name: string; status: string }[]> {
  const config = getShopifyConfig();
  const allSkus: { sku: string; name: string; status: string }[] = [];
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
      for (const variant of product.variants) {
        if (variant.sku && variant.sku.trim()) {
          const variantTitle = variant.title !== "Default Title" ? ` - ${variant.title}` : "";
          allSkus.push({
            sku: variant.sku.trim().toUpperCase(),
            name: `${product.title}${variantTitle}`,
            status: product.status,
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
