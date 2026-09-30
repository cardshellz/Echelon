import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EbayCategoryOption, EbayCategoryRulesReview, EbayCategoryRulesState } from "@shared/dropship/ebay-category-rules";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { ebayCategoryRulesEndpoint } from "@/lib/dropship-ebay-category-rules";
import { DropshipEbayCategoryRulesPanel, ReviewSummary } from "../DropshipEbayCategoryRulesPanel";
import { EbayCategoryPickerView } from "../DropshipEbayCategoryPicker";

const SLEEVES = { categoryId: "183435", categoryName: "Card Sleeves", path: ["Collectibles", "Trading Cards", "Card Sleeves"] };
const TOPLOADERS = { categoryId: "183436", categoryName: "Toploaders", path: ["Collectibles", "Trading Cards", "Toploaders"] };
const noop = () => undefined;

afterEach(() => { vi.unstubAllGlobals(); });

function render(node: React.ReactNode): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(node);
}

function renderPanel(state: EbayCategoryRulesState, options: { disabled?: boolean } = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData([ebayCategoryRulesEndpoint(22)], state);
  try {
    return render(React.createElement(QueryClientProvider, { client }, React.createElement(DropshipEbayCategoryRulesPanel, {
      storeConnectionId: 22, storeName: "Card Shellz Test Store", disabled: options.disabled,
      onSaveStarted: noop, onSaveSettled: noop, onSaved: async () => undefined,
    })));
  } finally { client.clear(); }
}

function option(overrides: Partial<EbayCategoryOption> = {}): EbayCategoryOption {
  return { ...SLEEVES, leaf: true, ...overrides };
}

function pickerProps(overrides: Partial<Parameters<typeof EbayCategoryPickerView>[0]> = {}): Parameters<typeof EbayCategoryPickerView>[0] {
  return {
    label: "eBay category for Toploaders", mode: "search", onModeChange: noop, onCancel: noop,
    search: "sleeves", onSearchChange: noop, searchStatus: "ready", searchError: null, searchResults: [], searchedText: "sleeves",
    onRetrySearch: noop, trail: [], onTrailChange: noop, browseStatus: "idle", browseError: null, browseParent: null, browseChildren: [],
    onRetryBrowse: noop, onPick: noop, onOpen: noop, ...overrides,
  };
}

function review(overrides: Partial<EbayCategoryRulesReview> = {}): EbayCategoryRulesReview {
  return {
    expectedRevisionId: 3, selectedCount: 800, changedCount: 142, unchangedCount: 658, withoutCategoryBefore: 0, withoutCategoryAfter: 0,
    bySource: { rule: 300, store_default: 500, catalog: 0, none: 0 }, byRule: [], otherCategoriesCount: 0,
    byCategory: [{ categoryId: "183435", categoryName: "Card Sleeves", count: 500 }, { categoryId: "183436", categoryName: "Toploaders", count: 300 }],
    changes: [{ productVariantId: 11, sku: "TL-35", title: "Toploader 35pt",
      before: { categoryId: "261328", categoryName: "Card Supplies", source: "catalog", ruleId: null },
      after: { categoryId: "183436", categoryName: "Toploaders", source: "rule", ruleId: "toploaders" } }],
    ...overrides,
  };
}

