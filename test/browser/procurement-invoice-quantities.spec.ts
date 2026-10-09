import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const exceptionUrl = "/purchase-orders/17?tab=exceptions";

async function setup(page: Page) {
  const failures = await installFixtures(page);
  let orderedQty = 25000;
  let available = true;
  await page.route("**/api/purchase-orders/17/exceptions*", (route) => route.fulfill({ json: { exceptions: [{
    id: 81, poId: 17, kind: "match_mismatch", severity: "warn", status: "open",
    title: "3-way match discrepancy — Invoice TEST-INV-71", message: "Quantity discrepancy", detectedBy: "system",
    detectedAt: "2026-10-08T12:00:00Z", payload: { invoiceId: 71, mismatchedLineIds: [72] },
  }] } }));
  await page.route("**/api/vendor-invoices/71", (route) => route.fulfill({ json: {
    id: 71, invoiceNumber: "TEST-INV-71", vendorId: 2, vendorName: "Test vendor", status: "paid", currency: "USD",
    invoicedAmountCents: 669375, balanceCents: 0, paidAmountCents: 669375, attachments: [], payments: [],
    poLinks: [{ id: 1, purchaseOrderId: 17, poNumber: "TEST-PO-17" }],
    lines: [{ id: 72, lineNumber: 1, purchaseOrderLineId: 18, sku: "COMPARE-SKU", productName: "Synthetic quantity comparison",
      qtyInvoiced: 12500, qtyOrdered: 12500, qtyReceived: 12500, unitCostCents: 50, unitCostMills: 5023,
      lineTotalCents: 669375, matchStatus: "qty_discrepancy",
      poQuantities: available
        ? { status: "current", purchaseOrderId: 17, purchaseOrderLineId: 18, orderedQty, receivedQty: 25000 }
        : { status: "unavailable" },
    }],
  } }));
  return { failures, correctPo: (quantity: number) => { orderedQty = quantity; }, removePo: () => { available = false; } };
}

async function expectComparison(row: Locator, testInfo: TestInfo, ordered: string) {
  if (testInfo.project.name === "mobile") {
    await expect(row.getByText(`PO ordered: ${ordered}`, { exact: true })).toBeVisible();
    await expect(row.getByText("PO received: 25,000", { exact: true })).toBeVisible();
  } else {
    await expect(row.locator("td").nth(4)).toHaveText(ordered);
    await expect(row.locator("td").nth(5)).toHaveText("25,000");
  }
  await expect(row.locator("td").nth(3)).toHaveText(/^12500/);
  await expect(row.locator("td").nth(7)).toHaveText("$6,693.75");
  await expect(row.getByText("Qty Mismatch", { exact: true })).toBeVisible();
}

test("keeps current PO counts and original invoice economics consistent through exception, direct, and refreshed views", async ({ page }, testInfo) => {
  const proof = await setup(page);
  await page.goto(exceptionUrl);
  await page.getByRole("link", { name: "Open invoice issues", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "COMPARE-SKU" });
  await expectComparison(row, testInfo, "25,000");
  await page.screenshot({ path: testInfo.outputPath("invoice-current-po-comparison.png"), fullPage: true });
  await page.goto("/ap-invoices/71");
  await expectComparison(row, testInfo, "25,000");
  proof.correctPo(30000);
  await page.reload();
  await expectComparison(row, testInfo, "30,000");
  await expect(page.getByRole("heading", { name: "Invoice #TEST-INV-71", exact: true })).toBeVisible();
  expect(proof.failures).toEqual([]);
});

test("marks unavailable PO comparisons without presenting the historical count as current", async ({ page }, testInfo) => {
  const proof = await setup(page);
  proof.removePo();
  await page.goto("/ap-invoices/71");
  const row = page.getByRole("row").filter({ hasText: "COMPARE-SKU" });
  if (testInfo.project.name === "mobile") {
    await expect(row.getByText("PO ordered: PO comparison unavailable", { exact: true })).toBeVisible();
  } else {
    await expect(row.locator("td").nth(4)).toHaveText("PO comparison unavailable");
    await expect(row.locator("td").nth(5)).toHaveText("PO comparison unavailable");
  }
  await expect(row.locator("td").nth(3)).toHaveText(/^12500/);
  expect(proof.failures).toEqual([]);
});
