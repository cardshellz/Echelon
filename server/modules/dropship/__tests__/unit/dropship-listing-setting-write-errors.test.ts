import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";
import {
  ListingSettingHeavyWriteGate,
  MAX_ECHOED_ISSUES,
  listingSettingBulkTooLarge,
  parseListingSettingInput,
} from "../../application/dropship-listing-setting-write-support";
import { DropshipError } from "../../domain/errors";
import { selectRateBookAssignment, type RateBookAssignmentCandidate } from "../../../shipping-engine/domain/rate-book";
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  LISTING_SETTINGS_INTERNAL_MESSAGE,
  LISTING_SETTING_WRITE_STATUS,
  MAX_LOGGED_CONTEXT_CHARS,
  listingSettingWriteErrorAnswer,
  publicListingSettingContext,
} from "../../interfaces/http/dropship-listing-setting-write-errors";

/** Every 500's words: true whether or not the save committed (review round; plan 3.3 said "Nothing was saved."). */
const INTERNAL_WORDS = "Something went wrong. We couldn't confirm your save.";

/** Plan PR 9, section 3.3, row by row: status, then the class a code without its own classification gets. */
const TABLE: ReadonlyArray<[number, "permanent" | "transient" | "fatal", readonly string[]]> = [
  [400, "permanent", ["DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", "DROPSHIP_REQUEST_JSON_INVALID", "DROPSHIP_LISTING_SETTINGS_BULK_INVALID"]],
  [401, "permanent", ["DROPSHIP_AUTH_REQUIRED"]],
  [403, "permanent", ["DROPSHIP_LISTING_VENDOR_BLOCKED", "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "DROPSHIP_LISTING_STORE_BLOCKED",
    "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED",
    "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED", "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
    // 9c: eBay refused the store's grant for a read the eBay values step makes.
    "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED"]],
  [404, "permanent", ["DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND",
    "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "DROPSHIP_PRICING_REVIEW_NOT_FOUND"]],
  [409, "permanent", ["DROPSHIP_IDEMPOTENCY_CONFLICT", "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
    "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "DROPSHIP_LISTING_PRICES_MOVED",
    "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT",
    // 9c: the store paused while eBay was asked, no token, and the Card Shellz shipping checks behind a new shipping policy.
    "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
    "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
    "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", "DROPSHIP_EBAY_FULFILLMENT_ROUTING_MISMATCH",
    "DROPSHIP_EBAY_FULFILLMENT_WAREHOUSE_REQUIRED", "DROPSHIP_EBAY_FULFILLMENT_SLA_REQUIRED",
    "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED", "DROPSHIP_EBAY_FULFILLMENT_DESTINATION_COVERAGE_REQUIRED",
    "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK", "DROPSHIP_EBAY_FULFILLMENT_AMBIGUOUS_RATE_BOOK"]],
  [413, "permanent", ["DROPSHIP_REQUEST_TOO_LARGE"]],
  [422, "permanent", ["DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "DROPSHIP_PRICING_RULES_NOT_CONFIGURED",
    "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
    "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED"]],
  [429, "transient", ["DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"]],
  [502, "transient", ["DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE",
    "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE",
    "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_INVALID_RESPONSE",
    "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE", "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE",
    "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT", "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE",
    "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE"]],
  [503, "transient", ["DROPSHIP_LISTING_SETTINGS_BUSY", "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE", "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE",
    "DROPSHIP_CREDENTIAL_CHANGED", "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE", "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED"]],
  [500, "fatal", ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE",
    "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]],
];
const ROWS = TABLE.flatMap(([status, errorClass, codes]) => codes.map((code) => [code, status, errorClass] as const));

describe("listing-settings write errors (plan PR 9, section 3.3)", () => {
  it("maps exactly the table's codes", () => {
    expect(new Map(ROWS.map(([code, status]) => [code, status]))).toEqual(LISTING_SETTING_WRITE_STATUS);
  });

  it.each(ROWS)("%s is %s and %s", (code, status, errorClass) => {
    const answer = listingSettingWriteErrorAnswer(new DropshipError(code, "Controlled words.", { storeConnectionId: 22 }));
    expect(answer.status).toBe(status);
    expect(answer.errorClass).toBe(errorClass);
    expect(answer.code).toBe(code);
    if (status === 500) {
      // A broken contract says only that the save could not be confirmed; its own words and context go to the log.
      expect(answer.body).toEqual({ error: { code, message: INTERNAL_WORDS } });
      expect(answer.internalMessage).toBe(`${code}: Controlled words.`);
      expect(answer.internalContext).toEqual({ storeConnectionId: 22 });
    } else {
      expect(answer.body).toEqual({ error: { code, message: "Controlled words.", context: { storeConnectionId: 22 } } });
      expect(answer.internalMessage).toBeNull();
      expect(answer.internalContext).toBeNull();
    }
  });

  it("takes the error's own classification over the status's, except on a 500", () => {
    expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "x", { classification: "transient" })).errorClass)
      .toBe("transient");
    expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "x", { classification: "permanent" })).errorClass)
      .toBe("permanent");
    expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "x", { classification: "permanent" })).errorClass)
      .toBe("fatal");
    // An unknown class word is ignored.
    expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "x", { classification: "maybe" })).errorClass)
      .toBe("permanent");
  });

  it("sends Retry-After on a busy answer only: the error's own wait, else 5 seconds", () => {
    expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Busy.", { retryAfterSeconds: 9 })).retryAfterSeconds).toBe(9);
    expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Busy.")).retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
    expect(DEFAULT_RETRY_AFTER_SECONDS).toBe(5);
    for (const odd of [0, -1, 2.5, 3_600, "9"]) {
      expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Busy.", { retryAfterSeconds: odd })).retryAfterSeconds)
        .toBe(DEFAULT_RETRY_AFTER_SECONDS);
    }
    expect(listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "x", { retryAfterSeconds: 9 })).retryAfterSeconds).toBeNull();
  });

  it("answers an unlisted code and a plain error with the generic 500, keeping their words for the log only", () => {
    expect(LISTING_SETTINGS_INTERNAL_MESSAGE).toBe(INTERNAL_WORDS);
    for (const error of [new DropshipError("DROPSHIP_SOMETHING_NEW", "secret detail"), new Error("pg connection string leaked"), "thrown text"]) {
      const answer = listingSettingWriteErrorAnswer(error);
      expect(answer).toMatchObject({ status: 500, errorClass: "fatal", code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", retryAfterSeconds: null,
        body: { error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: INTERNAL_WORDS } } });
      expect(JSON.stringify(answer.body)).not.toMatch(/secret|pg connection|thrown/);
    }
    expect(listingSettingWriteErrorAnswer(new Error("pg connection string leaked")).internalMessage).toBe("pg connection string leaked");
  });

  it("answers invalid input parsed by a service with 400 and at most 20 issues, with Zod's own words left out", () => {
    const schema = z.object({ rows: z.array(z.object({ priceCents: z.number().int().positive() })) })
      .refine(() => false, "Each size once.");
    const refusal = (value: unknown) => {
      try { parseListingSettingInput(schema, value); } catch (error) { return error; }
      throw new Error("Expected a refusal");
    };
    const answer = listingSettingWriteErrorAnswer(refusal({ rows: Array.from({ length: 30 }, () => ({ priceCents: "vendor text 'DROP TABLE'" })) }));
    expect(answer).toMatchObject({ status: 400, errorClass: "permanent", code: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT",
      body: { error: { message: "Check the listing settings change and reload if the page is out of date." } } });
    const issues = answer.body.error.context?.issues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(MAX_ECHOED_ISSUES);
    expect(issues[0]).toEqual({ path: ["rows", 0, "priceCents"], code: "invalid_type" });
    expect(JSON.stringify(answer.body)).not.toContain("vendor text");
  });

  it("answers a bare ZodError as a broken contract: 500 fatal, the issues' paths and codes for the log only", () => {
    const parsed = z.object({ rulePriceCents: z.number().int().positive() }).safeParse({ rulePriceCents: 0 });
    expect(parsed.success).toBe(false);
    const answer = listingSettingWriteErrorAnswer(parsed.error);
    expect(answer).toMatchObject({ status: 500, errorClass: "fatal", code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
      body: { error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: INTERNAL_WORDS } } });
    expect(answer.body.error).not.toHaveProperty("context");
    expect(answer.internalMessage).toBe("ZodError: 1 issue(s) in a listing settings contract.");
    expect(answer.internalContext).toEqual({ issues: [{ path: ["rulePriceCents"], code: "too_small" }] });
  });

  it("logs a database fault's code and constraint (never its detail), and a context that cannot be written as JSON as unloggable", () => {
    const pgFault = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505", constraint: "dropship_listing_price_revision_identity_uk", table: "dropship_listing_price_revisions",
      detail: "Key (id)=(1) already exists." });
    expect(listingSettingWriteErrorAnswer(pgFault).internalContext).toEqual({ code: "23505",
      constraint: "dropship_listing_price_revision_identity_uk", table: "dropship_listing_price_revisions" });

    const bigint = listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "x", { id: BigInt(10) }));
    expect(bigint.internalContext).toEqual({ unloggable: expect.any(String) });
    const large = listingSettingWriteErrorAnswer(new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "x", { ids: "1".repeat(10_000) }));
    expect((large.internalContext?.truncated as string).length).toBe(MAX_LOGGED_CONTEXT_CHARS);
  });
});

