import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, type UseQueryResult } from "@tanstack/react-query";
import { Router } from "wouter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingSettingsSummarySchema, type ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { ebayListingSetupQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import { bannerFromWriteError, listingSettingsEditRights, type ListingSettingsEditRights } from "@/lib/dropship-listing-settings-access";
import type { ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import {
  DropshipApiError,
  type DropshipEbayListingSetupResponse,
  type DropshipEbayStoreCategoryResponse,
  type DropshipStoreConnectionSummary,
} from "@/lib/dropship-ops-surface";
import type { UnsavedDraft } from "@/lib/dropship-unsaved-changes";
import type { ListingSettingsDraftsValue } from "../listing-settings/ListingSettingsDraftsProvider";
import { ListingSettingsDraftsProvider } from "../listing-settings/ListingSettingsDraftsProvider";
import {
  ListingSettingsActionBar,
  ListingSettingsStep,
  countEbayStores,
  nextTabsRequest,
  policyRowRight,
  type ListingSettingsStepProps,
  type ListingSettingsStepRead,
} from "../listing-settings/ListingSettingsStep";

/**
 * The Listing settings step's shell and its place on the Catalog page
 * (Listing settings PR 7, plan 3A and 4.1). The page wiring is checked on the
 * source, as the other Catalog page tests do; the shell is rendered with stub
 * reads and checked on its markup.
 */

/** What a test sets in place of the real guard drafts and step draft; null keeps the real ones. */
const state = vi.hoisted(() => ({
  guardDrafts: null as readonly UnsavedDraft[] | null,
  drafts: null as unknown,
}));

vi.mock("../catalog/UnsavedChangesGuard", async () => {
  const actual = await vi.importActual<typeof import("../catalog/UnsavedChangesGuard")>("../catalog/UnsavedChangesGuard");
  return { ...actual, useUnsavedDrafts: () => state.guardDrafts ?? actual.useUnsavedDrafts() };
});

vi.mock("../listing-settings/ListingSettingsDraftsProvider", async () => {
  const actual = await vi.importActual<typeof import("../listing-settings/ListingSettingsDraftsProvider")>(
    "../listing-settings/ListingSettingsDraftsProvider");
  return {
    ...actual,
    useListingSettingsDrafts: () => (state.drafts as ListingSettingsDraftsValue | null) ?? actual.useListingSettingsDrafts(),
  };
});

/** Radix renders sheets into a portal, which a static render leaves out; the drawer renders in place while open. */
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
  };
});

const STORE_ID = 5;
const STORE = "Marz Cards";
const STAMP = "2026-09-30T12:00:00.000Z";
const noop = () => undefined;
const resolved = () => Promise.resolve();

