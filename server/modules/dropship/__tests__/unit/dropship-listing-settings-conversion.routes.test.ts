import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LISTING_RULES_CONVERSION_ERROR_CODES,
  listingRulesConversionCheckInputSchema,
  type ListingRulesConversionCheck,
  type ListingRulesConversionNoticeResponse,
} from "../../../../../shared/dropship/listing-rules-conversion";
import { listingSettingsStoreInputSchema, type ListingSettingsSummary } from "../../../../../shared/dropship/listing-settings";
import { checkRulesConversion, conversionCheckView } from "../../application/dropship-listing-rules-conversion";
import {
  DropshipListingSettingsService,
  conversionCostReadFailedError,
  type ListingSettingsConversionLoad,
  type ListingSettingsRepository,
} from "../../application/dropship-listing-settings-service";
import { DropshipError } from "../../domain/errors";
import {
  COST_PLUS_10, COST_PLUS_40, availableCost, byCategory, candidate, conversionInputs, listingInputs, pricingState,
} from "../fixtures/listing-rules-conversion.fixture";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../../platform/observability/logger", () => ({ logger: logged }));
import {
  LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE,
  LISTING_SETTINGS_READS_PER_MINUTE,
  registerDropshipListingSettingsRoutes,
} from "../../interfaces/http/dropship-listing-settings.routes";

/*
 * The rules conversion's dry run route (PR 11, plan 4.B.2): every status it
 * answers, its own budget beside the read budget, `no-store`, and the class
 * each failure is logged with. The service is a stub that parses the input
 * with the real schema; the answers are the 11a1 planner's own.
 */

const PATH = "/api/dropship/listings/stores/:storeConnectionId/listing-settings/conversion";
const GENERATED_AT = new Date("2026-10-15T09:30:00.000Z");

/** The Binders shape over two sizes (plan CMC#1): an unmatched category group, so both sizes change and the store is not clean. */
function bindersCheck(page = 0): ListingRulesConversionCheck {
  const candidates = [1_001, 1_002].map((productVariantId) => candidate({ productVariantId, productId: 501, category: "Binders" }));
  const inputs = conversionInputs(listingInputs(candidates, {
    pricing: pricingState([{ id: "binders", name: "Binders rule", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }],
      COST_PLUS_10),
    costs: new Map(candidates.map((row) => [row.productVariantId, availableCost(800)])),
  }));
  const { plan, diff } = checkRulesConversion(inputs);
  return conversionCheckView(plan, diff, page, GENERATED_AT);
}

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
  generatedAt: GENERATED_AT.toISOString(),
};

const unexpected = (name: string) => vi.fn(async (): Promise<never> => { throw new Error(`The conversion route reached ${name}.`); });

