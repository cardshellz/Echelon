import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  listingSettingsSummarySchema,
  type ListingSettingsCategoriesResponse,
  type ListingSettingsCategoryDetail,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { listingSettingsCategoriesQueryOptions, listingSettingsCategoryQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import {
  categoryDraftValue,
  categorySettingsCardState,
  emptyCategoryChoices,
  type CategoryCardInput,
  type CategoryChoices,
  type CategoryPriceChange,
  type CategorySettingsRights,
} from "@/lib/dropship-listing-settings-categories";
import { categoryEditorId, reduceListingSettingsDraft, type ListingSettingsDraft, type ListingSettingsDraftAction } from "@/lib/dropship-listing-settings-drafts";
import { productPriceEditorModel } from "@/lib/dropship-listing-settings-price-check";
import type { PriceCheckRef } from "@/lib/dropship-listing-settings-product-edit";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { CategoryEditor, CategoryPriceRowItem, ClearTheirsBox, type CategoryEditorProps } from "../listing-settings/CategoryEditor";
import { ProductPriceEditor } from "../listing-settings/ProductPriceEditor";
import { CategoryCardRowItem, CategorySettingsCard, CategorySettingsCardView } from "../listing-settings/CategorySettingsCard";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsStep, type ListingSettingsStepProps } from "../listing-settings/ListingSettingsStep";

/**
 * The Category settings card and the category editor (Listing settings PR 10e, plan 8.2, 8.3, 8.4, 8.7, 3.7):
 * the card's states, the editor's states and the "Also clear theirs" box rules, and the step's wiring (the card
 * between the Store defaults card and the tabs, `?category=<id>` opening the editor, hidden while too large).
 * From PR 10f (plan 9.2, 9.3, 9.6): the Price row with its Change, the examples as "Now:" hidden while the price
 * is changed, the price's clear box, Save as [Check new prices], and the check body in place of the editor's
 * (D20) with its "Also saves" lines. Static renders, as the other step tests: the step's one draft is set per
 * test, the reads are put in the query cache, and what a button does is checked on the hook-free row and box views.
 */

const state = vi.hoisted(() => ({ drafts: null as unknown }));

vi.mock("../listing-settings/ListingSettingsDraftsProvider", async () => {
  const actual = await vi.importActual<typeof import("../listing-settings/ListingSettingsDraftsProvider")>(
    "../listing-settings/ListingSettingsDraftsProvider");
  return { ...actual, useListingSettingsDrafts: () => (state.drafts as ListingSettingsDraftsValue | null) ?? actual.useListingSettingsDrafts() };
});

/** Radix renders a sheet into a portal, which a static render leaves out: render it in place (plan 3.1: every export). */
vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? createElement("div", { "data-mock": "sheet" }, children) : null),
    SheetContent: ({ children, "data-testid": testId }: Props) => createElement("div", { "data-testid": testId }, children),
    SheetHeader: ({ children }: Props) => createElement("div", null, children),
    SheetTitle: ({ children }: Props) => createElement("h2", null, children),
    SheetDescription: ({ children }: Props) => createElement("p", null, children),
    SheetFooter: ({ children }: Props) => createElement("div", null, children),
  };
});

const STORE = 22;
const CATEGORY = 40;
const GENERATED_AT = "2026-10-09T12:00:00.000Z";
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.drafts = null;
});

// ---------------------------------------------------------------------------
// Fixtures, each checked against the shared contract
// ---------------------------------------------------------------------------

const LIST: ListingSettingsCategoriesResponse = listingSettingsCategoriesResponseSchema.parse({
  storeConnectionId: STORE,
  categories: [
    { categoryId: 42, name: "Cases", productCount: 1, revisionId: null, setFields: [] },
    { categoryId: CATEGORY, name: "Sleeves", productCount: 15, revisionId: 7, setFields: ["shippingPolicy", "textAbove"] },
    { categoryId: 41, name: "Toploaders", productCount: 3, revisionId: 9, setFields: ["storeShelf"] },
  ],
  uncategorizedProductCount: 4,
  generatedAt: GENERATED_AT,
});

