import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listingPriceSettingSchema, type ListingPriceSetting } from "@shared/dropship/listing-price";
import {
  listingSettingsProductDetailSchema,
  listingSettingsSizePriceSchema,
  type ListingSettingsProductDetail,
  type ListingSettingsSizePrice,
} from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { listingSettingsProductQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsReadState, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { productEditorId, reduceListingSettingsDraft, type ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import {
  drawerFooter,
  drawerSettingRows,
  drawerSizeEditState,
  drawerSizeLine,
  sizePriceDraftValue,
  sizePriceQueryKey,
  type DrawerSizeLine,
} from "@/lib/dropship-listing-settings-drawer";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-words";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { UnsavedChangesProvider } from "../catalog/UnsavedChangesGuard";
import { DrawerPriceSection, type DrawerPriceSectionProps } from "../listing-settings/DrawerPriceSection";
import { DrawerSettingRow } from "../listing-settings/DrawerSettingRow";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import { DrawerFooterBar, PRODUCT_DRAWER_CLASS, ProductDrawer, type ProductDrawerProps } from "../listing-settings/ProductDrawer";

/**
 * Radix renders a sheet into a portal, which a static render leaves out. This
 * stand-in renders the sheet in place and keeps the props the test checks.
 */
vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => (open ? createElement("div", { "data-mock": "sheet" }, children) : null),
    SheetContent: ({ side, children, className, "data-testid": testId }: Props) =>
      createElement("div", { "data-mock": "sheet-content", "data-side": side, "data-testid": testId, className }, children),
    SheetTitle: ({ children, className }: Props) => createElement("h2", { "data-mock": "sheet-title", className }, children),
  };
});

const STORE = 22;
const PRODUCT = 11;
const SIZE_A = 101;
const SIZE_B = 102;
const GENERATED_AT = "2026-10-09T12:00:00.000Z";
const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const EDITABLE: ListingSettingsRight = { editable: true, reason: null };
const noop = () => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sizePrice(overrides: Partial<ListingSettingsSizePrice> = {}): ListingSettingsSizePrice {
  return listingSettingsSizePriceSchema.parse({
    productVariantId: SIZE_A,
    productId: PRODUCT,
    productName: "Easy Glide Soft Sleeves",
    sizeName: "Box of 5 Packs of 100",
    sku: "EG-SLV-STD-5PCK-B500",
    priceCents: 1499,
    source: "exact",
    rule: null,
    basis: null,
    basisAmountCents: null,
    issue: null,
    costCents: 980,
    belowCostByCents: null,
    limits: [],
    pausedSince: null,
    settingRevisionId: 7,
    ...overrides,
  });
}

const RULES_B = sizePrice({
  productVariantId: SIZE_B, sizeName: "Pack of 100", sku: "EG-SLV-STD-100", priceCents: 499, source: "rules",
  rule: { kind: "store_default", name: "Store default rule", recipe: RETAIL_20_UP }, basis: "catalog_retail", basisAmountCents: 399,
  costCents: 210, settingRevisionId: null,
});

function detailWith(sizes: ListingSettingsSizePrice[], overrides: Partial<ListingSettingsProductDetail["product"]> = {}): ListingSettingsProductDetail {
  const ids = sizes.map((price) => price.productVariantId);
  const all = (value: unknown, source: "store_default" | "none" | "catalog" = "store_default") => [{ value, sources: [{ source, ruleName: null, productVariantIds: ids }] }];
  return listingSettingsProductDetailSchema.parse({
    storeConnectionId: STORE,
    product: {
      productId: PRODUCT,
      productName: "Easy Glide Soft Sleeves",
      category: "Sleeves",
      sizesChosen: sizes.length,
      sizesTotal: 4,
      priceRange: { minCents: 499, maxCents: 1499 },
      exactPriceCount: sizes.filter((price) => price.source === "exact").length,
      ownSettings: [],
      sizesDiffer: [],
      fixes: [],
      ...overrides,
    },
    settings: {
      shippingPolicy: all({ policyId: "ship-1" }),
      returnPolicy: all({ policyId: null }, "none"),
      paymentPolicy: all({ policyId: "pay-1" }),
      ebayCategory: all({ categoryId: "261328", categoryName: "Card Sleeves" }, "catalog"),
      storeShelf: all({ names: [] }, "none"),
      descriptionTemplate: all({ hasIntroduction: true, hasFooter: false, groupConflict: false }),
      mainText: all({ own: false }, "catalog"),
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
  },
  error: null,
};

function w9(overrides: Partial<ListingPriceSetting> = {}): ListingPriceSetting {
  return listingPriceSettingSchema.parse({
    storeConnectionId: STORE, productVariantId: SIZE_A, revisionId: 7, overridePriceCents: 1499, effectivePriceCents: 1499,
    defaultPriceCents: 1250, source: "override", pricingMode: "fixed", ruleName: "Store default rule", pricingIssue: null,
    rulePriceCents: 1599, rulesConfigured: true, ruleBasis: "catalog_retail", productCostCents: 980, updatedAt: GENERATED_AT,
    ...overrides,
  });
}

/** A window whose `matchMedia` answers `wide` for every query (the phone layout is below 640 px). */
function stubWidth(wide: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: wide, media: query, addEventListener: noop, removeEventListener: noop }),
  });
}

