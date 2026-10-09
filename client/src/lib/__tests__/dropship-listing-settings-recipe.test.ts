import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { MAX_LISTING_PRICE_CENTS } from "@shared/dropship/listing-price";
import type { ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import {
  applyPricingRulesInputSchema,
  pricingReviewResponseSchema,
  reviewPricingRulesInputSchema,
  type PricingImpactRow,
  type PricingProfile,
  type PricingProfileState,
  type PricingRecipe,
  type PricingReviewResponse,
} from "@shared/dropship/pricing-rules";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  nextSaveAttempt,
  reduceListingSettingsDraft,
  type DraftValue,
  type ListingSettingsDraft,
} from "../dropship-listing-settings-drafts";
import { LISTING_SETTINGS_OFF_CONTRACT, ListingSettingsReadError } from "../dropship-listing-settings";
import { builtFromWords } from "../dropship-listing-settings-price-words";
import { DropshipApiError } from "../dropship-ops-surface";
import { SUGGESTED_PRICING_RECIPE } from "../dropship-pricing-rules";
import {
  buildPricingApplyRequest,
  buildPricingReviewRequest,
  CHECK_NEW_PRICES_WORDS,
  checkNewPricesFooter,
  checkPricingReviewPage,
  decideAfterStaleApply,
  decideStaleCheck,
  fetchPricingReviewPage,
  hasNextReviewPage,
  hasPreviousReviewPage,
  isPriceSuggestion,
  isStoreSizePriceQuery,
  MAX_MARKUP_BPS,
  parseFlatCents,
  parsePercentBps,
  PRICE_DEFAULT_REQUEST_INVALID,
  PRICE_DEFAULT_WORDS,
  PriceDefaultRequestError,
  priceBaseMoved,
  priceDefaultBase,
  priceEditorFooter,
  priceRecipeDraft,
  pricingApplySignature,
  pricingRulesQueryKey,
  pricingRulesQueryOptions,
  readPriceRecipeDraft,
  recipeFromDraft,
  refreshAfterPricingApply,
  requestPricingReview,
  reviewBlockedWords,
  reviewCountsWords,
  reviewPageWords,
  reviewPriceWords,
  reviewRowBuiltFrom,
  reviewRowNotes,
  reviewSizeLine,
  runPriceCheck,
  runPricingApply,
  settlePriceConflictBeforeSending,
  type PriceRecipeDraft,
  type PriceSaveDrafts,
} from "../dropship-listing-settings-recipe";

const STORE = 22;
const ENDPOINT = `/api/dropship/listings/stores/${STORE}/pricing-rules`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REVIEW_ID = "22222222-2222-4222-8222-222222222222";

const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 0, rounding: "cent" };
const ENVELOPES = {
  id: "envelopes", name: "Envelopes", priority: 10,
  scope: { type: "category" as const, category: "Envelopes" },
  recipe: { basis: "catalog_retail" as const, markupBps: 3000, flatCents: 0, rounding: "cent" as const },
};
const PROFILE: PricingProfile = { defaultRecipe: RETAIL_20_UP, groups: [ENVELOPES] };
const STATE: PricingProfileState = { revisionId: 7, profile: PROFILE, updatedAt: "2026-10-01T12:00:00.000Z" };
const EMPTY_STATE: PricingProfileState = { revisionId: null, profile: null, updatedAt: null };
const EDITABLE = { editable: true } as const;
const NOT_EDITABLE = { editable: false } as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function row(overrides: Partial<PricingImpactRow> = {}): PricingImpactRow {
  return {
    productVariantId: 101,
    title: "Easy Glide Soft Sleeves",
    sku: "EG-SLV-STD-5PCK-B500",
    previousPriceCents: 1499,
    priceCents: 1599,
    productCostCents: 980,
    ruleName: "Store default rule",
    preserved: false,
    issues: [],
    settingRevisionId: null,
    evidenceHash: HASH_A,
    sizeName: "Box of 5 Packs of 100",
    basis: "catalog_retail",
    basisCents: 1250,
    warnings: [],
    ...overrides,
  };
}

function review(overrides: Partial<PricingReviewResponse> = {}): PricingReviewResponse {
  return pricingReviewResponseSchema.parse({
    reviewId: REVIEW_ID,
    reviewHash: HASH_A,
    createdAt: "2026-10-09T12:00:00.000Z",
    summary: { total: 1, changed: 1, preserved: 0, blocked: 0 },
    rows: [row()],
    page: 0,
    ...overrides,
  });
}

/** A size price from the read model, for comparing the check's words with 1A's Built from words. */
function sizePrice(overrides: Partial<ListingSettingsSizePrice>): ListingSettingsSizePrice {
  return {
    productVariantId: 101, productId: 11, productName: "Easy Glide Soft Sleeves", sizeName: "Box of 5 Packs of 100",
    sku: "EG-SLV-STD-5PCK-B500", priceCents: 1599, source: "rules", rule: null, basis: "catalog_retail",
    basisAmountCents: 1250, issue: null, costCents: 980, belowCostByCents: null, limits: [], pausedSince: null,
    settingRevisionId: null, ...overrides,
  };
}

/**
 * The draft provider's save calls over the real reducer, with a key maker
 * that counts how many keys it made.
 */
