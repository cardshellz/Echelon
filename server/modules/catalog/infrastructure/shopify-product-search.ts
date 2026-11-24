// Shopify product catalog search helpers, used to find variant-link candidates.
//
// Extracted from catalog.routes so the pagination behaviour can be unit-tested
// without mounting the whole route module. The key behaviour lives in
// fetchShopifyProductsForSearch: Shopify's /products.json returns products
// oldest-first, so a bare first-page scan silently hides newer products. This
// paginates the full catalog (up to a safety ceiling) and early-exits the
// instant an exact SKU match is found.

export type ShopifyProductSearchResult = {
  id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  variants: any[];
};

export function getShopifyNextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
  return nextMatch?.[1] || null;
}

export async function fetchShopifyProductsForSearch(
  credentials: { shopDomain: string; accessToken: string; apiVersion: string },
  maxProducts: number,
  // When set (a SKU), stop paginating as soon as a variant with that exact SKU
  // is found. Shopify's /products.json returns products oldest-first, so newer
  // products sit on later pages — without paginating past the first page a
  // targeted SKU lookup silently misses them. Early-exit keeps the common case
  // fast while still reaching products beyond page 1.
  stopWhenSkuMatches?: string | null,
): Promise<ShopifyProductSearchResult[]> {
  const productsForSearch: ShopifyProductSearchResult[] = [];
  const target = stopWhenSkuMatches ? stopWhenSkuMatches.trim().toUpperCase() : null;
  let pageInfo: string | null = null;
  let matched = false;

  do {
    const path: string = pageInfo
      ? `/products.json?limit=250&page_info=${encodeURIComponent(pageInfo)}&fields=id,title,handle,status,variants`
      : "/products.json?limit=250&fields=id,title,handle,status,variants";
    const response = await fetch(`https://${credentials.shopDomain}/admin/api/${credentials.apiVersion}${path}`, {
      headers: {
        "X-Shopify-Access-Token": credentials.accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw Object.assign(new Error(`Shopify API error ${response.status}: ${body || response.statusText}`), {
        statusCode: response.status === 404 ? 404 : 502,
      });
    }

    const data = await response.json();
    for (const product of data?.products || []) {
      if (productsForSearch.length >= maxProducts) break;
      const variants = Array.isArray(product.variants) ? product.variants : [];
      productsForSearch.push({
        id: String(product.id),
        title: product.title || null,
        handle: product.handle || null,
        status: product.status || null,
        variants,
      });
      if (target && variants.some((v: any) => String(v?.sku ?? "").trim().toUpperCase() === target)) {
        matched = true;
      }
    }

    pageInfo = matched || productsForSearch.length >= maxProducts
      ? null
      : getShopifyNextPageInfo(response.headers.get("Link"));
  } while (pageInfo);

  return productsForSearch;
}