function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(node);
}

interface RenderOptions {
  props?: Partial<ProductDrawerProps>;
  /** The product read as React Query holds it: an answer, an error, or nothing yet. */
  detail?: ListingSettingsProductDetail | { error: unknown } | null;
  /** The size's own price read (W9), cached under its key. */
  sizePrice?: ListingPriceSetting;
  inspect?: (client: QueryClient) => void;
}

/** The drawer inside the providers the step gives it, with a query cache the test fills and checks before it is cleared. */
function renderDrawer({ props = {}, detail = DETAIL, sizePrice: price, inspect }: RenderOptions = {}): string {
  // A failed read stays failed on mount, as it does between a failure and [Try again].
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  const detailOptions = listingSettingsProductQueryOptions(STORE, PRODUCT);
  if (detail && "error" in detail) {
    const query = client.getQueryCache().build(client, detailOptions);
    query.setState({ status: "error", error: detail.error as Error, fetchStatus: "idle", errorUpdatedAt: 1, errorUpdateCount: 1 });
  } else if (detail) {
    client.setQueryData(detailOptions.queryKey, detail);
  }
  if (price) client.setQueryData(sizePriceQueryKey({ storeConnectionId: STORE, productVariantId: price.productVariantId }), price);
  try {
    const markup = render(React.createElement(QueryClientProvider, { client },
      React.createElement(UnsavedChangesProvider, null,
        React.createElement(ListingSettingsDraftsProvider, {
          storeConnectionId: STORE,
          now: () => 1_000,
          children: React.createElement(ProductDrawer, {
            storeConnectionId: STORE,
            storeName: "Marz Cards",
            target: { productId: PRODUCT },
            rights: { exactPrice: EDITABLE },
            setup: SETUP,
            summaryRecipe: RETAIL_20_UP,
            onClose: noop,
            saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
            onSaved: noop,
            onGoToStep1: noop,
            onGoToStep3: noop,
            ...props,
          }),
        }))));
    inspect?.(client);
    return markup;
  } finally {
    client.clear();
  }
}

/** The size price reads the drawer registered, as the options it gave React Query (it never fetched). */
function sizePriceReads(client: QueryClient) {
  return client.getQueryCache().findAll().filter((query) => String(query.queryKey[0]).includes("/variants/") || query.queryKey[0] === "listing-settings-drawer")
    .map((query) => ({ key: query.queryKey, enabled: (query.options as { enabled?: unknown }).enabled }));
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ");
}

