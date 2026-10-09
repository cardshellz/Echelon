import { expect, test, type Page, type TestInfo } from "playwright/test";
import { join, resolve } from "node:path";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/** Where screenshots go when CATALOG_SHOTS_DIR is set (never in CI). */
const SHOTS_DIR = process.env.CATALOG_SHOTS_DIR ?? null;
/** The Catalog page's own addresses; the harness is served for each, so a reload keeps the step. */
const CATALOG_PATH = "/dropship-portal/catalog";
const STAMP = "2026-09-30T12:00:00.000Z";
const MEMBER_ID = "m-1";

interface StoreFixture { storeConnectionId: number; platform: string; name: string }
const MARZ: StoreFixture = { storeConnectionId: 5, platform: "ebay", name: "Marz Cards" };
const OUTLET: StoreFixture = { storeConnectionId: 9, platform: "ebay", name: "Marz Cards Outlet" };
const SHOP: StoreFixture = { storeConnectionId: 3, platform: "shopify", name: "Test Shop" };

const ROW = {
  productId: 11, productVariantId: 101, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: "ENV-SGL-P50",
  variantName: "Pack of 50", category: "Mailers", productLineIds: [], productLineNames: [], unitsPerVariant: 50,
  selectionDecision: { selected: true, reason: "selected", marketplaceQuantity: 25, quantityCapApplied: false, autoConnectNewSkus: true, autoListNewSkus: false },
  listingTier: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, reserveShortfallCents: 0, balanceShortfallCents: 0 },
};

function previewRow(storeConnectionId: number) {
  return {
    productVariantId: 101, productId: 11, sku: "ENV-SGL-P50", title: "Envelope Single Pocket, Pack of 50", platform: "ebay",
    listingMode: "create", currentListingStatus: "not_listed", previewStatus: "ready", blockers: [], warnings: [], marketplaceQuantity: 25,
    priceCents: 699, marketplaceCategoryId: "183435", marketplaceCategoryName: "Card Sleeves", storeCategoryNames: [],
    businessPolicySelection: null, previewHash: `${storeConnectionId}`.padStart(64, "d"), priceSettingRevisionId: null,
    contentEvidenceHash: "c".repeat(64),
  };
}

