import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { priceChangeReviewResponseSchema, type PriceChangeReviewResponse, type PriceChangeRow } from "@shared/dropship/listing-setting-writes";
import {
  listingSettingsProductDetailSchema,
  listingSettingsProductIdsResponseSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsSizePriceSchema,
  type ListingSettingsProductDetail,
  type ListingSettingsProductOwnSettings,
  type ListingSettingsSizePrice,
} from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { listingSettingsProductIdsQueryOptions, listingSettingsProductOwnQueryOptions, listingSettingsProductQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { bulkDraftValue, bulkPriceDraftValue, type BulkSettingsRights } from "@/lib/dropship-listing-settings-bulk";
import { BULK_EDITOR_ID, LISTING_SETTINGS_SAVE_WORDS, productEditorId, reduceListingSettingsDraft, type ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import { productPriceEditorModel, type ProductPriceEditorModel } from "@/lib/dropship-listing-settings-price-check";
import { sizePriceDraftValue } from "@/lib/dropship-listing-settings-drawer";
import { productPriceDraftValue, type PriceCheckRef, type ProductPriceChange } from "@/lib/dropship-listing-settings-product-edit";
import { emptySelection, reduceListingSettingsSelection, type ListingSettingsSelection } from "@/lib/dropship-listing-settings-selection";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_PRICE_CHECK_WORDS } from "@/lib/dropship-listing-settings-words";
import { BulkSettingsSheet, type BulkSettingsSheetProps } from "../listing-settings/BulkSettingsSheet";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { PriceChangeCheckBody, type PriceChangeCheckBodyProps } from "../listing-settings/PriceChangeCheckBody";
import { ProductDrawer, type ProductDrawerProps } from "../listing-settings/ProductDrawer";
import { ProductPriceEditor, type ProductPriceEditorProps } from "../listing-settings/ProductPriceEditor";

/**
 * The price check for one or many products (Listing settings PR 10d, plan 7.2, 7.4, 7.6, 7.7): the
 * check body inside its owner (every row, note and price from the server's integer cents, never computed
 * here; counts; the footer's states; Back to editing; phone cards), the product's price editor, and the
 * drawer and "Set for selected" with a price draft, with and without its check (D2, D20). Static renders:
 * the step's one draft is set per test, since the real provider can't start with one.
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
const PRODUCT = 11;
const SIZE_A = 101;
const SIZE_B = 102;
const GENERATED_AT = "2026-10-14T12:00:00.000Z";
const HASH_A = "a".repeat(64);
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 0, rounding: "cent" };
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const WORDS = LISTING_SETTINGS_PRICE_CHECK_WORDS;
const CHECK: PriceCheckRef = { reviewId: REVIEW_ID, reviewHash: HASH_A, after: null };
const SET_RELEASE: Pick<ProductPriceChange, "price" | "releaseExactPrices"> = { price: { mode: "set", value: RETAIL_20_UP }, releaseExactPrices: true };
const DEFAULT: Pick<ProductPriceChange, "price" | "releaseExactPrices"> = { price: { mode: "default" }, releaseExactPrices: false };
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  state.drafts = null;
});

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

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

// ---------------------------------------------------------------------------
// Fixtures, each checked against the shared contract; prices in odd cents, never round numbers
// ---------------------------------------------------------------------------

/** A W7 row: W1's review row with the product, the release and the refusal. */
function row(overrides: Partial<PriceChangeRow> = {}): PriceChangeRow {
  return {
    productVariantId: SIZE_A, productId: PRODUCT, title: "Easy Glide Soft Sleeves", sku: "EG-SLV-STD-5PCK-B500",
    previousPriceCents: 1499, priceCents: 1733, productCostCents: 981, ruleName: "Store default rule", preserved: false, issues: [],
    settingRevisionId: null, evidenceHash: HASH_A, sizeName: "Box of 5 Packs of 100", basis: "catalog_retail", basisCents: 1251, warnings: [],
    released: false, refusal: null, ...overrides,
  };
}

const ROWS: PriceChangeRow[] = [
  // Priced by the product's own price from retail $12.51: $14.99 → $17.33.
  row({ ruleLevel: "product", ruleName: "Product price" }),
  // An exact price kept.
  row({ productVariantId: 102, sizeName: "Pack of 100", sku: "EG-SLV-STD-100", previousPriceCents: 1201, priceCents: 1201, preserved: true,
    ruleName: "Fixed override preserved", basis: null, basisCents: null, settingRevisionId: 7 }),
  // An exact price cleared, now the category's price from the cost.
  row({ productVariantId: 103, sizeName: "Pack of 250", sku: "EG-SLV-STD-250", previousPriceCents: 1899, priceCents: 1323, released: true,
    ruleLevel: "category", ruleName: "Category price", basis: "product_cost", basisCents: 980, settingRevisionId: 8 }),
  // Would lose its price: refused at apply.
  row({ productVariantId: 104, sizeName: "Pack of 1000", sku: "EG-SLV-STD-1000", previousPriceCents: 2501, priceCents: null,
    issues: ["pricing_basis_unavailable"], ruleName: null, basisCents: null, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST" }),
  // Below the cost (a warning, never a block), from an older group rule.
  row({ productVariantId: 105, sizeName: "Pack of 50", sku: "EG-SLV-STD-50", previousPriceCents: 999, priceCents: 701, productCostCents: 833,
    ruleName: "Envelopes", warnings: ["price_below_product_cost"] }),
];

function review(overrides: Partial<PriceChangeReviewResponse> = {}): PriceChangeReviewResponse {
  return priceChangeReviewResponseSchema.parse({
    reviewId: REVIEW_ID, reviewHash: HASH_A, createdAt: GENERATED_AT, kind: "product_prices",
    summary: { total: 5, changed: 4, released: 1, refused: 1 }, rows: ROWS, page: 0, ...overrides,
  });
}

function checkBody(overrides: Partial<PriceChangeCheckBodyProps> = {}): string {
  return render(React.createElement(PriceChangeCheckBody, {
    check: CHECK, review: review(), change: SET_RELEASE, phase: null, message: null, code: null, notice: null, refusedSizes: new Set<number>(),
    busy: false, paging: false, read: null, compact: false, onBack: noop, onSave: noop, onResend: noop, onPage: noop, ...overrides,
  }));
}

function footerOf(markup: string): string {
  return markup.slice(markup.indexOf('data-testid="price-check-footer"'));
}

function sizeOf(markup: string, productVariantId: number): string {
  const start = markup.indexOf(`data-testid="price-check-size-${productVariantId}"`);
  expect(start, `size ${productVariantId}`).toBeGreaterThan(-1);
  const rest = markup.slice(start + 1);
  const next = /data-testid="price-check-size-\d+"/.exec(rest);
  return markup.slice(start, next === null ? start + 1 + rest.indexOf("</tbody>") : start + 1 + next.index);
}

// ---------------------------------------------------------------------------
// The check body (plan 7.4)
// ---------------------------------------------------------------------------

describe("PriceChangeCheckBody (plan 7.4): every row from the server's data", () => {
  it("heads itself with what is checked, counts the sizes, and lists each size with Built from, Now, New and its notes", () => {
    const markup = checkBody();
    // The check takes focus when it replaces the owner's body (plan 3.4), and the counts are read out.
    expect(markup).toMatch(/<div tabindex="-1"[^>]*data-testid="price-check" data-review="11111111-1111-4111-8111-111111111111">/);
    expect(text(markup)).toContain("Checking: Retail price + 20%, round up to .99 · Clear exact prices too · Not saved yet");
    expect(markup).toContain('<p role="status" class="text-sm text-zinc-700" data-testid="price-check-counts">5 sizes · 4 change · 1 loses its exact price · 1 would lose its price</p>');
    for (const column of ["Size", "Built from", "Now", "New", "Note"]) expect(markup).toContain(`>${column}</th>`);
    const product = text(sizeOf(markup, SIZE_A));
    expect(product).toContain("Easy Glide Soft Sleeves Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500");
    expect(product).toContain("This product's price, from retail $12.51 $14.99 $17.33");
    const kept = text(sizeOf(markup, 102));
    expect(kept).toContain("Exact price kept $12.01 $12.01");
    const released = text(sizeOf(markup, 103));
    expect(released).toContain("Category price, from your cost $9.80 $18.99 $13.23 Exact price cleared");
    const refused = sizeOf(markup, 104);
    expect(refused).toContain('data-refused="true"');
    expect(text(refused)).toContain("Can't price: Card Shellz has no retail price for this size $25.01 — ● Loses its price");
    const belowCost = text(sizeOf(markup, 105));
    expect(belowCost).toContain("Older group rule “Envelopes”, from retail $12.51 $9.99 $7.01 ! Below your cost ($8.33)");
    // Never a rounded or computed figure: the odd cents are the server's.
    expect(markup).not.toMatch(/\$1[57]\.00|\$12\.50/);
    // No stale line for a first check; the W1 footer line.
    expect(markup).not.toContain('data-testid="price-check-after"');
    expect(footerOf(markup)).toContain("Nothing is saved until you press Save new prices.");
    expect(footerOf(markup)).toMatch(/<button[^>]*>Back to editing<\/button>/);
    expect(footerOf(markup)).not.toMatch(/disabled=""[^>]*>Back to editing<\/button>/);
  });

  it("marks the sizes a refused apply named as losing their price, once each (7.5)", () => {
    const markup = checkBody({ review: review({ summary: { total: 5, changed: 4, released: 1, refused: 0 }, rows: ROWS.map((entry) => ({ ...entry, refusal: null })) }),
      refusedSizes: new Set([SIZE_A]) });
    const named = sizeOf(markup, SIZE_A);
    expect(named).toContain('data-refused="true"');
    expect(named.match(/● Loses its price/g)).toHaveLength(1);
    expect(sizeOf(markup, 102)).not.toContain("Loses its price");
  });

  it("says once when the check replaced an earlier one, and why (7.5)", () => {
    expect(checkBody({ check: { ...CHECK, after: "prices_moved" } })).toContain('data-testid="price-check-after">Prices changed while you were checking. Here\'s the new check.</p>');
    expect(checkBody({ check: { ...CHECK, after: "already_applied" } })).toContain(`>${WORDS.alreadySaved}</p>`);
    expect(checkBody({ check: { ...CHECK, after: "expired" } })).toContain(`>${WORDS.expired}</p>`);
  });

  it("pages the check, keeping the review on screen, with Previous and Next by the page (7.5)", () => {
    const first = checkBody({ review: review({ summary: { total: 60, changed: 4, released: 1, refused: 1 } }) });
    expect(first).toContain('data-testid="price-check-pages">1–50 of 60</span>');
    expect(first).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
    expect(first).toMatch(/<button[^>]*>Next<\/button>/);
    expect(first).not.toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
    const second = checkBody({ review: review({ summary: { total: 60, changed: 4, released: 1, refused: 1 }, page: 1 }) });
    expect(second).toContain(">51–60 of 60</span>");
    expect(second).toMatch(/<button[^>]*disabled=""[^>]*>Next<\/button>/);
    // A one-page check says so, with both buttons off (W1's sheet does the same).
    const one = checkBody();
    expect(one).toContain('data-testid="price-check-pages">1–5 of 5</span>');
    expect(one).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button><button[^>]*disabled=""[^>]*>Next<\/button>/);
  });

  it("follows the footer's states: Save off while sizes would lose their price, Saving…, Check again with Back on, the failed apply's words", () => {
    const refused = footerOf(checkBody());
    expect(refused).toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
    expect(refused).toContain('<p role="alert" class="text-sm text-rose-800">● 1 size can\'t be priced this way. Give it an exact price in Products, or start from Your cost.</p>');
    expect(refused).toContain(`<p role="status" class="text-sm text-zinc-700">${WORDS.oneDraft}</p>`);
    const clean = footerOf(checkBody({ review: review({ summary: { total: 5, changed: 4, released: 1, refused: 0 } }) }));
    expect(clean).toMatch(/<button[^>]*>Save new prices<\/button>/);
    expect(clean).not.toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
    const saving = footerOf(checkBody({ phase: "saving" }));
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*>Saving…<\/button>/);
    expect(saving).toMatch(/<button[^>]*disabled=""[^>]*>Back to editing<\/button>/);
    // Unconfirmed: Check again, with Back on (it closes the owner and keeps the locked draft, plan 7.6, D21).
    const uncertain = footerOf(checkBody({ phase: "uncertain", message: "We couldn't confirm your save." }));
    expect(uncertain).toMatch(/<button[^>]*>Check again<\/button>/);
    expect(uncertain).not.toMatch(/disabled=""[^>]*>Check again<\/button>/);
    expect(uncertain).not.toMatch(/<button[^>]*disabled=""[^>]*>Back to editing<\/button>/);
    expect(uncertain).toContain('<p role="alert" class="text-sm text-rose-800">We couldn\'t confirm your save.</p>');
    // A refused apply: its words, and Save off (the same check would be refused again); Back to editing is the way on.
    const failed = footerOf(checkBody({ phase: "refused", code: "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", message: "You can clear up to 200 exact prices at once. This would clear 236. Choose fewer products.",
      review: review({ summary: { total: 5, changed: 4, released: 1, refused: 0 } }) }));
    expect(failed).toContain(">You can clear up to 200 exact prices at once. This would clear 236. Choose fewer products.</p>");
    expect(failed).toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
    expect(failed).not.toMatch(/disabled=""[^>]*>Back to editing<\/button>/);
    // Words outside the draft (a page that didn't load) are an alert in the body; busy holds Save.
    expect(checkBody({ notice: "Couldn't load this page of the check. Try again." })).toContain('<p role="alert" class="text-sm text-amber-900">Couldn\'t load this page of the check. Try again.</p>');
    expect(footerOf(checkBody({ busy: true, review: review({ summary: { total: 5, changed: 4, released: 1, refused: 0 } }) }))).toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
  });

  it("says No chosen sizes to check for an empty check, and keeps Save on when a price is sent (P35)", () => {
    const empty = checkBody({ review: review({ summary: { total: 0, changed: 0, released: 0, refused: 0 }, rows: [] }), change: DEFAULT });
    expect(empty).toContain(`>${WORDS.noSizes}</p>`);
    expect(empty).toContain(">No sizes are chosen yet, so no prices change.</p>");
    expect(footerOf(empty)).not.toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
  });

  it("reads the rows again for a reopened check: Checking…, then a failed read with Try again; Check again never waits for them (D21)", () => {
    const loading = checkBody({ review: null, read: { kind: "loading" } });
    expect(loading).toContain('<p role="status" class="text-sm text-zinc-600">Checking…</p>');
    expect(loading).not.toContain('data-testid="price-check-counts"');
    expect(footerOf(loading)).toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
    const failed = checkBody({ review: null, read: { kind: "failed", message: "Couldn't load this page of the check. Try again." }, onRetryRead: noop });
    expect(failed).toMatch(/<div role="alert"[^>]*><span>Couldn't load this page of the check. Try again.<\/span><button[^>]*>Try again<\/button>/);
    expect(footerOf(failed)).toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
    // Unconfirmed with the rows not read, or their read failed (a 404 while locked too): Check again is on, rebuilt from
    // the draft's review id and hash alone; Back is on; nothing offers Save.
    for (const read of [{ kind: "loading" as const }, { kind: "failed" as const, message: LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone }]) {
      const markup = checkBody({ review: null, read, phase: "uncertain", message: "We couldn't confirm your save.", onRetryRead: noop });
      expect(footerOf(markup), read.kind).toMatch(/<button[^>]*>Check again<\/button>/);
      expect(footerOf(markup), read.kind).not.toMatch(/disabled=""[^>]*>Check again<\/button>/);
      expect(footerOf(markup), read.kind).not.toMatch(/disabled=""[^>]*>Back to editing<\/button>/);
      expect(footerOf(markup), read.kind).not.toMatch(/<button[^>]*>Save new prices<\/button>/);
      expect(footerOf(markup), read.kind).toContain(">We couldn't confirm your save.</p>");
    }
    expect(checkBody({ review: null, read: { kind: "failed", message: LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone }, phase: "uncertain", message: "x" }))
      .toContain("This price check has expired. Check new prices again.");
    // Another listing action still holds Check again.
    expect(footerOf(checkBody({ review: null, read: { kind: "loading" }, phase: "uncertain", busy: true }))).toMatch(/disabled=""[^>]*>Check again<\/button>/);
  });

  it("is cards on a phone, with the short footer and Back (R:471-488)", () => {
    const markup = checkBody({ compact: true });
    expect(markup).not.toContain("<table");
    expect(markup.match(/<li[^>]*data-testid="price-check-size-\d+"/g)).toHaveLength(5);
    expect(text(sizeOf(markup, SIZE_A))).toContain("$14.99 → $17.33");
    expect(footerOf(markup)).toContain("Nothing is saved yet.");
    expect(footerOf(markup)).toMatch(/<button[^>]*>Back<\/button>/);
    expect(footerOf(markup)).not.toContain("Back to editing");
  });
});

// ---------------------------------------------------------------------------
// The product's price editor (plan 7.2)
// ---------------------------------------------------------------------------

function editorModel(overrides: Partial<Parameters<typeof productPriceEditorModel>[0]> = {}): ProductPriceEditorModel {
  return productPriceEditorModel({
    rights: { canSet: true, canDefault: true, reason: null }, change: { price: { mode: "leave" }, releaseExactPrices: false },
    ownPrice: null, storeRecipe: COST_35, ...overrides,
  });
}

function priceEditor(overrides: Partial<ProductPriceEditorProps> = {}): string {
  return render(React.createElement(ProductPriceEditor, {
    model: editorModel(), title: "Price", productName: "Easy Glide Soft Sleeves", message: null, checking: false, locked: false,
    onCheck: noop, onCancel: noop, ...overrides,
  }));
}

describe("ProductPriceEditor (plan 7.2)", () => {
  it("opens on Use default for a product without its own price, offers Set price and Clear exact prices too, with Check new prices", () => {
    const markup = priceEditor();
    expect(markup).toContain('role="group" aria-label="Price for Easy Glide Soft Sleeves" data-testid="drawer-field-editor-price"');
    expect(markup).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span class="min-w-0"><span[^>]*>Use default<\/span>/);
    expect(markup).toMatch(/<input type="radio"[^>]*\/><span class="min-w-0"><span[^>]*>Set price<\/span>/);
    // No fields until Set price is chosen.
    expect(markup).not.toContain('data-testid="drawer-price-fields"');
    expect(markup).toContain(">Clear exact prices too, so every size uses this price</span>");
    expect(markup).toMatch(/<input type="checkbox"[^>]*\/>/);
    expect(markup).not.toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(markup).toMatch(/<button[^>]*>Cancel<\/button><button[^>]*>Check new prices<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Check new prices<\/button>/);
  });

  it("opens on Set price with the product's own recipe in W1's fields, and on the draft's change with its release", () => {
    const own = priceEditor({ model: editorModel({ ownPrice: RETAIL_20_UP }) });
    expect(own).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span class="min-w-0"><span[^>]*>Set price<\/span>/);
    expect(own).toContain('data-testid="drawer-price-fields"');
    expect(own).toMatch(/<input[^>]*id="[^"]*"[^>]*value="20"/);
    expect(own).toContain('<option value="up_99" selected="">Up to .99</option>');
    expect(own).not.toContain('data-testid="price-suggested"');
    const draft = priceEditor({ model: editorModel({ change: SET_RELEASE, ownPrice: null }) });
    expect(draft).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(draft).toMatch(/<input[^>]*value="20"/);
    // Use default from the draft: the fields hold the store price to start from, marked as a suggestion once Set price is picked.
    const useDefault = priceEditor({ model: editorModel({ change: DEFAULT, ownPrice: RETAIL_20_UP }) });
    expect(useDefault).toMatch(/<input type="radio"[^>]*checked=""[^>]*\/><span class="min-w-0"><span[^>]*>Use default<\/span>/);
  });

  it("waits while a check runs or the draft is locked, says why nothing can be chosen, and shows why a check didn't take", () => {
    const checking = priceEditor({ checking: true });
    expect(checking).toMatch(/<button[^>]*disabled=""[^>]*>Checking…<\/button>/);
    expect(checking).toMatch(/<fieldset disabled=""/);
    expect(priceEditor({ locked: true })).toMatch(/<button[^>]*disabled=""[^>]*>Check new prices<\/button>/);
    const off = priceEditor({ model: editorModel({ rights: { canSet: false, canDefault: false, reason: "loading" } }) });
    expect(off).toContain(">Checking…</p>");
    expect(off).not.toContain('type="radio"');
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Check new prices<\/button>/);
    expect(priceEditor({ message: "Save or discard your other change first." })).toContain('<p role="alert" class="text-sm text-amber-900">Save or discard your other change first.</p>');
  });
});

