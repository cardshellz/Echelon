import { useEffect, useReducer } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import {
  MAX_LISTING_SETTINGS_PAGE,
  MAX_LISTING_SETTINGS_SEARCH_LENGTH,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { PricesTab, type PriceShowOption } from "./PricesTab";
import {
  ProductsTab,
  countText,
  type ListingSettingsListView,
  type ListingSettingsProductTarget,
  type ProductShowChip,
} from "./ProductsTab";

export type { ListingSettingsProductTarget } from "./ProductsTab";

/**
 * The Products and Prices tabs of the Listing settings step (Listing settings
 * PR 7, sub-part 2D; R:92, R:589). Two read-only views over the same
 * selection: one row per chosen product, and one row per chosen size. Each
 * keeps its own search, filter and page, so switching tabs loses nothing.
 *
 * Products is the default tab, and its first read is the only new read on
 * mount (`…/products?search=&show=all&page=0`, plan 4.2). The Prices tab
 * reads only while it is shown. Nothing here saves: a row opens the product
 * drawer through `onOpenProduct`.
 */

/** Typing pauses this long before the list is searched (plan 2D). */
export const LISTING_SETTINGS_SEARCH_DEBOUNCE_MS = 300;

export const LISTING_SETTINGS_TABS = ["products", "prices"] as const;
export type ListingSettingsTab = (typeof LISTING_SETTINGS_TABS)[number];

export interface ListingSettingsTabsView {
  tab: ListingSettingsTab;
  products: ListingSettingsListView<ProductShowChip>;
  prices: ListingSettingsListView<PriceShowOption>;
}

type ListName = "products" | "prices";

export type ListingSettingsTabsAction =
  | { type: "tab"; tab: ListingSettingsTab }
  /** The search box changed; the list is not searched until `apply_search`. */
  | { type: "type_search"; list: ListName; value: string }
  /** Typing paused: search the list for this text. */
  | { type: "apply_search"; list: ListName; search: string }
  | { type: "clear_search"; list: ListName }
  | { type: "show_products"; show: ProductShowChip }
  | { type: "show_prices"; show: PriceShowOption }
  | { type: "page"; list: ListName; page: number }
  | { type: "load_more"; list: ListName }
  /** The step asks for Products with a filter (the attention strip's [See all] and [Show products]). */
  | { type: "request"; show: ProductShowChip };

function initialList<Show extends string>(show: Show): ListingSettingsListView<Show> {
  return { searchInput: "", search: "", show, page: 0, pagesLoaded: 1 };
}

/** Products, every product, first page. */
export function initialListingSettingsTabsView(): ListingSettingsTabsView {
  return { tab: "products", products: initialList("all"), prices: initialList("all") };
}

/** A new search or filter starts the list over at its first page. */
function restart<Show extends string>(list: ListingSettingsListView<Show>, change: Partial<ListingSettingsListView<Show>>): ListingSettingsListView<Show> {
  return { ...list, ...change, page: 0, pagesLoaded: 1 };
}

/** Applies a change to one list; the same list back means nothing changed, and so does the view. */
function updateList(
  view: ListingSettingsTabsView,
  name: ListName,
  update: <Show extends string>(list: ListingSettingsListView<Show>) => ListingSettingsListView<Show>,
): ListingSettingsTabsView {
  if (name === "products") {
    const products = update(view.products);
    return products === view.products ? view : { ...view, products };
  }
  const prices = update(view.prices);
  return prices === view.prices ? view : { ...view, prices };
}

/** The search the server is sent: trimmed, and at most 100 characters as the contract allows. */
export function searchText(value: string): string {
  return value.trim().slice(0, MAX_LISTING_SETTINGS_SEARCH_LENGTH).trimEnd();
}

/** A page number the contract accepts: a whole number from 0 to its last page. Anything else changes nothing. */
function validPage(page: number): boolean {
  return Number.isSafeInteger(page) && page >= 0 && page <= MAX_LISTING_SETTINGS_PAGE;
}

/**
 * What the tabs show next. Pure: no clock, no reads. An action that changes
 * nothing returns the same view, so React skips the render and no read starts.
 */
export function reduceListingSettingsTabsView(view: ListingSettingsTabsView, action: ListingSettingsTabsAction): ListingSettingsTabsView {
  switch (action.type) {
    case "tab":
      return view.tab === action.tab ? view : { ...view, tab: action.tab };
    case "type_search": {
      // The box itself stops at 100 characters; this keeps a pasted value to the same.
      const value = action.value.slice(0, MAX_LISTING_SETTINGS_SEARCH_LENGTH);
      return updateList(view, action.list, (list) => (list.searchInput === value ? list : { ...list, searchInput: value }));
    }
    case "apply_search": {
      const search = searchText(action.search);
      // A pause after Clear search, or after typing back what was searched, asks for nothing new.
      return updateList(view, action.list, (list) => (list.search === search ? list : restart(list, { search })));
    }
    case "clear_search":
      return updateList(view, action.list, (list) => (
        list.searchInput === "" && list.search === "" ? list : restart(list, { searchInput: "", search: "" })));
    case "show_products":
      return view.products.show === action.show ? view : { ...view, products: restart(view.products, { show: action.show }) };
    case "show_prices":
      return view.prices.show === action.show ? view : { ...view, prices: restart(view.prices, { show: action.show }) };
    case "page": {
      const page = action.page;
      if (!validPage(page)) return view;
      return updateList(view, action.list, (list) => (list.page === page ? list : { ...list, page }));
    }
    case "load_more":
      // A phone can load every page the contract has, and no more.
      return updateList(view, action.list, (list) => (
        list.pagesLoaded > MAX_LISTING_SETTINGS_PAGE ? list : { ...list, pagesLoaded: list.pagesLoaded + 1 }));
    case "request":
      return { ...view, tab: "products", products: restart(view.products, { searchInput: "", search: "", show: action.show }) };
  }
}

/** The tab names: "Products · 312" and "Prices · 1,240 sizes" (R:589); no counts while the summary has none. */
export function listingSettingsTabLabels(summary: ListingSettingsSummary | null | undefined): Record<ListingSettingsTab, string> {
  if (!summary || summary.catalog.state !== "ok") return { products: "Products", prices: "Prices" };
  const { products, sizes } = summary.catalog;
  return {
    products: `Products · ${countText(products)}`,
    prices: `Prices · ${countText(sizes)} ${sizes === 1 ? "size" : "sizes"}`,
  };
}

/** Whether the lists can be read: not over 10,000 sizes (R:521), whether the summary or the step says so. */
export function listingSettingsListsOff(input: { readOnly: boolean; summary: ListingSettingsSummary | null | undefined }): boolean {
  return input.readOnly || input.summary?.catalog.state === "too_large";
}

/** A request from the step: open Products with this filter. A new `key` each time; one key is applied once. */
export interface ListingSettingsTabsRequest {
  key: number;
  show: ProductShowChip;
}

export interface ListingSettingsTabsProps {
  storeConnectionId: number;
  /** The summary read's answer, for the tab and chip counts; null or undefined while it loads or when it failed. */
  summary: ListingSettingsSummary | null | undefined;
  /**
   * True while the lists can't be used: more than 10,000 sizes are chosen
   * (R:521). The lists are not read, their controls are off, and the banner
   * says why. The summary's own `too_large` does the same.
   */
  readOnly: boolean;
  /** A row's product, or a size's [Change]: open the drawer there. */
  onOpenProduct: (target: ListingSettingsProductTarget) => void;
  onGoToStep1: () => void;
  /** Set by the step to show Products with a filter, e.g. "Needs a fix" from the attention strip. */
  request?: ListingSettingsTabsRequest | null;
  /** A list read refused because more than 10,000 sizes are chosen: the step shows the banner (plan 4.4). */
  onTooLarge?: (error: unknown) => void;
}

/**
 * Searches a list once typing in its box pauses. Every change to the box
 * starts the wait again, including typing back a search that Clear search
 * emptied; `useDebounce` would keep its old value then and never search.
 * The reducer ignores a search that is already the list's.
 */
function useSearchPause(list: ListName, searchInput: string, dispatch: (action: ListingSettingsTabsAction) => void) {
  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: "apply_search", list, search: searchInput }), LISTING_SETTINGS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [list, searchInput, dispatch]);
}

