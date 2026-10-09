import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pricingReviewResponseSchema,
  type PricingImpactRow,
  type PricingProfile,
  type PricingRecipe,
  type PricingReviewResponse,
} from "@shared/dropship/pricing-rules";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { CHECK_NEW_PRICES_WORDS, PRICE_DEFAULT_WORDS, priceRecipeDraft } from "@/lib/dropship-listing-settings-recipe";
import { SUGGESTED_PRICING_RECIPE } from "@/lib/dropship-pricing-rules";
import { UnsavedChangesProvider } from "../catalog/UnsavedChangesGuard";
import { CHECK_NEW_PRICES_SHEET_CLASS, CheckNewPricesSheet, type CheckNewPricesSheetProps } from "../listing-settings/CheckNewPricesSheet";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import { PriceDefaultRow, PriceEditorView, priceRowValue, type PriceEditorViewProps } from "../listing-settings/PriceDefaultRow";

/**
 * Radix renders a sheet into a portal, which a static render leaves out. This
 * stand-in renders the sheet in place and keeps the props the test checks.
 */
vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? createElement("div", { "data-mock": "sheet" }, children) : null),
    SheetContent: ({ side, children, className, "data-testid": testId, "data-layout": layout }: Props) =>
      createElement("div", { "data-mock": "sheet-content", "data-side": side, "data-testid": testId, "data-layout": layout, className }, children),
    SheetHeader: ({ children }: Props) => createElement("div", { "data-mock": "sheet-header" }, children),
    SheetTitle: ({ children }: Props) => createElement("h2", { "data-mock": "sheet-title" }, children),
    SheetDescription: ({ children }: Props) => createElement("p", { "data-mock": "sheet-description" }, children),
  };
});

const STORE = 22;
const ENDPOINT = `/api/dropship/listings/stores/${STORE}/pricing-rules`;
const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const UNDER_BANNER: ListingSettingsRight = { editable: false, reason: "banner" };
const LOADING: ListingSettingsRight = { editable: false, reason: "loading" };
const noop = () => undefined;
const callbacks = { onSaveStarted: noop, onSaveSettled: noop };
const PROFILE: PricingProfile = {
  defaultRecipe: RETAIL_20_UP,
  groups: [{
    id: "envelopes", name: "Envelopes", priority: 10, scope: { type: "category", category: "Envelopes" },
    recipe: { basis: "catalog_retail", markupBps: 3000, flatCents: 0, rounding: "cent" },
  }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Node has no browser location, so the router renders from a fixed path. */
function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/setup", children: node }));
}

/** A window whose `matchMedia` answers `wide` for every query (the phone layout is below 640 px). */
function stubWidth(wide: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: wide, media: query, addEventListener: noop, removeEventListener: noop }),
  });
}

/** The row inside the providers the step gives it, with a query cache the test checks before it is cleared. */
function renderRow(props: Partial<React.ComponentProps<typeof PriceDefaultRow>> = {}, inspect?: (client: QueryClient) => void): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    const markup = render(React.createElement(QueryClientProvider, { client },
      React.createElement(UnsavedChangesProvider, null,
        React.createElement(ListingSettingsDraftsProvider, {
          storeConnectionId: STORE,
          now: () => 1_000,
          children: React.createElement(PriceDefaultRow, {
            storeConnectionId: STORE,
            saved: { recipe: RETAIL_20_UP, groupRules: 1 },
            right: EDITABLE,
            saveCallbacks: callbacks,
            onSaved: noop,
            ...props,
          }),
        }))));
    inspect?.(client);
    return markup;
  } finally {
    client.clear();
  }
}

/** The pricing rules read the row registered, as the options it gave React Query (it never fetched). */
function registeredRead(client: QueryClient) {
  const query = client.getQueryCache().find({ queryKey: [ENDPOINT] });
  if (!query) return null;
  const options = query.options as { enabled?: unknown; staleTime?: unknown; retry?: unknown };
  return { enabled: options.enabled, staleTime: options.staleTime, retry: options.retry };
}

