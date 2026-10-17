import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSION_PAGE_SIZE,
  listingRulesConversionCheckSchema,
  listingRulesConversionNoticeResponseSchema,
  type ListingRulesConversionCheck,
  type ListingRulesConversionNoticeResponse,
} from "@shared/dropship/listing-rules-conversion";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { listingSettingsConversionQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  OLDER_RULES_SHEET_OPENED,
  olderRulesSheetState,
  type OlderRulesApplyFacts,
  type OlderRulesSheetOutcome,
} from "@/lib/dropship-listing-settings-conversion";
import { conversionNoticeModel, conversionNoticeQueryKey, type ConversionNoticeModel } from "@/lib/dropship-listing-settings-conversion-notice";
import { ConversionNoticeLine, ConversionNoticeLineView } from "../listing-settings/ConversionNoticeLine";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import { OlderRulesSheet, OlderRulesSheetView, SheetFooterBar } from "../listing-settings/OlderRulesSheet";

/*
 * The one-time notice on screen (PR 11e1, plan 9.2, 9.4, 11.3): the line in
 * the strip's slot (role, words, [Got it] named "Got it, hide this note",
 * hidden while the store holds older group rules, shown over 10,000 sizes, a
 * failed press's words), and the sheet's `none` and `nothing_to_convert`
 * states with the notice's words and [Got it]. Static renders: the reads are
 * put in the query cache, and what a button does is checked on the hook-free
 * views.
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
const STAMP = "2026-10-16T09:00:00.000Z";
const CONVERSION = 41;
const RAW_CODE = /\b[a-z]+_[a-z_]+\b|DROPSHIP_/;
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const noop = () => undefined;
const MOVED_WORDS = "We moved your older group rules. 2 categories and 5 products now have their own settings. Nothing in your listings changed. "
  + "Products you choose later use their category's settings or your store defaults.";

beforeEach(() => {
  // The hook-free views are called as functions to press their buttons; their JSX needs React in scope.
  vi.stubGlobal("React", React);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function noticeAnswer(counts: { categoryCount?: number; productCount?: number } | null = {}): ListingRulesConversionNoticeResponse {
  return listingRulesConversionNoticeResponseSchema.parse({ storeConnectionId: STORE,
    notice: counts === null ? null : { conversionId: CONVERSION, convertedAt: STAMP, categoryCount: 2, productCount: 5, ...counts } });
}

function summaryFacts(groupRules = 0, catalogState: "ok" | "too_large" = "ok") {
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
    } as Pick<ListingSettingsSummary, "catalog" | "storeDefaults">,
    error: null,
  };
}

const NO_OLDER_RULES: ListingRulesConversionCheck = listingRulesConversionCheckSchema.parse({
  storeConnectionId: STORE, generatedAt: STAMP, state: "no_older_rules", planHash: null, writesHash: null,
  olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 },
  blocked: { wouldLosePrice: { total: 0, items: [] }, wouldBlockListing: { total: 0, items: [] }, tooMuchText: false },
  becomes: { categories: { total: 0, items: [] }, products: { total: 0, items: [] } },
  report: { unmatched: { total: 0, items: [] }, shared: { total: 0, items: [] }, nameMismatches: { total: 0, items: [] },
    neverApplies: { total: 0, items: [] }, ties: { total: 0, items: [] }, someSizesOnly: { total: 0, items: [] }, mixed: { total: 0, items: [] } },
  kept: { exactPrices: 0, catalogPrices: 0, sizePolicies: 0, sizeShelves: 0, sizeTexts: 0 },
  changes: { page: 0, pageSize: CONVERSION_PAGE_SIZE, total: 0, rows: [] },
});

function client(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
}

function render(node: React.ReactElement, cache = client()): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client: cache }, node))
    .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

type Element = React.ReactElement<{ onClick?: () => void; children?: React.ReactNode; disabled?: boolean; "aria-label"?: string }>;
function pressable(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(pressable);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  const own = typeof element.props.onClick === "function" ? [element] : [];
  return [...own, ...pressable(element.props.children)];
}

function expectPlainWords(markup: string): void {
  const text = markup.replace(/<[^>]+>/g, " ");
  expect(text).not.toMatch(RAW_CODE);
  expect(text).not.toContain(String(CONVERSION));
}

/** The line as the step mounts it, over the notice read and a summary. */
function renderLine(notice: ListingRulesConversionNoticeResponse | undefined, summary = summaryFacts()): string {
  const cache = client();
  if (notice !== undefined) cache.setQueryData([...conversionNoticeQueryKey(STORE)], notice);
  return render(React.createElement(ConversionNoticeLine, { storeConnectionId: STORE, summary }), cache);
}

