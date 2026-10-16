import {
  CONVERSION_PAGE_SIZE,
  LISTING_RULES_CONVERSION_ERROR_CODES,
  MAX_CONVERSION_PAGE,
  type ConversionBlockerCode,
  type ConversionChangeRow,
  type ConversionChangedField,
  type ConversionKept,
  type ConversionReport,
  type ConversionSizeView,
  type ListingRulesConversionCheck,
  type PricingRuleRef,
  type SizeRef,
} from "@shared/dropship/listing-rules-conversion";
import type { ListingSettingsCategoriesResponse, ListingSettingsSizePrice, ListingSettingsSummary } from "@shared/dropship/listing-settings";
import {
  listingSettingsCategoriesQueryOptions,
  listingSettingsConversionQueryOptions,
  listingSettingsSummaryQueryOptions,
} from "./dropship-listing-settings";
import type { ListingSettingsReadState } from "./dropship-listing-settings-access";
import { contentProfileQueryKey, ebayCategoryRulesQueryKey } from "./dropship-listing-settings-content-requests";
import { LISTING_SETTINGS_SAVE_WORDS } from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS, type DrawerSettingRowKey, type DrawerTarget } from "./dropship-listing-settings-drawer";
import { builtFromWords, formatCents, recipeWords } from "./dropship-listing-settings-price-words";
import { pricingRulesQueryKey } from "./dropship-listing-settings-recipe";
import { shelfPathWords } from "./dropship-listing-settings-store-requests";
import {
  CONVERSION_BLOCKER_WORDS,
  LISTING_SETTINGS_CATEGORY_PRICE_WORDS,
  LISTING_SETTINGS_CONVERSION_WORDS,
  conversionBecomesCategoryWords,
  conversionBecomesProductsWords,
  conversionBecomesUnlistableWords,
  conversionBuiltFromLineWords,
  conversionBuiltFromWithClassWords,
  conversionEbayCategoryAlsoCalledWords,
  conversionEbayCategoryLineWords,
  conversionFixLabel,
  conversionKeptWords,
  conversionMismatchWords,
  conversionMixedWords,
  conversionMoreWords,
  conversionNeverAppliesWords,
  conversionNotCleanWords,
  conversionPolicyChangesWords,
  conversionPriceLineWords,
  conversionPricingRuleLineWords,
  conversionPricingRuleWords,
  conversionSetPriceLabel,
  conversionSharedWords,
  conversionSizeWords,
  conversionSomeSizesOnlyWords,
  conversionStillUnlistableWords,
  conversionStoreShelfLineWords,
  conversionTieWords,
  conversionUnmatchedWords,
  conversionWouldBlockListingWords,
  conversionWouldLosePriceWords,
  drawerStoreShelfValue,
  LISTING_SETTINGS_EDIT_WORDS,
  type ConversionPriceSourceClass,
} from "./dropship-listing-settings-words";
import { DropshipApiError } from "./dropship-ops-surface";

/**
 * Moving a store's older group rules into category and product settings, on
 * screen and read-only (Listing settings PR 11b, plan 5, 11.1, 11.2, 11.4,
 * 11.5): the older-rules state from the summary's three counts (D17; PR 10
 * D11), the line under the attention strip in its three forms, the [See what
 * changes] opener the line, the Category settings card and the category
 * editor share, the dry run's read (`GET …/conversion?page=N`, 11a2), and the
 * sheet's model: its states, its pages (one plan per screen), and every line
 * it shows.
 *
 * Rules this module keeps:
 * - The client never computes a diff or a price (D18): every row, list and
 *   count is the server's. Every amount is the server's integer cents through
 *   `formatCents`; every price source is the Prices tab's `builtFromWords`;
 *   every recipe is `recipeWords`; every blocker is the closed
 *   `CONVERSION_BLOCKER_WORDS` table; every name is the server's.
 * - No line names an id, a code or an eBay category number (owner rule;
 *   ids are keys only).
 * - The older-rules state is learned only from the summary's three counts,
 *   the same the writers refuse with (11.1; D16: no new summary key).
 * - Nothing can be moved here (11b): no apply, no notice, no job.
 *
 * Pure: no React, no network, no clock. Never mutates its inputs.
 */

const W = LISTING_SETTINGS_CONVERSION_WORDS;
const TOO_LARGE_CODE = "DROPSHIP_LISTING_SETTINGS_TOO_LARGE";
const HTTP_TOO_MANY_REQUESTS = 429;

// ---------------------------------------------------------------------------
// The older-rules state (D17; PR 10 D11, plan P21)
// ---------------------------------------------------------------------------

/** What the older-rules check reads from the summary. */
export type OlderRulesSummaryFacts = Pick<ListingSettingsSummary, "storeDefaults">;

/**
 * Whether the store still holds older group rules (D11, D17): the summary's
 * three counts, the same the writers refuse with (`S/application/dropship-listing-setting-write-support.ts`
 * listingSettingOlderRulesPresent; `SR` storeDefaults.*.groupRules). Any one
 * above zero means no category save goes through, and the older-rules line
 * shows (11.1).
 */