/** The two tabs, each with its own search, Show filter and paging. */
export function ListingSettingsTabs(props: ListingSettingsTabsProps) {
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const [view, dispatch] = useReducer(reduceListingSettingsTabsView, undefined, initialListingSettingsTabsView);
  const listsOff = listingSettingsListsOff(props);
  const labels = listingSettingsTabLabels(props.summary);

  useSearchPause("products", view.products.searchInput, dispatch);
  useSearchPause("prices", view.prices.searchInput, dispatch);

  const requestKey = props.request?.key ?? null;
  const requestShow = props.request?.show ?? null;
  useEffect(() => {
    if (requestKey !== null && requestShow !== null) dispatch({ type: "request", show: requestShow });
  }, [requestKey, requestShow]);

  const listHandlers = (list: ListName) => ({
    onSearchInput: (value: string) => dispatch({ type: "type_search", list, value }),
    onClearSearch: () => dispatch({ type: "clear_search", list }),
    onPage: (page: number) => dispatch({ type: "page", list, page }),
    onLoadMore: () => dispatch({ type: "load_more", list }),
    onOpenProduct: props.onOpenProduct,
    onGoToStep1: props.onGoToStep1,
    onTooLarge: props.onTooLarge,
  });

  return (
    <section data-testid="listing-settings-tabs" aria-label="Products and prices" className="space-y-3">
      <Tabs
        value={view.tab}
        onValueChange={(value) => {
          const tab = LISTING_SETTINGS_TABS.find((name) => name === value);
          if (tab) dispatch({ type: "tab", tab });
        }}
      >
        <TabsList className="grid h-auto w-full grid-cols-2 sm:inline-flex sm:w-auto">
          <TabsTrigger value="products" className="min-h-9">{labels.products}</TabsTrigger>
          <TabsTrigger value="prices" className="min-h-9">{labels.prices}</TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="mt-3">
          <ProductsTab
            {...listHandlers("products")}
            storeConnectionId={props.storeConnectionId}
            summary={props.summary}
            view={view.products}
            compact={compact}
            listsOff={listsOff}
            onShow={(show) => dispatch({ type: "show_products", show })}
          />
        </TabsContent>
        <TabsContent value="prices" className="mt-3">
          <PricesTab
            {...listHandlers("prices")}
            storeConnectionId={props.storeConnectionId}
            view={view.prices}
            compact={compact}
            listsOff={listsOff}
            onShow={(show) => dispatch({ type: "show_prices", show })}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
