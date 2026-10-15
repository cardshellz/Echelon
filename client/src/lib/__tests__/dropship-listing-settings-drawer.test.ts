import { describe, expect, it, vi } from "vitest";
import {
  listingPriceSettingSchema,
  saveListingPriceInputSchema,
  type ListingPriceSetting,
  type SaveListingPriceInput,
} from "@shared/dropship/listing-price";
import {
  listingSettingsProductDetailSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsSizePriceSchema,
  type ListingSettingsProductDetail,
  type ListingSettingsProductSize,
  type ListingSettingsSizePrice,
} from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { listingSettingsQueryKey } from "../dropship-listing-settings";
import {
  nextSaveAttempt,
  productEditorId,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
  type WriteFailure,
} from "../dropship-listing-settings-drafts";
import {
  clearOutcome,
  decideSizeEdit,
  DRAWER_SIZES_SHOWN_FIRST,
  DRAWER_WORDS,
  drawerCategoryLine,
  drawerDraftState,
  drawerFooter,
  drawerOwnReadProblem,
  drawerOwnSettingsLine,
  drawerPhoneSummary,
  drawerReadProblem,
  drawerLanding,
  drawerSearch,
  drawerSettingRows,
  shownFieldEditor,
  drawerSizeEditState,
  drawerSizeLine,
  drawerSizeList,
  drawerStartsWithAllSizes,
  firstSizeNeedingFix,
  drawerTargetFromSearch,
  LISTING_SETTINGS_SHEETS,
  limitNotices,
  marginNotice,
  ownSizePriceDraft,
  parseExactPrice,
  priceHeadWords,
  productNotFoundWords,
  productPriceHeadRule,
  readSizePriceDraft,
  rebaseSizePriceDraft,
  refreshAfterSizePriceSave,
  rereadSizePrice,
  runSizePriceSave,
  savedExactText,
  sheetFromSearch,
  sheetSearch,
  sizeFactsLine,
  sizePriceDraftBase,
  sizePriceDraftValue,
  sizePriceQueryKey,
  sizePriceQueryOptions,
  sizePriceRequest,
  sizePriceSave,
  sizesNotChosenWords,
  typedPriceLine,
  wouldBeWords,
  type SizePriceDraft,
  type SizePriceQueryClient,
  type SizePriceSaveDrafts,
} from "../dropship-listing-settings-drawer";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  listingSettingsEditRights,
  type ListingSettingsReadState,
  type ListingSettingsRight,
  type ListingSettingsRightsInput,
  type ListingSetupFacts,
} from "../dropship-listing-settings-access";
import type { PolicySetupFacts } from "../dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";
import {
  emptyChoices,
  productPriceDraftValue,
  productSettingsDraftValue,
  type ProductOwnSettings,
  type ProductSettingsChoices,
} from "../dropship-listing-settings-product-edit";
import { isPolicyRowEdit } from "../dropship-listing-settings-drawer";

const STORE = 22;
const PRODUCT = 11;
const SIZE_A = 101;
const SIZE_B = 102;
const GENERATED_AT = "2026-10-09T12:00:00.000Z";
const EDITOR = productEditorId(PRODUCT);
const IDENTITY = { storeConnectionId: STORE, productVariantId: SIZE_A };
const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };

// ---------------------------------------------------------------------------
// Fixtures, each checked against the shared contract so they are answers the server could give.
// ---------------------------------------------------------------------------

function sizePrice(overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return listingSettingsSizePriceSchema.parse({
    productVariantId: SIZE_A,
    productId: PRODUCT,
    productName: "Easy Glide Soft Sleeves",
    sizeName: "Box of 5 Packs of 100",
    sku: "EG-SLV-STD-5PCK-B500",
    priceCents: 1599,
    source: "rules",
    rule: { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP },
    basis: "catalog_retail",
    basisAmountCents: 1250,
    issue: null,
    costCents: 980,
    belowCostByCents: null,
    limits: [],
    pausedSince: null,
    settingRevisionId: null,
    ...overrides,
  });
}

const EXACT_A = sizePrice({ priceCents: 1499, source: "exact", rule: null, basis: null, basisAmountCents: null, settingRevisionId: 7 });
const RULES_B = sizePrice({ productVariantId: SIZE_B, sizeName: "Pack of 100", sku: "EG-SLV-STD-100", priceCents: 499,
  basisAmountCents: 399, costCents: 210 });

function size(price: ListingSettingsSizePrice, stockUnits: number | null = 40): ListingSettingsProductSize {
  return { price, fixes: [], stockUnits };
}

function w9(overrides: Partial<ListingPriceSetting> = {}): ListingPriceSetting {
  return listingPriceSettingSchema.parse({
    storeConnectionId: STORE,
    productVariantId: SIZE_A,
    revisionId: 7,
    overridePriceCents: 1499,
    effectivePriceCents: 1499,
    defaultPriceCents: 1250,
    source: "override",
    pricingMode: "fixed",
    ruleName: "Store default rule",
    pricingIssue: null,
    rulePriceCents: 1599,
    rulesConfigured: true,
    ruleBasis: "catalog_retail",
    productCostCents: 980,
    updatedAt: GENERATED_AT,
    ...overrides,
  });
}

