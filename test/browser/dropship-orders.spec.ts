import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";

// Playwright's serviceWorkers:block init script reads navigator.serviceWorker in
// every frame, which throws in an opaque sandbox. This local-only harness
// registers no workers.
test.use({ serviceWorkers: "allow" });

const HARNESS_PATH = "/__orders-test";
const HOUR_MS = 60 * 60 * 1000;

interface StubState {
  heldCount: number;
  shortfallCents: number;
  availableBalanceCents: number;
  orderRequests: string[];
  unexpected: string[];
  errors: string[];
  /** The vendor's standing as the onboarding state reports it; a funding pause changes what held orders wait for. */
  vendorStatus: "active" | "paused";
  vendorStandingReason: "card_declined" | "funding_returned" | null;
}

function onboardingJson(state: StubState) {
  return {
    vendor: { vendorId: 1, memberId: "m-1", businessName: "Vendor", contactName: null, email: "vendor@example.com", phone: null,
      status: state.vendorStatus, entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 1,
      standingReason: state.vendorStandingReason, pausedAt: state.vendorStatus === "paused" ? "2026-09-16T00:00:00.000Z" : null },
    entitlement: { memberId: "m-1", cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops", subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
    storeConnections: { activeCount: 1, connectedCount: 1, launchReadyConnectedCount: 1, credentialAttentionCount: 0, needsAttentionCount: 0, totalCount: 1, includedLimit: 1, canConnectStore: false },
    catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
    wallet: { availableBalanceCents: state.availableBalanceCents, pendingBalanceCents: 0, activeFundingMethodCount: 1, activeStripeFundingMethodCount: 1, activeStripeCardFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0,
      autoReloadEnabled: true, autoReloadFundingMethodId: 10, autoReloadFundingMethodActive: true, autoReloadFundingMethodReady: true, autoReloadFundingMethodIsCard: true },
    steps: [],
  };
}

function heldOrder(intakeId: number, totalDebitCents: number, expiresAt: string) {
  return {
    intakeId,
    vendor: { vendorId: 1, memberId: "m-1", businessName: "Vendor", email: null, status: "active", entitlementStatus: "active" },
    platform: "ebay", externalOrderId: `EXT-${intakeId}`, externalOrderNumber: `10-0${intakeId}`,
    status: "payment_hold", paymentHoldExpiresAt: expiresAt,
    paymentHold: { totalDebitCents, currency: "USD", expiresAt },
    rejectionReason: null, cancellationStatus: null, omsOrderId: null,
    receivedAt: "2026-09-16T10:00:00.000Z", acceptedAt: null, updatedAt: "2026-09-16T10:00:00.000Z",
    lineCount: 1, totalQuantity: 1, shipTo: { name: "Buyer", city: "Austin", region: "TX", postalCode: "78701", country: "US" },
    storeConnection: { storeConnectionId: 22, platform: "ebay", status: "connected", setupStatus: "ready", launchReady: true, externalDisplayName: "Vendor eBay", shopDomain: null },
  };
}

async function setup(page: Page, initial: Partial<StubState> = {}, path = HARNESS_PATH) {
  const state: StubState = { heldCount: 2, shortfallCents: 15_000, availableBalanceCents: 4_000, orderRequests: [], unexpected: [], errors: [],
    vendorStatus: "active", vendorStandingReason: null, ...initial };
  // Deadlines sit a little past whole hours so the countdown text is stable for the length of a test run.
  const firstDeadline = new Date(Date.now() + 27 * HOUR_MS + 30 * 60 * 1000).toISOString();
  const secondDeadline = new Date(Date.now() + 40 * HOUR_MS).toISOString();
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === "/api/dropship/auth/me") {
      return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: "m-1", cardShellzEmail: "vendor@example.com", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: "2026-09-16T00:00:00.000Z" }, sensitiveProofs: {} } });
    }
    if (url.pathname === "/api/dropship/onboarding/state" && method === "GET") {
      return route.fulfill({ json: onboardingJson(state) });
    }
    if (url.pathname === "/api/dropship/orders/payment-hold-summary" && method === "GET") {
      return route.fulfill({ json: { summary: { heldCount: state.heldCount, totalDebitCents: 19_000, availableBalanceCents: state.availableBalanceCents,
        shortfallCents: state.shortfallCents, earliestExpiresAt: state.heldCount > 0 ? firstDeadline : null, currency: "USD" } } });
    }
    if (url.pathname === "/api/dropship/orders" && method === "GET") {
      state.orderRequests.push(url.search);
      const statuses = url.searchParams.get("statuses");
      const items = [heldOrder(1, 9_500, firstDeadline), heldOrder(2, 9_500, secondDeadline)];
      const accepted = { ...heldOrder(3, 0, secondDeadline), status: "accepted", paymentHold: null, paymentHoldExpiresAt: null, externalOrderNumber: "10-03" };
      const visible = statuses === "payment_hold" ? items : [...items, accepted];
      return route.fulfill({ json: { items: visible, total: visible.length, page: 1, limit: 50, statuses: statuses ? [statuses] : [], summary: [] } });
    }
    state.unexpected.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
  });
  await page.route(`**${HARNESS_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-orders-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(path);
  return state;
}

test("held orders are announced with the amount to add, and each row says what it needs and how long it has", async ({ page }) => {
  const state = await setup(page);
  const banner = page.getByTestId("orders-payment-hold-banner");
  await expect(banner.getByTestId("orders-payment-hold-title")).toHaveText("2 orders are waiting on payment");
  await expect(banner.getByTestId("orders-payment-hold-detail")).toHaveText(
    "They need $190.00 in total; your balance is $40.00. Add $150.00 to accept them. The first one is cancelled in 1d 3h if it is not paid.",
  );
  await expect(page.getByTestId("order-hold-detail").first()).toHaveText("Needs $95.00 · cancels in 1d 3h");
  await expect(page.getByTestId("order-hold-detail")).toHaveCount(2);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a vendor paused for funding is told the held orders wait for the wallet minimum, even with the money to cover them", async ({ page }) => {
  const state = await setup(page, { vendorStatus: "paused", vendorStandingReason: "card_declined", shortfallCents: 0, availableBalanceCents: 30_000 });
  const banner = page.getByTestId("orders-payment-hold-banner");
  await expect(banner.getByTestId("orders-payment-hold-title")).toHaveText("2 orders are waiting on payment");
  await expect(banner.getByTestId("orders-payment-hold-detail")).toHaveText(
    "They need $190.00 in total; your balance is $300.00. Selling is paused. Fund your wallet back to its reserve and they will be accepted. The first one is cancelled in 1d 3h if it is not paid.",
  );
  await expect(page.getByRole("button", { name: "Add funds" })).toBeVisible();
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("Show waiting orders filters the list to held orders; Add funds goes to the wallet", async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByText("10-03")).toBeVisible();
  await page.getByRole("button", { name: "Show waiting orders" }).click();
  await expect(page.getByText("10-03")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show waiting orders" })).toHaveCount(0);
  expect(state.orderRequests.at(-1)).toContain("statuses=payment_hold");

  await page.getByRole("button", { name: "Add funds" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toContain("/wallet");
  expect(state.errors).toEqual([]);
});

test("a link with ?status=payment_hold opens the page already filtered", async ({ page }) => {
  const state = await setup(page, {}, `${HARNESS_PATH}?status=payment_hold`);
  await expect(page.getByTestId("orders-payment-hold-banner")).toBeVisible();
  await expect(page.getByText("10-03")).toHaveCount(0);
  expect(state.orderRequests[0]).toContain("statuses=payment_hold");
  await expect(page.getByRole("button", { name: "Show waiting orders" })).toHaveCount(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("nothing is announced when no order is waiting", async ({ page }) => {
  const state = await setup(page, { heldCount: 0, shortfallCents: 0 });
  await expect(page.getByText("10-03")).toBeVisible();
  await expect(page.getByTestId("orders-payment-hold-banner")).toHaveCount(0);
  expect(state.errors).toEqual([]);
});
