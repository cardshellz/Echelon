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
import { listingSettingsCategoryDetailSchema, listingSettingsProductOwnSettingsSchema, type ListingSettingsCategoryDetail } from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { DropshipApiError } from "../dropship-ops-surface";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  categoryEditorId,
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type DraftValue,
  type ListingSettingsDraft,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import {
  categoryDraftValue,
  categoryPriceCheckBaseOf,
  categoryPriceDraftWithCheck,
  categoryPriceReviewRequest,
  emptyCategoryChoices,
  readCategoryDraft,
  type CategoryPriceReviewInput,
} from "../dropship-listing-settings-categories";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import { PRICE_CHECK_REQUEST_INVALID, PriceCheckRequestError, priceCheckRefOf, productPricesReviewBody } from "../dropship-listing-settings-price-check";
import {
  fetchPriceChangeReviewPage,
  loadLatestProductPrice,
  priceChangesEndpoint,
  readAppliedPriceChange,
  readPriceCheckPage,
  refreshAfterCategoryPriceApply,
  refreshAfterPriceChangeApply,
  requestPriceChangeReview,
  rereadProductPriceBase,
  runPriceChangeApply,
  runPriceChangeCheck,
  sendPriceChangeApply,
  sendPriceChangeReview,
  settlePriceCheckConflict,
  type CategoryPriceCheckRun,
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
import type { ProductSettingsSaveDrafts } from "../dropship-listing-settings-product-requests";
import { CHECK_NEW_PRICES_WORDS, MAX_PRICE_CHECK_ATTEMPTS, PRICE_DEFAULT_WORDS } from "../dropship-listing-settings-recipe";
import {
  LISTING_SETTINGS_CATEGORY_PRICE_WORDS,
  LISTING_SETTINGS_CATEGORY_WORDS,
  LISTING_SETTINGS_EDIT_WORDS,
  LISTING_SETTINGS_PRICE_CHECK_WORDS,
} from "../dropship-listing-settings-words";

/** W7 from the drawer and from "Set for selected" (plan PR 10d, 7.3, 7.5, 7.6, 3.3, 3.6, D5, D6a, D7, D9), and from the category editor (PR 10f, plan 9.2, 9.4). */

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

// ---------------------------------------------------------------------------
// The category kind (PR 10f, plan 9.2, 9.4; W7 `category_price`)
// ---------------------------------------------------------------------------

const CATEGORY = 40;
const CATEGORY_DETAIL: ListingSettingsCategoryDetail = listingSettingsCategoryDetailSchema.parse({
  storeConnectionId: STORE, categoryId: CATEGORY, name: "Sleeves", productCount: 15, revisionId: 7,
  settings: {
    price: { source: "store_default", value: RETAIL_20_UP },
    ebayCategory: { source: "none", value: null },
    storeShelf: { source: "store_default", value: { mode: "none" } },
    shippingPolicy: { source: "category", value: { id: "F2", name: "Fast Free" } },
    returnPolicy: { source: "store_default", value: { id: "R1", name: null } },
    paymentPolicy: { source: "none", value: null },
    textAbove: { source: "none", value: null },
    textBelow: { source: "none", value: null },
  },
  ownValues: [{ productId: 12, revisionId: null, fields: ["shippingPolicy"] }, { productId: 11, revisionId: 5, fields: ["shippingPolicy", "price"] }],
  examples: [],
  generatedAt: "2026-10-14T12:00:00.000Z",
});
/** The editor's draft value: the price set, the shipping policy changed with "Also clear theirs" ticked (riding along, D2). */
const CATEGORY_VALUE = categoryDraftValue(CATEGORY_DETAIL, { ...emptyCategoryChoices(), shippingPolicy: { mode: "set", value: { id: "F1" } } }, ["shippingPolicy"], { choice: { mode: "set", value: COST_35 }, check: null });
const CATEGORY_REQUEST: CategoryPriceReviewInput = categoryPriceReviewRequest(CATEGORY_VALUE);
const CATEGORY_BASE = categoryPriceCheckBaseOf(CATEGORY_VALUE);
const CATEGORY_REVIEW = review({ kind: "category_price" });
const CATEGORY_NEW_REVIEW = review({ kind: "category_price", reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B });
const CATEGORY_CHECK: PriceCheckRef = priceCheckRefOf(CATEGORY_REVIEW);
const CATEGORY_APPLIED = { ...APPLIED, categoryRevisionId: 8 };
const PRODUCTS_CHANGED = "The products in Sleeves changed. Load the latest and save again. A Card Shellz change can take a minute to show.";
const CATEGORY_CONFLICTS: ReadonlyArray<readonly [DropshipApiError, string]> = [
  [apiError(409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", { categoryId: CATEGORY, expectedRevisionId: 7, actualRevisionId: 8 }), LISTING_SETTINGS_SAVE_WORDS.conflict],
  [apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts: [{ productId: 11, expectedRevisionId: 5, actualRevisionId: 6 }], conflictCount: 1 }), PRODUCTS_CHANGED],
];
/** The category kind's own refusals, their words, and what the editor does beside showing them (plan 9.4, as W12's 8.6). */
const CATEGORY_REFUSALS: ReadonlyArray<readonly [DropshipApiError, string, "reread_card" | "close" | null]> = [
  [apiError(409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 }), LISTING_SETTINGS_CATEGORY_WORDS.olderRules, "reread_card"],
  [apiError(404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", { categoryId: CATEGORY }), "No chosen product is in this category any more.", "close"],
  [apiError(422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { reason: "price_check_rows", textBytes: 30_000_100, maxTextBytes: 30_000_000, productCount: 15 }), LISTING_SETTINGS_CATEGORY_PRICE_WORDS.tooHeavy, null],
  [apiError(422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_000_100 }), LISTING_SETTINGS_CATEGORY_PRICE_WORDS.tooHeavy, null],
  [apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"), LISTING_SETTINGS_CATEGORY_PRICE_WORDS.tooManySizes, null],
];

/** The category editor's draft on CATEGORY_DETAIL, holding CATEGORY_VALUE with `check` (null: before any check). */
function categoryDraft(check: PriceCheckRef | null = CATEGORY_CHECK): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(CATEGORY_DETAIL) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: categoryPriceDraftWithCheck(CATEGORY_VALUE, check) })!;
}

