import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

const HARNESS_PATH = "/__onboarding-test";
const STAMP = "2026-09-15T00:00:00.000Z";
const LIVE_PROOF = { method: "email_mfa", verifiedAt: STAMP, expiresAt: "2999-01-01T00:00:00.000Z" };
const EBAY_STORE = {
  storeConnectionId: 1, vendorId: 1, platform: "ebay", externalAccountId: "3swFOQgNRJi", externalDisplayName: "marz_cards", shopDomain: null,
  status: "connected", setupStatus: "ready", disconnectReason: null, disconnectedAt: null, graceEndsAt: null, tokenExpiresAt: null,
  hasAccessToken: true, hasRefreshToken: true, launchReady: true, lastSyncAt: null, lastOrderSyncAt: null, lastInventorySyncAt: null,
  orderProcessingConfig: { defaultWarehouseId: null }, createdAt: STAMP, updatedAt: STAMP,
};

interface StubState {
  vendorStatus: "onboarding" | "active" | "paused";
  storeReady: boolean;
  catalogOpen: boolean;
  selectionSaved: boolean;
  walletReady: boolean;
  proofs: Record<string, { method: string; verifiedAt: string; expiresAt: string }>;
  activations: number;
  codesSent: string[];
  unexpected: string[];
  errors: string[];
}

function stepStatus(done: boolean) {
  return done ? "complete" : "incomplete";
}

