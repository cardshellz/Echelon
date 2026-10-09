import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingSettingsSummarySchema, type ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { ebayListingSetupQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import { CONNECTION_BANNER_KINDS, type ConnectionBanner, type ConnectionBannerKind } from "@/lib/dropship-listing-settings-access";
import type { DropshipEbayListingSetupResponse } from "@/lib/dropship-ops-surface";
import {
  EbayListingSetupPanel,
  buildEbayListingSetupDraft,
  listingSetupHasUnsavedChange,
  listingSetupHasUnsavedPolicy,
} from "../EbayListingSetupPanel";
import { AttentionStrip, type AttentionStripProps } from "../listing-settings/AttentionStrip";
import { ConnectionBannerView, type ConnectionBannerViewProps } from "../listing-settings/ConnectionBanner";
import { ListingSettingsHeader } from "../listing-settings/ListingSettingsHeader";
import { OlderListingSettings, type OlderListingSettingsProps } from "../listing-settings/OlderListingSettings";

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
vi.mock("../EbayStoreCategoryAuthorizationRecovery", () => ({
  EbayStoreCategoryAuthorizationRecovery: () => null,
}));

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
    message: "Selling is paused on your account. You can still change your policies and store shelf. Prices, eBay categories and descriptions can't be changed until it resumes.",
    button: "Go to Wallet", href: "/dropship-portal/wallet",
  },
  ops_inactive: {
    message: "Your Shellz Club .ops access is inactive, so prices, eBay categories and descriptions can't be changed. Contact support.",
    ...SUPPORT,
  },
  sign_in: {
    message: "eBay needs you to sign in again for Marz Cards. Your settings are safe. Until you do, you can still change prices and descriptions.",
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

  it("leaves out the reconnect line while a banner shows, and keeps it as a link when none does", () => {
    const items = [item("reconnect_store"), item("own_text_needs_check", { count: 2 })];
    const withBanner = strip({ summary: { data: summary(items) }, bannerShown: true });
    expect(visibleText(withBanner)).toBe(
      "Needs your attention ● Card Shellz updated 2 products that have your own text. Check that it still fits. Show products",
    );

    buttons.length = 0;
    const withoutBanner = strip({ summary: { data: summary(items) }, bannerShown: false });
    expect(visibleText(withoutBanner)).toContain("● Reconnect eBay for Marz Cards. Reconnect eBay");
    expect(openingTag(withoutBanner, "<a ")).toContain('href="/dropship-portal/onboarding"');
    expect(buttons.map((entry) => entry.text)).toEqual(["Reconnect eBay", "Show products"]);
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

// ---------------------------------------------------------------------------
// Older settings
// ---------------------------------------------------------------------------

/** Stand-ins for today's panels: each has its heading, as the real panels do. */
function oldPanels(): React.ReactElement {
  return React.createElement(React.Fragment, null,
    React.createElement("section", null, React.createElement("h2", null, "Policy overrides")),
    React.createElement("section", null, React.createElement("h2", null, "Listing pricing rules")));
}

function older(overrides: Partial<OlderListingSettingsProps>, children: React.ReactNode = oldPanels()): string {
  return render(React.createElement(OlderListingSettings, {
    collapsible: true, open: false, onOpenChange: noop, unsaved: false, ...overrides, children,
  }));
}

describe("OlderListingSettings", () => {
  it("keeps the panels in the page while closed, inside an element with the hidden attribute", () => {
    const markup = older({ open: false });
    const content = openingTag(markup, 'data-testid="older-listing-settings-content"');
    expect(content).toMatch(/ hidden=""/);
    // The panels' headings are still there, inside the hidden element.
    const contentAt = markup.indexOf(content);
    expect(markup.indexOf("Policy overrides")).toBeGreaterThan(contentAt);
    expect(markup.indexOf("Listing pricing rules")).toBeGreaterThan(contentAt);
    // No display class on it: one would override the hidden attribute.
    expect(content).not.toMatch(/\b(?:block|flex|grid)\b/);

    const toggle = openingTag(markup, "aria-expanded=");
    expect(toggle).toContain('aria-expanded="false"');
    const contentId = /id="([^"]+)"/.exec(content)?.[1];
    expect(contentId).toBeTruthy();
    expect(toggle).toContain(`aria-controls="${contentId}"`);
    const text = visibleText(markup);
    expect(text).toMatch(/^Older settings Per-size policies and shelves, group rules and text templates\. They still work\. Show older settings/);
    expect(text).not.toContain("Not saved");
    expect(openingTag(markup, 'data-testid="older-listing-settings"')).toContain('role="region"');
  });

  it("shows the panels when open, and the button hides them again", () => {
    const onOpenChange = vi.fn();
    const markup = older({ open: true, onOpenChange });
    expect(openingTag(markup, 'data-testid="older-listing-settings-content"')).not.toContain("hidden");
    expect(openingTag(markup, "aria-expanded=")).toContain('aria-expanded="true"');
    button("Hide older settings").onClick?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    buttons.length = 0;
    older({ open: false, onOpenChange });
    button("Show older settings").onClick?.();
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });

  it("says \"Not saved\" by the title while an older panel holds a change", () => {
    const markup = older({ unsaved: true });
    expect(visibleText(markup)).toMatch(/^Older settings ● Not saved Per-size policies/);
  });

  it("renders the panels plainly when it can't collapse (no eBay store ready)", () => {
    const markup = older({ collapsible: false, open: false, unsaved: true });
    expect(visibleText(markup)).toBe("Policy overrides Listing pricing rules");
    expect(markup).not.toContain("hidden");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).not.toContain('role="region"');
    expect(buttons).toEqual([]);
    expect(openingTag(markup, 'data-testid="older-listing-settings"')).toContain('data-collapsible="false"');
  });

  it("keeps one shape either way, so a change of collapsible never remounts the panels", () => {
    // The panels sit at the same place in the tree: the wrapper's second child.
    const open = older({ collapsible: true, open: true });
    const plain = older({ collapsible: false, open: true });
    const panelsIn = (markup: string) => markup.slice(markup.indexOf('data-testid="older-listing-settings-content"'));
    expect(panelsIn(open)).toContain("<section><h2>Policy overrides</h2></section>");
    expect(panelsIn(plain)).toContain("<section><h2>Policy overrides</h2></section>");
    const source = readFileSync(join(process.cwd(), "client", "src", "pages", "dropship", "listing-settings", "OlderListingSettings.tsx"), "utf8");
    // Not Radix forceMount: it leaves closed content visible (plan D3).
    expect(source).not.toMatch(/components\/ui\/collapsible|@radix-ui\/react-collapsible/);
    expect(source).not.toMatch(/<CollapsibleContent|\bforceMount\s*[={]/);
  });

  it("keeps a real old panel mounted while closed", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(ebayListingSetupQueryKey(44), setupResponse({}));
    const markup = render(React.createElement(QueryClientProvider, { client },
      React.createElement(OlderListingSettings, {
        collapsible: true, open: false, onOpenChange: noop, unsaved: false,
        children: React.createElement(EbayListingSetupPanel, { storeConnectionId: 44, storeName: STORE, onConfigurationChange: noop, suggestionsCountAsUnsaved: false }),
      })));
    const contentAt = markup.indexOf(openingTag(markup, 'data-testid="older-listing-settings-content"'));
    expect(openingTag(markup, 'data-testid="older-listing-settings-content"')).toContain('hidden=""');
    expect(markup.indexOf("eBay listing setup")).toBeGreaterThan(contentAt);
  });
});

