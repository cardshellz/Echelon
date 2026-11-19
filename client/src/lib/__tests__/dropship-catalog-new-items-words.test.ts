import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_ITEMS_WORDS } from "../dropship-catalog-new-items-words";
import { CHOOSE_WORDS } from "../dropship-catalog-choose-words";
import { LISTING_SETTINGS_CONVERSION_WORDS } from "../dropship-listing-settings-words";

describe("catalog step 1 new-items notice words (PLAN-B v4.1 §13)", () => {
  it("NW1 the line, word for word: one item, many items, grouped numbers", () => {
    expect(NEW_ITEMS_WORDS.noticeLine(3, "Armalope")).toBe("3 new items from Card Shellz in Armalope");
    expect(NEW_ITEMS_WORDS.noticeLine(1, "Armalope")).toBe("1 new item from Card Shellz in Armalope");
    expect(NEW_ITEMS_WORDS.noticeLine(1_250, "Toploaders")).toBe("1,250 new items from Card Shellz in Toploaders");
    expect([NEW_ITEMS_WORDS.review, NEW_ITEMS_WORDS.gotIt]).toEqual(["Review", "Got it"]);
  });

  it("NW2 more than the lines shown: \"and {k} more categories\" with Show all; one is a category", () => {
    expect(NEW_ITEMS_WORDS.noticeMore(2)).toBe("and 2 more categories");
    expect(NEW_ITEMS_WORDS.noticeMore(1)).toBe("and 1 more category");
    expect(NEW_ITEMS_WORDS.noticeMore(1_204)).toBe("and 1,204 more categories");
    expect(NEW_ITEMS_WORDS.noticeShowAll).toBe("Show all");
  });

  it("NW3 Show's option while reviewing, apart from the step's other Show words", () => {
    expect(NEW_ITEMS_WORDS.showNew).toBe("New from Card Shellz");
    expect([CHOOSE_WORDS.showAll, CHOOSE_WORDS.showSelected, CHOOSE_WORDS.showNotSelected]).not.toContain(NEW_ITEMS_WORDS.showNew);
  });

  it("NW4 each button's accessible name is its label, then its line, so the names start with what is shown and differ by line", () => {
    const line = NEW_ITEMS_WORDS.noticeLine(3, "Armalope");
    expect(NEW_ITEMS_WORDS.reviewName(line)).toBe("Review: 3 new items from Card Shellz in Armalope");
    expect(NEW_ITEMS_WORDS.gotItName(line)).toBe("Got it: 3 new items from Card Shellz in Armalope");
    expect(NEW_ITEMS_WORDS.reviewName(line).startsWith(NEW_ITEMS_WORDS.review)).toBe(true);
    expect(NEW_ITEMS_WORDS.gotItName(line).startsWith(NEW_ITEMS_WORDS.gotIt)).toBe(true);
    expect(NEW_ITEMS_WORDS.reviewName(NEW_ITEMS_WORDS.noticeLine(1, "Sleeves"))).not.toBe(NEW_ITEMS_WORDS.reviewName(line));
  });

  it("NW5 a Got it that failed keeps the portal's existing words (no new words)", () => {
    expect(NEW_ITEMS_WORDS.gotItFailed).toBe(LISTING_SETTINGS_CONVERSION_WORDS.noticeFailed);
    expect(NEW_ITEMS_WORDS.gotItFailed).toBe("Couldn't save that. Try again.");
  });

  it("NW6 marks every entry: PR B's strings with \"Stage 3/5 (step 1 plan S2-5): PROPOSED\", the rest as composed or kept; no code, id or product line", () => {
    const source = readFileSync(join(process.cwd(), "client/src/lib/dropship-catalog-new-items-words.ts"), "utf8");
    const body = source.slice(source.indexOf("export const NEW_ITEMS_WORDS"));
    const entries = [...body.matchAll(/\n( {2}\/\/ [^\n]*\n)( {2}\/\/ [^\n]*\n)?( {2})(\w+): /g)];
    const keys = [...body.matchAll(/\n {2}(\w+): /g)].map((match) => match[1]);
    expect(keys).toEqual(Object.keys(NEW_ITEMS_WORDS));
    expect(entries.map((match) => match[4])).toEqual(keys);
    const firstComment = (key: string) => entries.find((match) => match[4] === key)?.[1] ?? "";
    const stage3 = keys.filter((key) => firstComment(key).includes("// Stage 3/5 (step 1 plan S2-5): PROPOSED."));
    expect(stage3).toEqual(["noticeLine", "review", "gotIt", "noticeMore", "noticeShowAll", "showNew"]);
    expect(firstComment("reviewName")).toContain("// Composed, no new words");
    expect(firstComment("gotItName")).toContain("// Composed, no new words");
    expect(firstComment("gotItFailed")).toContain("// Kept (Listing settings PR 11e1");
    const shown = [NEW_ITEMS_WORDS.noticeLine(3, "Armalope"), NEW_ITEMS_WORDS.noticeMore(2), NEW_ITEMS_WORDS.noticeShowAll,
      NEW_ITEMS_WORDS.showNew, NEW_ITEMS_WORDS.review, NEW_ITEMS_WORDS.gotIt, NEW_ITEMS_WORDS.gotItFailed];
    for (const words of shown) expect(words).not.toMatch(/product line|rule|_|DROPSHIP|\barrival\b/i);
  });
});
