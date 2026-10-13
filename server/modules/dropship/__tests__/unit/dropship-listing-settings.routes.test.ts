import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LISTING_SETTINGS_PAGE_SIZE,
  listingSettingsCategoryInputSchema,
  listingSettingsPricesInputSchema,
  listingSettingsProductIdsInputSchema,
  listingSettingsProductInputSchema,
  listingSettingsProductsInputSchema,
  listingSettingsStoreInputSchema,
  type ListingSettingsCategoriesResponse,
  type ListingSettingsCategoryDetail,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductDetail,
  type ListingSettingsProductsResponse,
  type ListingSettingsSummary,
  type ListingSettingsValueSource,
} from "../../../../../shared/dropship/listing-settings";
import { DropshipError } from "../../domain/errors";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../../platform/observability/logger", () => ({ logger: logged }));
import {
  LISTING_SETTINGS_READS_PER_MINUTE,
  registerDropshipListingSettingsRoutes,
} from "../../interfaces/http/dropship-listing-settings.routes";

const GENERATED_AT = "2026-10-06T12:00:00.000Z";
const summary: ListingSettingsSummary = {
  storeConnectionId: 22, storeStatus: "connected", access: { allowed: true },
  catalog: { state: "ok", products: 0, sizes: 0 },
  storeDefaults: {
    price: { recipe: null, groupRules: 0 },
    shippingPolicy: { policyId: null, verification: "not_checked" },
    returnPolicy: { policyId: null, verification: "not_checked" },
    paymentPolicy: { policyId: null, verification: "not_checked" },
    ebayCategory: { category: null, groupRules: 0 },
    description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
  },
  counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
  attention: { items: [], total: 0 },
  rail: { state: "choose_policy", productsNeedingFix: 0, missingPolicy: "shipping" },
  generatedAt: GENERATED_AT,
};
const pricesPage = (page: number): ListingSettingsPricesResponse =>
  ({ storeConnectionId: 22, page, pageSize: LISTING_SETTINGS_PAGE_SIZE, total: 0, rows: [], generatedAt: GENERATED_AT });
const productsPage = (page: number): ListingSettingsProductsResponse =>
  ({ storeConnectionId: 22, page, pageSize: LISTING_SETTINGS_PAGE_SIZE, total: 0, rows: [], generatedAt: GENERATED_AT });
/** One value, from one place, for the one size. */
const only = <V>(value: V, source: ListingSettingsValueSource) => [{ value, sources: [{ source, ruleName: null, productVariantIds: [11] }] }];
const productDetail: ListingSettingsProductDetail = {
  storeConnectionId: 22,
  product: { productId: 501, productName: "Toploader 35pt", category: null, sizesChosen: 1, sizesTotal: 1, priceRange: null,
    exactPriceCount: 0, ownSettings: [], sizesDiffer: [], fixes: ["size_cannot_be_priced"] },
  settings: {
    shippingPolicy: only({ policyId: "F1" }, "store_default"),
    returnPolicy: only({ policyId: "R1" }, "store_default"),
    paymentPolicy: only({ policyId: null }, "none"),
    ebayCategory: only({ categoryId: "183438", categoryName: "Toploaders" }, "catalog"),
    storeShelf: only({ names: [] }, "none"),
    descriptionTemplate: only({ hasIntroduction: false, hasFooter: false, groupConflict: false }, "none"),
    mainText: only({ own: false }, "catalog"),
  },
  sizes: [{
    price: { productVariantId: 11, productId: 501, productName: "Toploader 35pt", sizeName: "Pack of 25", sku: null, priceCents: null,
      source: "none", rule: null, basis: null, basisAmountCents: null, issue: "price_unavailable", costCents: null,
      belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: null },
    fixes: ["size_cannot_be_priced"],
    stockUnits: 3,
  }],
  stock: { state: "ok", checkedAt: GENERATED_AT },
  generatedAt: GENERATED_AT,
};

const categoriesList: ListingSettingsCategoriesResponse = {
  storeConnectionId: 22,
  categories: [{ categoryId: 3, name: "Toploaders", productCount: 2, revisionId: 41, setFields: ["storeShelf"] }],
  uncategorizedProductCount: 1,
  generatedAt: GENERATED_AT,
};
const none = { source: "none", value: null } as const;
const categoryDetail: ListingSettingsCategoryDetail = {
  storeConnectionId: 22, categoryId: 3, name: "Toploaders", productCount: 2, revisionId: 41,
  settings: { price: none, ebayCategory: none, storeShelf: { source: "category", value: { mode: "none" } },
    shippingPolicy: { source: "store_default", value: { id: "F1", name: null } }, returnPolicy: none, paymentPolicy: none,
    textAbove: none, textBelow: none },
  ownValues: [{ productId: 501, revisionId: 7, fields: ["storeShelf"] }],
  examples: [productDetail.sizes[0].price],
  generatedAt: GENERATED_AT,
};

