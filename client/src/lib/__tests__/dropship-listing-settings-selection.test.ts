import { describe, expect, it } from "vitest";
import { MAX_LISTING_SETTING_BULK_PRODUCTS } from "@shared/dropship/listing-setting-values";
import { listingSettingsProductIdsResponseSchema, type ListingSettingsProductIdsResponse } from "@shared/dropship/listing-settings";
import {
  emptySelection,
  idsRequestFor,
  isSelected,
  ListingSettingsSelectionError,
  pageTickState,
  pickSelected,
  reduceListingSettingsSelection,
  sameSelection,
  selectionCount,
  shownForSelection,
  type ListingSettingsSelection,
  type ListingSettingsSelectionAction,
} from "../dropship-listing-settings-selection";

/** The Products tab's ticks and "Select all N" (plan PR 10, 6.2, 6.6, D22). */

const STORE = 22;
const ALL = { search: "", show: "all" } as const;
const SLEEVES = { search: "sleeve", show: "all" } as const;

/** Freezes a selection in place, so a mutation would throw. */
function frozen(selection: ListingSettingsSelection): ListingSettingsSelection {
  Object.freeze(selection.ticked);
  if (selection.all !== null) {
    Object.freeze(selection.all.unticked);
    Object.freeze(selection.all.filter);
    Object.freeze(selection.all);
  }
  return Object.freeze(selection);
}

/** Applies actions in order, freezing every selection on the way. */
function run(actions: readonly ListingSettingsSelectionAction[], start: ListingSettingsSelection = emptySelection(STORE)): ListingSettingsSelection {
  return actions.reduce<ListingSettingsSelection>((selection, action) => reduceListingSettingsSelection(frozen(selection), Object.freeze(action)), start);
}

const ids = (rows: Array<[number, number | null]>): ListingSettingsProductIdsResponse =>
  listingSettingsProductIdsResponseSchema.parse({ total: rows.length, rows: rows.map(([productId, revisionId]) => ({ productId, revisionId })) });

describe("ticking products one by one and a page at a time", () => {
  it("starts with nothing ticked for its store", () => {
    expect(emptySelection(STORE)).toEqual({ storeConnectionId: STORE, ticked: [], all: null });
    expect(selectionCount(emptySelection(STORE))).toBe(0);
    expect(isSelected(emptySelection(STORE), 11)).toBe(false);
  });

  it("toggles one product, keeping the ids ascending", () => {
    const two = run([{ type: "toggle", productId: 12 }, { type: "toggle", productId: 11 }]);
    expect(two).toEqual({ storeConnectionId: STORE, ticked: [11, 12], all: null });
    expect(selectionCount(two)).toBe(2);
    expect(isSelected(two, 11)).toBe(true);
    expect(run([{ type: "toggle", productId: 12 }], two).ticked).toEqual([11]);
  });

  it("ticks the whole page, or unticks it when every product on it is ticked; the header says which", () => {
    const page = [11, 12, 13];
    expect(pageTickState(emptySelection(STORE), page)).toBe("none");
    const one = run([{ type: "toggle", productId: 12 }]);
    expect(pageTickState(one, page)).toBe("some");
    // Some ticked: the header ticks the rest.
    const all = run([{ type: "togglePage", productIds: page }], one);
    expect(all.ticked).toEqual([11, 12, 13]);
    expect(pageTickState(all, page)).toBe("all");
    // Ticks on another page stay when this page is unticked.
    const withOther = run([{ type: "toggle", productId: 99 }], all);
    expect(run([{ type: "togglePage", productIds: page }], withOther).ticked).toEqual([99]);
    expect(pageTickState(emptySelection(STORE), [])).toBe("none");
  });

  it("ignores an id that is not a positive whole number, and an empty page", () => {
    const start = run([{ type: "toggle", productId: 11 }]);
    for (const productId of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(run([{ type: "toggle", productId }], start)).toBe(start);
    }
    expect(run([{ type: "togglePage", productIds: [] }], start)).toBe(start);
    expect(run([{ type: "togglePage", productIds: [0, -2] }], start)).toBe(start);
    expect(run([{ type: "togglePage", productIds: [12, 0] }], start).ticked).toEqual([11, 12]);
  });
});

