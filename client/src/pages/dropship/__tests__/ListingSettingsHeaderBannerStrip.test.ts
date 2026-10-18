import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingSettingsSummarySchema, type ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { CONNECTION_BANNER_KINDS, type ConnectionBanner, type ConnectionBannerKind } from "@/lib/dropship-listing-settings-access";
import { AttentionStrip, type AttentionStripProps } from "../listing-settings/AttentionStrip";
import { ConnectionBannerView, type ConnectionBannerViewProps } from "../listing-settings/ConnectionBanner";
import { ListingSettingsHeader } from "../listing-settings/ListingSettingsHeader";

/**
 * Every Button rendered in a test, with its words and its click handler: a
 * static render runs no events, so a test clicks by calling the handler.
 */
interface RenderedButton {
  text: string;
  onClick?: () => void;
  disabled?: boolean;
  props: Record<string, unknown>;
}
const buttons: RenderedButton[] = [];

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement<{ children?: unknown }>(node)) return textOf(node.props.children);
  return "";
}

vi.mock("@/components/ui/button", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode; asChild?: boolean; onClick?: () => void; disabled?: boolean };
  return {
    Button: ({ asChild, children, variant: _variant, size: _size, ...rest }: Props) => {
      buttons.push({ text: textOf(children).trim(), onClick: rest.onClick, disabled: rest.disabled, props: rest });
      // asChild: the child is the element (a link); the rest of the props would be merged onto it.
      return asChild ? children : createElement("button", rest, children);
    },
  };
});

/** Radix renders popovers and sheets into a portal, which a static render leaves out; these render in place. */
vi.mock("@/components/ui/popover", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Popover: ({ children }: Props) => createElement("div", { "data-mock": "popover" }, children),
    PopoverTrigger: ({ children }: Props) => children,
    PopoverContent: ({ children, align: _align, ...rest }: Props) => createElement("div", { "data-mock": "popover-content", ...rest }, children),
  };
});
vi.mock("@/components/ui/sheet", async () => {
  const { createElement } = await vi.importActual<typeof import("react")>("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Sheet: ({ open, children }: Props) => createElement("div", { "data-mock": "sheet", "data-open": String(open) }, children),
    SheetContent: ({ side, children }: Props) => createElement("div", { "data-mock": "sheet-content", "data-side": side }, children),
    SheetHeader: ({ children }: Props) => createElement("div", null, children),
    SheetTitle: ({ children }: Props) => createElement("h2", null, children),
    SheetDescription: ({ children }: Props) => createElement("p", null, children),
  };
});

const noop = () => undefined;
const STORE = "Marz Cards";
const portalHref = (path: string) => `/dropship-portal${path}`;

beforeEach(() => {
  buttons.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Node has no browser location, so the router renders from a fixed path. */
function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(React.createElement(Router, { ssrPath: "/dropship-portal/catalog/setup", children: node }));
}

/** The words a vendor reads: tags dropped, entities decoded, spaces collapsed. */
function visibleText(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A window whose `matchMedia` answers `wide` for every query. */
function stubWidth(wide: boolean): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({ matches: wide, media: query, addEventListener: noop, removeEventListener: noop }),
  });
}

function button(text: string): RenderedButton {
  const found = buttons.find((entry) => entry.text === text);
  if (!found) throw new Error(`No button "${text}" among ${JSON.stringify(buttons.map((entry) => entry.text))}`);
  return found;
}

