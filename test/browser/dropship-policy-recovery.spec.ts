import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";

const defaults = { fulfillmentPolicyId: "ground", returnPolicyId: "returns", paymentPolicyId: "payments" };
const saved = { storeConnectionId: 1, verification: "not_checked", defaults,
  assignments: [{ productVariantId: 101, revisionId: 4, fulfillmentPolicyId: null, returnPolicyId: "return-override",
    paymentPolicyId: null, updatedAt: "2026-09-08T12:00:00.000Z" }], fetchedAt: "2026-09-08T12:00:00.000Z" };
const setup = { storeConnectionId: 1, marketplaceId: "EBAY_US", complete: true, missingFields: [],
  selection: { merchantLocationKey: "managed", ...defaults },
  fulfillmentCapability: { marketplaceId: "EBAY_US", requiredHandlingTimeBusinessDays: 1, destinationCountry: "US",
    destinationRegions: ["PA"], destinationCoverageComplete: true, supportedServices: [], evidenceHash: "fixture",
    source: { omsChannelId: 1, originWarehouseId: 1, rateBookId: 1, rateBookCode: "fixture", rateTableId: 1, serviceLevelId: 1, fulfillmentRoutingRevision: 1 } },
  options: { merchantLocations: [{ id: "managed", name: "Managed" }],
    fulfillmentPolicies: [{ id: "ground", name: "USPS Ground Advantage", compatible: true, compatibilityIssues: [] }],
    returnPolicies: [{ id: "returns", name: "30-day returns" }, { id: "return-override", name: "Custom returns" }],
    paymentPolicies: [{ id: "payments", name: "Managed payments" }] } };

async function mount(page: Page, failInitially: boolean) {
  const state = { failSetup: failInitially, failSaved: false, malformedSaved: false, invalidContract: false, setupReads: 0, savedReads: 0,
    writes: [] as string[], unexpected: [] as string[], pageErrors: [] as string[] };
  page.on("pageerror", (error) => state.pageErrors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") { state.writes.push(path); return route.fulfill({ status: 500, json: {} }); }
    if (path === "/api/dropship/ebay/listing-setup/1") {
      state.setupReads++;
      if (state.failSetup) return route.fulfill({ status: 502, json: { error: { code: "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE",
        message: "eBay did not return the connected store's listing setup.", context: { resource: "fulfillmentPolicies", status: 503,
          retryable: true, diagnosticReference: "browser-test-reference", attempts: 3 } } } });
      return route.fulfill({ json: setup });
    }
    if (path === "/api/dropship/ebay/listing-policy-overrides/1/saved") {
      state.savedReads++;
      if (state.failSaved) return route.fulfill({ status: 500, json: { error: { message: "Saved policies unavailable." } } });
      return route.fulfill({ json: state.malformedSaved ? { ...saved, storeConnectionId: 2 }
        : state.invalidContract ? { ...saved, assignments: [...saved.assignments, ...saved.assignments] } : saved });
    }
    state.unexpected.push(path); return route.fulfill({ status: 500, json: {} });
  });
  await page.route("**/__policy-test", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><div id="root"></div><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-policy-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__policy-test");
  return state;
}

test("fresh page keeps saved policy table during an outage and recovers without a browser reload", async ({ page }, testInfo) => {
  const state = await mount(page, true);
  await expect(page.getByText("Saved policy (ground)", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved policy (return-override)", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeDisabled();
  await expect(page.getByText("Saved policies are shown below.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Preview invalidations")).not.toHaveText("0");
  expect(state.setupReads).toBe(1);
  expect(state.savedReads).toBe(1);
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("saved-policies-during-outage.png"), fullPage: true });
  state.failSetup = false;
  await page.getByRole("button", { name: "Refresh policies", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeEnabled();
  await expect(page.getByRole("cell", { name: "USPS Ground Advantage Store default" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Custom returns Override" })).toBeVisible();
  expect(state.setupReads).toBe(2);
  expect(state.savedReads).toBe(2);
  expect(state.unexpected).toEqual([]);
  expect(state.pageErrors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("saved-policies-recovered.png"), fullPage: true });
});

test("a later failure retains verified labels but disables editing; remounting a fresh setup panel shares its read", async ({ page }) => {
  const state = await mount(page, false);
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeEnabled();
  await page.getByRole("button", { name: "Toggle setup panel" }).click();
  await page.getByRole("button", { name: "Toggle setup panel" }).click();
  expect(state.setupReads).toBe(1);
  state.failSetup = true;
  await page.getByRole("button", { name: "Refresh policies", exact: true }).click();
  await expect(page.getByText("Saved policies are shown below.", { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: "USPS Ground Advantage Store default" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeDisabled();
  expect(state.writes).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test("rejects malformed saved data with a usable message and keeps the last good table", async ({ page }) => {
  const state = await mount(page, false);
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeEnabled();
  state.invalidContract = true;
  await page.getByRole("button", { name: "Refresh policies", exact: true }).click();
  await expect(page.getByText("Saved listing policies could not be read safely. Refresh policies to try again.", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "USPS Ground Advantage Store default" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeDisabled();
  expect(state.writes).toEqual([]);
});

test("saved-read failure does not invent blank defaults and can be retried", async ({ page }) => {
  const state = await mount(page, false);
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeEnabled();
  state.failSaved = true;
  await page.getByRole("button", { name: "Refresh policies", exact: true }).click();
  await expect(page.getByText("Saved policies unavailable.", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "USPS Ground Advantage Store default" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeDisabled();
  state.failSaved = false;
  await page.getByRole("button", { name: "Refresh policies", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeEnabled();
  expect(state.writes).toEqual([]);
});

test("rejects a saved response belonging to another store", async ({ page }) => {
  const state = await mount(page, false);
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeEnabled();
  state.malformedSaved = true;
  await page.getByRole("button", { name: "Refresh policies", exact: true }).click();
  await expect(page.getByText("Saved policies did not match the selected store.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit policies for ARM-50" })).toBeDisabled();
  expect(state.writes).toEqual([]);
});