const model = (failure: string | null = null): ConversionNoticeModel =>
  conversionNoticeModel({ data: noticeAnswer(), error: null }, failure) as ConversionNoticeModel;

describe("the notice line in the strip's slot (11.1, 11.3)", () => {
  it("says what the job moved, as a status, with [Got it] named for what it does, and no id or code", () => {
    const markup = renderLine(noticeAnswer());
    expect(markup).toContain('data-testid="conversion-notice-line"');
    expect(markup).toContain(`<p role="status"`);
    expect(markup).toContain(MOVED_WORDS);
    expect(markup).toMatch(/<button[^>]*aria-label="Got it, hide this note"[^>]*>Got it<\/button>/);
    expect(markup).toMatch(/min-h-11/);
    expect(markup).not.toContain('role="alert"');
    expectPlainWords(markup);
  });

  it("says the rules were removed when they decided nothing (both counts 0)", () => {
    expect(renderLine(noticeAnswer({ categoryCount: 0, productCount: 0 })))
      .toContain("We removed your older group rules. They didn't decide any of your listings.");
  });

  it("shows nothing with no unseen notice, while the read loads, while the store holds older group rules, or while the summary loads", () => {
    expect(renderLine(noticeAnswer(null))).toBe("");
    expect(renderLine(undefined)).toBe("");
    expect(renderLine(noticeAnswer(), summaryFacts(1))).toBe("");
    expect(renderLine(noticeAnswer(), { data: undefined, error: null } as unknown as ReturnType<typeof summaryFacts>)).toBe("");
  });

  it("still shows over 10,000 chosen sizes (the server reads no selection for it)", () => {
    expect(renderLine(noticeAnswer(), summaryFacts(0, "too_large"))).toContain(MOVED_WORDS);
  });

  it("keeps the line after a failed Got it, with why (an alert), and hands its one button the press", () => {
    const markup = render(React.createElement(ConversionNoticeLineView, { line: model("Couldn't save that. Try again."), sending: false, onGotIt: noop }));
    expect(markup).toContain('<p role="alert" class="text-amber-900" data-testid="conversion-notice-failure">Couldn\'t save that. Try again.</p>');
    const onGotIt = vi.fn();
    const buttons = pressable(ConversionNoticeLineView({ line: model(), sending: false, onGotIt }));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props["aria-label"]).toBe("Got it, hide this note");
    buttons[0].props.onClick?.();
    expect(onGotIt).toHaveBeenCalledTimes(1);
    // While a press is out, the button is off: a double click sends one request.
    expect(pressable(ConversionNoticeLineView({ line: model(), sending: true, onGotIt }))[0].props.disabled).toBe(true);
  });
});

