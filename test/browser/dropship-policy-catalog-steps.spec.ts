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

/** The listing config revision every setup answer carries (migration 0728); a save sends it back. */
const SETUP_REVISION = 3;

function listingSetup(storeConnectionId: number) {
  const defaults = { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" };
  return { storeConnectionId, marketplaceId: "EBAY_US", complete: true, missingFields: [] as string[],
    revision: SETUP_REVISION, access: { canEdit: true, reason: null } as { canEdit: boolean; reason: string | null },
    checks: { ebay: "checked", fulfillment: { status: "checked" } },
    storedNames: { fulfillmentPolicyName: "USPS Ground Advantage", returnPolicyName: "30-day returns", paymentPolicyName: "Managed payments" },
    storeShelfDefault: null,
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

/** Everything saved, with a second shipping policy the vendor can switch to. */
function listingSetupWithAnotherShippingPolicy(storeConnectionId: number) {
  const setup = listingSetup(storeConnectionId);
  return { ...setup, options: { ...setup.options, fulfillmentPolicies: [...setup.options.fulfillmentPolicies,
    { id: "priority", name: "USPS Priority Mail", compatible: true, compatibilityIssues: [] }] } };
}

/**
 * The saved shipping policy ("ground") is gone from eBay, so that field opens empty (the server
 * names it missing); two other shipping policies fit, and a second return policy can be chosen.
 */
function listingSetupWithSavedShippingGone(storeConnectionId: number) {
  const setup = listingSetup(storeConnectionId);
  return { ...setup, complete: false, missingFields: ["fulfillmentPolicyId"],
    options: { ...setup.options,
      fulfillmentPolicies: [{ id: "priority", name: "USPS Priority Mail", compatible: true, compatibilityIssues: [] },
        { id: "express", name: "USPS Priority Mail Express", compatible: true, compatibilityIssues: [] }],
      returnPolicies: [...setup.options.returnPolicies, { id: "no-returns", name: "No returns" }] } };
}

/** The issue the server names for a shipping policy with too short a handling time (ebay-fulfillment-policy-compatibility.ts). */
const HANDLING_TIME_ISSUE = { code: "handling_time_too_short", message: "Policy must allow at least 1 business day of handling time." };

/**
 * The same answer without the Card Shellz shipping check: a save that sends no shipping policy
 * skips it (dropship-ebay-listing-setup-service.ts planSetupSave), and so does a read while
 * shipping can't be read; every shipping policy is then unchecked (buildFulfillmentPolicyOptions).
 */
function withShippingNotChecked<T extends ReturnType<typeof listingSetup>>(setup: T,
  fulfillment: Record<string, unknown> = { status: "not_checked" }) {
  return { ...setup, complete: false, checks: { ...setup.checks, fulfillment }, fulfillmentCapability: null,
    options: { ...setup.options, fulfillmentPolicies: setup.options.fulfillmentPolicies.map((policy) => ({
      ...policy, compatible: false, compatibilityChecked: false, compatibilityIssues: [] })) } };
}

const POLICY_FIELDS = ["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"] as const;

/** A save or repair the stub received. */
interface SetupWrite { method: string; path: string; body: Record<string, unknown> }

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
  /** How many eBay listing setup reads still fail (eBay unavailable) before they answer. */
  setupReadFailures: number;
  /** Saved pricing rules by store; a store left out has none. */
  pricingRules: Record<number, unknown>;
  /** eBay listing setup saves (PUT) and ship-from repairs (POST), in order. */
  setupWrites: SetupWrite[];
  /** How the next setup writes answer, in order; once used up, a write is saved. */
  setupWriteAnswers: Array<"drop" | { status: number; code: string; message: string; context?: Record<string, unknown> }>;
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
    summaryFailures: 0, listingSetups: {}, setupReadFailures: 0, pricingRules: {}, setupWrites: [], setupWriteAnswers: [], unexpected: [],
    errors: [], ...initial };
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
    if (storeId !== null && ((method === "PUT" && path === `/api/dropship/ebay/listing-setup/${storeId}`)
      || (method === "POST" && path === `/api/dropship/ebay/listing-setup/${storeId}/ship-from/repair`))) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.setupWrites.push({ method, path, body });
      const answer = state.setupWriteAnswers.shift();
      // The save reached the server but its answer never came back.
      if (answer === "drop") return route.abort("connectionreset");
      if (answer) {
        return route.fulfill({ status: answer.status, json: { error: { code: answer.code, message: answer.message,
          ...(answer.context ? { context: answer.context } : {}) } } });
      }
      const current = (state.listingSetups[storeId] ?? listingSetup(storeId)) as ReturnType<typeof listingSetup>;
      // Compare-and-set, as the server does (migration 0728): a write against an older revision
      // changes nothing and is refused (dropship-listing-config.repository.ts revisionConflict).
      if (body.expectedRevision !== current.revision) {
        return route.fulfill({ status: 409, json: { error: { code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
          message: "These store settings changed after they were loaded. Load the latest settings and save again.",
          context: { storeConnectionId: storeId, expectedRevision: body.expectedRevision, currentRevision: current.revision,
            retryable: false } } } });
      }
      // A save changes only the policies it sends; the server keeps the rest.
      const sent = Object.fromEntries(POLICY_FIELDS.filter((field) => typeof body[field] === "string").map((field) => [field, body[field]]));
      // The repair fixes only where items ship from; anything else the setup still lacks (a saved
      // policy eBay no longer lists, say) is still named missing.
      const stillMissing = current.missingFields.filter((field) => field !== "merchantLocationKey");
      const saved = method === "PUT"
        ? { ...current, revision: current.revision + 1, selection: { ...current.selection, ...sent } }
        : { ...current, revision: current.revision + 1, complete: stillMissing.length === 0, missingFields: stillMissing,
          selection: { ...current.selection, merchantLocationKey: "managed" } };
      state.listingSetups[storeId] = saved;
      const answered = method === "PUT" && body.fulfillmentPolicyId === undefined ? withShippingNotChecked(saved) : saved;
      return route.fulfill({ json: { ...answered, outcome: "changed" } });
    }
    if (storeId !== null && method === "GET" && state.stores.some((store) => store.storeConnectionId === storeId && store.platform === "ebay")) {
      if (path === `/api/dropship/ebay/listing-setup/${storeId}`) {
        state.setupReads.push(storeId);
        if (state.setupReadFailures > 0) {
          state.setupReadFailures -= 1;
          return route.fulfill({ status: 502, json: { error: { code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
            message: "eBay did not return the connected store's listing setup.",
            context: { resource: "fulfillmentPolicies", status: 503, retryable: true, diagnosticReference: "browser-test-setup-read" } } } });
        }
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

test("saving eBay listing setup sends the loaded revision and a request key; a retry after a lost answer reuses the key", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, {
    listingSetups: { [MARZ.storeConnectionId]: listingSetupWithAnotherShippingPolicy(MARZ.storeConnectionId) },
    setupWriteAnswers: ["drop"],
  });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const save = page.getByRole("button", { name: "Save eBay listing setup" });

  // Nothing changed yet: there is nothing to save.
  await expect(fulfillment).toBeVisible();
  await expect(save).toBeDisabled();
  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Priority Mail/ }).click();
  await expect(save).toBeEnabled();

  // The first save's answer is lost; saving the same choice again is the same request.
  await save.click();
  await expect(page.getByRole("alert").filter({ hasText: /fetch/i })).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText("Store defaults saved and listing policies updated. Generate a new preview to use them.", { exact: true })).toBeVisible();

  expect(state.setupWrites).toHaveLength(2);
  const [lost, retry] = state.setupWrites;
  // Only the changed policy is sent; the saved return and payment policies stay as they are.
  expect(lost).toEqual({ method: "PUT", path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}`, body: {
    expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ebay-setup:[A-Za-z0-9-]+$/),
    fulfillmentPolicyId: "priority" } });
  expect(retry.body).toEqual(lost.body);

  // Once the server confirmed it, the next change is a new request against the new revision.
  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Ground Advantage/ }).click();
  await save.click();
  await expect.poll(() => state.setupWrites.length).toBe(3);
  expect(state.setupWrites[2].body).toMatchObject({ expectedRevision: SETUP_REVISION + 1, fulfillmentPolicyId: "ground" });
  expect(state.setupWrites[2].body.idempotencyKey).not.toBe(lost.body.idempotencyKey);
  await expect(page.getByText("Store defaults saved and listing policies updated. Generate a new preview to use them.", { exact: true })).toBeVisible();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a save refused because the settings changed elsewhere says to refresh, and nothing is overwritten", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, {
    listingSetups: { [MARZ.storeConnectionId]: listingSetupWithAnotherShippingPolicy(MARZ.storeConnectionId) },
    setupWriteAnswers: [{ status: 409, code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
      message: "These store settings changed after they were loaded. Load the latest settings and save again." }],
  });
  await page.getByRole("combobox", { name: "Fulfillment policy", exact: true }).click();
  await page.getByRole("option", { name: /USPS Priority Mail/ }).click();
  await page.getByRole("button", { name: "Save eBay listing setup" }).click();

  // The words now also say the vendor's picks survive the refresh (Refresh options keeps them; see
  // the journey below), so the vendor isn't told to choose everything again.
  await expect(page.getByRole("alert").filter({ hasText: "These settings changed in another window. Choose Refresh options to load what is saved now. Your changes stay chosen; check them, then save again." })).toBeVisible();
  expect(state.setupWrites).toHaveLength(1);
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

const SAVED_MESSAGE = "Store defaults saved and listing policies updated. Generate a new preview to use them.";

test("with the saved shipping policy gone from eBay, changing only the return policy can be saved and sends just that policy", async ({ page }) => {
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`,
    { listingSetups: { [MARZ.storeConnectionId]: listingSetupWithSavedShippingGone(MARZ.storeConnectionId) } });
  const heading = page.getByRole("heading", { name: /^eBay listing setup/ });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const returns = page.getByRole("combobox", { name: "Return policy", exact: true });
  const save = page.getByRole("button", { name: "Save eBay listing setup" });

  // eBay no longer lists the saved shipping policy and two others fit, so that field opens empty.
  // An empty field holds nothing to save, so on its own it is no change.
  await expect(fulfillment).toHaveText("Choose a fulfillment policy");
  await expect(returns).toHaveText("30-day returns");
  await expect(heading).not.toContainText("Not saved");
  await expect(save).toBeDisabled();

  // The empty shipping field does not keep the vendor from saving another policy.
  await returns.click();
  await page.getByRole("option", { name: /No returns/ }).click();
  await expect(heading).toContainText("Not saved");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(SAVED_MESSAGE, { exact: true })).toBeVisible();

  // Only the return policy is sent; the saved shipping and payment policies are left as they are.
  expect(state.setupWrites).toEqual([{ method: "PUT", path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}`, body: {
    expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ebay-setup:[A-Za-z0-9-]+$/), returnPolicyId: "no-returns" } }]);
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION + 1,
    selection: { fulfillmentPolicyId: "ground", returnPolicyId: "no-returns", paymentPolicyId: "payments" } });
  // That save skipped the Card Shellz shipping check, so its answer could not replace the loaded
  // view: the panel read the setup again.
  expect(state.setupReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);
  await expect(returns).toHaveText("No returns");
  await expect(fulfillment).toHaveText("Choose a fulfillment policy");
  await expect(heading).not.toContainText("Not saved");
  await expect(save).toBeDisabled();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("after a save refused for a newer revision, Refresh options shows the other window's change, keeps the vendor's pick, and saves it against the new revision", async ({ page }) => {
  const loaded = listingSetupWithAnotherShippingPolicy(MARZ.storeConnectionId);
  const setup = { ...loaded, options: { ...loaded.options,
    returnPolicies: [...loaded.options.returnPolicies, { id: "no-returns", name: "No returns" }] } };
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: setup } });
  const heading = page.getByRole("heading", { name: /^eBay listing setup/ });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const returns = page.getByRole("combobox", { name: "Return policy", exact: true });
  const save = page.getByRole("button", { name: "Save eBay listing setup" });
  const conflict = page.getByRole("alert").filter({ hasText: "These settings changed in another window." });
  await expect(fulfillment).toHaveText("USPS Ground Advantage");
  await expect(returns).toHaveText("30-day returns");

  // Another window saves a different return policy after this page loaded.
  state.listingSetups[MARZ.storeConnectionId] = { ...setup, revision: SETUP_REVISION + 1,
    selection: { ...setup.selection, returnPolicyId: "no-returns" } };

  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Priority Mail/ }).click();
  await save.click();
  await expect(conflict).toContainText("Choose Refresh options to load what is saved now. Your changes stay chosen; check them, then save again.");
  expect(state.setupWrites).toHaveLength(1);
  expect(state.setupWrites[0].body).toMatchObject({ expectedRevision: SETUP_REVISION, fulfillmentPolicyId: "priority" });
  // The refused save changed nothing.
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION + 1,
    selection: { fulfillmentPolicyId: "ground", returnPolicyId: "no-returns" } });

  await page.getByRole("button", { name: "Refresh options", exact: true }).click();
  // The newer answer is loaded: the other window's return policy shows, and the vendor's
  // shipping pick is still chosen and still not saved.
  await expect(returns).toHaveText("No returns");
  await expect(fulfillment).toHaveText("USPS Priority Mail");
  await expect(heading).toContainText("Not saved");
  await expect(conflict).toHaveCount(0);
  expect(state.setupReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);

  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText(SAVED_MESSAGE, { exact: true })).toBeVisible();
  expect(state.setupWrites).toHaveLength(2);
  // Only the vendor's pick is sent, against the revision just loaded, as a new request.
  expect(state.setupWrites[1].body).toEqual({ expectedRevision: SETUP_REVISION + 1,
    idempotencyKey: expect.stringMatching(/^ebay-setup:[A-Za-z0-9-]+$/), fulfillmentPolicyId: "priority" });
  expect(state.setupWrites[1].body.idempotencyKey).not.toBe(state.setupWrites[0].body.idempotencyKey);
  // Both changes stand: the vendor's shipping policy and the other window's return policy.
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION + 2,
    selection: { fulfillmentPolicyId: "priority", returnPolicyId: "no-returns", paymentPolicyId: "payments" } });
  await expect(returns).toHaveText("No returns");
  await expect(heading).not.toContainText("Not saved");
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a save refused because the shipping policy doesn't fit Card Shellz shipping names the issue, and Refresh options lets the vendor pick another", async ({ page }) => {
  const loaded = listingSetupWithAnotherShippingPolicy(MARZ.storeConnectionId);
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, {
    listingSetups: { [MARZ.storeConnectionId]: loaded },
    // The policy fitted when the page loaded; the save's fresh check finds it no longer does.
    setupWriteAnswers: [{ status: 422, code: "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
      message: "The selected eBay fulfillment policy exceeds Card Shellz fulfillment capabilities.",
      context: { storeConnectionId: MARZ.storeConnectionId, fulfillmentPolicyId: "priority", issues: [HANDLING_TIME_ISSUE], retryable: false } }],
  });
  const heading = page.getByRole("heading", { name: /^eBay listing setup/ });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const save = page.getByRole("button", { name: "Save eBay listing setup" });
  const refused = page.getByRole("alert").filter({ hasText: "This shipping policy doesn't work with Card Shellz shipping" });

  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Priority Mail/ }).click();
  await save.click();
  // The vendor's words with the server's first issue, never the staff-facing message. Changed on
  // purpose (review round 3): the issue's own closing period is dropped before the words add theirs
  // (dropship-ebay-listing-setup.ts firstIssueMessage), so the sentence ends with one period where
  // it used to read "handling time.. Choose". The whole message is matched, so the period is checked.
  await expect(refused).toHaveText("This shipping policy doesn't work with Card Shellz shipping: "
    + "Policy must allow at least 1 business day of handling time. Choose Refresh options, then pick another shipping policy.");
  await expect(refused).not.toContainText("..");
  await expect(refused).not.toContainText("exceeds Card Shellz fulfillment capabilities");
  expect(state.setupWrites).toHaveLength(1);
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION });

  // Refresh options shows eBay's policy no longer fits: the pick can't be kept, so the field goes
  // back to the saved policy, and the one that doesn't fit can't be picked again.
  state.listingSetups[MARZ.storeConnectionId] = { ...loaded, options: { ...loaded.options, fulfillmentPolicies: [
    loaded.options.fulfillmentPolicies[0],
    { id: "priority", name: "USPS Priority Mail", compatible: false, compatibilityIssues: [HANDLING_TIME_ISSUE] }] } };
  await page.getByRole("button", { name: "Refresh options", exact: true }).click();
  await expect(fulfillment).toHaveText("USPS Ground Advantage");
  await expect(refused).toHaveCount(0);
  await expect(heading).not.toContainText("Not saved");
  await expect(save).toBeDisabled();
  await fulfillment.click();
  const doesNotFit = page.getByRole("option", { name: /USPS Priority Mail/ });
  await expect(doesNotFit).toHaveAttribute("aria-disabled", "true");
  await expect(doesNotFit).toContainText(HANDLING_TIME_ISSUE.message);
  await page.keyboard.press("Escape");
  expect(state.setupWrites).toHaveLength(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Update ship-from location repairs the warehouse destination on its own, without a policy save", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const outdated = { ...setup, complete: false, missingFields: ["merchantLocationKey"],
    selection: { ...setup.selection, merchantLocationKey: "old-warehouse" } };
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: outdated } });
  const repair = page.getByRole("button", { name: "Update ship-from location" });

  await expect(page.getByText("Card Shellz needs to update where your items ship from. It changes no policy.", { exact: true })).toBeVisible();
  await expect(page.getByText("Save setup to reconcile it automatically", { exact: false })).toHaveCount(0);
  // The policies are as saved, so there is nothing for Save to do.
  await expect(page.getByRole("button", { name: "Save eBay listing setup" })).toBeDisabled();
  await repair.click();
  await expect(page.getByText("Ship-from location updated. Queue any listing that failed for it again.", { exact: true })).toBeVisible();
  await expect(repair).toHaveCount(0);

  expect(state.setupWrites).toEqual([{ method: "POST",
    path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}/ship-from/repair`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ebay-ship-from:[A-Za-z0-9-]+$/) } }]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Update ship-from location waits while a policy change isn't saved, and is offered again once the change is undone", async ({ page }) => {
  const setup = listingSetupWithAnotherShippingPolicy(MARZ.storeConnectionId);
  const outdated = { ...setup, complete: false, missingFields: ["merchantLocationKey"],
    selection: { ...setup.selection, merchantLocationKey: "old-warehouse" } };
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: outdated } });
  const heading = page.getByRole("heading", { name: /^eBay listing setup/ });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const repair = page.getByRole("button", { name: "Update ship-from location" });
  const waitHint = page.getByText("Save or undo your policy change first.", { exact: true });

  await expect(repair).toBeEnabled();
  await expect(waitHint).toHaveCount(0);

  // The repair reloads the setup, which would drop the unsaved pick, so it waits.
  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Priority Mail/ }).click();
  await expect(heading).toContainText("Not saved");
  await expect(repair).toBeDisabled();
  await expect(waitHint).toBeVisible();

  // Choosing the saved policy again undoes the change.
  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Ground Advantage/ }).click();
  await expect(heading).not.toContainText("Not saved");
  await expect(repair).toBeEnabled();
  await expect(waitHint).toHaveCount(0);
  expect(state.setupWrites).toEqual([]);

  await repair.click();
  await expect(page.getByText("Ship-from location updated. Queue any listing that failed for it again.", { exact: true })).toBeVisible();
  // Only the repair was sent, against the loaded revision; no policy was saved.
  expect(state.setupWrites).toEqual([{ method: "POST",
    path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}/ship-from/repair`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ebay-ship-from:[A-Za-z0-9-]+$/) } }]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

const SHIP_FROM_UPDATED_MESSAGE = "Ship-from location updated. Queue any listing that failed for it again.";

/** Where items ship from is out of date (the server names merchantLocationKey); a second shipping policy can be picked. */
function listingSetupWithShipFromOutdated(storeConnectionId: number) {
  const setup = listingSetupWithAnotherShippingPolicy(storeConnectionId);
  return { ...setup, complete: false, missingFields: ["merchantLocationKey"],
    selection: { ...setup.selection, merchantLocationKey: "old-warehouse" } };
}

test("Update ship-from location is not held up by a policy Card Shellz suggested, only by one the vendor picked", async ({ page }) => {
  const outdated = listingSetupWithShipFromOutdated(MARZ.storeConnectionId);
  // The saved return policy is gone from eBay, which now lists exactly one, so Card Shellz fills
  // that one in as a suggestion (buildEbayListingSetupDraft): unsaved, but not the vendor's pick.
  const setup = { ...outdated, missingFields: ["returnPolicyId", "merchantLocationKey"],
    selection: { ...outdated.selection, returnPolicyId: "returns-retired" } };
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: setup } });
  const heading = page.getByRole("heading", { name: /^eBay listing setup/ });
  // Scoped to the panel: the pricing rules form shows its own "Suggested · not saved".
  const panel = page.locator("section").filter({ has: heading }).last();
  const suggested = panel.getByText("Suggested · not saved", { exact: true });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const returns = page.getByRole("combobox", { name: "Return policy", exact: true });
  const repair = page.getByRole("button", { name: "Update ship-from location" });
  const waitHint = page.getByText("Save or undo your policy change first.", { exact: true });

  await expect(returns).toHaveText("30-day returns");
  await expect(suggested).toHaveCount(1);
  await expect(heading).toContainText("Not saved");
  // Changed on purpose (review round 3): the repair waits only for a policy the vendor picked
  // (EbayListingSetupPanel unsavedPick). The vendor can't undo a suggestion, and the repair's
  // reload fills it in again, so it no longer holds the repair up.
  await expect(repair).toBeEnabled();
  await expect(waitHint).toHaveCount(0);

  // A policy the vendor picks would be lost by the reload, so the repair waits for it.
  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Priority Mail/ }).click();
  await expect(repair).toBeDisabled();
  await expect(waitHint).toBeVisible();

  // Undoing the pick leaves only the suggestion, and the repair is offered again.
  await fulfillment.click();
  await page.getByRole("option", { name: /USPS Ground Advantage/ }).click();
  await expect(repair).toBeEnabled();
  await expect(waitHint).toHaveCount(0);
  expect(state.setupWrites).toEqual([]);

  await repair.click();
  await expect(page.getByText(SHIP_FROM_UPDATED_MESSAGE, { exact: true })).toBeVisible();
  await expect(repair).toHaveCount(0);
  // Only the repair was sent; the suggested return policy was not saved with it.
  expect(state.setupWrites).toEqual([{ method: "POST",
    path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}/ship-from/repair`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ebay-ship-from:[A-Za-z0-9-]+$/) } }]);
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION + 1,
    selection: { merchantLocationKey: "managed", returnPolicyId: "returns-retired" } });
  // The reloaded setup fills the suggestion in again, still not saved.
  await expect(returns).toHaveText("30-day returns");
  await expect(suggested).toHaveCount(1);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("Update ship-from location refused because the settings changed elsewhere says to refresh and update again, and the retry is a new request", async ({ page }) => {
  const outdated = listingSetupWithShipFromOutdated(MARZ.storeConnectionId);
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: outdated } });
  const heading = page.getByRole("heading", { name: /^eBay listing setup/ });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const repair = page.getByRole("button", { name: "Update ship-from location" });
  const refused = page.getByRole("alert").filter({ hasText: "These settings changed in another window." });
  const repairPath = `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}/ship-from/repair`;
  await expect(fulfillment).toHaveText("USPS Ground Advantage");
  await expect(repair).toBeEnabled();

  // Another window saves a different shipping policy after this page loaded; where items ship
  // from is still out of date.
  state.listingSetups[MARZ.storeConnectionId] = { ...outdated, revision: SETUP_REVISION + 1,
    selection: { ...outdated.selection, fulfillmentPolicyId: "priority" } };

  // The stub refuses the older revision with 409 DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT, as the
  // server's compare-and-set does.
  await repair.click();
  // The repair's own words (review round 3): it has nothing to save again, only the update to run
  // again, so it does not borrow the save's "check them, then save again".
  await expect(refused).toHaveText("These settings changed in another window. Choose Refresh options, then Update ship-from location again.");
  expect(state.setupWrites).toEqual([{ method: "POST", path: repairPath,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ebay-ship-from:[A-Za-z0-9-]+$/) } }]);
  // The refused repair changed nothing.
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION + 1,
    selection: { merchantLocationKey: "old-warehouse", fulfillmentPolicyId: "priority" } });

  // Refresh options loads what the other window saved; the repair is still offered.
  await page.getByRole("button", { name: "Refresh options", exact: true }).click();
  await expect(fulfillment).toHaveText("USPS Priority Mail");
  await expect(refused).toHaveCount(0);
  await expect(heading).not.toContainText("Not saved");
  await expect(repair).toBeEnabled();

  await repair.click();
  await expect(page.getByText(SHIP_FROM_UPDATED_MESSAGE, { exact: true })).toBeVisible();
  await expect(repair).toHaveCount(0);
  // Sent against the revision just loaded, as a new request.
  expect(state.setupWrites).toHaveLength(2);
  expect(state.setupWrites[1]).toEqual({ method: "POST", path: repairPath,
    body: { expectedRevision: SETUP_REVISION + 1, idempotencyKey: expect.stringMatching(/^ebay-ship-from:[A-Za-z0-9-]+$/) } });
  expect(state.setupWrites[1].body.idempotencyKey).not.toBe(state.setupWrites[0].body.idempotencyKey);
  // Both stand: the other window's shipping policy and the repaired ship-from location.
  expect(state.listingSetups[MARZ.storeConnectionId]).toMatchObject({ revision: SETUP_REVISION + 2,
    selection: { merchantLocationKey: "managed", fulfillmentPolicyId: "priority" } });
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a paused store's eBay listing setup is read-only and sends nothing", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const paused = { ...setup, access: { canEdit: false, reason: "store_paused" },
    checks: { ebay: "not_checked", fulfillment: { status: "not_checked" } }, fulfillmentCapability: null,
    options: { merchantLocations: [], fulfillmentPolicies: [], returnPolicies: [], paymentPolicies: [] } };
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: paused } });

  await expect(page.getByText("Marz Cards is paused, so its settings can't be changed now.", { exact: true })).toBeVisible();
  // The rail says so too, with nothing to retry (review round 3, describeListingSettingsRail): the
  // unchecked answer is not an outage, and there is nothing the vendor can do here.
  await expect(step(page, "setup")).toContainText("View only");
  await expect(step(page, "setup")).toContainText("not known yet");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(page.getByTestId("catalog-step-setup-action")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Fulfillment policy", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save eBay listing setup" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Update ship-from location" })).toHaveCount(0);
  await expect(page.getByText("Card Shellz fulfillment capabilities", { exact: true })).toHaveCount(0);
  expect(state.setupWrites).toEqual([]);
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

test("switching eBay stores on Listing settings and back shows one setup panel, the chosen store's, and leaving afterwards asks nothing", async ({ page }) => {
  // React reports a key shared by two siblings as a console error. The setup and policy panels
  // once shared the store id as their key, which left the previous store's panel mounted after a
  // switch (fixed in review round 3: DropshipPortalCatalog keys them listing-setup-<id> and
  // policy-override-<id>).
  const keyErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("same key")) keyErrors.push(message.text());
  });
  // The outlet saved another shipping policy, so each store's panel shows which store it belongs to.
  const outlet = listingSetupWithAnotherShippingPolicy(OUTLET.storeConnectionId);
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { stores: [MARZ, OUTLET], listingSetups: {
    [OUTLET.storeConnectionId]: { ...outlet, selection: { ...outlet.selection, fulfillmentPolicyId: "priority" } } } });
  const storeSelect = page.getByTestId("catalog-store-select");
  const setupHeadings = page.getByRole("heading", { name: /^eBay listing setup/ });
  const policyHeadings = page.getByRole("heading", { name: "Listing policies", exact: true });
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const dialog = page.getByRole("alertdialog");

  await expect(fulfillment).toHaveText("USPS Ground Advantage");
  await expect(setupHeadings).toHaveCount(1);
  await expect(policyHeadings).toHaveCount(1);

  // Marz Cards -> Marz Cards Outlet -> Marz Cards.
  for (const [store, shippingPolicy] of [[OUTLET, "USPS Priority Mail"], [MARZ, "USPS Ground Advantage"]] as const) {
    await storeSelect.click();
    await page.getByRole("option", { name: `${store.name} (eBay)`, exact: true }).click();
    // Nothing is unsaved, so the picker switches at once.
    await expect(storeSelect).toHaveText(`${store.name} (eBay)`);
    await expect(page.getByTestId("catalog-action-summary")).toHaveText(`Settings for ${store.name}`);
    await expect(dialog).toHaveCount(0);
    // The switch has rendered (the summary above), so these counts are settled: one setup panel and
    // one policy panel, the chosen store's. The previous store's are gone.
    await expect(setupHeadings).toHaveCount(1);
    await expect(policyHeadings).toHaveCount(1);
    await expect(fulfillment).toHaveCount(1);
    await expect(fulfillment).toHaveText(shippingPolicy);
    await expect(setupHeadings).not.toContainText("Not saved");
  }

  // Nothing is unsaved in either store, so leaving the step asks nothing: not the Next button,
  // and not a step link.
  await page.getByRole("link", { name: "Next: Publish" }).click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/publish`);
  await expect(dialog).toHaveCount(0);
  await step(page, "setup").click();
  await expect(setupHeadings).toHaveCount(1);
  await expect(fulfillment).toHaveText("USPS Ground Advantage");
  await step(page, "choose").click();
  await expect(page).toHaveURL(`${CATALOG_PATH}/choose`);
  await expect(page.getByRole("heading", { name: "Available catalog" })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(keyErrors).toEqual([]);
  expect(state.setupWrites).toEqual([]);
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

test("the rail won't say All set over a live setup that couldn't check Card Shellz shipping, and Try again reads it again", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const shippingUnavailable = withShippingNotChecked(setup, { status: "unavailable", kind: "temporary", reference: "browser-test-ship-check" });
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: shippingUnavailable } });
  const retry = page.getByTestId("catalog-step-setup-action");
  const notice = page.getByText("Can't check Card Shellz shipping right now. Your saved settings still apply. Choose Refresh options in a few minutes.", { exact: true });

  // The saved settings look complete, but the live check found no problem only because it could
  // not check shipping, so the rail does not vouch for them.
  await expect(notice).toBeVisible();
  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(retry).toHaveText("Try again");

  // Card Shellz shipping is back: Try again reads the summary and the live setup again.
  state.listingSetups[MARZ.storeConnectionId] = setup;
  await retry.click();
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  await expect(notice).toHaveCount(0);
  expect(state.summaryReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);
  expect(state.setupReads).toEqual([MARZ.storeConnectionId, MARZ.storeConnectionId]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("while Card Shellz finishes shipping setup, the rail asks for a missing return policy first, then waits with nothing to retry, never asking for the shipping policy or ship-from location", async ({ page }) => {
  // eBay no longer lists the saved shipping or return policy, and where items ship from is out of
  // date; Card Shellz has not finished the store's shipping setup, so shipping can't be checked.
  const setup = listingSetupWithSavedShippingGone(MARZ.storeConnectionId);
  const finishing = withShippingNotChecked({ ...setup, missingFields: ["fulfillmentPolicyId", "returnPolicyId", "merchantLocationKey"],
    selection: { ...setup.selection, returnPolicyId: "returns-retired", merchantLocationKey: "old-warehouse" } },
  { status: "unavailable", kind: "setup_incomplete", reference: "browser-test-ship-setup" });
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { listingSetups: { [MARZ.storeConnectionId]: finishing } });
  const retry = page.getByTestId("catalog-step-setup-action");
  const notice = page.getByText("Card Shellz is finishing shipping setup for your store. You can pick a shipping policy when it's done.", { exact: true });
  const repair = page.getByRole("button", { name: "Update ship-from location" });
  const refresh = page.getByRole("button", { name: "Refresh options", exact: true });

  // The return policy is the vendor's to choose now, so the rail names it first (review round 4,
  // describeListingSettingsRail).
  await expect(notice).toBeVisible();
  await expect(step(page, "setup")).toContainText("Choose a return policy");
  await expect(retry).toHaveCount(0);
  await expect(repair).toHaveCount(0);

  // The return policy is chosen elsewhere; what is left waits on Card Shellz, and a retry would
  // change nothing.
  state.listingSetups[MARZ.storeConnectionId] = { ...finishing, missingFields: ["fulfillmentPolicyId", "merchantLocationKey"],
    selection: { ...finishing.selection, returnPolicyId: "returns" } };
  await refresh.click();
  await expect(step(page, "setup")).toContainText("Card Shellz is finishing setup");
  for (const line of ["Choose a shipping policy", "Ship-from location needs updating", "Couldn't check", "All set"]) {
    await expect(step(page, "setup")).not.toContainText(line);
  }
  await expect(retry).toHaveCount(0);
  await expect(repair).toHaveCount(0);
  await expect(notice).toBeVisible();

  // Card Shellz has finished and the vendor picked a shipping policy elsewhere: shipping is checked,
  // so the ship-from line and its repair show again, and the repair leaves nothing to do.
  state.listingSetups[MARZ.storeConnectionId] = { ...setup, missingFields: ["merchantLocationKey"],
    selection: { ...setup.selection, fulfillmentPolicyId: "priority", merchantLocationKey: "old-warehouse" } };
  await refresh.click();
  await expect(step(page, "setup")).toContainText("Ship-from location needs updating");
  await expect(notice).toHaveCount(0);
  await repair.click();
  await expect(page.getByText(SHIP_FROM_UPDATED_MESSAGE, { exact: true })).toBeVisible();
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  expect(state.setupWrites).toEqual([{ method: "POST",
    path: `/api/dropship/ebay/listing-setup/${MARZ.storeConnectionId}/ship-from/repair`,
    body: { expectedRevision: SETUP_REVISION, idempotencyKey: expect.stringMatching(/^ebay-ship-from:[A-Za-z0-9-]+$/) } }]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a store on an eBay site Card Shellz doesn't list on says Contact support in the rail, over a missing return policy and products that need a fix", async ({ page }) => {
  const setup = listingSetup(MARZ.storeConnectionId);
  const otherSite = withShippingNotChecked({ ...setup, missingFields: ["returnPolicyId"],
    selection: { ...setup.selection, returnPolicyId: "returns-retired" },
    options: { ...setup.options, returnPolicies: [...setup.options.returnPolicies, { id: "no-returns", name: "No returns" }] } },
  { status: "unavailable", kind: "marketplace_unsupported", reference: "browser-test-ship-site" });
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, {
    listingSetups: { [MARZ.storeConnectionId]: otherSite },
    summaries: { [MARZ.storeConnectionId]: listingSettingsSummary(MARZ.storeConnectionId,
      { state: "products_need_fix", productsNeedingFix: 2, missingPolicy: null }) } });

  await expect(page.getByText("Card Shellz lists on eBay US only. This store is set up for another eBay site. Contact support.", { exact: true }))
    .toBeVisible();
  // Card Shellz can't list on this eBay site at all, so the rail names the one thing that helps
  // (review round 4, describeListingSettingsRail), with nothing to retry.
  await expect(step(page, "setup")).toContainText("Contact support");
  for (const line of ["Choose a return policy", "2 products need a fix", "Couldn't check", "All set"]) {
    await expect(step(page, "setup")).not.toContainText(line);
  }
  await expect(page.getByTestId("catalog-step-setup-action")).toHaveCount(0);
  expect(state.setupWrites).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("a live eBay check that fails on Listing settings keeps the rail from saying All set, and Try again reads it again", async ({ page }) => {
  // eBay does not answer the first read.
  const state = await openCatalog(page, `${CATALOG_PATH}/setup`, { setupReadFailures: 1 });
  const retry = page.getByTestId("catalog-step-setup-action");
  const fulfillment = page.getByRole("combobox", { name: "Fulfillment policy", exact: true });
  const lastLoaded = page.getByText("Showing the last loaded setup. Use Refresh options to try again.", { exact: true });
  const reads = (count: number) => Array.from({ length: count }, () => MARZ.storeConnectionId);

  // The saved settings look complete, but nothing has checked them with eBay, so the rail does not
  // vouch for them (review round 3: a failed live read is an unchecked answer, DropshipPortalCatalog
  // liveSetup). Before, a failed first read counted as no live check and the rail said All set.
  // Scoped to the setup panel: the policy panel shows the same read's error.
  const setupPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: /^eBay listing setup/ }) }).last();
  await expect(setupPanel.getByText("eBay listing setup is unavailable.", { exact: true })).toBeVisible();
  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(retry).toHaveText("Try again");
  expect(state.setupReads).toEqual(reads(1));

  // Try again reads the live setup too, even with no answer to show yet (review round 3), and the
  // summary. (The policy panel also re-reads the summary when the setup read fails, as a
  // configuration change, so only "read again" is checked for the summary.)
  let summaryReadsBefore = state.summaryReads.length;
  await retry.click();
  await expect(fulfillment).toHaveText("USPS Ground Advantage");
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  expect(state.setupReads).toEqual(reads(2));
  await expect.poll(() => state.summaryReads.length).toBeGreaterThan(summaryReadsBefore);

  // eBay stops answering later. The panel keeps the last loaded setup, but that answer can no
  // longer vouch for the settings either.
  state.setupReadFailures = 1;
  await page.getByRole("button", { name: "Refresh options", exact: true }).click();
  await expect(lastLoaded).toBeVisible();
  await expect(fulfillment).toHaveText("USPS Ground Advantage");
  await expect(step(page, "setup")).toContainText("Couldn't check");
  await expect(step(page, "setup")).not.toContainText("All set");
  await expect(retry).toHaveText("Try again");
  expect(state.setupReads).toEqual(reads(3));

  // eBay is back: Try again reads the summary and the live setup again.
  summaryReadsBefore = state.summaryReads.length;
  await retry.click();
  await expect(step(page, "setup")).toContainText("All set");
  await expect(retry).toHaveCount(0);
  await expect(lastLoaded).toHaveCount(0);
  expect(state.setupReads).toEqual(reads(4));
  await expect.poll(() => state.summaryReads.length).toBeGreaterThan(summaryReadsBefore);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