describe("eBay category rules panel", () => {
  it("shows the saved store default and rules in the order they are checked", () => {
    const markup = renderPanel({ revisionId: 3, updatedAt: "2026-09-30T12:00:00.000Z", profile: { version: 1, defaultCategory: SLEEVES, rules: [
      { id: "toploaders", name: "Toploaders", scope: { type: "category", category: "Toploaders" }, category: TOPLOADERS },
      { id: "sleeves", name: "Penny sleeves", scope: { type: "product", productId: 9 }, category: SLEEVES },
    ] } });
    expect(markup).toContain("eBay categories");
    expect(markup).toContain("Each listing uses the first rule that matches it");
    expect(markup).toContain("then your store default, then the Card Shellz category for its product type");
    expect(markup).toContain("Collectibles › Trading Cards › Card Sleeves");
    expect(markup).toContain("Change store default");
    expect(markup).toContain("Use Card Shellz categories instead");
    expect(markup).toContain("Rules (2 of 100)");
    expect(markup.indexOf("1. Toploaders")).toBeGreaterThan(-1);
    expect(markup.indexOf("2. Penny sleeves")).toBeGreaterThan(markup.indexOf("1. Toploaders"));
    expect(markup).toContain("Live eBay listings change only when you publish them.");
    expect(markup).toContain("No unsaved changes.");
  });

  it("explains the Card Shellz fallback before the vendor has saved anything", () => {
    const markup = renderPanel({ revisionId: null, updatedAt: null, profile: null });
    expect(markup).toContain("None. Listings no rule covers use the Card Shellz category for their product type (recommended).");
    expect(markup).toContain("Choose a store default");
    expect(markup).toContain("No rules yet.");
    expect(markup).not.toContain("Use Card Shellz categories instead");
  });

  it("locks editing while a listing action is running", () => {
    const markup = renderPanel({ revisionId: null, updatedAt: null, profile: null }, { disabled: true });
    expect(markup).toMatch(/<fieldset[^>]* disabled=""/);
    expect(renderPanel({ revisionId: null, updatedAt: null, profile: null })).not.toMatch(/<fieldset[^>]* disabled=""/);
  });
});

describe("eBay category picker", () => {
  it("offers only final categories for picking; the others open one level down", () => {
    const markup = render(React.createElement(EbayCategoryPickerView, pickerProps({
      searchResults: [option(), option({ categoryId: "261328", categoryName: "Card Supplies", path: ["Collectibles", "Card Supplies"], leaf: false })],
    })));
    expect(markup).toContain("Suggestions come from eBay&#x27;s own category list");
    const sleeves = markup.slice(markup.indexOf("Card Sleeves"), markup.indexOf("Card Supplies"));
    expect(sleeves).toContain("Use this category");
    expect(sleeves).toContain("#183435");
    const supplies = markup.slice(markup.indexOf("Card Supplies"));
    expect(supplies).toContain("Open");
    expect(supplies).not.toContain("Use this category");
  });

  it("asks the vendor to reconnect when the eBay connection needs a refresh", () => {
    const error = new DropshipApiError({ status: 403, code: "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED", message: "Reconnect the store." });
    const markup = render(React.createElement(EbayCategoryPickerView, pickerProps({
      searchStatus: "error", searchError: error,
      renderAuthorizationRecovery: (value) => React.createElement("button", null, value === error ? "Refresh eBay authorization" : "wrong error"),
    })));
    expect(markup).toContain("Your eBay connection needs a refresh.");
    expect(markup).toContain("Refresh eBay authorization");
    expect(markup).not.toContain("Try again");
  });

  it("keeps other failures retryable and says why", () => {
    const error = new DropshipApiError({ status: 502, code: "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", message: "eBay categories could not be loaded. Try again shortly." });
    const markup = render(React.createElement(EbayCategoryPickerView, pickerProps({ searchStatus: "error", searchError: error })));
    expect(markup).toContain("eBay categories could not be loaded. Try again shortly.");
    expect(markup).toContain("Try again");
  });

  it("tells the vendor what to do when a search finds nothing or is too short", () => {
    expect(render(React.createElement(EbayCategoryPickerView, pickerProps({ searchResults: [] }))))
      .toContain("eBay has no suggestions for &quot;sleeves&quot;. Try other words, or browse all categories.");
    expect(render(React.createElement(EbayCategoryPickerView, pickerProps({ search: "s", searchStatus: "too_short" }))))
      .toContain("Type at least 2 characters to search.");
  });

  it("browses the tree with a path back to the top, and lets a final category be used from inside it", () => {
    const parent = option();
    const markup = render(React.createElement(EbayCategoryPickerView, pickerProps({
      mode: "browse", browseStatus: "ready", trail: [option({ categoryId: "1", categoryName: "Collectibles", path: ["Collectibles"], leaf: false }), parent],
      browseParent: parent, browseChildren: [],
    })));
    expect(markup).toContain("All categories");
    expect(markup).toContain("Collectibles");
    expect(markup).toContain("This is a final eBay category.");
    expect(markup).toContain("Use this category");
  });
});

