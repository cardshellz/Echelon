import {
  LISTING_SETTINGS_PAGE_SIZE,
  type ListingSettingsPricesResponse,
  type ListingSettingsSizePrice,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { MAX_SIZE_PRICES_PER_REQUEST, saveSizePricesInputSchema, type SaveSizePricesInput } from "@shared/dropship/listing-setting-writes";
import { displayListingPrice } from "./dropship-listing-price";
import { listingSettingsPricesQueryOptions } from "./dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "./dropship-listing-settings-access";
import {
  decideOpen,
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_SAVE_WORDS,
  SIZE_PRICES_EDITOR_ID,
  type DraftValue,
  type ListingSettingsDraft,
} from "./dropship-listing-settings-drafts";
import {
  DRAWER_WORDS,
  drawerFooter,
  limitNotices,
  marginNotice,
  parseExactPrice,
  sizeTitleWords,
  type DrawerFooter,
  type DrawerNotice,
} from "./dropship-listing-settings-drawer";
import {
  LISTING_SETTINGS_SIZE_PRICES_WORDS,
  rightReasonLine,
  sizeCostWords,
  sizePriceBoxLabel,
  sizePricesLeftListWords,
  sizePricesNotSavedWords,
} from "./dropship-listing-settings-words";
import { DropshipApiError } from "./dropship-ops-surface";

/**
 * "Give these sizes a price" (W8, `PUT …/listing-settings/size-prices`;
 * Listing settings PR 10f, plan 9.1-9.3, 9.5): the sheet's reads (the Prices
 * tab's "Can't be priced" pages, D18), the draft that holds a typed price per
 * size with the revision its row was read with (D6), the rows to send (the
 * typed ones, at most 200 in one request, all or none, D12), the W8 body
 * and its signature (D5), what a refusal marks on the rows (9.5), "Load
 * latest" after a conflict (`reloadTyped`), and the sheet's state (9.3, 3.7).
 *
 * Rules this module keeps:
 * - The client never computes a price (D1): each box's text becomes integer
 *   cents through the drawer's `parseExactPrice`, and every price shown (the
 *   cost, the limits) is the server's through `formatCents`.
 * - Each size's `expectedRevisionId` is its row's `settingRevisionId` as the
 *   Prices page listed it (D6). A conflict's `actualRevisionId` is never
 *   reused (CC-C5): the pages are read again and each typed size takes its
 *   new revision from them (`reloadTyped`).
 * - One Save is one request of at most 200 typed sizes (D12); over 200 typed
 *   Save is off with "Save up to 200 prices at a time.".
 *
 * Pure: no React, no network, no clock. Never mutates its inputs. The request
 * runner is in dropship-listing-settings-size-prices-requests.ts.
 */

// ---------------------------------------------------------------------------
// The reads (plan 9.3, D10, D18)
// ---------------------------------------------------------------------------

/** The Prices tab filter the sheet lists: sizes that can't be priced (`SR` LISTING_SETTINGS_PRICE_FILTERS). */
export const SIZE_PRICES_SHOW = "cannot_price" as const;
/** The page size the server uses (50): the sheet's pages, each loaded with [Load more] (9.3). */
export const SIZE_PRICES_PAGE_SIZE = LISTING_SETTINGS_PAGE_SIZE;

/** What the reads need from the summary: whether the selection is too large to check. */
export type SizePricesSummaryFacts = ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog">>;

/** Whether the sheet's reads may run (D18): only while the summary's catalog state is not `too_large`. */
export function sizePricesReadEnabled(summary: SizePricesSummaryFacts): boolean {
  return summary.data?.catalog.state !== "too_large";
}

/**
 * One page of the sheet's list: the very read the Prices tab makes for "Can't
 * be priced" with no search (the same key, so the tab's answer shows at once
 * and the sheet adds no read of its own kind, D18), read fresh while the
 * sheet is open (staleTime 0: an open editor's read, D10), because each row's
 * `settingRevisionId` is what a typed price is saved against (D6). Under the
 * store's prefix. Off while the sheet is closed or the selection is too large.
 */
export function sizePricesPageQueryOptions(storeConnectionId: number, page: number, summary: SizePricesSummaryFacts, open: boolean) {
  return listingSettingsPricesQueryOptions(storeConnectionId, { search: "", show: SIZE_PRICES_SHOW, page }, { enabled: open && sizePricesReadEnabled(summary), fresh: true });
}

/** The Prices tab's way in (plan 9.2, 9.3): [Give these sizes a price], and whether it shows. */
export interface SizePricesEntry {
  label: string;
  /** Shown while the tab shows "Can't be priced" and its first page lists a size; hidden while the lists are off, under another filter, before the page answers, or with no size to price. */
  shown: boolean;
}

/**
 * Whether the Prices tab offers the sheet (plan 9.3): only under Show = "Can't
 * be priced" (the sheet lists that very filter, D18), and only while the
 * sheet's own first page (no search: the button is tied to the Show filter,
 * not to the tab's search) says a size needs a price; the entry hides with
 * the empty words. With no search typed that page is the tab's own read.
 */
export function sizePricesEntry(input: {
  show: string;
  listsOff: boolean;
  page: ListingSettingsReadState<Pick<ListingSettingsPricesResponse, "total">>;
}): SizePricesEntry {
  const total = input.page.data?.total ?? null;
  return {
    label: LISTING_SETTINGS_SIZE_PRICES_WORDS.title,
    shown: !input.listsOff && input.show === SIZE_PRICES_SHOW && total !== null && total > 0,
  };
}

// ---------------------------------------------------------------------------
// The draft (plan 9.2, D6, D16)
// ---------------------------------------------------------------------------

/** One typed size: the box's text as typed, and the price revision its row was read with (W8's `expectedRevisionId`, D6; null for none saved). */
export interface SizePriceEntry {
  readonly text: string;
  readonly expectedRevisionId: number | null;
}

/** A typed size's field in the draft: `size:<productVariantId>`. */
export type SizePriceKey = `size:${number}`;

/**
 * The sheet's draft value: one field per typed size (so the bar counts each
 * typed price as one change), nothing else. The base is empty: every typed
 * size is a change, and a size whose box is emptied leaves the draft.
 */
export type SizePricesDraftValue = Readonly<Record<SizePriceKey, SizePriceEntry>>;

const MAX_ID = 2_147_483_647;
const SIZE_KEY = /^size:([1-9]\d{0,9})$/;
const NO_SIZES: SizePricesDraftValue = Object.freeze({});

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ID;
}

