import {
  LISTING_SETTINGS_PAGE_SIZE,
  type ListingSettingsSummary,
  type ListingSettingsUpdatedProductsResponse,
} from "@shared/dropship/listing-settings";
import { categoryMovesAcknowledgeItemsSchema, type CategoryMovesAcknowledgeItems } from "@shared/dropship/listing-setting-values";
import {
  acknowledgeCategoryMovesInputSchema,
  type AcknowledgeCategoryMovesInput,
  type AcknowledgeCategoryMovesResponse,
} from "@shared/dropship/listing-setting-writes";
import { DropshipApiError } from "./dropship-ops-surface";
import { listingSettingsUpdatedProductsQueryOptions } from "./dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "./dropship-listing-settings-access";
import type { AttentionAction } from "./dropship-listing-settings-attention";
import {
  isDraftLocked,
  isSavedFlashVisible,
  LISTING_SETTINGS_SAVE_WORDS,
  UPDATED_PRODUCTS_EDITOR_ID,
  type DraftValue,
  type ListingSettingsDraft,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import {
  changedCategorySettingsWords,
  checkOwnTextLabel,
  gotItForAllWords,
  gotItLabel,
  LISTING_SETTINGS_EDIT_WORDS,
  LISTING_SETTINGS_UPDATED_WORDS,
  movedAgainWords,
  movedFromToWords,
  rightReasonLine,
  UNNAMED_PRODUCT_WORDS,
  updatedProductsLineWords,
} from "./dropship-listing-settings-words";

/**
 * "Card Shellz updated products" (Listing settings PR 10g, plan 10.1-10.3):
 * the read of the products Card Shellz moved to another category, or changed
 * under the vendor's own text; the words of each row; the "Got it" request
 * for one product or for all of them (W13); the line under the attention
 * strip; and the sheet's state.
 *
 * Rules this module keeps:
 * - every "Got it" item is the server's: a row's `move.to.categoryId`, or
 *   `moves.items` as given for "Got it for all N" (D6; plan 10.2);
 * - the words never say "Nothing changes": `changedFields` compares category
 *   settings only (UX-M6), and category names follow CC-C21;
 * - what moved again comes from the answer, never from the re-read (10.3);
 * - the draft holds the request being sent and no change (D16).
 *
 * Pure: no React, no network, no clock. Every time is passed in.
 */

export type UpdatedProductsView = ListingSettingsUpdatedProductsResponse;
export type UpdatedProductRow = UpdatedProductsView["rows"][number];
export type UpdatedProductCategory = NonNullable<UpdatedProductRow["move"]>["to"];
/** One product to "Got it" for: the Card Shellz category the vendor was shown (null = none), sent back as it is. */
export type UpdatedProductMoveItem = CategoryMovesAcknowledgeItems[number];

/** The page size the server uses (50): the sheet's pages, and "Load more" on a phone (10.3). */
export const UPDATED_PRODUCTS_PAGE_SIZE = LISTING_SETTINGS_PAGE_SIZE;

// ---------------------------------------------------------------------------
// The read (plan 10.2, D10, D18)
// ---------------------------------------------------------------------------

/** What the read needs from the summary: whether the selection is too large to check. */
export type UpdatedProductsSummaryFacts = ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog">>;

/**
 * Whether the updated-products read may run (D18): only while the summary's
 * catalog state is not `too_large`. While the summary is still loading it
 * runs; a 422 from it then goes to the banner through `onTooLarge`.
 */
export function updatedProductsReadEnabled(summary: UpdatedProductsSummaryFacts): boolean {
  return summary.data?.catalog.state !== "too_large";
}

/** The line's read: page 0, a list read (at most 60 seconds old), off while the selection is too large. */
export function updatedProductsLineQueryOptions(storeConnectionId: number, summary: UpdatedProductsSummaryFacts) {
  return listingSettingsUpdatedProductsQueryOptions(storeConnectionId, 0, { enabled: updatedProductsReadEnabled(summary) });
}

/**
 * The open sheet's read of one page: fresh each time (staleTime 0), because
 * its "Got it" items come from this answer (D6); off while the sheet is
 * closed or the selection is too large.
 */
export function updatedProductsSheetQueryOptions(
  storeConnectionId: number,
  page: number,
  summary: UpdatedProductsSummaryFacts,
  open: boolean,
) {
  return listingSettingsUpdatedProductsQueryOptions(storeConnectionId, page, { enabled: open && updatedProductsReadEnabled(summary), fresh: true });
}

// ---------------------------------------------------------------------------
// The rows (plan 10.3)
// ---------------------------------------------------------------------------

/** A row's product name, or the words for one the answer gives no name for (as the attention strip says it). */
function productNameOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed : UNNAMED_PRODUCT_WORDS;
}