// ---------------------------------------------------------------------------
// The drawer with a price draft (D2, D20)
// ---------------------------------------------------------------------------

const RIGHTS: ProductDrawerProps["rights"] = {
  exactPrice: EDITABLE, productSettings: EDITABLE, shipping: EDITABLE, policies: EDITABLE, ebayCategory: EDITABLE, shelfPick: EDITABLE, priceCheck: EDITABLE,
};

function sizePrice(overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return listingSettingsSizePriceSchema.parse({
    productVariantId: SIZE_A, productId: PRODUCT, productName: "Easy Glide Soft Sleeves", sizeName: "Box of 5 Packs of 100", sku: "EG-SLV-STD-5PCK-B500",
    priceCents: 1499, source: "exact", rule: null, basis: null, basisAmountCents: null, issue: null, costCents: 980, belowCostByCents: null,
    limits: [], pausedSince: null, settingRevisionId: 7, ...overrides,
  });
}

const RULES_B = sizePrice({
  productVariantId: SIZE_B, sizeName: "Pack of 100", sku: "EG-SLV-STD-100", priceCents: 499, source: "rules",
  rule: { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP }, basis: "catalog_retail", basisAmountCents: 399, costCents: 210, settingRevisionId: null,
});

function detailWith(sizes: ListingSettingsSizePrice[]): ListingSettingsProductDetail {
  const ids = sizes.map((price) => price.productVariantId);
  const all = (value: unknown, source: "store_default" | "none" | "catalog" = "store_default") => [{ value, sources: [{ source, ruleName: null, productVariantIds: ids }] }];
  return listingSettingsProductDetailSchema.parse({
    storeConnectionId: STORE,
    product: {
      productId: PRODUCT, productName: "Easy Glide Soft Sleeves", category: "Sleeves", sizesChosen: sizes.length, sizesTotal: sizes.length,
      priceRange: { minCents: 499, maxCents: 1499 }, exactPriceCount: sizes.filter((price) => price.source === "exact").length,
      ownSettings: [], sizesDiffer: [], fixes: [],
    },
    settings: {
      shippingPolicy: all({ policyId: "ship-1" }), returnPolicy: all({ policyId: null }, "none"), paymentPolicy: all({ policyId: "pay-1" }),
      ebayCategory: all({ categoryId: "261328", categoryName: "Card Sleeves" }, "catalog"), storeShelf: all({ names: [] }, "none"),
      descriptionTemplate: all({ hasIntroduction: true, hasFooter: false, groupConflict: false }), mainText: all({ own: false }, "catalog"),
    },
    sizes: sizes.map((price, index) => ({ price, fixes: [], stockUnits: index === 0 ? 40 : 120 })),
    stock: { state: "ok", checkedAt: GENERATED_AT },
    generatedAt: GENERATED_AT,
  });
}

