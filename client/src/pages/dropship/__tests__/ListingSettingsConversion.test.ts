import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listingRulesConversionCheckSchema,
  type ConversionChangeRow,
  type ConversionSizeView,
  type ListingRulesConversionCheck,
} from "@shared/dropship/listing-rules-conversion";
import {
  listingSettingsCategoriesResponseSchema,
  listingSettingsSummarySchema,
  listingSettingsUpdatedProductsResponseSchema,
  type ListingSettingsCategoriesResponse,
  type ListingSettingsSizePrice,
  type ListingSettingsSummary,
  type ListingSettingsUpdatedProductsResponse,
} from "@shared/dropship/listing-settings";
import {
  listingSettingsCategoriesQueryOptions,
  listingSettingsConversionQueryOptions,
  listingSettingsQueryKey,
  listingSettingsUpdatedProductsQueryOptions,
} from "@/lib/dropship-listing-settings";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { categorySettingsCardState } from "@/lib/dropship-listing-settings-categories";
import {
  OLDER_RULES_SHEET_OPENED,
  blockedLines,
  olderRulesLineModel,
  olderRulesSheetState,
  type ConversionBlockedSize,
  type OlderRulesApplyFacts,
  type OlderRulesSheetOutcome,
  type OlderRulesSheetSession,
  type OlderRulesSheetState,
} from "@/lib/dropship-listing-settings-conversion";
import { CONVERSION_EDITOR_ID, classifyWriteFailure, reduceListingSettingsDraft, type ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import { builtFromWords } from "@/lib/dropship-listing-settings-price-words";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { CardOlderRules, CategoryCardRowItem, CategorySettingsCardView } from "../listing-settings/CategorySettingsCard";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsStep, type ListingSettingsStepProps } from "../listing-settings/ListingSettingsStep";
import { OlderRulesLine, OlderRulesLineView } from "../listing-settings/OlderRulesLine";
import {
  BlockedSizeItem,
  OlderRulesSheet,
  OlderRulesSheetView,
  ReportBody,
  SheetFooterBar,
  type OlderRulesSheetProps,
} from "../listing-settings/OlderRulesSheet";
import { firstConnected } from "../listing-settings/focusTarget";

/**
 * The older-rules line, the read-only "Your older group rules" sheet and its openers (Listing settings PR 11b, plan
 * 5.2, 5.3, 5.4, 11.1, 11.2, 11.4; D17, D18, D20, D21): the line in its three forms and hidden; the sheet in every
 * 5.3 state, in 11.2's order, with [Set a price] and [Fix] named with their size; the Category settings card's opener
 * and its rows' "No category settings yet"; the focus fallback; and the step's wiring (the line's place, `?sheet=convert`
 * opening the sheet, one surface at a time, no dry-run read unless the sheet is open). Static renders: the reads are
 * put in the query cache, and what a button does is checked on the hook-free views.
 */

/** Radix renders a sheet into a portal, which a static render leaves out: render it in place (plan 3.1: every export). */
vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? createElement("div", { "data-mock": "sheet" }, children) : null),
    SheetContent: ({ side, children, "data-testid": testId }: Props) =>
      createElement("div", { "data-mock": "sheet-content", "data-side": side, "data-testid": testId }, children),
    SheetHeader: ({ children }: Props) => createElement("div", null, children),
    SheetTitle: ({ children }: Props) => createElement("h2", null, children),
    SheetDescription: ({ children }: Props) => createElement("p", null, children),
    SheetFooter: ({ children }: Props) => createElement("div", null, children),
  };
});

const STORE = 5;
const STAMP = "2026-10-15T12:00:00.000Z";
const PLAN_A = "a".repeat(64);
const PLAN_B = "b".repeat(64);
const WRITES = "c".repeat(64);
const DESC = "d".repeat(64);
/** Ids are keys only: none of these may show up in the words (owner rule). */
const PENNY = 4711;
const PENNY_100 = 90101;
const TEAM = 4712;
const TEAM_50 = 90201;
const SLEEVES = 7301;
const EBAY_SLEEVES = "261328";
const SHIPPING = "6100001";
const IDS = [PENNY, PENNY_100, TEAM, TEAM_50, SLEEVES].map(String).concat([EBAY_SLEEVES, SHIPPING]);
/** A raw code or enum value leaking into vendor words: snake_case or a DROPSHIP_ code. */
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const noop = () => undefined;