function editorView(overrides: Partial<PriceEditorViewProps> = {}): string {
  return render(React.createElement(PriceEditorView, {
    read: "ready",
    onRetryRead: noop,
    value: priceRecipeDraft(RETAIL_20_UP),
    onChange: noop,
    locked: false,
    suggested: false,
    errors: {},
    marked: [],
    reason: null,
    message: null,
    ...overrides,
  }));
}

function impactRow(overrides: Partial<PricingImpactRow> = {}): PricingImpactRow {
  return {
    productVariantId: 101, title: "Easy Glide Soft Sleeves", sku: "EG-SLV-STD-5PCK-B500",
    previousPriceCents: 1499, priceCents: 1599, productCostCents: 980, ruleName: "Store default rule", preserved: false,
    issues: [], settingRevisionId: null, evidenceHash: "a".repeat(64), sizeName: "Box of 5 Packs of 100",
    basis: "catalog_retail", basisCents: 1250, warnings: [], ...overrides,
  };
}

function review(overrides: Partial<PricingReviewResponse> = {}): PricingReviewResponse {
  return pricingReviewResponseSchema.parse({
    reviewId: "11111111-1111-4111-8111-111111111111",
    reviewHash: "b".repeat(64),
    createdAt: "2026-10-09T12:00:00.000Z",
    summary: { total: 120, changed: 2, preserved: 1, blocked: 0 },
    rows: [
      impactRow(),
      impactRow({ productVariantId: 102, title: "Team Bags", sizeName: "Case of 1,000", sku: "TB-1000", previousPriceCents: 1999,
        priceCents: 2199, productCostCents: 2310, basisCents: 1800, warnings: ["price_below_product_cost"] }),
      impactRow({ productVariantId: 103, title: "Shellz Pro", sizeName: "Case of 500", sku: "SP-500", previousPriceCents: 5999,
        priceCents: null, ruleName: null, basisCents: null, issues: ["pricing_basis_unavailable", "vendor_retail_price_required"] }),
      impactRow({ productVariantId: 104, title: "Penny Sleeves", sizeName: "Pack of 100", sku: "PS-100", previousPriceCents: 499,
        priceCents: 499, preserved: true, ruleName: "Fixed override preserved", basis: null, basisCents: null }),
    ],
    page: 0,
    ...overrides,
  });
}

function sheet(overrides: Partial<CheckNewPricesSheetProps> = {}): string {
  return render(React.createElement(CheckNewPricesSheet, {
    checked: { review: review(), profile: PROFILE, expectedRevisionId: 7, stale: false },
    phase: null,
    message: null,
    paging: false,
    busy: false,
    onBack: noop,
    onSave: noop,
    onResend: noop,
    onPage: noop,
    ...overrides,
  }));
}

const ENTITIES: Readonly<Record<string, string>> = { "&#x27;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** The text of an element's descendants, tags removed and entities read. */
function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&quot;|&amp;|&lt;|&gt;/g, (entity) => ENTITIES[entity]).replace(/\s+/g, " ").trim();
}

/** Whether the button with exactly this label is disabled; fails when there is none. */
function buttonDisabled(markup: string, label: string): boolean {
  const match = markup.match(new RegExp(`<button([^>]*)>${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</button>`));
  if (!match) throw new Error(`No button "${label}" in ${markup}`);
  return /\sdisabled=""/.test(match[1]);
}