function draftsHarness(value: PriceRecipeDraft = priceRecipeDraft(RETAIL_20_UP)) {
  let draft: ListingSettingsDraft | null = reduceListingSettingsDraft(null, {
    type: "open", editor: "price", place: "Price", base: { ...priceRecipeDraft(SUGGESTED_PRICING_RECIPE) },
  });
  draft = reduceListingSettingsDraft(draft, { type: "edit", value: { ...value } });
  let minted = 0;
  const drafts: PriceSaveDrafts = {
    startSave: (signature, prefix) => {
      const attempt = nextSaveAttempt(draft, signature, () => {
        minted += 1;
        return `${prefix}:${minted}`;
      });
      if (attempt === null) return null;
      draft = reduceListingSettingsDraft(draft, { type: "startSave", attempt });
      return attempt.key;
    },
    settle: (key, settlement) => {
      draft = settlement.kind === "failure"
        ? reduceListingSettingsDraft(draft, { type: "failure", key, failure: settlement.failure })
        : reduceListingSettingsDraft(draft, { type: "saved", key, nowMs: 5_000, viewStale: settlement.kind === "saved_view_stale" });
    },
  };
  return {
    drafts,
    get draft() { return draft; },
    get minted() { return minted; },
  };
}

function callbacks(overrides: Partial<{ disabled: boolean; onSaveStarted: () => void }> = {}) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      disabled: overrides.disabled,
      onSaveStarted: overrides.onSaveStarted ?? (() => { calls.push("started"); }),
      onSaveSettled: () => { calls.push("settled"); },
    },
  };
}

const APPLIED = { revisionId: 8, idempotentReplay: false };
const networkDrop = () => new TypeError("Failed to fetch");
const apiError = (status: number, code: string | null, message = "Refused.") => new DropshipApiError({ status, code, message });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parsePercentBps", () => {
  it.each([
    ["20", 2000],
    ["12.5", 1250],
    ["0.01", 1],
    ["0", 0],
    [" 7.25 ", 725],
    ["10000", MAX_MARKUP_BPS],
  ])("reads %j as %i basis points", (text, bps) => {
    expect(parsePercentBps(text)).toEqual({ ok: true, value: bps });
  });

  it.each(["", "  ", "-5", "1.234", "20.", ".5", "1e3", "abc", "5%", "+5", "123456789012345678901"])("refuses %j", (text) => {
    expect(parsePercentBps(text)).toEqual({ ok: false, message: PRICE_DEFAULT_WORDS.percentInvalid });
  });

  it("refuses more than 10,000% (1,000,000 bps), even with twenty digits", () => {
    expect(parsePercentBps("10000.01")).toEqual({ ok: false, message: PRICE_DEFAULT_WORDS.percentTooLarge });
    expect(parsePercentBps("99999999999999999999")).toEqual({ ok: false, message: PRICE_DEFAULT_WORDS.percentTooLarge });
  });
});

describe("parseFlatCents", () => {
  it.each([
    ["", 0],
    ["1", 100],
    ["1.5", 150],
    ["0.01", 1],
    [" 2.00 ", 200],
    ["21474836.47", MAX_LISTING_PRICE_CENTS],
  ])("reads %j as %i cents", (text, cents) => {
    expect(parseFlatCents(text)).toEqual({ ok: true, value: cents });
  });

  it.each(["-1", "1.234", "abc", "1,00", "$1"])("refuses %j", (text) => {
    expect(parseFlatCents(text)).toEqual({ ok: false, message: PRICE_DEFAULT_WORDS.flatInvalid });
  });

  it("refuses an amount over the recipe's limit", () => {
    expect(parseFlatCents("21474836.48")).toEqual({ ok: false, message: PRICE_DEFAULT_WORDS.flatTooLarge });
    expect(parseFlatCents("99999999999999999999")).toEqual({ ok: false, message: PRICE_DEFAULT_WORDS.flatTooLarge });
  });
});

describe("the Price editor's draft", () => {
  it.each([
    [RETAIL_20_UP, { basis: "catalog_retail", percent: "20", flat: "0.00", rounding: "up_99" }],
    [{ basis: "product_cost", markupBps: 1250, flatCents: 100, rounding: "cent" } as PricingRecipe,
      { basis: "product_cost", percent: "12.5", flat: "1.00", rounding: "cent" }],
    [{ basis: "catalog_retail", markupBps: 1, flatCents: 5, rounding: "cent" } as PricingRecipe,
      { basis: "catalog_retail", percent: "0.01", flat: "0.05", rounding: "cent" }],
  ])("shows a saved recipe as typed text and reads it back unchanged", (recipe, draft) => {
    expect(priceRecipeDraft(recipe)).toEqual(draft);
    expect(recipeFromDraft(priceRecipeDraft(recipe))).toEqual({ ok: true, recipe });
  });

  it("reports every field error at once and builds no recipe", () => {
    expect(recipeFromDraft({ basis: "catalog_retail", percent: "-1", flat: "1.234", rounding: "cent" })).toEqual({
      ok: false, errors: { percent: PRICE_DEFAULT_WORDS.percentInvalid, flat: PRICE_DEFAULT_WORDS.flatInvalid },
    });
    expect(recipeFromDraft({ basis: "catalog_retail", percent: "20", flat: "", rounding: "cent" })).toEqual({
      ok: true, recipe: { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "cent" },
    });
  });

  it("starts from the saved store price, else the suggestion, never Your cost + 0%", () => {
    expect(priceDefaultBase(STATE, null)).toEqual(priceRecipeDraft(RETAIL_20_UP));
    // The saved profile wins over the summary, which can be up to a minute old.
    expect(priceDefaultBase(STATE, COST_35)).toEqual(priceRecipeDraft(RETAIL_20_UP));
    expect(priceDefaultBase(null, COST_35)).toEqual(priceRecipeDraft(COST_35));
    const suggestion = { basis: "catalog_retail", percent: "0", flat: "0.00", rounding: "cent" };
    expect(priceDefaultBase(EMPTY_STATE, COST_35)).toEqual(suggestion);
    expect(priceDefaultBase(null, null)).toEqual(suggestion);
    expect(isPriceSuggestion(EMPTY_STATE, COST_35)).toBe(true);
    expect(isPriceSuggestion(STATE, null)).toBe(false);
    expect(isPriceSuggestion(null, null)).toBe(true);
    expect(isPriceSuggestion(null, RETAIL_20_UP)).toBe(false);
  });

  it("reads only its own draft value", () => {
    const value = priceRecipeDraft(RETAIL_20_UP);
    expect(readPriceRecipeDraft({ ...value })).toEqual(value);
    expect(readPriceRecipeDraft({ policyId: "p1" })).toBeNull();
    expect(readPriceRecipeDraft({ ...value, extra: true })).toBeNull();
    expect(readPriceRecipeDraft({ ...value, basis: "auction" })).toBeNull();
  });

  it("tells when what is saved moved from the draft's start", () => {
    const base: DraftValue = { ...priceRecipeDraft(RETAIL_20_UP) };
    expect(priceBaseMoved(base, priceRecipeDraft(RETAIL_20_UP))).toBe(false);
    expect(priceBaseMoved(base, priceRecipeDraft(COST_35))).toBe(true);
  });
});

