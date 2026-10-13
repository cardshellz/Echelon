import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { saveProductSettingsInputSchema, saveSizePricesInputSchema } from "../../../../../shared/dropship/listing-setting-writes";
import { listingSettingStoreIdSchema, parseListingSettingInput } from "../../application/dropship-listing-setting-write-support";
import { DropshipError } from "../../domain/errors";
import type { ListingSettingWriteServices } from "../../infrastructure/dropship-listing-setting-writes.factory";
import { logger } from "../../../../platform/observability/logger";
import { installGlobalJsonBodyParser } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../infrastructure/dropship-listing-setting-writes.factory", () => ({ createDropshipListingSettingWriteServices: vi.fn() }));
vi.mock("../../../../platform/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
import { DROPSHIP_BULK_JSON_LIMIT_BYTES, LISTING_SETTINGS_TOO_LARGE_MESSAGE } from "../../interfaces/http/dropship-bulk-json.middleware";
import {
  LISTING_SETTING_BULK_WRITES_PER_MINUTE,
  LISTING_SETTING_SINGLE_WRITES_PER_MINUTE,
  registerDropshipListingSettingWritesRoutes,
} from "../../interfaces/http/dropship-listing-setting-writes.routes";

const KEY = "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const PATH = "/api/dropship/listings/stores/22/listing-settings/size-prices";
const row = (productVariantId: number, fields: Record<string, unknown> = {}) =>
  ({ productVariantId, priceCents: 1_499, expectedRevisionId: null, ...fields });
const body = (rows: unknown[]) => ({ idempotencyKey: KEY, rows });
const changed = { outcome: "changed", sizes: [{ productVariantId: 101, revisionId: 501, idempotentReplay: false }] };

class FakeSizePrices {
  calls: Array<{ memberId: string; storeId: unknown; input: unknown }> = [];
  failure: unknown = null;
  result: unknown = changed;
  /** Off: the route's parsing alone is under test, so the input is not checked. */
  validate = true;
  async saveForMember(memberId: string, storeId: unknown, input: unknown) {
    this.calls.push({ memberId, storeId, input });
    if (this.failure) throw this.failure;
    if (this.validate) {
      // The real service's parsing: the vendor's input is refused as DROPSHIP_LISTING_SETTINGS_INVALID_INPUT.
      parseListingSettingInput(listingSettingStoreIdSchema, storeId);
      parseListingSettingInput(saveSizePricesInputSchema, input);
    }
    return this.result;
  }
}

const PRODUCT_KEY = "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const PRODUCT_PATH = "/api/dropship/listings/stores/22/listing-settings/products/7";
const productBody = (fields: Record<string, unknown> = {}) =>
  ({ idempotencyKey: PRODUCT_KEY, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } }, ...fields });
const productChanged = { outcome: "changed", productId: 7, revisionId: 31, sizes: [], clearedSizeCount: 0 };

class FakeProducts {
  calls: Array<{ memberId: string; storeId: unknown; productId: unknown; input: unknown }> = [];
  failure: unknown = null;
  result: unknown = productChanged;
  async saveForMember(memberId: string, storeId: unknown, productId: unknown, input: unknown) {
    this.calls.push({ memberId, storeId, productId, input });
    if (this.failure) throw this.failure;
    // The real service's parsing: the vendor's input is refused as DROPSHIP_LISTING_SETTINGS_INVALID_INPUT.
    parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    parseListingSettingInput(listingSettingStoreIdSchema, productId);
    parseListingSettingInput(saveProductSettingsInputSchema, input);
    return this.result;
  }
}

