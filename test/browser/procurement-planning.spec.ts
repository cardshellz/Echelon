import { expect, test, type Page } from "@playwright/test";
import { generatePurchasingRecommendations } from "../../server/modules/procurement/purchasing-recommendation.engine";
import { defaultPurchasePlanningPolicy } from "../../shared/procurement/purchase-planning-policy";
import { installFixtures } from "./procurement-fixtures";

async function setup(page: Page, bundleReview = false) {
  const failures = await installFixtures(page);
  const policy = { ...defaultPurchasePlanningPolicy(), growthPercent: 25, products: [{ productId: 10, essential: true, minimumStockPieces: 100, targetCoverDays: 180, leadTimeStages: null }] };
  const analysis = generatePurchasingRecommendations({ asOf: "2026-09-07T12:00:00.000Z", lookbackDays: 30, autoDraftSettings: { planningPolicy: policy }, rows: [{
    product_id: 10, variant_id: 100, base_sku: "PLAN-TEST", product_name: "Fictional planning item", total_pieces: 20, total_reserved_pieces: 0, total_outbound_pieces: 60, previous_outbound_pieces: 60, demand_order_count: 12, demand_active_days: 10, latest_demand_at: "2026-09-06", on_order_pieces: bundleReview ? 0 : 500, open_po_count: bundleReview ? 0 : 1, earliest_expected: "2026-09-30", lead_time_days: 120, safety_stock_days: 10,
    preferred_vendor_id: 2, preferred_vendor_name: "Test supplier", vendor_product_id: 20, estimated_cost_mills: 10000, vendor_currency: "USD", vendor_minimum_order_cents: 500000, vendor_free_freight_threshold_cents: 1000000, inbound_schedule: bundleReview ? [] : [{ purchaseOrderId: 17, purchaseOrderNumber: "TEST-PO-17", purchaseOrderLineId: 171, remainingPieces: 500, expectedDate: "2026-09-30" }],
  }] });
  await page.route("**/api/settings/procurement", (route) => route.fulfill({ json: { useNewPoEditor: true, useNewReorderCockpit: true } }));
  await page.route("**/api/purchasing/kpis", (route) => route.fulfill({ json: { criticalRestocks: 0, upcomingRestocks: 0, idleCapitalCents: 0, inboundPipelineValueCents: 50000, totalOpenLines: 1, lastComputedAt: "2026-09-07T12:00:00Z" } }));
  await page.route("**/api/purchasing/reorder-analysis", (route) => route.fulfill({ json: analysis }));
  await page.route("**/api/purchasing/exclusion-rules", (route) => route.fulfill({ json: { rules: [], totalExcluded: 0 } }));
  await page.route("**/api/purchasing/exclusion-rules/field-values?*", (route) => route.fulfill({ json: { field: "category", values: [] } }));
  await page.route("**/api/purchasing/auto-draft-settings", (route) => route.fulfill({ json: { autoDraftMode: "review_only", forecastPolicy: {} } }));
  await page.route("**/api/purchasing/planning-policy", (route) => route.fulfill({ json: { revision: 3, policy, products: [{ id: 10, sku: "PLAN-TEST", name: "Fictional planning item" }] } }));
  await page.route("**/api/purchasing/planning-policy/history", (route) => route.fulfill({ json: { changes: [] } }));
  return { failures, policy };
}

