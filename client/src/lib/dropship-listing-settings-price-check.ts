import {
  applyPriceChangesInputSchema,
  MAX_PRICE_CHANGE_REVIEW_PAGE,
  priceChangeReviewResponseSchema,
  reviewPriceChangesInputSchema,
  type ApplyPriceChangesInput,
  type PriceChangeReviewKind,
  type PriceChangeReviewResponse,
  type PriceChangeRow,
  type ReviewPriceChangesInput,
} from "@shared/dropship/listing-setting-writes";
import { PRICING_REVIEW_PAGE_SIZE, RETAIL_FALLBACK_RULE_NAME, type PricingRecipe } from "@shared/dropship/pricing-rules";
import type { ListingSettingsRight, ListingSettingsRightReason } from "./dropship-listing-settings-access";
import {
  isDraftDirty,
  isDraftLocked,
  type ListingSettingsDraft,
  type SavePhase,
} from "./dropship-listing-settings-drafts";
import { recipeWords, reviewRetailFallbackWords } from "./dropship-listing-settings-price-words";
import {
  isProductPriceChanged,
  type FieldChoice,
  type PriceCheckAfter,
  type PriceCheckRef,
  type ProductFieldRights,
  type ProductPriceChange,
} from "./dropship-listing-settings-product-edit";
import {
  CHECK_NEW_PRICES_WORDS,
  checkNewPricesFooter,
  hasNextReviewPage,
  hasPreviousReviewPage,
  PRICE_DEFAULT_WORDS,
  priceRecipeDraft,
  recipeFromDraft,
  reviewBlockedWords,
  reviewCannotPriceWords,
  reviewPageWords,
  reviewPriceWords,
  reviewRowNotes,
  reviewSizeLine,
  type CheckNewPricesFooter,
  type PriceRecipeDraft,
  type ReviewNoteKind,
} from "./dropship-listing-settings-recipe";
import {
  builtFromStartWords,
  LISTING_SETTINGS_EDIT_WORDS,
  LISTING_SETTINGS_PRICE_CHECK_WORDS,
  loseExactPriceWords,
  olderGroupRuleWords,
  pendingSettingWords,
  rightReasonLine,
  wouldBeLeftWithoutPriceWords,
  wouldLosePriceCountWords,
} from "./dropship-listing-settings-words";
import { SUGGESTED_PRICING_RECIPE } from "./dropship-pricing-rules";

/**
 * The price check for one or many products (W7 `product_prices`; Listing
 * settings PR 10d, plan 7.2-7.6): the review request a product's drawer or
 * "Set for selected" sends, the check's rows, counts, pages and footer as
 * the vendor reads them, the price editor's model, and what an apply's
 * refusal means (check again, or show it).
 *
 * Rules this module keeps:
 * - The client never computes a price (D1): every Now and New price is the
 *   server's integer cents, shown through `formatCents`; the recipe the
 *   vendor types is parsed with PR 7's integer parsers (`recipeFromDraft`).
 * - The check lives inside its owner's draft (D16) and replaces its body
 *   (D20); one review has one apply key, its signature `{reviewId,
 *   reviewHash}` (D5); a moved apply checks again once, never re-applies
 *   (7.5, `MAX_PRICE_CHECK_ATTEMPTS`).
 * - W1's own check sheet is not refactored (UX-m6): this module reuses its
 *   words and row helpers (`CHECK_NEW_PRICES_WORDS`, `reviewRowNotes`,
 *   `reviewSizeLine`, `reviewBlockedWords`, the pages).
 *
 * Pure: no React, no network, no clock. Never mutates its inputs. The
 * requests and runners are in dropship-listing-settings-price-check-requests.ts.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A request this page built that W7 would not take. A bug, never the vendor's doing. */
export const PRICE_CHECK_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_PRICE_CHECK_REQUEST_INVALID";

export class PriceCheckRequestError extends Error {
  readonly code = PRICE_CHECK_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "PriceCheckRequestError";
    this.context = Object.freeze({ ...context });
  }
}

/** At most this many contract issues are kept on an error: enough to find the field, never the values. */
const MAX_REPORTED_ISSUES = 5;

