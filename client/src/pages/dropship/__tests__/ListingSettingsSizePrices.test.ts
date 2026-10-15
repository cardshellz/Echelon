import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listingSettingsPricesResponseSchema,
  listingSettingsSizePriceSchema,
  listingSettingsSummarySchema,
  type ListingSettingsPricesResponse,
  type ListingSettingsSizePrice,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { listingSettingsPricesQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { SIZE_PRICES_EDITOR_ID, reduceListingSettingsDraft, type ListingSettingsDraft, type ListingSettingsDraftAction } from "@/lib/dropship-listing-settings-drafts";
import {
  emptySizePricesDraft,
  noSizePricesRefusal,
  sizePriceTyped,
  sizePricesPageQueryOptions,
  sizePricesSheetState,
  type SizePricesDraftValue,
  type SizePricesSummaryFacts,
} from "@/lib/dropship-listing-settings-size-prices";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { GiveSizesPriceSheet, SizePriceBox, SizePriceRows, type GiveSizesPriceSheetProps } from "../listing-settings/GiveSizesPriceSheet";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsStep, type ListingSettingsStepProps } from "../listing-settings/ListingSettingsStep";
import { PricesTab, type PricesTabProps } from "../listing-settings/PricesTab";

/**
 * "Give these sizes a price" (Listing settings PR 10f, plan 9.1-9.3, 9.5, 9.6; D12, D16, D18, D20, D21): the sheet at
 * `?sheet=give-prices` with its states, its rows and their notes, the 200 rule, the footer by phase; the Prices tab's
 * entry button; the strip's [Fix] routing; and the step's wiring. Static renders, as the other step tests: the step's
 * one draft is set per test, the page reads are put in the query cache under the lib's keys, and what a box does is
 * checked on the hook-free row views.
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
const GENERATED_AT = "2026-10-15T12:00:00.000Z";
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const TITLE = "Give these sizes a price";
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.drafts = null;
});

// ---------------------------------------------------------------------------
// Fixtures, each checked against the shared contract; prices in odd cents
// ---------------------------------------------------------------------------

/** A chosen size that can't be priced: no retail price, no rule price. */
function size(overrides: Partial<ListingSettingsSizePrice> & Pick<ListingSettingsSizePrice, "productVariantId">): ListingSettingsSizePrice {
  return listingSettingsSizePriceSchema.parse({
    productId: 11, productName: "Penny Sleeves", sizeName: "Pack of 100", sku: "PSL-100", priceCents: null, source: "none", rule: null,
    basis: "catalog_retail", basisAmountCents: null, issue: "pricing_basis_unavailable", costCents: 210, belowCostByCents: null, limits: [],
    pausedSince: null, settingRevisionId: null, ...overrides,
  });
}

const PACK_100 = size({ productVariantId: 101 });
const PACK_500 = size({ productVariantId: 102, sizeName: "Pack of 500", sku: "PSL-500", costCents: 610, settingRevisionId: 9 });
const CASE_1000 = size({ productVariantId: 103, productId: 12, productName: "Team Bags", sizeName: "Case of 1,000", sku: null, costCents: null });
const FLOORED = size({ productVariantId: 104, productId: 13, productName: "Toploaders 35pt", sizeName: "Pack of 25", sku: "TL-25", costCents: 300,
  limits: [{ policyId: 7, floorCents: 500, ceilingCents: null, mode: "block_listing", breached: null }] });

function page(rows: ListingSettingsSizePrice[], total = rows.length, pageNumber = 0): ListingSettingsPricesResponse {
  return listingSettingsPricesResponseSchema.parse({ storeConnectionId: STORE, page: pageNumber, pageSize: 50, total, rows, generatedAt: GENERATED_AT });
}

const PAGE = page([PACK_100, PACK_500, CASE_1000, FLOORED]);

function summaryFacts(catalogState: "ok" | "too_large" = "ok"): SizePricesSummaryFacts {
  return { data: { catalog: catalogState === "ok" ? { state: "ok", products: 3, sizes: 4 } : { state: "too_large", limit: 10_000 } }, error: null };
}

type Phase = "editing" | "saving" | "uncertain" | "refused" | "conflict" | "saved_view_stale";

