import { MAX_LISTING_SETTING_BULK_PRODUCTS } from "@shared/dropship/listing-setting-values";
import type { ListingSettingsProductIdsResponse } from "@shared/dropship/listing-settings";
import type { ListingSettingsProductFilter, ListingSettingsProductIdsRequest } from "./dropship-listing-settings";

/**
 * The products the vendor ticks on the Products tab, for "Set for selected"
 * (Listing settings PR 10, plan 6.2, 6.3, D22): one by one, a page at a time,
 * or "Select all N" that match the search and filter.
 *
 * Rules this module keeps (D22):
 * - Ticks are kept after a confirmed save and across search and filter
 *   changes; "Select all N" falls back to the explicit ticks when the search
 *   or filter changes. [Clear] and a store switch clear the selection, and
 *   so does leaving the step (the state goes with the page).
 * - At most 10,000 products (`MAX_LISTING_SETTING_BULK_PRODUCTS`, W6's
 *   limit): a tick past it changes nothing.
 * - "Select all N" is exactly the products the list matched for its search
 *   and filter, less the ones unticked since; ticks made under another search
 *   wait underneath for the fallback (PROPOSAL: the bar's count is then what
 *   a save names).
 * - The sheet's products and revisions come from the ids read made when it
 *   opens (`idsRequestFor`, `pickSelected`; D6), never from the list's pages.
 *
 * Pure: no React, no network, no clock. Never mutates its input; ids are
 * kept ascending, so equal selections are equal values.
 */

/** The list's search and filter as it was last asked for them (the box after its pause, not as typed). */
export interface ListingSettingsSelectionFilter {
  readonly search: string;
  readonly show: ListingSettingsProductFilter;
}

/** "Select all N": every product matching `filter` (`total` when pressed), less those unticked since. */
export interface ListingSettingsSelectAll {
  readonly filter: ListingSettingsSelectionFilter;
  readonly total: number;
  readonly unticked: readonly number[];
}

export interface ListingSettingsSelection {
  readonly storeConnectionId: number;
  /** Products ticked one by one or a page at a time, ascending. */
  readonly ticked: readonly number[];
  /** "Select all N", or null when it isn't on. */
  readonly all: ListingSettingsSelectAll | null;
}

export type ListingSettingsSelectionAction =
  /** One row's checkbox. */
  | { type: "toggle"; productId: number }
  /** The header checkbox: ticks every product on the page, or unticks them when all are ticked. */
  | { type: "togglePage"; productIds: readonly number[] }
  /** [Select all N] for the list's search and filter, with the list's total. */
  | { type: "selectAllMatching"; filter: ListingSettingsSelectionFilter; total: number }
  | { type: "clear" }
  /** The list was asked for another search or filter: "Select all N" falls back to the ticks (D22). */
  | { type: "onListChange"; filter: ListingSettingsSelectionFilter }
  /**
   * A confirmed save under "Select all N" for `filter` named the products its
   * ids read matched (`total`): the bar counts what matches now, as the sheet did (D22).
   */
  | { type: "matched"; filter: ListingSettingsSelectionFilter; total: number }
  /** The step shows another store: its own, empty selection. */
  | { type: "store"; storeConnectionId: number };

/** Nothing ticked for this store. */
export function emptySelection(storeConnectionId: number): ListingSettingsSelection {
  return { storeConnectionId, ticked: [], all: null };
}

