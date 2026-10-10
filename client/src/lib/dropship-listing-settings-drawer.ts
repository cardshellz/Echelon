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
  drawerDescriptionTemplateValue,
  drawerEbayCategoryValue,
  drawerMainTextValue,
  drawerPolicyValue,
  drawerSourceWords,
  drawerStoreShelfValue,
  GROUP_RULE_ORDER_NOTE,
  ownSettingsSentence,
  productStatusWords,
  SIZES_DIFFER_WORDS,
  usedByWords,
  type PolicySetupFacts,
} from "./dropship-listing-settings-words";

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
// The header (R:591)
// ---------------------------------------------------------------------------

function sizesWord(count: number): string {
  return count === 1 ? "size" : "sizes";
}

/**
 * "Card Shellz category: Sleeves · 4 of 4 sizes selected · No fixes needed",
 * or "No Card Shellz category · …". Category settings come in PR 8-10, so the
 * header never says "From your <c> settings".
 */
export function drawerCategoryLine(product: ListingSettingsProductDetail["product"]): string {
  const category = product.category?.trim();
  // A chosen size Card Shellz no longer offers is still counted, so the line never reads "5 of 4".
  const total = Math.max(product.sizesTotal, product.sizesChosen);
  return [
    category ? `Card Shellz category: ${category}` : "No Card Shellz category",
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

/** The PRICE head (R:245): the store default recipe; "Checking…" until the summary answers. */
export function priceHeadWords(recipe: PricingRecipe | null | undefined): string {
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

/** The 404 words name the store (C27). */
export function productNotFoundWords(storeName: string): string {
  const name = storeName.trim() || "your eBay store";
  return `This product isn't chosen for ${name}. Choose it in step 1.`;
}

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

type W9PriceFacts = Pick<ListingPriceSetting, "rulePriceCents" | "defaultPriceCents" | "ruleName" | "pricingIssue">;

/** "the store default" or "your older group rule “Envelopes”": who gives a rule price. */
function ruleOwner(ruleName: string | null | undefined): { storeDefault: boolean; name: string | null } {
  const name = ruleName?.trim() || null;
  return name === null || name === STORE_DEFAULT_RULE_NAME ? { storeDefault: true, name: null } : { storeDefault: false, name };
}

/**
 * What the size would cost without its exact price (R:250, from W9's GET):
 * "store default would be $15.99", "your older group rule “Envelopes” would
 * give $6.99" (interim), or, with no rule price, "retail price would be
 * $12.50" (interim). Null when nothing would price it.
 */
export function wouldBeWords(setting: W9PriceFacts | null): string | null {
  if (setting === null) return null;
  const inherited = inheritedListingPrice(setting);
  if (inherited.priceCents === null) return null;
  const amount = formatCents(inherited.priceCents);
  if (inherited.from === "retail") return `retail price would be ${amount}`;
  const owner = ruleOwner(setting.ruleName);
  return owner.storeDefault ? `store default would be ${amount}` : `your older group rule “${owner.name}” would give ${amount}`;
}

/** "→ $14.99 · Not saved · store default would be $15.99" (R:250). */
export function typedPriceLine(priceCents: number, setting: W9PriceFacts | null): string {
  const wouldBe = wouldBeWords(setting);
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
  /** Another size of this product holds a change, so this one waits (D4). */
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

export function drawerSizeEditState(draft: ListingSettingsDraft | null, editor: EditorId, price: ListingSettingsSizePrice): DrawerSizeEditState {
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
}

/** The drawer's footer from its draft (R:535-545). */
export function drawerFooter(input: DrawerFooterInput): DrawerFooter {
  const { draft } = input;
  const dirty = isDraftDirty(draft);
  const saveLabel = input.compact ? DRAWER_WORDS.save : DRAWER_WORDS.saveProduct;
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
        { action: "resend", label: LISTING_SETTINGS_SAVE_WORDS.checkAgain, disabled: input.busy || !input.editable },
        { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.uncertain, tone: "alert" },
      );
    case "conflict":
      return footer(
        { action: "load_latest", label: LISTING_SETTINGS_SAVE_WORDS.loadLatest, disabled: input.busy },
        { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.conflict, tone: "alert" },
      );
    case "saved_view_stale":
      return footer(
        { action: "reload", label: LISTING_SETTINGS_SAVE_WORDS.reload, disabled: input.busy },
        { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.savedViewStale, tone: "status" },
      );
    default:
      break;
  }

  const clearReady = input.clear === null || input.clear.kind === "allowed";
  const save = { action: "save" as const, label: saveLabel, disabled: !dirty || !input.editable || input.busy || !clearReady };
  if (draft?.phase === "saved" && input.savedFlashVisible) return footer(save, { text: LISTING_SETTINGS_SAVE_WORDS.saved, tone: "status" });
  // A refused save is told by the size it was for; these are told here.
  if (draft?.phase === "rate_limited" || draft?.phase === "blocked" || draft?.phase === "unreachable") {
    return footer(save, { text: draft.message ?? LISTING_SETTINGS_SAVE_WORDS.blocked, tone: "alert" });
  }
  if (draft?.phase === "editing" && draft.message) return footer(save, { text: draft.message, tone: "status" });
  return footer(save);
}

// ---------------------------------------------------------------------------
// The read-only rows (R:259-266, R:285-294; C16, C17)
// ---------------------------------------------------------------------------

/** The read-only rows, in the record's order (R:259-266). The description row also shows the main text. */
export const DRAWER_SETTING_ROWS = [
  { key: "shippingPolicy", label: "Shipping policy" },
  { key: "returnPolicy", label: "Return policy" },
  { key: "paymentPolicy", label: "Payment policy" },
  { key: "ebayCategory", label: "eBay category" },
  { key: "storeShelf", label: "Store shelf" },
  { key: "descriptionTemplate", label: "Description" },
] as const satisfies readonly { key: ListingSettingsSettingKey; label: string }[];

export type DrawerSettingRowKey = (typeof DRAWER_SETTING_ROWS)[number]["key"];

/** One value of a setting and where it comes from. */
export interface DrawerSettingEntry {
  value: string;
  /** "Store default", "From your older group rule “Envelopes”"…; the value says it alone when empty. */
  tags: string[];
  /** "used by Pack of 100 and Box of 5" when the sizes differ; null otherwise. */
  usedBy: string | null;
}

/** One setting's values: one, or several when the sizes differ (C16). */
export interface DrawerSettingGroup {
  entries: DrawerSettingEntry[];
  /** "Sizes have different values. Each size keeps its own for now."; null when every size agrees. */
  differ: string | null;
}

export interface DrawerSettingRowModel {
  key: DrawerSettingRowKey;
  label: string;
  /** The setting; the description row adds the main text as a second group. */
  groups: DrawerSettingGroup[];
  /** "Older group rules come after a product's own settings and before your store defaults." once, when one is used. */
  notes: string[];
}

type SettingValue<K extends ListingSettingsSettingKey> = ListingSettingsProductDetail["settings"][K][number]["value"];

function settingValueWords(
  key: ListingSettingsSettingKey,
  value: SettingValue<ListingSettingsSettingKey>,
  setup: ListingSettingsReadState<PolicySetupFacts>,
): string {
  switch (key) {
    case "shippingPolicy":
    case "returnPolicy":
    case "paymentPolicy":
      return drawerPolicyValue(key, value as SettingValue<"shippingPolicy">, setup);
    case "ebayCategory":
      return drawerEbayCategoryValue(value as SettingValue<"ebayCategory">);
    case "storeShelf":
      return drawerStoreShelfValue(value as SettingValue<"storeShelf">);
    case "descriptionTemplate":
      return drawerDescriptionTemplateValue(value as SettingValue<"descriptionTemplate">);
    case "mainText":
      return drawerMainTextValue(value as SettingValue<"mainText">);
  }
}

function settingGroup(
  key: ListingSettingsSettingKey,
  detail: ListingSettingsProductDetail,
  setup: ListingSettingsReadState<PolicySetupFacts>,
  sizeNames: ReadonlyMap<number, string>,
): { group: DrawerSettingGroup; groupRule: boolean } {
  const values = detail.settings[key];
  const differ = values.length > 1;
  let groupRule = false;
  const entries = values.map((entry) => {
    const tags: string[] = [];
    for (const source of entry.sources) {
      if (source.source === "group_rule") groupRule = true;
      const tag = drawerSourceWords(key, source).tag;
      if (tag !== null && !tags.includes(tag)) tags.push(tag);
    }
    const sizes = entry.sources.flatMap((source) => source.productVariantIds).map((id) => sizeNames.get(id) ?? "");
    return { value: settingValueWords(key, entry.value, setup), tags, usedBy: differ ? usedByWords(sizes) : null };
  });
  return { group: { entries, differ: differ ? SIZES_DIFFER_WORDS : null }, groupRule };
}

/**
 * The drawer's read-only rows (R:968): each setting's value with where it
 * comes from. Sizes that differ list each value with the sizes using it
 * (C16); nothing here can be changed in PR 7.
 */
export function drawerSettingRows(
  detail: ListingSettingsProductDetail,
  setup: ListingSettingsReadState<PolicySetupFacts>,
): DrawerSettingRowModel[] {
  const sizeNames = new Map(detail.sizes.map((size) => [size.price.productVariantId, size.price.sizeName]));
  return DRAWER_SETTING_ROWS.map(({ key, label }) => {
    const keys: ListingSettingsSettingKey[] = key === "descriptionTemplate" ? ["descriptionTemplate", "mainText"] : [key];
    const parts = keys.map((settingKey) => settingGroup(settingKey, detail, setup, sizeNames));
    return {
      key,
      label,
      groups: parts.map((part) => part.group),
      notes: parts.some((part) => part.groupRule) ? [GROUP_RULE_ORDER_NOTE] : [],
    };
  });
}
