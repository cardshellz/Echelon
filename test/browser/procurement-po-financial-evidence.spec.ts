import { expect, test, type Page } from "@playwright/test";
import type { PoFinancialEvidence } from "../../shared/procurement/po-financial-evidence";
import { installFixtures, po } from "./procurement-fixtures";
import { expectFinancialRetryBoundaries, installFinancialRetryClock } from "./procurement-retry-clock";

const complete = (): PoFinancialEvidence => ({
  purchaseOrderId: 17, currency: "USD", state: "complete", invoiceCount: 1,
  invoicedAmountCents: 10000, paidAmountCents: 4000, outstandingAmountCents: 6000, reviewReasons: [],
});
const sharedPartial = (): PoFinancialEvidence => ({
  ...complete(), state: "review_required", paidAmountCents: null, outstandingAmountCents: null,
  reviewReasons: [{ code: "PO_SHARED_INVOICE_PARTIAL_PAYMENT", invoiceId: 71,
    message: "This invoice includes multiple purchases and its partial payment has no recorded PO split." }],
});

async function installFinancialFixtures(page: Page, evidence: unknown, options: { paidStatus?: boolean; autoDraft?: boolean } = {}) {
  const failures = await installFixtures(page);
  await page.route("**/api/purchase-orders/17", route => route.fulfill({ json: {
    ...po(17), status: "received", physicalStatus: "received", financialStatus: options.paidStatus ? "paid" : "partially_paid",
    // Deliberately contradictory cached whole-document figures must never become PO amounts.
    invoicedTotalCents: 990000, paidTotalCents: 990000, outstandingCents: 0,
    createdAt: "2026-10-01T00:00:00Z", firstInvoicedAt: "2026-09-01T00:00:00Z",
    ...(options.autoDraft ? { autoDraftActionPlan: {
      primaryAction: { id: "done", label: "No next action", detail: "Invoice and payment are complete.", severity: "success" },
      checklist: [{ id: "ap_closeout", label: "AP closeout", status: "done", detail: "Invoice and payment are complete." }],
      context: { lineCount: 0, openExceptionCount: 0, availableLifecycleActionIds: [] },
    } } : {}),
  } }));
  await page.route("**/api/purchase-orders/17/financial-evidence", route => route.fulfill({ json: evidence }));
  await page.route("**/api/purchase-orders/17/invoices", route => route.fulfill({ json: { invoices: [{
    id: 71, invoiceNumber: "TEST-SHARED-71", status: "partially_paid", currency: "USD",
    invoicedAmountCents: 30000, paidAmountCents: 10000, balanceCents: 20000,
  }] } }));
  await page.route("**/api/purchase-orders/17/payments", route => route.fulfill({ json: { payments: [{
    allocationId: 81, apPaymentId: 91, appliedAmountCents: 10000, invoiceNumber: "TEST-SHARED-71",
    paymentDate: "2026-10-01", paymentMethod: "ach", paymentNumber: "TEST-PAY-91",
  }] } }));
  return failures;
}

const financialCard = (page: Page) => page.getByRole("region", { name: "Purchase order financial evidence", exact: true });
const amountField = (page: Page, label: string) => financialCard(page).locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });

test("shows supported PO amounts separately from recorded whole-invoice status", async ({ page }, info) => {
  const failures = await installFinancialFixtures(page, complete());
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(amountField(page, "Invoiced to this PO")).toHaveText("Invoiced to this PO$100.00");
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this PO$40.00");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this PO$60.00");
  await expect(page.getByText("Linked invoice status describes whole invoices", { exact: false })).toBeVisible();
  await expect(page.getByText("$9,900.00", { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await financialCard(page).screenshot({ path: info.outputPath("po-financial-known.png") });
  expect(failures).toEqual([]);
});

test("shared partial settlement stays unknown and directs review even when cached status says paid", async ({ page }, info) => {
  const failures = await installFinancialFixtures(page, sharedPartial(), { paidStatus: true, autoDraft: true });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(amountField(page, "Invoiced to this PO")).toHaveText("Invoiced to this PO$100.00");
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this POUnknown");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this POUnknown");
  await expect(financialCard(page)).not.toContainText("$0.00");
  await expect(page.getByText("All done — PO fully received and paid.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Review linked invoices", exact: true })).toBeVisible();
  await expect(page.getByText("Invoice and payment are complete.", { exact: true })).toHaveCount(0);
  await financialCard(page).screenshot({ path: info.outputPath("po-shared-payment-unknown.png") });
  await financialCard(page).getByRole("button", { name: "Review linked invoices", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Invoices", exact: true })).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("columnheader", { name: "Entire invoice amount", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "$300.00", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Payments", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Applied to entire invoice", exact: true })).toBeVisible();
  await expect(page.getByText("These amounts are not payment allocations to this purchase order.", { exact: false })).toBeVisible();
  expect(failures).toEqual([]);
});

test("unmapped invoice evidence displays unknown amounts rather than zero", async ({ page }) => {
  const failures = await installFinancialFixtures(page, {
    ...sharedPartial(), invoicedAmountCents: null,
    reviewReasons: [{ code: "PO_INVOICE_UNASSIGNED_LINES", invoiceId: 71, message: "Invoice lines need a verified purchase source." }],
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(financialCard(page).getByText("Unknown", { exact: true })).toHaveCount(3);
  await expect(financialCard(page)).toContainText("Invoice lines need a verified purchase source.");
  await expect(financialCard(page)).not.toContainText("$0.00");
  expect(failures).toEqual([]);
});

test("confirmed zero amounts remain distinguishable from unknown evidence", async ({ page }) => {
  const failures = await installFinancialFixtures(page, {
    ...complete(), invoiceCount: 0, invoicedAmountCents: 0, paidAmountCents: 0, outstandingAmountCents: 0,
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(financialCard(page).getByText("$0.00", { exact: true })).toHaveCount(3);
  await expect(financialCard(page)).toContainText("No active linked invoices recorded.");
  await expect(financialCard(page).getByText("Unknown", { exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("loading never falls back to cached totals", async ({ page }) => {
  const failures = await installFinancialFixtures(page, complete(), { paidStatus: true, autoDraft: true });
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/purchase-orders/17/financial-evidence", async route => {
    await pending;
    await route.fulfill({ json: complete() });
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(financialCard(page)).toContainText("Loading purchase order financial evidence…");
  await expect(financialCard(page).locator("dd")).toHaveCount(0);
  await expect(page.getByText("$9,900.00", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Loading financial evidence…", exact: true })).toBeVisible();
  await expect(page.getByText("Invoice and payment are complete.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("All done — PO fully received and paid.", { exact: true })).toHaveCount(0);
  release();
  await expect(amountField(page, "Paid for this PO")).toContainText("$40.00");
  expect(failures).toEqual([]);
});

test("failed evidence read offers a retry without displaying stale cached money", async ({ page }) => {
  const failures = await installFinancialFixtures(page, complete(), { paidStatus: true, autoDraft: true });
  let available = false;
  await page.route("**/api/purchase-orders/17/financial-evidence", route => available
    ? route.fulfill({ json: complete() })
    : route.fulfill({ status: 503, json: { error: "Read unavailable" } }));
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(financialCard(page).getByRole("alert")).toContainText("amounts are unavailable");
  await expect(financialCard(page).locator("dd")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Reload financial evidence", exact: true })).toBeVisible();
  await expect(page.getByText("Invoice and payment are complete.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("All done — PO fully received and paid.", { exact: true })).toHaveCount(0);
  available = true;
  await financialCard(page).getByRole("button", { name: "Reload financial evidence", exact: true }).click();
  await expect(amountField(page, "Paid for this PO")).toContainText("$40.00");
  await expect(page.getByRole("heading", { name: "Review linked invoices", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

for (const invalid of [
  { name: "another purchase order", response: { ...complete(), purchaseOrderId: 99 } },
  { name: "a malformed amount", response: { ...complete(), paidAmountCents: "4000" } },
]) {
  test(`rejects financial evidence for ${invalid.name}`, async ({ page }) => {
    const failures = await installFinancialFixtures(page, invalid.response);
    await page.goto("/purchase-orders/17?tab=lines");
    await expect(financialCard(page).getByRole("alert")).toContainText("amounts are unavailable");
    await expect(financialCard(page).locator("dd")).toHaveCount(0);
    expect(failures).toEqual([]);
  });
}

test("invoice payment remains available with an explicit entire-invoice balance", async ({ page }) => {
  const failures = await installFinancialFixtures(page, sharedPartial());
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(financialCard(page)).toContainText("Financial attribution needs review");
  await page.getByRole("button", { name: "Record invoice payment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Record invoice payment", exact: true });
  await expect(dialog).toContainText("payment against the entire invoice, which may cover other purchase orders");
  await expect(dialog.getByRole("option", { name: "TEST-SHARED-71 — $200.00 due on entire invoice", exact: true })).toBeAttached();
  await expect(dialog.locator('input[type="number"]')).toHaveValue("200.00");
  expect(failures).toEqual([]);
});

test("returning from a linked invoice reloads the PO financial evidence", async ({ page }) => {
  const failures = await installFinancialFixtures(page, sharedPartial());
  await page.goto("/purchase-orders/17?tab=invoices");
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this POUnknown");
  await page.getByRole("link", { name: "View →", exact: true }).click();
  await expect(page).toHaveURL(/\/ap-invoices\/71/);
  // Simulate an invoice settlement completed while the PO screen is unmounted.
  await page.route("**/api/purchase-orders/17/financial-evidence", route => route.fulfill({ json: {
    ...complete(), paidAmountCents: 10000, outstandingAmountCents: 0,
  } }));
  await page.goBack();
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this PO$100.00");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this PO$0.00");
  expect(failures).toEqual([]);
});

test("recording an invoice payment refreshes mounted PO evidence through the shared query prefix", async ({ page }) => {
  const failures = await installFinancialFixtures(page, sharedPartial());
  let settled = false;
  let reads = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/purchase-orders/17/financial-evidence", async route => {
    reads += 1;
    if (settled) await pending;
    return route.fulfill({ json: settled ? { ...complete(), paidAmountCents: 10000, outstandingAmountCents: 0 } : sharedPartial() });
  });
  await page.route("**/api/ap-payments", route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({
      totalAmountCents: 20000, allocations: [{ vendorInvoiceId: 71, appliedAmountCents: 20000 }],
    });
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    settled = true;
    return route.fulfill({ json: { id: 91, apLedgerOutcome: { affectedPurchaseOrderIds: [17, 99] } } });
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this POUnknown");
  await page.getByRole("button", { name: "Record invoice payment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Record invoice payment", exact: true });
  await dialog.getByRole("button", { name: "Record invoice payment", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(financialCard(page)).toContainText("Refreshing purchase order financial evidence…");
  await expect(financialCard(page).locator("dd")).toHaveCount(0);
  release();
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this PO$100.00");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this PO$0.00");
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(failures).toEqual([]);
});

test("a lost payment response reloads committed evidence after bounded retries", async ({ page }) => {
  await installFinancialRetryClock(page);
  const failures = await installFinancialFixtures(page, sharedPartial());
  let settled = false;
  const keys: string[] = [];
  await page.route("**/api/purchase-orders/17/financial-evidence", route => route.fulfill({ json:
    settled ? { ...complete(), paidAmountCents: 10000, outstandingAmountCents: 0 } : sharedPartial(),
  }));
  await page.route("**/api/ap-payments", route => {
    keys.push(route.request().headers()["idempotency-key"]);
    settled = true;
    return route.abort("connectionreset");
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this POUnknown");
  await page.getByRole("button", { name: "Record invoice payment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Record invoice payment", exact: true });
  await expectFinancialRetryBoundaries(page,
    () => dialog.getByRole("button", { name: "Record invoice payment", exact: true }).click(),
    () => keys.length);
  await expect(dialog.getByRole("button", { name: "Record invoice payment", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this PO$100.00");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this PO$0.00");
  expect(keys).toHaveLength(4);
  expect(new Set(keys).size).toBe(1);
  expect(failures).toEqual([]);
});
