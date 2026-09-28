import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";

const HARNESS_PATH = "/__cost-changes-test";
const STAMP = "2026-09-28T16:00:00.000Z";

interface AnnouncedChange {
  entryId: number; productVariantId: number; variantSku: string | null; variantName: string; productName: string;
  kind: "increase" | "decrease"; fromCents: number; unitCostCents: number; effectiveAt: string; announcedAt: string;
}
interface RecentChange {
  logId: number; productVariantId: number; variantSku: string | null; variantName: string; productName: string;
  eventType: "baseline" | "increase_announced" | "increase_applied" | "decrease_announced" | "decrease_applied" | "increase_reduced" | "change_withdrawn";
  fromCents: number | null; toCents: number | null; effectiveAt: string; observedAt: string;
  noticeDecision: "sent" | "skipped_baseline" | "skipped_decrease" | "skipped_below_minimum" | "skipped_channels_off" | "skipped_unannounced" | null;
}

const policy = { increaseNoticeDays: 14, decreaseTiming: "immediate", priceProtection: true, notifyByEmail: true, notifyInPortal: true, notifyOnDecrease: true };

/** The vendor's session and onboarding, stubbed the way the wallet journey does; the cost changes view is the subject. */
interface ListingAction {
  actionId: number; entryId: number; listingId: number; storeConnectionId: number; platform: string; productVariantId: number;
  variantSku: string | null; variantName: string; productName: string;
  action: "reprice_queued" | "reprice_refused" | "awaiting_review" | "price_covers_cost" | "below_cost_recorded" | "below_cost_warned" | "below_cost_paused" | "skipped_inactive_listing" | "skipped_price_unavailable";
  detail: string | null; listingPriceCents: number | null; unitCostCents: number; pushJobId: number | null; decidedAt: string;
  holdReleasedAt: string | null; holdReleaseReason: "price_covers_cost" | "listing_inactive" | null;
}

async function mount(page: Page, view: { announced: AnnouncedChange[]; recent: RecentChange[]; listingActions?: ListingAction[]; policy?: typeof policy; fail?: boolean }) {
  const state = { unexpected: [] as string[], pageErrors: [] as string[], reads: 0 };
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/dropship/auth/me") {
      return route.fulfill({ json: { principal: { authIdentityId: 1, memberId: "m-1", cardShellzEmail: "vendor@example.com", hasPasskey: false,
        authMethod: "password", entitlementStatus: "active", authenticatedAt: STAMP }, sensitiveProofs: {} } });
    }
    if (url.pathname === "/api/dropship/onboarding/state") {
      return route.fulfill({ json: {
        vendor: { vendorId: 1, memberId: "m-1", businessName: "Vendor", contactName: null, email: "vendor@example.com", phone: null,
          status: "active", entitlementStatus: "active", membershipGraceEndsAt: null, includedStoreConnections: 1, standingReason: null, pausedAt: null },
        entitlement: { memberId: "m-1", cardShellzEmail: "vendor@example.com", status: "active", planId: "ops", planName: "Ops", subscriptionId: "sub-1", includesDropship: true, reasonCode: "active" },
        storeConnections: { activeCount: 1, connectedCount: 1, launchReadyConnectedCount: 1, credentialAttentionCount: 0, needsAttentionCount: 0, totalCount: 1, includedLimit: 1, canConnectStore: false },
        catalog: { adminExposureRuleCount: 1, vendorSelectionRuleCount: 1, adminCatalogAvailable: true, hasVendorSelection: true },
        wallet: { availableBalanceCents: 50_000, pendingBalanceCents: 0, activeFundingMethodCount: 1, activeStripeFundingMethodCount: 1, activeStripeCardFundingMethodCount: 1, activeUsdcBaseFundingMethodCount: 0,
          autoReloadEnabled: true, autoReloadFundingMethodId: 10, autoReloadFundingMethodActive: true, autoReloadFundingMethodReady: true, autoReloadFundingMethodIsCard: true },
        steps: [],
      } });
    }
    if (url.pathname === "/api/dropship/cost-changes") {
      state.reads += 1;
      if (view.fail) return route.fulfill({ status: 503, json: { error: { code: "DROPSHIP_COST_SCHEDULE_TABLE_MISSING", message: "Dropship cost schedule tables do not exist yet." } } });
      return route.fulfill({ json: {
        announced: view.announced, recent: view.recent, listingActions: view.listingActions ?? [], policy: view.policy ?? policy, generatedAt: STAMP,
      } });
    }
    state.unexpected.push(`${route.request().method()} ${url.pathname}`);
    return route.fulfill({ status: 500, json: {} });
  });
  await page.route(`**${HARNESS_PATH}**`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-cost-changes-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(HARNESS_PATH);
  return state;
}

