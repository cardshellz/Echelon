import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listingSettingsSummarySchema, listingSettingsUpdatedProductsResponseSchema, type ListingSettingsSummary, type ListingSettingsUpdatedProductsResponse } from "@shared/dropship/listing-settings";
import { listingSettingsUpdatedProductsQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { reduceListingSettingsDraft, UPDATED_PRODUCTS_EDITOR_ID, type ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import { updatedProductRow, updatedProductsDraftValue, updatedProductsLine, type UpdatedProductsSummaryFacts } from "@/lib/dropship-listing-settings-updated";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsStep, type ListingSettingsStepProps } from "../listing-settings/ListingSettingsStep";
import { UpdatedProductsLine, UpdatedProductsLineView } from "../listing-settings/UpdatedProductsLine";
import { UpdatedProductRowItem, UpdatedProductsSheet, type UpdatedProductsSheetProps } from "../listing-settings/UpdatedProductsSheet";

/**
 * "Card Shellz updated products" (Listing settings PR 10g, plan 10.2, 10.3, 10.5): the line under the
 * attention strip and the sheet at `?sheet=updated`, with its rows, header button, states and paging.
 * Static renders, as the other step tests: the step's one draft is set per test, the page read is put in
 * the query cache, and what a button does is checked on the hook-free row and line views.
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
  };
});

const STORE = 22;
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

type Row = ListingSettingsUpdatedProductsResponse["rows"][number];
const SLEEVES = { categoryId: 40, name: "Sleeves" };
const TOPLOADERS = { categoryId: 41, name: "Toploaders" };
const NONE = { categoryId: null, name: null };
const REMOVED = { categoryId: 99, name: null };

type Category = { categoryId: number | null; name: string | null };

function moved(productId: number, productName: string, from: Category, changedFields: NonNullable<Row["move"]>["changedFields"] = [], ownTextNeedsCheck = false): Row {
  return { productId, productName, ownTextNeedsCheck, move: { from, to: TOPLOADERS, changedFields } };
}

const ROWS: Row[] = [
  moved(2001, "Penny Sleeves", SLEEVES, ["shippingPolicy", "textBelow"]),
  moved(2002, "Team Bags", SLEEVES),
  moved(2003, "Binder Pages", NONE, ["shippingPolicy"]),
  moved(2004, "Card Cases", REMOVED, ["price"], true),
  { productId: 2006, productName: "Wordy Mailers", ownTextNeedsCheck: true, move: null },
];

function view(rows: Row[] = ROWS, page = 0, total = rows.length): ListingSettingsUpdatedProductsResponse {
  const moves = rows.filter((row) => row.move !== null).map((row) => ({ productId: row.productId, shownCategoryId: row.move!.to.categoryId }));
  return listingSettingsUpdatedProductsResponseSchema.parse({
    storeConnectionId: STORE, page, pageSize: 50, total, rows, moves: { total: moves.length, items: moves }, generatedAt: GENERATED_AT,
  });
}

const EMPTY = view([]);

function summaryFacts(catalogState: "ok" | "too_large" = "ok"): UpdatedProductsSummaryFacts {
  return { data: { catalog: catalogState === "ok" ? { state: "ok", products: 6, sizes: 9 } : { state: "too_large", limit: 10_000 } }, error: null };
}

/** A "Got it" draft as the sheet opens it, then settled as `phase` with its words. */
function gotItDraft(phase: "editing" | "saving" | "uncertain" | "refused" | "saved_view_stale", message: string | null = null): ListingSettingsDraft {
  const base = updatedProductsDraftValue({ items: [{ productId: 2001, shownCategoryId: 41 }] });
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: UPDATED_PRODUCTS_EDITOR_ID, place: "Card Shellz updated products", base })!;
  if (phase === "editing") return opened;
  const saving = reduceListingSettingsDraft(opened, { type: "startSave", attempt: { signature: "s", key: "ls-moves:k1" } })!;
  if (phase === "saving") return saving;
  if (phase === "saved_view_stale") return reduceListingSettingsDraft(saving, { type: "saved", key: "ls-moves:k1", nowMs: 1_000, viewStale: true })!;
  return reduceListingSettingsDraft(saving, { type: "failure", key: "ls-moves:k1", failure: { phase, message: message ?? "", code: null, status: null } })!;
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