describe("eBay category review", () => {
  it("shows what changes before anything is saved", () => {
    const markup = render(React.createElement(ReviewSummary, { review: review(), ruleNames: [], saving: false, disabled: false, backDisabled: false, onConfirm: noop, onBack: noop }));
    expect(markup).toContain("142 of 800 selected listings change eBay category.");
    expect(markup).toContain("After saving: 300 from your rules · 500 from your store default.");
    expect(markup).toContain("500 → Card Sleeves");
    expect(markup).toContain("Toploader 35pt");
    expect(markup).toContain("From the Card Shellz category");
    expect(markup).toContain("From one of your rules");
    expect(markup).toContain("Showing 1 of 142 changed listings.");
    const withoutExamples = render(React.createElement(ReviewSummary, { review: review({ changes: [] }), ruleNames: [], saving: false, disabled: false,
      backDisabled: false, onConfirm: noop, onBack: noop }));
    expect(withoutExamples).not.toContain("Showing 0");
    expect(markup).toContain("Confirm and save");
  });

  it("says how many listings each rule covers, in rule order, and flags a rule that covers none", () => {
    const markup = render(React.createElement(ReviewSummary, {
      review: review({ byRule: [{ ruleId: "toploaders", matched: 300 }, { ruleId: "unused", matched: 0 }] }),
      ruleNames: [{ id: "toploaders", name: "Toploaders" }, { id: "unused", name: "Old sleeves" }],
      saving: false, disabled: false, backDisabled: false, onConfirm: noop, onBack: noop,
    }));
    expect(markup).toContain("Listings each rule covers");
    expect(markup.indexOf("1. Toploaders: 300 listings")).toBeGreaterThan(-1);
    expect(markup.indexOf("2. Old sleeves: 0 listings")).toBeGreaterThan(markup.indexOf("1. Toploaders: 300 listings"));
    expect(markup).toContain("matches no selected listing, or an earlier rule covers them");
  });

  it("sums the destinations past the first ten and blocks going back over an unconfirmed save", () => {
    const byCategory = Array.from({ length: 12 }, (_, index) => ({ categoryId: String(1000 + index), categoryName: `Category ${index}`, count: 10 }));
    const markup = render(React.createElement(ReviewSummary, { review: review({ byCategory, otherCategoriesCount: 5 }), ruleNames: [],
      saving: false, disabled: false, backDisabled: true, onConfirm: noop, onBack: noop }));
    expect(markup).toContain("Category 9");
    expect(markup).not.toContain("Category 10");
    expect(markup).toContain("25 → other categories");
    expect(markup).toMatch(/<button[^>]* disabled=""[^>]*>Back to editing<\/button>/);
    const enabled = render(React.createElement(ReviewSummary, { review: review(), ruleNames: [], saving: false, disabled: false, backDisabled: false, onConfirm: noop, onBack: noop }));
    expect(enabled).not.toMatch(/<button[^>]* disabled=""[^>]*>Back to editing<\/button>/);
  });
});

describe("Catalog page wiring", () => {
  const catalog = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
  const recovery = readFileSync(join(process.cwd(), "client/src/pages/dropship/EbayStoreCategoryAuthorizationRecovery.tsx"), "utf8");

  it("mounts the rules panel only for an eBay store, with the preview callbacks and the reconnect control", () => {
    const ebayBlock = catalog.indexOf('{selectedStoreConnection?.platform === "ebay" && (');
    const panel = catalog.indexOf("<DropshipEbayCategoryRulesPanel");
    const pricing = catalog.indexOf("<DropshipPricingRulesPanel");
    expect(ebayBlock).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(ebayBlock);
    expect(panel).toBeLessThan(pricing);
    const mount = catalog.slice(panel, catalog.indexOf("/>\n            <EbayStoreCategoryAssignmentPanel", panel));
    expect(mount).toContain("{...priceSaveCallbacks}");
    expect(mount).toContain("<EbayStoreCategoryAuthorizationRecovery");
  });

  it("words the reconnect button as a refresh for the category permission code", () => {
    expect(recovery).toContain('"DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED"');
  });
});