beforeEach(() => {
  state.guardDrafts = null;
  state.drafts = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function setupAnswer(overrides: Partial<DropshipEbayListingSetupResponse> = {}): DropshipEbayListingSetupResponse {
  return {
    storeConnectionId: STORE_ID,
    marketplaceId: "EBAY_US",
    complete: true,
    missingFields: [],
    fulfillmentCapability: null,
    revision: 3,
    access: { canEdit: true, reason: null },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    storedNames: { fulfillmentPolicyName: "USPS Ground Advantage", returnPolicyName: "30-day returns", paymentPolicyName: "Managed payments" },
    storeShelfDefault: null,
    selection: { merchantLocationKey: "managed", fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" },
    options: {
      merchantLocations: [{ id: "managed", name: "Managed" }],
      fulfillmentPolicies: [{ id: "ground", name: "USPS Ground Advantage", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [{ id: "returns", name: "30-day returns" }],
      paymentPolicies: [{ id: "payments", name: "Managed payments" }],
    },
    ...overrides,
  };
}

function summaryAnswer(overrides: Partial<ListingSettingsSummary> = {}): ListingSettingsSummary {
  const policy = (policyId: string) => ({ policyId, verification: "not_checked" as const });
  return listingSettingsSummarySchema.parse({
    storeConnectionId: STORE_ID,
    storeStatus: "connected",
    access: { allowed: true },
    catalog: { state: "ok", products: 1, sizes: 1 },
    storeDefaults: {
      price: { recipe: null, groupRules: 0 },
      shippingPolicy: policy("ground"),
      returnPolicy: policy("returns"),
      paymentPolicy: policy("payments"),
      ebayCategory: { category: null, groupRules: 0 },
      description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
    },
    counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
    attention: { items: [], total: 0 },
    rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: null },
    generatedAt: STAMP,
    ...overrides,
  });
}

function read<T>(data: T | undefined, error: unknown = null): ListingSettingsStepRead<T> {
  return { data, error, isFetching: false, refetch: resolved };
}

const SHELVES: Pick<DropshipEbayStoreCategoryResponse, "categories"> = { categories: [] };

function stepProps(overrides: Partial<ListingSettingsStepProps> = {}): ListingSettingsStepProps {
  return {
    storeConnectionId: STORE_ID,
    storeName: STORE,
    ebayStoreCount: 1,
    account: { status: "active", entitlementStatus: "active" },
    summary: read(summaryAnswer()),
    shelves: read(SHELVES),
    saveCallbacks: { onSaveStarted: noop, onSaveSettled: noop },
    onSettingsSaved: noop,
    goToStep: noop,
    ...overrides,
  };
}

/** Node has no browser location: the router renders from a fixed address, with the drawer's query when given. */
function render(node: React.ReactElement, options: { setup?: DropshipEbayListingSetupResponse | null; address?: string } = {}): string {
  vi.stubGlobal("React", React);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.setup !== null) client.setQueryData(ebayListingSetupQueryKey(STORE_ID), options.setup ?? setupAnswer());
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(Router, { ssrPath: options.address ?? "/dropship-portal/catalog/setup",
      children: React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE_ID, children: node }) })));
}

function renderStep(overrides: Partial<ListingSettingsStepProps> = {}, options: Parameters<typeof render>[1] = {}): string {
  return render(React.createElement(ListingSettingsStep, stepProps(overrides)), options);
}

/** Where each testid first appears, so a test can check their order. */
function positions(markup: string, testIds: readonly string[]): number[] {
  return testIds.map((testId) => markup.indexOf(`data-testid="${testId}"`));
}

function expectInOrder(markup: string, testIds: readonly string[]) {
  const found = positions(markup, testIds);
  testIds.forEach((testId, index) => expect(found[index], testId).toBeGreaterThan(-1));
  expect([...found].sort((left, right) => left - right)).toEqual(found);
}

// ---------------------------------------------------------------------------
// The page wiring (source)
// ---------------------------------------------------------------------------