/** The opening tag of the first element carrying this attribute text. */
function openingTag(markup: string, marker: string): string {
  const at = markup.indexOf(marker);
  if (at === -1) throw new Error(`No element with ${marker}`);
  const start = markup.lastIndexOf("<", at);
  return markup.slice(start, markup.indexOf(">", at) + 1);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

describe("ListingSettingsHeader", () => {
  it("titles the step for the store, with the intro, the timing line and \"When is that?\" (one store)", () => {
    const markup = render(React.createElement(ListingSettingsHeader, { storeName: STORE, ebayStoreCount: 1 }));
    const text = visibleText(markup);
    expect(markup).toContain('data-testid="listing-settings-header"');
    expect(markup).toContain("<h2");
    expect(text).toContain("Listing settings for Marz Cards");
    expect(text).toContain("Set your store defaults once. Give any size an exact price in Products.");
    expect(text).toContain("Saved settings go to eBay the next time a listing is sent: when you publish it, or when Card Shellz updates it. When is that?");
    expect(markup).toContain('<button type="button"');
    // The popover's words (rendered in place by the stand-in).
    expect(text).toContain("A listing goes to eBay when you publish it in step 3.");
    expect(text).toContain("Card Shellz also re-sends your live listings to keep their stock right.");
    expect(text).toContain("Each time, your settings are used as they are at that moment.");
    expect(text).not.toContain("These settings are for");
    expect(markup).toContain('data-mock="popover-content"');
  });

  it("tells a vendor with two eBay stores that these settings are for this store only", () => {
    const text = visibleText(render(React.createElement(ListingSettingsHeader, { storeName: STORE, ebayStoreCount: 2 })));
    expect(text).toContain("These settings are for Marz Cards only. Each store has its own.");
  });

  it("uses the short title and timing line on a phone, and opens the details as a bottom sheet", () => {
    stubWidth(false);
    const markup = render(React.createElement(ListingSettingsHeader, { storeName: STORE, ebayStoreCount: 2 }));
    const text = visibleText(markup);
    expect(text).toMatch(/^Listing settings Set your store defaults once\./);
    expect(text).not.toContain("Listing settings for Marz Cards");
    expect(text).toContain("Saved settings go to eBay the next time a listing is sent. When is that?");
    expect(text).not.toContain("when you publish it, or when Card Shellz updates it");
    expect(markup).not.toContain('data-mock="popover"');
    expect(markup).toContain('data-mock="sheet" data-open="false"');
    expect(markup).toContain('data-side="bottom"');
    expect(openingTag(markup, 'aria-haspopup="dialog"')).toContain('aria-expanded="false"');
    expect(text).toContain("These settings are for Marz Cards only. Each store has its own.");
  });

  it("drops the store from the title when it has no name", () => {
    const text = visibleText(render(React.createElement(ListingSettingsHeader, { storeName: "  ", ebayStoreCount: 1 })));
    expect(text).toMatch(/^Listing settings Set your store defaults once\./);
  });
});

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

interface BannerExpectation {
  message: string;
  button: string;
  /** The link's href, or null for a button that runs on the page. */
  href: string | null;
}

const SUPPORT = { button: "Email Card Shellz support", href: "mailto:support@cardshellz.com" };
const STORE_CONNECTION = { button: "Go to store connection", href: "/dropship-portal/onboarding" };

const BANNERS: Readonly<Record<ConnectionBannerKind, BannerExpectation>> = {
  account_inactive: { message: "Your dropship account isn't active, so listing settings can't be changed. Contact support.", ...SUPPORT },
  store_paused: { message: "Marz Cards is paused, so its settings can't be changed now.", ...SUPPORT },
  store_disconnecting: { message: "Marz Cards is being disconnected, so its settings can't be changed now.", ...STORE_CONNECTION },
  store_disconnected: { message: "Marz Cards is disconnected, so its settings can't be changed now.", ...STORE_CONNECTION },
  too_large: {
    message: "You've chosen more than 10,000 sizes. Settings can't be checked until you choose 10,000 or fewer.",
    button: "Go to step 1", href: null,
  },
  other_site: { message: "Card Shellz lists on eBay US only. Marz Cards is set up for another eBay site. Contact support.", ...SUPPORT },
  selling_paused: {
    message: "Selling is paused on your account. Prices, products and categories can't be changed until it resumes.",
    button: "Go to Wallet", href: "/dropship-portal/wallet",
  },
  ops_inactive: {
    message: "Your Shellz Club .ops access is inactive, so prices, products and categories can't be changed. Contact support.",
    ...SUPPORT,
  },
  sign_in: {
    message: "eBay needs you to sign in again for Marz Cards. You can still change prices, text and defaults.",
    button: "Reconnect eBay", href: "/dropship-portal/onboarding",
  },
  access_denied: { message: "eBay won't let Card Shellz read Marz Cards. Signing in again won't fix this. Contact support.", ...SUPPORT },
  unreachable: { message: "Can't reach eBay right now. Your saved settings still apply.", button: "Try again", href: null },
};

function banner(kind: ConnectionBannerKind, overrides: Partial<ConnectionBannerViewProps> = {}, diagnosticReference: string | null = null) {
  const shown: ConnectionBanner = { kind, diagnosticReference };
  return render(React.createElement(ConnectionBannerView, {
    banner: shown, storeName: STORE, onRetry: noop, onGoToStep1: noop, portalHref, ...overrides,
  }));
}

describe("ConnectionBannerView", () => {
  it.each(CONNECTION_BANNER_KINDS.map((kind) => [kind]))("shows the %s banner with its words and its one button", (kind) => {
    const expected = BANNERS[kind];
    const markup = banner(kind);
    // One banner element, marked with its kind.
    expect(markup.split('data-testid="listing-settings-banner"').length - 1).toBe(1);
    expect(openingTag(markup, 'data-testid="listing-settings-banner"')).toContain(`data-kind="${kind}"`);
    expect(openingTag(markup, 'data-testid="listing-settings-banner"')).toContain('role="status"');
    // The button sits under the words on a phone and beside them from 640 px.
    expect(openingTag(markup, 'data-testid="listing-settings-banner"')).toContain("flex-col");
    expect(openingTag(markup, 'data-testid="listing-settings-banner"')).toContain("sm:flex-row");
    const text = visibleText(markup);
    expect(text).toBe(`${expected.message} ${expected.button}`);
    expect(buttons.map((entry) => entry.text)).toEqual([expected.button]);
    if (expected.href === null) {
      expect(markup).not.toContain("<a ");
    } else {
      const link = openingTag(markup, "<a ");
      expect(link).toContain(`href="${expected.href}"`);
      // A mail link opens the mail client and never a new tab.
      if (expected.href.startsWith("mailto:")) expect(link).not.toContain("target=");
    }
  });

  it("gives the support code when eBay sent one", () => {
    const text = visibleText(banner("access_denied", {}, "R-48213"));
    expect(text).toContain("eBay won't let Card Shellz read Marz Cards. Signing in again won't fix this. Contact support and give this code: R-48213.");
  });

  it("reads eBay again on Try again, and is off while that runs", () => {
    const onRetry = vi.fn();
    banner("unreachable", { onRetry });
    button("Try again").onClick?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button("Try again").disabled).toBe(false);

    buttons.length = 0;
    banner("unreachable", { onRetry, retrying: true });
    expect(button("Try again").disabled).toBe(true);
  });

  it("goes to step 1 through the step, which asks first when changes aren't saved", () => {
    const onGoToStep1 = vi.fn();
    banner("too_large", { onGoToStep1 });
    button("Go to step 1").onClick?.();
    expect(onGoToStep1).toHaveBeenCalledTimes(1);
  });

  it("names the store plainly when it has no name", () => {
    expect(visibleText(banner("store_paused", { storeName: " " }))).toContain("Your eBay store is paused, so its settings can't be changed now.");
  });
});