const DETAIL = detailWith([sizePrice(), RULES_B]);

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

function ownWith(price: PricingRecipe | null, revisionId: number | null = null): ListingSettingsProductOwnSettings {
  return listingSettingsProductOwnSettingsSchema.parse({
    storeConnectionId: STORE, productId: PRODUCT, revisionId,
    own: { price, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null },
    generatedAt: GENERATED_AT,
  });
}

const NO_OWN = ownWith(null);
const EDITOR = productEditorId(PRODUCT);

/** The drawer's price draft on `own`, with `change` and, when given, its check. */
function priceDraft(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">, check: PriceCheckRef | null, own = NO_OWN): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productPriceDraftValue(own) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: productPriceDraftValue(own, { ...change, check }) })!;
}

function renderDrawer(draft: ListingSettingsDraft | null, overrides: Partial<ProductDrawerProps> = {}, detail = DETAIL, own: ListingSettingsProductOwnSettings | null = NO_OWN): string {
  draftsValue(draft);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  client.setQueryData(listingSettingsProductQueryOptions(STORE, PRODUCT).queryKey, detail);
  if (own) client.setQueryData(listingSettingsProductOwnQueryOptions(STORE, PRODUCT).queryKey, own);
  return render(React.createElement(ProductDrawer, {
    storeConnectionId: STORE, storeName: "Marz Cards", target: { productId: PRODUCT }, rights: RIGHTS, setup: SETUP, summaryRecipe: RETAIL_20_UP,
    onClose: noop, saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop, onGoToStep1: noop, onGoToStep3: noop, ...overrides,
  }), client);
}

