import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_LISTING_SETTINGS_PAGE,
  listingSettingsPricesResponseSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductRow,
  type ListingSettingsProductsResponse,
  type ListingSettingsSizePrice,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import {
  LISTING_SETTINGS_INVALID_REQUEST,
  ListingSettingsReadError,
  listingSettingsPricesQueryOptions,
  listingSettingsProductsQueryOptions,
  listingSettingsQueryKey,
} from "@/lib/dropship-listing-settings";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import {
  ListingSettingsTabs,
  initialListingSettingsTabsView,
  listingSettingsListsOff,
  listingSettingsTabLabels,
  reduceListingSettingsTabsView,
  searchText,
  type ListingSettingsTabsProps,
  type ListingSettingsTabsView,
} from "../listing-settings/ListingSettingsTabs";
import {
  LISTING_SETTINGS_LIST_WORDS,
  LIST_LOADING_ROWS,
  ProductsPageView,
  ProductsTab,
  hasPageAfter,
  isListTooLarge,
  listPageView,
  listPagesShown,
  listRangeWords,
  listReadProblem,
  matchWords,
  priceRangeWords,
  productShowCount,
  productShowLabel,
  productTarget,
  sizesCardWords,
  sizesCellWords,
  type ListPageActions,
  type ListingSettingsListView,
  type ProductShowChip,
  type ProductsTabProps,
} from "../listing-settings/ProductsTab";
import {
  PRICE_SHOW_OPTIONS,
  PricesTab,
  centsOrDash,
  priceNotes,
  sizeTarget,
  sizeTitle,
  type PriceShowOption,
  type PricesTabProps,
} from "../listing-settings/PricesTab";

const STORE = 22;
const GENERATED_AT = "2026-10-09T12:00:00.000Z";
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures, each checked against the shared contract so they are answers the server could give.
// ---------------------------------------------------------------------------

const SUMMARY: ListingSettingsSummary = listingSettingsSummarySchema.parse({
  storeConnectionId: STORE,
  storeStatus: "connected",
  access: { allowed: true },
  catalog: { state: "ok", products: 312, sizes: 1240 },
  storeDefaults: {
    price: { recipe: null, groupRules: 0 },
    shippingPolicy: { policyId: null, verification: "not_checked" },
    returnPolicy: { policyId: null, verification: "not_checked" },
    paymentPolicy: { policyId: null, verification: "not_checked" },
    ebayCategory: { category: null, groupRules: 0 },
    description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
  },
  counts: { productsNeedingFix: 1, productsWithSizesDiffer: 2, productsWithOwnSettings: 18, exactPrices: 12, belowCost: 3, cannotPrice: 1, paused: 1 },
  attention: { items: [], total: 0 },
  rail: { state: "products_need_fix", productsNeedingFix: 1, missingPolicy: null },
  generatedAt: GENERATED_AT,
});

const TOO_LARGE_SUMMARY: ListingSettingsSummary = listingSettingsSummarySchema.parse({
  ...SUMMARY,
  catalog: { state: "too_large", limit: 10_000 },
  counts: null,
  rail: { state: "too_many_sizes", productsNeedingFix: 0, missingPolicy: null },
});

function productRow(overrides: Partial<ListingSettingsProductRow>): ListingSettingsProductRow {
  return {
    productId: 1,
    productName: "A product",
    category: "Toploaders",
    sizesChosen: 1,
    sizesTotal: 1,
    priceRange: { minCents: 299, maxCents: 299 },
    exactPriceCount: 0,
    ownSettings: [],
    sizesDiffer: [],
    fixes: [],
    matchedSize: null,
    ...overrides,
  };
}

const TOPLOADER = productRow({
  productId: 11, productName: "Shellz Pro Toploader 35pt", sizesChosen: 3, sizesTotal: 3,
  priceRange: { minCents: 699, maxCents: 3999 }, fixes: ["no_ebay_category"],
});
const TEAM_BAGS = productRow({
  productId: 12, productName: "Team Bags 100 ct", sizesChosen: 2, sizesTotal: 4,
  priceRange: { minCents: 399, maxCents: 2999 }, ownSettings: ["shipping_policy"], sizesDiffer: ["shipping_policy"],
});
const EASY_GLIDE = productRow({
  productId: 13, productName: "Easy Glide Soft Sleeves", sizesChosen: 4, sizesTotal: 4,
  priceRange: { minCents: 499, maxCents: 4399 }, exactPriceCount: 1,
  matchedSize: { productVariantId: 101, sizeName: "Box of 5 Packs", sku: "EG-SLV-STD-5PCK-B500" },
});
const PENNY = productRow({ productId: 14, productName: "Penny Sleeves 100 ct" });
const UNPRICED = productRow({ productId: 15, productName: "Shellz Pro Case", priceRange: null, fixes: ["size_cannot_be_priced"] });

function productsAnswer(rows: ListingSettingsProductRow[], total: number, page = 0): ListingSettingsProductsResponse {
  return listingSettingsProductsResponseSchema.parse({ storeConnectionId: STORE, page, pageSize: 50, total, rows, generatedAt: GENERATED_AT });
}

