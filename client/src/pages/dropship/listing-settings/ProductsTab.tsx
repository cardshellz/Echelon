import { useEffect, useId, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LISTING_SETTINGS_PAGE_SIZE,
  MAX_LISTING_SETTINGS_PAGE,
  MAX_LISTING_SETTINGS_SEARCH_LENGTH,
  type ListingSettingsProductRow,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import {
  ListingSettingsReadError,
  listingSettingsProductsQueryOptions,
  type ListingSettingsProductFilter,
} from "@/lib/dropship-listing-settings";
import { formatCents } from "@/lib/dropship-listing-settings-price-words";
import { ownSettingsWords, productStatusWords, type ProductStatusTone } from "@/lib/dropship-listing-settings-words";
import { DropshipApiError } from "@/lib/dropship-ops-surface";

/**
 * The Products tab of the Listing settings step (Listing settings PR 7,
 * sub-part 2D; record M1, R:142-165, R:466, R:549-558, R:589), and the list
 * parts the Prices tab shares with it: the search box, the read states, the
 * paging and the words for them.
 *
 * Read-only. A row opens the product drawer; nothing here saves. Search,
 * filters, counts and paging run on the server (`GET …/listing-settings/products`,
 * 50 rows a page). Words come from the design record unless marked interim;
 * the tab's interim words live in this file and PricesTab.tsx only.
 */

// ---------------------------------------------------------------------------
// Shared by both tabs
// ---------------------------------------------------------------------------

/** The words both lists use. */
export const LISTING_SETTINGS_LIST_WORDS = Object.freeze({
  search: "Search product, size or SKU",
  show: "Show",
  previous: "Previous",
  next: "Next",
  loadMore: "Load more",
  tryAgain: "Try again",
  clearSearch: "Clear search",
  goToStep1: "Go to step 1",
  nothingChosen: "No products chosen yet. Pick what to sell in step 1.",
  // Interim: the record has words for a save that is refused for this (R:545), not for a read.
  rateLimited: "Too many checks in a minute. Wait a moment and try again.",
  // Interim.
  failed: "Couldn't load this list. Try again.",
  // Interim: a refresh failed, so the rows shown are the last ones read.
  refreshFailed: "Couldn't check this list again, so it may be out of date.",
  // Interim (with its button): the list shrank while a later page was open.
  pastEnd: "Nothing is on this page now.",
  firstPage: "First page",
  // Interim: a filter that shows nothing.
  showAll: "Show all",
});

/** What the vendor opens: a product, and the size to land on when one is known. */
export interface ListingSettingsProductTarget {
  productId: number;
  /** The size to open on, with its Exact price box focused (R:360, R:552). */
  productVariantId?: number;
}

/** One list's search, filter and place (plan 2D). Kept by the tabs, so switching tabs loses nothing. */
export interface ListingSettingsListView<Show extends string> {
  /** What the search box holds now. */
  searchInput: string;
  /** The search the list was last asked for: the box, trimmed, after a pause in typing. */
  search: string;
  show: Show;
  /** The page shown on a wide screen, from 0. */
  page: number;
  /** How many pages a phone shows, from Load more (1 or more). */
  pagesLoaded: number;
}

/** The callbacks a list's controls call. */
export interface ListingSettingsListHandlers<Show extends string> {
  onSearchInput: (value: string) => void;
  onClearSearch: () => void;
  onShow: (show: Show) => void;
  onPage: (page: number) => void;
  onLoadMore: () => void;
  onOpenProduct: (target: ListingSettingsProductTarget) => void;
  onGoToStep1: () => void;
  /**
   * A page read was refused because more than 10,000 sizes are chosen. The
   * step shows the too-large banner from this refusal (plan 4.4), since the
   * list shows nothing then and the summary it read may not say so yet.
   */
  onTooLarge?: (error: unknown) => void;
}

/** Shown while a page loads (R:497). */
export const LIST_LOADING_ROWS = 8;

/** A whole number for the vendor: 1240 -> "1,240". */
export function countText(value: number): string {
  return value.toLocaleString("en-US");
}

/** Why a list read failed, in the terms the list shows. */
export type ListProblem =
  /** More than 10,000 sizes are chosen: the banner says so, the list shows nothing. */
  | { kind: "too_large" }
  | { kind: "rate_limited" }
  | { kind: "failed"; message: string };

/** The list read codes this tab handles itself (`dropship-listing-settings.routes.ts`). */
const TOO_LARGE_CODE = "DROPSHIP_LISTING_SETTINGS_TOO_LARGE";
const TOO_MANY_REQUESTS = 429;
const UNPROCESSABLE = 422;

/**
 * A failed list read, classified. A refused page is never retried out of
 * sight (the reads use `retry: false`); the vendor sees why and can try again.
 */
export function listReadProblem(error: unknown): ListProblem {
  if (error instanceof DropshipApiError) {
    if (error.status === UNPROCESSABLE && error.code === TOO_LARGE_CODE) return { kind: "too_large" };
    if (error.status === TOO_MANY_REQUESTS) return { kind: "rate_limited" };
  }
  // The adapter's own errors (an answer off the contract, a request outside it) carry vendor words.
  if (error instanceof ListingSettingsReadError) return { kind: "failed", message: error.message };
  return { kind: "failed", message: LISTING_SETTINGS_LIST_WORDS.failed };
}

/** Whether a list read was refused because more than 10,000 sizes are chosen (the banner then explains). */
export function isListTooLarge(error: unknown): boolean {
  return error !== null && error !== undefined && listReadProblem(error).kind === "too_large";
}

/**
 * Tells the step once when this page's read is refused as too large, so the
 * banner shows even while the summary it read still says the selection fits.
 */
export function useReportListTooLarge(error: unknown, onTooLarge: ((error: unknown) => void) | undefined): void {
  const tooLarge = isListTooLarge(error);
  useEffect(() => {
    if (tooLarge) onTooLarge?.(error);
  }, [tooLarge, error, onTooLarge]);
}

/** The line over rows that are shown although their refresh failed; null when the banner already says why. */
function refreshNotice(problem: ListProblem): string | null {
  switch (problem.kind) {
    case "too_large": return null;
    case "rate_limited": return LISTING_SETTINGS_LIST_WORDS.rateLimited;
    case "failed": return LISTING_SETTINGS_LIST_WORDS.refreshFailed;
  }
}

/** What one page of a list shows. */
export type ListPageView<Row> =
  | { kind: "loading" }
  | ListProblem
  /** Nothing is chosen in step 1. */
  | { kind: "nothing_chosen" }
  | { kind: "no_match"; search: string }
  /** A filter with no search shows nothing. */
  | { kind: "none_shown" }
  /** A later page is empty now (the list shrank). */
  | { kind: "past_end" }
  | {
    kind: "rows";
    rows: readonly Row[];
    page: number;
    total: number;
    /** The rows are the last page's while the next one loads. */
    refreshing: boolean;
    /** Why the rows may be out of date; null when they are current. */
    notice: string | null;
  };

/** The parts of a React Query read a page needs. */
export interface ListPageRead<Row> {
  data: { page: number; total: number; rows: readonly Row[] } | undefined;
  error: unknown;
  isPlaceholderData: boolean;
}

/**
 * What a page shows, from its read and what it asked for. Pure.
 * - An error with nothing usable to show is the error.
 * - Rows kept from the last page while the next loads are shown as refreshing;
 *   an empty kept page is shown as loading, so "no match" never names the old search.
 * - An empty answer is "nothing chosen", "no match" or "nothing in this filter".
 */
export function listPageView<Row>(read: ListPageRead<Row>, asked: { search: string; show: string }): ListPageView<Row> {
  const failed = read.error !== null && read.error !== undefined;
  const data = read.data;
  if (failed && (data === undefined || read.isPlaceholderData)) return listReadProblem(read.error);
  if (data === undefined) return { kind: "loading" };
  if (read.isPlaceholderData && data.rows.length === 0) return { kind: "loading" };
  if (data.rows.length > 0) {
    return {
      kind: "rows",
      rows: data.rows,
      page: data.page,
      total: data.total,
      refreshing: read.isPlaceholderData,
      notice: failed ? refreshNotice(listReadProblem(read.error)) : null,
    };
  }
  if (failed) return listReadProblem(read.error);
  if (data.total > 0) return { kind: "past_end" };
  if (asked.search !== "") return { kind: "no_match", search: asked.search };
  if (asked.show !== "all") return { kind: "none_shown" };
  return { kind: "nothing_chosen" };
}

/** "1–50 of 312": the rows on this page among all of them. */
export function listRangeWords(page: number, rowsOnPage: number, total: number): string {
  const first = page * LISTING_SETTINGS_PAGE_SIZE + 1;
  const last = page * LISTING_SETTINGS_PAGE_SIZE + rowsOnPage;
  return `${countText(first)}–${countText(last)} of ${countText(total)}`;
}

/** Whether rows come after this page. The contract stops at its last page. */
export function hasPageAfter(page: number, rowsOnPage: number, total: number): boolean {
  return page < MAX_LISTING_SETTINGS_PAGE && page * LISTING_SETTINGS_PAGE_SIZE + rowsOnPage < total;
}

/** The pages a list shows: the current one on a wide screen, every loaded one on a phone. */
export function listPagesShown(view: Pick<ListingSettingsListView<string>, "page" | "pagesLoaded">, compact: boolean): number[] {
  if (!compact) return [view.page];
  return Array.from({ length: Math.max(1, view.pagesLoaded) }, (_, page) => page);
}

/** The search box both lists use. Server-side search, at most 100 characters. */
export function ListSearch({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <Input
      type="search"
      value={value}
      disabled={disabled}
      maxLength={MAX_LISTING_SETTINGS_SEARCH_LENGTH}
      placeholder={LISTING_SETTINGS_LIST_WORDS.search}
      aria-label={LISTING_SETTINGS_LIST_WORDS.search}
      onChange={(event) => onChange(event.target.value)}
      className="h-9 w-full bg-white sm:max-w-sm"
    />
  );
}

/** A native "Show" select (the Prices filter, and the Products chips on a phone). */
export function ListShowSelect<Show extends string>({ value, options, disabled, onChange }: {
  value: Show;
  options: ReadonlyArray<{ show: Show; label: string }>;
  disabled: boolean;
  onChange: (show: Show) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2 text-sm text-zinc-700">
      <label htmlFor={id}>{LISTING_SETTINGS_LIST_WORDS.show}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const picked = options.find((option) => option.show === event.target.value);
          if (picked) onChange(picked.show);
        }}
        className="h-9 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-900 disabled:opacity-50 sm:flex-none"
      >
        {options.map((option) => <option key={option.show} value={option.show}>{option.label}</option>)}
      </select>
    </div>
  );
}

