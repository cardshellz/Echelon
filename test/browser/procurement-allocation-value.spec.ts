import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const staleMessage = "Duty allocation uses historical value evidence. Re-run allocation using the current PO product total before closing.";
const missingMessage = "PO line 101 has no valid product total and piece quantity. Review the purchase source before allocating or closing.";

async function setup(page: Page, mode: "current" | "legacy" | "missing" | "invalid_basis") {
  const failures = await installFixtures(page);
  const state = { legacy: mode === "legacy", missing: mode === "missing" || mode === "invalid_basis", allocations: 0, closes: 0, writes: [] as Array<{ path: string; body: string | null }> };
  const invalidStatus = mode === "invalid_basis" ? "invalid_allocation_basis" : "invalid_value_basis";
  const invalidMessage = mode === "invalid_basis" ? "Shipment line 1 has invalid weight evidence. Review the shipment source before allocating or closing." : missingMessage;
  const method = mode === "invalid_basis" ? "by_weight" : "by_value";
  const line = (id: number, sku: string, productMills: number, dutyCents: number, dutyMills: number) => ({
    id, purchaseOrderId: 17, purchaseOrderLineId: 100 + id, sku, productName: sku, qtyShipped: 1000, cartonCount: 1,
    poUnitCostMills: mode === "missing" && id === 1 ? null : productMills,
    freightAllocatedCents: 0, freightAllocatedMillsPerUnit: 0,
    dutyAllocatedCents: dutyCents, dutyAllocatedMillsPerUnit: dutyMills,
    insuranceAllocatedCents: 0, insuranceAllocatedMillsPerUnit: 0,
    otherAllocatedCents: 0, otherAllocatedMillsPerUnit: 0,
    allocatedCostCents: dutyCents, totalAllocatedMillsPerUnit: dutyMills,
    landedUnitCostMills: state.missing ? null : productMills + dutyMills,
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/inbound-shipments/42") return route.fulfill({ json: {
      id: 42, shipmentNumber: "VALUE-TEST-42", status: "costing", mode: "air", purchaseOrderId: 17,
      allocationMethodDefault: "by_value", statusHistory: [],
      // These are server projection fixtures, not client-calculated allocations.
      // The reviewed sources are 1,000 pieces at $0.0049 and $0.0050, with $9.90 duty.
      lines: [line(1, "PRODUCT-0049", 49, state.legacy ? 0 : 490, state.legacy ? 0 : 49),
        line(2, "PRODUCT-0050", 50, state.legacy ? 990 : 500, state.legacy ? 99 : 50)],
      costs: [{ id: 71, costType: "duty", description: "Reviewed duty", actualCents: 990, estimatedCents: 990,
        allocationMethod: "by_value", currency: "USD", costStatus: "finalized", linkedInvoice: null }],
    } });
    if (request.method() === "GET" && path === "/api/inbound-shipments/42/allocation-status") return route.fulfill({ json: {
      shipmentId: 42, status: state.legacy || state.missing ? "needs_allocation" : "allocated", lineCount: 2,
      costCount: 1, allocatableCostCount: 1, effectiveCostCents: 990, allocatedCostCents: 990, unallocatedCents: 0,
      issueCount: state.legacy || state.missing ? 1 : 0, blockerCount: state.legacy || state.missing ? 1 : 0, warningCount: 0,
      costs: [{ costId: 71, costType: "duty", description: "Reviewed duty", effectiveCents: 990, allocatedCents: 990,
        allocationCount: 2, method, methodSource: "cost_type_override", rawBasisTotal: state.missing ? null : 990,
        basisTotal: state.missing ? null : 990, usedFallback: false,
        status: state.missing ? invalidStatus : state.legacy ? "stale_allocation_basis" : "allocated" }],
      issues: state.missing ? [{ severity: "blocker", code: invalidStatus, costId: 71, lineId: 1, message: invalidMessage }]
        : state.legacy ? [{ severity: "blocker", code: "stale_allocation_basis", costId: 71, message: staleMessage }] : [],
    } });
    if (request.method() === "POST" && ["/api/inbound-shipments/42/allocate", "/api/inbound-shipments/42/close"].includes(path)) {
      state.writes.push({ path, body: request.postData() });
      if (path.endsWith("/close")) state.closes++; else state.allocations++;
      if (state.missing) return route.fulfill({ status: 400, json: { error: invalidMessage, code: invalidStatus } });
      if (path.endsWith("/allocate")) { state.legacy = false; return route.fulfill({ json: { allocated: 1 } }); }
      throw new Error("This fixture does not authorize shipment finalization");
    }
    return route.fallback();
  });
  await page.goto("/shipments/42?tab=allocation");
  await expect(page.getByRole("region", { name: "Allocation status", exact: true })).toBeVisible();
  return { state, failures, invalidMessage };
}