describe("listing-settings write routes (plan PR 9, sections 3.2-3.5, 4.2)", () => {
  let sizePrices: FakeSizePrices;
  let server: { url: string; close: () => Promise<void> } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    sizePrices = new FakeSizePrices();
    server = null;
  });
  afterEach(async () => {
    await server?.close();
  });

  const put = (payload: unknown, options: { member?: string | null; path?: string; raw?: string } = {}) =>
    fetch(`${server!.url}${options.path ?? PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(options.member === null ? {} : { "X-Test-Member": options.member ?? "member-1" }) },
      body: options.raw ?? JSON.stringify(payload),
    });

  it("refuses a request without a dropship session before the service or the parser", async () => {
    server = await startServer(buildApp(sizePrices));
    const response = await put(body([row(101)]), { member: null });
    expect(response.status).toBe(401);
    expect(sizePrices.calls).toEqual([]);
  });

  it("passes the member, the parsed store id and the body through, and is never cached", async () => {
    server = await startServer(buildApp(sizePrices));
    const sent = body([row(101, { expectedRevisionId: 12 }), row(102)]);
    const response = await put(sent);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(changed);
    expect(sizePrices.calls).toEqual([{ memberId: "member-1", storeId: 22, input: sent }]);
  });

  it("parses 200 sizes, and refuses 201 with 400 and the issue path", async () => {
    server = await startServer(buildApp(sizePrices));
    const two = Array.from({ length: 200 }, (_, index) => row(index + 1));
    expect((await put(body(two))).status).toBe(200);
    const refused = await put(body([...two, row(201)]));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT",
      message: "Check the listing settings change and reload if the page is out of date.",
      context: { retryable: false, classification: "permanent", issues: [{ path: ["rows"], code: "too_big" }] } } });
  });

  it.each([
    ["a store id with letters", { path: "/api/dropship/listings/stores/22x/listing-settings/size-prices" }, body([row(101)])],
    ["a store id of 0", { path: "/api/dropship/listings/stores/0/listing-settings/size-prices" }, body([row(101)])],
    ["a store id past int4", { path: "/api/dropship/listings/stores/2147483648/listing-settings/size-prices" }, body([row(101)])],
    ["a 7-character key", {}, { idempotencyKey: "abcdefg", rows: [row(101)] }],
    ["no sizes", {}, body([])],
    ["the same size twice", {}, body([row(101), row(101)])],
    ["a zero price", {}, body([row(101, { priceCents: 0 })])],
    ["a fractional price", {}, body([row(101, { priceCents: 14.99 })])],
    ["an unknown key", {}, { ...body([row(101)]), storeConnectionId: 22 }],
  ])("answers %s with 400, never a 500", async (_label, options, payload) => {
    server = await startServer(buildApp(sizePrices));
    const response = await put(payload, options);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
  });

  it("answers a body that is not JSON with 400 before the service", async () => {
    server = await startServer(buildApp(sizePrices));
    const response = await put(undefined, { raw: "{\"idempotencyKey\":" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_REQUEST_JSON_INVALID", message: "The request body is not valid JSON." } });
    expect(sizePrices.calls).toEqual([]);
  });

  it("parses a body past the 100 KB global limit (10,000 ids) and hands it to the service unchanged", async () => {
    server = await startServer(buildApp(sizePrices));
    sizePrices.validate = false;
    const large = body(Array.from({ length: 10_000 }, (_, index) => row(2_000_000_000 + index, { expectedRevisionId: 2_000_000_000 + index })));
    const text = JSON.stringify(large);
    expect(text.length).toBeGreaterThan(100 * 1024);
    expect(text.length).toBeLessThan(DROPSHIP_BULK_JSON_LIMIT_BYTES);

    const response = await put(undefined, { raw: text });

    expect(response.status).toBe(200);
    expect(sizePrices.calls).toHaveLength(1);
    expect(sizePrices.calls[0].input).toEqual(large);
  });

  it("refuses a body over 1 MiB with 413 in the listing-settings words, never calling the service", async () => {
    server = await startServer(buildApp(sizePrices));
    const response = await put({ ...body([row(101)]), padding: "x".repeat(DROPSHIP_BULK_JSON_LIMIT_BYTES + 1) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_REQUEST_TOO_LARGE", message: LISTING_SETTINGS_TOO_LARGE_MESSAGE } });
    expect(LISTING_SETTINGS_TOO_LARGE_MESSAGE).toBe("This change is too large to send at once. Choose fewer products.");
    expect(sizePrices.calls).toEqual([]);
  });

  it.each([
    [new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "2 sizes' prices changed.", {
      storeConnectionId: 22, conflictCount: 2, retryable: false, classification: "permanent",
      conflicts: [{ productVariantId: 101, expectedRevisionId: null, actualRevisionId: 9, secret: "x" }] }), 409, {
      storeConnectionId: 22, conflictCount: 2, retryable: false, classification: "permanent",
      conflicts: [{ productVariantId: 101, expectedRevisionId: null, actualRevisionId: 9 }] }],
    [new DropshipError("DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "Outside the limits.", {
      storeConnectionId: 22, sizeCount: 1, sizes: [{ productVariantId: 102, priceCents: 250, blockers: ["pricing:below_floor:policy_5"] }],
      vendorId: 10 }), 422, {
      storeConnectionId: 22, sizeCount: 1, sizes: [{ productVariantId: 102, priceCents: 250, blockers: ["pricing:below_floor:policy_5"] }] }],
    [new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "Key used.", { storeConnectionId: 22, mismatched: ["size.requestHash"] }), 409,
      { storeConnectionId: 22 }],
    [new DropshipError("DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "Not available.", { productVariantId: 104 }), 404, { productVariantId: 104 }],
    [new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found."), 404, undefined],
    [new DropshipError("DROPSHIP_LISTING_STORE_BLOCKED", "Not available.", { storeConnectionId: 22, reason: "paused" }), 403,
      { storeConnectionId: 22, reason: "paused" }],
    [new DropshipError("DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", "eBay only.", { storeConnectionId: 22 }), 422, { storeConnectionId: 22 }],
  ])("answers %s with its status and the public context only", async (error, status, context) => {
    server = await startServer(buildApp(sizePrices));
    sizePrices.failure = error;
    const response = await put(body([row(101)]));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: error.code, message: error.message, ...(context ? { context } : {}) } });
  });

  it("answers a busy write with 503 and Retry-After", async () => {
    server = await startServer(buildApp(sizePrices));
    sizePrices.failure = new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Listing settings are being changed by another request. Try again.", {
      sqlState: "40P01", retryable: true, classification: "transient" });
    const response = await put(body([row(101)]));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      message: "Listing settings are being changed by another request. Try again.", context: { retryable: true, classification: "transient" } } });
  });

  it("hides internals on a 500: a plain error, a broken invariant and an answer that breaks its contract", async () => {
    // Never "Nothing was saved": the answer's own contract fails after the commit (plan 3.3, review round).
    const words = "Something went wrong. We couldn't confirm your save.";
    server = await startServer(buildApp(sizePrices));
    sizePrices.failure = new Error("pg connection string leaked");
    const crashed = await put(body([row(101)]));
    expect(crashed.status).toBe(500);
    const crashedBody = await crashed.json();
    expect(crashedBody).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: words } });

    sizePrices.failure = new DropshipError("DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "Partly recorded.", { storeConnectionId: 22,
      classification: "fatal" });
    const incomplete = await put(body([row(101)]));
    expect(incomplete.status).toBe(500);
    expect(await incomplete.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", message: words } });

    sizePrices.failure = null;
    sizePrices.result = { outcome: "changed", sizes: [{ productVariantId: 101, revisionId: 501, idempotentReplay: true }] };
    const broken = await put(body([row(101)]));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: words } });
  });

  it("answers a database that cannot be reached as 503 with Retry-After, logged at WARN", async () => {
    server = await startServer(buildApp(sizePrices));
    sizePrices.failure = new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Listing settings couldn't be reached right now. Try again in a few seconds.", {
      failure: "pool_acquire_timeout", retryable: true, classification: "transient" });
    const response = await put(body([row(101)]));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      message: "Listing settings couldn't be reached right now. Try again in a few seconds.",
      context: { retryable: true, classification: "transient" } } });
    expect(logger.warn).toHaveBeenCalledWith("dropship.listing_settings.write_deferred", expect.objectContaining({ status: 503 }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a refusal at DEBUG, a retryable failure at WARN and a broken contract at ERROR, with the store and member", async () => {
    server = await startServer(buildApp(sizePrices));
    const correlation = { store_connection_id: 22, actor_id: "member-1", method: "PUT",
      path: "/api/dropship/listings/stores/:storeConnectionId/listing-settings/size-prices" };

    sizePrices.failure = new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "Changed.", { classification: "permanent" });
    expect((await put(body([row(101)]))).status).toBe(409);
    expect(logger.debug).toHaveBeenCalledWith("dropship.listing_settings.write_refused", expect.objectContaining({
      ...correlation, outcome: "refused", error_code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", error_class: "permanent", status: 409 }));

    sizePrices.failure = new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Busy.", { classification: "transient" });
    expect((await put(body([row(101)]))).status).toBe(503);
    expect(logger.warn).toHaveBeenCalledWith("dropship.listing_settings.write_deferred", expect.objectContaining({
      ...correlation, outcome: "deferred", error_code: "DROPSHIP_LISTING_SETTINGS_BUSY", error_class: "transient", status: 503 }));

    sizePrices.failure = new Error("unexpected");
    expect((await put(body([row(101)]))).status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith("dropship.listing_settings.write_failed", expect.objectContaining({
      ...correlation, outcome: "failed", error_code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", error_class: "fatal", status: 500,
      error_message: "unexpected", error_context: null }));

    // A fatal DropshipError's own context reaches the ERROR line (never the answer).
    sizePrices.failure = new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "A stored row failed its contract.", {
      source: "size", column: "request_hash", retryable: false, classification: "fatal" });
    const invariant = await put(body([row(101)]));
    expect(invariant.status).toBe(500);
    expect(JSON.stringify(await invariant.json())).not.toContain("request_hash");
    expect(logger.error).toHaveBeenLastCalledWith("dropship.listing_settings.write_failed", expect.objectContaining({
      error_code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      error_message: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED: A stored row failed its contract.",
      error_context: { source: "size", column: "request_hash", retryable: false, classification: "fatal" } }));
    // Refusals are never logged as INFO or WARN.
    expect(logger.info).not.toHaveBeenCalled();
    expect(vi.mocked(logger.warn).mock.calls.map((call) => call[0])).toEqual(["dropship.listing_settings.write_deferred"]);
  });

  it("limits each member to the bulk budget a minute; another member is unaffected", async () => {
    server = await startServer(buildApp(sizePrices));
    expect(LISTING_SETTING_BULK_WRITES_PER_MINUTE).toBe(30);
    for (let index = 0; index < LISTING_SETTING_BULK_WRITES_PER_MINUTE; index += 1) {
      expect((await put(body([row(101)]))).status).toBe(200);
    }
    const limited = await put(body([row(101)]));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED",
      message: "Too many saves in a minute. Wait a moment and try again." } });
    expect(sizePrices.calls).toHaveLength(LISTING_SETTING_BULK_WRITES_PER_MINUTE);
    expect((await put(body([row(101)]), { member: "member-2" })).status).toBe(200);
  });

  it("answers a ZodError from inside the operation as a broken contract (500, ERROR), never as the vendor's input", async () => {
    server = await startServer(buildApp(sizePrices));
    sizePrices.failure = new ZodError([{ code: "too_small", path: ["rulePriceCents"], message: "received 0", minimum: 1, inclusive: true,
      type: "number" }]);
    const response = await put(body([row(101)]));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
      message: "Something went wrong. We couldn't confirm your save." } });
    expect(logger.error).toHaveBeenCalledWith("dropship.listing_settings.write_failed", expect.objectContaining({
      error_class: "fatal", error_context: { issues: [{ path: ["rulePriceCents"], code: "too_small" }] } }));
  });
});

describe("PUT …/listing-settings/products/:productId (W5, plan PR 9, section 6.3)", () => {
  let sizePrices: FakeSizePrices;
  let products: FakeProducts;
  let server: { url: string; close: () => Promise<void> } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    sizePrices = new FakeSizePrices();
    products = new FakeProducts();
    server = null;
  });
  afterEach(async () => {
    await server?.close();
  });

  const put = (payload: unknown, options: { member?: string | null; path?: string; raw?: string } = {}) =>
    fetch(`${server!.url}${options.path ?? PRODUCT_PATH}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(options.member === null ? {} : { "X-Test-Member": options.member ?? "member-1" }) },
      body: options.raw ?? JSON.stringify(payload),
    });

  it("refuses a request without a dropship session before the limiter, the parser or the service", async () => {
    server = await startServer(buildApp(sizePrices, products));
    const response = await put(productBody(), { member: null });
    expect(response.status).toBe(401);
    expect(products.calls).toEqual([]);
  });

  it("passes the member, the parsed store and product ids and the body through, answers the schema's shape, never cached", async () => {
    server = await startServer(buildApp(sizePrices, products));
    const sent = productBody({ patch: { price: { basis: "product_cost", markupBps: 3_000, flatCents: 0, rounding: "cent" } },
      sizePrices: [{ productVariantId: 101, pricingMode: "inherit", expectedRevisionId: 4 }],
      expectedPrices: [{ productVariantId: 101, priceCents: 1_499 }] });
    const response = await put(sent);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(productChanged);
    expect(products.calls).toEqual([{ memberId: "member-1", storeId: 22, productId: 7, input: sent }]);
    expect(sizePrices.calls).toEqual([]);
  });

  it.each([
    ["a product id with letters", { path: "/api/dropship/listings/stores/22/listing-settings/products/7x" }, productBody()],
    ["a product id of 0", { path: "/api/dropship/listings/stores/22/listing-settings/products/0" }, productBody()],
    ["a product id past int4", { path: "/api/dropship/listings/stores/22/listing-settings/products/2147483648" }, productBody()],
    ["a 7-character key", {}, productBody({ idempotencyKey: "abcdefg" })],
    ["no change at all", {}, productBody({ patch: {} })],
    ["an eBay category name sent by the client", {}, productBody({ patch: { ebayCategory: { categoryId: "183438", categoryName: "X" } } })],
    ["a price change without the shown prices", {}, productBody({ patch: { price: null } })],
    ["an unknown key", {}, { ...productBody(), storeConnectionId: 22 }],
  ])("answers %s with 400, never a 500", async (_label, options, payload) => {
    server = await startServer(buildApp(sizePrices, products));
    const response = await put(payload, options);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVALID_INPUT");
  });

  it("parses a body past the 100 KB global limit (10,000 shown prices) and hands it to the service unchanged", async () => {
    server = await startServer(buildApp(sizePrices, products));
    const large = productBody({ patch: { price: null }, expectedPrices: Array.from({ length: 10_000 },
      (_, index) => ({ productVariantId: 2_000_000_000 + index, priceCents: 2_000_000_000 + index })) });
    const text = JSON.stringify(large);
    expect(text.length).toBeGreaterThan(100 * 1024);
    expect(text.length).toBeLessThan(DROPSHIP_BULK_JSON_LIMIT_BYTES);

    const response = await put(undefined, { raw: text });

    expect(response.status).toBe(200);
    expect(products.calls).toHaveLength(1);
    expect(products.calls[0].input).toEqual(large);
  });

  it("refuses a body over 1 MiB with 413 in the listing-settings words, never calling the service", async () => {
    server = await startServer(buildApp(sizePrices, products));
    const response = await put({ ...productBody(), padding: "x".repeat(DROPSHIP_BULK_JSON_LIMIT_BYTES + 1) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_REQUEST_TOO_LARGE", message: LISTING_SETTINGS_TOO_LARGE_MESSAGE } });
    expect(products.calls).toEqual([]);
  });

  it("answers a replay as the probe saw it, and an answer that breaks the response contract as a 500 with the fixed words", async () => {
    server = await startServer(buildApp(sizePrices, products));
    products.result = { outcome: "replayed", productId: 7, revisionId: 31, sizes: [{ productVariantId: 101, revisionId: 55 }],
      clearedSizeCount: null };
    expect(await (await put(productBody())).json()).toEqual(products.result);

    // A replay always leaves the clean-up count unknown; an unchanged save wrote nothing.
    for (const broken of [{ ...productChanged, outcome: "replayed" }, { ...productChanged, outcome: "unchanged", clearedSizeCount: 2 },
      { ...productChanged, sizes: [{ productVariantId: 101, revisionId: 1 }, { productVariantId: 101, revisionId: 2 }] }]) {
      products.result = broken;
      const response = await put(productBody());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
        message: "Something went wrong. We couldn't confirm your save." } });
    }
  });

  it.each([
    [new DropshipError("DROPSHIP_LISTING_PRICES_MOVED", "Prices changed while you were editing.", {
      storeConnectionId: 22, sizeCount: 1, sizes: [{ productVariantId: 101, expectedPriceCents: 1_499, priceCents: 1_599 }],
      retryable: false, classification: "permanent" }), 409],
    [new DropshipError("DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", "Sign in to eBay again.", {
      storeConnectionId: 22, fields: ["shippingPolicy"], retryable: false, classification: "permanent" }), 403],
    [new DropshipError("DROPSHIP_LISTING_SETTINGS_TOO_LARGE", "This store's saved listing text is at its limit.", {
      storeConnectionId: 22, reason: "store_text_limit", textBytes: 30_000_001, maxTextBytes: 30_000_000,
      retryable: false, classification: "permanent" }), 422],
    [new DropshipError("DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "eBay refused access.", { storeConnectionId: 22 }), 403],
    [new DropshipError("DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", "Routing unavailable.", { storeConnectionId: 22 }), 503],
  ])("answers %s with its status and the public context, logged with the product", async (error, status) => {
    server = await startServer(buildApp(sizePrices, products));
    products.failure = error;
    const response = await put(productBody());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: error.code, message: error.message, context: error.context } });
    const line = status === 503 ? logger.warn : logger.debug;
    expect(line).toHaveBeenCalledWith(status === 503 ? "dropship.listing_settings.write_deferred" : "dropship.listing_settings.write_refused",
      expect.objectContaining({ store_connection_id: 22, product_id: 7, actor_id: "member-1", status, error_code: error.code,
        path: "/api/dropship/listings/stores/:storeConnectionId/listing-settings/products/:productId" }));
  });

  it("limits each member to the single-write budget a minute, on its own counter: the bulk budget is not spent", async () => {
    server = await startServer(buildApp(sizePrices, products));
    expect(LISTING_SETTING_SINGLE_WRITES_PER_MINUTE).toBe(60);
    for (let index = 0; index < LISTING_SETTING_SINGLE_WRITES_PER_MINUTE; index += 1) {
      expect((await put(productBody())).status).toBe(200);
    }
    const limited = await put(productBody());
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED",
      message: "Too many saves in a minute. Wait a moment and try again." } });
    expect(products.calls).toHaveLength(LISTING_SETTING_SINGLE_WRITES_PER_MINUTE);
    // The bulk route has its own budget, and another member has their own.
    const bulk = await fetch(`${server.url}${PATH}`, { method: "PUT",
      headers: { "Content-Type": "application/json", "X-Test-Member": "member-1" }, body: JSON.stringify(body([row(101)])) });
    expect(bulk.status).toBe(200);
    expect((await put(productBody(), { member: "member-2" })).status).toBe(200);
  });
});