/** Eight grey rows (R:497). */
export function ListSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" data-testid="listing-settings-list-loading">
      {Array.from({ length: LIST_LOADING_ROWS }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}
    </div>
  );
}

/** A line in place of the rows, with at most one button. */
export function ListMessage({ text, action }: { text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div role="status" data-testid="listing-settings-list-message" className="rounded-md border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700">
      <p>{text}</p>
      {action && (
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  );
}

/** "1–50 of 312" [Previous] [Next] on a wide screen; [Load more] on a phone's last page. */
export function ListFooter({ page, rowsOnPage, total, compact, last, onPage, onLoadMore }: {
  page: number;
  rowsOnPage: number;
  total: number;
  compact: boolean;
  last: boolean;
  onPage: (page: number) => void;
  onLoadMore: () => void;
}) {
  const more = hasPageAfter(page, rowsOnPage, total);
  if (compact) {
    if (!last || !more) return null;
    return (
      <Button type="button" variant="outline" className="mt-3 min-h-11 w-full" onClick={onLoadMore}>
        {LISTING_SETTINGS_LIST_WORDS.loadMore}
      </Button>
    );
  }
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-600">
      <span>{listRangeWords(page, rowsOnPage, total)}</span>
      {total > LISTING_SETTINGS_PAGE_SIZE && (
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
            {LISTING_SETTINGS_LIST_WORDS.previous}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!more} onClick={() => onPage(page + 1)}>
            {LISTING_SETTINGS_LIST_WORDS.next}
          </Button>
        </div>
      )}
    </div>
  );
}

