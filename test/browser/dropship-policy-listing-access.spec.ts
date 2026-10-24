import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { join, resolve } from "node:path";
import { listingIntentChangeStatusSchema, type ListingIntentChangeStatus } from "../../shared/listing-intent-propagation";
import {
  createListingPushRunRequestSchema,
  createListingPushRunResponseSchema,
  emptyListingPushRunCounts,
  listListingPushRunsResponseSchema,
  listingPushRunDetailResponseSchema,
  type ListingPushRunView,
} from "../../shared/dropship/listing-push-runs";
import {
  dropshipCatalogCategoriesAnswerSchema,
  dropshipCatalogIdsAnswerSchema,
  dropshipCatalogNewItemsAnswerSchema,
  dropshipCatalogSelectionSummarySchema,
} from "../../shared/dropship/vendor-catalog-reads";
import type { z } from "zod";
import { listingIntentChangePage } from "./fixtures/listing-intent-changes.fixture";

/** An answer typed against its shared contract, so a field the contract adds fails the stub type check (review round 2 CT11). */
function contractAnswer<S extends z.ZodTypeAny>(schema: S, value: z.input<S>): z.output<S> {
  return schema.parse(value);
}

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

/** Where screenshots go when WALLET_SHOTS_DIR is set (never in CI). */
const SHOTS_DIR = process.env.WALLET_SHOTS_DIR ?? null;
/** The Catalog page's own addresses; the harness is served for each, so the page opens on the step it names. */
const CATALOG_PATH = "/dropship-portal/catalog";
const STAMP = "2026-09-27T12:00:00.000Z";
const LIVE_PROOF = { method: "email_mfa", verifiedAt: STAMP, expiresAt: "2999-01-01T00:00:00.000Z" };
const STORE_ID = 5;
const EBAY_STORE = {
  storeConnectionId: STORE_ID, vendorId: 1, platform: "ebay", externalAccountId: "test-ebay-seller", externalDisplayName: "Test eBay Store",
  shopDomain: null, status: "connected", setupStatus: "ready", disconnectReason: null, disconnectedAt: null,
  graceEndsAt: null, tokenExpiresAt: null, hasAccessToken: true, hasRefreshToken: true, launchReady: true, lastSyncAt: null,
  lastOrderSyncAt: null, lastInventorySyncAt: null, orderProcessingConfig: { defaultWarehouseId: null }, createdAt: STAMP, updatedAt: STAMP,
};
const SELECTED_ROW = {
  productId: 11, productVariantId: 101, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: "ENV-SGL-P50",
  variantName: "Pack of 50", category: "Mailers", categoryId: 30, productLineIds: [], productLineNames: [], unitsPerVariant: 50,
  // PR B's row (V24, V27): the vendor's pick, and the category id step 1 filters by.
  selectionDecision: { selected: true, reason: "selected", picked: true, marketplaceQuantity: 25, quantityCapApplied: false,
    autoConnectNewSkus: false, autoListNewSkus: false },
  listingTier: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, reserveShortfallCents: 0, balanceShortfallCents: 0 },
};
const PREVIEW_ROW = {
  productVariantId: 101, productId: 11, sku: "ENV-SGL-P50", title: "Envelope Single Pocket, Pack of 50", platform: "ebay",
  listingMode: "create", currentListingStatus: "not_listed", previewStatus: "ready", blockers: [], warnings: [], marketplaceQuantity: 25,
  priceCents: 699, marketplaceCategoryId: "183435", marketplaceCategoryName: "Card Sleeves", storeCategoryNames: [], businessPolicySelection: null,
  previewHash: "d".repeat(64), priceSettingRevisionId: null, contentEvidenceHash: "c".repeat(64),
};