/** Sleeves: sets its shipping policy and text above; the store gives its return policy and price; two products hold their own shipping policy. */
const DETAIL: ListingSettingsCategoryDetail = listingSettingsCategoryDetailSchema.parse({
  storeConnectionId: STORE, categoryId: CATEGORY, name: "Sleeves", productCount: 15, revisionId: 7,
  settings: {
    price: { source: "store_default", value: { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" } },
    ebayCategory: { source: "none", value: null },
    storeShelf: { source: "none", value: null },
    shippingPolicy: { source: "category", value: { id: "priority", name: "USPS Priority Mail" } },
    returnPolicy: { source: "store_default", value: { id: "returns", name: null } },
    paymentPolicy: { source: "store_default", value: { id: "payments", name: null } },
    textAbove: { source: "category", value: { mode: "own", text: "Ships fast." } },
    textBelow: { source: "none", value: null },
  },
  ownValues: [
    { productId: 12, revisionId: null, fields: ["storeShelf", "shippingPolicy"] },
    { productId: 11, revisionId: 5, fields: ["shippingPolicy"] },
  ],
  examples: [],
  generatedAt: GENERATED_AT,
});

const SETUP: PolicySetupFacts = {
  selection: { merchantLocationKey: "managed", fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" },
  storedNames: { fulfillmentPolicyName: "USPS Ground Advantage", returnPolicyName: "30-day returns", paymentPolicyName: "Managed payments" },
  options: {
    merchantLocations: [],
    fulfillmentPolicies: [
      { id: "ground", name: "USPS Ground Advantage", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
      { id: "priority", name: "USPS Priority Mail", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
    ],
    returnPolicies: [{ id: "returns", name: "30-day returns" }],
    paymentPolicies: [{ id: "payments", name: "Managed payments" }],
  },
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  fulfillmentCapability: null,
};
const LIVE: ListingSettingsReadState<PolicySetupFacts> = { data: SETUP, error: null };

type Summary = Pick<ListingSettingsSummary, "catalog" | "storeDefaults">;

function summaryFacts(groupRules = 0, catalogState: "ok" | "too_large" = "ok"): { data: Summary; error: null } {
  return {
    data: {
      catalog: catalogState === "ok" ? { state: "ok", products: 20, sizes: 60 } : { state: "too_large", limit: 10_000 },
      storeDefaults: {
        price: { recipe: null, groupRules },
        shippingPolicy: { policyId: "ground", verification: "not_checked" },
        returnPolicy: { policyId: "returns", verification: "not_checked" },
        paymentPolicy: { policyId: "payments", verification: "not_checked" },
        ebayCategory: { category: null, groupRules: 0 },
        description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
      },
    },
    error: null,
  };
}

const RIGHTS: CategorySettingsRights = { categorySettings: EDITABLE, shipping: EDITABLE, policies: EDITABLE, ebayCategory: EDITABLE, shelfPick: EDITABLE, priceCheck: EDITABLE };
const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 0, rounding: "cent" };
const CHECK: PriceCheckRef = { reviewId: "11111111-1111-4111-8111-111111111111", reviewHash: "a".repeat(64), after: null };
/** One example price of the category's sizes, as the detail lists them (current prices, CC-C23). */
function example(productVariantId: number, sizeName: string, priceCents: number | null) {
  return {
    productVariantId, productId: 11, productName: "Penny Sleeves", sizeName, sku: null, priceCents, source: "retail_fallback", rule: null, basis: null,
    basisAmountCents: null, issue: null, costCents: 210, belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: null,
  };
}
/** Sleeves with two example prices, and a third product holding its own price. */
const WITH_EXAMPLES: ListingSettingsCategoryDetail = listingSettingsCategoryDetailSchema.parse({
  ...DETAIL, examples: [example(101, "Pack of 100", 499), example(102, "Box of 5", 2199)],
  ownValues: [...DETAIL.ownValues, { productId: 14, revisionId: 3, fields: ["price"] }],
});

type Phase = "editing" | "saving" | "uncertain" | "refused" | "conflict" | "saved_view_stale";

function run(actions: readonly ListingSettingsDraftAction[]): ListingSettingsDraft {
  const draft = actions.reduce<ListingSettingsDraft | null>((current, action) => reduceListingSettingsDraft(current, action), null);
  if (draft === null) throw new Error("expected a draft");
  return draft;
}

/** Sleeves' draft opened on `detail`, edited to `edit` with `clear` ticked (and `price`, PR 10f), then settled as `phase` with its words. */
function categoryDraft(edit: Partial<CategoryChoices> = {}, clear: readonly ("shippingPolicy" | "storeShelf" | "textAbove" | "price")[] = [],
  phase: Phase = "editing", message: string | null = null, price?: CategoryPriceChange, detail: ListingSettingsCategoryDetail = DETAIL): ListingSettingsDraft {
  const base = categoryDraftValue(detail);
  const opened: ListingSettingsDraftAction[] = [
    { type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base },
    { type: "edit", value: categoryDraftValue(detail, { ...emptyCategoryChoices(), ...edit }, clear, price) },
  ];
  if (phase === "editing") return run(opened);
  const saving: ListingSettingsDraftAction[] = [...opened, { type: "startSave", attempt: { signature: "s", key: "ls-cat:k1" } }];
  if (phase === "saving") return run(saving);
  if (phase === "saved_view_stale") return run([...saving, { type: "saved", key: "ls-cat:k1", nowMs: 1_000, viewStale: true }]);
  return run([...saving, { type: "failure", key: "ls-cat:k1", failure: { phase, message: message ?? "", code: null, status: null } }]);
}

/** Sleeves' draft on WITH_EXAMPLES holding `price` (a check too when given), with `edit` and `clear` riding along (D2), settled as `phase`. */
function pricedDraft(price: CategoryPriceChange, edit: Partial<CategoryChoices> = {}, clear: readonly ("shippingPolicy" | "storeShelf" | "price")[] = [],
  phase: Phase = "editing", message: string | null = null): ListingSettingsDraft {
  return categoryDraft(edit, clear, phase, message, price, WITH_EXAMPLES);
}

function draftsValue(draft: ListingSettingsDraft | null): ListingSettingsDraftsValue {
  const value: ListingSettingsDraftsValue = {
    draft, savedFlashVisible: false, now: () => 2_000,
    open: vi.fn(() => true), edit: vi.fn(), startSave: vi.fn(() => null), settle: vi.fn(), rebase: vi.fn(),
    discard: vi.fn(), close: vi.fn(), requestClose: vi.fn(),
  };
  state.drafts = value;
  return value;
}

/** A window whose `matchMedia` answers `wide` for every query (the phone layout is below 640 px). */
function stubWidth(wide: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: wide, media: query, addEventListener: noop, removeEventListener: noop }),
  });
}

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
}

type Seeded<T> = T | { error: unknown; kept?: T } | undefined;

/** Puts a read's answer, failure (with the last answer kept beside it, as React Query does after a failed refetch) or nothing (still loading) under its key. */
function seed<T>(cache: QueryClient, options: { queryKey: readonly unknown[] }, answer: Seeded<T>) {
  if (answer === undefined) return;
  if (typeof answer === "object" && answer !== null && "error" in answer) {
    if (answer.kept !== undefined) cache.setQueryData(options.queryKey as unknown[], answer.kept);
    cache.getQueryCache().build(cache, { queryKey: options.queryKey as unknown[] })
      .setState({ status: "error", error: answer.error as Error, fetchStatus: "idle", errorUpdatedAt: 1, errorUpdateCount: 1 });
    return;
  }
  cache.setQueryData(options.queryKey as unknown[], answer);
}

function render(node: React.ReactElement, cache = client()): string {
  vi.stubGlobal("React", React);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: cache }, node))
      .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  } finally {
    cache.clear();
  }
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** The markup of one element with this test id, to its closing tag of `tag`. */
function sliceOf(markup: string, testId: string, tag: string): string {
  const start = markup.indexOf(`data-testid="${testId}"`);
  expect(start, testId).toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf(`</${tag}>`, start));
}

type Element = React.ReactElement<{ children?: unknown; onClick?: () => void; onChange?: (event: unknown) => void; "aria-label"?: string; type?: string }>;
/** Every element with a click or a change handler, outermost first (the `Button`s, which a forwardRef draws, and inputs). */
function pressable(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(pressable);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  const own = typeof element.props.onClick === "function" || typeof element.props.onChange === "function" ? [element] : [];
  return [...own, ...pressable(element.props.children)];
}

// ---------------------------------------------------------------------------
// The card (plan 8.3, 3.7, D11, D18)
// ---------------------------------------------------------------------------

function cardState(overrides: Partial<CategoryCardInput> = {}) {
  return categorySettingsCardState({ read: { data: LIST, error: null }, summary: summaryFacts(), draft: null, right: EDITABLE, ...overrides });
}

function renderCardView(overrides: Partial<CategoryCardInput> = {}): string {
  return render(React.createElement(CategorySettingsCardView, { card: cardState(overrides), onChange: noop, onRetry: noop }));
}