/** Puts the page read's answer, failure or nothing (still loading) under its key. */
function seed(cache: QueryClient, page: number, answer: ListingSettingsUpdatedProductsResponse | { error: unknown } | undefined) {
  const options = listingSettingsUpdatedProductsQueryOptions(STORE, page);
  if (answer === undefined) return;
  if ("error" in answer) {
    cache.getQueryCache().build(cache, options)
      .setState({ status: "error", error: answer.error as Error, fetchStatus: "idle", errorUpdatedAt: 1, errorUpdateCount: 1 });
    return;
  }
  cache.setQueryData(options.queryKey, answer);
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

/** The markup of one row (its `<li>`). */
function rowOf(markup: string, productId: number): string {
  const start = markup.indexOf(`data-testid="updated-product-${productId}"`);
  expect(start, `row ${productId}`).toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf("</li>", start));
}

// ---------------------------------------------------------------------------
// The line under the strip (plan 10.2, UX-M9, UX-M10)
// ---------------------------------------------------------------------------

function renderLine(answer: ListingSettingsUpdatedProductsResponse | { error: unknown } | undefined, summary = summaryFacts()): string {
  const cache = client();
  seed(cache, 0, answer);
  return render(React.createElement(UpdatedProductsLine, { storeConnectionId: STORE, summary, onOpen: noop }), cache);
}