type VendorStatus = "onboarding" | "active" | "paused";
/** How the next publish run create answers (step 1 plan S2-5 PR A: step 3 publishes through runs). */
interface RunReply { status: number; json: unknown; after?: (state: StubState) => void }
interface StubState {
  vendorStatus: VendorStatus;
  storeReady: boolean;
  proofs: Record<string, typeof LIVE_PROOF>;
  runReplies: RunReply[];
  runBodies: Array<Record<string, unknown>>;
  codesSent: string[];
  runCalls: number;
  runDetailCalls: number;
  previewCalls: number;
  onboardingReads: number;
  authReads: number;
  unexpected: string[];
  errors: string[];
  history: ListingIntentChangeStatus[];
  historyRetryStatuses: number[];
  historyRetryPaths: string[];
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
    catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, vendorSelectedItemCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
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

/** The listing settings summary the rail reads (shared/dropship/listing-settings.ts), all set. */
function listingSettingsSummary() {
  const policy = (policyId: string) => ({ policyId, verification: "not_checked" });
  return { storeConnectionId: STORE_ID, storeStatus: "connected", access: { allowed: true }, catalog: { state: "ok", products: 1, sizes: 1 },
    storeDefaults: { price: { recipe: null, groupRules: 0 }, shippingPolicy: policy("ground"), returnPolicy: policy("returns"),
      paymentPolicy: policy("payments"), ebayCategory: { category: null, groupRules: 0 },
      description: { hasIntroduction: false, hasFooter: false, groupRules: 0 } },
    counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0, exactPrices: 0, belowCost: 0, cannotPrice: 0, paused: 0 },
    attention: { items: [], total: 0 }, rail: { state: "all_set", productsNeedingFix: 0, missingPolicy: null }, generatedAt: STAMP };
}

function settingsJson(state: StubState) {
  const vendor = onboardingJson(state).vendor;
  return { settings: {
    vendor: { vendorId: 1, memberId: "m-1", businessName: vendor.businessName, email: vendor.email, status: vendor.status,
      entitlementStatus: vendor.entitlementStatus, includedStoreConnections: 1 },
    account: { hasContactEmail: true, hasBusinessName: true },
    storeConnections: [{ ...EBAY_STORE, launchReady: state.storeReady, setupStatus: state.storeReady ? "ready" : "pending" }],
    wallet: { availableBalanceCents: 10_000, pendingBalanceCents: 0, autoReloadEnabled: true, fundingMethodCount: 1,
      activeStripeFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0, autoReloadFundingMethodReady: true },
    notificationPreferences: { configuredCount: 0 }, sections: [], generatedAt: STAMP,
  } };
}

