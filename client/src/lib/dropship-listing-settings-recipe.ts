import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { MAX_LISTING_PRICE_CENTS } from "@shared/dropship/listing-price";
import {
  applyPricingRulesInputSchema,
  pricingProfileStateSchema,
  pricingRecipeSchema,
  pricingReviewResponseSchema,
  reviewPricingRulesInputSchema,
  type ApplyPricingRulesInput,
  type PricingImpactRow,
  type PricingProfile,
  type PricingProfileState,
  type PricingRecipe,
  type PricingReviewResponse,
  type ReviewPricingRulesInput,
} from "@shared/dropship/pricing-rules";
import { LISTING_SETTINGS_OFF_CONTRACT, ListingSettingsReadError } from "./dropship-listing-settings";
import type { ListingSettingsRight } from "./dropship-listing-settings-access";
import {
  classifyWriteFailure,
  LISTING_SETTINGS_KEY_PREFIXES,
  LISTING_SETTINGS_SAVE_WORDS,
  sameDraftValue,
  type DraftValue,
  type ListingSettingsDraft,
  type SavePhase,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { formatCents, percentText } from "./dropship-listing-settings-price-words";
import { listingPriceInput } from "./dropship-listing-price";
import { fetchJson, postJson, queryErrorMessage, DropshipApiError } from "./dropship-ops-surface";
import { parseNonnegativeHundredths, SUGGESTED_PRICING_RECIPE } from "./dropship-pricing-rules";

/**
 * The Price row of the Store defaults card and its price check (Listing
 * settings PR 7, sub-part 2C; writer W1, design M2 and M3).
 *
 * The store price is the pricing profile's default recipe. W1 never saves a
 * recipe directly: the vendor checks new prices (a review the server stores),
 * then saves that check (apply). The review sends every older group rule back
 * unchanged, because the server replaces the profile whole.
 *
 * Integer only: a percent is basis points (100 bps = 1%), an amount is cents.
 * No floating point is used for either, in parsing or in words.
 *
 * No React here. Request keys come from the draft provider; the clock too.
 * Words marked "interim" are not in the design record; they live here so a
 * later PR can change them in one place.
 */

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The Price row and its editor (R:174-183, R:205, R:516). */
export const PRICE_DEFAULT_WORDS = Object.freeze({
  /** Interim: R:516 adjusted, since a size cleared to follow the store price now uses its retail price. */
  notSet: "Not set. Sizes without an exact price use their retail price or last published price.",
  setPrice: "Set price",
  startFrom: "Start from",
  retailPrice: "Retail price",
  yourCost: "Your cost",
  add: "Add",
  percentSign: "%",
  plus: "plus $",
  round: "Round",
  roundUp99: "Up to .99",
  /** The record's word for rounding to the cent (R:578, C22). */
  roundCent: "To the cent",
  basisHelp: "Retail price is Card Shellz's list price for each size. Your cost is what you pay Card Shellz for one.",
  // Interim: categories and products have no price of their own until PRs 8-10.
  exactKept: "Sizes with an exact price keep them.",
  // Interim: not tied to the cost-change policy, because S2 was dropped.
  costFollows: "Prices that start from your cost change when your cost changes.",
  suggested: "Suggested · not saved",
  checkNewPrices: "Check new prices",
  // Interim: the button while the check runs.
  checking: "Checking…",
  // Interim: the editor while the saved store price loads.
  loading: "Checking…",
  // Interim: the saved store price couldn't be read.
  readFailed: "Couldn't load your store price. Try again.",
  tryAgain: LISTING_SETTINGS_SAVE_WORDS.tryAgain,
  // Interim (C28).
  reviewFailed: "Couldn't check new prices. Nothing was saved. Try again.",
  // Interim: field errors.
  percentInvalid: "Enter a percent like 20 or 12.5.",
  percentTooLarge: "Enter a percent of 10,000 or less.",
  flatInvalid: "Enter an amount like 1.00.",
  flatTooLarge: "Enter an amount up to $21,474,836.47.",
  // Interim: beside a field the vendor and another window both changed (R:542).
  bothChanged: "Also changed in another window",
  // Interim: a save the page held back because another listing action is running.
  busy: "Wait for the current listing action to finish, then try again.",
} as const);

/** The price check (M3, R:211-235; phone R:471-488). */
export const CHECK_NEW_PRICES_WORDS = Object.freeze({
  title: "Check new prices",
  notSavedYet: "Not saved yet",
  columns: Object.freeze(["Size", "Built from", "Now", "New", "Note"] as const),
  exactPrice: "Exact price",
  losesPrice: "● Loses its price",
  // Interim (C9): a Card Shellz price limit, warn-only or blocking.
  outsideLimit: "Outside a Card Shellz price limit",
  noPrice: "—",
  previous: "Previous",
  next: "Next",
  footer: "Nothing is saved until you press Save new prices.",
  footerPhone: "Nothing is saved yet.",
  back: "Back to editing",
  backPhone: "Back",
  save: "Save new prices",
  saving: LISTING_SETTINGS_SAVE_WORDS.saving,
  checkAgain: LISTING_SETTINGS_SAVE_WORDS.checkAgain,
  stale: "Prices changed while you were checking. Here's the new check.",
  // Interim: a check with no chosen sizes.
  empty: "No sizes are chosen yet, so no prices change.",
  // Interim: a page of the check couldn't be read.
  pageFailed: "Couldn't load this page of the check. Try again.",
} as const);

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

function count(value: number): string {
  return COUNT_FORMAT.format(value);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A request this page built that W1 would not take. A bug, never the vendor's doing. */
export const PRICE_DEFAULT_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_PRICE_REQUEST_INVALID";

export class PriceDefaultRequestError extends Error {
  readonly code: typeof PRICE_DEFAULT_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "PriceDefaultRequestError";
    this.code = PRICE_DEFAULT_REQUEST_INVALID;
    this.context = Object.freeze({ ...context });
  }
}

/** At most this many contract issues are kept on an error: enough to find the field, never the values. */
const MAX_REPORTED_ISSUES = 5;

function issuePaths(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => issue.path.join("."));
}