describe("ProductDrawer", () => {
  it("renders nothing while the address names no product", () => {
    expect(renderDrawer({ props: { target: null } })).toBe("");
  });

  it("shows the header, the PRICE section and the read-only rows (R:591, R:245-266)", () => {
    const markup = renderDrawer();
    const words = text(markup);
    expect(markup).toContain('data-testid="product-drawer"');
    expect(markup).toContain('data-side="right"');
    expect(markup).toContain(`class="${PRODUCT_DRAWER_CLASS.replace(/&/g, "&amp;").replace(/>/g, "&gt;")}"`);
    expect(words).toContain("Easy Glide Soft Sleeves");
    expect(words).toContain("Card Shellz category: Sleeves · 2 of 4 sizes selected · No fixes needed");
    expect(words).toContain("Own settings: 1 exact price. Everything else uses your store defaults.");
    expect(words).toContain("Store default: Retail price + 20%, round up to .99");
    expect(words).toContain("Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500");
    expect(words).toContain("Exact price · Your cost $9.80 · 40 in stock");
    expect(words).toContain("Store default: retail $3.99 + 20%, up to .99 · Your cost $2.10 · 120 in stock");
    expect(words).toContain("Leave Exact price empty to use the price above.");
    expect(words).toContain("2 more sizes aren't selected. Choose them in step 1.");
    expect(words).toContain("See the full listing in step 3 ›");
    // × beside the size with an exact price only.
    expect(markup.match(/aria-label="Use the price above"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Exact price for Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500"');
    expect(markup).toContain('value="14.99"');
    // The desktop × closes; the phone ← does not show.
    expect(markup).toContain('aria-label="Close"');
    expect(markup).not.toContain('aria-label="Back"');
  });

  it("shows every other setting read-only, with where it comes from (C17)", () => {
    const words = text(renderDrawer());
    for (const label of ["Shipping policy", "Return policy", "Payment policy", "eBay category", "Store shelf", "Description"]) {
      expect(words).toContain(label);
    }
    expect(words).toContain("Free Standard US Store default");
    expect(words).toContain("Not set");
    expect(words).toContain("eBay payments Store default");
    expect(words).toContain("Card Sleeves Card Shellz picks");
    expect(words).toContain("Card Shellz text, with your text above Store default");
    expect(words).toContain("Main text: Card Shellz text");
    // Read-only: no buttons for the settings, and no ids or codes.
    expect(words).not.toMatch(/Set for this product|Change|261328|ship-1|pay-1|DROPSHIP_/);
  });

  it("starts with nothing to save", () => {
    const markup = renderDrawer();
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Discard<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Save product<\/button>/);
    expect(text(markup)).not.toContain("Not saved");
  });

  it("is full screen on a phone, with ← and Save (R:416-453)", () => {
    stubWidth(false);
    const markup = renderDrawer();
    const words = text(markup);
    expect(markup).toContain('aria-label="Back"');
    expect(markup).not.toContain('aria-label="Close"');
    expect(words).toContain("2 sizes · No fixes needed");
    expect(words).not.toContain("Card Shellz category: Sleeves");
    expect(markup).toMatch(/<button[^>]*>Save<\/button>/);
    expect(PRODUCT_DRAWER_CLASS).toContain("w-full");
  });

  it("says it is loading until the product is read", () => {
    const words = text(renderDrawer({ detail: null }));
    expect(words).toContain("Loading this product…");
    expect(words).toContain("Product");
    expect(words).not.toContain("Save product");
  });

  it("names the store when the product isn't chosen, with Go to step 1 (C27)", () => {
    const notFound = new DropshipApiError({ message: "Not found", status: 404, code: "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND" });
    const words = text(renderDrawer({ detail: { error: notFound } }));
    expect(words).toContain("This product isn't chosen for Marz Cards. Choose it in step 1.");
    expect(words).toContain("Go to step 1");
    expect(words).not.toContain("Try again");
  });

  it("offers Try again when the product can't be read", () => {
    const words = text(renderDrawer({ detail: { error: new TypeError("Failed to fetch") } }));
    expect(words).toContain("Couldn't load this product. Try again.");
    expect(words).toContain("Try again");
  });

  it("tells a size on its retail price why, and how to fix it (A3, L1)", () => {
    const fallback = sizePrice({ source: "retail_fallback", priceCents: 1250, settingRevisionId: 8 });
    const words = text(renderDrawer({ props: { summaryRecipe: null }, detail: detailWith([fallback, RULES_B]) }));
    expect(words).toContain("No store price yet. Set one in Store defaults.");
    expect(words).toContain("No pricing rule covers this size, so it uses the retail price ($12.50) · Your cost $9.80 · 40 in stock");
    expect(words).toContain("Set a store price or type a price.");
  });

  it("says why exact prices can't be changed, with every box read-only", () => {
    const markup = renderDrawer({ props: { rights: { exactPrice: { editable: false, reason: "loading" } } } });
    expect(text(markup)).toContain("Checking…");
    expect(markup.match(/readOnly=""/gi)?.length ?? 0).toBe(2);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Use the price above"|aria-label="Use the price above"[^>]*disabled=""/);
  });
});

describe("ProductDrawer reads (D8)", () => {
  it("reads no size's price until a size is in edit", () => {
    let reads: ReturnType<typeof sizePriceReads> = [];
    renderDrawer({ inspect: (client) => { reads = sizePriceReads(client); } });
    expect(reads).toEqual([{ key: ["listing-settings-drawer", "no-size-in-edit"], enabled: false }]);
  });

  it("reads the target size's price when the drawer opens on it", () => {
    let reads: ReturnType<typeof sizePriceReads> = [];
    renderDrawer({ props: { target: { productId: PRODUCT, productVariantId: SIZE_B } }, inspect: (client) => { reads = sizePriceReads(client); } });
    expect(reads).toEqual([{ key: ["/api/dropship/listings/stores/22/variants/102/price"], enabled: true }]);
  });

  it("does not read it while W9 would refuse a save", () => {
    let reads: ReturnType<typeof sizePriceReads> = [];
    renderDrawer({
      props: { target: { productId: PRODUCT, productVariantId: SIZE_B }, rights: { exactPrice: { editable: false, reason: "banner" } } },
      inspect: (client) => { reads = sizePriceReads(client); },
    });
    expect(reads).toEqual([{ key: ["/api/dropship/listings/stores/22/variants/102/price"], enabled: false }]);
  });

  it("ignores a size that isn't one of the product's chosen sizes", () => {
    let reads: ReturnType<typeof sizePriceReads> = [];
    renderDrawer({ props: { target: { productId: PRODUCT, productVariantId: 999 } }, inspect: (client) => { reads = sizePriceReads(client); } });
    expect(reads).toEqual([{ key: ["listing-settings-drawer", "no-size-in-edit"], enabled: false }]);
  });

  it("shows × off with its reason when the target size could not be priced without it", () => {
    const words = text(renderDrawer({
      props: { target: { productId: PRODUCT, productVariantId: SIZE_A } },
      sizePrice: w9({ rulePriceCents: null, rulesConfigured: false, defaultPriceCents: null }),
    }));
    expect(words).toContain("This size has no retail price, so it needs an exact price.");
  });
});

// ---------------------------------------------------------------------------
// The Price section and the footer in each draft state (stateless views)
// ---------------------------------------------------------------------------

const EDITOR = productEditorId(PRODUCT);

function draft(exact: string): ListingSettingsDraft {
  const base = { productVariantId: SIZE_A, expectedRevisionId: 7, exact: "14.99" };
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: sizePriceDraftValue(base) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: sizePriceDraftValue({ ...base, exact }) })!;
}

