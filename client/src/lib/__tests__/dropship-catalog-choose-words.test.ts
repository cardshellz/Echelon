import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHOOSE_WORDS, describeCatalogListingTier, formatCatalogDollars, formatChooseCount } from "../dropship-catalog-choose-words";
import { CATALOG_READ_WORDS } from "../../../../server/modules/dropship/domain/catalog-read-words";
import { SELECTION_CHANGE_WORDS } from "../../../../server/modules/dropship/application/dropship-selection-change-service";

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
    // Review DUX1: the server filters by what is saved, so the options say so, and a note says checks move rows after Save.
    expect([CHOOSE_WORDS.showLabel, CHOOSE_WORDS.showAll, CHOOSE_WORDS.showSelected, CHOOSE_WORDS.showNotSelected])
      .toEqual(["Show", "All", "Saved as selected", "Not selected"]);
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
    expect(CHOOSE_WORDS.itemSizeLine("Pack of 50", null, 101)).toBe("Pack of 50 · Size 101");
    expect(CHOOSE_WORDS.noQuantitySr).toBe("No quantity: not selected");
  });

  it("W3 the How words come from the pick and the reason only (V24): no older-setting words remain", () => {
    expect(CHOOSE_WORDS.how).toEqual({
      willAdd: "Will be added", willRemove: "Will be removed", picked: "Picked by you", notSelected: "Not selected",
      turnedOff: "Turned off for you", notOffered: "Not offered by Card Shellz",
    });
    expect(CHOOSE_WORDS.turnedOffPickHint).toBe("You picked it, but it can't be sold now. Uncheck it to remove your pick.");
    for (const words of Object.values(CHOOSE_WORDS.how)) expect(words).not.toMatch(/_|older setting|Vendor Rule|Include Rule/);
    for (const gone of ["olderIncludeHint", "olderExcludeHint", "removedHint", "tooManyChoices", "confirmUnknown", "lastSaveWentThrough", "rulesFailed"]) {
      expect(gone in CHOOSE_WORDS, gone).toBe(false);
    }
  });

  it("W4 the count lines, with plurals and grouped numbers", () => {
    expect(CHOOSE_WORDS.shownLine(200, 1_433)).toBe("Showing 200 of 1,433");
    expect(CHOOSE_WORDS.shownLine(230, 230)).toBe("Showing all 230");
    expect(CHOOSE_WORDS.shownLine(1, 1)).toBe("Showing 1 item");
    expect(CHOOSE_WORDS.shownCapLine(1_000, 4_300)).toBe("Showing 1,000 of 4,300. Search, or filter by Category above, to see the rest.");
    expect(CHOOSE_WORDS.shownShortLine(199, 200)).toBe("Showing 199 of 200. Search to find the rest.");
    expect(formatChooseCount(1_433)).toBe("1,433");
    expect([CHOOSE_WORDS.loadMore, CHOOSE_WORDS.loadingMore, CHOOSE_WORDS.loadMoreFailed, CHOOSE_WORDS.tryAgain])
      .toEqual(["Load more", "Loading…", "Couldn't load more items.", "Try again"]);
    expect(CHOOSE_WORDS.pendingLine(3, 9)).toBe("Not saved: 3 to add · 9 to remove");
    expect([CHOOSE_WORDS.save, CHOOSE_WORDS.saving, CHOOSE_WORDS.undo]).toEqual(["Save changes", "Saving…", "Undo changes"]);
  });

  it("W5 the empty and failed states", () => {
    expect([CHOOSE_WORDS.emptyFilteredTitle, CHOOSE_WORDS.emptyFilteredText]).toEqual(["No matching items", "No items match your search and filters."]);
    expect([CHOOSE_WORDS.emptyTitle, CHOOSE_WORDS.emptyText]).toEqual(["No items yet", "Card Shellz hasn't offered any items for dropship yet."]);
    expect([CHOOSE_WORDS.catalogFailedTitle, CHOOSE_WORDS.catalogFailedText]).toEqual(["Catalog unavailable", "The catalog couldn't be loaded."]);
    expect(CHOOSE_WORDS.listBehindSave).toBe("The list couldn't be refreshed after the last save, so it may not show what is saved. Press Try again.");
  });

  it("W6 (§13) the categories card, Check all, Select everything, room and the cap, word for word", () => {
    expect(CHOOSE_WORDS.categoriesHeading).toBe("Categories");
    expect(CHOOSE_WORDS.categoryLine("Armalope", 142, 311)).toBe("Armalope · 142 of 311 selected");
    expect(CHOOSE_WORDS.categoryBox("Armalope")).toBe("Select all in Armalope");
    expect(CHOOSE_WORDS.categoryShowOnly("Armalope")).toBe("Show only Armalope");
    expect(CHOOSE_WORDS.noCategory).toBe("Items with no category aren't listed here. Choose them in the table.");
    expect(CHOOSE_WORDS.tickAdds(169, "Armalope")).toBe("Adds the 169 items in Armalope that aren't selected yet. Items Card Shellz adds to Armalope later aren't added; you'll see them in a notice here instead.");
    expect(CHOOSE_WORDS.tickAdds(1, "Armalope")).toBe("Adds the 1 item in Armalope that isn't selected yet. Items Card Shellz adds to Armalope later aren't added; you'll see them in a notice here instead.");
    expect(CHOOSE_WORDS.tickRemoves(142, "Armalope")).toBe("Removes all 142 selected items in Armalope.");
    expect(CHOOSE_WORDS.tickRemoves(1, "Armalope")).toBe("Removes the 1 selected item in Armalope.");
    expect(CHOOSE_WORDS.checkAllShown(200)).toBe("All 200 shown are checked.");
    expect(CHOOSE_WORDS.checkAll(1_433)).toBe("Check all 1,433 that match");
    expect(CHOOSE_WORDS.uncheckAll(1_433)).toBe("Uncheck all 1,433 that match");
    expect(CHOOSE_WORDS.matchChanged(1_440, 1_433)).toBe("1,440 now match (was 1,433).");
    expect(CHOOSE_WORDS.tooManyMatch(10_050)).toBe("Too many to change at once (10,050). Search or pick a category to narrow the list.");
    expect(CHOOSE_WORDS.selectEverything(4_300)).toBe("Select everything (4,300)");
    expect(CHOOSE_WORDS.everythingAdds(4_300)).toBe("Adds every item Card Shellz offers that isn't selected yet (4,300). Items Card Shellz adds later aren't added. You'll see a notice for new items in categories you sell from.");
    expect(CHOOSE_WORDS.room(4_000, 6_000)).toBe("You can have up to 10,000 selected. 4,000 are selected, so 6,000 more can be added.");
    expect(CHOOSE_WORDS.room(1, 9_999)).toBe("You can have up to 10,000 selected. 1 is selected, so 9,999 more can be added.");
    expect(CHOOSE_WORDS.room(10_050, -50)).toBe("You can have up to 10,000 selected. 10,050 are selected, so 0 more can be added.");
    expect(CHOOSE_WORDS.overCapAdd(10_100)).toBe("This would make 10,100 selected, over the 10,000 limit. Undo some additions to save.");
    expect(CHOOSE_WORDS.overCapState(10_050)).toBe("10,050 selected, over the 10,000 limit. Publishing refuses more than 10,000. Remove some, then publish.");
  });

  it("W7 (§13) the save question says only what Echelon does", () => {
    expect(CHOOSE_WORDS.confirmTitle).toBe("Save your changes?");
    expect(CHOOSE_WORDS.confirmCounts(12, 8, 0)).toBe("12 added · 8 removed");
    expect(CHOOSE_WORDS.confirmCounts(12, 8, 3)).toBe("12 added · 8 removed · 3 were already as you chose");
    expect(CHOOSE_WORDS.confirmCounts(1, 0, 1)).toBe("1 added · 0 removed · 1 was already as you chose");
    expect(CHOOSE_WORDS.confirmZero("Card Corner", 12)).toBe("On Card Corner: 12 listings are set to quantity 0, so buyers can't buy them.");
    expect(CHOOSE_WORDS.confirmZero("Card Corner", 1)).toBe("On Card Corner: 1 listing is set to quantity 0, so buyers can't buy it.");
    expect(CHOOSE_WORDS.confirmResume("Card Corner", 8)).toBe("On Card Corner: 8 listings get their quantity back shortly after you save, at the price they have on eBay now. To send today's prices, publish them in step 3.");
    expect(CHOOSE_WORDS.confirmResume("Card Corner", 1)).toBe("On Card Corner: 1 listing gets its quantity back shortly after you save, at the price it has on eBay now. To send today's price, publish it in step 3.");
    expect(CHOOSE_WORDS.confirmNone).toBe("Nothing changes on your eBay listings now.");
    expect(CHOOSE_WORDS.confirmScope).toBe("Your choice applies to all your stores.");
    expect([CHOOSE_WORDS.confirmSave, CHOOSE_WORDS.confirmCancel]).toEqual(["Save changes", "Cancel"]);
    // FIDELITY2: nothing promises what eBay shows, and B's lines never say a listing is ended (PR C's own lines do, W7b).
    for (const words of [CHOOSE_WORDS.confirmZero("S", 2), CHOOSE_WORDS.confirmResume("S", 2), CHOOSE_WORDS.confirmNone]) {
      expect(words).not.toMatch(/\bend(s|ed)\b|delist|removed from eBay/i);
    }
    // PR C deleted B's "aren't ended" line (PLAN-C v4.1 §11): a removal now ends its eBay listings.
    expect(Object.keys(CHOOSE_WORDS)).not.toContain("confirmNotEnded");
  });

  it("W7b (PLAN-C v4.1 §11) PR C's end lines, button and saved line, word for word, one and many", () => {
    expect(CHOOSE_WORDS.confirmEnd("Marz Cards", 3))
      .toBe("On Marz Cards: 3 eBay listings will be ended. To sell one again later, choose it here and publish it in step 3.");
    expect(CHOOSE_WORDS.confirmEnd("Marz Cards", 1))
      .toBe("On Marz Cards: 1 eBay listing will be ended. To sell one again later, choose it here and publish it in step 3.");
    expect(CHOOSE_WORDS.confirmEnd("Marz Cards", 1_200)).toContain("1,200 eBay listings will be ended.");
    expect(CHOOSE_WORDS.confirmEndWaitsForStore("Marz Cards", 3))
      .toBe("On Marz Cards: 3 eBay listings will be ended when the store can be used again. They stay at quantity 0 until then.");
    expect(CHOOSE_WORDS.confirmEndWaitsForStore("Marz Cards", 1))
      .toBe("On Marz Cards: 1 eBay listing will be ended when the store can be used again. It stays at quantity 0 until then.");
    expect(CHOOSE_WORDS.confirmEndOtherSizes(2))
      .toBe("2 of these are listings of other sizes of products you removed completely: sizes you removed earlier, or that Card Shellz isn't offering now.");
    expect(CHOOSE_WORDS.confirmEndOtherSizes(1))
      .toBe("1 of these is a listing of another size of a product you removed completely: a size you removed earlier, or that Card Shellz isn't offering now.");
    expect(CHOOSE_WORDS.confirmEndHidden(4))
      .toBe("Removing every size you can see of a product also removes 4 of its sizes that Card Shellz isn't offering right now.");
    expect(CHOOSE_WORDS.confirmEndHidden(1))
      .toBe("Removing every size you can see of a product also removes 1 of its sizes that Card Shellz isn't offering right now.");
    expect(CHOOSE_WORDS.confirmStillEnding(2))
      .toBe("2 of the items you're adding are still being ended on eBay. When that's done, publish them again in step 3.");
    expect(CHOOSE_WORDS.confirmStillEnding(1))
      .toBe("1 of the items you're adding is still being ended on eBay. When that's done, publish it again in step 3.");
    expect(CHOOSE_WORDS.confirmEndReview(2))
      .toBe("2 of the items you're adding have an eBay listing Card Shellz couldn't end yet. Card Shellz is looking into it; they stay at quantity 0 until then.");
    expect(CHOOSE_WORDS.confirmEndReview(1))
      .toBe("1 of the items you're adding has an eBay listing Card Shellz couldn't end yet. Card Shellz is looking into it; it stays at quantity 0 until then.");
    expect(CHOOSE_WORDS.confirmEndedReAdd(2)).toBe("2 of the items you're adding were ended on eBay. Publish them in step 3 to sell them again.");
    expect(CHOOSE_WORDS.confirmEndedReAdd(1)).toBe("1 of the items you're adding was ended on eBay. Publish it in step 3 to sell it again.");
    expect(CHOOSE_WORDS.saveEndButton(1)).toBe("End 1 listing and save");
    expect(CHOOSE_WORDS.saveEndButton(3)).toBe("End 3 listings and save");
    expect(CHOOSE_WORDS.saveEndButton(12_000)).toBe("End 12,000 listings and save");
    expect(CHOOSE_WORDS.savedEnding(1)).toBe("1 eBay listing is being ended.");
    expect(CHOOSE_WORDS.savedEnding(3)).toBe("3 eBay listings are being ended.");
    // One actor everywhere (FID-14): Card Shellz, never "we" or "Echelon".
    for (const words of [CHOOSE_WORDS.confirmEnd("S", 2), CHOOSE_WORDS.confirmEndWaitsForStore("S", 2), CHOOSE_WORDS.confirmEndOtherSizes(2),
      CHOOSE_WORDS.confirmEndHidden(2), CHOOSE_WORDS.confirmStillEnding(2), CHOOSE_WORDS.confirmEndReview(2), CHOOSE_WORDS.confirmEndedReAdd(2),
      CHOOSE_WORDS.saveEndButton(2), CHOOSE_WORDS.savedEnding(2), CHOOSE_WORDS.tooManyRemoved]) {
      expect(words).not.toMatch(/\bwe\b|Echelon|DROPSHIP_/i);
    }
  });

  it("W8 (§13) the outcomes, word for word; the ones the server also says match its words", () => {
    expect(CHOOSE_WORDS.skipped(3)).toBe("3 are no longer offered by Card Shellz and were skipped.");
    expect(CHOOSE_WORDS.skipped(1)).toBe("1 is no longer offered by Card Shellz and was skipped.");
    expect(CHOOSE_WORDS.saved(3, 9)).toBe("Saved. 3 added, 9 removed.");
    expect(CHOOSE_WORDS.saved(1_121, 0)).toBe("Saved. 1,121 added, 0 removed.");
    expect(CHOOSE_WORDS.savedDrift(12)).toBe("Saved. A few listings changed on eBay while you were deciding; 12 listings are set to quantity 0.");
    expect(CHOOSE_WORDS.savedDrift(1)).toBe("Saved. A few listings changed on eBay while you were deciding; 1 listing is set to quantity 0.");
    expect(CHOOSE_WORDS.savingStill).toBe("Still saving… eBay updates are in progress. Your changes are kept.");
    expect(CHOOSE_WORDS.busy).toBe("Saving is busy right now. Your changes are kept; try again in a minute.");
    expect(CHOOSE_WORDS.stale).toBe("Your saved choices changed after this page loaded. Review them and save again.");
    expect(CHOOSE_WORDS.effectsChanged).toBe("Something on eBay changed while you were deciding. Check the new numbers and save again.");
    expect(CHOOSE_WORDS.paused).toBe("Saving is paused for a few minutes while Card Shellz updates the site. Your changes are kept, and saving will try again by itself.");
    expect(CHOOSE_WORDS.pausedStill).toBe("Saving is still paused while Card Shellz updates the site. Your changes are kept; press Save again in a few minutes.");
    // The same words on both sides, so an answer the page shows as-is never contradicts the page's own line.
    expect(CHOOSE_WORDS.stale).toBe(SELECTION_CHANGE_WORDS.stale);
    expect(CHOOSE_WORDS.effectsChanged).toBe(SELECTION_CHANGE_WORDS.effectsChanged);
    expect(CHOOSE_WORDS.paused).toBe(SELECTION_CHANGE_WORDS.paused);
    expect(CHOOSE_WORDS.overCapAdd(10_001)).toBe(SELECTION_CHANGE_WORDS.tooLarge(10_001));
    expect(CHOOSE_WORDS.retired).toBe(CATALOG_READ_WORDS.retired);
    expect(CHOOSE_WORDS.retired).toBe("This page was updated, so your last changes weren't saved. Reload it and make them again.");
    expect(CHOOSE_WORDS.reload).toBe("Reload");
    expect(CHOOSE_WORDS.notSaved).toBe("Your changes weren't saved. Check your connection, then press Save changes again.");
    expect(CHOOSE_WORDS.unconfirmed).toBe("We couldn't confirm your save. Press Save changes again to check whether it went through.");
    // Review round 1 CLI-1, TST-2 (PROPOSED, not in §13): Undo after an unsure save, and the saved choices moved.
    expect(CHOOSE_WORDS.undoneSaveMoved).toBe("Your saved choices changed: your last save may have gone through, or another tab saved.");
    expect(CHOOSE_WORDS.rejected).toBe("Your changes couldn't be saved. They're still here. If this keeps happening, contact Card Shellz support.");
    expect(CHOOSE_WORDS.tooLarge).toBe("These changes are too large to save at once. Change some marked items back, then save.");
  });

  it("W9 the tier words moved unchanged from the page", () => {
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

  // Every string carries its stage's marker; PR B's new strings carry "Stage 3/5 (step 1 plan S2-5)" (PLAN-B v4.1 §13),
  // PR C's "Stage 4 (step 1 plan S2-5)" (PLAN-C v4.1 §11).
  it("marks every string with its stage, and names no product line", () => {
    const source = readFileSync(join(process.cwd(), "client/src/lib/dropship-catalog-choose-words.ts"), "utf8");
    const body = source.slice(source.indexOf("export const CHOOSE_WORDS"), source.indexOf("export function describeCatalogListingTier"));
    const how = source.slice(source.indexOf("const HOW_WORDS"), source.indexOf("export const CHOOSE_WORDS"));
    const entries = [...body.matchAll(/\n {2}(\w+): /g), ...how.matchAll(/\n {2}(\w+): /g)];
    expect(entries.length).toBeGreaterThan(80);
    for (const words of [body, how]) {
      for (const match of words.matchAll(/\n( {2}\/\/ [^\n]*\n)?( {2}\w+: )/g)) {
        expect(match[1], `no comment above ${match[2].trim()}`)
          .toMatch(/\/\/ (Interim \(step 1 PROPOSAL\)|Kept|Stage 2 \(step 1 plan S2-5\): PROPOSED|Stage 3\/5 \(step 1 plan S2-5\): PROPOSED|Stage 4 \(step 1 plan S2-5\): PROPOSED\.$)/m);
      }
    }
    const stage4 = [...body.matchAll(/\n {2}\/\/ Stage 4 \(step 1 plan S2-5\): PROPOSED\.\n {2}(\w+): /g)].map((match) => match[1]);
    expect(stage4).toEqual(["tooManyRemoved", "confirmEnd", "confirmEndWaitsForStore", "confirmEndOtherSizes", "confirmEndHidden",
      "confirmStillEnding", "confirmEndReview", "confirmEndedReAdd", "saveEndButton", "savedEnding"]);
    const stage3 = [...body.matchAll(/\n {2}\/\/ Stage 3\/5 \(step 1 plan S2-5\): PROPOSED[^\n]*\n {2}(\w+): /g)].map((match) => match[1]);
    expect(stage3).toEqual([
      "showNotSelected", "categoriesHeading", "categoryLine", "categoryBox", "categoryShowOnly", "noCategory", "tickAdds", "tickRemoves",
      "checkAllShown", "checkAll", "uncheckAll", "matchChanged", "tooManyMatch", "selectEverything", "everythingAdds", "room", "overCapAdd",
      "overCapState", "confirmCounts", "confirmZero", "confirmResume", "confirmNone", "confirmScope", "skipped", "saved",
      "savedDrift", "savingStill", "busy", "stale", "effectsChanged", "paused", "pausedStill",
      // Review round 1 CLI-1, TST-2: PROPOSED beyond §13 (BUILD-NOTES "## Review round 1", client group).
      "undoneSaveMoved",
    ]);
    const shown = [...Object.values(CHOOSE_WORDS as Record<string, unknown>).filter((value): value is string => typeof value === "string"), ...Object.values(CHOOSE_WORDS.how)];
    for (const words of shown) expect(words).not.toMatch(/product line|rule/i);
  });
});
