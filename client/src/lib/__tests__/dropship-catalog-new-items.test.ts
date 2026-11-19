import { describe, expect, it } from "vitest";
import {
  dropshipCatalogNewItemsAnswerSchema,
  type DropshipCatalogNewItemsAnswer,
  type DropshipCatalogNoticeAcknowledgeAnswer,
} from "@shared/dropship/vendor-catalog-reads";
import {
  NEW_ITEMS_NOTICE_LINES_SHOWN,
  endsNewItemsReview,
  newItemsNoticeModel,
  newItemsReviewFilters,
  showsNewItemsOption,
  withoutAcknowledged,
} from "../dropship-catalog-new-items";
import { NEW_ITEMS_WORDS } from "../dropship-catalog-new-items-words";

/** An answer as the server sends it, read through the shared schema, then frozen deep so a mutation throws. */
function answer(categories: Array<[categoryId: number, name: string, sizeCount: number, through: number]>): DropshipCatalogNewItemsAnswer {
  const parsed = dropshipCatalogNewItemsAnswerSchema.parse({
    categories: categories.map(([categoryId, categoryName, sizeCount, throughArrivalId]) => ({
      categoryId, categoryName, productCount: Math.max(1, Math.ceil(sizeCount / 4)), sizeCount, throughArrivalId,
    })),
  });
  parsed.categories.forEach((category) => Object.freeze(category));
  Object.freeze(parsed.categories);
  return Object.freeze(parsed);
}

function acknowledged(categoryId: number, seenThroughArrivalId: number): DropshipCatalogNoticeAcknowledgeAnswer {
  return Object.freeze({ outcome: "acknowledged", categoryId, seenThroughArrivalId });
}

const TWO = answer([[61, "Armalope", 3, 104], [40, "trading_card_sleeves", 1, 99]]);
const FIVE = answer([[1, "Armalope", 3, 10], [2, "Binders", 1, 11], [3, "Envelopes", 2, 12], [4, "Sleeves", 7, 13], [5, "Toploaders", 1, 14]]);

describe("newItemsNoticeModel (§11.4, §12.3)", () => {
  it("N1 one line per category in the server's order, its words, and both buttons named for the line", () => {
    const model = newItemsNoticeModel(TWO, false);
    expect(model?.more).toBeNull();
    expect(model?.lines.map((line) => line.text)).toEqual([
      "3 new items from Card Shellz in Armalope",
      "1 new item from Card Shellz in Trading Card Sleeves",
    ]);
    expect(model?.lines[0]).toEqual({
      categoryId: 61, name: "Armalope", sizeCount: 3, throughArrivalId: 104, text: "3 new items from Card Shellz in Armalope",
      reviewName: "Review: 3 new items from Card Shellz in Armalope", gotItName: "Got it: 3 new items from Card Shellz in Armalope",
    });
    // The category's name as step 1 shows it everywhere (formatStatus), never a raw code.
    expect(model?.lines[1].name).toBe("Trading Card Sleeves");
  });

  it("N2 nothing to show: loading, failed (no answer) or no category with new items", () => {
    expect(newItemsNoticeModel(undefined, false)).toBeNull();
    expect(newItemsNoticeModel(answer([]), false)).toBeNull();
    expect(newItemsNoticeModel(answer([]), true)).toBeNull();
  });

  it("N3 more than three categories: the first three lines, then \"and {k} more categories\"; Show all draws every line", () => {
    expect(NEW_ITEMS_NOTICE_LINES_SHOWN).toBe(3);
    const folded = newItemsNoticeModel(FIVE, false);
    expect(folded?.lines.map((line) => line.categoryId)).toEqual([1, 2, 3]);
    expect(folded?.more).toEqual({ count: 2, text: "and 2 more categories" });
    const all = newItemsNoticeModel(FIVE, true);
    expect(all?.lines.map((line) => line.categoryId)).toEqual([1, 2, 3, 4, 5]);
    expect(all?.more).toBeNull();
    // Four: one more category, singular.
    expect(newItemsNoticeModel(answer([[1, "A", 1, 1], [2, "B", 1, 2], [3, "C", 1, 3], [4, "D", 1, 4]]), false)?.more)
      .toEqual({ count: 1, text: NEW_ITEMS_WORDS.noticeMore(1) });
    // Exactly three: every line, no more line.
    expect(newItemsNoticeModel(answer([[1, "A", 1, 1], [2, "B", 1, 2], [3, "C", 1, 3]]), false)?.more).toBeNull();
  });

  it("N4 never mutates the answer and computes nothing the server did not count", () => {
    const model = newItemsNoticeModel(FIVE, true);
    expect(model?.lines.map((line) => [line.sizeCount, line.throughArrivalId])).toEqual(FIVE.categories.map((c) => [c.sizeCount, c.throughArrivalId]));
    expect(FIVE.categories).toHaveLength(5);
  });
});

describe("withoutAcknowledged (Got it the server took)", () => {
  it("A1 the category's line goes when the server's watermark covers what it counted; the other lines stay", () => {
    const after = withoutAcknowledged(TWO, acknowledged(61, 104));
    expect(after.categories.map((category) => category.categoryId)).toEqual([40]);
    expect(TWO.categories).toHaveLength(2);
    // A watermark past it (an earlier press in another tab went further) covers it too.
    expect(withoutAcknowledged(TWO, acknowledged(61, 120)).categories.map((category) => category.categoryId)).toEqual([40]);
  });

  it("A2 a newer arrival than the watermark keeps the line (the next read counts it); another category's answer changes nothing: same object", () => {
    expect(withoutAcknowledged(TWO, acknowledged(61, 103))).toBe(TWO);
    expect(withoutAcknowledged(TWO, acknowledged(7, 500))).toBe(TWO);
  });
});

describe("Review and the Show option", () => {
  it("R1 Review shows only the category's new items: its id, Show new, no search (so the table lists what the line counts)", () => {
    expect(newItemsReviewFilters(61)).toEqual({ search: "", categoryId: 61, show: "new" });
  });

  it("R2 \"New from Card Shellz\" is offered only while reviewing", () => {
    expect(showsNewItemsOption("new")).toBe(true);
    for (const show of ["all", "selected", "not_selected"] as const) expect(showsNewItemsOption(show)).toBe(false);
  });

  it("R3 a Got it ends the review of its own category only", () => {
    expect(endsNewItemsReview({ show: "new", categoryId: 61 }, 61)).toBe(true);
    expect(endsNewItemsReview({ show: "new", categoryId: 40 }, 61)).toBe(false);
    expect(endsNewItemsReview({ show: "all", categoryId: 61 }, 61)).toBe(false);
    expect(endsNewItemsReview({ show: "new", categoryId: null }, 61)).toBe(false);
  });
});