describe("the 9d refusals answer through existing rows (plan 3.3: 9d adds no status row)", () => {
  it("answers the heavy-write gate's refusal 503 transient with Retry-After 5 and its reason", async () => {
    const gate = new ListingSettingHeavyWriteGate();
    let release!: () => void;
    const held = gate.run(() => new Promise<void>((done) => { release = done; }));
    const busy = await gate.run(async () => undefined).then(() => null, (error: unknown) => error);
    release();
    await held;

    const answer = listingSettingWriteErrorAnswer(busy);
    expect(answer).toMatchObject({ status: 503, errorClass: "transient", code: "DROPSHIP_LISTING_SETTINGS_BUSY", retryAfterSeconds: 5 });
    expect(answer.body.error.context).toEqual({ reason: "heavy_write_in_progress", retryable: true, classification: "transient" });
  });

  it("answers the bulk text refusal 422 permanent with its numbers", () => {
    const answer = listingSettingWriteErrorAnswer(listingSettingBulkTooLarge(22, 30_000_001, 30_000_000, 3_750));
    expect(answer).toMatchObject({ status: 422, errorClass: "permanent", code: "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", retryAfterSeconds: null });
    expect(answer.body.error.context).toEqual({ storeConnectionId: 22, textBytes: 30_000_001, maxTextBytes: 30_000_000, productCount: 3_750,
      retryable: false, classification: "permanent" });
  });
});