function sizePrice(overrides: Partial<ListingSettingsSizePrice>): ListingSettingsSizePrice {
  return {
    productVariantId: 1,
    productId: 1,
    productName: "Easy Glide",
    sizeName: "Pack of 100",
    sku: "EG-SLV-STD-100",
    priceCents: 499,
    source: "exact",
    rule: null,
    basis: null,
    basisAmountCents: null,
    issue: null,
    costCents: 210,
    belowCostByCents: null,
    limits: [],
    pausedSince: null,
    settingRevisionId: 5,
    ...overrides,
  };
}

const STORE_DEFAULT_RULE = {
  kind: "store_default" as const,
  name: "Store default rule",
  recipe: { basis: "catalog_retail" as const, markupBps: 2000, flatCents: 0, rounding: "up_99" as const },
};

const EXACT = sizePrice({ productVariantId: 101, productId: 13, sizeName: "Box of 5 Packs", sku: "EG-SLV-STD-5PCK-B500", priceCents: 1499, costCents: 980 });
const STORE_DEFAULT = sizePrice({
  productVariantId: 102, productId: 13, source: "rules", rule: STORE_DEFAULT_RULE, basis: "catalog_retail", basisAmountCents: 399, settingRevisionId: null,
});
const BELOW_COST = sizePrice({
  productVariantId: 103, productId: 12, productName: "Team Bags", sizeName: "Case of 1,000", sku: "TB-100-CS1000", priceCents: 2199,
  source: "rules", rule: STORE_DEFAULT_RULE, basis: "catalog_retail", basisAmountCents: 1800, costCents: 2310, belowCostByCents: 111,
});
const NO_PRICE = sizePrice({
  productVariantId: 104, productId: 11, productName: "Shellz Pro", sizeName: "Case of 500", sku: "SP-TL35-CS500", priceCents: null,
  source: "none", basis: "catalog_retail", issue: "pricing_basis_unavailable", costCents: 3100,
});
const RETAIL_NO_RULE = sizePrice({
  productVariantId: 105, productId: 14, productName: "Penny Sleeves", sizeName: "Pack of 100", sku: null, priceCents: 1250,
  source: "retail_fallback", costCents: null,
});
const RETAIL_RULES_TIE = sizePrice({
  productVariantId: 106, productId: 14, productName: "Penny Sleeves", sizeName: "Box of 10", sku: "PS-B10", priceCents: 625,
  source: "retail_fallback", issue: "pricing_rule_priority_conflict",
});
const PAUSED = sizePrice({ productVariantId: 107, productId: 13, sizeName: "Single", sku: "EG-1", pausedSince: "2026-10-01T00:00:00.000Z" });

function pricesAnswer(rows: ListingSettingsSizePrice[], total: number, page = 0): ListingSettingsPricesResponse {
  return listingSettingsPricesResponseSchema.parse({ storeConnectionId: STORE, page, pageSize: 50, total, rows, generatedAt: GENERATED_AT });
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** renderToStaticMarkup escapes apostrophes; the tests read the text as the vendor does. */
function text(markup: string): string {
  return markup.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** Renders inside a query cache the test filled; `inspect` sees the cache before it is cleared. */
function render(node: React.ReactElement, client = newClient(), inspect?: (client: QueryClient) => void): string {
  vi.stubGlobal("React", React);
  try {
    const markup = renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/setup",
      children: React.createElement(QueryClientProvider, { client }, node) }));
    inspect?.(client);
    return text(markup);
  } finally {
    client.clear();
  }
}

/** A window whose `matchMedia` answers `wide` for every query (the phone layout is below 640 px). */
function stubWidth(wide: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: wide, media: query, addEventListener: noop, removeEventListener: noop }),
  });
}

function seedProducts(client: QueryClient, query: { search?: string; show?: ProductShowChip; page?: number }, answer: ListingSettingsProductsResponse) {
  client.setQueryData(listingSettingsProductsQueryOptions(STORE, query).queryKey, answer);
}

function seedPrices(client: QueryClient, query: { search?: string; show?: PriceShowOption; page?: number }, answer: ListingSettingsPricesResponse) {
  client.setQueryData(listingSettingsPricesQueryOptions(STORE, query).queryKey, answer);
}

function tabs(overrides: Partial<ListingSettingsTabsProps> = {}): React.ReactElement {
  return React.createElement(ListingSettingsTabs, {
    storeConnectionId: STORE, summary: SUMMARY, readOnly: false, onOpenProduct: noop, onGoToStep1: noop, ...overrides,
  });
}

function listView<Show extends string>(show: Show, overrides: Partial<ListingSettingsListView<Show>> = {}): ListingSettingsListView<Show> {
  return { searchInput: "", search: "", show, page: 0, pagesLoaded: 1, ...overrides };
}

const HANDLERS = {
  onSearchInput: noop, onClearSearch: noop, onShow: noop, onPage: noop, onLoadMore: noop, onOpenProduct: noop, onGoToStep1: noop,
};

function productsTab(overrides: Partial<ProductsTabProps> = {}): React.ReactElement {
  return React.createElement(ProductsTab, {
    ...HANDLERS, storeConnectionId: STORE, summary: SUMMARY, view: listView<ProductShowChip>("all"), compact: false, listsOff: false, ...overrides,
  });
}

function pricesTab(overrides: Partial<PricesTabProps> = {}): React.ReactElement {
  return React.createElement(PricesTab, {
    ...HANDLERS, storeConnectionId: STORE, view: listView<PriceShowOption>("all"), compact: false, listsOff: false, ...overrides,
  });
}