describe("listing settings HTTP boundary", () => {
  let server: http.Server;
  let base: string;
  const getSummaryForMember = vi.fn(async (_member: string, input: unknown) => { listingSettingsStoreInputSchema.parse(input); return summary; });
  const listPricesForMember = vi.fn(async (_member: string, input: unknown) => pricesPage(listingSettingsPricesInputSchema.parse(input).page));
  const listProductsForMember = vi.fn(async (_member: string, input: unknown) => productsPage(listingSettingsProductsInputSchema.parse(input).page));
  const getProductForMember = vi.fn(async (_member: string, input: unknown) => { listingSettingsProductInputSchema.parse(input); return productDetail; });
  const listProductIdsForMember = vi.fn(async (_member: string, input: unknown) => {
    listingSettingsProductIdsInputSchema.parse(input);
    return { total: 2, rows: [{ productId: 501, revisionId: 7 }, { productId: 502, revisionId: null }] };
  });
  const listCategoriesForMember = vi.fn(async (_member: string, input: unknown) => {
    listingSettingsStoreInputSchema.parse(input);
    return categoriesList;
  });
  const getCategoryForMember = vi.fn(async (_member: string, input: unknown) => {
    listingSettingsCategoryInputSchema.parse(input);
    return categoryDetail;
  });

  beforeEach(async () => {
    for (const fn of [getSummaryForMember, listPricesForMember, listProductsForMember, getProductForMember, listProductIdsForMember,
      listCategoriesForMember, getCategoryForMember, logged.info, logged.warn, logged.error]) fn.mockClear();
    const app = express();
    app.use((req, _res, next) => {
      const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"];
      next();
    });
    registerDropshipListingSettingsRoutes(app, { getSummaryForMember, listPricesForMember, listProductsForMember, getProductForMember,
      listProductIdsForMember, listCategoriesForMember, getCategoryForMember });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const get = (path: string, member: string | null = "member-1") =>
    fetch(`${base}${path}`, { headers: member ? { "X-Test-Member": member } : {} });

  it.each(["/22/listing-settings/summary", "/22/listing-settings/prices", "/22/listing-settings/products",
    "/22/listing-settings/products/501", "/22/listing-settings/products/ids", "/22/listing-settings/categories",
    "/22/listing-settings/categories/3"])(
    "requires a signed-in member for %s", async (path) => {
      expect((await get(path, null)).status).toBe(401);
      expect(listCategoriesForMember).not.toHaveBeenCalled();
      expect(getCategoryForMember).not.toHaveBeenCalled();
      expect(getSummaryForMember).not.toHaveBeenCalled();
      expect(listPricesForMember).not.toHaveBeenCalled();
      expect(listProductsForMember).not.toHaveBeenCalled();
      expect(getProductForMember).not.toHaveBeenCalled();
      expect(listProductIdsForMember).not.toHaveBeenCalled();
    });

  it("lists every matching product's id and settings revision, never cached, before the product route reads \"ids\" as an id", async () => {
    const response = await get("/22/listing-settings/products/ids?search=toploader&show=own_settings&categoryId=3&productId=501");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ total: 2, rows: [{ productId: 501, revisionId: 7 }, { productId: 502, revisionId: null }] });
    expect(listProductIdsForMember).toHaveBeenCalledWith("member-1",
      { storeConnectionId: 22, search: "toploader", show: "own_settings", categoryId: 3, productId: 501 });
    expect(getProductForMember).not.toHaveBeenCalled();
    expect((await get("/22/listing-settings/products/ids")).status).toBe(200);
    expect(listProductIdsForMember).toHaveBeenLastCalledWith("member-1", { storeConnectionId: 22, search: undefined, show: undefined });
  });

  it("answers 500 when the id list breaks its contract", async () => {
    listProductIdsForMember.mockResolvedValueOnce({ total: 3, rows: [{ productId: 501, revisionId: 7 }] });
    expect((await get("/22/listing-settings/products/ids")).status).toBe(500);
    listProductIdsForMember.mockResolvedValueOnce({ total: 2, rows: [{ productId: 501, revisionId: 7 }, { productId: 501, revisionId: 8 }] });
    expect((await get("/22/listing-settings/products/ids")).status).toBe(500);
  });

  it("maps a selection over 10,000 sizes on the id list to 422", async () => {
    listProductIdsForMember.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
      "More than 10,000 sizes are chosen for this store.", { storeConnectionId: 22 }));
    const response = await get("/22/listing-settings/products/ids");
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_TOO_LARGE");
  });

  it("passes a category filter on the Products and Prices tabs to the service", async () => {
    expect((await get("/22/listing-settings/products?categoryId=3")).status).toBe(200);
    expect(listProductsForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, search: undefined, show: undefined, page: undefined,
      categoryId: 3 });
    expect((await get("/22/listing-settings/prices?categoryId=5&page=1")).status).toBe(200);
    expect(listPricesForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, search: undefined, show: undefined, page: 1,
      categoryId: 5 });
  });

  it("lists the categories of the chosen products and gives one category's settings, never cached (plan 8.3)", async () => {
    const list = await get("/22/listing-settings/categories");
    expect(list.status).toBe(200);
    expect(list.headers.get("Cache-Control")).toBe("no-store");
    expect(await list.json()).toEqual(categoriesList);
    expect(listCategoriesForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22 });

    const one = await get("/22/listing-settings/categories/3");
    expect(one.status).toBe(200);
    expect(one.headers.get("Cache-Control")).toBe("no-store");
    expect(await one.json()).toEqual(categoryDetail);
    expect(getCategoryForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, categoryId: 3 });
  });

  it("maps a category with no chosen product to 404, logged with the category, and a selection over 10,000 sizes to 422", async () => {
    getCategoryForMember.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND",
      "None of this category's products is chosen for this store.", { storeConnectionId: 22, categoryId: 9 }));
    const missing = await get("/22/listing-settings/categories/9");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND",
      message: "None of this category's products is chosen for this store.", context: { storeConnectionId: 22 } } });
    expect(logged.info).toHaveBeenCalledWith("dropship.listing_settings.request_refused", expect.objectContaining({
      error_code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", status: 404, store_connection_id: 22, category_id: 9 }));

    for (const code of ["DROPSHIP_LISTING_SETTINGS_TOO_LARGE", "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY"]) {
      listCategoriesForMember.mockRejectedValueOnce(new DropshipError(code, "Controlled refusal.", { storeConnectionId: 22 }));
      getCategoryForMember.mockRejectedValueOnce(new DropshipError(code, "Controlled refusal.", { storeConnectionId: 22 }));
      expect((await get("/22/listing-settings/categories")).status).toBe(422);
      expect((await get("/22/listing-settings/categories/3")).status).toBe(422);
    }
  });

  it("answers 500 when a category answer breaks its contract", async () => {
    listCategoriesForMember.mockResolvedValueOnce({ ...categoriesList, categories: [...categoriesList.categories, ...categoriesList.categories] });
    expect((await get("/22/listing-settings/categories")).status).toBe(500);
    getCategoryForMember.mockResolvedValueOnce({ ...categoryDetail, revisionId: null });
    expect((await get("/22/listing-settings/categories/3")).status).toBe(500);
  });

  it("returns one product's settings, never cached by the browser", async () => {
    const response = await get("/22/listing-settings/products/501");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(productDetail);
    expect(getProductForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, productId: 501 });
  });

  it("maps a product with no chosen size to 404, logged with the product", async () => {
    getProductForMember.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND",
      "None of this product's sizes is chosen for this store.", { storeConnectionId: 22, productId: 999 }));
    const response = await get("/22/listing-settings/products/999");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND",
      message: "None of this product's sizes is chosen for this store.", context: { storeConnectionId: 22 } } });
    expect(logged.info).toHaveBeenCalledWith("dropship.listing_settings.request_refused", expect.objectContaining({
      error_code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", store_connection_id: 22, product_id: 999 }));
  });

  it("answers 500 when one product's settings disagree with its own row", async () => {
    getProductForMember.mockResolvedValueOnce({ ...productDetail, product: { ...productDetail.product, ownSettings: ["store_shelf"] } });
    expect((await get("/22/listing-settings/products/501")).status).toBe(500);
  });

  it("returns the summary, never cached by the browser, for the signed-in member", async () => {
    const response = await get("/22/listing-settings/summary");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(summary);
    expect(getSummaryForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22 });
  });

  it("passes the list query through to the service as the vendor sent it", async () => {
    expect((await get("/22/listing-settings/prices?search=sleeve&show=below_cost&page=2")).status).toBe(200);
    expect(listPricesForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, search: "sleeve", show: "below_cost", page: 2 });
    expect((await get("/22/listing-settings/products")).status).toBe(200);
    expect(listProductsForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, search: undefined, show: undefined, page: undefined });
  });

  it("passes the retail fallback filter through to the service (A3)", async () => {
    expect((await get("/22/listing-settings/prices?show=retail_fallback")).status).toBe(200);
    expect(listPricesForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, search: undefined, show: "retail_fallback", page: undefined });
  });

  it.each([
    ["a store id with letters", "/22oops/listing-settings/summary"],
    ["a store id in exponent form", "/2e1/listing-settings/summary"],
    ["a store id of 0", "/0/listing-settings/summary"],
    ["a store id beyond the integer column", "/2147483648/listing-settings/summary"],
    ["an unknown filter", "/22/listing-settings/prices?show=everything"],
    ["another unknown filter", "/22/listing-settings/prices?show=nope"],
    ["a price filter on the Products tab", "/22/listing-settings/products?show=retail_fallback"],
    ["a page that is not a whole number", "/22/listing-settings/prices?page=1.5"],
    ["a page past the last", "/22/listing-settings/products?page=200"],
    ["a repeated search", "/22/listing-settings/products?search=a&search=b"],
    ["a search over 100 characters", `/22/listing-settings/products?search=${"x".repeat(101)}`],
    ["a product id with letters", "/22/listing-settings/products/501x"],
    ["a product id of 0", "/22/listing-settings/products/0"],
    ["a product id beyond the integer column", "/22/listing-settings/products/2147483648"],
    ["a category id with letters on the Products tab", "/22/listing-settings/products?categoryId=3x"],
    ["a category id of 0 on the Prices tab", "/22/listing-settings/prices?categoryId=0"],
    ["a repeated category id", "/22/listing-settings/products?categoryId=3&categoryId=5"],
    ["a price filter on the id list", "/22/listing-settings/products/ids?show=retail_fallback"],
    ["a product id with letters on the id list", "/22/listing-settings/products/ids?productId=7a"],
    ["a category id past int4 on the id list", "/22/listing-settings/products/ids?categoryId=2147483648"],
    ["a category id with letters", "/22/listing-settings/categories/3x"],
    ["a category id of 0", "/22/listing-settings/categories/0"],
    ["a category id past int4", "/22/listing-settings/categories/2147483648"],
  ])("refuses %s with 400", async (_case, path) => {
    const response = await get(path);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
  });

  it.each([
    ["DROPSHIP_AUTH_REQUIRED", 401],
    ["DROPSHIP_STORE_CONNECTION_REQUIRED", 404],
    ["DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", 422],
    ["DROPSHIP_LISTING_SETTINGS_TOO_LARGE", 422],
  ])("maps %s to %s with the refusal's own words and the store id only", async (code, status) => {
    getSummaryForMember.mockRejectedValueOnce(new DropshipError(String(code), "Controlled refusal.", { storeConnectionId: 22, vendorId: 7 }));
    const response = await get("/22/listing-settings/summary");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: "Controlled refusal.", context: { storeConnectionId: 22 } } });
    expect(logged.info).toHaveBeenCalledWith("dropship.listing_settings.request_refused", expect.objectContaining({
      error_code: code, error_class: "permanent", store_connection_id: 22, actor_id: "member-1" }));
  });

  it("does not leak an internal failure, and logs it for a human", async () => {
    getSummaryForMember.mockRejectedValueOnce(new Error("secret connection string"));
    const response = await get("/22/listing-settings/summary");
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(logged.error).toHaveBeenCalledWith("dropship.listing_settings.request_failed", expect.objectContaining({
      error_code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", error_class: "fatal" }));
  });

  it("answers 500, not 400, when the service breaks its own contract", async () => {
    getSummaryForMember.mockResolvedValueOnce({ ...summary, counts: { ...summary.counts!, exactPrices: -1 } });
    expect((await get("/22/listing-settings/summary")).status).toBe(500);
  });

  it("limits each member to the read budget a minute", async () => {
    for (let index = 0; index < LISTING_SETTINGS_READS_PER_MINUTE; index += 1) {
      expect((await get("/22/listing-settings/summary")).status).toBe(200);
    }
    const limited = await get("/22/listing-settings/prices");
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_RATE_LIMITED");
    // One product's read, stock included, spends the same budget; so does the id list.
    expect((await get("/22/listing-settings/products/501")).status).toBe(429);
    expect((await get("/22/listing-settings/products/ids")).status).toBe(429);
    // The category reads too (plan P7: one read budget).
    expect((await get("/22/listing-settings/categories")).status).toBe(429);
    expect((await get("/22/listing-settings/categories/3")).status).toBe(429);
    expect((await get("/22/listing-settings/summary", "member-2")).status).toBe(200);
  });
});
