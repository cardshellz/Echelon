import { afterEach, describe, expect, it, vi } from "vitest";
import { keepPreviousData } from "@tanstack/react-query";
import {
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductsResponseSchema,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductDetail,
  type ListingSettingsProductsResponse,
  type ListingSettingsSizePrice,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  LISTING_SETTINGS_INVALID_REQUEST,
  LISTING_SETTINGS_OFF_CONTRACT,
  ListingSettingsReadError,
  listingSettingsPricesQueryOptions,
  listingSettingsProductQueryOptions,
  listingSettingsProductsQueryOptions,
  listingSettingsQueryKey,
  listingSettingsSummaryQueryOptions,
} from "../dropship-listing-settings";

const GENERATED_AT = "2026-10-07T12:00:00.000Z";

const summary: ListingSettingsSummary = {
  storeConnectionId: 22, storeStatus: "connected", access: { allowed: true },
  catalog: { state: "ok", products: 1, sizes: 2 },
  storeDefaults: {
    price: { recipe: null, groupRules: 0 },
    shippingPolicy: { policyId: "F1", verification: "not_checked" },
    returnPolicy: { policyId: "R1", verification: "not_checked" },
    paymentPolicy: { policyId: "P1", verification: "not_checked" },
    ebayCategory: { category: null, groupRules: 0 },
    description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
  },
  counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
  attention: { items: [], total: 0 },
  rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: null },
  generatedAt: GENERATED_AT,
};

const productsPage: ListingSettingsProductsResponse = listingSettingsProductsResponseSchema.parse({
  storeConnectionId: 22, page: 0, pageSize: 50, total: 1, generatedAt: GENERATED_AT,
  rows: [{
    productId: 11, productName: "Easy Glide Soft Sleeves", category: "Sleeves", sizesChosen: 1, sizesTotal: 2,
    priceRange: { minCents: 499, maxCents: 499 }, exactPriceCount: 0, ownSettings: [], sizesDiffer: [], fixes: [], matchedSize: null,
  }],
});

const sizePrice: ListingSettingsSizePrice = {
  productVariantId: 101, productId: 11, productName: "Easy Glide Soft Sleeves", sizeName: "Pack of 100", sku: "EG-100",
  priceCents: 1250, source: "retail_fallback", rule: null, basis: null, basisAmountCents: null, issue: null,
  costCents: 210, belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: 7,
};

const pricesPage: ListingSettingsPricesResponse = listingSettingsPricesResponseSchema.parse({
  storeConnectionId: 22, page: 2, pageSize: 50, total: 101, generatedAt: GENERATED_AT, rows: [sizePrice],
});

const storeDefault = (productVariantIds: number[]) => [{ source: "store_default" as const, ruleName: null, productVariantIds }];
const productDetail: ListingSettingsProductDetail = listingSettingsProductDetailSchema.parse({
  storeConnectionId: 22,
  product: {
    productId: 11, productName: "Easy Glide Soft Sleeves", category: "Sleeves", sizesChosen: 1, sizesTotal: 2,
    priceRange: { minCents: 1250, maxCents: 1250 }, exactPriceCount: 0, ownSettings: [], sizesDiffer: [], fixes: [],
  },
  settings: {
    shippingPolicy: [{ value: { policyId: "F1" }, sources: storeDefault([101]) }],
    returnPolicy: [{ value: { policyId: "R1" }, sources: storeDefault([101]) }],
    paymentPolicy: [{ value: { policyId: "P1" }, sources: storeDefault([101]) }],
    ebayCategory: [{ value: { categoryId: "261328", categoryName: "Card Sleeves" }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [101] }] }],
    storeShelf: [{ value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [101] }] }],
    descriptionTemplate: [{ value: { hasIntroduction: false, hasFooter: false, groupConflict: false }, sources: [{ source: "none", ruleName: null, productVariantIds: [101] }] }],
    mainText: [{ value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [101] }] }],
  },
  sizes: [{ price: sizePrice, fixes: [], stockUnits: 120 }],
  stock: { state: "ok", checkedAt: GENERATED_AT },
  generatedAt: GENERATED_AT,
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

const signal = new AbortController().signal;