describe("the drawer's price (plan 7.2, 7.6; D2, D20)", () => {
  it("offers Change price beside the PRICE head, named for the product, once its own settings are read", () => {
    const markup = renderDrawer(null);
    expect(markup).toContain('data-testid="drawer-price-head">Store default: Retail price + 20%, round up to .99</p>');
    expect(markup).toMatch(/<button[^>]*aria-label="Change price for Easy Glide Soft Sleeves"[^>]*aria-expanded="false"[^>]*>Change price<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Change price<\/button>/);
    expect(markup).not.toContain('data-testid="drawer-price-line"');
    // Until the own read answers: off, with Checking….
    const loading = renderDrawer(null, {}, DETAIL, null);
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>Change price<\/button>/);
    expect(loading).toContain('data-testid="drawer-price-line">Checking…</p>');
    // Without W7's right: off, with the reason.
    const paused = renderDrawer(null, { rights: { ...RIGHTS, priceCheck: { editable: false, reason: "banner" } } });
    expect(paused).toMatch(/<button[^>]*disabled=""[^>]*>Change price<\/button>/);
  });

  it("names the level that prices the product in the head: This product, its category, else the store default (UX-M7)", () => {
    const byProduct = detailWith([sizePrice({ ...RULES_B, rule: { kind: "product", name: "Easy Glide Soft Sleeves", recipe: COST_35 } })]);
    expect(renderDrawer(null, {}, byProduct)).toContain('data-testid="drawer-price-head">This product: Your cost + 35%, to the cent</p>');
    const byCategory = detailWith([sizePrice({ ...RULES_B, rule: { kind: "category", name: "Sleeves", recipe: COST_35 } })]);
    expect(renderDrawer(null, {}, byCategory)).toContain('data-testid="drawer-price-head">Sleeves: Your cost + 35%, to the cent</p>');
  });

  it("with a price change and no check, shows the change in the footer with Check new prices, and holds every other row and size (D2)", () => {
    const markup = renderDrawer(priceDraft(SET_RELEASE, null));
    expect(markup).toContain('data-testid="drawer-settings"');
    expect(markup).not.toContain('data-testid="price-check"');
    expect(markup).toContain('data-testid="product-drawer-not-saved">● Not saved · 1 change</span>');
    expect(markup).toMatch(/<button[^>]*>Check new prices<\/button>/);
    expect(markup).not.toMatch(/disabled=""[^>]*>Check new prices<\/button>/);
    expect(markup).not.toContain(">Save product</button>");
    // Every setting row's Change waits with the one-change line; every size's box is read-only.
    expect(markup.match(/<button[^>]*disabled=""[^>]*>Change<\/button>/g)).toHaveLength(6);
    expect(markup).toContain("Save or discard your other change first.");
    expect(markup.match(/aria-readonly="true"/g)).toHaveLength(2);
  });

  it("with a check, shows the check in place of its body, with the header kept and no drawer footer (D20)", () => {
    const markup = renderDrawer(priceDraft(SET_RELEASE, CHECK));
    expect(markup).toContain('data-testid="product-drawer"');
    expect(markup).toContain("<h2>Easy Glide Soft Sleeves</h2>");
    expect(markup).toContain('data-testid="price-check"');
    expect(markup).toContain(`data-review="${REVIEW_ID}"`);
    expect(markup).not.toContain('data-testid="drawer-settings"');
    expect(markup).not.toContain('data-testid="drawer-price-section"');
    expect(markup).not.toContain('data-testid="product-drawer-footer"');
    // The rows are read again for the check the draft holds (the drawer reopened on it, D21).
    expect(markup).toContain(">Checking…</p>");
    expect(text(markup)).toContain("Checking: Retail price + 20%, round up to .99 · Clear exact prices too · Not saved yet");
    expect(footerOf(markup)).toMatch(/<button[^>]*>Back to editing<\/button>/);
    expect(footerOf(markup)).not.toMatch(/disabled=""[^>]*>Back to editing<\/button>/);
  });

  it("reopened on an unconfirmed apply, shows the check with Check again on and Back, never the drawer's rows (D21)", () => {
    const saving = reduceListingSettingsDraft(priceDraft(SET_RELEASE, CHECK), { type: "startSave", attempt: { signature: "s", key: "ls-price-check:k1" } });
    const uncertain = reduceListingSettingsDraft(saving, {
      type: "failure", key: "ls-price-check:k1", failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null },
    })!;
    const markup = renderDrawer(reduceListingSettingsDraft(uncertain, { type: "close" }));
    expect(markup).toContain('data-testid="price-check"');
    expect(markup).not.toContain('data-testid="drawer-settings"');
    // The rows are still being read again, yet Check again is on: the apply needs only the draft's review id and hash.
    expect(markup).toContain(">Checking…</p>");
    expect(footerOf(markup)).toMatch(/<button[^>]*>Check again<\/button>/);
    expect(footerOf(markup)).not.toMatch(/disabled=""[^>]*>Check again<\/button>/);
    expect(footerOf(markup)).not.toMatch(/<button[^>]*disabled=""[^>]*>Back to editing<\/button>/);
    expect(footerOf(markup)).toContain(">We couldn't confirm your save.</p>");
  });

  it("reopened on a refused apply, shows the check with its words and Save off (the same check would be refused again)", () => {
    const saving = reduceListingSettingsDraft(priceDraft(SET_RELEASE, CHECK), { type: "startSave", attempt: { signature: "s", key: "ls-price-check:k1" } });
    const refused = reduceListingSettingsDraft(saving, {
      type: "failure", key: "ls-price-check:k1",
      failure: { phase: "refused", message: "● 1 size would be left without a price. Give it an exact price in Products first.", code: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", status: 422 },
    })!;
    const markup = renderDrawer(reduceListingSettingsDraft(refused, { type: "close" }));
    expect(markup).toContain('data-testid="price-check"');
    expect(footerOf(markup)).toContain(">● 1 size would be left without a price. Give it an exact price in Products first.</p>");
    expect(footerOf(markup)).toMatch(/<button[^>]*disabled=""[^>]*>Save new prices<\/button>/);
    expect(footerOf(markup)).not.toMatch(/disabled=""[^>]*>Back to editing<\/button>/);
  });

  it("holds Change price with the one-change line while a size's price or the settings hold a change (D2)", () => {
    const base = sizePriceDraftValue({ productVariantId: SIZE_A, expectedRevisionId: 7, exact: "14.99" });
    const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base });
    const sizeHolds = renderDrawer(reduceListingSettingsDraft(opened, { type: "edit", value: { ...base, exact: "12.00" } }));
    expect(sizeHolds).toMatch(/<button[^>]*disabled=""[^>]*>Change price<\/button>/);
    expect(sizeHolds).toContain('data-testid="drawer-price-line">Save or discard your other change first.</p>');
  });

  it("on a phone, Save reads Check new prices while the price holds a change, and the check says Nothing is saved yet with Back", () => {
    stubWidth(false);
    const change = renderDrawer(priceDraft(SET_RELEASE, null));
    expect(change).toContain('data-testid="product-drawer-not-saved">● Not saved · 1</span>');
    expect(change).toMatch(/<button[^>]*>Check new prices<\/button>/);
    expect(change).not.toMatch(/disabled=""[^>]*>Check new prices<\/button>/);
    expect(change).not.toContain(">Save</button>");
    const checked = renderDrawer(priceDraft(SET_RELEASE, CHECK));
    expect(footerOf(checked)).toContain("Nothing is saved yet.");
    expect(footerOf(checked)).toMatch(/<button[^>]*>Back<\/button>/);
    expect(footerOf(checked)).not.toContain("Back to editing");
  });

  it("after the apply, the check is gone and the drawer's rows show again with Saved", () => {
    const saving = reduceListingSettingsDraft(priceDraft(SET_RELEASE, CHECK), { type: "startSave", attempt: { signature: "s", key: "ls-price-check:k1" } });
    const saved = reduceListingSettingsDraft(saving, { type: "saved", key: "ls-price-check:k1", nowMs: 1_000, viewStale: false })!;
    draftsValue(saved);
    (state.drafts as ListingSettingsDraftsValue).savedFlashVisible = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
    client.setQueryData(listingSettingsProductQueryOptions(STORE, PRODUCT).queryKey, DETAIL);
    client.setQueryData(listingSettingsProductOwnQueryOptions(STORE, PRODUCT).queryKey, ownWith(RETAIL_20_UP, 9));
    const markup = render(React.createElement(ProductDrawer, {
      storeConnectionId: STORE, storeName: "Marz Cards", target: { productId: PRODUCT }, rights: RIGHTS, setup: SETUP, summaryRecipe: RETAIL_20_UP,
      onClose: noop, saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop, onGoToStep1: noop, onGoToStep3: noop,
    }), client);
    expect(markup).not.toContain('data-testid="price-check"');
    expect(markup).toContain('data-testid="drawer-settings"');
    expect(markup).toContain('<span role="status" class="text-sm text-zinc-700">Saved</span>');
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Change price<\/button>/);
  });
});

