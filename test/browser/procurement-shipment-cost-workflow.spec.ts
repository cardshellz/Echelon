import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

async function closedShipment(page: Page, options: { loseFirstResponse?: boolean; viewer?: boolean } = {}) {
  const failures = await installFixtures(page);
  const state = { updated: false, keys: [] as string[] };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: {
      user: { id: "test-user", username: "test", role: options.viewer ? "lead" : "admin" }, roles: options.viewer ? ["lead"] : ["admin"],
      permissions: options.viewer ? ["purchasing:view"] : ["purchasing:view", "purchasing:approve"],
    } });
    if (request.method() === "GET" && path === "/api/inbound-shipments/42") return route.fulfill({ json: {
      id: 42, shipmentNumber: "TEST-CLOSED-42", status: "closed", mode: "sea_fcl", purchaseOrderId: 17,
      allocationMethodDefault: "by_value", statusHistory: [],
      lines: [{ id: 1, purchaseOrderId: 17, purchaseOrderLineId: 101, sku: "TEST-PRODUCT", productName: "Test product",
        qtyShipped: 1000, cartonCount: 10, poUnitCostMills: 100, dutyAllocatedCents: 1000,
        dutyAllocatedMillsPerUnit: 100, allocatedCostCents: 1000, totalAllocatedMillsPerUnit: 100, landedUnitCostMills: 200 }],
      costs: [{ id: 71, costType: "duty", actualCents: 1000, estimatedCents: 1000, allocationMethod: "by_value", currency: "USD", costStatus: "finalized" }],
    } });
    if (path.endsWith("/42/allocation-status")) return route.fulfill({ json: {
      shipmentId: 42, status: state.updated ? "allocated" : "needs_allocation", lineCount: 1, allocatableCostCount: 1,
      effectiveCostCents: 1000, allocatedCostCents: 1000, unallocatedCents: 0, blockerCount: state.updated ? 0 : 1, warningCount: 0,
      issues: state.updated ? [] : [{ severity: "blocker", code: "stale_allocation_basis", costId: 71,
        message: "duty allocation basis no longer matches current by_value values on 1 line(s). Re-run allocation before closing." }],
      costs: [{ costId: 71, costType: "duty", effectiveCents: 1000, allocatedCents: 1000, method: "by_value",
        methodSource: "cost_type_override", basisTotal: 1000, rawBasisTotal: 1000, usedFallback: false,
        status: state.updated ? "allocated" : "stale_allocation_basis" }],
    } });
    if (path.endsWith("/42/cost-review")) return route.fulfill({ json: {
      shipmentId: 42, lines: [{ lineId: 1, sku: "TEST-PRODUCT", sourceIssue: null,
        application: state.updated ? { id: 2, recordedAt: "2026-10-15T12:00:00Z", status: "applied", lotsUpdated: 1, cogsRowsUpdated: 2, issues: [] } : null }],
    } });
    if (request.method() === "POST" && path.endsWith("/42/update-costs")) {
      expect(request.postDataJSON()).toEqual({});
      state.keys.push(request.headers()["idempotency-key"]);
      if (options.loseFirstResponse && state.keys.length === 1) return route.abort("connectionreset");
      state.updated = true;
      return route.fulfill({ json: { shipmentId: 42, finalizedLines: 1, adjustments: 1, status: "applied", updated: 1, total: 1, skipped: [] } });
    }
    return route.fallback();
  });
  await page.goto("/shipments/42?tab=allocation&purchase=purchase%3A17%3Alines");
  return { state, failures };
}

test("a closed shipment has one working cost update and saved results survive reload", async ({ page }, info) => {
  const { state, failures } = await closedShipment(page);
  const review = page.getByRole("region", { name: "Allocation status", exact: true });
  await expect(review).toContainText("The duty charge is saved, but its split across products uses older shipment or PO values.");
  await expect(review).toContainText("This shipment stays closed; cost adjustments are recorded automatically.");
  for (const name of ["Re-run allocation", "Run Allocation", "Finalize", "Push Costs to Lots"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  expect(state.keys).toEqual([]);
  await page.screenshot({ path: info.outputPath("closed-shipment-cost-review-before.png"), fullPage: true });
  await review.screenshot({ path: info.outputPath("cost-review-action.png") });
  await review.getByRole("button", { name: "Update shipment costs", exact: true }).click();
  await expect(review.getByText("Charge split current", { exact: true })).toBeVisible();
  const results = page.getByRole("region", { name: "Inventory cost results" });
  await expect(results).toContainText("1 of 1 shipment lines updated successfully.");
  expect(state.keys).toHaveLength(1);
  expect(state.keys[0]).toMatch(/^[\da-f-]{36}$/);
  await page.reload();
  await expect(results).toContainText("1 of 1 shipment lines updated successfully.");
  await expect(page.getByText("Closed", { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("closed-shipment-cost-review-after.png"), fullPage: true });
  await results.screenshot({ path: info.outputPath("saved-inventory-cost-results.png") });
  expect(failures).toEqual([]);
});

test("a lost response gives a plain explanation and retry sends the same command key", async ({ page }) => {
  const { state, failures } = await closedShipment(page, { loseFirstResponse: true });
  const button = page.getByRole("button", { name: "Update shipment costs", exact: true });
  await button.click();
  const error = page.getByRole("alert").filter({ hasText: "We could not confirm the cost update." });
  await expect(error).toBeVisible();
  await expect(error).not.toContainText("409:");
  await button.click();
  await expect(page.getByRole("region", { name: "Inventory cost results" })).toContainText("updated successfully");
  expect(state.keys).toHaveLength(2);
  expect(state.keys[0]).toBe(state.keys[1]);
  expect(failures).toEqual([]);
});

test("viewers can read costs but cannot start the approval-controlled update", async ({ page }) => {
  const { state, failures } = await closedShipment(page, { viewer: true });
  await expect(page.getByText("A purchasing approver can update these costs. You can review the saved details below.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update shipment costs", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Inventory cost results" })).toContainText("Not updated yet");
  expect(state.keys).toEqual([]);
  expect(failures).toEqual([]);
});
