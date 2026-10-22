import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHOOSE_WORDS, describeCatalogListingTier, formatCatalogDollars, formatChooseCount } from "../dropship-catalog-choose-words";

describe("catalog step 1 words", () => {
  it("W1 says what the step does and that nothing reaches eBay before Save", () => {
    expect(CHOOSE_WORDS.intro).toBe("Check what you want to sell and uncheck what you don't, then press Save changes. Nothing changes on eBay until you save. No verification code needed.");
    expect(CHOOSE_WORDS.heading).toBe("Available catalog");
    expect(CHOOSE_WORDS.selectedBadge(1)).toBe("1 selected");
    expect(CHOOSE_WORDS.loadingSelection).toBe("Loading selection");
    expect(CHOOSE_WORDS.filtersHeading).toBe("Catalog filters");
    expect(CHOOSE_WORDS.filtersLine).toBe("Narrow the table without changing what is selected.");
    expect(CHOOSE_WORDS.searchLabel).toBe("Search");
    expect(CHOOSE_WORDS.searchPlaceholder).toBe("Product, size, or SKU");
    // Review DUX1: the server filters by what is saved, so the option says so, and a note says checks move rows after Save.
    expect([CHOOSE_WORDS.showLabel, CHOOSE_WORDS.showAll, CHOOSE_WORDS.showSelected]).toEqual(["Show", "All", "Saved as selected"]);
    expect(CHOOSE_WORDS.showSavedNote).toBe("This list shows what is saved. Items you check or uncheck move in or out of it after you save.");
    expect([CHOOSE_WORDS.categoryLabel, CHOOSE_WORDS.categoryAll]).toEqual(["Category", "All categories"]);
    expect(CHOOSE_WORDS.categoryOption("trading_card_sleeves", 12)).toBe("Trading Card Sleeves (12)");
    expect(CHOOSE_WORDS.uncategorized).toBe("Uncategorized");
    expect(CHOOSE_WORDS.tableCaption).toBe("Items Card Shellz offers you. Check the ones you want to sell.");
    expect(CHOOSE_WORDS.columns).toEqual({ item: "Item", category: "Category", available: "Available", how: "How" });
  });

  it("W2 names every row's box, with a fallback for blank names", () => {
    expect(CHOOSE_WORDS.rowCheckbox("Envelope Single Pocket", "Pack of 50")).toBe("Select Envelope Single Pocket, Pack of 50");
    expect(CHOOSE_WORDS.rowCheckbox("Envelope Single Pocket", " ")).toBe("Select Envelope Single Pocket");
    expect(CHOOSE_WORDS.rowCheckbox("", "Pack of 50")).toBe("Select Pack of 50");
    expect(CHOOSE_WORDS.rowCheckbox(" ", "")).toBe("Select this item");
    expect(CHOOSE_WORDS.selectAllShown).toBe("Select all shown");
    expect(CHOOSE_WORDS.itemSizeLine("Pack of 50", "ENV-SGL-P50", 101)).toBe("Pack of 50 · ENV-SGL-P50");
    // Review DUX7: the step's word is "size".
    expect(CHOOSE_WORDS.itemSizeLine("Pack of 50", null, 101)).toBe("Pack of 50 · Size 101");
    expect(CHOOSE_WORDS.noQuantitySr).toBe("No quantity: not selected");
  });

  it("W3 the How words, in plain language and never a reason code", () => {
    expect(CHOOSE_WORDS.how).toEqual({
      willAdd: "Will be added", willRemove: "Will be removed", picked: "Picked by you", olderInclude: "Selected by an older setting",
      removed: "Removed by you", olderExclude: "Kept out by an older setting", notSelected: "Not selected", turnedOff: "Turned off for you",
      notOffered: "Not offered by Card Shellz", selected: "Selected", keptOut: "Kept out",
    });
    expect(CHOOSE_WORDS.removedHint).toBe("Check it to sell it again.");
    // Review DUX6: the two older-setting states say what the vendor can do.
    expect(CHOOSE_WORDS.olderIncludeHint).toBe("Uncheck it to keep it out.");
    expect(CHOOSE_WORDS.olderExcludeHint).toBe("Contact Card Shellz support to change this setting.");
    for (const words of Object.values(CHOOSE_WORDS.how)) expect(words).not.toMatch(/_|Vendor Rule|Include Rule/);
  });

  it("W4 the count lines, with plurals and grouped numbers", () => {
    expect(CHOOSE_WORDS.shownLine(200, 1_433)).toBe("Showing 200 of 1,433");
    expect(CHOOSE_WORDS.shownLine(230, 230)).toBe("Showing all 230");
    expect(CHOOSE_WORDS.shownLine(1, 1)).toBe("Showing 1 item");
    // Review DUX5: the Category filter, never "choose" (the step's word for selling).
    expect(CHOOSE_WORDS.shownCapLine(1_000, 4_300)).toBe("Showing 1,000 of 4,300. Search, or filter by Category above, to see the rest.");
    // Review DUX11: rows the paging can't reach.
    expect(CHOOSE_WORDS.shownShortLine(199, 200)).toBe("Showing 199 of 200. Search to find the rest.");
    expect(formatChooseCount(1_433)).toBe("1,433");
    expect([CHOOSE_WORDS.loadMore, CHOOSE_WORDS.loadingMore, CHOOSE_WORDS.loadMoreFailed, CHOOSE_WORDS.tryAgain])
      .toEqual(["Load more", "Loading…", "Couldn't load more items.", "Try again"]);
  });

  it("W5 the empty, failed and unreadable states", () => {
    expect([CHOOSE_WORDS.emptyFilteredTitle, CHOOSE_WORDS.emptyFilteredText]).toEqual(["No matching items", "No items match your search and filters."]);
    expect([CHOOSE_WORDS.emptyTitle, CHOOSE_WORDS.emptyText]).toEqual(["No items yet", "Card Shellz hasn't offered any items for dropship yet."]);
    expect([CHOOSE_WORDS.catalogFailedTitle, CHOOSE_WORDS.catalogFailedText]).toEqual(["Catalog unavailable", "The catalog couldn't be loaded."]);
    expect(CHOOSE_WORDS.catalogUnreadable).toBe("The catalog couldn't be read. Reload the page.");
    expect(CHOOSE_WORDS.rulesFailed).toBe("Your saved choices couldn't be loaded, so changes can't be saved yet.");
    expect(CHOOSE_WORDS.rulesUnreadable).toBe("Your saved choices couldn't be read. Reload the page.");
  });

  it("W6 the bar, the limits and the outcomes", () => {
    expect(CHOOSE_WORDS.pendingLine(3, 9)).toBe("Not saved: 3 to add · 9 to remove");
    expect(CHOOSE_WORDS.pendingLine(1, 0)).toBe("Not saved: 1 to add · 0 to remove");
    expect([CHOOSE_WORDS.save, CHOOSE_WORDS.saving, CHOOSE_WORDS.undo]).toEqual(["Save changes", "Saving…", "Undo changes"]);
    // Review CT8, DUX4: the cap comes from the caller, the words say how far over, and never name "Undo" (that button clears all).
    expect(CHOOSE_WORDS.tooManyChoices(501, 500)).toBe("You can keep up to 500 saved choices: each item you pick, each item you keep out and each older setting counts as one. This save would make 501, which is 1 over. Change some marked items back, then save.");
    expect(CHOOSE_WORDS.tooManyChoices(1_204, 500)).toContain("This save would make 1,204, which is 704 over.");
    expect(CHOOSE_WORDS.tooManyChoices(1_204, 2_000)).toContain("up to 2,000 saved choices");
    expect(CHOOSE_WORDS.tooLarge).toBe("These changes are too large to save at once. Change some marked items back, then save.");
    expect(CHOOSE_WORDS.savedLine(3, 9)).toBe("Saved. 3 added, 9 removed.");
    expect(CHOOSE_WORDS.savedLine(3, 0)).toBe("Saved. 3 added.");
    expect(CHOOSE_WORDS.savedLine(0, 9)).toBe("Saved. 9 removed.");
    expect(CHOOSE_WORDS.savedLine(1, 0)).toBe("Saved. 1 added.");
    expect(CHOOSE_WORDS.stale).toBe("Your choices were changed in another tab. Review them and save again.");
    expect(CHOOSE_WORDS.lastSaveWentThrough).toBe("Your last save went through. Review your changes and save again.");
    expect(CHOOSE_WORDS.notSaved).toBe("Your changes weren't saved. Check your connection, then press Save changes again.");
    // Review DUX10: a reload would drop every change and not fix a refusal.
    expect(CHOOSE_WORDS.rejected).toBe("Your changes couldn't be saved. They're still here. If this keeps happening, contact Card Shellz support.");
    // Review MC1: no answer may still mean saved; Undo then checks.
    expect(CHOOSE_WORDS.unconfirmed).toBe("We couldn't confirm your save. Press Save changes again to check whether it went through.");
    expect(CHOOSE_WORDS.undoneButSaved).toBe("Your last save went through after all. The list now shows what is saved.");
    expect(CHOOSE_WORDS.undoneUnknown).toBe("We couldn't check whether your last save went through. Reload the page to see what is saved.");
    // Review MC4, CT3: changes that were saved but did not take.
    expect(CHOOSE_WORDS.notTakenLine(1)).toBe("1 change didn't take effect: its row says why.");
    expect(CHOOSE_WORDS.notTakenLine(3)).toBe("3 changes didn't take effect: their rows say why.");
  });

  it("W7 the eBay question says today's behaviour: a removed size is set to quantity 0, only its quantity changes, other sizes keep theirs", () => {
    expect(CHOOSE_WORDS.confirmTitle).toBe("Save your changes?");
    // Review MC5, DUX7: no timing promise ("soon"), no promise about what eBay shows, and "sizes" throughout.
    // Verify V7: the 0 goes out with that listing's next stock update, which waits while another size of it is blocked
    // (inventory-channel-exposure-runtime.service.ts publishes a target only when every row is clean), so say when.
    expect(CHOOSE_WORDS.confirmRemove).toBe("Sizes you remove that are listed on eBay are set to quantity 0 there the next time Card Shellz updates that listing's stock, so buyers can't buy them. Card Shellz changes only their quantity. Sizes you keep checked don't change.");
    expect(CHOOSE_WORDS.confirmRemove).not.toMatch(/\bsoon\b|stay on eBay/);
    expect(CHOOSE_WORDS.confirmAdd).toBe("Items you add that still have an eBay listing can start selling again soon after you save. Items that were never listed stay off eBay until you publish them in step 3.");
    expect(CHOOSE_WORDS.confirmUnknown).toBe("This page can't tell yet which of these items are on eBay. Your choice applies to all your stores.");
    expect([CHOOSE_WORDS.confirmSave, CHOOSE_WORDS.confirmCancel]).toEqual(["Save changes", "Cancel"]);
    // Ending a listing is a later stage (owner Q5): the words never promise it.
    expect(`${CHOOSE_WORDS.confirmRemove} ${CHOOSE_WORDS.confirmAdd}`).not.toMatch(/\bend(s|ed)?\b|delist|removed from eBay/i);
  });

  it("W9 (verify round) nothing left to save, saved choices that moved, a list behind its save, and a turned-off pick", () => {
    expect(CHOOSE_WORDS.staleNothingLeft).toBe("Your choices were saved in another tab, and they already match your changes. Nothing is left to save.");
    expect(CHOOSE_WORDS.pendingMoved).toBe("Your saved choices changed: your last save may have gone through, or another tab saved. The list now shows what is saved.");
    expect(CHOOSE_WORDS.listBehindSave).toBe("The list couldn't be refreshed after the last save, so it may not show what is saved. Press Try again.");
    expect(CHOOSE_WORDS.turnedOffPickHint).toBe("You picked it, but it can't be sold now. Uncheck it to remove your pick.");
  });

  it("W8 the tier words moved unchanged from the page", () => {
    const tier = { eligible: false, policyMinimumCents: 50_000, reserveShortfallCents: 0, balanceShortfallCents: 38_000 };
    expect(describeCatalogListingTier({ ...tier, tier: "case", reason: "balance_below_tier" }))
      .toBe("The Case tier is not active: your balance needs to reach $500. You need $380 more.");
    expect(describeCatalogListingTier({ ...tier, tier: "case", reason: "reserve_below_tier", reserveShortfallCents: 40_000 }))
      .toBe("The Case tier is not active: it needs a reserve of $500. Raise your reserve in Wallet.");
    expect(describeCatalogListingTier({ ...tier, tier: "pack", policyMinimumCents: 10_000, reason: "autopay_off" }))
      .toBe("The Pack tier is not active: autopay is off, so your wallet has no reserve. Turn on autopay with a reserve of at least $100 in Wallet.");
    expect(formatCatalogDollars(1_050)).toBe("$10.50");
    expect(formatCatalogDollars(50_000)).toBe("$500");
  });

  // Stage 2 (step 1 plan S2-5) adds `retired` and its Reload, marked PROPOSED as the plan's words are (§4.11).
  it("marks every new string as interim, and names no product line", () => {
    const source = readFileSync(join(process.cwd(), "client/src/lib/dropship-catalog-choose-words.ts"), "utf8");
    const body = source.slice(source.indexOf("export const CHOOSE_WORDS"), source.indexOf("export function describeCatalogListingTier"));
    const how = source.slice(source.indexOf("const HOW_WORDS"), source.indexOf("export const CHOOSE_WORDS"));
    const entries = [...body.matchAll(/\n  (\w+): /g), ...how.matchAll(/\n  (\w+): /g)];
    expect(entries.length).toBeGreaterThan(50);
    for (const words of [body, how]) {
      for (const match of words.matchAll(/\n( {2}\/\/ [^\n]*\n)?( {2}\w+: )/g)) {
        expect(match[1], `no comment above ${match[2].trim()}`).toMatch(/\/\/ (Interim \(step 1 PROPOSAL\)|Kept|Stage 2 \(step 1 plan S2-5\): PROPOSED)/);
      }
    }
    // No word the vendor reads names a product line (owner Q2).
    const shown = [...Object.values(CHOOSE_WORDS as Record<string, unknown>).filter((value): value is string => typeof value === "string"), ...Object.values(CHOOSE_WORDS.how)];
    for (const words of shown) expect(words).not.toMatch(/product line/i);
  });
});
