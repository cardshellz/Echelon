import { describe, expect, it } from "vitest";
import {
  CONVERSION_BLOCKER_CODES,
  CONVERSION_CHANGED_FIELDS,
  listingRulesConversionCheckSchema,
  type ConversionBlockerCode,
  type ConversionChangeRow,
  type ConversionSizeView,
  type ListingRulesConversionCheck,
  type PricingRuleRef,
} from "@shared/dropship/listing-rules-conversion";
import type { ListingSettingsSizePrice, ListingSettingsSummary } from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import {
  CONVERSION_BLOCKER_FIX_ROWS,
  CONVERSION_REASON_LISTS,
  OLDER_RULES_SHEET_OPENED,
  becomesLines,
  blockedLines,
  conversionCheckQueryOptions,
  conversionCheckReadEnabled,
  conversionFixLanding,
  conversionRowLines,
  conversionTooLargeError,
  keptLine,
  laterProductsLine,
  olderGroupRulesPresent,
  conflictRereadKeys,
  olderRulesGoneRereadKeys,
  olderRulesLineModel,
  olderRulesOpener,
  olderRulesSheetPages,
  olderRulesSheetSession,
  olderRulesSheetState,
  olderRulesState,
  reportLines,
  conversionOutcomeOf,
  type OlderRulesApplyFacts,
  type OlderRulesSheetInput,
  type OlderRulesSheetNotice,
  type OlderRulesSheetOutcome,
  type OlderRulesSheetSession,
  type OlderRulesSheetState,
} from "../dropship-listing-settings-conversion";
import type { ListingSettingsRight } from "../dropship-listing-settings-access";
import {
  CONVERSION_EDITOR_ID,
  LISTING_SETTINGS_SAVE_WORDS,
  classifyWriteFailure,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type WriteFailure,
} from "../dropship-listing-settings-drafts";
import { LISTING_SETTINGS_OFF_CONTRACT, ListingSettingsReadError, listingSettingsQueryKey } from "../dropship-listing-settings";
import { DRAWER_WORDS, DRAWER_SETTING_ROWS } from "../dropship-listing-settings-drawer";
import { builtFromWords, formatCents, recipeWords } from "../dropship-listing-settings-price-words";
import {
  CONVERSION_BLOCKER_WORDS,
  LISTING_SETTINGS_CONVERSION_WORDS,
  LISTING_SETTINGS_EDIT_WORDS,
  conversionChangesListedWords,
  fixReasonWords,
} from "../dropship-listing-settings-words";
import { DropshipApiError } from "../dropship-ops-surface";

/** Moving older group rules over, on screen and read-only (PR 11b, plan 5.3, 5.4, 11.1, 11.2, 11.4, 11.5; D17, D18, D21, D25). */

const STORE = 22;
const GENERATED_AT = "2026-10-15T12:00:00.000Z";
const PLAN_A = "a".repeat(64);
const PLAN_B = "b".repeat(64);
const WRITES = "c".repeat(64);
const DESC_1 = "d".repeat(64);
const DESC_2 = "e".repeat(64);
/** Ids are keys only: none of these may show up in any words (owner rule; C10). */
const PENNY = 4711;
const PENNY_100 = 90101;
const PENNY_1000 = 90102;
const TEAM_BAGS = 4712;
const TEAM_BAGS_50 = 90201;
const SLEEVES_CATEGORY = 7301;
const EBAY_SLEEVES = "261328";
const EBAY_TOPLOADERS = "183454";
const SHIPPING_POLICY = "6100001";
const IDS = [String(PENNY), String(PENNY_100), String(PENNY_1000), String(TEAM_BAGS), String(TEAM_BAGS_50), String(SLEEVES_CATEGORY), EBAY_SLEEVES, EBAY_TOPLOADERS, SHIPPING_POLICY];
/** A raw code or enum value leaking into vendor words: snake_case or a DROPSHIP_ code. */
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;

const W = LISTING_SETTINGS_CONVERSION_WORDS;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const COST_40: PricingRecipe = { basis: "product_cost", markupBps: 4000, flatCents: 0, rounding: "cent" };
const COST_35_PLUS_1: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 100, rounding: "cent" };

function price(overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return {
    productVariantId: PENNY_100, productId: PENNY, productName: "Penny Sleeves", sizeName: "Pack of 100", sku: null,
    priceCents: 499, source: "rules", rule: { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP },
    basis: "catalog_retail", basisAmountCents: 399, issue: null, costCents: 210, belowCostByCents: null, limits: [],
    pausedSince: null, settingRevisionId: null,
    ...overrides,
  };
}

/** One sample price per source class (plan 3.2), each as the read model builds it, with the class it is. */
const PRICE_SAMPLES: ReadonlyArray<{ name: string; sourceClass: string; price: ListingSettingsSizePrice }> = [
  { name: "an exact price", sourceClass: "exact", price: price({ source: "exact", priceCents: 1499, rule: null, basis: null, basisAmountCents: null, settingRevisionId: 7 }) },
  { name: "the store default from cost", sourceClass: "rules_product_cost", price: price({ priceCents: 294, rule: { kind: "store_default", name: "Store default rule", recipe: COST_40 }, basis: "product_cost", basisAmountCents: 210 }) },
  { name: "an older group from cost", sourceClass: "rules_product_cost", price: price({ priceCents: 384, rule: { kind: "group", name: "Sleeves", recipe: COST_35_PLUS_1 }, basis: "product_cost", basisAmountCents: 210 }) },
  { name: "the store default from retail", sourceClass: "rules_catalog_retail", price: price() },
  { name: "a category price from retail", sourceClass: "rules_catalog_retail", price: price({ priceCents: 499, rule: { kind: "category", name: "Sleeves", recipe: RETAIL_20_UP } }) },
  { name: "a product price from retail", sourceClass: "rules_catalog_retail", price: price({ priceCents: 499, rule: { kind: "product", name: "Penny Sleeves", recipe: RETAIL_20_UP } }) },
  { name: "a rules price from cost the answer names no rule for", sourceClass: "rules_product_cost", price: price({ rule: null, basis: "product_cost", basisAmountCents: 210 }) },
  { name: "a rules price from retail the answer names no rule for", sourceClass: "rules_catalog_retail", price: price({ rule: null }) },
  { name: "the retail price, nothing saved", sourceClass: "catalog_price", price: price({ source: "catalog_price", priceCents: 399, rule: null, basis: null, basisAmountCents: null }) },
  { name: "the retail price, kept from before", sourceClass: "catalog_price", price: price({ source: "catalog_price", priceCents: 399, rule: null, basis: null, basisAmountCents: null, settingRevisionId: 3 }) },
  { name: "the last published price", sourceClass: "last_published", price: price({ source: "last_published", priceCents: 459, rule: null, basis: null, basisAmountCents: null }) },
  { name: "the retail fallback, no rule covers it", sourceClass: "retail_fallback", price: price({ source: "retail_fallback", priceCents: 399, rule: null, basis: null, basisAmountCents: null, issue: null }) },
  { name: "the retail fallback, no cost on file", sourceClass: "retail_fallback", price: price({ source: "retail_fallback", priceCents: 399, rule: null, basis: null, basisAmountCents: null, issue: "pricing_basis_unavailable" }) },
  { name: "the retail fallback, two rules tie", sourceClass: "retail_fallback", price: price({ source: "retail_fallback", priceCents: 399, rule: null, basis: null, basisAmountCents: null, issue: "pricing_rule_priority_conflict" }) },
  { name: "the retail fallback, outside a limit", sourceClass: "retail_fallback", price: price({ source: "retail_fallback", priceCents: 399, rule: null, basis: null, basisAmountCents: null, issue: "pricing_rule_outside_limit" }) },
  { name: "no price, no cost on file", sourceClass: "none", price: price({ source: "none", priceCents: null, rule: null, basis: "product_cost", basisAmountCents: null, issue: "pricing_basis_unavailable" }) },
  { name: "no price, no store price yet", sourceClass: "none", price: price({ source: "none", priceCents: null, rule: null, basis: null, basisAmountCents: null, issue: "pricing_rules_not_configured" }) },
];

function sizeView(overrides: Partial<ConversionSizeView> = {}): ConversionSizeView {
  return {
    price: price(),
    pricingRule: { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP },
    ebayCategory: { id: EBAY_SLEEVES, name: "Card Sleeves" },
    shelfNames: [],
    policies: { shipping: SHIPPING_POLICY, return: null, payment: null },
    descriptionHash: DESC_1,
    blockers: [],
    ...overrides,
  };
}

/** A changed size, both sides on the row's own size (the contract refines it). */
function changeRow(
  changed: ConversionChangeRow["changed"],
  before: ConversionSizeView,
  after: ConversionSizeView,
  size: { productId?: number; productVariantId?: number; productName?: string; sizeName?: string } = {},
): ConversionChangeRow {
  const productId = size.productId ?? PENNY;
  const productVariantId = size.productVariantId ?? PENNY_100;
  const onSize = (side: ConversionSizeView): ConversionSizeView => ({ ...side, price: { ...side.price, productId, productVariantId } });
  return {
    productVariantId, productId, productName: size.productName ?? "Penny Sleeves", sizeName: size.sizeName ?? "Pack of 100",
    changed, before: onSize(before), after: onSize(after),
  };
}

const list = <T>(items: readonly T[], total = items.length) => ({ total, items: [...items] });
const EMPTY_REPORT = {
  unmatched: list([]), shared: list([]), nameMismatches: list([]), neverApplies: list([]), ties: list([]), someSizesOnly: list([]), mixed: list([]),
};
const NOTHING_KEPT = { exactPrices: 0, catalogPrices: 0, sizePolicies: 0, sizeShelves: 0, sizeTexts: 0 };

/** A dry-run answer, parsed with the strict contract so every fixture is one the server could send. */
function check(overrides: Partial<ListingRulesConversionCheck> = {}): ListingRulesConversionCheck {
  return deepFreeze(listingRulesConversionCheckSchema.parse({
    storeConnectionId: STORE, generatedAt: GENERATED_AT, state: "clean", planHash: PLAN_A, writesHash: WRITES,
    olderRules: { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 },
    blocked: { wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: false },
    becomes: { categories: list([{ categoryId: SLEEVES_CATEGORY, categoryName: "Sleeves", settings: ["price"] }]), products: list([]) },
    report: EMPTY_REPORT,
    kept: NOTHING_KEPT,
    changes: { page: 0, pageSize: 50, total: 0, rows: [] },
    ...overrides,
  }));
}

const NO_OLDER_RULES = check({
  state: "no_older_rules", planHash: null, writesHash: null, olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 },
  becomes: { categories: list([]), products: list([]) },
});

/** `count` changed rows from size id `firstId`, each a price change (499 → 599). */
function priceRows(count: number, firstId: number, productName = "Penny Sleeves"): ConversionChangeRow[] {
  return Array.from({ length: count }, (_, index) => changeRow(["price"], sizeView(), sizeView({ price: price({ priceCents: 599 }) }), {
    productVariantId: firstId + index, productName, sizeName: `Size ${String(index + 1).padStart(3, "0")}`,
  }));
}

/** A not-clean answer for page `page` of a plan with `total` changed rows, 50 a page. */
function notCleanPage(page: number, total: number, planHash = PLAN_A, overrides: Partial<ListingRulesConversionCheck> = {}): ListingRulesConversionCheck {
  const rows = priceRows(Math.max(0, Math.min(50, total - page * 50)), 100_000 + page * 50);
  return check({ state: "not_clean", planHash, changes: { page, pageSize: 50, total, rows }, ...overrides });
}

