import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LISTING_SETTINGS_PAGE_SIZE,
  listingSettingsPricesInputSchema,
  listingSettingsProductsInputSchema,
  listingSettingsStoreInputSchema,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductsResponse,
  type ListingSettingsSummary,
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

describe("listing settings HTTP boundary", () => {
  let server: http.Server;
  let base: string;
  const getSummaryForMember = vi.fn(async (_member: string, input: unknown) => { listingSettingsStoreInputSchema.parse(input); return summary; });
  const listPricesForMember = vi.fn(async (_member: string, input: unknown) => pricesPage(listingSettingsPricesInputSchema.parse(input).page));
  const listProductsForMember = vi.fn(async (_member: string, input: unknown) => productsPage(listingSettingsProductsInputSchema.parse(input).page));

  beforeEach(async () => {
    for (const fn of [getSummaryForMember, listPricesForMember, listProductsForMember, logged.info, logged.warn, logged.error]) fn.mockClear();
    const app = express();
    app.use((req, _res, next) => {
      const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"];
      next();
    });
    registerDropshipListingSettingsRoutes(app, { getSummaryForMember, listPricesForMember, listProductsForMember });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const get = (path: string, member: string | null = "member-1") =>
    fetch(`${base}${path}`, { headers: member ? { "X-Test-Member": member } : {} });

  it.each(["/22/listing-settings/summary", "/22/listing-settings/prices", "/22/listing-settings/products"])(
    "requires a signed-in member for %s", async (path) => {
      expect((await get(path, null)).status).toBe(401);
      expect(getSummaryForMember).not.toHaveBeenCalled();
      expect(listPricesForMember).not.toHaveBeenCalled();
      expect(listProductsForMember).not.toHaveBeenCalled();
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

  it.each([
    ["a store id with letters", "/22oops/listing-settings/summary"],
    ["a store id in exponent form", "/2e1/listing-settings/summary"],
    ["a store id of 0", "/0/listing-settings/summary"],
    ["a store id beyond the integer column", "/2147483648/listing-settings/summary"],
    ["an unknown filter", "/22/listing-settings/prices?show=everything"],
    ["a page that is not a whole number", "/22/listing-settings/prices?page=1.5"],
    ["a page past the last", "/22/listing-settings/products?page=200"],
    ["a repeated search", "/22/listing-settings/products?search=a&search=b"],
    ["a search over 100 characters", `/22/listing-settings/products?search=${"x".repeat(101)}`],
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
    expect((await get("/22/listing-settings/summary", "member-2")).status).toBe(200);
  });
});