describe("the line under the attention strip", () => {
  it("says how many products Card Shellz moved, with Review, from page 0", () => {
    const markup = renderLine(view());
    expect(markup).toContain('data-testid="updated-products-line"');
    expect(markup).toContain("Card Shellz moved 4 products to another category.");
    expect(markup).toMatch(/<button class="[^"]*min-h-11[^"]*" type="button">Review<\/button>/);
    expect(renderLine(view([ROWS[0]]))).toContain("Card Shellz moved 1 product to another category.");
  });

  it("shows nothing (and no banner words) while the read loads, when it failed, or with no move; its read is off while the selection is too large", () => {
    expect(renderLine(undefined)).toBe("");
    expect(renderLine({ error: new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." }) })).toBe("");
    // Own text only: nothing moved.
    expect(renderLine(view([ROWS[4]]))).toBe("");
    expect(renderLine(EMPTY)).toBe("");
    // D18: no read is made while the summary says too large (the options' `enabled`, pinned in the lib's test), so nothing shows;
    // an answer cached before the summary said so is not shown either (the banner explains).
    expect(renderLine(undefined, summaryFacts("too_large"))).toBe("");
    expect(renderLine(view(), summaryFacts("too_large"))).toBe("");
  });

  it("Review opens the sheet", () => {
    vi.stubGlobal("React", React);
    const onOpen = vi.fn();
    const line = updatedProductsLine({ data: view() }, summaryFacts())!;
    const element = UpdatedProductsLineView({ line, onOpen }) as React.ReactElement<{ children: React.ReactElement[] }>;
    const button = element.props.children[1] as React.ReactElement<{ onClick: () => void; children: string }>;
    expect(button.props.children).toBe("Review");
    button.props.onClick();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The sheet (plan 10.3, 3.7)
// ---------------------------------------------------------------------------

function sheetProps(overrides: Partial<UpdatedProductsSheetProps> = {}): UpdatedProductsSheetProps {
  return {
    storeConnectionId: STORE, open: true, summary: summaryFacts(), right: EDITABLE,
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop, onClose: noop, onCheckOwnText: noop, ...overrides,
  };
}

/** The open sheet with page 0 answered (`answer`), failed (`{ error }`) or still loading (undefined). */
function renderSheet(draft: ListingSettingsDraft | null, answer: ListingSettingsUpdatedProductsResponse | { error: unknown } | undefined,
  overrides: Partial<UpdatedProductsSheetProps> = {}, more: Array<[number, ListingSettingsUpdatedProductsResponse]> = []): string {
  draftsValue(draft);
  const cache = client();
  seed(cache, 0, answer);
  for (const [page, pageAnswer] of more) seed(cache, page, pageAnswer);
  return render(React.createElement(UpdatedProductsSheet, sheetProps(overrides)), cache);
}

describe("the sheet", () => {
  it("titles itself, offers Got it for all N in the header, and words every row from the server's answer", () => {
    const markup = renderSheet(null, view());
    expect(count(markup, 'data-testid="updated-products-sheet"')).toBe(1);
    expect(markup).toContain("<h2>Card Shellz updated products</h2>");
    expect(markup).toMatch(/<button class="[^"]*" type="button" aria-label="Got it for all 4" data-testid="updated-products-got-it-all">Got it for all 4<\/button>/);
    // × is the first button (plan 3.4): the sheet never opens with its focus on the button that acknowledges every move.
    expect(markup.indexOf('aria-label="Close"')).toBeGreaterThan(-1);
    expect(markup.indexOf('aria-label="Close"')).toBeLessThan(markup.indexOf('data-testid="updated-products-got-it-all"'));

    const penny = rowOf(markup, 2001);
    expect(penny).toContain('<span class="font-medium text-zinc-900">Penny Sleeves</span> · Moved from Sleeves to Toploaders.');
    expect(penny).toContain("Category settings that differ: shipping policy, text below.");
    expect(penny).toMatch(/<button class="[^"]*" type="button" aria-label="Got it for Penny Sleeves">Got it<\/button>/);
    expect(penny).not.toContain("Check your text");

    // UX-M6: never "Nothing changes".
    const team = rowOf(markup, 2002);
    expect(team).toContain("No category setting changes for it.");
    expect(markup).not.toContain("Nothing changes");

    // CC-C21: no category, and a category Card Shellz removed.
    expect(rowOf(markup, 2003)).toContain("Moved from no category to Toploaders.");
    const cases = rowOf(markup, 2004);
    expect(cases).toContain("Moved from a category Card Shellz removed to Toploaders.");
    // A move and own text: both lines, both buttons.
    expect(cases).toContain("Card Shellz changed this product. Check your text still fits.");
    expect(cases).toContain('aria-label="Got it for Card Cases"');
    expect(cases).toContain('aria-label="Check the text of Card Cases"');

    // Own text only: no Got it.
    const wordy = rowOf(markup, 2006);
    expect(wordy).toContain('<span class="font-medium text-zinc-900">Wordy Mailers</span> · Card Shellz changed this product. Check your text still fits.');
    expect(wordy).toMatch(/<button class="[^"]*" type="button" aria-label="Check the text of Wordy Mailers">Check<\/button>/);
    expect(wordy).not.toContain("Got it");
    // Four rows' Got it, and the header's "Got it for all 4".
    expect(count(markup, 'aria-label="Got it for ')).toBe(5);
    // No status line, no Check again, no Reload, and nothing is off.
    expect(markup).not.toContain('data-testid="updated-products-line-status"');
    expect(markup).not.toContain("Check again");
    expect(markup).not.toContain("Reload");
    expect(markup).not.toContain('disabled=""');
  });

  it("says it is checking, then Try again when the read failed, the rate-limit words for a 429, and the empty words with no row", () => {
    const loading = renderSheet(null, undefined);
    expect(loading).toContain('<p role="status" class="text-sm text-zinc-600">Checking what Card Shellz updated…</p>');
    expect(loading).not.toContain("Got it for all");
    expect(loading).not.toContain('data-testid="updated-products-rows"');

    const failed = renderSheet(null, { error: new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." }) });
    expect(failed).toContain('data-testid="updated-products-read-problem"><span>Couldn\'t check what Card Shellz updated. Try again.</span>');
    expect(failed).toMatch(/<div role="alert" class="[^"]*" data-testid="updated-products-read-problem">/);
    expect(failed).toMatch(/<button class="[^"]*" type="button">Try again<\/button>/);

    const limited = renderSheet(null, { error: new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Slow down." }) });
    expect(limited).toContain("Too many checks in a minute. Wait a moment and try again.");

    const empty = renderSheet(null, EMPTY);
    expect(empty).toContain('<p role="status" class="text-sm text-zinc-700" data-testid="updated-products-empty">Nothing here. Card Shellz hasn\'t updated any of your products.</p>');
    expect(empty).not.toContain("Got it for all");
    expect(empty).not.toContain('data-testid="updated-products-paging"');
  });

  it("turns every Got it off with the right's reason, and without one under a banner; Check stays on", () => {
    const loadingRight = renderSheet(null, view(), { right: { editable: false, reason: "loading" } });
    expect(loadingRight).toContain('<p class="text-xs text-zinc-600" data-testid="updated-products-reason">Checking…</p>');
    expect(loadingRight).toMatch(/<button class="[^"]*" type="button" aria-label="Got it for all 4" disabled="" data-testid="updated-products-got-it-all">/);
    expect(loadingRight).toMatch(/<button class="[^"]*" type="button" aria-label="Got it for Penny Sleeves" disabled="">/);
    expect(loadingRight).not.toMatch(/aria-label="Check the text of Wordy Mailers" disabled=""/);

    const banner = renderSheet(null, view(), { right: { editable: false, reason: "banner" } });
    expect(banner).not.toContain('data-testid="updated-products-reason"');
    expect(count(banner, 'disabled=""')).toBe(5);

    const busy = renderSheet(null, view(), { saveCallbacks: { disabled: true, onSaveStarted: noop, onSaveSettled: noop } });
    expect(count(busy, 'disabled=""')).toBe(5);
  });

  it("locks while a Got it is out, offers Check again while it is unconfirmed, and Reload when its re-read failed", () => {
    const saving = renderSheet(gotItDraft("saving"), view());
    expect(saving).toContain('<p role="status" class="text-sm text-zinc-700" data-testid="updated-products-line-status">Saving…</p>');
    expect(count(saving, 'disabled=""')).toBe(5);

    const uncertain = renderSheet(gotItDraft("uncertain", "We couldn't confirm your save."), view());
    expect(uncertain).toContain('<p role="alert" class="text-sm text-amber-900" data-testid="updated-products-line-status">We couldn\'t confirm your save.</p>');
    expect(uncertain).toMatch(/<button class="[^"]*" type="button">Check again<\/button>/);
    expect(count(uncertain, 'disabled=""')).toBe(5);

    const refused = renderSheet(gotItDraft("refused", "Something changed since you last tried. Save again."), view());
    expect(refused).toContain("Something changed since you last tried. Save again.");
    expect(refused).not.toContain("Check again");
    expect(refused).not.toContain('disabled=""');

    const stale = renderSheet(gotItDraft("saved_view_stale"), view());
    expect(stale).toContain("Saved. We couldn't load the latest view.");
    expect(stale).toMatch(/<button class="[^"]*" type="button">Reload<\/button>/);
    // Another editor's draft locks nothing here.
    const other = reduceListingSettingsDraft(null, { type: "open", editor: "price", place: "Price", base: {} })!;
    expect(renderSheet(other, view())).not.toContain('disabled=""');
  });

  it("pages 50 at a time: the range with Previous and Next on a wide screen, Load more on a phone", () => {
    const sixty = view(ROWS, 0, 60);
    const wide = renderSheet(null, sixty);
    expect(wide).toContain('data-testid="updated-products-paging"><span>1–50 of 60</span>');
    expect(wide).toMatch(/<button class="[^"]*" type="button" disabled="">Previous<\/button>/);
    expect(wide).toMatch(/<button class="[^"]*" type="button">Next<\/button>/);
    expect(wide).not.toContain("Load more");
    // One page: the range alone.
    const one = renderSheet(null, view());
    expect(one).toContain("<span>1–5 of 5</span>");
    expect(one).not.toContain("Previous");

    stubWidth(false);
    const phone = renderSheet(null, sixty, {}, [[1, view([ROWS[0]], 1, 60)]]);
    expect(phone).not.toContain("Previous");
    expect(phone).toMatch(/<button class="[^"]*min-h-11 w-full[^"]*" type="button">Load more<\/button>/);
    // The phone shows every page loaded so far: page 0's rows only until Load more is pressed.
    expect(count(phone, 'data-testid="updated-product-')).toBe(5);
    expect(phone).toContain('aria-label="Back"');
    // ← comes first on a phone too.
    expect(phone.indexOf('aria-label="Back"')).toBeLessThan(phone.indexOf('data-testid="updated-products-got-it-all"'));
  });

});

// ---------------------------------------------------------------------------
// A row's buttons (hook-free)
// ---------------------------------------------------------------------------

describe("a row's buttons", () => {
  it("Got it sends the product with the category it is shown in; Check hands the own-text action, which lands on Description", () => {
    vi.stubGlobal("React", React);
    const onGotIt = vi.fn();
    const onCheck = vi.fn();
    type Element = React.ReactElement<{ children?: unknown; onClick?: () => void; "aria-label"?: string }>;
    /** Every element with a name and a click (the `Button`s, which a forwardRef draws), outermost first. */
    const pressable = (node: unknown): Element[] => {
      if (Array.isArray(node)) return node.flatMap(pressable);
      if (!React.isValidElement(node)) return [];
      const element = node as Element;
      const own = typeof element.props.onClick === "function" && typeof element.props["aria-label"] === "string" ? [element] : [];
      return [...own, ...pressable(element.props.children)];
    };
    const row = updatedProductRow(ROWS[3]);
    const buttons = pressable(UpdatedProductRowItem({ row, disabled: false, onGotIt, onCheck }));
    expect(buttons.map((button) => button.props["aria-label"])).toEqual(["Got it for Card Cases", "Check the text of Card Cases"]);
    buttons[0].props.onClick?.();
    expect(onGotIt).toHaveBeenCalledWith({ items: [{ productId: 2004, shownCategoryId: 41 }] });
    buttons[1].props.onClick?.();
    expect(onCheck).toHaveBeenCalledWith({ kind: "open_product", label: "Check", productId: 2004, fix: "own_text_needs_check", row: "descriptionTemplate" });
    // A row listed for its own text alone has no Got it.
    expect(pressable(UpdatedProductRowItem({ row: updatedProductRow(ROWS[4]), disabled: false, onGotIt, onCheck })).map((button) => button.props["aria-label"]))
      .toEqual(["Check the text of Wordy Mailers"]);
  });
});

// ---------------------------------------------------------------------------
// The step: the address opens the sheet, one surface at a time (D20, D21)
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

function renderStep(address: string, answer?: ListingSettingsUpdatedProductsResponse, catalogState: "ok" | "too_large" = "ok"): string {
  vi.stubGlobal("React", React);
  const cache = client();
  if (answer) cache.setQueryData(listingSettingsUpdatedProductsQueryOptions(STORE_ID, 0).queryKey, { ...answer, storeConnectionId: STORE_ID });
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
  it("opens the sheet the address names, under the strip's line, and never beside the drawer (D20)", () => {
    const closed = renderStep("/dropship-portal/catalog/setup", view());
    expect(closed).not.toContain('data-testid="updated-products-sheet"');
    // The line sits under the strip and before the Store defaults card (UX-M10), from the mount-time read.
    const line = closed.indexOf('data-testid="updated-products-line"');
    expect(line).toBeGreaterThan(closed.indexOf('data-testid="listing-settings-attention"'));
    expect(line).toBeLessThan(closed.indexOf('data-testid="store-defaults-card"'));

    const open = renderStep("/dropship-portal/catalog/setup?sheet=updated", view());
    expect(count(open, 'data-testid="updated-products-sheet"')).toBe(1);
    expect(open).toContain("Got it for all 4");
    expect(open).not.toContain('data-testid="product-drawer"');

    const both = renderStep("/dropship-portal/catalog/setup?sheet=updated&product=11", view());
    expect(both).toContain('data-testid="product-drawer"');
    expect(both).not.toContain('data-testid="updated-products-sheet"');
    // No read yet: no line, and nothing said about it.
    expect(renderStep("/dropship-portal/catalog/setup")).not.toContain('data-testid="updated-products-line"');
  });

  it("keeps the sheet shut and the line hidden while the selection is too large: the banner explains (plan 3.7, D18)", () => {
    const tooLarge = renderStep("/dropship-portal/catalog/setup?sheet=updated", view(), "too_large");
    expect(tooLarge).toContain('data-testid="listing-settings-banner"');
    expect(tooLarge).toContain("more than 10,000 sizes");
    expect(tooLarge).not.toContain('data-testid="updated-products-sheet"');
    expect(tooLarge).not.toContain("Checking what Card Shellz updated");
    // The page-0 answer cached before the summary said so is not shown either.
    expect(tooLarge).not.toContain('data-testid="updated-products-line"');
  });
});