// ---------------------------------------------------------------------------
// "Set for selected" with a price draft (plan 7.2, D2, D20)
// ---------------------------------------------------------------------------

const BULK_RIGHTS: BulkSettingsRights = { bulkSettings: EDITABLE, shipping: EDITABLE, policies: EDITABLE, ebayCategory: EDITABLE, shelfPick: EDITABLE, priceCheck: EDITABLE };
const PICKED = [{ productId: 11, expectedRevisionId: 5 }, { productId: 12, expectedRevisionId: null }, { productId: 13, expectedRevisionId: 9 }] as const;

function tick(...productIds: number[]): ListingSettingsSelection {
  return productIds.map((productId) => ({ type: "toggle" as const, productId })).reduce(reduceListingSettingsSelection, emptySelection(STORE));
}

/** The sheet's price draft on PICKED with `change` and, when given, its check; or its settings draft with a shipping change. */
function bulkPriceDraft(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">, check: PriceCheckRef | null): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: BULK_EDITOR_ID, place: "Set for selected", base: bulkPriceDraftValue(PICKED) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: bulkPriceDraftValue(PICKED, { ...change, check }) })!;
}

function bulkSettingsDraft(): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: BULK_EDITOR_ID, place: "Set for selected", base: bulkDraftValue(PICKED) });
  const value = bulkDraftValue(PICKED);
  return reduceListingSettingsDraft(opened, { type: "edit", value: { ...value, shippingPolicy: { mode: "default" } } })!;
}