beforeEach(() => {
  // The hook-free views are called as functions to press their buttons; their JSX needs React in scope.
  vi.stubGlobal("React", React);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures, each parsed with its shared contract
// ---------------------------------------------------------------------------

type Summary = Pick<ListingSettingsSummary, "catalog" | "storeDefaults">;

function summaryFacts(groupRules = 1, catalogState: "ok" | "too_large" = "ok"): { data: Summary; error: null } {
  return {
    data: {
      catalog: catalogState === "ok" ? { state: "ok", products: 2, sizes: 3 } : { state: "too_large", limit: 10_000 },
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

function summaryAnswer(groupRules = 1, catalogState: "ok" | "too_large" = "ok"): ListingSettingsSummary {
  const fits = catalogState === "ok";
  return listingSettingsSummarySchema.parse({
    storeConnectionId: STORE, storeStatus: "connected", access: { allowed: true },
    ...summaryFacts(groupRules, catalogState).data,
    counts: fits ? { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 } : null,
    attention: { items: [], total: 0 }, rail: { state: fits ? "all_set" : "too_many_sizes", productsNeedingFix: 0, missingPolicy: null }, generatedAt: STAMP,
  });
}

const CATEGORIES: ListingSettingsCategoriesResponse = listingSettingsCategoriesResponseSchema.parse({
  storeConnectionId: STORE,
  categories: [{ categoryId: SLEEVES, name: "Sleeves", productCount: 2, revisionId: null, setFields: [] }],
  uncategorizedProductCount: 0,
  generatedAt: STAMP,
});
const NO_CATEGORIES: ListingSettingsCategoriesResponse = { ...CATEGORIES, categories: [], uncategorizedProductCount: 2 };

function price(overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return {
    productVariantId: PENNY_100, productId: PENNY, productName: "Penny Sleeves", sizeName: "Pack of 100", sku: null,
    priceCents: 499, source: "rules", rule: { kind: "group", name: "Sleeves", recipe: { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" } },
    basis: "catalog_retail", basisAmountCents: 399, issue: null, costCents: 210, belowCostByCents: null, limits: [],
    pausedSince: null, settingRevisionId: null, ...overrides,
  };
}

function sizeView(overrides: Partial<ConversionSizeView> = {}): ConversionSizeView {
  return {
    price: price(), pricingRule: { kind: "group", name: "Sleeves", recipe: { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" } },
    ebayCategory: { id: EBAY_SLEEVES, name: "Card Sleeves" }, shelfNames: [], policies: { shipping: SHIPPING, return: null, payment: null },
    descriptionHash: DESC, blockers: [], ...overrides,
  };
}

/** A size whose price moves from $4.99 (the group rule) to the retail fallback $3.99. */
function changeRow(productVariantId: number, productId: number, productName: string, sizeName: string): ConversionChangeRow {
  const onSize = (side: ConversionSizeView): ConversionSizeView => ({ ...side, price: { ...side.price, productId, productVariantId, productName, sizeName } });
  return {
    productVariantId, productId, productName, sizeName, changed: ["price", "priceSource", "pricingRule"],
    before: onSize(sizeView()),
    after: onSize(sizeView({ price: price({ priceCents: 399, source: "retail_fallback", rule: null, basis: null, basisAmountCents: null }), pricingRule: null })),
  };
}

const list = <T>(items: readonly T[], total = items.length) => ({ total, items: [...items] });
const EMPTY_REPORT = { unmatched: list([]), shared: list([]), nameMismatches: list([]), neverApplies: list([]), ties: list([]), someSizesOnly: list([]), mixed: list([]) };

function check(overrides: Partial<ListingRulesConversionCheck> = {}): ListingRulesConversionCheck {
  return listingRulesConversionCheckSchema.parse({
    storeConnectionId: STORE, generatedAt: STAMP, state: "clean", planHash: PLAN_A, writesHash: WRITES,
    olderRules: { pricingGroups: 1, contentGroups: 0, ebayCategoryRules: 0 },
    blocked: { wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: false },
    becomes: { categories: list([{ categoryId: SLEEVES, categoryName: "Sleeves", settings: ["price"] }]), products: list([]) },
    report: EMPTY_REPORT,
    kept: { exactPrices: 2, catalogPrices: 0, sizePolicies: 0, sizeShelves: 0, sizeTexts: 0 },
    changes: { page: 0, pageSize: 50, total: 0, rows: [] },
    ...overrides,
  });
}

const CLEAN = check();
const NO_OLDER_RULES = check({
  state: "no_older_rules", planHash: null, writesHash: null, olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 },
  becomes: { categories: list([]), products: list([]) },
});

/** Not clean: two sizes lose their price, two listed sizes would be blocked, the text cap, every report list, two changed rows on page 0 of 60. */
function notClean(page = 0, planHash = PLAN_A): ListingRulesConversionCheck {
  const rows = page === 0
    ? [changeRow(PENNY_100, PENNY, "Penny Sleeves", "Pack of 100"), changeRow(TEAM_50, TEAM, "Team Bags", "Pack of 50")]
    : [changeRow(95_001, 4_799, "Soft Sleeves", "Pack of 200")];
  return check({
    state: "not_clean", planHash,
    blocked: {
      wouldLosePrice: list([
        { productId: PENNY, productVariantId: PENNY_100, productName: "Penny Sleeves", sizeName: "Pack of 100", priceCents: 499 },
        { productId: TEAM, productVariantId: TEAM_50, productName: "Team Bags", sizeName: "Pack of 50", priceCents: null },
      ]),
      wouldBlockListing: list([
        { productId: PENNY, productVariantId: 90103, productName: "Penny Sleeves", sizeName: "Pack of 1000", priceCents: 2999, reasons: ["no_ebay_category", "listing_content_description_too_large"] },
        { productId: TEAM, productVariantId: 90203, productName: "Team Bags", sizeName: "Pack of 200", priceCents: 1299, reasons: ["own_text_needs_check"] },
      ]),
      tooMuchText: true,
    },
    becomes: {
      categories: list([{ categoryId: SLEEVES, categoryName: "Sleeves", settings: ["price", "textAbove", "textBelow"] }]),
      products: list([{ productId: PENNY, productName: "Penny Sleeves", settings: ["price"] }, { productId: TEAM, productName: "Team Bags", settings: ["price"] }]),
    },
    report: {
      ...EMPTY_REPORT,
      ties: list([{ productId: TEAM, productName: "Team Bags", setting: "price" }]),
      nameMismatches: list([{ productId: PENNY, productName: "Penny Sleeves", listedAs: "Sleves", categoryName: "Sleeves" }]),
      // 112 unmatched rules: the answer carries the first 100 (its cap), the sheet says "and 12 more".
      unmatched: list(Array.from({ length: 100 }, (_, index) => ({ ruleName: index === 0 ? "Old binders" : `Old rule ${index}`, categoryName: index === 0 ? "Binders" : `Gone ${index}`, kind: "price" as const })), 112),
      shared: list([{ ruleName: "Cases rule", categoryName: "Cases", categoryCount: 2, kind: "ebayCategory" }]),
      someSizesOnly: list([{ ruleName: "Big packs", productId: PENNY, productName: "Penny Sleeves", setting: "ebayCategory" }]),
      mixed: list([{ productId: TEAM, productName: "Team Bags", setting: "textAbove" }]),
      neverApplies: list([{ ruleName: "Summer sale", kind: "price" }]),
    },
    changes: { page, pageSize: 50, total: 60, rows },
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
}

type Seeded<T> = T | { error: unknown } | undefined;

/** Puts a read's answer, its failure or nothing (still loading) under its key. */
function seed<T>(cache: QueryClient, queryKey: readonly unknown[], answer: Seeded<T>) {
  if (answer === undefined) return;
  if (typeof answer === "object" && answer !== null && "error" in answer) {
    cache.getQueryCache().build(cache, { queryKey: [...queryKey] })
      .setState({ status: "error", error: answer.error as Error, fetchStatus: "idle", errorUpdatedAt: 1, errorUpdateCount: 1 });
    return;
  }
  cache.setQueryData([...queryKey], answer);
}

function conversionKey(page: number): readonly unknown[] {
  return listingSettingsConversionQueryOptions(STORE, page).queryKey;
}

/** The markup, with the entities a static render writes turned back into characters; the cache stays for checks. */
function render(node: React.ReactElement, cache = client()): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: cache }, node))
    .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** Where each test id first appears, so a test can check their order. */
function expectInOrder(markup: string, testIds: readonly string[]) {
  const found = testIds.map((testId) => markup.indexOf(`data-testid="${testId}"`));
  testIds.forEach((testId, index) => expect(found[index], testId).toBeGreaterThan(-1));
  expect([...found].sort((left, right) => left - right)).toEqual(found);
}

/** The words a vendor sees: no code, no snake_case enum, no id (owner rule). */
function expectPlainWords(markup: string) {
  const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  expect(text).not.toMatch(RAW_CODE);
  for (const id of IDS) expect(text, id).not.toContain(id);
  for (const label of markup.match(/aria-label="[^"]*"/g) ?? []) {
    expect(label).not.toMatch(RAW_CODE);
    for (const id of IDS) expect(label, id).not.toContain(id);
  }
}

type Element = React.ReactElement<{ children?: unknown; onClick?: () => void; "aria-label"?: string }>;
/** Every element with a click handler, outermost first. */
function pressable(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(pressable);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  const own = typeof element.props.onClick === "function" ? [element] : [];
  return [...own, ...pressable(element.props.children)];
}

/** Every element in a tree, outermost first (components left uncalled). */
function elementsOf(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elementsOf(element.props.children)];
}

function sheetProps(overrides: Partial<OlderRulesSheetProps> = {}): OlderRulesSheetProps {
  return {
    storeConnectionId: STORE, open: true, summary: summaryFacts(), right: EDITABLE, saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
    onSaved: noop, onClose: noop, onSetPrice: noop, onFix: noop, ...overrides,
  };
}

/** The open sheet over page 0's answer (`answer`), its failure, or nothing yet, inside the step's drafts provider. */
function renderSheet(answer: Seeded<ListingRulesConversionCheck>, overrides: Partial<OlderRulesSheetProps> = {}): string {
  const cache = client();
  seed(cache, conversionKey(0), answer);
  return render(React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE, children: React.createElement(OlderRulesSheet, sheetProps(overrides)) }), cache);
}

const IDLE: OlderRulesApplyFacts = { draft: null, right: EDITABLE, busy: false, checking: false, notStartedLine: null };

function sheetState(
  pages: readonly (ListingRulesConversionCheck | { error: unknown } | undefined)[],
  session: Partial<OlderRulesSheetSession> = {},
  outcome: OlderRulesSheetOutcome | null = null,
  apply: Partial<OlderRulesApplyFacts> = {},
): OlderRulesSheetState {
  return olderRulesSheetState({
    pages: pages.map((page) => page === undefined ? { data: undefined, error: null } : "error" in page ? { data: undefined, error: page.error } : { data: page, error: null }),
    session: { ...OLDER_RULES_SHEET_OPENED, pageCount: Math.max(1, pages.length), ...session },
    outcome,
    apply: { ...IDLE, ...apply },
  });
}

function renderView(state: OlderRulesSheetState, compact = false): string {
  return render(React.createElement(OlderRulesSheetView, {
    state, compact, onClose: noop, onRetry: noop, onSetPrice: noop, onFix: noop, onLoadMore: noop, onRetryMore: noop,
    onMove: noop, onCheckAgain: noop, onReload: noop, onGotIt: noop,
  }));
}

/** The step's draft for a move of PLAN_A sent with one key, then answered `error` (classified as the runner does), or still out. */
function moveDraft(error?: unknown): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: CONVERSION_EDITOR_ID, place: "Your older group rules", base: { planHash: PLAN_A, writesHash: WRITES } });
  const sent = reduceListingSettingsDraft(opened, { type: "startSave", attempt: { signature: "plan A", key: "ls-convert:1" } });
  if (error === undefined) return sent!;
  return reduceListingSettingsDraft(sent, { type: "failure", key: "ls-convert:1", failure: classifyWriteFailure("W11", error) })!;
}

/** The footer bar alone, over a lib-built state. */
function renderFooter(state: OlderRulesSheetState): string {
  return render(React.createElement(SheetFooterBar, { footer: state.footer, onClose: noop, onMove: noop, onCheckAgain: noop, onReload: noop, onGotIt: noop }));
}

const apiError = (status: number, code: string) => new DropshipApiError({ status, code, message: "Refused." });
const apiErrorWith = (status: number, code: string, context?: Record<string, unknown>) => new DropshipApiError({ status, code, message: "Refused.", context });

// ---------------------------------------------------------------------------
// The line under the attention strip (plan 5.3, D17, K7)
// ---------------------------------------------------------------------------

describe("the older-rules line", () => {
  function renderLine(summary: ReturnType<typeof summaryFacts> | { data: undefined; error: unknown }, categories: Seeded<ListingSettingsCategoriesResponse>, tooLarge = false): string {
    const cache = client();
    seed(cache, listingSettingsCategoriesQueryOptions(STORE).queryKey, categories);
    return render(React.createElement(OlderRulesLine, { storeConnectionId: STORE, summary, tooLarge, onOpen: noop }), cache);
  }

  it("says the store still has older group rules, with See what changes, when a chosen product is in a Card Shellz category", () => {
    const markup = renderLine(summaryFacts(), CATEGORIES);
    expect(markup).toMatch(/^<div role="status" data-testid="older-rules-line" class="[^"]*">/);
    expect(markup).toContain("Your store still has older group rules. Move them over to use category settings.");
    expect(markup).toMatch(/<button class="[^"]*min-h-11[^"]*" type="button">See what changes<\/button>/);
    expect(count(markup, "<button")).toBe(1);
    expectPlainWords(markup);
  });

  it("drops the second sentence with no categorized product, or while the categories aren't read yet; the button stays", () => {
    for (const categories of [NO_CATEGORIES, undefined]) {
      const markup = renderLine(summaryFacts(), categories);
      expect(markup).toContain(">Your store still has older group rules.</span>");
      expect(markup).not.toContain("Move them over to use category settings.");
      expect(markup).toContain(">See what changes</button>");
    }
  });

  it("over 10,000 sizes says to choose fewer and has no button (K7)", () => {
    const markup = renderLine(summaryFacts(1, "too_large"), CATEGORIES);
    expect(markup).toContain("Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.");
    expect(markup).not.toContain("<button");
    // Refused as too large before the summary says so: by the step's banner, or by the card's own categories read.
    for (const shown of [
      renderLine(summaryFacts(), CATEGORIES, true),
      renderLine(summaryFacts(), { error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") }),
    ]) {
      expect(shown).toContain("Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.");
      expect(shown).not.toContain("<button");
    }
  });

  it("is hidden with no older rules, while the summary loads, and after it failed", () => {
    expect(renderLine(summaryFacts(0), CATEGORIES)).toBe("");
    expect(renderLine({ data: undefined, error: null }, CATEGORIES)).toBe("");
    expect(renderLine({ data: undefined, error: new TypeError("offline") }, CATEGORIES)).toBe("");
  });

  it("hands See what changes to the step", () => {
    const onOpen = vi.fn();
    const line = olderRulesLineModel(summaryFacts(), { data: CATEGORIES, error: null });
    if (line === null) throw new Error("expected a line");
    const buttons = pressable(OlderRulesLineView({ line, onOpen }));
    expect(buttons).toHaveLength(1);
    buttons[0].props.onClick?.();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The sheet's states (plan 5.3, 11.2, 11.5)
// ---------------------------------------------------------------------------

describe("the older-rules sheet", () => {
  it("is a right sheet titled by its words, with Close and Move them over in its footer; × on a wide screen, ← on a phone", () => {
    const markup = renderSheet(CLEAN);
    expect(markup).toContain('data-side="right" data-testid="older-rules-sheet">');
    expect(markup).toContain("<h2>Your older group rules</h2>");
    // 11d: the read-only preview's words are gone; [Close] then [Move them over], the sheet's one write, last.
    expect(markup).not.toContain("This is a preview");
    // A static render is the first one, while page 0 is (re)read on mount (staleTime 0): the button waits for it (D1).
    expect(markup).toMatch(/data-testid="older-rules-footer"><div class="[^"]*"><button class="[^"]*min-h-11[^"]*" type="button">Close<\/button><button class="[^"]*min-h-11[^"]*" type="button" disabled="" data-testid="older-rules-move">Move them over<\/button><\/div><\/div>/);
    expect(markup).toContain('aria-label="Close"');
    // No notice yet (11e1).
    expect(markup).not.toContain("Got it");

    vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener: noop, removeEventListener: noop }) });
    const phone = render(React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE, children: React.createElement(OlderRulesSheet, sheetProps()) }),
      (() => { const cache = client(); seed(cache, conversionKey(0), CLEAN); return cache; })());
    expect(phone).toContain('aria-label="Back"');
    expect(phone).not.toContain('aria-label="Close"');
  });

  it("renders nothing while the address doesn't open it", () => {
    expect(renderSheet(CLEAN, { open: false })).toBe("");
  });

  it("says it is checking while page 0 reads", () => {
    const markup = renderSheet(undefined);
    expect(markup).toContain('<p role="status" class="text-sm text-zinc-600" data-testid="older-rules-loading">Checking what would change…</p>');
    expect(markup).not.toContain('data-testid="older-rules-summary"');
    // Nothing to move from yet: [Close] only.
    expect(markup).toContain(">Close</button>");
    expect(markup).not.toContain('data-testid="older-rules-move"');
  });

  it("words each failed read (5xx, 429, the costs unavailable) with Try again, and a 422 too large without one", () => {
    const failed = renderSheet({ error: apiError(500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR") });
    expect(failed).toMatch(/<div role="alert" class="[^"]*" data-testid="older-rules-problem"><span>Couldn't check what would change\.<\/span><button class="[^"]*" type="button">Try again<\/button><\/div>/);
    expectPlainWords(failed);
    const limited = renderSheet({ error: apiError(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED") });
    expect(limited).toContain("<span>Too many checks in a minute. Wait a moment and try again.</span>");
    expect(limited).toContain(">Try again</button>");
    const costs = renderSheet({ error: apiError(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE") });
    expect(costs).toContain("<span>We couldn't read your costs just now, so we can't check yet. Try again in a minute.</span>");
    expect(costs).toContain(">Try again</button>");
    expectPlainWords(costs);
    // The 422 closes the sheet (the step takes it off the address, the banner explains); until then it says why, with no button.
    const tooLarge = renderSheet({ error: apiError(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE") });
    expect(tooLarge).toContain('data-testid="older-rules-problem"><span>Choose 10,000 or fewer sizes to move them over.</span></div>');
  });

  it("says the store has no older group rules any more when page 0 finds none (an old address, or moved meanwhile, 11.5)", () => {
    const markup = renderSheet(NO_OLDER_RULES);
    expect(markup).toContain('<p role="status" class="text-sm text-zinc-800" data-testid="older-rules-none">Your store has no older group rules any more.</p>');
    expect(markup).not.toContain('data-testid="older-rules-summary"');
    expect(markup).not.toContain("Products you choose later");
  });

  it("shows a clean answer: nothing changes, products chosen later, what the rules become, what is kept; no block and no rows", () => {
    const markup = renderSheet(CLEAN);
    expectInOrder(markup, ["older-rules-summary", "older-rules-later", "older-rules-becomes", "older-rules-kept", "older-rules-footer"]);
    expect(markup).toContain('data-testid="older-rules-summary">Moving them over changes nothing in your listings.</p>');
    expect(markup).toContain('data-testid="older-rules-later">Products you choose later use their category\'s settings or your store defaults, not these rules.</p>');
    expect(markup).toContain("<h3 class=\"text-sm font-semibold text-zinc-900\">They become:</h3>");
    expect(markup).toContain("<li class=\"break-words\">Sleeves: price</li>");
    expect(markup).toContain('data-testid="older-rules-kept">Kept as they are: 2 exact prices</p>');
    for (const absent of ["older-rules-blocked", "older-rules-reasons", "older-rules-changes", "older-rules-load-more", "older-rules-never-applies"]) {
      expect(markup, absent).not.toContain(`data-testid="${absent}"`);
    }
    expect(markup).not.toContain("Before you can move them over");
    expectPlainWords(markup);
  });

  it("shows a not-clean answer in 11.2's order, with the server's rows in the Prices tab's words and Load more", () => {
    const markup = renderSheet(notClean());
    expectInOrder(markup, [
      "older-rules-summary", "older-rules-later",
      "older-rules-blocked", "older-rules-lose-price", "older-rules-block-listing", "older-rules-too-much-text",
      "older-rules-becomes", "older-rules-becomes-categories", "older-rules-becomes-products",
      "older-rules-reasons", "older-rules-reason-ties", "older-rules-reason-nameMismatches", "older-rules-reason-unmatched",
      "older-rules-reason-shared", "older-rules-reason-someSizesOnly", "older-rules-reason-mixed",
      "older-rules-changes", "older-rules-rows", "older-rules-load-more",
      "older-rules-never-applies", "older-rules-kept", "older-rules-footer",
    ]);
    expect(markup).toContain("Moving them over would change 60 sizes. They're listed below.");
    expect(markup).toContain(">Before you can move them over</h3>");
    expect(markup).toContain("2 sizes would have no price after the move. Give each one its own price, then check again.");
    expect(markup).toContain("2 sizes you list on eBay would stop getting stock updates after the move. Fix each one, then check again.");
    expect(markup).toContain("Moving these rules would save more text than your store can keep.");
    expect(markup).toContain("Sleeves: price, text above and below");
    expect(markup).toContain("2 products get their own price: Penny Sleeves, Team Bags");
    expect(markup).toContain(">Why some sizes would change</h3>");
    expect(markup).toContain("Two price rules tie for Team Bags, so they can't price it today.");
    expect(markup).toContain("Card Shellz lists Penny Sleeves as “Sleves”, but it's in “Sleeves”. Its settings will follow “Sleeves”.");
    expect(markup).toContain("Your rule “Old binders” is for “Binders”, but no Card Shellz category has that name.");
    expect(markup).toContain("Your rule “Old rule 99” is for “Gone 99”");
    expect(markup).toContain("<li class=\"text-zinc-600\">and 12 more</li>");
    expect(markup).toContain("2 Card Shellz categories are called “Cases”. Your rule “Cases rule” becomes a setting on each of them that doesn't already have its own.");
    expect(markup).toContain("“Big packs” sets the eBay category for only some sizes of Penny Sleeves.");
    expect(markup).toContain("Different rules set the text above of Team Bags's sizes.");
    expect(markup).toContain(">Sizes that would change</h3>");
    // A row: its head, then one line per changed key, prices as the server's cents through formatCents, Built from in the Prices tab's words.
    const row = markup.slice(markup.indexOf(`data-testid="older-rules-row-${PENNY_100}"`), markup.indexOf(`data-testid="older-rules-row-${TEAM_50}"`));
    expect(row).toContain(">Penny Sleeves · Pack of 100</p>");
    expect(row).toContain("Price: $4.99 → $3.99");
    const pennyRow = notClean().changes.rows[0];
    expect(row).toContain(`Built from: ${builtFromWords(pennyRow.before.price)} → ${builtFromWords(pennyRow.after.price)}`);
    expect(row).toContain("Built from: From your older group rule “Sleeves”: retail $3.99 + 20%, up to .99 → No pricing rule covers this size, so it uses the retail price ($3.99).");
    expect(row).toContain("Pricing rule: “Sleeves” (Retail price + 20%, round up to .99) → None");
    expect(markup).toMatch(/<button class="[^"]*min-h-11[^"]*" type="button" data-testid="older-rules-load-more">Load more<\/button>/);
    expect(markup).toContain("Your rule “Summer sale” doesn't decide any of your chosen sizes, so it goes away.");
    expectPlainWords(markup);
  });

  it("gives every blocked size one button named with its size: Set a price for a lost price, Fix for a listed size, each name distinct", () => {
    const markup = renderSheet(notClean());
    const names = [...markup.matchAll(/aria-label="((?:Set a price for|Fix) [^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual([
      "Set a price for Penny Sleeves · Pack of 100", "Set a price for Team Bags · Pack of 50",
      "Fix Penny Sleeves · Pack of 1000", "Fix Team Bags · Pack of 200",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(count(markup, ">Set a price</button>")).toBe(2);
    expect(count(markup, ">Fix</button>")).toBe(2);
    // Today's price, and why a listed size would be blocked, in plain words.
    expect(markup).toContain("Now: $4.99");
    expect(markup).toContain("no eBay category, the description is too long");
    expect(markup).toContain("check your own text");
  });

  it("hands [Set a price] and [Fix] their landing: the size's Exact price, or the blocker's drawer row", () => {
    const blocked = blockedLines(notClean().blocked);
    if (blocked === null || blocked.wouldLosePrice === null || blocked.wouldBlockListing === null) throw new Error("expected blocks");
    const onSetPrice = vi.fn();
    const onFix = vi.fn();
    const press = (size: ConversionBlockedSize) => {
      const buttons = pressable(BlockedSizeItem({ size, onSetPrice, onFix }));
      expect(buttons).toHaveLength(1);
      buttons[0].props.onClick?.();
    };
    press(blocked.wouldLosePrice.sizes[0]);
    expect(onSetPrice).toHaveBeenCalledWith(expect.objectContaining({ kind: "set_price",
      landing: { target: { productId: PENNY, productVariantId: PENNY_100 }, row: null } }));
    press(blocked.wouldBlockListing.sizes[0]);
    expect(onFix).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "fix", blocker: "no_ebay_category",
      landing: { target: { productId: PENNY }, row: "ebayCategory" } }));
    press(blocked.wouldBlockListing.sizes[1]);
    expect(onFix).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "fix", blocker: "own_text_needs_check",
      landing: { target: { productId: TEAM }, row: "descriptionTemplate" } }));
    expect(onSetPrice).toHaveBeenCalledTimes(1);
    expect(onFix).toHaveBeenCalledTimes(2);
  });

  it("joins page 1's rows to page 0's, says a further page is reading or failed (with Try again), and Load more goes once every page read answered", () => {
    const joined = renderView(sheetState([notClean(0), notClean(1)]));
    expect(joined).toContain(`data-testid="older-rules-row-${PENNY_100}"`);
    expect(joined).toContain('data-testid="older-rules-row-95001"');
    expect(joined).toContain(">Soft Sleeves · Pack of 200</p>");
    // 60 rows, two pages read: none left.
    expect(joined).not.toContain('data-testid="older-rules-load-more"');

    const reading = renderView(sheetState([notClean(0), undefined]));
    expect(reading).toContain('data-testid="older-rules-more-loading">Checking what would change…</p>');
    expect(reading).not.toContain('data-testid="older-rules-load-more"');
    const failed = renderView(sheetState([notClean(0), { error: apiError(500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR") }]));
    expect(failed).toMatch(/data-testid="older-rules-more-problem"><span>Couldn't check what would change\.<\/span><button[^>]*>Try again<\/button>/);
    expect(failed).toContain(`data-testid="older-rules-row-${PENNY_100}"`);
  });

  it("shows only page 0's rows when page 1 answers for another plan, and says something changed until the sheet closes (CUX#12)", () => {
    const reset = sheetState([notClean(0, PLAN_A), notClean(1, PLAN_B)]);
    expect(reset.resetPages).toBe(true);
    const markup = renderView(reset);
    expect(markup).toContain('<p role="status" class="text-sm text-amber-900" data-testid="older-rules-changed">Something changed since you opened this. Check the list again.</p>');
    expect(markup).toContain(`data-testid="older-rules-row-${PENNY_100}"`);
    expect(markup).not.toContain('data-testid="older-rules-row-95001"');
    expect(markup).not.toContain('data-testid="older-rules-load-more"');
    // After the reset, page 0 alone, read again: the line stays.
    expect(renderView(sheetState([notClean(0, PLAN_B)], { planChanged: true }))).toContain('data-testid="older-rules-changed"');
  });

  it("hands Load more and a later page's Try again to the sheet", () => {
    const onLoadMore = vi.fn();
    const onRetryMore = vi.fn();
    const content = sheetState([notClean(0)]).content;
    if (content === null) throw new Error("expected a report");
    const loadMore = pressable(ReportBody({ content, onSetPrice: noop, onFix: noop, onLoadMore, onRetryMore }))
      .filter((element) => element.props.children === "Load more");
    expect(loadMore).toHaveLength(1);
    loadMore[0].props.onClick?.();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(onRetryMore).not.toHaveBeenCalled();

    // Page 1 failed: its line's Try again reads that page, never page 0 (the view's own Try again is page 0's).
    const failed = sheetState([notClean(0), { error: apiError(500, "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR") }]).content;
    if (failed === null) throw new Error("expected a report");
    const body = ReportBody({ content: failed, onSetPrice: noop, onFix: noop, onLoadMore, onRetryMore });
    expect(pressable(body).filter((element) => element.props.children === "Load more")).toEqual([]);
    // The later page's problem line, drawn as the sheet draws it, then its one button pressed.
    const line = elementsOf(body).find((element) => (element.props as { testId?: string }).testId === "older-rules-more-problem");
    if (line === undefined || typeof line.type !== "function") throw new Error("expected the later page's problem line");
    const buttons = pressable((line.type as (props: unknown) => unknown)(line.props));
    expect(buttons.map((button) => button.props.children)).toEqual(["Try again"]);
    buttons[0].props.onClick?.();
    expect(onRetryMore).toHaveBeenCalledTimes(1);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// [Move them over]: the footer in every 8.3 state (PR 11d, plan 8.3, 11.2, 11.4)
// ---------------------------------------------------------------------------

/** Not clean and nothing blocked: 60 sizes change, page 0 lists two of them. */
const NOT_CLEAN_FREE = check({ state: "not_clean", changes: { page: 0, pageSize: 50, total: 60, rows: [changeRow(PENNY_100, PENNY, "Penny Sleeves", "Pack of 100")] } });
const TEXT_ONLY = check({ state: "not_clean", blocked: { wouldLosePrice: list([]), wouldBlockListing: list([]), tooMuchText: true } });
const moveButton = (markup: string) => /<button class="[^"]*"( type="button")?( disabled="")?( type="button")? data-testid="older-rules-move">Move them over<\/button>/.exec(markup);
/** The footer's lines in order, with their role. */
function footerLines(markup: string): string[] {
  return [...markup.matchAll(/<p role="(status|alert)" class="[^"]*" data-testid="older-rules-footer-line">([^<]*)<\/p>/g)].map((match) => `${match[1]}: ${match[2]}`);
}
/** The footer's buttons, by their words, and whether each is off. */
function footerButtons(markup: string): string[] {
  return [...markup.matchAll(/<button ([^>]*)>([^<]*)<\/button>/g)].map((match) => `${match[2]}${/ disabled=""/.test(` ${match[1]}`) ? " (off)" : ""}`);
}

describe("[Move them over] in the footer (8.3)", () => {
  const cases: ReadonlyArray<[string, OlderRulesSheetState, string[], string[]]> = [
    ["clean", sheetState([CLEAN]), [], ["Close", "Move them over"]],
    ["not clean, nothing blocked", sheetState([NOT_CLEAN_FREE]), ["status: These 60 sizes change as listed."], ["Close", "Move them over"]],
    ["a size would lose its price, a listed size would stop updating (D9a, D9b)", sheetState([notClean()]), ["alert: Fix the sizes listed above first."], ["Close", "Move them over (off)"]],
    ["too much text (D9c)", sheetState([TEXT_ONLY]), [`alert: ${"Moving these rules would save more text than your store can keep. Choose fewer products in Choose what to sell, then check again. Listed products you take out stop selling on eBay."}`], ["Close", "Move them over (off)"]],
    ["no right, the summary still loading", sheetState([CLEAN], {}, null, { right: { editable: false, reason: "loading" } }), ["alert: Checking…"], ["Close", "Move them over (off)"]],
    ["no right, the banner says why", sheetState([CLEAN], {}, null, { right: { editable: false, reason: "banner" } }), [], ["Close", "Move them over (off)"]],
    ["saving", sheetState([CLEAN], {}, null, { draft: moveDraft(), busy: true }), ["status: Moving them over…"], ["Close", "Move them over (off)"]],
    ["converted / replayed", sheetState([NO_OLDER_RULES], {}, { kind: "moved", viewStale: false }), ["status: Moved over. Category settings can be saved now."], ["Close"]],
    ["converted, its view stale", sheetState([NO_OLDER_RULES], {}, { kind: "moved", viewStale: true }),
      ["status: Moved over. Category settings can be saved now.", "alert: We couldn't load the latest view."], ["Reload", "Close"]],
    ["nothing_to_convert", sheetState([NO_OLDER_RULES], {}, { kind: "already_moved", viewStale: false }), ["status: Your rules have already been moved over."], ["Close"]],
    ["409 CHANGED settings_changed", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "settings_changed" })) }),
      ["alert: Something changed since you opened this. Check the list again."], ["Close", "Move them over"]],
    ["409 CHANGED listed_changes_moved", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(409, "DROPSHIP_LISTING_CONVERSION_CHANGED", { reason: "listed_changes_moved" })) }),
      ["alert: Some changes in the list are different now, for example because a cost changed. Check the list again."], ["Close", "Move them over"]],
    ["422 WOULD_BE_LOST, page 0 read again", sheetState([notClean()], {}, null, { draft: moveDraft(apiErrorWith(422, "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizeCount: 2 })) }),
      ["alert: Something changed since you opened this. Check the list again.", "alert: Fix the sizes listed above first."], ["Close", "Move them over (off)"]],
    ["422 WOULD_BLOCK_LISTING, page 0 read again", sheetState([notClean()], {}, null, { draft: moveDraft(apiErrorWith(422, "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING", { sizeCount: 2 })) }),
      ["alert: Something changed since you opened this. Check the list again.", "alert: Fix the sizes listed above first."], ["Close", "Move them over (off)"]],
    ["422 TOO_LARGE store_text_limit, page 0 read again", sheetState([TEXT_ONLY], {}, null, { draft: moveDraft(apiErrorWith(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", { reason: "store_text_limit" })) }),
      ["alert: Something changed since you opened this. Check the list again.", `alert: ${"Moving these rules would save more text than your store can keep. Choose fewer products in Choose what to sell, then check again. Listed products you take out stop selling on eBay."}`], ["Close", "Move them over (off)"]],
    ["422 TOO_LARGE with no reason", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(422, "DROPSHIP_LISTING_SETTINGS_TOO_LARGE")) }),
      ["alert: Choose 10,000 or fewer sizes to move them over."], ["Close", "Move them over (off)"]],
    ["503 CHECK_UNAVAILABLE", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(503, "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE")) }),
      ["alert: We couldn't read your costs just now. Nothing was moved. Try again in a minute."], ["Close", "Move them over"]],
    ["409 IDEMPOTENCY_CONFLICT", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(409, "DROPSHIP_IDEMPOTENCY_CONFLICT")) }),
      ["alert: Something changed since you last tried. Check the list again."], ["Close", "Move them over"]],
    ["500 INVARIANT_FAILED", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(500, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED")) }),
      ["alert: Something went wrong on our side. Reload to see what's saved. If it happens again, contact support."], ["Close", "Move them over (off)"]],
    ["BUSY catalog_changed", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(503, "DROPSHIP_LISTING_SETTINGS_BUSY", { reason: "catalog_changed" })) }),
      ["alert: Card Shellz was changing your chosen products just then. Nothing was moved. Try again in a few seconds."], ["Close", "Move them over"]],
    ["uncertain (a dropped answer)", sheetState([CLEAN], {}, null, { draft: moveDraft(new TypeError("Failed to fetch")) }),
      ["alert: We couldn't confirm the move."], ["Check again", "Close"]],
    ["uncertain, reopened while page 0 reads", sheetState([undefined], {}, null, { draft: moveDraft(new TypeError("Failed to fetch")) }),
      ["alert: We couldn't confirm the move."], ["Check again", "Close"]],
    ["rate limited", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(429, "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED")) }),
      ["alert: Too many saves in a minute. Wait a moment and try again."], ["Close", "Move them over"]],
    ["blocked (the banner explains)", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(403, "DROPSHIP_LISTING_STORE_BLOCKED", { reason: "paused" })), right: { editable: false, reason: "banner" } }),
      ["alert: Nothing was saved."], ["Close", "Move them over (off)"]],
    ["signed out", sheetState([CLEAN], {}, null, { draft: moveDraft(apiErrorWith(401, "DROPSHIP_AUTH_REQUIRED")) }),
      ["alert: You're signed out. Sign in again, then save."], ["Close", "Move them over"]],
  ];

  it.each(cases)("%s", (_name, state, lines, buttons) => {
    const markup = renderFooter(state);
    expect(footerLines(markup)).toEqual(lines);
    expect(footerButtons(markup)).toEqual(buttons);
    expect(markup).toMatch(/min-h-11/);
    expectPlainWords(markup);
  });

  it("hands each button to the sheet: Move them over, Check again, Reload and Close, once each", () => {
    const onMove = vi.fn();
    const onCheckAgain = vi.fn();
    const onReload = vi.fn();
    const onClose = vi.fn();
    const press = (state: OlderRulesSheetState, label: string) => {
      const buttons = pressable(SheetFooterBar({ footer: state.footer, onClose, onMove, onCheckAgain, onReload, onGotIt: noop }))
        .filter((element) => element.props.children === label);
      expect(buttons).toHaveLength(1);
      buttons[0].props.onClick?.();
    };
    press(sheetState([CLEAN]), "Move them over");
    press(sheetState([CLEAN], {}, null, { draft: moveDraft(new TypeError("Failed to fetch")) }), "Check again");
    press(sheetState([NO_OLDER_RULES], {}, { kind: "moved", viewStale: true }), "Reload");
    press(sheetState([CLEAN]), "Close");
    expect([onMove, onCheckAgain, onReload, onClose].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1]);
    // The view hands the footer its own handlers: [Move them over] there is the sheet's onMove.
    const viewMove = vi.fn();
    const view = OlderRulesSheetView({ state: sheetState([CLEAN]), compact: false, onClose: noop, onRetry: noop, onSetPrice: noop, onFix: noop, onLoadMore: noop,
      onRetryMore: noop, onMove: viewMove, onCheckAgain: noop, onReload: noop, onGotIt: noop });
    const footer = elementsOf(view).find((element) => element.type === SheetFooterBar);
    expect((footer?.props as { onMove?: () => void } | undefined)?.onMove).toBe(viewMove);
  });

  it("a confirmed outcome stays in the sheet whatever page 0 answers after it (CUX#11)", () => {
    for (const page of [CLEAN, NO_OLDER_RULES, undefined]) {
      const markup = renderView(sheetState([page], {}, { kind: "moved", viewStale: false }));
      expect(markup).toContain(">Moved over. Category settings can be saved now.</p>");
      expect(moveButton(markup)).toBeNull();
    }
  });

  it("the step gives the sheet W11's right, the page's counter and its re-reads: the footer offers Move them over", () => {
    const { markup } = renderStep("/dropship-portal/catalog/setup?sheet=convert", { page0: CLEAN });
    expect(markup).toContain('data-testid="older-rules-move">Move them over</button>');
  });
});

// ---------------------------------------------------------------------------
// The Category settings card's opener (plan 5.2, D17)
// ---------------------------------------------------------------------------

describe("the Category settings card under older group rules", () => {
  function card(groupRules: number, catalogState: "ok" | "too_large" = "ok") {
    return categorySettingsCardState({ read: { data: CATEGORIES, error: null }, summary: summaryFacts(groupRules, catalogState), draft: null, right: EDITABLE });
  }

  it("puts See what changes under its one line, and its rows read No category settings yet", () => {
    const markup = render(React.createElement(CategorySettingsCardView, { card: card(1), onChange: noop, onRetry: noop, onSeeWhatChanges: noop }));
    expectInOrder(markup, ["category-settings-rows", "category-settings-older-rules", "category-settings-see-what-changes"]);
    expect(markup).toContain('data-testid="category-settings-older-rules">Category settings can\'t be saved while your store has older group rules.</p>');
    expect(markup).not.toContain("later update");
    expect(markup).toMatch(/<button class="[^"]*min-h-11[^"]*" type="button" data-testid="category-settings-see-what-changes">See what changes<\/button>/);
    expect(markup).toContain('<span class="font-medium">Sleeves</span> · 2 products · No category settings yet');
    expect(markup).not.toContain("Uses your store defaults");
    expect(markup).not.toContain('aria-label="Change settings for');
    // The heading takes focus when the sheet closes and its opener is gone (11.2).
    expect(markup).toMatch(/<h3 id="[^"]*" tabindex="-1" class="[^"]*">Category settings<\/h3>/);
  });

  it("has no opener without older rules (Uses your store defaults again), nor over 10,000 sizes", () => {
    const plain = render(React.createElement(CategorySettingsCardView, { card: card(0), onChange: noop, onRetry: noop, onSeeWhatChanges: noop }));
    expect(plain).not.toContain("See what changes");
    expect(plain).toContain("Uses your store defaults");
    expect(card(1, "too_large").olderRulesOpener).toBeNull();
  });

  it("hands See what changes to the step", () => {
    const onSeeWhatChanges = vi.fn();
    const { olderRulesLine, olderRulesOpener } = card(1);
    const buttons = pressable(CardOlderRules({ line: olderRulesLine, opener: olderRulesOpener, onSeeWhatChanges }));
    expect(buttons).toHaveLength(1);
    buttons[0].props.onClick?.();
    expect(onSeeWhatChanges).toHaveBeenCalledTimes(1);
    // The row itself has no Change (D11).
    const row = card(1).rows[0];
    expect(pressable(CategoryCardRowItem({ row, onChange: noop }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Focus when the sheet closes (11.2, CUX#11)
// ---------------------------------------------------------------------------

describe("firstConnected (the sheet's and the notice line's focus rule)", () => {
  const element = (isConnected: boolean) => ({ isConnected }) as unknown as HTMLElement;

  it("is the opener while it is on the page, else the Category settings card's heading, else the step's heading", () => {
    const opener = element(true);
    const cardHeading = element(true);
    const stepHeading = element(true);
    expect(firstConnected([opener, cardHeading, stepHeading])).toBe(opener);
    // The editor's See what changes went with the editor: the card's heading.
    expect(firstConnected([element(false), cardHeading, stepHeading])).toBe(cardHeading);
    // No card (no category, or too large): the step's heading.
    expect(firstConnected([null, undefined, stepHeading])).toBe(stepHeading);
    expect(firstConnected([null, element(false)])).toBeNull();
    expect(firstConnected([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The step (plan 5.2: the line's place, `?sheet=convert`, one surface at a time, D18)
// ---------------------------------------------------------------------------

function stepProps(summary: ListingSettingsSummary): ListingSettingsStepProps {
  const resolved = () => Promise.resolve();
  return {
    storeConnectionId: STORE, storeName: "Marz Cards", ebayStoreCount: 1,
    account: { status: "active", entitlementStatus: "active" },
    summary: { data: summary, error: null, isFetching: false, refetch: resolved },
    shelves: { data: { categories: [] }, error: null, isFetching: false, refetch: resolved },
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSettingsSaved: noop, goToStep: noop,
  };
}

/** One product Card Shellz moved to another category: "Card Shellz updated products" shows its line too (PR 10g). */
const UPDATED: ListingSettingsUpdatedProductsResponse = listingSettingsUpdatedProductsResponseSchema.parse({
  storeConnectionId: STORE, page: 0, pageSize: 50, total: 1,
  rows: [{ productId: PENNY, productName: "Penny Sleeves", ownTextNeedsCheck: false,
    move: { from: { categoryId: 7302, name: "Cases" }, to: { categoryId: SLEEVES, name: "Sleeves" }, changedFields: [] } }],
  moves: { total: 1, items: [{ productId: PENNY, shownCategoryId: SLEEVES }] }, generatedAt: STAMP,
});

function renderStep(address: string, options: { groupRules?: number; catalogState?: "ok" | "too_large"; page0?: ListingRulesConversionCheck; updated?: boolean } = {}) {
  vi.stubGlobal("React", React);
  const cache = client();
  seed(cache, listingSettingsCategoriesQueryOptions(STORE).queryKey, CATEGORIES);
  // Seeded only where the sheet is meant to read it: any other dry-run query in the cache is one the render made.
  if (options.page0) seed(cache, conversionKey(0), options.page0);
  if (options.updated) cache.setQueryData([...listingSettingsUpdatedProductsQueryOptions(STORE, 0).queryKey], UPDATED);
  const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client: cache },
    React.createElement(Router, { ssrPath: address, children: React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE,
      children: React.createElement(ListingSettingsStep, stepProps(summaryAnswer(options.groupRules ?? 1, options.catalogState ?? "ok"))) }) })))
    .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  // Every dry-run query the render made (D18: only the open sheet reads it).
  const conversionQueries = cache.getQueryCache().findAll({ queryKey: [...listingSettingsQueryKey(STORE), "conversion"] });
  cache.clear();
  return { markup, conversionQueries };
}

describe("the step and the older-rules sheet", () => {
  it("puts the line under the strip, above Card Shellz updated products and the Store defaults card; no dry-run query on mount (D18)", () => {
    const { markup, conversionQueries } = renderStep("/dropship-portal/catalog/setup", { updated: true });
    expectInOrder(markup, ["listing-settings-attention", "older-rules-line", "updated-products-line", "store-defaults-card", "category-settings-card"]);
    expect(markup).toContain("Your store still has older group rules. Move them over to use category settings.");
    expect(markup).not.toContain('data-testid="older-rules-sheet"');
    expect(conversionQueries).toEqual([]);
    // The card's See what changes too, and the step heading can take focus when nothing nearer is left (11.2).
    expect(markup).toContain('data-testid="category-settings-see-what-changes"');
    expect(markup).toMatch(/<h2 tabindex="-1" class="[^"]*">Listing settings for Marz Cards<\/h2>/);
  });

  it("opens the sheet at ?sheet=convert and reads page 0 only then; the drawer wins when the address opens both (D20)", () => {
    const open = renderStep("/dropship-portal/catalog/setup?sheet=convert", { page0: CLEAN });
    expect(count(open.markup, 'data-testid="older-rules-sheet"')).toBe(1);
    expect(open.markup).toContain("Moving them over changes nothing in your listings.");
    expect(open.conversionQueries.map((query) => query.queryKey)).toEqual([[...listingSettingsQueryKey(STORE), "conversion", 0]]);
    expect(open.markup).not.toContain('data-testid="product-drawer"');

    // No page seeded here, so any dry-run query in the cache would be one the render made.
    const both = renderStep("/dropship-portal/catalog/setup?sheet=convert&product=11");
    expect(both.markup).toContain('data-testid="product-drawer"');
    expect(both.markup).not.toContain('data-testid="older-rules-sheet"');
    expect(both.conversionQueries).toEqual([]);
    // The sheet wins over a category editor's address (one surface at a time, drawer > sheet > category).
    const overEditor = renderStep(`/dropship-portal/catalog/setup?sheet=convert&category=${SLEEVES}`, { page0: CLEAN });
    expect(overEditor.markup).toContain('data-testid="older-rules-sheet"');
    expect(overEditor.markup).not.toContain('data-testid="category-editor"');
  });

  it("keeps the sheet shut and the line without a button over 10,000 sizes, with no dry-run query (K7, D18)", () => {
    const { markup, conversionQueries } = renderStep("/dropship-portal/catalog/setup?sheet=convert", { catalogState: "too_large" });
    expect(markup).toContain('data-testid="listing-settings-banner"');
    expect(markup).toContain("Your store still has older group rules. Choose 10,000 or fewer sizes to move them over.");
    expect(markup.slice(markup.indexOf('data-testid="older-rules-line"'), markup.indexOf("</div>", markup.indexOf('data-testid="older-rules-line"')))).not.toContain("<button");
    expect(markup).not.toContain('data-testid="older-rules-sheet"');
    expect(conversionQueries).toEqual([]);
  });

  it("shows no line on a store with no older rules, and an old ?sheet=convert address opens the sheet, which says so", () => {
    const { markup } = renderStep("/dropship-portal/catalog/setup?sheet=convert", { groupRules: 0, page0: NO_OLDER_RULES });
    expect(markup).not.toContain('data-testid="older-rules-line"');
    expect(markup).not.toContain("See what changes");
    expect(markup).toContain("Your store has no older group rules any more.");
  });
});