function issuePaths(error: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number> }> }): string[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => issue.path.join("."));
}

const REBUILD_MESSAGE = "This price check couldn't be built. Reload the page and try again.";

// ---------------------------------------------------------------------------
// The review request (POST …/price-changes/review)
// ---------------------------------------------------------------------------

/**
 * The `product_prices` review (plan 7.3; `SW` reviewPriceChangesInputSchema):
 * the products (the drawer's one, or the ids read's), the price as the vendor
 * chose it (leave → absent, "Use default" → null, a recipe as parsed), and
 * `releaseExactPrices` only as `true`. Checked by the shared schema before
 * it is sent: no change at all, a product twice, more than 10,000 or a
 * recipe off its contract throws a PriceCheckRequestError (never sent).
 */
export function productPricesReviewBody(input: {
  productIds: readonly number[];
  price: FieldChoice<PricingRecipe>;
  releaseExactPrices: boolean;
}): ProductPricesReviewInput {
  const parsed = reviewPriceChangesInputSchema.safeParse({
    kind: "product_prices",
    productIds: [...input.productIds],
    ...(input.price.mode === "leave" ? {} : { price: input.price.mode === "default" ? null : input.price.value }),
    ...(input.releaseExactPrices ? { releaseExactPrices: true } : {}),
  });
  if (parsed.success && parsed.data.kind === "product_prices") return parsed.data;
  throw new PriceCheckRequestError(REBUILD_MESSAGE, {
    reason: "review_off_contract", issues: parsed.success ? ["kind"] : issuePaths(parsed.error),
  });
}

/** The `product_prices` review as the contract takes it. */
export type ProductPricesReviewInput = Extract<ReviewPriceChangesInput, { kind: "product_prices" }>;

// ---------------------------------------------------------------------------
// The apply request (POST …/price-changes/apply) and its signature (D5)
// ---------------------------------------------------------------------------

/** The check the draft keeps from a review's answer, and why it replaced an earlier check. */
export function priceCheckRefOf(review: Pick<PriceChangeReviewResponse, "reviewId" | "reviewHash">, after: PriceCheckAfter | null = null): PriceCheckRef {
  return { reviewId: review.reviewId, reviewHash: review.reviewHash, after };
}

/**
 * The apply's signature: the review it saves. One review has one request
 * key, so "Check again" resends the very same apply; a new check is a new
 * signature and a new key (W1's rule, `pricingApplySignature`).
 */
export function priceCheckApplySignature(check: Pick<PriceCheckRef, "reviewId" | "reviewHash">): string {
  return JSON.stringify({ reviewId: check.reviewId, reviewHash: check.reviewHash });
}