function lines(current: ListingSettingsDraft | null, sizePriceA: ListingPriceSetting | null = null, fieldError: string | null = null): DrawerSizeLine[] {
  return DETAIL.sizes.map((entry) => drawerSizeLine({
    size: entry,
    stock: DETAIL.stock,
    edit: drawerSizeEditState(current, EDITOR, entry.price),
    w9: entry.price.productVariantId === SIZE_A ? sizePriceA : null,
    editable: true,
    locked: false,
    fieldError: entry.price.productVariantId === SIZE_A ? fieldError : null,
  }));
}

function priceSection(overrides: Partial<DrawerPriceSectionProps> = {}): string {
  return render(React.createElement(DrawerPriceSection, {
    head: "Store default: Retail price + 20%, round up to .99",
    reason: null,
    waitingHint: null,
    sizes: lines(null),
    notChosen: null,
    onGoToStep1: noop,
    showAllLabel: null,
    onShowAll: noop,
    search: null,
    onEdit: noop,
    onClear: noop,
    onFocusSize: noop,
    ...overrides,
  }));
}

describe("DrawerPriceSection", () => {
  it("shows a typed price against the cost and the store price (R:250-252)", () => {
    const words = text(priceSection({ sizes: lines(draft("14.99 "), w9({ overridePriceCents: 1200, effectivePriceCents: 1200 })) }));
    expect(words).toContain("→ $14.99 · Not saved · store default would be $15.99");
    expect(words).toContain("$14.99 is $5.19 over your cost, before eBay fees and shipping.");
    expect(words).toContain("An exact price stays the same when your cost changes.");
  });

  it("holds every other size while one has a change (D4)", () => {
    const markup = priceSection({ sizes: lines(draft("12.00")), waitingHint: "Save or discard the price you changed first." });
    expect(text(markup)).toContain("Save or discard the price you changed first.");
    // Size B's box is read-only and points at the hint.
    const sizeB = markup.slice(markup.indexOf('data-testid="drawer-size-102"'));
    expect(sizeB).toMatch(/readOnly=""/i);
    expect(sizeB).toMatch(/aria-describedby="[^"]+"/);
    const sizeA = markup.slice(markup.indexOf('data-testid="drawer-size-101"'), markup.indexOf('data-testid="drawer-size-102"'));
    expect(sizeA).not.toMatch(/readOnly=""/i);
  });

  it("shows what clearing gives on a store with no store price (A3, L1)", () => {
    const words = text(priceSection({ sizes: lines(draft(""), w9({ rulePriceCents: null, rulesConfigured: false, ruleName: null })) }));
    expect(words).toContain("→ $12.50 · Not saved · uses the retail price");
    expect(words).toContain("No pricing rule covers this size, so it uses the retail price ($12.50).");
  });

  it("shows a refusal or a bad entry by the box", () => {
    const markup = priceSection({ sizes: lines(draft("14."), null, "Enter a price like 14.99.") });
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("Enter a price like 14.99.");
    expect(markup).toContain('aria-invalid="true"');
  });

  it("offers Show all and the size search", () => {
    const search = { value: "box", onChange: noop, noMatch: "No sizes match “box”." };
    const words = text(priceSection({ showAllLabel: "Show all 40 sizes", search, notChosen: "2 more sizes aren't selected. Choose them in step 1." }));
    expect(words).toContain("Show all 40 sizes");
    expect(words).toContain("No sizes match “box”.");
    expect(words).toContain("Clear search");
    expect(words).toContain("Go to step 1");
  });
});