describe("the Category settings card", () => {
  it("lists each category as the server lists it, with what it sets, Change named with the category, and the uncategorized line", () => {
    const markup = renderCardView();
    expect(count(markup, 'data-testid="category-settings-card"')).toBe(1);
    expect(markup).toContain(">Category settings</h3>");
    expect(markup).toContain("Products in a Card Shellz category use its settings before your store defaults.");
    const rows = sliceOf(markup, "category-settings-rows", "ul");
    expect(rows.indexOf('data-testid="category-settings-row-42"')).toBeLessThan(rows.indexOf('data-testid="category-settings-row-40"'));
    expect(rows.indexOf('data-testid="category-settings-row-40"')).toBeLessThan(rows.indexOf('data-testid="category-settings-row-41"'));
    expect(sliceOf(markup, "category-settings-row-42", "li")).toContain('<span class="font-medium">Cases</span> · 1 product · Uses your store defaults');
    expect(sliceOf(markup, "category-settings-row-40", "li")).toContain('<span class="font-medium">Sleeves</span> · 15 products · Sets: shipping policy, text above');
    expect(sliceOf(markup, "category-settings-row-41", "li")).toContain("Toploaders</span> · 3 products · Sets: store shelf");
    for (const name of ["Cases", "Sleeves", "Toploaders"]) {
      expect(markup).toMatch(new RegExp(`<button class="[^"]*min-h-11[^"]*" type="button" aria-label="Change settings for ${name}">Change</button>`));
    }
    expect(markup).toContain('data-testid="category-settings-uncategorized">4 products have no Card Shellz category. They use your store defaults.</p>');
    expect(markup).not.toContain('data-testid="category-settings-empty"');
    expect(markup).not.toContain('data-testid="category-settings-older-rules"');
    expect(markup).not.toContain('data-testid="category-settings-loading"');
    expect(markup).not.toContain('disabled=""');
  });

  it("shows skeleton rows while it loads, Try again when the read failed, the rate-limit words for a 429, and the empty words", () => {
    const loading = renderCardView({ read: { data: undefined, error: null } });
    expect(loading).toMatch(/<section aria-labelledby="[^"]*" aria-busy="true" data-testid="category-settings-card"/);
    expect(count(loading, "animate-pulse")).toBe(2);
    expect(loading).not.toContain("Change");

    const failed = renderCardView({ read: { data: undefined, error: new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." }) } });
    expect(failed).toContain('data-testid="category-settings-read-problem"><span>Couldn\'t load category settings.</span>');
    expect(failed).toMatch(/<div role="alert" class="[^"]*" data-testid="category-settings-read-problem">/);
    expect(failed).toMatch(/<button class="[^"]*" type="button">Try again<\/button>/);
    expect(failed).not.toContain('data-testid="category-settings-loading"');

    const limited = renderCardView({ read: { data: undefined, error: new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Slow down." }) } });
    expect(limited).toContain("Too many checks in a minute. Wait a moment and try again.");

    const empty = renderCardView({ read: { data: { ...LIST, categories: [], uncategorizedProductCount: 1 }, error: null } });
    expect(empty).toContain('<p role="status" class="mt-3 text-sm text-zinc-700" data-testid="category-settings-empty">None of your chosen products is in a Card Shellz category.</p>');
    expect(empty).toContain("1 product has no Card Shellz category. It uses your store defaults.");
    expect(empty).not.toContain('data-testid="category-settings-rows"');
    // No product without a category: no line.
    expect(renderCardView({ read: { data: { ...LIST, uncategorizedProductCount: 0 }, error: null } })).not.toContain('data-testid="category-settings-uncategorized"');

    // A refresh that failed keeps the rows and their Change, and says so over them with Try again.
    const kept = renderCardView({ read: { data: LIST, error: new TypeError("offline") } });
    expect(kept).toContain('data-testid="category-settings-rows"');
    expect(count(kept, 'aria-label="Change settings for')).toBe(3);
    expect(kept).toMatch(/<p role="status" class="[^"]*" data-testid="category-settings-latest-failed"><span>Couldn't load the latest view.<\/span><button class="[^"]*" type="button">Try again<\/button><\/p>/);
    expect(kept).not.toContain('data-testid="category-settings-read-problem"');
    expect(kept).not.toContain('data-testid="category-settings-loading"');
    // The step's line under the card after the editor closed on a gone category (8.6).
    const notice = renderCardView({ notice: "No chosen product is in this category any more." });
    expect(notice).toContain('<p role="status" class="mt-3 text-sm text-amber-900" data-testid="category-settings-notice">No chosen product is in this category any more.</p>');
    expect(renderCardView()).not.toContain('data-testid="category-settings-notice"');
  });

  it("takes every Change away with the one line while the store holds older group rules; a category whose save is out or unconfirmed keeps its Change (D11)", () => {
    const older = renderCardView({ summary: summaryFacts(2) });
    expect(older).not.toContain('aria-label="Change settings for');
    expect(older).toContain('<p role="status" class="mt-3 text-sm text-amber-900" data-testid="category-settings-older-rules">Category settings can\'t be saved while your store has older group rules. They\'ll be moved over in a later update.</p>');
    // The rows still say what each category sets.
    expect(older).toContain("Sets: shipping policy, text above");

    for (const phase of ["saving", "uncertain"] as const) {
      const held = renderCardView({ summary: summaryFacts(2), draft: categoryDraft({ shippingPolicy: { mode: "default" } }, [], phase) });
      expect(count(held, 'aria-label="Change settings for')).toBe(1);
      expect(held).toMatch(/<button class="[^"]*" type="button" aria-label="Change settings for Sleeves">Change<\/button>/);
      expect(held).toContain('data-testid="category-settings-older-rules"');
    }
    // A draft with changes, not out, is no reason to keep [Change]: the save would be refused (the 409 is the backstop).
    expect(renderCardView({ summary: summaryFacts(2), draft: categoryDraft({ shippingPolicy: { mode: "default" } }) })).not.toContain('aria-label="Change settings for');
    // Nothing listed: no line either.
    expect(renderCardView({ summary: summaryFacts(2), read: { data: { ...LIST, categories: [] }, error: null } })).not.toContain('data-testid="category-settings-older-rules"');
  });

  it("turns Change off with Checking… while the summary loads or failed, and with the right's reason", () => {
    const loading = renderCardView({ summary: { data: undefined, error: null } });
    expect(count(loading, 'aria-label="Change settings for')).toBe(3);
    expect(count(loading, 'disabled=""')).toBe(3);
    expect(count(loading, ">Checking…</p>")).toBe(3);
    const failed = renderCardView({ summary: { data: undefined, error: new TypeError("offline") } });
    expect(count(failed, 'disabled=""')).toBe(3);
    // A paused store, or any other banner: [Change] is off and nothing more needs saying (the banner says why).
    const banner = renderCardView({ right: { editable: false, reason: "banner" } });
    expect(count(banner, 'disabled=""')).toBe(3);
    expect(banner).not.toContain("Checking…");
    expect(banner).not.toMatch(/class="text-xs text-zinc-600">/);
    // A reason with words of its own is said under the row.
    const reload = renderCardView({ right: { editable: false, reason: "reload" } });
    expect(count(reload, 'disabled=""')).toBe(3);
    expect(count(reload, 'class="text-xs text-zinc-600">')).toBe(3);
  });

  it("reads its list from the cache through the lib's options, and hides while the selection is too large (D18)", () => {
    draftsValue(null);
    const cache = client();
    seed(cache, listingSettingsCategoriesQueryOptions(STORE), LIST);
    const shown = render(React.createElement(CategorySettingsCard, { storeConnectionId: STORE, summary: summaryFacts(), right: EDITABLE, onChange: noop }), cache);
    expect(shown).toContain("Sets: shipping policy, text above");

    const tooLarge = client();
    seed(tooLarge, listingSettingsCategoriesQueryOptions(STORE), LIST);
    expect(render(React.createElement(CategorySettingsCard, { storeConnectionId: STORE, summary: summaryFacts(0, "too_large"), right: EDITABLE, onChange: noop }), tooLarge)).toBe("");
    // Refused as too large by its own read, before the summary said so: hidden too (the banner explains, through onTooLarge).
    const refused = client();
    seed(refused, listingSettingsCategoriesQueryOptions(STORE), { error: new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "Too many." }) });
    expect(render(React.createElement(CategorySettingsCard, { storeConnectionId: STORE, summary: summaryFacts(), right: EDITABLE, onChange: noop }), refused)).toBe("");
    // Nothing cached: the skeleton.
    expect(render(React.createElement(CategorySettingsCard, { storeConnectionId: STORE, summary: summaryFacts(), right: EDITABLE, onChange: noop }))).toContain('data-testid="category-settings-loading"');
  });

  it("Change hands the step the row it opens the editor on", () => {
    vi.stubGlobal("React", React);
    const onChange = vi.fn();
    const row = cardState().rows[1];
    const buttons = pressable(CategoryCardRowItem({ row, onChange }));
    expect(buttons.map((button) => button.props["aria-label"])).toEqual(["Change settings for Sleeves"]);
    buttons[0].props.onClick?.();
    expect(onChange).toHaveBeenCalledWith({ categoryId: CATEGORY, name: "Sleeves", productCount: 15 });
    // Without [Change] (older rules), nothing to press.
    expect(pressable(CategoryCardRowItem({ row: cardState({ summary: summaryFacts(1) }).rows[1], onChange }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The editor (plan 8.3, 8.4, 3.7)
// ---------------------------------------------------------------------------

function editorProps(overrides: Partial<CategoryEditorProps> = {}): CategoryEditorProps {
  return {
    storeConnectionId: STORE, categoryId: CATEGORY, category: { categoryId: CATEGORY, name: "Sleeves", productCount: 15 },
    summary: summaryFacts(), rights: RIGHTS, setup: LIVE, shelves: [], saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
    onSaved: noop, onClose: noop, ...overrides,
  };
}

/** The open editor with its detail answered (`answer`), failed (`{ error }`) or still loading (undefined), on `draft`. */
function renderEditor(draft: ListingSettingsDraft | null, answer: Seeded<ListingSettingsCategoryDetail>, overrides: Partial<CategoryEditorProps> = {}): string {
  draftsValue(draft);
  const cache = client();
  seed(cache, listingSettingsCategoryQueryOptions(STORE, CATEGORY), answer);
  return render(React.createElement(CategoryEditor, editorProps(overrides)), cache);
}

/** The draft as the editor opens it on DETAIL, with no change. */
const OPENED = run([{ type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(DETAIL) }]);

describe("the category editor", () => {
  it("titles itself, shows each value with where it comes from, the Price row with its Change (PR 10f), and Change on every row named with the category", () => {
    const markup = renderEditor(OPENED, DETAIL);
    expect(count(markup, 'data-testid="category-editor"')).toBe(1);
    expect(markup).toContain("<h2>Sleeves · 15 products</h2>");
    // × is the first button (plan 3.4).
    expect(markup.indexOf('aria-label="Close"')).toBeLessThan(markup.indexOf('data-testid="category-editor-rows"'));
    const price = markup.slice(markup.indexOf('data-testid="category-price-row"'), markup.indexOf('data-testid="drawer-setting-shippingPolicy"'));
    expect(price).toContain(">Price</h4>");
    expect(price).toContain("Retail price + 20%, round up to .99");
    expect(price).toContain(">Store default</span>");
    expect(price).not.toContain("A category's price can't be changed here yet.");
    // Its name starts with its label (WCAG 2.5.3), as the rows' Change does; the words are 10d's PRICE head.
    expect(markup).toMatch(/<button class="[^"]*min-h-11[^"]*" type="button" aria-label="Change price for Sleeves" aria-expanded="false">Change price<\/button>/);
    // Without W7's right at hand (a caller from before 10f) the row reads as it did: no Change, the old line.
    const before = renderEditor(OPENED, DETAIL, { rights: { ...RIGHTS, priceCheck: undefined } });
    expect(before).toContain("A category's price can't be changed here yet.");
    expect(before).not.toContain('aria-label="Change price for Sleeves"');
    // The rows in the drawer's order, each with its tag and [Change].
    const rows = sliceOf(markup, "category-editor-rows", "section");
    const order = ["category-price-row", "drawer-setting-shippingPolicy", "drawer-setting-returnPolicy", "drawer-setting-paymentPolicy",
      "drawer-setting-ebayCategory", "drawer-setting-storeShelf", "drawer-setting-descriptionTemplate"].map((id) => rows.indexOf(`data-testid="${id}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(sliceOf(markup, "drawer-setting-shippingPolicy", "h4")).toContain("Shipping policy");
    expect(markup).toContain("USPS Priority Mail");
    expect(markup).toContain(">Set for Sleeves</span>");
    expect(markup).toContain("30-day returns");
    for (const setting of ["price", "shipping policy", "return policy", "payment policy", "eBay category", "store shelf", "description"]) {
      expect(markup).toContain(`aria-label="Change ${setting} for Sleeves"`);
    }
    expect(rows).not.toContain('disabled=""');
    // The footer with nothing to save.
    expect(markup).toContain('data-testid="category-editor-footer"');
    expect(markup).not.toContain('data-testid="category-editor-not-saved"');
    expect(markup).toMatch(/<button class="[^"]*" type="button" disabled="">Discard<\/button>/);
    expect(markup).toMatch(/<button class="[^"]*" type="button" disabled="">Save<\/button>/);
    // No ids anywhere.
    expect(markup).not.toContain("priority");
    expect(markup).not.toContain('"returns"');
  });

  it("says Loading Sleeves… before its read answers, Try again when it failed, the rate-limit words, the too-large words with no button, and the gone words", () => {
    const loading = renderEditor(null, undefined);
    expect(loading).toContain("<h2>Sleeves · 15 products</h2>");
    expect(loading).toContain('<p role="status" class="text-sm text-zinc-600">Loading Sleeves…</p>');
    expect(loading).not.toContain('data-testid="category-editor-rows"');
    expect(loading).not.toContain('data-testid="category-editor-footer"');
    // From the address alone, with no row to name it.
    const unnamed = renderEditor(null, undefined, { category: null });
    expect(unnamed).toContain("<h2>Category · 0 products</h2>");
    expect(unnamed).toContain(">Loading…</p>");

    const failed = renderEditor(null, { error: new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." }) });
    expect(failed).toContain('data-testid="category-editor-read-problem"><span>Couldn\'t load category settings.</span>');
    expect(failed).toMatch(/<button class="[^"]*" type="button">Try again<\/button>/);

    const limited = renderEditor(null, { error: new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Slow down." }) });
    expect(limited).toContain("Too many checks in a minute. Wait a moment and try again.");

    const tooLarge = renderEditor(null, { error: new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "Too many." }) });
    expect(tooLarge).toContain("This category can't be checked until you choose 10,000 or fewer sizes.");
    expect(sliceOf(tooLarge, "category-editor-read-problem", "div")).not.toContain("<button");

    const gone = renderEditor(null, { error: new DropshipApiError({ status: 404, code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", message: "Gone." }) });
    expect(gone).toContain("No chosen product is in this category any more.");
    expect(sliceOf(gone, "category-editor-read-problem", "div")).not.toContain("<button");
  });

  it("keeps every Change off until the draft is open, and while a save is out or unconfirmed; renders its rows over another editor's clean draft, with Change waiting for its own", () => {
    const noDraft = renderEditor(null, DETAIL);
    expect(count(noDraft, 'aria-label="Change ')).toBe(7);
    expect(noDraft).toMatch(/aria-label="Change shipping policy for Sleeves" aria-expanded="false" disabled=""/);
    const saving = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "saving"), DETAIL);
    // Back on [Change], the change not saved yet is read with it (aria-describedby names the pending line).
    expect(saving).toMatch(/aria-label="Change shipping policy for Sleeves"(?: aria-describedby="[^"]+")? aria-expanded="false" disabled=""/);
    expect(saving).toContain("→ Use store default · Not saved");
    expect(saving).toContain(">Saving…</button>");
    // Another editor's clean draft: the rows render, with every [Change] off until the category's own draft opens (the
    // open effect runs in the browser; the lib's `categoryEditorOpen` pins that it opens over a clean draft).
    const other = run([{ type: "open", editor: "price", place: "Price", base: {} }]);
    const over = renderEditor(other, DETAIL);
    expect(over).toContain('data-testid="category-editor-rows"');
    expect(count(over, 'aria-label="Change ')).toBe(7);
    expect(count(over, 'aria-expanded="false" disabled=""')).toBe(7);
    expect(over).toContain('data-testid="category-editor-footer"');
  });

  it("keeps the rows and the footer when a refresh fails, so Reload after a stale view and Check again stay reachable, and says the latest read failed", () => {
    // A save's re-read failed: the draft says "Saved. We couldn't load the latest view." and React Query keeps the last answer beside the error.
    const stale = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "saved_view_stale"), { kept: DETAIL, error: new TypeError("offline") });
    expect(stale).toContain('data-testid="category-editor-rows"');
    expect(stale).toContain("USPS Priority Mail");
    expect(stale).toMatch(/<p role="status" class="[^"]*" data-testid="category-editor-latest-failed">Couldn't load the latest view.<button class="[^"]*" type="button">Try again<\/button><\/p>/);
    expect(stale).not.toContain('data-testid="category-editor-read-problem"');
    expect(stale).toContain("Saved. We couldn't load the latest view.");
    expect(stale).toMatch(/<button class="[^"]*" type="button">Reload<\/button>/);
    // A save nobody could confirm keeps its Check again over the kept rows.
    const uncertain = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "uncertain", "We couldn't confirm your save."), { kept: DETAIL, error: new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Slow down." }) });
    expect(uncertain).toContain('data-testid="category-editor-rows"');
    expect(uncertain).toContain("Too many checks in a minute. Wait a moment and try again.");
    expect(uncertain).toMatch(/<button class="[^"]*" type="button">Check again<\/button>/);
    // The category is gone: the old answer is not shown (the editor closes in the browser, 8.6).
    const gone = renderEditor(null, { kept: DETAIL, error: new DropshipApiError({ status: 404, code: "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND", message: "Gone." }) });
    expect(gone).toContain("No chosen product is in this category any more.");
    expect(gone).not.toContain('data-testid="category-editor-rows"');
    expect(gone).not.toContain('data-testid="category-editor-footer"');
  });

  it("offers no save while the store holds older group rules (D11): no Change, no box, Save off with the one line; a save out or unconfirmed keeps Check again", () => {
    const gated = renderEditor(OPENED, DETAIL, { summary: summaryFacts(2) });
    expect(gated).toContain('data-testid="category-editor-rows"');
    expect(gated).not.toContain('aria-label="Change ');
    expect(gated).not.toContain('data-testid="category-clear-');
    expect(gated).toMatch(/<button class="[^"]*" type="button" disabled="">Save<\/button>/);
    expect(sliceOf(gated, "category-editor-footer", "div")).toContain("Category settings can't be saved while your store has older group rules. They'll be moved over in a later update.");
    // A change held from before the rules came: kept, Discard on, Save off.
    const held = renderEditor(categoryDraft({ shippingPolicy: { mode: "set", value: { id: "ground" } } }, ["shippingPolicy"]), DETAIL, { summary: summaryFacts(2) });
    expect(held).toContain("→ USPS Ground Advantage · Not saved");
    expect(held).toMatch(/<button class="[^"]*" type="button">Discard<\/button>/);
    expect(held).toMatch(/<button class="[^"]*" type="button" disabled="">Save<\/button>/);
    expect(held).not.toContain('aria-label="Change ');
    const uncertain = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "uncertain", "We couldn't confirm your save."), DETAIL, { summary: summaryFacts(2) });
    expect(uncertain).toMatch(/<button class="[^"]*" type="button">Check again<\/button>/);
    expect(count(uncertain, 'aria-label="Change ')).toBe(7);
  });

  it("the Price row (PR 10f, plan 9.2, 9.3): the examples as Now, hidden while the price is changed; the pending line; Save as Check new prices; the price's clear box; no Change without W7's right (CC-C23, D3)", () => {
    const opened = run([{ type: "open", editor: categoryEditorId(CATEGORY), place: "Sleeves", base: categoryDraftValue(WITH_EXAMPLES) }]);
    const plain = renderEditor(opened, WITH_EXAMPLES);
    expect(plain).toContain('data-testid="category-price-examples">Now: Pack of 100 $4.99 · Box of 5 $21.99</p>');
    expect(plain).not.toContain('data-testid="category-price-pending"');
    expect(plain).not.toContain('data-testid="category-clear-price"');
    expect(plain).toMatch(/<button class="[^"]*" type="button" disabled="">Save<\/button>/);

    const priced = renderEditor(pricedDraft({ choice: { mode: "set", value: RETAIL_20_UP }, check: null }), WITH_EXAMPLES);
    expect(priced).not.toContain('data-testid="category-price-examples"');
    expect(priced).toMatch(/<p id="[^"]+" class="[^"]*" data-testid="category-price-pending">→ Retail price \+ 20%, round up to \.99 · Not saved<\/p>/);
    // Back on [Change], the change not saved yet is read with it.
    expect(priced).toMatch(/aria-label="Change price for Sleeves" aria-describedby="[^"]+" aria-expanded="false">Change price<\/button>/);
    expect(priced).toContain('data-testid="category-editor-not-saved">● Not saved · 1 change</span>');
    expect(priced).toMatch(/<button class="[^"]*" type="button">Check new prices<\/button>/);
    expect(priced).not.toMatch(/<button class="[^"]*" type="button">Save<\/button>/);
    // The price's "Also clear theirs" box, with a recipe set and a product holding its own price (9.1), read out with its line.
    const box = sliceOf(priced, "category-clear-price", "div");
    expect(box).toContain('<p id="category-clear-price-line" class="text-zinc-700">1 product in Sleeves has its own price.</p>');
    expect(box).toMatch(/<input type="checkbox" class="[^"]*" aria-describedby="category-clear-price-line"\/><span>Also clear theirs, so all 15 use this one\.<\/span>/);
    expect(priced.indexOf('data-testid="category-clear-price"')).toBeGreaterThan(priced.indexOf('data-testid="category-price-row"'));
    expect(priced.indexOf('data-testid="category-clear-price"')).toBeLessThan(priced.indexOf('data-testid="drawer-setting-shippingPolicy"'));
    // Ticked: two changes, still Check new prices; the other rows' changes ride along (D2).
    const riding = renderEditor(pricedDraft({ choice: { mode: "set", value: COST_35 }, check: null }, { shippingPolicy: { mode: "set", value: { id: "ground" } } }, ["price", "shippingPolicy"]), WITH_EXAMPLES);
    expect(riding).toContain('data-testid="category-editor-not-saved">● Not saved · 3 changes</span>');
    expect(sliceOf(riding, "category-clear-price", "div")).toContain('checked=""');
    expect(riding).toContain("→ Your cost + 35%, to the cent · Not saved");
    expect(riding).toContain("→ USPS Ground Advantage · Not saved");
    expect(riding).toMatch(/<button class="[^"]*" type="button">Check new prices<\/button>/);
    // "Use store default" over the category's own recipe, worded the editor's way (D17).
    const ownPriced = listingSettingsCategoryDetailSchema.parse({ ...WITH_EXAMPLES, settings: { ...WITH_EXAMPLES.settings, price: { source: "category", value: COST_35 } } });
    const toDefault = renderEditor(categoryDraft({}, [], "editing", null, { choice: { mode: "default" }, check: null }, ownPriced), ownPriced);
    expect(toDefault).toContain("Your cost + 35%, to the cent");
    expect(toDefault).toContain('data-testid="category-price-pending">→ Use store default · Not saved</p>');
    expect(toDefault).not.toContain('data-testid="category-clear-price"');
    // Without W7's right: no Change, the right's reason where it has words; the examples still show.
    const signIn = renderEditor(opened, WITH_EXAMPLES, { rights: { ...RIGHTS, priceCheck: { editable: false, reason: "reload" } } });
    expect(signIn).not.toContain('aria-label="Change price for Sleeves"');
    expect(signIn).toContain('data-testid="category-price-line"');
    expect(signIn).toContain('data-testid="category-price-examples"');
    const banner = renderEditor(opened, WITH_EXAMPLES, { rights: { ...RIGHTS, priceCheck: { editable: false, reason: "banner" } } });
    expect(banner).not.toContain('aria-label="Change price for Sleeves"');
    expect(banner).not.toContain('data-testid="category-price-line"');
    // Under older rules (D11) the Price row has no Change either, and Save stays off with the one line.
    const gated = renderEditor(pricedDraft({ choice: { mode: "set", value: RETAIL_20_UP }, check: null }), WITH_EXAMPLES, { summary: summaryFacts(1) });
    expect(gated).not.toContain('aria-label="Change price for Sleeves"');
    expect(gated).toMatch(/<button class="[^"]*" type="button" disabled="">Check new prices<\/button>/);
    expect(sliceOf(gated, "category-editor-footer", "div")).toContain("Category settings can't be saved while your store has older group rules.");
  });

  it("shows the price check in place of its body while the draft holds one (D20), with the category's head and Also saves lines; the editor's body is back for a conflict and a stale view", () => {
    const checked = pricedDraft({ choice: { mode: "set", value: RETAIL_20_UP }, check: CHECK }, { shippingPolicy: { mode: "set", value: { id: "ground" } } }, ["shippingPolicy"]);
    const markup = renderEditor(checked, WITH_EXAMPLES);
    expect(count(markup, 'data-testid="price-check"')).toBe(1);
    expect(markup).toContain("data-review=\"11111111-1111-4111-8111-111111111111\"");
    // The header stays; the rows and the editor's footer do not.
    expect(markup).toContain("<h2>Sleeves · 15 products</h2>");
    expect(markup).not.toContain('data-testid="category-editor-rows"');
    expect(markup).not.toContain('data-testid="category-editor-footer"');
    const headOf = (shown: string) => { const head = sliceOf(shown, "price-check-head", "h3"); return head.slice(head.indexOf(">") + 1).replace(/<[^>]+>/g, ""); };
    expect(headOf(markup)).toBe("Checking: Retail price + 20%, round up to .99 · Not saved yet");
    expect(count(markup, 'data-testid="price-check-also"')).toBe(2);
    expect(markup).toContain('data-testid="price-check-also">Also saves: shipping policy.</p>');
    expect(markup).toContain('data-testid="price-check-also">Clears 2 products\' own shipping policy.</p>');
    // A static render reads the rows again (no page yet): Save waits, Back to editing is on.
    expect(markup).toContain('data-testid="price-check-footer"');
    expect(markup).toMatch(/<button[^>]*>Back to editing<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
    // "Use store default" reads the category's way in the head (D17).
    const ownPriced = listingSettingsCategoryDetailSchema.parse({ ...WITH_EXAMPLES, settings: { ...WITH_EXAMPLES.settings, price: { source: "category", value: COST_35 } } });
    const toDefault = renderEditor(categoryDraft({}, [], "editing", null, { choice: { mode: "default" }, check: CHECK }, ownPriced), ownPriced);
    expect(headOf(toDefault)).toBe("Checking: Use store default · Not saved yet");
    expect(toDefault).not.toContain('data-testid="price-check-also"');
    // An apply nobody could confirm keeps the check with Check again (D21).
    const uncertain = renderEditor(pricedDraft({ choice: { mode: "set", value: RETAIL_20_UP }, check: CHECK }, {}, [], "uncertain", "We couldn't confirm your save."), WITH_EXAMPLES);
    expect(uncertain).toContain('data-testid="price-check"');
    expect(uncertain).toContain("We couldn't confirm your save.");
    expect(uncertain).toMatch(/<button[^>]*>Check again<\/button>/);
    // The category's version conflict (plan 9.4): the editor's body with Load latest; no check body.
    const conflict = renderEditor(pricedDraft({ choice: { mode: "set", value: RETAIL_20_UP }, check: CHECK }, {}, [], "conflict", "This changed in another window."), WITH_EXAMPLES);
    expect(conflict).not.toContain('data-testid="price-check"');
    expect(conflict).toContain('data-testid="category-editor-rows"');
    expect(conflict).toContain("This changed in another window.");
    expect(conflict).toMatch(/<button class="[^"]*" type="button">Load latest and keep my changes<\/button>/);
    // Saved, but the views couldn't be read again: the body with Reload (D9).
    const stale = renderEditor(pricedDraft({ choice: { mode: "set", value: RETAIL_20_UP }, check: CHECK }, {}, [], "saved_view_stale"), WITH_EXAMPLES);
    expect(stale).not.toContain('data-testid="price-check"');
    expect(stale).toContain("Saved. We couldn't load the latest view.");
    expect(stale).toMatch(/<button class="[^"]*" type="button">Reload<\/button>/);
  });

  it("the price editor offers Use store default and Set price, never Clear exact prices too (D17; a category check releases nothing)", () => {
    const model = productPriceEditorModel({ rights: { canSet: true, canDefault: true, reason: null }, change: { price: { mode: "leave" }, releaseExactPrices: false }, ownPrice: null, storeRecipe: RETAIL_20_UP });
    const markup = render(React.createElement(ProductPriceEditor, {
      model, title: "Price", productName: "Sleeves", message: null, checking: false, locked: false, onCheck: noop, onCancel: noop,
      defaultLabel: "Use store default", release: false,
    }));
    expect(markup).toContain('role="group" aria-label="Price for Sleeves" data-testid="drawer-field-editor-price"');
    expect(markup).toContain(">Use store default</span>");
    expect(markup).not.toContain(">Use default</span>");
    expect(markup).toContain(">Set price</span>");
    expect(markup).not.toContain("Clear exact prices too");
    expect(markup).toMatch(/<button[^>]*>Check new prices<\/button>/);
    // The drawer's editor keeps its words and its box.
    const drawers = render(React.createElement(ProductPriceEditor, { model, title: "Price", productName: "Penny Sleeves", message: null, checking: false, locked: false, onCheck: noop, onCancel: noop }));
    expect(drawers).toContain(">Use default</span>");
    expect(drawers).toContain("Clear exact prices too");
  });

  it("the Price row hands its Change to the editor and reads its button from the lib's words", () => {
    vi.stubGlobal("React", React);
    const onChange = vi.fn();
    const price = {
      label: "Price", value: "Retail price + 20%, round up to .99", tag: "Store default", line: null, examples: "Now: Pack of 100 $4.99", pending: null,
      change: { label: "Change price", ariaLabel: "Change price for Sleeves", shown: true, disabled: false },
      editor: productPriceEditorModel({ rights: { canSet: true, canDefault: true, reason: null }, change: { price: { mode: "leave" }, releaseExactPrices: false }, ownPrice: null, storeRecipe: RETAIL_20_UP }),
      open: false, marked: false, fieldError: null, clears: [],
    };
    const buttons = pressable(CategoryPriceRowItem({ price, onChange }));
    expect(buttons.map((button) => button.props["aria-label"])).toEqual(["Change price for Sleeves"]);
    buttons[0].props.onClick?.();
    expect(onChange).toHaveBeenCalledTimes(1);
    // Hidden Change: nothing to press.
    expect(pressable(CategoryPriceRowItem({ price: { ...price, change: { ...price.change, shown: false } }, onChange }))).toEqual([]);
  });

  it("shows Also clear theirs under a field the save sets on the category whose products hold their own value, never with Use store default (8.4)", () => {
    // The category sets its shipping policy and two products hold their own: the box, unticked, with the category's count.
    const markup = renderEditor(OPENED, DETAIL);
    const box = sliceOf(markup, "category-clear-shippingPolicy", "div");
    expect(box).toContain('<p id="category-clear-shippingPolicy-line" class="text-zinc-700">2 products in Sleeves have their own shipping policy.</p>');
    // The box is read out with its line, which names the setting and the category (plan 3.4).
    expect(box).toMatch(/<input type="checkbox" class="[^"]*" aria-describedby="category-clear-shippingPolicy-line"\/><span>Also clear theirs, so all 15 use this one\.<\/span>/);
    // Under its row, before the next.
    expect(markup.indexOf('data-testid="category-clear-shippingPolicy"')).toBeGreaterThan(markup.indexOf('data-testid="drawer-setting-shippingPolicy"'));
    expect(markup.indexOf('data-testid="category-clear-shippingPolicy"')).toBeLessThan(markup.indexOf('data-testid="drawer-setting-returnPolicy"'));
    // Nothing gives the shelf on the category: no box, although a product holds its own shelf.
    expect(markup).not.toContain('data-testid="category-clear-storeShelf"');
    expect(count(markup, 'data-testid="category-clear-')).toBe(1);

    // A Set on the shelf shows its box; ticked boxes read checked; "Use store default" on the shipping policy takes its box away.
    const shelfSet = categoryDraft({ storeShelf: { mode: "set", value: { mode: "own", shelfIds: ["S1"] } }, shippingPolicy: { mode: "default" } }, ["storeShelf"]);
    const changed = renderEditor(shelfSet, DETAIL);
    expect(sliceOf(changed, "category-clear-storeShelf", "div")).toContain("1 product in Sleeves has its own store shelf.");
    expect(sliceOf(changed, "category-clear-storeShelf", "div")).toContain('<input type="checkbox" class="h-4 w-4 shrink-0 accent-[#C060E0]" aria-describedby="category-clear-storeShelf-line" checked=""');
    expect(changed).not.toContain('data-testid="category-clear-shippingPolicy"');
    expect(changed).toContain("→ Use store default · Not saved");
    expect(changed).toContain('data-testid="category-editor-not-saved">● Not saved · 3 changes</span>');

    // Off while a save is out; gone with [Change] while W12 can't be used (a row that can't be changed clears nothing).
    const held = renderEditor(categoryDraft({}, ["shippingPolicy"], "uncertain", "We couldn't confirm your save."), DETAIL);
    expect(sliceOf(held, "category-clear-shippingPolicy", "div")).toContain('disabled="" checked=""');
    // A banner takes every writer's right away (D3): W12's and W7's.
    const paused = renderEditor(OPENED, DETAIL, { rights: { ...RIGHTS, categorySettings: { editable: false, reason: "banner" }, priceCheck: { editable: false, reason: "banner" } } });
    expect(paused).not.toContain('aria-label="Change ');
    expect(paused).not.toContain('data-testid="category-clear-');
  });

  it("the box hands the field and its tick to the editor", () => {
    vi.stubGlobal("React", React);
    const onTick = vi.fn();
    const box = { field: "shippingPolicy" as const, count: 2, line: "2 products in Sleeves have their own shipping policy.", label: "Also clear theirs, so all 15 use this one.", ticked: false, disabled: false };
    const inputs = pressable(ClearTheirsBox({ box, onTick }));
    expect(inputs).toHaveLength(1);
    inputs[0].props.onChange?.({ target: { checked: true } });
    expect(onTick).toHaveBeenCalledWith("shippingPolicy", true);
  });

  it("words the footer by the draft: the change count with Discard and Save, Saving…, Check again, Load latest, the refusal, Reload; a phone counts alone", () => {
    const editing = renderEditor(categoryDraft({ shippingPolicy: { mode: "set", value: { id: "ground" } } }, ["shippingPolicy"]), DETAIL);
    expect(editing).toContain('data-testid="category-editor-not-saved">● Not saved · 2 changes</span>');
    expect(editing).toContain("→ USPS Ground Advantage · Not saved");
    expect(editing).toMatch(/<button class="[^"]*" type="button">Discard<\/button>/);
    expect(editing).toMatch(/<button class="[^"]*" type="button">Save<\/button>/);

    const uncertain = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "uncertain", "We couldn't confirm your save."), DETAIL);
    expect(uncertain).toContain('<span role="alert" class="text-sm text-amber-900">We couldn\'t confirm your save.</span>');
    expect(uncertain).toMatch(/<button class="[^"]*" type="button">Check again<\/button>/);
    expect(uncertain).toMatch(/<button class="[^"]*" type="button" disabled="">Discard<\/button>/);

    const conflict = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "conflict", "This changed in another window."), DETAIL);
    expect(conflict).toContain("This changed in another window.");
    expect(conflict).toMatch(/<button class="[^"]*" type="button">Load latest and keep my changes<\/button>/);

    const older = "Category settings can't be saved while your store has older group rules. They'll be moved over in a later update.";
    const refused = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "refused", older), DETAIL);
    expect(refused).toContain(`<span role="alert" class="text-sm text-amber-900">${older}</span>`);
    expect(refused).toMatch(/<button class="[^"]*" type="button">Save<\/button>/);

    const stale = renderEditor(categoryDraft({ shippingPolicy: { mode: "default" } }, [], "saved_view_stale"), DETAIL);
    expect(stale).toContain("Saved. We couldn't load the latest view.");
    expect(stale).toMatch(/<button class="[^"]*" type="button">Reload<\/button>/);

    stubWidth(false);
    const phone = renderEditor(categoryDraft({ shippingPolicy: { mode: "set", value: { id: "ground" } } }, ["shippingPolicy"]), DETAIL);
    expect(phone).toContain('data-testid="category-editor-not-saved">● Not saved · 2</span>');
    expect(phone).toContain('aria-label="Back"');
    expect(phone.indexOf('aria-label="Back"')).toBeLessThan(phone.indexOf("<h2>"));
  });

  it("says why a field offers Use store default alone under a sign-in, and nothing can be picked for a paused store", () => {
    const signIn = renderEditor(OPENED, DETAIL, { rights: { ...RIGHTS, shipping: { editable: false, reason: "sign_in" }, policies: { editable: false, reason: "sign_in" }, ebayCategory: { editable: false, reason: "sign_in" }, shelfPick: { editable: false, reason: "sign_in" } } });
    expect(signIn).toContain("Sign in to eBay again to pick a new one. You can still use the default.");
    expect(signIn).toContain('aria-label="Change shipping policy for Sleeves"');
    const paused = renderEditor(OPENED, DETAIL, { rights: { ...RIGHTS, categorySettings: { editable: false, reason: "banner" }, priceCheck: { editable: false, reason: "banner" } } });
    expect(paused).not.toContain('aria-label="Change ');
    expect(paused).toMatch(/<button class="[^"]*" type="button" disabled="">Save<\/button>/);
  });

  it("stays shut while the address names no category", () => {
    expect(renderEditor(null, DETAIL, { categoryId: null })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The step: the card's place, the address, one surface at a time (A5, D18, D20, D21)
// ---------------------------------------------------------------------------

const STORE_ID = 5;
const STAMP = "2026-09-30T12:00:00.000Z";

function summaryAnswer(catalogState: "ok" | "too_large" = "ok"): ListingSettingsSummary {
  const policy = (policyId: string) => ({ policyId, verification: "not_checked" as const });
  const fits = catalogState === "ok";
  return listingSettingsSummarySchema.parse({
    storeConnectionId: STORE_ID, storeStatus: "connected", access: { allowed: true },
    catalog: fits ? { state: "ok", products: 1, sizes: 1 } : { state: "too_large", limit: 10_000 },
    storeDefaults: {
      price: { recipe: null, groupRules: 0 }, shippingPolicy: policy("ground"), returnPolicy: policy("returns"), paymentPolicy: policy("payments"),
      ebayCategory: { category: null, groupRules: 0 }, description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
    },
    counts: fits ? { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 } : null,
    attention: { items: [], total: 0 }, rail: { state: fits ? "all_set" : "too_many_sizes", productsNeedingFix: 0, missingPolicy: null }, generatedAt: STAMP,
  });
}

function renderStep(address: string, catalogState: "ok" | "too_large" = "ok"): string {
  vi.stubGlobal("React", React);
  const cache = client();
  seed(cache, listingSettingsCategoriesQueryOptions(STORE_ID), { ...LIST, storeConnectionId: STORE_ID });
  seed(cache, listingSettingsCategoryQueryOptions(STORE_ID, CATEGORY), { ...DETAIL, storeConnectionId: STORE_ID });
  const resolved = () => Promise.resolve();
  const props: ListingSettingsStepProps = {
    storeConnectionId: STORE_ID, storeName: "Marz Cards", ebayStoreCount: 1,
    account: { status: "active", entitlementStatus: "active" },
    summary: { data: summaryAnswer(catalogState), error: null, isFetching: false, refetch: resolved },
    shelves: { data: { categories: [] }, error: null, isFetching: false, refetch: resolved },
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSettingsSaved: noop, goToStep: noop,
  };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: cache },
      React.createElement(Router, { ssrPath: address, children: React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE_ID,
        children: React.createElement(ListingSettingsStep, props) }) })));
  } finally {
    cache.clear();
  }
}

describe("the step", () => {
  it("puts the card between the Store defaults card and the tabs (A5), and opens the editor the address names, one surface at a time (D20)", () => {
    const closed = renderStep("/dropship-portal/catalog/setup");
    const card = closed.indexOf('data-testid="category-settings-card"');
    expect(card).toBeGreaterThan(closed.indexOf('data-testid="store-defaults-card"'));
    expect(card).toBeGreaterThan(closed.indexOf('data-testid="store-default-row-description"'));
    expect(card).toBeLessThan(closed.indexOf('data-testid="listing-settings-tabs"'));
    expect(closed).toContain("Sets: shipping policy, text above");
    expect(closed).not.toContain('data-testid="category-editor"');
    // No "Change for X" link in the drawer (UX-m3): the card's [Change] is the one way in, so the drawer knows nothing
    // of the category editor, its address or its words (a static render opens no drawer header to look at).
    const drawerSource = readFileSync(join(process.cwd(), "client/src/pages/dropship/listing-settings/ProductDrawer.tsx"), "utf8");
    expect(drawerSource).not.toMatch(/dropship-listing-settings-categor|categorySearch|\bCategoryEditor\b|Change for /);

    const open = renderStep(`/dropship-portal/catalog/setup?category=${CATEGORY}`);
    expect(count(open, 'data-testid="category-editor"')).toBe(1);
    expect(open).toContain("<h2>Sleeves · 15 products</h2>");
    expect(open).not.toContain('data-testid="product-drawer"');
    expect(open).not.toContain('data-testid="updated-products-sheet"');

    // The drawer, then a sheet, win over the category (the order the parts arrived in).
    const withDrawer = renderStep(`/dropship-portal/catalog/setup?category=${CATEGORY}&product=11`);
    expect(withDrawer).toContain('data-testid="product-drawer"');
    expect(withDrawer).not.toContain('data-testid="category-editor"');
    const withSheet = renderStep(`/dropship-portal/catalog/setup?category=${CATEGORY}&sheet=updated`);
    expect(withSheet).toContain('data-testid="updated-products-sheet"');
    expect(withSheet).not.toContain('data-testid="category-editor"');
    // Not a whole-number id: nothing opens.
    for (const address of ["/dropship-portal/catalog/setup?category=abc", "/dropship-portal/catalog/setup?category=0"]) {
      expect(renderStep(address), address).not.toContain('data-testid="category-editor"');
    }
  });

  it("hides the card and keeps the editor shut while the selection is too large: the banner explains (D18)", () => {
    const tooLarge = renderStep(`/dropship-portal/catalog/setup?category=${CATEGORY}`, "too_large");
    expect(tooLarge).toContain('data-testid="listing-settings-banner"');
    expect(tooLarge).toContain("more than 10,000 sizes");
    expect(tooLarge).not.toContain('data-testid="category-settings-card"');
    expect(tooLarge).not.toContain('data-testid="category-editor"');
  });
});