/**
 * A category's name in a row (CC-C21): no category reads "no category"; a
 * category Card Shellz has since deleted keeps its id but has no name, so it
 * reads "a category Card Shellz removed"; otherwise its current name.
 */
export function updatedCategoryName(category: UpdatedProductCategory): string {
  if (category.categoryId === null) return LISTING_SETTINGS_UPDATED_WORDS.noCategory;
  if (category.name === null) return LISTING_SETTINGS_UPDATED_WORDS.removedCategory;
  return category.name;
}

/** The "Got it" request before its key: the items W13 takes (plan 10.2). */
export interface GotItBody {
  items: readonly UpdatedProductMoveItem[];
}

/**
 * [Got it] for one row: the product with the category the vendor is shown now
 * (`move.to.categoryId`, null for no category), as W13's item (plan 10.2). A
 * row without a move has nothing to "Got it" for: a programming fault.
 */
export function gotItBody(row: Pick<UpdatedProductRow, "productId" | "move">): GotItBody {
  if (row.move === null) throw new Error("Only a moved product can be acknowledged.");
  return { items: [{ productId: row.productId, shownCategoryId: row.move.to.categoryId }] };
}

/**
 * [Got it for all N]: every moved product, on every page, as the read lists
 * them in `moves.items`, sent back unchanged (plan 10.2; `SR` "Got it for all
 * N sends it to W13 as it is").
 */
export function gotItAllBody(view: Pick<UpdatedProductsView, "moves">): GotItBody {
  return { items: view.moves.items };
}

/** The drawer row an own-text [Check] lands on and opens (10b's landing request, plan 5.2). */
const DESCRIPTION_ROW = "descriptionTemplate" as const;

/**
 * An own-text row's [Check] (plan 10.3, D20): it closes the sheet and opens
 * the drawer on its Description row, through the same action the attention
 * strip's [Fix] uses for a description conflict.
 */
export function ownTextCheckAction(row: Pick<UpdatedProductRow, "productId">): Extract<AttentionAction, { kind: "open_product" }> {
  return {
    kind: "open_product",
    label: LISTING_SETTINGS_UPDATED_WORDS.check,
    productId: row.productId,
    fix: "own_text_needs_check",
    row: DESCRIPTION_ROW,
  };
}

export interface UpdatedProductMoveModel {
  /** "Moved from Sleeves to Toploaders." */
  text: string;
  /** "Category settings that differ: price, shipping policy." or "No category setting changes for it." */
  changes: string;
  gotIt: { label: string; ariaLabel: string; body: GotItBody };
}

export interface UpdatedProductOwnTextModel {
  /** "Card Shellz changed this product. Check your text still fits." */
  text: string;
  check: { label: string; ariaLabel: string; action: Extract<AttentionAction, { kind: "open_product" }> };
}

export interface UpdatedProductRowModel {
  /** Stable among the rows shown: the product. */
  key: string;
  productId: number;
  productName: string;
  /** The move Card Shellz made, with its [Got it]; null for a row listed for its own text only. */
  move: UpdatedProductMoveModel | null;
  /** The own-text check, with its [Check]; null when the product's text needs none. */
  ownText: UpdatedProductOwnTextModel | null;
}

/** One row's words and buttons (plan 10.3). The server lists a row only when it has a move, a text check, or both. */
export function updatedProductRow(row: UpdatedProductRow): UpdatedProductRowModel {
  const productName = productNameOf(row.productName);
  return {
    key: `product:${row.productId}`,
    productId: row.productId,
    productName,
    move: row.move === null ? null : {
      text: movedFromToWords(updatedCategoryName(row.move.from), updatedCategoryName(row.move.to)),
      // In the stored shape's order, as the server gives it: never re-sorted here.
      changes: changedCategorySettingsWords(row.move.changedFields),
      gotIt: { label: LISTING_SETTINGS_UPDATED_WORDS.gotIt, ariaLabel: gotItLabel(productName), body: gotItBody(row) },
    },
    ownText: row.ownTextNeedsCheck ? {
      text: LISTING_SETTINGS_EDIT_WORDS.ownTextCheck,
      check: { label: LISTING_SETTINGS_UPDATED_WORDS.check, ariaLabel: checkOwnTextLabel(productName), action: ownTextCheckAction(row) },
    } : null,
  };
}

export function updatedProductRows(view: Pick<UpdatedProductsView, "rows">): UpdatedProductRowModel[] {
  return view.rows.map(updatedProductRow);
}