describe("the pricing rules read (D8)", () => {
  it("shares the older pricing panel's key and runs only while the editor is open and W1 takes a save", () => {
    expect(pricingRulesQueryKey(STORE)).toEqual([ENDPOINT]);
    expect(pricingRulesQueryOptions(STORE, { editorOpen: false, right: EDITABLE }).enabled).toBe(false);
    expect(pricingRulesQueryOptions(STORE, { editorOpen: true, right: NOT_EDITABLE }).enabled).toBe(false);
    expect(pricingRulesQueryOptions(STORE, { editorOpen: false, right: NOT_EDITABLE }).enabled).toBe(false);
    expect(pricingRulesQueryOptions(0, { editorOpen: true, right: EDITABLE }).enabled).toBe(false);
    const open = pricingRulesQueryOptions(STORE, { editorOpen: true, right: EDITABLE });
    expect(open).toMatchObject({ queryKey: [ENDPOINT], enabled: true, staleTime: 0, retry: false });
  });

  it("parses the answer with the contract and refuses an off-contract one", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(STATE), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...STATE, extra: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const options = pricingRulesQueryOptions(STORE, { editorOpen: true, right: EDITABLE });
    await expect(options.queryFn({})).resolves.toEqual(STATE);
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINT);
    const refused = await options.queryFn({}).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ListingSettingsReadError);
    expect((refused as ListingSettingsReadError).code).toBe(LISTING_SETTINGS_OFF_CONTRACT);
  });

  it("after a save reads the rules again and marks only this store's size prices stale", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...STATE, revisionId: 8 }), { status: 200 })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mine = [`/api/dropship/listings/stores/${STORE}/variants/101/price`];
    const other = ["/api/dropship/listings/stores/23/variants/101/price"];
    client.setQueryData(mine, { price: 1 });
    client.setQueryData(other, { price: 2 });
    client.setQueryData([ENDPOINT], STATE);
    const cancel = vi.spyOn(client, "cancelQueries");
    try {
      const state = await refreshAfterPricingApply(client, STORE);
      expect(state.revisionId).toBe(8);
      expect(cancel).toHaveBeenCalledWith({ queryKey: [ENDPOINT], exact: true });
      expect(client.getQueryData<PricingProfileState>([ENDPOINT])?.revisionId).toBe(8);
      expect(client.getQueryState(mine)?.isInvalidated).toBe(true);
      expect(client.getQueryState(other)?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });

  it("matches size price reads of one store only", () => {
    const match = isStoreSizePriceQuery(STORE);
    expect(match({ queryKey: [`/api/dropship/listings/stores/${STORE}/variants/9/price`] })).toBe(true);
    expect(match({ queryKey: [`/api/dropship/listings/stores/${STORE}0/variants/9/price`] })).toBe(false);
    expect(match({ queryKey: [ENDPOINT] })).toBe(false);
  });
});

