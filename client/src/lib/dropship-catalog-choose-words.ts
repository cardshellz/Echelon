/**
 * The vendor's words for Catalog step 1, "Choose what to sell". Words marked
 * "Interim (step 1 PROPOSAL)" are stage 1's, words marked "Kept" are the
 * step's words from before stage 1, and words marked "Stage 3/5 (step 1 plan
 * S2-5)" are PR B's one-time picks (PLAN-B v4.1 §13, PROPOSED), and words
 * marked "Stage 4 (step 1 plan S2-5)" are PR C's listing ends (PLAN-C v4.1
 * §11, PROPOSED; a count of 1 reads in the singular), so a later stage can
 * change them in one place. No function returns a raw reason code or a
 * product-line name (owner Q2). Pure: no React, no network, no clock.
 */
import { SELECTION_CHANGE_CAP } from "@shared/dropship/vendor-selection-changes";
import { formatStatus, type DropshipCatalogListingTier } from "./dropship-ops-surface";

/** "1,433": every count the step shows. */
export function formatChooseCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** The selection cap as the words print it ("10,000"); the server's cap, so the words never drift from it. */
const CAP_WORDS = formatChooseCount(SELECTION_CHANGE_CAP);

/** The How column's words, by `ChooseHow`. */
const HOW_WORDS = Object.freeze({
  // Interim (step 1 PROPOSAL): a size marked to add, not saved yet.
  willAdd: "Will be added",
  // Interim (step 1 PROPOSAL): a size marked to remove, not saved yet.
  willRemove: "Will be removed",
  // Interim (step 1 PROPOSAL): selected by the vendor's own pick of this size.
  picked: "Picked by you",
  // Interim (step 1 PROPOSAL): not picked.
  notSelected: "Not selected",
  // Interim (step 1 PROPOSAL): `disabled_by_vendor_override`.
  turnedOff: "Turned off for you",
  // Interim (step 1 PROPOSAL): `not_exposed_by_admin` (the catalog read drops these; shown only defensively).
  notOffered: "Not offered by Card Shellz",
});

/** The per-store effect lines of the save question: "listing is" or "listings are", by count. */
function listingsAre(n: number): string {
  return n === 1 ? "1 listing is" : `${formatChooseCount(n)} listings are`;
}

/** PR C's end lines: "1 eBay listing" or "3 eBay listings" (§11's "{l} eBay listing(s)"). */
function ebayListings(n: number): string {
  return n === 1 ? "1 eBay listing" : `${formatChooseCount(n)} eBay listings`;
}