const ACTIONS: ListPageActions = { onRetry: noop, onClearSearch: noop, onShowAll: noop, onFirstPage: noop, onGoToStep1: noop };

/** The listing settings reads a render registered, by what follows the store prefix. */
function listReads(client: QueryClient): unknown[][] {
  const prefix = listingSettingsQueryKey(STORE);
  return client.getQueryCache().getAll()
    .map((query) => query.queryKey as unknown[])
    .filter((key) => prefix.every((part, index) => key[index] === part))
    .map((key) => key.slice(prefix.length));
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// The view: search, filter, page, tab
// ---------------------------------------------------------------------------

describe("reduceListingSettingsTabsView", () => {
  const start = initialListingSettingsTabsView();

  it("starts on Products, every product, first page, with nothing searched", () => {
    expect(start).toEqual({
      tab: "products",
      products: { searchInput: "", search: "", show: "all", page: 0, pagesLoaded: 1 },
      prices: { searchInput: "", search: "", show: "all", page: 0, pagesLoaded: 1 },
    });
  });

  it("switches tabs and keeps each list as it was", () => {
    const searched = reduceListingSettingsTabsView(start, { type: "apply_search", list: "products", search: "sleeve" });
    const prices = reduceListingSettingsTabsView(searched, { type: "tab", tab: "prices" });
    expect(prices.tab).toBe("prices");
    expect(prices.products).toBe(searched.products);
    expect(reduceListingSettingsTabsView(prices, { type: "tab", tab: "prices" })).toBe(prices);
  });

  it("holds typing in the box and searches only when typing pauses, from the first page", () => {
    const onPage3 = reduceListingSettingsTabsView(start, { type: "page", list: "products", page: 3 });
    const typed = reduceListingSettingsTabsView(onPage3, { type: "type_search", list: "products", value: "  toploader " });
    expect(typed.products).toMatchObject({ searchInput: "  toploader ", search: "", page: 3 });
    const applied = reduceListingSettingsTabsView(typed, { type: "apply_search", list: "products", search: typed.products.searchInput });
    expect(applied.products).toMatchObject({ searchInput: "  toploader ", search: "toploader", page: 0, pagesLoaded: 1 });
    // The same search after trimming asks for nothing new.
    expect(reduceListingSettingsTabsView(applied, { type: "apply_search", list: "products", search: "toploader  " })).toBe(applied);
    // The other list is untouched.
    expect(applied.prices).toBe(start.prices);
  });

  it("keeps a search to the contract's 100 characters", () => {
    const long = "x".repeat(140);
    const typed = reduceListingSettingsTabsView(start, { type: "type_search", list: "prices", value: long });
    expect(typed.prices.searchInput).toHaveLength(100);
    expect(searchText(`  ${"y".repeat(120)}`)).toHaveLength(100);
    expect(searchText("   ")).toBe("");
    expect(reduceListingSettingsTabsView(typed, { type: "type_search", list: "prices", value: long })).toBe(typed);
  });

  it("clears the search at once, and a clear with nothing to clear changes nothing", () => {
    const applied = reduceListingSettingsTabsView(
      reduceListingSettingsTabsView(start, { type: "type_search", list: "products", value: "bags" }),
      { type: "apply_search", list: "products", search: "bags" });
    const paged = reduceListingSettingsTabsView(applied, { type: "page", list: "products", page: 2 });
    const cleared = reduceListingSettingsTabsView(paged, { type: "clear_search", list: "products" });
    expect(cleared.products).toEqual({ searchInput: "", search: "", show: "all", page: 0, pagesLoaded: 1 });
    expect(reduceListingSettingsTabsView(cleared, { type: "clear_search", list: "products" })).toBe(cleared);
  });

  it("starts a list over when its filter changes, and changes nothing for the same filter", () => {
    const paged = reduceListingSettingsTabsView(
      reduceListingSettingsTabsView(start, { type: "load_more", list: "products" }),
      { type: "page", list: "products", page: 4 });
    const fix = reduceListingSettingsTabsView(paged, { type: "show_products", show: "needs_fix" });
    expect(fix.products).toMatchObject({ show: "needs_fix", page: 0, pagesLoaded: 1 });
    expect(reduceListingSettingsTabsView(fix, { type: "show_products", show: "needs_fix" })).toBe(fix);
    const fallback = reduceListingSettingsTabsView(start, { type: "show_prices", show: "retail_fallback" });
    expect(fallback.prices.show).toBe("retail_fallback");
    expect(fallback.products).toBe(start.products);
  });

  it("moves only to a page the contract has", () => {
    const page2 = reduceListingSettingsTabsView(start, { type: "page", list: "prices", page: 2 });
    expect(page2.prices.page).toBe(2);
    for (const bad of [-1, 1.5, Number.NaN, MAX_LISTING_SETTINGS_PAGE + 1]) {
      expect(reduceListingSettingsTabsView(page2, { type: "page", list: "prices", page: bad })).toBe(page2);
    }
    const last = reduceListingSettingsTabsView(start, { type: "page", list: "prices", page: MAX_LISTING_SETTINGS_PAGE });
    expect(last.prices.page).toBe(MAX_LISTING_SETTINGS_PAGE);
    expect(reduceListingSettingsTabsView(page2, { type: "page", list: "prices", page: 2 })).toBe(page2);
  });

  it("loads one more page on a phone, never past the contract's last page", () => {
    const more = reduceListingSettingsTabsView(start, { type: "load_more", list: "products" });
    expect(more.products.pagesLoaded).toBe(2);
    let view: ListingSettingsTabsView = start;
    for (let index = 0; index < MAX_LISTING_SETTINGS_PAGE + 5; index += 1) view = reduceListingSettingsTabsView(view, { type: "load_more", list: "products" });
    expect(view.products.pagesLoaded).toBe(MAX_LISTING_SETTINGS_PAGE + 1);
  });

  it("opens Products with the asked filter, clearing its search (the strip's See all)", () => {
    const elsewhere = reduceListingSettingsTabsView(
      reduceListingSettingsTabsView(
        reduceListingSettingsTabsView(start, { type: "tab", tab: "prices" }),
        { type: "type_search", list: "products", value: "bags" }),
      { type: "apply_search", list: "products", search: "bags" });
    const asked = reduceListingSettingsTabsView(elsewhere, { type: "request", show: "needs_fix" });
    expect(asked.tab).toBe("products");
    expect(asked.products).toEqual({ searchInput: "", search: "", show: "needs_fix", page: 0, pagesLoaded: 1 });
    expect(asked.prices).toBe(elsewhere.prices);
  });
});

describe("tab names and chip counts", () => {
  it("names the tabs with the summary's counts (R:589)", () => {
    expect(listingSettingsTabLabels(SUMMARY)).toEqual({ products: "Products · 312", prices: "Prices · 1,240 sizes" });
    const one = listingSettingsSummarySchema.parse({ ...SUMMARY, catalog: { state: "ok", products: 1, sizes: 1 } });
    expect(listingSettingsTabLabels(one)).toEqual({ products: "Products · 1", prices: "Prices · 1 size" });
  });

  it("leaves the counts out while the summary has none", () => {
    for (const summary of [null, undefined, TOO_LARGE_SUMMARY]) {
      expect(listingSettingsTabLabels(summary)).toEqual({ products: "Products", prices: "Prices" });
    }
  });

  it("counts products on the chips, and gives Exact prices no count because the summary counts sizes (G13)", () => {
    expect(productShowCount("all", SUMMARY)).toBe(312);
    expect(productShowCount("needs_fix", SUMMARY)).toBe(1);
    expect(productShowCount("sizes_differ", SUMMARY)).toBe(2);
    expect(productShowCount("own_settings", SUMMARY)).toBe(18);
    expect(productShowCount("exact_prices", SUMMARY)).toBeNull();
    expect(productShowLabel({ show: "all", label: "All" }, SUMMARY)).toBe("All 312");
    expect(productShowLabel({ show: "exact_prices", label: "Exact prices" }, SUMMARY)).toBe("Exact prices");
    expect(productShowLabel({ show: "needs_fix", label: "Needs a fix" }, TOO_LARGE_SUMMARY)).toBe("Needs a fix");
    expect(productShowLabel({ show: "all", label: "All" }, null)).toBe("All");
  });

  it("turns the lists off over 10,000 sizes, whether the step or the summary says so", () => {
    expect(listingSettingsListsOff({ readOnly: false, summary: SUMMARY })).toBe(false);
    expect(listingSettingsListsOff({ readOnly: true, summary: SUMMARY })).toBe(true);
    expect(listingSettingsListsOff({ readOnly: false, summary: TOO_LARGE_SUMMARY })).toBe(true);
    expect(listingSettingsListsOff({ readOnly: false, summary: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Words for one row
// ---------------------------------------------------------------------------

describe("row words", () => {
  it("writes sizes as '4' or '2 of 4' (R:551), and phone cards as '3 sizes'", () => {
    expect(sizesCellWords({ sizesChosen: 4, sizesTotal: 4 })).toBe("4");
    expect(sizesCellWords({ sizesChosen: 2, sizesTotal: 4 })).toBe("2 of 4");
    // A chosen size Card Shellz no longer offers never reads "3 of 2".
    expect(sizesCellWords({ sizesChosen: 3, sizesTotal: 2 })).toBe("3");
    expect(sizesCardWords({ sizesChosen: 3, sizesTotal: 3 })).toBe("3 sizes");
    expect(sizesCardWords({ sizesChosen: 1, sizesTotal: 1 })).toBe("1 size");
    expect(sizesCardWords({ sizesChosen: 2, sizesTotal: 4 })).toBe("2 of 4 sizes");
    expect(sizesCellWords({ sizesChosen: 1200, sizesTotal: 1500 })).toBe("1,200 of 1,500");
  });

  it("writes the price range from integer cents", () => {
    expect(priceRangeWords({ minCents: 699, maxCents: 3999 })).toBe("$6.99–$39.99");
    expect(priceRangeWords({ minCents: 299, maxCents: 299 })).toBe("$2.99");
    expect(priceRangeWords(null)).toBe("—");
    expect(centsOrDash(null)).toBe("—");
    expect(centsOrDash(1)).toBe("$0.01");
  });

  it("says which size a search matched, and opens there", () => {
    expect(matchWords(EASY_GLIDE.matchedSize)).toBe("Matches: Box of 5 Packs · EG-SLV-STD-5PCK-B500");
    expect(matchWords({ productVariantId: 9, sizeName: "Single", sku: null })).toBe("Matches: Single");
    expect(matchWords(null)).toBeNull();
    expect(productTarget(EASY_GLIDE)).toEqual({ productId: 13, productVariantId: 101 });
    expect(productTarget(TOPLOADER)).toEqual({ productId: 11 });
  });

  it("names the size, notes each price problem, and opens [Change] on that size", () => {
    expect(sizeTitle(EXACT)).toBe("Easy Glide · Box of 5 Packs");
    expect(priceNotes(EXACT)).toEqual([]);
    expect(priceNotes(BELOW_COST)).toEqual([{ tone: "warn", text: "! Below cost" }]);
    expect(priceNotes(NO_PRICE)).toEqual([{ tone: "stop", text: "● No price" }]);
    expect(priceNotes(PAUSED)).toEqual([{ tone: "warn", text: "Paused on eBay" }]);
    expect(sizeTarget(BELOW_COST)).toEqual({ productId: 12, productVariantId: 103 });
  });

  it("offers the Prices filters in the plan's words, retail fallback included (A3)", () => {
    expect(PRICE_SHOW_OPTIONS.map((option) => [option.show, option.label])).toEqual([
      ["all", "All"],
      ["exact_prices", "Exact price"],
      ["below_cost", "Below your cost"],
      ["cannot_price", "Can't be priced"],
      ["paused", "Paused on eBay"],
      ["retail_fallback", "Retail price, no store price"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pages: states, paging, failures
// ---------------------------------------------------------------------------

describe("list pages", () => {
  const asked = { search: "", show: "all" };
  const read = (data: ListingSettingsProductsResponse | undefined, error: unknown = null, isPlaceholderData = false) => ({ data, error, isPlaceholderData });

  it("is loading until a first answer comes", () => {
    expect(listPageView(read(undefined), asked)).toEqual({ kind: "loading" });
    // An empty page kept from the last search never names that search.
    expect(listPageView(read(productsAnswer([], 0), null, true), { search: "toploader", show: "all" })).toEqual({ kind: "loading" });
  });

  it("shows rows, and marks rows kept from the last page while the next loads", () => {
    const answer = productsAnswer([TOPLOADER], 312, 2);
    expect(listPageView(read(answer), asked)).toEqual({ kind: "rows", rows: [TOPLOADER], page: 2, total: 312, refreshing: false, notice: null });
    expect(listPageView(read(answer, null, true), asked)).toMatchObject({ kind: "rows", refreshing: true });
  });

  it("tells nothing chosen, no match and an empty filter apart", () => {
    expect(listPageView(read(productsAnswer([], 0)), asked)).toEqual({ kind: "nothing_chosen" });
    expect(listPageView(read(productsAnswer([], 0)), { search: "envlope", show: "needs_fix" })).toEqual({ kind: "no_match", search: "envlope" });
    expect(listPageView(read(productsAnswer([], 0)), { search: "", show: "needs_fix" })).toEqual({ kind: "none_shown" });
    expect(listPageView(read(productsAnswer([], 120, 4)), asked)).toEqual({ kind: "past_end" });
  });

  it("classifies a failed read: too large, too many, off the contract, anything else", () => {
    const tooLarge = new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "More than 10,000 sizes." });
    const rateLimited = new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Too many." });
    const offContract = new ListingSettingsReadError({ code: LISTING_SETTINGS_INVALID_REQUEST, message: "This list can't be checked as asked. Clear the search and try again.", context: {} });
    expect(listReadProblem(tooLarge)).toEqual({ kind: "too_large" });
    expect(listReadProblem(rateLimited)).toEqual({ kind: "rate_limited" });
    expect(listReadProblem(offContract)).toEqual({ kind: "failed", message: "This list can't be checked as asked. Clear the search and try again." });
    // A server message is never shown raw: a 500, another 422 and a dropped connection read the same.
    for (const other of [
      new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Listing settings could not be loaded. Please retry." }),
      new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", message: "Listing settings work for eBay stores only." }),
      new TypeError("Failed to fetch"),
    ]) {
      expect(listReadProblem(other)).toEqual({ kind: "failed", message: "Couldn't load this list. Try again." });
    }
    expect(listPageView(read(undefined, rateLimited), asked)).toEqual({ kind: "rate_limited" });
    expect(listPageView(read(productsAnswer([], 0), tooLarge), asked)).toEqual({ kind: "too_large" });
  });

  it("keeps rows on screen when a refresh fails, and says they may be out of date (no silent failure)", () => {
    const answer = productsAnswer([TOPLOADER], 1);
    expect(listPageView(read(answer, new DropshipApiError({ status: 429, message: "Too many." })), asked))
      .toMatchObject({ kind: "rows", notice: "Too many checks in a minute. Wait a moment and try again." });
    expect(listPageView(read(answer, new TypeError("Failed to fetch")), asked))
      .toMatchObject({ kind: "rows", notice: "Couldn't check this list again, so it may be out of date." });
    expect(listPageView(read(answer, new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "x" })), asked))
      .toMatchObject({ kind: "rows", notice: null });
  });

  it("tells the step about a list refused as too large, and about nothing else", () => {
    // The step shows the too-large banner from this refusal: the list shows nothing then (plan 4.4).
    expect(isListTooLarge(new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "x" }))).toBe(true);
    for (const other of [
      null,
      undefined,
      new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", message: "x" }),
      new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "x" }),
      new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "x" }),
      new TypeError("Failed to fetch"),
    ]) {
      expect(isListTooLarge(other), String(other)).toBe(false);
    }
  });

  it("reports a too-large refusal from both lists' pages, and the tabs pass the step's callback on", () => {
    // Effects don't run in a static render, so the wiring is checked on the source, as the page tests do.
    const read = (file: string) => readFileSync(join(process.cwd(), "client/src/pages/dropship/listing-settings", file), "utf8");
    for (const file of ["ProductsTab.tsx", "PricesTab.tsx"]) {
      expect(read(file).split("useReportListTooLarge(read.error, props.onTooLarge);").length - 1, file).toBe(1);
    }
    expect(read("ListingSettingsTabs.tsx")).toContain("onTooLarge: props.onTooLarge,");
  });

  it("writes paging as '1–50 of 312' and knows when another page follows", () => {
    expect(listRangeWords(0, 50, 312)).toBe("1–50 of 312");
    expect(listRangeWords(24, 40, 1240)).toBe("1,201–1,240 of 1,240");
    expect(hasPageAfter(0, 50, 312)).toBe(true);
    expect(hasPageAfter(6, 12, 312)).toBe(false);
    expect(hasPageAfter(0, 3, 3)).toBe(false);
    expect(hasPageAfter(MAX_LISTING_SETTINGS_PAGE, 50, 1_000_000)).toBe(false);
  });

  it("shows one page on a wide screen and every loaded page on a phone", () => {
    expect(listPagesShown({ page: 3, pagesLoaded: 2 }, false)).toEqual([3]);
    expect(listPagesShown({ page: 3, pagesLoaded: 3 }, true)).toEqual([0, 1, 2]);
    expect(listPagesShown({ page: 0, pagesLoaded: 0 }, true)).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// Rendered with data
// ---------------------------------------------------------------------------

describe("ListingSettingsTabs, rendered", () => {
  it("opens on Products and reads only its first page (plan 4.2), with counts on the tabs and chips", () => {
    const client = newClient();
    seedProducts(client, {}, productsAnswer([TOPLOADER, TEAM_BAGS, EASY_GLIDE, PENNY, UNPRICED], 312));
    let reads: unknown[][] = [];
    const markup = render(tabs(), client, (cache) => { reads = listReads(cache); });

    expect(reads).toEqual([["products", { search: "", show: "all", page: 0 }]]);
    expect(markup).toContain('data-testid="listing-settings-tabs"');
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Products · 312<\/button>/);
    expect(markup).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Prices · 1,240 sizes<\/button>/);
    expect(markup).toContain('placeholder="Search product, size or SKU"');
    expect(markup).toContain('maxLength="100"');
    // Chips with the summary's counts; Exact prices has none.
    for (const chip of ["All 312", "Needs a fix 1", "Sizes differ 2", "Own settings 18", "Exact prices"]) {
      expect(markup).toMatch(new RegExp(`aria-pressed="(true|false)"[^>]*>${chip}</button>`));
    }
    expect(markup).toMatch(/aria-pressed="true"[^>]*>All 312<\/button>/);
    expect(markup).not.toContain("No own settings");
    // The Prices tab is not mounted, so it reads nothing.
    expect(markup).not.toContain('data-testid="listing-settings-prices-tab"');
  });

  it("draws one row per product with sizes, price range, own settings and status (C15)", () => {
    const client = newClient();
    seedProducts(client, {}, productsAnswer([TOPLOADER, TEAM_BAGS, EASY_GLIDE, PENNY, UNPRICED], 312));
    const markup = render(tabs(), client);
    for (const column of ["Product", "Sizes", "Price", "Own settings", "Status"]) expect(markup).toContain(`<th scope="col" class="px-3 py-2">${column}</th>`);

    const row = (id: number) => markup.slice(markup.indexOf(`data-testid="listing-settings-product-${id}"`)).split("</tr>")[0];
    expect(row(11)).toContain("Shellz Pro Toploader 35pt");
    expect(row(11)).toContain("$6.99–$39.99");
    expect(row(11)).toContain("Needs a fix: no eBay category");
    expect(row(11)).toContain(">—<");
    expect(row(12)).toContain(">2 of 4<");
    expect(row(12)).toContain("Shipping policy");
    expect(row(12)).toContain("Sizes differ");
    expect(row(13)).toContain("1 exact price");
    expect(row(13)).toContain("Matches: Box of 5 Packs · EG-SLV-STD-5PCK-B500");
    expect(row(13)).toContain("No fixes needed");
    expect(row(14)).toContain("$2.99");
    expect(row(15)).toContain("Needs a fix: a size can't be priced");
    // "All set" is not said: step 3 still checks stock, photos and the wallet (C15).
    expect(markup).not.toContain("All set");
    // Paging.
    expect(markup).toContain("1–5 of 312");
    expect(markup).toContain(">Previous</button>");
    expect(markup).toContain(">Next</button>");
    expect(markup).not.toContain("Load more");
  });

  it("over 10,000 sizes reads no list, turns the controls off and leaves the words to the banner", () => {
    for (const props of [{ summary: TOO_LARGE_SUMMARY }, { readOnly: true }]) {
      let reads: unknown[][] = [];
      const markup = render(tabs(props), newClient(), (cache) => { reads = listReads(cache); });
      expect(reads).toEqual([]);
      expect(markup).toMatch(/<input[^>]*disabled=""[^>]*placeholder="Search product, size or SKU"/);
      expect(markup).not.toContain('data-testid="listing-settings-list-message"');
      expect(markup).not.toContain('data-testid="listing-settings-products-table"');
      expect(markup).not.toContain("listing-settings-list-loading");
    }
    expect(render(tabs({ summary: TOO_LARGE_SUMMARY }))).toMatch(/role="tab"[^>]*>Products<\/button>/);
  });

  it("on a phone, turns the chips into Show [All 312 ▾] and the rows into cards with Load more (C24)", () => {
    stubWidth(false);
    const client = newClient();
    seedProducts(client, {}, productsAnswer([TOPLOADER, TEAM_BAGS, EASY_GLIDE], 312));
    const markup = render(tabs(), client);
    expect(markup).not.toContain("aria-pressed");
    expect(markup).toMatch(/<label for="[^"]+">Show<\/label><select/);
    expect(markup).toContain('<option value="all" selected="">All 312</option>');
    expect(markup).toContain('<option value="needs_fix">Needs a fix 1</option>');
    expect(markup).toContain('<option value="exact_prices">Exact prices</option>');
    expect(markup).not.toContain("<table");
    expect(markup).toContain('data-testid="listing-settings-product-cards"');
    expect(markup).toContain("3 sizes · $6.99–$39.99");
    expect(markup).toContain("● Needs a fix: no eBay category");
    expect(markup).toContain("2 of 4 sizes · $3.99–$29.99");
    expect(markup).toContain("● Sizes differ");
    expect(markup).toContain("Own settings: Shipping policy");
    expect(markup).toContain("4 sizes · $4.99–$43.99");
    expect(markup).toContain(">No fixes needed<");
    expect(markup).toContain(">Load more</button>");
    expect(markup).not.toContain(">Next</button>");
  });

  it("on a phone, shows every loaded page and puts Load more after the last one only", () => {
    stubWidth(false);
    const client = newClient();
    seedProducts(client, {}, productsAnswer([TOPLOADER], 120, 0));
    seedProducts(client, { page: 1 }, productsAnswer([TEAM_BAGS], 120, 1));
    const markup = render(productsTab({ compact: true, view: listView<ProductShowChip>("all", { pagesLoaded: 2 }) }), client);
    expect(markup.indexOf("Shellz Pro Toploader 35pt")).toBeLessThan(markup.indexOf("Team Bags 100 ct"));
    expect(count(markup, ">Load more</button>")).toBe(1);
    expect(markup.lastIndexOf("Team Bags 100 ct")).toBeLessThan(markup.indexOf(">Load more</button>"));
  });
});

describe("Products tab states", () => {
  it("shows eight grey rows while the first page loads (R:497)", () => {
    const markup = render(productsTab());
    expect(markup).toContain('data-testid="listing-settings-list-loading"');
    expect(count(markup, "animate-pulse")).toBe(LIST_LOADING_ROWS);
  });

  it("with nothing chosen sends the vendor to step 1 (R:517)", () => {
    const client = newClient();
    seedProducts(client, {}, productsAnswer([], 0));
    const markup = render(productsTab(), client);
    expect(markup).toContain("No products chosen yet. Pick what to sell in step 1.");
    expect(markup).toContain(">Go to step 1</button>");
  });

  it("names the search that found nothing, with Clear search (R:522)", () => {
    const client = newClient();
    seedProducts(client, { search: "envlope" }, productsAnswer([], 0));
    const markup = render(productsTab({ view: listView<ProductShowChip>("all", { searchInput: "envlope", search: "envlope" }) }), client);
    expect(markup).toContain("No products match “envlope”.");
    expect(markup).toContain(">Clear search</button>");
    expect(markup).toContain('value="envlope"');
  });

  it("says a filter with nothing in it shows nothing, with Show all (interim)", () => {
    const client = newClient();
    seedProducts(client, { show: "needs_fix" }, productsAnswer([], 0));
    const markup = render(productsTab({ view: listView<ProductShowChip>("needs_fix") }), client);
    expect(markup).toContain("No products to show here.");
    expect(markup).toContain(">Show all</button>");
    expect(markup).toMatch(/aria-pressed="true"[^>]*>Needs a fix 1<\/button>/);
  });

  it("says too many checks with Try again, and shows nothing of its own for a 422 too large", () => {
    const actions = { ...ACTIONS };
    const page = (state: Parameters<typeof ProductsPageView>[0]["state"]) => render(React.createElement(ProductsPageView, {
      state, compact: false, last: true, actions, onPage: noop, onLoadMore: noop, onOpenProduct: noop,
    }));
    const limited = page({ kind: "rate_limited" });
    expect(limited).toContain(LISTING_SETTINGS_LIST_WORDS.rateLimited);
    expect(limited).toContain(">Try again</button>");
    expect(page({ kind: "too_large" })).toBe("");
    expect(page({ kind: "failed", message: "Couldn't load this list. Try again." })).toContain("Couldn't load this list. Try again.");
    expect(page({ kind: "past_end" })).toContain(">First page</button>");
    const stale = page({ kind: "rows", rows: [TOPLOADER], page: 0, total: 1, refreshing: true, notice: "Couldn't check this list again, so it may be out of date." });
    expect(stale).toContain('aria-busy="true"');
    expect(stale).toContain("Couldn't check this list again, so it may be out of date.");
    expect(stale).toContain("1–1 of 1");
    // One page of rows needs no Previous or Next.
    expect(stale).not.toContain(">Next</button>");
  });
});

describe("Prices tab", () => {
  const ROWS = [EXACT, STORE_DEFAULT, BELOW_COST, NO_PRICE, RETAIL_NO_RULE, RETAIL_RULES_TIE, PAUSED];

  it("reads its own list, and offers Show [All ▾] with the retail-fallback filter", () => {
    const client = newClient();
    seedPrices(client, {}, pricesAnswer(ROWS, 1240));
    let reads: unknown[][] = [];
    const markup = render(pricesTab(), client, (cache) => { reads = listReads(cache); });
    expect(reads).toEqual([["prices", { search: "", show: "all", page: 0 }]]);
    expect(markup).toMatch(/<label for="[^"]+">Show<\/label><select/);
    expect(markup).toContain('<option value="all" selected="">All</option>');
    expect(markup).toContain('<option value="retail_fallback">Retail price, no store price</option>');
    for (const column of ["Product · size", "Price", "Built from", "Your cost"]) expect(markup).toContain(`<th scope="col" class="px-3 py-2">${column}</th>`);
    expect(markup).toContain("1–7 of 1,240");
  });

  it("draws each size with its price, Built from words, cost, notes and [Change]", () => {
    const client = newClient();
    seedPrices(client, {}, pricesAnswer(ROWS, 7));
    const markup = render(pricesTab(), client);
    const row = (id: number) => markup.slice(markup.indexOf(`data-testid="listing-settings-size-${id}"`)).split("</tr>")[0];

    expect(row(101)).toContain("Easy Glide · Box of 5 Packs");
    expect(row(101)).toContain("EG-SLV-STD-5PCK-B500");
    expect(row(101)).toContain("$14.99");
    expect(row(101)).toContain("Exact price");
    expect(row(101)).toContain("$9.80");
    expect(row(101)).toContain('aria-label="Change Easy Glide · Box of 5 Packs"');
    expect(row(102)).toContain("Store default: retail $3.99 + 20%, up to .99");
    expect(row(103)).toContain("! Below cost");
    expect(row(103)).toContain("$23.10");
    expect(row(104)).toContain(">—<");
    expect(row(104)).toContain("Can't price: Card Shellz has no retail price for this size");
    expect(row(104)).toContain("● No price");
    expect(row(107)).toContain("Paused on eBay");
    // The rows never show a raw code (C10); the filter's option values are the only codes in the markup.
    const body = markup.slice(markup.indexOf("<tbody>"), markup.indexOf("</tbody>"));
    expect(body).not.toMatch(/pricing_|retail_fallback|catalog_retail|store_default|_price/);
  });

  it("explains a size on its retail price, with the fix only when no pricing rule covers it (A3, L1)", () => {
    const client = newClient();
    seedPrices(client, { show: "retail_fallback" }, pricesAnswer([RETAIL_NO_RULE, RETAIL_RULES_TIE], 2));
    const markup = render(pricesTab({ view: listView<PriceShowOption>("retail_fallback") }), client);
    const row = (id: number) => markup.slice(markup.indexOf(`data-testid="listing-settings-size-${id}"`)).split("</tr>")[0];
    expect(markup).toContain('<option value="retail_fallback" selected="">Retail price, no store price</option>');
    expect(row(105)).toContain("No pricing rule covers this size, so it uses the retail price ($12.50).");
    expect(row(105)).toContain("Set a store price or type a price.");
    expect(row(105)).toContain("$12.50");
    expect(row(106)).toContain("Your pricing rules can't price this size (two older group rules tie), so it uses the retail price ($6.25).");
    expect(row(106)).not.toContain("Set a store price or type a price.");
  });

  it("names a search with no sizes, and shows cards on a phone", () => {
    const client = newClient();
    seedPrices(client, { search: "zzz" }, pricesAnswer([], 0));
    const empty = render(pricesTab({ view: listView<PriceShowOption>("all", { searchInput: "zzz", search: "zzz" }) }), client);
    expect(empty).toContain("No sizes match “zzz”.");
    expect(empty).toContain(">Clear search</button>");

    const phone = newClient();
    seedPrices(phone, {}, pricesAnswer([EXACT, RETAIL_NO_RULE], 80));
    const cards = render(pricesTab({ compact: true }), phone);
    expect(cards).not.toContain("<table");
    expect(cards).toContain('data-testid="listing-settings-price-cards"');
    expect(cards).toContain("Your cost $9.80");
    expect(cards).toContain("Set a store price or type a price.");
    // An unknown cost is left out on a card.
    const retailCard = cards.slice(cards.indexOf('data-testid="listing-settings-size-105"'));
    expect(retailCard).not.toContain("Your cost");
    expect(count(cards, ">Change</button>")).toBe(2);
    expect(cards).toContain(">Load more</button>");
  });

  it("over 10,000 sizes reads nothing and turns its controls off", () => {
    let reads: unknown[][] = [];
    const markup = render(pricesTab({ listsOff: true }), newClient(), (cache) => { reads = listReads(cache); });
    expect(reads).toEqual([]);
    expect(markup).toMatch(/<select[^>]*disabled=""/);
    expect(markup).not.toContain("listing-settings-list-loading");
  });
});
