/**
 * The vendor's words for Catalog step 1, "Choose what to sell" (step 1 stage
 * 1). Words marked "Interim (step 1 PROPOSAL)" are new in stage 1 and live
 * here only, so a later stage can change them in one place; words marked
 * "kept" are the step's words from before stage 1. No function returns a raw
 * reason code or a product-line name (owner Q2). Pure: no React, no network,
 * no clock.
 */
import { formatStatus, type DropshipCatalogListingTier } from "./dropship-ops-surface";

/** "1,433": every count the step shows. */
export function formatChooseCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** The How column's words, by `ChooseHow`. */
const HOW_WORDS = Object.freeze({
  // Interim (step 1 PROPOSAL): a size marked to add, not saved yet.
  willAdd: "Will be added",
  // Interim (step 1 PROPOSAL): a size marked to remove, not saved yet.
  willRemove: "Will be removed",
  // Interim (step 1 PROPOSAL): selected by the vendor's own pick of this size.
  picked: "Picked by you",
  // Interim (step 1 PROPOSAL): selected only by an older, broader rule (category, product, product line or whole catalog).
  olderInclude: "Selected by an older setting",
  // Interim (step 1 PROPOSAL): kept out by the vendor's own keep-out for this size.
  removed: "Removed by you",
  // Interim (step 1 PROPOSAL): kept out by an older, broader rule; the box is off.
  olderExclude: "Kept out by an older setting",
  // Interim (step 1 PROPOSAL): no rule selects it.
  notSelected: "Not selected",
  // Interim (step 1 PROPOSAL): `disabled_by_vendor_override`; the box is off.
  turnedOff: "Turned off for you",
  // Interim (step 1 PROPOSAL): `not_exposed_by_admin` (the catalog read drops these; shown only defensively).
  notOffered: "Not offered by Card Shellz",
  // Interim (step 1 PROPOSAL): selected, while the saved choices load.
  selected: "Selected",
  // Interim (step 1 PROPOSAL): kept out, while the saved choices load.
  keptOut: "Kept out",
});

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
  // Interim (step 1 PROPOSAL): over the table while Show is "Saved as selected" and changes aren't saved (review DUX1).
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
  // Interim (step 1 PROPOSAL): under "Removed by you".
  removedHint: "Check it to sell it again.",
  // Interim (step 1 PROPOSAL): under "Selected by an older setting" (review DUX6): unchecking writes a keep-out for this size.
  olderIncludeHint: "Uncheck it to keep it out.",
  // Interim (step 1 PROPOSAL): under "Kept out by an older setting" (review DUX6). Never names the setting (owner Q2) or offers a rule (Q3).
  olderExcludeHint: "Contact Card Shellz support to change this setting.",
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
  // Interim (step 1 PROPOSAL): no rows under a search, a category or Show = Selected.
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
  // Interim (step 1 PROPOSAL): an answer that is not the catalog's contract.
  catalogUnreadable: "The catalog couldn't be read. Reload the page.",
  // Interim (step 1 PROPOSAL): the list couldn't be read again after the saved choices moved; its boxes stay off until it can (verify V5).
  listBehindSave: "The list couldn't be refreshed after the last save, so it may not show what is saved. Press Try again.",
  // Interim (step 1 PROPOSAL): the saved choices failed to load; boxes and Save stay off.
  rulesFailed: "Your saved choices couldn't be loaded, so changes can't be saved yet.",
  // Interim (step 1 PROPOSAL): an answer that is not the rules' contract.
  rulesUnreadable: "Your saved choices couldn't be read. Reload the page.",
  // Interim (step 1 PROPOSAL): the bar, with both numbers always shown.
  pendingLine: (add: number, remove: number) => `Not saved: ${formatChooseCount(add)} to add · ${formatChooseCount(remove)} to remove`,
  // Interim (step 1 PROPOSAL).
  save: "Save changes",
  // Interim (step 1 PROPOSAL).
  saving: "Saving…",
  // Interim (step 1 PROPOSAL).
  undo: "Undo changes",
  // The cap comes from the caller (MAX_SELECTION_RULES; review CT8); the words say how far over and never name "Undo",
  // which clears every change (review DUX4).
  // Interim (step 1 PROPOSAL): the server's rule cap (owner Q4), stopped before sending.
  tooManyChoices: (count: number, cap: number) =>
    `You can keep up to ${formatChooseCount(cap)} saved choices: each item you pick, each item you keep out and each older setting counts as one. This save would make ${formatChooseCount(count)}, which is ${formatChooseCount(Math.max(0, count - cap))} over. Change some marked items back, then save.`,
  // Interim (step 1 PROPOSAL): the 100 KiB body limit, stopped before sending, and a 413.
  tooLarge: "These changes are too large to save at once. Change some marked items back, then save.",
  // Interim (step 1 PROPOSAL): the question before every save.
  confirmTitle: "Save your changes?",
  // No "soon", and nothing about what eBay shows for quantity 0 (the seller's eBay setting; not in the code) (review MC5,
  // DUX7). When: with the listing's next stock update, which waits while another size of that listing is blocked
  // (inventory-channel-exposure-runtime.service.ts publishes a target only when every row is clean) (verify V7).
  // Each size is its own eBay listing (dropship-ebay-listing-push.provider.ts sends one variant per listing).
  // Interim (step 1 PROPOSAL): today's behaviour for a removed size (owner Q5): quantity 0, nothing ended, others keep theirs.
  confirmRemove: "Sizes you remove that are listed on eBay are set to quantity 0 there the next time Card Shellz updates that listing's stock, so buyers can't buy them. Card Shellz changes only their quantity. Sizes you keep checked don't change.",
  // Interim (step 1 PROPOSAL): today's behaviour for an added size.
  confirmAdd: "Items you add that still have an eBay listing can start selling again soon after you save. Items that were never listed stay off eBay until you publish them in step 3.",
  // Interim (step 1 PROPOSAL): no listing data reaches this page yet.
  confirmUnknown: "This page can't tell yet which of these items are on eBay. Your choice applies to all your stores.",
  // Interim (step 1 PROPOSAL).
  confirmSave: "Save changes",
  // Interim (step 1 PROPOSAL).
  confirmCancel: "Cancel",
  // Interim (step 1 PROPOSAL): after a save, with the changes that took (review MC4).
  savedLine: (add: number, remove: number) => {
    const parts = [
      ...(add > 0 ? [`${formatChooseCount(add)} added`] : []),
      ...(remove > 0 ? [`${formatChooseCount(remove)} removed`] : []),
    ];
    return parts.length > 0 ? `Saved. ${parts.join(", ")}.` : "Saved.";
  },
  // Interim (step 1 PROPOSAL): after the saved line, the changes saved whose rows still don't read as marked (review MC4, CT3).
  notTakenLine: (count: number) => (count === 1
    ? "1 change didn't take effect: its row says why."
    : `${formatChooseCount(count)} changes didn't take effect: their rows say why.`),
  // Interim (step 1 PROPOSAL): the rules changed since the first mark; nothing was sent.
  stale: "Your choices were changed in another tab. Review them and save again.",
  // Interim (step 1 PROPOSAL): another tab's save already matches every change, so nothing was sent and nothing is left (verify V1).
  staleNothingLeft: "Your choices were saved in another tab, and they already match your changes. Nothing is left to save.",
  // Interim (step 1 PROPOSAL): an earlier save whose answer was lost went through, and changes are left to save.
  lastSaveWentThrough: "Your last save went through. Review your changes and save again.",
  // Interim (step 1 PROPOSAL): nothing of this save was written (the rules couldn't be read first, or every answer was "busy").
  notSaved: "Your changes weren't saved. Check your connection, then press Save changes again.",
  // Interim (step 1 PROPOSAL): no answer, so the save may have gone through; the next press checks first (review MC1).
  unconfirmed: "We couldn't confirm your save. Press Save changes again to check whether it went through.",
  // Interim (step 1 PROPOSAL): Undo after an unconfirmed save, which the rules show went through (review MC1).
  undoneButSaved: "Your last save went through after all. The list now shows what is saved.",
  // Interim (step 1 PROPOSAL): Undo (or a reload) after an unconfirmed save, and the rules changed some other way since (verify V2).
  pendingMoved: "Your saved choices changed: your last save may have gone through, or another tab saved. The list now shows what is saved.",
  // Interim (step 1 PROPOSAL): Undo after an unconfirmed save, and the rules couldn't be read to check (review MC1).
  undoneUnknown: "We couldn't check whether your last save went through. Reload the page to see what is saved.",
  // Interim (step 1 PROPOSAL): a refusal this page can't fix. Never "reload": that drops every change and fixes nothing (review DUX10).
  rejected: "Your changes couldn't be saved. They're still here. If this keeps happening, contact Card Shellz support.",
  // §4.11 retired: the save once PR B froze the old rules. This page is out of date, nothing was saved, and only a
  // reload fixes it (the one refusal where Reload is offered; CHK9). The server sends the same words
  // (server/modules/dropship/domain/catalog-read-words.ts).
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
