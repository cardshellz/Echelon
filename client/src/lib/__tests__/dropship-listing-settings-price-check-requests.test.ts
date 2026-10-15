import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPriceChangesInputSchema,
  priceChangeReviewResponseSchema,
  reviewPriceChangesInputSchema,
  type ApplyPriceChangesInput,
  type PriceChangeReviewResponse,
  type PriceChangeRow,
  type ReviewPriceChangesInput,
} from "@shared/dropship/listing-setting-writes";
import { listingSettingsProductOwnSettingsSchema } from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type DraftValue,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import { PRICE_CHECK_REQUEST_INVALID, PriceCheckRequestError, priceCheckRefOf, productPricesReviewBody } from "../dropship-listing-settings-price-check";
import {
  fetchPriceChangeReviewPage,
  loadLatestProductPrice,
  priceChangesEndpoint,
  readAppliedPriceChange,
  readPriceCheckPage,
  refreshAfterPriceChangeApply,
  requestPriceChangeReview,
  rereadProductPriceBase,
  runPriceChangeApply,
  runPriceChangeCheck,
  sendPriceChangeApply,
  sendPriceChangeReview,
  settlePriceCheckConflict,
  type PriceCheckDrafts,
  type PriceCheckQueryClient,
  type PriceChangeApplyRun,
  type PriceChangeCheckOutcome,
} from "../dropship-listing-settings-price-check-requests";
import {
  productPriceBaseOf,
  productPriceDraftValue,
  productPriceDraftWithCheck,
  readProductPriceDraft,
  type PriceCheckAfter,
  type PriceCheckRef,
  type ProductOwnSettings,
  type ProductPriceChange,
} from "../dropship-listing-settings-product-edit";
import { CHECK_NEW_PRICES_WORDS, MAX_PRICE_CHECK_ATTEMPTS, PRICE_DEFAULT_WORDS } from "../dropship-listing-settings-recipe";
import { LISTING_SETTINGS_EDIT_WORDS, LISTING_SETTINGS_PRICE_CHECK_WORDS } from "../dropship-listing-settings-words";

/** W7 from the drawer and from "Set for selected" (plan PR 10d, 7.3, 7.5, 7.6, 3.3, 3.6, D5, D6a, D7, D9). */

const STORE = 22;
const PRODUCT = 11;
const EDITOR = productEditorId(PRODUCT);
const ENDPOINT = `/api/dropship/listings/stores/${STORE}/listing-settings/price-changes`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 0, rounding: "cent" };
const WORDS = LISTING_SETTINGS_EDIT_WORDS;
const UNCONFIRMED = "We couldn't confirm your save.";
const SET: Pick<ProductPriceChange, "price" | "releaseExactPrices"> = { price: { mode: "set", value: COST_35 }, releaseExactPrices: true };
const REVIEW_BODY: ReviewPriceChangesInput = { kind: "product_prices", productIds: [PRODUCT], price: COST_35, releaseExactPrices: true };
const APPLIED = { outcome: "changed", reviewId: REVIEW_ID, requestId: 9, changedProductCount: 1, releasedSizeCount: 2, categoryRevisionId: null };
const REPLAYED = { ...APPLIED, outcome: "replayed", changedProductCount: null };
const SENT: ApplyPriceChangesInput = { reviewId: REVIEW_ID, reviewHash: HASH_A, idempotencyKey: "ls-price-check:1" };

function own(revisionId: number | null = 5, price: PricingRecipe | null = null): ProductOwnSettings {
  return listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: STORE, productId: PRODUCT, revisionId,
    own: { price, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null },
    generatedAt: "2026-10-14T12:00:00.000Z",
  });
}
const OWN = own();

function row(overrides: Partial<PriceChangeRow> = {}): PriceChangeRow {
  return {
    productVariantId: 101, productId: PRODUCT, title: "Easy Glide Soft Sleeves", sku: "EG-SLV-STD-5PCK-B500",
    previousPriceCents: 1499, priceCents: 1733, productCostCents: 981, ruleName: "Store default rule", preserved: false, issues: [],
    settingRevisionId: null, evidenceHash: HASH_A, sizeName: "Box of 5 Packs of 100", basis: "catalog_retail", basisCents: 1251, warnings: [],
    released: false, refusal: null, ...overrides,
  };
}

function review(overrides: Partial<PriceChangeReviewResponse> = {}): PriceChangeReviewResponse {
  return priceChangeReviewResponseSchema.parse({
    reviewId: REVIEW_ID, reviewHash: HASH_A, createdAt: "2026-10-14T12:00:00.000Z", kind: "product_prices",
    summary: { total: 1, changed: 1, released: 0, refused: 0 }, rows: [row()], page: 0, ...overrides,
  });
}
const CHECK: PriceCheckRef = priceCheckRefOf(review());
const NEW_REVIEW = review({ reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B });

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });
const networkDrop = () => new TypeError("Failed to fetch");

/** The drawer's price draft on OWN, with `change` and, when given, its check. */
function priceDraft(change: Pick<ProductPriceChange, "price" | "releaseExactPrices"> = SET, check: PriceCheckRef | null = CHECK, base: ProductOwnSettings = OWN): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productPriceDraftValue(base) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: productPriceDraftValue(base, { ...change, check }) })!;
}