function run(actions: readonly ListingSettingsDraftAction[]): ListingSettingsDraft {
  const draft = actions.reduce<ListingSettingsDraft | null>((current, action) => reduceListingSettingsDraft(current, action), null);
  if (draft === null) throw new Error("expected a draft");
  return draft;
}

/** The sheet's draft with `typed` prices (each with its row's revision), then settled as `phase` with its words. */
function typedDraft(typed: ReadonlyArray<[ListingSettingsSizePrice, string]>, phase: Phase = "editing", message: string | null = null): ListingSettingsDraft {
  const value = typed.reduce<SizePricesDraftValue>((current, [row, text]) => sizePriceTyped(current, row, text), emptySizePricesDraft());
  const opened: ListingSettingsDraftAction[] = [
    { type: "open", editor: SIZE_PRICES_EDITOR_ID, place: TITLE, base: emptySizePricesDraft() },
    { type: "edit", value },
  ];
  if (phase === "editing") return run(opened);
  const saving: ListingSettingsDraftAction[] = [...opened, { type: "startSave", attempt: { signature: "s", key: "ls-size-prices:k1" } }];
  if (phase === "saving") return run(saving);
  if (phase === "saved_view_stale") return run([...saving, { type: "saved", key: "ls-size-prices:k1", nowMs: 1_000, viewStale: true }]);
  return run([...saving, { type: "failure", key: "ls-size-prices:k1", failure: { phase, message: message ?? "", code: null, status: null } }]);
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

type Seeded = ListingSettingsPricesResponse | { error: unknown; kept?: ListingSettingsPricesResponse } | undefined;

/** Puts a page's answer, failure (with the last answer kept beside it) or nothing (still loading) under the sheet's key for it. */
function seed(cache: QueryClient, pageNumber: number, answer: Seeded) {
  if (answer === undefined) return;
  const options = sizePricesPageQueryOptions(STORE, pageNumber, summaryFacts(), true);
  if ("error" in answer) {
    if (answer.kept !== undefined) cache.setQueryData(options.queryKey, answer.kept);
    cache.getQueryCache().build(cache, { queryKey: options.queryKey })
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

/** The markup of one element with this test id, to its closing tag of `tag`. */
function sliceOf(markup: string, testId: string, tag: string): string {
  const start = markup.indexOf(`data-testid="${testId}"`);
  expect(start, testId).toBeGreaterThan(-1);
  return markup.slice(start, markup.indexOf(`</${tag}>`, start));
}

type Element = React.ReactElement<{ children?: unknown; onClick?: () => void; onChange?: (event: unknown) => void; "aria-label"?: string }>;
/** Every element with a click or a change handler, outermost first (the inputs, and the `Button`s a forwardRef draws). */
function pressable(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(pressable);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  const own = typeof element.props.onClick === "function" || typeof element.props.onChange === "function" ? [element] : [];
  return [...own, ...pressable(element.props.children)];
}

function sheetProps(overrides: Partial<GiveSizesPriceSheetProps> = {}): GiveSizesPriceSheetProps {
  return {
    storeConnectionId: STORE, open: true, summary: summaryFacts(), right: EDITABLE, saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
    onSaved: noop, onClose: noop, ...overrides,
  };
}

/** The open sheet with its first page answered (`answer`), failed (`{ error }`) or still loading (undefined), on `draft`. */
function renderSheet(draft: ListingSettingsDraft | null, answer: Seeded, overrides: Partial<GiveSizesPriceSheetProps> = {}): string {
  draftsValue(draft);
  const cache = client();
  seed(cache, 0, answer);
  return render(React.createElement(GiveSizesPriceSheet, sheetProps(overrides)), cache);
}

// ---------------------------------------------------------------------------
// The sheet (plan 9.3, 3.7)
// ---------------------------------------------------------------------------

describe("Give these sizes a price", () => {
  it("titles itself with the intro, lists each size of the first page with its product, size, cost and a box named by product and size, and offers Load more while another page follows", () => {
    const markup = renderSheet(null, PAGE);
    expect(count(markup, 'data-testid="give-sizes-price-sheet"')).toBe(1);
    expect(markup).toContain(`<h2>${TITLE}</h2>`);
    expect(markup).toContain("<p>These sizes can't be listed until they have a price.</p>");
    // × is the first button on a wide screen (plan 3.4).
    expect(markup.indexOf('aria-label="Close"')).toBeLessThan(markup.indexOf('data-testid="size-prices-rows"'));
    for (const column of ["Product", "Size", "Your cost", "Exact price"]) expect(markup).toContain(`<th scope="col" class="px-3 py-2">${column}</th>`);
    const rows = sliceOf(markup, "size-prices-rows", "table");
    const order = [101, 102, 103, 104].map((id) => rows.indexOf(`data-testid="size-price-${id}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    const pack = sliceOf(markup, "size-price-101", "tr");
    expect(pack).toContain(">Penny Sleeves</td>");
    expect(pack).toContain(">Pack of 100 · PSL-100</td>");
    // The column is headed "Your cost": the cell holds the amount alone; a phone card says "Your cost $2.10".
    expect(pack).toContain(">$2.10</td>");
    expect(pack).not.toContain("Your cost $2.10");
    expect(pack).toMatch(/<input type="text" class="[^"]*" inputMode="decimal" autoComplete="off" aria-label="Exact price for Penny Sleeves, Pack of 100" value=""/);
    // A size with no SKU and no cost known.
    const caseRow = sliceOf(markup, "size-price-103", "tr");
    expect(caseRow).toContain(">Case of 1,000</td>");
    expect(caseRow).toContain(">—</td>");
    expect(caseRow).toContain('aria-label="Exact price for Team Bags, Case of 1,000"');
    // Every box can be typed in; the footer with nothing typed: Discard and Save prices off, no count.
    expect(count(markup, 'aria-label="Exact price for')).toBe(4);
    expect(markup).not.toMatch(/readOnly=""/i);
    expect(markup).toContain('data-testid="size-prices-footer"');
    expect(markup).not.toContain('data-testid="size-prices-not-saved"');
    expect(markup).toMatch(/<button class="[^"]*" type="button" disabled="">Discard<\/button>/);
    expect(markup).toMatch(/<button class="[^"]*" type="button" disabled="">Save prices<\/button>/);
    // Four of four: no Load more; four of sixty: Load more after the rows, on a wide screen too (9.3).
    expect(markup).not.toContain('data-testid="size-prices-load-more"');
    const more = renderSheet(null, page([PACK_100, PACK_500, CASE_1000, FLOORED], 60));
    expect(more).toMatch(/<button class="[^"]*min-h-11[^"]*" type="button" data-testid="size-prices-load-more">Load more<\/button>/);
    expect(more.indexOf('data-testid="size-prices-load-more"')).toBeGreaterThan(more.indexOf('data-testid="size-price-104"'));
    // No raw code anywhere.
    expect(markup).not.toMatch(/pricing_basis_unavailable|catalog_retail|cannot_price/);
  });

  it("says it is checking before its read answers, Try again when it failed, the rate-limit words for a 429, and that every size has a price with nothing to save", () => {
    const loading = renderSheet(null, undefined);
    expect(loading).toContain('<p role="status" class="text-sm text-zinc-600">Checking which sizes need a price…</p>');
    expect(loading).not.toContain('data-testid="size-prices-rows"');
    expect(loading).not.toContain('data-testid="size-prices-footer"');

    const failed = renderSheet(null, { error: new DropshipApiError({ status: 500, code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR", message: "Read failed." }) });
    expect(failed).toContain('data-testid="size-prices-read-problem"><span>Couldn\'t check which sizes need a price. Try again.</span>');
    expect(failed).toMatch(/<div role="alert" class="[^"]*" data-testid="size-prices-read-problem">/);
    expect(failed).toMatch(/<button class="[^"]*" type="button">Try again<\/button>/);

    const limited = renderSheet(null, { error: new DropshipApiError({ status: 429, code: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED", message: "Slow down." }) });
    expect(limited).toContain("Too many checks in a minute. Wait a moment and try again.");

    const empty = renderSheet(null, page([]));
    expect(empty).toContain('<p role="status" class="text-sm text-emerald-800" data-testid="size-prices-empty">Every size has a price.</p>');
    expect(empty).not.toContain('data-testid="size-prices-rows"');
    expect(empty).not.toContain('data-testid="size-prices-footer"');

    // A refresh that failed keeps the rows (React Query keeps the last answer beside the error).
    const kept = renderSheet(null, { kept: PAGE, error: new TypeError("offline") });
    expect(kept).toContain('data-testid="size-prices-rows"');
    expect(kept).not.toContain('data-testid="size-prices-read-problem"');
  });

  it("shows the typed prices with the drawer's notes under each box, the parsers' words as a note, and counts them in the footer with Discard and Save prices; a phone counts alone", () => {
    const typed = renderSheet(typedDraft([[PACK_100, "3.49"], [PACK_500, "2.0"]]), PAGE);
    const pack = sliceOf(typed, "size-price-101", "tr");
    expect(pack).toContain('value="3.49"');
    expect(pack).toContain("$3.49 is $1.39 over your cost, before eBay fees and shipping.");
    const big = sliceOf(typed, "size-price-102", "tr");
    expect(big).toContain('value="2.0"');
    expect(big).toContain("Below your cost: you'd lose $4.10 on each sale. You can still save it.");
    expect(typed).toContain('data-testid="size-prices-not-saved">● Not saved · 2 prices</span>');
    expect(typed).toMatch(/<button class="[^"]*" type="button">Discard<\/button>/);
    expect(typed).toMatch(/<button class="[^"]*" type="button">Save prices<\/button>/);
    expect(typed).not.toContain('disabled="">Save prices');
    // A limit the typed price breaks: the drawer's note; a box the parsers refuse: its words, Save off.
    const flooredLow = renderSheet(typedDraft([[FLOORED, "2.00"]]), PAGE);
    expect(sliceOf(flooredLow, "size-price-104", "tr")).toContain("Card Shellz lists this size at $5.00 or more.");
    const invalid = renderSheet(typedDraft([[PACK_100, "abc"], [PACK_500, "4.50"]]), PAGE);
    expect(sliceOf(invalid, "size-price-101", "tr")).toMatch(/aria-invalid="true" aria-describedby="size-price-101-error"/);
    // The parsers' words are a note the box points at, never a live alert for each keystroke (the drawer's way).
    expect(invalid).toContain('<p id="size-price-101-error" class="text-xs text-rose-800">Enter a price like 14.99.</p>');
    expect(sliceOf(invalid, "size-price-101", "tr")).not.toContain('role="alert"');
    expect(invalid).toContain("● Not saved · 2 prices");
    expect(invalid).toMatch(/<button class="[^"]*" type="button" disabled="">Save prices<\/button>/);
    // One price.
    expect(renderSheet(typedDraft([[PACK_100, "3.49"]]), PAGE)).toContain("● Not saved · 1 price</span>");

    stubWidth(false);
    const phone = renderSheet(typedDraft([[PACK_100, "3.49"], [PACK_500, "2.0"]]), PAGE);
    expect(phone).toContain('data-testid="size-prices-not-saved">● Not saved · 2</span>');
    expect(phone).toContain('aria-label="Back"');
    expect(phone.indexOf('aria-label="Back"')).toBeLessThan(phone.indexOf("<h2>"));
    expect(phone).not.toContain("<table");
    expect(phone).toContain('<ul aria-label="Give these sizes a price" class="space-y-2" data-testid="size-prices-rows">');
    const card = sliceOf(phone, "size-price-101", "li");
    expect(card).toContain(">Penny Sleeves</p>");
    expect(card).toContain(">Pack of 100 · PSL-100</p>");
    expect(card).toContain(">Your cost $2.10</p>");
    expect(card).toContain('aria-label="Exact price for Penny Sleeves, Pack of 100"');
    expect(sliceOf(phone, "size-price-103", "li")).not.toContain("Your cost");
    expect(phone).toMatch(/<button class="[^"]*" type="button">Save prices<\/button>/);
    // Load more spans the width on a phone.
    expect(renderSheet(null, page([PACK_100], 60))).toMatch(/class="[^"]*w-full[^"]*" type="button" data-testid="size-prices-load-more"/);
  });

  it("turns Save off over 200 typed prices with the words, whatever the pages show (D12)", () => {
    const many: Array<[ListingSettingsSizePrice, string]> = Array.from({ length: 201 }, (_, index) => [size({ productVariantId: 1_000 + index }), "4.99"]);
    const markup = renderSheet(typedDraft(many), PAGE);
    expect(markup).toContain("● Not saved · 201 prices</span>");
    expect(markup).toMatch(/<button class="[^"]*" type="button" disabled="">Save prices<\/button>/);
    expect(markup).toContain("Save up to 200 prices at a time.");
    const two = renderSheet(typedDraft(many.slice(0, 200)), PAGE);
    expect(two).toContain("● Not saved · 200 prices</span>");
    expect(two).not.toContain("Save up to 200 prices at a time.");
    expect(two).not.toContain('disabled="">Save prices');
  });

  it("locks the boxes while a save is out or unconfirmed, offers Check again, Load latest after a conflict, Reload after a stale view, and words a refusal", () => {
    const saving = renderSheet(typedDraft([[PACK_100, "3.49"]], "saving"), PAGE);
    expect(count(saving, 'readOnly=""')).toBe(4);
    expect(saving).toContain(">Saving…</button>");
    expect(saving).toMatch(/<button class="[^"]*" type="button" disabled="">Discard<\/button>/);

    const uncertain = renderSheet(typedDraft([[PACK_100, "3.49"]], "uncertain", "We couldn't confirm your save."), PAGE);
    expect(count(uncertain, 'readOnly=""')).toBe(4);
    expect(uncertain).toContain('<span role="alert" class="text-sm text-amber-900">We couldn\'t confirm your save.</span>');
    expect(uncertain).toMatch(/<button class="[^"]*" type="button">Check again<\/button>/);
    expect(uncertain).toMatch(/<button class="[^"]*" type="button" disabled="">Discard<\/button>/);

    const conflict = renderSheet(typedDraft([[PACK_100, "3.49"]], "conflict", "1 size's price changed in another window."), PAGE);
    expect(conflict).toContain("1 size's price changed in another window.");
    expect(conflict).toMatch(/<button class="[^"]*" type="button">Load latest and keep my changes<\/button>/);
    expect(conflict).not.toMatch(/readOnly=""/i);

    const refused = renderSheet(typedDraft([[PACK_100, "3.49"]], "refused", "1 size's price would be outside what Card Shellz allows. Enter prices Card Shellz allows."), PAGE);
    expect(refused).toContain('<span role="alert" class="text-sm text-amber-900">1 size\'s price would be outside what Card Shellz allows. Enter prices Card Shellz allows.</span>');
    expect(refused).toMatch(/<button class="[^"]*" type="button">Save prices<\/button>/);

    const stale = renderSheet(typedDraft([[PACK_100, "3.49"]], "saved_view_stale"), PAGE);
    expect(stale).toContain("Saved. We couldn't load the latest view.");
    expect(stale).toMatch(/<button class="[^"]*" type="button">Reload<\/button>/);
  });

  it("marks the rows a refusal named: outside a limit with the words, in conflict with the amber ring (9.5)", () => {
    vi.stubGlobal("React", React);
    const sheet = sizePricesSheetState({
      pages: [{ data: PAGE, error: null }], draft: typedDraft([[PACK_100, "3.49"], [FLOORED, "2.00"]], "refused", "x"), right: EDITABLE, busy: false,
      savedFlashVisible: false, compact: false, refusal: { outsideLimit: new Set([104]), conflicts: new Set([101]) },
    });
    const markup = render(React.createElement(SizePriceRows, { sheet, compact: false, onEdit: noop }));
    const floored = sliceOf(markup, "size-price-104", "tr");
    expect(floored).toMatch(/^data-testid="size-price-104" data-outside-limit="true"/);
    expect(floored).toContain("Outside a Card Shellz price limit");
    expect(floored).toContain('aria-invalid="true"');
    const conflict = sliceOf(markup, "size-price-101", "tr");
    expect(conflict).toMatch(/^data-testid="size-price-101" data-conflict="true"/);
    expect(conflict).toContain("ring-amber-400");
    expect(sliceOf(markup, "size-price-102", "tr")).not.toMatch(/data-conflict|data-outside-limit|ring-amber/);
  });

  it("takes the boxes and Save away while W8 can't be used, saying why where the banner doesn't", () => {
    const reload = renderSheet(null, PAGE, { right: { editable: false, reason: "reload" } });
    expect(count(reload, 'readOnly=""')).toBe(4);
    expect(reload).toContain('data-testid="size-prices-reason"');
    expect(reload).toMatch(/<button class="[^"]*" type="button" disabled="">Save prices<\/button>/);
    const banner = renderSheet(null, PAGE, { right: { editable: false, reason: "banner" } });
    expect(count(banner, 'readOnly=""')).toBe(4);
    expect(banner).not.toContain('data-testid="size-prices-reason"');
    // Another listing action runs: the boxes wait too.
    expect(count(renderSheet(null, PAGE, { saveCallbacks: { disabled: true, onSaveStarted: noop, onSaveSettled: noop } }), 'readOnly=""')).toBe(4);
  });

  it("a box hands the size and its text to the sheet; a read-only box too (the draft decides)", () => {
    vi.stubGlobal("React", React);
    const onEdit = vi.fn();
    const sheet = sizePricesSheetState({
      pages: [{ data: PAGE, error: null }], draft: null, right: EDITABLE, busy: false, savedFlashVisible: false, compact: false, refusal: noSizePricesRefusal(),
    });
    const inputs = pressable(SizePriceBox({ row: sheet.rows[1], onEdit }));
    expect(inputs).toHaveLength(1);
    expect(inputs[0].props["aria-label"]).toBe("Exact price for Penny Sleeves, Pack of 500");
    inputs[0].props.onChange?.({ target: { value: "7.25" } });
    expect(onEdit).toHaveBeenCalledWith(102, "7.25");
  });

  it("stays shut while the address doesn't open it", () => {
    expect(renderSheet(null, PAGE, { open: false })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The Prices tab's way in (plan 9.3)
// ---------------------------------------------------------------------------

function pricesTab(overrides: Partial<PricesTabProps> = {}, cache = client()): string {
  return render(React.createElement(PricesTab, {
    onSearchInput: noop, onClearSearch: noop, onShow: noop, onPage: noop, onLoadMore: noop, onOpenProduct: noop, onGoToStep1: noop,
    storeConnectionId: STORE, view: { searchInput: "", search: "", show: "cannot_price", page: 0, pagesLoaded: 1 }, compact: false, listsOff: false,
    onGivePrices: noop, ...overrides,
  }), cache);
}

function seedTab(cache: QueryClient, show: PricesTabProps["view"]["show"], answer: ListingSettingsPricesResponse) {
  cache.setQueryData(listingSettingsPricesQueryOptions(STORE, { search: "", show, page: 0 }).queryKey, answer);
}

describe("the Prices tab's entry", () => {
  it("offers Give these sizes a price under Can't be priced while a size is listed, from the sheet's own first page (the tab's with no search)", () => {
    const cache = client();
    seedTab(cache, "cannot_price", PAGE);
    const markup = pricesTab({}, cache);
    expect(markup).toMatch(/<div data-testid="listing-settings-give-prices"><button class="[^"]*min-h-11[^"]*" type="button">Give these sizes a price<\/button><\/div>/);
    // Between the controls and the rows.
    expect(markup.indexOf('data-testid="listing-settings-give-prices"')).toBeLessThan(markup.indexOf('data-testid="listing-settings-prices-table"'));
    expect(markup.indexOf('data-testid="listing-settings-give-prices"')).toBeGreaterThan(markup.indexOf("<select"));
    // The button follows the Show filter, not the tab's search (the sheet lists every size that can't be priced): a
    // search matching nothing keeps it, from the unsearched page.
    const searched = client();
    seedTab(searched, "cannot_price", PAGE);
    searched.setQueryData(listingSettingsPricesQueryOptions(STORE, { search: "zzz", show: "cannot_price", page: 0 }).queryKey, page([]));
    expect(pricesTab({ view: { searchInput: "zzz", search: "zzz", show: "cannot_price", page: 0, pagesLoaded: 1 } }, searched)).toContain('data-testid="listing-settings-give-prices"');
  });

  it("hides the button with nothing to price, under another filter, before the page answers, while the lists are off, and without the step's handler", () => {
    const empty = client();
    seedTab(empty, "cannot_price", page([]));
    expect(pricesTab({}, empty)).not.toContain('data-testid="listing-settings-give-prices"');
    const all = client();
    seedTab(all, "all", PAGE);
    expect(pricesTab({ view: { searchInput: "", search: "", show: "all", page: 0, pagesLoaded: 1 } }, all)).not.toContain('data-testid="listing-settings-give-prices"');
    expect(pricesTab({})).not.toContain('data-testid="listing-settings-give-prices"');
    const off = client();
    seedTab(off, "cannot_price", PAGE);
    expect(pricesTab({ listsOff: true }, off)).not.toContain('data-testid="listing-settings-give-prices"');
    const noHandler = client();
    seedTab(noHandler, "cannot_price", PAGE);
    expect(pricesTab({ onGivePrices: undefined }, noHandler)).not.toContain('data-testid="listing-settings-give-prices"');
  });
});

// ---------------------------------------------------------------------------
// The step: the address, one surface at a time, the strip's Fix (D18, D20, D21, UX-M2)
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
    counts: fits ? { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 4, paused: 0 } : null,
    attention: { items: [], total: 0 }, rail: { state: fits ? "all_set" : "too_many_sizes", productsNeedingFix: 0, missingPolicy: null }, generatedAt: STAMP,
  });
}

function renderStep(address: string, catalogState: "ok" | "too_large" = "ok"): string {
  vi.stubGlobal("React", React);
  const cache = client();
  cache.setQueryData(sizePricesPageQueryOptions(STORE_ID, 0, { data: { catalog: { state: "ok", products: 1, sizes: 1 } }, error: null }, true).queryKey, { ...PAGE, storeConnectionId: STORE_ID });
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
  it("opens the sheet the address names with the page it already holds, after the tabs and never beside the drawer; a sheet wins over a category (D20, D21)", () => {
    const closed = renderStep("/dropship-portal/catalog/setup");
    expect(closed).not.toContain('data-testid="give-sizes-price-sheet"');
    const open = renderStep("/dropship-portal/catalog/setup?sheet=give-prices");
    expect(count(open, 'data-testid="give-sizes-price-sheet"')).toBe(1);
    expect(open).toContain("Give these sizes a price</h2>");
    expect(open).toContain('data-testid="size-price-101"');
    expect(open.indexOf('data-testid="give-sizes-price-sheet"')).toBeGreaterThan(open.indexOf('data-testid="listing-settings-tabs"'));
    expect(open).not.toContain('data-testid="product-drawer"');
    expect(open).not.toContain('data-testid="bulk-settings-sheet"');
    expect(open).not.toContain('data-testid="updated-products-sheet"');
    // The drawer wins when the address opens both.
    const withDrawer = renderStep("/dropship-portal/catalog/setup?sheet=give-prices&product=11");
    expect(withDrawer).toContain('data-testid="product-drawer"');
    expect(withDrawer).not.toContain('data-testid="give-sizes-price-sheet"');
    // A sheet wins over a category's editor (the order the parts arrived in).
    const withCategory = renderStep("/dropship-portal/catalog/setup?sheet=give-prices&category=40");
    expect(withCategory).toContain('data-testid="give-sizes-price-sheet"');
    expect(withCategory).not.toContain('data-testid="category-editor"');
    // Another sheet is another surface.
    expect(renderStep("/dropship-portal/catalog/setup?sheet=updated")).not.toContain('data-testid="give-sizes-price-sheet"');
  });

  it("keeps the sheet shut while the selection is too large: the banner explains (D18)", () => {
    const tooLarge = renderStep("/dropship-portal/catalog/setup?sheet=give-prices", "too_large");
    expect(tooLarge).toContain('data-testid="listing-settings-banner"');
    expect(tooLarge).toContain("more than 10,000 sizes");
    expect(tooLarge).not.toContain('data-testid="give-sizes-price-sheet"');
  });

  it("routes the strip's Fix on a can't-be-priced line with no product to the sheet, and the Prices tab's button too (UX-M2)", () => {
    // Effects and clicks don't run in a static render: the wiring is checked on the source, as the tabs test does.
    const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/listing-settings/ListingSettingsStep.tsx"), "utf8");
    expect(source).toMatch(/case "open_size_prices":\s*openGivePricesSheet\(\);/);
    expect(source).toContain("onGivePrices={openGivePricesSheet}");
    expect(source).toContain('sheetSearch(drawerSearch(categorySearch(query, null), null), "give-prices")');
    expect(source).toContain('open={sheet === "give-prices" && drawerTarget === null && !tooLarge}');
    expect(source).toContain("right={rights.sizePrices}");
  });
});