export function sizePriceKey(productVariantId: number): SizePriceKey {
  if (!isId(productVariantId)) throw new Error(`A size's field needs a positive whole-number size id, not ${String(productVariantId)}.`);
  return `size:${productVariantId}`;
}

/** The size a draft field names, or null for any other field. */
export function sizeIdOfKey(key: string): number | null {
  const match = SIZE_KEY.exec(key);
  if (match === null) return null;
  const id = Number(match[1]);
  return isId(id) ? id : null;
}

/** Nothing typed: the draft's base. */
export function emptySizePricesDraft(): SizePricesDraftValue {
  return NO_SIZES;
}

function isEntry(value: unknown): value is SizePriceEntry {
  if (typeof value !== "object" || value === null) return false;
  const { text, expectedRevisionId } = value as Record<string, unknown>;
  return typeof text === "string" && (expectedRevisionId === null || isId(expectedRevisionId));
}

/** The sheet's draft value, or null when `value` is not one (another editor's draft: any field that isn't a typed size). */
export function readSizePricesDraft(value: DraftValue): SizePricesDraftValue | null {
  for (const key of Object.keys(value)) {
    if (sizeIdOfKey(key) === null || !isEntry(value[key])) return null;
  }
  return value as SizePricesDraftValue;
}

/** The sheet's draft and its value, when the step's one draft is it; null otherwise. */
export function ownSizePricesDraft(draft: ListingSettingsDraft | null): { draft: ListingSettingsDraft; value: SizePricesDraftValue } | null {
  if (draft === null || draft.editor !== SIZE_PRICES_EDITOR_ID) return null;
  const value = readSizePricesDraft(draft.value);
  return value === null ? null : { draft, value };
}

