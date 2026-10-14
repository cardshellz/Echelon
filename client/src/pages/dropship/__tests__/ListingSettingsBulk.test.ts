import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listingSettingsProductIdsResponseSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
  type ListingSettingsProductIdsResponse,
  type ListingSettingsProductRow,
  type ListingSettingsSummary,
} from "@shared/dropship/listing-settings";
import { listingSettingsProductIdsQueryOptions, listingSettingsProductsQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  bulkDescriptionFieldEditor,
  bulkDraftValue,
  bulkEbayCategoryFieldEditor,
  bulkPolicyFieldEditor,
  bulkStoreShelfFieldEditor,
  emptyBulkChoices,
  type BulkChoices,
  type BulkSettingsRights,
} from "@/lib/dropship-listing-settings-bulk";
import { BULK_EDITOR_ID, reduceListingSettingsDraft, type ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import {
  emptySelection,
  idsRequestFor,
  reduceListingSettingsSelection,
  type ListingSettingsSelection,
  type ListingSettingsSelectionAction,
  type PickedProduct,
} from "@/lib/dropship-listing-settings-selection";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { bulkConflictWords, LISTING_SETTINGS_BULK_WORDS } from "@/lib/dropship-listing-settings-words";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { BulkSettingsSheet, type BulkSettingsSheetProps } from "../listing-settings/BulkSettingsSheet";
import { DrawerDescriptionEditor } from "../listing-settings/DrawerDescriptionEditor";
import { DrawerEbayCategoryEditor, DrawerFieldEditor, DrawerShelfEditor } from "../listing-settings/DrawerFieldEditor";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { ProductCards, ProductsTab, ProductsTable, type ProductsTabProps } from "../listing-settings/ProductsTab";

/**
 * "Set for selected" (Listing settings PR 10, plan 6.3, 6.6): the Products tab's checkboxes and
 * selection bar, and the sheet that sets one change for the ticked products (W6), with its rows,
 * footer and its row editors in "bulk" mode. Static renders, as the other step tests: the step's one
 * draft is set per test, and what a click does is checked on the element tree the table draws, with
 * a click bubbling from the checkbox up the way a browser's would.
 */

const state = vi.hoisted(() => ({ drafts: null as unknown }));

vi.mock("../listing-settings/ListingSettingsDraftsProvider", () => ({
  useListingSettingsDrafts: () => state.drafts,
}));

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
const RIGHTS: BulkSettingsRights = { bulkSettings: EDITABLE, shipping: EDITABLE, policies: EDITABLE, ebayCategory: EDITABLE, shelfPick: EDITABLE };
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.drafts = null;
});

// ---------------------------------------------------------------------------
// Fixtures, each checked against the shared contract
// ---------------------------------------------------------------------------

const SUMMARY: ListingSettingsSummary = listingSettingsSummarySchema.parse({
  storeConnectionId: STORE, storeStatus: "connected", access: { allowed: true }, catalog: { state: "ok", products: 312, sizes: 400 },
  storeDefaults: {
    price: { recipe: null, groupRules: 0 },
    shippingPolicy: { policyId: null, verification: "not_checked" },
    returnPolicy: { policyId: null, verification: "not_checked" },
    paymentPolicy: { policyId: null, verification: "not_checked" },
    ebayCategory: { category: null, groupRules: 0 },
    description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
  },
  counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
  attention: { items: [], total: 0 },
  rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: null },
  generatedAt: GENERATED_AT,
});

function productRow(productId: number, productName: string): ListingSettingsProductRow {
  return {
    productId, productName, category: "Sleeves", sizesChosen: 1, sizesTotal: 1, priceRange: { minCents: 299, maxCents: 299 },
    exactPriceCount: 0, ownSettings: [], sizesDiffer: [], fixes: [], matchedSize: null,
  };
}

const ROWS = [productRow(11, "Penny Sleeves"), productRow(12, "Team Bags"), productRow(13, "Toploaders")];

