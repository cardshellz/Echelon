import { expect, test, type Locator, type Page, type TestInfo } from "playwright/test";
import { join, resolve } from "node:path";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/** Where screenshots go when WALLET_SHOTS_DIR is set (never in CI). */
const SHOTS_DIR = process.env.WALLET_SHOTS_DIR ?? null;
const HARNESS_PATH = "/__catalog-access-test";
const STAMP = "2026-09-27T12:00:00.000Z";
const LIVE_PROOF = { method: "email_mfa", verifiedAt: STAMP, expiresAt: "2999-01-01T00:00:00.000Z" };
const STORE_ID = 5;
const SHOP_STORE = {
  storeConnectionId: STORE_ID, vendorId: 1, platform: "shopify", externalAccountId: "test-shop", externalDisplayName: "Test Shop",
  shopDomain: "test-shop.myshopify.com", status: "connected", setupStatus: "ready", disconnectReason: null, disconnectedAt: null,
  graceEndsAt: null, tokenExpiresAt: null, hasAccessToken: true, hasRefreshToken: true, launchReady: true, lastSyncAt: null,
  lastOrderSyncAt: null, lastInventorySyncAt: null, orderProcessingConfig: { defaultWarehouseId: null }, createdAt: STAMP, updatedAt: STAMP,
};
const SELECTED_ROW = {
  productId: 11, productVariantId: 101, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: "ENV-SGL-P50",
  variantName: "Pack of 50", category: "Mailers", productLineIds: [], productLineNames: [], unitsPerVariant: 50,
  selectionDecision: { selected: true, reason: "selected", marketplaceQuantity: 25, quantityCapApplied: false, autoConnectNewSkus: true, autoListNewSkus: false },
  listingTier: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, reserveShortfallCents: 0, balanceShortfallCents: 0 },
};
const PREVIEW_ROW = {
  productVariantId: 101, productId: 11, sku: "ENV-SGL-P50", title: "Envelope Single Pocket, Pack of 50", platform: "shopify",
  listingMode: "create", currentListingStatus: "not_listed", previewStatus: "ready", blockers: [], warnings: [], marketplaceQuantity: 25,
  priceCents: 699, marketplaceCategoryId: null, marketplaceCategoryName: null, storeCategoryNames: [], businessPolicySelection: null,
  previewHash: "d".repeat(64), priceSettingRevisionId: null, contentEvidenceHash: "c".repeat(64),
};

type VendorStatus = "onboarding" | "active" | "paused";
interface PushReply { status: number; json: unknown; after?: (state: StubState) => void }
interface StubState {
  vendorStatus: VendorStatus;
  storeReady: boolean;
  proofs: Record<string, typeof LIVE_PROOF>;
  pushReplies: PushReply[];
  pushBodies: Array<Record<string, unknown>>;
  codesSent: string[];
  pushCalls: number;
  statusCalls: number;
  previewCalls: number;
  onboardingReads: number;
  authReads: number;
  unexpected: string[];
  errors: string[];
}