describe("Select all N (REC:820, D22)", () => {
  it("selects every product the search and filter match, and keeps its filter and total", () => {
    const page = run([{ type: "togglePage", productIds: [11, 12] }]);
    const all = run([{ type: "selectAllMatching", filter: SLEEVES, total: 312 }], page);
    expect(all.all).toEqual({ filter: SLEEVES, total: 312, unticked: [] });
    expect(selectionCount(all)).toBe(312);
    // Every row of the list is ticked, whatever page it is on.
    expect(isSelected(all, 500)).toBe(true);
    expect(pageTickState(all, [400, 401])).toBe("all");
    // The explicit ticks wait underneath for the fallback.
    expect(all.ticked).toEqual([11, 12]);
  });

  it("unticks and ticks again under Select all, and the count follows", () => {
    const all = run([{ type: "togglePage", productIds: [11, 12] }, { type: "selectAllMatching", filter: SLEEVES, total: 312 }]);
    const less = run([{ type: "toggle", productId: 11 }, { type: "toggle", productId: 400 }], all);
    expect(less.all?.unticked).toEqual([11, 400]);
    expect(selectionCount(less)).toBe(310);
    expect(isSelected(less, 11)).toBe(false);
    // An untick is explicit: it leaves the ticks too.
    expect(less.ticked).toEqual([12]);
    const again = run([{ type: "toggle", productId: 400 }], less);
    expect(again.all?.unticked).toEqual([11]);
    expect(again.ticked).toEqual([12, 400]);
    // The header under Select all: a page with an unticked product is "some", and ticks it again.
    expect(pageTickState(again, [11, 12])).toBe("some");
    expect(run([{ type: "togglePage", productIds: [11, 12] }], again).all?.unticked).toEqual([]);
    expect(run([{ type: "togglePage", productIds: [12, 13] }], again).all?.unticked).toEqual([11, 12, 13]);
  });

  it("refuses a total it can't hold: none, more than 10,000, or not a whole number", () => {
    const start = run([{ type: "toggle", productId: 11 }]);
    for (const total of [0, -1, 1.5, Number.NaN, MAX_LISTING_SETTING_BULK_PRODUCTS + 1]) {
      expect(run([{ type: "selectAllMatching", filter: SLEEVES, total }], start)).toBe(start);
    }
    expect(selectionCount(run([{ type: "selectAllMatching", filter: SLEEVES, total: MAX_LISTING_SETTING_BULK_PRODUCTS }], start))).toBe(10_000);
  });
});