/** The provider's save calls and `edit` on the real reducer, minting keys `ls-price-check:1`, `:2`… */
function reducerDrafts(start: ListingSettingsDraft | null) {
  let draft: ListingSettingsDraft | null = start;
  let keys = 0;
  const drafts: PriceCheckDrafts & { current: () => ListingSettingsDraft; minted: () => number } = {
    startSave: (signature, prefix) => {
      const attempt = nextSaveAttempt(draft, signature, () => `${prefix}:${++keys}`);
      if (attempt === null) return null;
      draft = reduceListingSettingsDraft(draft, { type: "startSave", attempt });
      return attempt.key;
    },
    settle: (key, settlement) => {
      draft = settlement.kind === "failure"
        ? reduceListingSettingsDraft(draft, { type: "failure", key, failure: settlement.failure })
        : reduceListingSettingsDraft(draft, { type: "saved", key, nowMs: 1_000, viewStale: settlement.kind === "saved_view_stale" });
    },
    edit: (value: DraftValue) => { draft = reduceListingSettingsDraft(draft, { type: "edit", value }); },
    current: () => draft!,
    minted: () => keys,
  };
  return drafts;
}

const currentCheck = (drafts: ReturnType<typeof reducerDrafts>) => readProductPriceDraft(drafts.current().value)?.priceChange.check ?? null;

/**
 * An apply run on the drawer's draft: the apply's answers queue up in `answers`, the re-check's reviews in
 * `reviews` (each answered by the review POST through the real check run, with the drawer's guard, D6a).
 */