describe("listing settings summary query", () => {
  it("reads one store's summary under the prefix every listing settings read shares", async () => {
    const fetchMock = stubFetch(summary);
    const options = listingSettingsSummaryQueryOptions(22);
    expect(options.queryKey.slice(0, 3)).toEqual([...listingSettingsQueryKey(22)]);
    await expect(options.queryFn({ signal })).resolves.toEqual(summary);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/summary");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include", signal });
  });

  it("refuses an answer outside the contract, so the rail says it couldn't check", async () => {
    stubFetch({ ...summary, rail: { ...summary.rail, state: "ready" } });
    await expect(listingSettingsSummaryQueryOptions(22).queryFn({ signal })).rejects.toThrow();
  });

  it("refuses an answer with a key the strict contract doesn't have, naming where, never the values", async () => {
    stubFetch({ ...summary, counts: { ...summary.counts, retailFallback: 3 } });
    const failure = await listingSettingsSummaryQueryOptions(22).queryFn({ signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ListingSettingsReadError);
    expect(failure).toMatchObject({ code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "summary" } });
    expect(JSON.stringify((failure as ListingSettingsReadError).context)).not.toContain("3");
  });

  it("passes the server's refusal on", async () => {
    stubFetch({ error: { code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", message: "Listing settings work for eBay stores only." } }, 422);
    await expect(listingSettingsSummaryQueryOptions(22).queryFn({ signal })).rejects.toThrow("Listing settings work for eBay stores only.");
  });

  it("asks only for a real store, and never retries out of sight", () => {
    expect(listingSettingsSummaryQueryOptions(0).enabled).toBe(false);
    expect(listingSettingsSummaryQueryOptions(22)).toMatchObject({ enabled: true, retry: false, staleTime: 60_000 });
  });
});

describe("listing settings Products query", () => {
  it("asks for the first page of every product by default, the read every step 2 visit makes", async () => {
    const fetchMock = stubFetch(productsPage);
    const options = listingSettingsProductsQueryOptions(22, {});
    await expect(options.queryFn({ signal })).resolves.toEqual(productsPage);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/products?search=&show=all&page=0");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include", signal });
  });

  it("encodes the search, the filter and the page", async () => {
    const fetchMock = stubFetch(productsPage);
    await listingSettingsProductsQueryOptions(22, { search: "  toploader \"35pt\" & more ", show: "needs_fix", page: 3 }).queryFn({ signal });
    const url = new URL(fetchMock.mock.calls[0][0], "https://portal.test");
    expect(url.pathname).toBe("/api/dropship/listings/stores/22/listing-settings/products");
    // The contract trims the search; the rest arrives exactly as typed.
    expect(Object.fromEntries(url.searchParams)).toEqual({ search: "toploader \"35pt\" & more", show: "needs_fix", page: "3" });
    expect(fetchMock.mock.calls[0][0]).toContain("search=toploader+%2235pt%22+%26+more&show=needs_fix&page=3");
  });

  it("keys each page under the store's prefix, with the trimmed search, so a refresh reaches every list", () => {
    const options = listingSettingsProductsQueryOptions(22, { search: "sleeves ", show: "own_settings", page: 1 });
    expect(options.queryKey).toEqual([...listingSettingsQueryKey(22), "products", { search: "sleeves", show: "own_settings", page: 1 }]);
    expect(listingSettingsProductsQueryOptions(22, { search: "sleeves" }).queryKey)
      .toEqual(listingSettingsProductsQueryOptions(22, { search: " sleeves  " }).queryKey);
    expect(listingSettingsProductsQueryOptions(22, { page: 1 }).queryKey).not.toEqual(listingSettingsProductsQueryOptions(22, { page: 2 }).queryKey);
  });

  it("keeps the last page on screen while the next one loads, and never retries out of sight", () => {
    expect(listingSettingsProductsQueryOptions(22, {})).toMatchObject({
      enabled: true, retry: false, staleTime: 60_000, placeholderData: keepPreviousData,
    });
  });

  it("runs only while the tab is shown and the request is inside the contract", async () => {
    expect(listingSettingsProductsQueryOptions(22, {}, { enabled: false }).enabled).toBe(false);
    expect(listingSettingsProductsQueryOptions(0, {}).enabled).toBe(false);
    expect(listingSettingsProductsQueryOptions(22, { page: -1 }).enabled).toBe(false);
    expect(listingSettingsProductsQueryOptions(22, { page: 1.5 }).enabled).toBe(false);
    expect(listingSettingsProductsQueryOptions(22, { page: 200 }).enabled).toBe(false);
    expect(listingSettingsProductsQueryOptions(22, { search: "x".repeat(101) }).enabled).toBe(false);
    expect(listingSettingsProductsQueryOptions(22, { search: `${"x".repeat(100)}   ` }).enabled).toBe(true);
    // `refetch()` runs a disabled read anyway, so the request is refused without a fetch.
    const fetchMock = stubFetch(productsPage);
    const failure = await listingSettingsProductsQueryOptions(22, { page: -1 }).queryFn({ signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: LISTING_SETTINGS_INVALID_REQUEST, context: { read: "products", fields: ["page"] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an answer outside the contract", async () => {
    stubFetch({ ...productsPage, pageSize: 25 });
    await expect(listingSettingsProductsQueryOptions(22, {}).queryFn({ signal })).rejects.toMatchObject({
      code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "products" },
    });
  });

  it("passes the server's refusal on, so the tab can show its too-large state", async () => {
    stubFetch({ error: { code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "Too many sizes." } }, 422);
    const failure = await listingSettingsProductsQueryOptions(22, {}).queryFn({ signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DropshipApiError);
    expect(failure).toMatchObject({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" });
  });
});

describe("listing settings Prices query", () => {
  it("asks for a page of sizes with the retail-fallback filter (A3)", async () => {
    const fetchMock = stubFetch(pricesPage);
    const options = listingSettingsPricesQueryOptions(22, { search: "pack of 100", show: "retail_fallback", page: 2 });
    await expect(options.queryFn({ signal })).resolves.toEqual(pricesPage);
    expect(fetchMock.mock.calls[0][0])
      .toBe("/api/dropship/listings/stores/22/listing-settings/prices?search=pack+of+100&show=retail_fallback&page=2");
    expect(options.queryKey).toEqual([...listingSettingsQueryKey(22), "prices", { search: "pack of 100", show: "retail_fallback", page: 2 }]);
    expect(options).toMatchObject({ enabled: true, retry: false, staleTime: 60_000, placeholderData: keepPreviousData });
  });

  it("keeps Products and Prices apart under the same prefix", () => {
    const products = listingSettingsProductsQueryOptions(22, {}).queryKey;
    const prices = listingSettingsPricesQueryOptions(22, {}).queryKey;
    expect(products.slice(0, 3)).toEqual(prices.slice(0, 3));
    expect(products[3]).toBe("products");
    expect(prices[3]).toBe("prices");
  });

  it("refuses a filter the contract doesn't have, an off-contract answer and passes a refusal on", async () => {
    // A value from outside the typed filter (an old URL, say) is never sent.
    const show = "store_default" as unknown as "all";
    expect(listingSettingsPricesQueryOptions(22, { show }).enabled).toBe(false);
    stubFetch({ ...pricesPage, rows: [{ ...sizePrice, source: "inherit" }] });
    await expect(listingSettingsPricesQueryOptions(22, {}).queryFn({ signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_OFF_CONTRACT });
    stubFetch({ error: { code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Too many listing settings requests. Try again in a minute." } }, 429);
    await expect(listingSettingsPricesQueryOptions(22, {}).queryFn({ signal })).rejects.toMatchObject({ status: 429 });
    expect(listingSettingsPricesQueryOptions(22, {}, { enabled: false }).enabled).toBe(false);
  });
});

describe("listing settings product query (the drawer)", () => {
  it("reads one product under the store's prefix", async () => {
    const fetchMock = stubFetch(productDetail);
    const options = listingSettingsProductQueryOptions(22, 11);
    expect(options.queryKey).toEqual([...listingSettingsQueryKey(22), "product", 11]);
    await expect(options.queryFn({ signal })).resolves.toEqual(productDetail);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/products/11");
    expect(options).toMatchObject({ enabled: true, retry: false, staleTime: 60_000 });
    expect(options).not.toHaveProperty("placeholderData");
  });

  it("runs only for a real product while the drawer is open", async () => {
    expect(listingSettingsProductQueryOptions(22, 11, { enabled: false }).enabled).toBe(false);
    for (const productId of [0, -3, 1.5, Number.NaN, 2_147_483_648]) {
      expect(listingSettingsProductQueryOptions(22, productId).enabled).toBe(false);
    }
    expect(listingSettingsProductQueryOptions(0, 11).enabled).toBe(false);
    const fetchMock = stubFetch(productDetail);
    await expect(listingSettingsProductQueryOptions(22, 0).queryFn({ signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_INVALID_REQUEST });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a detail whose sizes break the contract's own checks", async () => {
    stubFetch({ ...productDetail, sizes: [{ ...productDetail.sizes[0], stockUnits: null }] });
    await expect(listingSettingsProductQueryOptions(22, 11).queryFn({ signal })).rejects.toMatchObject({
      code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "product" },
    });
  });

  it("passes the not-chosen refusal on (C27)", async () => {
    stubFetch({ error: { code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", message: "That product isn't chosen." } }, 404);
    await expect(listingSettingsProductQueryOptions(22, 11).queryFn({ signal })).rejects.toMatchObject({
      status: 404, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND",
    });
  });
});