const currentCategoryCheck = (drafts: ReturnType<typeof reducerDrafts>) => readCategoryDraft(drafts.current().value)?.price.check ?? null;

type LatestDetail = Pick<ListingSettingsCategoryDetail, "revisionId" | "ownValues">;

/** A category check run on `drafts`, with the editor's guard reading `latest` (plan 9.4). */
function categoryCheckRun(drafts: ProductSettingsSaveDrafts, send: (body: ReviewPriceChangesInput) => Promise<unknown>, latest: () => Promise<LatestDetail> = async () => CATEGORY_DETAIL, after: PriceCheckAfter | null = null): CategoryPriceCheckRun {
  return { kind: "category_price", request: CATEGORY_REQUEST, categoryName: "Sleeves", after, send, drafts, guard: { base: CATEGORY_BASE, reread: latest } };
}

/** An apply run on the category editor's draft, as `setup` is for the drawer's: the re-check runs through the editor's guard. */
function categorySetup(overrides: Partial<PriceChangeApplyRun> = {}, start: ListingSettingsDraft = categoryDraft(), latestDetail: () => LatestDetail = () => CATEGORY_DETAIL) {
  const drafts = reducerDrafts(start);
  const sent: ApplyPriceChangesInput[] = [];
  const reviewsSent: ReviewPriceChangesInput[] = [];
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const answers: Array<unknown | Error> = [];
  const reviews: Array<unknown | Error> = [];
  const send = vi.fn(async (body: ApplyPriceChangesInput) => {
    sent.push(body);
    const next = answers.length > 0 ? answers.shift() : CATEGORY_APPLIED;
    if (next instanceof Error) throw next;
    return next;
  });
  const reviewSend = vi.fn(async (body: ReviewPriceChangesInput) => {
    reviewsSent.push(body);
    const next = reviews.length > 0 ? reviews.shift() : CATEGORY_NEW_REVIEW;
    if (next instanceof Error) throw next;
    return next;
  });
  const guardReread = vi.fn(async () => latestDetail());
  const check = vi.fn((after: PriceCheckAfter): Promise<PriceChangeCheckOutcome> => runPriceChangeCheck(categoryCheckRun(drafts, reviewSend, guardReread, after)));
  const input: PriceChangeApplyRun = {
    kind: "category_price", categoryName: "Sleeves",
    draft: drafts.current(), check: currentCategoryCheck(drafts) ?? CATEGORY_CHECK, drafts, callbacks, send,
    reread: vi.fn(async () => undefined), onSettingsSaved: vi.fn(), onBlocked: vi.fn(),
    recheck: { check, withCheck: (next) => categoryPriceDraftWithCheck(readCategoryDraft(drafts.current().value)!, next) },
    ...overrides,
  };
  const apply = () => runPriceChangeApply({ ...input, draft: drafts.current(), check: currentCategoryCheck(drafts) ?? input.check });
  return { input, drafts, sent, reviewsSent, callbacks, answers, reviews, send, reviewSend, guardReread, check, apply };
}