/** One typed size as the draft holds it, with its text parsed (D1): integer cents, or why not. */
export interface TypedSizePrice {
  productVariantId: number;
  text: string;
  expectedRevisionId: number | null;
  parsed: ReturnType<typeof parseExactPrice>;
}

/** The typed sizes, ascending by size id, each with its text parsed by the drawer's rule (R:540). An emptied box is not typed. */
export function typedSizePrices(value: SizePricesDraftValue): TypedSizePrice[] {
  return Object.keys(value)
    .map((key) => ({ key, productVariantId: sizeIdOfKey(key) }))
    .filter((entry): entry is { key: string; productVariantId: number } => entry.productVariantId !== null)
    .sort((left, right) => left.productVariantId - right.productVariantId)
    .map(({ key, productVariantId }) => {
      const entry = value[key as SizePriceKey];
      return { productVariantId, text: entry.text, expectedRevisionId: entry.expectedRevisionId, parsed: parseExactPrice(entry.text) };
    });
}

/**
 * The draft with `text` typed for a size: an emptied box takes the size out
 * of the draft; a box with text keeps the revision the size was first typed
 * against (the row the vendor saw, D6; `reloadTyped` moves it after a
 * conflict), or takes the row's for a size typed now.
 */
export function sizePriceTyped(
  value: SizePricesDraftValue,
  size: Pick<ListingSettingsSizePrice, "productVariantId" | "settingRevisionId">,
  text: string,
): SizePricesDraftValue {
  const key = sizePriceKey(size.productVariantId);
  const { [key]: current, ...rest } = value;
  if (text.trim() === "") return Object.freeze(rest) as SizePricesDraftValue;
  return Object.freeze({ ...rest, [key]: { text, expectedRevisionId: current === undefined ? size.settingRevisionId : current.expectedRevisionId } });
}

/** What typing in a size's box does to the step's one draft (D16). */
export type SizePricesEditAction =
  /** The sheet's draft holds typed sizes: send `value` to `drafts.edit`. */
  | { kind: "edit"; value: SizePricesDraftValue }
  /** The sheet's draft is clean or missing: `drafts.open(SIZE_PRICES_EDITOR_ID, place, base)`, then `drafts.edit(value)`. */
  | { kind: "start"; base: SizePricesDraftValue; value: SizePricesDraftValue }
  /** A save is in flight or unconfirmed: nothing changes until it ends (R:539, R:541). */
  | { kind: "locked" }
  /** Another editor holds a change, or is saving one (D16): the sheet asks through the leave guard first; nothing is typed. */
  | { kind: "elsewhere" };

/**
 * Typing `text` into a size's box: a draft holding typed sizes takes it; a
 * clean one (after a confirmed save its base still holds what was saved)
 * starts again on nothing typed, so a size saved before is never sent with
 * its old revision; another editor's unsaved change is asked about first.
 */
export function sizePricesEditAction(input: {
  draft: ListingSettingsDraft | null;
  size: Pick<ListingSettingsSizePrice, "productVariantId" | "settingRevisionId">;
  text: string;
}): SizePricesEditAction {
  const own = ownSizePricesDraft(input.draft);
  if (own !== null && isDraftLocked(own.draft)) return { kind: "locked" };
  if (own !== null && isDraftDirty(own.draft)) return { kind: "edit", value: sizePriceTyped(own.value, input.size, input.text) };
  if (decideOpen(input.draft, SIZE_PRICES_EDITOR_ID) !== "open") return { kind: "elsewhere" };
  return { kind: "start", base: NO_SIZES, value: sizePriceTyped(NO_SIZES, input.size, input.text) };
}