const REBUILD_MESSAGE = "This price check couldn't be built. Reload the page and try again.";

// ---------------------------------------------------------------------------
// Parsing what the vendor typed (integer only)
// ---------------------------------------------------------------------------

/** 100 basis points are 1%. */
const BPS_PER_PERCENT = 100;
/** The recipe's markup limit: 1,000,000 bps is a 10,000% markup (`pricingRecipeSchema`). */
export const MAX_MARKUP_BPS = 1_000_000;
/** Longer text is refused before any arithmetic, so a pasted wall of digits never becomes a huge number. */
const MAX_NUMBER_TEXT_LENGTH = 20;
/** A whole number with at most two decimal places; no sign, no exponent. */
const HUNDREDTHS_TEXT = /^\d+(?:\.\d{1,2})?$/;

export type FieldParse<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Percent text to basis points: "20" -> 2000, "12.5" -> 1250, "0.01" -> 1.
 * Refuses an empty box, a sign, more than two decimal places, and more than
 * 10,000% (1,000,000 bps). String and BigInt math only.
 */
export function parsePercentBps(text: string): FieldParse<number> {
  const trimmed = text.trim();
  if (trimmed.length > MAX_NUMBER_TEXT_LENGTH || !HUNDREDTHS_TEXT.test(trimmed)) {
    return { ok: false, message: PRICE_DEFAULT_WORDS.percentInvalid };
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const bps = BigInt(whole) * BigInt(BPS_PER_PERCENT) + BigInt(fraction.padEnd(2, "0"));
  if (bps > BigInt(MAX_MARKUP_BPS)) return { ok: false, message: PRICE_DEFAULT_WORDS.percentTooLarge };
  return { ok: true, value: Number(bps) };
}

/**
 * Dollar text to cents with `parseNonnegativeHundredths`: "1" -> 100,
 * "1.5" -> 150. An empty box is $0.00: the flat amount is an optional add-on
 * ("plus $"), unlike the percent. Refuses a sign, more than two decimal
 * places, and more than $21,474,836.47 (the recipe's limit).
 */
export function parseFlatCents(text: string): FieldParse<number> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: 0 };
  let cents: number;
  try {
    cents = parseNonnegativeHundredths(trimmed, PRICE_DEFAULT_WORDS.plus);
  } catch {
    // Its own words name the field by its label; this editor has field words of its own.
    return { ok: false, message: trimmed.length > MAX_NUMBER_TEXT_LENGTH || !HUNDREDTHS_TEXT.test(trimmed)
      ? PRICE_DEFAULT_WORDS.flatInvalid : PRICE_DEFAULT_WORDS.flatTooLarge };
  }
  if (cents > MAX_LISTING_PRICE_CENTS) return { ok: false, message: PRICE_DEFAULT_WORDS.flatTooLarge };
  return { ok: true, value: cents };
}

// ---------------------------------------------------------------------------
// The editor's draft
// ---------------------------------------------------------------------------

/** The Price editor's fields, as typed. Each is one draft field, so the bar counts each change. */
export interface PriceRecipeDraft {
  readonly basis: PricingRecipe["basis"];
  readonly percent: string;
  readonly flat: string;
  readonly rounding: PricingRecipe["rounding"];
}

export type PriceRecipeField = keyof PriceRecipeDraft;

/** A saved recipe as the editor shows it: 2000 bps -> "20", 150 cents -> "1.50". */
export function priceRecipeDraft(recipe: PricingRecipe): PriceRecipeDraft {
  return { basis: recipe.basis, percent: percentText(recipe.markupBps), flat: listingPriceInput(recipe.flatCents), rounding: recipe.rounding };
}

/**
 * What the editor starts from: the saved store price, or, with nothing
 * saved, the suggestion "Retail price + 0%, to the cent" (R:205; never
 * "Your cost + 0%"). Before the saved profile is read, the summary's recipe
 * stands in for it.
 */
export function priceDefaultBase(state: PricingProfileState | null, summaryRecipe: PricingRecipe | null): PriceRecipeDraft {
  const saved = state ? state.profile?.defaultRecipe ?? null : summaryRecipe;
  return priceRecipeDraft(saved ?? SUGGESTED_PRICING_RECIPE);
}