async function setup(page: Page, initial: Partial<StubState> = {}) {
  const state: StubState = { vendorStatus: "active", storeReady: true, proofs: {}, runReplies: [], runBodies: [], codesSent: [], runCalls: 0, runDetailCalls: 0,
    previewCalls: 0, onboardingReads: 0, authReads: 0, unexpected: [], errors: [],
    history: [], historyRetryStatuses: [], historyRetryPaths: [], ...initial };
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
    const historyPath = `/api/dropship/listings/stores/${STORE_ID}/listing-intent-changes`;
    if (path === historyPath && method === "GET") {
      return route.fulfill({ json: listingIntentChangePage(url, state.history) });
    }
    const historyRow = state.history.find((row) => path === `${historyPath}/${row.id}/retry`);
    if (historyRow && method === "POST" && state.historyRetryStatuses.length > 0) {
      state.historyRetryPaths.push(path);
      const status = state.historyRetryStatuses.shift()!;
      if (status !== 200) return route.fulfill({ status, json: { message: "The retry could not be requested. Try again." } });
      historyRow.state = "pending";
      historyRow.can_retry = false;
      historyRow.last_error_code = null;
      historyRow.last_error_message = null;
      historyRow.last_error_resolution = null;
      return route.fulfill({ json: { retried: true } });
    }
    // The step rail's line under Listing settings comes from the saved-settings summary, on every step.
    if (path === `/api/dropship/listings/stores/${STORE_ID}/listing-settings/summary` && method === "GET") {
      return route.fulfill({ json: listingSettingsSummary() });
    }
    if (path === "/api/dropship/catalog" && method === "GET") {
      // Step 3's Check reads the selected ids (step 1 plan S2-5 §4.8), its list a page with the new summary.
      if (url.searchParams.get("idsOnly") === "true") {
        return route.fulfill({ json: dropshipCatalogIdsAnswerSchema.parse({ selectedIds: [101], notSelectedIds: [], total: 1 }) });
      }
      return route.fulfill({ json: { rows: [SELECTED_ROW], total: 1, page: 1, limit: Number(url.searchParams.get("limit") ?? 50),
        facets: url.searchParams.get("includeFacets") === "false" ? null : { categories: [], productLines: [], products: [] },
        summary: { matching: 1, matchingSelected: 1 } } });
    }
    // A journey that leaves the Catalog page lands on a portal path the harness renders as step 1, whose categories
    // card reads its counts on mount (PLAN-B v4.1 §12.2, V26).
    if (path === "/api/dropship/catalog/categories" && method === "GET") {
      return route.fulfill({ json: contractAnswer(dropshipCatalogCategoriesAnswerSchema, {
        categories: [{ categoryId: 30, name: "Mailers", rowCount: 1, selectedCount: 1 }], uncategorizedCount: 0 }) });
    }
    // The same step 1 reads its new-items notice on mount (PLAN-B v4.1 §11.4, B3): nothing new here.
    if (path === "/api/dropship/catalog/new-items" && method === "GET") {
      return route.fulfill({ json: contractAnswer(dropshipCatalogNewItemsAnswerSchema, { categories: [] }) });
    }
    if (path === "/api/dropship/catalog/selection" && method === "GET") {
      const store = url.searchParams.get("storeConnectionId");
      return route.fulfill({ json: contractAnswer(dropshipCatalogSelectionSummarySchema, { selectionRevisionId: 1, selectedTotal: 1, cap: 10_000, overCap: false,
        store: store === null ? null : { storeConnectionId: Number(store), live: 0, notLive: 1 } }) });
    }
    if (path === "/api/dropship/catalog/selection-rules" && method === "GET") return route.fulfill({ json: { rules: [] } });
    if ((path === `/api/dropship/listings/stores/${STORE_ID}/pricing-rules`
      || path === `/api/dropship/listings/stores/${STORE_ID}/content-profile`) && method === "GET") {
      return route.fulfill({ json: { revisionId: null, profile: null, updatedAt: null } });
    }
    if (path === "/api/dropship/listings/preview" && method === "POST") {
      state.previewCalls += 1;
      return route.fulfill({ json: { preview: { vendorId: 1, storeConnectionId: STORE_ID, platform: "ebay", generatedAt: STAMP,
        rows: [PREVIEW_ROW], summary: { total: 1, ready: 1, blocked: 0, warning: 0 } } } });
    }
    if (path === "/api/dropship/listing-push-runs" && method === "GET") return route.fulfill({ json: contractAnswer(listListingPushRunsResponseSchema, { runs: [] }) });
    if (path === "/api/dropship/listing-push-runs" && method === "POST") {
      state.runCalls += 1;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.runBodies.push(body);
      if (!createListingPushRunRequestSchema.safeParse(body).success) state.unexpected.push("POST listing-push-runs (body off contract)");
      const reply = state.runReplies.shift();
      if (!reply) { state.unexpected.push("POST listing-push-runs without a scripted reply"); return route.fulfill({ status: 500, json: {} }); }
      reply.after?.(state);
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    if (/^\/api\/dropship\/listing-push-runs\/\d+$/.test(path) && method === "GET") {
      state.runDetailCalls += 1;
      return route.fulfill({ json: finishedRun(Number(path.split("/").pop())) });
    }
    if (path === "/api/dropship/auth/sensitive-actions/challenge/start" && method === "POST") {
      state.codesSent.push((route.request().postDataJSON() as { action: string }).action);
      return route.fulfill({ status: 202, json: { method: "email_mfa", challengeId: "c-1", expiresAt: "2999-01-01T00:10:00.000Z" } });
    }
    state.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  await page.route(`**${CATALOG_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-catalog-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  // The listing card lives on the Publish step.
  await page.goto(`${CATALOG_PATH}/publish`);
  return state;
}

function runView(runId: number, overrides: Partial<ListingPushRunView> = {}): ListingPushRunView {
  return { runId, storeConnectionId: STORE_ID, scope: "not_live", status: "processing", stopReason: null, selectionRevisionId: 1, targetCount: 1,
    chunkSize: 500, chunkCount: 1, nextChunkIndex: 0, cancelRequestedAt: null, createdAt: STAMP, updatedAt: STAMP, completedAt: null, ...overrides };
}

/** The run create's answer: run 31 made from the selection's one size. */
function createdRun() {
  return contractAnswer(createListingPushRunResponseSchema, { run: runView(31), idempotentReplay: false });
}

/** The run the page follows after publishing: its one size published. */
function finishedRun(runId: number) {
  return contractAnswer(listingPushRunDetailResponseSchema, { run: runView(runId, { status: "completed", completedAt: STAMP, nextChunkIndex: 1 }),
    counts: { ...emptyListingPushRunCounts(), completed: 1 }, problems: { items: [], nextCursor: null }, waitingUntil: null, drafts: 0 });
}

function listingCard(page: Page): Locator {
  return page.locator("section").filter({ has: page.getByRole("heading", { name: "Check and publish" }) });
}

async function shot(page: Page, testInfo: TestInfo, locator: Locator, name: string) {
  if (!SHOTS_DIR) return;
  await locator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(SHOTS_DIR, `${testInfo.project.name}-${name}.png`) });
}

// Step 1 plan S2-5 PR A: step 3 publishes through runs ("Publish {n} new"), and its optional Check previews the
// selection; the account's blocks, the step-up and the refusals keep their places in the step's card.
test("an onboarding vendor is told to activate, can still check, and is never sent a code for a publish the server would refuse", async ({ page }, testInfo) => {
  const state = await setup(page, { vendorStatus: "onboarding" });
  const card = listingCard(page);
  const notice = card.getByTestId("listing-access-notice");
  await expect(notice).toHaveText(/Your account isn't active yet, so listings can't be pushed to your store\. Finish the steps on the Onboarding page and choose Activate \.ops\./);
  await expect(notice.getByRole("link", { name: "Go to Onboarding" })).toHaveAttribute("href", "/dropship-portal/onboarding");

  await card.getByRole("button", { name: "Check listings" }).click();
  await expect(card.getByText("Envelope Single Pocket, Pack of 50").first()).toBeVisible();
  // The row's price links to the product's drawer in Listing settings (PR 10h): the address is checked, not followed.
  await expect(card.getByRole("link", { name: "Change in Listing settings: ENV-SGL-P50" }))
    .toHaveAttribute("href", "/dropship-portal/catalog/setup?product=11&size=101");
  await expect(card.getByRole("button", { name: "Publish 1 new" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Publish all 1" })).toBeDisabled();
  await shot(page, testInfo, card, "catalog-access-onboarding");
  expect(state.previewCalls).toBe(1);
  expect(state.runCalls).toBe(0);
  expect(state.codesSent).toEqual([]);

  await notice.getByRole("link", { name: "Go to Onboarding" }).click();
  expect(new URL(page.url()).pathname).toBe("/dropship-portal/onboarding");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a paused vendor is sent to the Wallet page and cannot check or publish", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "paused" });
  const card = listingCard(page);
  const notice = card.getByTestId("listing-access-notice");
  await expect(notice).toHaveText(/Selling is paused on your account, so listings can't be previewed or pushed\. The Wallet page shows why and what to do\./);
  await expect(notice.getByRole("link", { name: "Go to Wallet" })).toHaveAttribute("href", "/dropship-portal/wallet");
  await expect(card.getByRole("button", { name: "Check listings" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Publish 1 new" })).toBeDisabled();
  expect(state.previewCalls).toBe(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a refusal after the page loaded shows in the step's card with its fix, then the reloaded account explains it", async ({ page }, testInfo) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF }, runReplies: [{
    status: 403,
    json: { error: { code: "DROPSHIP_LISTING_VENDOR_BLOCKED",
      message: "Selling is paused on your account, so listings can't be previewed or pushed. The Wallet page shows why and what to do.",
      context: { resolution: "resolve_pause" } } },
    // The pause happened between loading the page and pressing Publish.
    after: (current) => { current.vendorStatus = "paused"; },
  }] });
  const card = listingCard(page);
  await expect(card.getByTestId("listing-access-notice")).toHaveCount(0);
  const readsBeforePublish = state.onboardingReads;

  await card.getByRole("button", { name: "Check listings" }).click();
  await expect(card.getByTestId("publish-check-summary")).toBeVisible();
  await card.getByRole("button", { name: "Publish 1 new" }).click();

  const notice = card.getByTestId("listing-access-notice");
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("Selling is paused on your account");
  await expect(notice.getByRole("link", { name: "Go to Wallet" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Publish 1 new" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Check listings" })).toBeDisabled();
  await shot(page, testInfo, card, "catalog-access-refused-push");
  expect(state.onboardingReads).toBeGreaterThan(readsBeforePublish);
  expect(state.runCalls).toBe(1);
  // The failure shows once, inside the step's card next to its buttons, never at the top of the page.
  await expect(page.getByText("Selling is paused on your account", { exact: false })).toHaveCount(1);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("an expired verification asks again instead of repeating the refusal", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF }, runReplies: [{
    status: 403,
    json: { error: { code: "DROPSHIP_STEP_UP_REQUIRED", message: "Recent dropship sensitive-action verification is required.",
      context: { action: "bulk_listing_push" } } },
    // The server no longer holds the proof this page still shows as current.
    after: (current) => { current.proofs = {}; },
  }] });
  const card = listingCard(page);
  const authReadsBeforePublish = state.authReads;
  await card.getByRole("button", { name: "Publish 1 new" }).click();

  await expect(card.getByRole("alert")).toHaveText("Your verification expired before publishing started. Press Publish again to verify.");
  await expect.poll(() => state.authReads).toBeGreaterThan(authReadsBeforePublish);
  await card.getByRole("button", { name: "Publish 1 new" }).click();
  await expect(card.getByText("Verification code to publish listings")).toBeVisible();
  expect(state.codesSent).toEqual(["bulk_listing_push"]);
  expect(state.runCalls).toBe(1);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a vendor with no ready store is sent to the store connection panel", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", storeReady: false });
  const notice = listingCard(page).getByTestId("listing-access-notice");
  await expect(notice).toHaveText(/Connect your eBay store and finish its setup before checking or publishing listings\./);
  await expect(notice.getByRole("link", { name: "Go to store connection" })).toHaveAttribute("href", "/dropship-portal/onboarding");
  await expect(listingCard(page).getByRole("button", { name: "Check listings" })).toBeDisabled();
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("publishes in one press without a check and shows what was published", async ({ page }, testInfo) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF },
    runReplies: [{ status: 202, json: createdRun() }] });
  const card = listingCard(page);

  await card.getByRole("button", { name: "Publish 1 new" }).click();

  // The page follows run 31 and says what became of it, in the vendor's words.
  await expect(card.getByTestId("publish-run-title")).toHaveText("Publishing finished.");
  await expect(card.getByTestId("publish-run-counts")).toHaveText("1 published");
  expect(state.runDetailCalls).toBeGreaterThanOrEqual(1);
  await expect(card.getByText("These results are out of date", { exact: false })).toHaveCount(0);
  await shot(page, testInfo, card, "catalog-one-step-queued");
  // One request with a scope and the revision counted from: the server snapshots the selection, nothing is echoed.
  expect(state.previewCalls).toBe(0);
  expect(state.runCalls).toBe(1);
  expect(state.runBodies[0]).toEqual({
    storeConnectionId: STORE_ID,
    scope: "not_live",
    idempotencyKey: expect.stringMatching(/^listing-push-run:/),
    expectedSelectionRevisionId: 1,
  });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("sends the same request once more when a selection save held the vendor's lock", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF }, runReplies: [
    { status: 409, json: { error: { code: "DROPSHIP_LISTING_PUSH_RUN_BUSY", message: "Your choices are being saved. Publishing will start in a moment." } } },
    { status: 202, json: createdRun() },
  ] });
  const card = listingCard(page);

  await card.getByRole("button", { name: "Publish 1 new" }).click();

  await expect(card.getByTestId("publish-run-title")).toHaveText("Publishing finished.");
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(state.runCalls).toBe(2);
  // The busy answer wrote nothing, so the retry reuses its key.
  expect(state.runBodies[1]).toEqual(state.runBodies[0]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("says plainly when everything selected is already on eBay", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "active", proofs: { bulk_listing_push: LIVE_PROOF },
    runReplies: [{ status: 422, json: { error: { code: "DROPSHIP_LISTING_PUSH_RUN_EMPTY",
      message: "Everything selected is already on eBay. Use Publish all to re-send it.",
      context: { scope: "not_live", liveCount: 1, selectedCount: 1 } } } }] });
  const card = listingCard(page);

  await card.getByRole("button", { name: "Publish 1 new" }).click();

  await expect(card.getByRole("alert")).toHaveText("Everything selected is already on eBay. Use Publish all to re-send it.");
  expect(state.runCalls).toBe(1);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});


function blockedListingChange(overrides: Partial<ListingIntentChangeStatus> = {}): ListingIntentChangeStatus {
  return listingIntentChangeStatusSchema.parse({
    id: "9007199254740993", change_id: "9007199254740995",
    destination: { kind: "dropship", provider: "ebay", connectionId: STORE_ID, channelId: null,
      vendorId: 1, accountId: "test-ebay-seller", environment: "production", marketplaceId: "EBAY_US", ambiguousConnection: false },
    product_id: 11, variant_ids: [101], state: "blocked", receipt: null, can_retry: true,
    last_error_code: "DROPSHIP_LISTING_STORE_BLOCKED",
    last_error_message: "Your store needs authorization again. Reconnect it on the Onboarding page.",
    last_error_resolution: "reconnect_store", attempt_count: 1, created_at: STAMP, updated_at: STAMP,
    source_relation: "dropship.dropship_product_listing_settings", changed_fields: ["current_revision_id"],
    operation: "UPDATE", before_scope: { store_connection_id: STORE_ID, product_id: 11 },
    after_scope: { store_connection_id: STORE_ID, product_id: 11 }, actor_provenance: { source: "browser_fixture" },
    ...overrides,
  });
}

test("saved listing attention uses the supported connection remedy and never offers an ineligible retry", async ({ page }) => {
  const state = await setup(page, { history: [blockedListingChange({ can_retry: false })] });
  const history = page.getByTestId("listing-intent-changes");
  await expect(history.locator("summary")).toHaveText("Listing updates (1) - 1 on this page need attention");
  await history.locator("summary").click();
  await expect(history.getByText("Your store needs authorization again. Reconnect it on the Onboarding page.")).toBeVisible();
  await expect(history.getByRole("button", { name: "Retry update" })).toHaveCount(0);
  await history.getByRole("button", { name: "Resolve issue" }).click();
  await expect(page).toHaveURL(/\/dropship-portal\/onboarding$/);
  expect(state.historyRetryPaths).toEqual([]);
  expect(state.runCalls).toBe(0);
  expect(state.codesSent).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("saved listing retry retains attention on failure and sends only the exact saved command route", async ({ page }) => {
  const state = await setup(page, { history: [blockedListingChange()], historyRetryStatuses: [503, 200] });
  const history = page.getByTestId("listing-intent-changes");
  await expect(history.locator("summary")).toContainText("Listing updates (1)");
  await history.locator("summary").click();
  await history.getByRole("button", { name: "Retry update" }).click();
  await expect(history.getByRole("status")).toContainText("The retry could not be requested. Try again.");
  await expect(history.getByText("Product 11 - Needs attention")).toBeVisible();
  await expect(history.getByRole("button", { name: "Retry update" })).toBeEnabled();
  await history.getByRole("button", { name: "Retry update" }).click();
  await expect(history.getByText("Product 11 - Update pending")).toBeVisible();
  await expect(history.getByRole("status")).toHaveText("Another update attempt has been requested. Check update status for its result.");
  await expect(history.getByRole("button", { name: "Retry update" })).toHaveCount(0);
  expect(state.historyRetryPaths).toEqual(Array(2).fill(`/api/dropship/listings/stores/${STORE_ID}/listing-intent-changes/9007199254740993/retry`));
  expect(state.runCalls).toBe(0);
  expect(state.previewCalls).toBe(0);
  expect(state.codesSent).toEqual([]);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