function setup(overrides: Partial<PriceChangeApplyRun> = {}, start: ListingSettingsDraft = priceDraft(), latestOwn: () => ProductOwnSettings = () => OWN) {
  const drafts = reducerDrafts(start);
  const sent: ApplyPriceChangesInput[] = [];
  const reviewsSent: ReviewPriceChangesInput[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const reviews: Array<unknown | Error> = [];
  const send = vi.fn(async (body: ApplyPriceChangesInput) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : APPLIED;
    if (next instanceof Error) throw next;
    return next;
  });
  const reviewSend = vi.fn(async (body: ReviewPriceChangesInput) => {
    reviewsSent.push(body);
    const next = reviews.length > 0 ? reviews.shift() : NEW_REVIEW;
    if (next instanceof Error) throw next;
    return next;
  });
  const guardReread = vi.fn(async () => productPriceBaseOf(latestOwn()));
  const check = vi.fn((after: PriceCheckAfter): Promise<PriceChangeCheckOutcome> => runPriceChangeCheck({
    productIds: [PRODUCT], change: SET, after, send: reviewSend,
    guard: { base: { ownPrice: null, revisionId: 5 }, reread: guardReread, drafts },
  }));
  const input: PriceChangeApplyRun = {
    draft: drafts.current(), check: currentCheck(drafts) ?? CHECK, drafts, callbacks, send,
    reread: vi.fn(async () => undefined), onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    recheck: { check, withCheck: (next) => productPriceDraftWithCheck(readProductPriceDraft(drafts.current().value)!, next) },
    ...overrides,
  };
  /** Save, or Check again, on the draft and the check as they are now. */
  const apply = () => runPriceChangeApply({ ...input, draft: drafts.current(), check: currentCheck(drafts) ?? input.check });
  return { input, drafts, sent, reviewsSent, callbacks, answers, reviews, send, reviewSend, guardReread, check, apply };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Endpoints and reads
// ---------------------------------------------------------------------------

describe("the W7 requests (plan 7.3)", () => {
  it("puts the check, its pages and the apply under the store's listing settings, the page by the review's id", async () => {
    expect(priceChangesEndpoint(STORE)).toBe(ENDPOINT);
    const page1 = review({ page: 1, summary: { total: 60, changed: 60, released: 0, refused: 0 } });
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify(page1), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPriceChangeReviewPage(STORE, REVIEW_ID, 1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/reviews/${REVIEW_ID}?page=1`);
    await sendPriceChangeReview(STORE, REVIEW_BODY);
    expect(fetchMock.mock.calls[1][0]).toBe(`${ENDPOINT}/review`);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual(REVIEW_BODY);
    await sendPriceChangeApply(STORE, SENT);
    expect(fetchMock.mock.calls[2][0]).toBe(`${ENDPOINT}/apply`);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual(SENT);
    // A page or an id the contract doesn't take is never asked for.
    for (const page of [-1, 201, 1.5]) expect(() => fetchPriceChangeReviewPage(STORE, REVIEW_ID, page)).toThrow(PriceCheckRequestError);
    expect(() => fetchPriceChangeReviewPage(STORE, REVIEW_ID.toUpperCase().replace("1", "A"), 0)).toThrow(CHECK_NEW_PRICES_WORDS.pageFailed);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads the product's own price and revision again for the drawer's guard, cancelling a read in flight first (D6a)", async () => {
    const client = { cancelQueries: vi.fn(async () => undefined), fetchQuery: vi.fn(async () => own(6, RETAIL_20_UP)) };
    await expect(rereadProductPriceBase(client as never, STORE, PRODUCT)).resolves.toEqual({ ownPrice: RETAIL_20_UP, revisionId: 6 });
    expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), "product-own", PRODUCT], exact: true });
    expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({ queryKey: [...listingSettingsQueryKey(STORE), "product-own", PRODUCT], staleTime: 0, retry: false }));
    client.fetchQuery.mockRejectedValueOnce(networkDrop());
    await expect(rereadProductPriceBase(client as never, STORE, PRODUCT)).rejects.toThrow("Failed to fetch");
    // Load latest: the vendor's price change on what is saved now.
    const mine = productPriceDraftValue(OWN, { ...SET, check: CHECK });
    await expect(loadLatestProductPrice(client as never, STORE, PRODUCT, mine)).resolves.toEqual({
      edited: productPriceDraftValue(own(6, RETAIL_20_UP), { ...SET, check: null }), latest: productPriceDraftValue(own(6, RETAIL_20_UP)), marked: ["priceChange"], keeps: true,
    });
  });

  it("marks every view an apply changes stale after it, the size prices too, cancelling reads in flight first (D9, plan 7.6)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`cancel ${String(queryKey[3])}`); }),
      invalidateQueries: vi.fn(async (filter: { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => {
        calls.push(filter.queryKey ? `invalidate ${String(filter.queryKey[3])}` : "invalidate sizes");
        if (filter.predicate) {
          expect(filter.predicate({ queryKey: [`/api/dropship/listings/stores/${STORE}/variants/101/price`] })).toBe(true);
          expect(filter.predicate({ queryKey: [`/api/dropship/listings/stores/${STORE + 1}/variants/101/price`] })).toBe(false);
        }
      }),
      fetchQuery: vi.fn(),
    };
    await refreshAfterPriceChangeApply(client as unknown as PriceCheckQueryClient, STORE);
    expect(calls).toEqual([
      "cancel product", "cancel product-own", "cancel products", "cancel prices", "cancel summary",
      "invalidate product", "invalidate product-own", "invalidate products", "invalidate prices", "invalidate summary", "invalidate sizes",
    ]);
    for (const read of ["product", "product-own", "products", "prices", "summary"]) {
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] }, { throwOnError: true });
    }
    expect(client.fetchQuery).not.toHaveBeenCalled();
    client.invalidateQueries.mockRejectedValueOnce(networkDrop());
    await expect(refreshAfterPriceChangeApply(client as unknown as PriceCheckQueryClient, STORE)).rejects.toThrow("Failed to fetch");
  });

  it("checks an apply answer against its contract, for the review it was sent for", () => {
    expect(readAppliedPriceChange(APPLIED, REVIEW_ID)).toEqual(APPLIED);
    expect(readAppliedPriceChange(REPLAYED, REVIEW_ID).changedProductCount).toBeNull();
    for (const bad of [{ ...APPLIED, extra: 1 }, { ...APPLIED, outcome: "replayed" }, { ...APPLIED, outcome: "unchanged" }, { ...APPLIED, categoryRevisionId: "x" }, null]) {
      expect(() => readAppliedPriceChange(bad, REVIEW_ID)).toThrow(PriceCheckRequestError);
    }
    expect(() => readAppliedPriceChange(APPLIED, OTHER_REVIEW_ID)).toThrow(expect.objectContaining({ context: { reason: "other_review" } }));
  });
});

// ---------------------------------------------------------------------------
// The check (plan 7.5)
// ---------------------------------------------------------------------------

describe("the check (plan 7.3, 7.5, D6a)", () => {
  it("classifies a check's outcome by code and reason; a dropped check is never an unconfirmed save", async () => {
    await expect(requestPriceChangeReview(async () => review())).resolves.toEqual({ kind: "ok", review: review() });
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    await expect(requestPriceChangeReview(async () => { throw blocked; })).resolves.toEqual({ kind: "blocked", error: blocked });
    await expect(requestPriceChangeReview(async () => { throw apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"); }))
      .resolves.toEqual({ kind: "failed", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited });
    await expect(requestPriceChangeReview(async () => { throw apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { storeConnectionId: STORE }); }))
      .resolves.toEqual({ kind: "failed", message: LISTING_SETTINGS_PRICE_CHECK_WORDS.tooManySizes });
    // The reason is read, never `textBytes` alone: the rows and the text together are "too big", not "shorten your text".
    await expect(requestPriceChangeReview(async () => { throw apiError(422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { reason: "price_check_rows", textBytes: 30_000_001, maxTextBytes: 30_000_000, productCount: 2 }); }))
      .resolves.toEqual({ kind: "failed", message: LISTING_SETTINGS_PRICE_CHECK_WORDS.tooHeavy });
    await expect(requestPriceChangeReview(async () => { throw apiError(422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_000_001 }); }))
      .resolves.toEqual({ kind: "failed", message: LISTING_SETTINGS_PRICE_CHECK_WORDS.tooHeavy });
    await expect(requestPriceChangeReview(async () => { throw apiError(422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", { releaseCount: 236, maxReleases: 200 }); }))
      .resolves.toEqual({ kind: "failed", message: "You can clear up to 200 exact prices at once. This would clear 236. Choose fewer products." });
    await expect(requestPriceChangeReview(async () => { throw apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }); }))
      .resolves.toEqual({ kind: "failed", message: WORDS.busyHeavy });
    await expect(requestPriceChangeReview(async () => { throw apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }); }))
      .resolves.toEqual({ kind: "failed", message: WORDS.busyKeyChanged });
    // A check saves nothing: no "We couldn't confirm your save." for a lost answer.
    for (const thrown of [apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY"), networkDrop(), apiError(500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR"), apiError(502, null)]) {
      await expect(requestPriceChangeReview(async () => { throw thrown; })).resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    }
    await expect(requestPriceChangeReview(async () => { throw apiError(500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED"); })).resolves.toEqual({ kind: "failed", message: WORDS.fatal });
    await expect(requestPriceChangeReview(async () => { throw apiError(401, "DROPSHIP_AUTH_REQUIRED"); })).resolves.toEqual({ kind: "failed", message: WORDS.signedOut });
    // An answer off its contract, of another kind, or not page 0, is "couldn't check".
    for (const answer of [{ ...review(), extra: true }, review({ kind: "category_price" }), review({ page: 1, summary: { total: 60, changed: 1, released: 0, refused: 0 } }), null]) {
      await expect(requestPriceChangeReview(async () => answer)).resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    }
  });

  it("sends the body built from the change and keeps the request and the check reference", async () => {
    const send = vi.fn().mockResolvedValue(review());
    const outcome = await runPriceChangeCheck({ productIds: [PRODUCT], change: SET, send });
    expect(outcome).toEqual({ kind: "checked", review: review(), check: CHECK, request: REVIEW_BODY });
    expect(send).toHaveBeenCalledWith(REVIEW_BODY);
    expect(reviewPriceChangesInputSchema.safeParse(send.mock.calls[0][0]).success).toBe(true);
    // A re-check carries why, for the stale line; many products (the sheet) send their ids and no guard.
    expect((await runPriceChangeCheck({ productIds: [12, 11, 13], change: { price: { mode: "default" }, releaseExactPrices: false }, after: "prices_moved", send })))
      .toMatchObject({ kind: "checked", check: { ...CHECK, after: "prices_moved" }, request: { kind: "product_prices", productIds: [12, 11, 13], price: null } });
    expect(JSON.stringify(send.mock.calls[1][0])).not.toMatch(/releaseExactPrices|expectedRevisionId|Cents/);
  });

  it("for the drawer, reads the own price again first and shows the conflict when it moved, sending nothing (D6a)", async () => {
    for (const latest of [own(6), own(5, RETAIL_20_UP), own(null)]) {
      const drafts = reducerDrafts(priceDraft(SET, null));
      const send = vi.fn();
      const outcome = await runPriceChangeCheck({
        productIds: [PRODUCT], change: SET, send,
        guard: { base: productPriceBaseOf(OWN), reread: async () => productPriceBaseOf(latest), drafts },
      });
      expect(outcome).toEqual({ kind: "conflict" });
      expect(send).not.toHaveBeenCalled();
      expect(drafts.current()).toMatchObject({ phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, attempt: null, changes: 1 });
    }
    // The same price and revision: the check is sent.
    const drafts = reducerDrafts(priceDraft(SET, null));
    const send = vi.fn().mockResolvedValue(review());
    await expect(runPriceChangeCheck({ productIds: [PRODUCT], change: SET, send, guard: { base: productPriceBaseOf(OWN), reread: async () => productPriceBaseOf(own(5)), drafts } }))
      .resolves.toMatchObject({ kind: "checked" });
    expect(drafts.current().phase).toBe("editing");
    // A guard read that fails sends nothing: "couldn't check".
    await expect(runPriceChangeCheck({ productIds: [PRODUCT], change: SET, send, guard: { base: productPriceBaseOf(OWN), reread: async () => { throw networkDrop(); }, drafts } }))
      .resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("passes a block on, and never throws for a check it can't build", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    await expect(runPriceChangeCheck({ productIds: [PRODUCT], change: SET, send: async () => { throw blocked; } })).resolves.toEqual({ kind: "blocked", error: blocked });
    const send = vi.fn();
    for (const run of [
      { productIds: [PRODUCT, PRODUCT], change: SET },
      { productIds: [], change: SET },
      { productIds: [PRODUCT], change: { price: { mode: "leave" as const }, releaseExactPrices: false } },
    ]) {
      const outcome = await runPriceChangeCheck({ ...run, send });
      expect(outcome).toMatchObject({ kind: "failed" });
      expect(outcome.kind === "failed" && outcome.message).toMatch(/Reload the page/);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("settles a conflict found before sending, under its own key, and not while a save is in flight", () => {
    const drafts = reducerDrafts(priceDraft(SET, null));
    expect(settlePriceCheckConflict(drafts)).toBe(true);
    expect(drafts.current()).toMatchObject({ phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, attempt: null });
    expect(drafts.minted()).toBe(1);
    const saving = reducerDrafts(priceDraft());
    saving.startSave("busy", "ls-price-check");
    expect(settlePriceCheckConflict(saving)).toBe(false);
    expect(saving.current().phase).toBe("saving");
  });
});

// ---------------------------------------------------------------------------
// A page of the check (plan 7.5)
// ---------------------------------------------------------------------------

describe("a page of the check (plan 7.5)", () => {
  const page1 = review({ page: 1, summary: { total: 60, changed: 60, released: 0, refused: 0 }, rows: [row()] });

  it("takes a page of the very review, keeps its id, and words a failure by what happened", async () => {
    await expect(readPriceCheckPage(CHECK, async () => page1)).resolves.toEqual({ kind: "ok", review: page1 });
    await expect(readPriceCheckPage(CHECK, async () => ({ ...page1, reviewId: OTHER_REVIEW_ID }))).resolves.toEqual({ kind: "failed", message: CHECK_NEW_PRICES_WORDS.pageFailed });
    await expect(readPriceCheckPage(CHECK, async () => ({ ...page1, reviewHash: HASH_B }))).resolves.toEqual({ kind: "failed", message: CHECK_NEW_PRICES_WORDS.pageFailed });
    await expect(readPriceCheckPage(CHECK, async () => ({ nope: true }))).resolves.toEqual({ kind: "failed", message: CHECK_NEW_PRICES_WORDS.pageFailed });
    await expect(readPriceCheckPage(CHECK, async () => { throw apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"); }))
      .resolves.toEqual({ kind: "failed", message: DRAWER_WORDS.readRateLimited });
    expect(DRAWER_WORDS.readRateLimited).toBe("Too many checks in a minute. Wait a moment and try again.");
    await expect(readPriceCheckPage(CHECK, async () => { throw apiError(404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND", { reviewId: REVIEW_ID }); })).resolves.toEqual({ kind: "expired" });
    await expect(readPriceCheckPage(CHECK, async () => { throw apiError(404, "DROPSHIP_STORE_CONNECTION_REQUIRED"); })).resolves.toEqual({ kind: "failed", message: CHECK_NEW_PRICES_WORDS.pageFailed });
    for (const thrown of [apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY"), apiError(500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR"), networkDrop()]) {
      await expect(readPriceCheckPage(CHECK, async () => { throw thrown; })).resolves.toEqual({ kind: "failed", message: CHECK_NEW_PRICES_WORDS.pageFailed });
    }
  });
});

// ---------------------------------------------------------------------------
// The apply (plan 3.6, 7.5, D5, D7, D9)
// ---------------------------------------------------------------------------

describe("runPriceChangeApply (plan 3.6)", () => {
  it("(1) sends the check's id and hash with the draft's ls-price-check key, re-reads, then tells the step", async () => {
    const run = setup();
    await expect(run.apply()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent).toEqual([SENT]);
    expect(applyPriceChangesInputSchema.safeParse(run.sent[0]).success).toBe(true);
    expect(JSON.stringify(run.sent[0])).not.toMatch(/Cents|productIds|expectedRevisionId/);
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(run.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(run.check).not.toHaveBeenCalled();
    expect(run.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
  });

  it("(2) a dropped answer, then Check again, resends the same key and body; a replay counts as saved", async () => {
    const run = setup();
    run.answers.push(networkDrop(), REPLAYED);
    await expect(run.apply()).resolves.toEqual({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED, code: null, status: null, fields: [] }, refusedSizes: new Set() });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", changes: 1, attempt: { key: "ls-price-check:1" } });
    await expect(run.apply()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent).toEqual([SENT, SENT]);
    expect(run.drafts.minted()).toBe(1);
  });

  it("(3) a block goes to the banner and the draft is kept", async () => {
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const run = setup();
    run.answers.push(blocked);
    await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked", message: "Nothing was saved." } });
    expect(run.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(run.drafts.current()).toMatchObject({ phase: "blocked", changes: 1, attempt: null });
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
  });

  it("(4) a 429 keeps the key, and Save sends the same apply", async () => {
    const run = setup();
    run.answers.push(apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited } });
    expect(run.drafts.current().attempt?.key).toBe("ls-price-check:1");
    await expect(run.apply()).resolves.toMatchObject({ kind: "saved" });
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price-check:1", "ls-price-check:1"]);
  });

  it("(5) a refusal means the next try gets a new key; the release limit and the lost sizes are worded from the answer", async () => {
    const run = setup();
    run.answers.push(apiError(422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", { releaseCount: 236, maxReleases: 200 }));
    await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: "You can clear up to 200 exact prices at once. This would clear 236. Choose fewer products." } });
    expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 1 });
    expect(run.check).not.toHaveBeenCalled();
    await run.apply();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price-check:1", "ls-price-check:2"]);
    const lost = setup();
    lost.answers.push(apiError(422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizes: [{ productVariantId: 101 }, { productVariantId: 102 }], sizeCount: 3 }));
    await expect(lost.apply()).resolves.toEqual({
      kind: "failed", refusedSizes: new Set([101, 102]),
      failure: { phase: "refused", message: "● 3 sizes would be left without a price. Give them an exact price in Products first.", code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", status: 422, fields: [] },
    });
    expect(lost.check).not.toHaveBeenCalled();
    expect(currentCheck(lost.drafts)).toEqual(CHECK);
  });

  it("(6) the drawer's conflict: prices moved and the own price moved too, so the check is dropped and nothing more is sent (D6a)", async () => {
    const run = setup({}, priceDraft(), () => own(6));
    run.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED", { sizes: [] }));
    await expect(run.apply()).resolves.toEqual({ kind: "conflict" });
    expect(run.guardReread).toHaveBeenCalledTimes(1);
    expect(run.reviewSend).not.toHaveBeenCalled();
    expect(run.sent).toHaveLength(1);
    expect(run.drafts.current()).toMatchObject({ phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, attempt: null, changes: 1 });
    expect(currentCheck(run.drafts)).toBeNull();
    expect(readProductPriceDraft(run.drafts.current().value)?.priceChange).toEqual({ ...SET, check: null });
    // The own price moved, not the revision: the same conflict.
    const priced = setup({}, priceDraft(), () => own(5, RETAIL_20_UP));
    priced.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    await expect(priced.apply()).resolves.toEqual({ kind: "conflict" });
    expect(priced.reviewSend).not.toHaveBeenCalled();
  });

  it("(7) saved, then the re-read fails: saved with a stale view", async () => {
    const run = setup({ reread: vi.fn(async () => { throw networkDrop(); }) });
    await expect(run.apply()).resolves.toEqual({ kind: "saved", viewStale: true });
    expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale", message: LISTING_SETTINGS_SAVE_WORDS.savedViewStale });
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
  });

  it("(8) an off-contract 2xx, or one for another review, counts as saved with a stale view, never as data", async () => {
    for (const answer of [{ ...APPLIED, extra: 1 }, { ...APPLIED, reviewId: OTHER_REVIEW_ID }, { outcome: "changed" }]) {
      const run = setup();
      run.answers.push(answer);
      await expect(run.apply()).resolves.toEqual({ kind: "saved", viewStale: true });
      expect(run.input.reread).toHaveBeenCalledTimes(1);
      expect(run.drafts.current()).toMatchObject({ phase: "saved_view_stale" });
    }
  });

  it("(9) no send when the draft can't take it, or another listing action runs", async () => {
    const busy = setup();
    busy.drafts.startSave("other", "ls-price-check");
    await expect(busy.apply()).resolves.toEqual({ kind: "not_started", message: null });
    expect(busy.send).not.toHaveBeenCalled();
    expect(busy.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    const disabled = setup({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(disabled.apply()).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refusing = setup({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(refusing.apply()).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refusing.send).not.toHaveBeenCalled();
    expect(refusing.input.callbacks.onSaveSettled).not.toHaveBeenCalled();
    // A check the draft doesn't hold: the body can't be built, never sent, refused with a new key next time.
    const bad = setup({ check: { reviewId: "x", reviewHash: HASH_A } });
    await expect(runPriceChangeApply({ ...bad.input, draft: bad.drafts.current() })).resolves.toMatchObject({
      kind: "failed", failure: { phase: "refused", code: PRICE_CHECK_REQUEST_INVALID, status: null }, refusedSizes: new Set(),
    });
    expect(bad.send).not.toHaveBeenCalled();
    expect(bad.drafts.current()).toMatchObject({ phase: "refused", attempt: null });
  });

  it("(10) never sends a second apply while one is in flight", async () => {
    const run = setup();
    let resolve: (value: unknown) => void = () => undefined;
    run.send.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = run.apply();
    await expect(run.apply()).resolves.toEqual({ kind: "not_started", message: null });
    resolve(APPLIED);
    await expect(first).resolves.toMatchObject({ kind: "saved" });
    expect(run.send).toHaveBeenCalledTimes(1);
  });

  it("(11) BUSY by reason: heavy and key changed say nothing was saved; no reason is unconfirmed (D7a)", async () => {
    const cases: Array<[Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [{ reason: "heavy_write_in_progress", retryAfterSeconds: 5 }, "unreachable", WORDS.busyHeavy],
      [{ reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged],
      [undefined, "uncertain", UNCONFIRMED],
    ];
    for (const [context, phase, message] of cases) {
      const run = setup();
      run.answers.push(apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", context));
      await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase, message } });
      expect(run.drafts.current().attempt?.key).toBe("ls-price-check:1");
      await expect(run.apply()).resolves.toMatchObject({ kind: "saved" });
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price-check:1", "ls-price-check:1"]);
    }
  });

  it("(12) a Check again answered by BUSY, a 429 or the write gate stays unconfirmed, with the same key (D7b)", async () => {
    const run = setup();
    run.answers.push(networkDrop(), apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }), apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"));
    await run.apply();
    await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: WORDS.stillUnconfirmed } });
    await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: WORDS.stillUnconfirmedRateLimited } });
    expect(run.drafts.current()).toMatchObject({ phase: "uncertain", attempt: { key: "ls-price-check:1" } });
    const gate = setup();
    gate.answers.push(networkDrop(), apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" }));
    await gate.apply();
    await expect(gate.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED } });
    expect(gate.input.onBlocked).toHaveBeenCalledTimes(1);
    // A refusal after a Check again stands: a moved check is still re-checked.
    const moved = setup();
    moved.answers.push(networkDrop(), apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    await moved.apply();
    await expect(moved.apply()).resolves.toMatchObject({ kind: "rechecked", after: "prices_moved" });
  });

  it("(13) the three fatal codes are final: refused, a new key next time, never Check again, never a re-check (D7c)", async () => {
    for (const code of ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]) {
      const run = setup();
      run.answers.push(apiError(500, code, undefined, "Something went wrong."));
      await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: WORDS.fatal, code } });
      expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null, changes: 1 });
      expect(run.check).not.toHaveBeenCalled();
      await run.apply();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price-check:1", "ls-price-check:2"]);
    }
  });
});

describe("a refused apply that asks for a new check (plan 7.5, CC-C8, CC-C11; W1's apply cases)", () => {
  it("prices moved: the own price didn't, so a new check replaces the stale one, with the stale line, and is never applied by itself", async () => {
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED", { sizes: [{ productVariantId: 101, beforePriceCents: 1499, afterPriceCents: 1599 }] }));
    const outcome = await run.apply();
    expect(outcome).toEqual({ kind: "rechecked", review: NEW_REVIEW, check: { reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B, after: "prices_moved" }, after: "prices_moved" });
    expect(run.guardReread).toHaveBeenCalledTimes(1);
    expect(run.reviewsSent).toEqual([REVIEW_BODY]);
    expect(run.sent).toHaveLength(1);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    // The new check is in the draft, editing again, with no key (a new apply mints one).
    expect(run.drafts.current()).toMatchObject({ phase: "editing", attempt: null, changes: 1 });
    expect(currentCheck(run.drafts)).toEqual({ reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B, after: "prices_moved" });
    expect(readProductPriceDraft(run.drafts.current().value)?.priceChange.price).toEqual(SET.price);
    // Save on the new check: a new signature, a new key.
    await expect(run.apply()).resolves.toMatchObject({ kind: "saved" });
    expect(run.sent.map((body) => [body.reviewId, body.idempotencyKey])).toEqual([[REVIEW_ID, "ls-price-check:1"], [OTHER_REVIEW_ID, "ls-price-check:2"]]);
  });

  it("a check already applied under another key, or no longer held by the server, gets a new check with why (CC-C8)", async () => {
    const applied = setup();
    applied.answers.push(apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT", { reviewId: REVIEW_ID }));
    await expect(applied.apply()).resolves.toMatchObject({ kind: "rechecked", after: "already_applied", check: { after: "already_applied" } });
    expect(applied.check).toHaveBeenCalledWith("already_applied");
    const expired = setup();
    expired.answers.push(apiError(404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND", { reviewId: REVIEW_ID }));
    await expect(expired.apply()).resolves.toMatchObject({ kind: "rechecked", after: "expired" });
    expect(currentCheck(expired.drafts)?.after).toBe("expired");
    // A release's W9 refusal rolled back with the rest (CC-C11): the sizes moved under the apply.
    for (const [status, code] of [[409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT"], [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT"], [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE"], [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST"]] as const) {
      const run = setup();
      run.answers.push(apiError(status, code, { productVariantId: 101 }));
      await expect(run.apply()).resolves.toMatchObject({ kind: "rechecked", after: "prices_moved" });
    }
  });

  it("checks again once, never loops: the re-check's own refusal is shown, with a new key next time (MAX_PRICE_CHECK_ATTEMPTS)", async () => {
    expect(MAX_PRICE_CHECK_ATTEMPTS).toBe(2);
    const run = setup();
    run.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"), apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    await expect(run.apply()).resolves.toMatchObject({ kind: "rechecked" });
    await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", code: "DROPSHIP_LISTING_PRICES_MOVED", message: "Server words." } });
    expect(run.check).toHaveBeenCalledTimes(1);
    expect(run.reviewsSent).toHaveLength(1);
    expect(run.drafts.current()).toMatchObject({ phase: "refused", attempt: null });
    expect(currentCheck(run.drafts)).toEqual({ reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B, after: "prices_moved" });
    // The runner itself doesn't gate a Save on the shown (refused) check: a new key, never a re-check. The check
    // body's footer keeps Save off after a refusal (`priceCheckFooter`), so the vendor goes Back to editing instead.
    await run.apply();
    expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price-check:1", "ls-price-check:2", "ls-price-check:3"]);
    expect(run.check).toHaveBeenCalledTimes(1);
  });

  it("a check made after a page read's 404 (the owner's own re-check) has had no apply, so its refused apply still gets the one re-check", async () => {
    const run = setup({}, priceDraft(SET, { ...CHECK, after: "page_expired" }));
    run.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"), apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    await expect(run.apply()).resolves.toMatchObject({ kind: "rechecked", after: "prices_moved", check: { after: "prices_moved" } });
    // The re-check's own refusal is shown: still at most MAX_PRICE_CHECK_ATTEMPTS checks for the apply.
    await expect(run.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", code: "DROPSHIP_LISTING_PRICES_MOVED" } });
    expect(run.check).toHaveBeenCalledTimes(1);
    for (const after of ["prices_moved", "already_applied", "expired"] as const) {
      const last = setup({}, priceDraft(SET, { ...CHECK, after }));
      last.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
      await expect(last.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused" } });
      expect(last.check).not.toHaveBeenCalled();
    }
  });

  it("when the new check can't be made, the stale check is dropped and the editor shows the words; a block goes to the banner", async () => {
    const failed = setup();
    failed.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    failed.reviews.push(apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"));
    await expect(failed.apply()).resolves.toEqual({ kind: "recheck_failed", message: LISTING_SETTINGS_PRICE_CHECK_WORDS.tooManySizes, after: "prices_moved" });
    expect(currentCheck(failed.drafts)).toBeNull();
    expect(failed.drafts.current()).toMatchObject({ phase: "editing", changes: 1, attempt: null });
    expect(readProductPriceDraft(failed.drafts.current().value)?.priceChange).toEqual({ ...SET, check: null });
    const dropped = setup();
    dropped.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    dropped.reviews.push(networkDrop());
    await expect(dropped.apply()).resolves.toEqual({ kind: "recheck_failed", message: PRICE_DEFAULT_WORDS.reviewFailed, after: "prices_moved" });
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const gate = setup();
    gate.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    gate.reviews.push(blocked);
    await expect(gate.apply()).resolves.toEqual({ kind: "recheck_failed", message: LISTING_SETTINGS_SAVE_WORDS.blocked, after: "prices_moved" });
    expect(gate.input.onBlocked).toHaveBeenCalledWith(blocked);
    expect(currentCheck(gate.drafts)).toBeNull();
  });

  it("for Set for selected there is no guard: a moved apply checks the same products again", async () => {
    const drafts = reducerDrafts(priceDraft());
    const reviewSend = vi.fn().mockResolvedValue(NEW_REVIEW);
    const check = vi.fn((after: PriceCheckAfter) => runPriceChangeCheck({ productIds: [11, 12, 13], change: SET, after, send: reviewSend }));
    const run: PriceChangeApplyRun = {
      draft: drafts.current(), check: CHECK, drafts, callbacks: { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() },
      send: vi.fn(async () => { throw apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"); }), reread: vi.fn(), onSettingsSaved: vi.fn(),
      recheck: { check, withCheck: (next) => productPriceDraftWithCheck(readProductPriceDraft(drafts.current().value)!, next) },
    };
    await expect(runPriceChangeApply(run)).resolves.toMatchObject({ kind: "rechecked", check: { reviewId: OTHER_REVIEW_ID, after: "prices_moved" } });
    expect(reviewSend).toHaveBeenCalledWith({ kind: "product_prices", productIds: [11, 12, 13], price: COST_35, releaseExactPrices: true });
    expect(reviewSend.mock.calls[0][0]).toEqual(productPricesReviewBody({ productIds: [11, 12, 13], price: SET.price, releaseExactPrices: true }));
  });
});

/**
 * Every code W7's route answers, through the apply runner (plan 3.3 rows 1-23, 7.5):
 * [status, code, context, phase, words (null: the server's), re-check].
 */
const EBAY_DOWN = "Can't reach eBay right now. Nothing was saved. Try again.";
type Row = readonly [number, string | null, Record<string, unknown> | undefined, WriteFailurePhase, string | null, boolean];
const W7_ROWS: readonly Row[] = [
  [429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", undefined, "rate_limited", LISTING_SETTINGS_SAVE_WORDS.rateLimited, false],
  [401, "DROPSHIP_AUTH_REQUIRED", undefined, "refused", WORDS.signedOut, false],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }, "unreachable", WORDS.busyHeavy, false],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }, "unreachable", WORDS.busyKeyChanged, false],
  [503, "DROPSHIP_LISTING_SETTINGS_BUSY", undefined, "uncertain", UNCONFIRMED, false],
  ...["DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "DROPSHIP_CREDENTIAL_CHANGED"].map((code): Row => [503, code, undefined, "unreachable", EBAY_DOWN, false]),
  [502, null, undefined, "uncertain", UNCONFIRMED, false],
  [504, null, undefined, "uncertain", UNCONFIRMED, false],
  [500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, false],
  [500, "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", undefined, "refused", WORDS.fatal, false],
  [500, "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", undefined, "refused", WORDS.fatal, false],
  [500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", undefined, "uncertain", UNCONFIRMED, false],
  // Plan 7.5: the apply's own refusals, and which get a new check.
  [409, "DROPSHIP_LISTING_PRICES_MOVED", { sizes: [] }, "refused", null, true],
  [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", { reviewId: REVIEW_ID }, "refused", LISTING_SETTINGS_SAVE_WORDS.keyReused, true],
  [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND", { reviewId: REVIEW_ID }, "refused", LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone, true],
  [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { productVariantId: 101 }, "refused", null, true],
  [422, "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { productVariantId: 101 }, "refused", null, true],
  [404, "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", { productVariantId: 101 }, "refused", null, true],
  [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { productVariantId: 101 }, "refused", null, true],
  [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizes: [{ productVariantId: 101 }], sizeCount: 1 }, "refused", "● 1 size would be left without a price. Give it an exact price in Products first.", false],
  [422, "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", { releaseCount: 236, maxReleases: 200 }, "refused", "You can clear up to 200 exact prices at once. This would clear 236. Choose fewer products.", false],
  [422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", undefined, "refused", LISTING_SETTINGS_PRICE_CHECK_WORDS.tooManySizes, false],
  [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { reason: "price_check_rows", textBytes: 30_000_100 }, "refused", LISTING_SETTINGS_PRICE_CHECK_WORDS.tooHeavy, false],
  [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_000_100 }, "refused", LISTING_SETTINGS_PRICE_CHECK_WORDS.tooHeavy, false],
  [422, "DROPSHIP_PRICING_RULES_NOT_CONFIGURED", undefined, "refused", WORDS.invalid, false],
  [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 1 }, "refused", WORDS.invalid, false],
  [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", undefined, "refused", WORDS.invalid, false],
  [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", undefined, "refused", WORDS.invalid, false],
  [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", undefined, "refused", WORDS.invalid, false],
  [413, "DROPSHIP_REQUEST_TOO_LARGE", undefined, "refused", WORDS.tooBig, false],
  [400, "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", { issues: [] }, "refused", WORDS.invalid, false],
  [400, "DROPSHIP_REQUEST_JSON_INVALID", undefined, "refused", WORDS.invalid, false],
  [403, "DROPSHIP_LISTING_VENDOR_BLOCKED", { reason: "paused" }, "blocked", "Nothing was saved.", false],
  [403, "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", { reason: "lapsed" }, "blocked", "Nothing was saved.", false],
  [403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" }, "blocked", "Nothing was saved.", false],
  [404, "DROPSHIP_STORE_CONNECTION_REQUIRED", undefined, "blocked", "Nothing was saved.", false],
  [409, "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", undefined, "blocked", "Nothing was saved.", false],
  [422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", undefined, "blocked", "Nothing was saved.", false],
  [422, "DROPSHIP_SOMETHING_NEW", undefined, "refused", null, false],
];
const KEY_KEPT: ReadonlySet<WriteFailurePhase> = new Set(["uncertain", "unreachable", "rate_limited"]);

describe("every W7 code through the apply runner (plan 3.3, 7.5)", () => {
  it.each(W7_ROWS.map((entry) => [entry[0], entry[1] ?? "no code", entry] as const))("%i %s", async (_status, _code, entry) => {
    const [status, code, context, phase, words, rechecks] = entry;
    const run = setup();
    run.answers.push(apiError(status, code, context));
    const outcome = await run.apply();
    if (rechecks) {
      expect(outcome).toMatchObject({ kind: "rechecked", after: code === "DROPSHIP_IDEMPOTENCY_CONFLICT" ? "already_applied" : code === "DROPSHIP_PRICING_REVIEW_NOT_FOUND" ? "expired" : "prices_moved" });
      expect(run.check).toHaveBeenCalledTimes(1);
      expect(run.drafts.current()).toMatchObject({ phase: "editing", attempt: null, changes: 1 });
      return;
    }
    expect(outcome).toEqual({ kind: "failed", failure: { phase, message: words ?? "Server words.", code, status, fields: [] }, refusedSizes: refusedSizes(context) });
    expect(run.drafts.current()).toMatchObject({ phase, changes: 1, message: words ?? "Server words." });
    expect(run.drafts.current().attempt?.key ?? null).toBe(KEY_KEPT.has(phase) ? "ls-price-check:1" : null);
    expect(run.check).not.toHaveBeenCalled();
    // Only a block goes to the banner; a refusal (the too-large codes included) never does (D8).
    expect(run.input.onBlocked).toHaveBeenCalledTimes(phase === "blocked" ? 1 : 0);
    expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
    expect(words ?? "Server words.").not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
  });

  function refusedSizes(context: Record<string, unknown> | undefined): ReadonlySet<number> {
    const sizes = context?.sizes;
    return new Set(Array.isArray(sizes) ? sizes.map((size) => (size as { productVariantId: number }).productVariantId) : []);
  }
});