describe("Catalog page wiring of the Listing settings step", () => {
  const source = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
  const setupStart = source.indexOf('{activeStep === "setup" && (');
  const setupBlock = source.slice(setupStart, source.indexOf('{activeStep === "publish" && (', setupStart));
  const OLD_PANELS = ["<EbayListingSetupPanel", "<EbayListingPolicyOverridePanel", "<DropshipEbayCategoryRulesPanel",
    "<EbayStoreCategoryAssignmentPanel", "<DropshipPricingRulesPanel", "<DropshipContentTemplatesPanel"];

  it("mounts the new step first, then Older settings around today's step 2 intro and panels", () => {
    expect(setupStart).toBeGreaterThan(-1);
    // One setup block only, so the other Catalog page tests read the same one.
    expect(source.split('{activeStep === "setup" && (').length - 1).toBe(1);
    const step = setupBlock.indexOf("<ListingSettingsStep");
    const older = setupBlock.indexOf("<OlderListingSettings");
    const intro = setupBlock.indexOf('<CatalogStepIntro step="setup"');
    const olderEnd = setupBlock.indexOf("</OlderListingSettings>");
    expect(step).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(step);
    expect(intro).toBeGreaterThan(older);
    expect(olderEnd).toBeGreaterThan(intro);
    // The step only for a launch-ready eBay store; with none, the old notice shows plainly.
    expect(setupBlock).toContain("{storeReady && (\n              <ListingSettingsStep");
    expect(setupBlock).toContain("<OlderListingSettings collapsible={storeReady} open={olderOpen} onOpenChange={setOlderOpen} unsaved={olderUnsaved}>");
  });

  it("keys the step by store with a key no other sibling uses", () => {
    const key = /<ListingSettingsStep\s+key=\{`([^`]*)`\}/.exec(source)?.[1];
    expect(key).toBe("listing-settings-${selectedStoreConnectionIdNumber}");
    expect(source.split("<ListingSettingsStep").length - 1).toBe(1);
    expect(source).not.toContain("key={selectedStoreConnectionIdNumber}");
  });

  it("keeps each of today's six panels inside Older settings, once each", () => {
    const older = setupBlock.slice(setupBlock.indexOf("<OlderListingSettings"), setupBlock.indexOf("</OlderListingSettings>"));
    for (const panel of OLD_PANELS) {
      expect(older, panel).toContain(panel);
      expect(source.split(panel).length - 1, panel).toBe(1);
    }
    // The setup panel's lone-policy suggestion counts only while Older settings is open (L2).
    const setupTag = older.slice(older.indexOf("<EbayListingSetupPanel"), older.indexOf("/>", older.indexOf("<EbayListingSetupPanel")));
    expect(setupTag).toContain("suggestionsCountAsUnsaved={olderOpen}");
  });

  it("adds no second eBay-store block before the category rules panel", () => {
    const ebayBlock = '{selectedStoreConnection?.platform === "ebay" && (';
    expect(source.split(ebayBlock).length - 1).toBe(1);
    expect(source.indexOf(ebayBlock)).toBeLessThan(source.indexOf("<DropshipEbayCategoryRulesPanel"));
    expect(source.indexOf(ebayBlock)).toBeGreaterThan(source.indexOf("<OlderListingSettings"));
  });

  it("passes the step the page's reads, the save counter without its preview, and a guarded way to other steps", () => {
    const tag = source.slice(source.indexOf("<ListingSettingsStep"), source.indexOf("/>", source.indexOf("<ListingSettingsStep")));
    expect(tag).toContain("storeConnectionId={selectedStoreConnectionIdNumber}");
    expect(tag).toContain("account={listingAccount}");
    expect(tag).toContain("summary={listingSettingsSummaryQuery}");
    expect(tag).toContain("shelves={ebayStoreCategoryQuery}");
    expect(tag).toContain("saveCallbacks={listingSettingsSaveCallbacks}");
    expect(tag).toContain("onSettingsSaved={() => { invalidateListingPreview(true); refreshListingSettings(); }}");
    expect(tag).toContain("goToStep={(target) => leaveGuard(() => navigate(stepHref(target)))}");
    // D9, D10: the counter stays; the step never posts a new preview after a save.
    expect(source).toContain("const listingSettingsSaveCallbacks: ListingPriceSaveCallbacks = { ...priceSaveCallbacks, onSaved: async () => undefined };");
    // C28: counted from every store, not only the launch-ready ones.
    expect(source).toContain("const ebayStoreCount = countEbayStores(settingsQuery.data?.settings.storeConnections ?? []);");
  });

  it("shows the too-large banner from a list's refusal, and turns the lists off under a wider banner too", () => {
    const step = readFileSync(join(process.cwd(), "client/src/pages/dropship/listing-settings/ListingSettingsStep.tsx"), "utf8");
    const start = step.indexOf("<ListingSettingsTabs\n");
    expect(start).toBeGreaterThan(-1);
    const tabs = step.slice(start, step.indexOf("/>", start));
    expect(tabs).toContain("onTooLarge={onWriteBlocked}");
    expect(tabs).toContain('readOnly={banner?.kind === "too_large" || blocked?.kind === "too_large"}');
    // The refusal names the banner on its own, so nothing else is read again for it.
    expect(bannerFromWriteError(new DropshipApiError({ status: 422, code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", message: "x" })))
      .toEqual({ kind: "too_large", diagnosticReference: null });
  });

  it("holds the step's draft at page level, unkeyed, and gives Listing settings its own bar", () => {
    expect(source).toContain("return <ListingSettingsDraftsProvider storeConnectionId={selectedStoreConnectionIdNumber}>{page}</ListingSettingsDraftsProvider>;");
    expect(source).not.toMatch(/<ListingSettingsDraftsProvider\s+key=/);
    expect(source).toContain('{activeStep === "setup" && storeReady\n          ? <ListingSettingsActionBar next={nextAction} saving={pendingPriceSaves > 0} />\n          : <CatalogActionBar summary={actionBar.summary} next={nextAction} />}');
    expect(source).toContain("const olderUnsaved = countOlderSettingsDrafts(useUnsavedDrafts()) > 0;");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function connection(platform: string, status: string): Pick<DropshipStoreConnectionSummary, "platform" | "status"> {
  return { platform, status };
}

describe("countEbayStores", () => {
  it("counts every eBay store that is not disconnected, including one that needs a sign-in", () => {
    expect(countEbayStores([])).toBe(0);
    expect(countEbayStores([connection("ebay", "connected")])).toBe(1);
    expect(countEbayStores([
      connection("ebay", "connected"), connection("ebay", "needs_reauth"), connection("ebay", "refresh_failed"),
      connection("ebay", "paused"), connection("ebay", "grace_period"),
    ])).toBe(5);
    expect(countEbayStores([connection("ebay", "disconnected"), connection("shopify", "connected"), connection("ebay", "connected")])).toBe(1);
  });
});

describe("policyRowRight", () => {
  const rights = (setup: DropshipEbayListingSetupResponse): ListingSettingsEditRights => listingSettingsEditRights({
    account: { status: "active", entitlementStatus: "active" },
    summary: { storeStatus: "connected", catalog: { state: "ok", products: 1, sizes: 1 } },
    setup: { data: setup },
    shelves: { data: SHELVES },
    blocked: null,
  });

  it("uses the shipping right for Shipping and the policies right for Return and Payment", () => {
    // Card Shellz is still setting up shipping: only the shipping policy waits.
    const finishing = rights(setupAnswer({ checks: { ebay: "checked", fulfillment: { status: "unavailable", kind: "setup_incomplete", reference: "ref-1" } } }));
    expect(policyRowRight(finishing, "shipping")).toEqual({ editable: false, reason: "shipping_setup" });
    expect(policyRowRight(finishing, "return")).toEqual({ editable: true, reason: null });
    expect(policyRowRight(finishing, "payment")).toEqual({ editable: true, reason: null });
  });
});

describe("nextTabsRequest", () => {
  it("makes a new key every time, so the same filter asked twice is applied twice", () => {
    const first = nextTabsRequest(null, "needs_fix");
    expect(first).toEqual({ key: 1, show: "needs_fix" });
    const second = nextTabsRequest(first, "needs_fix");
    expect(second).toEqual({ key: 2, show: "needs_fix" });
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// The shell, rendered
// ---------------------------------------------------------------------------

const ROW_ORDER = ["price", "shipping", "return", "payment", "ebayCategory", "shelf", "description"] as const;

describe("ListingSettingsStep", () => {
  it("renders the header, the strip, the seven rows in the record's order, then the tabs", () => {
    const markup = renderStep();
    expect(markup).toContain('data-testid="listing-settings-step"');
    expectInOrder(markup, [
      "listing-settings-header",
      "listing-settings-attention",
      "store-defaults-card",
      ...ROW_ORDER.map((field) => `store-default-row-${field}`),
      "listing-settings-tabs",
    ]);
    expect(markup).toContain(`Listing settings for ${STORE}`);
    for (const label of ["Shipping policy", "Return policy", "Payment policy", "eBay category", "Description"]) {
      expect(markup).toContain(`aria-label="Change ${label}"`);
    }
    // No store price yet: the Price row offers [Set price]. No shelves on eBay: the shelf stays None, with nothing to pick.
    expect(markup).toContain("Set price");
    expect(markup).toContain("Your eBay store has no shelves.");
    // Everything is readable and nothing blocks: no banner, and the drawer is closed.
    expect(markup).not.toContain('data-testid="listing-settings-banner"');
    expect(markup).not.toContain('data-testid="product-drawer"');
  });

  it("puts the ship-from note under Shipping, before Return", () => {
    const outdated = setupAnswer({ complete: false, missingFields: ["merchantLocationKey"],
      selection: { merchantLocationKey: "old-warehouse", fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" } });
    const markup = renderStep({}, { setup: outdated });
    expectInOrder(markup, ["store-default-row-shipping", "ship-from-repair-note", "store-default-row-return"]);
    expect(markup).toContain("Card Shellz needs to update where your items ship from.");
  });

  it("names policies from the live setup read once it has answered (A4)", () => {
    const markup = renderStep();
    expect(markup).toContain("USPS Ground Advantage");
    expect(markup).toContain("30-day returns");
    expect(markup).toContain("Managed payments");
  });

  it("shows one banner when eBay can't be read, and keeps every row that needs it read-only", () => {
    const unreachable = new DropshipApiError({ status: 502, code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", message: "eBay did not answer." });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("React", React);
    // A refetch of the setup failed: React Query keeps the older answer beside the error, and the
    // step trusts the latest attempt, not the older answer.
    const now = Date.now();
    client.getQueryCache().build(client, { queryKey: ebayListingSetupQueryKey(STORE_ID) }).setState({
      data: setupAnswer(), dataUpdatedAt: now, status: "error", error: unreachable, errorUpdatedAt: now, fetchStatus: "idle",
    });
    const markup = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(Router, { ssrPath: "/dropship-portal/catalog/setup",
        children: React.createElement(ListingSettingsDraftsProvider, { storeConnectionId: STORE_ID,
          children: React.createElement(ListingSettingsStep, stepProps()) }) })));
    expect(markup.split('data-testid="listing-settings-banner"').length - 1).toBe(1);
    expect(markup).toContain('data-kind="unreachable"');
    expect(markup).toContain("Can&#x27;t reach eBay right now. Your saved settings still apply.");
    // Policies and the shelf save against the setup read; price, category and description don't.
    for (const label of ["Shipping policy", "Return policy", "Payment policy", "Store shelf"]) {
      expect(markup, label).not.toContain(`aria-label="Change ${label}"`);
    }
    for (const label of ["eBay category", "Description"]) {
      expect(markup, label).toContain(`aria-label="Change ${label}"`);
    }
    expect(markup).toContain("Set price");
  });

  it("shows the paused-store banner from the summary, and nothing can be changed", () => {
    const markup = renderStep({ summary: read(summaryAnswer({ storeStatus: "paused" })) });
    expect(markup).toContain('data-kind="store_paused"');
    expect(markup).toContain(`${STORE} is paused, so its settings can&#x27;t be changed now.`);
    expect(markup).not.toContain('aria-label="Change ');
    expect(markup).not.toContain("Set price");
  });

  it("turns the lists off while more than 10,000 sizes are chosen", () => {
    const markup = renderStep({ summary: read(summaryAnswer({
      catalog: { state: "too_large", limit: 10_000 }, counts: null,
    })) });
    expect(markup).toContain('data-kind="too_large"');
    expect(markup).not.toContain('aria-label="Change ');
    expect(markup).not.toContain("Set price");
    // The lists are not read and their search is off; the banner says why.
    expect(markup).not.toContain('data-testid="listing-settings-list-loading"');
    expect(markup).toMatch(/<input[^>]*disabled=""[^>]*placeholder="Search product, size or SKU"/);
  });

  it("waits for the account before offering any change", () => {
    const markup = renderStep({ account: null });
    expect(markup).not.toContain('aria-label="Change ');
    expect(markup).not.toContain("Set price");
    expect(markup).not.toContain('data-testid="listing-settings-banner"');
  });

  it("opens the drawer the address names, and only for a whole-number product id", () => {
    const open = renderStep({}, { address: "/dropship-portal/catalog/setup?product=11&size=101" });
    expect(open.split('data-testid="product-drawer"').length - 1).toBe(1);
    expect(open.indexOf('data-testid="product-drawer"')).toBeGreaterThan(open.indexOf('data-testid="listing-settings-tabs"'));
    for (const address of ["/dropship-portal/catalog/setup", "/dropship-portal/catalog/setup?product=abc",
      "/dropship-portal/catalog/setup?product=0", "/dropship-portal/catalog/setup?size=101"]) {
      expect(renderStep({}, { address }), address).not.toContain('data-testid="product-drawer"');
    }
  });

  it("type-checks against the page's React Query results", () => {
    // Compile-time only: the page passes its query results as they are.
    const summaryRead = (query: UseQueryResult<ListingSettingsSummary>): ListingSettingsStepProps["summary"] => query;
    const shelvesRead = (query: UseQueryResult<DropshipEbayStoreCategoryResponse>): ListingSettingsStepProps["shelves"] => query;
    expect(typeof summaryRead).toBe("function");
    expect(typeof shelvesRead).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// The bottom bar
// ---------------------------------------------------------------------------

function draft(overrides: Partial<ListingSettingsDraft> = {}): ListingSettingsDraft {
  return {
    editor: "price", place: "Price", base: {}, value: {}, changes: 0, marked: [], open: true, phase: "editing",
    message: null, code: null, attempt: null, savedAtMs: null, ...overrides,
  };
}

function draftsValue(current: ListingSettingsDraft | null): ListingSettingsDraftsValue {
  return {
    draft: current, savedFlashVisible: false, now: () => 0, open: () => true, edit: noop, startSave: () => null,
    settle: noop, rebase: noop, discard: noop, close: noop, requestClose: noop,
  };
}

function renderBar(saving = false): string {
  return render(React.createElement(ListingSettingsActionBar, {
    next: { label: "Next: Publish", href: "/dropship-portal/catalog/publish", disabled: false }, saving,
  }), { setup: null });
}

function barSummary(markup: string): string {
  const match = /data-testid="catalog-action-summary"[^>]*>([^<]*)</.exec(markup);
  return match?.[1] ?? "";
}

describe("ListingSettingsActionBar", () => {
  it("says All saved with nothing unsaved, as a polite live region, with the way to Publish", () => {
    const markup = renderBar();
    expect(barSummary(markup)).toBe("All saved");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Next: Publish");
  });

  it("names the step's draft and its change count", () => {
    state.drafts = draftsValue(draft({ place: "Shipping policy", changes: 1 }));
    expect(barSummary(renderBar())).toBe("Not saved · 1 change in Shipping policy");
    state.drafts = draftsValue(draft({ place: "Price", changes: 2 }));
    expect(barSummary(renderBar())).toBe("Not saved · 2 changes in Price");
  });

  it("names Older settings when only an old panel holds a change, and ignores the step's own guard entry", () => {
    state.guardDrafts = [{ id: "listing-setup:5", label: "eBay listing setup" }];
    expect(barSummary(renderBar())).toBe("Not saved · changes in Older settings");
    state.guardDrafts = [{ id: `listing-settings:${STORE_ID}`, label: "Price", changes: 1, discard: noop }];
    expect(barSummary(renderBar())).toBe("All saved");
  });

  it("says Saving… while any save on the page runs", () => {
    expect(barSummary(renderBar(true))).toBe("Saving…");
    state.drafts = draftsValue(draft({ changes: 1, phase: "saving" }));
    expect(barSummary(renderBar())).toBe("Saving…");
  });
});
