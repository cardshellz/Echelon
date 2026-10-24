/**
 * The vendor's words for Catalog step 1's new-items notice (PR B, PLAN-B v4.1
 * §11.4, §13): "3 new items from Card Shellz in Armalope · [Review] · [Got
 * it]", "and 2 more categories · [Show all]", and Show "New from Card
 * Shellz". Words marked "Stage 3/5 (step 1 plan S2-5)" are PR B's
 * (PROPOSED), so a later stage can change them in one place; the one "Kept"
 * entry is the portal's existing words for a "Got it" that failed. No
 * function returns a raw code or an id. Pure: no React, no network, no clock.
 */
import { formatChooseCount } from "./dropship-catalog-choose-words";
import { LISTING_SETTINGS_CONVERSION_WORDS } from "./dropship-listing-settings-words";

/** The two buttons of a notice line, as the line shows them. */
const REVIEW = "Review";
const GOT_IT = "Got it";

export const NEW_ITEMS_WORDS = Object.freeze({
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. One category's line of the notice; n is the new sizes ("items", the step's word).
  noticeLine: (n: number, category: string) => (n === 1
    ? `1 new item from Card Shellz in ${category}`
    : `${formatChooseCount(n)} new items from Card Shellz in ${category}`),
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The line's button that shows the category's new items in the table.
  review: REVIEW,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. The line's button that hides it: the vendor has seen these new items.
  gotIt: GOT_IT,
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. After the first lines when more categories have new items ("category" for one).
  noticeMore: (k: number) => (k === 1 ? "and 1 more category" : `and ${formatChooseCount(k)} more categories`),
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Beside `noticeMore`: every category's line.
  noticeShowAll: "Show all",
  // Stage 3/5 (step 1 plan S2-5): PROPOSED. Show = `selection=new`, while the vendor reviews the notice.
  showNew: "New from Card Shellz",
  // Composed, no new words: Review's accessible name is its label and the line it acts on ("Review: 3 new items from
  // Card Shellz in Armalope"), so one line's button is told apart from the next's, and the name starts with what it shows.
  reviewName: (line: string) => `${REVIEW}: ${line}`,
  // Composed, no new words: Got it's accessible name, the same way.
  gotItName: (line: string) => `${GOT_IT}: ${line}`,
  // Kept (Listing settings PR 11e1, LISTING_SETTINGS_CONVERSION_WORDS.noticeFailed): a "Got it" whose answer never came,
  // or was a refusal. The line stays, and pressing again is safe: "Got it" is idempotent by state.
  gotItFailed: LISTING_SETTINGS_CONVERSION_WORDS.noticeFailed,
});