function renderSheet(draft: ListingSettingsDraft | null, overrides: Partial<BulkSettingsSheetProps> = {}): string {
  draftsValue(draft);
  const selection = tick(11, 12, 13);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  client.setQueryData(listingSettingsProductIdsQueryOptions(STORE, { search: "", show: "all" }).queryKey,
    listingSettingsProductIdsResponseSchema.parse({ total: 3, rows: PICKED.map((product) => ({ productId: product.productId, revisionId: product.expectedRevisionId })) }));
  return render(React.createElement(BulkSettingsSheet, {
    storeConnectionId: STORE, open: true, selection, rights: BULK_RIGHTS, summaryRecipe: RETAIL_20_UP, setup: SETUP, shelves: null,
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop }, onSaved: noop, onClose: noop, onSavedFor: noop, ...overrides,
  }), client);
}

function rowOf(markup: string, key: string): string {
  const start = markup.indexOf(`data-testid="drawer-setting-${key}"`);
  expect(start, key).toBeGreaterThan(-1);
  const rest = markup.slice(start + 1);
  const next = /data-testid="drawer-setting-[A-Za-z]+"/.exec(rest);
  return markup.slice(start, next === null ? markup.indexOf('data-testid="bulk-settings-footer"') : start + 1 + next.index);
}

