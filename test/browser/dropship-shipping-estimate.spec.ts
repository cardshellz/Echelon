import { expect, test, type Page } from "playwright/test";
import { resolve } from "node:path";
import { LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_CODE, LISTING_SHIPPING_ESTIMATE_UNAVAILABLE_MESSAGE,
  type ListingShippingEstimateInput } from "../../shared/dropship/listing-shipping-estimate";

async function setup(page: Page) {
  const state = { requests: [] as ListingShippingEstimateInput[], errors: [] as string[], unexpected: [] as string[],
    unavailable: false, fail: false, privateResponse: false };
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
          ...(state.privateResponse ? { breakdown: { markupCents: 8 }, rate: { rateTableId: 1 } } : {}) };
    return route.fulfill({ json: { estimate } });
  });
  await page.route("**/__shipping-estimate-test", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root" style="max-width:900px;margin:24px auto;padding:12px"></main>
    <script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/dropship-shipping-estimate-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__shipping-estimate-test");
  await page.getByLabel("Postal code").fill("16046");
  await page.getByLabel("State / region").fill("PA");
  return state;
}

test("requires the state needed by the rate card before sending a request", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel("State / region").clear();
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  expect(state.requests).toHaveLength(0);
  await expect(page.getByLabel("State / region")).toHaveAttribute("required", "");
  await page.getByLabel("State / region").fill("pa");
  await page.getByRole("button", { name: "Estimate shipping", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("$8.24");
  expect(state.requests[0].destination.region).toBe("PA");
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
  for (const label of ["Rate and fee breakdown", "Shipping markup", "Insurance pool", "Dunnage", "Rate table"]) {
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