describe("listing settings HTTP boundary: the rules conversion's dry run (PR 11, plan 4.B.2)", () => {
  let server: http.Server;
  let base: string;
  const getConversionForMember = vi.fn(async (_member: string, input: unknown) =>
    bindersCheck(listingRulesConversionCheckInputSchema.parse(input).page));
  const getSummaryForMember = vi.fn(async (_member: string, input: unknown) => { listingSettingsStoreInputSchema.parse(input); return summary; });
  const others = {
    listPricesForMember: unexpected("the prices"), listProductsForMember: unexpected("the products"),
    listProductIdsForMember: unexpected("the product ids"), getProductForMember: unexpected("one product"),
    getProductOwnSettings: unexpected("a product's own settings"), listCategoriesForMember: unexpected("the categories"),
    getCategoryForMember: unexpected("one category"), listUpdatedProductsForMember: unexpected("the updated products"),
    getConversionNoticeForMember: unexpected("the conversion notice"),
  };

  beforeEach(async () => {
    for (const fn of [getConversionForMember, getSummaryForMember, ...Object.values(others), logged.info, logged.warn, logged.error]) {
      fn.mockClear();
    }
    const app = express();
    app.use((req, _res, next) => {
      const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"];
      next();
    });
    registerDropshipListingSettingsRoutes(app, { ...others, getSummaryForMember, getConversionForMember });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const get = (path: string, member: string | null = "member-1") =>
    fetch(`${base}${path}`, { headers: member ? { "X-Test-Member": member } : {} });

  it("answers the check for the signed-in member, never cached, a page at a time", async () => {
    const first = await get("/22/listing-settings/conversion");
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(first.headers.get("Retry-After")).toBeNull();
    expect(await first.json()).toEqual(bindersCheck(0));
    expect(getConversionForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, page: undefined });

    const second = await get("/22/listing-settings/conversion?page=3");
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ changes: { page: 3, total: 2, rows: [] } });
    expect(getConversionForMember).toHaveBeenLastCalledWith("member-1", { storeConnectionId: 22, page: 3 });
    expect([...logged.info.mock.calls, ...logged.warn.mock.calls, ...logged.error.mock.calls]).toEqual([]);
  });

  it("requires a signed-in member, before the budget or the service", async () => {
    for (let index = 0; index <= LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE; index += 1) {
      expect((await get("/22/listing-settings/conversion", null)).status).toBe(401);
    }
    expect(getConversionForMember).not.toHaveBeenCalled();
    // An anonymous caller spent no member's budget.
    expect((await get("/22/listing-settings/conversion")).status).toBe(200);
  });

  it.each([
    ["a page that is not a whole number", "/22/listing-settings/conversion?page=1.5"],
    ["a page past the last", "/22/listing-settings/conversion?page=200"],
    ["a negative page", "/22/listing-settings/conversion?page=-1"],
    ["a page in exponent form", "/22/listing-settings/conversion?page=1e1"],
    ["a repeated page", "/22/listing-settings/conversion?page=1&page=2"],
    ["a store id with letters", "/22oops/listing-settings/conversion"],
    ["a store id of 0", "/0/listing-settings/conversion"],
    ["a store id beyond the integer column", "/2147483648/listing-settings/conversion"],
  ])("refuses %s with 400, logged as a refusal", async (_case, path) => {
    const response = await get(path);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
    expect(logged.info).toHaveBeenCalledWith("dropship.listing_settings.request_refused", expect.objectContaining({
      status: 400, error_class: "permanent", path: PATH }));
  });

  it.each([
    ["DROPSHIP_AUTH_REQUIRED", 401],
    ["DROPSHIP_STORE_CONNECTION_REQUIRED", 404],
    ["DROPSHIP_LISTING_SETTINGS_TOO_LARGE", 422],
    ["DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", 422],
  ])("maps %s to %s with the refusal's own words and the store id only, logged as a refusal", async (code, status) => {
    getConversionForMember.mockRejectedValueOnce(new DropshipError(String(code), "Controlled refusal.", { storeConnectionId: 22, vendorId: 7 }));
    const response = await get("/22/listing-settings/conversion");
    expect(response.status).toBe(status);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({ error: { code, message: "Controlled refusal.", context: { storeConnectionId: 22 } } });
    expect(logged.info).toHaveBeenCalledWith("dropship.listing_settings.request_refused", expect.objectContaining({
      outcome: "failed", error_code: code, status, error_class: "permanent", store_connection_id: 22, actor_id: "member-1", path: PATH }));
    expect(logged.warn).not.toHaveBeenCalled();
    expect(logged.error).not.toHaveBeenCalled();
  });

  it("answers a cost read that timed out with 503 and Retry-After: 60, logged WARN as deferred, never as a request_failed ERROR", async () => {
    getConversionForMember.mockRejectedValueOnce(conversionCostReadFailedError(22, { stage: "variant_overrides", sqlState: "57014" }));
    const response = await get("/22/listing-settings/conversion?page=1");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable,
      message: "Prices from cost can't be checked right now. Try again in a minute.", context: { storeConnectionId: 22 } } });
    expect(logged.warn).toHaveBeenCalledTimes(1);
    expect(logged.warn).toHaveBeenCalledWith("dropship.listing_settings.request_deferred", expect.objectContaining({
      outcome: "deferred", error_code: LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable, status: 503, error_class: "transient",
      store_connection_id: 22, actor_id: "member-1", path: PATH, error_message: undefined }));
    expect(logged.error).not.toHaveBeenCalled();
    expect(logged.info).not.toHaveBeenCalled();
  });

  it("answers a cost read that failed for good with 500, logged as a fatal request_failed ERROR, with no Retry-After", async () => {
    getConversionForMember.mockRejectedValueOnce(conversionCostReadFailedError(22, { stage: "variant_overrides", sqlState: "42P01" }));
    const response = await get("/22/listing-settings/conversion");
    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect((await response.json()).error).toEqual({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      message: "Prices from cost can't be read for this store, so its older rules can't be checked.", context: { storeConnectionId: 22 } });
    expect(logged.error).toHaveBeenCalledWith("dropship.listing_settings.request_failed", expect.objectContaining({
      outcome: "failed", error_code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", status: 500, error_class: "fatal" }));
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["no wait", {}],
    ["a wait of 0", { retryAfterSeconds: 0 }],
    ["a wait as text", { retryAfterSeconds: "60" }],
    ["a wait past a minute", { retryAfterSeconds: 61 }],
  ])("sends no Retry-After for a transient 503 whose error names %s: the route invents none", async (_case, wait) => {
    getConversionForMember.mockRejectedValueOnce(new DropshipError(LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable,
      "Prices from cost can't be checked right now.", { storeConnectionId: 22, classification: "transient", retryable: true, ...wait }));
    const response = await get("/22/listing-settings/conversion");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(logged.warn).toHaveBeenCalledWith("dropship.listing_settings.request_deferred", expect.objectContaining({ error_class: "transient" }));
  });

  it("keeps a 503 code that does not say it is transient a fatal failure, with no Retry-After (only the error's own class is trusted)", async () => {
    getConversionForMember.mockRejectedValueOnce(new DropshipError(LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable,
      "Prices from cost can't be checked right now.", { storeConnectionId: 22 }));
    const response = await get("/22/listing-settings/conversion");
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(logged.error).toHaveBeenCalledWith("dropship.listing_settings.request_failed", expect.objectContaining({
      status: 503, error_class: "fatal" }));
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a clean state beside changed sizes", (check: ListingRulesConversionCheck) => ({ ...check, state: "clean" })],
    ["no plan hash for a store with older rules", (check: ListingRulesConversionCheck) => ({ ...check, planHash: null })],
    ["a page size other than 50", (check: ListingRulesConversionCheck) => ({ ...check, changes: { ...check.changes, pageSize: 10 } })],
    ["an unknown key", (check: ListingRulesConversionCheck) => ({ ...check, extra: true })],
  ])("answers 500, logged as a fatal request_failed ERROR, when the check breaks its contract: %s", async (_case, breakIt) => {
    getConversionForMember.mockResolvedValueOnce(breakIt(bindersCheck()) as ListingRulesConversionCheck);
    const response = await get("/22/listing-settings/conversion");
    expect(response.status).toBe(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
      message: "Listing settings could not be loaded. Please retry." } });
    expect(logged.error).toHaveBeenCalledWith("dropship.listing_settings.request_failed", expect.objectContaining({
      error_code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", status: 500, error_class: "fatal", path: PATH }));
  });

  it("answers 500 without leaking it when a stored profile no longer parses, and logs it for a human", async () => {
    // readPricingProfile's own failure (dropship-pricing-profile.reader.ts), as the summary gets it.
    getConversionForMember.mockRejectedValueOnce(new Error("Persisted pricing profile failed its contract."));
    const response = await get("/22/listing-settings/conversion");
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("Persisted");
    expect(logged.error).toHaveBeenCalledWith("dropship.listing_settings.request_failed", expect.objectContaining({
      error_code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", error_class: "fatal",
      error_message: "Persisted pricing profile failed its contract." }));
  });

  it("limits each member to 30 checks a minute on a budget of its own: the 31st is 429 while the summary still answers", async () => {
    expect(LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE).toBe(30);
    for (let index = 0; index < LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE; index += 1) {
      expect((await get(`/22/listing-settings/conversion?page=${index % 2}`)).status).toBe(200);
    }
    const limited = await get("/22/listing-settings/conversion");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED",
      message: "Too many listing settings requests. Try again in a minute." } });
    expect(getConversionForMember).toHaveBeenCalledTimes(LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE);
    // The read budget is the step's own and untouched by the checks; another member has a budget of their own.
    expect((await get("/22/listing-settings/summary")).status).toBe(200);
    expect((await get("/22/listing-settings/conversion", "member-2")).status).toBe(200);
  });

  it("holds one load at a time for a burst of 30 checks from one member, through the real service (review CS-1)", async () => {
    // The real read service over a repository whose loads the test settles, on a server of its own (the stub stays as it is).
    const loads: Array<(load: ListingSettingsConversionLoad) => void> = [];
    const repository: ListingSettingsRepository = {
      loadConversionInputs: async () => new Promise<ListingSettingsConversionLoad>((settle) => { loads.push(settle); }),
      readFingerprint: unexpected("the views' fingerprint"), load: unexpected("the views' load"),
      readProductOwnSettings: unexpected("a product's own settings"), readConversionNotice: unexpected("the conversion notice"),
    };
    const realService = new DropshipListingSettingsService({ repository,
      stock: { atp: { getVariantAtp: unexpected("stock") }, overrides: { listVariantOverrides: unexpected("stock caps") } },
      clock: { now: () => GENERATED_AT }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    const arrived = vi.fn();
    const app = express();
    app.use((req, _res, next) => { req.session = { dropship: { memberId: "member-1" } } as Request["session"]; next(); });
    registerDropshipListingSettingsRoutes(app, { ...others, getSummaryForMember, getConversionForMember: async (member, input) => {
      arrived();
      return realService.getConversionForMember(member, input);
    } });
    const burstServer = http.createServer(app);
    await new Promise<void>((resolve) => burstServer.listen(0, "127.0.0.1", resolve));
    const burstBase = `http://127.0.0.1:${(burstServer.address() as AddressInfo).port}/api/dropship/listings/stores`;
    const until = async (done: () => boolean) => {
      for (let wait = 0; !done() && wait < 400; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const candidates = [1_001, 1_002].map((productVariantId) => candidate({ productVariantId, productId: 501, category: "Binders" }));
    const binders: ListingSettingsConversionLoad = { state: "ok", costReadFailure: null, inputs: conversionInputs(listingInputs(candidates, {
      pricing: pricingState([{ id: "binders", name: "Binders rule", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }],
        COST_PLUS_10),
      costs: new Map(candidates.map((row) => [row.productVariantId, availableCost(800)])) })) };
    try {
      const burst = Array.from({ length: LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE }, (_, index) =>
        fetch(`${burstBase}/22/listing-settings/conversion?page=${index % 2}`));
      await until(() => arrived.mock.calls.length === burst.length);
      // Every check of the burst reached the service while the first load ran; none started a load of its own.
      expect(arrived).toHaveBeenCalledTimes(burst.length);
      expect(loads).toHaveLength(1);
      loads[0](binders);
      await until(() => loads.length === 2);
      expect(loads).toHaveLength(2);
      loads[1](binders);
      const responses = await Promise.all(burst);
      expect(responses.map((response) => response.status)).toEqual(burst.map(() => 200));
      expect(loads).toHaveLength(2);
      const bodies = await Promise.all(responses.map((response) => response.json() as Promise<ListingRulesConversionCheck>));
      expect(bodies.map((body) => body.changes.page)).toEqual(burst.map((_, index) => index % 2));
    } finally {
      for (const settle of loads) settle(binders);
      await new Promise<void>((resolve, reject) => burstServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("spends none of the check budget on the step's reads: a member over the read budget still checks", async () => {
    for (let index = 0; index < LISTING_SETTINGS_READS_PER_MINUTE; index += 1) {
      expect((await get("/22/listing-settings/summary")).status).toBe(200);
    }
    expect((await get("/22/listing-settings/summary")).status).toBe(429);
    expect((await get("/22/listing-settings/conversion")).status).toBe(200);
  });
});

describe("listing settings HTTP boundary: the one-time notice's read (11e1, plan 9.2)", () => {
  const NOTICE_PATH = "/api/dropship/listings/stores/:storeConnectionId/listing-settings/conversion/notice";
  let server: http.Server;
  let base: string;
  const answer: ListingRulesConversionNoticeResponse = { storeConnectionId: 22,
    notice: { conversionId: 41, convertedAt: GENERATED_AT.toISOString(), categoryCount: 2, productCount: 5 } };
  const getConversionNoticeForMember = vi.fn(async (_member: string, input: unknown): Promise<ListingRulesConversionNoticeResponse> => {
    listingSettingsStoreInputSchema.parse(input);
    return answer;
  });
  const getConversionForMember = vi.fn(async (_member: string, input: unknown) =>
    bindersCheck(listingRulesConversionCheckInputSchema.parse(input).page));
  const getSummaryForMember = vi.fn(async (_member: string, input: unknown) => { listingSettingsStoreInputSchema.parse(input); return summary; });
  const others = {
    listPricesForMember: unexpected("the prices"), listProductsForMember: unexpected("the products"),
    listProductIdsForMember: unexpected("the product ids"), getProductForMember: unexpected("one product"),
    getProductOwnSettings: unexpected("a product's own settings"), listCategoriesForMember: unexpected("the categories"),
    getCategoryForMember: unexpected("one category"), listUpdatedProductsForMember: unexpected("the updated products"),
  };

  beforeEach(async () => {
    for (const fn of [getConversionNoticeForMember, getConversionForMember, getSummaryForMember, logged.info, logged.warn, logged.error]) {
      fn.mockClear();
    }
    const app = express();
    app.use((req, _res, next) => {
      const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"];
      next();
    });
    registerDropshipListingSettingsRoutes(app, { ...others, getSummaryForMember, getConversionForMember, getConversionNoticeForMember });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const get = (path: string, member: string | null = "member-1") =>
    fetch(`${base}${path}`, { headers: member ? { "X-Test-Member": member } : {} });

  it("answers the store's notice for the signed-in member, never cached, and never reaches the dry run", async () => {
    const response = await get("/22/listing-settings/conversion/notice");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(answer);
    expect(getConversionNoticeForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22 });
    expect(getConversionForMember).not.toHaveBeenCalled();
    getConversionNoticeForMember.mockResolvedValueOnce({ storeConnectionId: 22, notice: null });
    expect(await (await get("/22/listing-settings/conversion/notice")).json()).toEqual({ storeConnectionId: 22, notice: null });
    expect([...logged.info.mock.calls, ...logged.warn.mock.calls, ...logged.error.mock.calls]).toEqual([]);
  });

  it("requires a signed-in member before the service, and refuses a bad store id with 400", async () => {
    expect((await get("/22/listing-settings/conversion/notice", null)).status).toBe(401);
    expect(getConversionNoticeForMember).not.toHaveBeenCalled();
    for (const path of ["/22oops/listing-settings/conversion/notice", "/0/listing-settings/conversion/notice"]) {
      const response = await get(path);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
    }
  });

  it.each([
    ["DROPSHIP_STORE_CONNECTION_REQUIRED", 404],
    ["DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", 422],
  ])("maps %s to %s with the store id only, logged as a refusal", async (code, status) => {
    getConversionNoticeForMember.mockRejectedValueOnce(new DropshipError(String(code), "Controlled refusal.", { storeConnectionId: 22, vendorId: 7 }));
    const response = await get("/22/listing-settings/conversion/notice");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: "Controlled refusal.", context: { storeConnectionId: 22 } } });
    expect(logged.info).toHaveBeenCalledWith("dropship.listing_settings.request_refused", expect.objectContaining({
      error_code: code, status, error_class: "permanent", store_connection_id: 22, path: NOTICE_PATH }));
  });

  it("answers a broken contract or an answer off its schema with 500, logged for a human (ERROR)", async () => {
    getConversionNoticeForMember.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "Not a notice.",
      { storeConnectionId: 22, conversionId: 41, classification: "fatal" }));
    expect((await get("/22/listing-settings/conversion/notice")).status).toBe(500);
    // An answer the service should never give: the route's schema refuses it, so the page is never shown it.
    getConversionNoticeForMember.mockResolvedValueOnce({ storeConnectionId: 22,
      notice: { ...answer.notice, actorType: "system" } } as unknown as ListingRulesConversionNoticeResponse);
    const offContract = await get("/22/listing-settings/conversion/notice");
    expect(offContract.status).toBe(500);
    expect((await offContract.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR");
    expect(logged.error).toHaveBeenCalledTimes(2);
    expect(logged.error).toHaveBeenLastCalledWith("dropship.listing_settings.request_failed", expect.objectContaining({
      status: 500, error_class: "fatal", path: NOTICE_PATH }));
  });

  it("reads on the step's read budget, not the dry run's: a member over the check budget still reads the notice", async () => {
    for (let index = 0; index < LISTING_SETTINGS_CONVERSION_CHECKS_PER_MINUTE; index += 1) {
      expect((await get("/22/listing-settings/conversion")).status).toBe(200);
    }
    expect((await get("/22/listing-settings/conversion")).status).toBe(429);
    expect((await get("/22/listing-settings/conversion/notice")).status).toBe(200);
    for (let index = 1; index < LISTING_SETTINGS_READS_PER_MINUTE; index += 1) {
      expect((await get("/22/listing-settings/summary")).status).toBe(200);
    }
    // The notice and the summary share the 120: the 121st read of the two is refused.
    const limited = await get("/22/listing-settings/conversion/notice");
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_RATE_LIMITED");
  });
});