/**
 * The rows of several pages shown together (a phone's "Load more"), each
 * product once: while the pages are read again after a "Got it", one page's
 * new answer sits beside another's old one, and a product that moved up a
 * page would be listed twice. The first row for a product wins.
 */
export function uniqueUpdatedProductRows(pages: readonly (readonly UpdatedProductRowModel[])[]): UpdatedProductRowModel[] {
  const seen = new Set<number>();
  const rows: UpdatedProductRowModel[] = [];
  for (const page of pages) {
    for (const row of page) {
      if (seen.has(row.productId)) continue;
      seen.add(row.productId);
      rows.push(row);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The request (plan 10.2, 10.4, D5)
// ---------------------------------------------------------------------------

/**
 * The sheet's draft value (D16): the items of the "Got it" being sent, as
 * base and value alike, so the draft holds no change and a Check again
 * rebuilds exactly the same request from it after Back (D21).
 */
export type UpdatedProductsDraftValue = { items: readonly UpdatedProductMoveItem[] };

export function updatedProductsDraftValue(body: GotItBody): UpdatedProductsDraftValue {
  return Object.freeze({ items: Object.freeze(body.items.map((item) => ({ productId: item.productId, shownCategoryId: item.shownCategoryId }))) });
}

/** The sheet's draft value, or null when `value` is not one (another editor's draft, or items the contract refuses). */
export function readUpdatedProductsDraft(value: DraftValue): UpdatedProductsDraftValue | null {
  const parsed = categoryMovesAcknowledgeItemsSchema.safeParse(value.items);
  return parsed.success ? { items: parsed.data } : null;
}

/** Whether the step's one draft is a "Got it" (sent, unconfirmed, or just confirmed). */
export function isUpdatedProductsDraft(draft: Pick<ListingSettingsDraft, "editor"> | null): boolean {
  return draft !== null && draft.editor === UPDATED_PRODUCTS_EDITOR_ID;
}

/**
 * The held "Got it" a press for `items` sends again with its kept key (D5;
 * plan 3.3 "key kept"): the step's draft is a "Got it" for the same items
 * that was rate limited or never reached the server. Null when the press is
 * a new request, which opens the editor afresh and gets a new key; a "Got
 * it" out or unconfirmed is never pressed again from a row (its own button
 * checks it).
 */
export function heldGotItFor(
  draft: ListingSettingsDraft | null,
  storeConnectionId: number,
  items: readonly UpdatedProductMoveItem[],
): ListingSettingsDraft | null {
  if (draft === null || !isUpdatedProductsDraft(draft) || draft.attempt === null) return null;
  if (draft.phase !== "rate_limited" && draft.phase !== "unreachable") return null;
  return draft.attempt.signature === gotItSignature(storeConnectionId, items) ? draft : null;
}

/**
 * What a "Got it" sends, as the draft's attempt signature (D5): the same
 * products with the same shown categories, in any order, reuse the key.
 * The order doesn't matter to the server either: it sorts the items before
 * it hashes them (`S/application/dropship-listing-category-moves-service.ts`).
 */
export function gotItSignature(storeConnectionId: number, items: readonly UpdatedProductMoveItem[]): string {
  const sorted = [...items]
    .map((item) => ({ productId: item.productId, shownCategoryId: item.shownCategoryId }))
    .sort((left, right) => left.productId - right.productId);
  return JSON.stringify({ v: 1, writer: "W13", storeConnectionId, items: sorted });
}

/** A "Got it" this page could not build; it was never sent. */
export const UPDATED_PRODUCTS_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_UPDATED_PRODUCTS_REQUEST_INVALID";

export class UpdatedProductsRequestError extends Error {
  readonly code = UPDATED_PRODUCTS_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "UpdatedProductsRequestError";
    this.context = Object.freeze({ ...context });
  }
}

/** The W13 request, checked against the shared input schema before it is sent (plan 3.2; key shape `SV`). */
export function acknowledgeBody(input: { key: string; items: readonly UpdatedProductMoveItem[] }): AcknowledgeCategoryMovesInput {
  const parsed = acknowledgeCategoryMovesInputSchema.safeParse({
    idempotencyKey: input.key,
    items: input.items.map((item) => ({ productId: item.productId, shownCategoryId: item.shownCategoryId })),
  });
  if (parsed.success) return parsed.data;
  throw new UpdatedProductsRequestError("This can't be sent as it is. Reload the page and try again.", {
    itemCount: input.items.length,
    issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

// ---------------------------------------------------------------------------
// After a "Got it" (plan 10.3)
// ---------------------------------------------------------------------------

export interface GotItOutcomeWords {
  /** "Done." */
  done: string;
  /** "2 products moved again. Check them below. It can take a minute to update.", or null when none did. */
  movedAgain: string | null;
}

/**
 * The words after a confirmed "Got it", from the answer (plan 10.3, 10.6):
 * what moved again is counted from `movedAgainProductIds`, never from the
 * re-read, which can show the same list for up to a minute. A replay (the
 * first send did it) and an answer the page couldn't read (null) say only
 * "Done.": the re-read shows what stands.
 */
export function gotItOutcomeWords(answer: AcknowledgeCategoryMovesResponse | null): GotItOutcomeWords {
  const movedAgain = answer === null ? 0 : answer.movedAgainProductIds.length;
  return { done: LISTING_SETTINGS_UPDATED_WORDS.done, movedAgain: movedAgain > 0 ? movedAgainWords(movedAgain) : null };
}

// ---------------------------------------------------------------------------
// The line under the attention strip (plan 10.2, UX-M9, UX-M10)
// ---------------------------------------------------------------------------

export interface UpdatedProductsLine {
  /** "Card Shellz moved 4 products to another category." */
  text: string;
  /** [Review] */
  label: string;
}

/**
 * The line under the attention strip, from page 0's read: shown only when
 * the answer counts a move; a read still loading, failed, refused or too
 * large shows nothing and no banner (the lists' banner covers too large).
 * The latest attempt wins: an older answer a failed refetch replaced is not
 * shown as current, and neither is one read before the summary said the
 * selection is too large (the read is off then, D18, but its last answer
 * stays cached).
 */
export function updatedProductsLine(
  read: ListingSettingsReadState<Pick<UpdatedProductsView, "moves">>,
  summary: UpdatedProductsSummaryFacts,
): UpdatedProductsLine | null {
  if (!updatedProductsReadEnabled(summary)) return null;
  if (read.error !== undefined && read.error !== null) return null;
  const total = read.data?.moves.total ?? 0;
  if (total === 0) return null;
  return { text: updatedProductsLineWords(total), label: LISTING_SETTINGS_UPDATED_WORDS.review };
}

// ---------------------------------------------------------------------------
// The sheet (plan 10.3, 3.7)
// ---------------------------------------------------------------------------

export interface UpdatedProductsPaging {
  page: number;
  pageCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** "1–50 of 120"; null with no rows. */
  text: string | null;
  /** The phone's [Load more] (10.3). */
  loadMoreLabel: string;
}

const COUNT = new Intl.NumberFormat("en-US");

/** The page's place among the rows, 50 a page. */
export function updatedProductsPaging(view: Pick<UpdatedProductsView, "page" | "total">): UpdatedProductsPaging {
  const pageCount = Math.max(1, Math.ceil(view.total / UPDATED_PRODUCTS_PAGE_SIZE));
  const first = view.page * UPDATED_PRODUCTS_PAGE_SIZE + 1;
  const last = Math.min(view.total, (view.page + 1) * UPDATED_PRODUCTS_PAGE_SIZE);
  return {
    page: view.page,
    pageCount,
    hasPrevious: view.page > 0,
    hasNext: last < view.total,
    text: view.total === 0 || first > view.total ? null : `${COUNT.format(first)}–${COUNT.format(last)} of ${COUNT.format(view.total)}`,
    loadMoreLabel: LISTING_SETTINGS_UPDATED_WORDS.loadMore,
  };
}

export interface UpdatedProductsSheetInput {
  /** The open page's read, as React Query holds it. */
  read: ListingSettingsReadState<UpdatedProductsView>;
  /** The step's one draft. */
  draft: ListingSettingsDraft | null;
  /** W13's right (`rights.categoryMoves`). */
  right: ListingSettingsRight;
  /** Any save on the page still in flight (the page's pending-save counter). */
  busy: boolean;
  nowMs: number;
  /** The last confirmed "Got it"'s answer, kept by the sheet until the next one (null before any, or when the answer couldn't be read). */
  lastAnswer: AcknowledgeCategoryMovesResponse | null;
  /** Whether a "Got it" was confirmed since the sheet opened (the "Done." line stays with its moved-again line). */
  lastDone: boolean;
}

export type UpdatedProductsReadProblem =
  | { kind: "failed"; text: string; retryLabel: string }
  | { kind: "rate_limited"; text: string; retryLabel: string };

export interface UpdatedProductsStatusLine {
  text: string;
  tone: "ok" | "info" | "alert";
}

export interface UpdatedProductsSheetState {
  title: string;
  read: "loading" | "failed" | "answered";
  loadingLine: string | null;
  problem: UpdatedProductsReadProblem | null;
  rows: UpdatedProductRowModel[];
  /** "Nothing here. …", when the page answered with no row. */
  empty: string | null;
  paging: UpdatedProductsPaging | null;
  /** Every [Got it] and [Got it for all N] is off: a save is out or unconfirmed, another action runs, or the right is gone. */
  buttonsDisabled: boolean;
  /** Why the buttons are off, when the banner doesn't say (the right's own line); null otherwise. */
  reason: string | null;
  gotItAll: { label: string; shown: boolean; disabled: boolean; body: GotItBody | null };
  /** The lines under the rows: saving, done and moved again, a failed save's words, Check again. */
  lines: UpdatedProductsStatusLine[];
  /** [Check again] resends the unconfirmed "Got it" with the same key. */
  checkAgain: { label: string; shown: boolean };
  /** [Reload] after a confirmed "Got it" whose re-read failed. */
  reload: { label: string; shown: boolean };
  /** Esc keeps the sheet open: a "Got it" is out or unconfirmed (plan 3.4). */
  escapeKeepsOpen: boolean;
}

/** The read's state, the latest attempt winning (as the lists do). */
function readState(read: ListingSettingsReadState<UpdatedProductsView>): { state: "loading" } | { state: "failed"; problem: UpdatedProductsReadProblem } | { state: "answered"; view: UpdatedProductsView } {
  if (read.error !== undefined && read.error !== null) {
    const rateLimited = read.error instanceof DropshipApiError && read.error.status === 429;
    return rateLimited
      ? { state: "failed", problem: { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain } }
      : { state: "failed", problem: { kind: "failed", text: LISTING_SETTINGS_UPDATED_WORDS.readFailed, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain } };
  }
  if (read.data !== undefined) return { state: "answered", view: read.data };
  return { state: "loading" };
}

/**
 * The sheet from its page read, the step's draft and W13's right (plan 3.7).
 * The draft is the sheet's only while it is a "Got it" (`updatedProducts`);
 * another editor's draft locks nothing here but the page's pending-save
 * counter (`busy`).
 */
export function updatedProductsSheetState(input: UpdatedProductsSheetInput): UpdatedProductsSheetState {
  const read = readState(input.read);
  const draft = isUpdatedProductsDraft(input.draft) ? input.draft : null;
  const locked = isDraftLocked(draft);
  const uncertain = draft?.phase === "uncertain";
  const view = read.state === "answered" ? read.view : null;
  const rows = view === null ? [] : updatedProductRows(view);
  const moves = view?.moves.total ?? 0;
  const reason = input.right.editable ? null : rightReasonLine(input.right.reason);
  const buttonsDisabled = locked || input.busy || !input.right.editable || read.state !== "answered";

  const lines: UpdatedProductsStatusLine[] = [];
  if (draft?.phase === "saving") lines.push({ text: LISTING_SETTINGS_SAVE_WORDS.saving, tone: "info" });
  else if (draft !== null && draft.phase !== "editing" && draft.phase !== "saved" && draft.phase !== "saved_view_stale" && draft.message !== null) {
    lines.push({ text: draft.message, tone: "alert" });
  } else if (draft?.phase === "saved_view_stale" && draft.message !== null) {
    lines.push({ text: draft.message, tone: "alert" });
  } else if (input.lastDone && (draft === null || draft.phase === "editing" || isSavedFlashVisible(draft, input.nowMs))) {
    const words = gotItOutcomeWords(input.lastAnswer);
    lines.push({ text: words.done, tone: "ok" });
    if (words.movedAgain !== null) lines.push({ text: words.movedAgain, tone: "info" });
  }

  return {
    title: LISTING_SETTINGS_UPDATED_WORDS.title,
    read: read.state,
    loadingLine: read.state === "loading" ? LISTING_SETTINGS_UPDATED_WORDS.loading : null,
    problem: read.state === "failed" ? read.problem : null,
    rows,
    empty: view !== null && view.total === 0 ? LISTING_SETTINGS_UPDATED_WORDS.empty : null,
    paging: view === null ? null : updatedProductsPaging(view),
    buttonsDisabled,
    reason,
    gotItAll: {
      label: gotItForAllWords(moves),
      shown: moves > 0,
      disabled: buttonsDisabled || moves === 0,
      body: view !== null && moves > 0 ? gotItAllBody(view) : null,
    },
    lines,
    checkAgain: { label: LISTING_SETTINGS_SAVE_WORDS.checkAgain, shown: uncertain },
    reload: { label: LISTING_SETTINGS_SAVE_WORDS.reload, shown: draft?.phase === "saved_view_stale" },
    escapeKeepsOpen: locked,
  };
}