test("planning explains growth, arrival risk and the exact source PO in the same drawer", async ({ page }, testInfo) => {
  const { failures } = await setup(page);
  await page.goto("/reorder-analysis?chips=all");
  await page.getByRole("button", { name: /^All / }).click();
  await expect(page.getByText("Essential", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review arrival coverage", exact: true }).click();
  await expect(page.getByText("Uniform growth adjustment: 25%.", { exact: false })).toBeVisible();
  const link = page.getByRole("link", { name: /TEST-PO-17 · line 171/ });
  await expect(link).toHaveAttribute("href", "/purchase-orders/17");
  await expect(page.getByText("Projected supply can run out", { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("planning-arrival-evidence.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("stock policy retries retain their command identity and show validation before saving", async ({ page }, testInfo) => {
  const { failures, policy } = await setup(page);
  const requests: Array<{ expectedRevision: number; idempotencyKey: string; policy: unknown }> = [];
  await page.route("**/api/purchasing/planning-policy", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { revision: 3, policy } });
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) return route.fulfill({ status: 500, json: { error: "Synthetic lost response; retry the same request" } });
    return route.fulfill({ json: { revision: 4, policy: { ...policy, growthPercent: 30 } } });
  });
  await page.goto("/reorder-analysis");
  await page.getByRole("button", { name: "Planning Policy", exact: true }).click();
  const growth = page.getByLabel("Uniform growth adjustment (%)", { exact: true });
  await growth.fill("30");
  const save = page.getByRole("button", { name: "Save stock and growth policy", exact: true });
  await save.click();
  await expect(page.getByText("Synthetic lost response; retry the same request", { exact: true })).toBeVisible();
  await save.click();
  await expect(page.getByText("Planning policy saved", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  await growth.fill("1001");
  await expect(save).toBeDisabled();
  await expect(page.getByText("Enter valid quantities and days.", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("planning-policy-review.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});


test("new product names survive subsequent policy edits", async ({ page }) => {
  const { failures } = await setup(page);
  await page.route("**/api/purchasing/planning-policy/products?*", (route) => route.fulfill({ json: { items: [{ id: 11, sku: "NEW-TEST", name: "Fictional new item" }] } }));
  await page.goto("/reorder-analysis");
  await page.getByRole("button", { name: "Planning Policy", exact: true }).click();
  await page.getByLabel("Find product planning policy", { exact: true }).fill("NEW");
  await page.getByRole("button", { name: "NEW-TEST · Fictional new item", exact: true }).click();
  await page.getByLabel("Uniform growth adjustment (%)", { exact: true }).fill("30");
  await expect(page.locator("legend", { hasText: "NEW-TEST · Fictional new item" })).toBeVisible();
  expect(failures).toEqual([]);
});


test("replacement forecasts require an explicit valid range and save the exact total", async ({ page }, testInfo) => {
  const { failures, policy } = await setup(page);
  let saved: any;
  await page.route("**/api/purchasing/planning-policy", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { revision: 3, policy } });
    saved = route.request().postDataJSON();
    return route.fulfill({ json: { revision: 4, policy: saved.policy } });
  });
  await page.goto("/reorder-analysis");
  await page.getByRole("button", { name: "Planning Policy", exact: true }).click();
  await page.getByRole("button", { name: "Add replacement forecast", exact: true }).click();
  const save = page.getByRole("button", { name: "Save stock and growth policy", exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel("Forecast start date", { exact: true }).fill("2026-10-01");
  await page.getByLabel("Forecast end date", { exact: true }).fill("2026-10-31");
  await page.getByLabel("Total forecast pieces", { exact: true }).fill("600");
  await page.getByLabel("Forecast reference", { exact: true }).fill("October club plan");
  await expect(save).toBeEnabled();
  await page.getByRole("button", { name: "Add replacement forecast", exact: true }).click();
  await page.getByLabel("Forecast start date", { exact: true }).nth(1).fill("2026-10-31");
  await page.getByLabel("Forecast end date", { exact: true }).nth(1).fill("2026-11-30");
  await page.getByLabel("Total forecast pieces", { exact: true }).nth(1).fill("700");
  await page.getByLabel("Forecast reference", { exact: true }).nth(1).fill("Overlapping forecast");
  await expect(save).toBeDisabled();
  await page.getByRole("button", { name: "Remove forecast range", exact: true }).nth(1).click();
  await save.click();
  await expect(page.getByText("Planning policy saved", { exact: true })).toBeVisible();
  expect(saved.policy.replacementForecasts).toEqual([{ productId: 10, startDate: "2026-10-01", endDate: "2026-10-31", totalPieces: 600, reference: "October club plan" }]);
  await page.screenshot({ path: testInfo.outputPath("planning-replacement-policy.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});

test("supplier minimum is visible before drafting and an unresolved RFQ remains reviewable", async ({ page }, testInfo) => {
  const { failures } = await setup(page, true);
  await page.goto("/reorder-analysis?chips=all");
  await page.getByRole("checkbox", { name: "Add PLAN-TEST to order", exact: true }).click();
  await page.getByRole("button", { name: "Open order builder", exact: true }).click();
  await expect(page.getByText("Supplier minimum $5,000 USD", { exact: false })).toBeVisible();
  await expect(page.getByText("Free-freight target $10,000", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Continue → confirm 1 PO/ }).click();
  await expect(page.getByRole("alert")).toContainText("below the supplier order minimum");
  await expect(page.getByRole("button", { name: /Create.*PO/ })).toBeDisabled();
  await page.getByRole("button", { name: "← Back", exact: true }).last().click();
  await page.getByRole("radio", { name: "Request quote", exact: true }).check();
  await expect(page.getByText("An RFQ can still be drafted for review; the supplier basket is unresolved.", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("planning-supplier-bundle.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});