const SETUP_ANSWER: PolicySetupFacts = {
  selection: { merchantLocationKey: "cs", fulfillmentPolicyId: "F1", returnPolicyId: null, paymentPolicyId: "P1" },
  storedNames: { fulfillmentPolicyName: null, returnPolicyName: null, paymentPolicyName: null },
  options: {
    merchantLocations: [],
    fulfillmentPolicies: [
      { id: "F1", name: "Standard", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
      { id: "F2", name: "Priority", compatible: true, compatibilityChecked: true, compatibilityIssues: [] },
    ],
    returnPolicies: [{ id: "R1", name: "30 days" }],
    paymentPolicies: [{ id: "P1", name: "eBay payments" }],
  },
  checks: { ebay: "checked", fulfillment: { status: "checked" } },
  fulfillmentCapability: null,
};
const SETUP: ListingSettingsReadState<PolicySetupFacts> = { data: SETUP_ANSWER, error: null };

function ids(rows: Array<[number, number | null]>): ListingSettingsProductIdsResponse {
  return listingSettingsProductIdsResponseSchema.parse({ total: rows.length, rows: rows.map(([productId, revisionId]) => ({ productId, revisionId })) });
}

function select(...actions: ListingSettingsSelectionAction[]): ListingSettingsSelection {
  return actions.reduce(reduceListingSettingsSelection, emptySelection(STORE));
}

const tick = (...productIds: number[]) => select(...productIds.map((productId) => ({ type: "toggle" as const, productId })));

const PICKED: readonly PickedProduct[] = [
  { productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }, { productId: 13, expectedRevisionId: 9 },
];

/** The sheet's draft, opened on `products` with every row "Leave as is", then the given choices. */
function bulkDraft(choices: Partial<BulkChoices> = {}, products: readonly PickedProduct[] = PICKED): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: BULK_EDITOR_ID, place: "Set for selected", base: bulkDraftValue(products) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: bulkDraftValue(products, { ...emptyBulkChoices(), ...choices }) })!;
}

/** The same draft after a save that was refused or not confirmed (`phase`, with its words). */
function settledDraft(draft: ListingSettingsDraft, phase: "conflict" | "uncertain", message: string): ListingSettingsDraft {
  const saving = reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "ls-bulk:k1" } });
  return reduceListingSettingsDraft(saving, {
    type: "failure", key: "ls-bulk:k1", failure: { phase, message, code: null, status: phase === "conflict" ? 409 : null },
  })!;
}

function draftsValue(draft: ListingSettingsDraft | null): ListingSettingsDraftsValue {
  const value: ListingSettingsDraftsValue = {
    draft, savedFlashVisible: false, now: () => 0,
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

function render(node: React.ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } })): string {
  vi.stubGlobal("React", React);
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, node))
      .replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  } finally {
    client.clear();
  }
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** A checkbox read out as `label`, ticked or not (React writes `checked` after the class). */
function box(label: string, checked: boolean): RegExp {
  const name = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<input type="checkbox" aria-label="${name}" class="[^"]*"${checked ? ' checked=""' : ""}/>`);
}

// ---------------------------------------------------------------------------
// The Products tab: checkboxes and the selection bar
// ---------------------------------------------------------------------------

function productsTab(overrides: Partial<ProductsTabProps> = {}, client?: QueryClient): string {
  const cache = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (!client) {
    cache.setQueryData(listingSettingsProductsQueryOptions(STORE, { search: "", show: "all", page: 0 }).queryKey,
      listingSettingsProductsResponseSchema.parse({ storeConnectionId: STORE, page: 0, pageSize: 50, total: 312, rows: ROWS, generatedAt: GENERATED_AT }));
  }
  return render(React.createElement(ProductsTab, {
    storeConnectionId: STORE, summary: SUMMARY, view: { searchInput: "", search: "", show: "all", page: 0, pagesLoaded: 1 },
    compact: false, listsOff: false, onSearchInput: noop, onClearSearch: noop, onShow: noop, onPage: noop, onLoadMore: noop,
    onOpenProduct: noop, onGoToStep1: noop, selection: emptySelection(STORE), onSelect: noop, onSetForSelected: noop,
    bulkRight: EDITABLE, saved: null, heldSave: false, ...overrides,
  }), cache);
}