function listingSetup(storeConnectionId: number) {
  const defaults = { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" };
  return { storeConnectionId, marketplaceId: "EBAY_US", complete: true, missingFields: [],
    selection: { merchantLocationKey: "managed", ...defaults },
    fulfillmentCapability: { marketplaceId: "EBAY_US", requiredHandlingTimeBusinessDays: 1, destinationCountry: "US",
      destinationRegions: ["PA"], destinationCoverageComplete: true, supportedServices: [], evidenceHash: "fixture",
      source: { omsChannelId: 1, originWarehouseId: 1, rateBookId: 1, rateBookCode: "fixture", rateTableId: 1, serviceLevelId: 1,
        fulfillmentRoutingRevision: 1 } },
    options: { merchantLocations: [{ id: "managed", name: "Managed" }],
      fulfillmentPolicies: [{ id: "ground", name: "USPS Ground Advantage", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [{ id: "returns", name: "30-day returns" }],
      paymentPolicies: [{ id: "payments", name: "Managed payments" }] } };
}

/** A store that has saved no eBay policies yet, with two of each to choose from. */
function listingSetupWithNothingSaved(storeConnectionId: number) {
  const setup = listingSetup(storeConnectionId);
  return { ...setup, complete: false, missingFields: ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"],
    selection: { merchantLocationKey: "managed", fulfillmentPolicyId: null, returnPolicyId: null, paymentPolicyId: null },
    options: { ...setup.options,
      fulfillmentPolicies: [...setup.options.fulfillmentPolicies,
        { id: "priority", name: "USPS Priority Mail", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [...setup.options.returnPolicies, { id: "no-returns", name: "No returns" }],
      paymentPolicies: [...setup.options.paymentPolicies, { id: "payments-other", name: "Other payments" }] } };
}

type SummaryRail = { state: string; productsNeedingFix: number; missingPolicy: string | null };

/** The listing settings summary the rail reads (shared/dropship/listing-settings.ts). */
function listingSettingsSummary(storeConnectionId: number, rail: SummaryRail = { state: "all_set", productsNeedingFix: 0, missingPolicy: null }) {
  const policy = (policyId: string) => ({ policyId, verification: "not_checked" });
  return { storeConnectionId, storeStatus: "connected", access: { allowed: true }, catalog: { state: "ok", products: 1, sizes: 1 },
    storeDefaults: { price: { recipe: null, groupRules: 0 }, shippingPolicy: policy("ground"), returnPolicy: policy("returns"),
      paymentPolicy: policy("payments"), ebayCategory: { category: null, groupRules: 0 },
      description: { hasIntroduction: false, hasFooter: false, groupRules: 0 } },
    counts: { productsNeedingFix: rail.productsNeedingFix, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0,
      belowCost: 0, cannotPrice: 0, paused: 0 },
    attention: { items: [], total: 0 }, rail, generatedAt: STAMP };
}

interface StubState {
  stores: StoreFixture[];
  selected: boolean;
  previewCalls: number;
  setupReads: number[];
  summaryReads: number[];
  /** The listing settings summary by store; a store left out gets listingSettingsSummary(). */
  summaries: Record<number, unknown>;
  /** How many summary reads still fail before they answer. */
  summaryFailures: number;
  /** eBay listing setup by store; a store left out gets listingSetup(). */
  listingSetups: Record<number, unknown>;
  /** Saved pricing rules by store; a store left out has none. */
  pricingRules: Record<number, unknown>;
  unexpected: string[];
  errors: string[];
}

/** Saved pricing rules: catalog reference retail + 15%. */
const SAVED_PRICING_RULES = { revisionId: 3, updatedAt: STAMP, profile: {
  defaultRecipe: { basis: "catalog_retail", markupBps: 1_500, flatCents: 0, rounding: "cent" }, groups: [] } };

function storeConnection(store: StoreFixture) {
  return { storeConnectionId: store.storeConnectionId, vendorId: 1, platform: store.platform, externalAccountId: `acct-${store.storeConnectionId}`,
    externalDisplayName: store.name, shopDomain: null, status: "connected", setupStatus: "ready", disconnectReason: null,
    disconnectedAt: null, graceEndsAt: null, tokenExpiresAt: null, hasAccessToken: true, hasRefreshToken: true, launchReady: true,
    lastSyncAt: null, lastOrderSyncAt: null, lastInventorySyncAt: null, orderProcessingConfig: { defaultWarehouseId: null },
    createdAt: STAMP, updatedAt: STAMP };
}

function onboardingJson() {
  return {
    vendor: { vendorId: 1, memberId: MEMBER_ID, businessName: "Marz Cards", contactName: null, email: "vendor@example.com", phone: null,
      status: "active", entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 3, standingReason: null, pausedAt: null },
    entitlement: { memberId: MEMBER_ID, cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops",
      subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
    storeConnections: { activeCount: 1, connectedCount: 1, launchReadyConnectedCount: 1, credentialAttentionCount: 0,
      needsAttentionCount: 0, totalCount: 1, includedLimit: 3, canConnectStore: true },
    catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
    wallet: { availableBalanceCents: 10_000, pendingBalanceCents: 0, activeFundingMethodCount: 1, activeStripeFundingMethodCount: 1,
      activeStripeCardFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0, autoReloadEnabled: true, autoReloadFundingMethodId: 10,
      autoReloadFundingMethodActive: true, autoReloadFundingMethodReady: true, autoReloadFundingMethodIsCard: true, hasActiveFundingMethod: true,
      hasStripeReadyFundingMethod: true, hasUsdcBaseFundingMethod: false, hasCardBackstop: true, autoReloadConfigured: true,
      hasSpendableBalance: true, walletReady: true },
    steps: [
      { key: "vendor_profile", label: "Vendor profile", status: "complete", required: true },
      { key: "store_connection", label: "Store connection", status: "complete", required: true },
      { key: "catalog_available", label: "Card Shellz catalog", status: "complete", required: true },
      { key: "catalog_selection", label: "Catalog selection", status: "complete", required: true },
      { key: "wallet_payment", label: "Wallet and auto-reload", status: "complete", required: true },
    ],
  };
}

function settingsJson(state: StubState) {
  return { settings: {
    vendor: { vendorId: 1, memberId: MEMBER_ID, businessName: "Marz Cards", email: "vendor@example.com", status: "active",
      entitlementStatus: "active", includedStoreConnections: 3 },
    account: { hasContactEmail: true, hasBusinessName: true },
    storeConnections: state.stores.map(storeConnection),
    wallet: { availableBalanceCents: 10_000, pendingBalanceCents: 0, autoReloadEnabled: true, fundingMethodCount: 1,
      activeStripeFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0, autoReloadFundingMethodReady: true },
    notificationPreferences: { configuredCount: 0 }, sections: [], generatedAt: STAMP,
  } };
}

async function openCatalog(page: Page, path: string, initial: Partial<StubState> = {}) {
  const state: StubState = { stores: [MARZ], selected: true, previewCalls: 0, setupReads: [], summaryReads: [], summaries: {},
    summaryFailures: 0, listingSetups: {}, pricingRules: {}, unexpected: [], errors: [], ...initial };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    const storePath = /^\/api\/dropship\/(?:ebay\/(?:listing-setup|store-categories|listing-policy-overrides)|listings\/stores)\/(\d+)(\/.*)?$/.exec(path);
    const storeId = storePath ? Number(storePath[1]) : null;
    if (path === "/api/dropship/auth/me") {
      return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: MEMBER_ID, cardShellzEmail: "vendor@example.com", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: STAMP }, sensitiveProofs: {} } });
    }
    if (path === "/api/dropship/onboarding/state" && method === "GET") return route.fulfill({ json: onboardingJson() });
    if (path === "/api/dropship/settings" && method === "GET") return route.fulfill({ json: settingsJson(state) });
    if (path === "/api/dropship/catalog" && method === "GET") {
      const selectedOnly = url.searchParams.get("selectedOnly") === "true";
      const row = { ...ROW, selectionDecision: { ...ROW.selectionDecision, selected: state.selected, reason: state.selected ? "selected" : "not_selected" } };
      const rows = selectedOnly && !state.selected ? [] : [row];
      return route.fulfill({ json: { rows, total: rows.length, page: 1, limit: Number(url.searchParams.get("limit") ?? 50),
        facets: { categories: [], productLines: [], products: [] } } });
    }
    if (path === "/api/dropship/catalog/selection-rules" && method === "GET") {
      return route.fulfill({ json: { rules: state.selected
        ? [{ id: 1, scopeType: "variant", action: "include", productVariantId: 101, isActive: true }] : [] } });
    }
    if (storeId !== null && method === "GET" && state.stores.some((store) => store.storeConnectionId === storeId && store.platform === "ebay")) {
      if (path === `/api/dropship/ebay/listing-setup/${storeId}`) {
        state.setupReads.push(storeId);
        return route.fulfill({ json: state.listingSetups[storeId] ?? listingSetup(storeId) });
      }
      if (path === `/api/dropship/listings/stores/${storeId}/listing-settings/summary`) {
        state.summaryReads.push(storeId);
        if (state.summaryFailures > 0) {
          state.summaryFailures -= 1;
          return route.fulfill({ status: 500, json: { error: { code: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
            message: "Listing settings could not be loaded. Please retry." } } });
        }
        return route.fulfill({ json: state.summaries[storeId] ?? listingSettingsSummary(storeId) });
      }
      if (path === `/api/dropship/ebay/listing-policy-overrides/${storeId}/saved`) {
        return route.fulfill({ json: { storeConnectionId: storeId, verification: "not_checked",
          defaults: { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" }, assignments: [], fetchedAt: STAMP } });
      }
      if (path === `/api/dropship/ebay/store-categories/${storeId}`) {
        return route.fulfill({ json: { storeConnectionId: storeId, categories: [], assignments: [], fetchedAt: STAMP } });
      }
      if (path === `/api/dropship/listings/stores/${storeId}/pricing-rules/targets` && url.searchParams.get("type") === "listings") {
        return route.fulfill({ json: { total: 1, rows: [{ id: "101", name: "Envelope Single Pocket · Pack of 50 · ENV-SGL-P50" }] } });
      }
      if (path === `/api/dropship/listings/stores/${storeId}/variants/101/price`) {
        return route.fulfill({ json: { price: { storeConnectionId: storeId, productVariantId: 101, revisionId: null,
          overridePriceCents: null, effectivePriceCents: 699, defaultPriceCents: 699, source: "catalog_default",
          pricingMode: "catalog_default", ruleName: null, pricingIssue: null, rulePriceCents: null, rulesConfigured: false,
          ruleBasis: null, productCostCents: 410, updatedAt: null } } });
      }
      if (path === `/api/dropship/listings/stores/${storeId}/pricing-rules` && state.pricingRules[storeId]) {
        return route.fulfill({ json: state.pricingRules[storeId] });
      }
      if (path === `/api/dropship/listings/stores/${storeId}/ebay-category-rules`
        || path === `/api/dropship/listings/stores/${storeId}/pricing-rules`
        || path === `/api/dropship/listings/stores/${storeId}/content-profile`) {
        return route.fulfill({ json: { revisionId: null, profile: null, updatedAt: null } });
      }
    }
    if (path === "/api/dropship/listings/preview" && method === "POST") {
      state.previewCalls += 1;
      const storeConnectionId = (route.request().postDataJSON() as { storeConnectionId: number }).storeConnectionId;
      return route.fulfill({ json: { preview: { vendorId: 1, storeConnectionId, platform: "ebay", generatedAt: STAMP,
        rows: [previewRow(storeConnectionId)], summary: { total: 1, ready: 1, blocked: 0, warning: 0 } } } });
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  await page.route(`**${CATALOG_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-catalog-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(path);
  return state;
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  if (!SHOTS_DIR) return;
  await page.screenshot({ path: join(SHOTS_DIR, `${testInfo.project.name}-${name}.png`) });
}

function step(page: Page, name: "choose" | "setup" | "publish") {
  return page.getByTestId(`catalog-step-${name}`);
}

test("a bare Catalog address opens Choose, and moving between steps keeps the vendor's work", async ({ page }, testInfo) => {
  const state = await openCatalog(page, CATALOG_PATH);

  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  await expect(step(page, "choose")).toHaveAttribute("aria-current", "step");
  await expect(step(page, "choose")).toContainText("1 selected");
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Listing preview and push" })).toHaveCount(0);
  await expect(page.getByTestId("portal-nav").getByRole("button", { name: "Catalog" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("1 selected");
  // The rail's line comes from saved settings: eBay is not asked off Listing settings.
  await expect(step(page, "setup")).toContainText("All set");
  expect(state.setupReads).toEqual([]);
  await shot(page, testInfo, "catalog-step-choose");

  await page.getByRole("link", { name: "Next: Listing settings" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(step(page, "setup")).toHaveAttribute("aria-current", "step");
  await expect(step(page, "setup")).toContainText("All set");
  await expect(page.getByRole("heading", { name: "eBay listing setup" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "eBay categories" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Listing pricing rules" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available catalog" })).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Settings for Marz Cards");
  await shot(page, testInfo, "catalog-step-setup");
  // Only the setup panel asks eBay, once; the rail reads its answer.
  expect(state.setupReads).toEqual([5]);

  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Listing preview and push" }) });
  await card.getByRole("button", { name: "Preview selected" }).click();
  await expect(card.getByText("Envelope Single Pocket, Pack of 50").first()).toBeVisible();
  await shot(page, testInfo, "catalog-step-publish");

  // Leaving the step and coming back keeps the preview: nothing is asked again.
  await step(page, "choose").click();
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await step(page, "publish").click();
  await expect(card.getByText("Envelope Single Pocket, Pack of 50").first()).toBeVisible();
  expect(state.previewCalls).toBe(1);

  // The browser's Back button walks the steps.
  await page.goBack();
  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Next stays off until something is selected", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { selected: false });

  await expect(step(page, "choose")).toContainText("0 selected");
  await expect(step(page, "choose")).toContainText("not done yet");
  await expect(page.getByRole("button", { name: "Next: Listing settings" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Next: Listing settings" })).toHaveCount(0);
  // The rail still opens any step.
  await step(page, "publish").click();
  await expect(page.getByText("Choose items in step 1, Choose what to sell.", { exact: false })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("asks before leaving Listing settings with changes that aren't saved", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [MARZ, OUTLET],
    pricingRules: { [OUTLET.storeConnectionId]: SAVED_PRICING_RULES } });
  const markup = page.getByLabel("Markup (%)", { exact: true });
  const dialog = page.getByRole("alertdialog");
  await expect(page.getByRole("heading", { name: "Listing pricing rules" })).toBeVisible();

  // With no saved pricing rules the form opens on a suggestion, which is not a change on its own.
  await expect(page.getByText("Suggested · not saved")).toBeVisible();
  await expect(markup).toHaveValue("0.00");
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await step(page, "setup").click();

  await markup.fill("20");
  await expect(page.getByRole("heading", { name: "Listing pricing rules" })).toContainText("Not saved");

  // The Next button asks first, and Keep editing keeps the change.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(dialog).toContainText("Leave without saving?");
  await expect(dialog).toContainText("You have changes that aren't saved in Listing pricing rules.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(markup).toHaveValue("20");

  // So do the step links and the store picker.
  await step(page, "choose").click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await page.getByTestId("catalog-store-select").click();
  await page.getByRole("option", { name: "Marz Cards Outlet (eBay)" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Settings for Marz Cards");
  await expect(markup).toHaveValue("20");

  // Discard and leave goes where the vendor asked, and the change is gone when they come back.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await step(page, "setup").click();
  await expect(markup).toHaveValue("0.00");

  // Discarding through the store picker opens the other store's own saved rules, not this store's draft.
  await markup.fill("20");
  await page.getByTestId("catalog-store-select").click();
  await page.getByRole("option", { name: "Marz Cards Outlet (eBay)" }).click();
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Settings for Marz Cards Outlet");
  await expect(markup).toHaveValue("15.00");
  await expect(page.getByRole("heading", { name: "Listing pricing rules" })).not.toContainText("Not saved");
  await expect(page.getByText("Suggested · not saved")).toHaveCount(0);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);

  // Closing the tab with a change gets the browser's own question.
  await markup.fill("25");
  await expect(page.getByRole("heading", { name: "Listing pricing rules" })).toContainText("Not saved");
  const asked = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const unload = await asked;
  expect(unload.type()).toBe("beforeunload");
  await unload.accept();
});

test("asks before leaving with an exact price that isn't saved, and before choosing another size", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`);
  const box = page.getByRole("region", { name: "Exact price for one size" });
  const dialog = page.getByRole("alertdialog");
  await box.getByLabel("Find a size by name or SKU").fill("ENV");
  await box.getByRole("button", { name: "Envelope Single Pocket · Pack of 50 · ENV-SGL-P50" }).click();
  await expect(box).toContainText("Catalog reference retail");
  await box.getByLabel("Your listing price (USD)").fill("14.99");

  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(dialog).toContainText("You have changes that aren't saved in Exact price for one size.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(box.getByLabel("Your listing price (USD)")).toHaveValue("14.99");

  await box.getByRole("button", { name: "Choose another size" }).click();
  await expect(dialog).toContainText("Exact price for one size");
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(box.getByLabel("Find a size by name or SKU")).toBeVisible();

  // Nothing is left unsaved, so Next goes straight on.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("eBay listing setup with nothing saved is not a change until the vendor picks a policy", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`,
    { listingSetups: { [MARZ.storeConnectionId]: listingSetupWithNothingSaved(MARZ.storeConnectionId) } });
  const heading = page.getByRole("heading", { name: /^eBay listing setup/ });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const dialog = page.getByRole("alertdialog");

  // Several policies to choose from and none saved: the fields open empty, which is nothing to lose.
  await expect(fulfillment).toBeVisible();
  await expect(heading).not.toContainText("Not saved");
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await step(page, "setup").click();

  // Picking one is a change until saved.
  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Priority Mail/ }).click();
  await expect(heading).toContainText("Not saved");
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(dialog).toContainText("You have changes that aren't saved in eBay listing setup.");
  await dialog.getByRole("button", { name: "Discard and leave" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await step(page, "setup").click();
  await expect(heading).not.toContainText("Not saved");
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("description templates still say Not saved after the vendor hides them", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`);
  const heading = page.getByRole("heading", { name: "Description templates" });
  const dialog = page.getByRole("alertdialog");
  await page.getByRole("button", { name: "Edit templates" }).click();
  const introduction = page.getByLabel(/introduction/i);
  await expect(introduction).toHaveValue("");
  await expect(heading).not.toContainText("Not saved");

  await introduction.fill("Ships from Card Shellz.");
  await expect(heading).toContainText("Not saved");
  await page.getByRole("button", { name: "Hide templates" }).click();
  await expect(introduction).toBeHidden();
  await expect(heading).toContainText("Not saved");
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(dialog).toContainText("You have changes that aren't saved in Description templates.");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await page.getByRole("button", { name: "Edit templates" }).click();
  await expect(introduction).toHaveValue("Ships from Card Shellz.");
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("remembers the chosen eBay store for this member, and never offers a store on another platform", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [SHOP, MARZ, OUTLET] });
  const storeSelect = page.getByTestId("catalog-store-select");

  // The first eBay store is used until the vendor chooses; the Shopify store listed first is skipped.
  await expect(storeSelect).toHaveText("Marz Cards (eBay)");
  await storeSelect.click();
  await expect(page.getByRole("option", { name: "Test Shop (Shopify) · Not supported yet" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("option", { name: "Marz Cards Outlet (eBay)" }).click();
  await expect(storeSelect).toHaveText("Marz Cards Outlet (eBay)");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Settings for Marz Cards Outlet");
  await expect.poll(() => state.setupReads.includes(9)).toBe(true);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), `dropship.catalog.store:${MEMBER_ID}`)).toBe("9");

  await page.reload();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(page.getByTestId("catalog-store-select")).toHaveText("Marz Cards Outlet (eBay)");
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Settings for Marz Cards Outlet");
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a vendor whose only store is on another platform is told so, and nothing asks eBay", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [SHOP] });

  await expect(page.getByTestId("catalog-store-none")).toHaveText("No eBay store ready. Test Shop (Shopify): not supported yet.");
  await expect(step(page, "setup")).toContainText("No eBay store");
  await expect(page.getByTestId("listing-access-notice"))
    .toContainText("Connect your eBay store and finish its setup to set how your listings look.");
  await expect(page.getByRole("heading", { name: "eBay listing setup" })).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("No eBay store ready");
  expect(state.setupReads).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("the rail names what saved settings need, says Couldn't check when it can't read them, and Try again reads them again", async ({ page }, testInfo) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { summaryFailures: 1, summaries: {
    [MARZ.storeConnectionId]: listingSettingsSummary(MARZ.storeConnectionId, { state: "products_need_fix", productsNeedingFix: 2, missingPolicy: null }) } });
  const retry = page.getByTestId("catalog-step-setup-action");

  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).toContainText("not known yet");
  await expect(retry).toHaveText("Try again");
  await shot(page, testInfo, "catalog-rail-couldnt-check");
  await retry.click();
  await expect(step(page, "setup")).toContainText("2 products need a fix");
  await expect(step(page, "setup")).toContainText("not done yet");
  await expect(retry).toHaveCount(0);
  expect(state.summaryReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);
  expect(state.setupReads).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("the live eBay check on Listing settings keeps the rail from saying All set over a policy that no longer fits", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const noLongerFits = { ...setup, complete: false, missingFields: ["fulfillmentPolicyCompatibility"],
    options: { ...setup.options, fulfillmentPolicies: [{ id: "ground", name: "USPS Ground Advantage", compatible: false,
      compatibilityIssues: [{ code: "handling_time_too_short", message: "Handling time must be 1 business day or more." }] }] } };
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { listingSetups: { [MARZ.storeConnectionId]: noLongerFits } });

  // Saved settings alone look complete, and eBay has not been asked yet.
  await expect(step(page, "setup")).toContainText("All set");
  await step(page, "setup").click();
  await expect(page.getByRole("heading", { name: /^eBay listing setup/ })).toBeVisible();
  await expect(step(page, "setup")).toContainText("Choose a shipping policy");
  // Back on Choose, the rail keeps eBay's newest answer without asking again.
  await step(page, "choose").click();
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await expect(step(page, "setup")).toContainText("Choose a shipping policy");
  expect(state.setupReads).toEqual([MARZ.storeConnectionId]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
