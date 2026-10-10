import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { EbayListingIssue } from "../../../shared/types/ebay-listing-issue";
const missingPhoto =
  "Replace uploaded catalog image 42: its file is missing, empty or larger than 10 MB.";
const success = {
  synced: 2,
  priceChanges: 0,
  qtyChanges: 0,
  policyChanges: 0,
  errors: 0,
  details: [{ success: true }, { success: true }],
};
export async function setupEbayChannelPage(page: Page) {
  const state = {
    response: {
      ...success,
      synced: 0,
      errors: 1,
      details: [{ success: false, error: missingPhoto, code: "EBAY_CATALOG_PHOTO_UNAVAILABLE" }],
    } as unknown,
    jobs: [] as unknown[],
    feedStatus: "listed",
    connectionHealth: "verified" as "verified" | "needs_attention" | "not_connected",
    connectionIssue: null as EbayListingIssue | null,
    syncError: null as string | null,
    commands: [] as string[],
    requests: [] as string[],
    errors: [] as string[],
    unexpected: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) =>
    new URL(route.request().url()).hostname === "127.0.0.1"
      ? route.continue()
      : route.abort(),
  );
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: { id: "operator", role: "lead", username: "operator" },
          roles: ["lead"],
          permissions: ["channels:view", "channels:edit"],
        },
      });
    if (path === "/api/ebay/channel-config")
      return route.fulfill({
        json: {
          connected: true,
          connectionHealth: state.connectionHealth,
          connectionIssue: state.connectionIssue,
          channel: { id: 67, name: "eBay", status: "active" },
          ebayUsername: "test-store",
          tokenInfo: null,
          config: {
            marketplaceId: "EBAY_US",
            merchantLocationKey: "warehouse",
            fulfillmentPolicyId: "ship",
            returnPolicyId: "returns",
            paymentPolicyId: "pay",
            merchantLocation: null,
          },
          categoryMappings: [],
          productTypes: [],
          lastSyncAt: null,
          syncStatus: "idle",
        },
      });
    if (path === "/api/ebay/policies")
      return route.fulfill({
        json: {
          fulfillmentPolicies: [],
          returnPolicies: [],
          paymentPolicies: [],
        },
      });
    if (path === "/api/ebay/store-categories")
      return route.fulfill({ json: { categories: [] } });
    if (path === "/api/ebay/pricing-rules")
      return route.fulfill({ json: { rules: [] } });
    if (path === "/api/ebay/listings/sync-jobs")
      return route.fulfill({ json: state.jobs });
    if (/^\/api\/ebay\/listings\/sync-jobs\/[a-f0-9-]{36}$/i.test(path)) {
      const job = state.jobs.find((value) => (value as { id: string }).id === path.split("/").at(-1));
      return job
        ? route.fulfill({ json: { job, sourceIdentity: null, providerIdentity: null } })
        : route.fulfill({ status: 404, json: { code: "EBAY_SYNC_JOB_NOT_FOUND", error: "No saved command receipt was found." } });
    }
    if (path === "/api/ebay/effective-prices")
      return route.fulfill({ json: { prices: {} } });
    if (path === "/api/ebay/product-type-defaults")
      return route.fulfill({ json: { defaults: {} } });
    if (path === "/api/ebay/listing-feed")
      return route.fulfill({
        json: {
          total: 1,
          feed: [
            {
              id: 1,
              name: "55PT Toploader Combo Pack",
              sku: "PHOTO-PRODUCT",
              productType: "toploaders",
              productTypeName: "Toploaders",
              ebayBrowseCategoryId: "183438",
              ebayBrowseCategoryName: "Card Toploaders",
              ebayBrowseCategoryOverrideId: null,
              ebayBrowseCategoryOverrideName: null,
              ebayStoreCategoryName: null,
              status: state.feedStatus,
              missingItems: [],
              missingAspects: [],
              isListed: true,
              isExcluded: false,
              syncError: state.syncError,
              externalListingId: "listing-1",
              externalListingIdentityConflict: false,
              variantCount: 2,
              includedVariantCount: 2,
              imageCount: 2,
              variants: [],
              fulfillmentPolicyOverride: null,
              returnPolicyOverride: null,
              paymentPolicyOverride: null,
            },
          ],
        },
      });
    if (path === "/api/marketplace-listings/registrations/channel/ebay/status")
      return route.fulfill({ json: { statuses: [] } });
    if (
      path === "/api/ebay/listings/sync-product/1" &&
      req.method() === "POST"
    ) {
      state.requests.push(path);
      const command = req.postDataJSON();
      state.commands.push(command.commandKey);
      const response = state.response as { jobs?: unknown[] };
      if (response.jobs) state.jobs = response.jobs;
      return route.fulfill({ json: state.response });
    }
    state.unexpected.push(`${req.method()} ${path}`);
    return route.fulfill({
      status: 500,
      json: { error: "Unexpected test request" },
    });
  });
  await page.route("**/__ebay-photo-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/ebay-channel-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
    }),
  );
  await page.goto("/__ebay-photo-test");
  await expect(
    page.getByText("55PT Toploader Combo Pack", { exact: true }),
  ).toBeVisible();
  return state;
}