describe("the Price row, closed", () => {
  it("shows the store price from the summary with [Change], and reads no pricing rules (D8)", () => {
    let read: ReturnType<typeof registeredRead> = null;
    const markup = renderRow({}, (client) => { read = registeredRead(client); });
    expect(markup).toContain('data-testid="store-default-row-price"');
    expect(text(markup)).toContain("Retail price + 20%, round up to .99");
    expect(markup).toContain('aria-label="Change Price"');
    expect(read).toEqual({ enabled: false, staleTime: 0, retry: false });
  });

  it("is read-only with no [Change] and no read while W1 won't take a save", () => {
    let read: ReturnType<typeof registeredRead> = null;
    const markup = renderRow({ right: UNDER_BANNER }, (client) => { read = registeredRead(client); });
    expect(markup).not.toContain('aria-label="Change Price"');
    expect(text(markup)).toContain("Retail price + 20%, round up to .99");
    expect(read).toMatchObject({ enabled: false });
    expect(text(renderRow({ right: LOADING }))).toContain("Checking…");
  });

  it("says Not set and offers [Set price] when the store has no store price (R:516)", () => {
    const markup = renderRow({ saved: { recipe: null, groupRules: 0 } });
    expect(text(markup)).toContain(PRICE_DEFAULT_WORDS.notSet);
    expect(buttonDisabled(markup, "Set price")).toBe(false);
    expect(markup).not.toContain('aria-label="Change Price"');
    const readOnly = renderRow({ saved: { recipe: null, groupRules: 0 }, right: UNDER_BANNER });
    expect(readOnly).not.toContain("Set price");
  });

  it("shows Checking… until the summary answers, and the short form on a phone", () => {
    expect(text(renderRow({ saved: null }))).toContain("Checking…");
    stubWidth(false);
    const phone = renderRow();
    expect(text(phone)).toContain("Retail + 20%, up to .99");
    expect(phone).not.toContain("round up to .99");
    expect(priceRowValue({ recipe: { basis: "product_cost", markupBps: 2000, flatCents: 100, rounding: "cent" }, groupRules: 0 }, "full"))
      .toBe("Your cost + 20% plus $1.00, to the cent");
  });
});

describe("the Price editor (R:174-183)", () => {
  it("opens on the suggestion on a first visit, marked Suggested · not saved (R:205)", () => {
    const markup = editorView({ value: priceRecipeDraft(SUGGESTED_PRICING_RECIPE), suggested: true });
    const words = text(markup);
    expect(words).toContain("Retail price + 0%, to the cent Suggested · not saved");
    expect(words).toContain("Start from");
    expect(markup).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="catalog_retail"\/>Retail price/);
    expect(markup).toMatch(/<input type="radio"[^>]*value="product_cost"\/>Your cost/);
    expect(markup).not.toMatch(/checked=""[^>]*value="product_cost"/);
    expect(markup).toMatch(/<input[^>]*inputMode="decimal"[^>]*value="0"/);
    expect(markup).toMatch(/<option value="cent" selected="">To the cent<\/option>/);
    expect(words).toContain("Up to .99");
    expect(words).toContain("Add");
    expect(words).toContain("plus $");
    expect(words).toContain("Round");
    expect(words).toContain(PRICE_DEFAULT_WORDS.basisHelp);
    expect(words).toContain("Sizes with an exact price keep them.");
    expect(words).not.toContain(PRICE_DEFAULT_WORDS.costFollows);
  });

  it("says prices follow the cost when the price starts from Your cost", () => {
    const words = text(editorView({ value: { ...priceRecipeDraft(RETAIL_20_UP), basis: "product_cost" } }));
    expect(words).toContain("Prices that start from your cost change when your cost changes.");
    expect(words).not.toContain("Suggested · not saved");
  });

  it("shows field errors on their fields and marks fields both windows changed", () => {
    const markup = editorView({
      errors: { percent: PRICE_DEFAULT_WORDS.percentInvalid, flat: PRICE_DEFAULT_WORDS.flatTooLarge },
      marked: ["percent"],
    });
    expect(text(markup)).toContain(PRICE_DEFAULT_WORDS.percentInvalid);
    expect(text(markup)).toContain(PRICE_DEFAULT_WORDS.flatTooLarge);
    expect(markup.match(/aria-invalid="true"/g)).toHaveLength(2);
    expect(text(markup)).toContain("Also changed in another window");
  });

  it("locks the fields while saving, and shows the read's states", () => {
    expect(editorView({ locked: true })).toMatch(/<fieldset[^>]*disabled=""/);
    expect(text(editorView({ read: "loading" }))).toBe("Checking…");
    const failed = editorView({ read: "failed" });
    expect(text(failed)).toContain("Couldn't load your store price. Try again.");
    expect(buttonDisabled(failed, "Try again")).toBe(false);
    expect(text(editorView({ read: "unavailable", reason: "Checking…" }))).toBe("Checking…");
    const words = text(editorView({ message: { text: "We couldn't confirm your save.", tone: "alert" } }));
    expect(words).toContain("We couldn't confirm your save.");
  });
});