function onboardingJson(state: StubState) {
  return {
    vendor: { vendorId: 1, memberId: "m-1", businessName: "Marz Cards", contactName: null, email: "vendor@example.com", phone: null,
      status: state.vendorStatus, entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 1, standingReason: null, pausedAt: null },
    entitlement: { memberId: "m-1", cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops", subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
    storeConnections: { activeCount: state.storeReady ? 1 : 0, connectedCount: state.storeReady ? 1 : 0, launchReadyConnectedCount: state.storeReady ? 1 : 0,
      credentialAttentionCount: 0, needsAttentionCount: 0, totalCount: state.storeReady ? 1 : 0, includedLimit: 1, canConnectStore: !state.storeReady },
    catalog: { adminExposureRuleCount: state.catalogOpen ? 1 : 0, vendorSelectionRuleCount: state.selectionSaved ? 2 : 0, adminCatalogAvailable: state.catalogOpen, hasVendorSelection: state.selectionSaved },
    wallet: { availableBalanceCents: 0, pendingBalanceCents: 0, activeFundingMethodCount: state.walletReady ? 1 : 0, activeStripeFundingMethodCount: state.walletReady ? 1 : 0,
      activeStripeCardFundingMethodCount: state.walletReady ? 1 : 0, activeUsdcBaseFundingMethodCount: 0, autoReloadEnabled: state.walletReady, autoReloadFundingMethodId: state.walletReady ? 10 : null,
      autoReloadFundingMethodActive: state.walletReady, autoReloadFundingMethodReady: state.walletReady, autoReloadFundingMethodIsCard: state.walletReady,
      hasActiveFundingMethod: state.walletReady, hasStripeReadyFundingMethod: state.walletReady, hasUsdcBaseFundingMethod: false, hasCardBackstop: state.walletReady,
      autoReloadConfigured: state.walletReady, hasSpendableBalance: false, walletReady: state.walletReady },
    steps: [
      { key: "vendor_profile", label: "Vendor profile", status: "complete", required: true },
      { key: "store_connection", label: "Store connection", status: stepStatus(state.storeReady), required: true },
      { key: "catalog_available", label: "Card Shellz catalog", status: stepStatus(state.catalogOpen), required: true },
      { key: "catalog_selection", label: "Catalog selection", status: stepStatus(state.selectionSaved), required: true },
      { key: "wallet_payment", label: "Wallet and auto-reload", status: stepStatus(state.walletReady), required: true },
    ],
  };
}

async function setup(page: Page, initial: Partial<StubState> = {}) {
  const state: StubState = { vendorStatus: "onboarding", storeReady: true, catalogOpen: true, selectionSaved: true, walletReady: false,
    proofs: {}, activations: 0, codesSent: [], unexpected: [], errors: [], ...initial };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/dropship/auth/me") {
      return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: "m-1", cardShellzEmail: "vendor@example.com", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: STAMP }, sensitiveProofs: state.proofs } });
    }
    if (url.pathname === "/api/dropship/auth/sensitive-actions/challenge/start") {
      const body = route.request().postDataJSON() as { action: string };
      state.codesSent.push(body.action);
      return route.fulfill({ status: 202, json: { method: "email_mfa", challengeId: "c-1", expiresAt: "2026-09-15T00:10:00.000Z" } });
    }
    if (url.pathname === "/api/dropship/auth/sensitive-actions/challenge/verify") {
      const body = route.request().postDataJSON() as { action: string; verificationCode: string };
      if (body.verificationCode !== "123456") return route.fulfill({ status: 400, json: { error: { message: "That code is not right." } } });
      state.proofs[body.action] = LIVE_PROOF;
      return route.fulfill({ json: { action: body.action, ...LIVE_PROOF } });
    }
    if (url.pathname === "/api/dropship/onboarding/state" && method === "GET") {
      return route.fulfill({ json: onboardingJson(state) });
    }
    if (url.pathname === "/api/dropship/store-connections" && method === "GET") {
      const vendor = onboardingJson(state).vendor;
      return route.fulfill({ json: { vendor, connections: state.storeReady ? [EBAY_STORE] : [], setupChecksByConnectionId: {} } });
    }
    if (url.pathname === "/api/dropship/onboarding/activate" && method === "POST") {
      state.activations += 1;
      state.vendorStatus = "active";
      return route.fulfill({ json: onboardingJson(state) });
    }
    state.unexpected.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  await page.route(`**${HARNESS_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-onboarding-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(HARNESS_PATH);
  return state;
}

test("shows one checklist with a button on each open step, the store panel below it, and nothing repeated", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByTestId("onboarding-progress")).toHaveText("4 of 5 complete");
  const checklist = page.getByTestId("onboarding-checklist");
  await expect(checklist.getByTestId("onboarding-step-store_connection")).toContainText("Your store is connected and launch ready.");
  await expect(checklist.getByTestId("onboarding-step-store_connection").getByRole("button")).toHaveCount(0);
  await expect(checklist.getByTestId("onboarding-step-catalog_available")).toContainText("Card Shellz has opened the catalog to you.");
  await expect(checklist.getByTestId("onboarding-step-catalog_selection")).toContainText("2 product selection rules saved.");
  await expect(checklist.getByTestId("onboarding-step-catalog_selection").getByRole("button", { name: "Open catalog" })).toBeVisible();
  const walletRow = checklist.getByTestId("onboarding-step-wallet_payment");
  await expect(walletRow).toContainText("To do");
  await expect(walletRow).toContainText("Add your backup card in Wallet, then choose how to keep the wallet topped up.");
  // The old right-hand gate cards are gone: one place for status, one place for the action.
  await expect(page.getByText("Catalog availability")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage catalog" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "eBay connected" })).toHaveCount(1);
  // Activation lives in the same card and explains what is left.
  const activation = page.getByTestId("onboarding-activation");
  await expect(activation).toContainText("Finish the remaining step above, then activate.");
  await expect(activation.getByRole("button", { name: "Send verification code" })).toBeDisabled();
  // The nav still offers Onboarding while the vendor is on it.
  await expect(page.getByTestId("portal-nav").getByRole("button", { name: "Onboarding" })).toBeVisible();

  await walletRow.getByRole("button", { name: "Set up wallet" }).click();
  expect(new URL(page.url()).pathname.endsWith("/wallet")).toBe(true);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("catalog access reads as waiting on Card Shellz, and the store row's button brings the connect panel into view", async ({ page }) => {
  const state = await setup(page, { storeReady: false, catalogOpen: false, selectionSaved: false });
  await expect(page.getByTestId("onboarding-progress")).toHaveText("1 of 5 complete");
  const catalogRow = page.getByTestId("onboarding-step-catalog_available");
  await expect(catalogRow).toContainText("Waiting on Card Shellz");
  await expect(catalogRow).toContainText("Nothing for you to do yet.");
  await expect(catalogRow.getByRole("button")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-step-catalog_selection")).toContainText("Pick products once Card Shellz opens the catalog.");
  await expect(page.getByTestId("onboarding-activation")).toContainText("Finish the 4 remaining steps above, then activate.");

  const storeRow = page.getByTestId("onboarding-step-store_connection");
  await expect(storeRow).toContainText("Connect your eBay or Shopify store below.");
  await storeRow.getByRole("button", { name: "Connect store" }).click();
  await expect(page.getByRole("heading", { name: "Connect store" })).toBeInViewport();
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("activation takes one emailed code and keeps the confirmation on screen, while the nav drops Onboarding", async ({ page }) => {
  const state = await setup(page, { walletReady: true });
  await expect(page.getByTestId("onboarding-progress")).toHaveText("5 of 5 complete");
  const activation = page.getByTestId("onboarding-activation");
  await expect(activation).toContainText("Everything is in place. Activate to start accepting orders.");
  await activation.getByRole("button", { name: "Send verification code" }).click();
  expect(state.codesSent).toEqual(["activate_account"]);
  await activation.locator("input").first().fill("123456");
  await activation.getByRole("button", { name: "Activate .ops" }).click();
  await expect(activation).toContainText("Your .ops account is active.");
  await expect(activation.getByRole("button", { name: "Open dashboard" })).toBeVisible();
  expect(state.activations).toBe(1);
  // The checklist stays for the vendor to read; the nav no longer offers a page that is finished.
  await expect(page.getByTestId("onboarding-checklist")).toBeVisible();
  await expect(page.getByTestId("portal-nav").getByRole("button", { name: "Onboarding" })).toHaveCount(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a vendor past onboarding sees a short account summary with the store panel, not the checklist", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", walletReady: true });
  const summary = page.getByTestId("onboarding-account-summary");
  await expect(summary).toContainText("Your .ops account is active");
  await expect(summary.getByRole("button", { name: "Open dashboard" })).toBeVisible();
  await expect(page.getByTestId("onboarding-checklist")).toHaveCount(0);
  await expect(page.getByTestId("onboarding-progress")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "eBay connected" })).toBeVisible();
  await expect(page.getByTestId("portal-nav").getByRole("button", { name: "Onboarding" })).toHaveCount(0);
  await expect(page.getByTestId("portal-nav").getByRole("button", { name: "Dashboard" })).toBeVisible();
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