type Summary = Pick<ListingSettingsSummary, "catalog" | "storeDefaults">;
function summary(groupRules: { price?: number; description?: number; ebayCategory?: number } = {}, state: "ok" | "too_large" = "ok"): { data: Summary; error: null } {
  return deepFreeze({
    data: {
      catalog: state === "ok" ? { state: "ok", products: 20, sizes: 60 } : { state: "too_large", limit: 10_000 },
      storeDefaults: {
        price: { recipe: RETAIL_20_UP, groupRules: groupRules.price ?? 0 },
        shippingPolicy: { policyId: "F1", verification: "not_checked" },
        returnPolicy: { policyId: "R1", verification: "not_checked" },
        paymentPolicy: { policyId: null, verification: "not_checked" },
        ebayCategory: { category: null, groupRules: groupRules.ebayCategory ?? 0 },
        description: { hasIntroduction: false, hasFooter: false, groupRules: groupRules.description ?? 0 },
      },
    },
    error: null,
  } as const);
}

const categoriesListed = deepFreeze({ data: { categories: [{ categoryId: SLEEVES_CATEGORY, name: "Sleeves", productCount: 3, revisionId: null, setFields: [] }] }, error: null });
const categoriesNone = deepFreeze({ data: { categories: [] }, error: null });

const apiError = (status: number, code: string | null, context?: Record<string, unknown>) =>
  new DropshipApiError({ message: "Server words.", status, code, context: context ?? null });

const answered = (value: ListingRulesConversionCheck) => ({ data: value, error: null });
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
/** Nothing in the way of a move: no draft, the right, no other action, page 0 read (11d's footer facts). */
const IDLE: OlderRulesApplyFacts = { draft: null, right: EDITABLE, busy: false, checking: false, notStartedLine: null };
function sheet(
  pages: OlderRulesSheetInput["pages"],
  session: OlderRulesSheetSession = OLDER_RULES_SHEET_OPENED,
  outcome: OlderRulesSheetOutcome | null = null,
  apply: Partial<OlderRulesApplyFacts> = {},
): OlderRulesSheetState {
  return olderRulesSheetState(deepFreeze({ pages, session, outcome, apply: { ...IDLE, ...apply } }));
}

/** Every string a model shows: its words, lines, labels and headings (never its keys, kinds or forms). */
const DISPLAY_KEYS = new Set([
  "text", "lines", "label", "ariaLabel", "heading", "summary", "more", "reasons", "priceNow", "head", "laterProducts", "kept",
  "noneLine", "changedLine", "loadingLine", "closeLabel", "retryLabel", "tooMuchText", "title",
]);
function shownStrings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) shownStrings(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (DISPLAY_KEYS.has(key) && typeof item === "string") out.push(item);
      else if (DISPLAY_KEYS.has(key) && Array.isArray(item) && item.every((line) => typeof line === "string")) out.push(...item);
      else shownStrings(item, out);
    }
  }
  return out;
}