describe("what keeps the selection, and what clears it (D22)", () => {
  it("keeps the ticks across a search or filter change, and drops only Select all", () => {
    const ticks = run([{ type: "togglePage", productIds: [11, 12] }]);
    expect(run([{ type: "onListChange", filter: { search: "toploader", show: "needs_fix" } }], ticks)).toBe(ticks);
    const all = run([{ type: "selectAllMatching", filter: SLEEVES, total: 312 }, { type: "toggle", productId: 11 }], ticks);
    // The same search and filter (a refetch, a page change) keep it.
    expect(run([{ type: "onListChange", filter: { search: "sleeve", show: "all" } }], all)).toBe(all);
    for (const filter of [{ search: "sleeves", show: "all" }, { search: "sleeve", show: "needs_fix" }, ALL] as const) {
      const after = run([{ type: "onListChange", filter }], all);
      // The explicit ticks come back, less the one unticked under Select all.
      expect(after).toEqual({ storeConnectionId: STORE, ticked: [12], all: null });
      expect(selectionCount(after)).toBe(1);
    }
  });

  it("keeps the ticks after a confirmed save: the save and the list's re-read change nothing", () => {
    const all = run([{ type: "togglePage", productIds: [11, 12] }, { type: "selectAllMatching", filter: SLEEVES, total: 312 }]);
    // After a save the page reads its lists again with the same search and filter: the list "changes" to itself.
    expect(run([{ type: "onListChange", filter: SLEEVES }], all)).toBe(all);
    expect(selectionCount(all)).toBe(312);
  });

  it("after a save under Select all, counts what its ids read matched, for that search and filter only", () => {
    const all = run([{ type: "selectAllMatching", filter: SLEEVES, total: 312 }, { type: "toggle", productId: 11 }]);
    const matched = run([{ type: "matched", filter: SLEEVES, total: 314 }], all);
    expect(matched).toEqual({ storeConnectionId: STORE, ticked: [], all: { filter: SLEEVES, total: 314, unticked: [11] } });
    expect(selectionCount(matched)).toBe(313);
    // The same count, another filter, ticks only, or a count the bar can't show: nothing changes.
    for (const action of [
      { type: "matched", filter: SLEEVES, total: 312 }, { type: "matched", filter: ALL, total: 314 }, { type: "matched", filter: SLEEVES, total: 0 },
      { type: "matched", filter: SLEEVES, total: 10_001 }, { type: "matched", filter: SLEEVES, total: 1.5 },
    ] as const) expect(run([action], all)).toBe(all);
    // Fewer matches than products unticked since: the bar would count below zero, so nothing changes.
    const twoOff = run([{ type: "selectAllMatching", filter: SLEEVES, total: 3 }, { type: "toggle", productId: 11 }, { type: "toggle", productId: 12 }]);
    expect(run([{ type: "matched", filter: SLEEVES, total: 1 }], twoOff)).toBe(twoOff);
    expect(run([{ type: "matched", filter: SLEEVES, total: 2 }], twoOff).all?.total).toBe(2);
    const ticks = run([{ type: "toggle", productId: 11 }]);
    expect(run([{ type: "matched", filter: SLEEVES, total: 5 }], ticks)).toBe(ticks);
  });

  it("tells equal selections apart from other ones, by value", () => {
    const ticks = run([{ type: "toggle", productId: 12 }, { type: "toggle", productId: 11 }]);
    expect(sameSelection(ticks, run([{ type: "togglePage", productIds: [11, 12] }]))).toBe(true);
    expect(sameSelection(ticks, run([{ type: "toggle", productId: 11 }]))).toBe(false);
    expect(sameSelection(ticks, { ...ticks, storeConnectionId: 23 })).toBe(false);
    const all = run([{ type: "selectAllMatching", filter: SLEEVES, total: 312 }], ticks);
    expect(sameSelection(all, run([{ type: "selectAllMatching", filter: SLEEVES, total: 312 }], ticks))).toBe(true);
    expect(sameSelection(all, ticks)).toBe(false);
    expect(sameSelection(all, run([{ type: "selectAllMatching", filter: SLEEVES, total: 313 }], ticks))).toBe(false);
    expect(sameSelection(all, run([{ type: "selectAllMatching", filter: ALL, total: 312 }], ticks))).toBe(false);
    expect(sameSelection(all, run([{ type: "toggle", productId: 30 }], all))).toBe(false);
  });

  it("clears with Clear and with a store switch, and keeps itself for the same store", () => {
    const all = run([{ type: "togglePage", productIds: [11, 12] }, { type: "selectAllMatching", filter: SLEEVES, total: 312 }]);
    expect(run([{ type: "clear" }], all)).toEqual(emptySelection(STORE));
    const empty = emptySelection(STORE);
    expect(run([{ type: "clear" }], empty)).toBe(empty);
    expect(run([{ type: "store", storeConnectionId: 23 }], all)).toEqual(emptySelection(23));
    expect(run([{ type: "store", storeConnectionId: STORE }], all)).toBe(all);
  });
});

describe("the 10,000 limit (W6's, MAX_LISTING_SETTING_BULK_PRODUCTS)", () => {
  const full = (): ListingSettingsSelection => ({
    storeConnectionId: STORE, ticked: Array.from({ length: MAX_LISTING_SETTING_BULK_PRODUCTS }, (_, index) => index + 1), all: null,
  });

  it("ticks up to 10,000 products and refuses one more, alone or with a page", () => {
    const start = full();
    expect(selectionCount(start)).toBe(10_000);
    expect(run([{ type: "toggle", productId: 20_000 }], start)).toBe(start);
    expect(run([{ type: "togglePage", productIds: [20_000, 20_001] }], start)).toBe(start);
    // Unticking still works, and then one more fits.
    const less = run([{ type: "toggle", productId: 1 }], start);
    expect(selectionCount(less)).toBe(9_999);
    expect(selectionCount(run([{ type: "toggle", productId: 20_000 }], less))).toBe(10_000);
  });
});

describe("idsRequestFor (D6)", () => {
  it("asks for nothing with nothing selected", () => {
    expect(idsRequestFor(emptySelection(STORE))).toBeNull();
    const allUnticked = run([{ type: "selectAllMatching", filter: SLEEVES, total: 1 }, { type: "toggle", productId: 11 }]);
    expect(selectionCount(allUnticked)).toBe(0);
    expect(idsRequestFor(allUnticked)).toBeNull();
  });

  it("asks for every chosen product for ticks, and for the search and filter for Select all", () => {
    expect(idsRequestFor(run([{ type: "toggle", productId: 11 }]))).toEqual({ search: "", show: "all" });
    expect(idsRequestFor(run([{ type: "toggle", productId: 11 }, { type: "selectAllMatching", filter: { search: "sleeve", show: "needs_fix" }, total: 3 }])))
      .toEqual({ search: "sleeve", show: "needs_fix" });
  });
});