/**
 * Whether the store has no store price, so the editor shows the suggestion
 * marked "Suggested · not saved". The suggestion is not counted as a change
 * (as in the older pricing panel): leaving the editor loses nothing the vendor
 * did, and "Check new prices" works on it as it is.
 */
export function isPriceSuggestion(state: PricingProfileState | null, summaryRecipe: PricingRecipe | null): boolean {
  return state ? state.profile === null : summaryRecipe === null;
}

/** The draft's value as this editor stores it; null when it is not one (another editor's draft). */
export function readPriceRecipeDraft(value: DraftValue): PriceRecipeDraft | null {
  const parsed = z.object({
    basis: pricingRecipeSchema.shape.basis,
    percent: z.string(),
    flat: z.string(),
    rounding: pricingRecipeSchema.shape.rounding,
  }).strict().safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether what is saved moved away from what the draft started from (another window or the older panel saved). */
export function priceBaseMoved(base: DraftValue, latest: PriceRecipeDraft): boolean {
  return !sameDraftValue(base, latest);
}

export type RecipeFromDraft =
  | { ok: true; recipe: PricingRecipe }
  | { ok: false; errors: Partial<Record<"percent" | "flat", string>> };

/** The recipe the draft describes, checked with `pricingRecipeSchema`; every field error at once. */
export function recipeFromDraft(draft: PriceRecipeDraft): RecipeFromDraft {
  const percent = parsePercentBps(draft.percent);
  const flat = parseFlatCents(draft.flat);
  const errors: Partial<Record<"percent" | "flat", string>> = {};
  if (!percent.ok) errors.percent = percent.message;
  if (!flat.ok) errors.flat = flat.message;
  if (!percent.ok || !flat.ok) return { ok: false, errors };
  const parsed = pricingRecipeSchema.safeParse({ basis: draft.basis, markupBps: percent.value, flatCents: flat.value, rounding: draft.rounding });
  if (!parsed.success) {
    // Both numbers passed their own checks, so only a value outside the contract gets here.
    throw new PriceDefaultRequestError(REBUILD_MESSAGE, { reason: "recipe_off_contract", issues: issuePaths(parsed.error) });
  }
  return { ok: true, recipe: parsed.data };
}

// ---------------------------------------------------------------------------
// Reads (plan 4.2, D8, D9)
// ---------------------------------------------------------------------------

export function pricingRulesEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/pricing-rules`;
}

/** The pricing rules read, under the key the older pricing panel uses too, so it is one cached read. */
export function pricingRulesQueryKey(storeConnectionId: number) {
  return [pricingRulesEndpoint(storeConnectionId)] as const;
}

/** The Price editor's own read runs only while its editor is open and W1 would take a save (D8). */
export interface PriceReadGate {
  editorOpen: boolean;
  right: Pick<ListingSettingsRight, "editable">;
}

function isStoreId(storeConnectionId: number): boolean {
  return Number.isSafeInteger(storeConnectionId) && storeConnectionId > 0;
}

export function pricingRulesReadEnabled(storeConnectionId: number, gate: PriceReadGate): boolean {
  return isStoreId(storeConnectionId) && gate.editorOpen && gate.right.editable;
}

async function readPricingRules(storeConnectionId: number, signal: AbortSignal | undefined): Promise<PricingProfileState> {
  // fetchJson throws a DropshipApiError (status, code, context) for a refused or failed request.
  const parsed = pricingProfileStateSchema.safeParse(await fetchJson<unknown>(pricingRulesEndpoint(storeConnectionId), { signal }));
  if (parsed.success) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: { read: "pricing_rules", issues: issuePaths(parsed.error) },
  });
}

export function pricingRulesQueryOptions(storeConnectionId: number, gate: PriceReadGate) {
  return {
    queryKey: pricingRulesQueryKey(storeConnectionId),
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<PricingProfileState> => readPricingRules(storeConnectionId, signal),
    enabled: pricingRulesReadEnabled(storeConnectionId, gate),
    // Opening the editor reads the saved profile again, so it starts from what is saved now.
    staleTime: 0,
    retry: false,
  } as const;
}

/** One size's price reads (`GET …/variants/:id/price`) of this store: an applied store price changes them. */
export function isStoreSizePriceQuery(storeConnectionId: number) {
  const prefix = `/api/dropship/listings/stores/${storeConnectionId}/variants/`;
  return (query: { queryKey: readonly unknown[] }): boolean => String(query.queryKey[0]).startsWith(prefix);
}

/**
 * Reads the saved profile again (D9: never taken from a save's answer). Any
 * read in flight is cancelled first, so its older answer can't land after
 * this one. Throws when the read fails.
 */
export async function rereadPricingRules(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
): Promise<PricingProfileState> {
  const queryKey = pricingRulesQueryKey(storeConnectionId);
  await queryClient.cancelQueries({ queryKey, exact: true });
  return queryClient.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => readPricingRules(storeConnectionId, signal),
    staleTime: 0,
    retry: false,
  });
}

/**
 * After a store price is saved: the profile is read again, then every size
 * price read of the store is marked stale (the old panel's predicate,
 * DropshipPricingRulesPanel.tsx). Throws when the profile read fails.
 */
export async function refreshAfterPricingApply(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery" | "invalidateQueries">,
  storeConnectionId: number,
): Promise<PricingProfileState> {
  const state = await rereadPricingRules(queryClient, storeConnectionId);
  await queryClient.invalidateQueries({ predicate: isStoreSizePriceQuery(storeConnectionId) });
  return state;
}

// ---------------------------------------------------------------------------
// Requests (W1)
// ---------------------------------------------------------------------------

/**
 * The review request for a new store price: the recipe as the store default,
 * every saved group rule unchanged (the profile is replaced whole), and
 * exact prices kept (`releaseFixedOverrides: false`). `expectedRevisionId` is
 * the revision `state` was read at, so the check is of exactly what is saved.
 */
export function buildPricingReviewRequest(state: PricingProfileState, recipe: PricingRecipe): ReviewPricingRulesInput {
  const parsed = reviewPricingRulesInputSchema.safeParse({
    expectedRevisionId: state.revisionId,
    profile: { defaultRecipe: recipe, groups: state.profile?.groups ?? [] },
    releaseFixedOverrides: false,
  });
  if (parsed.success) return parsed.data;
  throw new PriceDefaultRequestError(REBUILD_MESSAGE, { reason: "review_off_contract", issues: issuePaths(parsed.error) });
}

/** POST …/pricing-rules/reviews. Resolves with the server's answer, unread. */
export function sendPricingReview(storeConnectionId: number, input: ReviewPricingRulesInput): Promise<unknown> {
  return postJson<unknown>(`${pricingRulesEndpoint(storeConnectionId)}/reviews`, input);
}

/** GET …/pricing-rules/reviews/:reviewId?page=. Resolves with the server's answer, unread. */
export function fetchPricingReviewPage(storeConnectionId: number, reviewId: string, page: number): Promise<unknown> {
  if (!Number.isSafeInteger(page) || page < 0) {
    throw new PriceDefaultRequestError(REBUILD_MESSAGE, { reason: "page_invalid", page });
  }
  return fetchJson<unknown>(`${pricingRulesEndpoint(storeConnectionId)}/reviews/${encodeURIComponent(reviewId)}?page=${page}`);
}

/**
 * A page of the same check: the answer must match its contract and be the
 * very review shown (same id and hash), or it is refused.
 */
export function checkPricingReviewPage(current: Pick<PricingReviewResponse, "reviewId" | "reviewHash">, answer: unknown): PricingReviewResponse {
  const parsed = pricingReviewResponseSchema.safeParse(answer);
  if (!parsed.success) {
    throw new PriceDefaultRequestError(CHECK_NEW_PRICES_WORDS.pageFailed, { reason: "page_off_contract", issues: issuePaths(parsed.error) });
  }
  if (parsed.data.reviewId !== current.reviewId || parsed.data.reviewHash !== current.reviewHash) {
    throw new PriceDefaultRequestError(CHECK_NEW_PRICES_WORDS.pageFailed, { reason: "page_other_review" });
  }
  return parsed.data;
}

/**
 * The apply request's signature: the review it saves. One review has one
 * request key, so "Check again" resends the very same apply (a second key for
 * the same review is refused, dropship-pricing-rules.repository.ts).
 */
export function pricingApplySignature(review: Pick<PricingReviewResponse, "reviewId" | "reviewHash">): string {
  return JSON.stringify({ reviewId: review.reviewId, reviewHash: review.reviewHash });
}

/** The apply request for a signature and its key, checked against the apply's own schema. */
export function buildPricingApplyRequest(signature: string, idempotencyKey: string): ApplyPricingRulesInput {
  let body: unknown;
  try {
    body = JSON.parse(signature);
  } catch (error) {
    throw new PriceDefaultRequestError(REBUILD_MESSAGE, { reason: "signature_not_json", detail: error instanceof Error ? error.name : "unknown" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PriceDefaultRequestError(REBUILD_MESSAGE, { reason: "signature_not_object" });
  }
  const parsed = applyPricingRulesInputSchema.safeParse({ ...body, idempotencyKey });
  if (parsed.success) return parsed.data;
  throw new PriceDefaultRequestError(REBUILD_MESSAGE, { reason: "apply_off_contract", issues: issuePaths(parsed.error) });
}

/** POST …/pricing-rules/apply. Resolves with the server's answer, unread (D9). */
export function sendPricingApply(storeConnectionId: number, input: ApplyPricingRulesInput): Promise<unknown> {
  return postJson<unknown>(`${pricingRulesEndpoint(storeConnectionId)}/apply`, input);
}

/** The apply's 2xx answer (dropship-pricing-rules.routes.ts). */
export const pricingApplyAnswerSchema = z.object({ revisionId: z.number().int().positive(), idempotentReplay: z.boolean() }).strict();

// ---------------------------------------------------------------------------
// Running a check (POST …/reviews)
// ---------------------------------------------------------------------------

/**
 * How a check ended. A check saves nothing, so a dropped answer is just
 * "couldn't check" (never "we couldn't confirm your save"):
 * - `stale`: the saved profile moved since it was read (409); read it again;
 * - `blocked`: a block a banner explains (403);
 * - `failed`: anything else, with its words.
 */
export type PricingReviewOutcome =
  | { kind: "ok"; review: PricingReviewResponse }
  | { kind: "stale" }
  | { kind: "blocked"; error: unknown }
  | { kind: "failed"; message: string };

export async function requestPricingReview(send: () => Promise<unknown>): Promise<PricingReviewOutcome> {
  let answer: unknown;
  try {
    answer = await send();
  } catch (error) {
    const failure = classifyWriteFailure("W1", error);
    switch (failure.phase) {
      case "conflict":
        return { kind: "stale" };
      case "blocked":
        return { kind: "blocked", error };
      case "rate_limited":
        return { kind: "failed", message: failure.message };
      case "refused":
        // A 400 or 422 has the server's own words (a check too large, values it refused).
        return { kind: "failed", message: error instanceof DropshipApiError && error.message.trim() ? error.message : PRICE_DEFAULT_WORDS.reviewFailed };
      default:
        return { kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed };
    }
  }
  const parsed = pricingReviewResponseSchema.safeParse(answer);
  return parsed.success ? { kind: "ok", review: parsed.data } : { kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed };
}

/**
 * After a 409 stale, the profile was read again. If its revision moved, someone
 * else saved, so the vendor sees the conflict; otherwise only prices or costs
 * moved and the check simply runs again.
 */
export function decideStaleCheck(checkedRevisionId: number | null, latest: Pick<PricingProfileState, "revisionId">): "conflict" | "recheck" {
  return latest.revisionId === checkedRevisionId ? "recheck" : "conflict";
}

/** A check refused as stale is read again and sent once more; a second refusal is shown, never looped. */
export const MAX_PRICE_CHECK_ATTEMPTS = 2;

export type PriceCheckOutcome =
  | { kind: "checked"; review: PricingReviewResponse; request: ReviewPricingRulesInput }
  /** What is saved moved away from the draft's start; the draft now shows the conflict. Nothing was sent. */
  | { kind: "conflict" }
  | { kind: "blocked"; error: unknown }
  | { kind: "failed"; message: string };

export interface PriceCheckRun {
  /** The saved value the draft started from. */
  base: DraftValue;
  /** The recipe to check, from `recipeFromDraft`. */
  recipe: PricingRecipe;
  /** The saved profile as last read. */
  start: PricingProfileState;
  drafts: PriceSaveDrafts;
  send: (input: ReviewPricingRulesInput) => Promise<unknown>;
  /** Reads the saved profile again (`rereadPricingRules`). */
  reread: () => Promise<PricingProfileState>;
}

/**
 * Checks a recipe against what is saved (M3). Before anything is sent, a
 * saved store price that moved away from the draft's start becomes the
 * conflict (never overwritten unseen). A stale refusal means the saved
 * profile moved since it was read: it is read again and, if the store price
 * itself did not move, checked once more against the latest groups and
 * revision. Never throws; every failure has vendor words.
 */
export async function runPriceCheck(run: PriceCheckRun): Promise<PriceCheckOutcome> {
  let latest = run.start;
  try {
    for (let attempt = 0; attempt < MAX_PRICE_CHECK_ATTEMPTS; attempt += 1) {
      if (priceBaseMoved(run.base, priceDefaultBase(latest, null))) {
        settlePriceConflictBeforeSending(run.drafts);
        return { kind: "conflict" };
      }
      const request = buildPricingReviewRequest(latest, run.recipe);
      const outcome = await requestPricingReview(() => run.send(request));
      switch (outcome.kind) {
        case "ok":
          return { kind: "checked", review: outcome.review, request };
        case "blocked":
          return { kind: "blocked", error: outcome.error };
        case "failed":
          return { kind: "failed", message: outcome.message };
        case "stale":
          latest = await run.reread();
          break;
      }
    }
    return { kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed };
  } catch (error) {
    // A request this page couldn't build has its own words; a failed re-read is just "couldn't check".
    return { kind: "failed", message: error instanceof PriceDefaultRequestError ? error.message : PRICE_DEFAULT_WORDS.reviewFailed };
  }
}

/**
 * After a save refused as stale (409, R:683): the profile is read again. A
 * moved revision is someone else's save, so the conflict the draft shows
 * stays. Otherwise only prices or costs moved, and the check runs again on
 * the latest profile. A failed read keeps the conflict; [Load latest and
 * keep my changes] reads again.
 */
export async function decideAfterStaleApply(
  checkedRevisionId: number | null,
  reread: () => Promise<PricingProfileState>,
): Promise<{ kind: "conflict" } | { kind: "recheck"; latest: PricingProfileState }> {
  let latest: PricingProfileState;
  try {
    latest = await reread();
  } catch {
    return { kind: "conflict" };
  }
  return decideStaleCheck(checkedRevisionId, latest) === "recheck" ? { kind: "recheck", latest } : { kind: "conflict" };
}

// ---------------------------------------------------------------------------
// Running a save (POST …/apply)
// ---------------------------------------------------------------------------

/** The page's pending-save counter (D10): it holds back a queue or push while a save runs. */
export interface PriceSaveCallbacks {
  disabled?: boolean;
  /** Throws when another listing action is running; then nothing is sent. */
  onSaveStarted: () => void;
  onSaveSettled: () => void;
}

/** The draft provider's two save calls (ListingSettingsDraftsProvider). */
export interface PriceSaveDrafts {
  startSave: (signature: string, keyPrefix: string) => string | null;
  settle: (
    key: string,
    settlement: { kind: "saved" } | { kind: "saved_view_stale" } | { kind: "failure"; failure: WriteFailure },
  ) => void;
}

export interface PricingApplyRun {
  /** The apply's signature: `pricingApplySignature(review)`, or the draft's last one when resending. */
  signature: string;
  drafts: PriceSaveDrafts;
  callbacks: PriceSaveCallbacks;
  send: (input: ApplyPricingRulesInput) => Promise<unknown>;
  /** Reads the saved profile again and marks size prices stale (`refreshAfterPricingApply`). */
  reread: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads the summary again. */
  onSaved: () => void;
  /** A save refused because of a block a banner explains (plan 4.4). The draft is kept. */
  onBlocked?: (error: unknown) => void;
}

export type PricingApplyOutcome =
  | { kind: "not_started"; message: string | null }
  | { kind: "saved"; viewStale: boolean }
  | { kind: "failed"; failure: WriteFailure };

/**
 * One save of a checked store price, start to finish:
 * 1. the page's pending-save counter starts, or the save does not;
 * 2. the draft takes the request key: the same review reuses its key;
 * 3. the apply is sent; a failure is classified (W1) and settles the draft;
 * 4. a 2xx means saved. The profile is read again (never taken from the
 *    answer, D9); if that read or the answer's contract check fails, the save
 *    still stands and the vendor sees "Saved. We couldn't load the latest view.";
 * 5. the step is told, and the counter always ends once it started.
 */
export async function runPricingApply(run: PricingApplyRun): Promise<PricingApplyOutcome> {
  if (run.callbacks.disabled) return { kind: "not_started", message: PRICE_DEFAULT_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and Save works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, PRICE_DEFAULT_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(run.signature, LISTING_SETTINGS_KEY_PREFIXES.pricingApply);
    if (key === null) return { kind: "not_started", message: null };

    let input: ApplyPricingRulesInput;
    try {
      input = buildPricingApplyRequest(run.signature, key);
    } catch (error) {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused",
        message: queryErrorMessage(error, REBUILD_MESSAGE),
        code: error instanceof PriceDefaultRequestError ? error.code : PRICE_DEFAULT_REQUEST_INVALID,
        status: null,
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure };
    }

    let answer: unknown;
    try {
      answer = await run.send(input);
    } catch (error) {
      const failure = classifyWriteFailure("W1", error);
      run.drafts.settle(key, { kind: "failure", failure });
      if (failure.phase === "blocked") run.onBlocked?.(error);
      return { kind: "failed", failure };
    }

    let viewStale = false;
    try {
      pricingApplyAnswerSchema.parse(answer);
      await run.reread();
    } catch {
      // Deliberate: the server answered 2xx, so the save stands. Only the view is out of date,
      // and the draft says so with [Reload] ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSaved();
    return { kind: "saved", viewStale };
  } finally {
    run.callbacks.onSaveSettled();
  }
}

/** The request signature a conflict found before sending settles under (nothing is sent with it). */
const BASE_MOVED_SIGNATURE = "price-base-moved";

/**
 * Shows "This changed in another window." when what is saved moved away from
 * the draft's start before anything was sent. The draft goes through the same
 * conflict state as a 409, so [Load latest and keep my changes] works the same
 * way. Returns false when the draft can't take it now (a save in flight).
 */
export function settlePriceConflictBeforeSending(drafts: PriceSaveDrafts): boolean {
  const key = drafts.startSave(BASE_MOVED_SIGNATURE, LISTING_SETTINGS_KEY_PREFIXES.pricingApply);
  if (key === null) return false;
  drafts.settle(key, {
    kind: "failure",
    failure: { phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, code: null, status: null },
  });
  return true;
}

// ---------------------------------------------------------------------------
// The editor's footer and the check's footer
// ---------------------------------------------------------------------------

/**
 * What the editor's main button does:
 * - `check`: build a check from the draft;
 * - `resend`: send the last apply again with its key (an unconfirmed save);
 * - `load_latest`: read what is saved now and put the vendor's changes on top (a conflict);
 * - `none`: a save or a check is in flight.
 */
export type PriceEditorAction = "check" | "resend" | "load_latest" | "none";

export interface PriceEditorFooter {
  primary: { label: string; action: PriceEditorAction; disabled: boolean };
  cancelDisabled: boolean;
  /** The draft's words: an alert for a failed save, a status line otherwise. */
  message: { text: string; tone: "alert" | "status" } | null;
}

export interface PriceEditorFooterInput {
  draft: Pick<ListingSettingsDraft, "phase" | "changes" | "message" | "attempt"> | null;
  /** The saved profile has answered, so a check can be built. */
  ready: boolean;
  /** W1 would take a save (plan 4.3). */
  editable: boolean;
  /** Another listing action is running, so the page holds saves back. */
  busy: boolean;
  /** A check is running. */
  checking: boolean;
  /** Nothing is saved, so the suggestion can be checked as it is. */
  suggestion: boolean;
}

const FAILURE_PHASES: ReadonlySet<SavePhase> = new Set<SavePhase>([
  "uncertain", "unreachable", "conflict", "refused", "rate_limited", "reload_required", "blocked", "saved_view_stale",
]);

function draftMessage(draft: PriceEditorFooterInput["draft"]): PriceEditorFooter["message"] {
  if (!draft?.message) return null;
  return { text: draft.message, tone: FAILURE_PHASES.has(draft.phase) ? "alert" : "status" };
}

export function priceEditorFooter(input: PriceEditorFooterInput): PriceEditorFooter {
  const { draft } = input;
  const message = draftMessage(draft);
  switch (draft?.phase) {
    case "saving":
      return { primary: { label: LISTING_SETTINGS_SAVE_WORDS.saving, action: "none", disabled: true }, cancelDisabled: true, message };
    case "uncertain":
      // Locked until settled (R:541): "Check again" resends the same apply with the same key.
      return {
        primary: { label: LISTING_SETTINGS_SAVE_WORDS.checkAgain, action: "resend", disabled: input.busy || draft.attempt === null },
        cancelDisabled: true,
        message,
      };
    case "conflict":
      return { primary: { label: LISTING_SETTINGS_SAVE_WORDS.loadLatest, action: "load_latest", disabled: input.checking }, cancelDisabled: false, message };
    default:
      if (input.checking) {
        return { primary: { label: PRICE_DEFAULT_WORDS.checking, action: "none", disabled: true }, cancelDisabled: false, message };
      }
      return {
        primary: {
          label: PRICE_DEFAULT_WORDS.checkNewPrices,
          action: "check",
          disabled: !input.ready || !input.editable || input.busy || draft == null
            || draft.phase === "reload_required" || (draft.changes === 0 && !input.suggestion),
        },
        cancelDisabled: false,
        message,
      };
  }
}

/**
 * The check's buttons (M3 footer):
 * - `save`: apply the check (the same review keeps its key);
 * - `resend`: an unconfirmed save; "Check again" sends the same apply;
 * - `none`: a save in flight.
 * Back and × are off while a save is in flight or unconfirmed (the draft is locked).
 */
export interface CheckNewPricesFooter {
  primary: { label: string; action: "save" | "resend" | "none"; disabled: boolean };
  backDisabled: boolean;
}

export function checkNewPricesFooter(input: {
  phase: SavePhase | null;
  blocked: number;
  busy: boolean;
  paging: boolean;
}): CheckNewPricesFooter {
  switch (input.phase) {
    case "saving":
      return { primary: { label: CHECK_NEW_PRICES_WORDS.saving, action: "none", disabled: true }, backDisabled: true };
    case "uncertain":
      return { primary: { label: CHECK_NEW_PRICES_WORDS.checkAgain, action: "resend", disabled: input.busy }, backDisabled: true };
    default:
      // Today's W1 refuses a check with any blocked size (C9, section 6), so Save stays off and the footer says why.
      return {
        primary: { label: CHECK_NEW_PRICES_WORDS.save, action: "save", disabled: input.blocked > 0 || input.busy || input.paging },
        backDisabled: false,
      };
  }
}

// ---------------------------------------------------------------------------
// The check's words (M3)
// ---------------------------------------------------------------------------

/** The name `resolvePricingRule` gives the store default recipe (shared/dropship/pricing-rules.ts). */
const STORE_DEFAULT_RULE_NAME = "Store default rule";

/** The size price falls below the .ops cost of one pack (server/modules/dropship/domain/listing-price-cost.ts). Never a block. */
const BELOW_COST_WARNING = "price_below_product_cost";
/** A Card Shellz price limit the new price breaks (`evaluateListingPricingPolicy`): `pricing:<violation>:policy_<id>`. */
const PRICE_LIMIT_CODE = /^pricing:(?:below_floor|above_ceiling):policy_\d+$/;

/** The Built from words of a rule price, as 1A's lines read them: "retail $12.50 + 20%, up to .99". */
function ruleStartWords(recipe: PricingRecipe, basis: PricingRecipe["basis"], basisCents: number | null | undefined): string {
  const start = basis === "catalog_retail" ? "retail" : "your cost";
  const amount = basisCents == null ? "" : ` ${formatCents(basisCents)}`;
  const flat = recipe.flatCents > 0 ? ` plus ${formatCents(recipe.flatCents)}` : "";
  const rounding = recipe.rounding === "up_99" ? ", up to .99" : "";
  return `${start}${amount} + ${percentText(recipe.markupBps)}%${flat}${rounding}`;
}

/** "Can't price: …" for a size the checked recipe gives no price. The same words as 1A's Built from lines. */
function cannotPriceWords(row: Pick<PricingImpactRow, "issues" | "basis">): string {
  const issues = new Set(row.issues);
  if (issues.has("pricing_basis_unavailable")) {
    if (row.basis === "catalog_retail") return "Can't price: Card Shellz has no retail price for this size";
    if (row.basis === "product_cost") return "Can't price: your cost isn't on file. Contact support.";
    return "Can't price: what the store price starts from isn't on file"; // interim
  }
  if (issues.has("pricing_rule_priority_conflict")) return "Can't price: two older group rules tie"; // interim
  if (issues.has("pricing_result_out_of_range")) return "Can't price: the rule's price is out of range"; // interim
  return "Can't price this size"; // interim; the server always names the rule's reason
}

/**
 * Where a size's new price comes from (R:593), never a raw rule name or code:
 * - a kept exact price: "Exact price" (never "Fixed override preserved", C9);
 * - the store default: "Store default: retail $12.50 + 20%, up to .99";
 * - an older group rule: "From your older group rule “Envelopes”: retail $6.25 + 30%";
 * - no price: "Can't price: …".
 * `profile` is the profile the check was made with. A group rule's recipe is
 * found by its name; when two groups share the name, only the starting amount is shown.
 */
export function reviewRowBuiltFrom(row: PricingImpactRow, profile: PricingProfile): string {
  if (row.preserved) return CHECK_NEW_PRICES_WORDS.exactPrice;
  if (row.priceCents === null) return cannotPriceWords(row);
  const name = row.ruleName;
  if (name === null) return "Your pricing rules"; // interim; a rule price always names its rule
  if (name === STORE_DEFAULT_RULE_NAME) {
    const recipe = profile.defaultRecipe;
    return `Store default: ${ruleStartWords(recipe, row.basis ?? recipe.basis, row.basisCents)}`;
  }
  const label = `From your older group rule “${name}”`;
  const matches = profile.groups.filter((group) => group.name === name);
  if (matches.length === 1) {
    const recipe = matches[0].recipe;
    return `${label}: ${ruleStartWords(recipe, row.basis ?? recipe.basis, row.basisCents)}`;
  }
  if (!row.basis) return label;
  const start = row.basis === "catalog_retail" ? "retail" : "your cost";
  return row.basisCents == null ? `${label}: ${start}` : `${label}: ${start} ${formatCents(row.basisCents)}`;
}

export type ReviewNoteKind = "below_cost" | "loses_price" | "outside_limit";
export interface ReviewNote {
  kind: ReviewNoteKind;
  text: string;
}

/**
 * The Note column (M3): "! Below your cost ($23.10)" (a warning, never a
 * block), "● Loses its price" (had a price, would have none), and "Outside a
 * Card Shellz price limit" (a limit's code, warn-only or blocking; C9).
 */
export function reviewRowNotes(row: Pick<PricingImpactRow, "previousPriceCents" | "priceCents" | "productCostCents" | "issues" | "warnings">): ReviewNote[] {
  const notes: ReviewNote[] = [];
  const warnings = row.warnings ?? [];
  if (warnings.includes(BELOW_COST_WARNING)) {
    notes.push({ kind: "below_cost", text: row.productCostCents === null ? "! Below your cost" : `! Below your cost (${formatCents(row.productCostCents)})` });
  }
  if (row.previousPriceCents !== null && row.priceCents === null) notes.push({ kind: "loses_price", text: CHECK_NEW_PRICES_WORDS.losesPrice });
  if ([...row.issues, ...warnings].some((code) => PRICE_LIMIT_CODE.test(code))) {
    notes.push({ kind: "outside_limit", text: CHECK_NEW_PRICES_WORDS.outsideLimit });
  }
  return notes;
}

/** A price in the Now and New columns: "$27.99", or "—" for none. */
export function reviewPriceWords(cents: number | null): string {
  return cents === null ? CHECK_NEW_PRICES_WORDS.noPrice : formatCents(cents);
}

/** The size under its product: "Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500", without empty parts. */
export function reviewSizeLine(row: Pick<PricingImpactRow, "sizeName" | "sku">): string {
  return [row.sizeName?.trim(), row.sku?.trim()].filter((part): part is string => Boolean(part)).join(" · ");
}

/** "1,240 sizes · 1,180 change · 36 keep their own price" (M3). Parts that are zero are left out, except the sizes. */
export function reviewCountsWords(summary: PricingReviewResponse["summary"]): string {
  const parts = [`${count(summary.total)} ${summary.total === 1 ? "size" : "sizes"}`];
  parts.push(summary.changed === 0 ? "no price changes" : `${count(summary.changed)} change`);
  if (summary.preserved > 0) {
    parts.push(`${count(summary.preserved)} ${summary.preserved === 1 ? "keeps its own price" : "keep their own price"}`);
  }
  return parts.join(" · ");
}

/** The footer line while sizes block the save (C9; interim words). Null when none do. */
export function reviewBlockedWords(blocked: number): string | null {
  if (blocked <= 0) return null;
  return blocked === 1
    ? "● 1 size can't be priced this way. Give it an exact price in Products, or start from Your cost."
    : `● ${count(blocked)} sizes can't be priced this way. Give them an exact price in Products, or start from Your cost.`;
}

/** "1–50 of 1,240"; null for a check with no sizes. */
export function reviewPageWords(review: Pick<PricingReviewResponse, "page" | "summary">, pageSize: number): string | null {
  if (review.summary.total === 0) return null;
  const first = review.page * pageSize + 1;
  const last = Math.min(review.summary.total, (review.page + 1) * pageSize);
  return `${count(first)}–${count(last)} of ${count(review.summary.total)}`;
}

export function hasPreviousReviewPage(review: Pick<PricingReviewResponse, "page">): boolean {
  return review.page > 0;
}

export function hasNextReviewPage(review: Pick<PricingReviewResponse, "page" | "summary">, pageSize: number): boolean {
  return (review.page + 1) * pageSize < review.summary.total;
}