describe("the notice in the sheet (9.2, D19, D25)", () => {
  const IDLE: OlderRulesApplyFacts = { draft: null, right: EDITABLE, busy: false, checking: false, notStartedLine: null };
  const sheetState = (page: ListingRulesConversionCheck, outcome: OlderRulesSheetOutcome | null, failure: string | null = null) =>
    olderRulesSheetState({ pages: [{ data: page, error: null }], session: OLDER_RULES_SHEET_OPENED, outcome, apply: IDLE,
      notice: { model: model(failure), sending: false } });
  const view = (state: ReturnType<typeof sheetState>, onGotIt: () => void = noop) => OlderRulesSheetView({ state, compact: false, onClose: noop,
    onRetry: noop, onSetPrice: noop, onFix: noop, onLoadMore: noop, onRetryMore: noop, onMove: noop, onCheckAgain: noop, onReload: noop, onGotIt });

  it("opened on a store the job moved: the notice's words in place of 'no older group rules', [Got it] before Close", () => {
    const markup = render(React.createElement(OlderRulesSheetView, { state: sheetState(NO_OLDER_RULES, null), compact: false, onClose: noop,
      onRetry: noop, onSetPrice: noop, onFix: noop, onLoadMore: noop, onRetryMore: noop, onMove: noop, onCheckAgain: noop, onReload: noop,
      onGotIt: noop }));
    expect(markup).toContain(`data-testid="older-rules-none">${MOVED_WORDS}</p>`);
    expect(markup).not.toContain("Your store has no older group rules any more.");
    const gotItAt = markup.search(/aria-label="Got it, hide this note"[^>]*data-testid="older-rules-got-it"[^>]*>Got it<\/button>/);
    expect(gotItAt).toBeGreaterThan(-1);
    expect(markup.indexOf(">Close</button>")).toBeGreaterThan(gotItAt);
    expect(markup).not.toContain('data-testid="older-rules-move"');
    expectPlainWords(markup);
  });

  it("after nothing_to_convert: the notice's words in the footer instead of 'already moved', with [Got it]; a failed press says why", () => {
    const state = sheetState(NO_OLDER_RULES, { kind: "already_moved", viewStale: false }, "Couldn't save that. Try again.");
    const markup = render(React.createElement(SheetFooterBar, { footer: state.footer, onClose: noop, onMove: noop, onCheckAgain: noop,
      onReload: noop, onGotIt: noop }));
    expect(markup).toContain(`<p role="status" class="text-sm text-emerald-800" data-testid="older-rules-footer-line">${MOVED_WORDS}</p>`);
    expect(markup).toContain('<p role="alert" class="text-sm text-amber-900" data-testid="older-rules-footer-line">Couldn\'t save that. Try again.</p>');
    expect(markup).not.toContain("Your rules have already been moved over.");
    expect(markup).toContain(">Got it</button>");
  });

  it("hands [Got it] to the sheet once, through the view's footer", () => {
    const onGotIt = vi.fn();
    const footer = (view(sheetState(NO_OLDER_RULES, null), onGotIt).props as { children: React.ReactNode[] }).children
      .find((child) => React.isValidElement(child) && child.type === SheetFooterBar) as React.ReactElement<Parameters<typeof SheetFooterBar>[0]>;
    const buttons = pressable(SheetFooterBar(footer.props)).filter((element) => element.props.children === "Got it");
    expect(buttons).toHaveLength(1);
    buttons[0].props.onClick?.();
    expect(onGotIt).toHaveBeenCalledTimes(1);
  });

  it("reads the notice from the step's mount read (the same key): the open sheet on a moved store shows it with no read of its own", () => {
    const cache = client();
    cache.setQueryData([...listingSettingsConversionQueryOptions(STORE, 0).queryKey], NO_OLDER_RULES);
    cache.setQueryData([...conversionNoticeQueryKey(STORE)], noticeAnswer());
    const markup = render(React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE,
      children: React.createElement(OlderRulesSheet, { storeConnectionId: STORE, open: true, summary: summaryFacts(), right: EDITABLE,
        saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop, onClose: noop, onSetPrice: noop, onFix: noop }) }), cache);
    expect(markup).toContain(MOVED_WORDS);
    expect(markup).toContain('data-testid="older-rules-got-it"');
    // With no notice in the cache, the plain words and no [Got it].
    const plain = client();
    plain.setQueryData([...listingSettingsConversionQueryOptions(STORE, 0).queryKey], NO_OLDER_RULES);
    plain.setQueryData([...conversionNoticeQueryKey(STORE)], noticeAnswer(null));
    const none = render(React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE,
      children: React.createElement(OlderRulesSheet, { storeConnectionId: STORE, open: true, summary: summaryFacts(), right: EDITABLE,
        saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop, onClose: noop, onSetPrice: noop, onFix: noop }) }), plain);
    expect(none).toContain("Your store has no older group rules any more.");
    expect(none).not.toContain('data-testid="older-rules-got-it"');
  });
});