/** [Discard] in the sheet: the draft goes (`drafts.discard()`); none while a save is out or unconfirmed, or with nothing typed. */
export function sizePricesDiscard(draft: ListingSettingsDraft | null): "discard" | "none" {
  const own = ownSizePricesDraft(draft);
  return own !== null && !isDraftLocked(own.draft) && isDraftDirty(own.draft) ? "discard" : "none";
}

// ---------------------------------------------------------------------------
// The W8 request (plan 9.4, 9.5; D1, D5, D12)
// ---------------------------------------------------------------------------

/** One row W8 takes: integer cents and the revision the size was read with. */
export type SizePriceRow = SaveSizePricesInput["rows"][number];

export type SizePricesSaveRows =
  | { ok: true; rows: SizePriceRow[] }
  /** Nothing typed, a box the parsers refuse (its own words, shown by the row), or more than 200 typed (D12). */
  | { ok: false; reason: "none" | "invalid" | "too_many"; message: string | null };

/** The sheet's one request: every typed size as integer cents (D1), ascending, at most 200 (D12). */
export function sizePricesSaveRows(value: SizePricesDraftValue): SizePricesSaveRows {
  const typed = typedSizePrices(value);
  if (typed.length === 0) return { ok: false, reason: "none", message: null };
  if (typed.length > MAX_SIZE_PRICES_PER_REQUEST) return { ok: false, reason: "too_many", message: LISTING_SETTINGS_SIZE_PRICES_WORDS.tooMany };
  const invalid = typed.find((entry) => !entry.parsed.ok);
  if (invalid !== undefined && !invalid.parsed.ok) return { ok: false, reason: "invalid", message: invalid.parsed.message };
  return {
    ok: true,
    rows: typed.map((entry) => ({
      productVariantId: entry.productVariantId,
      priceCents: entry.parsed.ok ? entry.parsed.cents : 0,
      expectedRevisionId: entry.expectedRevisionId,
    })),
  };
}

/**
 * Everything a W8 request sends except its key (D5): the same sizes with the
 * same cents and revisions, in any order, reuse the key; any edit, or a new
 * revision after "Load latest", gets a new one.
 */
export function sizePricesSignature(storeConnectionId: number, rows: readonly SizePriceRow[]): string {
  const sorted = [...rows].sort((left, right) => left.productVariantId - right.productVariantId)
    .map((row) => [row.productVariantId, row.priceCents, row.expectedRevisionId]);
  return JSON.stringify(["listing-settings-size-prices-v1", storeConnectionId, sorted]);
}

export const SIZE_PRICES_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_SIZE_PRICES_REQUEST_INVALID";

/** A W8 body this page would build outside the contract: never sent. */
export class SizePricesRequestError extends Error {
  readonly code = SIZE_PRICES_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "SizePricesRequestError";
    this.context = Object.freeze({ ...context });
  }
}