const subject = { productVariantId: 66, variantSku: "ARM-ENV-SGL-P50", variantName: "Single pack", productName: "Armor Envelope" };

test("shows the notice terms, the coming changes and the recent changes with their notice status", async ({ page }, testInfo) => {
  const state = await mount(page, {
    listingActions: [{
      actionId: 71, entryId: 11, listingId: 2, storeConnectionId: 9, platform: "shopify", productVariantId: 66, variantSku: "ARM-ENV-SGL-P50",
      variantName: "Single pack", productName: "Armor Envelope", action: "awaiting_review", detail: null, listingPriceCents: 1152, unitCostCents: 999,
      pushJobId: null, decidedAt: "2026-10-13T00:05:00.000Z", holdReleasedAt: null, holdReleaseReason: null,
    }],
    announced: [{ ...subject, entryId: 11, kind: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: "2026-10-13T00:00:00.000Z", announcedAt: STAMP }],
    recent: [
      { ...subject, logId: 31, eventType: "increase_announced", fromCents: 809, toCents: 999, effectiveAt: "2026-10-13T00:00:00.000Z", observedAt: STAMP, noticeDecision: "sent" },
      { ...subject, logId: 30, productVariantId: 67, variantSku: null, variantName: "Case of 10", eventType: "decrease_applied", fromCents: 8_999, toCents: 7_999, effectiveAt: STAMP, observedAt: STAMP, noticeDecision: "skipped_decrease" },
    ],
  });

  await expect(page.getByTestId("cost-changes-terms")).toContainText("You get 14 days' notice before a higher .ops cost is charged.");
  await expect(page.getByTestId("cost-changes-action-71")).toContainText("Waiting for your price review");
  await expect(page.getByTestId("cost-changes-action-71")).toContainText("listed at $11.52, cost now $9.99");
  await expect(page.getByTestId("cost-changes-terms")).toContainText("Orders accepted before a change takes effect are charged the cost in force at the time.");
  const announced = page.getByTestId("cost-changes-announced-11");
  await expect(announced).toContainText("ARM-ENV-SGL-P50 · Armor Envelope");
  await expect(announced).toContainText("Increase");
  await expect(announced).toContainText("$8.09 → $9.99");
  await expect(page.getByTestId("cost-changes-recent-31")).toContainText("You were notified");
  await expect(page.getByTestId("cost-changes-recent-30")).toContainText("Case of 10 · Armor Envelope");
  await expect(page.getByTestId("cost-changes-recent-30")).toContainText("$89.99 → $79.99, applied at once");
  await expect(page.getByTestId("cost-changes-recent-30")).toContainText("No notice: decreases are not announced");
  await page.screenshot({ path: testInfo.outputPath(`cost-changes-portal-${testInfo.project.name}.png`), fullPage: true });
  expect(state.reads).toBe(1);
  expect(state.unexpected).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("says when nothing is coming, and says a failed read failed", async ({ page }) => {
  const quiet = await mount(page, { announced: [], recent: [] });
  await expect(page.getByTestId("cost-changes-announced-empty")).toHaveText("No cost change is announced for your listings.");
  await expect(page.getByTestId("cost-changes-recent-empty")).toHaveText("Nothing changed in the last 30 days.");
  expect(quiet.pageErrors).toEqual([]);

  const failed = await mount(page, { announced: [], recent: [], fail: true });
  await expect(page.getByRole("alert")).toContainText("Dropship cost schedule tables do not exist yet.");
  expect(failed.pageErrors).toEqual([]);
});