const DETAIL: ListingSettingsProductDetail = listingSettingsProductDetailSchema.parse({
  storeConnectionId: STORE,
  product: {
    productId: PRODUCT,
    productName: "Easy Glide Soft Sleeves",
    category: "Sleeves",
    sizesChosen: 2,
    sizesTotal: 4,
    priceRange: { minCents: 499, maxCents: 1499 },
    exactPriceCount: 1,
    ownSettings: ["shipping_policy"],
    sizesDiffer: ["shipping_policy"],
    fixes: [],
  },
  settings: {
    shippingPolicy: [
      { value: { policyId: "ship-1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [SIZE_A] }] },
      { value: { policyId: "ship-2" }, sources: [{ source: "size", ruleName: null, productVariantIds: [SIZE_B] }] },
    ],
    returnPolicy: [{ value: { policyId: null }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    paymentPolicy: [{ value: { policyId: "pay-1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    ebayCategory: [{ value: { categoryId: "261328", categoryName: "Card Sleeves" }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    storeShelf: [{ value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
    descriptionTemplate: [{
      value: { hasIntroduction: true, hasFooter: false, groupConflict: false },
      sources: [{ source: "group_rule", ruleName: "Sleeves text", productVariantIds: [SIZE_A, SIZE_B] }],
    }],
    mainText: [{ value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
  },
  sizes: [size(EXACT_A), size(RULES_B, 120)],
  stock: { state: "ok", checkedAt: GENERATED_AT },
  generatedAt: GENERATED_AT,
});

const SETUP: ListingSettingsReadState<PolicySetupFacts> = {
  data: {
    selection: { merchantLocationKey: "loc-1", fulfillmentPolicyId: "ship-1", returnPolicyId: null, paymentPolicyId: "pay-1" },
    storedNames: { fulfillmentPolicyName: "Free Standard US", returnPolicyName: null, paymentPolicyName: "eBay payments" },
    options: {
      merchantLocations: [],
      fulfillmentPolicies: [{ id: "ship-1", name: "Free Standard US", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [],
      paymentPolicies: [{ id: "pay-1", name: "eBay payments" }],
    },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    fulfillmentCapability: null,
  },
  error: null,
};

/** A draft the provider would hold for this product, built with the real reducer. */
function draftFor(base: SizePriceDraft, exact: string): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: sizePriceDraftValue(base) });
  const edited = reduceListingSettingsDraft(opened, { type: "edit", value: sizePriceDraftValue({ ...base, exact }) });
  if (!edited) throw new Error("The draft did not open.");
  return edited;
}

const BASE_A: SizePriceDraft = { productVariantId: SIZE_A, expectedRevisionId: 7, exact: "14.99" };

// ---------------------------------------------------------------------------
// The deep link
// ---------------------------------------------------------------------------

describe("drawerTargetFromSearch", () => {
  it("opens on a product and its size", () => {
    expect(drawerTargetFromSearch("?product=11&size=101")).toEqual({ productId: 11, productVariantId: 101 });
    expect(drawerTargetFromSearch("product=11&size=101")).toEqual({ productId: 11, productVariantId: 101 });
    expect(drawerTargetFromSearch("?store=22&product=11")).toEqual({ productId: 11 });
    expect(drawerTargetFromSearch("?product=2147483647&size=2147483647")).toEqual({ productId: 2_147_483_647, productVariantId: 2_147_483_647 });
  });

  it.each([
    ["missing", ""],
    ["missing with other params", "?store=22"],
    ["zero", "?product=0"],
    ["negative", "?product=-11"],
    ["text", "?product=sleeves"],
    ["huge", "?product=2147483648"],
    ["very huge", "?product=99999999999999999999"],
    ["leading zero", "?product=011"],
    ["decimal", "?product=11.5"],
    ["exponent", "?product=1e3"],
    ["sign", "?product=%2B11"],
    ["spaces", "?product=%2011"],
    ["empty", "?product="],
    ["repeated", "?product=11&product=12"],
  ])("opens nothing for a product id that is %s", (_name, search) => {
    expect(drawerTargetFromSearch(search)).toBeNull();
  });

  it.each([
    ["zero", "0"], ["negative", "-101"], ["text", "box"], ["huge", "2147483648"], ["decimal", "1.5"], ["empty", ""],
  ])("opens the product without a size when the size is %s", (_name, value) => {
    expect(drawerTargetFromSearch(`?product=11&size=${value}`)).toEqual({ productId: 11 });
  });

  it("drops a repeated size", () => {
    expect(drawerTargetFromSearch("?product=11&size=101&size=102")).toEqual({ productId: 11 });
  });
});

describe("drawerSearch", () => {
  it("opens and closes the drawer, keeping every other parameter", () => {
    expect(drawerSearch("", { productId: 11, productVariantId: 101 })).toBe("?product=11&size=101");
    expect(drawerSearch("?store=22", { productId: 11 })).toBe("?store=22&product=11");
    expect(drawerSearch("?product=9&size=90&store=22", { productId: 11, productVariantId: 101 })).toBe("?store=22&product=11&size=101");
    expect(drawerSearch("?product=11&size=101&store=22", null)).toBe("?store=22");
    expect(drawerSearch("?product=11", null)).toBe("");
  });

  it("round-trips through drawerTargetFromSearch", () => {
    const target = { productId: 11, productVariantId: 101 };
    expect(drawerTargetFromSearch(drawerSearch("?store=22", target))).toEqual(target);
  });

  it("refuses an id that is not a positive whole number", () => {
    expect(() => drawerSearch("", { productId: 0 })).toThrow();
    expect(() => drawerSearch("", { productId: 1.5 })).toThrow();
    expect(() => drawerSearch("", { productId: 11, productVariantId: -1 })).toThrow();
  });

  it("keeps a sheet's parameter as it is (K15)", () => {
    expect(drawerSearch("?sheet=bulk&store=22", { productId: 11 })).toBe("?sheet=bulk&store=22&product=11");
    expect(drawerSearch("?sheet=bulk&product=11", null)).toBe("?sheet=bulk");
  });
});

describe("the sheets in the page address (?sheet=, PR 10c, 10g, D21)", () => {
  it("opens Set for selected from ?sheet=bulk, Card Shellz updated products from ?sheet=updated, and nothing from a sheet this page doesn't have", () => {
    expect(LISTING_SETTINGS_SHEETS).toEqual(["bulk", "updated"]);
    expect(sheetFromSearch("?sheet=bulk")).toBe("bulk");
    expect(sheetFromSearch("?sheet=updated")).toBe("updated");
    expect(sheetFromSearch("?store=22&sheet=updated&product=11")).toBe("updated");
    expect(sheetFromSearch("sheet=bulk&store=22")).toBe("bulk");
    expect(sheetFromSearch("?store=22&product=11&sheet=bulk")).toBe("bulk");
    for (const search of ["", "?store=22", "?sheet=", "?sheet=Bulk", "?sheet=bulk%20", "?sheet=give-prices", "?sheet=Updated", "?sheet=bulk&sheet=bulk", "?sheet=bulk&sheet=updated", "?sheets=bulk"]) {
      expect({ search, sheet: sheetFromSearch(search) }).toEqual({ search, sheet: null });
    }
  });

  it("opens and closes a sheet, keeping every other parameter, the drawer's too (K15)", () => {
    expect(sheetSearch("", "bulk")).toBe("?sheet=bulk");
    expect(sheetSearch("?store=22", "bulk")).toBe("?store=22&sheet=bulk");
    expect(sheetSearch("?sheet=bulk&store=22", null)).toBe("?store=22");
    expect(sheetSearch("?sheet=bulk", null)).toBe("");
    expect(sheetSearch("?product=11&size=101&sheet=bulk&sheet=bulk", null)).toBe("?product=11&size=101");
    expect(sheetSearch("?product=11", "bulk")).toBe("?product=11&sheet=bulk");
    // One sheet at a time in the address: opening the other replaces it (10g).
    expect(sheetSearch("?sheet=bulk&store=22", "updated")).toBe("?store=22&sheet=updated");
    expect(sheetSearch("?sheet=updated", null)).toBe("");
    expect(sheetFromSearch(sheetSearch("", "updated"))).toBe("updated");
    // Each helper leaves the other's parameter alone, so a closed sheet never closes the drawer and the other way round.
    expect(drawerTargetFromSearch(sheetSearch("?product=11&size=101", "bulk"))).toEqual({ productId: 11, productVariantId: 101 });
    expect(sheetFromSearch(drawerSearch("?sheet=bulk", { productId: 11 }))).toBe("bulk");
    expect(sheetFromSearch(sheetSearch("?store=22", "bulk"))).toBe("bulk");
  });

  it("refuses a sheet this page doesn't have", () => {
    expect(() => sheetSearch("", "give-prices" as "bulk")).toThrow(/only a sheet this page has/);
  });
});

// ---------------------------------------------------------------------------
// The header and the PRICE head
// ---------------------------------------------------------------------------

describe("header words", () => {
  it("names the Card Shellz category, the sizes chosen and the status (R:591)", () => {
    expect(drawerCategoryLine(DETAIL.product)).toBe("Card Shellz category: Sleeves · 2 of 4 sizes selected · Sizes differ");
    expect(drawerCategoryLine({ ...DETAIL.product, category: null, sizesDiffer: [], sizesTotal: 2 }))
      .toBe("No Card Shellz category · 2 of 2 sizes selected · No fixes needed");
    expect(drawerCategoryLine({ ...DETAIL.product, sizesChosen: 1, sizesTotal: 1, sizesDiffer: [], fixes: ["no_ebay_category"] }))
      .toBe("Card Shellz category: Sleeves · 1 of 1 size selected · Needs a fix: no eBay category");
  });

  it("never reads more chosen than there are", () => {
    expect(drawerCategoryLine({ ...DETAIL.product, sizesChosen: 5, sizesTotal: 4 })).toContain("5 of 5 sizes selected");
  });

  it("says \"From your <c> settings\" only when the server says a value comes from the category (R:591; plan 5.2)", () => {
    // DETAIL has no category source: the line is as before, with or without the settings.
    expect(drawerCategoryLine(DETAIL.product, DETAIL.settings)).toBe("Card Shellz category: Sleeves · 2 of 4 sizes selected · Sizes differ");
    const settings = {
      ...DETAIL.settings,
      returnPolicy: [{ value: { policyId: "ret-4" }, sources: [{ source: "category" as const, ruleName: " Sleeves ", productVariantIds: [SIZE_A, SIZE_B] }] }],
    };
    expect(drawerCategoryLine(DETAIL.product, settings))
      .toBe("Card Shellz category: Sleeves · From your Sleeves settings · 2 of 4 sizes selected · Sizes differ");
    // Named as the server names the category now, even when the product row's name lags behind.
    expect(drawerCategoryLine({ ...DETAIL.product, category: "Old name" }, settings)).toContain("From your Sleeves settings");
  });

  it("has a short phone line and the own settings sentence", () => {
    expect(drawerPhoneSummary(DETAIL.product)).toBe("2 sizes · Sizes differ");
    expect(drawerPhoneSummary({ ...DETAIL.product, sizesChosen: 1, sizesDiffer: [] })).toBe("1 size · No fixes needed");
    // DETAIL's description comes from the older group rule "Sleeves text", so the rest is not all store defaults.
    expect(drawerOwnSettingsLine(DETAIL)).toBe("Own settings: 1 exact price, shipping policy. Everything else uses your store defaults or older group rules.");
    expect(drawerOwnSettingsLine({ ...DETAIL, product: { ...DETAIL.product, exactPriceCount: 0, ownSettings: [] } }))
      .toBe("Everything uses your store defaults or older group rules.");
  });

  it("says store defaults alone only when no older group rule gives a setting or a price", () => {
    const storeDefaultText = listingSettingsProductDetailSchema.parse({ ...DETAIL, settings: { ...DETAIL.settings, descriptionTemplate: [{
      value: { hasIntroduction: true, hasFooter: false, groupConflict: false },
      sources: [{ source: "store_default", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }],
    }] } });
    expect(drawerOwnSettingsLine(storeDefaultText)).toBe("Own settings: 1 exact price, shipping policy. Everything else uses your store defaults.");
    expect(drawerOwnSettingsLine({ ...storeDefaultText, product: { ...storeDefaultText.product, exactPriceCount: 0, ownSettings: [] } }))
      .toBe("Everything uses your store defaults.");

    // A size priced by an older group rule ("From your older group rule …" in the Price section).
    const groupPriced = { ...storeDefaultText, sizes: [size(EXACT_A), size(sizePrice({ ...RULES_B,
      rule: { kind: "group", name: "Toploaders", recipe: { basis: "catalog_retail", markupBps: 3000, flatCents: 0, rounding: "up_99" } } }), 120)] };
    expect(drawerOwnSettingsLine(listingSettingsProductDetailSchema.parse(groupPriced)))
      .toBe("Own settings: 1 exact price, shipping policy. Everything else uses your store defaults or older group rules.");
  });

  it("shows the store price, or says there is none yet", () => {
    expect(priceHeadWords(RETAIL_20_UP)).toBe("Store default: Retail price + 20%, round up to .99");
    expect(priceHeadWords(null)).toBe("No store price yet. Set one in Store defaults.");
    expect(priceHeadWords(undefined)).toBe("Checking…");
  });

  it("counts the sizes not chosen (R:555)", () => {
    expect(sizesNotChosenWords({ sizesChosen: 2, sizesTotal: 4 })).toBe("2 more sizes aren't selected. Choose them in step 1.");
    expect(sizesNotChosenWords({ sizesChosen: 3, sizesTotal: 4 })).toBe("1 more size isn't selected. Choose it in step 1.");
    expect(sizesNotChosenWords({ sizesChosen: 4, sizesTotal: 4 })).toBeNull();
    expect(sizesNotChosenWords({ sizesChosen: 5, sizesTotal: 4 })).toBeNull();
  });

  it("names the store when the product isn't chosen (C27)", () => {
    expect(productNotFoundWords("Marz Cards")).toBe("This product isn't chosen for Marz Cards. Choose it in step 1.");
    expect(productNotFoundWords("  ")).toBe("This product isn't chosen for your eBay store. Choose it in step 1.");
    const notFound = new DropshipApiError({ message: "x", status: 404, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND" });
    expect(drawerReadProblem(notFound, "Marz Cards")).toEqual({ kind: "not_found", message: productNotFoundWords("Marz Cards") });
    expect(drawerReadProblem(new DropshipApiError({ message: "x", status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" }), "M").kind).toBe("too_large");
    expect(drawerReadProblem(new DropshipApiError({ message: "x", status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED" }), "M").kind).toBe("rate_limited");
    // A store that isn't found is not "this product isn't chosen".
    expect(drawerReadProblem(new DropshipApiError({ message: "x", status: 404, code: "DROPSHIP_STORE_CONNECTION_REQUIRED" }), "M").kind).toBe("failed");
    expect(drawerReadProblem(new TypeError("Failed to fetch"), "M")).toEqual({ kind: "failed", message: DRAWER_WORDS.readFailed });
  });
});

// ---------------------------------------------------------------------------
// Which sizes show
// ---------------------------------------------------------------------------

describe("drawerSizeList", () => {
  const many = Array.from({ length: 40 }, (_, index) => size(sizePrice({
    productVariantId: 1000 + index, sizeName: `Size ${index + 1}`, sku: `SKU-${index + 1}`,
  })));

  it("shows 25, then Show all N sizes (R:556)", () => {
    const list = drawerSizeList(many, { showAll: false, search: "", keepVariantIds: [] });
    expect(list.shown).toHaveLength(DRAWER_SIZES_SHOWN_FIRST);
    expect(list.showAllLabel).toBe("Show all 40 sizes");
    expect(list.searchable).toBe(false);
  });

  it("never hides the size holding a change", () => {
    const list = drawerSizeList(many, { showAll: false, search: "", keepVariantIds: [1039] });
    expect(list.shown.map((entry) => entry.price.productVariantId)).toContain(1039);
    const searched = drawerSizeList(many, { showAll: true, search: "Size 3", keepVariantIds: [1039] });
    expect(searched.shown.map((entry) => entry.price.productVariantId)).toContain(1039);
  });

  it("searches size names and SKUs once every size shows", () => {
    const list = drawerSizeList(many, { showAll: true, search: " sku-12 ", keepVariantIds: [] });
    expect(list.searchable).toBe(true);
    expect(list.shown.map((entry) => entry.price.sizeName)).toEqual(["Size 12"]);
    const none = drawerSizeList(many, { showAll: true, search: "toploader", keepVariantIds: [] });
    expect(none.shown).toEqual([]);
    expect(none.noMatch).toBe("No sizes match “toploader”.");
  });

  it("shows a short list whole, with no search", () => {
    const list = drawerSizeList(DETAIL.sizes, { showAll: false, search: "nothing", keepVariantIds: [] });
    expect(list.shown).toHaveLength(2);
    expect(list).toMatchObject({ showAllLabel: null, searchable: false, noMatch: null });
  });

  it("opens with every size shown when the target is beyond the first 25 (C13)", () => {
    expect(drawerStartsWithAllSizes(many, 1030)).toBe(true);
    expect(drawerStartsWithAllSizes(many, 1003)).toBe(false);
    expect(drawerStartsWithAllSizes(many, null)).toBe(false);
    expect(drawerStartsWithAllSizes(many, 99)).toBe(false);
    expect(drawerStartsWithAllSizes(DETAIL.sizes, SIZE_B)).toBe(false);
  });

  it("lands an attention line's [Fix] on the first size that needs it, in the detail's order", () => {
    const [first, second] = DETAIL.sizes;
    const unpricedSecond = { sizes: [first, { ...second, fixes: ["size_cannot_be_priced" as const] }] };
    expect(firstSizeNeedingFix(unpricedSecond, "size_cannot_be_priced")).toBe(SIZE_B);
    const bothUnpriced = { sizes: [{ ...first, fixes: ["size_cannot_be_priced" as const] }, unpricedSecond.sizes[1]] };
    expect(firstSizeNeedingFix(bothUnpriced, "size_cannot_be_priced")).toBe(SIZE_A);
    // Another fix, or none at all: the drawer opens on the product alone.
    expect(firstSizeNeedingFix(unpricedSecond, "no_ebay_category")).toBeNull();
    expect(firstSizeNeedingFix(DETAIL, "size_cannot_be_priced")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prices, costs and limits: integer cents only
// ---------------------------------------------------------------------------

describe("parseExactPrice", () => {
  it.each([
    ["14.99", 1499], ["14.9", 1490], ["14", 1400], [" 0.01 ", 1], ["21474836.47", 2_147_483_647],
  ])("reads %s as %i cents", (text, cents) => {
    expect(parseExactPrice(text)).toEqual({ ok: true, cents });
  });

  it.each(["abc", "14.999", "$14.99", "14,99", "-1", "", " ", "1e3", "12345678901234567890.1"])("asks for the shape of %j (R:540)", (text) => {
    expect(parseExactPrice(text)).toEqual({ ok: false, message: "Enter a price like 14.99." });
  });

  it.each(["0", "0.00", "21474836.48", "99999999999"])("asks for a price in range for %s (R:540)", (text) => {
    expect(parseExactPrice(text)).toEqual({ ok: false, message: "Enter a price from $0.01 to $21,474,836.47." });
  });
});

describe("margin and would-be words", () => {
  it("says how far over the cost a price is, in whole cents (R:251)", () => {
    expect(marginNotice(1499, 980)).toEqual({ tone: "info", text: "$14.99 is $5.19 over your cost, before eBay fees and shipping." });
    expect(marginNotice(1001, 1000)?.text).toBe("$10.01 is $0.01 over your cost, before eBay fees and shipping.");
  });

  it("warns below cost and never blocks (R:526)", () => {
    expect(marginNotice(940, 980)).toEqual({ tone: "warn", text: "Below your cost: you'd lose $0.40 on each sale. You can still save it." });
  });

  it("says nothing without a known cost, and says so at cost", () => {
    expect(marginNotice(1499, null)).toBeNull();
    expect(marginNotice(1499, undefined)).toBeNull();
    expect(marginNotice(980, 980)?.text).toBe("$9.80 is the same as your cost, before eBay fees and shipping.");
    expect(marginNotice(1, 0)?.text).toBe("$0.01 is $0.01 over your cost, before eBay fees and shipping.");
  });

  it("names what the size would cost without an exact price (R:250)", () => {
    expect(typedPriceLine(1499, w9())).toBe("→ $14.99 · Not saved · store default would be $15.99");
    expect(typedPriceLine(1499, w9({ ruleName: "Envelopes", rulePriceCents: 699 }))).toBe("→ $14.99 · Not saved · your older group rule “Envelopes” would give $6.99");
    expect(typedPriceLine(1499, w9({ rulePriceCents: null, rulesConfigured: false, ruleName: null }))).toBe("→ $14.99 · Not saved · retail price would be $12.50");
    expect(typedPriceLine(1499, w9({ rulePriceCents: null, defaultPriceCents: null }))).toBe("→ $14.99 · Not saved");
    expect(typedPriceLine(1499, null)).toBe("→ $14.99 · Not saved");
    expect(wouldBeWords(null)).toBeNull();
  });
});

describe("limitNotices (R:527-528)", () => {
  const block = { policyId: 3, floorCents: 500, ceilingCents: 4000, mode: "block_listing" as const, breached: null };
  const orders = { policyId: 4, floorCents: 500, ceilingCents: null, mode: "refuse_orders" as const, breached: null };

  it("says the range a blocking limit lists between, only outside it", () => {
    expect(limitNotices([block], 499)).toEqual([{ tone: "alert", text: "Card Shellz lists this size between $5.00 and $40.00." }]);
    expect(limitNotices([block], 4001)).toEqual([{ tone: "alert", text: "Card Shellz lists this size between $5.00 and $40.00." }]);
    expect(limitNotices([block], 500)).toEqual([]);
    expect(limitNotices([block], 4000)).toEqual([]);
    expect(limitNotices([block], null)).toEqual([]);
  });

  it("uses the highest floor and the lowest ceiling", () => {
    const tighter = { ...block, policyId: 5, floorCents: 700, ceilingCents: 3000 };
    expect(limitNotices([block, tighter], 650)[0].text).toBe("Card Shellz lists this size between $7.00 and $30.00.");
    expect(limitNotices([{ ...block, ceilingCents: null }], 100)[0].text).toBe("Card Shellz lists this size at $5.00 or more.");
    expect(limitNotices([{ ...block, floorCents: null }], 5000)[0].text).toBe("Card Shellz lists this size at $40.00 or less.");
  });

  it("warns, never refuses, for the order limit", () => {
    expect(limitNotices([orders], 499)).toEqual([{ tone: "warn", text: "Card Shellz can't accept orders for this size below $5.00." }]);
    expect(limitNotices([orders], 500)).toEqual([]);
    expect(limitNotices([{ ...orders, floorCents: null, ceilingCents: 4000 }], 4001)[0].text).toBe("Card Shellz can't accept orders for this size above $40.00.");
    expect(limitNotices([{ ...block, mode: "warn" }], 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// × ("Use the price above") and the retail fallback (A3, L1)
// ---------------------------------------------------------------------------

describe("clearOutcome", () => {
  it("waits for the size's own price read", () => {
    expect(clearOutcome(null)).toEqual({ kind: "checking" });
    expect(clearOutcome(undefined)).toEqual({ kind: "checking" });
  });

  it("follows the store price while it gives one", () => {
    expect(clearOutcome(w9())).toEqual({ kind: "allowed", priceCents: 1599, line: "→ $15.99 · Not saved · uses the store default", note: null });
    expect(clearOutcome(w9({ ruleName: "Envelopes", rulePriceCents: 699 })))
      .toMatchObject({ kind: "allowed", priceCents: 699, line: "→ $6.99 · Not saved · uses your older group rule “Envelopes”" });
  });

  it("falls back to the retail price, and says why (L1)", () => {
    expect(clearOutcome(w9({ rulePriceCents: null, rulesConfigured: false, ruleName: null, ruleBasis: null }))).toEqual({
      kind: "allowed",
      priceCents: 1250,
      line: "→ $12.50 · Not saved · uses the retail price",
      note: "No pricing rule covers this size, so it uses the retail price ($12.50).",
    });
    expect(clearOutcome(w9({ rulePriceCents: null, pricingIssue: "pricing_rule_priority_conflict" }))).toMatchObject({
      kind: "allowed",
      priceCents: 1250,
      note: "Your pricing rules can't price this size (two older group rules tie), so it uses the retail price ($12.50).",
    });
  });

  it("is off when nothing would price the size, in both cases", () => {
    expect(clearOutcome(w9({ rulePriceCents: null, rulesConfigured: false, defaultPriceCents: null })))
      .toEqual({ kind: "off", reason: "This size has no retail price, so it needs an exact price." });
    expect(clearOutcome(w9({ rulePriceCents: null, rulesConfigured: true, defaultPriceCents: null, pricingIssue: "pricing_basis_unavailable" })))
      .toEqual({ kind: "off", reason: "The store price can't price this size and it has no retail price, so it needs an exact price." });
  });
});

describe("sizePriceSave and sizePriceRequest", () => {
  it("always sends inherit for an empty box (A3)", () => {
    for (const exact of ["", "   "]) {
      const save = sizePriceSave(IDENTITY, { ...BASE_A, exact });
      expect(save.ok && save.intent).toEqual({ kind: "inherit" });
      if (!save.ok) throw new Error("expected a save");
      const body = sizePriceRequest(save.intent, 7, "ls-price:abc");
      expect(body).toEqual({ priceCents: null, pricingMode: "inherit", expectedRevisionId: 7, idempotencyKey: "ls-price:abc" });
      expect(saveListingPriceInputSchema.safeParse(body).success).toBe(true);
    }
  });

  it("sends a typed price with no mode (journey 8's exact body)", () => {
    const save = sizePriceSave(IDENTITY, { ...BASE_A, exact: "14.9" });
    if (!save.ok) throw new Error("expected a save");
    expect(save.intent).toEqual({ kind: "exact", priceCents: 1490 });
    expect(save.normalized.exact).toBe("14.90");
    expect(sizePriceRequest(save.intent, null, "ls-price:abc")).toEqual({ priceCents: 1490, expectedRevisionId: null, idempotencyKey: "ls-price:abc" });
  });

  it("refuses a bad entry before anything is built", () => {
    expect(sizePriceSave(IDENTITY, { ...BASE_A, exact: "14.999" })).toEqual({ ok: false, message: "Enter a price like 14.99." });
    expect(sizePriceSave(IDENTITY, { ...BASE_A, exact: "0" })).toEqual({ ok: false, message: "Enter a price from $0.01 to $21,474,836.47." });
    expect(() => sizePriceSave({ ...IDENTITY, productVariantId: SIZE_B }, BASE_A)).toThrow();
    expect(() => sizePriceRequest({ kind: "inherit" }, 7, "not a key!")).toThrow();
  });

  it("gives the same request the same signature, and any change a new one", () => {
    const signature = (draft: SizePriceDraft) => {
      const save = sizePriceSave(IDENTITY, draft);
      if (!save.ok) throw new Error("expected a save");
      return save.signature;
    };
    const typed = signature({ ...BASE_A, exact: "14.90" });
    expect(signature({ ...BASE_A, exact: "14.9" })).toBe(typed);
    expect(signature({ ...BASE_A, exact: " 14.90 " })).toBe(typed);
    expect(signature({ ...BASE_A, exact: "14.91" })).not.toBe(typed);
    expect(signature({ ...BASE_A, exact: "14.90", expectedRevisionId: 8 })).not.toBe(typed);
    expect(signature({ ...BASE_A, exact: "" })).not.toBe(typed);
    expect(sizePriceSave({ ...IDENTITY, storeConnectionId: 23 }, { ...BASE_A, exact: "14.90" })).not.toMatchObject({ signature: typed });
  });

  it("reuses the request key for the same request through the draft (fingerprint reuse)", () => {
    const save = sizePriceSave(IDENTITY, { ...BASE_A, exact: "12.00" });
    if (!save.ok) throw new Error("expected a save");
    let keys = 0;
    const newKey = () => `ls-price:${++keys}`;
    let draft = draftFor(BASE_A, "12.00");
    const first = nextSaveAttempt(draft, save.signature, newKey);
    expect(first?.key).toBe("ls-price:1");
    draft = reduceListingSettingsDraft(draft, { type: "startSave", attempt: first! })!;
    const dropped: WriteFailure = { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null };
    draft = reduceListingSettingsDraft(draft, { type: "failure", key: "ls-price:1", failure: dropped })!;
    // Check again: the same request, so the same key.
    expect(nextSaveAttempt(draft, save.signature, newKey)?.key).toBe("ls-price:1");
    // An unconfirmed save can't be replaced by another request.
    const other = sizePriceSave(IDENTITY, { ...BASE_A, exact: "12.50" });
    if (!other.ok) throw new Error("expected a save");
    expect(nextSaveAttempt(draft, other.signature, newKey)).toBeNull();
    expect(keys).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The draft and one size at a time (D4)
// ---------------------------------------------------------------------------

describe("the draft", () => {
  it("reads only its own shape", () => {
    expect(readSizePriceDraft(sizePriceDraftValue(BASE_A))).toEqual(BASE_A);
    expect(readSizePriceDraft({ productVariantId: SIZE_A, expectedRevisionId: null, exact: "" })).toEqual({ productVariantId: SIZE_A, expectedRevisionId: null, exact: "" });
    expect(readSizePriceDraft({ basis: "catalog_retail", percent: "20" })).toBeNull();
    expect(readSizePriceDraft({ productVariantId: 0, expectedRevisionId: null, exact: "" })).toBeNull();
    expect(readSizePriceDraft({ productVariantId: SIZE_A, expectedRevisionId: -1, exact: "" })).toBeNull();
    expect(readSizePriceDraft({ productVariantId: SIZE_A, expectedRevisionId: 7, exact: 14.99 })).toBeNull();
  });

  it("starts from the size's own price read when it answered, else the product read", () => {
    expect(savedExactText(EXACT_A)).toBe("14.99");
    expect(savedExactText(RULES_B)).toBe("");
    expect(sizePriceDraftBase(EXACT_A, null)).toEqual({ productVariantId: SIZE_A, expectedRevisionId: 7, exact: "14.99" });
    expect(sizePriceDraftBase(EXACT_A, w9({ revisionId: 9, overridePriceCents: 1550 }))).toEqual({ productVariantId: SIZE_A, expectedRevisionId: 9, exact: "15.50" });
    expect(sizePriceDraftBase(EXACT_A, w9({ revisionId: 9, overridePriceCents: null, source: "rules", pricingMode: "inherit", effectivePriceCents: 1599 })))
      .toEqual({ productVariantId: SIZE_A, expectedRevisionId: 9, exact: "" });
    // Another size's read is never used.
    expect(sizePriceDraftBase(RULES_B, w9())).toEqual({ productVariantId: SIZE_B, expectedRevisionId: null, exact: "" });
  });

  it("lets one size hold a change; the others wait (D4)", () => {
    const draft = draftFor(BASE_A, "12.00");
    expect(draft.changes).toBe(1);
    expect(drawerSizeEditState(draft, EDITOR, EXACT_A)).toEqual({ text: "12.00", changed: true, waiting: false, marked: false });
    expect(drawerSizeEditState(draft, EDITOR, RULES_B)).toEqual({ text: "", changed: false, waiting: true, marked: false });
    const waitingLine = drawerSizeLine({ size: size(RULES_B), stock: DETAIL.stock, edit: drawerSizeEditState(draft, EDITOR, RULES_B),
      w9: null, editable: true, locked: false, fieldError: null });
    expect(waitingLine.input.readOnly).toBe(true);
    // Another product's draft does not hold this one.
    expect(drawerSizeEditState(draft, productEditorId(12), RULES_B).waiting).toBe(false);
  });

  it("decides what typing in a box does (D4)", () => {
    // No draft yet: start from the product read, or from the size's own read when it answered.
    expect(decideSizeEdit(null, EDITOR, EXACT_A, null, "12")).toEqual({
      kind: "start", base: { productVariantId: SIZE_A, expectedRevisionId: 7, exact: "14.99" }, value: { productVariantId: SIZE_A, expectedRevisionId: 7, exact: "12" },
    });
    expect(decideSizeEdit(null, EDITOR, EXACT_A, w9({ revisionId: 9, overridePriceCents: 1550 }), "12")).toMatchObject({
      kind: "start", base: { expectedRevisionId: 9, exact: "15.50" },
    });
    const holdingA = draftFor(BASE_A, "12.00");
    expect(decideSizeEdit(holdingA, EDITOR, EXACT_A, w9({ revisionId: 9 }), "12.5")).toEqual({
      // The size holding a change keeps the revision the vendor saw.
      kind: "edit", reopen: false, value: { productVariantId: SIZE_A, expectedRevisionId: 7, exact: "12.5" },
    });
    expect(decideSizeEdit(holdingA, EDITOR, RULES_B, null, "5")).toEqual({ kind: "wait" });
    const hidden = reduceListingSettingsDraft(holdingA, { type: "close" })!;
    expect(decideSizeEdit(hidden, EDITOR, EXACT_A, null, "12.5")).toMatchObject({ kind: "edit", reopen: true });
    // An unchanged draft never holds a size: the next edit starts over from what is saved now.
    const unchanged = draftFor(BASE_A, "14.99");
    expect(decideSizeEdit(unchanged, EDITOR, RULES_B, null, "5")).toMatchObject({ kind: "start", base: { productVariantId: SIZE_B, expectedRevisionId: null, exact: "" } });
    expect(decideSizeEdit(unchanged, EDITOR, sizePrice({ ...EXACT_A, settingRevisionId: 8, priceCents: 1550 }), null, "16")).toMatchObject({
      kind: "start", base: { expectedRevisionId: 8, exact: "15.50" },
    });
    // Another product's draft is not this one's; opening asks first (the provider decides).
    expect(decideSizeEdit(holdingA, productEditorId(12), RULES_B, null, "5")).toMatchObject({ kind: "start" });
  });

  it("shows what is saved now for an unchanged draft, and keeps what was sent while it settles", () => {
    const unchanged = draftFor(BASE_A, "14.99");
    expect(unchanged.changes).toBe(0);
    const moved = sizePrice({ ...EXACT_A, priceCents: 1550 });
    expect(drawerSizeEditState(unchanged, EDITOR, moved).text).toBe("15.50");
    const saving = reduceListingSettingsDraft(draftFor(BASE_A, "12.00"), { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(drawerSizeEditState(saving, EDITOR, moved).text).toBe("12.00");
  });

  it("counts only the price: a moved revision is not a change, and only a price both changed is marked (R:542)", () => {
    let draft = draftFor(BASE_A, "12.00");
    draft = reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k1" } })!;
    const conflict: WriteFailure = { phase: "conflict", message: "This changed in another window.", code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", status: 409 };
    draft = reduceListingSettingsDraft(draft, { type: "failure", key: "k1", failure: conflict })!;
    const mine = readSizePriceDraft(draft.value)!;

    const both = rebaseSizePriceDraft(mine, w9({ revisionId: 8, overridePriceCents: 1300 }));
    let rebased = reduceListingSettingsDraft(draft, { type: "edit", value: sizePriceDraftValue(both.edited) })!;
    rebased = reduceListingSettingsDraft(rebased, { type: "rebase", latest: sizePriceDraftValue(both.latest) })!;
    expect(readSizePriceDraft(rebased.value)).toEqual({ productVariantId: SIZE_A, expectedRevisionId: 8, exact: "12.00" });
    expect(rebased).toMatchObject({ changes: 1, marked: ["exact"], phase: "editing", attempt: null });
    expect(drawerSizeEditState(rebased, EDITOR, EXACT_A).marked).toBe(true);

    const revisionOnly = rebaseSizePriceDraft(mine, w9({ revisionId: 8, overridePriceCents: 1499 }));
    let moved = reduceListingSettingsDraft(draft, { type: "edit", value: sizePriceDraftValue(revisionOnly.edited) })!;
    moved = reduceListingSettingsDraft(moved, { type: "rebase", latest: sizePriceDraftValue(revisionOnly.latest) })!;
    expect(moved).toMatchObject({ changes: 1, marked: [] });

    expect(() => rebaseSizePriceDraft(mine, w9({ productVariantId: SIZE_B }))).toThrow();
    expect(ownSizePriceDraft(rebased, EDITOR)?.value.expectedRevisionId).toBe(8);
    expect(ownSizePriceDraft(rebased, productEditorId(12))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One size's line
// ---------------------------------------------------------------------------

describe("drawerSizeLine", () => {
  const line = (price: ListingSettingsSizePrice, overrides: Partial<Parameters<typeof drawerSizeLine>[0]> = {}) => drawerSizeLine({
    size: size(price),
    stock: DETAIL.stock,
    edit: { text: savedExactText(price), changed: false, waiting: false, marked: false },
    w9: null,
    editable: true,
    locked: false,
    fieldError: null,
    ...overrides,
  });

  it("shows the price, what it is built from, the cost and the stock (R:249)", () => {
    expect(line(RULES_B)).toMatchObject({
      title: "Pack of 100 · EG-SLV-STD-100",
      priceText: "$4.99",
      facts: "Store default: retail $3.99 + 20%, up to .99 · Your cost $2.10 · 40 in stock",
      input: { text: "", readOnly: false, invalid: false, marked: false },
      clear: { shown: false, disabled: false, reason: null },
      pending: null,
      notices: [],
    });
    expect(line(EXACT_A)).toMatchObject({ facts: "Exact price · Your cost $9.80 · 40 in stock", clear: { shown: true, disabled: false } });
  });

  it("leaves out an unknown cost and unread stock", () => {
    const unread = { state: "unavailable" as const, retryable: true, checkedAt: GENERATED_AT };
    expect(sizeFactsLine(size(sizePrice({ costCents: null }), null), unread)).toBe("Store default: retail $12.50 + 20%, up to .99");
    expect(sizeFactsLine(size(sizePrice(), 1240), DETAIL.stock)).toBe("Store default: retail $12.50 + 20%, up to .99 · Your cost $9.80 · 1,240 in stock");
    expect(line(sizePrice({ priceCents: null, source: "none", rule: null, basis: "catalog_retail", basisAmountCents: null, issue: "pricing_basis_unavailable" })).priceText)
      .toBe("No price");
  });

  it("tells a size on its retail price why, and how to fix it (A3, L1)", () => {
    const fallback = sizePrice({ source: "retail_fallback", priceCents: 1250, rule: null, basis: null, basisAmountCents: null, settingRevisionId: 8 });
    expect(line(fallback)).toMatchObject({
      facts: "No pricing rule covers this size, so it uses the retail price ($12.50) · Your cost $9.80 · 40 in stock",
      notices: [{ tone: "warn", text: "Set a store price or type a price." }],
    });
    const tied = line({ ...fallback, issue: "pricing_rule_priority_conflict" });
    expect(tied.facts).toBe("Your pricing rules can't price this size (two older group rules tie), so it uses the retail price ($12.50) · Your cost $9.80 · 40 in stock");
    expect(tied.notices).toEqual([]);
  });

  it("says when the size is paused, and checks the limits against its price", () => {
    const paused = sizePrice({ pausedSince: GENERATED_AT, priceCents: 450,
      limits: [{ policyId: 3, floorCents: 500, ceilingCents: 4000, mode: "block_listing", breached: "below_floor" }] });
    expect(line(paused).notices).toEqual([
      { tone: "warn", text: "Paused on eBay: the price is under your cost. Raise it to start selling again." },
      { tone: "alert", text: "Card Shellz lists this size between $5.00 and $40.00." },
    ]);
  });

  it("shows a typed price against the cost and the store price (R:250-252)", () => {
    const typed = line(EXACT_A, { edit: { text: "14.99", changed: true, waiting: false, marked: false }, w9: w9() });
    expect(typed.pending).toEqual({
      line: "→ $14.99 · Not saved · store default would be $15.99",
      notices: [
        { tone: "info", text: "$14.99 is $5.19 over your cost, before eBay fees and shipping." },
        { tone: "info", text: "An exact price stays the same when your cost changes." },
      ],
    });
    const below = line(RULES_B, { edit: { text: "1.80", changed: true, waiting: false, marked: false } });
    expect(below.pending?.notices[0]).toEqual({ tone: "warn", text: "Below your cost: you'd lose $0.30 on each sale. You can still save it." });
    // An unknown cost drops the margin line.
    const unknown = line(sizePrice({ costCents: null }), { edit: { text: "14.99", changed: true, waiting: false, marked: false } });
    expect(unknown.pending?.notices).toEqual([{ tone: "info", text: "An exact price stays the same when your cost changes." }]);
  });

  it("checks the limits against the typed price", () => {
    const limited = sizePrice({ limits: [{ policyId: 3, floorCents: 500, ceilingCents: 4000, mode: "block_listing", breached: null }] });
    const typed = line(limited, { edit: { text: "45", changed: true, waiting: false, marked: false } });
    expect(typed.notices).toEqual([{ tone: "alert", text: "Card Shellz lists this size between $5.00 and $40.00." }]);
    expect(line(limited).notices).toEqual([]);
  });

  it("checks a bad entry only on Save; until then it just isn't saved", () => {
    const bad = line(EXACT_A, { edit: { text: "14.", changed: true, waiting: false, marked: false } });
    expect(bad.pending).toEqual({ line: "→ Not saved", notices: [] });
    expect(bad.input.invalid).toBe(false);
    const flagged = line(EXACT_A, { edit: { text: "14.", changed: true, waiting: false, marked: false }, fieldError: "Enter a price like 14.99." });
    expect(flagged).toMatchObject({ fieldError: "Enter a price like 14.99.", input: { invalid: true } });
  });

  it("shows what clearing gives, or why it can't (A3, L1)", () => {
    const cleared = { text: "", changed: true, waiting: false, marked: false };
    expect(line(EXACT_A, { edit: cleared }).pending).toEqual({ line: "→ Checking the price above…", notices: [] });
    expect(line(EXACT_A, { edit: cleared, w9: w9() }).pending).toEqual({ line: "→ $15.99 · Not saved · uses the store default", notices: [] });
    const retail = line(EXACT_A, { edit: cleared, w9: w9({ rulePriceCents: null, rulesConfigured: false, ruleName: null }) });
    expect(retail.pending).toEqual({
      line: "→ $12.50 · Not saved · uses the retail price",
      notices: [{ tone: "info", text: "No pricing rule covers this size, so it uses the retail price ($12.50)." }],
    });
    const nothing = line(EXACT_A, { edit: cleared, w9: w9({ rulePriceCents: null, rulesConfigured: false, defaultPriceCents: null }) });
    expect(nothing.pending).toEqual({ line: "→ Not saved", notices: [{ tone: "alert", text: "This size has no retail price, so it needs an exact price." }] });
  });

  it("turns × off with its reason when nothing would price the size", () => {
    const noRetail = w9({ rulePriceCents: null, rulesConfigured: true, defaultPriceCents: null });
    expect(line(EXACT_A, { w9: noRetail }).clear).toEqual({
      shown: true, disabled: true, reason: "The store price can't price this size and it has no retail price, so it needs an exact price.",
    });
    // Read-only boxes never show a reason; the row's reason line says why.
    expect(line(EXACT_A, { w9: noRetail, editable: false }).clear).toEqual({ shown: true, disabled: true, reason: null });
    expect(line(EXACT_A, { locked: true }).input.readOnly).toBe(true);
    expect(line(EXACT_A, { w9: w9() }).clear).toEqual({ shown: true, disabled: false, reason: null });
  });
});

// ---------------------------------------------------------------------------
// Reads (D8, C2)
// ---------------------------------------------------------------------------

describe("sizePriceQueryOptions (D8)", () => {
  const EDITABLE = { editable: true };
  const OFF = { editable: false };

  it("reads only the size in edit, and only while W9 would take a save", () => {
    expect(sizePriceQueryOptions(IDENTITY, { inEdit: true, right: EDITABLE }).enabled).toBe(true);
    expect(sizePriceQueryOptions(IDENTITY, { inEdit: false, right: EDITABLE }).enabled).toBe(false);
    expect(sizePriceQueryOptions(IDENTITY, { inEdit: true, right: OFF }).enabled).toBe(false);
    expect(sizePriceQueryOptions(null, { inEdit: true, right: EDITABLE }).enabled).toBe(false);
  });

  it("shares the older price editor's key and never retries or trusts a cached answer", () => {
    const options = sizePriceQueryOptions(IDENTITY, { inEdit: true, right: EDITABLE });
    expect(options.queryKey).toEqual(["/api/dropship/listings/stores/22/variants/101/price"]);
    expect(sizePriceQueryKey(IDENTITY)).toEqual(options.queryKey);
    expect(options).toMatchObject({ staleTime: 0, retry: false });
  });

  it("reads nothing with no size in edit, even when asked", async () => {
    const options = sizePriceQueryOptions(null, { inEdit: false, right: EDITABLE });
    await expect(options.queryFn({})).rejects.toThrow("No size is in edit.");
  });
});

function fakeQueryClient() {
  const calls: string[] = [];
  const client = {
    cancelQueries: vi.fn(async () => { calls.push("cancel"); }),
    setQueryData: vi.fn(() => { calls.push("set"); return undefined; }),
    invalidateQueries: vi.fn(async () => { calls.push("invalidate"); }),
  };
  return { client: client as unknown as SizePriceQueryClient & typeof client, calls };
}

describe("refreshing after a save (C2, D9)", () => {
  it("cancels, reads with a GET, caches that answer, then refreshes the step's reads", async () => {
    const { client, calls } = fakeQueryClient();
    const fresh = w9({ revisionId: 9, overridePriceCents: 1200 });
    const read = vi.fn(async () => { calls.push("read"); return fresh; });
    await expect(refreshAfterSizePriceSave(client, IDENTITY, read)).resolves.toBe(fresh);
    expect(calls).toEqual(["cancel", "read", "set", "invalidate"]);
    expect(client.cancelQueries).toHaveBeenCalledWith({ queryKey: sizePriceQueryKey(IDENTITY), exact: true });
    expect(client.setQueryData).toHaveBeenCalledWith(sizePriceQueryKey(IDENTITY), fresh);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: listingSettingsQueryKey(STORE) });
  });

  it("throws, and caches nothing, when the GET fails", async () => {
    const { client } = fakeQueryClient();
    await expect(rereadSizePrice(client, IDENTITY, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(client.setQueryData).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Running a save
// ---------------------------------------------------------------------------

/** The provider's save calls on the real reducer, with keys from a counter. */
function reducerDrafts(start: ListingSettingsDraft) {
  let draft: ListingSettingsDraft | null = start;
  let keys = 0;
  const settled: unknown[] = [];
  const drafts: SizePriceSaveDrafts & { current: () => ListingSettingsDraft | null; settled: unknown[] } = {
    startSave: (signature, prefix) => {
      const attempt = nextSaveAttempt(draft, signature, () => `${prefix}:${++keys}`);
      if (attempt === null) return null;
      draft = reduceListingSettingsDraft(draft, { type: "startSave", attempt });
      return attempt.key;
    },
    settle: (key, settlement) => {
      settled.push(settlement);
      draft = settlement.kind === "failure"
        ? reduceListingSettingsDraft(draft, { type: "failure", key, failure: settlement.failure })
        : reduceListingSettingsDraft(draft, { type: "saved", key, nowMs: 1_000, viewStale: settlement.kind === "saved_view_stale" });
    },
    current: () => draft,
    settled,
  };
  return drafts;
}

function run(overrides: Partial<Parameters<typeof runSizePriceSave>[0]> & { exact?: string } = {}) {
  const exact = overrides.exact ?? "12.00";
  const drafts = (overrides.drafts as ReturnType<typeof reducerDrafts> | undefined) ?? reducerDrafts(draftFor(BASE_A, exact));
  const callbacks = { onSaveStarted: vi.fn(), onSaveSettled: vi.fn() };
  const sent: SaveListingPriceInput[] = [];
  const onSaved = vi.fn();
  const onBlocked = vi.fn();
  const input = {
    identity: IDENTITY,
    draft: { ...BASE_A, exact },
    drafts,
    callbacks,
    send: vi.fn(async (body: SaveListingPriceInput) => {
      sent.push(body);
      return { price: w9({ revisionId: 8, overridePriceCents: body.priceCents, pricingMode: body.priceCents === null ? "inherit" : "fixed" }), idempotentReplay: false };
    }),
    refresh: vi.fn(async () => undefined),
    onSaved,
    onBlocked,
    ...overrides,
  };
  return { input, drafts, callbacks, sent, onSaved, onBlocked };
}

describe("runSizePriceSave", () => {
  it("saves a typed price under a ls-price key, re-reads, then tells the step", async () => {
    const setup = run();
    await expect(runSizePriceSave(setup.input)).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(setup.sent).toEqual([{ priceCents: 1200, expectedRevisionId: 7, idempotencyKey: "ls-price:1" }]);
    expect(setup.input.refresh).toHaveBeenCalledTimes(1);
    expect(setup.onSaved).toHaveBeenCalledTimes(1);
    expect(setup.callbacks.onSaveStarted).toHaveBeenCalledTimes(1);
    expect(setup.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    expect(setup.drafts.current()).toMatchObject({ phase: "saved", changes: 0, attempt: null });
  });

  it("sends inherit for × (A3)", async () => {
    const setup = run({ exact: "" });
    await runSizePriceSave(setup.input);
    expect(setup.sent).toEqual([{ priceCents: null, pricingMode: "inherit", expectedRevisionId: 7, idempotencyKey: "ls-price:1" }]);
  });

  it("never caches the PUT answer of a replay; the GET re-read is cached (C2)", async () => {
    const { client } = fakeQueryClient();
    const stalePut = { price: w9({ revisionId: 7, overridePriceCents: 1200 }), idempotentReplay: true };
    const fresh = w9({ revisionId: 11, overridePriceCents: 1200 });
    const setup = run({
      send: vi.fn(async () => stalePut),
      refresh: () => refreshAfterSizePriceSave(client, IDENTITY, async () => fresh),
    });
    await expect(runSizePriceSave(setup.input)).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(client.setQueryData).toHaveBeenCalledTimes(1);
    expect(client.setQueryData).toHaveBeenCalledWith(sizePriceQueryKey(IDENTITY), fresh);
    for (const [, value] of client.setQueryData.mock.calls as unknown as Array<[unknown, unknown]>) {
      expect(value).not.toBe(stalePut);
      expect(value).not.toBe(stalePut.price);
    }
  });

  it("checks the entry first and sends nothing for a bad one", async () => {
    const setup = run({ exact: "14.999" });
    await expect(runSizePriceSave(setup.input)).resolves.toEqual({ kind: "invalid", message: "Enter a price like 14.99." });
    expect(setup.input.send).not.toHaveBeenCalled();
    expect(setup.callbacks.onSaveStarted).not.toHaveBeenCalled();
  });

  it("sends nothing while another listing action runs", async () => {
    const disabled = run({ callbacks: { disabled: true, onSaveStarted: vi.fn(), onSaveSettled: vi.fn() } });
    await expect(runSizePriceSave(disabled.input)).resolves.toEqual({ kind: "not_started", message: DRAWER_WORDS.busy });
    const refused = run({ callbacks: { onSaveStarted: () => { throw new Error("Wait for the current listing action to finish."); }, onSaveSettled: vi.fn() } });
    await expect(runSizePriceSave(refused.input)).resolves.toEqual({ kind: "not_started", message: "Wait for the current listing action to finish." });
    expect(refused.input.send).not.toHaveBeenCalled();
    expect(refused.input.callbacks.onSaveSettled).not.toHaveBeenCalled();
  });

  it("keeps the key after a dropped connection, so Check again sends the same request", async () => {
    let calls = 0;
    const setup = run({ send: vi.fn(async (body: SaveListingPriceInput) => {
      setup.sent.push(body);
      calls += 1;
      if (calls === 1) throw new TypeError("Failed to fetch");
      return { price: w9({ revisionId: 8, overridePriceCents: 1200 }), idempotentReplay: true };
    }) });
    await expect(runSizePriceSave(setup.input)).resolves.toMatchObject({ kind: "failed", failure: { phase: "uncertain" } });
    expect(setup.drafts.current()).toMatchObject({ phase: "uncertain", changes: 1 });
    expect(setup.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
    await expect(runSizePriceSave(setup.input)).resolves.toEqual({ kind: "saved", viewStale: false });
    expect(setup.sent.map((body) => body.idempotencyKey)).toEqual(["ls-price:1", "ls-price:1"]);
    expect(setup.sent[0]).toEqual(setup.sent[1]);
  });

  it("hands a blocked save to the banner and keeps the draft", async () => {
    const blocked = new DropshipApiError({ message: "This store is not available.", status: 403, code: "DROPSHIP_LISTING_STORE_BLOCKED" });
    const setup = run({ send: vi.fn(async () => { throw blocked; }) });
    await expect(runSizePriceSave(setup.input)).resolves.toMatchObject({ kind: "failed", failure: { phase: "blocked" } });
    expect(setup.onBlocked).toHaveBeenCalledWith(blocked);
    expect(setup.drafts.current()).toMatchObject({ phase: "blocked", changes: 1, attempt: null });
    expect(setup.onSaved).not.toHaveBeenCalled();
  });

  it("keeps the server's words for a refused price, with a new key next time", async () => {
    const lost = new DropshipApiError({ message: "This size would be left with no price, so it could not be listed and a live listing would stop getting stock updates. Type an exact price instead.",
      status: 422, code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" });
    const setup = run({ exact: "", send: vi.fn(async () => { throw lost; }) });
    await expect(runSizePriceSave(setup.input)).resolves.toMatchObject({ kind: "failed", failure: { phase: "refused", message: lost.message } });
    expect(setup.drafts.current()).toMatchObject({ phase: "refused", changes: 1, attempt: null, message: lost.message });
  });

  it("calls a conflict a conflict", async () => {
    const conflict = new DropshipApiError({ message: "x", status: 409, code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    const setup = run({ send: vi.fn(async () => { throw conflict; }) });
    await expect(runSizePriceSave(setup.input)).resolves.toMatchObject({ kind: "failed", failure: { phase: "conflict" } });
  });

  it("keeps the draft and key after a rate limit", async () => {
    const limited = new DropshipApiError({ message: "Too many price saves.", status: 429, code: "DROPSHIP_LISTING_PRICE_RATE_LIMITED" });
    const setup = run({ send: vi.fn(async () => { throw limited; }) });
    await expect(runSizePriceSave(setup.input)).resolves.toMatchObject({
      kind: "failed", failure: { phase: "rate_limited", message: "Too many saves in a minute. Wait a moment and try again." },
    });
    expect(setup.drafts.current()?.attempt?.key).toBe("ls-price:1");
  });

  it("still counts a save whose re-read failed, and says so", async () => {
    const setup = run({ refresh: vi.fn(async () => { throw new Error("offline"); }) });
    await expect(runSizePriceSave(setup.input)).resolves.toEqual({ kind: "saved", viewStale: true });
    expect(setup.drafts.current()).toMatchObject({ phase: "saved_view_stale", message: "Saved. We couldn't load the latest view." });
    expect(setup.onSaved).toHaveBeenCalledTimes(1);
  });

  it("treats an off-contract 2xx answer as saved with a stale view, never as data", async () => {
    const setup = run({ send: vi.fn(async () => ({ price: { productVariantId: SIZE_A } })) });
    await expect(runSizePriceSave(setup.input)).resolves.toEqual({ kind: "saved", viewStale: true });
    expect(setup.input.refresh).not.toHaveBeenCalled();
  });

  it("does not start when the draft can't take a save", async () => {
    const drafts = reducerDrafts(draftFor(BASE_A, "12.00"));
    drafts.startSave("busy", "ls-price");
    const setup = run({ drafts });
    await expect(runSizePriceSave(setup.input)).resolves.toEqual({ kind: "not_started", message: null });
    expect(setup.input.send).not.toHaveBeenCalled();
    expect(setup.callbacks.onSaveSettled).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The footer
// ---------------------------------------------------------------------------

describe("drawerFooter", () => {
  const base = { editable: true, busy: false, clear: null, savedFlashVisible: false, compact: false };
  const dirty = draftFor(BASE_A, "12.00");

  it("is quiet with nothing to save", () => {
    expect(drawerFooter({ ...base, draft: null })).toEqual({
      notSaved: null,
      primary: { action: "save", label: "Save product", disabled: true },
      discardDisabled: true,
      message: null,
    });
  });

  it("counts the change and offers Save (R:272, R:451-452)", () => {
    expect(drawerFooter({ ...base, draft: dirty })).toMatchObject({
      notSaved: "● Not saved · 1 change", primary: { action: "save", label: "Save product", disabled: false }, discardDisabled: false,
    });
    expect(drawerFooter({ ...base, draft: dirty, compact: true })).toMatchObject({ notSaved: "● Not saved · 1", primary: { label: "Save" } });
    expect(drawerFooter({ ...base, draft: dirty, editable: false }).primary.disabled).toBe(true);
    expect(drawerFooter({ ...base, draft: dirty, busy: true }).primary.disabled).toBe(true);
  });

  it("takes another wide Save's words, and keeps the phone's \"Save\" (Set for selected, PR 10c plan 6.3)", () => {
    expect(drawerFooter({ ...base, draft: dirty, saveLabel: "Save for 312 products" }).primary).toEqual({ action: "save", label: "Save for 312 products", disabled: false });
    expect(drawerFooter({ ...base, draft: dirty, saveLabel: "Save for 312 products", compact: true }).primary.label).toBe("Save");
    // The price's Save runs the check (PR 10d): a phone says so too when asked, never "Save".
    expect(drawerFooter({ ...base, draft: dirty, saveLabel: "Check new prices", compactSaveLabel: "Check new prices", compact: true }).primary.label).toBe("Check new prices");
    expect(drawerFooter({ ...base, draft: dirty, saveLabel: "Check new prices", compactSaveLabel: "Check new prices" }).primary.label).toBe("Check new prices");
    expect(drawerFooter({ ...base, draft: null, saveLabel: "Save for 1 product" }).primary).toEqual({ action: "save", label: "Save for 1 product", disabled: true });
  });

  it("holds Save for a clear until it is known to price the size", () => {
    expect(drawerFooter({ ...base, draft: dirty, clear: { kind: "checking" } }).primary.disabled).toBe(true);
    expect(drawerFooter({ ...base, draft: dirty, clear: { kind: "off", reason: "x" } }).primary.disabled).toBe(true);
    expect(drawerFooter({ ...base, draft: dirty, clear: { kind: "allowed", priceCents: 1599, line: "", note: null } }).primary.disabled).toBe(false);
  });

  it("follows the save through its phases", () => {
    const saving = reduceListingSettingsDraft(dirty, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(drawerFooter({ ...base, draft: saving })).toMatchObject({ primary: { action: "none", label: "Saving…", disabled: true }, discardDisabled: true });
    const fail = (failure: WriteFailure) => reduceListingSettingsDraft(saving, { type: "failure", key: "k", failure })!;
    const uncertain = fail({ phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null });
    expect(drawerFooter({ ...base, draft: uncertain })).toMatchObject({
      primary: { action: "resend", label: "Check again", disabled: false }, discardDisabled: true,
      message: { text: "We couldn't confirm your save.", tone: "alert" },
    });
    const conflict = fail({ phase: "conflict", message: "This changed in another window.", code: "C", status: 409 });
    expect(drawerFooter({ ...base, draft: conflict })).toMatchObject({
      primary: { action: "load_latest", label: "Load latest and keep my changes" }, message: { text: "This changed in another window." },
    });
    const limited = fail({ phase: "rate_limited", message: "Too many saves in a minute. Wait a moment and try again.", code: "R", status: 429 });
    expect(drawerFooter({ ...base, draft: limited })).toMatchObject({ primary: { action: "save", disabled: false }, message: { tone: "alert" } });
    const refused = fail({ phase: "refused", message: "That price is below the Card Shellz minimum.", code: "O", status: 422 });
    // A refusal is told by the size it was for.
    expect(drawerFooter({ ...base, draft: refused }).message).toBeNull();
    const blocked = fail({ phase: "blocked", message: "Nothing was saved.", code: "B", status: 403 });
    expect(drawerFooter({ ...base, draft: blocked }).message).toEqual({ text: "Nothing was saved.", tone: "alert" });

    const saved = reduceListingSettingsDraft(saving, { type: "saved", key: "k", nowMs: 1_000 })!;
    expect(drawerFooter({ ...base, draft: saved, savedFlashVisible: true })).toMatchObject({
      notSaved: null, primary: { action: "save", disabled: true }, message: { text: "Saved", tone: "status" },
    });
    expect(drawerFooter({ ...base, draft: saved }).message).toBeNull();
    const stale = reduceListingSettingsDraft(saving, { type: "saved", key: "k", nowMs: 1_000, viewStale: true })!;
    expect(drawerFooter({ ...base, draft: stale })).toMatchObject({
      primary: { action: "reload", label: "Reload" }, message: { text: "Saved. We couldn't load the latest view.", tone: "status" },
    });
  });
});

// ---------------------------------------------------------------------------
// The read-only rows (C16, C17)
// ---------------------------------------------------------------------------

describe("drawerSettingRows", () => {
  const rows = drawerSettingRows(DETAIL, SETUP);
  const row = (key: string) => rows.find((entry) => entry.key === key)!;

  it("lists the six rows in the record's order", () => {
    expect(rows.map((entry) => entry.label)).toEqual([
      "Shipping policy", "Return policy", "Payment policy", "eBay category", "Store shelf", "Description",
    ]);
  });

  it("lists each value with the sizes using it when the sizes differ (C16)", () => {
    expect(row("shippingPolicy").groups).toEqual([{
      differ: "Sizes have different values. Each size keeps its own for now.",
      entries: [
        { value: "Free Standard US", tags: ["Store default"], usedBy: "used by Box of 5 Packs of 100" },
        // ship-2 is not among eBay's policies.
        { value: "A policy that's no longer on eBay", tags: ["Set on this size"], usedBy: "used by Pack of 100" },
      ],
    }]);
  });

  it("tags each source (C17) and names values only", () => {
    expect(row("returnPolicy").groups[0]).toEqual({ differ: null, entries: [{ value: "Not set", tags: [], usedBy: null }] });
    expect(row("paymentPolicy").groups[0].entries).toEqual([{ value: "eBay payments", tags: ["Store default"], usedBy: null }]);
    expect(row("ebayCategory").groups[0].entries).toEqual([{ value: "Card Sleeves", tags: ["Card Shellz picks"], usedBy: null }]);
    expect(row("storeShelf").groups[0].entries).toEqual([{ value: "None", tags: [], usedBy: null }]);
    const description = row("descriptionTemplate");
    expect(description.groups).toEqual([
      { differ: null, entries: [{ value: "Card Shellz text, with your text above", tags: ["From your older group rule “Sleeves text”"], usedBy: null }] },
      { differ: null, entries: [{ value: "Main text: Card Shellz text", tags: [], usedBy: null }] },
    ]);
    expect(description.notes).toEqual(["Older group rules come after a product's own settings and before category settings and store defaults."]);
    expect(row("shippingPolicy").notes).toEqual([]);
    expect(JSON.stringify(rows)).not.toMatch(/261328|ship-1|pay-1|DROPSHIP_/);
  });

  it("says Checking eBay… while the setup read loads, and Set when it failed", () => {
    expect(drawerSettingRows(DETAIL, { data: undefined, error: null })[2].groups[0].entries[0].value).toBe("Checking eBay…");
    expect(drawerSettingRows(DETAIL, { data: undefined, error: new Error("x") })[2].groups[0].entries[0].value).toBe("Set");
  });

  it("says when no eBay category is set, and when two older description rules tie", () => {
    const detail = listingSettingsProductDetailSchema.parse({
      ...DETAIL,
      settings: {
        ...DETAIL.settings,
        ebayCategory: [{ value: { categoryId: null, categoryName: null }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
        descriptionTemplate: [{
          value: { hasIntroduction: false, hasFooter: false, groupConflict: true },
          sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }],
        }],
      },
    });
    const next = drawerSettingRows(detail, SETUP);
    expect(next[3].groups[0].entries[0]).toEqual({ value: "No eBay category", tags: [], usedBy: null });
    expect(next[5].groups[0].entries[0].value).toBe("Two older rules tie, so no text is added");
    expect(next[5].notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Editing the rows (PR 10, plan 4.3, 4.4, 4.8; D2, D3, D4)
// ---------------------------------------------------------------------------

describe("the drawer with a product's own settings (PR 10)", () => {
  const OWN: ProductOwnSettings = listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: STORE, productId: PRODUCT, revisionId: 5,
    own: {
      price: null, ebayCategory: null, storeShelf: null,
      shippingPolicy: { id: "ship-9", name: "Fast Free" }, returnPolicy: null, paymentPolicy: { id: "pay-7", name: "Managed payments" },
      textAbove: null, textBelow: null, mainText: null,
    },
    generatedAt: GENERATED_AT,
  });
  // The product's own shipping policy, and a return policy its Card Shellz category sets.
  const EDITED = listingSettingsProductDetailSchema.parse({
    ...DETAIL,
    product: { ...DETAIL.product, sizesDiffer: [] },
    settings: {
      ...DETAIL.settings,
      shippingPolicy: [{ value: { policyId: "ship-9" }, sources: [{ source: "product", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }],
      returnPolicy: [{ value: { policyId: "ret-4" }, sources: [{ source: "category", ruleName: "Sleeves", productVariantIds: [SIZE_A, SIZE_B] }] }],
    },
  });
  const setupFacts: ListingSetupFacts = {
    access: { canEdit: true, reason: null }, revision: 4, checks: { ebay: "checked", fulfillment: { status: "checked" } }, missingFields: [],
  };
  const rights = (overrides: Partial<ListingSettingsRightsInput> = {}) => listingSettingsEditRights({
    account: { status: "active", entitlementStatus: "active" },
    summary: { storeStatus: "connected", catalog: { state: "ok", products: 3, sizes: 9 } },
    setup: { data: setupFacts, error: null },
    shelves: { data: { categories: [] }, error: null },
    blocked: null,
    ...overrides,
  });
  const settingsDraft = (choices: Partial<ProductSettingsChoices>): ListingSettingsDraft => {
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productSettingsDraftValue(OWN) });
    return reduceListingSettingsDraft(opened, { type: "edit", value: productSettingsDraftValue(OWN, { ...emptyChoices(), ...choices }) })!;
  };
  const rowsWith = (edit: Partial<Parameters<typeof drawerSettingRows>[2] & object> = {}, setup = SETUP) => drawerSettingRows(EDITED, setup, {
    own: { data: OWN, error: null }, rights: rights(), draft: null, editor: EDITOR, openField: null, failure: null, ...edit,
  });
  const edit = (rows: ReturnType<typeof drawerSettingRows>, key: string) => rows.find((row) => row.key === key)!.edit!;

  it("gives every row its edit state (10b: the eBay category, the shelf and the description too); none without edit facts", () => {
    const rows = rowsWith();
    expect(rows.map((row) => row.edit?.target ?? null)).toEqual(["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "description"]);
    expect(edit(rows, "shippingPolicy")).toEqual({
      kind: "field", target: "shippingPolicy", field: "shippingPolicy", canSet: true, canDefault: true, canNone: false,
      change: { shown: true, disabled: false }, picksDisabled: false, line: null, open: false, choice: { mode: "leave" }, pending: null, marked: false,
      fieldError: null,
    });
    expect(edit(rows, "ebayCategory")).toMatchObject({ kind: "field", field: "ebayCategory", canSet: true, canNone: false, choice: { mode: "leave" } });
    expect(edit(rows, "storeShelf")).toMatchObject({ kind: "field", field: "storeShelf", canSet: true, canNone: true, choice: { mode: "leave" } });
    expect(edit(rows, "descriptionTemplate")).toEqual({
      kind: "description", target: "description", fields: ["textAbove", "textBelow", "mainText"],
      canSet: true, canDefault: true, canNone: true, change: { shown: true, disabled: false }, picksDisabled: false, line: null, open: false,
      choices: { textAbove: { mode: "leave" }, textBelow: { mode: "leave" }, mainText: { mode: "leave" } },
      pending: null, marked: false, fieldError: null, check: null,
    });
    expect(rows.map((row) => isPolicyRowEdit(row.edit))).toEqual([true, true, true, false, false, false]);
    expect(drawerSettingRows(EDITED, SETUP).every((row) => row.edit === null)).toBe(true);
  });

  it("says where each value comes from, a category by name, and names the product's own policy from its own read", () => {
    const rows = rowsWith({}, { data: undefined, error: new Error("down") });
    expect(rows[0].groups[0].entries).toEqual([{ value: "Fast Free", tags: ["Set for this product"], usedBy: null }]);
    expect(rows[1].groups[0].entries).toEqual([{ value: "Set", tags: ["From category: Sleeves"], usedBy: null }]);
    // eBay read: the product's own policy isn't in eBay's list any more.
    expect(rowsWith()[0].groups[0].entries[0].value).toBe("Fast Free (no longer on eBay)");
    expect(JSON.stringify(rowsWith())).not.toMatch(/ship-9|ret-4|DROPSHIP_/);
  });

  it("keeps [Change] off while the own read loads, and says the failure once for the drawer", () => {
    const loading = edit(rowsWith({ own: { data: undefined, error: null } }), "returnPolicy");
    expect(loading).toMatchObject({ change: { shown: true, disabled: true }, line: "Checking…" });
    const failed = edit(rowsWith({ own: { data: OWN, error: new Error("down") } }), "returnPolicy");
    expect(failed).toMatchObject({ change: { shown: true, disabled: true }, line: null });
    expect(drawerOwnReadProblem(new TypeError("Failed to fetch"), "Marz Cards")).toEqual({ kind: "failed", message: LISTING_SETTINGS_EDIT_WORDS.ownReadFailed });
    const limited = new DropshipApiError({ message: "x", status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED" });
    expect(drawerOwnReadProblem(limited, "Marz Cards")).toEqual({ kind: "rate_limited", message: DRAWER_WORDS.readRateLimited });
    const tooLarge = new DropshipApiError({ message: "x", status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE" });
    expect(drawerOwnReadProblem(tooLarge, "Marz Cards")).toEqual({ kind: "too_large", message: DRAWER_WORDS.readTooLarge });
    const notFound = new DropshipApiError({ message: "x", status: 404, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND" });
    expect(drawerOwnReadProblem(notFound, "Marz Cards").kind).toBe("not_found");
  });

  it("offers only Use default under a sign-in, and nothing under a banner that takes W5 away (D3, D4)", () => {
    const signIn = edit(rowsWith({ rights: rights({ blocked: { kind: "sign_in", diagnosticReference: null } }) }), "paymentPolicy");
    expect(signIn).toMatchObject({ canSet: false, canDefault: true, change: { shown: true, disabled: false }, line: LISTING_SETTINGS_EDIT_WORDS.signInFieldLine });
    const down = edit(rowsWith({ rights: rights({ setup: { error: new DropshipApiError({ message: "x", status: 502, code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE" }) } }) }), "paymentPolicy");
    expect(down).toMatchObject({ canSet: false, canDefault: true, line: "Can't check eBay right now." });
    // eBay refusing access: the banner says why, and the row says only the default is left (the editor lists it alone).
    const denied = rights({ setup: { error: new DropshipApiError({ message: "x", status: 403, code: "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED" }) } });
    for (const field of ["shippingPolicy", "returnPolicy", "paymentPolicy"]) {
      expect(edit(rowsWith({ rights: denied }), field)).toMatchObject({ canSet: false, canDefault: true, change: { shown: true }, line: LISTING_SETTINGS_EDIT_WORDS.defaultOnlyLine });
    }
    for (const account of [{ status: "paused", entitlementStatus: "active" }, { status: "active", entitlementStatus: "lapsed" }]) {
      for (const field of ["shippingPolicy", "returnPolicy", "paymentPolicy"]) {
        expect(edit(rowsWith({ rights: rights({ account }) }), field)).toMatchObject({ canSet: false, canDefault: false, change: { shown: false }, line: null });
      }
    }
  });

  it("shows the draft's choice as not saved, by name, and the default by its word", () => {
    const draft = settingsDraft({ shippingPolicy: { mode: "set", value: { id: "ship-1" } }, paymentPolicy: { mode: "default" } });
    const rows = rowsWith({ draft, openField: "paymentPolicy" });
    expect(edit(rows, "shippingPolicy")).toMatchObject({ choice: { mode: "set", value: { id: "ship-1" } }, pending: "→ Free Standard US · Not saved", open: false });
    expect(edit(rows, "paymentPolicy")).toMatchObject({ choice: { mode: "default" }, pending: "→ Use default · Not saved", open: true });
    expect(edit(rows, "returnPolicy")).toMatchObject({ choice: { mode: "leave" }, pending: null });
    // Once saved, the rows show what the server says, not the draft's choices.
    const sent = reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(edit(rowsWith({ draft: sent }), "shippingPolicy").pending).toBe("→ Free Standard US · Not saved");
    for (const viewStale of [false, true]) {
      const saved = reduceListingSettingsDraft(sent, { type: "saved", key: "k", nowMs: 1_000, viewStale })!;
      expect(edit(rowsWith({ draft: saved }), "shippingPolicy")).toMatchObject({ choice: { mode: "leave" }, pending: null, change: { disabled: false } });
    }
  });

  it("waits for a size's price (D2), and locks while a save is out", () => {
    const size = draftFor(BASE_A, "12.00");
    expect(edit(rowsWith({ draft: size }), "shippingPolicy")).toMatchObject({ change: { shown: true, disabled: true }, line: "Save or discard your other change first." });
    const saving = reduceListingSettingsDraft(settingsDraft({ paymentPolicy: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(edit(rowsWith({ draft: saving }), "shippingPolicy")).toMatchObject({ change: { disabled: true }, line: null });
    // Another product's draft holds nothing of this one.
    expect(edit(rowsWith({ draft: { ...size, editor: productEditorId(12) } }), "shippingPolicy").change.disabled).toBe(false);
  });

  it("marks the fields both windows changed, and puts a refusal on the fields it names", () => {
    const draft = reduceListingSettingsDraft(settingsDraft({ shippingPolicy: { mode: "set", value: { id: "ship-1" } } }), {
      type: "rebase", latest: productSettingsDraftValue(OWN), marked: ["shippingPolicy"],
    })!;
    const rows = rowsWith({ draft, failure: { message: "That policy is no longer on eBay. Pick another one.", fields: ["returnPolicy"] } });
    expect(edit(rows, "shippingPolicy")).toMatchObject({ marked: true, fieldError: null });
    expect(edit(rows, "returnPolicy")).toMatchObject({ marked: false, fieldError: "That policy is no longer on eBay. Pick another one." });
  });

  it("holds a size's price back while the product's settings hold a change (D2)", () => {
    const draft = settingsDraft({ paymentPolicy: { mode: "default" } });
    expect(decideSizeEdit(draft, EDITOR, EXACT_A, null, "12.00")).toEqual({ kind: "wait" });
    expect(drawerSizeEditState(draft, EDITOR, EXACT_A)).toEqual({ text: "14.99", changed: false, waiting: true, marked: false });
    // An unchanged settings draft holds nothing: typing starts a price draft.
    const unchanged = settingsDraft({});
    expect(decideSizeEdit(unchanged, EDITOR, EXACT_A, null, "12.00").kind).toBe("start");
    expect(drawerSizeEditState(unchanged, EDITOR, EXACT_A).waiting).toBe(false);
  });

  it("lands on a row and opens its editor only when its Change would (plan 5.2)", () => {
    expect(drawerLanding(rowsWith(), "descriptionTemplate")).toEqual({ target: "description", open: true });
    expect(drawerLanding(rowsWith(), "storeShelf")).toEqual({ target: "storeShelf", open: true });
    // The own read loads, or a size's price waits: the drawer only goes to the row.
    expect(drawerLanding(rowsWith({ own: { data: undefined, error: null } }), "descriptionTemplate")).toEqual({ target: "description", open: false });
    expect(drawerLanding(rowsWith({ draft: draftFor(BASE_A, "12.00") }), "descriptionTemplate")).toEqual({ target: "description", open: false });
    // W5 taken away: nothing can be chosen, so it doesn't open.
    expect(drawerLanding(rowsWith({ rights: rights({ account: { status: "paused", entitlementStatus: "active" } }) }), "descriptionTemplate"))
      .toEqual({ target: "description", open: false });
    // Rows without edit facts (PR 7): nowhere to land.
    expect(drawerLanding(drawerSettingRows(DETAIL, SETUP), "descriptionTemplate")).toBeNull();
  });

  it("shows the opened field's editor only while its row offers a choice and the own read is there", () => {
    expect(shownFieldEditor(rowsWith(), "returnPolicy", true)).toBe("returnPolicy");
    expect(shownFieldEditor(rowsWith(), null, true)).toBeNull();
    // The own read failed on a refetch, or a banner took W5 away: it closes.
    expect(shownFieldEditor(rowsWith(), "returnPolicy", false)).toBeNull();
    expect(shownFieldEditor(rowsWith({ rights: rights({ account: { status: "paused", entitlementStatus: "active" } }) }), "returnPolicy", true)).toBeNull();
    // A row 10a doesn't edit has no editor.
    expect(shownFieldEditor([{ edit: null }], "returnPolicy", true)).toBeNull();
    // A size's price typed meanwhile keeps it open, so Done can say why it waits (D2).
    expect(shownFieldEditor(rowsWith({ draft: draftFor(BASE_A, "12.00") }), "returnPolicy", true)).toBe("returnPolicy");
  });

  it("holds Save while a field editor is open, and says so once the draft holds a change", () => {
    const base = { editable: true, busy: false, clear: null, savedFlashVisible: false, compact: false, fieldEditorOpen: true };
    const draft = settingsDraft({ paymentPolicy: { mode: "default" } });
    expect(drawerFooter({ ...base, draft })).toMatchObject({
      primary: { action: "save", disabled: true }, discardDisabled: false, message: { text: LISTING_SETTINGS_EDIT_WORDS.finishEditorFirst, tone: "status" },
    });
    // Nothing to save yet: Save is off anyway, and nothing needs saying.
    expect(drawerFooter({ ...base, draft: null })).toMatchObject({ primary: { disabled: true }, message: null });
    // A size's price typed while the editor is open waits the same way.
    expect(drawerFooter({ ...base, draft: draftFor(BASE_A, "12.00") })).toMatchObject({ primary: { disabled: true }, message: { text: LISTING_SETTINGS_EDIT_WORDS.finishEditorFirst } });
    // Closed, Save is back; the PR 7 footer is the same without the flag.
    expect(drawerFooter({ ...base, draft, fieldEditorOpen: false })).toMatchObject({ primary: { disabled: false }, message: null });
    const sent = reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    const conflict = reduceListingSettingsDraft(sent, { type: "failure", key: "k",
      failure: { phase: "conflict", message: "This changed in another window.", code: "C", status: 409, fields: [] } })!;
    expect(drawerFooter({ ...base, draft: conflict }).primary).toMatchObject({ action: "load_latest", disabled: true });
  });

  it("works out which writer the draft is for, the right the footer saves with, and what Esc does (D2, plan 3.4)", () => {
    const allowed = { editable: true as const, reason: null };
    const off = { editable: false as const, reason: "banner" as const };
    const state = (draft: ListingSettingsDraft | null, overrides: Partial<Parameters<typeof drawerDraftState>[0]> = {}) =>
      drawerDraftState({ draft, editor: EDITOR, rights: { exactPrice: allowed, productSettings: off }, failure: null, ...overrides });
    expect(state(null)).toEqual({ writer: "W9", footerDraft: null, editable: true, settingsHoldChange: false, priceHoldsChange: false, showRefusal: false, escapeKeepsOpen: false });
    const size = draftFor(BASE_A, "12.00");
    expect(state(size)).toEqual({ writer: "W9", footerDraft: size, editable: true, settingsHoldChange: false, priceHoldsChange: false, showRefusal: false, escapeKeepsOpen: false });
    const settings = settingsDraft({ paymentPolicy: { mode: "default" } });
    expect(state(settings)).toEqual({ writer: "W5", footerDraft: settings, editable: false, settingsHoldChange: true, priceHoldsChange: false, showRefusal: true, escapeKeepsOpen: false });
    // An unchanged settings draft is still W5's, but holds no size back.
    expect(state(settingsDraft({}))).toMatchObject({ writer: "W5", settingsHoldChange: false });
    // A refusal that names a row is told there, not in the footer.
    expect(state(settings, { failure: { fields: ["returnPolicy"] } }).showRefusal).toBe(false);
    expect(state(settings, { failure: { fields: ["price"] } }).showRefusal).toBe(true);
    // Out or unconfirmed: Esc keeps the drawer, and the sizes still wait. A size's price keeps PR 7's Esc.
    const saving = reduceListingSettingsDraft(settings, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(state(saving)).toMatchObject({ writer: "W5", settingsHoldChange: true, escapeKeepsOpen: true });
    const uncertain = reduceListingSettingsDraft(saving, { type: "failure", key: "k",
      failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null, fields: [] } })!;
    expect(state(uncertain).escapeKeepsOpen).toBe(true);
    const sizeSaving = reduceListingSettingsDraft(size, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(state(sizeSaving)).toMatchObject({ writer: "W9", escapeKeepsOpen: false });
    // Another product's draft or another editor's is not this drawer's.
    expect(state({ ...settings, editor: productEditorId(12) })).toEqual(state(null));
  });

  it("tells a settings refusal that names no field in the footer, when asked", () => {
    const saving = reduceListingSettingsDraft(settingsDraft({ paymentPolicy: { mode: "default" } }), { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    const refused = reduceListingSettingsDraft(saving, { type: "failure", key: "k", failure: { phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.fatal, code: "F", status: 500 } })!;
    const base = { editable: true, busy: false, clear: null, savedFlashVisible: false, compact: false };
    expect(drawerFooter({ ...base, draft: refused }).message).toBeNull();
    expect(drawerFooter({ ...base, draft: refused, showRefusal: true }).message).toEqual({ text: LISTING_SETTINGS_EDIT_WORDS.fatal, tone: "alert" });
    expect(drawerFooter({ ...base, draft: refused, showRefusal: true }).primary).toMatchObject({ action: "save", label: "Save product", disabled: false });
  });

  // -------------------------------------------------------------------------
  // 10b: the eBay category, the shelf and the description (plan 5.2-5.6)
  // -------------------------------------------------------------------------

  /** Own values for every 10b row; its main text needs a check since Card Shellz changed the product. */
  const OWN_10B: ProductOwnSettings = listingSettingsProductOwnSettingsSchema.parse({
    ...OWN,
    revisionId: 6,
    own: {
      ...OWN.own,
      ebayCategory: { categoryId: "183454", categoryName: "Card Sleeves" },
      storeShelf: { mode: "own", shelves: [{ id: "S1", name: "Sleeves" }] },
      textAbove: { mode: "own", text: "Ships in 1 day." },
      mainText: { text: "Our own words.", needsCheck: true },
    },
  });
  const draftOn = (base: ProductOwnSettings, choices: Partial<ProductSettingsChoices>): ListingSettingsDraft => {
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productSettingsDraftValue(base) });
    return reduceListingSettingsDraft(opened, { type: "edit", value: productSettingsDraftValue(base, { ...emptyChoices(), ...choices }) })!;
  };
  const SHELVES = [{ categoryId: "S3", categoryName: "Toploaders", path: "Supplies:Toploaders", level: 2 }];
  const descriptionOf = (rows: ReturnType<typeof drawerSettingRows>) => {
    const model = edit(rows, "descriptionTemplate");
    if (model.kind !== "description") throw new Error("The description row has the description's edit.");
    return model;
  };

  it("offers the default (and None) but no new eBay category or shelf under a sign-in, and keeps text whole (D4)", () => {
    const rows = rowsWith({ own: { data: OWN_10B, error: null }, rights: rights({ blocked: { kind: "sign_in", diagnosticReference: null } }) });
    expect(edit(rows, "ebayCategory")).toMatchObject({ canSet: false, canDefault: true, canNone: false, change: { shown: true }, line: LISTING_SETTINGS_EDIT_WORDS.signInFieldLine });
    expect(edit(rows, "storeShelf")).toMatchObject({ canSet: false, canDefault: true, canNone: true, change: { shown: true }, line: LISTING_SETTINGS_EDIT_WORDS.signInFieldLine });
    expect(edit(rows, "descriptionTemplate")).toMatchObject({ canSet: true, canDefault: true, canNone: true, line: null });
    // The shelves can't be read: the shelf row says so; the category picker reads eBay itself.
    const shelvesDown = rowsWith({ rights: rights({ shelves: { error: new DropshipApiError({ message: "x", status: 502, code: "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE" }) } }) });
    expect(edit(shelvesDown, "storeShelf")).toMatchObject({ canSet: false, canDefault: true, line: "Can't check eBay right now." });
    // A paused vendor (or inactive .ops) takes W5 away: no row can be changed, the shelf included (C16).
    const paused = rowsWith({ rights: rights({ account: { status: "paused", entitlementStatus: "active" } }) });
    for (const key of ["ebayCategory", "storeShelf", "descriptionTemplate"]) {
      expect(edit(paused, key)).toMatchObject({ canSet: false, canDefault: false, canNone: false, change: { shown: false }, line: null });
    }
  });

  it("names the draft's eBay category, shelves and text parts in their pending lines, never an id or the text", () => {
    const draft = draftOn(OWN_10B, {
      ebayCategory: { mode: "set", value: { categoryId: "261328", categoryName: "Toploaders" } },
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S3", "S1"] } },
      textAbove: { mode: "set", value: { mode: "none" } },
      textBelow: { mode: "set", value: { mode: "own", text: "Thanks for buying!" } },
      mainText: { mode: "default" },
    });
    const rows = rowsWith({ own: { data: OWN_10B, error: null }, draft, shelves: SHELVES, openField: "description" });
    expect(edit(rows, "ebayCategory")).toMatchObject({ choice: { mode: "set", value: { categoryId: "261328" } }, pending: "→ Toploaders · Not saved" });
    // The new shelf by its path from the shelves read, the product's own by the name it stored.
    expect(edit(rows, "storeShelf").pending).toBe("→ Supplies › Toploaders · second: Sleeves · Not saved");
    expect(edit(rows, "descriptionTemplate")).toMatchObject({
      open: true,
      choices: { textAbove: { mode: "set", value: { mode: "none" } }, mainText: { mode: "default" } },
      pending: "→ Text above: None, text below: your own, main text: Card Shellz text · Not saved",
      // The draft answers the main text's check, so the check steps back.
      check: null,
    });
    expect(JSON.stringify(rows.map((row) => row.edit?.pending))).not.toMatch(/261328|S3|Thanks for buying/);
    // A shelf the read doesn't know, the default and None.
    const other = rowsWith({ own: { data: OWN_10B, error: null }, draft: draftOn(OWN_10B, {
      storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S9"] } }, ebayCategory: { mode: "default" },
    }) });
    expect(edit(other, "storeShelf").pending).toBe("→ A shelf · Not saved");
    expect(edit(other, "ebayCategory").pending).toBe("→ Use default · Not saved");
    const none = rowsWith({ own: { data: OWN_10B, error: null }, draft: draftOn(OWN_10B, { storeShelf: { mode: "set", value: { mode: "none" } } }) });
    expect(edit(none, "storeShelf").pending).toBe("→ None · Not saved");
    // The product's own category picked again by its number alone is named from the own read.
    const again = rowsWith({ own: { data: OWN_10B, error: null }, draft: draftOn(OWN_10B, {
      ebayCategory: { mode: "set", value: { categoryId: "183454" } }, textAbove: { mode: "default" },
    }) });
    expect(edit(again, "ebayCategory").pending).toBeNull();
    expect(edit(again, "descriptionTemplate").pending).toBe("→ Text above: Use default · Not saved");
  });

  it("asks the main text's check on the Description row while it needs one and can be answered (5.4)", () => {
    expect(descriptionOf(rowsWith({ own: { data: OWN_10B, error: null } })).check)
      .toEqual({ keep: { mode: "set", value: { text: "Our own words." } }, useCardShellz: { mode: "default" } });
    expect(descriptionOf(rowsWith()).check).toBeNull();
    expect(descriptionOf(rowsWith({ own: { data: OWN_10B, error: null }, rights: rights({ account: { status: "active", entitlementStatus: "lapsed" } }) })).check)
      .toBeNull();
    const kept = draftOn(OWN_10B, { mainText: { mode: "set", value: { text: "Our own words." } } });
    expect(edit(rowsWith({ own: { data: OWN_10B, error: null }, draft: kept }), "descriptionTemplate"))
      .toMatchObject({ check: null, pending: "→ Main text: your own · Not saved" });
  });

  it("offers only [Use Card Shellz text] on the row while a size keeps its own main text, which a keep would delete (review CE1)", () => {
    const detail = listingSettingsProductDetailSchema.parse({
      ...EDITED,
      product: { ...EDITED.product, ownSettings: [...EDITED.product.ownSettings, "description"], sizesDiffer: ["description"] },
      settings: { ...EDITED.settings, mainText: [
        { value: { own: true }, sources: [{ source: "product", ruleName: null, productVariantIds: [SIZE_A] }] },
        { value: { own: true }, sources: [{ source: "size", ruleName: null, productVariantIds: [SIZE_B] }] },
      ] },
    });
    const rows = drawerSettingRows(detail, SETUP, { own: { data: OWN_10B, error: null }, rights: rights(), draft: null, editor: EDITOR, openField: null, failure: null });
    expect(edit(rows, "descriptionTemplate")).toMatchObject({ kind: "description", check: { keep: null, useCardShellz: { mode: "default" } } });
    // The row's [Change] picks one text for all sizes instead (5.3's line).
    expect(rows.find((row) => row.key === "descriptionTemplate")!.groups[1].differ).toBe("Sizes differ. Use Change to pick one for all sizes.");
  });

  it("puts eBay's category and shelf refusals on their rows, and the store text cap in the footer (rows 19-21)", () => {
    const category = rowsWith({ failure: { message: "Pick a final eBay category.", fields: ["ebayCategory"] } });
    expect(edit(category, "ebayCategory").fieldError).toBe("Pick a final eBay category.");
    expect(edit(category, "storeShelf").fieldError).toBeNull();
    const shelf = rowsWith({ failure: { message: "That shelf is gone from your eBay store.", fields: ["storeShelf"] } });
    expect(edit(shelf, "storeShelf").fieldError).toBe("That shelf is gone from your eBay store.");
    const text = rowsWith({ failure: { message: LISTING_SETTINGS_EDIT_WORDS.textEmpty, fields: ["textBelow"] } });
    expect(edit(text, "descriptionTemplate").fieldError).toBe(LISTING_SETTINGS_EDIT_WORDS.textEmpty);
    const draft = draftOn(OWN_10B, { ebayCategory: { mode: "set", value: { categoryId: "99" } } });
    const state = (fields: string[]) => drawerDraftState({ draft, editor: EDITOR, rights: rights(), failure: { fields } }).showRefusal;
    expect(state(["ebayCategory"])).toBe(false);
    expect(state(["storeShelf"])).toBe(false);
    expect(state(["mainText"])).toBe(false);
    // The store text cap names no field: the footer says it (D8, never the banner).
    expect(state([])).toBe(true);
    // A row's marked line after Load latest names its fields.
    const marked = reduceListingSettingsDraft(draftOn(OWN_10B, { textAbove: { mode: "default" } }), {
      type: "rebase", latest: productSettingsDraftValue(OWN_10B), marked: ["textAbove"],
    })!;
    expect(edit(rowsWith({ own: { data: OWN_10B, error: null }, draft: marked }), "descriptionTemplate").marked).toBe(true);
    expect(edit(rowsWith({ own: { data: OWN_10B, error: null }, draft: marked }), "storeShelf").marked).toBe(false);
  });

  it("shows the Description editor while its row offers a choice, as the field editors", () => {
    expect(shownFieldEditor(rowsWith(), "description", true)).toBe("description");
    expect(shownFieldEditor(rowsWith(), "ebayCategory", true)).toBe("ebayCategory");
    expect(shownFieldEditor(rowsWith({ rights: rights({ account: { status: "paused", entitlementStatus: "active" } }) }), "description", true)).toBeNull();
  });

  // "Sizes differ" in the rows (plan 5.3): DETAIL's shipping policy differs, store default on one size, a leftover on the other.
  // SETUP doesn't list the leftover's ship-2; SETUP_SHIP_2 lists it, working with Card Shellz shipping.
  const SETUP_SHIP_2: ListingSettingsReadState<PolicySetupFacts> = { error: null, data: { ...SETUP.data!, options: { ...SETUP.data!.options,
    fulfillmentPolicies: [...SETUP.data!.options.fulfillmentPolicies, { id: "ship-2", name: "Economy", compatible: true, compatibilityIssues: [] }] } } };
  const differRows = (edit: Partial<Parameters<typeof drawerSettingRows>[2] & object> = {}, setup = SETUP_SHIP_2) => drawerSettingRows(DETAIL, setup, {
    own: { data: OWN, error: null }, rights: rights(), draft: null, editor: EDITOR, openField: null, failure: null, ...edit,
  });

  it("puts a quick pick beside each value whose sizes differ, with the line over them (5.3)", () => {
    const shipping = differRows()[0].groups[0];
    expect(shipping.differ).toBe("Sizes differ. Pick one for all sizes.");
    expect(shipping.entries.map((entry) => entry.pick)).toEqual([
      { action: "use_default", label: "Use default for all sizes", field: "shippingPolicy", picks: { shippingPolicy: { mode: "default" } }, disabled: false },
      { action: "use_this", label: "Use for all sizes", field: "shippingPolicy", picks: { shippingPolicy: { mode: "set", value: { id: "ship-2" } } }, disabled: false },
    ]);
    // A policy no longer on eBay gets no "Use for all sizes": its editor wouldn't take it, and the Save would be refused (review CE3).
    expect(differRows({}, SETUP)[0].groups[0].entries.map((entry) => entry.pick?.action ?? null)).toEqual(["use_default", null]);
    // Rows whose sizes agree have none.
    expect(differRows()[1].groups[0]).toEqual({ differ: null, entries: [{ value: "Not set", tags: [], usedBy: null }] });
    // Without edit facts, PR 7's words and no pick.
    expect(drawerSettingRows(DETAIL, SETUP)[0].groups[0].differ).toBe("Sizes have different values. Each size keeps its own for now.");
    expect(drawerSettingRows(DETAIL, SETUP)[0].groups[0].entries.every((entry) => entry.pick === undefined)).toBe(true);
  });

  it("hides Use for all sizes under a sign-in, waits as [Change] does, and drops every pick when nothing can change (D4, D2)", () => {
    const signIn = differRows({ rights: rights({ blocked: { kind: "sign_in", diagnosticReference: null } }) })[0].groups[0];
    expect(signIn.entries.map((entry) => entry.pick?.label ?? null)).toEqual(["Use default for all sizes", null]);
    expect(signIn.differ).toBe("Sizes differ. Pick one for all sizes.");
    const loading = differRows({ own: { data: undefined, error: null } })[0].groups[0];
    expect(loading.entries.map((entry) => entry.pick?.disabled)).toEqual([true, true]);
    const waiting = differRows({ draft: draftFor(BASE_A, "12.00") })[0].groups[0];
    expect(waiting.entries.map((entry) => entry.pick?.disabled)).toEqual([true, true]);
    const paused = differRows({ rights: rights({ account: { status: "paused", entitlementStatus: "active" } }) })[0].groups[0];
    expect(paused.entries.every((entry) => entry.pick === undefined)).toBe(true);
    expect(paused.differ).toBe("Sizes have different values. Each size keeps its own for now.");
  });

  it("turns the quick picks off while any row's editor is open, so its Done can't override them unseen (review UX4)", () => {
    for (const openField of ["shippingPolicy", "returnPolicy", "description"] as const) {
      const rows = differRows({ openField });
      expect(rows[0].groups[0].entries.map((entry) => entry.pick?.disabled)).toEqual([true, true]);
      expect(rows.every((row) => row.edit?.picksDisabled === true)).toBe(true);
      // [Change] keeps its 10a behaviour: another row's opens that row's editor.
      expect(rows[0].edit?.change.disabled).toBe(false);
    }
    expect(differRows()[0].edit?.picksDisabled).toBe(false);
  });

  it("names a stored shelf in the record's words, in the row and in a pending pick (R:581)", () => {
    const detail = listingSettingsProductDetailSchema.parse({
      ...DETAIL,
      product: { ...DETAIL.product, ownSettings: ["shipping_policy", "store_shelf"] },
      settings: { ...DETAIL.settings,
        storeShelf: [{ value: { names: ["Supplies:Sleeves", "Sale"] }, sources: [{ source: "product", ruleName: null, productVariantIds: [SIZE_A, SIZE_B] }] }] },
    });
    const shelfRow = (edit: Parameters<typeof drawerSettingRows>[2] = null) => drawerSettingRows(detail, SETUP, edit).find((row) => row.key === "storeShelf")!;
    expect(shelfRow().groups[0].entries[0].value).toBe("Supplies › Sleeves · second: Sale");
    const own = listingSettingsProductOwnSettingsSchema.parse({ ...OWN, revisionId: 3,
      own: { ...OWN.own, storeShelf: { mode: "own", shelves: [{ id: "S1", name: "Supplies:Sleeves" }, { id: "S2", name: "Sale" }] } } });
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "x", base: productSettingsDraftValue(own) });
    const draft = reduceListingSettingsDraft(opened, { type: "edit",
      value: productSettingsDraftValue(own, { ...emptyChoices(), storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S2", "S1"] } } }) })!;
    const edit = shelfRow({ own: { data: own, error: null }, rights: rights(), draft, editor: EDITOR, openField: null, failure: null }).edit!;
    expect(edit.pending).toBe("→ Sale · second: Supplies › Sleeves · Not saved");
  });

  it("gives the shelf and the description only the line (5.3)", () => {
    const detail = listingSettingsProductDetailSchema.parse({
      ...DETAIL,
      product: { ...DETAIL.product, ownSettings: ["shipping_policy", "store_shelf", "description"], sizesDiffer: ["shipping_policy", "store_shelf", "description"] },
      settings: {
        ...DETAIL.settings,
        storeShelf: [
          { value: { names: ["Sleeves"] }, sources: [{ source: "size", ruleName: null, productVariantIds: [SIZE_A] }] },
          { value: { names: [] }, sources: [{ source: "none", ruleName: null, productVariantIds: [SIZE_B] }] },
        ],
        mainText: [
          { value: { own: true }, sources: [{ source: "size", ruleName: null, productVariantIds: [SIZE_A] }] },
          { value: { own: false }, sources: [{ source: "catalog", ruleName: null, productVariantIds: [SIZE_B] }] },
        ],
      },
    });
    const rows = drawerSettingRows(detail, SETUP, { own: { data: OWN, error: null }, rights: rights(), draft: null, editor: EDITOR, openField: null, failure: null });
    const shelf = rows.find((row) => row.key === "storeShelf")!.groups[0];
    expect(shelf.differ).toBe("Sizes differ. Use Change to pick one for all sizes.");
    expect(shelf.entries.every((entry) => entry.pick === undefined)).toBe(true);
    const description = rows.find((row) => row.key === "descriptionTemplate")!;
    expect(description.groups.map((group) => group.differ)).toEqual([null, "Sizes differ. Use Change to pick one for all sizes."]);
    // "Main text: your own", never "set in step 3" (5.7).
    expect(description.groups[1].entries[0].value).toBe("Main text: your own");
    expect(JSON.stringify(rows)).not.toContain("set in step 3");
  });
});

// ---------------------------------------------------------------------------
// The product's price (PR 10d, plan 7.2, D2, UX-M7)
// ---------------------------------------------------------------------------

describe("the product's price in the drawer (PR 10d, plan 7.2, D2, UX-M7)", () => {
  const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 0, rounding: "cent" };
  const PRODUCT_RULE = { kind: "product" as const, name: "Easy Glide Soft Sleeves", recipe: COST_35 };
  const CATEGORY_RULE = { kind: "category" as const, name: "Sleeves", recipe: RETAIL_20_UP };
  const GROUP_RULE = { kind: "group" as const, name: "Envelopes", recipe: COST_35 };
  const STORE_RULE = { kind: "store_default" as const, name: "Store default rule", recipe: COST_35 };
  const OWN_PRICE: ProductOwnSettings = listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: STORE, productId: PRODUCT, revisionId: 5,
    own: { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null },
    generatedAt: GENERATED_AT,
  });
  const allowed = { editable: true as const, reason: null };
  const setupFacts: ListingSetupFacts = {
    access: { canEdit: true, reason: null }, revision: 4, checks: { ebay: "checked", fulfillment: { status: "checked" } }, missingFields: [],
  };
  const rights = () => listingSettingsEditRights({
    account: { status: "active", entitlementStatus: "active" },
    summary: { storeStatus: "connected", catalog: { state: "ok", products: 3, sizes: 9 } },
    setup: { data: setupFacts, error: null }, shelves: { data: { categories: [] }, error: null }, blocked: null,
  });
  const priceDraft = (change: { price: { mode: "leave" } | { mode: "default" } | { mode: "set"; value: PricingRecipe }; releaseExactPrices: boolean }) => {
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productPriceDraftValue(OWN_PRICE) });
    return reduceListingSettingsDraft(opened, { type: "edit", value: productPriceDraftValue(OWN_PRICE, { ...change, check: null }) })!;
  };

  it("names the level that prices the product in the PRICE head, one case per level (UX-M7)", () => {
    expect(priceHeadWords(RETAIL_20_UP, PRODUCT_RULE)).toBe("This product: Your cost + 35%, to the cent");
    expect(priceHeadWords(RETAIL_20_UP, CATEGORY_RULE)).toBe("Sleeves: Retail price + 20%, round up to .99");
    // The level the sizes show wins over the summary's state: no "Checking…" or "No store price" while a level prices them.
    expect(priceHeadWords(undefined, CATEGORY_RULE)).toBe("Sleeves: Retail price + 20%, round up to .99");
    expect(priceHeadWords(null, PRODUCT_RULE)).toBe("This product: Your cost + 35%, to the cent");
    // A group rule or the store default is not a level of the product's: the store default recipe, as before.
    expect(priceHeadWords(RETAIL_20_UP, GROUP_RULE)).toBe("Store default: Retail price + 20%, round up to .99");
    expect(priceHeadWords(RETAIL_20_UP, STORE_RULE)).toBe("Store default: Retail price + 20%, round up to .99");
    expect(priceHeadWords(RETAIL_20_UP, null)).toBe(priceHeadWords(RETAIL_20_UP));
    expect(priceHeadWords(RETAIL_20_UP, { ...CATEGORY_RULE, name: "  " })).toBe("Category: Retail price + 20%, round up to .99");
  });

  it("finds the level from the sizes: the product's own price first, then its category's, else none", () => {
    const categorySize = size(sizePrice({ ...RULES_B, rule: CATEGORY_RULE }));
    const productSize = size(sizePrice({ ...RULES_B, productVariantId: 103, rule: PRODUCT_RULE }));
    expect(productPriceHeadRule([size(EXACT_A), categorySize])).toEqual(CATEGORY_RULE);
    expect(productPriceHeadRule([size(EXACT_A), categorySize, productSize])).toEqual(PRODUCT_RULE);
    expect(productPriceHeadRule([productSize, categorySize])).toEqual(PRODUCT_RULE);
    expect(productPriceHeadRule([size(EXACT_A)])).toBeNull();
    expect(productPriceHeadRule([size(sizePrice({ ...RULES_B, rule: GROUP_RULE }))])).toBeNull();
    expect(productPriceHeadRule([size(sizePrice({ ...RULES_B, rule: STORE_RULE }))])).toBeNull();
    expect(productPriceHeadRule([])).toBeNull();
  });

  it("says what a size would cost by the level that prices it, one case per level (UX-M7)", () => {
    expect(wouldBeWords(w9())).toBe("store default would be $15.99");
    expect(wouldBeWords(w9({ ruleName: "Envelopes" }))).toBe("your older group rule “Envelopes” would give $15.99");
    expect(wouldBeWords(w9({ ruleName: "Easy Glide Soft Sleeves", ruleLevel: "product" }))).toBe("this product's price would be $15.99");
    expect(wouldBeWords(w9({ ruleName: "Sleeves", ruleLevel: "category" }))).toBe("the Sleeves price would be $15.99");
    expect(wouldBeWords(w9({ rulePriceCents: null, rulesConfigured: false, ruleName: null }))).toBe("retail price would be $12.50");
    // The level decides, never the name; the category is named from the product detail when given, else as W9 names it.
    expect(wouldBeWords(w9({ ruleName: "Store default rule", ruleLevel: "product" }))).toBe("this product's price would be $15.99");
    expect(wouldBeWords(w9({ ruleName: "Old name", ruleLevel: "category" }), DETAIL.product)).toBe("the Sleeves price would be $15.99");
    expect(wouldBeWords(w9({ ruleName: "Old name", ruleLevel: "category" }), { category: null })).toBe("the Old name price would be $15.99");
    expect(wouldBeWords(w9({ ruleName: null, ruleLevel: "category" }), { category: null })).toBe("the Category price would be $15.99");
    // A rule price a blocking limit refuses falls back to retail, whatever its level.
    expect(wouldBeWords(w9({ ruleLevel: "product", pricingIssue: "pricing_rule_outside_limit" }))).toBe("retail price would be $12.50");
    expect(typedPriceLine(1499, w9({ ruleName: "Sleeves", ruleLevel: "category" }), DETAIL.product)).toBe("→ $14.99 · Not saved · the Sleeves price would be $15.99");
    expect(typedPriceLine(1499, w9({ ruleLevel: "product" }))).toBe("→ $14.99 · Not saved · this product's price would be $15.99");
  });

  it("holds the product's price as its own kind of change: the rows and the sizes wait, the footer is W7's (D2, 7.6)", () => {
    const draft = priceDraft({ price: { mode: "set", value: COST_35 }, releaseExactPrices: false });
    expect(draft.changes).toBe(1);
    const rows = drawerSettingRows(DETAIL, SETUP, { own: { data: OWN_PRICE, error: null }, rights: rights(), draft, editor: EDITOR, openField: null, failure: null });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.edit).toMatchObject({ change: { shown: true, disabled: true }, picksDisabled: true, line: LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst });
    }
    expect(drawerSizeEditState(draft, EDITOR, EXACT_A)).toEqual({ text: "14.99", changed: false, waiting: true, marked: false });
    expect(decideSizeEdit(draft, EDITOR, EXACT_A, null, "12")).toEqual({ kind: "wait" });
    const state = (held: ListingSettingsDraft, priceCheck: ListingSettingsRight = allowed) =>
      drawerDraftState({ draft: held, editor: EDITOR, rights: { exactPrice: allowed, productSettings: allowed, priceCheck }, failure: null });
    expect(state(draft)).toEqual({ writer: "W7", footerDraft: draft, editable: true, settingsHoldChange: false, priceHoldsChange: true, showRefusal: true, escapeKeepsOpen: false });
    // W7's right decides the footer; a caller without it can't save a price.
    expect(state(draft, { editable: false, reason: "banner" })).toMatchObject({ writer: "W7", editable: false });
    expect(drawerDraftState({ draft, editor: EDITOR, rights: { exactPrice: allowed, productSettings: allowed }, failure: null })).toMatchObject({ writer: "W7", editable: false });
    // A clean price draft holds nothing back.
    const clean = priceDraft({ price: { mode: "leave" }, releaseExactPrices: false });
    expect(state(clean)).toMatchObject({ writer: "W7", priceHoldsChange: false, settingsHoldChange: false });
    expect(drawerSizeEditState(clean, EDITOR, EXACT_A).waiting).toBe(false);
    expect(drawerSettingRows(DETAIL, SETUP, { own: { data: OWN_PRICE, error: null }, rights: rights(), draft: clean, editor: EDITOR, openField: null, failure: null })
      .every((row) => row.edit?.change.disabled === false)).toBe(true);
    // Out or unconfirmed: Esc keeps the drawer (3.4), and everything still waits.
    const saving = reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(state(saving)).toMatchObject({ writer: "W7", priceHoldsChange: true, escapeKeepsOpen: true });
    expect(drawerSizeEditState(saving, EDITOR, EXACT_A).waiting).toBe(true);
    const uncertain = reduceListingSettingsDraft(saving, { type: "failure", key: "k",
      failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null, fields: [] } })!;
    expect(state(uncertain)).toMatchObject({ writer: "W7", priceHoldsChange: true, escapeKeepsOpen: true });
    // Another product's price draft is not this drawer's.
    expect(state({ ...draft, editor: productEditorId(12) })).toMatchObject({ writer: "W9", footerDraft: null, priceHoldsChange: false });
  });
});
