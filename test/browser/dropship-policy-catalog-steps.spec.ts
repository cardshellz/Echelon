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

interface StubState {
  stores: StoreFixture[];
  selected: boolean;
  previewCalls: number;
  setupReads: number[];
  unexpected: string[];
  errors: string[];
}

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
  const state: StubState = { stores: [MARZ], selected: true, previewCalls: 0, setupReads: [], unexpected: [], errors: [], ...initial };
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
        return route.fulfill({ json: listingSetup(storeId) });
      }
      if (path === `/api/dropship/ebay/listing-policy-overrides/${storeId}/saved`) {
        return route.fulfill({ json: { storeConnectionId: storeId, verification: "not_checked",
          defaults: { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" }, assignments: [], fetchedAt: STAMP } });
      }
      if (path === `/api/dropship/ebay/store-categories/${storeId}`) {
        return route.fulfill({ json: { storeConnectionId: storeId, categories: [], assignments: [], fetchedAt: STAMP } });
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
  await shot(page, testInfo, "catalog-step-choose");

  await page.getByRole("link", { name: "Continue to Set how it lists" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/setup`);
  await expect(step(page, "setup")).toHaveAttribute("aria-current", "step");
  await expect(step(page, "setup")).toContainText("Setup complete");
  await expect(page.getByRole("heading", { name: "eBay listing setup" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "eBay categories" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Listing pricing rules" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available catalog" })).toHaveCount(0);
  await expect(page.getByTestId("catalog-action-summary")).toHaveText("Settings for Marz Cards");
  await shot(page, testInfo, "catalog-step-setup");
  // The rail and the setup panel read the store's eBay setup once between them.
  expect(state.setupReads).toEqual([5]);

  await page.getByRole("link", { name: "Continue to Publish" }).click();
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

test("Continue stays off until something is selected", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/choose`, { selected: false });

  await expect(step(page, "choose")).toContainText("0 selected");
  await expect(step(page, "choose")).toContainText("not done yet");
  await expect(page.getByRole("button", { name: "Continue to Set how it lists" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Continue to Set how it lists" })).toHaveCount(0);
  // The rail still opens any step.
  await step(page, "publish").click();
  await expect(page.getByText("Choose items in step 1, Choose what to sell.", { exact: false })).toBeVisible();
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