describe("pickSelected (plan 6.2, 6.3)", () => {
  it("picks the ticks the read still lists, ascending, each with its revision, and counts the ones left out", () => {
    const ticks = run([{ type: "toggle", productId: 13 }, { type: "toggle", productId: 11 }, { type: "toggle", productId: 99 }]);
    const picked = pickSelected(ids([[14, 1], [13, null], [12, 4], [11, 7]]), ticks);
    expect(picked).toEqual({
      products: [{ productId: 11, expectedRevisionId: 7 }, { productId: 13, expectedRevisionId: null }],
      missing: 1, total: 2, matched: null,
    });
  });

  it("picks every product of Select all's read less the unticked, and says how many match now", () => {
    const all = run([{ type: "selectAllMatching", filter: SLEEVES, total: 3 }, { type: "toggle", productId: 12 }]);
    expect(pickSelected(ids([[11, 1], [12, 2], [13, 3], [14, null]]), all)).toEqual({
      products: [{ productId: 11, expectedRevisionId: 1 }, { productId: 13, expectedRevisionId: 3 }, { productId: 14, expectedRevisionId: null }],
      missing: 0, total: 3, matched: { now: 4, before: 3 },
    });
    expect(pickSelected(ids([]), all)).toEqual({ products: [], missing: 0, total: 0, matched: { now: 0, before: 3 } });
  });

  it("drops products no longer chosen, down to none", () => {
    const ticks = run([{ type: "togglePage", productIds: [11, 12] }]);
    expect(pickSelected(ids([[30, 1]]), ticks)).toEqual({ products: [], missing: 2, total: 0, matched: null });
  });

  it("takes a read of 10,000 products, and refuses a longer list it can never get past the contract", () => {
    const rows: Array<[number, number | null]> = Array.from({ length: MAX_LISTING_SETTING_BULK_PRODUCTS }, (_, index) => [index + 1, index + 1]);
    const all = run([{ type: "selectAllMatching", filter: ALL, total: 10_000 }]);
    expect(pickSelected(ids(rows), all).total).toBe(10_000);
    const tooMany = { total: 10_001, rows: [...ids(rows).rows, { productId: 10_001, revisionId: null }] };
    expect(() => pickSelected(tooMany, all)).toThrow(ListingSettingsSelectionError);
  });

  it("never mutates the answer or the selection", () => {
    const answer = Object.freeze(ids([[12, 2], [11, 1]]));
    Object.freeze(answer.rows);
    answer.rows.forEach((row) => Object.freeze(row));
    const before = JSON.stringify(answer);
    // Frozen all the way down (`frozen`), so sorting or editing the ticks or the unticked in place would throw.
    const ticks = frozen(run([{ type: "togglePage", productIds: [12, 11] }]));
    const all = frozen(run([{ type: "selectAllMatching", filter: ALL, total: 2 }, { type: "toggle", productId: 12 }]));
    const selections = JSON.stringify([ticks, all]);
    expect(pickSelected(answer, ticks).products.map((product) => product.productId)).toEqual([11, 12]);
    expect(pickSelected(answer, all).products.map((product) => product.productId)).toEqual([11]);
    expect(JSON.stringify(answer)).toBe(before);
    expect(JSON.stringify([ticks, all])).toBe(selections);
  });
});

describe("shownForSelection (plan 6.3: what the ticks act on)", () => {
  const page = (total: number, productIds: number[], isPlaceholderData = false) => ({
    data: { total, rows: productIds.map((productId) => ({ productId })) }, isPlaceholderData,
  });

  it("is every product of the pages that answered, ascending and once each, with the list's total", () => {
    expect(shownForSelection([page(120, [12, 11]), page(120, [13, 11])])).toEqual({ productIds: [11, 12, 13], total: 120 });
    expect(shownForSelection([page(0, [])])).toEqual({ productIds: [], total: 0 });
  });

  it("leaves out a page still loading and an older page kept on screen while the next one loads", () => {
    expect(shownForSelection([])).toBeNull();
    expect(shownForSelection([{ data: undefined, isPlaceholderData: false }])).toBeNull();
    expect(shownForSelection([page(312, [11, 12], true)])).toBeNull();
    expect(shownForSelection([page(120, [11]), { data: undefined, isPlaceholderData: false }])).toEqual({ productIds: [11], total: 120 });
  });
});