export function olderGroupRulesPresent(summary: OlderRulesSummaryFacts): boolean {
  const { price, ebayCategory, description } = summary.storeDefaults;
  return price.groupRules + ebayCategory.groupRules + description.groupRules > 0;
}

/** The check as the card, the line and the openers use it: unknown while the summary loads or after its latest attempt failed (UX-M9). */
export type OlderRulesState = "present" | "absent" | "unknown";

export function olderRulesState(summary: ListingSettingsReadState<OlderRulesSummaryFacts>): OlderRulesState {
  if (summary.error !== undefined && summary.error !== null) return "unknown";
  if (summary.data === undefined) return "unknown";
  return olderGroupRulesPresent(summary.data) ? "present" : "absent";
}

/** What the line, the openers and the read need from the summary: the older-rules counts and whether the selection is too large. */
export type ConversionSummaryFacts = ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog" | "storeDefaults">>;

function summaryTooLarge(summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog">>): boolean {
  return summary.data?.catalog.state === "too_large";
}

// ---------------------------------------------------------------------------
// The read (plan 5.2, 11.2, D14, D18)
// ---------------------------------------------------------------------------

/**
 * Whether the dry run's read may run: only while the sheet is open and the
 * summary does not say the selection is too large (D18). While the summary
 * is still loading it runs; a 422 from it then goes to the banner and closes
 * the sheet (`olderRulesSheetState`'s `close`). It is never a mount read.
 */