describe("Set for selected's Price row (plan 7.2; D2, D20)", () => {
  it("shows the price change under the Price row and holds every other row, with the footer's Save as Check new prices", () => {
    const markup = renderSheet(bulkPriceDraft(SET_RELEASE, null));
    const price = rowOf(markup, "price");
    expect(price).toContain('data-testid="drawer-setting-price-pending">→ Retail price + 20%, round up to .99 · Clear exact prices too · Not saved</p>');
    expect(price).toMatch(/<button[^>]*aria-describedby="[^"]+"[^>]*>Change<\/button>/);
    expect(price).not.toMatch(/<button[^>]*disabled=""[^>]*>Change<\/button>/);
    for (const key of ["shippingPolicy", "returnPolicy", "paymentPolicy", "ebayCategory", "storeShelf", "descriptionTemplate"]) {
      expect(rowOf(markup, key), key).toMatch(/<button[^>]*disabled=""[^>]*>Change<\/button>/);
      expect(rowOf(markup, key), key).toContain("Save or discard your other change first.");
    }
    const footer = markup.slice(markup.indexOf('data-testid="bulk-settings-footer"'));
    expect(footer).toContain('data-testid="bulk-settings-not-saved">● Not saved · 1 change</span>');
    expect(footer).toMatch(/<button[^>]*>Check new prices<\/button>/);
    expect(footer).not.toMatch(/disabled=""[^>]*>Check new prices<\/button>/);
    expect(footer).not.toContain("Save for 3 products");
    expect(markup).not.toContain('data-testid="price-check"');
    // A phone says what the button does too.
    stubWidth(false);
    const phone = renderSheet(bulkPriceDraft(SET_RELEASE, null));
    expect(phone.slice(phone.indexOf('data-testid="bulk-settings-footer"'))).toMatch(/<button[^>]*>Check new prices<\/button>/);
  });

  it("holds the Price row while the other rows hold a change (D2)", () => {
    const markup = renderSheet(bulkSettingsDraft());
    const price = rowOf(markup, "price");
    expect(price).toMatch(/<button[^>]*disabled=""[^>]*>Change<\/button>/);
    expect(price).toContain('data-testid="drawer-setting-price-line">Save or discard your other change first.</p>');
    expect(markup.slice(markup.indexOf('data-testid="bulk-settings-footer"'))).toMatch(/<button[^>]*>Save for 3 products<\/button>/);
  });

  it("with a check, shows the check in place of the rows, for the products the ids read gave (D6, D20)", () => {
    const markup = renderSheet(bulkPriceDraft(DEFAULT, CHECK));
    expect(markup).toContain("<h2>Set for 3 products</h2>");
    expect(markup).toContain('data-testid="price-check"');
    expect(markup).not.toContain('data-testid="bulk-settings-rows"');
    expect(markup).not.toContain('data-testid="bulk-settings-footer"');
    expect(text(markup)).toContain("Checking: Use default · Not saved yet");
    expect(footerOf(markup)).toMatch(/<button[^>]*>Back to editing<\/button>/);
    expect(footerOf(markup)).not.toMatch(/disabled=""[^>]*>Back to editing<\/button>/);
  });

  it("after a price apply saved with a stale view, shows the rows again with the price's Reload (D9)", () => {
    const saving = reduceListingSettingsDraft(bulkPriceDraft(DEFAULT, CHECK), { type: "startSave", attempt: { signature: "s", key: "k" } });
    const stale = reduceListingSettingsDraft(saving, { type: "saved", key: "k", nowMs: 1, viewStale: true })!;
    const markup = renderSheet(stale);
    expect(markup).not.toContain('data-testid="price-check"');
    expect(markup).toContain('data-testid="bulk-settings-rows"');
    const footer = markup.slice(markup.indexOf('data-testid="bulk-settings-footer"'));
    expect(footer).toContain("Saved. We couldn't load the latest view.");
    expect(footer).toMatch(/<button[^>]*>Reload<\/button>/);
    expect(footer).not.toMatch(/disabled=""[^>]*>Reload<\/button>/);
    // Every row can be changed again (a Done then starts the settings on the same products).
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Change<\/button>/);
  });

  it("offers no price change without W7's right, and says why", () => {
    const markup = renderSheet(bulkPriceDraft({ price: { mode: "leave" }, releaseExactPrices: false }, null), {
      rights: { ...BULK_RIGHTS, priceCheck: { editable: false, reason: "sign_in" } },
    });
    const price = rowOf(markup, "price");
    expect(price).not.toContain(">Change</button>");
    expect(price).toContain('data-testid="drawer-setting-price-line">Reconnect eBay to change this.</p>');
  });
});