/** The W8 body, checked by the shared input schema before it is sent (1 to 200 rows, each size once, integer cents above zero). */
export function sizePricesBody(input: { key: string; rows: readonly SizePriceRow[] }): SaveSizePricesInput {
  const parsed = saveSizePricesInputSchema.safeParse({ idempotencyKey: input.key, rows: input.rows.map((row) => ({ ...row })) });
  if (parsed.success) return parsed.data;
  throw new SizePricesRequestError("These prices can't be sent as they are. Check them and save again.", {
    rowCount: input.rows.length,
    issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

// ---------------------------------------------------------------------------
// After a refusal (plan 9.5)
// ---------------------------------------------------------------------------

/** The sizes a refusal names (9.5): the first 100 of a version conflict's `conflicts`, or of a limit refusal's `sizes`; the rest are marked by a re-read. */
export interface SizePricesRefusal {
  /** 422 PRICE_OUTSIDE_LIMIT: rows marked "Outside a Card Shellz price limit". */
  readonly outsideLimit: ReadonlySet<number>;
  /** 409 PRICE_VERSION_CONFLICT: rows whose price changed in another window. */
  readonly conflicts: ReadonlySet<number>;
}

const NO_REFUSAL: SizePricesRefusal = Object.freeze({ outsideLimit: new Set<number>(), conflicts: new Set<number>() });
const OUTSIDE_LIMIT_CODE = "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT";
const VERSION_CONFLICT_CODE = "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT";

function sizeIdsOf(list: unknown): ReadonlySet<number> {
  if (!Array.isArray(list)) return new Set();
  return new Set(list
    .map((entry) => (entry !== null && typeof entry === "object" ? (entry as { productVariantId?: unknown }).productVariantId : undefined))
    .filter((id): id is number => isId(id)));
}

const NOT_AVAILABLE_CODE = "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE";

/**
 * What a failed save marks on the rows, from its code and the answer's
 * context (`WE` publicListingSettingContext: `conflicts`, `sizes`; a 404's
 * `productVariantId`, the size no longer chosen, which the wrapper names,
 * `SPS` namingSize). A size no longer chosen is a conflict (W8's rule): its
 * row is marked as one until Load latest drops it.
 */
export function sizePricesRefusalOf(code: string | null, context: Readonly<Record<string, unknown>> | null | undefined): SizePricesRefusal {
  if (code === OUTSIDE_LIMIT_CODE) return { outsideLimit: sizeIdsOf(context?.sizes), conflicts: new Set() };
  if (code === VERSION_CONFLICT_CODE) return { outsideLimit: new Set(), conflicts: sizeIdsOf(context?.conflicts) };
  if (code === NOT_AVAILABLE_CODE) return { outsideLimit: new Set(), conflicts: sizeIdsOf([{ productVariantId: context?.productVariantId }]) };
  return NO_REFUSAL;
}

/**
 * The marks after a size's box is typed in again (plan 9.5): the retyped
 * size is no longer the price the server refused, so its mark goes; the
 * other marks stay until the next save. The same object when nothing changes.
 */
export function sizePricesRefusalWithoutSize(refusal: SizePricesRefusal, productVariantId: number): SizePricesRefusal {
  if (!refusal.outsideLimit.has(productVariantId) && !refusal.conflicts.has(productVariantId)) return refusal;
  const without = (set: ReadonlySet<number>) => new Set([...set].filter((id) => id !== productVariantId));
  return { outsideLimit: without(refusal.outsideLimit), conflicts: without(refusal.conflicts) };
}

/** What a failed save marks, from the error itself (a `DropshipApiError`); nothing for anything else. */
export function sizePricesRefusalOfError(error: unknown): SizePricesRefusal {
  return error instanceof DropshipApiError ? sizePricesRefusalOf(error.code, error.context) : NO_REFUSAL;
}

export function noSizePricesRefusal(): SizePricesRefusal {
  return NO_REFUSAL;
}

// ---------------------------------------------------------------------------
// "Load latest" after a conflict (plan 9.5, CC-C5)
// ---------------------------------------------------------------------------

export interface SizePricesReload {
  /** The typed sizes still listed, each with its new revision from the pages read again: send it to the draft, then rebase on nothing typed. */
  value: SizePricesDraftValue;
  /** Sizes still listed, kept. */
  kept: number;
  /** Typed sizes the pages no longer list: they leave the draft, unsaved. */
  dropped: number;
  /** "2 sizes left this list and weren't saved."; null when none did. */
  line: string | null;
  /** False when nothing typed is left: the draft is discarded instead. */
  keeps: boolean;
}

/**
 * The typed sizes on the pages read again (9.5): each typed size still listed
 * keeps its text and takes its new `settingRevisionId`; a typed size no longer
 * listed leaves the draft (it was priced elsewhere, or is no longer chosen).
 * A conflict's `actualRevisionId` is never used (CC-C5).
 */
export function reloadTyped(value: SizePricesDraftValue, loadedPages: ReadonlyArray<Pick<ListingSettingsPricesResponse, "rows">>): SizePricesReload {
  const listed = new Map<number, number | null>();
  for (const page of loadedPages) {
    for (const row of page.rows) {
      if (!listed.has(row.productVariantId)) listed.set(row.productVariantId, row.settingRevisionId);
    }
  }
  const next: Record<string, SizePriceEntry> = {};
  let kept = 0;
  let dropped = 0;
  for (const entry of typedSizePrices(value)) {
    if (!listed.has(entry.productVariantId)) {
      dropped += 1;
      continue;
    }
    kept += 1;
    next[sizePriceKey(entry.productVariantId)] = { text: entry.text, expectedRevisionId: listed.get(entry.productVariantId) ?? null };
  }
  return {
    value: Object.freeze(next) as SizePricesDraftValue,
    kept,
    dropped,
    line: dropped > 0 ? sizePricesLeftListWords(dropped) : null,
    keeps: kept > 0,
  };
}

// ---------------------------------------------------------------------------
// The sheet (plan 9.3, 3.7)
// ---------------------------------------------------------------------------

export interface SizePriceRowModel {
  /** Stable among the rows: the size. */
  key: string;
  productVariantId: number;
  productId: number;
  productName: string;
  /** "Pack of 100 · EG-SLV-STD-100": the size with its SKU. */
  size: string;
  /** "Your cost $2.10", for a card that has no column head; null when it isn't known. */
  cost: string | null;
  /** "$2.10", for the table's "Your cost" column; null when it isn't known. */
  costAmount: string | null;
  box: {
    text: string;
    /** "Exact price for Penny Sleeves, Pack of 100" (plan 3.4). */
    label: string;
    /** The parsers' words for the text as typed ("Enter a price like 14.99."); null while it parses or is empty. */
    invalid: string | null;
    readOnly: boolean;
  };
  /** Under the box: a limit refusal's mark, the drawer's limit and below-cost notes for the typed price. */
  notices: DrawerNotice[];
  typed: boolean;
  /** 422 PRICE_OUTSIDE_LIMIT named this size. */
  outsideLimit: boolean;
  /** 409 PRICE_VERSION_CONFLICT named this size. */
  conflict: boolean;
}

/** The rows of the pages loaded so far (0..k), each size once (the first listing wins), with the draft's typed text and the drawer's notes. */
export function sizePriceRows(input: {
  pages: ReadonlyArray<Pick<ListingSettingsPricesResponse, "rows">>;
  value: SizePricesDraftValue | null;
  refusal: SizePricesRefusal;
  readOnly: boolean;
}): SizePriceRowModel[] {
  const seen = new Set<number>();
  const rows: SizePriceRowModel[] = [];
  for (const page of input.pages) {
    for (const row of page.rows) {
      if (seen.has(row.productVariantId)) continue;
      seen.add(row.productVariantId);
      rows.push(sizePriceRow(row, input.value?.[sizePriceKey(row.productVariantId)] ?? null, input.refusal, input.readOnly));
    }
  }
  return rows;
}

function sizePriceRow(row: ListingSettingsSizePrice, entry: SizePriceEntry | null, refusal: SizePricesRefusal, readOnly: boolean): SizePriceRowModel {
  const text = entry?.text ?? "";
  const typed = entry !== null && text.trim() !== "";
  const parsed = typed ? parseExactPrice(text) : null;
  const notices: DrawerNotice[] = [];
  const outsideLimit = refusal.outsideLimit.has(row.productVariantId);
  if (outsideLimit) notices.push({ tone: "alert", text: LISTING_SETTINGS_SIZE_PRICES_WORDS.outsideLimit });
  if (parsed?.ok) {
    const margin = marginNotice(parsed.cents, row.costCents);
    if (margin) notices.push(margin);
    notices.push(...limitNotices(row.limits, parsed.cents));
  }
  return {
    key: `size:${row.productVariantId}`,
    productVariantId: row.productVariantId,
    productId: row.productId,
    productName: row.productName,
    size: sizeTitleWords(row),
    cost: sizeCostWords(row.costCents),
    costAmount: row.costCents === null ? null : displayListingPrice(row.costCents),
    box: {
      text,
      label: sizePriceBoxLabel(row.productName, row.sizeName),
      invalid: parsed !== null && !parsed.ok ? parsed.message : null,
      readOnly,
    },
    notices,
    typed,
    outsideLimit,
    conflict: refusal.conflicts.has(row.productVariantId),
  };
}

export type SizePricesReadProblem = { kind: "failed" | "rate_limited"; text: string; retryLabel: string };

export interface SizePricesLoadMore {
  label: string;
  /** Another page follows the loaded ones. */
  shown: boolean;
  /** The next page to read (k + 1). */
  nextPage: number;
  /** The last page's read is in flight. */
  loading: boolean;
  /** The last page's read failed: its words, with [Try again] reading it again; null otherwise. */
  problem: SizePricesReadProblem | null;
}

export interface SizePricesSheetInput {
  /** The pages read so far, 0..k in order, as React Query holds them. */
  pages: ReadonlyArray<ListingSettingsReadState<ListingSettingsPricesResponse>>;
  /** The step's one draft, whoever holds it. */
  draft: ListingSettingsDraft | null;
  /** W8's right (`rights.sizePrices`, D3). */
  right: ListingSettingsRight;
  /** Another listing action is running, or a read for the footer is in flight. */
  busy: boolean;
  /** "Saved" shows now (3 seconds after a confirmed save, R:538). */
  savedFlashVisible: boolean;
  compact: boolean;
  /** What the last failed save named (`sizePricesRefusalOf`), kept by the sheet until the next save. */
  refusal: SizePricesRefusal;
  /** The line after Load latest: "2 sizes left this list and weren't saved."; null for none. */
  reloadLine?: string | null;
}

export interface SizePricesSheetState {
  title: string;
  intro: string;
  /** `failed` only while nothing is shown: a later page's failure is `loadMore.problem`. */
  read: "loading" | "failed" | "answered";
  loadingLine: string | null;
  problem: SizePricesReadProblem | null;
  rows: SizePriceRowModel[];
  /** "Every size has a price." when the first page answered with no row; null otherwise. */
  empty: string | null;
  loadMore: SizePricesLoadMore;
  /** How many sizes are typed. */
  typedCount: number;
  /** The footer: "● Not saved · 12 prices" [Discard] [Save prices], or the draft's phase (Check again, Load latest, Reload). */
  footer: DrawerFooter;
  /**
   * Whether the footer shows (3.7): always with typed prices or a save out or unconfirmed (its Check again, Discard
   * and count must stay in reach, even when the first page's read failed after Back, D21); else once the first page
   * answered with rows or the footer has words; never while loading, or empty with nothing to say.
   */
  footerShown: boolean;
  /** The line after Load latest, under the footer's words. */
  reloadLine: string | null;
  /** Every box is read only: the right is gone, a save is out or unconfirmed, or another action runs. */
  boxesReadOnly: boolean;
  /** Why the boxes are off, when the banner doesn't say (the right's own line); null otherwise. */
  reason: string | null;
  /** Esc keeps the sheet open: a save is out or unconfirmed (plan 3.4). */
  escapeKeepsOpen: boolean;
  /** The sheet's save is out or unconfirmed. */
  held: boolean;
}

const HTTP_TOO_MANY_REQUESTS = 429;

function readProblem(error: unknown): SizePricesReadProblem {
  if (error instanceof DropshipApiError && error.status === HTTP_TOO_MANY_REQUESTS) {
    return { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
  }
  return { kind: "failed", text: LISTING_SETTINGS_SIZE_PRICES_WORDS.readFailed, retryLabel: LISTING_SETTINGS_SAVE_WORDS.tryAgain };
}

function hasError(read: ListingSettingsReadState<unknown>): boolean {
  return read.error !== undefined && read.error !== null;
}

/**
 * The sheet from its pages, the step's draft and W8's right (plan 9.3, 3.7):
 * the rows of every loaded page (each size once), [Load more] while another
 * page follows, the typed count and why Save is off, and the footer. The
 * draft is the sheet's only while it is a `sizePrices` draft; another
 * editor's draft locks nothing here but the page's pending-save counter
 * (`busy`). A page answered keeps its rows across a failed refresh (React
 * Query keeps `data` beside `error`).
 */
export function sizePricesSheetState(input: SizePricesSheetInput): SizePricesSheetState {
  const first = input.pages[0];
  const answered = input.pages.filter((page): page is ListingSettingsReadState<ListingSettingsPricesResponse> & { data: ListingSettingsPricesResponse } => page.data !== undefined);
  const firstView = first?.data ?? null;
  const read: SizePricesSheetState["read"] = firstView !== null ? "answered" : first !== undefined && hasError(first) ? "failed" : "loading";
  const own = ownSizePricesDraft(input.draft);
  const locked = own !== null && isDraftLocked(own.draft);
  const value = own !== null && (isDraftDirty(own.draft) || locked) ? own.value : null;
  const typed = value === null ? [] : typedSizePrices(value);
  const reason = input.right.editable ? null : rightReasonLine(input.right.reason);
  const boxesReadOnly = !input.right.editable || locked || input.busy;

  const rows = sizePriceRows({ pages: answered.map((page) => page.data), value, refusal: input.refusal, readOnly: boxesReadOnly });
  const total = firstView?.total ?? null;
  const last = input.pages[input.pages.length - 1];
  const loadedCount = answered.length;
  const lastLoading = last !== undefined && last.data === undefined && !hasError(last);
  const lastFailed = last !== undefined && last.data === undefined && hasError(last) && input.pages.length > 1;
  const loadMore: SizePricesLoadMore = {
    label: LISTING_SETTINGS_SIZE_PRICES_WORDS.loadMore,
    shown: total !== null && loadedCount * SIZE_PRICES_PAGE_SIZE < total,
    nextPage: loadedCount,
    loading: lastLoading && input.pages.length > 1,
    problem: lastFailed ? readProblem(last.error) : null,
  };

  const saveRows = value === null ? null : sizePricesSaveRows(value);
  // Why Save is off though sizes are typed: over 200 (D12); a box the parsers refuse says so under itself.
  const saveLine = saveRows !== null && !saveRows.ok && saveRows.reason === "too_many" ? saveRows.message : null;
  const canSave = saveRows !== null && saveRows.ok;
  const drawn = drawerFooter({
    draft: own?.draft ?? null,
    editable: input.right.editable && firstView !== null,
    busy: input.busy,
    clear: null,
    savedFlashVisible: input.savedFlashVisible,
    compact: input.compact,
    showRefusal: true,
    saveLabel: LISTING_SETTINGS_SIZE_PRICES_WORDS.save,
    compactSaveLabel: LISTING_SETTINGS_SIZE_PRICES_WORDS.save,
  });
  const footer: DrawerFooter = {
    ...drawn,
    notSaved: typed.length > 0 ? sizePricesNotSavedWords(typed.length, input.compact) : null,
    primary: drawn.primary.action === "save" && !canSave ? { ...drawn.primary, disabled: true } : drawn.primary,
    message: drawn.message ?? (saveLine !== null ? { text: saveLine, tone: "status" } : null),
  };

  return {
    title: LISTING_SETTINGS_SIZE_PRICES_WORDS.title,
    intro: LISTING_SETTINGS_SIZE_PRICES_WORDS.intro,
    read,
    loadingLine: read === "loading" ? LISTING_SETTINGS_SIZE_PRICES_WORDS.loading : null,
    problem: read === "failed" && first !== undefined ? readProblem(first.error) : null,
    rows,
    empty: firstView !== null && firstView.total === 0 ? LISTING_SETTINGS_SIZE_PRICES_WORDS.empty : null,
    loadMore,
    typedCount: typed.length,
    footer,
    footerShown: locked || typed.length > 0 || (read === "answered" && (rows.length > 0 || footer.message !== null)),
    reloadLine: input.reloadLine ?? null,
    boxesReadOnly,
    reason,
    escapeKeepsOpen: locked,
    held: locked,
  };
}