describe("Check new prices (M3)", () => {
  it("lists every size with what its new price is built from, now and new, and notes", () => {
    stubWidth(true);
    const markup = sheet();
    const words = text(markup);
    expect(markup).toContain('data-layout="wide"');
    expect(words).toContain("Check new prices · Not saved yet");
    expect(words).toContain("Retail price + 20%, round up to .99");
    expect(words).toContain("120 sizes · 2 change · 1 keeps its own price");
    for (const column of CHECK_NEW_PRICES_WORDS.columns) expect(markup).toContain(`>${column}</th>`);
    expect(words).toContain("Easy Glide Soft Sleeves Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500");
    expect(words).toContain("Store default: retail $12.50 + 20%, up to .99 $14.99 $15.99");
    expect(words).toContain("! Below your cost ($23.10)");
    expect(words).toContain("Can't price: Card Shellz has no retail price for this size $59.99 — ● Loses its price");
    expect(words).toContain("Exact price $4.99 $4.99");
    expect(words).not.toContain("Fixed override preserved");
    expect(words).toContain("1–50 of 120");
    expect(buttonDisabled(markup, "Previous")).toBe(true);
    expect(buttonDisabled(markup, "Next")).toBe(false);
    expect(words).toContain("Nothing is saved until you press Save new prices.");
    expect(buttonDisabled(markup, "Back to editing")).toBe(false);
    expect(buttonDisabled(markup, "Save new prices")).toBe(false);
  });

  it("keeps Save off while sizes can't be priced, and says why (C9)", () => {
    const markup = sheet({ checked: { review: review({ summary: { total: 120, changed: 2, preserved: 1, blocked: 3 } }), profile: PROFILE, expectedRevisionId: 7, stale: false } });
    expect(text(markup)).toContain("● 3 sizes can't be priced this way. Give them an exact price in Products, or start from Your cost.");
    expect(buttonDisabled(markup, "Save new prices")).toBe(true);
  });

  it("is full screen on a phone, as cards, with the short footer (R:471-488)", () => {
    stubWidth(false);
    const markup = sheet();
    const words = text(markup);
    expect(markup).toContain('data-layout="phone"');
    expect(CHECK_NEW_PRICES_SHEET_CLASS.split(" ")).toContain("w-full");
    expect(markup).not.toContain("<table");
    expect(markup.match(/data-testid="check-new-prices-card"/g)).toHaveLength(4);
    expect(words).toContain("$14.99 → $15.99");
    expect(words).toContain("Nothing is saved yet.");
    expect(words).not.toContain("Nothing is saved until you press Save new prices.");
    expect(buttonDisabled(markup, "Back")).toBe(false);
    expect(buttonDisabled(markup, "Save new prices")).toBe(false);
  });

  it("says when prices moved and the check ran again (R:683)", () => {
    const markup = sheet({ checked: { review: review(), profile: PROFILE, expectedRevisionId: 7, stale: true } });
    expect(text(markup)).toContain("Prices changed while you were checking. Here's the new check.");
  });

  it("locks while saving and offers Check again for an unconfirmed save", () => {
    const saving = sheet({ phase: "saving" });
    expect(buttonDisabled(saving, "Saving…")).toBe(true);
    expect(buttonDisabled(saving, "Back to editing")).toBe(true);
    const uncertain = sheet({ phase: "uncertain", message: "We couldn't confirm your save." });
    expect(text(uncertain)).toContain("We couldn't confirm your save.");
    expect(uncertain).toMatch(/role="alert"[^>]*>We couldn&#x27;t confirm your save\./);
    expect(buttonDisabled(uncertain, "Check again")).toBe(false);
    expect(buttonDisabled(uncertain, "Back to editing")).toBe(true);
  });

  it("shows nothing until there is a check, and an empty check plainly", () => {
    expect(sheet({ checked: null })).toBe("");
    const empty = sheet({ checked: { review: review({ summary: { total: 0, changed: 0, preserved: 0, blocked: 0 }, rows: [] }), profile: PROFILE, expectedRevisionId: null, stale: false } });
    expect(text(empty)).toContain("No sizes are chosen yet, so no prices change.");
    expect(text(empty)).not.toContain("of 0");
  });
});