describe("the selection bar (plan 6.3)", () => {
  it("counts the ticks with Set for selected and Clear, and ticks each product's box", () => {
    const markup = productsTab({ selection: tick(11, 13) });
    const bar = markup.slice(markup.indexOf('data-testid="listing-settings-selection-bar"')).split("</div></div>")[0];
    expect(bar).toContain(">2 selected</span>");
    expect(bar).toMatch(/<button[^>]*>Set for selected<\/button>/);
    expect(bar).not.toMatch(/<button[^>]*disabled=""[^>]*>Set for selected<\/button>/);
    expect(bar).toMatch(/<button[^>]*>Clear<\/button>/);
    expect(markup).toMatch(box("Select Penny Sleeves", true));
    expect(markup).toMatch(box("Select Team Bags", false));
    expect(markup).toMatch(box("Select Toploaders", true));
    // Some of the page is ticked: the header's box is not checked (it is "mixed" in a browser).
    expect(markup).toMatch(box("Select every product on this page", false));
    // Two of three: nothing more to offer yet.
    expect(markup).not.toContain("Select all 312");
    // A screen reader hears the count from a status region that is always in the page (3.4).
    expect(markup).toContain('<p role="status" class="sr-only" data-testid="listing-settings-selection-live">2 selected.</p>');
    expect(productsTab()).toContain('<p role="status" class="sr-only" data-testid="listing-settings-selection-live"></p>');
  });

  it("after the whole page, offers Select all N for the list's search and filter, on a wide screen and a phone", () => {
    const wide = productsTab({ selection: tick(11, 12, 13) });
    expect(wide).toContain(">3 selected</span>");
    expect(wide).toMatch(box("Select every product on this page", true));
    expect(wide).toContain("<span>All 3 on this page are selected.</span>");
    expect(wide).toMatch(/<button[^>]*>Select all 312<\/button>/);
    expect(wide).toContain(">3 selected. All 3 on this page are selected. Select all 312 is available.</p>");
    stubWidth(false);
    const phone = productsTab({ selection: tick(11, 12, 13), compact: true });
    expect(phone).toContain("<span>All 3 shown are selected.</span>");
    expect(phone).toMatch(/<label[^>]*data-testid="listing-settings-select-shown"><input type="checkbox" class="[^"]*" checked=""\/>Select all shown<\/label>/);
    // Sticky on a phone just below the step rail (which publishes its height), so it stays in reach while the cards scroll.
    expect(phone).toMatch(/data-testid="listing-settings-selection-bar" class="[^"]*sticky z-10[^"]*" style="top:var\(--catalog-step-rail-height, 0px\)"/);
    expect(wide).not.toMatch(/data-testid="listing-settings-selection-bar" class="[^"]*sticky/);
  });

  it("says Select all N's count, and no more offer, once it is on", () => {
    const all = select({ type: "selectAllMatching", filter: { search: "", show: "all" }, total: 312 }, { type: "toggle", productId: 12 });
    const markup = productsTab({ selection: all });
    expect(markup).toContain(">311 selected</span>");
    expect(markup).not.toContain("Select all 312");
    expect(markup).toMatch(box("Select Team Bags", false));
    expect(markup).toMatch(box("Select Penny Sleeves", true));
  });

  it("turns Set for selected off with the reason while W6 can't be used, and says a save's count with the ticks kept", () => {
    const off = productsTab({ selection: tick(11), bulkRight: { editable: false, reason: "loading" } });
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Set for selected<\/button>/);
    // The reason line is the off button's description (3.4).
    const reasonId = /<button[^>]*aria-describedby="([^"]+)"[^>]*>Set for selected<\/button>/.exec(off)?.[1];
    expect(reasonId).toBeTruthy();
    expect(off).toContain(`<span id="${reasonId}" class="text-xs text-zinc-600">Checking…</span>`);
    expect(productsTab({ selection: tick(11) })).not.toContain("aria-describedby");
    const ticks = tick(11, 12);
    const saved = productsTab({ selection: ticks, saved: { productCount: 2, selection: ticks } });
    expect(saved).toContain('<p class="text-sm text-emerald-800" data-testid="listing-settings-selection-saved">Saved for 2 products. Still selected.</p>');
    expect(saved).toContain(">2 selected</span>");
    expect(saved).toContain(">2 selected. Saved for 2 products. Still selected.</p>");
    // With nothing ticked and no status, there is no bar.
    expect(productsTab()).not.toContain('data-testid="listing-settings-selection-bar"');
  });

  it("keeps Set for selected on with nothing ticked while a save is out or unconfirmed (D21)", () => {
    const held = productsTab({ heldSave: true });
    expect(held).toContain('data-testid="listing-settings-selection-bar"');
    expect(held).toContain(">0 selected</span>");
    expect(held).not.toMatch(/<button[^>]*disabled=""[^>]*>Set for selected<\/button>/);
  });

  it("shows no bar or box while the lists are off (more than 10,000 sizes)", () => {
    const markup = productsTab({ selection: tick(11), listsOff: true });
    expect(markup).not.toContain('data-testid="listing-settings-selection-bar"');
    expect(markup).not.toContain('type="checkbox"');
  });
});

