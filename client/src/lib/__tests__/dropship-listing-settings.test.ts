import { afterEach, describe, expect, it, vi } from "vitest";
import { keepPreviousData } from "@tanstack/react-query";
import {
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductIdsResponseSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsUpdatedProductsResponseSchema,
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
  listingSettingsCategoriesQueryOptions,
  listingSettingsCategoryQueryOptions,
  listingSettingsPricesQueryOptions,
  listingSettingsProductIdsQueryOptions,
  listingSettingsProductOwnQueryOptions,
  listingSettingsProductQueryOptions,
  listingSettingsProductsQueryOptions,
  listingSettingsQueryKey,
  listingSettingsSummaryQueryOptions,
  listingSettingsUpdatedProductsQueryOptions,
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

describe("listing settings own settings query (the drawer's editors, PR 10)", () => {
  const ownSettings = listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: 22, productId: 11, revisionId: 5,
    own: {
      price: null, ebayCategory: null, storeShelf: null, shippingPolicy: { id: "F2", name: "Fast Free" }, returnPolicy: null,
      paymentPolicy: null, textAbove: { mode: "own", text: "Ships fast." }, textBelow: null, mainText: null,
    },
    generatedAt: GENERATED_AT,
  });

  it("reads one product's own settings under the store's prefix, fresh each time the drawer opens", async () => {
    const fetchMock = stubFetch(ownSettings);
    const options = listingSettingsProductOwnQueryOptions(22, 11);
    expect(options.queryKey).toEqual(["/api/dropship/listings/stores", 22, "listing-settings", "product-own", 11]);
    expect(options.queryKey.slice(0, 3)).toEqual(listingSettingsQueryKey(22));
    await expect(options.queryFn({ signal })).resolves.toEqual(ownSettings);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/products/11/own");
    expect(options).toMatchObject({ enabled: true, retry: false, staleTime: 0 });
    expect(options.queryKey).not.toEqual(listingSettingsProductQueryOptions(22, 11).queryKey);
  });

  it("runs only for a real product while the drawer is open", async () => {
    expect(listingSettingsProductOwnQueryOptions(22, 11, { enabled: false }).enabled).toBe(false);
    for (const productId of [0, -3, 1.5, Number.NaN, 2_147_483_648]) expect(listingSettingsProductOwnQueryOptions(22, productId).enabled).toBe(false);
    const fetchMock = stubFetch(ownSettings);
    await expect(listingSettingsProductOwnQueryOptions(22, 0).queryFn({ signal })).rejects.toMatchObject({
      code: LISTING_SETTINGS_INVALID_REQUEST, context: { read: "product-own" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an answer outside the strict contract, or for another store or product", async () => {
    for (const answer of [
      { ...ownSettings, categoryId: 40 },
      { ...ownSettings, own: { ...ownSettings.own, shippingPolicy: { id: "F2" } } },
      { ...ownSettings, revisionId: null },
      { ...ownSettings, productId: 12 },
      { ...ownSettings, storeConnectionId: 23 },
    ]) {
      stubFetch(answer);
      await expect(listingSettingsProductOwnQueryOptions(22, 11).queryFn({ signal })).rejects.toMatchObject({
        code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "product-own" },
      });
    }
  });

  it("passes the server's refusals on, for the drawer's read words", async () => {
    for (const [status, code] of [[404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND"], [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"], [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"]] as const) {
      stubFetch({ error: { code, message: "Refused." } }, status);
      await expect(listingSettingsProductOwnQueryOptions(22, 11).queryFn({ signal })).rejects.toBeInstanceOf(DropshipApiError);
      await expect(listingSettingsProductOwnQueryOptions(22, 11).queryFn({ signal })).rejects.toMatchObject({ status, code });
    }
  });
});

describe("listing settings product ids query (Set for selected, PR 10c, plan 6.4, D6)", () => {
  const ids = listingSettingsProductIdsResponseSchema.parse({ total: 2, rows: [{ productId: 11, revisionId: 5 }, { productId: 12, revisionId: null }] });

  it("reads every matching product's id and revision under the store's prefix, fresh each time the sheet opens", async () => {
    const fetchMock = stubFetch(ids);
    const options = listingSettingsProductIdsQueryOptions(22, {});
    expect(options.queryKey).toEqual(["/api/dropship/listings/stores", 22, "listing-settings", "product-ids", { search: "", show: "all" }]);
    expect(options.queryKey.slice(0, 3)).toEqual(listingSettingsQueryKey(22));
    await expect(options.queryFn({ signal })).resolves.toEqual(ids);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/products/ids?search=&show=all");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "include", signal });
    // Never kept once the sheet closes: the next opening reads afresh, so it never opens on an older answer.
    expect(options).toMatchObject({ enabled: true, retry: false, staleTime: 0, gcTime: 0 });
    // Never "products" pages or one product's detail: their own keys.
    expect(options.queryKey[3]).not.toBe("products");
    expect(options.queryKey).not.toEqual(listingSettingsProductQueryOptions(22, 11).queryKey);
  });

  it("encodes the search and the filter, keys by the trimmed request, and narrows by category or product when asked", async () => {
    const fetchMock = stubFetch(ids);
    const options = listingSettingsProductIdsQueryOptions(22, { search: "  top & \"load\" ", show: "needs_fix" });
    expect(options.queryKey[4]).toEqual({ search: "top & \"load\"", show: "needs_fix" });
    expect(listingSettingsProductIdsQueryOptions(22, { search: "top & \"load\"", show: "needs_fix" }).queryKey).toEqual(options.queryKey);
    await options.queryFn({ signal });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/products/ids?search=top+%26+%22load%22&show=needs_fix");
    const narrowed = listingSettingsProductIdsQueryOptions(22, { categoryId: 40, productId: 11 });
    expect(narrowed.queryKey[4]).toEqual({ search: "", show: "all", categoryId: 40, productId: 11 });
    await narrowed.queryFn({ signal });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/dropship/listings/stores/22/listing-settings/products/ids?search=&show=all&categoryId=40&productId=11");
  });

  it("runs only for a request inside the contract while the sheet is open", async () => {
    expect(listingSettingsProductIdsQueryOptions(22, {}, { enabled: false }).enabled).toBe(false);
    const fetchMock = stubFetch(ids);
    for (const [store, request] of [
      [0, {}], [22, { search: "x".repeat(101) }], [22, { show: "paused" as never }], [22, { categoryId: 0 }], [22, { productId: 1.5 }],
    ] as const) {
      const options = listingSettingsProductIdsQueryOptions(store, request);
      expect(options.enabled).toBe(false);
      await expect(options.queryFn({ signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_INVALID_REQUEST, context: { read: "product-ids" } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an answer outside the strict contract: a total that isn't the rows, a product twice, an extra key", async () => {
    for (const answer of [
      { total: 3, rows: ids.rows },
      { total: 2, rows: [{ productId: 11, revisionId: 5 }, { productId: 11, revisionId: 6 }] },
      { ...ids, generatedAt: GENERATED_AT },
      { total: 1, rows: [{ productId: 11, revisionId: 0 }] },
      { total: 1, rows: [{ productId: 11 }] },
    ]) {
      stubFetch(answer);
      await expect(listingSettingsProductIdsQueryOptions(22, {}).queryFn({ signal })).rejects.toMatchObject({
        code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "product-ids" },
      });
    }
  });

  it("passes the server's refusals on, for the sheet's read words and the too-large banner", async () => {
    for (const [status, code] of [[422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"], [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"], [404, "DROPSHIP_STORE_CONNECTION_REQUIRED"]] as const) {
      stubFetch({ error: { code, message: "Refused." } }, status);
      await expect(listingSettingsProductIdsQueryOptions(22, {}).queryFn({ signal })).rejects.toMatchObject({ status, code });
    }
  });
});

describe("listing settings updated-products query (Card Shellz updated products, PR 10g, plan 10.2, D10, D18)", () => {
  const updated = listingSettingsUpdatedProductsResponseSchema.parse({
    storeConnectionId: 22, page: 1, pageSize: 50, total: 51, generatedAt: GENERATED_AT,
    rows: [{ productId: 11, productName: "Easy Glide Soft Sleeves", ownTextNeedsCheck: false, move: { from: { categoryId: 40, name: "Sleeves" }, to: { categoryId: 41, name: "Toploaders" }, changedFields: ["price"] } }],
    moves: { total: 1, items: [{ productId: 11, shownCategoryId: 41 }] },
  });

  it("reads one page under the store's prefix, keyed by the page, a list read by default and fresh for the open sheet", async () => {
    const fetchMock = stubFetch(updated);
    const options = listingSettingsUpdatedProductsQueryOptions(22, 1);
    expect(options.queryKey).toEqual(["/api/dropship/listings/stores", 22, "listing-settings", "updated-products", 1]);
    expect(options.queryKey.slice(0, 3)).toEqual(listingSettingsQueryKey(22));
    await expect(options.queryFn({ signal })).resolves.toEqual(updated);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/updated-products?page=1");
    expect(options).toMatchObject({ enabled: true, retry: false, staleTime: 60_000 });
    expect(listingSettingsUpdatedProductsQueryOptions(22, 1, { fresh: true })).toMatchObject({ staleTime: 0, retry: false });
    expect(listingSettingsUpdatedProductsQueryOptions(22, 1, { fresh: true }).queryKey).toEqual(options.queryKey);
    expect(listingSettingsUpdatedProductsQueryOptions(22, 0).queryKey).not.toEqual(options.queryKey);
  });

  it("runs only for a real store and a page inside the contract, and only while enabled (too large, a closed sheet)", async () => {
    expect(listingSettingsUpdatedProductsQueryOptions(22, 0, { enabled: false }).enabled).toBe(false);
    for (const page of [-1, 1.5, 200, Number.NaN]) expect(listingSettingsUpdatedProductsQueryOptions(22, page).enabled).toBe(false);
    for (const store of [0, -3, 1.5]) expect(listingSettingsUpdatedProductsQueryOptions(store, 0).enabled).toBe(false);
    const fetchMock = stubFetch(updated);
    await expect(listingSettingsUpdatedProductsQueryOptions(22, 200).queryFn({ signal })).rejects.toMatchObject({
      code: LISTING_SETTINGS_INVALID_REQUEST, context: { read: "updated-products" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an answer outside the strict contract, or for another store or page", async () => {
    for (const answer of [
      { ...updated, extra: 1 },
      { ...updated, page: 0 },
      { ...updated, storeConnectionId: 23 },
      { ...updated, moves: { total: 2, items: updated.moves.items } },
      { ...updated, rows: [{ ...updated.rows[0], move: null }] },
      { ...updated, rows: [{ ...updated.rows[0], move: { ...updated.rows[0].move, to: { categoryId: 41, name: null } } }] },
      null,
    ]) {
      stubFetch(answer);
      await expect(listingSettingsUpdatedProductsQueryOptions(22, 1).queryFn({ signal })).rejects.toMatchObject({
        code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "updated-products" },
      });
    }
  });

  it("passes the server's refusals on, for the sheet's read words and the too-large banner (D18)", async () => {
    for (const [status, code] of [[422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"], [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"], [422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY"]] as const) {
      stubFetch({ error: { code, message: "Refused." } }, status);
      await expect(listingSettingsUpdatedProductsQueryOptions(22, 0).queryFn({ signal })).rejects.toMatchObject({ status, code });
    }
  });
});

describe("listing settings categories queries (the Category settings card and editor, PR 10e, plan 8.2, D6, D10, D18)", () => {
  const categories = listingSettingsCategoriesResponseSchema.parse({
    storeConnectionId: 22, generatedAt: GENERATED_AT, uncategorizedProductCount: 4,
    categories: [{ categoryId: 40, name: "Sleeves", productCount: 15, revisionId: 7, setFields: ["shippingPolicy"] }, { categoryId: 41, name: "Toploaders", productCount: 1, revisionId: null, setFields: [] }],
  });
  const detail = listingSettingsCategoryDetailSchema.parse({
    storeConnectionId: 22, categoryId: 40, name: "Sleeves", productCount: 15, revisionId: 7, generatedAt: GENERATED_AT, examples: [sizePrice],
    settings: {
      price: { source: "none", value: null }, ebayCategory: { source: "none", value: null }, storeShelf: { source: "store_default", value: { mode: "none" } },
      shippingPolicy: { source: "category", value: { id: "F2", name: "Fast Free" } }, returnPolicy: { source: "store_default", value: { id: "R1", name: null } },
      paymentPolicy: { source: "none", value: null }, textAbove: { source: "none", value: null }, textBelow: { source: "none", value: null },
    },
    ownValues: [{ productId: 11, revisionId: 5, fields: ["shippingPolicy"] }],
  });

  it("reads every category of the chosen products under the store's prefix, a list read at most a minute old", async () => {
    const fetchMock = stubFetch(categories);
    const options = listingSettingsCategoriesQueryOptions(22);
    expect(options.queryKey).toEqual(["/api/dropship/listings/stores", 22, "listing-settings", "categories"]);
    expect(options.queryKey.slice(0, 3)).toEqual(listingSettingsQueryKey(22));
    await expect(options.queryFn({ signal })).resolves.toEqual(categories);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/categories");
    expect(options).toMatchObject({ enabled: true, retry: false, staleTime: 60_000 });
    expect(listingSettingsCategoriesQueryOptions(22, { enabled: false }).enabled).toBe(false);
    for (const store of [0, -3, 1.5]) expect(listingSettingsCategoriesQueryOptions(store).enabled).toBe(false);
    await expect(listingSettingsCategoriesQueryOptions(0).queryFn({ signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_INVALID_REQUEST, context: { read: "categories" } });
  });

  it("reads one category fresh each time the editor opens, under its own key beside the product detail's", async () => {
    const fetchMock = stubFetch(detail);
    const options = listingSettingsCategoryQueryOptions(22, 40);
    expect(options.queryKey).toEqual(["/api/dropship/listings/stores", 22, "listing-settings", "category", 40]);
    expect(options.queryKey).not.toEqual(listingSettingsProductQueryOptions(22, 40).queryKey);
    await expect(options.queryFn({ signal })).resolves.toEqual(detail);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/dropship/listings/stores/22/listing-settings/categories/40");
    expect(options).toMatchObject({ enabled: true, retry: false, staleTime: 0 });
    expect(listingSettingsCategoryQueryOptions(22, 40, { enabled: false }).enabled).toBe(false);
    for (const categoryId of [0, -3, 1.5, Number.NaN, 2_147_483_648]) expect(listingSettingsCategoryQueryOptions(22, categoryId).enabled).toBe(false);
    fetchMock.mockClear();
    await expect(listingSettingsCategoryQueryOptions(22, 0).queryFn({ signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_INVALID_REQUEST, context: { read: "category" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses answers outside the strict contracts, or for another store or category", async () => {
    for (const answer of [
      { ...categories, extra: 1 }, { ...categories, storeConnectionId: 23 },
      { ...categories, categories: [{ ...categories.categories[0], revisionId: null }] },
      { ...categories, categories: [categories.categories[0], categories.categories[0]] },
      null,
    ]) {
      stubFetch(answer);
      await expect(listingSettingsCategoriesQueryOptions(22).queryFn({ signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "categories" } });
    }
    for (const answer of [
      { ...detail, extra: 1 }, { ...detail, storeConnectionId: 23 }, { ...detail, categoryId: 41 },
      { ...detail, revisionId: null },
      { ...detail, ownValues: [{ productId: 11, revisionId: 5, fields: [] }] },
      { ...detail, ownValues: [detail.ownValues[0], detail.ownValues[0]] },
      { ...detail, settings: { ...detail.settings, paymentPolicy: { source: "none", value: { id: "P1", name: null } } } },
      "ok",
    ]) {
      stubFetch(answer);
      await expect(listingSettingsCategoryQueryOptions(22, 40).queryFn({ signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "category" } });
    }
  });

  it("passes the server's refusals on, for the card's and the editor's words and the too-large banner (D18)", async () => {
    for (const [status, code] of [[422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"], [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"], [422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY"]] as const) {
      stubFetch({ error: { code, message: "Refused." } }, status);
      await expect(listingSettingsCategoriesQueryOptions(22).queryFn({ signal })).rejects.toMatchObject({ status, code });
    }
    for (const [status, code] of [[404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND"], [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"], [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"]] as const) {
      stubFetch({ error: { code, message: "Refused." } }, status);
      await expect(listingSettingsCategoryQueryOptions(22, 40).queryFn({ signal })).rejects.toBeInstanceOf(DropshipApiError);
      await expect(listingSettingsCategoryQueryOptions(22, 40).queryFn({ signal })).rejects.toMatchObject({ status, code });
    }
  });
});