function onboardingJson(state: StubState) {
  return {
    vendor: { vendorId: 1, memberId: "m-1", businessName: "Marz Cards", contactName: null, email: "vendor@example.com", phone: null,
      status: state.vendorStatus, entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 1,
      standingReason: state.vendorStatus === "paused" ? "card_declined" : null, pausedAt: state.vendorStatus === "paused" ? STAMP : null },
    entitlement: { memberId: "m-1", cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops",
      subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
    storeConnections: { activeCount: 1, connectedCount: 1, launchReadyConnectedCount: state.storeReady ? 1 : 0, credentialAttentionCount: 0,
      needsAttentionCount: 0, totalCount: 1, includedLimit: 1, canConnectStore: false },
    catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
    wallet: { availableBalanceCents: 10_000, pendingBalanceCents: 0, activeFundingMethodCount: 1, activeStripeFundingMethodCount: 1,
      activeStripeCardFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0, autoReloadEnabled: true, autoReloadFundingMethodId: 10,
      autoReloadFundingMethodActive: true, autoReloadFundingMethodReady: true, autoReloadFundingMethodIsCard: true, hasActiveFundingMethod: true,
      hasStripeReadyFundingMethod: true, hasUsdcBaseFundingMethod: false, hasCardBackstop: true, autoReloadConfigured: true,
      hasSpendableBalance: true, walletReady: true },
    steps: [
      { key: "vendor_profile", label: "Vendor profile", status: "complete", required: true },
      { key: "store_connection", label: "Store connection", status: state.storeReady ? "complete" : "incomplete", required: true },
      { key: "catalog_available", label: "Card Shellz catalog", status: "complete", required: true },
      { key: "catalog_selection", label: "Catalog selection", status: "complete", required: true },
      { key: "wallet_payment", label: "Wallet and auto-reload", status: "complete", required: true },
    ],
  };
}

function settingsJson(state: StubState) {
  const vendor = onboardingJson(state).vendor;
  return { settings: {
    vendor: { vendorId: 1, memberId: "m-1", businessName: vendor.businessName, email: vendor.email, status: vendor.status,
      entitlementStatus: vendor.entitlementStatus, includedStoreConnections: 1 },
    account: { hasContactEmail: true, hasBusinessName: true },
    storeConnections: [{ ...SHOP_STORE, launchReady: state.storeReady, setupStatus: state.storeReady ? "ready" : "pending" }],
    wallet: { availableBalanceCents: 10_000, pendingBalanceCents: 0, autoReloadEnabled: true, fundingMethodCount: 1,
      activeStripeFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0, autoReloadFundingMethodReady: true },
    notificationPreferences: { configuredCount: 0 }, sections: [], generatedAt: STAMP,
  } };
}

async function setup(page: Page, initial: Partial<StubState> = {}) {
  const state: StubState = { vendorStatus: "active", storeReady: true, proofs: {}, pushReplies: [], pushBodies: [], codesSent: [], pushCalls: 0, statusCalls: 0,
    previewCalls: 0, onboardingReads: 0, authReads: 0, unexpected: [], errors: [], ...initial };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (path === "/api/dropship/auth/me") {
      state.authReads += 1;
      return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: "m-1", cardShellzEmail: "vendor@example.com", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: STAMP }, sensitiveProofs: state.proofs } });
    }
    if (path === "/api/dropship/onboarding/state" && method === "GET") {
      state.onboardingReads += 1;
      return route.fulfill({ json: onboardingJson(state) });
    }
    if (path === "/api/dropship/settings" && method === "GET") return route.fulfill({ json: settingsJson(state) });
    if (path === "/api/dropship/catalog" && method === "GET") {
      return route.fulfill({ json: { rows: [SELECTED_ROW], total: 1, page: 1, limit: Number(url.searchParams.get("limit") ?? 50),
        facets: { categories: [], productLines: [], products: [] } } });
    }
    if (path === "/api/dropship/catalog/selection-rules" && method === "GET") return route.fulfill({ json: { rules: [] } });
    if ((path === `/api/dropship/listings/stores/${STORE_ID}/pricing-rules`
      || path === `/api/dropship/listings/stores/${STORE_ID}/content-profile`) && method === "GET") {
      return route.fulfill({ json: { revisionId: null, profile: null, updatedAt: null } });
    }
    if (path === "/api/dropship/listings/preview" && method === "POST") {
      state.previewCalls += 1;
      return route.fulfill({ json: { preview: { vendorId: 1, storeConnectionId: STORE_ID, platform: "shopify", generatedAt: STAMP,
        rows: [PREVIEW_ROW], summary: { total: 1, ready: 1, blocked: 0, warning: 0 } } } });
    }
    if (path === "/api/dropship/listing-push-jobs" && method === "POST") {
      state.pushCalls += 1;
      state.pushBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      const reply = state.pushReplies.shift();
      if (!reply) { state.unexpected.push("POST listing-push-jobs without a scripted reply"); return route.fulfill({ status: 500, json: {} }); }
      reply.after?.(state);
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    if (/^\/api\/dropship\/listing-push-jobs\/\d+$/.test(path) && method === "GET") {
      state.statusCalls += 1;
      return route.fulfill({ json: pushJobStatus(Number(path.split("/").pop())) });
    }
    if (path === "/api/dropship/auth/sensitive-actions/challenge/start" && method === "POST") {
      state.codesSent.push((route.request().postDataJSON() as { action: string }).action);
      return route.fulfill({ status: 202, json: { method: "email_mfa", challengeId: "c-1", expiresAt: "2999-01-01T00:10:00.000Z" } });
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  await page.route(`**${HARNESS_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-catalog-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(HARNESS_PATH);
  return state;
}

/** What the server answers for a push: the job, its items and the preview it queued from. */
/** The worker's finished verdict for the job the page follows after queueing. */
function pushJobStatus(jobId: number) {
  return { job: { jobId, storeConnectionId: STORE_ID, platform: "shopify", environment: null, status: "completed", finished: true,
    createdAt: STAMP, updatedAt: STAMP, completedAt: STAMP,
    items: [{ itemId: 1, listingId: 100, productVariantId: 101, sku: "ENV-SGL-P50", productName: "Envelope Single Pocket",
      variantName: "Pack of 50", status: "completed", errorCode: null, errorMessage: null, retryable: null,
      externalListingId: "gid://shopify/Product/900", published: null, listingUrl: null }] } };
}

function pushResponse(rows: Array<typeof PREVIEW_ROW>, jobStatus: "queued" | "failed" = "queued") {
  const blocked = rows.filter((row) => row.previewStatus === "blocked").length;
  return {
    job: { jobId: 31, vendorId: 1, storeConnectionId: STORE_ID, status: jobStatus, idempotencyKey: "k", requestHash: "h",
      createdAt: STAMP, updatedAt: STAMP },
    items: rows.map((row, index) => ({ itemId: index + 1, jobId: 31, listingId: null, productVariantId: row.productVariantId,
      status: row.previewStatus === "blocked" ? "blocked" : "queued", previewHash: row.previewHash, errorCode: null, errorMessage: null })),
    preview: { vendorId: 1, storeConnectionId: STORE_ID, platform: "shopify", generatedAt: STAMP, rows,
      summary: { total: rows.length, ready: rows.length - blocked, blocked, warning: 0 } },
    idempotentReplay: false,
  };
}

function listingCard(page: Page): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Listing preview and push" }) });
}

async function shot(page: Page, testInfo: TestInfo, locator: Locator, name: string) {
  if (!SHOTS_DIR) return;
  await locator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS_DIR, `${testInfo.project.name}-${name}.png`) });
}

test("an onboarding vendor is told to activate, can still preview, and is never sent a code for a push the server would refuse", async ({ page }, testInfo) => {
  const state = await setup(page, { vendorStatus: "onboarding" });
  const card = listingCard(page);
  const notice = card.getByTestId("listing-access-notice");
  await expect(notice).toHaveText(/Your account isn't active yet, so listings can't be pushed to your store\. Finish the steps on the Onboarding page and choose Activate \.ops\./);
  await expect(notice.getByRole("link", { name: "Go to Onboarding" })).toHaveAttribute("href", "/dropship-portal/onboarding");

  await card.getByRole("button", { name: "Preview selected" }).click();
  await expect(card.getByText("Envelope Single Pocket, Pack of 50").first()).toBeVisible();
  await expect(card.getByRole("button", { name: "Queue ready listings" })).toBeDisabled();
  await shot(page, testInfo, card, "catalog-access-onboarding");
  expect(state.previewCalls).toBe(1);
  expect(state.pushCalls).toBe(0);
  expect(state.codesSent).toEqual([]);

  await notice.getByRole("link", { name: "Go to Onboarding" }).click();
  expect(new URL(page.url()).pathname).toBe("/dropship-portal/onboarding");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a paused vendor is sent to the Wallet page and cannot preview or push", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "paused" });
  const card = listingCard(page);
  const notice = card.getByTestId("listing-access-notice");
  await expect(notice).toHaveText(/Selling is paused on your account, so listings can't be previewed or pushed\. The Wallet page shows why and what to do\./);
  await expect(notice.getByRole("link", { name: "Go to Wallet" })).toHaveAttribute("href", "/dropship-portal/wallet");
  await expect(card.getByRole("button", { name: "Preview selected" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Queue ready listings" })).toBeDisabled();
  expect(state.previewCalls).toBe(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a refusal after the page loaded shows in the listing card with its fix, then the reloaded account explains it", async ({ page }, testInfo) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF }, pushReplies: [{
    status: 403,
    json: { error: { code: "DROPSHIP_LISTING_VENDOR_BLOCKED",
      message: "Selling is paused on your account, so listings can't be previewed or pushed. The Wallet page shows why and what to do.",
      context: { vendorId: 1, vendorStatus: "paused", action: "push", resolution: "resolve_pause" } } },
    // The pause happened between loading the page and queueing the push.
    after: (current) => { current.vendorStatus = "paused"; },
  }] });
  const card = listingCard(page);
  await expect(card.getByTestId("listing-access-notice")).toHaveCount(0);
  const readsBeforePush = state.onboardingReads;

  await card.getByRole("button", { name: "Preview selected" }).click();
  await card.getByRole("button", { name: "Queue ready listings" }).click();

  const notice = card.getByTestId("listing-access-notice");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Selling is paused on your account");
  await expect(notice.getByRole("link", { name: "Go to Wallet" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Queue ready listings" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Preview selected" })).toBeDisabled();
  await shot(page, testInfo, card, "catalog-access-refused-push");
  expect(state.onboardingReads).toBeGreaterThan(readsBeforePush);
  expect(state.pushCalls).toBe(1);
  // Nothing about this failure is shown at the top of the page, away from the button.
  await expect(page.locator("section").first().getByText("Selling is paused on your account")).toHaveCount(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("an expired verification asks again instead of repeating the refusal", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF }, pushReplies: [{
    status: 403,
    json: { error: { code: "DROPSHIP_STEP_UP_REQUIRED", message: "Recent dropship sensitive-action verification is required.",
      context: { action: "bulk_listing_push" } } },
    // The server no longer holds the proof this page still shows as current.
    after: (current) => { current.proofs = {}; },
  }] });
  const card = listingCard(page);
  await card.getByRole("button", { name: "Preview selected" }).click();
  const authReadsBeforePush = state.authReads;
  await card.getByRole("button", { name: "Queue ready listings" }).click();

  await expect(card.getByRole("alert")).toHaveText("Your verification expired before the push was queued. Choose Queue ready listings again to verify.");
  await expect.poll(() => state.authReads).toBeGreaterThan(authReadsBeforePush);
  await card.getByRole("button", { name: "Queue ready listings" }).click();
  await expect(card.getByText("Verification code to push listings")).toBeVisible();
  expect(state.codesSent).toEqual(["bulk_listing_push"]);
  expect(state.pushCalls).toBe(1);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a vendor with no ready store is sent to the store connection panel", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", storeReady: false });
  const notice = listingCard(page).getByTestId("listing-access-notice");
  await expect(notice).toHaveText(/Connect your store and finish its setup before previewing or pushing listings\./);
  await expect(notice.getByRole("link", { name: "Go to store connection" })).toHaveAttribute("href", "/dropship-portal/onboarding");
  await expect(listingCard(page).getByRole("button", { name: "Preview selected" })).toBeDisabled();
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("queues in one click without a preview and shows what was queued", async ({ page }, testInfo) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF },
    pushReplies: [{ status: 201, json: pushResponse([PREVIEW_ROW]) }] });
  const card = listingCard(page);

  await card.getByRole("button", { name: "Queue ready listings" }).click();

  // The page follows job 31 and shows what became of the listing, in the vendor's words.
  await expect(card.getByTestId("listing-queue-result")).toContainText("Live on Test Shop: 1 listing.");
  await expect(card.getByTestId("listing-push-outcome-1")).toHaveText("Envelope Single Pocket · Pack of 50 · ENV-SGL-P50: Live on Test Shop.");
  expect(state.statusCalls).toBeGreaterThanOrEqual(1);
  await expect(card.getByText("This preview is out of date", { exact: false })).toHaveCount(0);
  await expect(card.getByText("ENV-SGL-P50").first()).toBeVisible();
  await shot(page, testInfo, card, "catalog-one-step-queued");
  // One request, built from the selection alone: nothing is echoed from a preview.
  expect(state.previewCalls).toBe(0);
  expect(state.pushCalls).toBe(1);
  expect(state.pushBodies[0]).toEqual({
    storeConnectionId: STORE_ID,
    productVariantIds: [101],
    idempotencyKey: expect.stringMatching(/^listing-push:/),
    reviewMode: "current_preview",
  });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("sends the same request once more when a listing changed while it was being queued", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF }, pushReplies: [
    { status: 409, json: { error: { code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
      message: "Pricing rules or their cost basis changed while queueing. Generate a new preview." } } },
    { status: 201, json: pushResponse([PREVIEW_ROW]) },
  ] });
  const card = listingCard(page);

  await card.getByRole("button", { name: "Queue ready listings" }).click();

  await expect(card.getByTestId("listing-queue-result")).toContainText("Live on Test Shop: 1 listing.");
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(state.pushCalls).toBe(2);
  // The refused attempt wrote nothing, so the retry reuses its key.
  expect(state.pushBodies[1]).toEqual(state.pushBodies[0]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("says plainly when nothing selected was ready to queue", async ({ page }) => {
  const blockedRow = { ...PREVIEW_ROW, previewStatus: "blocked", blockers: ["catalog_package_data_required"] };
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF },
    pushReplies: [{ status: 201, json: pushResponse([blockedRow], "failed") }] });
  const card = listingCard(page);

  await card.getByRole("button", { name: "Queue ready listings" }).click();

  await expect(card.getByTestId("listing-queue-result"))
    .toHaveText("Nothing was queued: the selected listing is not ready. The table below shows why.");
  expect(state.pushCalls).toBe(1);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