// ---------------------------------------------------------------------------
// Ticking never opens the drawer (plan 6.3, CI-M3)
// ---------------------------------------------------------------------------

type Node = React.ReactElement<Record<string, unknown>>;

/** The element tree a hook-free component draws, its own function components expanded. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!React.isValidElement(node)) return node;
  const element = node as Node;
  if (typeof element.type === "function") return expand((element.type as (props: unknown) => unknown)(element.props));
  const children = element.props.children;
  return { ...element, props: { ...element.props, children: children === undefined ? undefined : expand(children) } };
}

/** Every path from the root to an element `match` takes, outermost first. */
function pathsTo(node: unknown, match: (element: Node) => boolean, path: Node[] = []): Node[][] {
  if (Array.isArray(node)) return node.flatMap((child) => pathsTo(child, match, path));
  if (!React.isValidElement(node)) return [];
  const element = node as Node;
  const here = [...path, element];
  return [...(match(element) ? [here] : []), ...pathsTo(element.props.children, match, here)];
}

/** A click on the path's last element, bubbling outward through each onClick until one stops it; the handlers reached. */
function clickBubbling(path: readonly Node[]): number {
  let stopped = false;
  let reached = 0;
  for (const element of [...path].reverse()) {
    const onClick = element.props.onClick as ((event: { stopPropagation: () => void }) => void) | undefined;
    if (onClick) {
      reached += 1;
      onClick({ stopPropagation: () => { stopped = true; } });
    }
    if (stopped) break;
  }
  return reached;
}

const isCheckbox = (name: string) => (element: Node) => element.type === "input" && element.props.type === "checkbox" && element.props["aria-label"] === `Select ${name}`;

describe("ticking a product never opens the drawer (plan 6.3)", () => {
  // The components are called as functions here; their JSX needs React in scope, as a render gives it.
  beforeEach(() => {
    vi.stubGlobal("React", React);
  });

  it("on a wide screen the checkbox's cell keeps the click, while the rest of the row opens the drawer", () => {
    const onOpenProduct = vi.fn();
    const onSelect = vi.fn();
    const tree = expand(React.createElement(ProductsTable, { rows: ROWS, onOpenProduct, ticks: { selection: tick(11), onSelect } }));
    const [toBox] = pathsTo(tree, isCheckbox("Team Bags"));
    expect(toBox.map((element) => element.type)).toEqual(["div", "table", "tbody", "tr", "td", "label", "input"]);
    // The click reaches the cell's handler and stops there; the row's never runs.
    expect(clickBubbling(toBox)).toBe(1);
    expect(onOpenProduct).not.toHaveBeenCalled();
    (toBox.at(-1)!.props.onChange as () => void)();
    expect(onSelect).toHaveBeenCalledWith({ type: "toggle", productId: 12 });
    // A click anywhere else on the row (its Sizes cell, say) still opens the drawer.
    const [toSizes] = pathsTo(tree, (element) => element.type === "td" && typeof element.props.className === "string"
      && element.props.className === "px-3 py-2 text-zinc-700" && element.props.children === "1");
    expect(clickBubbling(toSizes)).toBe(1);
    expect(onOpenProduct).toHaveBeenCalledWith({ productId: 11 });
  });

  it("turns every box off while the rows are an older list's, kept on screen as a new search loads", () => {
    const markup = render(React.createElement(ProductsTable, { rows: ROWS, onOpenProduct: noop, ticks: { selection: tick(11), onSelect: noop }, ticksOff: true }));
    expect(count(markup, 'type="checkbox"')).toBe(4);
    expect(count(markup, 'disabled=""')).toBe(4);
    const cards = render(React.createElement(ProductCards, { rows: ROWS, onOpenProduct: noop, ticks: { selection: tick(11), onSelect: noop }, ticksOff: true }));
    expect(count(cards, 'disabled=""')).toBe(3);
    expect(count(render(React.createElement(ProductsTable, { rows: ROWS, onOpenProduct: noop, ticks: { selection: tick(11), onSelect: noop } })), 'disabled=""')).toBe(0);
  });

  it("the header's box ticks the page", () => {
    const onSelect = vi.fn();
    const tree = expand(React.createElement(ProductsTable, { rows: ROWS, onOpenProduct: noop, ticks: { selection: tick(11), onSelect } }));
    const [toHeader] = pathsTo(tree, (element) => element.type === "input" && element.props["aria-label"] === "Select every product on this page");
    expect(toHeader.map((element) => element.type)).toEqual(["div", "table", "thead", "tr", "th", "input"]);
    expect(toHeader.at(-1)!.props.checked).toBe(false);
    (toHeader.at(-1)!.props.onChange as () => void)();
    expect(onSelect).toHaveBeenCalledWith({ type: "togglePage", productIds: [11, 12, 13] });
  });

  it("on a phone the checkbox sits beside the card's button, never inside it", () => {
    const onOpenProduct = vi.fn();
    const onSelect = vi.fn();
    const tree = expand(React.createElement(ProductCards, { rows: ROWS, onOpenProduct, ticks: { selection: emptySelection(STORE), onSelect } }));
    const [toBox] = pathsTo(tree, isCheckbox("Penny Sleeves"));
    expect(toBox.map((element) => element.type)).toEqual(["ul", "li", "label", "input"]);
    expect(clickBubbling(toBox)).toBe(0);
    (toBox.at(-1)!.props.onChange as () => void)();
    expect(onSelect).toHaveBeenCalledWith({ type: "toggle", productId: 11 });
    expect(onOpenProduct).not.toHaveBeenCalled();
    // The card's button holds no checkbox, and its name still starts with the product (the drawer spec's openProductRow).
    const [toButton] = pathsTo(tree, (element) => element.type === "button");
    expect(pathsTo(toButton.at(-1), (element) => element.type === "input")).toEqual([]);
    expect(render(React.createElement(ProductCards, { rows: ROWS, onOpenProduct, ticks: { selection: emptySelection(STORE), onSelect } })))
      .toMatch(/<button type="button" class="[^"]*"><span class="min-w-0"><span class="block break-words font-medium text-zinc-900">Penny Sleeves<\/span>/);
    clickBubbling(toButton);
    expect(onOpenProduct).toHaveBeenCalledWith({ productId: 11 });
  });
});