/** The apply body for a signature and its key, checked against the apply's own schema. */
export function priceCheckApplyBody(signature: string, idempotencyKey: string): ApplyPriceChangesInput {
  let body: unknown;
  try {
    body = JSON.parse(signature);
  } catch (error) {
    throw new PriceCheckRequestError(REBUILD_MESSAGE, { reason: "signature_not_json", detail: error instanceof Error ? error.name : "unknown" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PriceCheckRequestError(REBUILD_MESSAGE, { reason: "signature_not_object" });
  }
  const parsed = applyPriceChangesInputSchema.safeParse({ ...body, idempotencyKey });
  if (parsed.success) return parsed.data;
  throw new PriceCheckRequestError(REBUILD_MESSAGE, { reason: "apply_off_contract", issues: issuePaths(parsed.error) });
}

// ---------------------------------------------------------------------------
// Pages (GET …/price-changes/reviews/:reviewId?page=)
// ---------------------------------------------------------------------------

/** The check's page size: 50 rows a page, 0 to 200 pages (the shared contract's). */
export const PRICE_CHECK_PAGE_SIZE = PRICING_REVIEW_PAGE_SIZE;
export const MAX_PRICE_CHECK_PAGE = MAX_PRICE_CHANGE_REVIEW_PAGE;

/** Whether `page` is one the contract takes (a whole number, 0 to 200). */
export function isPriceCheckPage(page: number): boolean {
  return Number.isSafeInteger(page) && page >= 0 && page <= MAX_PRICE_CHECK_PAGE;
}

/**
 * A page of the same check: the answer must match its contract and be the
 * very review shown (same id and hash), or it is refused with the page
 * words. The review's `kind` must be the one checked.
 */
export function checkPriceCheckPage(
  current: Pick<PriceCheckRef, "reviewId" | "reviewHash">,
  answer: unknown,
  kind: PriceChangeReviewKind = "product_prices",
): PriceChangeReviewResponse {
  const parsed = priceChangeReviewResponseSchema.safeParse(answer);
  if (!parsed.success) {
    throw new PriceCheckRequestError(CHECK_NEW_PRICES_WORDS.pageFailed, { reason: "page_off_contract", issues: issuePaths(parsed.error) });
  }
  if (parsed.data.reviewId !== current.reviewId || parsed.data.reviewHash !== current.reviewHash || parsed.data.kind !== kind) {
    throw new PriceCheckRequestError(CHECK_NEW_PRICES_WORDS.pageFailed, { reason: "page_other_review" });
  }
  return parsed.data;
}

/** "1–50 of 1,240"; null for a check with no sizes. */
export function priceCheckPageWords(review: Pick<PriceChangeReviewResponse, "page" | "summary">): string | null {
  return reviewPageWords(review, PRICE_CHECK_PAGE_SIZE);
}

export function hasPreviousPriceCheckPage(review: Pick<PriceChangeReviewResponse, "page">): boolean {
  return hasPreviousReviewPage(review);
}

export function hasNextPriceCheckPage(review: Pick<PriceChangeReviewResponse, "page" | "summary">): boolean {
  return hasNextReviewPage(review, PRICE_CHECK_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Rows (plan 7.4)
// ---------------------------------------------------------------------------

export type PriceCheckNoteKind = ReviewNoteKind | "released";
export interface PriceCheckNote {
  kind: PriceCheckNoteKind;
  text: string;
}

/** One size of the check as the vendor reads it: Size, Built from, Now, New, Note (M3's columns, W1's words). */
export interface PriceCheckRowModel {
  productVariantId: number;
  productId: number;
  /** The product's name, as the row's title. */
  title: string;
  /** "Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500" (`reviewSizeLine`). */
  size: string;
  builtFrom: string;
  /** The Now and New prices: the server's integer cents through `formatCents`, "—" for none. */
  now: string;
  next: string;
  notes: PriceCheckNote[];
  /** The apply would refuse the size: it would lose its price (7.4 "● Loses its price"). */
  refused: boolean;
  /** The apply releases the size's exact price (7.4 "Exact price cleared"). */
  released: boolean;
}

/**
 * Where a size's new price comes from (7.4, 12.2): by the row's `ruleLevel`,
 * then its `ruleName`; a kept exact price, a size on its retail price, or
 * why it can't be priced (W1's words). "from retail $12.50" / "from your
 * cost $2.10" follows the level the row's start is known for.
 */
export function priceCheckBuiltFrom(row: PriceChangeRow): string {
  const words = LISTING_SETTINGS_PRICE_CHECK_WORDS;
  if (row.preserved) return words.exactKept;
  if (row.priceCents === null) return reviewCannotPriceWords(row);
  if (row.followsStorePricing === true && row.ruleName === RETAIL_FALLBACK_RULE_NAME) {
    return row.retailFallbackIssue == null ? words.retailNoPrice : reviewRetailFallbackWords(row.retailFallbackIssue, row.priceCents);
  }
  const start = builtFromStartWords(row.basis, row.basisCents);
  const level = row.ruleLevel === "product" ? words.thisProductPrice
    : row.ruleLevel === "category" ? words.categoryPrice
      : row.ruleName === null || row.ruleName === STORE_DEFAULT_RULE_NAME ? words.storeDefault
        : olderGroupRuleWords(row.ruleName);
  return start === null ? level : `${level}, ${start}`;
}

/** The name `resolvePricingRule` gives the store default recipe (shared/dropship/pricing-rules.ts). */
const STORE_DEFAULT_RULE_NAME = "Store default rule";

/**
 * One row of the check (7.4). `refusedSizes`: sizes an apply named as losing
 * their price (422 WOULD_BE_LOST `sizes`), shown as the check's own refused
 * rows are.
 */
export function priceCheckRow(row: PriceChangeRow, refusedSizes: ReadonlySet<number> = NO_SIZES): PriceCheckRowModel {
  const refused = row.refusal !== null || refusedSizes.has(row.productVariantId);
  const notes: PriceCheckNote[] = [...reviewRowNotes(row)];
  if (refused && !notes.some((note) => note.kind === "loses_price")) notes.push({ kind: "loses_price", text: CHECK_NEW_PRICES_WORDS.losesPrice });
  if (row.released) notes.push({ kind: "released", text: LISTING_SETTINGS_PRICE_CHECK_WORDS.exactPriceCleared });
  return {
    productVariantId: row.productVariantId,
    productId: row.productId,
    title: row.title,
    size: reviewSizeLine(row),
    builtFrom: priceCheckBuiltFrom(row),
    now: reviewPriceWords(row.previousPriceCents),
    next: reviewPriceWords(row.priceCents),
    notes,
    refused,
    released: row.released,
  };
}

const NO_SIZES: ReadonlySet<number> = new Set();

/** The sizes a 422 WOULD_BE_LOST names (`context.sizes[].productVariantId`), for the rows; empty when the answer names none. */
export function refusedSizesOf(context: Readonly<Record<string, unknown>> | null | undefined): ReadonlySet<number> {
  const sizes = context?.sizes;
  if (!Array.isArray(sizes)) return NO_SIZES;
  const ids = sizes
    .map((size) => (size !== null && typeof size === "object" ? (size as { productVariantId?: unknown }).productVariantId : undefined))
    .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// Counts, the checked change, the stale line (plan 7.4, 7.5)
// ---------------------------------------------------------------------------

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** "1,240 sizes · 1,180 change · 36 lose their exact price · 3 would lose their price" (7.4). Zero parts are left out, except the sizes. */
export function priceCheckCountsWords(summary: PriceChangeReviewResponse["summary"]): string {
  const parts = [`${COUNT_FORMAT.format(summary.total)} ${summary.total === 1 ? "size" : "sizes"}`];
  parts.push(summary.changed === 0 ? "no price changes" : `${COUNT_FORMAT.format(summary.changed)} change`);
  if (summary.released > 0) parts.push(loseExactPriceWords(summary.released));
  if (summary.refused > 0) parts.push(wouldLosePriceCountWords(summary.refused));
  return parts.join(" · ");
}

/**
 * What the check is of, in the vendor's words: "Retail price + 20%, round up
 * to .99" or "Use default", then "Clear exact prices too" when the release is
 * on. Empty for no change.
 */
export function priceCheckChangeWords(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">): string[] {
  const words: string[] = [];
  if (change.price.mode === "set") words.push(recipeWords(change.price.value));
  else if (change.price.mode === "default") words.push(LISTING_SETTINGS_EDIT_WORDS.useDefault);
  if (change.releaseExactPrices) words.push(LISTING_SETTINGS_PRICE_CHECK_WORDS.clearExactPricesShort);
  return words;
}

/** "→ Retail price + 20%, round up to .99 · Clear exact prices too · Not saved": the price's pending line; null with no change. */
export function pendingPriceWords(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">): string | null {
  const words = priceCheckChangeWords(change);
  return words.length === 0 ? null : pendingSettingWords(words.join(" · "));
}

/** The line shown once over a check that replaced an earlier one (7.5): R:683's for moved prices, else why. */
export function priceCheckAfterWords(after: PriceCheckAfter | null): string | null {
  switch (after) {
    case "prices_moved":
      return CHECK_NEW_PRICES_WORDS.stale;
    case "already_applied":
      return LISTING_SETTINGS_PRICE_CHECK_WORDS.alreadySaved;
    case "expired":
    case "page_expired":
      return LISTING_SETTINGS_PRICE_CHECK_WORDS.expired;
    case null:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The check's footer (plan 7.4, 7.6)
// ---------------------------------------------------------------------------

export interface PriceCheckFooterInput {
  /** The owner's draft phase: a save in flight, unconfirmed, refused…; null before any apply. */
  phase: SavePhase | null;
  /** The check's counts; null while its rows are read again for a reopened owner (D21): Save waits for them, Check again does not. */
  summary: PriceChangeReviewResponse["summary"] | null;
  /** What was checked. */
  change: Pick<ProductPriceChange, "price" | "releaseExactPrices">;
  /** Another listing action is running, so the page holds saves back. */
  busy: boolean;
  /** A page of the check is loading. */
  paging: boolean;
  /** The last failed apply's words, shown as an alert while the draft is refused, busy or rate limited. */
  message?: string | null;
  /** The last failed apply's code (the draft's): a refusal keeps Save off, since the same check would be refused again. */
  code?: string | null;
}

export interface PriceCheckFooter extends CheckNewPricesFooter {
  /** Lines under the buttons: why Save is off, what saving does, a failed apply's words. */
  lines: Array<{ text: string; tone: "alert" | "status" }>;
}

/**
 * The check's buttons and lines (7.4, UX-M2):
 * - sizes would lose their price (`refused` > 0): Save off; with a recipe,
 *   W1's "… can't be priced this way …" naming the other start; with Use
 *   default or a release alone, "● N sizes would be left without a price …";
 *   under it the one-draft line (an exact price is another draft, D16);
 * - no rows (P35): "No chosen sizes to check."; Save on when a price is sent
 *   (it still sets the products' price), off for a release alone;
 * - rows but no price moves while a price is sent: "No prices change now.
 *   Saving still sets the price."; Save on;
 * - a release alone with nothing to clear: "No exact prices to clear."; Save off;
 * - the rows not read yet (a reopened owner, D21): Save off until they are;
 *   Check again needs only the draft's review id and hash, so it stays on;
 * - the apply refused (plan 7.5, CLAUDE.md §6): the same check would be
 *   refused again, so Save stays off with the words (Back to editing, then a
 *   new check, is the way on); only a sign-in (401) can be saved again.
 * Back is off while a save is in flight only (plan 7.6): while it is
 * unconfirmed, Back closes the owner and keeps the locked draft (D21), so
 * reopening shows Check again. W1's own footer keeps Back off then (UX-m6).
 */
export function priceCheckFooter(input: PriceCheckFooterInput): PriceCheckFooter {
  const { summary, change } = input;
  const base = checkNewPricesFooter({ phase: input.phase, blocked: summary?.refused ?? 0, busy: input.busy, paging: input.paging });
  const lines: PriceCheckFooter["lines"] = [];
  let saveOff = false;
  const sendsPrice = change.price.mode !== "leave";
  if (summary === null) {
    saveOff = true;
  } else if (summary.refused > 0) {
    lines.push({
      text: change.price.mode === "set"
        ? reviewBlockedWords(summary.refused, change.price.value.basis) ?? wouldBeLeftWithoutPriceWords(summary.refused)
        : wouldBeLeftWithoutPriceWords(summary.refused),
      tone: "alert",
    });
    lines.push({ text: LISTING_SETTINGS_PRICE_CHECK_WORDS.oneDraft, tone: "status" });
    saveOff = true;
  } else if (summary.total === 0) {
    lines.push({ text: LISTING_SETTINGS_PRICE_CHECK_WORDS.noSizes, tone: "status" });
    saveOff = !sendsPrice;
  } else if (!sendsPrice && change.releaseExactPrices && summary.released === 0) {
    lines.push({ text: LISTING_SETTINGS_PRICE_CHECK_WORDS.nothingToClear, tone: "status" });
    saveOff = true;
  } else if (sendsPrice && summary.changed === 0) {
    lines.push({ text: LISTING_SETTINGS_PRICE_CHECK_WORDS.noPriceChanges, tone: "status" });
  }
  if (input.message && FAILURE_PHASES.has(input.phase)) lines.push({ text: input.message, tone: "alert" });
  if (input.phase === "refused" && input.code !== SIGN_IN_CODE) saveOff = true;
  const primary = base.primary.action === "save" && saveOff ? { ...base.primary, disabled: true } : base.primary;
  return { primary, backDisabled: input.phase === "saving", lines };
}

/** Phases whose words are a failed apply's (the check body says them; an unconfirmed one shows beside Check again). */
const FAILURE_PHASES: ReadonlySet<SavePhase | null> = new Set<SavePhase | null>([
  "uncertain", "unreachable", "conflict", "refused", "rate_limited", "reload_required", "blocked",
]);

/** The one refusal a Save of the same check can clear: the vendor signs in again (plan 3.3 row 2). */
const SIGN_IN_CODE = "DROPSHIP_AUTH_REQUIRED";

// ---------------------------------------------------------------------------
// After a refused apply (plan 7.5, 9.4; CC-C3, CC-C8, CC-C11)
// ---------------------------------------------------------------------------

/** What an apply's refusal means for its owner. */
export type ApplyRefusalDecision = "recheck" | "conflict" | "refused";

/** Codes after which a new check, once, is the answer (7.5): the drawer first runs its D6a guard. */
const RECHECK_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_PRICES_MOVED", "DROPSHIP_IDEMPOTENCY_CONFLICT", "DROPSHIP_PRICING_REVIEW_NOT_FOUND",
  // A release's W9 refusal, rolled back with the rest (CC-C11): the sizes moved under the apply.
  "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE",
]);
/** The category kind's version conflicts (9.4): the editor re-reads the category and its products (PR 10f). */
const CATEGORY_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
]);
const WOULD_BE_LOST_CODE = "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST";

/**
 * After an apply the server refused (7.5, 9.4; one table-driven test per
 * row, CC-C3):
 * - `recheck`: a new check, once, with the stale line: prices moved (409),
 *   the check already applied under another key (409 IDEMPOTENCY_CONFLICT,
 *   CC-C8), no such check (404), or a release's W9 refusal rolled back
 *   (CC-C11); the drawer runs its D6a guard first. 422 WOULD_BE_LOST too,
 *   when it names no `sizeCount`: a release's W9 refusal of one size;
 * - `conflict`: the category kind's version conflicts only (9.4; PR 10f);
 * - `refused`: shown, with the row's words: WOULD_BE_LOST with `sizeCount`
 *   (the sizes the check named), every limit, and anything else.
 * The second refusal of a re-check is shown, never looped: the runner asks
 * only for a first check (`MAX_PRICE_CHECK_ATTEMPTS`).
 */
export function decideAfterApplyRefusal(
  kind: PriceChangeReviewKind,
  code: string | null,
  context: Readonly<Record<string, unknown>> | null = null,
): ApplyRefusalDecision {
  if (code === null) return "refused";
  if (kind === "category_price" && CATEGORY_CONFLICT_CODES.has(code)) return "conflict";
  if (RECHECK_CODES.has(code)) return "recheck";
  if (code === WOULD_BE_LOST_CODE) {
    const sizeCount = context?.sizeCount;
    return typeof sizeCount === "number" && Number.isSafeInteger(sizeCount) && sizeCount > 0 ? "refused" : "recheck";
  }
  return "refused";
}

/** Why the new check replaced the refused one, for its stale line (`priceCheckAfterWords`). */
export function priceCheckAfterOf(code: string | null): PriceCheckAfter {
  if (code === "DROPSHIP_IDEMPOTENCY_CONFLICT") return "already_applied";
  if (code === "DROPSHIP_PRICING_REVIEW_NOT_FOUND") return "expired";
  return "prices_moved";
}

// ---------------------------------------------------------------------------
// The price editor (plan 7.2 `ProductPriceEditor`; the drawer's PRICE head and the "Set for selected" Price row)
// ---------------------------------------------------------------------------

/** The editor's local state: "Use default" or a recipe as typed (W1's fields), and "Clear exact prices too". */
export interface ProductPriceEditorState {
  mode: "default" | "set";
  fields: PriceRecipeDraft;
  releaseExactPrices: boolean;
}

export interface ProductPriceEditorModel {
  /** A recipe can be typed, "Use default" chosen; both W7's right (D3). */
  canSet: boolean;
  canDefault: boolean;
  /** Why not, in the row's terms; null when everything can be chosen. */
  reason: ListingSettingsRightReason | null;
  /**
   * Where the editor opens: the draft's change, else the product's own price
   * (a recipe, or "Use default" with the store price's fields to start from),
   * else "Use default" with the suggestion "Retail price + 0%, to the cent"
   * (R:205; `SUGGESTED_PRICING_RECIPE`). For many products (no own price) the
   * same, so the fields always hold a recipe to start from.
   */
  initial: ProductPriceEditorState;
  /** The fields show the store price or the suggestion, not a price of the product's: "Suggested · not saved" (R:205). */
  suggestion: boolean;
}

/**
 * The editor's model (7.2): what can be chosen (W7's right), where it opens
 * (the draft's change first), and whether the fields are only a suggestion.
 * `storeRecipe`: the store price from the summary, for the fields under "Use
 * default"; null while none is set.
 */
export function productPriceEditorModel(input: {
  rights: Pick<ProductFieldRights, "canSet" | "canDefault" | "reason">;
  change: Pick<ProductPriceChange, "price" | "releaseExactPrices">;
  ownPrice: PricingRecipe | null;
  storeRecipe: PricingRecipe | null;
}): ProductPriceEditorModel {
  const { change } = input;
  const fallback = input.storeRecipe ?? SUGGESTED_PRICING_RECIPE;
  let initial: ProductPriceEditorState;
  let suggestion = false;
  if (change.price.mode === "set") {
    initial = { mode: "set", fields: priceRecipeDraft(change.price.value), releaseExactPrices: change.releaseExactPrices };
  } else if (change.price.mode === "default") {
    initial = { mode: "default", fields: priceRecipeDraft(fallback), releaseExactPrices: change.releaseExactPrices };
    suggestion = true;
  } else if (input.ownPrice !== null) {
    initial = { mode: "set", fields: priceRecipeDraft(input.ownPrice), releaseExactPrices: change.releaseExactPrices };
  } else {
    initial = { mode: "default", fields: priceRecipeDraft(fallback), releaseExactPrices: change.releaseExactPrices };
    suggestion = true;
  }
  return { canSet: input.rights.canSet, canDefault: input.rights.canDefault, reason: input.rights.reason, initial, suggestion };
}

export type ProductPriceEditorResult =
  /** The change to put in the draft and check (`productPriceEditAction`, then the check runner). */
  | { ok: true; change: Pick<ProductPriceChange, "price" | "releaseExactPrices"> }
  /** A field the parsers refuse (W1's words), or a choice the rights don't allow (`errors` empty: the button is just off). */
  | { ok: false; errors: Partial<Record<"percent" | "flat", string>> };

/**
 * [Check new prices] in the editor: the state as a change, the recipe parsed
 * with the integer parsers (D1; every field error at once), "Use default" as
 * the default, the release as ticked. Nothing is computed from it here.
 */
export function productPriceEditorResult(
  model: Pick<ProductPriceEditorModel, "canSet" | "canDefault">,
  state: ProductPriceEditorState,
): ProductPriceEditorResult {
  if (state.mode === "default") {
    return model.canDefault ? { ok: true, change: { price: { mode: "default" }, releaseExactPrices: state.releaseExactPrices } } : { ok: false, errors: {} };
  }
  if (!model.canSet) return { ok: false, errors: {} };
  const recipe = recipeFromDraft(state.fields);
  if (!recipe.ok) return { ok: false, errors: recipe.errors };
  return { ok: true, change: { price: { mode: "set", value: recipe.recipe }, releaseExactPrices: state.releaseExactPrices } };
}

/** The editor's words: the button, the tick box, "Use default" and the suggestion tag (W1's and this part's). */
export const PRODUCT_PRICE_EDITOR_WORDS = Object.freeze({
  change: LISTING_SETTINGS_PRICE_CHECK_WORDS.changePrice,
  useDefault: LISTING_SETTINGS_EDIT_WORDS.useDefault,
  setPrice: PRICE_DEFAULT_WORDS.setPrice,
  clearExactPrices: LISTING_SETTINGS_PRICE_CHECK_WORDS.clearExactPrices,
  checkNewPrices: PRICE_DEFAULT_WORDS.checkNewPrices,
  checking: PRICE_DEFAULT_WORDS.checking,
  suggested: PRICE_DEFAULT_WORDS.suggested,
} as const);

// ---------------------------------------------------------------------------
// The check inside its owner (D16, D20, D21)
// ---------------------------------------------------------------------------

/** The check body its owner shows in place of its own (D20), and the draft phase it is in. */
export interface PriceCheckShown {
  check: PriceCheckRef;
  phase: SavePhase;
  /** The draft's words, for the footer. */
  message: string | null;
  /** The draft's last failure code, for the footer (a refused apply keeps Save off). */
  code: string | null;
  /** The owner's draft is locked (a save out or unconfirmed): Back closes the owner and keeps it (D21). */
  locked: boolean;
}

/**
 * Whether the owner shows the check: its draft holds a price change with a
 * check (made, or kept from before Back, D21). A saved check has no body any
 * more (the owner's views are read again). Null shows the owner's own body.
 */
export function priceCheckShown(draft: Pick<ListingSettingsDraft, "phase" | "message" | "code"> | null, change: ProductPriceChange | null): PriceCheckShown | null {
  if (draft === null || change === null || change.check === null) return null;
  if (draft.phase === "saved" || draft.phase === "saved_view_stale") return null;
  return { check: change.check, phase: draft.phase, message: draft.message, code: draft.code, locked: isDraftLocked(draft) };
}

/** What "Back to editing" does (D20, D21). */
export type PriceCheckBack =
  /** Back to the owner's body: the check is dropped from the draft (send `change` to the owner's edit), the change stays. */
  | { kind: "edit"; change: ProductPriceChange }
  /** The draft is locked (a save out or unconfirmed): the owner closes and keeps it; reopening shows Check again. */
  | { kind: "close" }
  /** Nothing to go back from. */
  | { kind: "none" };

export function priceCheckBack(draft: Pick<ListingSettingsDraft, "phase" | "changes"> | null, change: ProductPriceChange | null): PriceCheckBack {
  if (draft === null || change === null || change.check === null) return { kind: "none" };
  if (isDraftLocked(draft)) return { kind: "close" };
  if (!isDraftDirty(draft) && !isProductPriceChanged(change)) return { kind: "none" };
  return { kind: "edit", change: { ...change, check: null } };
}

/** [Change price] beside the drawer's PRICE head (plan 7.2): whether it is off, and why, in the rows' terms. */
export interface ChangePriceButton {
  disabled: boolean;
  /** A right's reason (D3), "Checking…" while the own read loads, "Save or discard your other change first." (D2); null for nothing. */
  line: string | null;
}

/**
 * [Change price] as the drawer's setting rows decide their [Change] (D2, D3,
 * plan 3.4): off without W7's right (its reason), until the own read answers
 * ("Checking…"; a failed read is said once by the drawer), while a size's
 * price or the settings hold a change (the one-change line), and while the
 * price draft is locked or a check runs.
 */
export function changePriceButton(input: {
  /** The product's own read: loading, failed, or answered. */
  own: "loading" | "failed" | "ready";
  /** W7's right. */
  right: ListingSettingsRight;
  /** A size's price or the product's settings hold a change, or a save of them is out or unconfirmed (D2). */
  otherHoldsChange: boolean;
  /** The price draft is locked, or a check runs. */
  waiting: boolean;
}): ChangePriceButton {
  const disabled = input.own !== "ready" || !input.right.editable || input.otherHoldsChange || input.waiting;
  const line = !input.right.editable ? rightReasonLine(input.right.reason)
    : input.own === "loading" ? rightReasonLine("loading")
      : input.otherHoldsChange ? LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst
        : null;
  return { disabled, line };
}