/** The actions a page's states offer. */
export interface ListPageActions {
  onRetry: () => void;
  onClearSearch: () => void;
  onShowAll: () => void;
  onFirstPage: () => void;
  onGoToStep1: () => void;
}

/**
 * Every state of one page except its rows, which the tab draws. `noMatch`
 * and `noneShown` are the tab's own words. Over 10,000 sizes the page shows
 * nothing: the banner explains (plan 2D).
 */
export function ListPageStates<Row>({ state, words, actions, children }: {
  state: ListPageView<Row>;
  words: { noMatch: (search: string) => string; noneShown: string };
  actions: ListPageActions;
  children: (rows: Extract<ListPageView<Row>, { kind: "rows" }>) => ReactNode;
}) {
  switch (state.kind) {
    case "loading": return <ListSkeleton />;
    case "too_large": return null;
    case "rate_limited":
      return <ListMessage text={LISTING_SETTINGS_LIST_WORDS.rateLimited} action={{ label: LISTING_SETTINGS_LIST_WORDS.tryAgain, onClick: actions.onRetry }} />;
    case "failed":
      return <ListMessage text={state.message} action={{ label: LISTING_SETTINGS_LIST_WORDS.tryAgain, onClick: actions.onRetry }} />;
    case "nothing_chosen":
      return <ListMessage text={LISTING_SETTINGS_LIST_WORDS.nothingChosen} action={{ label: LISTING_SETTINGS_LIST_WORDS.goToStep1, onClick: actions.onGoToStep1 }} />;
    case "no_match":
      return <ListMessage text={words.noMatch(state.search)} action={{ label: LISTING_SETTINGS_LIST_WORDS.clearSearch, onClick: actions.onClearSearch }} />;
    case "none_shown":
      return <ListMessage text={words.noneShown} action={{ label: LISTING_SETTINGS_LIST_WORDS.showAll, onClick: actions.onShowAll }} />;
    case "past_end":
      return <ListMessage text={LISTING_SETTINGS_LIST_WORDS.pastEnd} action={{ label: LISTING_SETTINGS_LIST_WORDS.firstPage, onClick: actions.onFirstPage }} />;
    case "rows":
      return (
        <div aria-busy={state.refreshing} className={state.refreshing ? "opacity-60" : undefined}>
          {state.notice && <p role="status" className="mb-2 text-sm text-amber-800">{state.notice}</p>}
          {children(state)}
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// The Products tab
// ---------------------------------------------------------------------------

/** The Products tab's own words. */
export const PRODUCTS_TAB_WORDS = Object.freeze({
  columns: Object.freeze({ product: "Product", sizes: "Sizes", price: "Price", ownSettings: "Own settings", status: "Status" }),
  noMatch: (search: string) => `No products match “${search}”.`,
  // Interim.
  noneShown: "No products to show here.",
});

/**
 * The Show chips (R:144, R:589). "No own settings" has no server filter and is
 * left out (S3 dropped). "Exact prices" has no count: the summary counts
 * sizes with an exact price, and the chip lists products (G13).
 */
export const PRODUCT_SHOW_CHIPS = [
  { show: "all", label: "All" },
  { show: "needs_fix", label: "Needs a fix" },
  { show: "sizes_differ", label: "Sizes differ" },
  { show: "own_settings", label: "Own settings" },
  { show: "exact_prices", label: "Exact prices" },
] as const satisfies ReadonlyArray<{ show: ListingSettingsProductFilter; label: string }>;
export type ProductShowChip = (typeof PRODUCT_SHOW_CHIPS)[number]["show"];

/** A chip's count from the summary; null when the summary has none for it. */
export function productShowCount(show: ProductShowChip, summary: ListingSettingsSummary | null | undefined): number | null {
  if (!summary || summary.catalog.state !== "ok") return null;
  switch (show) {
    case "all": return summary.catalog.products;
    case "needs_fix": return summary.counts?.productsNeedingFix ?? null;
    case "sizes_differ": return summary.counts?.productsWithSizesDiffer ?? null;
    case "own_settings": return summary.counts?.productsWithOwnSettings ?? null;
    case "exact_prices": return null;
  }
}

/** "All 312", or "Exact prices" with no count. */
export function productShowLabel(chip: { show: ProductShowChip; label: string }, summary: ListingSettingsSummary | null | undefined): string {
  const count = productShowCount(chip.show, summary);
  return count === null ? chip.label : `${chip.label} ${countText(count)}`;
}

/** The Sizes column: "4", or "2 of 4" when some sizes aren't chosen (R:551). */
export function sizesCellWords(row: Pick<ListingSettingsProductRow, "sizesChosen" | "sizesTotal">): string {
  // A chosen size Card Shellz no longer offers can leave more chosen than offered; the count of chosen ones is then the truth.
  return row.sizesChosen >= row.sizesTotal ? countText(row.sizesChosen) : `${countText(row.sizesChosen)} of ${countText(row.sizesTotal)}`;
}

/** A phone card's sizes: "3 sizes", "1 size", "2 of 4 sizes". */
export function sizesCardWords(row: Pick<ListingSettingsProductRow, "sizesChosen" | "sizesTotal">): string {
  if (row.sizesChosen < row.sizesTotal) return `${countText(row.sizesChosen)} of ${countText(row.sizesTotal)} sizes`;
  return row.sizesChosen === 1 ? "1 size" : `${countText(row.sizesChosen)} sizes`;
}

/** The Price column: "$6.99–$39.99", "$2.99" when every size has one price, "—" when none can be priced. */
export function priceRangeWords(range: ListingSettingsProductRow["priceRange"]): string {
  if (range === null) return "—";
  if (range.minCents === range.maxCents) return formatCents(range.minCents);
  return `${formatCents(range.minCents)}–${formatCents(range.maxCents)}`;
}

/** "Matches: Box of 5 Packs · EG-SLV-STD-5PCK" under a product a search found by one of its sizes (R:589). */
export function matchWords(matched: ListingSettingsProductRow["matchedSize"]): string | null {
  if (matched === null) return null;
  return matched.sku ? `Matches: ${matched.sizeName} · ${matched.sku}` : `Matches: ${matched.sizeName}`;
}

/** Where a product row opens: the size a search matched, else the product. */
export function productTarget(row: Pick<ListingSettingsProductRow, "productId" | "matchedSize">): ListingSettingsProductTarget {
  return row.matchedSize === null
    ? { productId: row.productId }
    : { productId: row.productId, productVariantId: row.matchedSize.productVariantId };
}

const STATUS_TONE_CLASS: Readonly<Record<ProductStatusTone, string>> = {
  fix: "text-red-700",
  differ: "text-amber-800",
  ok: "text-zinc-600",
};

export interface ProductsTabProps extends ListingSettingsListHandlers<ProductShowChip> {
  storeConnectionId: number;
  /** The summary's answer, for the chip counts; null or undefined while it loads or when it failed. */
  summary: ListingSettingsSummary | null | undefined;
  view: ListingSettingsListView<ProductShowChip>;
  /** The phone layout (below 640 px). */
  compact: boolean;
  /** The list can't be read now (more than 10,000 sizes): no reads, controls off, the banner says why. */
  listsOff: boolean;
}

/** The Products tab: search, Show, one row per chosen product, paging. */
export function ProductsTab(props: ProductsTabProps) {
  const { view, compact, listsOff } = props;
  return (
    <div data-testid="listing-settings-products-tab" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ListSearch value={view.searchInput} disabled={listsOff} onChange={props.onSearchInput} />
        {compact && (
          <ListShowSelect
            value={view.show}
            options={PRODUCT_SHOW_CHIPS.map((chip) => ({ show: chip.show, label: productShowLabel(chip, props.summary) }))}
            disabled={listsOff}
            onChange={props.onShow}
          />
        )}
      </div>
      {!compact && <ProductShowChips summary={props.summary} value={view.show} disabled={listsOff} onShow={props.onShow} />}
      {!listsOff && listPagesShown(view, compact).map((page, index, pages) => (
        // One page on a wide screen keeps its place while the next loads; a phone keeps every page it loaded.
        <ProductsPage key={compact ? page : "page"} {...props} page={page} last={index === pages.length - 1} />
      ))}
    </div>
  );
}

function ProductShowChips({ summary, value, disabled, onShow }: {
  summary: ListingSettingsSummary | null | undefined;
  value: ProductShowChip;
  disabled: boolean;
  onShow: (show: ProductShowChip) => void;
}) {
  return (
    <div role="group" aria-label={LISTING_SETTINGS_LIST_WORDS.show} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-zinc-600" aria-hidden="true">{LISTING_SETTINGS_LIST_WORDS.show}:</span>
      {PRODUCT_SHOW_CHIPS.map((chip) => {
        const pressed = chip.show === value;
        return (
          <button
            key={chip.show}
            type="button"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onShow(chip.show)}
            className={`rounded-full border px-3 py-1 text-sm disabled:opacity-50 ${pressed ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white text-zinc-800"}`}
          >
            {productShowLabel(chip, summary)}
          </button>
        );
      })}
    </div>
  );
}

function ProductsPage(props: ProductsTabProps & { page: number; last: boolean }) {
  const { storeConnectionId, view, page } = props;
  const read = useQuery(listingSettingsProductsQueryOptions(storeConnectionId, { search: view.search, show: view.show, page }));
  useReportListTooLarge(read.error, props.onTooLarge);
  return (
    <ProductsPageView
      state={listPageView(read, view)}
      compact={props.compact}
      last={props.last}
      actions={{
        // A refused read shows its reason; Try again reads it once more.
        onRetry: () => void read.refetch(),
        onClearSearch: props.onClearSearch,
        onShowAll: () => props.onShow("all"),
        onFirstPage: () => props.onPage(0),
        onGoToStep1: props.onGoToStep1,
      }}
      onPage={props.onPage}
      onLoadMore={props.onLoadMore}
      onOpenProduct={props.onOpenProduct}
    />
  );
}

export interface ProductsPageViewProps {
  state: ListPageView<ListingSettingsProductRow>;
  compact: boolean;
  /** The last page shown, which carries the footer. */
  last: boolean;
  actions: ListPageActions;
  onPage: (page: number) => void;
  onLoadMore: () => void;
  onOpenProduct: (target: ListingSettingsProductTarget) => void;
}

/** One page of products in any state: a table on a wide screen, cards on a phone. */
export function ProductsPageView({ state, compact, last, actions, onPage, onLoadMore, onOpenProduct }: ProductsPageViewProps) {
  return (
    <ListPageStates state={state} words={PRODUCTS_TAB_WORDS} actions={actions}>
      {(page) => (
        <>
          {compact
            ? <ProductCards rows={page.rows} onOpenProduct={onOpenProduct} />
            : <ProductsTable rows={page.rows} onOpenProduct={onOpenProduct} />}
          <ListFooter page={page.page} rowsOnPage={page.rows.length} total={page.total} compact={compact} last={last} onPage={onPage} onLoadMore={onLoadMore} />
        </>
      )}
    </ListPageStates>
  );
}

function ProductsTable({ rows, onOpenProduct }: { rows: readonly ListingSettingsProductRow[]; onOpenProduct: (target: ListingSettingsProductTarget) => void }) {
  const words = PRODUCTS_TAB_WORDS.columns;
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
      <table className="w-full text-sm" data-testid="listing-settings-products-table">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium text-zinc-600">
            <th scope="col" className="px-3 py-2">{words.product}</th>
            <th scope="col" className="px-3 py-2">{words.sizes}</th>
            <th scope="col" className="px-3 py-2">{words.price}</th>
            <th scope="col" className="px-3 py-2">{words.ownSettings}</th>
            <th scope="col" className="px-3 py-2">{words.status}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const open = () => onOpenProduct(productTarget(row));
            const status = productStatusWords(row);
            const match = matchWords(row.matchedSize);
            return (
              // The whole row opens the drawer for a mouse; the product name is the button for a keyboard.
              <tr key={row.productId} data-testid={`listing-settings-product-${row.productId}`} onClick={open}
                className="cursor-pointer border-b border-zinc-100 align-top last:border-0 hover:bg-zinc-50">
                <td className="px-3 py-2">
                  <button type="button" className="text-left font-medium text-zinc-900 hover:underline"
                    onClick={(event) => { event.stopPropagation(); open(); }}>
                    {row.productName}
                  </button>
                  {match && <div className="text-xs text-zinc-500">{match}</div>}
                </td>
                <td className="px-3 py-2 text-zinc-700">{sizesCellWords(row)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-700">{priceRangeWords(row.priceRange)}</td>
                <td className="px-3 py-2 text-zinc-700">{ownSettingsWords(row)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className={STATUS_TONE_CLASS[status.tone]}>{status.text}</span>
                    <span aria-hidden="true" className="text-zinc-400">›</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Phone cards (R:458-466): name, "3 sizes · $6.99–$39.99", the status with ● when it needs a look, and own settings. */
function ProductCards({ rows, onOpenProduct }: { rows: readonly ListingSettingsProductRow[]; onOpenProduct: (target: ListingSettingsProductTarget) => void }) {
  return (
    <ul className="space-y-2" data-testid="listing-settings-product-cards">
      {rows.map((row) => {
        const status = productStatusWords(row);
        const match = matchWords(row.matchedSize);
        const own = ownSettingsWords(row);
        const price = row.priceRange === null ? null : priceRangeWords(row.priceRange);
        return (
          <li key={row.productId} data-testid={`listing-settings-product-${row.productId}`}>
            <button type="button" onClick={() => onOpenProduct(productTarget(row))}
              className="flex min-h-11 w-full items-start justify-between gap-3 rounded-md border border-zinc-200 bg-white p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0]">
              <span className="min-w-0">
                <span className="block break-words font-medium text-zinc-900">{row.productName}</span>
                {match && <span className="block break-words text-xs text-zinc-500">{match}</span>}
                <span className="block text-sm text-zinc-700">{price === null ? sizesCardWords(row) : `${sizesCardWords(row)} · ${price}`}</span>
                <span className={`block text-sm ${STATUS_TONE_CLASS[status.tone]}`}>
                  {status.tone === "ok" ? status.text : `● ${status.text}`}
                </span>
                {own !== "—" && <span className="block break-words text-xs text-zinc-500">{PRODUCTS_TAB_WORDS.columns.ownSettings}: {own}</span>}
              </span>
              <span aria-hidden="true" className="shrink-0 text-lg leading-5 text-zinc-400">›</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