describe("DrawerSettingRow", () => {
  it("lists each value with the sizes using it when the sizes differ (C16)", () => {
    const detail = listingSettingsProductDetailSchema.parse({
      ...DETAIL,
      product: { ...DETAIL.product, ownSettings: ["shipping_policy"], sizesDiffer: ["shipping_policy"] },
      settings: {
        ...DETAIL.settings,
        shippingPolicy: [
          { value: { policyId: "ship-1" }, sources: [{ source: "store_default", ruleName: null, productVariantIds: [SIZE_A] }] },
          { value: { policyId: "ship-2" }, sources: [{ source: "size", ruleName: null, productVariantIds: [SIZE_B] }] },
        ],
      },
    });
    const [shipping] = drawerSettingRows(detail, SETUP);
    const words = text(render(React.createElement(DrawerSettingRow, { row: shipping })));
    expect(words).toContain("Sizes have different values. Each size keeps its own for now.");
    expect(words).toContain("Free Standard US Store default used by Box of 5 Packs of 100");
    expect(words).toContain("A policy that's no longer on eBay Set on each size used by Pack of 100");
  });
});

describe("DrawerFooterBar", () => {
  const footerMarkup = (current: ListingSettingsDraft | null, compact = false, message: string | null = null) =>
    render(React.createElement(DrawerFooterBar, {
      footer: drawerFooter({ draft: current, editable: true, busy: false, clear: null, savedFlashVisible: false, compact }),
      message,
      onDiscard: noop,
      onPrimary: noop,
    }));

  it("counts the change, with Discard and Save product (R:272)", () => {
    const markup = footerMarkup(draft("12.00"));
    expect(text(markup)).toContain("● Not saved · 1 change");
    expect(markup).toMatch(/<button[^>]*>Discard<\/button>/);
    expect(markup).not.toMatch(/disabled=""[^>]*>Save product/);
  });

  it("is short on a phone (R:451-452)", () => {
    const words = text(footerMarkup(draft("12.00"), true));
    expect(words).toContain("● Not saved · 1");
    expect(words).not.toContain("1 change");
    expect(words).toContain("Save");
  });

  it("shows words outside the draft as an alert", () => {
    const markup = footerMarkup(draft("12.00"), false, "Wait for the current listing action to finish, then save again.");
    expect(markup).toContain('role="alert"');
    expect(text(markup)).toContain("Wait for the current listing action to finish, then save again.");
  });
});