// ---------------------------------------------------------------------------
// The sheet: title, lines, rows and footer
// ---------------------------------------------------------------------------

function sheetProps(selection: ListingSettingsSelection, overrides: Partial<BulkSettingsSheetProps> = {}): BulkSettingsSheetProps {
  return {
    storeConnectionId: STORE, open: true, selection, rights: RIGHTS, setup: SETUP, shelves: [],
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop, onClose: noop, onSavedFor: noop, ...overrides,
  };
}

/** The open sheet with its ids read answered (`answer`), failed (`{ error }`) or still loading (undefined). */
function renderSheet(selection: ListingSettingsSelection, draft: ListingSettingsDraft | null,
  answer?: ListingSettingsProductIdsResponse | { error: unknown }, overrides: Partial<BulkSettingsSheetProps> = {}): string {
  draftsValue(draft);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const options = listingSettingsProductIdsQueryOptions(STORE, idsRequestFor(selection) ?? {});
  if (answer !== undefined && "error" in answer) {
    client.getQueryCache().build(client, options)
      .setState({ status: "error", error: answer.error as Error, fetchStatus: "idle", errorUpdatedAt: 1, errorUpdateCount: 1 });
  } else if (answer !== undefined) {
    client.setQueryData(options.queryKey, answer);
  }
  return render(React.createElement(BulkSettingsSheet, sheetProps(selection, overrides)), client);
}

