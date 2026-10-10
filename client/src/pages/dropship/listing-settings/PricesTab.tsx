import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import type { ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import { listingSettingsPricesQueryOptions, type ListingSettingsPriceFilter } from "@/lib/dropship-listing-settings";
import { builtFromWords, formatCents, retailFallbackFixWords } from "@/lib/dropship-listing-settings-price-words";
import {
  ListFooter,
  ListPageStates,
  ListSearch,
  ListShowSelect,
  listPageView,
  listPagesShown,
  useReportListTooLarge,
  type ListPageActions,
  type ListPageView,
  type ListingSettingsListHandlers,
  type ListingSettingsListView,
  type ListingSettingsProductTarget,
} from "./ProductsTab";

/**
 * The Prices tab of the Listing settings step (Listing settings PR 7,
 * sub-part 2D; record M6, R:336-360): every chosen size's price, what it is
 * built from and the vendor's cost, read-only. [Change] opens the product
 * drawer on that size with its Exact price box focused (R:360); nothing here
 * saves. `GET …/listing-settings/prices`, 50 rows a page, read only while
 * this tab is shown.
 *
 * Price words come from dropship-listing-settings-price-words.ts (1A), so a
 * size reads the same here, in the drawer and in the price check.
 */

/** The Prices tab's own words. */
export const PRICES_TAB_WORDS = Object.freeze({
  columns: Object.freeze({ size: "Product · size", price: "Price", builtFrom: "Built from", cost: "Your cost", actions: "Notes" }),
  change: "Change",
  yourCost: "Your cost",
  noMatch: (search: string) => `No sizes match “${search}”.`, // interim: the record words the Products list only
  // Interim.
  noneShown: "No sizes to show here.",
  belowCost: "! Below cost",
  noPrice: "● No price",
  // Interim: the Show filter lists these; the row says why it is there.
  paused: "Paused on eBay",
});

/**
 * Show [All ▾] (R:360, adjusted). "Store default", "Category price" and "This
 * product's price" have no server filter or no data in PR 7. "Retail price, no
 * store price" lists sizes that follow the pricing rules and use their retail
 * price (owner answer A3). No option carries a count (A4).
 */
export const PRICE_SHOW_OPTIONS = [
  { show: "all", label: "All" },
  { show: "exact_prices", label: "Exact price" },
  { show: "below_cost", label: "Below your cost" },
  { show: "cannot_price", label: "Can't be priced" },
  { show: "paused", label: "Paused on eBay" },
  { show: "retail_fallback", label: "Retail price, no store price" },
] as const satisfies ReadonlyArray<{ show: ListingSettingsPriceFilter; label: string }>;
export type PriceShowOption = (typeof PRICE_SHOW_OPTIONS)[number]["show"];

/** "Easy Glide · Pack of 100": rows always name the size, never only the product (R:235). */
export function sizeTitle(price: Pick<ListingSettingsSizePrice, "productName" | "sizeName">): string {
  return `${price.productName} · ${price.sizeName}`;
}

/** An amount, or "—" when there is none. */
export function centsOrDash(cents: number | null): string {
  return cents === null ? "—" : formatCents(cents);
}

export type PriceNoteTone = "warn" | "stop";
export interface PriceNote {
  tone: PriceNoteTone;
  text: string;
}

/** The notes beside a size (R:343-354): "! Below cost", "● No price", and "Paused on eBay". Never a block. */
export function priceNotes(price: Pick<ListingSettingsSizePrice, "priceCents" | "belowCostByCents" | "pausedSince">): PriceNote[] {
  const notes: PriceNote[] = [];
  if (price.priceCents === null) notes.push({ tone: "stop", text: PRICES_TAB_WORDS.noPrice });
  if (price.belowCostByCents !== null) notes.push({ tone: "warn", text: PRICES_TAB_WORDS.belowCost });
  if (price.pausedSince !== null) notes.push({ tone: "warn", text: PRICES_TAB_WORDS.paused });
  return notes;
}

/** Where [Change] opens: this size, in its product's drawer. */
export function sizeTarget(price: Pick<ListingSettingsSizePrice, "productId" | "productVariantId">): ListingSettingsProductTarget {
  return { productId: price.productId, productVariantId: price.productVariantId };
}

const NOTE_TONE_CLASS: Readonly<Record<PriceNoteTone, string>> = {
  warn: "text-amber-800",
  stop: "text-red-700",
};

export interface PricesTabProps extends ListingSettingsListHandlers<PriceShowOption> {
  storeConnectionId: number;
  view: ListingSettingsListView<PriceShowOption>;
  /** The phone layout (below 640 px). */
  compact: boolean;
  /** The list can't be read now (more than 10,000 sizes): no reads, controls off, the banner says why. */
  listsOff: boolean;
}

/** The Prices tab: search, Show, one row per chosen size, paging. */
export function PricesTab(props: PricesTabProps) {
  const { view, compact, listsOff } = props;
  return (
    <div data-testid="listing-settings-prices-tab" className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <ListSearch value={view.searchInput} disabled={listsOff} onChange={props.onSearchInput} />
        <ListShowSelect value={view.show} options={PRICE_SHOW_OPTIONS} disabled={listsOff} onChange={props.onShow} />
      </div>
      {!listsOff && listPagesShown(view, compact).map((page, index, pages) => (
        <PricesPage key={compact ? page : "page"} {...props} page={page} last={index === pages.length - 1} />
      ))}
    </div>
  );
}

function PricesPage(props: PricesTabProps & { page: number; last: boolean }) {
  const { storeConnectionId, view, page } = props;
  const read = useQuery(listingSettingsPricesQueryOptions(storeConnectionId, { search: view.search, show: view.show, page }));
  useReportListTooLarge(read.error, props.onTooLarge);
  return (
    <PricesPageView
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

export interface PricesPageViewProps {
  state: ListPageView<ListingSettingsSizePrice>;
  compact: boolean;
  /** The last page shown, which carries the footer. */
  last: boolean;
  actions: ListPageActions;
  onPage: (page: number) => void;
  onLoadMore: () => void;
  onOpenProduct: (target: ListingSettingsProductTarget) => void;
}

/** One page of sizes in any state: a table on a wide screen, cards on a phone. */
export function PricesPageView({ state, compact, last, actions, onPage, onLoadMore, onOpenProduct }: PricesPageViewProps) {
  return (
    <ListPageStates state={state} words={PRICES_TAB_WORDS} actions={actions}>
      {(page) => (
        <>
          {compact
            ? <PriceCards rows={page.rows} onOpenProduct={onOpenProduct} />
            : <PricesTable rows={page.rows} onOpenProduct={onOpenProduct} />}
          <ListFooter page={page.page} rowsOnPage={page.rows.length} total={page.total} compact={compact} last={last} onPage={onPage} onLoadMore={onLoadMore} />
        </>
      )}
    </ListPageStates>
  );
}

/** "Built from" and, for a size on its retail price because no pricing rule covers it, the fix (owner decision L1). */
function BuiltFrom({ price }: { price: ListingSettingsSizePrice }) {
  const fix = retailFallbackFixWords(price);
  return (
    <>
      <span className="block break-words">{builtFromWords(price)}</span>
      {fix && <span className="block text-amber-800">{fix}</span>}
    </>
  );
}

function Notes({ notes }: { notes: readonly PriceNote[] }) {
  if (notes.length === 0) return null;
  return (
    <span className="flex flex-col">
      {notes.map((note) => <span key={note.text} className={`whitespace-nowrap ${NOTE_TONE_CLASS[note.tone]}`}>{note.text}</span>)}
    </span>
  );
}

function ChangeButton({ price, onOpenProduct, className }: {
  price: ListingSettingsSizePrice;
  onOpenProduct: (target: ListingSettingsProductTarget) => void;
  className?: string;
}) {
  return (
    <Button type="button" variant="outline" size="sm" className={className}
      aria-label={`${PRICES_TAB_WORDS.change} ${sizeTitle(price)}`} onClick={() => onOpenProduct(sizeTarget(price))}>
      {PRICES_TAB_WORDS.change}
    </Button>
  );
}

function PricesTable({ rows, onOpenProduct }: { rows: readonly ListingSettingsSizePrice[]; onOpenProduct: (target: ListingSettingsProductTarget) => void }) {
  const words = PRICES_TAB_WORDS.columns;
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white">
      <table className="w-full text-sm" data-testid="listing-settings-prices-table">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium text-zinc-600">
            <th scope="col" className="px-3 py-2">{words.size}</th>
            <th scope="col" className="px-3 py-2">{words.price}</th>
            <th scope="col" className="px-3 py-2">{words.builtFrom}</th>
            <th scope="col" className="px-3 py-2">{words.cost}</th>
            <th scope="col" className="px-3 py-2"><span className="sr-only">{words.actions}</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((price) => (
            <tr key={price.productVariantId} data-testid={`listing-settings-size-${price.productVariantId}`}
              className="border-b border-zinc-100 align-top last:border-0">
              <td className="px-3 py-2">
                <div className="font-medium text-zinc-900">{sizeTitle(price)}</div>
                {price.sku && <div className="font-mono text-xs text-zinc-500">{price.sku}</div>}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-zinc-900">{centsOrDash(price.priceCents)}</td>
              <td className="px-3 py-2 text-zinc-700"><BuiltFrom price={price} /></td>
              <td className="whitespace-nowrap px-3 py-2 text-zinc-700">{centsOrDash(price.costCents)}</td>
              <td className="px-3 py-2">
                <div className="flex flex-col items-start gap-1">
                  <Notes notes={priceNotes(price)} />
                  <ChangeButton price={price} onOpenProduct={onOpenProduct} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Phone cards: the size, its price, what it is built from, the cost and notes, then [Change]. */
function PriceCards({ rows, onOpenProduct }: { rows: readonly ListingSettingsSizePrice[]; onOpenProduct: (target: ListingSettingsProductTarget) => void }) {
  return (
    <ul className="space-y-2" data-testid="listing-settings-price-cards">
      {rows.map((price) => (
        <li key={price.productVariantId} data-testid={`listing-settings-size-${price.productVariantId}`}
          className="rounded-md border border-zinc-200 bg-white p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="break-words font-medium text-zinc-900">{sizeTitle(price)}</div>
              {price.sku && <div className="break-all font-mono text-xs text-zinc-500">{price.sku}</div>}
            </div>
            <div className="shrink-0 font-medium text-zinc-900">{centsOrDash(price.priceCents)}</div>
          </div>
          <div className="mt-1 text-zinc-700"><BuiltFrom price={price} /></div>
          {price.costCents !== null && <div className="text-zinc-700">{PRICES_TAB_WORDS.yourCost} {formatCents(price.costCents)}</div>}
          <div className="mt-1"><Notes notes={priceNotes(price)} /></div>
          <ChangeButton price={price} onOpenProduct={onOpenProduct} className="mt-2 min-h-11 w-full" />
        </li>
      ))}
    </ul>
  );
}