describe("the check request (POST …/reviews)", () => {
  it("sends the new store default with every group rule unchanged and exact prices kept", () => {
    const state = deepFreeze(structuredClone(STATE));
    const request = buildPricingReviewRequest(state, COST_35);
    expect(request).toEqual({
      expectedRevisionId: 7,
      profile: { defaultRecipe: COST_35, groups: STATE.profile!.groups },
      releaseFixedOverrides: false,
    });
    expect(request.profile.groups).toEqual(state.profile!.groups);
    expect(reviewPricingRulesInputSchema.parse(request)).toEqual(request);
  });

  it("checks a first store price against no saved revision and no groups", () => {
    expect(buildPricingReviewRequest(EMPTY_STATE, SUGGESTED_PRICING_RECIPE)).toEqual({
      expectedRevisionId: null, profile: { defaultRecipe: SUGGESTED_PRICING_RECIPE, groups: [] }, releaseFixedOverrides: false,
    });
  });

  it("refuses to build a check the server would refuse", () => {
    const bad = { ...STATE, profile: { ...PROFILE, groups: [{ ...ENVELOPES, id: "has space" }] } } as PricingProfileState;
    expect(() => buildPricingReviewRequest(bad, RETAIL_20_UP)).toThrow(PriceDefaultRequestError);
  });

  it("classifies a check's outcome; a dropped check is never called an unconfirmed save", async () => {
    await expect(requestPricingReview(async () => review())).resolves.toEqual({ kind: "ok", review: review() });
    await expect(requestPricingReview(async () => { throw apiError(409, "DROPSHIP_PRICING_REVIEW_STALE"); })).resolves.toEqual({ kind: "stale" });
    const blocked = apiError(403, "DROPSHIP_PRICING_NOT_ALLOWED");
    await expect(requestPricingReview(async () => { throw blocked; })).resolves.toEqual({ kind: "blocked", error: blocked });
    await expect(requestPricingReview(async () => { throw apiError(429, "DROPSHIP_PRICING_RATE_LIMITED"); }))
      .resolves.toEqual({ kind: "failed", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited });
    await expect(requestPricingReview(async () => { throw apiError(422, "DROPSHIP_PRICING_REVIEW_TOO_LARGE", "Too many sizes to check."); }))
      .resolves.toEqual({ kind: "failed", message: "Too many sizes to check." });
    await expect(requestPricingReview(async () => { throw networkDrop(); }))
      .resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    await expect(requestPricingReview(async () => { throw apiError(500, "DROPSHIP_PRICING_INTERNAL_ERROR"); }))
      .resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    await expect(requestPricingReview(async () => ({ ...review(), extra: true })))
      .resolves.toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
  });

  it("runs a check against what is saved and keeps the request it sent", async () => {
    const harness = draftsHarness();
    const send = vi.fn().mockResolvedValue(review());
    const reread = vi.fn();
    const outcome = await runPriceCheck({ base: harness.draft!.base, recipe: COST_35, start: EMPTY_STATE, drafts: harness.drafts, send, reread });
    expect(outcome).toEqual({ kind: "checked", review: review(), request: buildPricingReviewRequest(EMPTY_STATE, COST_35) });
    expect(send).toHaveBeenCalledTimes(1);
    expect(reread).not.toHaveBeenCalled();
    expect(harness.minted).toBe(0);
  });

  it("sends nothing and shows the conflict when the saved store price moved from the draft's start", async () => {
    const harness = draftsHarness();
    const send = vi.fn();
    // The draft started from nothing saved; another window saved a store price since.
    const outcome = await runPriceCheck({ base: harness.draft!.base, recipe: COST_35, start: STATE, drafts: harness.drafts, send, reread: vi.fn() });
    expect(outcome).toEqual({ kind: "conflict" });
    expect(send).not.toHaveBeenCalled();
    expect(harness.draft).toMatchObject({ phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, value: priceRecipeDraft(RETAIL_20_UP) });
  });

  it("reads again after a stale refusal and checks once more against the latest groups and revision", async () => {
    const harness = draftsHarness();
    const latest: PricingProfileState = { revisionId: 3, profile: { defaultRecipe: SUGGESTED_PRICING_RECIPE, groups: [ENVELOPES] }, updatedAt: null };
    const send = vi.fn().mockRejectedValueOnce(apiError(409, "DROPSHIP_PRICING_REVIEW_STALE")).mockResolvedValueOnce(review());
    const reread = vi.fn().mockResolvedValue(latest);
    const outcome = await runPriceCheck({ base: harness.draft!.base, recipe: COST_35, start: EMPTY_STATE, drafts: harness.drafts, send, reread });
    expect(outcome).toMatchObject({ kind: "checked", request: { expectedRevisionId: 3, profile: { defaultRecipe: COST_35, groups: [ENVELOPES] } } });
    expect(send.mock.calls.map(([input]) => input.expectedRevisionId)).toEqual([null, 3]);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it("never loops: a second stale refusal is shown", async () => {
    const harness = draftsHarness();
    const send = vi.fn().mockRejectedValue(apiError(409, "DROPSHIP_PRICING_REVIEW_STALE"));
    const outcome = await runPriceCheck({ base: harness.draft!.base, recipe: COST_35, start: EMPTY_STATE, drafts: harness.drafts, send, reread: async () => EMPTY_STATE });
    expect(outcome).toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("shows the conflict when the re-read finds a new store price, and says so when it fails", async () => {
    const harness = draftsHarness();
    const send = vi.fn().mockRejectedValue(apiError(409, "DROPSHIP_PRICING_REVIEW_STALE"));
    expect(await runPriceCheck({ base: harness.draft!.base, recipe: COST_35, start: EMPTY_STATE, drafts: harness.drafts, send, reread: async () => STATE }))
      .toEqual({ kind: "conflict" });
    expect(send).toHaveBeenCalledTimes(1);
    const other = draftsHarness();
    expect(await runPriceCheck({ base: other.draft!.base, recipe: COST_35, start: EMPTY_STATE, drafts: other.drafts, send, reread: async () => { throw networkDrop(); } }))
      .toEqual({ kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed });
  });

  it("passes a block on and never throws for a check it can't build", async () => {
    const harness = draftsHarness();
    const blocked = apiError(403, "DROPSHIP_PRICING_NOT_ALLOWED");
    expect(await runPriceCheck({ base: harness.draft!.base, recipe: COST_35, start: EMPTY_STATE, drafts: harness.drafts, send: async () => { throw blocked; }, reread: vi.fn() }))
      .toEqual({ kind: "blocked", error: blocked });
    const bad = { revisionId: 7, profile: { ...PROFILE, groups: [{ ...ENVELOPES, id: "has space" }] }, updatedAt: null } as PricingProfileState;
    const send = vi.fn();
    const outcome = await runPriceCheck({ base: { ...priceRecipeDraft(RETAIL_20_UP) }, recipe: COST_35, start: bad, drafts: harness.drafts, send, reread: vi.fn() });
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(outcome.kind === "failed" && outcome.message).toMatch(/Reload the page/);
    expect(send).not.toHaveBeenCalled();
  });

  it("after a stale save, checks again only when nobody saved", async () => {
    await expect(decideAfterStaleApply(7, async () => STATE)).resolves.toEqual({ kind: "recheck", latest: STATE });
    await expect(decideAfterStaleApply(6, async () => STATE)).resolves.toEqual({ kind: "conflict" });
    await expect(decideAfterStaleApply(7, async () => { throw networkDrop(); })).resolves.toEqual({ kind: "conflict" });
  });

  it("re-checks when only prices moved, and shows the conflict when someone saved", () => {
    expect(decideStaleCheck(7, { revisionId: 7 })).toBe("recheck");
    expect(decideStaleCheck(null, { revisionId: null })).toBe("recheck");
    expect(decideStaleCheck(7, { revisionId: 8 })).toBe("conflict");
    expect(decideStaleCheck(null, { revisionId: 1 })).toBe("conflict");
  });

  it("pages the same check only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(review({ page: 1 })), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchPricingReviewPage(STORE, REVIEW_ID, 1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/reviews/${REVIEW_ID}?page=1`);
    expect(() => fetchPricingReviewPage(STORE, REVIEW_ID, -1)).toThrow(PriceDefaultRequestError);
    expect(checkPricingReviewPage(review(), review({ page: 1 })).page).toBe(1);
    expect(() => checkPricingReviewPage(review(), review({ reviewId: OTHER_REVIEW_ID }))).toThrow(CHECK_NEW_PRICES_WORDS.pageFailed);
    expect(() => checkPricingReviewPage(review(), review({ reviewHash: HASH_B }))).toThrow(PriceDefaultRequestError);
    expect(() => checkPricingReviewPage(review(), { nope: true })).toThrow(PriceDefaultRequestError);
  });
});

describe("the save (POST …/apply)", () => {
  it("sends the check's id and hash with an ls-apply key", () => {
    const signature = pricingApplySignature(review());
    const input = buildPricingApplyRequest(signature, "ls-apply:abc");
    expect(input).toEqual({ reviewId: REVIEW_ID, reviewHash: HASH_A, idempotencyKey: "ls-apply:abc" });
    expect(applyPricingRulesInputSchema.parse(input)).toEqual(input);
  });

  it("refuses a signature it can't rebuild, with a namespaced code", () => {
    for (const signature of ["not json", "[]", JSON.stringify({ reviewId: "x", reviewHash: HASH_A })]) {
      const error = (() => { try { buildPricingApplyRequest(signature, "ls-apply:1"); } catch (caught) { return caught; } return null; })();
      expect(error).toBeInstanceOf(PriceDefaultRequestError);
      expect((error as PriceDefaultRequestError).code).toBe(PRICE_DEFAULT_REQUEST_INVALID);
    }
  });

  it("saves, reads the rules again, then tells the step; the counter starts and ends once", async () => {
    const harness = draftsHarness();
    const cb = callbacks();
    const send = vi.fn().mockResolvedValue(APPLIED);
    const reread = vi.fn().mockResolvedValue(STATE);
    const onSaved = vi.fn();
    const outcome = await runPricingApply({ signature: pricingApplySignature(review()), drafts: harness.drafts, callbacks: cb.value, send, reread, onSaved });
    expect(outcome).toEqual({ kind: "saved", viewStale: false });
    expect(send).toHaveBeenCalledWith({ reviewId: REVIEW_ID, reviewHash: HASH_A, idempotencyKey: "ls-apply:1" });
    expect(reread).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(cb.calls).toEqual(["started", "settled"]);
    expect(harness.draft).toMatchObject({ phase: "saved", attempt: null, changes: 0 });
  });

  it("reuses one key for one check: a dropped answer, then Check again, sends the same apply", async () => {
    const harness = draftsHarness();
    const signature = pricingApplySignature(review());
    const send = vi.fn().mockRejectedValueOnce(networkDrop()).mockResolvedValueOnce({ ...APPLIED, idempotentReplay: true });
    const run = { signature, drafts: harness.drafts, callbacks: callbacks().value, send, reread: async () => STATE, onSaved: () => undefined };
    const first = await runPricingApply(run);
    expect(first).toMatchObject({ kind: "failed", failure: { phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain } });
    expect(harness.draft).toMatchObject({ phase: "uncertain", attempt: { signature, key: "ls-apply:1" } });
    const second = await runPricingApply({ ...run, signature: harness.draft!.attempt!.signature });
    expect(second).toEqual({ kind: "saved", viewStale: false });
    expect(send.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(["ls-apply:1", "ls-apply:1"]);
    expect(harness.minted).toBe(1);
  });

  it("keeps the key after too many saves, and Save sends the same apply", async () => {
    const harness = draftsHarness();
    const signature = pricingApplySignature(review());
    const send = vi.fn().mockRejectedValueOnce(apiError(429, "DROPSHIP_PRICING_RATE_LIMITED")).mockResolvedValueOnce(APPLIED);
    const run = { signature, drafts: harness.drafts, callbacks: callbacks().value, send, reread: async () => STATE, onSaved: () => undefined };
    expect(await runPricingApply(run)).toMatchObject({ kind: "failed", failure: { phase: "rate_limited", message: LISTING_SETTINGS_SAVE_WORDS.rateLimited } });
    expect(await runPricingApply(run)).toEqual({ kind: "saved", viewStale: false });
    expect(send.mock.calls.map(([input]) => input.idempotencyKey)).toEqual(["ls-apply:1", "ls-apply:1"]);
    expect(harness.minted).toBe(1);
  });

  it("a stale check clears the key, so only a new check gets a new key", async () => {
    const harness = draftsHarness();
    const send = vi.fn().mockRejectedValueOnce(apiError(409, "DROPSHIP_PRICING_REVIEW_STALE")).mockResolvedValueOnce(APPLIED);
    const base = { drafts: harness.drafts, callbacks: callbacks().value, send, reread: async () => STATE, onSaved: () => undefined };
    expect(await runPricingApply({ ...base, signature: pricingApplySignature(review()) }))
      .toMatchObject({ kind: "failed", failure: { phase: "conflict" } });
    expect(harness.draft).toMatchObject({ phase: "conflict", attempt: null });
    // The step runs the check again (a new review) before anything else is sent.
    expect(await runPricingApply({ ...base, signature: pricingApplySignature({ reviewId: OTHER_REVIEW_ID, reviewHash: HASH_B }) }))
      .toEqual({ kind: "saved", viewStale: false });
    expect(send.mock.calls.map(([input]) => [input.reviewId, input.idempotencyKey]))
      .toEqual([[REVIEW_ID, "ls-apply:1"], [OTHER_REVIEW_ID, "ls-apply:2"]]);
  });

  it("never sends a second apply while one is in flight", async () => {
    const harness = draftsHarness();
    let resolve: (value: unknown) => void = () => undefined;
    const send = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const run = { signature: pricingApplySignature(review()), drafts: harness.drafts, callbacks: callbacks().value, send, reread: async () => STATE, onSaved: () => undefined };
    const first = runPricingApply(run);
    expect(await runPricingApply(run)).toEqual({ kind: "not_started", message: null });
    resolve(APPLIED);
    expect(await first).toEqual({ kind: "saved", viewStale: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("hands a block to the banner and keeps the draft", async () => {
    const harness = draftsHarness();
    const blocked = apiError(403, "DROPSHIP_PRICING_NOT_ALLOWED");
    const onBlocked = vi.fn();
    const onSaved = vi.fn();
    const outcome = await runPricingApply({
      signature: pricingApplySignature(review()), drafts: harness.drafts, callbacks: callbacks().value,
      send: async () => { throw blocked; }, reread: async () => STATE, onSaved, onBlocked,
    });
    expect(outcome).toMatchObject({ kind: "failed", failure: { phase: "blocked", message: LISTING_SETTINGS_SAVE_WORDS.blocked } });
    expect(onBlocked).toHaveBeenCalledWith(blocked);
    expect(onSaved).not.toHaveBeenCalled();
    expect(harness.draft).toMatchObject({ phase: "blocked", value: priceRecipeDraft(RETAIL_20_UP), attempt: null });
  });

  it("says an expired check must be checked again", async () => {
    const harness = draftsHarness();
    const outcome = await runPricingApply({
      signature: pricingApplySignature(review()), drafts: harness.drafts, callbacks: callbacks().value,
      send: async () => { throw apiError(404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND"); }, reread: async () => STATE, onSaved: () => undefined,
    });
    expect(outcome).toMatchObject({ kind: "failed", failure: { phase: "refused", message: LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone } });
  });

  it("a 2xx stands even when its answer or the re-read is off; the view says so", async () => {
    for (const [answer, reread] of [
      [{ revisionId: "8" }, async () => STATE],
      [APPLIED, async () => { throw networkDrop(); }],
    ] as const) {
      const harness = draftsHarness();
      const onSaved = vi.fn();
      const outcome = await runPricingApply({
        signature: pricingApplySignature(review()), drafts: harness.drafts, callbacks: callbacks().value,
        send: async () => answer, reread, onSaved,
      });
      expect(outcome).toEqual({ kind: "saved", viewStale: true });
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(harness.draft).toMatchObject({ phase: "saved_view_stale", message: LISTING_SETTINGS_SAVE_WORDS.savedViewStale });
    }
  });

  it("sends nothing while another listing action runs", async () => {
    const harness = draftsHarness();
    const send = vi.fn();
    const busy = callbacks({ disabled: true });
    expect(await runPricingApply({ signature: pricingApplySignature(review()), drafts: harness.drafts, callbacks: busy.value, send, reread: async () => STATE, onSaved: () => undefined }))
      .toEqual({ kind: "not_started", message: PRICE_DEFAULT_WORDS.busy });
    const refusing = callbacks({ onSaveStarted: () => { throw new Error("Wait for the current listing action to finish before saving listing changes."); } });
    expect(await runPricingApply({ signature: pricingApplySignature(review()), drafts: harness.drafts, callbacks: refusing.value, send, reread: async () => STATE, onSaved: () => undefined }))
      .toEqual({ kind: "not_started", message: "Wait for the current listing action to finish before saving listing changes." });
    expect(refusing.calls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(harness.minted).toBe(0);
  });

  it("shows a conflict found before sending without sending anything", () => {
    const harness = draftsHarness();
    expect(settlePriceConflictBeforeSending(harness.drafts)).toBe(true);
    expect(harness.draft).toMatchObject({ phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, attempt: null });
  });
});

describe("the editor's footer", () => {
  const editing = (changes: number, overrides: Partial<ListingSettingsDraft> = {}) =>
    ({ phase: "editing", changes, message: null, attempt: null, ...overrides }) as ListingSettingsDraft;
  const input = (overrides: Partial<Parameters<typeof priceEditorFooter>[0]> = {}) => ({
    draft: editing(1), ready: true, editable: true, busy: false, checking: false, suggestion: false, ...overrides,
  });

  it("offers Check new prices only for a change, or for the suggestion when nothing is saved", () => {
    expect(priceEditorFooter(input()).primary).toEqual({ label: PRICE_DEFAULT_WORDS.checkNewPrices, action: "check", disabled: false });
    expect(priceEditorFooter(input({ draft: editing(0) })).primary.disabled).toBe(true);
    expect(priceEditorFooter(input({ draft: editing(0), suggestion: true })).primary.disabled).toBe(false);
    for (const blocked of [{ ready: false }, { editable: false }, { busy: true }, { draft: null }]) {
      expect(priceEditorFooter(input(blocked)).primary.disabled).toBe(true);
    }
    expect(priceEditorFooter(input({ checking: true })).primary).toEqual({ label: PRICE_DEFAULT_WORDS.checking, action: "none", disabled: true });
  });

  it("locks while saving and while a save is unconfirmed", () => {
    expect(priceEditorFooter(input({ draft: editing(1, { phase: "saving" }) }))).toMatchObject({
      primary: { label: LISTING_SETTINGS_SAVE_WORDS.saving, action: "none", disabled: true }, cancelDisabled: true,
    });
    const uncertain = editing(1, { phase: "uncertain", message: LISTING_SETTINGS_SAVE_WORDS.uncertain, attempt: { signature: "s", key: "ls-apply:1" } });
    expect(priceEditorFooter(input({ draft: uncertain }))).toEqual({
      primary: { label: LISTING_SETTINGS_SAVE_WORDS.checkAgain, action: "resend", disabled: false },
      cancelDisabled: true,
      message: { text: LISTING_SETTINGS_SAVE_WORDS.uncertain, tone: "alert" },
    });
  });

  it("offers Load latest on a conflict", () => {
    expect(priceEditorFooter(input({ draft: editing(1, { phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict }) }))).toEqual({
      primary: { label: LISTING_SETTINGS_SAVE_WORDS.loadLatest, action: "load_latest", disabled: false },
      cancelDisabled: false,
      message: { text: LISTING_SETTINGS_SAVE_WORDS.conflict, tone: "alert" },
    });
  });

  it("shows Load latest's own words as a status line", () => {
    const rebased = editing(1, { message: LISTING_SETTINGS_SAVE_WORDS.rebased });
    expect(priceEditorFooter(input({ draft: rebased })).message).toEqual({ text: LISTING_SETTINGS_SAVE_WORDS.rebased, tone: "status" });
  });
});

describe("the check's footer", () => {
  it("keeps Save off while sizes are blocked, busy or paging", () => {
    expect(checkNewPricesFooter({ phase: "editing", blocked: 0, busy: false, paging: false })).toEqual({
      primary: { label: CHECK_NEW_PRICES_WORDS.save, action: "save", disabled: false }, backDisabled: false,
    });
    expect(checkNewPricesFooter({ phase: null, blocked: 3, busy: false, paging: false }).primary.disabled).toBe(true);
    expect(checkNewPricesFooter({ phase: null, blocked: 0, busy: true, paging: false }).primary.disabled).toBe(true);
    expect(checkNewPricesFooter({ phase: null, blocked: 0, busy: false, paging: true }).primary.disabled).toBe(true);
  });

  it("locks Back while saving, and offers Check again for an unconfirmed save", () => {
    expect(checkNewPricesFooter({ phase: "saving", blocked: 0, busy: false, paging: false })).toEqual({
      primary: { label: CHECK_NEW_PRICES_WORDS.saving, action: "none", disabled: true }, backDisabled: true,
    });
    expect(checkNewPricesFooter({ phase: "uncertain", blocked: 0, busy: false, paging: false })).toEqual({
      primary: { label: CHECK_NEW_PRICES_WORDS.checkAgain, action: "resend", disabled: false }, backDisabled: true,
    });
    expect(checkNewPricesFooter({ phase: "rate_limited", blocked: 0, busy: false, paging: false }).primary)
      .toEqual({ label: CHECK_NEW_PRICES_WORDS.save, action: "save", disabled: false });
  });
});

describe("the check's words (M3)", () => {
  it("names what each new price is built from", () => {
    expect(reviewRowBuiltFrom(row(), PROFILE)).toBe("Store default: retail $12.50 + 20%, up to .99");
    expect(reviewRowBuiltFrom(row({ basis: "product_cost", basisCents: 980 }), { ...PROFILE, defaultRecipe: COST_35 }))
      .toBe("Store default: your cost $9.80 + 35%");
    expect(reviewRowBuiltFrom(row(), { ...PROFILE, defaultRecipe: { ...RETAIL_20_UP, flatCents: 100 } }))
      .toBe("Store default: retail $12.50 + 20% plus $1.00, up to .99");
    expect(reviewRowBuiltFrom(row({ basisCents: null }), PROFILE)).toBe("Store default: retail + 20%, up to .99");
    expect(reviewRowBuiltFrom(row({ ruleName: "Envelopes", basisCents: 625 }), PROFILE))
      .toBe("From your older group rule “Envelopes”: retail $6.25 + 30%");
  });

  it("shows only the starting amount when two group rules share a name", () => {
    const twins = { ...PROFILE, groups: [ENVELOPES, { ...ENVELOPES, id: "envelopes-2", priority: 20 }] };
    expect(reviewRowBuiltFrom(row({ ruleName: "Envelopes", basisCents: 625 }), twins)).toBe("From your older group rule “Envelopes”: retail $6.25");
    expect(reviewRowBuiltFrom(row({ ruleName: "Gone", basis: null, basisCents: null }), PROFILE)).toBe("From your older group rule “Gone”");
  });

  it("says Exact price for a kept exact price, never the server's rule name (C9)", () => {
    const kept = row({ preserved: true, ruleName: "Fixed override preserved", basis: null, basisCents: null, priceCents: 1499 });
    expect(reviewRowBuiltFrom(kept, PROFILE)).toBe("Exact price");
  });

  it("uses the same words as the drawer's Built from lines", () => {
    expect(reviewRowBuiltFrom(row(), PROFILE)).toBe(builtFromWords(sizePrice({
      rule: { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP },
    })));
    expect(reviewRowBuiltFrom(row({ ruleName: "Envelopes", basisCents: 625 }), PROFILE)).toBe(builtFromWords(sizePrice({
      rule: { kind: "group", name: "Envelopes", recipe: ENVELOPES.recipe }, basisAmountCents: 625,
    })));
    const cases = [
      { issue: "pricing_basis_unavailable", basis: "catalog_retail" },
      { issue: "pricing_basis_unavailable", basis: "product_cost" },
      { issue: "pricing_rule_priority_conflict", basis: null },
      { issue: "pricing_result_out_of_range", basis: "catalog_retail" },
    ] as const;
    for (const { issue, basis } of cases) {
      const words = reviewRowBuiltFrom(row({ priceCents: null, ruleName: null, issues: [issue, "vendor_retail_price_required"], basis }), PROFILE);
      expect(words).toBe(builtFromWords(sizePrice({ source: "none", priceCents: null, issue, basis, basisAmountCents: null })));
    }
  });

  it("never shows a raw code", () => {
    const rows = [
      row(), row({ preserved: true, ruleName: "Fixed override preserved" }),
      row({ priceCents: null, ruleName: null, issues: ["vendor_retail_price_required"] }),
      row({ priceCents: null, issues: ["pricing_basis_unavailable", "vendor_retail_price_required"], basis: null }),
      row({ issues: ["pricing:below_floor:policy_3"], warnings: ["price_below_product_cost", "pricing:above_ceiling:policy_4"] }),
    ];
    for (const item of rows) {
      const words = [reviewRowBuiltFrom(item, PROFILE), ...reviewRowNotes(item).map((note) => note.text)];
      for (const text of words) {
        expect(text).not.toMatch(/[a-z]+_[a-z_]+|policy_\d|Fixed override/);
      }
    }
  });

  it("notes below cost, a lost price and a Card Shellz price limit", () => {
    expect(reviewRowNotes(row({ productCostCents: 2310, priceCents: 2199, warnings: ["price_below_product_cost"] })))
      .toEqual([{ kind: "below_cost", text: "! Below your cost ($23.10)" }]);
    expect(reviewRowNotes(row({ priceCents: null, previousPriceCents: 5999, issues: ["pricing_basis_unavailable"] })))
      .toEqual([{ kind: "loses_price", text: "● Loses its price" }]);
    expect(reviewRowNotes(row({ priceCents: null, previousPriceCents: null, issues: ["pricing_basis_unavailable"] }))).toEqual([]);
    expect(reviewRowNotes(row({ issues: ["pricing:below_floor:policy_3"] }))).toEqual([{ kind: "outside_limit", text: "Outside a Card Shellz price limit" }]);
    expect(reviewRowNotes(row({ warnings: ["pricing:above_ceiling:policy_12"] }))).toEqual([{ kind: "outside_limit", text: "Outside a Card Shellz price limit" }]);
    expect(reviewRowNotes(row({ warnings: undefined }))).toEqual([]);
    expect(reviewRowNotes(row())).toEqual([]);
  });

  it("counts, pages and prices in plain words", () => {
    expect(reviewCountsWords({ total: 1240, changed: 1180, preserved: 36, blocked: 0 })).toBe("1,240 sizes · 1,180 change · 36 keep their own price");
    expect(reviewCountsWords({ total: 1, changed: 1, preserved: 1, blocked: 0 })).toBe("1 size · 1 change · 1 keeps its own price");
    expect(reviewCountsWords({ total: 4, changed: 0, preserved: 0, blocked: 0 })).toBe("4 sizes · no price changes");
    expect(reviewBlockedWords(0)).toBeNull();
    expect(reviewBlockedWords(1)).toBe("● 1 size can't be priced this way. Give it an exact price in Products, or start from Your cost.");
    expect(reviewBlockedWords(1200)).toBe("● 1,200 sizes can't be priced this way. Give them an exact price in Products, or start from Your cost.");
    const summary = { total: 1240, changed: 10, preserved: 0, blocked: 0 };
    expect(reviewPageWords({ page: 0, summary }, 50)).toBe("1–50 of 1,240");
    expect(reviewPageWords({ page: 24, summary }, 50)).toBe("1,201–1,240 of 1,240");
    expect(reviewPageWords({ page: 0, summary: { ...summary, total: 0 } }, 50)).toBeNull();
    expect(hasPreviousReviewPage({ page: 0 })).toBe(false);
    expect(hasPreviousReviewPage({ page: 1 })).toBe(true);
    expect(hasNextReviewPage({ page: 0, summary }, 50)).toBe(true);
    expect(hasNextReviewPage({ page: 24, summary }, 50)).toBe(false);
    expect(reviewPriceWords(null)).toBe("—");
    expect(reviewPriceWords(2799)).toBe("$27.99");
    expect(reviewSizeLine(row())).toBe("Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500");
    expect(reviewSizeLine(row({ sizeName: undefined, sku: null }))).toBe("");
  });
});
