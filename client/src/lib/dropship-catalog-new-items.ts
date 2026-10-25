/**
 * Catalog step 1's new-items notice (step 1 plan S2-5, PR B; PLAN-B v4.1
 * §11.4, §12.3, §13): when Card Shellz adds items to a category the vendor
 * sells from, one line per category says how many are new, with [Review]
 * (the table shows only that category's new items) and [Got it] (the vendor
 * has seen them; the line goes). More than three categories: the first three
 * lines, then "and {k} more categories" with [Show all].
 *
 * Rules this module keeps:
 * - Everything comes from the server's answer (`GET /api/dropship/catalog/
 *   new-items`): its counts and its order (by category name). The page
 *   computes nothing new itself, so the notice and `selection=new` always
 *   count the same sizes (TESTS-8).
 * - Nothing here adds an item: Review only filters the table; the vendor
 *   checks and saves (decision 3).
 * - "Got it" sends the category and the `throughArrivalId` the line was shown
 *   with; once the server took it, the line is taken off only if the server's
 *   watermark covers it (a newer arrival keeps the line, with its new count,
 *   on the next read).
 *
 * Pure: no React, no network, no clock.
 */
import type {
  DropshipCatalogNewItemsAnswer,
  DropshipCatalogNoticeAcknowledgeAnswer,
} from "@shared/dropship/vendor-catalog-reads";
import { formatStatus } from "./dropship-ops-surface";
import { NEW_ITEMS_WORDS } from "./dropship-catalog-new-items-words";
import type { ChooseFilters } from "./dropship-catalog-choose-requests";

/** Lines shown before "and {k} more categories" (§12.3: more than three categories → `noticeMore` with Show all). */
export const NEW_ITEMS_NOTICE_LINES_SHOWN = 3;

/** One category's line, as the notice draws it. */
export interface NewItemsNoticeLine {
  categoryId: number;
  /** The category's name as step 1 shows it everywhere (`formatStatus`, as the categories card and the table). */
  name: string;
  /** New sizes ("items") in it. */
  sizeCount: number;
  /** What "Got it" sends back: the highest arrival this line counts. */
  throughArrivalId: number;
  /** "3 new items from Card Shellz in Armalope". */
  text: string;
  /** The buttons' accessible names: their label and the line ("Review: 3 new items from Card Shellz in Armalope"). */
  reviewName: string;
  gotItName: string;
}

export interface NewItemsNoticeModel {
  lines: readonly NewItemsNoticeLine[];
  /** "and {k} more categories" with [Show all]; null when every line is shown. */
  more: { count: number; text: string } | null;
}

/**
 * The notice from the server's answer: null while it loads, after it failed
 * (a notice is never a reason to block the step; the read retries by itself)
 * and when nothing is new. `expanded` (Show all pressed) shows every line.
 */
export function newItemsNoticeModel(answer: DropshipCatalogNewItemsAnswer | undefined, expanded: boolean): NewItemsNoticeModel | null {
  const categories = answer?.categories ?? [];
  if (categories.length === 0) return null;
  const lines = categories.map((category): NewItemsNoticeLine => {
    const name = formatStatus(category.categoryName);
    const text = NEW_ITEMS_WORDS.noticeLine(category.sizeCount, name);
    return {
      categoryId: category.categoryId,
      name,
      sizeCount: category.sizeCount,
      throughArrivalId: category.throughArrivalId,
      text,
      reviewName: NEW_ITEMS_WORDS.reviewName(text),
      gotItName: NEW_ITEMS_WORDS.gotItName(text),
    };
  });
  if (expanded || lines.length <= NEW_ITEMS_NOTICE_LINES_SHOWN) return { lines, more: null };
  const hidden = lines.length - NEW_ITEMS_NOTICE_LINES_SHOWN;
  return { lines: lines.slice(0, NEW_ITEMS_NOTICE_LINES_SHOWN), more: { count: hidden, text: NEW_ITEMS_WORDS.noticeMore(hidden) } };
}

/**
 * The answer after a "Got it" the server took: the category's line goes when
 * the server's watermark (`seenThroughArrivalId`) covers what it counted.
 * The same object when nothing goes (a newer arrival in the category keeps
 * its line until the next read counts it). Never mutates.
 */
export function withoutAcknowledged(answer: DropshipCatalogNewItemsAnswer, acknowledged: DropshipCatalogNoticeAcknowledgeAnswer): DropshipCatalogNewItemsAnswer {
  const categories = answer.categories.filter((category) => category.categoryId !== acknowledged.categoryId
    || category.throughArrivalId > acknowledged.seenThroughArrivalId);
  return categories.length === answer.categories.length ? answer : { ...answer, categories };
}

/**
 * The table's filters for [Review]: only the category's new items (§12.3: Show "New from Card Shellz", the
 * category's id). The search is cleared, so the table lists exactly what the line counts.
 */
export function newItemsReviewFilters(categoryId: number): ChooseFilters {
  return { search: "", categoryId, show: "new" };
}

/** The Show menu offers "New from Card Shellz" while the vendor reviews the notice (§12.3), and only then. */
export function showsNewItemsOption(show: ChooseFilters["show"]): boolean {
  return show === "new";
}

/**
 * After a "Got it" the server took: the table was reviewing that category's new items, so the review is over and the
 * table shows the category's items again (Show "All"); any other filter stays as it is.
 */
export function endsNewItemsReview(filters: Pick<ChooseFilters, "categoryId" | "show">, categoryId: number): boolean {
  return filters.show === "new" && filters.categoryId === categoryId;
}
