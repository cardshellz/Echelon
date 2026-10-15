import { describe, expect, it } from "vitest";
import { CATEGORY_LISTING_SETTING_FIELDS } from "@shared/dropship/listing-setting-values";
import { CATEGORY_CLEAR_FIELDS, saveCategorySettingsInputSchema } from "@shared/dropship/listing-setting-writes";
import {
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  type ListingSettingsCategoriesResponse,
  type ListingSettingsCategoryDetail,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { DropshipApiError } from "../dropship-ops-surface";
import {
  listingSettingsEditRights,
  type ListingSettingsReadState,
  type ListingSettingsRight,
  type ListingSettingsRightsInput,
  type ListingSetupFacts,
} from "../dropship-listing-settings-access";
import {
  categoryEditorId,
  classifyWriteFailure,
  productEditorId,
  reduceListingSettingsDraft,
  type DraftValue,
  type ListingSettingsDraft,
  type ListingSettingsDraftAction,
  type WriteFailurePhase,
} from "../dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "../dropship-listing-settings-drawer";
import type { DescriptionEditorState } from "../dropship-listing-settings-product-edit";
import {
  CATEGORY_EDIT_FIELDS,
  CategoryRequestError,
  categoriesCardQueryOptions,
  categoriesReadEnabled,
  categoryAsOwn,
  categoryChangedFields,
  categoryClearAction,
  categoryClearBody,
  categoryDescriptionEditorResult,
  categoryDescriptionFieldEditor,
  categoryDiscard,
  categoryDraftValue,
  categoryEbayCategoryFieldEditor,
  categoryEditorOpen,
  categoryEditorQueryOptions,
  categoryEditorState,
  categoryFieldRights,
  categoryGoneDiscards,
  categoryHasChange,
  categoryHoldsSave,
  categoryOwnValues,
  categoryPatch,
  categoryPickAction,
  categoryPolicyFieldEditor,
  categorySaveBody,
  categorySettingsCardState,
  categorySignature,
  categoryStoreShelfFieldEditor,
  choicesFromCategory,
  clearAllowed,
  clearCandidates,
  emptyCategoryChoices,
  olderGroupRulesPresent,
  olderRulesState,
  readCategoryDraft,
  rebaseCategoryDraft,
  type CategoryChoices,
  type CategoryEditorInput,
} from "../dropship-listing-settings-categories";
import type { PolicySetupFacts } from "../dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_CATEGORY_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "../dropship-listing-settings-words";

/** The Category settings card and the category editor (plan PR 10, 8.1-8.7; W12). */

const STORE = 22;
const CATEGORY = 40;
const GENERATED_AT = "2026-10-07T12:00:00.000Z";
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;

/** Freezes a value and everything under it, so a mutation anywhere would throw. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** Sleeves: sets its eBay category, shipping policy and text above; the store gives its shelf and return policy; nothing gives the payment policy or the text below. */
const DETAIL: ListingSettingsCategoryDetail = deepFreeze(listingSettingsCategoryDetailSchema.parse({
  storeConnectionId: STORE, categoryId: CATEGORY, name: "Sleeves", productCount: 15, revisionId: 7,
  settings: {
    price: { source: "store_default", value: { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" } },
    ebayCategory: { source: "category", value: { categoryId: "261328", categoryName: "Card Sleeves" } },
    storeShelf: { source: "store_default", value: { mode: "own", shelves: [{ id: "S1", name: "Supplies:Sleeves" }] } },
    shippingPolicy: { source: "category", value: { id: "F2", name: "Fast Free" } },
    returnPolicy: { source: "store_default", value: { id: "R1", name: null } },
    paymentPolicy: { source: "none", value: null },
    textAbove: { source: "category", value: { mode: "own", text: "Ships fast." } },
    textBelow: { source: "none", value: null },
  },
  ownValues: [
    { productId: 12, revisionId: null, fields: ["storeShelf", "shippingPolicy"] },
    { productId: 11, revisionId: 5, fields: ["shippingPolicy"] },
    // Its price is its own too: no clear names the price, so it is a candidate for its shelf alone.
    { productId: 13, revisionId: 9, fields: ["price", "storeShelf"] },
    { productId: 14, revisionId: 2, fields: ["textAbove"] },
  ],
  examples: [],
  generatedAt: GENERATED_AT,
}));

const LIST: ListingSettingsCategoriesResponse = deepFreeze(listingSettingsCategoriesResponseSchema.parse({
  storeConnectionId: STORE,
  categories: [
    { categoryId: CATEGORY, name: "Sleeves", productCount: 15, revisionId: 7, setFields: ["ebayCategory", "shippingPolicy", "textAbove"] },
    { categoryId: 41, name: "Toploaders", productCount: 1, revisionId: null, setFields: [] },
  ],
  uncategorizedProductCount: 4,
  generatedAt: GENERATED_AT,
}));

const setupChecked: ListingSetupFacts = {
  access: { canEdit: true, reason: null },
  revision: 4,
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  missingFields: [],
};

function rights(overrides: Partial<ListingSettingsRightsInput> = {}) {
  return listingSettingsEditRights({
    account: { status: "active", entitlementStatus: "active" },
    summary: { storeStatus: "connected", catalog: { state: "ok", products: 3, sizes: 9 } },
    setup: { data: setupChecked, error: null },
    shelves: { data: { categories: [] }, error: null },
    blocked: null,
    ...overrides,
  });
}

const SETUP: PolicySetupFacts = {
  selection: { merchantLocationKey: "cs", fulfillmentPolicyId: "F1", returnPolicyId: "R1", paymentPolicyId: null },
  storedNames: { fulfillmentPolicyName: null, returnPolicyName: "30 days", paymentPolicyName: null },
  options: {
    merchantLocations: [],
    fulfillmentPolicies: [
      { id: "F1", name: "Standard", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
      { id: "F2", name: "Fast Free", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
    ],
    returnPolicies: [{ id: "R1", name: "30 days" }],
    paymentPolicies: [{ id: "P1", name: "eBay payments" }],
  },
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  fulfillmentCapability: null,
};
const LIVE: ListingSettingsReadState<PolicySetupFacts> = { data: SETUP, error: null };
const SHELVES = [{ categoryId: "S1", categoryName: "Sleeves", path: "Supplies:Sleeves", level: 1 }, { categoryId: "S2", categoryName: "Boxes", path: "Supplies:Boxes", level: 1 }];

function storeDefaults(groupRules: { price?: number; ebayCategory?: number; description?: number } = {}): Pick<ListingSettingsSummary, "storeDefaults"> {
  return {
    storeDefaults: {
      price: { recipe: null, groupRules: groupRules.price ?? 0 },
      shippingPolicy: { policyId: "F1", verification: "not_checked" },
      returnPolicy: { policyId: "R1", verification: "not_checked" },
      paymentPolicy: { policyId: null, verification: "not_checked" },
      ebayCategory: { category: null, groupRules: groupRules.ebayCategory ?? 0 },
      description: { hasIntroduction: false, hasFooter: false, groupRules: groupRules.description ?? 0 },
    },
  };
}

type Summary = Pick<ListingSettingsSummary, "catalog" | "storeDefaults">;
function summary(groupRules: Parameters<typeof storeDefaults>[0] = {}, state: "ok" | "too_large" = "ok"): { data: Summary } {
  return { data: { catalog: state === "ok" ? { state: "ok", products: 20, sizes: 60 } : { state: "too_large", limit: 10_000 }, ...storeDefaults(groupRules) } };
}

const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const choices = (overrides: Partial<CategoryChoices>): CategoryChoices => ({ ...emptyCategoryChoices(), ...overrides });

/** Applies actions in order, freezing every draft on the way so a mutation would throw. */
function run(actions: readonly ListingSettingsDraftAction[], start: ListingSettingsDraft | null = null): ListingSettingsDraft | null {
  return actions.reduce<ListingSettingsDraft | null>((draft, action) => {
    const next = reduceListingSettingsDraft(draft === null ? null : deepFreeze(draft), deepFreeze(action));
    return next === null ? null : deepFreeze(next);
  }, start);
}

/** The editor's draft opened on DETAIL, then edited to `edit` with `clear` ticked. */
function categoryDraft(edit: Partial<CategoryChoices> = {}, clear: readonly ("ebayCategory" | "storeShelf" | "shippingPolicy" | "returnPolicy" | "paymentPolicy" | "textAbove" | "textBelow")[] = [], ...after: ListingSettingsDraftAction[]): ListingSettingsDraft {
  const draft = run([
    { type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(DETAIL) },
    { type: "edit", value: categoryDraftValue(DETAIL, choices(edit), clear) },
    ...after,
  ]);
  if (draft === null) throw new Error("expected a draft");
  return draft;
}

const SET_F1 = { mode: "set", value: { id: "F1" } } as const;
const SET_SHELF = { mode: "set", value: { mode: "own", shelfIds: ["S2"] } } as const;

function expectPlain(text: string | null): void {
  if (text === null) return;
  expect(text).not.toMatch(RAW_CODE);
  expect(text.trim()).toBe(text);
  expect(text.length).toBeGreaterThan(0);
}

const apiError = (status: number, code: string | null, context?: Record<string, unknown>, message = "Server words.") =>
  new DropshipApiError({ status, code, message, context });

// ---------------------------------------------------------------------------

describe("the reads (plan 8.2, D10, D18)", () => {
  it("runs the card's read under the store's prefix, at most a minute old, only while the selection isn't too large", () => {
    const ok = categoriesCardQueryOptions(STORE, summary());
    expect(ok.queryKey).toEqual(["/api/dropship/listings/stores", STORE, "listing-settings", "categories"]);
    expect(ok).toMatchObject({ enabled: true, staleTime: 60_000, retry: false });
    expect(categoriesCardQueryOptions(STORE, summary({}, "too_large")).enabled).toBe(false);
    // While the summary loads or failed, it runs: a 422 then goes to the banner (D18).
    expect(categoriesReadEnabled({ data: undefined })).toBe(true);
    expect(categoriesReadEnabled({ error: new TypeError("offline") })).toBe(true);
    expect(categoriesReadEnabled(summary({}, "too_large"))).toBe(false);
  });

  it("reads the open editor's category fresh each time, off while closed or too large", () => {
    const open = categoryEditorQueryOptions(STORE, CATEGORY, summary(), true);
    expect(open.queryKey).toEqual(["/api/dropship/listings/stores", STORE, "listing-settings", "category", CATEGORY]);
    expect(open).toMatchObject({ enabled: true, staleTime: 0, retry: false });
    expect(categoryEditorQueryOptions(STORE, CATEGORY, summary(), false).enabled).toBe(false);
    expect(categoryEditorQueryOptions(STORE, CATEGORY, summary({}, "too_large"), true).enabled).toBe(false);
    expect(categoryEditorQueryOptions(STORE, 0, summary(), true).enabled).toBe(false);
  });
});

describe("older group rules (D11; plan P21)", () => {
  it("are present for any count above zero, in any of the three places, and absent at zero", () => {
    expect(olderGroupRulesPresent(storeDefaults())).toBe(false);
    for (const groupRules of [{ price: 1 }, { ebayCategory: 1 }, { description: 1 }, { price: 3, description: 2 }, { price: 0, ebayCategory: 0, description: 1_000 }]) {
      expect({ groupRules, present: olderGroupRulesPresent(storeDefaults(groupRules)) }).toEqual({ groupRules, present: true });
    }
  });

  it("is unknown while the summary loads or after its latest attempt failed (UX-M9)", () => {
    expect(olderRulesState({ data: undefined })).toBe("unknown");
    expect(olderRulesState({ data: storeDefaults(), error: new TypeError("offline") })).toBe("unknown");
    expect(olderRulesState({ data: storeDefaults(), error: null })).toBe("absent");
    expect(olderRulesState({ data: storeDefaults({ price: 1 }) })).toBe("present");
  });
});

describe("the card (plan 8.3, 3.7, D11, D18)", () => {
  const card = (overrides: Partial<Parameters<typeof categorySettingsCardState>[0]> = {}) =>
    categorySettingsCardState({ read: { data: LIST, error: null }, summary: summary(), draft: null, right: EDITABLE, ...overrides });

  it("lists each category in the read's order with what it sets, in the stored order given, or that it uses the store defaults", () => {
    const state = card();
    expect(state).toMatchObject({ title: "Category settings", intro: "Products in a Card Shellz category use its settings before your store defaults.", hidden: false, read: "answered", problem: null, empty: null, olderRules: "absent", olderRulesLine: null });
    expect(state.rows.map((row) => row.text)).toEqual([
      "Sleeves · 15 products · Sets: eBay category, shipping policy, text above",
      "Toploaders · 1 product · Uses your store defaults",
    ]);
    expect(state.rows[0]).toMatchObject({ key: "category:40", categoryId: 40, name: "Sleeves", productCount: 15, revisionId: 7, held: false, line: null, change: { label: "Change", ariaLabel: "Change settings for Sleeves", shown: true, disabled: false } });
    expect(state.rows[0].words).toEqual({ name: "Sleeves", products: "15 products", sets: "Sets: eBay category, shipping policy, text above", text: state.rows[0].text });
    expect(state.uncategorized).toBe("4 products have no Card Shellz category. They use your store defaults.");
    for (const row of state.rows) {
      expectPlain(row.text);
      expectPlain(row.change.ariaLabel);
    }
    // The fields read in the order the server lists them (the stored shape's), never re-sorted.
    const reordered = listingSettingsCategoriesResponseSchema.parse({ ...LIST, categories: [{ ...LIST.categories[0], setFields: ["textBelow", "storeShelf", "price"] }] });
    expect(card({ read: { data: reordered } }).rows[0].words.sets).toBe("Sets: text below, store shelf, price");
  });

  it("takes [Change] away while the store holds older group rules, with one line, except a save out or unconfirmed (D11, CC-C25)", () => {
    const older = card({ summary: summary({ description: 2 }) });
    expect(older.olderRules).toBe("present");
    expect(older.olderRulesLine).toBe(LISTING_SETTINGS_CATEGORY_WORDS.olderRules);
    for (const row of older.rows) expect(row.change).toMatchObject({ shown: false });
    expect(older.rows.map((row) => row.line)).toEqual([null, null]);
    // The one line only when there are rows to say it for.
    expect(card({ summary: summary({ price: 1 }), read: { data: { ...LIST, categories: [] } } }).olderRulesLine).toBeNull();
    // A save of Sleeves is out or unconfirmed: its [Change] stays so Check again is reachable.
    const held = card({ summary: summary({ price: 1 }), draft: categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } }) });
    expect(held.rows[0]).toMatchObject({ held: true, change: { shown: true, disabled: false } });
    expect(held.rows[1]).toMatchObject({ held: false, change: { shown: false } });
    const uncertain = card({ summary: summary({ price: 1 }), right: { editable: false, reason: "banner" }, draft: categoryDraft({ shippingPolicy: SET_F1 }, [],
      { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } }, { type: "failure", key: "ls-cat:1", failure: { phase: "uncertain", message: "x", code: null, status: null } }) });
    expect(uncertain.rows[0]).toMatchObject({ held: true, change: { shown: true, disabled: false } });
  });

  it("turns [Change] off with Checking… while the older-rules check is unknown, and with the right's line while W12 can't be used", () => {
    for (const unknown of [{ data: undefined }, { data: summary().data, error: new TypeError("offline") }]) {
      const state = card({ summary: unknown });
      expect(state.olderRules).toBe("unknown");
      for (const row of state.rows) expect(row).toMatchObject({ change: { shown: true, disabled: true }, line: "Checking…" });
    }
    const loading = card({ right: { editable: false, reason: "loading" } });
    expect(loading.rows[0]).toMatchObject({ change: { shown: true, disabled: true }, line: "Checking…" });
    // A banner says why: no line of its own.
    const banner = card({ right: { editable: false, reason: "banner" } });
    expect(banner.rows[0]).toMatchObject({ change: { shown: true, disabled: true }, line: null });
    // A sign-in never takes W12 away (D4): resets and known ids need no eBay call.
    expect(rights({ setup: { data: undefined, error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED") } }).categorySettings).toEqual(EDITABLE);
  });

  it("says it is loading, that the read failed with Try again, or too many checks in a minute (D10), and that nothing is in a category", () => {
    expect(card({ read: { data: undefined } })).toMatchObject({ read: "loading", rows: [], problem: null, latestFailed: null, uncategorized: null, empty: null, notice: null });
    expect(card({ read: { error: new TypeError("offline") } })).toMatchObject({
      read: "failed", rows: [], problem: { kind: "failed", text: "Couldn't load category settings.", retryLabel: "Try again" }, latestFailed: null,
    });
    expect(card({ read: { data: undefined, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") } })).toMatchObject({
      read: "failed", rows: [], problem: { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: "Try again" },
    });
    expect(card({ read: { data: { ...LIST, categories: [], uncategorizedProductCount: 1 } } })).toMatchObject({
      read: "answered", rows: [], empty: "None of your chosen products is in a Card Shellz category.", uncategorized: "1 product has no Card Shellz category. It uses your store defaults.",
    });
    expect(card({ read: { data: { ...LIST, uncategorizedProductCount: 0 } } }).uncategorized).toBeNull();
    // The step's line under the card (the editor closed on a gone category, 8.6).
    expect(card({ notice: LISTING_SETTINGS_CATEGORY_WORDS.categoryNotFound }).notice).toBe("No chosen product is in this category any more.");
  });

  it("keeps the rows and their Change when a refresh fails, and says so with Try again (React Query keeps the last answer beside the error)", () => {
    const kept = card({ read: { data: LIST, error: new TypeError("offline") } });
    expect(kept).toMatchObject({ read: "answered", problem: null, latestFailed: { kind: "failed", text: DRAWER_WORDS.latestFailed, retryLabel: "Try again" } });
    expect(kept.rows.map((row) => [row.text, row.change.shown, row.change.disabled])).toEqual([[kept.rows[0].text, true, false], [kept.rows[1].text, true, false]]);
    expect(kept.uncategorized).toBe("4 products have no Card Shellz category. They use your store defaults.");
    // Too many checks in a minute: the D10 words over the kept rows; a held draft keeps its Change too.
    const limited = card({ read: { data: LIST, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") }, draft: categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } }) });
    expect(limited).toMatchObject({ read: "answered", problem: null, latestFailed: { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited } });
    expect(limited.rows[0]).toMatchObject({ held: true, change: { shown: true, disabled: false } });
  });

  it("is hidden while the selection is too large, by the summary or by the read's own 422 (D18)", () => {
    expect(card({ summary: summary({}, "too_large") })).toMatchObject({ hidden: true });
    expect(card({ read: { error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") } })).toMatchObject({ hidden: true, read: "failed", problem: null });
    expect(card({ read: { data: LIST, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") } })).toMatchObject({ hidden: true, latestFailed: null });
    expect(card({ read: { error: apiError(422, "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY") } })).toMatchObject({ hidden: false, problem: { kind: "failed" } });
  });
});

describe("the fields and their choices (plan 8.2, 8.3, D17)", () => {
  it("edits the seven settings Also clear theirs can clear, never the price or a main text", () => {
    expect([...CATEGORY_EDIT_FIELDS]).toEqual(["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "textAbove", "textBelow"]);
    expect(new Set(CATEGORY_EDIT_FIELDS)).toEqual(new Set(CATEGORY_CLEAR_FIELDS));
    expect(CATEGORY_LISTING_SETTING_FIELDS.filter((field) => !(CATEGORY_EDIT_FIELDS as readonly string[]).includes(field))).toEqual(["price"]);
    expect(Object.values(emptyCategoryChoices()).every((choice) => choice.mode === "leave")).toBe(true);
  });

  it("reads what the category sets itself, as values and as choices, with the store default as Use store default", () => {
    const own = categoryOwnValues(DETAIL.settings);
    expect(own).toEqual({
      shippingPolicy: { id: "F2", name: "Fast Free" }, returnPolicy: null, paymentPolicy: null,
      ebayCategory: { categoryId: "261328", categoryName: "Card Sleeves" }, storeShelf: null,
      textAbove: { mode: "own", text: "Ships fast." }, textBelow: null,
    });
    expect(categoryAsOwn(own).own).toMatchObject({ price: null, mainText: null, shippingPolicy: { id: "F2" } });
    expect(choicesFromCategory(DETAIL.settings)).toEqual({
      shippingPolicy: { mode: "set", value: { id: "F2" } },
      returnPolicy: { mode: "default" },
      paymentPolicy: { mode: "default" },
      ebayCategory: { mode: "set", value: { categoryId: "261328", categoryName: "Card Sleeves" } },
      storeShelf: { mode: "default" },
      textAbove: { mode: "set", value: { mode: "own", text: "Ships fast." } },
      textBelow: { mode: "default" },
    });
  });
});

describe("the draft (plan 8.2, 8.4, D6, D16)", () => {
  it("starts from the detail: its revision, its own values and its products' own values, with every field left and nothing ticked", () => {
    const base = categoryDraftValue(DETAIL);
    expect(base).toMatchObject({ categoryId: CATEGORY, expectedRevisionId: 7, clear: [], shippingPolicy: { mode: "leave" }, textBelow: { mode: "leave" } });
    expect(base.ownValues).toEqual(DETAIL.ownValues);
    expect(categoryChangedFields(base)).toEqual([]);
    expect(categoryHasChange(base)).toBe(false);
    expect(Object.isFrozen(base.clear)).toBe(true);
    expect(readCategoryDraft(base as unknown as DraftValue)).toBe(base);
  });

  it("counts a choice that asks for what the category has as no change, and copies the rest", () => {
    const value = categoryDraftValue(DETAIL, choices({
      shippingPolicy: { mode: "set", value: { id: "F2" } },
      returnPolicy: { mode: "default" },
      paymentPolicy: SET_F1 as never,
      ebayCategory: { mode: "set", value: { categoryId: "261328" } },
      textAbove: { mode: "set", value: { mode: "own", text: "Ships fast.\r\n" } },
      textBelow: { mode: "set", value: { mode: "none" } },
    }));
    expect(categoryChangedFields(value)).toEqual(["paymentPolicy", "textBelow"]);
    expect(value.shippingPolicy).toEqual({ mode: "leave" });
    expect(value.ebayCategory).toEqual({ mode: "leave" });
    expect(value.textAbove).toEqual({ mode: "leave" });
    // Use store default on a field the category sets is a change; on one it doesn't, none.
    expect(categoryChangedFields(categoryDraftValue(DETAIL, choices({ shippingPolicy: { mode: "default" }, storeShelf: { mode: "default" } })))).toEqual(["shippingPolicy"]);
    const draft = categoryDraft({ shippingPolicy: SET_F1, textBelow: { mode: "set", value: { mode: "own", text: "Thanks!" } } }, ["shippingPolicy"]);
    expect(draft.changes).toBe(3);
  });

  it("tells a category draft from any other, and refuses one it can't trust", () => {
    expect(readCategoryDraft({ productVariantId: 101, expectedRevisionId: 1, exact: "" })).toBeNull();
    expect(readCategoryDraft({ items: [] })).toBeNull();
    const base = categoryDraftValue(DETAIL) as unknown as Record<string, unknown>;
    for (const bad of [
      { ...base, categoryId: 0 }, { ...base, expectedRevisionId: 1.5 }, { ...base, own: null }, { ...base, clear: ["price"] }, { ...base, clear: ["storeShelf", "storeShelf"] },
      { ...base, ownValues: [{ productId: 11, revisionId: 5, fields: [] }] }, { ...base, ownValues: [{ productId: 11, revisionId: 5, fields: ["mainText"] }] },
      { ...base, ownValues: [{ productId: 11, revisionId: 5, fields: ["price"] }, { productId: 11, revisionId: 6, fields: ["price"] }] },
      { ...base, shippingPolicy: { mode: "set", value: { id: "" } } }, { ...base, storeShelf: { mode: "set", value: { mode: "own", shelfIds: [] } } },
    ]) {
      expect(readCategoryDraft(bad)).toBeNull();
    }
    expect(readCategoryDraft({ ...base, ownValues: [{ productId: 13, revisionId: 9, fields: ["price", "storeShelf"] }] })).not.toBeNull();
  });

  it("puts an editor's choices in the open draft, keeps the ticks that still apply, and refuses a pick it doesn't set", () => {
    const opened = categoryDraft({ shippingPolicy: SET_F1 }, ["shippingPolicy"]);
    const edit = categoryPickAction({ draft: opened, categoryId: CATEGORY, picks: { returnPolicy: { mode: "default" } } });
    expect(edit).toMatchObject({ kind: "edit", value: { shippingPolicy: SET_F1, returnPolicy: { mode: "leave" }, clear: ["shippingPolicy"] } });
    // Use store default on the shipping policy drops its tick: a clear needs a set value (SW:438-445).
    expect(categoryPickAction({ draft: opened, categoryId: CATEGORY, picks: { shippingPolicy: { mode: "default" } } }))
      .toMatchObject({ kind: "edit", value: { shippingPolicy: { mode: "default" }, clear: [] } });
    // Setting it back to the category's own value keeps the tick (a clear-only save).
    expect(categoryPickAction({ draft: opened, categoryId: CATEGORY, picks: { shippingPolicy: { mode: "set", value: { id: "F2" } } } }))
      .toMatchObject({ kind: "edit", value: { shippingPolicy: { mode: "leave" }, clear: ["shippingPolicy"] } });
    expect(categoryPickAction({ draft: null, categoryId: CATEGORY, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "not_open" });
    expect(categoryPickAction({ draft: opened, categoryId: 41, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "not_open" });
    expect(categoryPickAction({ draft: { ...opened, editor: productEditorId(11) }, categoryId: CATEGORY, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "not_open" });
    const saving = categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } });
    expect(categoryPickAction({ draft: saving, categoryId: CATEGORY, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "locked" });
    expect(() => categoryPickAction({ draft: opened, categoryId: CATEGORY, picks: { mainText: { mode: "default" } } as never })).toThrow(/doesn't set: mainText/);
    expect(() => categoryPickAction({ draft: opened, categoryId: CATEGORY, picks: { price: { mode: "default" } } as never })).toThrow(/doesn't set: price/);
    expect(() => categoryPickAction({ draft: opened, categoryId: CATEGORY, picks: { shippingPolicy: { mode: "set", value: { id: "" } } } })).toThrow(/doesn't set: shippingPolicy/);
  });

  it("starts a clean draft again on the detail read now, so a change after a save carries the new revision and clear set (D6)", () => {
    const editor = categoryEditorId(CATEGORY);
    // After a confirmed save: the draft is clean and holds the revision the save moved; the detail was read again.
    const saved = categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } },
      { type: "saved", key: "ls-cat:1", nowMs: 1_000, viewStale: false });
    const latest: ListingSettingsCategoryDetail = deepFreeze({ ...DETAIL, revisionId: 8,
      settings: { ...DETAIL.settings, shippingPolicy: { source: "category", value: { id: "F1", name: "Standard" } } },
      ownValues: [{ productId: 14, revisionId: 2, fields: ["textAbove"] }] });
    const start = categoryPickAction({ draft: saved, categoryId: CATEGORY, detail: latest, picks: { returnPolicy: { mode: "default" } } });
    expect(start).toMatchObject({ kind: "start", editor, place: "Sleeves", base: { expectedRevisionId: 8, clear: [] }, value: { expectedRevisionId: 8, returnPolicy: { mode: "leave" }, clear: [] } });
    // Nothing to send yet: the store default gives the return policy already, so the pick is no change on the new base.
    expect(start.kind === "start" && categoryHasChange(start.value)).toBe(false);
    expect(start.kind === "start" && start.value.ownValues).toEqual([{ productId: 14, revisionId: 2, fields: ["textAbove"] }]);
    // A tick starts the same way, on the new set.
    expect(categoryClearAction({ draft: saved, categoryId: CATEGORY, detail: latest, field: "textAbove", ticked: true }))
      .toMatchObject({ kind: "start", base: { expectedRevisionId: 8 }, value: { expectedRevisionId: 8, clear: ["textAbove"] } });
    // No draft yet and the read at hand: the pick opens the draft on it.
    expect(categoryPickAction({ draft: null, categoryId: CATEGORY, detail: DETAIL, picks: { returnPolicy: { mode: "set", value: { id: "R1" } } } }))
      .toMatchObject({ kind: "start", editor, place: "Sleeves", base: { expectedRevisionId: 7 } });
    // A draft holding a change keeps the facts it was made against, whatever the read says now (D6: the 409 tells).
    const dirty = categoryDraft({ shippingPolicy: SET_F1 });
    expect(categoryPickAction({ draft: dirty, categoryId: CATEGORY, detail: latest, picks: { returnPolicy: { mode: "default" } } }))
      .toMatchObject({ kind: "edit", value: { expectedRevisionId: 7, shippingPolicy: SET_F1 } });
    expect(categoryClearAction({ draft: dirty, categoryId: CATEGORY, detail: latest, field: "shippingPolicy", ticked: true }))
      .toMatchObject({ kind: "edit", value: { expectedRevisionId: 7, clear: ["shippingPolicy"] } });
    // A read for another category is no read to start from; a locked draft stays locked; another editor's change opens nothing.
    expect(categoryPickAction({ draft: saved, categoryId: CATEGORY, detail: { ...latest, categoryId: 41 }, picks: { returnPolicy: { mode: "default" } } }))
      .toMatchObject({ kind: "edit", value: { expectedRevisionId: 7 } });
    const saving = categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } });
    expect(categoryPickAction({ draft: saving, categoryId: CATEGORY, detail: latest, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "locked" });
    const other = run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]);
    expect(categoryPickAction({ draft: other, categoryId: CATEGORY, detail: DETAIL, picks: { returnPolicy: { mode: "default" } } })).toEqual({ kind: "not_open" });
    // A clean draft of another editor is left: the category's draft opens over it.
    const clean = run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }]);
    expect(categoryPickAction({ draft: clean, categoryId: CATEGORY, detail: DETAIL, picks: { returnPolicy: { mode: "default" } } })).toMatchObject({ kind: "start" });
  });

  it("ticks and unticks Also clear theirs where the box can show, and drops a tick where it can't (8.4)", () => {
    const opened = categoryDraft();
    // The category sets its shipping policy and two products hold their own: a clear-only save.
    const ticked = categoryClearAction({ draft: opened, categoryId: CATEGORY, field: "shippingPolicy", ticked: true });
    expect(ticked).toMatchObject({ kind: "edit", value: { clear: ["shippingPolicy"], shippingPolicy: { mode: "leave" } } });
    expect(ticked.kind === "edit" && categoryHasChange(ticked.value)).toBe(true);
    // The store default gives the shelf: no tick without a Set.
    expect(categoryClearAction({ draft: opened, categoryId: CATEGORY, field: "storeShelf", ticked: true })).toMatchObject({ kind: "edit", value: { clear: [] } });
    // With a Set, the tick holds.
    const shelf = categoryDraft({ storeShelf: SET_SHELF });
    expect(categoryClearAction({ draft: shelf, categoryId: CATEGORY, field: "storeShelf", ticked: true })).toMatchObject({ kind: "edit", value: { clear: ["storeShelf"] } });
    // No product holds its own payment policy: nothing to clear.
    expect(categoryClearAction({ draft: categoryDraft({ paymentPolicy: { mode: "set", value: { id: "P1" } } }), categoryId: CATEGORY, field: "paymentPolicy", ticked: true }))
      .toMatchObject({ kind: "edit", value: { clear: [] } });
    // Untick.
    const both = categoryDraft({ storeShelf: SET_SHELF }, ["storeShelf", "shippingPolicy"]);
    expect(both.changes).toBe(2);
    expect(categoryClearAction({ draft: both, categoryId: CATEGORY, field: "shippingPolicy", ticked: false })).toMatchObject({ kind: "edit", value: { clear: ["storeShelf"] } });
    // In the stored shape's order, whatever order they were ticked in.
    expect(categoryDraftValue(DETAIL, choices({ storeShelf: SET_SHELF }), ["shippingPolicy", "storeShelf", "textAbove"]).clear).toEqual(["storeShelf", "shippingPolicy", "textAbove"]);
    expect(categoryClearAction({ draft: null, categoryId: CATEGORY, field: "shippingPolicy", ticked: true })).toEqual({ kind: "not_open" });
    expect(() => categoryClearAction({ draft: opened, categoryId: CATEGORY, field: "price" as never, ticked: true })).toThrow(/can't clear: price/);
  });

  it("drops its draft when the read says the category is gone, unless a save is out or unconfirmed (8.6, 3.4)", () => {
    expect(categoryGoneDiscards(null, CATEGORY)).toBe(false);
    expect(categoryGoneDiscards(run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]), CATEGORY)).toBe(false);
    expect(categoryGoneDiscards(categoryDraft({ shippingPolicy: SET_F1 }), 41)).toBe(false);
    expect(categoryGoneDiscards(run([{ type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(DETAIL) }]), CATEGORY)).toBe(true);
    expect(categoryGoneDiscards(categoryDraft({ shippingPolicy: SET_F1 }), CATEGORY)).toBe(true);
    const saving = categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } });
    expect(categoryGoneDiscards(saving, CATEGORY)).toBe(false);
    // A save nobody could confirm keeps its attempt and its key: Check again is answered by the replay probe first.
    expect(categoryGoneDiscards(run([{ type: "failure", key: "ls-cat:1", failure: { phase: "uncertain", message: "x", code: null, status: null } }], saving), CATEGORY)).toBe(false);
    expect(categoryGoneDiscards(run([{ type: "failure", key: "ls-cat:1", failure: { phase: "refused", message: "x", code: "C", status: 404 } }], saving), CATEGORY)).toBe(true);
  });

  it("says whether a save is out or unconfirmed, and what Discard does", () => {
    expect(categoryHoldsSave(categoryDraft({ shippingPolicy: SET_F1 }), CATEGORY)).toBe(false);
    const saving = categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } });
    expect(categoryHoldsSave(saving, CATEGORY)).toBe(true);
    expect(categoryHoldsSave(saving, 41)).toBe(false);
    expect(categoryDiscard(saving, CATEGORY)).toEqual({ kind: "none" });
    expect(categoryDiscard(null, CATEGORY)).toEqual({ kind: "none" });
    expect(categoryDiscard(categoryDraft({ shippingPolicy: SET_F1 }, ["shippingPolicy"]), CATEGORY)).toMatchObject({ kind: "reset", value: { shippingPolicy: { mode: "leave" }, clear: [], expectedRevisionId: 7 } });
    const conflict = run([{ type: "failure", key: "ls-cat:1", failure: { phase: "conflict", message: "x", code: "C", status: 409 } }], saving);
    expect(categoryDiscard(conflict, CATEGORY)).toEqual({ kind: "reread" });
  });
});

describe("the clear set (plan 8.4, CC-C4, CC-C15)", () => {
  const facts = categoryDraftValue(DETAIL);

  it("names the products holding their own value in a field, the price never making one a candidate", () => {
    expect(clearCandidates(facts, "shippingPolicy").map((entry) => entry.productId)).toEqual([12, 11]);
    expect(clearCandidates(facts, "storeShelf").map((entry) => entry.productId)).toEqual([12, 13]);
    expect(clearCandidates(facts, "textAbove").map((entry) => entry.productId)).toEqual([14]);
    expect(clearCandidates(facts, "paymentPolicy")).toEqual([]);
  });

  it("allows the box with candidates and a set field, or the category's own field left alone; never on a store default without a Set, never with Use store default", () => {
    expect(clearAllowed(facts, "shippingPolicy", { mode: "leave" })).toBe(true);
    expect(clearAllowed(facts, "shippingPolicy", { mode: "set", value: { id: "F1" } })).toBe(true);
    expect(clearAllowed(facts, "shippingPolicy", { mode: "default" })).toBe(false);
    expect(clearAllowed(facts, "storeShelf", { mode: "leave" })).toBe(false);
    expect(clearAllowed(facts, "storeShelf", { mode: "set", value: { mode: "none" } })).toBe(true);
    expect(clearAllowed(facts, "paymentPolicy", { mode: "set", value: { id: "P1" } })).toBe(false);
  });

  it("is the union of the entries holding any ticked field, each once, ascending, with the revision it was read with", () => {
    expect(categoryClearBody(categoryDraftValue(DETAIL, choices({ storeShelf: SET_SHELF }), ["storeShelf", "shippingPolicy"]))).toEqual({
      fields: ["storeShelf", "shippingPolicy"],
      products: [{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }, { productId: 13, expectedRevisionId: 9 }],
    });
    expect(categoryClearBody(categoryDraftValue(DETAIL, emptyCategoryChoices(), ["shippingPolicy"]))).toEqual({
      fields: ["shippingPolicy"], products: [{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }],
    });
    // Nothing ticked, or no entry for the field: no clear at all.
    expect(categoryClearBody(facts)).toBeUndefined();
    expect(categoryClearBody(categoryDraftValue({ ...DETAIL, ownValues: [] }, choices({ shippingPolicy: SET_F1 }), ["shippingPolicy"]))).toBeUndefined();
  });
});

describe("categoryPatch and the W12 body (plan 8.4, 8.5, D1, P34)", () => {
  it("sends Use store default as null, Set as ids or text only, leave as absent, and a cleared field left alone as the category's own value again", () => {
    const value = categoryDraftValue(DETAIL, choices({
      // "Use store default" on a field the category sets (null); on one the store already gives, it would be no change.
      textAbove: { mode: "default" },
      returnPolicy: { mode: "default" },
      storeShelf: SET_SHELF,
      ebayCategory: { mode: "set", value: { categoryId: "183454", categoryName: "Toploaders" } },
      textBelow: { mode: "set", value: { mode: "own", text: "  Thanks!\r\n" } },
    }), ["shippingPolicy", "storeShelf", "textAbove"]);
    expect(value.clear).toEqual(["storeShelf", "shippingPolicy"]);
    const patch = categoryPatch(value);
    expect(patch).toEqual({
      textAbove: null,
      storeShelf: { mode: "own", shelfIds: ["S2"] },
      ebayCategory: { categoryId: "183454" },
      textBelow: { mode: "own", text: "  Thanks!\r\n" },
      // Clear-only: the category's current value, as ids-only input (P20).
      shippingPolicy: { id: "F2" },
    });
    expect(JSON.stringify(patch)).not.toMatch(/price|mainText|categoryName|Fast Free/);
    const body = categorySaveBody({ key: "ls-cat:00000001", expectedRevisionId: 7, patch, clear: categoryClearBody(value) });
    expect(saveCategorySettingsInputSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      idempotencyKey: "ls-cat:00000001", expectedRevisionId: 7,
      patch: { ...patch, textBelow: { mode: "own", text: "Thanks!" } },
      clear: { fields: ["storeShelf", "shippingPolicy"], products: [
        { productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }, { productId: 13, expectedRevisionId: 9 },
      ] },
    });
    expect(body).not.toHaveProperty("patch.price");
    expect(body).not.toHaveProperty("patch.mainText");
  });

  it("a clear-only save resends the category's own value and parses: the category saves as unchanged (P20)", () => {
    const value = categoryDraftValue(DETAIL, emptyCategoryChoices(), ["shippingPolicy"]);
    expect(categoryChangedFields(value)).toEqual([]);
    expect(categoryHasChange(value)).toBe(true);
    const patch = categoryPatch(value);
    expect(patch).toEqual({ shippingPolicy: { id: "F2" } });
    expect(categorySaveBody({ key: "ls-cat:00000001", expectedRevisionId: 7, patch, clear: categoryClearBody(value) })).toMatchObject({
      patch: { shippingPolicy: { id: "F2" } }, clear: { fields: ["shippingPolicy"] },
    });
    // The shelf's own value and None resend as ids-only input too.
    const shelfOwn = listingSettingsCategoryDetailSchema.parse({ ...DETAIL, settings: { ...DETAIL.settings,
      storeShelf: { source: "category", value: { mode: "own", shelves: [{ id: "S1", name: "Supplies:Sleeves" }, { id: "S2", name: "Supplies:Boxes" }] } },
      textAbove: { source: "category", value: { mode: "none" } } } });
    expect(categoryPatch(categoryDraftValue(shelfOwn, emptyCategoryChoices(), ["storeShelf", "textAbove"]))).toEqual({
      storeShelf: { mode: "own", shelfIds: ["S1", "S2"] }, textAbove: { mode: "none" },
    });
    const shelfNone = listingSettingsCategoryDetailSchema.parse({ ...DETAIL, settings: { ...DETAIL.settings, storeShelf: { source: "category", value: { mode: "none" } } } });
    expect(categoryPatch(categoryDraftValue(shelfNone, emptyCategoryChoices(), ["storeShelf"]))).toEqual({ storeShelf: { mode: "none" } });
  });

  it("never carries a price or a main text, and refuses a body outside the contract before sending", () => {
    for (const choicesWithout of [choices({ shippingPolicy: SET_F1 }), choices({ textAbove: { mode: "set", value: { mode: "none" } } })]) {
      expect(Object.keys(categoryPatch(categoryDraftValue(DETAIL, choicesWithout))).every((field) => (CATEGORY_EDIT_FIELDS as readonly string[]).includes(field))).toBe(true);
    }
    const throws = (input: Parameters<typeof categorySaveBody>[0], context: Record<string, unknown>) => {
      expect(() => categorySaveBody(input)).toThrow(CategoryRequestError);
      expect(() => categorySaveBody(input)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_REQUEST_INVALID", context: expect.objectContaining(context) }));
    };
    throws({ key: "ls-cat:00000001", expectedRevisionId: 7, patch: { price: null } as never }, { fields: ["price"] });
    throws({ key: "ls-cat:00000001", expectedRevisionId: 7, patch: { mainText: { text: "x" } } as never }, { fields: ["mainText"] });
    throws({ key: "ls-cat:00000001", expectedRevisionId: 7, patch: {} }, { fields: [] });
    throws({ key: "ls-cat:00000001", expectedRevisionId: 7, patch: { shippingPolicy: undefined } }, { fields: [] });
    // A cleared field the patch doesn't set (Use store default), a clear with no product, a bad key, text over its limit.
    throws({ key: "ls-cat:00000001", expectedRevisionId: 7, patch: { shippingPolicy: null }, clear: { fields: ["shippingPolicy"], products: [{ productId: 11, expectedRevisionId: 5 }] } }, { fields: ["shippingPolicy"] });
    throws({ key: "ls-cat:00000001", expectedRevisionId: 7, patch: { shippingPolicy: { id: "F1" } }, clear: { fields: ["shippingPolicy"], products: [] } }, { issues: expect.any(Array) });
    throws({ key: "x", expectedRevisionId: 7, patch: { shippingPolicy: { id: "F1" } } }, { issues: [{ path: "idempotencyKey", code: "invalid_string" }] });
    throws({ key: "ls-cat:00000001", expectedRevisionId: 7, patch: { textAbove: { mode: "own", text: "x".repeat(4_001) } } }, { issues: expect.any(Array) });
  });

  it("signs the request stable under the order of the clear's fields and products, and differently by revision, product revision, category and store", () => {
    const patch = categoryPatch(categoryDraftValue(DETAIL, choices({ storeShelf: SET_SHELF }), ["storeShelf", "shippingPolicy"]));
    const clear = { fields: ["shippingPolicy", "storeShelf"], products: [{ productId: 13, expectedRevisionId: 9 }, { productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }] } as const;
    const sorted = categoryClearBody(categoryDraftValue(DETAIL, choices({ storeShelf: SET_SHELF }), ["storeShelf", "shippingPolicy"]));
    const signature = categorySignature(STORE, CATEGORY, 7, patch, clear);
    expect(signature).toBe(categorySignature(STORE, CATEGORY, 7, patch, sorted));
    expect(signature).toBe(categorySignature(STORE, CATEGORY, 7, { storeShelf: patch.storeShelf, shippingPolicy: patch.shippingPolicy }, sorted));
    expect(signature).toBe('["listing-settings-category-settings-v1",22,40,7,[["storeShelf",{"mode":"own","shelfIds":["S2"]}],["shippingPolicy",{"id":"F2"}]],[["storeShelf","shippingPolicy"],[[11,5],[12,null],[13,9]]]]');
    expect(categorySignature(STORE, CATEGORY, 8, patch, clear)).not.toBe(signature);
    expect(categorySignature(STORE, CATEGORY, 7, patch, { ...clear, products: [{ productId: 13, expectedRevisionId: 10 }, { productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }] })).not.toBe(signature);
    expect(categorySignature(STORE, 41, 7, patch, clear)).not.toBe(signature);
    expect(categorySignature(23, CATEGORY, 7, patch, clear)).not.toBe(signature);
    expect(categorySignature(STORE, CATEGORY, 7, patch, undefined)).not.toBe(signature);
    expect(categorySignature(STORE, CATEGORY, 7, { storeShelf: { mode: "own", shelfIds: ["S2", "S1"] } }, undefined))
      .not.toBe(categorySignature(STORE, CATEGORY, 7, { storeShelf: { mode: "own", shelfIds: ["S1", "S2"] } }, undefined));
  });
});

describe("categoryFieldRights (D3, D4)", () => {
  it("gives every field while W12 and the eBay reads allow, with None for the shelf and the text", () => {
    const all = rights();
    for (const field of CATEGORY_EDIT_FIELDS) {
      expect({ field, ...categoryFieldRights(all, field) }).toEqual({ field, canSet: true, canDefault: true, canNone: field === "storeShelf" || field === "textAbove" || field === "textBelow", reason: null });
    }
  });

  it("leaves Use store default (and None) only under a sign-in, and takes every field away while W12 is off", () => {
    const signIn = rights({ setup: { data: undefined, error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED") } });
    expect(categoryFieldRights(signIn, "shippingPolicy")).toEqual({ canSet: false, canDefault: true, canNone: false, reason: "sign_in" });
    expect(categoryFieldRights(signIn, "storeShelf")).toEqual({ canSet: false, canDefault: true, canNone: true, reason: "sign_in" });
    expect(categoryFieldRights(signIn, "textAbove")).toEqual({ canSet: true, canDefault: true, canNone: true, reason: null });
    const paused = rights({ account: { status: "paused", entitlementStatus: "active" } });
    for (const field of CATEGORY_EDIT_FIELDS) expect(categoryFieldRights(paused, field)).toEqual({ canSet: false, canDefault: false, canNone: false, reason: "banner" });
  });
});

describe("opening the editor, Load latest and Discard (D6, D16, D21, plan 8.6)", () => {
  it("waits for the detail, opens on it, keeps a held change or save, and closes over another editor's change", () => {
    expect(categoryEditorOpen(null, CATEGORY, null)).toEqual({ kind: "wait" });
    expect(categoryEditorOpen(null, CATEGORY, DETAIL)).toMatchObject({ kind: "open", base: { categoryId: CATEGORY, expectedRevisionId: 7, clear: [] } });
    const clean = run([{ type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(DETAIL) }]);
    expect(categoryEditorOpen(clean, CATEGORY, DETAIL)).toMatchObject({ kind: "open" });
    // Another editor's clean draft holds nothing to lose: the category's own opens over it.
    const cleanOther = run([{ type: "open", editor: "price", place: "Price", base: {} }]);
    expect(categoryEditorOpen(cleanOther, CATEGORY, DETAIL)).toMatchObject({ kind: "open" });
    expect(categoryEditorOpen(categoryDraft({ shippingPolicy: SET_F1 }), CATEGORY, DETAIL)).toEqual({ kind: "keep" });
    expect(categoryEditorOpen(categoryDraft({ shippingPolicy: SET_F1 }, [], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } }), CATEGORY, null)).toEqual({ kind: "keep" });
    // The drawer holds a change: the address opened the editor without [Change]'s question (D16).
    const product = run([{ type: "open", editor: productEditorId(11), place: "Penny Sleeves", base: { a: 1 } }, { type: "edit", value: { a: 2 } }]);
    expect(categoryEditorOpen(product, CATEGORY, DETAIL)).toEqual({ kind: "elsewhere" });
    // Another category's held change too.
    expect(categoryEditorOpen(categoryDraft({ shippingPolicy: SET_F1 }), 41, DETAIL)).toEqual({ kind: "elsewhere" });
  });

  it("Load latest keeps the vendor's choices on the detail read now, rebuilds the clear set from the new ownValues, and marks the fields both changed", () => {
    const mine = categoryDraftValue(DETAIL, choices({ shippingPolicy: SET_F1, ebayCategory: { mode: "default" }, storeShelf: SET_SHELF }), ["shippingPolicy", "storeShelf"]);
    // Another window set the shipping policy to F3 and saved a return policy; product 12 lost its own shelf.
    const latest = listingSettingsCategoryDetailSchema.parse({
      ...DETAIL, revisionId: 8,
      settings: { ...DETAIL.settings, shippingPolicy: { source: "category", value: { id: "F3", name: "Slow" } }, returnPolicy: { source: "category", value: { id: "R1", name: "30 days" } } },
      ownValues: [{ productId: 11, revisionId: 6, fields: ["shippingPolicy"] }, { productId: 13, revisionId: 9, fields: ["price", "storeShelf"] }],
    });
    const reload = rebaseCategoryDraft(mine, latest);
    expect(reload.edited).toMatchObject({ expectedRevisionId: 8, shippingPolicy: SET_F1, ebayCategory: { mode: "default" }, returnPolicy: { mode: "leave" }, storeShelf: SET_SHELF, clear: ["storeShelf", "shippingPolicy"] });
    expect(categoryClearBody(reload.edited)).toEqual({ fields: ["storeShelf", "shippingPolicy"], products: [{ productId: 11, expectedRevisionId: 6 }, { productId: 13, expectedRevisionId: 9 }] });
    expect(reload.latest).toMatchObject({ expectedRevisionId: 8, shippingPolicy: { mode: "leave" }, clear: [] });
    // The shipping policy: both changed it. The eBay category: only the vendor. The return policy: only the other window.
    expect(reload.marked).toEqual(["shippingPolicy"]);
    expect(reload.keeps).toBe(true);
    // The other window saved the very same choice: no longer a change, not marked; with nothing else kept, the draft goes.
    const same = listingSettingsCategoryDetailSchema.parse({ ...DETAIL, revisionId: 8, settings: { ...DETAIL.settings, shippingPolicy: { source: "category", value: { id: "F1", name: "Standard" } } } });
    const agreed = rebaseCategoryDraft(categoryDraftValue(DETAIL, choices({ shippingPolicy: SET_F1 })), same);
    expect(agreed).toMatchObject({ marked: [], keeps: false, edited: { shippingPolicy: { mode: "leave" }, clear: [] } });
    // A tick whose field no product holds any more is dropped; one still held stays (a clear-only save keeps).
    const noneLeft = listingSettingsCategoryDetailSchema.parse({ ...DETAIL, revisionId: 8, ownValues: [{ productId: 14, revisionId: 3, fields: ["textAbove"] }] });
    expect(rebaseCategoryDraft(categoryDraftValue(DETAIL, emptyCategoryChoices(), ["shippingPolicy"]), noneLeft)).toMatchObject({ keeps: false, edited: { clear: [] } });
    expect(rebaseCategoryDraft(categoryDraftValue(DETAIL, emptyCategoryChoices(), ["textAbove"]), noneLeft)).toMatchObject({ keeps: true, edited: { clear: ["textAbove"] } });
  });
});

describe("the rows' editors (plan 8.2, D17)", () => {
  const own = categoryOwnValues(DETAIL.settings);
  const full = { canSet: true, canDefault: true, canNone: true };

  it("open each editor on the draft's choice, else on the category's value, with Use store default as the default", () => {
    const shipping = categoryPolicyFieldEditor({ field: "shippingPolicy", rights: full, draftChoice: { mode: "leave" }, own, setup: LIVE });
    expect(shipping).toMatchObject({ field: "shippingPolicy", kind: "shipping", initial: { mode: "set", value: { id: "F2" } }, canSet: true, canDefault: true });
    expect(shipping.choices?.map((choice) => choice.id)).toEqual(["F1", "F2"]);
    expect(categoryPolicyFieldEditor({ field: "returnPolicy", rights: full, draftChoice: { mode: "leave" }, own, setup: LIVE }).initial).toEqual({ mode: "default" });
    expect(categoryPolicyFieldEditor({ field: "returnPolicy", rights: full, draftChoice: { mode: "set", value: { id: "R1" } }, own, setup: LIVE }).initial).toEqual({ mode: "set", value: { id: "R1" } });
    expect(categoryPolicyFieldEditor({ field: "shippingPolicy", rights: { canSet: false, canDefault: true }, draftChoice: { mode: "leave" }, own, setup: LIVE }).choices).toBeNull();
    const ebay = categoryEbayCategoryFieldEditor({ rights: full, draftChoice: { mode: "leave" }, own });
    expect(ebay).toMatchObject({ initial: { mode: "set", value: { categoryId: "261328", categoryName: "Card Sleeves" } }, initialQuery: "Card Sleeves" });
    const shelf = categoryStoreShelfFieldEditor({ rights: full, draftChoice: { mode: "leave" }, own, shelves: SHELVES });
    expect(shelf).toMatchObject({ initial: { mode: "default", first: null, second: null }, canNone: true });
    expect(shelf.options?.map((option) => option.categoryId)).toEqual(["S1", "S2"]);
    expect(categoryStoreShelfFieldEditor({ rights: full, draftChoice: SET_SHELF, own, shelves: SHELVES }).initial).toEqual({ mode: "own", first: "S2", second: null });
  });

  it("the Description editor edits text above and below only: no main text, no check, no tie line", () => {
    const model = categoryDescriptionFieldEditor({ rights: full, draftChoices: { textAbove: { mode: "leave" }, textBelow: { mode: "leave" } }, own });
    expect(model).toMatchObject({
      initial: { textAbove: { mode: "own", text: "Ships fast." }, textBelow: { mode: "default", text: "" } },
      canSet: true, canDefault: true, canNone: true, mainTextOwn: false, check: null, conflictLine: null,
    });
    const state: DescriptionEditorState = { textAbove: { mode: "none", text: "Ships fast." }, textBelow: { mode: "own", text: "Thanks!" }, mainText: model.initial.mainText };
    expect(categoryDescriptionEditorResult(model, state)).toEqual({ ok: true, picks: { textAbove: { mode: "set", value: { mode: "none" } }, textBelow: { mode: "set", value: { mode: "own", text: "Thanks!" } } } });
    expect(categoryDescriptionEditorResult(model, { ...state, mainText: { mode: "own", text: "never" } })).toEqual({ ok: true, picks: { textAbove: { mode: "set", value: { mode: "none" } }, textBelow: { mode: "set", value: { mode: "own", text: "Thanks!" } } } });
    expect(categoryDescriptionEditorResult(model, { ...state, textBelow: { mode: "own", text: "   " } })).toEqual({ ok: false, problems: { textBelow: LISTING_SETTINGS_EDIT_WORDS.textEmpty } });
    expect(categoryDescriptionEditorResult(model, model.initial)).toEqual({ ok: true, picks: {} });
    const withDraft = categoryDescriptionFieldEditor({ rights: full, draftChoices: { textAbove: { mode: "default" }, textBelow: { mode: "set", value: { mode: "none" } } }, own });
    expect(withDraft.initial).toMatchObject({ textAbove: { mode: "default", text: "Ships fast." }, textBelow: { mode: "none" } });
  });
});

describe("the editor (plan 8.3, 8.4, 3.7)", () => {
  const editor = (overrides: Partial<CategoryEditorInput> = {}) => categoryEditorState({
    category: { categoryId: CATEGORY, name: "Sleeves", productCount: 15 }, categoryId: CATEGORY, detail: { data: DETAIL, error: null }, summary: summary(), draft: null,
    rights: rights(), setup: LIVE, shelves: SHELVES, openTarget: null, failure: null, busy: false, savedFlashVisible: false, compact: false, fieldEditorOpen: false,
    ...overrides,
  });
  const OPENED = run([{ type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(DETAIL) }]);
  const SAVING = categoryDraft({ shippingPolicy: SET_F1 }, ["shippingPolicy"], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } });
  const UNCERTAIN = run([{ type: "failure", key: "ls-cat:1", failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null } }], SAVING);

  it("titles the editor, shows each value with where it comes from, the Price row read-only, and Change on every row once the draft is open", () => {
    const state = editor({ draft: OPENED });
    expect(state).toMatchObject({ title: "Sleeves · 15 products", name: "Sleeves", read: "answered", loadingLine: null, problem: null, latestFailed: null, detail: DETAIL, escapeKeepsOpen: false, held: false });
    // A value nothing gives has no tag: the value says so itself, as the drawer's `none` (10a).
    expect(state.rows.map((row) => [row.key, row.row.groups[0].entries[0].value, row.row.groups[0].entries[0].tags])).toEqual([
      ["shippingPolicy", "Fast Free", ["Set for Sleeves"]],
      ["returnPolicy", "30 days", ["Store default"]],
      ["paymentPolicy", "Not set", []],
      ["ebayCategory", "Card Sleeves", ["Set for Sleeves"]],
      ["storeShelf", "Supplies › Sleeves", ["Store default"]],
      ["descriptionTemplate", "Card Shellz text, with your text above", ["Set for Sleeves"]],
    ]);
    const storeText = { ...DETAIL, settings: { ...DETAIL.settings, textBelow: { source: "store_default" as const, value: { mode: "own" as const, text: "Thanks." } } } };
    expect(editor({ detail: { data: storeText } }).rows[5].row.groups[0].entries[0].tags).toEqual(["Set for Sleeves", "Store default"]);
    const noPrice = { ...DETAIL, settings: { ...DETAIL.settings, price: { source: "none" as const, value: null } } };
    expect(editor({ detail: { data: noPrice } }).price).toMatchObject({ value: DRAWER_WORDS.noStorePrice, tag: null });
    for (const row of state.rows) {
      expect(row.row.edit).toMatchObject({ change: { shown: true, disabled: false }, picksDisabled: true, line: null, open: false, marked: false, fieldError: null, pending: null });
      expect(row.row.notes).toEqual([]);
    }
    expect(state.rows[5].row.edit).toMatchObject({ kind: "description", fields: ["textAbove", "textBelow"], check: null });
    expect(state.rows.map((row) => row.fields)).toEqual([["shippingPolicy"], ["returnPolicy"], ["paymentPolicy"], ["ebayCategory"], ["storeShelf"], ["textAbove", "textBelow"]]);
    expect(state.price).toEqual({ label: "Price", value: "Retail price + 20%, round up to .99", tag: "Store default", line: LISTING_SETTINGS_CATEGORY_WORDS.priceReadOnly });
    // The rows' editors open on the category's own values: the read's while the draft holds nothing.
    expect(state.own).toEqual(categoryOwnValues(DETAIL.settings));
    expect(editor({ detail: { data: undefined, error: null } }).own).toBeNull();
    expect(state.footer).toMatchObject({ notSaved: null, primary: { action: "save", label: "Save", disabled: true }, discardDisabled: true, message: null });
    // Only the boxes that can show (8.4): the category's own shipping policy and text above have products holding their own.
    expect(state.rows.map((row) => row.clears.map((box) => [box.field, box.count, box.ticked, box.disabled]))).toEqual([
      [["shippingPolicy", 2, false, false]], [], [], [], [], [["textAbove", 1, false, false]],
    ]);
    expect(state.rows[0].clears[0]).toMatchObject({ line: "2 products in Sleeves have their own shipping policy.", label: "Also clear theirs, so all 15 use this one." });
    expect(state.rows[5].clears[0]).toMatchObject({ line: "1 product in Sleeves has its own text above." });
    for (const row of state.rows) for (const box of row.clears) { expectPlain(box.line); expectPlain(box.label); }
  });

  it("shows the draft's changes and ticks, counts them in the footer, and shows a box once its field is set", () => {
    const draft = categoryDraft({ storeShelf: SET_SHELF, ebayCategory: { mode: "default" }, textAbove: { mode: "default" } }, ["storeShelf", "shippingPolicy"]);
    const state = editor({ draft });
    expect(state.footer).toMatchObject({ notSaved: "● Not saved · 4 changes", primary: { action: "save", label: "Save", disabled: false }, discardDisabled: false });
    expect(editor({ draft, compact: true }).footer).toMatchObject({ notSaved: "● Not saved · 4", primary: { label: "Save" } });
    expect(state.rows[4].row.edit).toMatchObject({ kind: "field", field: "storeShelf", choice: SET_SHELF, pending: "→ Supplies › Boxes · Not saved" });
    // The category editor's word for the default (D17), in a field's line and in the description's.
    expect(state.rows[3].row.edit).toMatchObject({ pending: "→ Use store default · Not saved" });
    expect(state.rows[5].row.edit).toMatchObject({ kind: "description", pending: "→ Text above: Use store default · Not saved" });
    // "Use store default" on a field the store already gives is no change: the return policy stays as it is.
    expect(categoryDraft({ returnPolicy: { mode: "default" } }).changes).toBe(0);
    // The text above's box goes with "Use store default" on it (8.4); the shelf's shows once it is set.
    expect(state.rows.map((row) => row.clears.map((box) => [box.field, box.ticked]))).toEqual([[["shippingPolicy", true]], [], [], [], [["storeShelf", true]], []]);
    expect(state.rows[4].clears[0]).toMatchObject({ count: 2, line: "2 products in Sleeves have their own store shelf." });
    // With "Use store default" on the shipping policy its box goes (never pins the store default, 8.4).
    expect(editor({ draft: categoryDraft({ shippingPolicy: { mode: "default" } }) }).rows[0].clears).toEqual([]);
  });

  it("waits for the draft, locks while a save is out or unconfirmed, marks fields after Load latest and names a refused field", () => {
    const noDraft = editor();
    for (const row of noDraft.rows) {
      expect(row.row.edit).toMatchObject({ change: { shown: true, disabled: true } });
      for (const box of row.clears) expect(box.disabled).toBe(true);
    }
    const saving = categoryDraft({ shippingPolicy: SET_F1 }, ["shippingPolicy"], { type: "startSave", attempt: { signature: "s", key: "ls-cat:1" } });
    const locked = editor({ draft: saving });
    expect(locked).toMatchObject({ escapeKeepsOpen: true, held: true, footer: { primary: { action: "none", label: "Saving…" } } });
    expect(locked.rows[0]).toMatchObject({ row: { edit: { change: { disabled: true }, pending: "→ Standard · Not saved" } }, clears: [{ ticked: true, disabled: true }] });
    const uncertain = run([{ type: "failure", key: "ls-cat:1", failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null } }], saving);
    expect(editor({ draft: uncertain }).footer).toMatchObject({ primary: { action: "resend", label: "Check again", disabled: false }, message: { text: "We couldn't confirm your save.", tone: "alert" } });
    const conflict = run([{ type: "failure", key: "ls-cat:1", failure: { phase: "conflict", message: "This changed in another window.", code: "C", status: 409 } }], saving);
    expect(editor({ draft: conflict }).footer).toMatchObject({ primary: { action: "load_latest", label: "Load latest and keep my changes" } });
    const rebased = run([{ type: "rebase", latest: categoryDraftValue({ ...DETAIL, revisionId: 8 }), marked: ["shippingPolicy"] }], conflict);
    expect(editor({ draft: rebased }).rows[0].row.edit).toMatchObject({ marked: true });
    expect(editor({ draft: rebased }).rows[1].row.edit).toMatchObject({ marked: false });
    const refused = run([{ type: "failure", key: "ls-cat:1", failure: { phase: "refused", message: "That policy is no longer on eBay. Pick another one.", code: "X", status: 422, fields: ["shippingPolicy"] } }], saving);
    const named = editor({ draft: refused, failure: { message: "That policy is no longer on eBay. Pick another one.", fields: ["shippingPolicy"] } });
    expect(named.rows[0].row.edit).toMatchObject({ fieldError: "That policy is no longer on eBay. Pick another one." });
    expect(named.footer.message).toBeNull();
    const unnamed = editor({ draft: run([{ type: "failure", key: "ls-cat:1", failure: { phase: "refused", message: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, code: "O", status: 409, fields: [] } }], saving), failure: { message: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, fields: [] } });
    expect(unnamed.footer.message).toEqual({ text: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, tone: "alert" });
    expect(editor({ draft: categoryDraft({ shippingPolicy: SET_F1 }), fieldEditorOpen: true }).footer).toMatchObject({ primary: { disabled: true }, message: { text: "Press Done or Cancel first." } });
  });

  it("says it is loading, that the read failed, that the category is gone, too large or too many checks (3.7)", () => {
    expect(editor({ detail: { data: undefined } })).toMatchObject({ read: "loading", title: "Sleeves · 15 products", loadingLine: "Loading Sleeves…", rows: [], price: null, detail: null, footer: { primary: { disabled: true } } });
    expect(editor({ detail: { data: undefined }, category: null }).loadingLine).toBe("Loading…");
    expect(editor({ detail: { error: new TypeError("offline") } })).toMatchObject({ read: "failed", problem: { kind: "failed", text: "Couldn't load category settings.", retryLabel: "Try again" }, latestFailed: null, rows: [] });
    expect(editor({ detail: { error: apiError(404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND") } }).problem).toEqual({ kind: "not_found", text: "No chosen product is in this category any more.", retryLabel: null });
    expect(editor({ detail: { error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") } }).problem).toEqual({ kind: "too_large", text: LISTING_SETTINGS_CATEGORY_WORDS.readTooLarge, retryLabel: null });
    expect(editor({ detail: { error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") } }).problem).toEqual({ kind: "rate_limited", text: DRAWER_WORDS.readRateLimited, retryLabel: "Try again" });
    // An answer for another category is not this editor's.
    expect(editor({ detail: { data: { ...DETAIL, categoryId: 41 } } })).toMatchObject({ read: "loading", rows: [], detail: null });
  });

  it("keeps the rows, the footer and a held draft's Check again when a refresh fails, and says so; a 404 or a 422 replaces the view", () => {
    // A save's re-read, Load latest or Reload failed: React Query keeps the last answer beside the error.
    const kept = editor({ detail: { data: DETAIL, error: new TypeError("offline") }, draft: UNCERTAIN });
    expect(kept).toMatchObject({ read: "answered", problem: null, loadingLine: null, detail: DETAIL, latestFailed: { kind: "failed", text: DRAWER_WORDS.latestFailed, retryLabel: "Try again" }, held: true });
    expect(kept.rows).toHaveLength(6);
    expect(kept.rows[0].row.edit).toMatchObject({ pending: "→ Standard · Not saved" });
    expect(kept.footer).toMatchObject({ primary: { action: "resend", label: "Check again", disabled: false }, message: { text: "We couldn't confirm your save." } });
    const stale = run([{ type: "saved", key: "ls-cat:1", nowMs: 1_000, viewStale: true }], SAVING);
    expect(editor({ detail: { data: DETAIL, error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") }, draft: stale })).toMatchObject({
      read: "answered", latestFailed: { kind: "rate_limited", text: DRAWER_WORDS.readRateLimited }, footer: { primary: { action: "reload", label: "Reload", disabled: false } },
    });
    // The category is gone, or the selection too large: nothing of the old answer shows (8.6, D18).
    expect(editor({ detail: { data: DETAIL, error: apiError(404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND") }, draft: UNCERTAIN })).toMatchObject({
      read: "failed", problem: { kind: "not_found" }, latestFailed: null, detail: null, rows: [], price: null,
    });
    expect(editor({ detail: { data: DETAIL, error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") } })).toMatchObject({ read: "failed", problem: { kind: "too_large" }, detail: null, rows: [] });
  });

  it("offers no save while the store holds older group rules (D11), as the card does, unless this category's save is out or unconfirmed", () => {
    const older = summary({ ebayCategory: 1 });
    const clean = editor({ summary: older, draft: OPENED });
    for (const row of clean.rows) {
      expect(row.row.edit).toMatchObject({ change: { shown: false }, line: null });
      expect(row.clears).toEqual([]);
    }
    expect(clean.footer).toMatchObject({ primary: { action: "save", disabled: true }, discardDisabled: true, message: { text: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, tone: "status" } });
    // A change already held is kept, with Discard, and the same line.
    const dirty = editor({ summary: older, draft: categoryDraft({ shippingPolicy: SET_F1 }, ["shippingPolicy"]) });
    expect(dirty.footer).toMatchObject({ notSaved: "● Not saved · 2 changes", primary: { action: "save", disabled: true }, discardDisabled: false, message: { text: LISTING_SETTINGS_CATEGORY_WORDS.olderRules } });
    expect(dirty.rows[0].row.edit).toMatchObject({ change: { shown: false }, pending: "→ Standard · Not saved" });
    // The 409's own words win over the line (the refusal is told once).
    const refused = run([{ type: "failure", key: "ls-cat:1", failure: { phase: "refused", message: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, code: "O", status: 409, fields: [] } }], SAVING);
    expect(editor({ summary: older, draft: refused, failure: { message: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, fields: [] } }).footer)
      .toMatchObject({ primary: { action: "save", disabled: true }, message: { text: LISTING_SETTINGS_CATEGORY_WORDS.olderRules, tone: "alert" } });
    // A save out or unconfirmed keeps its Check again (CC-C25: the replay probe runs before the older-rules check).
    expect(editor({ summary: older, draft: SAVING })).toMatchObject({ held: true, footer: { primary: { action: "none", label: "Saving…" } } });
    const uncertain = editor({ summary: older, draft: UNCERTAIN });
    expect(uncertain.footer).toMatchObject({ primary: { action: "resend", label: "Check again", disabled: false }, message: { text: "We couldn't confirm your save." } });
    expect(uncertain.rows[0]).toMatchObject({ row: { edit: { change: { shown: true, disabled: true } } }, clears: [{ ticked: true, disabled: true }] });
    // Load latest after a conflict is a read: still offered.
    const conflict = run([{ type: "failure", key: "ls-cat:1", failure: { phase: "conflict", message: "This changed in another window.", code: "C", status: 409 } }], SAVING);
    expect(editor({ summary: older, draft: conflict }).footer).toMatchObject({ primary: { action: "load_latest", disabled: false }, message: { text: "This changed in another window." } });
    // Unknown (the summary loading or failed): not gated here; the 409 stays the backstop.
    expect(editor({ summary: { data: undefined }, draft: categoryDraft({ shippingPolicy: SET_F1 }) }).footer).toMatchObject({ primary: { action: "save", disabled: false }, message: null });
    expect(editor({ summary: summary(), draft: OPENED }).rows.every((row) => row.row.edit?.change.shown === true)).toBe(true);
  });

  it("offers only Use store default under a sign-in, says so, and nothing while W12 is off", () => {
    const draft = run([{ type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(DETAIL) }]);
    const signIn = editor({ draft, rights: rights({ setup: { data: undefined, error: apiError(403, "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED") } }) });
    expect(signIn.rows[0].row.edit).toMatchObject({ canSet: false, canDefault: true, change: { shown: true, disabled: false }, line: LISTING_SETTINGS_EDIT_WORDS.signInFieldLine });
    expect(signIn.rows[5].row.edit).toMatchObject({ canSet: true, canNone: true, line: null });
    // A clear-only save needs no eBay call: the box stays.
    expect(signIn.rows[0].clears).toEqual([expect.objectContaining({ field: "shippingPolicy", disabled: false })]);
    const paused = editor({ draft, rights: rights({ account: { status: "paused", entitlementStatus: "active" } }) });
    for (const row of paused.rows) {
      expect(row.row.edit).toMatchObject({ change: { shown: false }, line: null });
      // A row without [Change] clears nothing: no box under it.
      expect(row.clears).toEqual([]);
    }
    expect(paused.footer.primary.disabled).toBe(true);
  });
});

describe("W12's own refusals, code by code (plan 8.6)", () => {
  const W12 = (status: number, code: string | null, context?: Record<string, unknown>) =>
    classifyWriteFailure("W12", apiError(status, code, context), { categoryName: "Sleeves" });

  it("words every 8.6 code: older rules refused, the two conflicts, the category gone, too much text; a price can't happen", () => {
    const rows: Array<[number, string, Record<string, unknown> | undefined, WriteFailurePhase, string]> = [
      [409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT", { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 }, "refused", LISTING_SETTINGS_CATEGORY_WORDS.olderRules],
      [409, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", { categoryId: 40, expectedRevisionId: 7, actualRevisionId: 8 }, "conflict", "This changed in another window."],
      [409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflicts: [{ productId: 12 }], conflictCount: 1 }, "conflict", "The products in Sleeves changed. Load the latest and save again. A Card Shellz change can take a minute to show."],
      [404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", { categoryId: 40 }, "refused", "No chosen product is in this category any more."],
      [422, "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { textBytes: 30_000_100, maxTextBytes: 30_000_000, productCount: 3 }, "refused", LISTING_SETTINGS_BULK_WORDS.tooMuchText],
      [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "heavy_write_in_progress" }, "unreachable", LISTING_SETTINGS_EDIT_WORDS.busyHeavy],
      [503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "request_key_changed" }, "unreachable", LISTING_SETTINGS_EDIT_WORDS.busyKeyChanged],
      [503, "DROPSHIP_LISTING_SETTINGS_BUSY", undefined, "uncertain", "We couldn't confirm your save."],
      [422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", undefined, "refused", LISTING_SETTINGS_EDIT_WORDS.invalid],
      [409, "DROPSHIP_LISTING_PRICES_MOVED", undefined, "refused", LISTING_SETTINGS_EDIT_WORDS.invalid],
      [404, "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", { productId: 12 }, "refused", LISTING_SETTINGS_EDIT_WORDS.invalid],
      [404, "DROPSHIP_PRICING_REVIEW_NOT_FOUND", undefined, "refused", LISTING_SETTINGS_EDIT_WORDS.invalid],
      [500, "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", undefined, "refused", LISTING_SETTINGS_EDIT_WORDS.fatal],
      [403, "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED", { fields: ["shippingPolicy"] }, "blocked", "Nothing was saved."],
      [422, "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", { invalidFields: ["returnPolicy"] }, "refused", LISTING_SETTINGS_EDIT_WORDS.policyGone],
    ];
    for (const [status, code, context, phase, message] of rows) {
      expect({ input: code, ...W12(status, code, context) }).toEqual({ input: code, code, phase, message, status, fields: expect.any(Array) });
      expectPlain(message);
    }
    // The product conflict without a category name still reads.
    expect(classifyWriteFailure("W12", apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 2 })).message)
      .toBe("The products in this category changed. Load the latest and save again. A Card Shellz change can take a minute to show.");
    // The other writers keep their own words for the same codes.
    expect(classifyWriteFailure("W6", apiError(409, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 2 })).message).toBe("2 of the selected products changed in another window.");
    expect(classifyWriteFailure("W5", apiError(409, "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT")).message).toBe(LISTING_SETTINGS_EDIT_WORDS.invalid);
    expect(classifyWriteFailure("W7", apiError(404, "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND")).message).toBe(LISTING_SETTINGS_EDIT_WORDS.invalid);
  });
});

describe("never mutates its inputs", () => {
  it("builds every value from frozen inputs without throwing, and returns fresh objects", () => {
    const picks = deepFreeze({ shippingPolicy: SET_F1, storeShelf: SET_SHELF });
    const value = categoryDraftValue(DETAIL, choices(picks), deepFreeze(["storeShelf", "shippingPolicy"]));
    expect(value.storeShelf).not.toBe(picks.storeShelf);
    expect(value.storeShelf).toEqual(picks.storeShelf);
    const before = JSON.stringify(DETAIL);
    categoryPatch(value);
    categoryClearBody(value);
    categorySignature(STORE, CATEGORY, 7, categoryPatch(value), categoryClearBody(value));
    rebaseCategoryDraft(value, DETAIL);
    categorySettingsCardState({ read: { data: LIST, error: null }, summary: summary({ price: 1 }), draft: categoryDraft(picks), right: EDITABLE });
    categoryEditorState({
      category: null, categoryId: CATEGORY, detail: { data: DETAIL, error: null }, summary: summary({ price: 1 }), draft: categoryDraft(picks, ["shippingPolicy"]),
      rights: rights(), setup: LIVE, shelves: SHELVES, openTarget: "storeShelf", failure: null, busy: false, savedFlashVisible: false, compact: false, fieldEditorOpen: false,
    });
    expect(JSON.stringify(DETAIL)).toBe(before);
    expect(JSON.stringify(LIST)).toBe(JSON.stringify(listingSettingsCategoriesResponseSchema.parse(LIST)));
  });
});
