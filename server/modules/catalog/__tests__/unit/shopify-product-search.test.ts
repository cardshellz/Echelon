import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchShopifyProductsForSearch, getShopifyNextPageInfo } from "../../shopify-product-search";

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the Shopify variant-link search used to scan only the first page
// (250 products, oldest-first), so any SKU on a newer product was unfindable.
// These tests mock global fetch to prove the search now paginates past page 1
// and early-exits the moment the target SKU is found.
// ─────────────────────────────────────────────────────────────────────────────

const creds = { shopDomain: "card-shellz.myshopify.com", accessToken: "shpat_test", apiVersion: "2024-01" };

function makeResponse(products: any[], nextPageInfo?: string) {
  return {
    ok: true,
    json: async () => ({ products }),
    text: async () => "",
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "link" && nextPageInfo
          ? `<https://card-shellz.myshopify.com/admin/api/2024-01/products.json?limit=250&page_info=${nextPageInfo}>; rel="next"`
          : null,
    },
  } as any;
}

describe("fetchShopifyProductsForSearch", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("paginates past the first 250 to reach a SKU on a later page (the cap bug)", async () => {
    const page1 = Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, title: `p${i}`, variants: [{ id: 9000 + i, sku: `OLD-${i}` }] }));
    const page2 = [{ id: 10919489863839, title: "Slimloader", variants: [{ id: 62822781026463, sku: "SHLZ-TOP-TCG-BLU-SLIM-P25" }] }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse(page1, "PAGE2"))
      .mockResolvedValueOnce(makeResponse(page2));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchShopifyProductsForSearch(creds, 5000, "SHLZ-TOP-TCG-BLU-SLIM-P25");

    expect(fetchMock).toHaveBeenCalledTimes(2); // reached page 2
    expect(result.some((p) => p.variants.some((v: any) => v.sku === "SHLZ-TOP-TCG-BLU-SLIM-P25"))).toBe(true);
  });

  it("early-exits after the page containing the SKU (does not fetch further pages)", async () => {
    const page1 = [{ id: 1, title: "match", variants: [{ id: 11, sku: "TARGET" }] }];
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(page1, "PAGE2")); // a next page exists, but we should stop
    vi.stubGlobal("fetch", fetchMock);

    await fetchShopifyProductsForSearch(creds, 5000, "target"); // case-insensitive match

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops when there are no more pages even if the SKU is never found", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse([{ id: 1, variants: [{ id: 11, sku: "OTHER" }] }])); // no Link header
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchShopifyProductsForSearch(creds, 5000, "MISSING");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("honours the maxProducts ceiling", async () => {
    const page = Array.from({ length: 250 }, (_, i) => ({ id: i, variants: [] }));
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(page, "NEXT")); // always another page
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchShopifyProductsForSearch(creds, 250); // ceiling 250, no target
    expect(result).toHaveLength(250);
    expect(fetchMock).toHaveBeenCalledTimes(1); // hit ceiling after page 1
  });

  it("with no target, keeps paginating until pages are exhausted", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeResponse([{ id: 1, variants: [] }], "P2"))
      .mockResolvedValueOnce(makeResponse([{ id: 2, variants: [] }])); // no Link → last page
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchShopifyProductsForSearch(creds, 5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });
});

describe("getShopifyNextPageInfo", () => {
  it("extracts page_info from a rel=next Link header", () => {
    const link = `<https://x/admin/api/2024-01/products.json?limit=250&page_info=ABC123>; rel="next"`;
    expect(getShopifyNextPageInfo(link)).toBe("ABC123");
  });
  it("returns null when absent", () => {
    expect(getShopifyNextPageInfo(null)).toBeNull();
    expect(getShopifyNextPageInfo(`<https://x>; rel="previous"`)).toBeNull();
  });
});