/**
 * Every writer the router takes, with the given fakes; any other member is a
 * stub that throws, so a route reaching the wrong service fails here. Each
 * later sub-PR adds its member (plan 6.1, C-feas-6).
 */
function writeServices(overrides: Partial<ListingSettingWriteServices>): ListingSettingWriteServices {
  const unexpected = (name: string) => ({
    saveForMember: async (): Promise<never> => { throw new Error(`The ${name} service was not expected here.`); },
  });
  return {
    sizePrices: unexpected("sizePrices") as unknown as ListingSettingWriteServices["sizePrices"],
    products: unexpected("products") as unknown as ListingSettingWriteServices["products"],
    ...overrides,
  };
}

/** The W8 cases pass no products fake, so a W8 route that reached the W5 service would fail on its throwing stub. */
function buildApp(sizePrices: FakeSizePrices, products?: FakeProducts): express.Express {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const memberId = req.header("X-Test-Member");
    req.session = (memberId ? { dropship: { memberId } } : {}) as unknown as Request["session"];
    next();
  });
  // The production order: the global 100 KB parser skips this route, which parses its own body after sign-in.
  installGlobalJsonBodyParser(app);
  registerDropshipListingSettingWritesRoutes(app, writeServices({
    sizePrices: sizePrices as unknown as ListingSettingWriteServices["sizePrices"],
    ...(products ? { products: products as unknown as ListingSettingWriteServices["products"] } : {}),
  }));
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const listener = http.createServer(app);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())),
  };
}