describe("rate-book refusals (review round, finding H1)", () => {
  // The capability provider throws `DROPSHIP_EBAY_FULFILLMENT_${selectRateBookAssignment(...).code}`
  // (dropship-ebay-fulfillment-capability.provider.ts), so a new rate-book code cannot fall to 500 unnoticed.
  const context = { pricingChannel: "dropship", purpose: "vendor_fulfillment_charge", originWarehouseId: 5 } as const;
  const candidate = (assignmentId: number): RateBookAssignmentCandidate => ({
    ...context, assignmentId, rateBookId: assignmentId, rateBookCode: `book-${assignmentId}`, zoneSetId: 1,
  });

  it.each([
    ["no rate book", [] as RateBookAssignmentCandidate[]],
    ["two warehouse rate books", [candidate(1), candidate(2)]],
  ])("answers %s 409 permanent with its own code, never the reason sentence", (_name, candidates) => {
    const selected = selectRateBookAssignment(candidates, context);
    if (selected.ok) throw new Error("expected a refusal");
    const answer = listingSettingWriteErrorAnswer(new DropshipError(`DROPSHIP_EBAY_FULFILLMENT_${selected.code}`,
      "A unique active dropship fulfillment rate book is required.",
      { storeConnectionId: 22, originWarehouseId: 5, reason: selected.message, retryable: false }));
    expect(answer).toMatchObject({ status: 409, errorClass: "permanent", code: `DROPSHIP_EBAY_FULFILLMENT_${selected.code}` });
    expect(answer.body.error.context).toEqual({ storeConnectionId: 22, retryable: false });
  });
});