function expectPlain(text: string): void {
  expect(text, text).not.toMatch(RAW_CODE);
  expect(text.trim()).toBe(text);
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toMatch(/undefined|null|NaN|\[object/);
  for (const id of IDS) expect(text, `${text} shows the id ${id}`).not.toContain(id);
}

// ---------------------------------------------------------------------------
// The older-rules state, the opener and the line (5.3, 11.1, D17, K7)
// ---------------------------------------------------------------------------

describe("the older-rules state (D17; PR 10 D11)", () => {
  it("is present when any of the summary's three counts is above zero, unknown while it loads or failed", () => {
    expect(olderGroupRulesPresent(summary().data)).toBe(false);
    for (const counts of [{ price: 1 }, { description: 2 }, { ebayCategory: 1 }, { price: 1, description: 1, ebayCategory: 1 }]) {
      expect(olderGroupRulesPresent(summary(counts).data)).toBe(true);
      expect(olderRulesState(summary(counts))).toBe("present");
    }
    expect(olderRulesState(summary())).toBe("absent");
    expect(olderRulesState({ data: undefined })).toBe("unknown");
    expect(olderRulesState({ data: summary({ price: 1 }).data, error: new TypeError("offline") })).toBe("unknown");
  });
});

describe("[See what changes] (D17, K7)", () => {
  it("is offered while the store holds older group rules, and never over 10,000 sizes, while the summary loads or after it failed", () => {
    expect(olderRulesOpener(summary({ price: 1 }))).toEqual({ label: "See what changes" });
    expect(olderRulesOpener(summary({ description: 3 }))).toEqual({ label: "See what changes" });
    expect(olderRulesOpener(summary())).toBeNull();
    expect(olderRulesOpener(summary({ price: 1 }, "too_large"))).toBeNull();
    expect(olderRulesOpener({ data: undefined })).toBeNull();
    expect(olderRulesOpener({ data: summary({ price: 1 }).data, error: apiError(500, null) })).toBeNull();
  });

  it("is not offered once the step's banner says too large, while the summary on screen still says the selection fits (K7, D18)", () => {
    expect(olderRulesOpener(summary({ price: 1 }), { tooLarge: true })).toBeNull();
    expect(olderRulesOpener(summary({ price: 1 }), { tooLarge: false })).toEqual({ label: "See what changes" });
  });
});

describe("the older-rules line under the attention strip (5.3, 11.1)", () => {
  it("names the move with [See what changes] when a chosen product is in a Card Shellz category", () => {
    for (const counts of [{ price: 1 }, { description: 1 }, { ebayCategory: 4 }]) {
      expect(olderRulesLineModel(summary(counts), categoriesListed)).toEqual({
        form: "categories",
        text: "Your store still has older group rules. Move them over to use category settings.",
        opener: { label: "See what changes" },
      });
    }
  });

  it("says only that the rules are there, still with [See what changes], when no chosen product is in a category or the categories can't be read yet", () => {
    const expected = { form: "no_categories", text: "Your store still has older group rules.", opener: { label: "See what changes" } };
    expect(olderRulesLineModel(summary({ price: 1 }), categoriesNone)).toEqual(expected);
    expect(olderRulesLineModel(summary({ price: 1 }), { data: undefined })).toEqual(expected);
    expect(olderRulesLineModel(summary({ price: 1 }), { data: undefined, error: new TypeError("offline") })).toEqual(expected);
    // A failed refresh keeps the last answer's form.
    expect(olderRulesLineModel(summary({ price: 1 }), { data: categoriesListed.data, error: new TypeError("offline") })?.form).toBe("categories");
  });

  it("asks for 10,000 or fewer sizes, with no button, over the limit (K7)", () => {
    expect(olderRulesLineModel(summary({ price: 1 }, "too_large"), categoriesListed)).toEqual({
      form: "too_large", text: "Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.", opener: null,
    });
    expect(olderRulesLineModel(summary({ price: 1 }, "too_large"), { data: undefined })?.opener).toBeNull();
  });

  it("takes the too-large form, with no button, once a read or a save was refused as too large before the summary says so (K7)", () => {
    const tooLarge = { form: "too_large", text: W.lineTooLarge, opener: null };
    // The step's banner (any list, the sheet, a save).
    expect(olderRulesLineModel(summary({ price: 1 }), categoriesListed, { tooLarge: true })).toEqual(tooLarge);
    // The categories read itself refused (the card hides): the same, before the step's banner catches up.
    expect(olderRulesLineModel(summary({ price: 1 }), { data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") })).toEqual(tooLarge);
    expect(olderRulesLineModel(summary({ price: 1 }), { data: categoriesListed.data, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") })).toEqual(tooLarge);
    // Not on another refusal, and not once the banner is gone.
    expect(olderRulesLineModel(summary({ price: 1 }), { data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY") })?.form).toBe("no_categories");
    expect(olderRulesLineModel(summary({ price: 1 }), categoriesListed, { tooLarge: false })?.form).toBe("categories");
    // Still hidden without older rules.
    expect(olderRulesLineModel(summary(), categoriesListed, { tooLarge: true })).toBeNull();
  });

  it("is hidden with no older rules, while the summary loads, and after its latest attempt failed", () => {
    expect(olderRulesLineModel(summary(), categoriesListed)).toBeNull();
    expect(olderRulesLineModel(summary({}, "too_large"), categoriesListed)).toBeNull();
    expect(olderRulesLineModel({ data: undefined }, categoriesListed)).toBeNull();
    expect(olderRulesLineModel({ data: summary({ price: 1 }).data, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") }, categoriesListed)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The read (5.2, 11.2, D14, D18)
// ---------------------------------------------------------------------------

describe("the dry run's read options (5.2, D18)", () => {
  it("reads one page under the store's prefix + conversion + page, fresh, never retried, and only while the sheet is open and not too large", () => {
    const options = conversionCheckQueryOptions(STORE, 2, { open: true, summary: summary({ price: 1 }) });
    expect(options.queryKey).toEqual([...listingSettingsQueryKey(STORE), "conversion", 2]);
    expect(options).toMatchObject({ enabled: true, staleTime: 0, gcTime: 0, retry: false });
    expect(conversionCheckQueryOptions(STORE, 0, { open: false, summary: summary({ price: 1 }) }).enabled).toBe(false);
    expect(conversionCheckQueryOptions(STORE, 0, { open: true, summary: summary({ price: 1 }, "too_large") }).enabled).toBe(false);
    // While the summary loads it runs: a 422 then closes the sheet and reaches the banner (D18).
    expect(conversionCheckQueryOptions(STORE, 0, { open: true, summary: { data: undefined } }).enabled).toBe(true);
    expect(conversionCheckQueryOptions(STORE, 0, { open: true, summary: { data: undefined, error: new TypeError("offline") } }).enabled).toBe(true);
    // A page outside 0..199 is never asked for.
    expect(conversionCheckQueryOptions(STORE, 200, { open: true, summary: summary({ price: 1 }) }).enabled).toBe(false);
    expect(conversionCheckReadEnabled({ open: true, summary: summary() })).toBe(true);
    expect(conversionCheckReadEnabled({ open: false, summary: summary() })).toBe(false);
  });

  it("parses the answer strictly: one off the contract never reaches the sheet", async () => {
    const options = conversionCheckQueryOptions(STORE, 0, { open: true, summary: summary({ price: 1 }) });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ ...check(), extra: true }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    try {
      await expect(options.queryFn({ signal: new AbortController().signal })).rejects.toMatchObject({ code: LISTING_SETTINGS_OFF_CONTRACT, context: { read: "conversion" } });
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// One size's row (11.4, D18; CUX#2)
// ---------------------------------------------------------------------------

describe("a changed size's lines (11.4, D18)", () => {
  it("heads the row with the product and size and gives one line per changed key, in the row's order", () => {
    const row = changeRow(["price", "priceSource", "pricingRule"],
      sizeView({ price: PRICE_SAMPLES[3].price }),
      sizeView({ price: PRICE_SAMPLES[1].price, pricingRule: { kind: "store_default", name: "Store default rule", recipe: COST_40 } }));
    expect(conversionRowLines(row)).toEqual({
      key: `size:${PENNY_100}`,
      productVariantId: PENNY_100,
      head: "Penny Sleeves · Pack of 100",
      lines: [
        `Price: ${formatCents(499)} → ${formatCents(294)}`,
        `Built from: ${builtFromWords(PRICE_SAMPLES[3].price)} → ${builtFromWords(PRICE_SAMPLES[1].price)}`,
        `Pricing rule: Store default (${recipeWords(RETAIL_20_UP)}) → Store default (${recipeWords(COST_40)})`,
      ],
    });
    expect(conversionRowLines(row).lines[0]).toBe("Price: $4.99 → $2.94");
    // A size with no name reads its product alone; a product with none reads "A product".
    expect(conversionRowLines(changeRow(["description"], sizeView(), sizeView({ descriptionHash: DESC_2 }), { productName: " ", sizeName: "" })).head).toBe("A product");
  });

  it("reads every amount through formatCents, and a missing price as —", () => {
    const lost = changeRow(["price", "priceSource"], sizeView(), sizeView({ price: PRICE_SAMPLES[15].price }));
    expect(conversionRowLines(lost).lines[0]).toBe(`Price: ${formatCents(499)} → —`);
    const found = changeRow(["price"], sizeView({ price: PRICE_SAMPLES[16].price }), sizeView({ price: price({ priceCents: 123_456 }) }));
    expect(conversionRowLines(found).lines).toEqual([`Price: — → ${formatCents(123_456)}`]);
  });

  it("words retail fallback ↔ retail price as two different Built from lines, both ways", () => {
    const fallback = PRICE_SAMPLES[11].price;
    const retail = PRICE_SAMPLES[8].price;
    const there = conversionRowLines(changeRow(["priceSource"], sizeView({ price: fallback }), sizeView({ price: retail }))).lines;
    expect(there).toEqual([`Built from: No pricing rule covers this size, so it uses the retail price ($3.99). → Retail price (no store price yet)`]);
    const back = conversionRowLines(changeRow(["priceSource"], sizeView({ price: retail }), sizeView({ price: fallback }))).lines;
    expect(back).toEqual([`Built from: Retail price (no store price yet) → No pricing rule covers this size, so it uses the retail price ($3.99).`]);
  });

  it("never reads the same on both sides for any pair of different price sources (CUX#2)", () => {
    let pairs = 0;
    for (const before of PRICE_SAMPLES) {
      for (const after of PRICE_SAMPLES) {
        if (before.sourceClass === after.sourceClass) continue;
        pairs += 1;
        const [line] = conversionRowLines(changeRow(["priceSource"], sizeView({ price: before.price }), sizeView({ price: after.price }))).lines;
        const [from, to] = line.replace(/^Built from: /, "").split(" → ");
        expect({ before: before.name, after: after.name, differ: from !== to }).toEqual({ before: before.name, after: after.name, differ: true });
        // Each side is the Prices tab's words (D18), with the class added only where the words alone would read the same.
        expect(from.startsWith(builtFromWords(before.price))).toBe(true);
        expect(to.startsWith(builtFromWords(after.price))).toBe(true);
        expectPlain(line);
      }
    }
    expect(pairs).toBeGreaterThan(200);
    // The only pair the Prices tab's words read alike: a rules price whose rule the answer doesn't name, from cost and from retail.
    expect(conversionRowLines(changeRow(["priceSource"], sizeView({ price: PRICE_SAMPLES[6].price }), sizeView({ price: PRICE_SAMPLES[7].price }))).lines)
      .toEqual(["Built from: Your pricing rules (from your cost) → Your pricing rules (from the retail price)"]);
  });

  it("names the pricing rule a size follows, in every form, so a row whose only change is the rule says so (CMC#1)", () => {
    const rule = (from: PricingRuleRef | null, to: PricingRuleRef | null) =>
      conversionRowLines(changeRow(["pricingRule"], sizeView({ pricingRule: from }), sizeView({ pricingRule: to }))).lines;
    expect(rule({ kind: "group", name: "Binders", recipe: COST_40 }, { kind: "store_default", name: "Store default rule", recipe: { ...COST_40, markupBps: 1000 } }))
      .toEqual(["Pricing rule: “Binders” (Your cost + 40%, to the cent) → Store default (Your cost + 10%, to the cent)"]);
    expect(rule({ kind: "tie" }, { kind: "category", name: "Sleeves", recipe: RETAIL_20_UP }))
      .toEqual(["Pricing rule: two rules that tie → Sleeves category (Retail price + 20%, round up to .99)"]);
    expect(rule({ kind: "product", name: "Penny Sleeves", recipe: COST_35_PLUS_1 }, null))
      .toEqual(["Pricing rule: This product (Your cost + 35% plus $1.00, to the cent) → None"]);
  });

  it("names eBay categories by name only: a nameless one, none, and two ids with one name (CUX#2, CMC#8)", () => {
    const ebay = (from: ConversionSizeView["ebayCategory"], to: ConversionSizeView["ebayCategory"]) =>
      conversionRowLines(changeRow(["ebayCategory"], sizeView({ ebayCategory: from }), sizeView({ ebayCategory: to }))).lines[0];
    expect(ebay({ id: EBAY_SLEEVES, name: "Card Sleeves" }, { id: EBAY_TOPLOADERS, name: "Toploaders" })).toBe("eBay category: Card Sleeves → Toploaders");
    expect(ebay({ id: EBAY_SLEEVES, name: null }, { id: EBAY_TOPLOADERS, name: "Toploaders" })).toBe("eBay category: the Card Shellz eBay category → Toploaders");
    expect(ebay(null, { id: EBAY_TOPLOADERS, name: "Toploaders" })).toBe("eBay category: None → Toploaders");
    expect(ebay({ id: EBAY_SLEEVES, name: "Card Sleeves" }, null)).toBe("eBay category: Card Sleeves → None");
    expect(ebay({ id: EBAY_SLEEVES, name: "Card Sleeves" }, { id: EBAY_TOPLOADERS, name: "Card Sleeves" }))
      .toBe("eBay category: Card Sleeves → another eBay category also called “Card Sleeves”");
    expect(ebay({ id: EBAY_SLEEVES, name: null }, { id: EBAY_TOPLOADERS, name: null }))
      .toBe("eBay category: the Card Shellz eBay category → another Card Shellz eBay category");
  });

  it("words the shelves as the drawer does, the policies and the description as a change, and each listable direction with its reasons", () => {
    const lines = (changed: ConversionChangeRow["changed"], before: Partial<ConversionSizeView>, after: Partial<ConversionSizeView>) =>
      conversionRowLines(changeRow(changed, sizeView(before), sizeView(after))).lines;
    expect(lines(["storeShelf"], { shelfNames: [] }, { shelfNames: ["Supplies:Sleeves", "Toploaders"] })).toEqual(["Store shelf: None → Supplies › Sleeves · second: Toploaders"]);
    expect(lines(["storeShelf"], { shelfNames: ["Toploaders", "Sleeves"] }, { shelfNames: ["Sleeves", "Toploaders"] })).toEqual(["Store shelf: Toploaders · second: Sleeves → Sleeves · second: Toploaders"]);
    expect(lines(["shippingPolicy", "returnPolicy", "paymentPolicy"], {}, { policies: { shipping: null, return: "R2", payment: "P2" } }))
      .toEqual(["Shipping policy changes", "Return policy changes", "Payment policy changes"]);
    expect(lines(["description"], {}, { descriptionHash: DESC_2 })).toEqual(["Description changes"]);
    expect(lines(["listable"], { blockers: [] }, { blockers: ["no_ebay_category", "listing_content_description_too_large"] }))
      .toEqual(["Can be listed → can't be listed: no eBay category, the description is too long"]);
    expect(lines(["listable"], { blockers: ["size_cannot_be_priced"] }, { blockers: [] })).toEqual(["Can't be listed → can be listed"]);
    expect(lines(["listable"], { blockers: ["no_ebay_category"] }, { blockers: ["price_outside_limit"] }))
      .toEqual(["Still can't be listed, now because its price is outside a Card Shellz price limit"]);
  });

  it("has a line for every changed key, and every line is plain words with no id or code", () => {
    const before = sizeView({ blockers: [] });
    const after = sizeView({
      price: PRICE_SAMPLES[15].price, pricingRule: { kind: "tie" }, ebayCategory: { id: EBAY_TOPLOADERS, name: null }, shelfNames: ["Supplies:Sleeves"],
      policies: { shipping: null, return: "R2", payment: "P2" }, descriptionHash: DESC_2, blockers: [...CONVERSION_BLOCKER_CODES],
    });
    const row = conversionRowLines(changeRow([...CONVERSION_CHANGED_FIELDS], before, after));
    expect(row.lines).toHaveLength(CONVERSION_CHANGED_FIELDS.length);
    for (const line of [row.head, ...row.lines]) expectPlain(line);
  });
});

describe("the blocker words (CMC#8)", () => {
  it("words every blocker code in a closed table, the four fix codes as the Products tab does", () => {
    expect(Object.keys(CONVERSION_BLOCKER_WORDS).sort()).toEqual([...CONVERSION_BLOCKER_CODES].sort());
    for (const code of CONVERSION_BLOCKER_CODES) expectPlain(CONVERSION_BLOCKER_WORDS[code]);
    expect(new Set(Object.values(CONVERSION_BLOCKER_WORDS)).size).toBe(CONVERSION_BLOCKER_CODES.length);
    for (const code of ["no_ebay_category", "size_cannot_be_priced", "own_text_needs_check", "description_group_conflict"] as const) {
      expect(CONVERSION_BLOCKER_WORDS[code]).toBe(fixReasonWords(code));
    }
    expect(CONVERSION_BLOCKER_WORDS).toMatchObject({
      price_outside_limit: "its price is outside a Card Shellz price limit",
      listing_content_catalog_too_large: "the Card Shellz description is too long",
      listing_content_description_required: "it has no description",
      listing_content_description_too_large: "the description is too long",
    });
  });

  it("sends every blocker's [Fix] to its drawer row: eBay category, Description, or the size's own price", () => {
    expect(Object.keys(CONVERSION_BLOCKER_FIX_ROWS).sort()).toEqual([...CONVERSION_BLOCKER_CODES].sort());
    const rows: readonly string[] = DRAWER_SETTING_ROWS.map((row) => row.key);
    for (const code of CONVERSION_BLOCKER_CODES) {
      const row = CONVERSION_BLOCKER_FIX_ROWS[code];
      if (row !== null) expect(rows).toContain(row);
    }
    const size = { productId: PENNY, productVariantId: PENNY_100 };
    expect(conversionFixLanding(size, "no_ebay_category")).toEqual({ target: { productId: PENNY }, row: "ebayCategory" });
    for (const code of ["own_text_needs_check", "description_group_conflict", "listing_content_catalog_too_large", "listing_content_description_required", "listing_content_description_too_large"] as const) {
      expect(conversionFixLanding(size, code)).toEqual({ target: { productId: PENNY }, row: "descriptionTemplate" });
    }
    for (const code of ["size_cannot_be_priced", "price_outside_limit"] as const) {
      expect(conversionFixLanding(size, code)).toEqual({ target: { productId: PENNY, productVariantId: PENNY_100 }, row: null });
    }
  });
});

// ---------------------------------------------------------------------------
// The lists (11.2, 11.4)
// ---------------------------------------------------------------------------

const sizeRef = (productVariantId: number, sizeName: string, priceCents: number | null = 499, productName = "Penny Sleeves", productId = PENNY) =>
  ({ productId, productVariantId, productName, sizeName, priceCents });

describe("what blocks a move (11.2, D9; CUX#3, CMC#3)", () => {
  it("lists each size that would lose its price with [Set a price] on its Exact price, named for the size", () => {
    const blocked = blockedLines(check({
      state: "not_clean",
      blocked: { wouldLosePrice: list([sizeRef(PENNY_100, "Pack of 100"), sizeRef(PENNY_1000, "Pack of 1000", 2999)]), wouldBlockListing: list([]), tooMuchText: false },
      changes: { page: 0, pageSize: 50, total: 2, rows: [
        changeRow(["price"], sizeView(), sizeView({ price: PRICE_SAMPLES[15].price })),
        changeRow(["price"], sizeView(), sizeView({ price: PRICE_SAMPLES[15].price }), { productVariantId: PENNY_1000, sizeName: "Pack of 1000" }),
      ] },
    }).blocked);
    expect(blocked).toEqual({
      heading: "Before you can move them over",
      wouldLosePrice: {
        text: "2 sizes would have no price after the move. Give each one its own price, then check again.",
        sizes: [
          { key: `size:${PENNY_100}`, text: "Penny Sleeves · Pack of 100", priceNow: `Now: ${formatCents(499)}`, reasons: null,
            action: { kind: "set_price", label: "Set a price", ariaLabel: "Set a price for Penny Sleeves · Pack of 100", landing: { target: { productId: PENNY, productVariantId: PENNY_100 }, row: null } } },
          { key: `size:${PENNY_1000}`, text: "Penny Sleeves · Pack of 1000", priceNow: "Now: $29.99", reasons: null,
            action: { kind: "set_price", label: "Set a price", ariaLabel: "Set a price for Penny Sleeves · Pack of 1000", landing: { target: { productId: PENNY, productVariantId: PENNY_1000 }, row: null } } },
        ],
        more: null,
      },
      wouldBlockListing: null,
      tooMuchText: null,
    });
  });

  it("lists each listed size that would stop updating with its reasons and [Fix] on its first blocker's row, and the text cap", () => {
    const blocked = blockedLines({
      wouldLosePrice: list([]),
      wouldBlockListing: list([
        { ...sizeRef(PENNY_100, "Pack of 100"), reasons: ["no_ebay_category", "listing_content_description_too_large"] },
        { ...sizeRef(TEAM_BAGS_50, "Pack of 50", null, "Team Bags", TEAM_BAGS), reasons: ["price_outside_limit"] },
      ]),
      tooMuchText: true,
    });
    expect(blocked?.wouldBlockListing?.text).toBe("2 sizes you list on eBay would stop getting stock updates after the move. Fix each one, then check again.");
    expect(blocked?.wouldBlockListing?.sizes).toEqual([
      { key: `size:${PENNY_100}`, text: "Penny Sleeves · Pack of 100", priceNow: "Now: $4.99", reasons: "no eBay category, the description is too long",
        action: { kind: "fix", label: "Fix", ariaLabel: "Fix Penny Sleeves · Pack of 100", blocker: "no_ebay_category", landing: { target: { productId: PENNY }, row: "ebayCategory" } } },
      { key: `size:${TEAM_BAGS_50}`, text: "Team Bags · Pack of 50", priceNow: null, reasons: "its price is outside a Card Shellz price limit",
        action: { kind: "fix", label: "Fix", ariaLabel: "Fix Team Bags · Pack of 50", blocker: "price_outside_limit", landing: { target: { productId: TEAM_BAGS, productVariantId: TEAM_BAGS_50 }, row: null } } },
    ]);
    expect(blocked?.tooMuchText).toBe("Moving these rules would save more text than your store can keep. Shorten your older description rules in Older settings, then check again.");
    // Each [Set a price] / [Fix] has its own accessible name.
    const names = blocked?.wouldBlockListing?.sizes.map((size) => size.action.ariaLabel) ?? [];
    expect(new Set(names).size).toBe(names.length);
  });

  it("counts one size in the singular, totals over 100 as \"and N more\", and is null when nothing blocks the move", () => {
    const one = blockedLines({ wouldLosePrice: list([sizeRef(PENNY_100, "Pack of 100")]), wouldBlockListing: list([{ ...sizeRef(PENNY_1000, "Pack of 1000"), reasons: ["no_ebay_category"] }]), tooMuchText: false });
    expect(one?.wouldLosePrice?.text).toBe("1 size would have no price after the move. Give it its own price, then check again.");
    expect(one?.wouldBlockListing?.text).toBe("1 size you list on eBay would stop getting stock updates after the move. Fix it, then check again.");
    const hundred = Array.from({ length: 100 }, (_, index) => sizeRef(200_000 + index, `Size ${index}`));
    const many = blockedLines({ wouldLosePrice: list(hundred, 112), wouldBlockListing: list([]), tooMuchText: false });
    expect(many?.wouldLosePrice).toMatchObject({ text: "112 sizes would have no price after the move. Give each one its own price, then check again.", more: "and 12 more" });
    expect(many?.wouldLosePrice?.sizes).toHaveLength(100);
    expect(blockedLines({ wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: false })).toBeNull();
    expect(blockedLines({ wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: true })).toMatchObject({ wouldLosePrice: null, wouldBlockListing: null, tooMuchText: W.tooMuchText });
  });
});

describe("what the rules become (11.2, 11.4)", () => {
  it("lists categories with their settings, and products by the settings they get, both text parts read as one", () => {
    const becomes = becomesLines({
      categories: list([
        { categoryId: SLEEVES_CATEGORY, categoryName: "Sleeves", settings: ["price", "textAbove", "textBelow"] },
        { categoryId: SLEEVES_CATEGORY + 1, categoryName: "Toploaders", settings: ["ebayCategory", "textBelow"] },
      ]),
      products: list([
        { productId: PENNY, productName: "Penny Sleeves", settings: ["price"] },
        { productId: TEAM_BAGS, productName: "Team Bags", settings: ["price", "ebayCategory", "textAbove", "textBelow"] },
        { productId: TEAM_BAGS + 1, productName: "Toploader 35pt", settings: ["price"] },
      ]),
    });
    expect(becomes).toEqual({
      heading: "They become:",
      categories: { key: "categories", lines: ["Sleeves: price, text above and below", "Toploaders: eBay category, text below"], more: null },
      products: { key: "products", lines: ["2 products get their own price: Penny Sleeves, Toploader 35pt", "1 product gets its own price, eBay category, text above and below: Team Bags"], more: null },
    });
  });

  it("says \"and N more\" beyond the 100 the answer lists, and is null when the move writes nothing", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => ({ categoryId: 8000 + index, categoryName: `Category ${index}`, settings: ["price" as const] }));
    expect(becomesLines({ categories: list(hundred, 104), products: list([], 250) })).toMatchObject({ categories: { more: "and 4 more" }, products: { lines: [], more: "and 250 more" } });
    expect(becomesLines({ categories: list([]), products: list([]) })).toBeNull();
  });
});

describe("why some sizes would change, never applies, kept (11.2, 11.4, D5, D6, D8)", () => {
  const report = {
    ties: list([{ productId: PENNY, productName: "Penny Sleeves", setting: "price" as const }, { productId: TEAM_BAGS, productName: "Team Bags", setting: "description" as const }]),
    nameMismatches: list([
      { productId: PENNY, productName: "Penny Sleeves", listedAs: "Sleeve", categoryName: "Sleeves" },
      { productId: TEAM_BAGS, productName: "Team Bags", listedAs: "Bags", categoryName: null },
      { productId: TEAM_BAGS + 1, productName: "Binder Pages", listedAs: null, categoryName: "Binders" },
    ]),
    unmatched: list([{ ruleName: "Old sleeves", categoryName: "Sleeve", kind: "price" as const }]),
    shared: list([{ ruleName: "Sleeves markup", categoryName: "Sleeves", categoryCount: 2, kind: "price" as const }]),
    someSizesOnly: list([{ ruleName: "Big packs", productId: PENNY, productName: "Penny Sleeves", setting: "ebayCategory" as const }]),
    mixed: list([{ productId: TEAM_BAGS, productName: "Team Bags", setting: "textBelow" as const }]),
    neverApplies: list([{ ruleName: "Holiday", kind: "description" as const }]),
  };

  it("words every list, naming both the rule and the category where the server gives both", () => {
    const lines = reportLines(report, "not_clean");
    expect(lines.reasons?.heading).toBe("Why some sizes would change");
    expect(lines.reasons?.lists.map((entry) => entry.key)).toEqual([...CONVERSION_REASON_LISTS]);
    expect(Object.fromEntries((lines.reasons?.lists ?? []).map((entry) => [entry.key, entry.lines]))).toEqual({
      ties: [
        "Two price rules tie for Penny Sleeves, so they can't price it today.",
        "Two description rules tie for Team Bags, so it has no text above or below today.",
      ],
      nameMismatches: [
        "Card Shellz lists Penny Sleeves as “Sleeve”, but it's in “Sleeves”. Its settings will follow “Sleeves”.",
        "Card Shellz lists Team Bags as “Bags”, but it's in no category. It will use your store defaults.",
        "Your older rules don't see Binder Pages as in “Binders”. After the move it follows “Binders”.",
      ],
      unmatched: ["Your rule “Old sleeves” is for “Sleeve”, but no Card Shellz category has that name. It goes away when you move them over."],
      shared: ["2 Card Shellz categories are called “Sleeves”. Your rule “Sleeves markup” becomes a setting on each of them that doesn't already have its own."],
      someSizesOnly: ["“Big packs” sets the eBay category for only some sizes of Penny Sleeves."],
      mixed: ["Different rules set the text below of Team Bags's sizes."],
    });
    expect(lines.neverApplies).toEqual({ key: "neverApplies", lines: ["Your rule “Holiday” doesn't decide any of your chosen sizes, so it goes away."], more: null });
    for (const line of shownStrings(lines)) expectPlain(line);
  });

  it("never quotes nothing: a blank copy reads as no copy, a blank category name as the page's unnamed category", () => {
    const mismatch = (listedAs: string | null, categoryName: string | null) => reportLines({
      ...EMPTY_REPORT, nameMismatches: list([{ productId: PENNY, productName: "Penny Sleeves", listedAs, categoryName }]),
    }, "not_clean").reasons?.lists[0].lines;
    // Shopify's empty product type, copied as is.
    expect(mismatch("", "Sleeves")).toEqual(["Your older rules don't see Penny Sleeves as in “Sleeves”. After the move it follows “Sleeves”."]);
    expect(mismatch("  ", "Sleeves")).toEqual(mismatch(null, "Sleeves"));
    expect(mismatch("", null)).toEqual(["Penny Sleeves is in no Card Shellz category. It will use your store defaults."]);
    // A category the answer gives no name for reads as the card and the editor call it.
    expect(mismatch("Sleeve", " ")).toEqual(["Card Shellz lists Penny Sleeves as “Sleeve”, but it's in “Category”. Its settings will follow “Category”."]);
    expect(mismatch(null, "")).toEqual(["Your older rules don't see Penny Sleeves as in “Category”. After the move it follows “Category”."]);
    for (const listedAs of ["", " ", null]) {
      for (const categoryName of ["", " ", null, "Sleeves"]) {
        if (listedAs === null && categoryName === null) continue;
        for (const line of mismatch(listedAs, categoryName) ?? []) expect(line, `${listedAs}|${categoryName}`).not.toMatch(/“\s*”/);
      }
    }
  });

  it("says a rule on a shared name becomes a setting only where the category has none of its own (4.A.4)", () => {
    const lines = reportLines({ ...EMPTY_REPORT, shared: list([{ ruleName: "Sleeves markup", categoryName: "Sleeves", categoryCount: 3, kind: "price" }]) }, "clean");
    expect(lines.reasons?.lists[0].lines).toEqual(["3 Card Shellz categories are called “Sleeves”. Your rule “Sleeves markup” becomes a setting on each of them that doesn't already have its own."]);
  });

  it("lists each item once, as the server lists it: a rule in one list only, and nothing for empty lists", () => {
    const lines = reportLines(report, "not_clean");
    const all = [...(lines.reasons?.lists ?? []).flatMap((entry) => entry.lines), ...(lines.neverApplies?.lines ?? [])];
    for (const rule of ["Old sleeves", "Sleeves markup", "Big packs", "Holiday"]) {
      expect(all.filter((line) => line.includes(`“${rule}”`))).toHaveLength(1);
    }
    for (const entry of lines.reasons?.lists ?? []) expect(entry.lines).toHaveLength(report[entry.key as (typeof CONVERSION_REASON_LISTS)[number]].items.length);
    const only = reportLines({ ...EMPTY_REPORT, unmatched: report.unmatched }, "not_clean");
    expect(only.reasons?.lists.map((entry) => entry.key)).toEqual(["unmatched"]);
    expect(only.neverApplies).toBeNull();
    expect(reportLines(EMPTY_REPORT, "not_clean")).toEqual({ reasons: null, neverApplies: null });
  });

  it("drops the heading on a clean sheet, where no size changes, and counts totals over 100 as \"and N more\"", () => {
    const clean = reportLines({ ...EMPTY_REPORT, shared: report.shared }, "clean");
    expect(clean.reasons).toEqual({ heading: null, lists: [{ key: "shared", lines: [expect.stringContaining("“Sleeves markup”")], more: null }] });
    const hundred = Array.from({ length: 100 }, (_, index) => ({ ruleName: `Rule ${index}`, kind: "price" as const }));
    expect(reportLines({ ...EMPTY_REPORT, neverApplies: list(hundred, 112) }, "not_clean").neverApplies?.more).toBe("and 12 more");
    const ties = Array.from({ length: 100 }, (_, index) => ({ productId: 300_000 + index, productName: `Product ${index}`, setting: "price" as const }));
    expect(reportLines({ ...EMPTY_REPORT, ties: list(ties, 1_100) }, "not_clean").reasons?.lists[0]).toMatchObject({ key: "ties", more: "and 1,000 more" });
  });

  it("says what is kept as it is, in the singular for one, and nothing when nothing is", () => {
    expect(keptLine({ exactPrices: 12, catalogPrices: 2, sizePolicies: 3, sizeShelves: 4, sizeTexts: 5 }))
      .toBe("Kept as they are: 12 exact prices, 2 sizes on their retail price, 3 sizes with their own policies, 4 sizes with their own store shelf, 5 sizes with their own main text");
    expect(keptLine({ exactPrices: 1, catalogPrices: 1, sizePolicies: 1, sizeShelves: 1, sizeTexts: 1 }))
      .toBe("Kept as they are: 1 exact price, 1 size on its retail price, 1 size with its own policies, 1 size with its own store shelf, 1 size with its own main text");
    expect(keptLine({ ...NOTHING_KEPT, exactPrices: 1_200 })).toBe("Kept as they are: 1,200 exact prices");
    expect(keptLine(NOTHING_KEPT)).toBeNull();
  });

  it("says products chosen later follow their category or the store, on a clean and a not-clean sheet only", () => {
    expect(laterProductsLine("clean")).toBe("Products you choose later use their category's settings or your store defaults, not these rules.");
    expect(laterProductsLine("not_clean")).toBe(laterProductsLine("clean"));
    expect(laterProductsLine("no_older_rules")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The sheet (5.3, 11.2, 11.5)
// ---------------------------------------------------------------------------

describe("the sheet's states (5.3, 11.2)", () => {
  it("is loading until page 0 answers, with Close and no Move them over", () => {
    for (const pages of [[], [{ data: undefined }], [{ data: undefined, error: null }]]) {
      expect(sheet(pages)).toMatchObject({
        title: "Your older group rules", view: "loading", loadingLine: "Checking what would change…", problem: null, content: null, close: false,
        footer: { lines: [], move: { label: "Move them over", shown: false, disabled: true }, checkAgain: { shown: false }, reload: { shown: false },
          closeLabel: DRAWER_WORDS.close, escapeKeepsOpen: false, press: null },
      });
    }
  });

  it("says a failed check with Try again, 429 in the drawer's words, a cost read failure with Try again in a minute, and closes on too large", () => {
    for (const error of [apiError(500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED"), new TypeError("offline"), apiError(404, "DROPSHIP_STORE_CONNECTION_REQUIRED"),
      apiError(422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY"),
      new ListingSettingsReadError({ code: LISTING_SETTINGS_OFF_CONTRACT, message: "Off.", context: { read: "conversion" } })]) {
      expect(sheet([{ data: undefined, error }])).toMatchObject({ view: "problem", close: false, problem: { kind: "failed", text: "Couldn't check what would change.", retryLabel: "Try again" } });
    }
    expect(sheet([{ data: undefined, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") }])).toMatchObject({
      view: "problem", problem: { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: "Try again" },
    });
    expect(sheet([{ data: undefined, error: apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE", { retryAfterSeconds: 60 }) }])).toMatchObject({
      view: "problem", close: false,
      problem: { kind: "check_unavailable", text: "We couldn't read your costs just now, so we can't check yet. Try again in a minute.", retryLabel: "Try again" },
    });
    // Another 503 (busy) is a failed check, not the cost words.
    expect(sheet([{ data: undefined, error: apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY") }]).problem?.kind).toBe("failed");
    expect(sheet([{ data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") }])).toMatchObject({
      view: "problem", close: true, problem: { kind: "too_large", text: "Choose 10,000 or fewer sizes to move them over.", retryLabel: null },
    });
    // The latest attempt wins: a failed re-read replaces the plan kept beside it.
    expect(sheet([{ data: notCleanPage(0, 3), error: apiError(500, null) }])).toMatchObject({ view: "problem", content: null });
  });

  it("says the store has no older rules any more and asks for the one-time re-read, once per opening (11.5)", () => {
    const none = sheet([answered(NO_OLDER_RULES)]);
    expect(none).toMatchObject({ view: "none", noneLine: "Your store has no older group rules any more.", rereadAfterMoved: true, content: null, resetPages: false });
    expect(sheet([answered(NO_OLDER_RULES)], { ...OLDER_RULES_SHEET_OPENED, movedReread: true }).rereadAfterMoved).toBe(false);
  });

  it("shows a clean move: changes nothing, products chosen later, what the rules become, and no rows, blocks or reasons heading", () => {
    const clean = sheet([answered(check({
      kept: { ...NOTHING_KEPT, exactPrices: 2 },
      report: { ...EMPTY_REPORT, neverApplies: list([{ ruleName: "Holiday", kind: "price" }]) },
    }))]);
    expect(clean).toMatchObject({ view: "report", rereadAfterMoved: false, resetPages: false, changedLine: null });
    expect(clean.content).toEqual({
      state: "clean",
      summary: "Moving them over changes nothing in your listings.",
      laterProducts: "Products you choose later use their category's settings or your store defaults, not these rules.",
      blocked: null,
      becomes: { heading: "They become:", categories: { key: "categories", lines: ["Sleeves: price"], more: null }, products: { key: "products", lines: [], more: null } },
      reasons: null,
      changes: null,
      neverApplies: { key: "neverApplies", lines: ["Your rule “Holiday” doesn't decide any of your chosen sizes, so it goes away."], more: null },
      kept: "Kept as they are: 2 exact prices",
    });
  });

  it("shows a move that is not clean: how many sizes change, the blocks with their actions, the reasons, the rows and Load more", () => {
    const page = notCleanPage(0, 60, PLAN_A, {
      blocked: { wouldLosePrice: list([sizeRef(100_000, "Size 001")]), wouldBlockListing: list([]), tooMuchText: false },
      report: { ...EMPTY_REPORT, ties: list([{ productId: PENNY, productName: "Penny Sleeves", setting: "price" }]) },
    });
    const state = sheet([answered(page)]);
    expect(state.view).toBe("report");
    expect(state.content).toMatchObject({
      state: "not_clean",
      summary: "Moving them over would change 60 sizes. They're listed below.",
      laterProducts: W.laterProducts,
      blocked: { heading: "Before you can move them over", wouldLosePrice: { sizes: [{ action: { kind: "set_price" } }] } },
      reasons: { heading: "Why some sizes would change", lists: [{ key: "ties" }] },
      changes: { heading: "Sizes that would change", total: 60, loadMore: { label: "Load more", shown: true }, more: null },
    });
    expect(state.content?.changes?.rows).toHaveLength(50);
    expect(state.content?.changes?.rows[0]).toEqual({ key: "size:100000", productVariantId: 100_000, head: "Penny Sleeves · Size 001", lines: ["Price: $4.99 → $5.99"] });
    // One size in the singular.
    expect(sheet([answered(notCleanPage(0, 1))]).content?.summary).toBe("Moving them over would change 1 size. It's listed below.");
  });

  it("says a store held back by its text alone changes nothing in its listings, with the block that says why", () => {
    const state = sheet([answered(check({ state: "not_clean", blocked: { wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: true } }))]);
    expect(state.content).toMatchObject({ state: "not_clean", summary: W.clean, changes: null, blocked: { tooMuchText: W.tooMuchText, wouldLosePrice: null } });
  });
});

describe("the sheet's pages: Load more and one plan per screen (11.2, D25; CUX#12)", () => {
  it("joins the pages of one plan in order, says while the next one reads or failed, and offers Load more until the last row", () => {
    const two = sheet([answered(notCleanPage(0, 120)), answered(notCleanPage(1, 120))]);
    expect(two.content?.changes?.rows).toHaveLength(100);
    expect(two.content?.changes?.rows.map((row) => row.productVariantId).slice(48, 52)).toEqual([100_048, 100_049, 100_050, 100_051]);
    expect(two.content?.changes?.loadMore.shown).toBe(true);
    const three = sheet([answered(notCleanPage(0, 120)), answered(notCleanPage(1, 120)), answered(notCleanPage(2, 120))]);
    expect(three.content?.changes).toMatchObject({ total: 120, loadMore: { shown: false }, more: null });
    expect(three.content?.changes?.rows).toHaveLength(120);
    expect(sheet([answered(notCleanPage(0, 100)), answered(notCleanPage(1, 100))]).content?.changes?.loadMore.shown).toBe(false);
    expect(sheet([answered(notCleanPage(0, 50))]).content?.changes?.loadMore.shown).toBe(false);

    const reading = sheet([answered(notCleanPage(0, 120)), { data: undefined }]);
    expect(reading.content?.changes).toMatchObject({ loadMore: { shown: false }, more: { kind: "loading", text: "Checking what would change…" } });
    expect(reading.content?.changes?.rows).toHaveLength(50);
    const limited = sheet([answered(notCleanPage(0, 120)), { data: undefined, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") }]);
    expect(limited.content?.changes).toMatchObject({ loadMore: { shown: false }, more: { kind: "problem", problem: { kind: "rate_limited", retryLabel: "Try again" } } });
    const unavailable = sheet([answered(notCleanPage(0, 120)), { data: undefined, error: apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE") }]);
    expect(unavailable.content?.changes?.more).toMatchObject({ kind: "problem", problem: { kind: "check_unavailable" } });
    // No later page's failure closes the sheet but a too-large one.
    for (const state of [reading, limited, unavailable]) expect(state.close).toBe(false);
  });

  it("closes on a later page refused as too large, as on page 0 (5.3: a 422 closes it), and hands the step that refusal", () => {
    const refusal = apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE");
    const later = [answered(notCleanPage(0, 120)), { data: undefined, error: refusal }];
    expect(sheet(later)).toMatchObject({ view: "report", close: true });
    expect(sheet([answered(notCleanPage(0, 120)), answered(notCleanPage(1, 120)), { data: undefined, error: refusal }]).close).toBe(true);
    expect(conversionTooLargeError(later)).toBe(refusal);
    expect(conversionTooLargeError([{ data: undefined, error: refusal }])).toBe(refusal);
    // None refused as too large: nothing for the banner.
    expect(conversionTooLargeError([answered(notCleanPage(0, 120)), { data: undefined, error: apiError(500, null) }])).toBeUndefined();
    expect(conversionTooLargeError([{ data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY") }])).toBeUndefined();
    expect(conversionTooLargeError([])).toBeUndefined();
  });

  it("drops the pages of another plan, shows only page 0's rows, asks for page 0 again and says something changed", () => {
    const moved = sheet([answered(notCleanPage(0, 120, PLAN_A)), answered(notCleanPage(1, 120, PLAN_B))]);
    expect(moved).toMatchObject({ view: "report", resetPages: true, changedLine: "Something changed since you opened this. Check the list again." });
    expect(moved.content?.changes?.rows).toHaveLength(50);
    expect(moved.content?.changes).toMatchObject({ loadMore: { shown: false }, more: null });
    // A later page that finds the store already moved is another plan too.
    expect(sheet([answered(notCleanPage(0, 120)), answered(notCleanPage(0, 120)), { data: { ...NO_OLDER_RULES, changes: { ...NO_OLDER_RULES.changes, page: 2 } }, error: null }]).resetPages).toBe(true);
    // After the reset (the session back on page 0), the line stays until the sheet closes; page 0's new plan is shown.
    const after = olderRulesSheetSession(olderRulesSheetSession(OLDER_RULES_SHEET_OPENED, { type: "load_more" }), { type: "plan_changed" });
    const reread = sheet([answered(notCleanPage(0, 120, PLAN_B))], after);
    expect(reread).toMatchObject({ resetPages: false, changedLine: W.changed });
    expect(reread.content?.changes?.loadMore.shown).toBe(true);
    // A page still reading or failed never resets.
    expect(sheet([answered(notCleanPage(0, 120)), { data: undefined, error: apiError(500, null) }]).resetPages).toBe(false);
  });

  it("shows a size once when a rename moved it onto the next page", () => {
    const first = notCleanPage(0, 60);
    const second = check({ state: "not_clean", changes: { page: 1, pageSize: 50, total: 60, rows: [first.changes.rows[49], ...priceRows(9, 100_050)] } });
    expect(sheet([answered(first), answered(second)]).content?.changes?.rows.map((row) => row.productVariantId)).toEqual(
      [...first.changes.rows.map((row) => row.productVariantId), ...Array.from({ length: 9 }, (_, index) => 100_050 + index)],
    );
  });

  it("keeps its session: page 0 on opening, one more page per Load more up to page 199, back to page 0 on another plan", () => {
    expect(OLDER_RULES_SHEET_OPENED).toEqual({ pageCount: 1, planChanged: false, movedReread: false });
    expect(olderRulesSheetPages(OLDER_RULES_SHEET_OPENED)).toEqual([0]);
    const more = olderRulesSheetSession(olderRulesSheetSession(OLDER_RULES_SHEET_OPENED, { type: "load_more" }), { type: "load_more" });
    expect(more).toEqual({ pageCount: 3, planChanged: false, movedReread: false });
    expect(olderRulesSheetPages(more)).toEqual([0, 1, 2]);
    let last: OlderRulesSheetSession = { ...OLDER_RULES_SHEET_OPENED, pageCount: 199 };
    for (let index = 0; index < 3; index += 1) last = olderRulesSheetSession(last, { type: "load_more" });
    expect(last.pageCount).toBe(200);
    expect(olderRulesSheetPages(last).at(-1)).toBe(199);
    expect(olderRulesSheetPages({ pageCount: 0 })).toEqual([0]);
    expect(olderRulesSheetSession(more, { type: "plan_changed" })).toEqual({ pageCount: 1, planChanged: true, movedReread: false });
    expect(olderRulesSheetSession(more, { type: "moved_reread" })).toEqual({ pageCount: 3, planChanged: false, movedReread: true });
    // A new object each time, never the shared start object, so a caller's change can't move it.
    expect(olderRulesSheetSession(OLDER_RULES_SHEET_OPENED, { type: "moved_reread" })).not.toBe(OLDER_RULES_SHEET_OPENED);
    expect(Object.isFrozen(OLDER_RULES_SHEET_OPENED)).toBe(true);
    // The last page the dry run has: no Load more past page 199 whatever the total says.
    const pages = Array.from({ length: 200 }, (_, page) => answered(notCleanPage(page, 10_000)));
    expect(sheet(pages, { ...OLDER_RULES_SHEET_OPENED, pageCount: 200 }).content?.changes).toMatchObject({ total: 10_000, loadMore: { shown: false } });
  });

  it("has the step's conflict hook read exactly the summary and the notice again (8.2, 11e1, D25)", () => {
    expect(conflictRereadKeys(STORE)).toEqual([
      [...listingSettingsQueryKey(STORE), "summary"],
      [...listingSettingsQueryKey(STORE), "conversion-notice"],
    ]);
  });

  it("re-reads exactly the summary, the categories, the notice and the three profiles once the store is found moved, never the check itself (11.5)", () => {
    const keys = olderRulesGoneRereadKeys(STORE);
    expect(keys).toEqual([
      [...listingSettingsQueryKey(STORE), "summary"],
      [...listingSettingsQueryKey(STORE), "categories"],
      // 11e1: the one-time notice, so the sheet says what the job moved, with [Got it].
      [...listingSettingsQueryKey(STORE), "conversion-notice"],
      ["/api/dropship/listings/stores/22/pricing-rules"],
      ["/api/dropship/listings/stores/22/ebay-category-rules"],
      ["/api/dropship/listings/stores/22/content-profile"],
    ]);
    for (const key of keys) expect(key).not.toContain("conversion");
  });
});

// ---------------------------------------------------------------------------
// [Move them over]: the footer, every 8.3 row (PR 11d, plan 8.3, 11.2; D1, D9; CUX#11)
// ---------------------------------------------------------------------------

const SHOWN = Object.freeze({ planHash: PLAN_A, writesHash: WRITES });
const KEY = "ls-convert:first";

/** The step's draft for a move of page 0's plan, sent with KEY and then answered `failure` (or still out). */
function moveDraft(answer: WriteFailure | "saving" | "saved" = "saving"): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: CONVERSION_EDITOR_ID, place: W.sheetTitle, base: SHOWN });
  const sent = reduceListingSettingsDraft(opened, { type: "startSave", attempt: { signature: "plan A", key: KEY } });
  if (answer === "saving") return sent!;
  if (answer === "saved") return reduceListingSettingsDraft(sent, { type: "saved", key: KEY, nowMs: 1 })!;
  return reduceListingSettingsDraft(sent, { type: "failure", key: KEY, failure: answer })!;
}

/** The move answered `error`, classified as the runner classifies it (W11). */
function refusedMove(error: unknown): ListingSettingsDraft {
  return moveDraft(classifyWriteFailure("W11", error));
}

/** The refusals of 8.3, as the server answers them (and a dropped connection, last). */
const MOVE_REFUSALS: readonly DropshipApiError[] = [
  apiError(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "settings_changed" }),
  apiError(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "listed_changes_moved" }),
  apiError(422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizeCount: 1 }),
  apiError(422, "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING", { sizeCount: 1 }),
  apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit" }),
  apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE"),
  apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE"),
  apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT"),
  apiError(500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED"),
  apiError(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "catalog_changed" }),
  apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"),
  apiError(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" }),
];
const DROPPED = new TypeError("Failed to fetch");

const footerOf = (state: OlderRulesSheetState) => state.footer;
const linesOf = (state: OlderRulesSheetState) => state.footer.lines.map((line) => line.text);
const blockedSizes = { wouldLosePrice: list([sizeRef(PENNY_100, "Pack of 100")]), wouldBlockListing: list([]), tooMuchText: false };

describe("the one-time notice in the sheet (11e1, plan 9.2, D19, D25)", () => {
  const NOTICE: OlderRulesSheetNotice = { model: { conversionId: 41,
    text: "We moved your older group rules. 1 category now has its own settings. Nothing in your listings changed.",
    gotIt: { label: "Got it", ariaLabel: "Got it, hide this note" }, failure: null }, sending: false };
  const withNotice = (pages: OlderRulesSheetInput["pages"], outcome: OlderRulesSheetOutcome | null, notice: OlderRulesSheetNotice | null = NOTICE,
    apply: Partial<OlderRulesApplyFacts> = {}) =>
    olderRulesSheetState(deepFreeze({ pages, session: OLDER_RULES_SHEET_OPENED, outcome, apply: { ...IDLE, ...apply }, notice }));

  it("says what the job moved instead of 'no older group rules any more', with [Got it] beside Close, when the sheet finds the store moved", () => {
    const state = withNotice([answered(NO_OLDER_RULES)], null);
    expect(state).toMatchObject({ view: "none", noneLine: NOTICE.model.text, rereadAfterMoved: true });
    expect(state.footer).toMatchObject({ lines: [], move: { shown: false }, gotIt: { label: "Got it", ariaLabel: "Got it, hide this note", shown: true,
      disabled: false }, press: null });
    // With [Got it] out, the button waits; seen (no notice), the plain words and no [Got it] again.
    expect(withNotice([answered(NO_OLDER_RULES)], null, { ...NOTICE, sending: true }).footer.gotIt).toMatchObject({ shown: true, disabled: true });
    expect(withNotice([answered(NO_OLDER_RULES)], null, null)).toMatchObject({ noneLine: W.none, footer: { gotIt: { shown: false } } });
  });

  it("says what the job moved after nothing_to_convert, whatever page 0 answers after it, and keeps a failed Got it's words", () => {
    const already = { kind: "already_moved", viewStale: false } as const;
    for (const pages of [[answered(NO_OLDER_RULES)], [answered(check())], [{ data: undefined }]]) {
      const state = withNotice(pages, already);
      expect(state.footer.lines).toEqual([{ text: NOTICE.model.text, tone: "ok" }]);
      expect(state.footer.gotIt).toMatchObject({ shown: true, disabled: false });
    }
    const failed = withNotice([answered(NO_OLDER_RULES)], already, { ...NOTICE, model: { ...NOTICE.model, failure: W.noticeFailed } });
    expect(failed.footer.lines).toEqual([{ text: NOTICE.model.text, tone: "ok" }, { text: "Couldn't save that. Try again.", tone: "alert" }]);
    // Seen: "Your rules have already been moved over." again.
    expect(withNotice([answered(NO_OLDER_RULES)], already, null).footer.lines).toEqual([{ text: W.alreadyMoved, tone: "ok" }]);
  });

  it("never shows it beside the vendor's own move, nor over a report (older rules are there), nor while page 0 loads or failed", () => {
    const moved = withNotice([answered(NO_OLDER_RULES)], { kind: "moved", viewStale: false });
    expect(moved.footer).toMatchObject({ lines: [{ text: W.moved, tone: "ok" }], gotIt: { shown: false } });
    for (const pages of [[answered(check())], [{ data: undefined }], [{ data: undefined, error: new TypeError("offline") }]]) {
      const state = withNotice(pages, null);
      expect(state.footer.gotIt.shown).toBe(false);
      expect(shownStrings(state)).not.toContain(NOTICE.model.text);
    }
  });

  it("keeps the notice's words plain", () => {
    for (const text of shownStrings(withNotice([answered(NO_OLDER_RULES)], null))) expectPlain(text);
  });
});

describe("[Move them over]: the footer (8.3)", () => {
  it("clean: [Move them over] on, nothing else said, and it sends page 0's two hashes as shown (D1)", () => {
    const footer = footerOf(sheet([answered(check())]));
    expect(footer).toEqual({
      lines: [], move: { label: "Move them over", shown: true, disabled: false },
      gotIt: { label: "Got it", ariaLabel: "Got it, hide this note", shown: false, disabled: true },
      checkAgain: { label: "Check again", shown: false, disabled: false }, reload: { label: "Reload", shown: false },
      closeLabel: DRAWER_WORDS.close, escapeKeepsOpen: false, press: SHOWN,
    });
  });

  it("not clean, nothing blocked: the footer counts the sizes that change, and the button is on (8.3 changesListed)", () => {
    const state = sheet([answered(notCleanPage(0, 60))]);
    expect(state.footer).toMatchObject({ lines: [{ text: "These 60 sizes change as listed.", tone: "info" }], move: { shown: true, disabled: false }, press: SHOWN });
    expect(linesOf(sheet([answered(notCleanPage(0, 1))]))).toEqual(["This size changes as listed."]);
  });

  it("a size would lose its price, or a listed size would stop updating: the button is off and the section above names them (D9a, D9b)", () => {
    for (const blocked of [
      blockedSizes,
      { wouldLosePrice: list([]), wouldBlockListing: list([{ ...sizeRef(PENNY_100, "Pack of 100"), reasons: ["no_ebay_category" as const] }]), tooMuchText: false },
      { ...blockedSizes, tooMuchText: true },
    ]) {
      const state = sheet([answered(notCleanPage(0, 3, PLAN_A, { blocked }))]);
      expect(state.content?.blocked).not.toBeNull();
      expect(state.footer).toMatchObject({ lines: [{ text: "Fix the sizes listed above first.", tone: "alert" }], move: { shown: true, disabled: true }, press: null });
    }
  });

  it("too much text alone: the button is off with the text cap's words (D9c)", () => {
    const state = sheet([answered(check({ state: "not_clean", blocked: { wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: true } }))]);
    expect(state.footer).toMatchObject({ lines: [{ text: W.tooMuchText, tone: "alert" }], move: { shown: true, disabled: true }, press: null });
  });

  it("no right: off with the right's own line, or none when the banner says why (PLAN10 D3)", () => {
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { right: { editable: false, reason: "loading" } }).footer)
      .toMatchObject({ lines: [{ text: "Checking…", tone: "alert" }], move: { shown: true, disabled: true }, press: null });
    // Paused account, .ops inactive or store blocked: the banner explains.
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { right: { editable: false, reason: "banner" } }).footer)
      .toMatchObject({ lines: [], move: { shown: true, disabled: true }, press: null });
  });

  it("saving: Moving them over…, locked, Esc keeps the sheet; another action or a page 0 read in flight keeps the button off too", () => {
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft: moveDraft("saving"), busy: true }).footer).toMatchObject({
      lines: [{ text: "Moving them over…", tone: "info" }], move: { shown: true, disabled: true }, checkAgain: { shown: false }, escapeKeepsOpen: true, press: null,
    });
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { busy: true }).footer).toMatchObject({ move: { disabled: true }, press: null });
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { checking: true }).footer).toMatchObject({ move: { disabled: true }, press: null });
    // Why a press didn't start (another listing action runs), said under the rest.
    expect(linesOf(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { notStartedLine: DRAWER_WORDS.busy }))).toEqual([DRAWER_WORDS.busy]);
  });

  it("converted or replayed: Moved over., [Close] only, and it stays until the sheet closes, even after page 0 answers no older rules (CUX#11)", () => {
    const moved = conversionOutcomeOf({ outcome: "converted" }, false);
    expect(moved).toEqual({ kind: "moved", viewStale: false });
    expect(conversionOutcomeOf({ outcome: "replayed" }, false)).toEqual(moved);
    // An answer off the contract was a 2xx all the same: moved, with a stale view.
    expect(conversionOutcomeOf(null, true)).toEqual({ kind: "moved", viewStale: true });
    for (const pages of [[answered(check())], [answered(NO_OLDER_RULES)], [{ data: undefined }], [{ data: undefined, error: apiError(500, null) }]]) {
      const state = sheet(pages, OLDER_RULES_SHEET_OPENED, moved);
      expect(state.footer).toMatchObject({
        lines: [{ text: "Moved over. Category settings can be saved now.", tone: "ok" }], move: { shown: false }, checkAgain: { shown: false },
        reload: { shown: false }, escapeKeepsOpen: false, press: null,
      });
      // The prefix re-read finding the store moved is the move's own doing: no one-time re-read (11.5), nothing closes.
      expect(state.rereadAfterMoved).toBe(false);
      expect(state.close).toBe(false);
    }
    expect(sheet([{ data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") }], OLDER_RULES_SHEET_OPENED, moved).close).toBe(false);
    // A stale view says so, with [Reload].
    expect(sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, { kind: "moved", viewStale: true }).footer).toMatchObject({
      lines: [{ text: W.moved, tone: "ok" }, { text: "We couldn't load the latest view.", tone: "alert" }], reload: { label: "Reload", shown: true },
    });
  });

  it("nothing_to_convert: Your rules have already been moved over., [Close] (8.3)", () => {
    const already = conversionOutcomeOf({ outcome: "nothing_to_convert" }, false);
    expect(already).toEqual({ kind: "already_moved", viewStale: false });
    expect(sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, already).footer)
      .toMatchObject({ lines: [{ text: "Your rules have already been moved over.", tone: "ok" }], move: { shown: false }, press: null });
  });

  it("while a confirmed move settles, page 0 finding no older rules asks for no re-read and a page refused as too large closes nothing", () => {
    for (const draft of [moveDraft("saving"), moveDraft("saved")]) {
      expect(sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, null, { draft }).rereadAfterMoved).toBe(false);
      expect(sheet([{ data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") }], OLDER_RULES_SHEET_OPENED, null, { draft }).close).toBe(false);
      // Its own re-reads answer page by page: no reset and no "changed" line under it.
      const mixed = sheet([answered(notCleanPage(0, 120, PLAN_A)), answered(notCleanPage(1, 120, PLAN_B))], OLDER_RULES_SHEET_OPENED, null, { draft });
      expect(mixed).toMatchObject({ resetPages: false, changedLine: null });
      expect(mixed.content?.changes?.rows).toHaveLength(50);
    }
    // A just-confirmed move's draft says nothing in the footer (its outcome shows), and a reopened sheet starts clean.
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft: moveDraft("saved") }).footer).toMatchObject({ lines: [], move: { shown: true } });
  });

  it("a settled move's draft left closed from an earlier opening is not settling: a later opening reacts to its pages again", () => {
    // Confirmed with failed re-reads (saved_view_stale), then the sheet closed: the draft stays, closed, past any tick.
    const settled = reduceListingSettingsDraft(moveDraft("saving"), { type: "saved", key: KEY, nowMs: 1, viewStale: true });
    const closed = reduceListingSettingsDraft(reduceListingSettingsDraft(settled, { type: "close" }), { type: "tick", nowMs: 10_000_000 });
    expect(closed).toMatchObject({ phase: "saved_view_stale", open: false });
    // Open (this opening's own move settling), it still keeps the sheet quiet.
    expect(sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, null, { draft: settled }).rereadAfterMoved).toBe(false);

    // Closed: page 0 finding the store moved elsewhere asks for the one-time re-read (11.5), and a too-large page closes the sheet.
    expect(sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, null, { draft: closed }).rereadAfterMoved).toBe(true);
    expect(sheet([{ data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") }], OLDER_RULES_SHEET_OPENED, null,
      { draft: closed }).close).toBe(true);
    // A later page of another plan resets the pages and says so (CUX#12), as with no draft at all.
    const mixed = [answered(notCleanPage(0, 120, PLAN_A)), answered(notCleanPage(1, 120, PLAN_B))];
    const later = sheet(mixed, OLDER_RULES_SHEET_OPENED, null, { draft: closed });
    expect(later).toMatchObject({ resetPages: true, changedLine: W.changed });
    expect(later.footer.move.disabled).toBe(true);
    expect({ ...later, footer: { ...later.footer } }).toEqual(sheet(mixed, OLDER_RULES_SHEET_OPENED, null, { draft: null }));
  });

  it("an unconfirmed move closed by Back, then Check again in the reopened sheet: the draft is opened, and the sheet stays quiet while it settles", () => {
    // A first send that never committed (a 5xx with no code is a gateway's: uncertain), then Back: the draft is kept, closed (D21).
    const uncertain = moveDraft(classifyWriteFailure("W11", apiError(504, null)));
    const closed = reduceListingSettingsDraft(uncertain, { type: "close" })!;
    expect(closed).toMatchObject({ phase: "uncertain", open: false, attempt: { key: KEY } });
    const mixed = [answered(notCleanPage(0, 120, PLAN_A)), answered(notCleanPage(1, 120, PLAN_B))];
    const tooLarge = [{ data: undefined, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") }];

    // [Check again] (OlderRulesSheet's checkAgain): open (a locked draft of the same editor is kept, now open), then the
    // start with the same key, as the runner's startSave makes it; then the confirmation.
    const reopened = reduceListingSettingsDraft(closed, { type: "open", editor: CONVERSION_EDITOR_ID, place: W.sheetTitle, base: closed.value })!;
    expect(reopened).toMatchObject({ phase: "uncertain", open: true, attempt: closed.attempt, value: closed.value });
    const started = reduceListingSettingsDraft(reopened, { type: "startSave", attempt: closed.attempt! })!;
    expect(started).toMatchObject({ phase: "saving", open: true, attempt: { key: KEY } });
    const confirmed = reduceListingSettingsDraft(started, { type: "saved", key: KEY, nowMs: 2 })!;
    for (const draft of [started, confirmed]) {
      // Page 0 then finds no older rules: the move's own doing, so no one-time re-read (11.5) under it.
      expect(sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, null, { draft }).rereadAfterMoved).toBe(false);
      // A re-read refused as too large doesn't close the sheet before the vendor sees the outcome.
      expect(sheet(tooLarge, OLDER_RULES_SHEET_OPENED, null, { draft }).close).toBe(false);
      // Its own re-reads answer page by page: no reset, and no "changed" line beside the move.
      expect(sheet(mixed, OLDER_RULES_SHEET_OPENED, null, { draft })).toMatchObject({ resetPages: false, changedLine: null });
    }

    // Why the sheet opens it: the lib counts only an open draft as this opening's move (MC1), so a start on the draft left
    // closed would have the sheet react to the move's own re-reads.
    const startedClosed = reduceListingSettingsDraft(closed, { type: "startSave", attempt: closed.attempt! })!;
    expect(startedClosed).toMatchObject({ phase: "saving", open: false });
    expect(sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, null, { draft: startedClosed }).rereadAfterMoved).toBe(true);
  });

  it("409 CHANGED: the reason's words; the button comes back with the new hashes once page 0 is read again, and waits while it is", () => {
    for (const [reason, words] of [["settings_changed", W.changed], ["listed_changes_moved", W.listedChangesMoved]] as const) {
      const draft = refusedMove(apiError(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason }));
      expect(draft).toMatchObject({ phase: "conflict", attempt: null });
      // Page 0 read again: the new plan's hashes, the words of the refusal above what the page says.
      const reread = check({ planHash: PLAN_B });
      expect(sheet([answered(reread)], OLDER_RULES_SHEET_OPENED, null, { draft }).footer).toMatchObject({
        lines: [{ text: words, tone: "alert" }], move: { shown: true, disabled: false }, press: { planHash: PLAN_B, writesHash: WRITES },
      });
      expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft, checking: true }).footer).toMatchObject({ move: { disabled: true }, press: null });
    }
  });

  it("422 blocks: the changed words, and page 0 read again shows the matching section with the button off (8.3)", () => {
    for (const error of MOVE_REFUSALS.slice(2, 5)) {
      const draft = refusedMove(error);
      const page = notCleanPage(0, 3, PLAN_B, { blocked: error.code === "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" ? { ...blockedSizes, wouldLosePrice: list([]), tooMuchText: true } : blockedSizes });
      const state = sheet([answered(page)], OLDER_RULES_SHEET_OPENED, null, { draft });
      expect(state.footer.lines[0]).toEqual({ text: W.changed, tone: "alert" });
      expect(state.footer.lines[1].text).toBe(error.code === "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" ? W.tooMuchText : "Fix the sizes listed above first.");
      expect(state.footer).toMatchObject({ move: { disabled: true }, press: null });
    }
  });

  it("422 TOO_LARGE store_text_limit is a block, not final: page 0 read again without it, with new hashes, turns the button on (D9c)", () => {
    const draft = refusedMove(MOVE_REFUSALS[4]);
    expect(draft).toMatchObject({ phase: "refused", code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: W.changed, attempt: null });
    const reread = check({ planHash: PLAN_B });
    expect(sheet([answered(reread)], OLDER_RULES_SHEET_OPENED, null, { draft }).footer).toMatchObject({
      lines: [{ text: W.changed, tone: "alert" }], move: { shown: true, disabled: false }, press: { planHash: PLAN_B, writesHash: WRITES },
    });
    // As WOULD_BE_LOST does in the same case.
    expect(sheet([answered(reread)], OLDER_RULES_SHEET_OPENED, null, { draft: refusedMove(MOVE_REFUSALS[2]) }).footer)
      .toMatchObject({ move: { disabled: false }, press: { planHash: PLAN_B, writesHash: WRITES } });
  });

  it("422 TOO_LARGE with no reason and a fatal 500: refused for good in this sheet, the button stays off (no Try again loop)", () => {
    for (const [error, words] of [[MOVE_REFUSALS[5], W.tooLargeApply], [MOVE_REFUSALS[8], LISTING_SETTINGS_EDIT_WORDS.fatal]] as const) {
      expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft: refusedMove(error) }).footer).toMatchObject({
        lines: [{ text: words, tone: "alert" }], move: { shown: true, disabled: true }, checkAgain: { shown: false }, press: null,
      });
    }
  });

  it("503 CHECK_UNAVAILABLE, BUSY catalog_changed and 429: nothing was moved; the button is on with the same plan (its key is kept)", () => {
    for (const [error, words] of [[MOVE_REFUSALS[6], W.checkUnavailableApply], [MOVE_REFUSALS[9], W.busyCatalogChanged], [MOVE_REFUSALS[10], LISTING_SETTINGS_SAVE_WORDS.rateLimited]] as const) {
      const draft = refusedMove(error);
      expect(draft.attempt?.key).toBe(KEY);
      expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft }).footer).toMatchObject({
        lines: [{ text: words, tone: "alert" }], move: { shown: true, disabled: false }, checkAgain: { shown: false }, press: SHOWN,
      });
    }
  });

  it("409 IDEMPOTENCY_CONFLICT: its words; page 0 read again, and the button on (the next press gets a new key)", () => {
    const draft = refusedMove(MOVE_REFUSALS[7]);
    expect(draft).toMatchObject({ phase: "refused", attempt: null });
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft }).footer)
      .toMatchObject({ lines: [{ text: W.idempotencyConflict, tone: "alert" }], move: { disabled: false }, press: SHOWN });
  });

  it("uncertain: We couldn't confirm the move., [Check again] instead of the button, locked, wherever page 0 stands (PLAN10 3.3 row 9, D21)", () => {
    const draft = refusedMove(DROPPED);
    expect(draft.phase).toBe("uncertain");
    for (const pages of [[answered(check())], [answered(notCleanPage(0, 60))], [answered(NO_OLDER_RULES)], [{ data: undefined }], [{ data: undefined, error: apiError(500, null) }]]) {
      expect(sheet(pages, OLDER_RULES_SHEET_OPENED, null, { draft }).footer).toMatchObject({
        lines: [{ text: "We couldn't confirm the move.", tone: "alert" }], move: { shown: false, disabled: true },
        checkAgain: { label: "Check again", shown: true, disabled: false }, escapeKeepsOpen: true, press: null,
      });
    }
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft, busy: true }).footer.checkAgain).toMatchObject({ shown: true, disabled: true });
  });

  it("a block goes to the banner: Nothing was saved., and the button is on again once the right is", () => {
    const draft = refusedMove(MOVE_REFUSALS[11]);
    expect(draft.phase).toBe("blocked");
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft, right: { editable: false, reason: "banner" } }).footer)
      .toMatchObject({ lines: [{ text: "Nothing was saved.", tone: "alert" }], move: { disabled: true } });
  });

  it("another editor's draft is not the sheet's: its words never show here, only the page's counter keeps the button off", () => {
    const other = reduceListingSettingsDraft(null, { type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } });
    const failed = reduceListingSettingsDraft(reduceListingSettingsDraft(other, { type: "startSave", attempt: { signature: "x", key: "ls-product:1" } }),
      { type: "failure", key: "ls-product:1", failure: { phase: "refused", message: "Product words.", code: "X", status: 422 } });
    expect(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft: failed }).footer).toMatchObject({ lines: [], move: { disabled: false }, press: SHOWN });
  });

  it("one plan per screen: while a later page of another plan is on screen, the button waits for page 0 again (CUX#12)", () => {
    expect(sheet([answered(notCleanPage(0, 120, PLAN_A)), answered(notCleanPage(1, 120, PLAN_B))]).footer).toMatchObject({ move: { disabled: true }, press: null });
  });

  it("goes back to page 0 alone after a refusal that says the plan moved, keeping the changed line as it was (8.3)", () => {
    const more = olderRulesSheetSession(olderRulesSheetSession(OLDER_RULES_SHEET_OPENED, { type: "load_more" }), { type: "load_more" });
    expect(olderRulesSheetSession(more, { type: "check_again" })).toEqual({ pageCount: 1, planChanged: false, movedReread: false });
    expect(olderRulesSheetSession({ ...more, planChanged: true }, { type: "check_again" })).toEqual({ pageCount: 1, planChanged: true, movedReread: false });
  });

  it("never names an id or a code, whatever the answer", () => {
    for (const error of [...MOVE_REFUSALS, DROPPED]) {
      for (const text of linesOf(sheet([answered(check())], OLDER_RULES_SHEET_OPENED, null, { draft: refusedMove(error) }))) expectPlain(text);
    }
  });
});

// ---------------------------------------------------------------------------
// Every word, and the inputs left alone (owner rule, C10; CLAUDE.md §4)
// ---------------------------------------------------------------------------

describe("the words (11.4)", () => {
  it("keeps the plan's words, each one plain, none with an id or a code", () => {
    expect(LISTING_SETTINGS_CONVERSION_WORDS).toMatchObject({
      line: "Your store still has older group rules. Move them over to use category settings.",
      lineNoCategories: "Your store still has older group rules.",
      lineTooLarge: "Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.",
      seeWhatChanges: "See what changes",
      sheetTitle: "Your older group rules",
      loading: "Checking what would change…",
      failed: "Couldn't check what would change.",
      checkUnavailable: "We couldn't read your costs just now, so we can't check yet. Try again in a minute.",
      none: "Your store has no older group rules any more.",
      clean: "Moving them over changes nothing in your listings.",
      laterProducts: "Products you choose later use their category's settings or your store defaults, not these rules.",
      blockedHeading: "Before you can move them over",
      setPrice: "Set a price",
      fix: "Fix",
      tooMuchText: "Moving these rules would save more text than your store can keep. Shorten your older description rules in Older settings, then check again.",
      becomesHeading: "They become:",
      reasonsHeading: "Why some sizes would change",
      changesHeading: "Sizes that would change",
      changed: "Something changed since you opened this. Check the list again.",
      // 11d (8.3, 11.4).
      moveOver: "Move them over",
      moving: "Moving them over…",
      moved: "Moved over. Category settings can be saved now.",
      alreadyMoved: "Your rules have already been moved over.",
      listedChangesMoved: "Some changes in the list are different now, for example because a cost changed. Check the list again.",
      idempotencyConflict: "Something changed since you last tried. Check the list again.",
      checkUnavailableApply: "We couldn't read your costs just now. Nothing was moved. Try again in a minute.",
      tooLargeApply: "Choose 10,000 or fewer sizes to move them over.",
      uncertain: "We couldn't confirm the move.",
    });
    expect(conversionChangesListedWords(12)).toBe("These 12 sizes change as listed.");
    expect(conversionChangesListedWords(1_234)).toBe("These 1,234 sizes change as listed.");
    expect(conversionChangesListedWords(1)).toBe("This size changes as listed.");
    for (const text of Object.values(LISTING_SETTINGS_CONVERSION_WORDS)) expectPlain(text);
    // The read-only preview's footer is gone (11d), and no word says the rules are deleted or removed.
    expect(Object.values(LISTING_SETTINGS_CONVERSION_WORDS)).not.toContain("This is a preview. Nothing is moved yet.");
    for (const text of Object.values(LISTING_SETTINGS_CONVERSION_WORDS)) expect(text).not.toMatch(/delete/i);
    // A cost read failure on the move never reads "couldn't confirm" (CUX#4); nothing promised moved says "saved".
    expect(W.checkUnavailableApply).not.toMatch(/confirm/i);
  });

  it("shows only plain words in every model the line and the sheet build", () => {
    const busy = check({
      state: "not_clean",
      kept: { exactPrices: 2, catalogPrices: 1, sizePolicies: 1, sizeShelves: 1, sizeTexts: 1 },
      blocked: {
        wouldLosePrice: list([sizeRef(PENNY_100, "Pack of 100")]),
        wouldBlockListing: list([{ ...sizeRef(PENNY_1000, "Pack of 1000", null), reasons: [...CONVERSION_BLOCKER_CODES] }]),
        tooMuchText: true,
      },
      becomes: {
        categories: list([{ categoryId: SLEEVES_CATEGORY, categoryName: "Sleeves", settings: ["price", "ebayCategory", "textAbove", "textBelow"] }]),
        products: list([{ productId: TEAM_BAGS, productName: "Team Bags", settings: ["textAbove"] }]),
      },
      report: {
        unmatched: list([{ ruleName: "Old sleeves", categoryName: "Sleeve", kind: "ebayCategory" }]),
        shared: list([{ ruleName: "Sleeves markup", categoryName: "Sleeves", categoryCount: 3, kind: "description" }]),
        nameMismatches: list([{ productId: PENNY, productName: "Penny Sleeves", listedAs: "Sleeve", categoryName: "Sleeves" }]),
        neverApplies: list([{ ruleName: "Holiday", kind: "price" }]),
        ties: list([{ productId: TEAM_BAGS, productName: "Team Bags", setting: "description" }]),
        someSizesOnly: list([{ ruleName: "Big packs", productId: PENNY, productName: "Penny Sleeves", setting: "textBelow" }]),
        mixed: list([{ productId: PENNY, productName: "Penny Sleeves", setting: "price" }]),
      },
      changes: { page: 0, pageSize: 50, total: 2, rows: [
        changeRow([...CONVERSION_CHANGED_FIELDS], sizeView(), sizeView({
          price: PRICE_SAMPLES[15].price, pricingRule: null, ebayCategory: { id: EBAY_TOPLOADERS, name: "Card Sleeves" }, shelfNames: ["Supplies:Sleeves"],
          policies: { shipping: null, return: "R2", payment: null }, descriptionHash: DESC_2, blockers: ["no_ebay_category"],
        })),
        changeRow(["listable"], sizeView({ blockers: ["own_text_needs_check"] }), sizeView({ blockers: [] }), { productVariantId: PENNY_1000, sizeName: "Pack of 1000" }),
      ] },
    });
    const models: unknown[] = [
      sheet([answered(busy)]),
      sheet([answered(check())]),
      sheet([answered(NO_OLDER_RULES)]),
      sheet([answered(notCleanPage(0, 120, PLAN_A)), answered(notCleanPage(1, 120, PLAN_B))]),
      sheet([]),
      ...[apiError(500, null), apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"), apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE"),
        apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE")].map((error) => sheet([{ data: undefined, error }])),
      olderRulesLineModel(summary({ price: 1 }), categoriesListed),
      olderRulesLineModel(summary({ price: 1 }), categoriesNone),
      olderRulesLineModel(summary({ price: 1 }, "too_large"), categoriesListed),
      olderRulesOpener(summary({ price: 1 })),
      // 11d's footers: every outcome, failure and stop (8.3).
      sheet([answered(check())], OLDER_RULES_SHEET_OPENED, { kind: "moved", viewStale: true }),
      sheet([answered(NO_OLDER_RULES)], OLDER_RULES_SHEET_OPENED, { kind: "already_moved", viewStale: false }),
      sheet([answered(notCleanPage(0, 12))], OLDER_RULES_SHEET_OPENED, null, { right: { editable: false, reason: "loading" }, notStartedLine: DRAWER_WORDS.busy }),
      ...MOVE_REFUSALS.map((error) => sheet([answered(busy)], OLDER_RULES_SHEET_OPENED, null, { draft: refusedMove(error) })),
    ];
    const strings = models.flatMap((model) => shownStrings(model));
    expect(strings.length).toBeGreaterThan(60);
    for (const text of strings) expectPlain(text);
  });
});

describe("the inputs are left alone (CLAUDE.md §4)", () => {
  it("never mutates a page, a row, a list or the summary (every input is frozen: a write would throw)", () => {
    const pages = deepFreeze([answered(notCleanPage(0, 120)), answered(notCleanPage(1, 120))]);
    const before = JSON.stringify(pages);
    sheet(pages);
    sheet([pages[0], answered(notCleanPage(1, 120, PLAN_B))]);
    const row = deepFreeze(changeRow([...CONVERSION_CHANGED_FIELDS], sizeView(), sizeView({ blockers: ["no_ebay_category"] as ConversionBlockerCode[], descriptionHash: DESC_2 })));
    conversionRowLines(row);
    const answer = check({ state: "not_clean", blocked: { wouldLosePrice: list([sizeRef(PENNY_100, "Pack of 100")]), wouldBlockListing: list([]), tooMuchText: false } });
    blockedLines(answer.blocked);
    becomesLines(answer.becomes);
    reportLines(answer.report, "not_clean");
    keptLine(answer.kept);
    olderRulesLineModel(summary({ price: 1 }), categoriesListed);
    olderRulesOpener(summary({ price: 1 }));
    const session = deepFreeze({ ...OLDER_RULES_SHEET_OPENED });
    olderRulesSheetSession(session, { type: "load_more" });
    olderRulesSheetSession(session, { type: "plan_changed" });
    expect(session).toEqual(OLDER_RULES_SHEET_OPENED);
    expect(JSON.stringify(pages)).toBe(before);
  });
});