async function expectExactAllocation(page: Page) {
  const first = page.getByRole("row").filter({ hasText: "PRODUCT-0049" });
  const second = page.getByRole("row").filter({ hasText: "PRODUCT-0050" });
  await expect(first.getByRole("cell").nth(1)).toHaveText("$0.0049");
  await expect(first.getByRole("cell").nth(3)).toContainText("$4.90");
  await expect(first.getByRole("cell").nth(3)).toContainText("$0.0049/unit");
  await expect(first.getByRole("cell").nth(7)).toHaveText("$0.0098");
  await expect(second.getByRole("cell").nth(1)).toHaveText("$0.0050");
  await expect(second.getByRole("cell").nth(3)).toContainText("$5.00");
  await expect(second.getByRole("cell").nth(3)).toContainText("$0.0050/unit");
  await expect(second.getByRole("cell").nth(7)).toHaveText("$0.0100");
}

test("by-value allocation explains the source and preserves server subcent product and duty values", async ({ page }, info) => {
  const { state, failures } = await setup(page, "current");
  const status = page.getByRole("region", { name: "Allocation status", exact: true });
  await expect(status).toContainText("By value uses each PO line's product total, prorated to the pieces in this shipment.");
  await expect(status).toContainText("Allocation preserves subcent product values.");
  const basis = status.getByRole("cell").filter({ hasText: "PO product value (cents)" });
  await expect(basis).toContainText("990");
  await expectExactAllocation(page);
  await expect(page.getByRole("button", { name: "Re-run allocation", exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]); expect(failures).toEqual([]);
  await status.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("exact-value-allocation.png"), fullPage: true });
});

test("historical by-value evidence stays under review until the operator reruns server allocation", async ({ page }) => {
  const { state, failures } = await setup(page, "legacy");
  const status = page.getByRole("region", { name: "Allocation status", exact: true });
  await expect(status.getByText("Stale Basis", { exact: true })).toBeVisible();
  await expect(status.getByText(staleMessage, { exact: true })).toBeVisible();
  const first = page.getByRole("row").filter({ hasText: "PRODUCT-0049" });
  await expect(first.getByRole("cell").nth(3)).toContainText("$0.00");
  expect(state.writes).toEqual([]);
  await status.getByRole("button", { name: "Re-run allocation", exact: true }).click();
  await expectExactAllocation(page);
  await expect(status.getByText("Stale Basis", { exact: true })).toHaveCount(0);
  await expect(status.getByText(staleMessage, { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([{ path: "/api/inbound-shipments/42/allocate", body: null }]);
  expect(state.allocations).toBe(1); expect(state.closes).toBe(0); expect(failures).toEqual([]);
});

for (const mode of ["missing", "invalid_basis"] as const) test(`${mode} allocation evidence remains visible and cannot finalize the shipment`, async ({ page }) => {
  const { state, failures, invalidMessage } = await setup(page, mode);
  const status = page.getByRole("region", { name: "Allocation status", exact: true });
  await expect(status.getByText("Data needs review", { exact: true })).toBeVisible();
  await expect(status.getByText(invalidMessage, { exact: true })).toBeVisible();
  await expect(status.getByRole("row").nth(1).getByRole("cell").nth(4)).toHaveText(mode === "missing" ? "—PO product value (cents)" : "—");
  if (mode === "missing") await expect(page.getByRole("row").filter({ hasText: "PRODUCT-0049" }).getByRole("cell").nth(1)).toHaveText("—");
  else await expect(status.getByText(/By value uses/)).toHaveCount(0);
  await page.getByRole("button", { name: "Close Shipment", exact: true }).click();
  await expect.poll(() => state.closes).toBe(1);
  await expect(page.getByRole("button", { name: "Close Shipment", exact: true })).toBeEnabled();
  await expect(status.getByText("Data needs review", { exact: true })).toBeVisible();
  await expect(page.getByText("Shipment close completed", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("region", { name: "Allocation status", exact: true }).getByText(invalidMessage, { exact: true })).toBeVisible();
  expect(state.closes).toBe(1); expect(state.allocations).toBe(0); expect(failures).toEqual([]);
});
