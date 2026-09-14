import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";
import { LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE,
  type ListingShippingEstimateCalculation, type ListingShippingEstimateInput } from "../../shared/dropship/listing-shipping-estimate";

// What a staff session would receive alongside the total; vendors never do.
const STAFF_CALCULATION: ListingShippingEstimateCalculation = {
  pricingSource: "shared", cutoverMode: "live", cutoverReasonCode: "LIVE_ENABLED", originWarehouseId: 1,
  items: [{ productVariantId: 66, sku: "ARM-ENV-SGL-P50", quantity: 1, unitWeightGrams: 635, lineWeightGrams: 635 }],
  packages: [{ packageSequence: 1, boxCode: "BOX-10x8x4", weightGrams: 635, lengthMm: 254, widthMm: 203, heightMm: 102, items: [{ productVariantId: 66, quantity: 1 }] }],
  rate: { source: "shared_engine", rateBookId: 34, rateBookCode: "dropship-vendor", rateTableId: 5, rateRowId: 9001, serviceLevelCode: "standard",
    serviceLevelName: "Standard Shipping", zone: "2", ratedWeightGrams: 635, chargeModel: "fixed_band", rowMaxShipmentWeightGrams: 907,
    perStartedPoundCents: null, billablePounds: null, productPolicyApplied: false, policySteps: [] },
  charges: { baseCents: 700, markupCents: 100, insuranceCents: 24, dunnageCents: 0, totalCents: 824 }, warnings: [],
};

async function chooseState(page: Page, option: string) {
  await page.getByRole("combobox", { name: "State" }).click();
  await page.getByRole("option", { name: option }).click();
}

async function setup(page: Page, options: { selectState?: boolean } = {}) {
  const state = { requests: [] as ListingShippingEstimateInput[], errors: [] as string[], unexpected: [] as string[],
    unavailable: false, fail: false, privateResponse: false, staffCalculation: false };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/dropship/listings/shipping-estimate" || route.request().method() !== "POST") {
      state.unexpected.push(route.request().url());
      return route.fulfill({ status: 500, json: { error: { message: "Unexpected request" } } });
    }
    const request = route.request().postDataJSON() as ListingShippingEstimateInput;
    state.requests.push(request);
    if (state.fail) return route.fulfill({ status: 503, json: { error: { message: "Shipping could not be estimated. Please try again." } } });
    const scenario = { ...request, destination: { ...request.destination, region: request.destination.region ?? null },
      estimatedAt: "2026-09-08T12:00:00.000Z", warnings: [] };
    const estimate = state.unavailable
      ? { ...scenario, status: "unavailable", code: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, message: LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE }
      : { ...scenario, status: "estimated", totalShippingCents: request.quantity === 1 ? 824 : 1020, currency: "USD",
          ...(state.privateResponse ? { breakdown: { markupCents: 8 }, rate: { rateTableId: 1 } } : {}),
          ...(state.staffCalculation ? { calculation: STAFF_CALCULATION } : {}) };
    return route.fulfill({ json: { estimate } });
  });
  await page.route("**/__shipping-estimate-test", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root" style="max-width:900px;margin:24px auto;padding:12px"></main>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-shipping-estimate-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__shipping-estimate-test");
  await page.getByLabel("Postal code").fill("16046");
  if (options.selectState !== false) await chooseState(page, "Pennsylvania (PA)");
  return state;
}

test("requires a state chosen from the rate-card region list before sending a request", async ({ page }) => {
  const state = await setup(page, { selectState: false });
  // No free-text state for a US destination: only the region list the rate tables are keyed by.
  await expect(page.getByRole("textbox", { name: "State" })).toHaveCount(0);
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("state or region code");
  expect(state.requests).toHaveLength(0);
  await page.getByRole("combobox", { name: "State" }).click();
  await expect(page.getByRole("option", { name: "Alaska (AK)" })).toBeVisible();
  await page.getByRole("option", { name: "Pennsylvania (PA)" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "State" })).toContainText("Pennsylvania (PA)");
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("$8.24");
  expect(state.requests[0].destination.region).toBe("PA");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("re-estimates purchase quantity without exposing rate or fee internals", async ({ page }, testInfo) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("$8.24");
  await page.getByLabel("Quantity to buy").fill("2");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("$10.20");
  await expect(page.getByRole("status")).toContainText("2 sellable pack(s)");
  await expect(page.locator("details")).toHaveCount(0);
  for (const label of ["Rate and fee breakdown", "Shipping markup", "Insurance pool", "Dunnage", "Rate table", "Calculation details"]) {
    await expect(page.getByText(label, { exact: false })).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath("shipping-total-only.png"), fullPage: true });
  expect(state.requests.map((request) => request.quantity)).toEqual([1, 2]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("clears old prices on a failed scenario and allows a deliberate retry", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("$8.24");
  state.unavailable = true;
  await page.getByLabel("Quantity to buy").fill("2");
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE);
  await expect(page.getByText("$8.24", { exact: true })).toHaveCount(0);
  state.unavailable = false; state.fail = true;
  await page.getByLabel("Postal code").fill("16066");
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Please try again");
  state.fail = false;
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("$10.20");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("refuses an outdated response containing private cost fields", async ({ page }) => {
  const state = await setup(page); state.privateResponse = true;
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The shipping estimate response was invalid");
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator("details")).toHaveCount(0);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("renders the staff calculation detail only when the server attaches it", async ({ page }, testInfo) => {
  const state = await setup(page); state.staffCalculation = true;
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("$8.24");
  const details = page.getByTestId("listing-shipping-calculation");
  await expect(details).toContainText("Calculation details (Card Shellz staff view)");
  await expect(details).toContainText("Shared shipping engine (cutover live, LIVE_ENABLED)");
  await expect(details).toContainText("ARM-ENV-SGL-P50");
  await expect(details).toContainText("635 g (1.40 lb)");
  await expect(details).toContainText("BOX-10x8x4");
  await expect(details).toContainText("dropship-vendor (rate book #34)");
  await expect(details).toContainText("table #5, row #9001");
  await expect(details).toContainText("Standard Shipping (standard)");
  await expect(details).toContainText("$7.00");
  await expect(details).toContainText("$8.24");
  await page.screenshot({ path: testInfo.outputPath("shipping-staff-calculation.png"), fullPage: true });
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