describe("publicListingSettingContext (the allow-list)", () => {
  it("passes reason only as one of our enum words", () => {
    expect(publicListingSettingContext({ reason: "store_text_limit" })).toEqual({ reason: "store_text_limit" });
    expect(publicListingSettingContext({ reason: "needs_reauth" })).toEqual({ reason: "needs_reauth" });
    expect(publicListingSettingContext({ reason: "eBay returned an empty category tree." })).toBeUndefined();
    expect(publicListingSettingContext({ reason: "no active rate book is assigned to dropship/vendor_fulfillment_charge for warehouse 5" })).toBeUndefined();
    expect(publicListingSettingContext({ reason: "x".repeat(65) })).toBeUndefined();
    expect(publicListingSettingContext({ reason: 3 })).toBeUndefined();
  });

  it("passes ids, counts, flags and enum words, and drops everything else", () => {
    expect(publicListingSettingContext({
      storeConnectionId: 22, productId: 7, categoryId: 3, productVariantId: 101, reviewId: "6f1b1d7e-6d0e-4d43-9a43-2f9d3c0b7c11",
      conflictCount: 2, sizeCount: 1, productCount: 4, reason: "paused", pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 2,
      textBytes: 10, maxTextBytes: 30_000_000, releaseCount: 201, maxReleases: 200, retryable: false, classification: "permanent",
      fields: ["textAbove", 3], invalidFields: ["shippingPolicy"],
      vendorId: 10, memberId: "member-1", mismatched: ["size.requestHash"], databaseMessage: "duplicate key", text: "own words",
      expectedRevisionId: 3, actualRevisionId: 4, blockers: ["pricing:below_floor:policy_5"],
    })).toEqual({
      storeConnectionId: 22, productId: 7, categoryId: 3, productVariantId: 101, reviewId: "6f1b1d7e-6d0e-4d43-9a43-2f9d3c0b7c11",
      conflictCount: 2, sizeCount: 1, productCount: 4, reason: "paused", pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 2,
      textBytes: 10, maxTextBytes: 30_000_000, releaseCount: 201, maxReleases: 200, retryable: false, classification: "permanent",
      fields: ["textAbove"], invalidFields: ["shippingPolicy"],
    });
  });

  it("keeps only the listed keys of each conflict and size, at most 100 of each", () => {
    const conflicts = Array.from({ length: 120 }, (_, index) => ({ productVariantId: index + 1, expectedRevisionId: null, actualRevisionId: 9,
      secret: "x" }));
    const sizes = [{ productVariantId: 101, priceCents: 250, blockers: ["pricing:below_floor:policy_5", { nested: true }],
      beforePriceCents: 1_299, afterPriceCents: null, expectedPriceCents: 1_100, refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT",
      productName: "Toploader" }];
    const safe = publicListingSettingContext({ conflicts, sizes, productIds: [7, "8", 9.5, 10],
      issues: Array.from({ length: 30 }, (_, index) => ({ path: ["rows", index], code: "too_small" })) });
    expect(safe?.conflicts).toHaveLength(100);
    expect((safe?.conflicts as unknown[])[0]).toEqual({ productVariantId: 1, expectedRevisionId: null, actualRevisionId: 9 });
    expect(safe?.sizes).toEqual([{ productVariantId: 101, priceCents: 250, beforePriceCents: 1_299, afterPriceCents: null,
      expectedPriceCents: 1_100, refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", blockers: ["pricing:below_floor:policy_5"] }]);
    expect(safe?.productIds).toEqual([7, 10]);
    expect(safe?.issues).toHaveLength(20);
  });

  it("rebuilds each issue as { path, code }, keeping a message only on a custom issue (plan P5)", () => {
    const safe = publicListingSettingContext({ issues: [
      { path: ["a"], code: "invalid_enum_value", message: "received 'vendor secret text'", received: "vendor secret text", options: ["x"] },
      { path: ["rows", 0, { nested: true }], code: "custom", message: "Each size once.", params: { secret: "x" } },
      { path: "rows.1.priceCents", code: "too_small", keys: ["vendor key"] },
      { code: "invalid_type" }, { path: ["b"] }, "not an issue", null, [{ path: ["c"], code: "custom" }],
    ] });
    expect(safe?.issues).toEqual([
      { path: ["a"], code: "invalid_enum_value" },
      { path: ["rows", 0], code: "custom", message: "Each size once." },
      { path: "rows.1.priceCents", code: "too_small" },
    ]);
    expect(JSON.stringify(safe)).not.toMatch(/vendor|secret/);
  });

  it("is undefined when nothing is left", () => {
    expect(publicListingSettingContext(undefined)).toBeUndefined();
    expect(publicListingSettingContext({ vendorId: 10, text: "own words" })).toBeUndefined();
  });
});