describe("the category check (PR 10f, plan 9.2, 9.4)", () => {
  it("sends the editor's request as built, after the detail is read again; a moved revision or clear set is the conflict, and nothing is sent", async () => {
    const drafts = reducerDrafts(categoryDraft(null));
    const send = vi.fn().mockResolvedValue(CATEGORY_REVIEW);
    await expect(runPriceChangeCheck(categoryCheckRun(drafts, send))).resolves.toEqual({ kind: "checked", review: CATEGORY_REVIEW, check: CATEGORY_CHECK, request: CATEGORY_REQUEST });
    expect(send).toHaveBeenCalledWith(CATEGORY_REQUEST);
    expect(reviewPriceChangesInputSchema.safeParse(send.mock.calls[0][0]).success).toBe(true);
    expect(send.mock.calls[0][0]).toMatchObject({ kind: "category_price", categoryId: CATEGORY, expectedRevisionId: 7, patch: { price: COST_35, shippingPolicy: { id: "F1" } }, clear: { fields: ["shippingPolicy"] } });
    expect(drafts.current()).toMatchObject({ phase: "editing", changes: 3 });
    // A re-check carries why, for the stale line.
    await expect(runPriceChangeCheck(categoryCheckRun(drafts, send, undefined, "prices_moved"))).resolves.toMatchObject({ kind: "checked", check: { ...CATEGORY_CHECK, after: "prices_moved" } });
    // The category's revision moved, a ticked product's revision moved, or one left the clear set: the conflict, nothing sent (D6).
    const moved: LatestDetail[] = [
      { ...CATEGORY_DETAIL, revisionId: 8 },
      { ...CATEGORY_DETAIL, revisionId: null },
      { ...CATEGORY_DETAIL, ownValues: [CATEGORY_DETAIL.ownValues[0], { productId: 11, revisionId: 6, fields: ["shippingPolicy", "price"] }] },
      { ...CATEGORY_DETAIL, ownValues: [CATEGORY_DETAIL.ownValues[1]] },
      { ...CATEGORY_DETAIL, ownValues: [...CATEGORY_DETAIL.ownValues, { productId: 13, revisionId: 2, fields: ["shippingPolicy"] }] },
    ];
    for (const latest of moved) {
      const stale = reducerDrafts(categoryDraft(null));
      const never = vi.fn();
      await expect(runPriceChangeCheck(categoryCheckRun(stale, never, async () => latest))).resolves.toEqual({ kind: "conflict" });
      expect(never).not.toHaveBeenCalled();
      expect(stale.current()).toMatchObject({ phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, attempt: null, changes: 3 });
    }
    // A product holding its own value in a setting that isn't ticked may change: not this check's business.
    const unticked: LatestDetail = { ...CATEGORY_DETAIL, ownValues: [...CATEGORY_DETAIL.ownValues, { productId: 13, revisionId: 2, fields: ["storeShelf"] }] };
    await expect(runPriceChangeCheck(categoryCheckRun(reducerDrafts(categoryDraft(null)), send, async () => unticked))).resolves.toMatchObject({ kind: "checked" });
    // A guard read that fails, or an answer of the products kind, is "couldn't check"; nothing is sent for the first.
    const dropped = vi.fn();
    await expect(runPriceChangeCheck(categoryCheckRun(reducerDrafts(categoryDraft(null)), dropped, async () => { throw networkDrop(); }))).resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    expect(dropped).not.toHaveBeenCalled();
    await expect(runPriceChangeCheck(categoryCheckRun(reducerDrafts(categoryDraft(null)), async () => review()))).resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    // Without a guard (the review alone) the request still goes as built.
    await expect(runPriceChangeCheck({ kind: "category_price", request: CATEGORY_REQUEST, categoryName: "Sleeves", send, drafts })).resolves.toMatchObject({ kind: "checked", request: CATEGORY_REQUEST });
  });

  it("settles the review's own version conflicts as the draft's conflict in their words, and refuses older rules, a gone category and too much text with the editor's (9.4)", async () => {
    for (const [thrown, message] of CATEGORY_CONFLICTS) {
      const drafts = reducerDrafts(categoryDraft(null));
      await expect(runPriceChangeCheck(categoryCheckRun(drafts, async () => { throw thrown; }))).resolves.toEqual({ kind: "conflict" });
      expect(drafts.current()).toMatchObject({ phase: "conflict", message, attempt: null, changes: 3 });
      // Its Load latest re-reads the category (`loadLatestCategory`); the check it held is none yet.
      expect(currentCategoryCheck(drafts)).toBeNull();
    }
    for (const [thrown, message, followUp] of CATEGORY_REFUSALS) {
      const drafts = reducerDrafts(categoryDraft(null));
      // Older rules and a gone category carry what the editor does next (the card re-read, the close); the rest only words.
      await expect(runPriceChangeCheck(categoryCheckRun(drafts, async () => { throw thrown; }))).resolves.toEqual(followUp === null ? { kind: "failed", message } : { kind: "failed", message, followUp });
      expect(drafts.current()).toMatchObject({ phase: "editing", attempt: null, changes: 3 });
      expect(message).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+/);
    }
    // The products kind never carries a follow-up: its refusals name no category.
    await expect(requestPriceChangeReview(async () => { throw CATEGORY_REFUSALS[0][0]; })).resolves.toEqual({ kind: "failed", message: WORDS.invalid });
    // The review's outcome by kind: the products kind has no conflict (the same code is just "can't happen" there).
    const productsConflict = CATEGORY_CONFLICTS[1][0];
    await expect(requestPriceChangeReview(async () => { throw productsConflict; }, "category_price", { categoryName: "Sleeves" })).resolves.toEqual({ kind: "conflict", message: PRODUCTS_CHANGED });
    await expect(requestPriceChangeReview(async () => { throw productsConflict; }, "category_price")).resolves.toEqual({ kind: "conflict", message: "The products in this category changed. Load the latest and save again. A Card Shellz change can take a minute to show." });
    await expect(requestPriceChangeReview(async () => { throw productsConflict; })).resolves.toEqual({ kind: "failed", message: WORDS.invalid });
    await expect(requestPriceChangeReview(async () => CATEGORY_REVIEW, "category_price")).resolves.toEqual({ kind: "ok", review: CATEGORY_REVIEW });
    await expect(requestPriceChangeReview(async () => CATEGORY_REVIEW)).resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    // A block goes to the banner through the check run too.
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    await expect(runPriceChangeCheck(categoryCheckRun(reducerDrafts(categoryDraft(null)), async () => { throw blocked; }))).resolves.toEqual({ kind: "blocked", error: blocked });
  });
});