function isProductId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function ascending(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function sameFilter(left: ListingSettingsSelectionFilter, right: ListingSettingsSelectionFilter): boolean {
  return left.search === right.search && left.show === right.show;
}

/** Whether two selections tick the same products the same way: the same store, ticks and "Select all N". */
export function sameSelection(left: ListingSettingsSelection, right: ListingSettingsSelection): boolean {
  if (left === right) return true;
  if (left.storeConnectionId !== right.storeConnectionId || !sameIds(left.ticked, right.ticked)) return false;
  if (left.all === null || right.all === null) return left.all === right.all;
  return sameFilter(left.all.filter, right.all.filter) && left.all.total === right.all.total && sameIds(left.all.unticked, right.all.unticked);
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Whether a row's checkbox is ticked. */
export function isSelected(selection: ListingSettingsSelection, productId: number): boolean {
  if (selection.all !== null) return !selection.all.unticked.includes(productId);
  return selection.ticked.includes(productId);
}

/** How many products a save would name, as far as the page knows before the sheet's ids read (the bar's "3 selected"). */
export function selectionCount(selection: ListingSettingsSelection): number {
  return selection.all !== null ? selection.all.total - selection.all.unticked.length : selection.ticked.length;
}

/** The header checkbox: every product on the page ticked, some, or none. */
export function pageTickState(selection: ListingSettingsSelection, productIds: readonly number[]): "all" | "some" | "none" {
  const ticked = productIds.filter((productId) => isSelected(selection, productId)).length;
  if (ticked === 0) return "none";
  return ticked === productIds.length ? "all" : "some";
}

/** Ticks (`on`) or unticks the products, under "Select all N" too; past the 10,000 limit nothing changes. */
function setTicked(selection: ListingSettingsSelection, productIds: readonly number[], on: boolean): ListingSettingsSelection {
  const ids = ascending(productIds.filter(isProductId));
  if (ids.length === 0) return selection;
  const ticked = new Set(selection.ticked);
  for (const productId of ids) {
    if (on) ticked.add(productId);
    else ticked.delete(productId);
  }
  if (ticked.size > MAX_LISTING_SETTING_BULK_PRODUCTS) return selection;
  let all = selection.all;
  if (all !== null) {
    const unticked = new Set(all.unticked);
    for (const productId of ids) {
      if (on) unticked.delete(productId);
      else unticked.add(productId);
    }
    all = { ...all, unticked: ascending(unticked) };
  }
  return { ...selection, ticked: ascending(ticked), all };
}

/**
 * The selection after an action (D22). An action that changes nothing
 * returns the same selection, so React skips the render.
 */
export function reduceListingSettingsSelection(
  selection: ListingSettingsSelection,
  action: ListingSettingsSelectionAction,
): ListingSettingsSelection {
  switch (action.type) {
    case "toggle":
      if (!isProductId(action.productId)) return selection;
      return setTicked(selection, [action.productId], !isSelected(selection, action.productId));
    case "togglePage": {
      const ids = action.productIds.filter(isProductId);
      if (ids.length === 0) return selection;
      return setTicked(selection, ids, pageTickState(selection, ids) !== "all");
    }
    case "selectAllMatching": {
      const { total } = action;
      if (!Number.isSafeInteger(total) || total < 1 || total > MAX_LISTING_SETTING_BULK_PRODUCTS) return selection;
      const filter = { search: action.filter.search, show: action.filter.show };
      return { ...selection, all: { filter, total, unticked: [] } };
    }
    case "clear":
      return selection.ticked.length === 0 && selection.all === null ? selection : emptySelection(selection.storeConnectionId);
    case "onListChange":
      // Only "Select all N" belongs to a search and filter; the ticks stay (D22).
      return selection.all === null || sameFilter(selection.all.filter, action.filter) ? selection : { ...selection, all: null };
    case "matched": {
      const { all } = selection;
      const { total } = action;
      if (all === null || !sameFilter(all.filter, action.filter) || total === all.total) return selection;
      // A count the bar can't show (fewer matches than products unticked since) changes nothing.
      if (!Number.isSafeInteger(total) || total < 1 || total > MAX_LISTING_SETTING_BULK_PRODUCTS || total < all.unticked.length) return selection;
      return { ...selection, all: { ...all, total } };
    }
    case "store":
      return action.storeConnectionId === selection.storeConnectionId ? selection : emptySelection(action.storeConnectionId);
  }
}

/**
 * The ids read the sheet makes when it opens (D6): the search and filter for
 * "Select all N", else every chosen product, which the ticks are picked from.
 * Null when nothing is selected.
 */
export function idsRequestFor(selection: ListingSettingsSelection): ListingSettingsProductIdsRequest | null {
  if (selectionCount(selection) <= 0) return null;
  if (selection.all !== null) return { search: selection.all.filter.search, show: selection.all.filter.show };
  return { search: "", show: "all" };
}

/** One page of the Products list as its read holds it: the parts the ticks need. */
export interface ShownProductsPage {
  data?: { total: number; rows: readonly { productId: number }[] } | undefined;
  /** The rows are an older page's, kept on screen while this one loads. */
  isPlaceholderData: boolean;
}

/** The products the list shows now, with the list's total: what "Select all N" and the phone's "Select all shown" act on. */
export interface ShownProducts {
  productIds: number[];
  total: number;
}

/**
 * The products the vendor sees ticks for (a wide page, or every page a phone
 * loaded), from those pages' reads: only pages that answered for the list as
 * asked now, never an older page kept on screen while the next loads. Null
 * while none has.
 */
export function shownForSelection(pages: readonly ShownProductsPage[]): ShownProducts | null {
  const answered = pages.filter((page) => page.data !== undefined && !page.isPlaceholderData);
  if (answered.length === 0) return null;
  return {
    productIds: ascending(answered.flatMap((page) => page.data!.rows.map((row) => row.productId))),
    total: answered[0].data!.total,
  };
}

/** One product a save names, with the revision of its own settings the ids read gave (null: none yet). */
export interface PickedProduct {
  readonly productId: number;
  readonly expectedRevisionId: number | null;
}

/** The products a "Set for selected" save names, from the sheet's ids read. */
export interface PickedProducts {
  /** Ascending ids, each with its revision; at most 10,000. */
  readonly products: readonly PickedProduct[];
  /** Ticked products the read no longer lists (no longer chosen): left out of the save (6.3). */
  readonly missing: number;
  /** `products.length`: the sheet's "Set for 312 products". */
  readonly total: number;
  /** "Select all N" only: how many match now and how many did when it was pressed ("312 now match (was 310)."); null for ticks. */
  readonly matched: { readonly now: number; readonly before: number } | null;
}

/** A selection this page can't send: more products than W6 takes. A programming fault, never shown. */
export class ListingSettingsSelectionError extends Error {
  readonly code = "DROPSHIP_LISTING_SETTINGS_SELECTION_INVALID";
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "ListingSettingsSelectionError";
    this.context = Object.freeze({ ...context });
  }
}

/**
 * The products a save names, from the ids read `idsRequestFor` asked for:
 * the ticks it still lists, or every product it lists less the ones unticked
 * since "Select all N". Each keeps the revision the read gave, which the save
 * sends back (D6).
 */
export function pickSelected(answer: ListingSettingsProductIdsResponse, selection: ListingSettingsSelection): PickedProducts {
  const unticked = new Set(selection.all?.unticked ?? []);
  const ticked = new Set(selection.ticked);
  const rows = selection.all !== null
    ? answer.rows.filter((row) => !unticked.has(row.productId))
    : answer.rows.filter((row) => ticked.has(row.productId));
  const products = rows
    .map((row) => ({ productId: row.productId, expectedRevisionId: row.revisionId }))
    .sort((left, right) => left.productId - right.productId);
  // The read's contract lists at most 10,000 rows; a longer answer was refused before it got here.
  if (products.length > MAX_LISTING_SETTING_BULK_PRODUCTS) {
    throw new ListingSettingsSelectionError("A save can name at most 10,000 products.", { count: products.length });
  }
  return {
    products,
    missing: selection.all !== null ? 0 : selection.ticked.length - products.length,
    total: products.length,
    matched: selection.all !== null ? { now: answer.total, before: selection.all.total } : null,
  };
}
