import type { QueryClient } from "@tanstack/react-query";
import {
  applyPriceChangesResponseSchema,
  priceChangeReviewResponseSchema,
  type ApplyPriceChangesInput,
  type ApplyPriceChangesResponse,
  type PriceChangeReviewKind,
  type PriceChangeReviewResponse,
  type ReviewPriceChangesInput,
} from "@shared/dropship/listing-setting-writes";
import { DropshipApiError, fetchJson, postJson, queryErrorMessage } from "./dropship-ops-surface";
import { listingSettingsProductOwnQueryOptions, listingSettingsQueryKey } from "./dropship-listing-settings";
import {
  classifyWriteFailure,
  failureAfterUnconfirmed,
  LISTING_SETTINGS_KEY_PREFIXES,
  LISTING_SETTINGS_SAVE_WORDS,
  type DraftValue,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import {
  checkPriceCheckPage,
  decideAfterApplyRefusal,
  isPriceCheckPage,
  PRICE_CHECK_REQUEST_INVALID,
  PriceCheckRequestError,
  priceCheckAfterOf,
  priceCheckApplyBody,
  priceCheckApplySignature,
  priceCheckRefOf,
  productPricesReviewBody,
  refusedSizesOf,
} from "./dropship-listing-settings-price-check";
import {
  productPriceBaseMoved,
  productPriceBaseOf,
  rebaseProductPriceDraft,
  type PriceCheckAfter,
  type PriceCheckRef,
  type ProductPriceBase,
  type ProductPriceChange,
  type ProductPriceDraftValue,
  type ProductPriceReload,
} from "./dropship-listing-settings-product-edit";
import type { ProductSettingsSaveCallbacks, ProductSettingsSaveDrafts } from "./dropship-listing-settings-product-requests";
import { CHECK_NEW_PRICES_WORDS, isStoreSizePriceQuery, MAX_PRICE_CHECK_ATTEMPTS, PRICE_DEFAULT_WORDS } from "./dropship-listing-settings-recipe";
import { priceChangeReviewIdSchema } from "@shared/dropship/listing-setting-writes";

/**
 * The price check for one or many products and its apply (W7
 * `product_prices`; Listing settings PR 10d, plan 7.3, 7.5, 7.6): the three
 * requests, the check run (the review), a page of it, the apply run from
 * Save to settled (as `runPricingApply` runs W1's and `runProductSettingsSave`
 * W5's), the re-reads after it, and the drawer's guard (D6a).
 *
 * Rules this module keeps (plan D1, D5, D6a, D7, D9, 7.5):
 * - The client never computes a price (D1): a check is the server's rows; the
 *   recipe sent is the one the editor parsed with the integer parsers.
 * - The check is unkeyed; one review has one apply key (`ls-price-check:…`),
 *   its signature `{reviewId, reviewHash}`, reused only while the same, so a
 *   Check again is answered by the first apply (D5).
 * - The drawer never applies over a price it didn't show (D6a): before every
 *   drawer check, and again after a 409 PRICES_MOVED before the automatic
 *   re-check, the own read is read again; a moved price or revision is the
 *   draft's conflict and nothing is sent.
 * - A refused apply that asks for a new check gets one, once
 *   (`MAX_PRICE_CHECK_ATTEMPTS`): the first check and this one re-check. The
 *   new check is shown with why; it is never applied by itself, and a second
 *   refusal is shown, never looped (7.5, CC-C11).
 * - An apply's answer is checked, never shown or cached: the views are read
 *   again instead (D9). A Check again answered "not now" keeps its doubt (D7b).
 *
 * The network calls and the query client are passed in, so every step can be
 * run in a test.
 */

// ---------------------------------------------------------------------------
// Endpoints (plan 7.3)
// ---------------------------------------------------------------------------

/** The W7 routes of one store (`S/interfaces/http/dropship-listing-setting-writes.routes.ts`). */
export function priceChangesEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/price-changes`;
}

/** POST …/price-changes/review. Resolves with the server's answer, unread. */
export function sendPriceChangeReview(storeConnectionId: number, body: ReviewPriceChangesInput): Promise<unknown> {
  return postJson<unknown>(`${priceChangesEndpoint(storeConnectionId)}/review`, body);
}

/** GET …/price-changes/reviews/:reviewId?page=N (a lowercase uuid, page 0 to 200). Resolves with the server's answer, unread. */
export function fetchPriceChangeReviewPage(storeConnectionId: number, reviewId: string, page: number): Promise<unknown> {
  if (!priceChangeReviewIdSchema.safeParse(reviewId).success) {
    throw new PriceCheckRequestError(CHECK_NEW_PRICES_WORDS.pageFailed, { reason: "review_id_invalid" });
  }
  if (!isPriceCheckPage(page)) throw new PriceCheckRequestError(CHECK_NEW_PRICES_WORDS.pageFailed, { reason: "page_invalid", page });
  return fetchJson<unknown>(`${priceChangesEndpoint(storeConnectionId)}/reviews/${encodeURIComponent(reviewId)}?page=${page}`);
}

/** POST …/price-changes/apply. Resolves with the server's answer, unread (D9). */
export function sendPriceChangeApply(storeConnectionId: number, body: ApplyPriceChangesInput): Promise<unknown> {
  return postJson<unknown>(`${priceChangesEndpoint(storeConnectionId)}/apply`, body);
}

// ---------------------------------------------------------------------------
// Re-reads (D6a, D9)
// ---------------------------------------------------------------------------

export type PriceCheckQueryClient = Pick<QueryClient, "cancelQueries" | "fetchQuery" | "invalidateQueries">;

/**
 * The product's own price and revision as saved now (the own read, read
 * again; D6a): what the drawer compares with its draft's base before a check.
 * A read in flight is cancelled first, so an older answer can't land after
 * this one. Throws when the read fails.
 */
export async function rereadProductPriceBase(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
  productId: number,
): Promise<ProductPriceBase> {
  const options = listingSettingsProductOwnQueryOptions(storeConnectionId, productId);
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  const own = await queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn, staleTime: 0, retry: false });
  return productPriceBaseOf(own);
}

/**
 * "Load latest and keep my changes" after the drawer's price conflict (D6a,
 * R:542): reads the own settings again, then gives the vendor's price change
 * on what is saved now (`rebaseProductPriceDraft`). The drawer sends `edited`,
 * then rebases on `latest` with `marked`; with nothing left to keep it
 * discards the draft. Throws when the read fails.
 */
export async function loadLatestProductPrice(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
  productId: number,
  mine: ProductPriceDraftValue,
): Promise<ProductPriceReload> {
  const options = listingSettingsProductOwnQueryOptions(storeConnectionId, productId);
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  const own = await queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn, staleTime: 0, retry: false });
  return rebaseProductPriceDraft(mine, own);
}

/** The listing settings reads an apply changes (plan 7.6): every product's detail and own row, the lists, the summary. */
const READS_AFTER_APPLY = ["product", "product-own", "products", "prices", "summary"] as const;

/**
 * After a confirmed apply (D9, plan 7.6): the product details and own reads,
 * the Products and Prices lists and the summary are marked stale and the shown
 * ones read now (prefixes: every page, every product), and so is every size
 * price read of the store (W1's rule). Reads in flight are cancelled first.
 * Never taken from the apply's answer. Throws when a refetch fails.
 */
export async function refreshAfterPriceChangeApply(queryClient: PriceCheckQueryClient, storeConnectionId: number): Promise<void> {
  const keys = READS_AFTER_APPLY.map((read) => [...listingSettingsQueryKey(storeConnectionId), read] as const);
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await Promise.all([
    ...keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })),
    queryClient.invalidateQueries({ predicate: isStoreSizePriceQuery(storeConnectionId) }, { throwOnError: true }),
  ]);
}

// ---------------------------------------------------------------------------
// The check (POST …/review; plan 7.5)
// ---------------------------------------------------------------------------

/**
 * How a check ended. A check saves nothing, so a dropped answer is just
 * "couldn't check" (never "we couldn't confirm your save"):
 * - `blocked`: a block a banner explains;
 * - `failed`: anything else, with its words (W7's refusals read by code and
 *   reason: more than 10,000 sizes, too many releases, too heavy, busy…).
 */
export type PriceChangeReviewOutcome =
  | { kind: "ok"; review: PriceChangeReviewResponse }
  | { kind: "blocked"; error: unknown }
  | { kind: "failed"; message: string };

export async function requestPriceChangeReview(
  send: () => Promise<unknown>,
  kind: PriceChangeReviewKind = "product_prices",
): Promise<PriceChangeReviewOutcome> {
  let answer: unknown;
  try {
    answer = await send();
  } catch (error) {
    const failure = classifyWriteFailure("W7", error);
    switch (failure.phase) {
      case "blocked":
        return { kind: "blocked", error };
      case "refused":
      case "rate_limited":
      case "unreachable":
      case "reload_required":
        return { kind: "failed", message: failure.message };
      default:
        // No answer, or a 5xx without a known code: nothing was saved by a check, so only "couldn't check".
        return { kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed };
    }
  }
  const parsed = priceChangeReviewResponseSchema.safeParse(answer);
  if (!parsed.success || parsed.data.kind !== kind || parsed.data.page !== 0) return { kind: "failed", message: PRICE_DEFAULT_WORDS.reviewFailed };
  return { kind: "ok", review: parsed.data };
}

/** The drawer's guard (D6a): the price and revision its draft started from, and the own read again. */
export interface PriceCheckGuard {
  base: ProductPriceBase;
  /** Reads the own settings again (`rereadProductPriceBase`). */
  reread: () => Promise<ProductPriceBase>;
  /** The draft to settle the conflict in when the price moved. */
  drafts: ProductSettingsSaveDrafts;
}

export interface PriceChangeCheckRun {
  /** The drawer's one product, or the sheet's products from its ids read (D6). */
  productIds: readonly number[];
  /** What to check: the recipe or "Use default", and "Clear exact prices too". */
  change: Pick<ProductPriceChange, "price" | "releaseExactPrices">;
  /** Why this check replaces an earlier one (the stale line); null or absent for a first check. */
  after?: PriceCheckAfter | null;
  send: (body: ReviewPriceChangesInput) => Promise<unknown>;
  /** The drawer's guard (D6a); absent for "Set for selected". */
  guard?: PriceCheckGuard;
}

export type PriceChangeCheckOutcome =
  /** The check to show; `check` goes in the owner's draft (`productPriceDraftWithCheck` / `bulkPriceDraftWithCheck`). */
  | { kind: "checked"; review: PriceChangeReviewResponse; check: PriceCheckRef; request: ReviewPriceChangesInput }
  /** The product's price or revision moved from the draft's start (D6a); the draft shows the conflict. Nothing was sent. */
  | { kind: "conflict" }
  | { kind: "blocked"; error: unknown }
  | { kind: "failed"; message: string };

/**
 * One check (plan 7.3): for the drawer, the own read is read again first and
 * a moved price or revision is the conflict, nothing sent (D6a); then the
 * review body is checked by the shared schema and sent. Never throws; every
 * failure has vendor words. A failed guard read sends nothing either ("couldn't check").
 */
export async function runPriceChangeCheck(run: PriceChangeCheckRun): Promise<PriceChangeCheckOutcome> {
  try {
    if (run.guard !== undefined) {
      const latest = await run.guard.reread();
      if (productPriceBaseMoved(run.guard.base, latest)) {
        settlePriceCheckConflict(run.guard.drafts);
        return { kind: "conflict" };
      }
    }
    const request = productPricesReviewBody({ productIds: run.productIds, price: run.change.price, releaseExactPrices: run.change.releaseExactPrices });
    const outcome = await requestPriceChangeReview(() => run.send(request));
    switch (outcome.kind) {
      case "ok":
        return { kind: "checked", review: outcome.review, check: priceCheckRefOf(outcome.review, run.after ?? null), request };
      case "blocked":
        return { kind: "blocked", error: outcome.error };
      case "failed":
        return { kind: "failed", message: outcome.message };
    }
  } catch (error) {
    // A request this page couldn't build has its own words; a failed guard read is just "couldn't check".
    return { kind: "failed", message: error instanceof PriceCheckRequestError ? error.message : PRICE_DEFAULT_WORDS.reviewFailed };
  }
}

/** The request signature a conflict found before sending settles under (nothing is sent with it). */
const BASE_MOVED_SIGNATURE = "price-check-base-moved";

/**
 * Shows "This changed in another window." when the product's price or
 * revision moved away from the draft's start before anything was sent (D6a).
 * The draft goes through the same conflict state as a 409, so [Load latest and
 * keep my changes] works the same way (`loadLatestProductPrice`). Returns
 * false when the draft can't take it now (a save in flight).
 */
export function settlePriceCheckConflict(drafts: ProductSettingsSaveDrafts): boolean {
  const key = drafts.startSave(BASE_MOVED_SIGNATURE, LISTING_SETTINGS_KEY_PREFIXES.priceCheck);
  if (key === null) return false;
  drafts.settle(key, {
    kind: "failure",
    failure: { phase: "conflict", message: LISTING_SETTINGS_SAVE_WORDS.conflict, code: null, status: null, fields: [] },
  });
  return true;
}

// ---------------------------------------------------------------------------
// A page of the check (GET …/reviews/:reviewId?page=; plan 7.5)
// ---------------------------------------------------------------------------

const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const PRICING_REVIEW_NOT_FOUND_CODE = "DROPSHIP_PRICING_REVIEW_NOT_FOUND";

export type PriceCheckPageOutcome =
  | { kind: "ok"; review: PriceChangeReviewResponse }
  /** The server no longer holds the check (404): the owner checks again. */
  | { kind: "expired" }
  /** Too many checks in a minute, or the page couldn't be read; the words say which. */
  | { kind: "failed"; message: string };

/**
 * A page of the check shown (plan 7.5): the answer must be the very review
 * (same id and hash) on its contract. 429 says "Too many checks in a minute…"
 * (D10), a 404 of the review means a new check, anything else "Couldn't load
 * this page of the check. Try again." Never throws.
 */
export async function readPriceCheckPage(
  current: Pick<PriceCheckRef, "reviewId" | "reviewHash">,
  fetchPage: () => Promise<unknown>,
  kind: PriceChangeReviewKind = "product_prices",
): Promise<PriceCheckPageOutcome> {
  let answer: unknown;
  try {
    answer = await fetchPage();
  } catch (error) {
    if (error instanceof DropshipApiError) {
      if (error.status === HTTP_TOO_MANY_REQUESTS) return { kind: "failed", message: DRAWER_WORDS.readRateLimited };
      if (error.status === HTTP_NOT_FOUND && error.code === PRICING_REVIEW_NOT_FOUND_CODE) return { kind: "expired" };
    }
    return { kind: "failed", message: CHECK_NEW_PRICES_WORDS.pageFailed };
  }
  try {
    return { kind: "ok", review: checkPriceCheckPage(current, answer, kind) };
  } catch (error) {
    return { kind: "failed", message: queryErrorMessage(error, CHECK_NEW_PRICES_WORDS.pageFailed) };
  }
}

// ---------------------------------------------------------------------------
// The apply (POST …/apply; plan 7.5, 7.6, D5, D7, D9)
// ---------------------------------------------------------------------------

/** The draft provider's save calls, and `edit`: the re-check's result goes in the draft (D16, D21). */
export interface PriceCheckDrafts extends ProductSettingsSaveDrafts {
  edit: (value: DraftValue) => void;
}

/** After a refusal that asks for a new check (plan 7.5): the owner's check run, and its draft value with another check. */
export interface PriceCheckRecheck {
  /** Runs the owner's check again (`runPriceChangeCheck` with the drawer's guard, D6a), with why. */
  check: (after: PriceCheckAfter) => Promise<PriceChangeCheckOutcome>;
  /** The owner's draft value with `check` in place of the one it holds; null drops it (the editor shows again). */
  withCheck: (check: PriceCheckRef | null) => DraftValue;
}

export interface PriceChangeApplyRun {
  /** The check's kind; `product_prices` for this part. */
  kind?: PriceChangeReviewKind;
  /** The owner's draft as Save (or Check again) was pressed: its phase decides a Check again's doubt (D7b). */
  draft: Pick<ListingSettingsDraft, "phase">;
  /**
   * The check the draft holds: the review the vendor saw and its hash (D6),
   * and why it replaced an earlier one (`after`): a check made after an
   * apply's refusal is the last, so its own refusal is shown, never
   * re-checked (7.5); one made after a page read's 404 (`page_expired`) has
   * had no apply yet, so it still gets the one automatic re-check.
   */
  check: Pick<PriceCheckRef, "reviewId" | "reviewHash"> & Partial<Pick<PriceCheckRef, "after">>;
  drafts: PriceCheckDrafts;
  /** The page's pending-save counter (D10). */
  callbacks: ProductSettingsSaveCallbacks;
  send: (body: ApplyPriceChangesInput) => Promise<unknown>;
  /** Reads the views again (`refreshAfterPriceChangeApply`). */
  reread: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads every listing settings view again. */
  onSettingsSaved: () => void;
  /** A save refused because of a block a banner explains. The draft is kept. Never given a refusal (D8). */
  onBlocked?: (error: unknown) => void;
  recheck: PriceCheckRecheck;
}

export type PriceChangeApplyOutcome =
  /** Nothing was sent: another action is running, or no save can start now. */
  | { kind: "not_started"; message: string | null }
  /** Saved; the views are read again (D9). `viewStale`: that read, or the answer's contract, failed: the owner offers Reload. */
  | { kind: "saved"; viewStale: boolean }
  /** Shown by the check body; `refusedSizes` names the sizes a 422 WOULD_BE_LOST refused (rows "● Loses its price"). */
  | { kind: "failed"; failure: WriteFailure; refusedSizes: ReadonlySet<number> }
  /** The apply was refused for a reason a new check answers (7.5): the new check is in the draft, with why. */
  | { kind: "rechecked"; review: PriceChangeReviewResponse; check: PriceCheckRef; after: PriceCheckAfter }
  /** The apply was refused, and the new check couldn't be made: the check is dropped, the editor shows these words. */
  | { kind: "recheck_failed"; message: string; after: PriceCheckAfter }
  /** The product's price moved under the apply (D6a): the check is dropped, the draft shows the conflict. */
  | { kind: "conflict" };

/**
 * Automatic re-checks after a refused apply: the first check and this one are
 * the attempts (`MAX_PRICE_CHECK_ATTEMPTS`, W1's bound). The re-check's own
 * apply, if refused, is shown (`check.after` is set), so no apply ever
 * re-checks twice over: never looped.
 */
const AUTOMATIC_RECHECKS = MAX_PRICE_CHECK_ATTEMPTS - 1;

/**
 * One apply of a checked price change, start to finish (plan 7.3, 7.5):
 * 1. the page's pending-save counter starts, or the apply does not;
 * 2. the draft takes the request key (`ls-price-check`): the same check reuses its key;
 * 3. the body is checked by the shared schema, then sent; a failure is
 *    classified (W7) and, for a Check again, keeps its doubt (D7b);
 * 4. a refusal that asks for a new check (prices moved, already applied, no
 *    such check, a release's refusal) gets one, once: the stale check leaves
 *    the draft, the owner's check runs (the drawer's guard first, D6a), and
 *    the new check goes in with why; it is never applied by itself;
 * 5. a 2xx means saved. The views are read again (the answer is only checked);
 *    if that read or the check fails, the save still stands and the vendor sees
 *    "Saved. We couldn't load the latest view.";
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runPriceChangeApply(run: PriceChangeApplyRun): Promise<PriceChangeApplyOutcome> {
  const kind = run.kind ?? "product_prices";
  const signature = priceCheckApplySignature(run.check);
  // Read before the save starts: startSave turns the phase to "saving".
  const wasUncertain = run.draft.phase === "uncertain";

  if (run.callbacks.disabled) return { kind: "not_started", message: DRAWER_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and Save works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, DRAWER_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(signature, LISTING_SETTINGS_KEY_PREFIXES.priceCheck);
    if (key === null) return { kind: "not_started", message: null };

    let body: ApplyPriceChangesInput;
    try {
      body = priceCheckApplyBody(signature, key);
    } catch (error) {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused",
        message: queryErrorMessage(error, LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone),
        code: error instanceof PriceCheckRequestError ? error.code : PRICE_CHECK_REQUEST_INVALID,
        status: null,
        fields: [],
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure, refusedSizes: refusedSizesOf(null) };
    }

    let answer: unknown;
    try {
      answer = await run.send(body);
    } catch (error) {
      const classified = classifyWriteFailure("W7", error);
      const failure = failureAfterUnconfirmed(wasUncertain, classified);
      run.drafts.settle(key, { kind: "failure", failure });
      // The banner learns of every block, a Check again's too, which stays unconfirmed (D7b).
      if (classified.phase === "blocked") run.onBlocked?.(error);
      const context = error instanceof DropshipApiError ? error.context : null;
      // A refusal a new check answers gets one, once: a check that already came from an apply's re-check is shown as refused (CC-C11).
      const firstCheck = run.check.after == null || run.check.after === "page_expired";
      if (firstCheck && failure.phase === "refused" && decideAfterApplyRefusal(kind, failure.code, context) === "recheck") {
        return recheckAfterRefusal(run, failure.code);
      }
      return { kind: "failed", failure, refusedSizes: refusedSizesOf(context) };
    }

    let viewStale = false;
    try {
      // Checked for its contract only; what it says is never shown or cached (D9).
      readAppliedPriceChange(answer, run.check.reviewId);
    } catch {
      // Deliberate: a 2xx saved, but the page and the server disagree on the answer. The views are
      // still read again, and the draft says the view may be out of date, with [Reload].
      viewStale = true;
    }
    try {
      await run.reread();
    } catch {
      // Deliberate: the save stands; only the view is out of date ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSettingsSaved();
    return { kind: "saved", viewStale };
  } finally {
    run.callbacks.onSaveSettled();
  }
}

/**
 * A W7 apply answer checked against its contract, for the review it was sent
 * for. Throws when it doesn't match: the save still stands (a 2xx), only the
 * page can't trust what it says.
 */
export function readAppliedPriceChange(answer: unknown, reviewId: string): ApplyPriceChangesResponse {
  const parsed = applyPriceChangesResponseSchema.safeParse(answer);
  if (parsed.success && parsed.data.reviewId === reviewId) return parsed.data;
  throw new PriceCheckRequestError("This page couldn't read Card Shellz's answer. Reload the page and try again.", {
    reason: parsed.success ? "other_review" : "apply_answer_off_contract",
  });
}

/**
 * Step 4 of the apply: the refused check leaves the draft, then the owner's
 * check runs once (`AUTOMATIC_RECHECKS`): a new check goes in the draft with
 * why; a conflict (the drawer's guard, D6a) is already settled by the check
 * run; a block goes to the banner; a failed check leaves the editor with
 * its words. The draft is `refused` (unlocked) here, so `edit` takes it.
 */
async function recheckAfterRefusal(run: PriceChangeApplyRun, code: string | null): Promise<PriceChangeApplyOutcome> {
  const after = priceCheckAfterOf(code);
  run.drafts.edit(run.recheck.withCheck(null));
  for (let attempt = 0; attempt < AUTOMATIC_RECHECKS; attempt += 1) {
    const outcome = await run.recheck.check(after);
    switch (outcome.kind) {
      case "checked":
        run.drafts.edit(run.recheck.withCheck(outcome.check));
        return { kind: "rechecked", review: outcome.review, check: outcome.check, after };
      case "conflict":
        return { kind: "conflict" };
      case "blocked":
        run.onBlocked?.(outcome.error);
        return { kind: "recheck_failed", message: LISTING_SETTINGS_SAVE_WORDS.blocked, after };
      case "failed":
        return { kind: "recheck_failed", message: outcome.message, after };
    }
  }
  return { kind: "recheck_failed", message: PRICE_DEFAULT_WORDS.reviewFailed, after };
}