// ---------------------------------------------------------------------------
// Strip
// ---------------------------------------------------------------------------

type AttentionItem = ListingSettingsSummary["attention"]["items"][number];

function summary(items: AttentionItem[], total = items.length, missingPolicy: ListingSettingsSummary["rail"]["missingPolicy"] = null): ListingSettingsSummary {
  return listingSettingsSummarySchema.parse({
    storeConnectionId: 22,
    storeStatus: "connected",
    access: { allowed: true },
    catalog: { state: "ok", products: 3, sizes: 9 },
    storeDefaults: {
      price: { recipe: null, groupRules: 0 },
      shippingPolicy: { policyId: null, verification: "not_checked" },
      returnPolicy: { policyId: null, verification: "not_checked" },
      paymentPolicy: { policyId: null, verification: "not_checked" },
      ebayCategory: { category: null, groupRules: 0 },
      description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
    },
    counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
    attention: { items, total },
    rail: { state: "all_set", productsNeedingFix: 0, missingPolicy },
    generatedAt: "2026-10-09T12:00:00.000Z",
  });
}

const item = (code: AttentionItem["code"], extra: Partial<AttentionItem> = {}): AttentionItem => ({
  code, count: 1, productId: null, productName: null, ...extra,
});

function strip(overrides: Partial<AttentionStripProps>): string {
  return render(React.createElement(AttentionStrip, {
    summary: { data: summary([]) }, bannerShown: false, storeName: STORE, onAction: noop, onRetry: noop, portalHref, ...overrides,
  }));
}

