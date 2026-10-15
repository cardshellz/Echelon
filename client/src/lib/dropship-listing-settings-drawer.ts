import type { QueryClient } from "@tanstack/react-query";
import {
  MAX_LISTING_PRICE_CENTS,
  saveListingPriceInputSchema,
  type ListingPriceSetting,
  type SaveListingPriceInput,
} from "@shared/dropship/listing-price";
import {
  LISTING_SETTINGS_SETTING_KEYS,
  type ListingSettingsFixCode,
  type ListingSettingsPriceLimit,
  type ListingSettingsPriceRule,
  type ListingSettingsProductDetail,
  type ListingSettingsProductSize,
  type ListingSettingsSettingKey,
  type ListingSettingsSizePrice,
} from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { DropshipApiError, fetchJson, queryErrorMessage } from "./dropship-ops-surface";
import {
  inheritedListingPrice,
  listingPriceEndpoint,
  listingPriceInput,
  parseListingPriceCents,
  readListingPrice,
  readSavedListingPrice,
  type ListingPriceIdentity,
} from "./dropship-listing-price";
import { listingSettingsQueryKey } from "./dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "./dropship-listing-settings-access";
import {
  classifyWriteFailure,
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_KEY_PREFIXES,
  LISTING_SETTINGS_SAVE_WORDS,
  type DraftValue,
  type EditorId,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { builtFromWords, formatCents, recipeWords, retailFallbackFixWords, w9OriginWords } from "./dropship-listing-settings-price-words";
import {
  DESCRIPTION_EDIT_FIELDS,
  drawerChangeKind,
  isPolicyEditField,
  ownTextCheckChoices,
  PRODUCT_EDIT_FIELDS,
  productFieldRights,
  readProductPriceDraft,
  readProductSettingsDraft,
  sizeLeftoverFields,
  sizesDifferPick,
  type DescriptionEditField,
  type FieldChoice,
  type OwnTextCheck,
  type PolicyEditField,
  type ProductEditField,
  type ProductFieldChoice,
  type ProductFieldRights,
  type ProductOwnSettings,
  type ProductSettingsChoices,
  type ProductSettingsPicks,
  type ProductSettingsRights,
  type SizesDifferField,
  type SizesDifferSetting,
} from "./dropship-listing-settings-product-edit";
// The live setup read with Card Shellz shipping's facts: the rows name policies from it, and a quick pick checks a policy as its editor does (5.3).
import { shelfPathWords, type PolicySetupFacts } from "./dropship-listing-settings-store-requests";
import {
  descriptionPendingWords,
  drawerDescriptionTemplateValue,
  drawerEbayCategoryValue,
  drawerMainTextValue,
  drawerPolicyValue,
  drawerSourceWords,
  drawerStoreShelfValue,
  fromCategorySettingsWords,
  GROUP_RULE_ORDER_NOTE,
  LISTING_SETTINGS_EDIT_WORDS,
  ownSettingsSentence,
  pendingSettingWords,
  productNotFoundWords,
  productStatusWords,
  rightReasonLine,
  SIZES_DIFFER_WORDS,
  UNNAMED_SHELF,
  usedByWords,
  type DescriptionPendingPart,
} from "./dropship-listing-settings-words";
import type { DropshipEbayStoreCategoryOption } from "./dropship-ops-surface";

/**
 * The product drawer of the Listing settings step (Listing settings PR 7,
 * sub-part 2E; design M4, R:237-296, R:591-595): the deep link that opens it,
 * the words of its header, Price section and read-only rows, and one size's
 * exact price save through W9 (`PUT …/variants/:id/price`).
 *
 * Rules this module keeps:
 * - One changed size per Save (plan D4): W9 writes one size per request, so
 *   several sizes would be several transactions. Another size waits.
 * - × ("Use the price above") always saves `inherit` (owner decisions A3, L1):
 *   the size follows the store's pricing rules while they give it a price,
 *   and otherwise its retail price, never the price an earlier push saved.
 * - After a save, the size's price is read again with a GET and that answer
 *   is cached (C2, D9). A PUT answer is never cached: a replayed save answers
 *   with the first save's revision.
 * - The size's own price read (W9 GET) runs only for the size in edit, and
 *   only while W9 would take a save (D8).
 *
 * Pure apart from the read and save helpers at the end, which take their
 * query client and network calls as arguments. Integer cents only. Words
 * marked "interim" are not in the design record; they live here so a later
 * PR can change them in one place.
 */

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "$21,474,836.47": the largest price, with its thousands marked (R:540). Integer math only. */
function groupedCents(cents: number): string {
  const value = BigInt(cents);
  const dollars = (value / BigInt(100)).toLocaleString("en-US");
  return `$${dollars}.${String(value % BigInt(100)).padStart(2, "0")}`;
}

export const DRAWER_WORDS = Object.freeze({
  close: "Close",
  back: "Back",
  // Interim: the drawer's title before the product is read.
  untitled: "Product",
  priceHead: "Price",
  // Interim: the record's head always has a store price to name.
  noStorePrice: "No store price yet. Set one in Store defaults.",
  // Interim (PR 10d): a category price whose category the server named with nothing (never expected; the contract requires a name).
  unnamedCategory: "Category",
  checking: "Checking…",
  exact: "Exact",
  clear: "Use the price above",
  leaveEmpty: "Leave Exact price empty to use the price above.",
  // Interim (D4): W9 saves one size per request.
  oneSizeAtATime: "Save or discard the price you changed first.",
  exactStays: "An exact price stays the same when your cost changes.",
  inputFormat: "Enter a price like 14.99.",
  inputRange: `Enter a price from $0.01 to ${groupedCents(MAX_LISTING_PRICE_CENTS)}.`,
  // Interim: a size with no price today shows this where its price would be.
  noPrice: "No price",
  paused: "Paused on eBay: the price is under your cost. Raise it to start selling again.",
  // Interim: × is off because nothing could price the size without an exact price.
  clearOffNoRetail: "This size has no retail price, so it needs an exact price.",
  // Interim (L1): the store's rules can't price it and there is no retail price to fall back to.
  clearOffRulesNoRetail: "The store price can't price this size and it has no retail price, so it needs an exact price.",
  // Interim: the size's own price read is still answering.
  checkingPriceAbove: "Checking the price above…",
  // Interim: the size's own price read failed; a typed price can still be saved, × waits for it.
  sizePriceReadFailed: "Couldn't check this size's price. Try again.",
  seeFullListing: "See the full listing in step 3 ›",
  goToStep1: "Go to step 1",
  discard: "Discard",
  saveProduct: "Save product",
  save: "Save",
  // Interim: the step's other listing action is running (the page's pending-save counter, D10).
  busy: "Wait for the current listing action to finish, then save again.",
  // Interim.
  loading: "Loading this product…",
  // Interim.
  readFailed: "Couldn't load this product. Try again.",
  // Interim.
  latestFailed: "Couldn't load the latest view.",
  tryAgain: "Try again",
  // Interim, as the Products tab says it.
  readRateLimited: "Too many checks in a minute. Wait a moment and try again.",
  // Interim: the banner says why (more than 10,000 sizes chosen).
  readTooLarge: "This product can't be checked until you choose 10,000 or fewer sizes.",
  // Interim: a size search inside the drawer.
  sizeSearch: "Search sizes",
  clearSearch: "Clear search",
} as const);

/** The product read's 404: the product isn't chosen for this store (any more). */
export const PRODUCT_NOT_FOUND_CODE = "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND";
const TOO_LARGE_CODE = "DROPSHIP_LISTING_SETTINGS_TOO_LARGE";
const HTTP_TOO_MANY_REQUESTS = 429;

/** The name `resolvePricingRule` gives the store default recipe (shared/dropship/pricing-rules.ts). */
const STORE_DEFAULT_RULE_NAME = "Store default rule";

/** "1,240": a whole number for the vendor. */
function countText(value: number): string {
  return value.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// The deep link (?product=<id>&size=<variantId>)
// ---------------------------------------------------------------------------

export const DRAWER_PRODUCT_PARAM = "product";
export const DRAWER_SIZE_PARAM = "size";
/** Ids are PostgreSQL integers. */
const MAX_ID = 2_147_483_647;
/** A positive whole number written plainly: no sign, no leading zero, no spaces, no exponent. */
const ID_TEXT = /^[1-9]\d{0,9}$/;

/** What the drawer opens on: a product, and the size to land on when one is known. */
export interface DrawerTarget {
  productId: number;
  /** The size whose Exact price box gets focus (R:360, R:552). */
  productVariantId?: number;
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_ID;
}

/** The one id a parameter names, or null when it is missing, repeated or not a positive whole number. */
function idParam(params: URLSearchParams, name: string): number | null {
  const values = params.getAll(name);
  if (values.length !== 1 || !ID_TEXT.test(values[0])) return null;
  const value = Number(values[0]);
  return isId(value) ? value : null;
}

/**
 * The drawer a page address opens (R:692), or null. Only a positive whole
 * product id opens it; a size that isn't a positive whole id is left out, so
 * the drawer opens on the product without landing on a size.
 */
export function drawerTargetFromSearch(search: string): DrawerTarget | null {
  const params = new URLSearchParams(search);
  const productId = idParam(params, DRAWER_PRODUCT_PARAM);
  if (productId === null) return null;
  const productVariantId = idParam(params, DRAWER_SIZE_PARAM);
  return productVariantId === null ? { productId } : { productId, productVariantId };
}

/**
 * The page address with the drawer opened on `target`, or closed with null.
 * Every other parameter is kept as it was. Returns "" or "?…".
 */
export function drawerSearch(search: string, target: DrawerTarget | null): string {
  const params = new URLSearchParams(search);
  params.delete(DRAWER_PRODUCT_PARAM);
  params.delete(DRAWER_SIZE_PARAM);
  if (target !== null) {
    if (!isId(target.productId) || (target.productVariantId !== undefined && !isId(target.productVariantId))) {
      throw new Error("The drawer opens on a positive whole-number product id and size id only.");
    }
    params.set(DRAWER_PRODUCT_PARAM, String(target.productId));
    if (target.productVariantId !== undefined) params.set(DRAWER_SIZE_PARAM, String(target.productVariantId));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ---------------------------------------------------------------------------
// The sheets in the page address (?sheet=bulk|updated|give-prices; plan PR 10, D21)
// ---------------------------------------------------------------------------

export const LISTING_SETTINGS_SHEET_PARAM = "sheet";
/**
 * The sheets the page address opens, each added in its part: "Set for
 * selected" (10c), "Card Shellz updated products" (10g), "Give these sizes a
 * price" (10f, `give-prices`).
 */
export const LISTING_SETTINGS_SHEETS = ["bulk", "updated", "give-prices"] as const;
export type ListingSettingsSheet = (typeof LISTING_SETTINGS_SHEETS)[number];

function isListingSettingsSheet(value: string): value is ListingSettingsSheet {
  return (LISTING_SETTINGS_SHEETS as readonly string[]).includes(value);
}

/**
 * The sheet a page address opens, or null: one `sheet` parameter naming a
 * sheet this page has; a repeated or unknown one opens nothing. Browser Back
 * to an address without it closes the sheet, and its draft is kept (D21).
 */
export function sheetFromSearch(search: string): ListingSettingsSheet | null {
  const values = new URLSearchParams(search).getAll(LISTING_SETTINGS_SHEET_PARAM);
  return values.length === 1 && isListingSettingsSheet(values[0]) ? values[0] : null;
}

/**
 * The page address with `sheet` open, or closed with null (D21: pushed on
 * open, replaced on close). Every other parameter is kept as it was, the
 * drawer's included (K15); one surface at a time (D20) is the page's to
 * keep. Returns "" or "?…".
 */
export function sheetSearch(search: string, sheet: ListingSettingsSheet | null): string {
  const params = new URLSearchParams(search);
  params.delete(LISTING_SETTINGS_SHEET_PARAM);
  if (sheet !== null) {
    if (!isListingSettingsSheet(sheet)) throw new Error("The page address opens only a sheet this page has.");
    params.set(LISTING_SETTINGS_SHEET_PARAM, sheet);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ---------------------------------------------------------------------------
// The category editor in the page address (?category=<id>; plan PR 10, 8.2, D21)
// ---------------------------------------------------------------------------

export const LISTING_SETTINGS_CATEGORY_PARAM = "category";

/**
 * The Card Shellz category whose editor a page address opens (D21), or null:
 * one `category` parameter holding a positive whole id; a repeated or
 * malformed one opens nothing. Browser Back to an address without it closes
 * the editor, and its draft is kept.
 */
export function categoryTargetFromSearch(search: string): number | null {
  return idParam(new URLSearchParams(search), LISTING_SETTINGS_CATEGORY_PARAM);
}

/**
 * The page address with the category editor open on `categoryId`, or closed
 * with null (D21: pushed on open, replaced on close). Every other parameter
 * is kept as it was, the drawer's and the sheets' included (K15); one surface
 * at a time (D20) is the page's to keep, as `listingSettingsSurfaceFromSearch`
 * reads it. Returns "" or "?…".
 */
export function categorySearch(search: string, categoryId: number | null): string {
  const params = new URLSearchParams(search);
  params.delete(LISTING_SETTINGS_CATEGORY_PARAM);
  if (categoryId !== null) {
    if (!isId(categoryId)) throw new Error("The category editor opens on a positive whole-number category id only.");
    params.set(LISTING_SETTINGS_CATEGORY_PARAM, String(categoryId));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The one surface a page address opens (D20, D21): the drawer, a sheet, or the category editor. */
export type ListingSettingsSurface =
  | { kind: "drawer"; target: DrawerTarget }
  | { kind: "sheet"; sheet: ListingSettingsSheet }
  | { kind: "category"; categoryId: number };

/**
 * Which surface a page address opens, one at a time (D20): the drawer wins
 * over a sheet, which wins over the category editor (the order the parts
 * arrived in; an address naming two comes only from Forward or by hand,
 * since each opener takes the others off the address first). Null for none.
 */
export function listingSettingsSurfaceFromSearch(search: string): ListingSettingsSurface | null {
  const target = drawerTargetFromSearch(search);
  if (target !== null) return { kind: "drawer", target };
  const sheet = sheetFromSearch(search);
  if (sheet !== null) return { kind: "sheet", sheet };
  const categoryId = categoryTargetFromSearch(search);
  return categoryId === null ? null : { kind: "category", categoryId };
}

// ---------------------------------------------------------------------------
// The header (R:591)
// ---------------------------------------------------------------------------

function sizesWord(count: number): string {
  return count === 1 ? "size" : "sizes";
}

/** The category whose settings give one of the product's values (a `category` source names it), or null. */
function categorySettingsName(settings: ListingSettingsProductDetail["settings"]): string | null {
  for (const key of LISTING_SETTINGS_SETTING_KEYS) {
    for (const entry of settings[key]) {
      const source = entry.sources.find((candidate) => candidate.source === "category" && candidate.ruleName?.trim());
      if (source?.ruleName) return source.ruleName.trim();
    }
  }
  return null;
}

/**
 * "Card Shellz category: Sleeves · 4 of 4 sizes selected · No fixes needed",
 * or "No Card Shellz category · …". With the product's settings in full, a
 * value its Card Shellz category sets adds "From your Sleeves settings"
 * (R:591; plan 5.2), only when the server says the source is the category,
 * named as the server names it. The part's place in the line is a PROPOSAL.
 */
export function drawerCategoryLine(
  product: ListingSettingsProductDetail["product"],
  settings: ListingSettingsProductDetail["settings"] | null = null,
): string {
  const category = product.category?.trim();
  // A chosen size Card Shellz no longer offers is still counted, so the line never reads "5 of 4".
  const total = Math.max(product.sizesTotal, product.sizesChosen);
  const fromCategory = settings === null ? null : categorySettingsName(settings);
  return [
    category ? `Card Shellz category: ${category}` : "No Card Shellz category",
    ...(fromCategory === null ? [] : [fromCategorySettingsWords(fromCategory)]),
    `${countText(product.sizesChosen)} of ${countText(total)} ${sizesWord(total)} selected`,
    productStatusWords(product).text,
  ].join(" · ");
}

/** The phone header's line under the name (R:417): "4 sizes · No fixes needed". */
export function drawerPhoneSummary(product: ListingSettingsProductDetail["product"]): string {
  return `${countText(product.sizesChosen)} ${sizesWord(product.sizesChosen)} · ${productStatusWords(product).text}`;
}

/**
 * "Own settings: 1 exact price. Everything else uses your store defaults." (1C), or "… your store
 * defaults or older group rules." when an older group rule gives a setting or a size's price, as
 * the Price section and the rows below then say.
 */
export function drawerOwnSettingsLine(detail: ListingSettingsProductDetail): string {
  return ownSettingsSentence(detail.product, usesOlderGroupRule(detail));
}

function usesOlderGroupRule(detail: ListingSettingsProductDetail): boolean {
  const setting = LISTING_SETTINGS_SETTING_KEYS.some((key) =>
    detail.settings[key].some((entry) => entry.sources.some((source) => source.source === "group_rule")));
  return setting || detail.sizes.some((size) => size.price.rule?.kind === "group");
}

/**
 * The level that prices the product's sizes, when it is the product's own
 * price or its Card Shellz category's (PR 10d, UX-M7): the first size whose
 * rule is one of those (a product price prices every size without an exact
 * price, so one size says it for all; the product's own price wins over the
 * category's, as the server's resolution does). Null when the store default,
 * an older group rule or nothing prices them.
 */
export function productPriceHeadRule(sizes: ReadonlyArray<Pick<ListingSettingsProductSize, "price">>): ListingSettingsPriceRule | null {
  const rules = sizes.map((size) => size.price.rule).filter((rule): rule is ListingSettingsPriceRule => rule !== null);
  return rules.find((rule) => rule.kind === "product") ?? rules.find((rule) => rule.kind === "category") ?? null;
}

/**
 * The PRICE head (R:245): the level that prices the product (PR 10d, plan
 * 7.2, UX-M7): "This product: Retail price + 20%…" for its own price, "Sleeves:
 * …" for its category's (`productPriceHeadRule`), else the store default
 * recipe; "Checking…" until the summary answers.
 */
export function priceHeadWords(recipe: PricingRecipe | null | undefined, rule: ListingSettingsPriceRule | null = null): string {
  if (rule !== null && rule.kind === "product") return `This product: ${recipeWords(rule.recipe)}`;
  if (rule !== null && rule.kind === "category") return `${rule.name.trim() || DRAWER_WORDS.unnamedCategory}: ${recipeWords(rule.recipe)}`;
  if (recipe === undefined) return DRAWER_WORDS.checking;
  if (recipe === null) return DRAWER_WORDS.noStorePrice;
  return `Store default: ${recipeWords(recipe)}`;
}

/** "2 more sizes aren't selected. Choose them in step 1." (R:555), or null when every size is chosen. */
export function sizesNotChosenWords(product: Pick<ListingSettingsProductDetail["product"], "sizesChosen" | "sizesTotal">): string | null {
  const more = product.sizesTotal - product.sizesChosen;
  if (more <= 0) return null;
  return more === 1
    ? "1 more size isn't selected. Choose it in step 1."
    : `${countText(more)} more sizes aren't selected. Choose them in step 1.`;
}

/** The 404 words name the store (C27); they live with the other words, so a product save's 404 says the same. */
export { productNotFoundWords };

export type DrawerReadProblem =
  | { kind: "not_found"; message: string }
  | { kind: "too_large"; message: string }
  | { kind: "rate_limited"; message: string }
  | { kind: "failed"; message: string };

/** Why the product couldn't be read, in the vendor's words. */
export function drawerReadProblem(error: unknown, storeName: string): DrawerReadProblem {
  if (error instanceof DropshipApiError) {
    if (error.code === PRODUCT_NOT_FOUND_CODE) return { kind: "not_found", message: productNotFoundWords(storeName) };
    if (error.code === TOO_LARGE_CODE) return { kind: "too_large", message: DRAWER_WORDS.readTooLarge };
    if (error.status === HTTP_TOO_MANY_REQUESTS) return { kind: "rate_limited", message: DRAWER_WORDS.readRateLimited };
  }
  return { kind: "failed", message: DRAWER_WORDS.readFailed };
}

/**
 * Why the product's own settings couldn't be read (plan PR 10, 4.8): the
 * drawer's read words, except a plain failure says the settings couldn't be
 * loaded, since the rest of the drawer did load. [Change] stays off.
 */
export function drawerOwnReadProblem(error: unknown, storeName: string): DrawerReadProblem {
  const problem = drawerReadProblem(error, storeName);
  return problem.kind === "failed" ? { kind: "failed", message: LISTING_SETTINGS_EDIT_WORDS.ownReadFailed } : problem;
}

// ---------------------------------------------------------------------------
// Which sizes show (R:556, C13)
// ---------------------------------------------------------------------------

/** The drawer shows this many sizes, then "Show all N sizes" (R:556). */
export const DRAWER_SIZES_SHOWN_FIRST = 25;

/** A target size beyond the first 25 opens the drawer with every size shown (C13). */
export function drawerStartsWithAllSizes(sizes: readonly ListingSettingsProductSize[], targetVariantId: number | null | undefined): boolean {
  if (targetVariantId == null || sizes.length <= DRAWER_SIZES_SHOWN_FIRST) return false;
  return sizes.findIndex((size) => size.price.productVariantId === targetVariantId) >= DRAWER_SIZES_SHOWN_FIRST;
}

/**
 * The size an attention line's [Fix] lands on (plan 2F: a size that can't be
 * priced opens the drawer on the first such size): the first size, in the
 * detail's order, that carries `fix`. Null when none does, and the drawer
 * then opens on the product alone. The step reads the detail first (the
 * drawer's own query key, so the drawer opens from that answer) and puts the
 * size in the address, which keeps the address the one source of what shows.
 */
export function firstSizeNeedingFix(
  detail: Pick<ListingSettingsProductDetail, "sizes">,
  fix: ListingSettingsFixCode,
): number | null {
  return detail.sizes.find((size) => size.fixes.includes(fix))?.price.productVariantId ?? null;
}

export interface DrawerSizeList {
  shown: ListingSettingsProductSize[];
  /** "Show all 40 sizes"; null when every size is shown. */
  showAllLabel: string | null;
  /** Whether the size search shows (every size is shown, and there are more than 25). */
  searchable: boolean;
  /** "No sizes match “x”." when a search hides every size. */
  noMatch: string | null;
}

function matchesSizeSearch(size: ListingSettingsProductSize, needle: string): boolean {
  const name = size.price.sizeName.toLocaleLowerCase("en-US");
  const sku = size.price.sku?.toLocaleLowerCase("en-US") ?? "";
  return name.includes(needle) || sku.includes(needle);
}

/**
 * The sizes the Price section lists, in the detail's order. Sizes in
 * `keepVariantIds` (the size holding a change) always show, so a change is
 * never hidden behind a search or "Show all".
 */
export function drawerSizeList(sizes: readonly ListingSettingsProductSize[], options: {
  showAll: boolean;
  search: string;
  keepVariantIds: readonly number[];
}): DrawerSizeList {
  const keep = new Set(options.keepVariantIds);
  if (!options.showAll && sizes.length > DRAWER_SIZES_SHOWN_FIRST) {
    const shown = sizes.filter((size, index) => index < DRAWER_SIZES_SHOWN_FIRST || keep.has(size.price.productVariantId));
    return { shown, showAllLabel: `Show all ${countText(sizes.length)} sizes`, searchable: false, noMatch: null };
  }
  const searchable = sizes.length > DRAWER_SIZES_SHOWN_FIRST;
  const needle = searchable ? options.search.trim().toLocaleLowerCase("en-US") : "";
  if (needle === "") return { shown: [...sizes], showAllLabel: null, searchable, noMatch: null };
  const shown = sizes.filter((size) => matchesSizeSearch(size, needle) || keep.has(size.price.productVariantId));
  return {
    shown,
    showAllLabel: null,
    searchable,
    // Interim.
    noMatch: shown.length === 0 ? `No sizes match “${options.search.trim()}”.` : null,
  };
}

// ---------------------------------------------------------------------------
// One size's line (R:247-257, R:525-529)
// ---------------------------------------------------------------------------

export type DrawerNoticeTone = "info" | "warn" | "alert";

export interface DrawerNotice {
  tone: DrawerNoticeTone;
  text: string;
}

/** The size's price now, or "No price". */
export function sizePriceText(price: Pick<ListingSettingsSizePrice, "priceCents">): string {
  return price.priceCents === null ? DRAWER_WORDS.noPrice : formatCents(price.priceCents);
}

/** "Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500", or the size name alone without a SKU. */
export function sizeTitleWords(price: Pick<ListingSettingsSizePrice, "sizeName" | "sku">): string {
  const sku = price.sku?.trim();
  return sku ? `${price.sizeName} · ${sku}` : price.sizeName;
}

/**
 * The line under a size (R:249): "<Built from> · Your cost $2.10 · 120 in
 * stock". The cost is left out when it is not known, and the stock when it
 * could not be read.
 */
export function sizeFactsLine(size: ListingSettingsProductSize, stock: ListingSettingsProductDetail["stock"]): string {
  // A Built from sentence (a retail fallback reason) loses its full stop inside the line.
  const parts = [builtFromWords(size.price).replace(/\.$/, "")];
  if (size.price.costCents !== null) parts.push(`Your cost ${formatCents(size.price.costCents)}`);
  if (stock.state === "ok" && size.stockUnits !== null) parts.push(`${countText(size.stockUnits)} in stock`);
  return parts.join(" · ");
}

/**
 * Card Shellz's price limits for one price (R:527-528). A `block_listing`
 * limit is refused by W9 outside its range; a `refuse_orders` limit is a
 * warning only, since W9 does not refuse it. Nothing is said while the price
 * is inside every limit. The highest floor and the lowest ceiling are the
 * ones a price must clear (as the server's refusal names them).
 */
export function limitNotices(limits: readonly ListingSettingsPriceLimit[], priceCents: number | null): DrawerNotice[] {
  if (priceCents === null) return [];
  const notices: DrawerNotice[] = [];
  const range = (mode: ListingSettingsPriceLimit["mode"]) => {
    const floors = limits.filter((limit) => limit.mode === mode && limit.floorCents !== null).map((limit) => limit.floorCents as number);
    const ceilings = limits.filter((limit) => limit.mode === mode && limit.ceilingCents !== null).map((limit) => limit.ceilingCents as number);
    return {
      floor: floors.length > 0 ? Math.max(...floors) : null,
      ceiling: ceilings.length > 0 ? Math.min(...ceilings) : null,
    };
  };
  const block = range("block_listing");
  if ((block.floor !== null && priceCents < block.floor) || (block.ceiling !== null && priceCents > block.ceiling)) {
    const text = block.floor !== null && block.ceiling !== null
      ? `Card Shellz lists this size between ${formatCents(block.floor)} and ${formatCents(block.ceiling)}.`
      : block.floor !== null
        ? `Card Shellz lists this size at ${formatCents(block.floor)} or more.` // interim
        : `Card Shellz lists this size at ${formatCents(block.ceiling as number)} or less.`; // interim
    notices.push({ tone: "alert", text });
  }
  const orders = range("refuse_orders");
  if (orders.floor !== null && priceCents < orders.floor) {
    notices.push({ tone: "warn", text: `Card Shellz can't accept orders for this size below ${formatCents(orders.floor)}.` });
  }
  if (orders.ceiling !== null && priceCents > orders.ceiling) {
    // Interim.
    notices.push({ tone: "warn", text: `Card Shellz can't accept orders for this size above ${formatCents(orders.ceiling)}.` });
  }
  return notices;
}

/**
 * A typed price against the vendor's cost (R:250-251, R:526). Below cost is
 * allowed; it is never blocked. Null when the cost is not known.
 */
export function marginNotice(priceCents: number, costCents: number | null | undefined): DrawerNotice | null {
  if (costCents == null) return null;
  if (priceCents > costCents) {
    return { tone: "info", text: `${formatCents(priceCents)} is ${formatCents(priceCents - costCents)} over your cost, before eBay fees and shipping.` };
  }
  if (priceCents < costCents) {
    return { tone: "warn", text: `Below your cost: you'd lose ${formatCents(costCents - priceCents)} on each sale. You can still save it.` };
  }
  // Interim.
  return { tone: "info", text: `${formatCents(priceCents)} is the same as your cost, before eBay fees and shipping.` };
}

export type ExactPriceParse = { ok: true; cents: number } | { ok: false; message: string };

/** The Exact price box's text as integer cents, with the record's input words (R:540). Never a float. */
export function parseExactPrice(text: string): ExactPriceParse {
  const trimmed = text.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed) || trimmed.length > 20) return { ok: false, message: DRAWER_WORDS.inputFormat };
  try {
    return { ok: true, cents: parseListingPriceCents(trimmed) };
  } catch {
    // The shape is right, so the amount is out of range ("0", or above the largest price).
    return { ok: false, message: DRAWER_WORDS.inputRange };
  }
}

/**
 * What W9's GET says of a size's price without its exact price: the rule
 * price and the level that gives it (`ruleLevel` for the product's own price
 * or its category's, PR 10d; absent for the store default or an older group
 * rule, which `ruleName` then names), else the retail price.
 */
export type W9PriceFacts = Pick<ListingPriceSetting, "rulePriceCents" | "defaultPriceCents" | "ruleName" | "pricingIssue" | "ruleLevel">;

/** "the store default" or "your older group rule “Envelopes”": who gives a rule price. */
function ruleOwner(ruleName: string | null | undefined): { storeDefault: boolean; name: string | null } {
  const name = ruleName?.trim() || null;
  return name === null || name === STORE_DEFAULT_RULE_NAME ? { storeDefault: true, name: null } : { storeDefault: false, name };
}

/**
 * What the size would cost without its exact price (R:250, from W9's GET):
 * "store default would be $15.99", "your older group rule “Envelopes” would
 * give $6.99" (interim), "this product's price would be $14.99" or "the
 * Sleeves price would be $14.99" (PR 10d, UX-M7; `ruleLevel`, the category
 * named from the product detail when given, else as W9 names it), or, with no
 * rule price, "retail price would be $12.50" (interim). Null when nothing
 * would price it.
 */
export function wouldBeWords(setting: W9PriceFacts | null, product: Pick<ListingSettingsProductDetail["product"], "category"> | null = null): string | null {
  if (setting === null) return null;
  const inherited = inheritedListingPrice(setting);
  if (inherited.priceCents === null) return null;
  const amount = formatCents(inherited.priceCents);
  if (inherited.from === "retail") return `retail price would be ${amount}`;
  if (setting.ruleLevel === "product") return `this product's price would be ${amount}`;
  if (setting.ruleLevel === "category") {
    const name = product?.category?.trim() || setting.ruleName?.trim() || DRAWER_WORDS.unnamedCategory;
    return `the ${name} price would be ${amount}`;
  }
  const owner = ruleOwner(setting.ruleName);
  return owner.storeDefault ? `store default would be ${amount}` : `your older group rule “${owner.name}” would give ${amount}`;
}

/** "→ $14.99 · Not saved · store default would be $15.99" (R:250). */
export function typedPriceLine(priceCents: number, setting: W9PriceFacts | null, product: Pick<ListingSettingsProductDetail["product"], "category"> | null = null): string {
  const wouldBe = wouldBeWords(setting, product);
  return `→ ${formatCents(priceCents)} · ${LISTING_SETTINGS_SAVE_WORDS.notSaved}${wouldBe ? ` · ${wouldBe}` : ""}`;
}

/** What clearing the box (saving `inherit`) would do, from the size's own price read. */
export type ClearOutcome =
  /** The size's price read hasn't answered yet. */
  | { kind: "checking" }
  /** The size would get `priceCents`: `line` beside it, and `note` (why it is the retail price) under it. */
  | { kind: "allowed"; priceCents: number; line: string; note: string | null }
  /** Nothing would price the size: × is off, and the server would refuse it (DROPSHIP_LISTING_PRICE_WOULD_BE_LOST). */
  | { kind: "off"; reason: string };

/**
 * What × ("Use the price above") gives the size (owner decision L1): the rule
 * price while the store's rules give a usable one, otherwise its retail price,
 * and nothing when it has neither. W9 names a rule price that a blocking Card
 * Shellz limit refuses (pricing_rule_outside_limit); such a size takes its
 * retail price. Whether the retail price itself is allowed is checked by the
 * server on save.
 */
export function clearOutcome(setting: ListingPriceSetting | null | undefined): ClearOutcome {
  if (!setting) return { kind: "checking" };
  const inherited = inheritedListingPrice(setting);
  if (inherited.priceCents === null) {
    return { kind: "off", reason: setting.rulesConfigured === true ? DRAWER_WORDS.clearOffRulesNoRetail : DRAWER_WORDS.clearOffNoRetail };
  }
  const amount = formatCents(inherited.priceCents);
  const prefix = `→ ${amount} · ${LISTING_SETTINGS_SAVE_WORDS.notSaved}`;
  if (inherited.from === "rules") {
    const owner = ruleOwner(setting.ruleName);
    // Interim.
    const from = owner.storeDefault ? "uses the store default" : `uses your older group rule “${owner.name}”`;
    return { kind: "allowed", priceCents: inherited.priceCents, line: `${prefix} · ${from}`, note: null };
  }
  // The words the size will show once saved (L1), with the reason it is on its retail price.
  const note = w9OriginWords({ ...setting, source: "catalog_default", pricingMode: "inherit", effectivePriceCents: inherited.priceCents });
  // Interim.
  return { kind: "allowed", priceCents: inherited.priceCents, line: `${prefix} · uses the retail price`, note };
}

/** Notices that stand under a size whatever is typed: the retail fallback's fix (L1) and a pause (R:529). */
export function standingSizeNotices(price: ListingSettingsSizePrice): DrawerNotice[] {
  const notices: DrawerNotice[] = [];
  const fix = retailFallbackFixWords(price);
  if (fix) notices.push({ tone: "warn", text: fix });
  if (price.pausedSince !== null) notices.push({ tone: "warn", text: DRAWER_WORDS.paused });
  return notices;
}

// ---------------------------------------------------------------------------
// The draft: one size's exact price
// ---------------------------------------------------------------------------

/**
 * The drawer's draft value (one per product, plan D4). One size at a time:
 * `productVariantId` and `expectedRevisionId` are the same in base and
 * value, so the only change a draft can count is `exact`, and the bar reads
 * "Not saved · 1 change in <Product>". `expectedRevisionId` is the size's
 * saved revision as the vendor saw it: the server refuses the save if it
 * moved (409 DROPSHIP_LISTING_PRICE_VERSION_CONFLICT).
 */
export interface SizePriceDraft {
  productVariantId: number;
  expectedRevisionId: number | null;
  /** What the Exact price box holds; "" means "use the price above". */
  exact: string;
}

export function sizePriceDraftValue(draft: SizePriceDraft): DraftValue {
  return { productVariantId: draft.productVariantId, expectedRevisionId: draft.expectedRevisionId, exact: draft.exact };
}

/** The drawer's draft value, or null when `value` is not one (another editor's draft). */
export function readSizePriceDraft(value: DraftValue): SizePriceDraft | null {
  const { productVariantId, expectedRevisionId, exact } = value;
  if (!isId(productVariantId) || typeof exact !== "string") return null;
  if (expectedRevisionId !== null && !isId(expectedRevisionId)) return null;
  return { productVariantId, expectedRevisionId, exact };
}

/** The Exact price box's saved text: the size's typed price, or "" when it has none. */
export function savedExactText(price: Pick<ListingSettingsSizePrice, "source" | "priceCents">): string {
  return price.source === "exact" && price.priceCents !== null ? listingPriceInput(price.priceCents) : "";
}

/**
 * Where a size's draft starts: its own price read (W9) when it answered for
 * this size, being the fresher read, else the drawer's product read.
 */
export function sizePriceDraftBase(price: ListingSettingsSizePrice, w9: ListingPriceSetting | null): SizePriceDraft {
  if (w9 !== null && w9.productVariantId === price.productVariantId) {
    return {
      productVariantId: price.productVariantId,
      expectedRevisionId: w9.revisionId,
      exact: w9.overridePriceCents === null ? "" : listingPriceInput(w9.overridePriceCents),
    };
  }
  return { productVariantId: price.productVariantId, expectedRevisionId: price.settingRevisionId, exact: savedExactText(price) };
}

/**
 * "Load latest and keep my changes" after a 409 (R:542): the vendor's text on
 * the latest saved revision (`edited`), and what is saved now (`latest`),
 * which becomes the draft's base. Send `edited` first, then rebase on
 * `latest`, so the count is right and only the price is marked when both
 * changed it.
 */
export function rebaseSizePriceDraft(mine: SizePriceDraft, latest: ListingPriceSetting): { edited: SizePriceDraft; latest: SizePriceDraft } {
  if (latest.productVariantId !== mine.productVariantId) throw new Error("The latest price is for another size.");
  const saved: SizePriceDraft = {
    productVariantId: mine.productVariantId,
    expectedRevisionId: latest.revisionId,
    exact: latest.overridePriceCents === null ? "" : listingPriceInput(latest.overridePriceCents),
  };
  return { edited: { ...mine, expectedRevisionId: latest.revisionId }, latest: saved };
}

/** What typing in a size's box does to the drawer's draft (D4). */
export type SizeEditAction =
  /** This size holds the draft's change: the text replaces it (`reopen` when the drawer was hidden by Back). */
  | { kind: "edit"; reopen: boolean; value: SizePriceDraft }
  /** A new edit: the draft opens on `base` (asking first if another editor holds changes), then takes `value`. */
  | { kind: "start"; base: SizePriceDraft; value: SizePriceDraft }
  /** Another size of this product holds a change; it is saved or discarded first. */
  | { kind: "wait" };

/**
 * Typing `text` into a size's box. A size holding a change keeps its base
 * (the revision the vendor saw); any other edit starts from the price as it
 * is saved now, even over an unchanged draft, so it never sends an old revision.
 */
export function decideSizeEdit(
  draft: ListingSettingsDraft | null,
  editor: EditorId,
  price: ListingSettingsSizePrice,
  w9: ListingPriceSetting | null,
  text: string,
): SizeEditAction {
  // The product's settings or its price hold a change: a size's price waits until they are saved or discarded (PR 10, D2).
  if (otherKindHoldsChange(draft, editor)) return { kind: "wait" };
  const own = ownSizePriceDraft(draft, editor);
  const holding = own !== null && (isDraftDirty(own.draft) || isDraftLocked(own.draft));
  if (holding && own.value.productVariantId === price.productVariantId) {
    return { kind: "edit", reopen: !own.draft.open, value: { ...own.value, exact: text } };
  }
  if (holding) return { kind: "wait" };
  const base = sizePriceDraftBase(price, w9 !== null && w9.productVariantId === price.productVariantId ? w9 : null);
  return { kind: "start", base, value: { ...base, exact: text } };
}

/** How one size's box stands against the drawer's draft. */
export interface DrawerSizeEditState {
  /** What the box shows. */
  text: string;
  /** This size holds the draft's change. */
  changed: boolean;
  /** Another size of this product, or the product's settings, hold a change, so this one waits (D4; PR 10, D2). */
  waiting: boolean;
  /** Another window changed this price too (R:542, after "Load latest"). */
  marked: boolean;
}

/** The drawer's own draft for this product, or null (none, or another editor's). */
export function ownSizePriceDraft(draft: ListingSettingsDraft | null, editor: EditorId): { draft: ListingSettingsDraft; value: SizePriceDraft } | null {
  if (draft === null || draft.editor !== editor) return null;
  const value = readSizePriceDraft(draft.value);
  return value === null ? null : { draft, value };
}

/** This product's draft holds a change of another kind than a size's price: its settings (W5) or its price (W7, PR 10d); the sizes wait (D2). */
function otherKindHoldsChange(draft: ListingSettingsDraft | null, editor: EditorId): boolean {
  const kind = drawerChangeKind(draft, editor);
  return kind === "settings" || kind === "product_price";
}

export function drawerSizeEditState(draft: ListingSettingsDraft | null, editor: EditorId, price: ListingSettingsSizePrice): DrawerSizeEditState {
  if (otherKindHoldsChange(draft, editor)) return { text: savedExactText(price), changed: false, waiting: true, marked: false };
  const own = ownSizePriceDraft(draft, editor);
  if (own !== null && own.value.productVariantId === price.productVariantId) {
    const dirty = isDraftDirty(own.draft);
    // An unchanged draft shows what is saved now (another window may have moved it), except
    // while a save is out or its view couldn't be read again: then the box keeps what was sent.
    const keepsDraft = dirty || isDraftLocked(own.draft) || own.draft.phase === "saved_view_stale";
    return {
      text: keepsDraft ? own.value.exact : savedExactText(price),
      changed: dirty,
      waiting: false,
      marked: own.draft.marked.includes("exact"),
    };
  }
  return { text: savedExactText(price), changed: false, waiting: own !== null && isDraftDirty(own.draft), marked: false };
}

// ---------------------------------------------------------------------------
// One size's line, as the Price section draws it
// ---------------------------------------------------------------------------

export interface DrawerSizeLineInput {
  size: ListingSettingsProductSize;
  stock: ListingSettingsProductDetail["stock"];
  edit: DrawerSizeEditState;
  /** The size's own price read (W9), when this is the size in edit and it answered. */
  w9: ListingPriceSetting | null;
  /** `rights.exactPrice.editable`. */
  editable: boolean;
  /** The draft is saving or its save is unconfirmed (R:539, R:541). */
  locked: boolean;
  /** A refused save or a bad entry for this size. */
  fieldError: string | null;
}

export interface DrawerSizeLine {
  productVariantId: number;
  title: string;
  priceText: string;
  facts: string;
  input: { text: string; readOnly: boolean; invalid: boolean; marked: boolean };
  /** × beside a box with text; off with a reason when nothing would price the size. */
  clear: { shown: boolean; disabled: boolean; reason: string | null };
  /** The line under a changed size: "→ $14.99 · Not saved · …", and what goes with it. */
  pending: { line: string; notices: DrawerNotice[] } | null;
  notices: DrawerNotice[];
  fieldError: string | null;
}

/** One size's line in the Price section (R:247-257), from the drawer's reads and its draft. */
export function drawerSizeLine(input: DrawerSizeLineInput): DrawerSizeLine {
  const { size, edit, w9 } = input;
  const price = size.price;
  const readOnly = !input.editable || input.locked || edit.waiting;
  const costCents = w9?.productCostCents ?? price.costCents;
  const clear = w9 === null ? null : clearOutcome(w9);

  let pending: DrawerSizeLine["pending"] = null;
  // The price the limits are checked against: the one typed, the one × would give, else today's.
  let checkedCents: number | null = price.priceCents;
  if (edit.changed) {
    if (edit.text.trim() === "") {
      const outcome = clearOutcome(w9);
      if (outcome.kind === "allowed") {
        checkedCents = outcome.priceCents;
        pending = { line: outcome.line, notices: outcome.note ? [{ tone: "info", text: outcome.note }] : [] };
      } else if (outcome.kind === "off") {
        checkedCents = null;
        pending = { line: `→ ${LISTING_SETTINGS_SAVE_WORDS.notSaved}`, notices: [{ tone: "alert", text: outcome.reason }] };
      } else {
        checkedCents = null;
        pending = { line: `→ ${DRAWER_WORDS.checkingPriceAbove}`, notices: [] };
      }
    } else {
      const parsed = parseExactPrice(edit.text);
      if (parsed.ok) {
        checkedCents = parsed.cents;
        const margin = marginNotice(parsed.cents, costCents);
        pending = {
          line: typedPriceLine(parsed.cents, w9),
          notices: [...(margin ? [margin] : []), { tone: "info", text: DRAWER_WORDS.exactStays }],
        };
      } else {
        // The entry is checked when Save is pressed; until then the line only says it isn't saved.
        checkedCents = null;
        pending = { line: `→ ${LISTING_SETTINGS_SAVE_WORDS.notSaved}`, notices: [] };
      }
    }
  }

  const clearOff = clear?.kind === "off" ? clear.reason : null;
  return {
    productVariantId: price.productVariantId,
    title: sizeTitleWords(price),
    priceText: sizePriceText(price),
    facts: sizeFactsLine(size, input.stock),
    input: { text: edit.text, readOnly, invalid: input.fieldError !== null, marked: edit.marked },
    clear: {
      shown: edit.text !== "",
      disabled: readOnly || clearOff !== null,
      // The reason shows only when the vendor could otherwise use ×.
      reason: !readOnly && edit.text !== "" ? clearOff : null,
    },
    pending,
    notices: [...standingSizeNotices(price), ...limitNotices(price.limits, checkedCents)],
    fieldError: input.fieldError,
  };
}

// ---------------------------------------------------------------------------
// The save request (W9)
// ---------------------------------------------------------------------------

export type SizePriceIntent = { kind: "exact"; priceCents: number } | { kind: "inherit" };

export type SizePriceSave =
  | {
    ok: true;
    intent: SizePriceIntent;
    /** The draft with its text written as it is saved ("14.9" becomes "14.90"). */
    normalized: SizePriceDraft;
    /** Same request, same signature: a retry reuses its request key (ListingSettingsDraftsProvider). */
    signature: string;
  }
  | { ok: false; message: string };

/**
 * What a size's draft saves: a typed price, or `inherit` for an empty box
 * (A3: × always saves `inherit`). The signature holds everything the request
 * sends except its key, so the same request always reuses its key and any
 * edit gets a new one.
 */
export function sizePriceSave(identity: ListingPriceIdentity, draft: SizePriceDraft): SizePriceSave {
  if (identity.productVariantId !== draft.productVariantId) throw new Error("The draft is for another size.");
  listingPriceEndpoint(identity);
  let intent: SizePriceIntent;
  let exact = "";
  if (draft.exact.trim() === "") {
    intent = { kind: "inherit" };
  } else {
    const parsed = parseExactPrice(draft.exact);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    intent = { kind: "exact", priceCents: parsed.cents };
    exact = listingPriceInput(parsed.cents);
  }
  const signature = JSON.stringify([
    "listing-settings-size-price-v1",
    identity.storeConnectionId,
    identity.productVariantId,
    intent.kind,
    intent.kind === "exact" ? intent.priceCents : null,
    draft.expectedRevisionId,
  ]);
  return { ok: true, intent, normalized: { ...draft, exact }, signature };
}

/**
 * The W9 body: `{ priceCents, expectedRevisionId, idempotencyKey }` for a
 * typed price, `{ priceCents: null, pricingMode: "inherit", … }` for "use the
 * price above". Checked against the shared input schema before it is sent.
 */
export function sizePriceRequest(intent: SizePriceIntent, expectedRevisionId: number | null, idempotencyKey: string): SaveListingPriceInput {
  return saveListingPriceInputSchema.parse(intent.kind === "exact"
    ? { priceCents: intent.priceCents, expectedRevisionId, idempotencyKey }
    : { priceCents: null, pricingMode: "inherit", expectedRevisionId, idempotencyKey });
}

// ---------------------------------------------------------------------------
// Reads (D8, D9, C2)
// ---------------------------------------------------------------------------

/** One size's price read, under the key the older price editor uses too, so it is one cached read. */
export function sizePriceQueryKey(identity: ListingPriceIdentity) {
  return [listingPriceEndpoint(identity)] as const;
}

/** The key used while no size is in edit: nothing is ever read under it. */
const NO_SIZE_KEY = ["listing-settings-drawer", "no-size-in-edit"] as const;

/** The size's own read runs only for the size in edit, and only while W9 would take a save (D8). */
export interface SizePriceReadGate {
  inEdit: boolean;
  right: Pick<ListingSettingsRight, "editable">;
}

export function sizePriceReadEnabled(identity: ListingPriceIdentity | null, gate: SizePriceReadGate): boolean {
  return identity !== null && gate.inEdit && gate.right.editable;
}

async function fetchSizePrice(identity: ListingPriceIdentity, signal?: AbortSignal): Promise<ListingPriceSetting> {
  // fetchJson throws a DropshipApiError (status, code, context) for a refused or failed request.
  return readListingPrice(await fetchJson<unknown>(listingPriceEndpoint(identity), { signal }), identity);
}

export function sizePriceQueryOptions(identity: ListingPriceIdentity | null, gate: SizePriceReadGate) {
  return {
    queryKey: identity === null ? NO_SIZE_KEY : sizePriceQueryKey(identity),
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<ListingPriceSetting> => {
      // `refetch()` runs even a disabled read; with no size in edit there is nothing to read.
      if (identity === null) return Promise.reject(new Error("No size is in edit."));
      return fetchSizePrice(identity, signal);
    },
    enabled: sizePriceReadEnabled(identity, gate),
    // Every edit starts from the price as it is saved now.
    staleTime: 0,
    retry: false,
  } as const;
}

export type SizePriceQueryClient = Pick<QueryClient, "cancelQueries" | "setQueryData" | "invalidateQueries">;

/**
 * Reads one size's price again and caches that GET answer (C2, D9). A read
 * in flight is cancelled first, so its older answer can't land after this
 * one. Throws when the read fails.
 */
export async function rereadSizePrice(
  queryClient: SizePriceQueryClient,
  identity: ListingPriceIdentity,
  read: (identity: ListingPriceIdentity) => Promise<ListingPriceSetting> = (target) => fetchSizePrice(target),
): Promise<ListingPriceSetting> {
  const queryKey = sizePriceQueryKey(identity);
  await queryClient.cancelQueries({ queryKey, exact: true });
  const current = await read(identity);
  queryClient.setQueryData(queryKey, current);
  return current;
}

/**
 * After a size's price is saved (including a replay): its price is read
 * again (never taken from the PUT answer), then every listing settings read
 * of the store is refreshed (the product, both lists and the summary).
 * Throws when the size's price can't be read again.
 */
export async function refreshAfterSizePriceSave(
  queryClient: SizePriceQueryClient,
  identity: ListingPriceIdentity,
  read?: (identity: ListingPriceIdentity) => Promise<ListingPriceSetting>,
): Promise<ListingPriceSetting> {
  const current = await rereadSizePrice(queryClient, identity, read);
  await queryClient.invalidateQueries({ queryKey: listingSettingsQueryKey(identity.storeConnectionId) });
  return current;
}

// ---------------------------------------------------------------------------
// Running a save
// ---------------------------------------------------------------------------

/** The page's pending-save counter (D10): it holds back a queue or push while a save runs. */
export interface SizePriceSaveCallbacks {
  disabled?: boolean;
  /** Throws when another listing action is running; then nothing is sent. */
  onSaveStarted: () => void;
  onSaveSettled: () => void;
}

/** The draft provider's two save calls (ListingSettingsDraftsProvider). */
export interface SizePriceSaveDrafts {
  startSave: (signature: string, keyPrefix: string) => string | null;
  settle: (
    key: string,
    settlement: { kind: "saved" } | { kind: "saved_view_stale" } | { kind: "failure"; failure: WriteFailure },
  ) => void;
}

export interface SizePriceSaveRun {
  identity: ListingPriceIdentity;
  draft: SizePriceDraft;
  drafts: SizePriceSaveDrafts;
  callbacks: SizePriceSaveCallbacks;
  send: (input: SaveListingPriceInput) => Promise<unknown>;
  /** Reads the size's price again and refreshes the step's reads (`refreshAfterSizePriceSave`). */
  refresh: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads the summary again. */
  onSaved: () => void;
  /** A save refused because of a block a banner explains (plan 4.4). The draft is kept. */
  onBlocked?: (error: unknown) => void;
}

export type SizePriceSaveOutcome =
  /** Nothing was sent: another action is running, or no save can start now. */
  | { kind: "not_started"; message: string | null }
  /** The entry can't be saved as typed; nothing was sent. */
  | { kind: "invalid"; message: string }
  | { kind: "saved"; viewStale: boolean }
  | { kind: "failed"; failure: WriteFailure };

/** Words for a body that could not be built (never sent). */
const REBUILD_MESSAGE = "This price can't be saved as it is. Check it and save again.";
const SIZE_PRICE_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_SIZE_PRICE_REQUEST_INVALID";

/**
 * One save of one size's price, start to finish:
 * 1. the entry is checked; a bad one is shown by the box and nothing is sent;
 * 2. the page's pending-save counter starts, or the save does not;
 * 3. the draft takes the request key: the same request reuses its key;
 * 4. the request is sent; a failure is classified (W9) and settles the draft;
 * 5. a 2xx means saved. The price is read again (never taken from the
 *    answer, C2); if that read or the answer's contract check fails, the save
 *    still stands and the vendor sees "Saved. We couldn't load the latest view.";
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runSizePriceSave(run: SizePriceSaveRun): Promise<SizePriceSaveOutcome> {
  const prepared = sizePriceSave(run.identity, run.draft);
  if (!prepared.ok) return { kind: "invalid", message: prepared.message };
  if (run.callbacks.disabled) return { kind: "not_started", message: DRAWER_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and Save works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, DRAWER_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(prepared.signature, LISTING_SETTINGS_KEY_PREFIXES.sizePrice);
    if (key === null) return { kind: "not_started", message: null };

    let input: SaveListingPriceInput;
    try {
      input = sizePriceRequest(prepared.intent, run.draft.expectedRevisionId, key);
    } catch {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = { phase: "refused", message: REBUILD_MESSAGE, code: SIZE_PRICE_REQUEST_INVALID, status: null };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure };
    }

    let answer: unknown;
    try {
      answer = await run.send(input);
    } catch (error) {
      const failure = classifyWriteFailure("W9", error);
      run.drafts.settle(key, { kind: "failure", failure });
      if (failure.phase === "blocked") run.onBlocked?.(error);
      return { kind: "failed", failure };
    }

    let viewStale = false;
    try {
      // Checked for its contract only; what it says is never shown or cached (C2).
      readSavedListingPrice(answer, run.identity);
      await run.refresh();
    } catch {
      // Deliberate: the server answered 2xx, so the save stands. Only the view is out of date,
      // and the draft says so with [Reload] ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSaved();
    return { kind: "saved", viewStale };
  } finally {
    run.callbacks.onSaveSettled();
  }
}

// ---------------------------------------------------------------------------
// The footer (R:272, R:451-452)
// ---------------------------------------------------------------------------

export type DrawerFooterAction = "save" | "resend" | "load_latest" | "reload" | "none";

export interface DrawerFooter {
  /** "● Not saved · 1 change" (phone "● Not saved · 1"); null with nothing unsaved. */
  notSaved: string | null;
  primary: { action: DrawerFooterAction; label: string; disabled: boolean };
  discardDisabled: boolean;
  message: { text: string; tone: "status" | "alert" } | null;
}

export interface DrawerFooterInput {
  /** The drawer's own draft for this product. */
  draft: ListingSettingsDraft | null;
  /** `rights.exactPrice.editable`. */
  editable: boolean;
  /** Another listing action is running, or a read for the footer is in flight. */
  busy: boolean;
  /** What a pending clear would do; null when the change is a typed price. */
  clear: ClearOutcome | null;
  /** "Saved" shows now (for 3 seconds after a confirmed save, R:538). */
  savedFlashVisible: boolean;
  compact: boolean;
  /**
   * A refused save is told here (a settings save whose refusal names no
   * field, PR 10); otherwise the size or field it was for tells it.
   */
  showRefusal?: boolean;
  /**
   * A field editor is open (PR 10): its pick is not in the draft until
   * [Done], so the footer waits as it does while busy, and says why while
   * the draft holds a change.
   */
  fieldEditorOpen?: boolean;
  /** The wide Save's words when they aren't "Save product" ("Save for 312 products", PR 10 plan 6.3); a phone says "Save". */
  saveLabel?: string;
  /** The phone's words when "Save" would mislead: the price's Save runs the check ("Check new prices", PR 10d); left out, "Save". */
  compactSaveLabel?: string;
}

/** The drawer's footer from its draft (R:535-545). */
export function drawerFooter(input: DrawerFooterInput): DrawerFooter {
  const { draft } = input;
  const dirty = isDraftDirty(draft);
  const busy = input.busy || input.fieldEditorOpen === true;
  const saveLabel = input.compact ? input.compactSaveLabel ?? DRAWER_WORDS.save : input.saveLabel ?? DRAWER_WORDS.saveProduct;
  const notSaved = dirty && draft
    ? input.compact
      ? `● ${LISTING_SETTINGS_SAVE_WORDS.notSaved} · ${draft.changes}`
      : `● ${LISTING_SETTINGS_SAVE_WORDS.notSaved} · ${draft.changes} ${draft.changes === 1 ? "change" : "changes"}`
    : null;
  const footer = (primary: DrawerFooter["primary"], message: DrawerFooter["message"] = null): DrawerFooter => ({
    notSaved,
    primary,
    discardDisabled: !dirty || isDraftLocked(draft),
    message,
  });

  switch (draft?.phase) {
    case "saving":
      return footer({ action: "none", label: LISTING_SETTINGS_SAVE_WORDS.saving, disabled: true });
    case "uncertain":
      return footer(
        { action: "resend", label: LISTING_SETTINGS_SAVE_WORDS.checkAgain, disabled: busy || !input.editable },
        { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.uncertain, tone: "alert" },
      );
    case "conflict":
      return footer(
        { action: "load_latest", label: LISTING_SETTINGS_SAVE_WORDS.loadLatest, disabled: busy },
        { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.conflict, tone: "alert" },
      );
    case "saved_view_stale":
      return footer(
        { action: "reload", label: LISTING_SETTINGS_SAVE_WORDS.reload, disabled: busy },
        { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.savedViewStale, tone: "status" },
      );
    default:
      break;
  }

  const clearReady = input.clear === null || input.clear.kind === "allowed";
  const save = { action: "save" as const, label: saveLabel, disabled: !dirty || !input.editable || busy || !clearReady };
  if (draft?.phase === "saved" && input.savedFlashVisible) return footer(save, { text: LISTING_SETTINGS_SAVE_WORDS.saved, tone: "status" });
  // An open field editor holds a pick that isn't in the draft: Save waits for its Done or Cancel, and says so (PR 10).
  if (input.fieldEditorOpen === true && dirty) return footer(save, { text: LISTING_SETTINGS_EDIT_WORDS.finishEditorFirst, tone: "status" });
  // A refused save is told by the size it was for, unless the caller says it is told here; these are told here.
  if (draft?.phase === "rate_limited" || draft?.phase === "blocked" || draft?.phase === "unreachable"
    || (draft?.phase === "refused" && input.showRefusal === true)) {
    return footer(save, { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.blocked, tone: "alert" });
  }
  if (draft?.phase === "editing" && draft.message) return footer(save, { text: draft.message, tone: "status" });
  return footer(save);
}

// ---------------------------------------------------------------------------
// The setting rows (R:259-266, R:285-294; C16, C17; PR 10 plan 4.3, 5.2, 5.3)
// ---------------------------------------------------------------------------

/** The rows, in the record's order (R:259-266). The description row also shows the main text. */
export const DRAWER_SETTING_ROWS = [
  { key: "shippingPolicy", label: "Shipping policy" },
  { key: "returnPolicy", label: "Return policy" },
  { key: "paymentPolicy", label: "Payment policy" },
  { key: "ebayCategory", label: "eBay category" },
  { key: "storeShelf", label: "Store shelf" },
  { key: "descriptionTemplate", label: "Description" },
] as const satisfies readonly { key: ListingSettingsSettingKey; label: string }[];

export type DrawerSettingRowKey = (typeof DRAWER_SETTING_ROWS)[number]["key"];

/** A "Sizes differ" quick pick beside one value (plan 5.3): its button, and what it puts in the draft. */
export interface DrawerEntryPick {
  /** `use_default`: every size gets the default back; `use_this`: this value for the product. */
  action: "use_default" | "use_this";
  /** "Use for all sizes" or "Use default for all sizes". */
  label: string;
  field: SizesDifferField;
  /** For `productSettingsEditAction({ picks })`; nothing is sent until Save. */
  picks: ProductSettingsPicks;
  /** Off as the row's [Change] is (the own read loads, a save is out, a size's price waits, D2), and while any row's editor is open. */
  disabled: boolean;
}

/** One value of a setting and where it comes from. */
export interface DrawerSettingEntry {
  value: string;
  /** "Store default", "From category: Sleeves", "From your older group rule “Envelopes”"…; the value says it alone when empty. */
  tags: string[];
  /** "used by Pack of 100 and Box of 5" when the sizes differ; null otherwise. */
  usedBy: string | null;
  /** The quick pick beside it while the sizes differ and the row can be changed (PR 10, 5.3); absent otherwise. */
  pick?: DrawerEntryPick;
}

/** One setting's values: one, or several when the sizes differ (C16). */
export interface DrawerSettingGroup {
  entries: DrawerSettingEntry[];
  /**
   * The line over values that differ, null when every size agrees. Without
   * a way to change the row: "Sizes have different values. Each size keeps
   * its own for now." With one: "Sizes differ. Pick one for all sizes." over
   * quick picks, or "Sizes differ. Use Change to pick one for all sizes." for
   * the shelf and the description (5.3).
   */
  differ: string | null;
}

/** What a row's [Change] opens: one field's editor, or the description's (text above, text below, main text). */
export type DrawerFieldTarget = PolicyEditField | "ebayCategory" | "storeShelf";
export type DrawerEditTarget = DrawerFieldTarget | "description";

/** What each row's [Change] opens (also the "Set for selected" rows', PR 10 plan 6.3). */
export const DRAWER_ROW_TARGETS: Readonly<Record<DrawerSettingRowKey, DrawerEditTarget>> = {
  shippingPolicy: "shippingPolicy",
  returnPolicy: "returnPolicy",
  paymentPolicy: "paymentPolicy",
  ebayCategory: "ebayCategory",
  storeShelf: "storeShelf",
  descriptionTemplate: "description",
};

/** The fields a row's editor changes, in the drawer's order. */
export function drawerEditFields(target: DrawerEditTarget): readonly ProductEditField[] {
  return target === "description" ? DESCRIPTION_EDIT_FIELDS : [target];
}

/** How a row can be changed, whatever its editor. */
interface DrawerRowEditState {
  /** A new value can be picked (own text written, for the description). */
  canSet: boolean;
  /** "Use default" can be chosen. */
  canDefault: boolean;
  /** "None" can be chosen (shelf, text above and below). */
  canNone: boolean;
  /** [Change]: shown when anything can be chosen; off while the own read loads, a save is out or a size's price waits (D2). */
  change: { shown: boolean; disabled: boolean };
  /**
   * The row's "Sizes differ" quick picks and the check's answers under the
   * closed Description row: off as [Change] is, and while any row's editor is
   * open, since that editor's [Done] would then override them unseen.
   */
  picksDisabled: boolean;
  /** The line under the row: "Checking…", the D2 or sign-in line, or why it can't be changed; null when nothing needs saying. */
  line: string | null;
  /** This row's editor is the one open. */
  open: boolean;
  /** "→ Free Standard US · Not saved", "→ Use default · Not saved", "→ Text above: your own · Not saved" while the draft changes it. */
  pending: string | null;
  /** Another window changed one of its fields too (R:542, after "Load latest"). */
  marked: boolean;
  /** The refused save that names one of its fields. */
  fieldError: string | null;
}

/** A one-field row (a policy, the eBay category, the store shelf): its field and the draft's choice for it. */
export type DrawerFieldRowEdit = {
  [F in DrawerFieldTarget]: DrawerRowEditState & {
    kind: "field";
    target: F;
    field: F;
    /** The draft's choice for this field: "leave" while it holds none. */
    choice: ProductFieldChoice<F>;
  };
}[DrawerFieldTarget];

/** The Description row: its three parts, the draft's choice for each, and the main text's check. */
export interface DrawerDescriptionRowEdit extends DrawerRowEditState {
  kind: "description";
  target: "description";
  fields: readonly DescriptionEditField[];
  choices: Pick<ProductSettingsChoices, DescriptionEditField>;
  /** "Card Shellz changed this product. Check your text still fits." [Keep my text] [Use Card Shellz text]; null when nothing needs a check, it can't be answered now, or the draft answers it. */
  check: OwnTextCheck | null;
}

export type DrawerRowEdit = DrawerFieldRowEdit | DrawerDescriptionRowEdit;
export type DrawerPolicyRowEdit = Extract<DrawerFieldRowEdit, { field: PolicyEditField }>;

/** Whether a row's edit is a policy row's (PR 10a's editor). */
export function isPolicyRowEdit(edit: DrawerRowEdit | null | undefined): edit is DrawerPolicyRowEdit {
  return edit != null && edit.kind === "field" && isPolicyEditField(edit.field);
}

export interface DrawerSettingRowModel {
  key: DrawerSettingRowKey;
  label: string;
  /** The setting; the description row adds the main text as a second group. */
  groups: DrawerSettingGroup[];
  /** The older group rules' place in the order, once, when one is used. */
  notes: string[];
  /** How it can be changed; null without edit facts (PR 7). */
  edit: DrawerRowEdit | null;
}

/** What the rows need to say how each can be changed (PR 10). */
export interface DrawerSettingsEditInput {
  /** The product's own settings read (`listingSettingsProductOwnQueryOptions`). */
  own: ListingSettingsReadState<ProductOwnSettings>;
  rights: ProductSettingsRights;
  /** The step's one draft, whoever holds it. */
  draft: ListingSettingsDraft | null;
  editor: EditorId;
  /** The row whose editor is open; one at a time. */
  openField: DrawerEditTarget | null;
  /** The last refused settings save, with the fields it named (`WriteFailure.fields`). */
  failure: Pick<WriteFailure, "message" | "fields"> | null;
  /** The step's shelves read (`categories`), to name a picked shelf in its pending line; null or absent while it can't be read. */
  shelves?: readonly DropshipEbayStoreCategoryOption[] | null;
}

type SettingValue<K extends ListingSettingsSettingKey> = ListingSettingsProductDetail["settings"][K][number]["value"];

/** The name the product's own row stored for this policy, when its own policy is this one (G2). Also a category's row (PR 10e). */
function ownPolicyName(own: Pick<ProductOwnSettings, "own"> | null, key: PolicyEditField, policyId: string | null): string | null {
  const saved = own?.own[key] ?? null;
  return saved !== null && saved.id === policyId ? saved.name : null;
}

function settingValueWords(
  key: ListingSettingsSettingKey,
  value: SettingValue<ListingSettingsSettingKey>,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  own: ProductOwnSettings | null,
): string {
  switch (key) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy": {
      const policy = value as SettingValue<"shippingPolicy">;
      return drawerPolicyValue(key, policy, setup, ownPolicyName(own, key, policy.policyId));
    }
    case "ebayCategory":
      return drawerEbayCategoryValue(value as SettingValue<"ebayCategory">);
    case "storeShelf":
      // A stored shelf name is eBay's path ("Supplies:Sleeves"); the drawer says it in the record's words
      // ("Supplies › Sleeves", R:581), as the shelf editor and a pending pick do.
      return drawerStoreShelfValue({ names: (value as SettingValue<"storeShelf">).names.map(shelfPathWords) });
    case "descriptionTemplate":
      return drawerDescriptionTemplateValue(value as SettingValue<"descriptionTemplate">);
    case "mainText":
      return drawerMainTextValue(value as SettingValue<"mainText">);
  }
}

/** The row's rights and whether its quick picks wait, for "Sizes differ" (5.3); null without edit facts. */
type DifferFacts = { rights: Pick<ProductFieldRights, "canSet" | "canDefault">; disabled: boolean } | null;

function settingGroup(
  key: ListingSettingsSettingKey,
  detail: ListingSettingsProductDetail,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  sizeNames: ReadonlyMap<number, string>,
  own: ProductOwnSettings | null,
  differFacts: DifferFacts,
): { group: DrawerSettingGroup; groupRule: boolean } {
  const values = detail.settings[key];
  const differ = values.length > 1;
  const setting = { key, values } as SizesDifferSetting;
  let groupRule = false;
  let anyButton = false;
  let differLine: string | null = null;
  const entries = values.map((entry): DrawerSettingEntry => {
    const tags: string[] = [];
    for (const source of entry.sources) {
      if (source.source === "group_rule") groupRule = true;
      const tag = drawerSourceWords(key, source).tag;
      if (tag !== null && !tags.includes(tag)) tags.push(tag);
    }
    const sizes = entry.sources.flatMap((source) => source.productVariantIds).map((id) => sizeNames.get(id) ?? "");
    const shown: DrawerSettingEntry = { value: settingValueWords(key, entry.value, setup, own), tags, usedBy: differ ? usedByWords(sizes) : null };
    if (!differ || differFacts === null) return shown;
    const pick = sizesDifferPick(setting, entry, differFacts.rights, setup);
    if (pick.kind === "line") differLine = pick.line;
    if (pick.kind !== "button") return shown;
    anyButton = true;
    return { ...shown, pick: { action: pick.action, label: pick.label, field: pick.field, picks: pick.picks, disabled: differFacts.disabled } };
  });
  const differWords = !differ ? null
    : anyButton ? LISTING_SETTINGS_EDIT_WORDS.sizesDifferPick
      : differLine ?? SIZES_DIFFER_WORDS;
  return { group: { entries, differ: differWords }, groupRule };
}

const LEAVE_CHOICE: FieldChoice<never> = Object.freeze({ mode: "leave" });

/** A picked shelf's name: the product's (or category's, PR 10e) own row's, else the shelves read's path, else "A shelf". */
function shelfName(id: string, own: Pick<ProductOwnSettings, "own"> | null, shelves: readonly DropshipEbayStoreCategoryOption[] | null): string {
  const saved = own?.own.storeShelf;
  const stored = saved?.mode === "own" ? saved.shelves.find((shelf) => shelf.id === id)?.name ?? null : null;
  if (stored !== null) return shelfPathWords(stored) || UNNAMED_SHELF;
  const live = shelves?.find((shelf) => shelf.categoryId === id) ?? null;
  return live === null ? UNNAMED_SHELF : shelfPathWords(live.path) || live.categoryName.trim() || UNNAMED_SHELF;
}

/**
 * A one-field row's change before Save, by name only (never an id). Also the
 * "Set for selected" rows' (PR 10 plan 6.3), with no product's own row (`own`
 * null), and the category editor's (PR 10e), with the category's own row in
 * the product row's shape (the two store the same value shapes, `SR`).
 */
export function fieldPendingWords(
  field: DrawerFieldTarget,
  choice: ProductFieldChoice<DrawerFieldTarget>,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  own: Pick<ProductOwnSettings, "own"> | null,
  shelves: readonly DropshipEbayStoreCategoryOption[] | null,
): string | null {
  if (choice.mode === "leave") return null;
  if (choice.mode === "default") return pendingSettingWords(LISTING_SETTINGS_EDIT_WORDS.useDefault);
  const value = choice.value as unknown as Record<string, unknown>;
  switch (field) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy": {
      const id = String(value.id);
      return pendingSettingWords(drawerPolicyValue(field, { policyId: id }, setup, ownPolicyName(own, field, id)));
    }
    case "ebayCategory": {
      const id = String(value.categoryId);
      const saved = own?.own.ebayCategory;
      const name = typeof value.categoryName === "string" ? value.categoryName : saved?.categoryId === id ? saved.categoryName : null;
      return pendingSettingWords(drawerEbayCategoryValue({ categoryId: id, categoryName: name }));
    }
    case "storeShelf": {
      if (value.mode !== "own") return pendingSettingWords(LISTING_SETTINGS_EDIT_WORDS.none);
      const names = (value.shelfIds as readonly string[]).map((id) => shelfName(id, own, shelves));
      return pendingSettingWords(drawerStoreShelfValue({ names }));
    }
  }
}

/** The Description row's change before Save: each part it changes, never the text itself. Also the "Set for selected" row's. */
export function descriptionPending(choices: Pick<ProductSettingsChoices, DescriptionEditField>): string | null {
  const parts: DescriptionPendingPart[] = [];
  for (const part of DESCRIPTION_EDIT_FIELDS) {
    const choice = choices[part];
    if (choice.mode === "leave") continue;
    if (choice.mode === "default") parts.push({ part, to: "default" });
    else parts.push({ part, to: part === "mainText" ? "own" : (choice.value as { mode: "none" | "own" }).mode });
  }
  return descriptionPendingWords(parts);
}

/** How one row can be changed, from the rights, the own read and the draft. */
function rowEdit(
  target: DrawerEditTarget,
  input: DrawerSettingsEditInput,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  detail: ListingSettingsProductDetail,
): DrawerRowEdit {
  const fields = drawerEditFields(target);
  // The description's three parts share one right: W5's (text names no eBay value).
  const rights = productFieldRights(input.rights, fields[0]);
  const own = input.own.error != null ? null : input.own.data ?? null;
  const ownFailed = input.own.error != null;
  const ownDraft = input.draft !== null && input.draft.editor === input.editor ? input.draft : null;
  const locked = ownDraft !== null && isDraftLocked(ownDraft);
  // Choices count only while the draft holds them: once saved, the rows show what the server says.
  const holding = ownDraft !== null && (isDraftDirty(ownDraft) || locked);
  const settings = holding ? readProductSettingsDraft(ownDraft.value) : null;
  // A size's exact price (W9) or the product's price (W7, PR 10d) holds a change: the settings wait (D2).
  const changeKind = drawerChangeKind(input.draft, input.editor);
  const sizeWaits = changeKind === "size_price" || changeKind === "product_price";
  const shown = rights.canSet || rights.canDefault || rights.canNone;

  let line: string | null = null;
  if (!shown) line = rights.reason === null ? null : rightReasonLine(rights.reason);
  // A failed own read is said once for the drawer (`drawerOwnReadProblem`), not on each row.
  else if (own === null) line = ownFailed ? null : DRAWER_WORDS.checking;
  else if (sizeWaits) line = LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst;
  else if (!rights.canSet && rights.reason !== null) {
    // The editor then lists "Use default" (and "None") alone; a banner that says why gives no line of its own (D4).
    line = rights.reason === "sign_in"
      ? LISTING_SETTINGS_EDIT_WORDS.signInFieldLine
      : rightReasonLine(rights.reason) ?? LISTING_SETTINGS_EDIT_WORDS.defaultOnlyLine;
  }

  const choiceOf = <F extends ProductEditField>(field: F): ProductFieldChoice<F> =>
    (settings?.[field] ?? LEAVE_CHOICE) as ProductFieldChoice<F>;
  const state: Omit<DrawerRowEditState, "pending"> = {
    canSet: rights.canSet,
    canDefault: rights.canDefault,
    canNone: rights.canNone,
    change: { shown, disabled: own === null || locked || sizeWaits },
    picksDisabled: own === null || locked || sizeWaits || input.openField !== null,
    line,
    open: input.openField === target,
    marked: settings !== null && ownDraft !== null && fields.some((field) => ownDraft.marked.includes(field)),
    fieldError: fields.some((field) => input.failure?.fields?.includes(field) === true) ? input.failure?.message ?? null : null,
  };
  const shelves = input.shelves ?? null;
  if (target === "description") {
    const choices = { textAbove: choiceOf("textAbove"), textBelow: choiceOf("textBelow"), mainText: choiceOf("mainText") };
    // The check's answers put a choice in the draft, so they wait as [Change] does; once the draft answers it, the pending line says so.
    const check = shown && own !== null && choices.mainText.mode === "leave" ? ownTextCheckChoices(own, detail, sizeLeftoverFields(detail.settings)) : null;
    return { ...state, kind: "description", target, fields: DESCRIPTION_EDIT_FIELDS, choices, pending: descriptionPending(choices), check };
  }
  const choice = choiceOf(target);
  return { ...state, kind: "field", target, field: target, choice, pending: fieldPendingWords(target, choice, setup, own, shelves) } as DrawerFieldRowEdit;
}

/** How the drawer's one draft drives its footer, its Save and its Esc (PR 10: D2, plan 3.4, 4.6; PR 10d: 7.6). */
export interface DrawerDraftState {
  /**
   * The writer Save, Check again, Load latest and Reload use: the product's
   * settings (W5), the product's price (W7: Save runs the price check, the
   * check body's own footer applies it), else one size's price (W9).
   */
  writer: "W5" | "W7" | "W9";
  /** The draft the footer reads: the product's draft of any kind; null with none. */
  footerDraft: ListingSettingsDraft | null;
  /** The right the footer saves with: `productSettings` for W5, `priceCheck` for W7, `exactPrice` for W9. */
  editable: boolean;
  /** The product's settings hold a change, or a save of them is out or unconfirmed: every size's price waits (D2). */
  settingsHoldChange: boolean;
  /** The product's price holds a change, or its apply is out or unconfirmed: every size's price and every row waits (D2). */
  priceHoldsChange: boolean;
  /** A refused save that names none of the rows is told in the footer; one that names a row is told there. */
  showRefusal: boolean;
  /** Esc keeps the drawer open: a settings or price save is out or unconfirmed (3.4). A size's price keeps PR 7's Esc. */
  escapeKeepsOpen: boolean;
}

const EDIT_FIELD_NAMES: ReadonlySet<string> = new Set<string>(PRODUCT_EDIT_FIELDS);

/**
 * The drawer's draft state, from the step's one draft, the rights and the
 * last refused save. `rights.priceCheck` is W7's (PR 10d); a caller that
 * doesn't pass it can't save a price change (the footer's Save stays off).
 */
export function drawerDraftState(input: {
  draft: ListingSettingsDraft | null;
  editor: EditorId;
  rights: { exactPrice: ListingSettingsRight; productSettings: ListingSettingsRight; priceCheck?: ListingSettingsRight };
  failure: Pick<WriteFailure, "fields"> | null;
}): DrawerDraftState {
  const mine = input.draft !== null && input.draft.editor === input.editor ? input.draft : null;
  const settings = mine !== null && readProductSettingsDraft(mine.value) !== null;
  const price = mine !== null && !settings && readProductPriceDraft(mine.value) !== null;
  const namesRow = (input.failure?.fields ?? []).some((field) => EDIT_FIELD_NAMES.has(field));
  const kind = drawerChangeKind(input.draft, input.editor);
  const writer: DrawerDraftState["writer"] = settings ? "W5" : price ? "W7" : "W9";
  return {
    writer,
    footerDraft: settings || price ? mine : ownSizePriceDraft(input.draft, input.editor)?.draft ?? null,
    editable: settings ? input.rights.productSettings.editable
      : price ? input.rights.priceCheck?.editable === true
        : input.rights.exactPrice.editable,
    settingsHoldChange: kind === "settings",
    priceHoldsChange: kind === "product_price",
    // A price refusal names no row: it is told in the footer (or in the check body, which shows while the draft holds a check).
    showRefusal: (settings && !namesRow) || price,
    escapeKeepsOpen: (settings || price) && isDraftLocked(mine),
  };
}

/**
 * The row whose editor shows (plan 4.5): the one the vendor opened, while
 * its row still offers a choice and the product's own settings are read. A
 * banner can take the right away and a refetch of the own read can fail while
 * it is open; then it closes (its pick was never in the draft). A size's price
 * typed meanwhile keeps it open, so [Done] can say why it waits (D2).
 */
export function shownFieldEditor<T extends DrawerEditTarget>(
  rows: readonly Pick<DrawerSettingRowModel, "edit">[],
  target: T | null,
  ownRead: boolean,
): T | null {
  if (target === null || !ownRead) return null;
  const edit = rows.find((row) => row.edit?.target === target)?.edit ?? null;
  return edit !== null && edit.change.shown ? target : null;
}

/**
 * Where the drawer lands when it opens on a row (an attention [Fix], plan
 * 5.2): the row's edit target, and whether its editor opens there. It opens
 * only when the row's [Change] would (the own read answered, nothing locked,
 * no size price waiting); otherwise the drawer only takes the vendor to the
 * row. Null for a row with no edit facts.
 */
export function drawerLanding(
  rows: readonly Pick<DrawerSettingRowModel, "key" | "edit">[],
  key: DrawerSettingRowKey,
): { target: DrawerEditTarget; open: boolean } | null {
  const edit = rows.find((row) => row.key === key)?.edit ?? null;
  if (edit === null) return null;
  return { target: edit.target, open: edit.change.shown && !edit.change.disabled };
}

/**
 * The drawer's rows (R:968): each setting's value with where it comes from.
 * Sizes that differ list each value with the sizes using it (C16). With
 * `edit` (PR 10), every row says how it can be changed, a product's own
 * policy is named from its own read when eBay wasn't read, and values whose
 * sizes differ get their quick pick (5.3); without it, nothing can be
 * changed, as in PR 7.
 */
export function drawerSettingRows(
  detail: ListingSettingsProductDetail,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  edit: DrawerSettingsEditInput | null = null,
): DrawerSettingRowModel[] {
  const sizeNames = new Map(detail.sizes.map((size) => [size.price.productVariantId, size.price.sizeName]));
  const own = edit === null || edit.own.error != null ? null : edit.own.data ?? null;
  return DRAWER_SETTING_ROWS.map(({ key, label }) => {
    const model = edit === null ? null : rowEdit(DRAWER_ROW_TARGETS[key], edit, setup, detail);
    // A quick pick shows only where the row's [Change] does, and waits as it does and while an editor is open.
    const differFacts: DifferFacts = model === null || !model.change.shown ? null : { rights: model, disabled: model.picksDisabled };
    const keys: ListingSettingsSettingKey[] = key === "descriptionTemplate" ? ["descriptionTemplate", "mainText"] : [key];
    const parts = keys.map((settingKey) => settingGroup(settingKey, detail, setup, sizeNames, own, differFacts));
    return {
      key,
      label,
      groups: parts.map((part) => part.group),
      notes: parts.some((part) => part.groupRule) ? [GROUP_RULE_ORDER_NOTE] : [],
      edit: model,
    };
  });
}