const ROW_KEYS = ["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "descriptionTemplate"] as const;
const ROW_SETTINGS = ["shipping policy", "return policy", "payment policy", "eBay category", "store shelf", "description"];

function rowOf(markup: string, key: string): string {
  const start = markup.indexOf(`data-testid="drawer-setting-${key}"`);
  const rest = markup.slice(start + 1);
  const next = /data-testid="drawer-setting-[A-Za-z]+"/.exec(rest);
  return markup.slice(start, next === null ? markup.indexOf('data-testid="bulk-settings-footer"') : start + 1 + next.index);
}

function footerOf(markup: string): string {
  return markup.slice(markup.indexOf('data-testid="bulk-settings-footer"'));
}

describe("BulkSettingsSheet (plan 6.3)", () => {
  it("titles itself from the ids read, says what it does, and gives one row per setting reading Leave as is with Change", () => {
    const markup = renderSheet(tick(11, 12, 13), bulkDraft(), ids([[11, 5], [12, null], [13, 9]]));
    expect(markup).toContain('data-testid="bulk-settings-sheet"');
    expect(markup).toContain("<h2>Set for 3 products</h2>");
    expect(markup).toContain("<p>These become each product's own values.</p>");
    expect(markup).not.toContain('data-testid="bulk-settings-line"');
    ROW_KEYS.forEach((key, index) => {
      const row = rowOf(markup, key);
      expect(row, key).toContain(">Leave as is</span>");
      expect(row, key).toMatch(new RegExp(`<button[^>]*aria-label="Change ${ROW_SETTINGS[index]} for the selected products"[^>]*aria-expanded="false"[^>]*>Change</button>`));
      expect(row, key).not.toMatch(/<button[^>]*disabled=""[^>]*>Change<\/button>/);
    });
    // Exactly the six rows: never a price row, an id or a size's own words.
    expect(markup.match(/data-testid="drawer-setting-[A-Za-z]+"/g)).toEqual(ROW_KEYS.map((key) => `data-testid="drawer-setting-${key}"`));
    expect(markup).not.toMatch(/drawer-setting-price|>Price<|\b(?:F1|F2|R1|P1)\b|ls-bulk|Sizes differ/);
    // Nothing chosen yet: Save waits for a change.
    expect(footerOf(markup)).toMatch(/<button[^>]*disabled=""[^>]*>Save for 3 products<\/button>/);
    expect(footerOf(markup)).not.toContain("Not saved");
  });

  it("says what moved since the ticks: a match count that changed, and products no longer chosen", () => {
    const all = select({ type: "selectAllMatching", filter: { search: "sleeve", show: "all" }, total: 3 });
    const moved = renderSheet(all, bulkDraft({}, [{ productId: 11, expectedRevisionId: 5 }]), ids([[11, 5], [12, null], [13, 9], [14, 2]]));
    expect(moved).toContain(">4 now match (was 3).</p>");
    const leftOut = renderSheet(tick(11, 12, 13), bulkDraft({}, PICKED.slice(0, 2)), ids([[11, 5], [12, null]]));
    expect(leftOut).toContain("<h2>Set for 2 products</h2>");
    expect(leftOut).toContain(">1 product is no longer chosen and is left out.</p>");
    expect(footerOf(leftOut)).toContain(">Save for 2 products</button>");
    const none = renderSheet(tick(11, 12), null, ids([[30, 1]]));
    expect(none).toContain(">2 products are no longer chosen and are left out.</p>");
    expect(none).toContain(`<p role="alert" class="text-sm font-medium text-amber-900">${LISTING_SETTINGS_BULK_WORDS.noneChosen}</p>`);
  });

  it("says it is checking the products while the ids read answers, and a failed read with Try again", () => {
    const loading = renderSheet(tick(11, 12, 13), null);
    expect(loading).toContain('<p role="status" class="text-sm text-zinc-600">Checking 3 products…</p>');
    expect(loading).toContain("<h2>Set for 3 products</h2>");
    // No draft yet: every Change waits.
    expect(loading.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(6);
    const failed = renderSheet(tick(11, 12, 13), null, { error: new DropshipApiError({ status: 500, code: "X", message: "x" }) });
    expect(failed).toContain("Couldn't check the selected products. Try again.");
    expect(failed).toMatch(/data-testid="bulk-settings-read-problem"><span>[^<]+<\/span><button[^>]*>Try again<\/button>/);
    const limited = renderSheet(tick(11), null, { error: new DropshipApiError({ status: 429, code: "X", message: "x" }) });
    expect(limited).toContain("Too many checks in a minute. Wait a moment and try again.");
  });

  it("shows each change below its row by name, and the footer counts them with Save for N products", () => {
    const draft = bulkDraft({
      shippingPolicy: { mode: "set", value: { id: "F2" } },
      storeShelf: { mode: "default" },
      textAbove: { mode: "set", value: { mode: "own", text: "Ships fast." } },
      mainText: { mode: "default" },
    });
    const markup = renderSheet(tick(11, 12, 13), draft, ids([[11, 5], [12, null], [13, 9]]));
    expect(rowOf(markup, "shippingPolicy")).toContain(">→ Priority · Not saved</p>");
    expect(rowOf(markup, "storeShelf")).toContain(">→ Use default · Not saved</p>");
    expect(rowOf(markup, "descriptionTemplate")).toContain(">→ Text above: your own, main text: Card Shellz text · Not saved</p>");
    expect(rowOf(markup, "returnPolicy")).not.toContain("Not saved");
    const footer = footerOf(markup);
    expect(footer).toContain(">● Not saved · 4 changes</span>");
    expect(footer).toMatch(/<button[^>]*>Discard<\/button>/);
    expect(footer).toMatch(/<button[^>]*>Save for 3 products<\/button>/);
    expect(footer).not.toMatch(/disabled=""[^>]*>Save for 3 products/);
    stubWidth(false);
    const phone = footerOf(renderSheet(tick(11, 12, 13), draft, ids([[11, 5], [12, null], [13, 9]])));
    expect(phone).toContain(">● Not saved · 4</span>");
    expect(phone).toMatch(/<button[^>]*>Save<\/button>/);
  });

  it("turns Save off with words when the text is more than the server takes for this many products (6.5)", () => {
    const products = Array.from({ length: 3_751 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null }));
    const all = select({ type: "selectAllMatching", filter: { search: "", show: "all" }, total: 3_751 });
    const own = (text: string) => ({ mode: "set" as const, value: { mode: "own" as const, text } });
    const draft = bulkDraft({ textAbove: own("a".repeat(4_000)), textBelow: own("b".repeat(4_000)) }, products);
    const markup = renderSheet(all, draft, ids(products.map((product) => [product.productId, null])));
    const footer = footerOf(markup);
    expect(footer).toMatch(/<button[^>]*disabled=""[^>]*>Save for 3,751 products<\/button>/);
    expect(footer).toContain(`<span role="alert" class="text-sm text-amber-900">${LISTING_SETTINGS_BULK_WORDS.tooMuchText}</span>`);
  });

  it("after a conflict, says how many products changed with Load latest; after a lost answer, Check again with the rows locked", () => {
    const conflict = settledDraft(bulkDraft({ shippingPolicy: { mode: "default" } }), "conflict", bulkConflictWords(1));
    const markup = renderSheet(tick(11, 12, 13), conflict, ids([[11, 6], [12, null], [13, 9]]));
    expect(footerOf(markup)).toContain("1 of the selected products changed in another window.");
    expect(footerOf(markup)).toMatch(/<button[^>]*>Load latest and keep my changes<\/button>/);
    const uncertain = settledDraft(bulkDraft({ shippingPolicy: { mode: "default" } }), "uncertain", "We couldn't confirm your save.");
    const locked = renderSheet(tick(11, 12, 13), uncertain, ids([[11, 5], [12, null], [13, 9]]));
    expect(footerOf(locked)).toMatch(/<button[^>]*>Check again<\/button>/);
    expect(footerOf(locked)).toMatch(/<button[^>]*disabled=""[^>]*>Discard<\/button>/);
    expect(locked.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(6);
  });

  it("reopened on an unconfirmed save, names that save's products and needs no ids read, whatever is ticked (D21)", () => {
    const uncertain = settledDraft(bulkDraft({ shippingPolicy: { mode: "default" } }, PICKED.slice(0, 2)), "uncertain", "We couldn't confirm your save.");
    // Nothing ticked (Clear, or the step was left): no read, no loading line.
    const markup = renderSheet(emptySelection(STORE), uncertain);
    expect(markup).toContain("<h2>Set for 2 products</h2>");
    expect(markup).toContain(">This save is for the 2 products it was sent for.</p>");
    expect(markup).not.toContain("Checking");
    expect(footerOf(markup)).toMatch(/<button[^>]*>Check again<\/button>/);
    // Another product ticked now: still the save's own products.
    const other = renderSheet(tick(13), uncertain, ids([[13, 9]]));
    expect(other).toContain("<h2>Set for 2 products</h2>");
    expect(other).toContain(">This save is for the 2 products it was sent for.</p>");
    expect(other).not.toContain("no longer chosen");
  });

  it("takes every Change away while W6 can't be used, and leaves only Use default (and None) under a sign-in (D3, D4)", () => {
    const off: BulkSettingsRights = { ...RIGHTS, bulkSettings: { editable: false, reason: "banner" } };
    const markup = renderSheet(tick(11), bulkDraft({}, PICKED.slice(0, 1)), ids([[11, 5]]), { rights: off });
    expect(markup).not.toContain(">Change</button>");
    expect(footerOf(markup)).toMatch(/<button[^>]*disabled=""[^>]*>Save for 1 product<\/button>/);
    const signIn: BulkSettingsRights = { ...RIGHTS, shipping: { editable: false, reason: "sign_in" }, policies: { editable: false, reason: "sign_in" } };
    const line = renderSheet(tick(11), bulkDraft({}, PICKED.slice(0, 1)), ids([[11, 5]]), { rights: signIn });
    expect(rowOf(line, "shippingPolicy")).toContain("Sign in to eBay again to pick a new one. You can still use the default.");
    expect(rowOf(line, "shippingPolicy")).toContain(">Change</button>");
  });

  it("renders nothing while the address doesn't open it", () => {
    expect(renderSheet(tick(11), null, undefined, { open: false })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The rows' editors in "bulk" mode (plan 6.3, UX-m5)
// ---------------------------------------------------------------------------

const EDITOR_BASE = { title: "Shipping policy", productName: LISTING_SETTINGS_BULK_WORDS.selectedProducts, message: null, onCancel: noop };
const ALL_RIGHTS = { canSet: true, canDefault: true, canNone: true };

/** The radio's whole label that holds `words`: its input, and whether that input is checked. */
function labelWith(markup: string, words: string): string {
  const at = markup.indexOf(`>${words}</span>`);
  expect(at, words).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<label", at), markup.indexOf("</label>", at));
}

describe("the rows' editors in bulk mode", () => {
  it("a policy's offers Leave as is first, then eBay's policies and Use default, opening on Leave as is with Done on", () => {
    const model = bulkPolicyFieldEditor({ field: "shippingPolicy", rights: ALL_RIGHTS, draftChoice: { mode: "leave" }, setup: SETUP });
    const markup = render(React.createElement(DrawerFieldEditor, { ...EDITOR_BASE, bulk: true, model, onDone: noop }));
    expect(markup).toContain('aria-label="Shipping policy for the selected products"');
    const order = ["Leave as is", "Standard", "Priority", "Use default"].map((words) => markup.indexOf(`>${words}</span>`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(labelWith(markup, "Leave as is")).toContain('checked=""');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
    // The drawer's own editor has no Leave as is.
    expect(render(React.createElement(DrawerFieldEditor, { ...EDITOR_BASE, model, onDone: noop }))).not.toContain("Leave as is");
    // Opening on the draft's choice.
    const set = bulkPolicyFieldEditor({ field: "shippingPolicy", rights: ALL_RIGHTS, draftChoice: { mode: "set", value: { id: "F2" } }, setup: SETUP });
    expect(labelWith(render(React.createElement(DrawerFieldEditor, { ...EDITOR_BASE, bulk: true, model: set, onDone: noop })), "Priority")).toContain('checked=""');
  });

  it("the eBay category's and the shelf's offer Leave as is beside Use default (and None)", () => {
    const category = render(React.createElement(DrawerEbayCategoryEditor, {
      ...EDITOR_BASE, title: "eBay category", bulk: true, storeConnectionId: STORE,
      model: bulkEbayCategoryFieldEditor({ rights: ALL_RIGHTS, draftChoice: { mode: "leave" } }), onDone: noop,
    }));
    expect(labelWith(category, "Leave as is")).toContain('checked=""');
    expect(category).toContain(">Use default</span>");
    expect(category).toMatch(/<button[^>]*>Pick an eBay category<\/button>/);
    const shelf = render(React.createElement(DrawerShelfEditor, {
      ...EDITOR_BASE, title: "Store shelf", bulk: true,
      model: bulkStoreShelfFieldEditor({ rights: ALL_RIGHTS, draftChoice: { mode: "leave" }, shelves: [] }), onDone: noop,
    }));
    expect(labelWith(shelf, "Leave as is")).toContain('checked=""');
    expect(shelf).toContain(">None</span>");
    expect(shelf).toContain(">Use default</span>");
    expect(shelf).not.toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
  });

  it("the description's offers Leave as is in each part, and the main text only as the Card Shellz text", () => {
    const model = bulkDescriptionFieldEditor({ rights: ALL_RIGHTS, draftChoices: { textAbove: { mode: "leave" }, textBelow: { mode: "leave" }, mainText: { mode: "leave" } } });
    const markup = render(React.createElement(DrawerDescriptionEditor, { ...EDITOR_BASE, title: "Description", bulk: true, model, onDone: noop }));
    expect(count(markup, ">Leave as is</span>")).toBe(3);
    const main = markup.slice(markup.indexOf('data-testid="drawer-description-mainText"'), markup.indexOf('data-testid="drawer-description-textBelow"'));
    expect(main).toContain(">Leave as is</span>");
    expect(main).toContain(">Use Card Shellz text</span>");
    expect(main).not.toContain("Own text");
    const above = markup.slice(markup.indexOf('data-testid="drawer-description-textAbove"'), markup.indexOf('data-testid="drawer-description-mainText"'));
    for (const words of ["Leave as is", "Use default", "None", "Own text"]) expect(above, words).toContain(`>${words}</span>`);
  });
});