describe("the category apply (PR 10f, plan 9.4; CC-C3)", () => {
  it("sends the check with the draft's ls-price-check key, re-reads, then tells the step; its version conflicts are the editor's conflict with Load latest, never a re-check", async () => {
    const run = categorySetup();
    await expect(run.apply()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(run.sent).toEqual([{ reviewId: REVIEW_ID, reviewHash: HASH_A, idempotencyKey: "ls-price-check:1" }]);
    expect(run.input.reread).toHaveBeenCalledTimes(1);
    expect(run.input.onSettingsSaved).toHaveBeenCalledTimes(1);
    expect(run.check).not.toHaveBeenCalled();
    expect(run.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
    // A replay, and an answer whose category revision is null, both count as saved.
    for (const answer of [{ ...REPLAYED, categoryRevisionId: 8 }, { ...CATEGORY_APPLIED, categoryRevisionId: null }]) {
      const again = categorySetup();
      again.answers.push(answer);
      await expect(again.apply()).resolves.toEqual({ kind: "saved", viewStale: false });
    }
    for (const [thrown, message] of CATEGORY_CONFLICTS) {
      const conflict = categorySetup();
      conflict.answers.push(thrown);
      await expect(conflict.apply()).resolves.toEqual({ kind: "conflict" });
      expect(conflict.check).not.toHaveBeenCalled();
      expect(conflict.guardReread).not.toHaveBeenCalled();
      expect(conflict.drafts.current()).toMatchObject({ phase: "conflict", message, attempt: null, changes: 3 });
      // The check stays in the draft until Load latest re-reads the category and drops it (`rebaseCategoryDraft`); the editor's body shows meanwhile.
      expect(currentCategoryCheck(conflict.drafts)).toEqual(CATEGORY_CHECK);
      expect(conflict.input.onSettingsSaved).not.toHaveBeenCalled();
      expect(conflict.input.onBlocked).not.toHaveBeenCalled();
    }
  });

  it("prices moved, already applied or expired under the apply: the detail is read again; the same revision and clear set get the one re-check with the same request, a moved one the conflict", async () => {
    const codes = [
      [409, "DROPSHIP_LISTING_PRICES_MOVED", { sizes: [{ productVariantId: 101, beforePriceCents: 1499, afterPriceCents: 1599 }] }, "prices_moved"],
      [409, "DROPSHIP_IDEMPOTENCY_CONFLICT", { reviewId: REVIEW_ID }, "already_applied"],
      [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND", { reviewId: REVIEW_ID }, "expired"],
      // A size's compare-and-set refusal rolled back with the rest (CC-C11): the sizes moved under the apply.
      [409, "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { productVariantId: 101 }, "prices_moved"],
    ] as const;
    for (const [status, code, context, after] of codes) {
      const run = categorySetup();
      run.answers.push(apiError(status, code, { ...context }));
      await expect(run.apply()).resolves.toEqual({ kind: "rechecked", review: CATEGORY_NEW_REVIEW, check: { reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B, after }, after });
      expect(run.guardReread).toHaveBeenCalledTimes(1);
      expect(run.reviewsSent).toEqual([CATEGORY_REQUEST]);
      expect(run.sent).toHaveLength(1);
      expect(run.input.onSettingsSaved).not.toHaveBeenCalled();
      // The new check is in the draft with the vendor's changes untouched, editing again, with no key.
      expect(currentCategoryCheck(run.drafts)).toEqual({ reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B, after });
      expect(readCategoryDraft(run.drafts.current().value)).toMatchObject({ shippingPolicy: { mode: "set", value: { id: "F1" } }, clear: ["shippingPolicy"], price: { choice: { mode: "set", value: COST_35 } } });
      expect(run.drafts.current()).toMatchObject({ phase: "editing", attempt: null, changes: 3 });
      // Save on the new check: a new signature, a new key; the re-check's own refusal is shown, never looped.
      await expect(run.apply()).resolves.toMatchObject({ kind: "saved" });
      expect(run.sent.map((body) => [body.reviewId, body.idempotencyKey])).toEqual([[REVIEW_ID, "ls-price-check:1"], [OTHER_REVIEW_ID, "ls-price-check:2"]]);
    }
    const looped = categorySetup();
    looped.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"), apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    await expect(looped.apply()).resolves.toMatchObject({ kind: "rechecked" });
    await expect(looped.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", code: "DROPSHIP_LISTING_PRICES_MOVED" } });
    expect(looped.check).toHaveBeenCalledTimes(1);
    // The category's revision, or its clear set, moved under the apply: the conflict, nothing re-checked, the stale check gone.
    for (const latest of [{ ...CATEGORY_DETAIL, revisionId: 8 }, { ...CATEGORY_DETAIL, ownValues: [CATEGORY_DETAIL.ownValues[1]] }]) {
      const moved = categorySetup({}, categoryDraft(), () => latest);
      moved.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
      await expect(moved.apply()).resolves.toEqual({ kind: "conflict" });
      expect(moved.guardReread).toHaveBeenCalledTimes(1);
      expect(moved.reviewSend).not.toHaveBeenCalled();
      expect(moved.drafts.current()).toMatchObject({ phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, attempt: null, changes: 3 });
      expect(currentCategoryCheck(moved.drafts)).toBeNull();
    }
    // The re-check's review answers a version conflict: the same conflict.
    const answered = categorySetup();
    answered.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    answered.reviews.push(CATEGORY_CONFLICTS[1][0]);
    await expect(answered.apply()).resolves.toEqual({ kind: "conflict" });
    expect(answered.drafts.current()).toMatchObject({ phase: "conflict", message: PRODUCTS_CHANGED });
    // When the new check can't be made the stale one is dropped and the editor shows the words.
    const failed = categorySetup();
    failed.answers.push(apiError(409, "DROPSHIP_LISTING_PRICES_MOVED"));
    failed.reviews.push(CATEGORY_REFUSALS[0][0]);
    await expect(failed.apply()).resolves.toEqual({ kind: "recheck_failed", message: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, after: "prices_moved", followUp: "reread_card" });
    expect(currentCategoryCheck(failed.drafts)).toBeNull();
    expect(failed.drafts.current()).toMatchObject({ phase: "editing", changes: 3, attempt: null });
  });

  it("refuses older rules, a gone category and too much text with the editor's words, a new key next time and no re-check (9.4)", async () => {
    for (const [thrown, message] of CATEGORY_REFUSALS) {
      const run = categorySetup();
      run.answers.push(thrown);
      await expect(run.apply()).resolves.toEqual({ kind: "failed", failure: { phase: "refused", message, code: thrown.code, status: thrown.status, fields: [] }, refusedSizes: new Set() });
      expect(run.check).not.toHaveBeenCalled();
      expect(run.guardReread).not.toHaveBeenCalled();
      expect(run.input.onBlocked).not.toHaveBeenCalled();
      expect(run.drafts.current()).toMatchObject({ phase: "refused", message, attempt: null, changes: 3 });
      expect(currentCategoryCheck(run.drafts)).toEqual(CATEGORY_CHECK);
      await run.apply();
      expect(run.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price-check:1", "ls-price-check:2"]);
    }
    // The shared rows read the same for the category kind: a drop is unconfirmed with its key kept, a block goes to the banner.
    const dropped = categorySetup();
    dropped.answers.push(networkDrop(), { ...REPLAYED, categoryRevisionId: 8 });
    await expect(dropped.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: UNCONFIRMED } });
    await expect(dropped.apply()).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(dropped.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price-check:1", "ls-price-check:1"]);
    const blocked = apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" });
    const gate = categorySetup();
    gate.answers.push(blocked);
    await expect(gate.apply()).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked" } });
    expect(gate.input.onBlocked).toHaveBeenCalledWith(blocked);
  });

  it("after a category apply the categories, the lists, the summary, every product read and the size prices are read again, and the category's detail fresh (D9, 9.2)", async () => {
    const calls: string[] = [];
    const client = {
      cancelQueries: vi.fn(async (filter: { queryKey: readonly unknown[]; exact?: boolean }) => {
        calls.push(`cancel ${String(filter.queryKey[3])}${filter.exact ? `:${String(filter.queryKey[4])}` : ""}`);
      }),
      invalidateQueries: vi.fn(async (filter: { queryKey?: readonly unknown[]; predicate?: (query: { queryKey: readonly unknown[] }) => boolean }) => {
        calls.push(filter.queryKey ? `invalidate ${String(filter.queryKey[3])}` : "invalidate sizes");
        if (filter.predicate) {
          expect(filter.predicate({ queryKey: [`/api/dropship/listings/stores/${STORE}/variants/101/price`] })).toBe(true);
          expect(filter.predicate({ queryKey: [`/api/dropship/listings/stores/${STORE + 1}/variants/101/price`] })).toBe(false);
        }
      }),
      fetchQuery: vi.fn(async ({ queryKey }: { queryKey: readonly unknown[] }) => { calls.push(`fetch ${String(queryKey[3])}:${String(queryKey[4])}`); return CATEGORY_DETAIL; }),
    };
    await refreshAfterCategoryPriceApply(client as unknown as PriceCheckQueryClient, STORE, CATEGORY);
    expect(calls).toEqual([
      "cancel categories", "cancel products", "cancel prices", "cancel summary", "cancel product", "cancel product-own", "cancel category:40",
      "invalidate categories", "invalidate products", "invalidate prices", "invalidate summary", "invalidate product", "invalidate product-own", "invalidate sizes",
      "fetch category:40",
    ]);
    for (const read of ["categories", "products", "prices", "summary", "product", "product-own"]) {
      expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: [...listingSettingsQueryKey(STORE), read] }, { throwOnError: true });
    }
    expect(client.fetchQuery).toHaveBeenCalledWith(expect.objectContaining({ queryKey: [...listingSettingsQueryKey(STORE), "category", CATEGORY], staleTime: 0, retry: false }));
    client.fetchQuery.mockRejectedValueOnce(networkDrop());
    await expect(refreshAfterCategoryPriceApply(client as unknown as PriceCheckQueryClient, STORE, CATEGORY)).rejects.toThrow("Failed to fetch");
    client.invalidateQueries.mockRejectedValueOnce(networkDrop());
    await expect(refreshAfterCategoryPriceApply(client as unknown as PriceCheckQueryClient, STORE, CATEGORY)).rejects.toThrow("Failed to fetch");
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