export function conversionCheckReadEnabled(input: { open: boolean; summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog">> }): boolean {
  return input.open && !summaryTooLarge(input.summary);
}

/**
 * One page of the dry run (`…/conversion?page=N`): key `[…prefix,
 * "conversion", page]`, fresh on every opening (staleTime 0, gcTime 0), no
 * retry, the answer parsed with the strict contract
 * (`listingRulesConversionCheckSchema`); off while the sheet is closed or the
 * selection is too large.
 */
export function conversionCheckQueryOptions(
  storeConnectionId: number,
  page: number,
  input: { open: boolean; summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog">> },
) {
  return listingSettingsConversionQueryOptions(storeConnectionId, page, { enabled: conversionCheckReadEnabled(input) });
}

// ---------------------------------------------------------------------------
// [See what changes] and the line under the attention strip (plan 5.3, 11.1, D17, K7)
// ---------------------------------------------------------------------------

/** [See what changes]: opens the sheet (`?sheet=convert`). The step carries it out. */
export interface OlderRulesOpener {
  label: string;
}

/**
 * What the step already knows beyond the summary: a read or a save was
 * refused because more than 10,000 sizes are chosen now (its banner shows,
 * and the sheet can't open, D18), while the summary on screen may still say
 * the selection fits until it is read again (D25).
 */
export interface OlderRulesTooLargeFacts {
  tooLarge?: boolean;
}

/**
 * The opener the line, the Category settings card and the category editor
 * show (D17): only while the store holds older group rules and the
 * selection is not too large (over 10,000 sizes nothing can be checked, K7),
 * by the summary or by the step's refusal. Null while the summary loads or
 * failed.
 */
export function olderRulesOpener(summary: ConversionSummaryFacts, step: OlderRulesTooLargeFacts = {}): OlderRulesOpener | null {
  if (olderRulesState(summary) !== "present" || summaryTooLarge(summary) || step.tooLarge === true) return null;
  return { label: W.seeWhatChanges };
}

/**
 * The line's form (5.3): `categories` when a chosen product is in a Card
 * Shellz category, `no_categories` when none is (or the categories can't be
 * read yet: its words are true either way), `too_large` over 10,000 sizes.
 */
export type OlderRulesLineForm = "categories" | "no_categories" | "too_large";

export interface OlderRulesLineModel {
  form: OlderRulesLineForm;
  text: string;
  /** [See what changes]; null in the too-large form (K7). */
  opener: OlderRulesOpener | null;
}

/**
 * The line under the attention strip (5.3, 11.1): shown whenever any of the
 * summary's three older-rules counts is above zero; hidden at zero, while the
 * summary loads, and after its latest attempt failed (the card's gate says
 * "Checking…" then, PR 10 D11). The categories read is the card's own
 * (`categoriesCardQueryOptions`); its last answer decides the form, also
 * while a refresh of it fails. Too large (no button, K7) when the summary
 * says so, when the categories read was refused as too large, or when the
 * step's banner already says so (`step.tooLarge`): [See what changes] would
 * open nothing then.
 */
export function olderRulesLineModel(
  summary: ConversionSummaryFacts,
  categories: ListingSettingsReadState<Pick<ListingSettingsCategoriesResponse, "categories">>,
  step: OlderRulesTooLargeFacts = {},
): OlderRulesLineModel | null {
  if (olderRulesState(summary) !== "present") return null;
  if (summaryTooLarge(summary) || step.tooLarge === true || isTooLargeError(categories.error)) {
    return { form: "too_large", text: W.lineTooLarge, opener: null };
  }
  const opener = olderRulesOpener(summary, step);
  const listed = categories.data?.categories.length ?? 0;
  return listed > 0
    ? { form: "categories", text: W.line, opener }
    : { form: "no_categories", text: W.lineNoCategories, opener };
}

// ---------------------------------------------------------------------------
// One size's row (plan 11.4, D18, D22; CUX#2)
// ---------------------------------------------------------------------------

/** A size's price in a row: the server's integer cents, or "—" for none. */
function priceWords(cents: number | null): string {
  return cents === null ? W.noPrice : formatCents(cents);
}

/**
 * A price's source class, as the dry run compares it (plan 3.2): `rules`
 * split by what the rule starts from. Read here only to tell two Built from
 * lines apart when their words are the same (never for money).
 */
function priceSourceClass(price: Pick<ListingSettingsSizePrice, "source" | "basis">): ConversionPriceSourceClass {
  if (price.source !== "rules") return price.source;
  return price.basis === null ? "rules" : `rules_${price.basis}`;
}

/**
 * "Built from: {before} → {after}" (11.4 row `priceSource`): each side in the
 * Prices tab's words (`builtFromWords`, D18). When two different classes
 * would read the same, each side adds its class, so the line never reads as
 * no change (CUX#2).
 */
function builtFromLine(before: ListingSettingsSizePrice, after: ListingSettingsSizePrice): string {
  let from = builtFromWords(before);
  let to = builtFromWords(after);
  const fromClass = priceSourceClass(before);
  const toClass = priceSourceClass(after);
  if (from === to && fromClass !== toClass) {
    from = conversionBuiltFromWithClassWords(from, fromClass);
    to = conversionBuiltFromWithClassWords(to, toClass);
  }
  return conversionBuiltFromLineWords(from, to);
}

/** A pricing rule as a row names it (11.4 row `pricingRule`); "None" when no rule covers the size or it owns its price. */
function pricingRuleWords(rule: PricingRuleRef | null): string {
  if (rule === null) return LISTING_SETTINGS_EDIT_WORDS.none;
  if (rule.kind === "tie") return W.ruleTie;
  return conversionPricingRuleWords(rule, recipeWords(rule.recipe));
}

/**
 * "eBay category: Toploaders → Sleeves" (11.4 row `ebayCategory`), by name
 * only: a nameless one is "the Card Shellz eBay category", none is "None",
 * and two ids with one name read "another eBay category also called “…”"
 * (the name is a label that can differ for the same id, CUX#2).
 */
function ebayCategoryLine(before: ConversionSizeView["ebayCategory"], after: ConversionSizeView["ebayCategory"]): string {
  const named = (side: ConversionSizeView["ebayCategory"]) => side === null ? LISTING_SETTINGS_EDIT_WORDS.none : side.name ?? W.cardShellzEbayCategory;
  const from = named(before);
  let to = named(after);
  if (before !== null && after !== null && before.id !== after.id && from === to) {
    to = after.name === null ? W.anotherCardShellzEbayCategory : conversionEbayCategoryAlsoCalledWords(after.name);
  }
  return conversionEbayCategoryLineWords(from, to);
}

/** A size's shelves as the drawer words them ("Supplies › Sleeves · second: Toploaders", or "None"). */
function shelfWords(names: readonly string[]): string {
  return drawerStoreShelfValue({ names: names.map(shelfPathWords) });
}

/** The blockers' words, in the closed order the answer gives them. */
function blockerWords(blockers: readonly ConversionBlockerCode[]): string {
  return blockers.map((code) => CONVERSION_BLOCKER_WORDS[code]).join(", ");
}

/** 11.4 row `listable`, by the two sides' blockers; null when neither side is blocked (a row never names it then). */
function listableLine(before: readonly ConversionBlockerCode[], after: readonly ConversionBlockerCode[]): string | null {
  if (before.length === 0 && after.length === 0) return null;
  if (before.length === 0) return conversionBecomesUnlistableWords(blockerWords(after));
  if (after.length === 0) return W.becomesListable;
  return conversionStillUnlistableWords(blockerWords(after));
}

/** One changed key's line (11.4), or null for none. Exhaustive over `CONVERSION_CHANGED_FIELDS`. */
function changedLine(field: ConversionChangedField, row: Pick<ConversionChangeRow, "before" | "after">): string | null {
  const { before, after } = row;
  switch (field) {
    case "price": return conversionPriceLineWords(priceWords(before.price.priceCents), priceWords(after.price.priceCents));
    case "priceSource": return builtFromLine(before.price, after.price);
    case "pricingRule": return conversionPricingRuleLineWords(pricingRuleWords(before.pricingRule), pricingRuleWords(after.pricingRule));
    case "ebayCategory": return ebayCategoryLine(before.ebayCategory, after.ebayCategory);
    case "storeShelf": return conversionStoreShelfLineWords(shelfWords(before.shelfNames), shelfWords(after.shelfNames));
    case "shippingPolicy": return conversionPolicyChangesWords("shipping");
    case "returnPolicy": return conversionPolicyChangesWords("return");
    case "paymentPolicy": return conversionPolicyChangesWords("payment");
    case "description": return W.descriptionChanges;
    case "listable": return listableLine(before.blockers, after.blockers);
  }
}

export interface ConversionRowModel {
  /** Stable among the rows shown: the size. */
  key: string;
  productVariantId: number;
  /** "Penny Sleeves · Pack of 100". */
  head: string;
  /** One line per changed key, in the order the row names them (the contract's). */
  lines: string[];
}

/** One changed size (11.4): its head and a line for each key the server says changed; nothing is compared here (D18). */
export function conversionRowLines(row: ConversionChangeRow): ConversionRowModel {
  return {
    key: `size:${row.productVariantId}`,
    productVariantId: row.productVariantId,
    head: conversionSizeWords(row.productName, row.sizeName),
    lines: row.changed.flatMap((field) => {
      const line = changedLine(field, row);
      return line === null ? [] : [line];
    }),
  };
}

// ---------------------------------------------------------------------------
// What blocks a move, and the way to fix each size (plan 11.2, D9; CUX#3, CMC#3)
// ---------------------------------------------------------------------------

/**
 * Where a blocker is fixed in the drawer (11.2): `no_ebay_category` on the
 * eBay category row; own text, a description tie and the description issues
 * on Description; a size that can't be priced or is outside a limit on the
 * size's own price (null: the drawer opens on the size). Closed over
 * `CONVERSION_BLOCKER_CODES`.
 */
export const CONVERSION_BLOCKER_FIX_ROWS: Readonly<Record<ConversionBlockerCode, DrawerSettingRowKey | null>> = Object.freeze({
  no_ebay_category: "ebayCategory",
  size_cannot_be_priced: null,
  own_text_needs_check: "descriptionTemplate",
  description_group_conflict: "descriptionTemplate",
  price_outside_limit: null,
  listing_content_catalog_too_large: "descriptionTemplate",
  listing_content_description_required: "descriptionTemplate",
  listing_content_description_too_large: "descriptionTemplate",
});

/** Where [Set a price] or [Fix] opens the drawer: on the size (its Exact price), or on the product with a row to land on (10b's landing request). */
export interface ConversionDrawerLanding {
  target: DrawerTarget;
  /** The drawer row to land on and open; null opens the drawer on the size itself. */
  row: DrawerSettingRowKey | null;
}

/** The drawer landing for a blocked size's blocker (11.2). */
export function conversionFixLanding(size: Pick<SizeRef, "productId" | "productVariantId">, blocker: ConversionBlockerCode): ConversionDrawerLanding {
  const row = CONVERSION_BLOCKER_FIX_ROWS[blocker];
  return row === null
    ? { target: { productId: size.productId, productVariantId: size.productVariantId }, row: null }
    : { target: { productId: size.productId }, row };
}

/** What a blocked size's one button does (11.2). The step carries it out in one push that takes the sheet off the address (D20, D21). */
export type ConversionSizeAction =
  /** [Set a price]: the drawer on the size's Exact price. */
  | { kind: "set_price"; label: string; ariaLabel: string; landing: ConversionDrawerLanding }
  /** [Fix]: the drawer on the row of the size's first blocker (in the closed order). */
  | { kind: "fix"; label: string; ariaLabel: string; blocker: ConversionBlockerCode; landing: ConversionDrawerLanding };

export interface ConversionBlockedSize {
  key: string;
  /** "Penny Sleeves · Pack of 100". */
  text: string;
  /** "Now: $4.99", the size's price today (the server's cents); null when it has none (beyond 11.4). */
  priceNow: string | null;
  /** Why a listed size would be blocked: "no eBay category, the description is too long"; null for a lost price. */
  reasons: string | null;
  action: ConversionSizeAction;
}

export interface ConversionBlockedList {
  /** "3 sizes would have no price after the move. …", counted over every size (`total`). */
  text: string;
  sizes: ConversionBlockedSize[];
  /** "and 12 more" beyond the 100 the answer lists; null for none. */
  more: string | null;
}

export interface ConversionBlockedModel {
  heading: string;
  wouldLosePrice: ConversionBlockedList | null;
  wouldBlockListing: ConversionBlockedList | null;
  /** The store text cap (D9c); null when the move stays under it. */
  tooMuchText: string | null;
}

function priceNowWords(cents: number | null): string | null {
  return cents === null ? null : `${LISTING_SETTINGS_CATEGORY_PRICE_WORDS.now} ${formatCents(cents)}`;
}

/** "Before you can move them over" (11.2): each size with its [Set a price] or [Fix]; null when nothing blocks the move. */
export function blockedLines(blocked: ListingRulesConversionCheck["blocked"]): ConversionBlockedModel | null {
  const { wouldLosePrice, wouldBlockListing, tooMuchText } = blocked;
  if (wouldLosePrice.total === 0 && wouldBlockListing.total === 0 && !tooMuchText) return null;
  return {
    heading: W.blockedHeading,
    wouldLosePrice: wouldLosePrice.total === 0 ? null : {
      text: conversionWouldLosePriceWords(wouldLosePrice.total),
      sizes: wouldLosePrice.items.map((size): ConversionBlockedSize => ({
        key: `size:${size.productVariantId}`,
        text: conversionSizeWords(size.productName, size.sizeName),
        priceNow: priceNowWords(size.priceCents),
        reasons: null,
        action: {
          kind: "set_price",
          label: W.setPrice,
          ariaLabel: conversionSetPriceLabel(size.productName, size.sizeName),
          landing: { target: { productId: size.productId, productVariantId: size.productVariantId }, row: null },
        },
      })),
      more: conversionMoreWords(wouldLosePrice.total - wouldLosePrice.items.length),
    },
    wouldBlockListing: wouldBlockListing.total === 0 ? null : {
      text: conversionWouldBlockListingWords(wouldBlockListing.total),
      sizes: wouldBlockListing.items.map((size): ConversionBlockedSize => {
        // The contract gives at least one reason, in the closed order; the first is the one [Fix] opens on.
        const blocker = size.reasons[0];
        return {
          key: `size:${size.productVariantId}`,
          text: conversionSizeWords(size.productName, size.sizeName),
          priceNow: priceNowWords(size.priceCents),
          reasons: blockerWords(size.reasons),
          action: {
            kind: "fix",
            label: W.fix,
            ariaLabel: conversionFixLabel(size.productName, size.sizeName),
            blocker,
            landing: conversionFixLanding(size, blocker),
          },
        };
      }),
      more: conversionMoreWords(wouldBlockListing.total - wouldBlockListing.items.length),
    },
    tooMuchText: tooMuchText ? W.tooMuchText : null,
  };
}

// ---------------------------------------------------------------------------
// What the rules become, why sizes change, what is kept (plan 11.2, 11.4)
// ---------------------------------------------------------------------------

/** A list of lines with its "and 12 more" (items beyond the 100 the answer carries). */
export interface ConversionLinesList {
  key: string;
  lines: string[];
  more: string | null;
}

export interface ConversionBecomesModel {
  heading: string;
  /** "Sleeves: price, text above and below", in the server's order (name, then id). */
  categories: ConversionLinesList;
  /** "2 products get their own price: Penny Sleeves, Team Bags", one line per set of settings, in the order first met. */
  products: ConversionLinesList;
}

/** "They become:" (11.2): the categories with the settings they get, then the products with their own values; null when the move writes neither. */
export function becomesLines(becomes: ListingRulesConversionCheck["becomes"]): ConversionBecomesModel | null {
  const { categories, products } = becomes;
  if (categories.total === 0 && products.total === 0) return null;
  // Products that get the same settings share one line (11.4 `becomesProducts`), in the order the server lists them.
  const groups = new Map<string, { settings: (typeof products.items)[number]["settings"]; names: string[] }>();
  for (const product of products.items) {
    const key = product.settings.join(",");
    const group = groups.get(key);
    if (group) group.names.push(product.productName);
    else groups.set(key, { settings: product.settings, names: [product.productName] });
  }
  return {
    heading: W.becomesHeading,
    categories: {
      key: "categories",
      lines: categories.items.map((category) => conversionBecomesCategoryWords(category.categoryName, category.settings)),
      more: conversionMoreWords(categories.total - categories.items.length),
    },
    products: {
      key: "products",
      lines: [...groups.values()].map((group) => conversionBecomesProductsWords(group.settings, group.names)),
      more: conversionMoreWords(products.total - products.items.length),
    },
  };
}

/** The report's lists in the sheet's order (11.2): ties, name mismatches, unmatched names, shared names, some sizes only, mixed rules. */
export const CONVERSION_REASON_LISTS = ["ties", "nameMismatches", "unmatched", "shared", "someSizesOnly", "mixed"] as const;
export type ConversionReasonList = (typeof CONVERSION_REASON_LISTS)[number];

export interface ConversionReasonsModel {
  /** "Why some sizes would change"; null on a clean sheet, where no size changes (its items are listed without it). */
  heading: string | null;
  /** The lists that hold an item, in `CONVERSION_REASON_LISTS` order. */
  lists: ConversionLinesList[];
}

export interface ConversionReportModel {
  reasons: ConversionReasonsModel | null;
  /** "Your rule “…” doesn't decide any of your chosen sizes, so it goes away."; null for none. */
  neverApplies: ConversionLinesList | null;
}

function reasonLines(report: ConversionReport, list: ConversionReasonList): string[] {
  switch (list) {
    case "ties": return report.ties.items.map((item) => conversionTieWords(item.productName, item.setting));
    case "nameMismatches": return report.nameMismatches.items.map((item) => conversionMismatchWords(item));
    case "unmatched": return report.unmatched.items.map((item) => conversionUnmatchedWords(item.ruleName, item.categoryName));
    case "shared": return report.shared.items.map((item) => conversionSharedWords(item.categoryCount, item.ruleName, item.categoryName));
    case "someSizesOnly": return report.someSizesOnly.items.map((item) => conversionSomeSizesOnlyWords(item.ruleName, item.setting, item.productName));
    case "mixed": return report.mixed.items.map((item) => conversionMixedWords(item.setting, item.productName));
  }
}

/**
 * The report (11.2, 11.4): "Why some sizes would change" with each list's
 * items and "and N more", then "Never applies". A rule is listed once, as
 * the server lists it (D5). `state` decides the heading only.
 */
export function reportLines(report: ConversionReport, state: "clean" | "not_clean"): ConversionReportModel {
  const lists = CONVERSION_REASON_LISTS.flatMap((list): ConversionLinesList[] => report[list].total === 0 ? [] : [{
    key: list,
    lines: reasonLines(report, list),
    more: conversionMoreWords(report[list].total - report[list].items.length),
  }]);
  const never = report.neverApplies;
  return {
    reasons: lists.length === 0 ? null : { heading: state === "not_clean" ? W.reasonsHeading : null, lists },
    neverApplies: never.total === 0 ? null : {
      key: "neverApplies",
      lines: never.items.map((item) => conversionNeverAppliesWords(item.ruleName)),
      more: conversionMoreWords(never.total - never.items.length),
    },
  };
}

/** "Kept as they are: 12 exact prices, …" (11.4 `kept`, D6); null when the move keeps no per-size row. */
export function keptLine(kept: ConversionKept): string | null {
  return conversionKeptWords(kept);
}

/** "Products you choose later use …" (11.4 `laterProducts`), under the summary line of a clean or not-clean sheet; null otherwise. */
export function laterProductsLine(state: ListingRulesConversionCheck["state"]): string | null {
  return state === "no_older_rules" ? null : W.laterProducts;
}

// ---------------------------------------------------------------------------
// The sheet's pages: one plan per screen (plan 11.2, D25; CUX#12)
// ---------------------------------------------------------------------------

/**
 * What the open sheet keeps between renders: how many pages it reads (page 0
 * and those [Load more] added), whether a page of another plan reset them
 * since it opened (the `changed` line stays until the sheet closes), and
 * whether it already re-read the summary, the categories and the profiles
 * after page 0 found the store moved (once per opening, 11.5).
 */
export interface OlderRulesSheetSession {
  pageCount: number;
  planChanged: boolean;
  movedReread: boolean;
}

/**
 * What changes the open sheet's session. Opening needs no event: the sheet's
 * body mounts per opening and starts from `OLDER_RULES_SHEET_OPENED`.
 */
export type OlderRulesSheetEvent =
  /** [Load more]: one page more, up to the last page the dry run has (199). */
  | { type: "load_more" }
  /** A page answered with another plan than page 0's: back to page 0, which is read again, and the `changed` line. */
  | { type: "plan_changed" }
  /** The step re-read the summary and the profiles after page 0 found no older rules (11.5). */
  | { type: "moved_reread" };

/** The session of a sheet just opened: page 0 only, nothing seen yet. */
export const OLDER_RULES_SHEET_OPENED: Readonly<OlderRulesSheetSession> = Object.freeze({ pageCount: 1, planChanged: false, movedReread: false });

/** The session after one event; a new object each time. */
export function olderRulesSheetSession(session: OlderRulesSheetSession, event: OlderRulesSheetEvent): OlderRulesSheetSession {
  switch (event.type) {
    case "load_more": return { ...session, pageCount: Math.min(session.pageCount + 1, MAX_CONVERSION_PAGE + 1) };
    case "plan_changed": return { ...session, pageCount: 1, planChanged: true };
    case "moved_reread": return { ...session, movedReread: true };
  }
}

/** The pages the open sheet reads, in order: 0 to `pageCount - 1`. */
export function olderRulesSheetPages(session: Pick<OlderRulesSheetSession, "pageCount">): number[] {
  const count = Math.max(1, Math.min(session.pageCount, MAX_CONVERSION_PAGE + 1));
  return Array.from({ length: count }, (_, page) => page);
}

/**
 * The query keys the step invalidates once per opening when page 0 finds the
 * store has no older rules any more (11.5, D25): the summary and the
 * categories (the line and the card re-decide) and the three profiles the
 * move empties (pricing rules, eBay category rules, description profile).
 * Never the conversion key, so it cannot loop. 11e1 adds the notice's key.
 */
export function olderRulesGoneRereadKeys(storeConnectionId: number): ReadonlyArray<readonly unknown[]> {
  return [
    listingSettingsSummaryQueryOptions(storeConnectionId).queryKey,
    listingSettingsCategoriesQueryOptions(storeConnectionId).queryKey,
    pricingRulesQueryKey(storeConnectionId),
    ebayCategoryRulesQueryKey(storeConnectionId),
    contentProfileQueryKey(storeConnectionId),
  ];
}

// ---------------------------------------------------------------------------
// The sheet (plan 5.3, 11.2, 11.5, 3.7)
// ---------------------------------------------------------------------------

/**
 * A confirmed outcome the sheet keeps on screen until it closes, whatever a
 * re-read answers (11.2, CUX#11). Nothing can be moved in 11b, so none
 * exists yet: 11d defines `converted`, `replayed` and `nothing_to_convert`.
 */
export type OlderRulesSheetOutcome = never;

export interface OlderRulesSheetInput {
  /** The reads of `olderRulesSheetPages(session)`, in page order, as React Query holds them. */
  pages: readonly ListingSettingsReadState<ListingRulesConversionCheck>[];
  session: OlderRulesSheetSession;
  outcome: OlderRulesSheetOutcome | null;
}

export type OlderRulesSheetProblem =
  /** 5xx, a refusal, or an answer off the contract (PLAN10 K7): [Try again]. */
  | { kind: "failed"; text: string; retryLabel: string }
  /** 429 (PLAN10 D10): too many checks in a minute. */
  | { kind: "rate_limited"; text: string; retryLabel: string }
  /** 503 CHECK_UNAVAILABLE: the costs couldn't be read; [Try again] in a minute. */
  | { kind: "check_unavailable"; text: string; retryLabel: string }
  /** 422 TOO_LARGE: the sheet closes and the banner explains (D18). */
  | { kind: "too_large"; text: string; retryLabel: null };

/** A further page that hasn't answered: reading it, or its read failed (with Try again). */
export type OlderRulesSheetMore =
  | { kind: "loading"; text: string }
  | { kind: "problem"; problem: OlderRulesSheetProblem };

export interface OlderRulesSheetChanges {
  heading: string;
  /** Every changed size the dry run counts (`changes.total`). */
  total: number;
  /** The rows of the pages read so far that belong to page 0's plan, each size once. */
  rows: ConversionRowModel[];
  /** [Load more]: reads the next page; shown while more rows exist and every page read so far answered. */
  loadMore: { label: string; shown: boolean };
  /** A further page still reading, or failed; null when every page read answered. */
  more: OlderRulesSheetMore | null;
}

export interface OlderRulesSheetContent {
  state: "clean" | "not_clean";
  /** "Moving them over changes nothing in your listings." or "Moving them over would change 12 sizes. They're listed below." */
  summary: string;
  /** "Products you choose later use …", on a clean and a not-clean sheet alike. */
  laterProducts: string | null;
  blocked: ConversionBlockedModel | null;
  becomes: ConversionBecomesModel | null;
  reasons: ConversionReasonsModel | null;
  /** "Sizes that would change" with [Load more]; null when no size changes. */
  changes: OlderRulesSheetChanges | null;
  neverApplies: ConversionLinesList | null;
  kept: string | null;
}

export interface OlderRulesSheetState {
  title: string;
  /** What the body shows: page 0 loading, a problem, the store has no older rules any more, or the report. */
  view: "loading" | "problem" | "none" | "report";
  loadingLine: string | null;
  problem: OlderRulesSheetProblem | null;
  /** The check refused the selection as too large, on page 0 or a later page: the step closes the sheet (the banner says why, D18; 5.3). */
  close: boolean;
  /** "Your store has no older group rules any more."; null otherwise. */
  noneLine: string | null;
  /**
   * Page 0 found no older rules and no confirmed outcome is shown: the step
   * re-reads `olderRulesGoneRereadKeys` once per opening, then sends
   * `moved_reread` (11.5).
   */
  rereadAfterMoved: boolean;
  /**
   * A page answered with another plan than page 0's (CUX#12): the step sends
   * `plan_changed` (the further pages drop) and reads page 0 again. Until
   * then only page 0's rows are shown.
   */
  resetPages: boolean;
  /** "Something changed since you opened this. Check the list again." from a reset until the sheet closes; null otherwise. */
  changedLine: string | null;
  content: OlderRulesSheetContent | null;
  /** The read-only footer (11b): "This is a preview. Nothing is moved yet." [Close]. */
  footer: { text: string; closeLabel: string };
}

function isTooLargeError(error: unknown): boolean {
  return error instanceof DropshipApiError && error.code === TOO_LARGE_CODE;
}

/**
 * The first page read the check refused as too large, page 0 or a later one
 * (5.3: "a 422 closes it"); undefined when none was. The step's banner says
 * why (D18), as for the lists' refusals.
 */
export function conversionTooLargeError(pages: readonly ListingSettingsReadState<unknown>[]): unknown {
  return pages.find((page) => isTooLargeError(page.error))?.error;
}

/** A failed read in the vendor's words (5.3): too large closes, 429, the costs unavailable, else Try again. */
function sheetProblem(error: unknown): OlderRulesSheetProblem {
  const tryAgain = LISTING_SETTINGS_SAVE_WORDS.tryAgain;
  if (isTooLargeError(error)) return { kind: "too_large", text: W.tooLarge, retryLabel: null };
  if (error instanceof DropshipApiError && error.status === HTTP_TOO_MANY_REQUESTS) {
    return { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: tryAgain };
  }
  if (error instanceof DropshipApiError && error.code === LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable) {
    return { kind: "check_unavailable", text: W.checkUnavailable, retryLabel: tryAgain };
  }
  return { kind: "failed", text: W.failed, retryLabel: tryAgain };
}

type PageState =
  | { state: "loading" }
  | { state: "failed"; error: unknown }
  | { state: "answered"; check: ListingRulesConversionCheck };

/** A page's read, the latest attempt winning (as the lists do): an error replaces an older answer kept beside it. */
function pageState(read: ListingSettingsReadState<ListingRulesConversionCheck> | undefined): PageState {
  if (read === undefined) return { state: "loading" };
  if (read.error !== undefined && read.error !== null) return { state: "failed", error: read.error };
  return read.data === undefined ? { state: "loading" } : { state: "answered", check: read.data };
}

/** The changed rows of page 0 and the further pages of its plan, each size once (a rename can move a size between pages). */
function planRows(pages: readonly PageState[]): ConversionRowModel[] {
  const seen = new Set<number>();
  const rows: ConversionRowModel[] = [];
  for (const page of pages) {
    if (page.state !== "answered") continue;
    for (const row of page.check.changes.rows) {
      if (seen.has(row.productVariantId)) continue;
      seen.add(row.productVariantId);
      rows.push(conversionRowLines(row));
    }
  }
  return rows;
}

/**
 * The sheet from its page reads and its session (5.3, 11.2, 11.5): page 0
 * decides the state (loading, a problem, `none`, or the report); a further
 * page joins the rows only while its plan hash is page 0's. A page of
 * another plan asks for a reset (`resetPages`) and shows only page 0's rows
 * meanwhile; the `changed` line then stays until the sheet closes. A page
 * refused as too large, page 0 or a later one, closes the sheet. Read-only:
 * the footer is the preview's.
 */
export function olderRulesSheetState(input: OlderRulesSheetInput): OlderRulesSheetState {
  const pages = (input.pages.length === 0 ? [undefined] : [...input.pages]).map(pageState);
  const first = pages[0];
  const base = {
    title: W.sheetTitle,
    loadingLine: null,
    problem: null,
    // A 422 on any page closes the sheet (5.3): over 10,000 sizes no page can be checked.
    close: conversionTooLargeError(input.pages) !== undefined,
    noneLine: null,
    rereadAfterMoved: false,
    resetPages: false,
    changedLine: input.session.planChanged ? W.changed : null,
    content: null,
    footer: { text: W.preview, closeLabel: DRAWER_WORDS.close },
  } satisfies Omit<OlderRulesSheetState, "view">;

  if (first.state === "loading") return { ...base, view: "loading", loadingLine: W.loading };
  if (first.state === "failed") {
    return { ...base, view: "problem", problem: sheetProblem(first.error) };
  }
  const check = first.check;
  if (check.state === "no_older_rules") {
    return { ...base, view: "none", noneLine: W.none, rereadAfterMoved: input.outcome === null && !input.session.movedReread };
  }

  // One plan per screen: a further page of another plan (or of a store moved meanwhile) never joins page 0's rows.
  const resetPages = pages.slice(1).some((page) => page.state === "answered" && page.check.planHash !== check.planHash);
  const joined = resetPages ? [first] : pages;
  const rows = planRows(joined);
  const pending = resetPages ? undefined : joined.slice(1).find((page) => page.state !== "answered");
  const more: OlderRulesSheetMore | null = pending === undefined ? null
    : pending.state === "failed" ? { kind: "problem", problem: sheetProblem(pending.error) }
      : { kind: "loading", text: W.loading };
  const total = check.changes.total;
  // The next page exists while the pages read hold fewer rows than the server counts, up to its last page (199).
  const hasNext = !resetPages && joined.length * CONVERSION_PAGE_SIZE < total && joined.length <= MAX_CONVERSION_PAGE;
  const report = reportLines(check.report, check.state);

  return {
    ...base,
    view: "report",
    resetPages,
    changedLine: resetPages || input.session.planChanged ? W.changed : null,
    content: {
      state: check.state,
      // A store held back by its text alone changes no listing: its summary says so, and its block says why (beyond 11.4).
      summary: total === 0 ? W.clean : conversionNotCleanWords(total),
      laterProducts: laterProductsLine(check.state),
      blocked: blockedLines(check.blocked),
      becomes: becomesLines(check.becomes),
      reasons: report.reasons,
      changes: total === 0 ? null : {
        heading: W.changesHeading,
        total,
        rows,
        loadMore: { label: W.loadMore, shown: hasNext && more === null },
        more,
      },
      neverApplies: report.neverApplies,
      kept: keptLine(check.kept),
    },
  };
}