export const CHOOSE_WORDS = Object.freeze({
  // Interim (step 1 PROPOSAL): replaces "Choose the variants you want to sell. Catalog selection does not require verification."
  intro: "Check what you want to sell and uncheck what you don't, then press Save changes. Nothing changes on eBay until you save. No verification code needed.",
  // Kept: the card's heading (the browser journeys use it).
  heading: "Available catalog",
  // Kept: the saved count beside the heading.
  selectedBadge: (count: number) => `${formatChooseCount(count)} selected`,
  // Kept.
  loadingSelection: "Loading selection",
  // Kept.
  filtersHeading: "Catalog filters",
  // Kept.
  filtersLine: "Narrow the table without changing what is selected.",
  // Kept.
  searchLabel: "Search",
  // Interim (step 1 PROPOSAL): "variant" becomes "size", step 2's and the owner's word.
  searchPlaceholder: "Product, size, or SKU",
  // Interim (step 1 PROPOSAL): replaces "Selection".
  showLabel: "Show",
  // Interim (step 1 PROPOSAL): replaces "All exposed".
  showAll: "All",
  // Interim (step 1 PROPOSAL): replaces "Selected only". The server filters by what is saved, so the option says so (review DUX1).
  showSelected: "Saved as selected",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Show = `selection=not_selected`.
  showNotSelected: "Not selected",
  // Interim (step 1 PROPOSAL): over the table while Show filters by what is saved and changes aren't saved (review DUX1).
  showSavedNote: "This list shows what is saved. Items you check or uncheck move in or out of it after you save.",
  // Kept.
  categoryLabel: "Category",
  // Kept.
  categoryAll: "All categories",
  // Kept: a category menu option.
  categoryOption: (label: string, rowCount: number) => `${formatStatus(label)} (${rowCount})`,
  // Kept: a row with no category.
  uncategorized: "Uncategorized",
  // Interim (step 1 PROPOSAL): the table's caption, read out only.
  tableCaption: "Items Card Shellz offers you. Check the ones you want to sell.",
  // Interim (step 1 PROPOSAL): Product and Variant merge into Item; "Quantity" becomes "Available"; "Status" becomes "How".
  columns: Object.freeze({ item: "Item", category: "Category", available: "Available", how: "How" }),
  // Interim (step 1 PROPOSAL): the size line under a product's name.
  itemSizeLine: (variantName: string, variantSku: string | null, productVariantId: number) =>
    `${variantName} · ${variantSku || `Size ${productVariantId}`}`,
  // Interim (step 1 PROPOSAL): step 2's words for the same box (dropship-listing-settings-words.ts, selectShown).
  selectAllShown: "Select all shown",
  // Interim (step 1 PROPOSAL): a row's box, read out.
  rowCheckbox: (productName: string, variantName: string) => {
    const product = productName.trim();
    const size = variantName.trim();
    if (product && size) return `Select ${product}, ${size}`;
    if (product || size) return `Select ${product || size}`;
    return "Select this item";
  },
  // Interim (step 1 PROPOSAL): read out for the "—" of a size that isn't selected (the server sends 0, not "out of stock").
  noQuantitySr: "No quantity: not selected",
  // Interim (step 1 PROPOSAL): the How column, each entry marked above.
  how: HOW_WORDS,
  // Interim (step 1 PROPOSAL): under "Turned off for you" when the vendor's own pick of the size is saved; its box removes the pick (verify V6).
  turnedOffPickHint: "You picked it, but it can't be sold now. Uncheck it to remove your pick.",
  // Interim (step 1 PROPOSAL): the line over the table.
  shownLine: (shown: number, total: number) => {
    if (shown < total) return `Showing ${formatChooseCount(shown)} of ${formatChooseCount(total)}`;
    return total === 1 ? "Showing 1 item" : `Showing all ${formatChooseCount(total)}`;
  },
  // Interim (step 1 PROPOSAL): past the most rows the table shows. "Filter", never "choose": choosing is selling here (review DUX5).
  shownCapLine: (shown: number, total: number) =>
    `Showing ${formatChooseCount(shown)} of ${formatChooseCount(total)}. Search, or filter by Category above, to see the rest.`,
  // Interim (step 1 PROPOSAL): every page read, yet fewer rows than the total (a row skipped between pages; review DUX11).
  shownShortLine: (shown: number, total: number) =>
    `Showing ${formatChooseCount(shown)} of ${formatChooseCount(total)}. Search to find the rest.`,
  // Interim (step 1 PROPOSAL).
  loadMore: "Load more",
  // Interim (step 1 PROPOSAL).
  loadingMore: "Loading…",
  // Interim (step 1 PROPOSAL).
  loadMoreFailed: "Couldn't load more items.",
  // Interim (step 1 PROPOSAL).
  tryAgain: "Try again",
  // Interim (step 1 PROPOSAL): no rows under a search, a category or a Show filter.
  emptyFilteredTitle: "No matching items",
  // Interim (step 1 PROPOSAL).
  emptyFilteredText: "No items match your search and filters.",
  // Interim (step 1 PROPOSAL): no rows at all.
  emptyTitle: "No items yet",
  // Interim (step 1 PROPOSAL).
  emptyText: "Card Shellz hasn't offered any items for dropship yet.",
  // Kept.
  catalogFailedTitle: "Catalog unavailable",
  // Interim (step 1 PROPOSAL): replaces "The catalog API request failed."
  catalogFailedText: "The catalog couldn't be loaded.",
  // Interim (step 1 PROPOSAL): the list couldn't be read again after the saved choices moved; its boxes stay off until it can (verify V5).
  listBehindSave: "The list couldn't be refreshed after the last save, so it may not show what is saved. Press Try again.",
  // Interim (step 1 PROPOSAL): the bar, with both numbers always shown.
  pendingLine: (add: number, remove: number) => `Not saved: ${formatChooseCount(add)} to add · ${formatChooseCount(remove)} to remove`,
  // Interim (step 1 PROPOSAL).
  save: "Save changes",
  // Interim (step 1 PROPOSAL).
  saving: "Saving…",
  // Interim (step 1 PROPOSAL).
  undo: "Undo changes",
  // Interim (step 1 PROPOSAL): the bulk parser's 413 (`DROPSHIP_REQUEST_TOO_LARGE`, PLAN-B v4.1 §14 `tooLarge`).
  tooLarge: "These changes are too large to save at once. Change some marked items back, then save.",

  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The categories card's heading.
  categoriesHeading: "Categories",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. One category's line.
  categoryLine: (name: string, selected: number, total: number) =>
    `${name} · ${formatChooseCount(selected)} of ${formatChooseCount(total)} selected`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. A category's box, read out.
  categoryBox: (name: string) => `Select all in ${name}`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. A category's name button, read out.
  categoryShowOnly: (name: string) => `Show only ${name}`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Under the categories list.
  noCategory: "Items with no category aren't listed here. Choose them in the table.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. A category ticked: what it adds, and that later items are not added.
  tickAdds: (n: number, name: string) => `${n === 1 ? `Adds the 1 item in ${name} that isn't selected yet.`
    : `Adds the ${formatChooseCount(n)} items in ${name} that aren't selected yet.`} Items Card Shellz adds to ${name} later aren't added; you'll see them in a notice here instead.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. A category unticked.
  tickRemoves: (n: number, name: string) => (n === 1 ? `Removes the 1 selected item in ${name}.`
    : `Removes all ${formatChooseCount(n)} selected items in ${name}.`),
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Every shown row checked, more match.
  checkAllShown: (shown: number) => `All ${formatChooseCount(shown)} shown are checked.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED.
  checkAll: (total: number) => `Check all ${formatChooseCount(total)} that match`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED.
  uncheckAll: (total: number) => `Uncheck all ${formatChooseCount(total)} that match`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The match count moved since the rows loaded.
  matchChanged: (now: number, was: number) => `${formatChooseCount(now)} now match (was ${formatChooseCount(was)}).`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The id list the change needs is longer than one change takes.
  tooManyMatch: (n: number) => `Too many to change at once (${formatChooseCount(n)}). Search or pick a category to narrow the list.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED.
  selectEverything: (n: number) => `Select everything (${formatChooseCount(n)})`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED.
  everythingAdds: (n: number) =>
    `Adds every item Card Shellz offers that isn't selected yet (${formatChooseCount(n)}). Items Card Shellz adds later aren't added. You'll see a notice for new items in categories you sell from.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The room left under the cap.
  room: (selected: number, room: number) =>
    `You can have up to ${CAP_WORDS} selected. ${selected === 1 ? "1 is" : `${formatChooseCount(selected)} are`} selected, so ${formatChooseCount(Math.max(0, room))} more can be added.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. A growing change over the cap (also the server's 422).
  overCapAdd: (after: number) => `This would make ${formatChooseCount(after)} selected, over the ${CAP_WORDS} limit. Undo some additions to save.`,
  // PR C's 422 DROPSHIP_SELECTION_REMOVAL_TOO_LARGE: a removal whose products have more sizes, or that would end more
  // eBay listings, than one save covers (never the over-cap words, FID-4).
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  tooManyRemoved: "That's too many items to change at once. Remove fewer products in one save.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The saved selection is over the cap.
  overCapState: (selected: number) =>
    `${formatChooseCount(selected)} selected, over the ${CAP_WORDS} limit. Publishing refuses more than ${CAP_WORDS}. Remove some, then publish.`,
  // Interim (step 1 PROPOSAL): the question before every save.
  confirmTitle: "Save your changes?",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The server's counts of the change.
  confirmCounts: (add: number, remove: number, already: number) => {
    const counts = `${formatChooseCount(add)} added · ${formatChooseCount(remove)} removed`;
    if (already <= 0) return counts;
    return `${counts} · ${already === 1 ? "1 was" : `${formatChooseCount(already)} were`} already as you chose`;
  },
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Only what Echelon does on the store (FIDELITY2).
  confirmZero: (store: string, n: number) => `On ${store}: ${listingsAre(n)} set to quantity 0, so buyers can't buy ${n === 1 ? "it" : "them"}.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED (V23): the price is the one on eBay now (#1900 adopts the vendor's eBay price).
  confirmResume: (store: string, n: number) => (n === 1
    ? `On ${store}: 1 listing gets its quantity back shortly after you save, at the price it has on eBay now. To send today's price, publish it in step 3.`
    : `On ${store}: ${formatChooseCount(n)} listings get their quantity back shortly after you save, at the price they have on eBay now. To send today's prices, publish them in step 3.`),
  // Stage 3/5 (step 1 plan S2-5): PROPOSED (V23). No store has any entry.
  confirmNone: "Nothing changes on your eBay listings now.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED.
  confirmScope: "Your choice applies to all your stores.",
  // PR C (PLAN-C v4.1 §11): the eBay listings a removal ends on a store that can be used now (`ends`, storeConnected).
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  confirmEnd: (store: string, n: number) =>
    `On ${store}: ${ebayListings(n)} will be ended. To sell one again later, choose it here and publish it in step 3.`,
  // The same on a store that can't be used now (not `connected`): its ends wait for it, at quantity 0.
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  confirmEndWaitsForStore: (store: string, n: number) =>
    `On ${store}: ${ebayListings(n)} will be ended when the store can be used again. ${n === 1 ? "It stays" : "They stay"} at quantity 0 until then.`,
  // Of the ends above, those of other sizes of a product removed completely (`ends.otherSizes`).
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  confirmEndOtherSizes: (n: number) => (n === 1
    ? "1 of these is a listing of another size of a product you removed completely: a size you removed earlier, or that Card Shellz isn't offering now."
    : `${formatChooseCount(n)} of these are listings of other sizes of products you removed completely: sizes you removed earlier, or that Card Shellz isn't offering now.`),
  // The hidden picks a wholly removed product takes with it (`ends.hiddenRemovedIds`), vendor level.
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  confirmEndHidden: (n: number) =>
    `Removing every size you can see of a product also removes ${formatChooseCount(n)} of its sizes that Card Shellz isn't offering right now.`,
  // Added sizes whose listing Card Shellz is still ending (`ends.stillEnding`): the save never stops an end under way.
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  confirmStillEnding: (n: number) => (n === 1
    ? "1 of the items you're adding is still being ended on eBay. When that's done, publish it again in step 3."
    : `${formatChooseCount(n)} of the items you're adding are still being ended on eBay. When that's done, publish them again in step 3.`),
  // Added sizes whose end failed and waits for Card Shellz (`ends.endReview`).
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  confirmEndReview: (n: number) => (n === 1
    ? "1 of the items you're adding has an eBay listing Card Shellz couldn't end yet. Card Shellz is looking into it; it stays at quantity 0 until then."
    : `${formatChooseCount(n)} of the items you're adding have an eBay listing Card Shellz couldn't end yet. Card Shellz is looking into it; they stay at quantity 0 until then.`),
  // Added sizes whose listing Card Shellz ended (`ends.endedReAdd`): only step 3 publishes them again.
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  confirmEndedReAdd: (n: number) => (n === 1
    ? "1 of the items you're adding was ended on eBay. Publish it in step 3 to sell it again."
    : `${formatChooseCount(n)} of the items you're adding were ended on eBay. Publish them in step 3 to sell them again.`),
  // Interim (step 1 PROPOSAL).
  confirmSave: "Save changes",
  // The question's own button when the save ends any eBay listing (`ends.listingIds`), in place of `confirmSave`.
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  saveEndButton: (n: number) => (n === 1 ? "End 1 listing and save" : `End ${formatChooseCount(n)} listings and save`),
  // Interim (step 1 PROPOSAL).
  confirmCancel: "Cancel",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Added sizes Card Shellz stopped offering.
  skipped: (n: number) => (n === 1 ? "1 is no longer offered by Card Shellz and was skipped."
    : `${formatChooseCount(n)} are no longer offered by Card Shellz and were skipped.`),
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. After a save, from the server's answer.
  saved: (added: number, removed: number) => `Saved. ${formatChooseCount(added)} added, ${formatChooseCount(removed)} removed.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. A removal-only save whose effects moved between the question and the save (§7.5).
  savedDrift: (n: number) => `Saved. A few listings changed on eBay while you were deciding; ${listingsAre(n)} set to quantity 0.`,
  // After `saved` or `savedDrift` when the save ended any eBay listing (the answer's `ends.listingIds`).
  // Stage 4 (step 1 plan S2-5): PROPOSED.
  savedEnding: (n: number) => `${ebayListings(n)} ${n === 1 ? "is" : "are"} being ended.`,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. While the server answers busy and the page sends the same save again.
  savingStill: "Still saving… eBay updates are in progress. Your changes are kept.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Busy past every try.
  busy: "Saving is busy right now. Your changes are kept; try again in a minute.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Replaces stage 1's "…in another tab…": a follow-up tidy can change them too (FIDELITY-6).
  stale: "Your saved choices changed after this page loaded. Review them and save again.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. On the second question after the effects moved.
  effectsChanged: "Something on eBay changed while you were deciding. Check the new numbers and save again.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. While the page sends the same save again during an update.
  paused: "Saving is paused for a few minutes while Card Shellz updates the site. Your changes are kept, and saving will try again by itself.",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. After the paused window (FIDELITY-7).
  pausedStill: "Saving is still paused while Card Shellz updates the site. Your changes are kept; press Save again in a few minutes.",
  // Review round 1 CLI-1, TST-2 (not in §13; owner to confirm): Undo, or every box unticked back, after a save with no
  // sure answer, once the saved choices read again moved past that save's base. Stage 1's reviewed `pendingMoved`,
  // first sentence (the list may still fail to read; it says so itself).
  // Stage 3/5 (step 1 plan S2-5): PROPOSED.
  undoneSaveMoved: "Your saved choices changed: your last save may have gone through, or another tab saved.",
  // Interim (step 1 PROPOSAL): nothing of this save was written (every answer was "try again" with nothing written).
  notSaved: "Your changes weren't saved. Check your connection, then press Save changes again.",
  // Interim (step 1 PROPOSAL): no answer, so the save may have gone through; the next press sends the same save, which replays (review MC1).
  unconfirmed: "We couldn't confirm your save. Press Save changes again to check whether it went through.",
  // Interim (step 1 PROPOSAL): a refusal this page can't fix. Never "reload": that drops every change and fixes nothing (review DUX10).
  rejected: "Your changes couldn't be saved. They're still here. If this keeps happening, contact Card Shellz support.",
  // §4.11 retired: the save once PR B froze the old rules, and PR C's "page outdated". This page is out of date, nothing
  // was saved, and only a reload fixes it (the one refusal where Reload is offered; CHK9). The server sends the same
  // words (server/modules/dropship/domain/catalog-read-words.ts).
  // Stage 2 (step 1 plan S2-5): PROPOSED.
  retired: "This page was updated, so your last changes weren't saved. Reload it and make them again.",
  // Stage 2 (step 1 plan S2-5): PROPOSED. The button beside `retired`.
  reload: "Reload",
});

/**
 * Why a selected SKU's tier is not active, in the vendor's words: what the
 * tier needs and what to change, from the server's reason. The amount is the
 * published one, the same the wallet shows.
 */
export function describeCatalogListingTier(tier: DropshipCatalogListingTier): string {
  const name = tier.tier === "case" ? "Case tier" : "Pack tier";
  const amount = formatCatalogDollars(tier.policyMinimumCents);
  if (tier.reason === "autopay_off") {
    return `The ${name} is not active: autopay is off, so your wallet has no reserve. Turn on autopay with a reserve of at least ${amount} in Wallet.`;
  }
  if (tier.reason === "reserve_below_tier") {
    return `The ${name} is not active: it needs a reserve of ${amount}. Raise your reserve in Wallet.`;
  }
  return `The ${name} is not active: your balance needs to reach ${amount}. You need ${formatCatalogDollars(tier.balanceShortfallCents)} more.`;
}

/** Whole dollars when there are no cents ($500), else both cent digits ($10.50, never $10.5). Display only. */
export function formatCatalogDollars(centsValue: number): string {
  const fractionDigits = centsValue % 100 === 0 ? 0 : 2;
  return `$${(centsValue / 100).toLocaleString("en-US", { minimumFractionDigits: fractionDigits, maximumFractionDigits: 2 })}`;
}