describe("AttentionStrip", () => {
  it("keeps the server's order, with one button a line, and \"And N more.\" [See all]", () => {
    const onAction = vi.fn();
    const items = [
      item("choose_store_policies", { count: 3 }),
      item("size_cannot_be_priced", { productId: 12, productName: "Easy Glide Soft Sleeves" }),
      item("no_ebay_category", { productId: 11, productName: "Shellz Pro Toploader 35pt" }),
    ];
    const markup = strip({ summary: { data: summary(items, 6, "shipping") }, onAction });
    expect(visibleText(markup)).toBe([
      "Needs your attention",
      "● Choose your shipping, return and payment policies. Nothing can be listed until you do. Choose",
      "● Easy Glide Soft Sleeves can't be listed: a size can't be priced. Fix",
      "● Shellz Pro Toploader 35pt can't be listed: it has no eBay category. Fix",
      "And 3 more. See all",
    ].join(" "));
    expect(openingTag(markup, 'data-testid="listing-settings-attention"')).toContain('data-state="lines"');
    expect(markup.indexOf('data-code="choose_store_policies"')).toBeLessThan(markup.indexOf('data-code="size_cannot_be_priced"'));
    expect(markup.indexOf('data-code="size_cannot_be_priced"')).toBeLessThan(markup.indexOf('data-code="no_ebay_category"'));

    expect(buttons.map((entry) => entry.text)).toEqual(["Choose", "Fix", "Fix", "See all"]);
    for (const entry of buttons) entry.onClick?.();
    expect(onAction.mock.calls.map(([action]) => action)).toEqual([
      { kind: "open_store_default", label: "Choose", field: "shipping" },
      { kind: "open_product", label: "Fix", productId: 12, fix: "size_cannot_be_priced" },
      { kind: "open_product", label: "Fix", productId: 11, fix: "no_ebay_category" },
      { kind: "show_products", label: "See all", show: "needs_fix" },
    ]);
  });

  it("a can't-be-priced line with no product opens Give these sizes a price; a one-product line keeps the drawer (PR 10f, UX-M2)", () => {
    const onAction = vi.fn();
    const items = [
      item("size_cannot_be_priced", { count: 3, productId: null, productName: null }),
      item("size_cannot_be_priced", { productId: 12, productName: "Easy Glide Soft Sleeves" }),
    ];
    const markup = strip({ summary: { data: summary(items) }, onAction });
    expect(visibleText(markup)).toBe([
      "Needs your attention",
      "● A product can't be listed: a size can't be priced. Fix",
      "● Easy Glide Soft Sleeves can't be listed: a size can't be priced. Fix",
    ].join(" "));
    expect(buttons.map((entry) => entry.text)).toEqual(["Fix", "Fix"]);
    for (const entry of buttons) entry.onClick?.();
    expect(onAction.mock.calls.map(([action]) => action)).toEqual([
      { kind: "open_size_prices", label: "Fix" },
      { kind: "open_product", label: "Fix", productId: 12, fix: "size_cannot_be_priced" },
    ]);
  });

  it("names only the two policies that aren't set", () => {
    const onAction = vi.fn();
    const base = summary([item("choose_store_policies", { count: 2 })], 1, "return");
    // The shipping policy is set; return and payment are not.
    const shippingSet = listingSettingsSummarySchema.parse({
      ...base, storeDefaults: { ...base.storeDefaults, shippingPolicy: { policyId: "ship-1", verification: "not_checked" } },
    });
    const markup = strip({ summary: { data: shippingSet }, onAction });
    expect(visibleText(markup)).toBe("Needs your attention ● Choose your return and payment policies. Nothing can be listed until you do. Choose");
    button("Choose").onClick?.();
    expect(onAction).toHaveBeenCalledWith({ kind: "open_store_default", label: "Choose", field: "return" });
  });

  it("leaves out the reconnect line while a banner shows, and keeps it as a link when none does", () => {
    const onAction = vi.fn();
    const items = [item("reconnect_store"), item("own_text_needs_check", { count: 2 })];
    const withBanner = strip({ summary: { data: summary(items) }, bannerShown: true, onAction });
    // The own-text line keeps its record words; only its button changed (PR 10g, plan 10.6): [Check] opens
    // "Card Shellz updated products", never the Products filter.
    expect(visibleText(withBanner)).toBe(
      "Needs your attention ● Card Shellz updated 2 products that have your own text. Check that it still fits. Check",
    );
    expect(withBanner).not.toContain("Show products");
    button("Check").onClick?.();
    expect(onAction).toHaveBeenCalledWith({ kind: "open_updated_products", label: "Check" });

    buttons.length = 0;
    const withoutBanner = strip({ summary: { data: summary(items) }, bannerShown: false });
    expect(visibleText(withoutBanner)).toContain("● Reconnect eBay for Marz Cards. Reconnect eBay");
    expect(openingTag(withoutBanner, "<a ")).toContain('href="/dropship-portal/onboarding"');
    expect(buttons.map((entry) => entry.text)).toEqual(["Reconnect eBay", "Check"]);
  });

  it("says nothing needs the vendor when the list is empty", () => {
    const markup = strip({ summary: { data: summary([]) } });
    expect(visibleText(markup)).toBe("Needs your attention ✓ Nothing here needs you. Step 3 checks the rest, like stock, photos and your wallet.");
    expect(buttons).toEqual([]);
  });

  it("says it is checking while the summary loads", () => {
    const markup = strip({ summary: {} });
    expect(visibleText(markup)).toBe("Needs your attention Checking your products…");
    expect(openingTag(markup, 'data-testid="listing-settings-attention"')).toContain('aria-busy="true"');
  });

  it("offers Try again when the summary failed", () => {
    const onRetry = vi.fn();
    const markup = strip({ summary: { error: new Error("down") }, onRetry });
    expect(visibleText(markup)).toBe("Needs your attention Couldn't check your products. Try again");
    button("Try again").onClick?.();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the selection is too large to check (the banner says why)", () => {
    const tooLarge = listingSettingsSummarySchema.parse({
      ...summary([]),
      catalog: { state: "too_large", limit: 10_000 },
      counts: null,
      rail: { state: "too_many_sizes", productsNeedingFix: 0, missingPolicy: null },
    });
    expect(strip({ summary: { data: tooLarge }, bannerShown: true })).toBe("");
  });
});