// ---------------------------------------------------------------------------
// L2: the old setup panel's lone-policy suggestion while "Older settings" is closed
// ---------------------------------------------------------------------------

function setupResponse(overrides: Partial<DropshipEbayListingSetupResponse>): DropshipEbayListingSetupResponse {
  return {
    storeConnectionId: 44,
    marketplaceId: "EBAY_US",
    complete: false,
    missingFields: [],
    fulfillmentCapability: null,
    selection: { merchantLocationKey: null, fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
    options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] },
    ...overrides,
  };
}

const policyOption = (id: string, name: string) => ({ id, name, compatible: true, compatibilityIssues: [] });

/** eBay offers one payment policy and nothing is saved: Card Shellz fills it in. Two return policies: the vendor picks. */
const LONE_PAYMENT = setupResponse({
  options: {
    merchantLocations: [],
    fulfillmentPolicies: [policyOption("ship-standard", "Standard"), policyOption("ship-fast", "Fast")],
    returnPolicies: [{ id: "return-30", name: "Thirty days" }, { id: "return-60", name: "Sixty days" }],
    paymentPolicies: [{ id: "payment-managed", name: "Managed payments" }],
  },
});

describe("listingSetupHasUnsavedChange (L2)", () => {
  it("does not count a policy Card Shellz filled in when suggestions don't count, and does by default", () => {
    const draft = buildEbayListingSetupDraft(LONE_PAYMENT);
    expect(draft.paymentPolicyId).toBe("payment-managed");
    expect(listingSetupHasUnsavedChange(LONE_PAYMENT, draft, { countSuggestions: true })).toBe(true);
    expect(listingSetupHasUnsavedChange(LONE_PAYMENT, draft, { countSuggestions: false })).toBe(false);
  });

  it("always counts a policy the vendor picked", () => {
    const picked = { ...buildEbayListingSetupDraft(LONE_PAYMENT), returnPolicyId: "return-60" };
    expect(listingSetupHasUnsavedChange(LONE_PAYMENT, picked, { countSuggestions: false })).toBe(true);
    expect(listingSetupHasUnsavedChange(LONE_PAYMENT, picked, { countSuggestions: true })).toBe(true);
  });

  it("is today's rule when suggestions count", () => {
    const saved = setupResponse({
      ...LONE_PAYMENT,
      selection: { merchantLocationKey: null, fulfillmentPolicyId: "ship-fast", returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
    });
    const drafts = [
      buildEbayListingSetupDraft(LONE_PAYMENT),
      { fulfillmentPolicyId: "", returnPolicyId: "", paymentPolicyId: "" },
      { fulfillmentPolicyId: "ship-fast", returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
      { fulfillmentPolicyId: "ship-standard", returnPolicyId: "return-30", paymentPolicyId: "payment-managed" },
    ];
    for (const setup of [LONE_PAYMENT, saved]) {
      for (const draft of drafts) {
        expect(listingSetupHasUnsavedChange(setup, draft, { countSuggestions: true })).toBe(listingSetupHasUnsavedPolicy(setup, draft));
      }
    }
    // A saved store has nothing filled in, so the suggestion rule changes nothing there.
    for (const draft of drafts) {
      expect(listingSetupHasUnsavedChange(saved, draft, { countSuggestions: false })).toBe(listingSetupHasUnsavedPolicy(saved, draft));
    }
  });

  it("is wired to the leave guard and the badge, and is on by default", () => {
    const source = readFileSync(join(process.cwd(), "client", "src", "pages", "dropship", "EbayListingSetupPanel.tsx"), "utf8");
    expect(source).toContain("suggestionsCountAsUnsaved = true,");
    const unsavedPolicy = /const unsavedPolicy = useMemo\(([\s\S]*?)\n {2}\);/.exec(source)?.[1] ?? "";
    expect(unsavedPolicy).toContain("listingSetupHasUnsavedChange(setupQuery.data, draft, { countSuggestions: suggestionsCountAsUnsaved })");
    expect(unsavedPolicy).toContain("suggestionsCountAsUnsaved]");
    expect(source).toContain('useUnsavedDraft(`listing-setup:${storeConnectionId}`, "eBay listing setup", unsavedPolicy);');
    expect(source).toContain("eBay listing setup{unsavedPolicy && <NotSavedBadge />}");
    // Saving still works on a suggestion: Save is about what the server lacks, not what the guard reports.
    expect(source).toContain("const canSave = setupQuery.data !== undefined && listingSetupHasUnsavedPolicy(setupQuery.data, draft);");
    // One guard report only.
    expect(source.split("useUnsavedDraft(").length - 1).toBe(1);
  });
});
