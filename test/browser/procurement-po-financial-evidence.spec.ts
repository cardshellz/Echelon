import { invoiceSourceFixture, unbilledOwnershipFixture } from "../fixtures/invoice-source";
import { expect, test, type Page } from "@playwright/test";
import type { PoFinancialEvidence } from "../../shared/procurement/po-financial-evidence";
import type { PoFinancialWorkflow } from "../../shared/procurement/po-financial-workflow";
import { financialWorkflowFixture } from "../fixtures/po-financial-workflow";
import { installFixtures, po } from "./procurement-fixtures";
import { recordedPaymentReply } from "./procurement-payment-fixtures";

const complete = (): PoFinancialEvidence => ({
  purchaseOrderId: 17, currency: "USD", state: "complete", invoiceCount: 1,
  invoicedAmountCents: 10000, paidAmountCents: 4000, outstandingAmountCents: 6000, reviewReasons: [],
});
const sharedPartial = (): PoFinancialEvidence => ({
  ...complete(), state: "review_required", paidAmountCents: null, outstandingAmountCents: null,
  reviewReasons: [{ code: "PO_SHARED_INVOICE_PARTIAL_PAYMENT", invoiceId: 71,
    message: "This invoice includes multiple purchases and its partial payment has no recorded PO split." }],
});

async function installFinancialFixtures(page: Page, evidence: unknown, options: {
  paidStatus?: boolean;
  autoDraft?: boolean;
  workflow?: PoFinancialWorkflow;
  invoiceStatus?: "received" | "partially_paid" | "paid";
  cancelled?: boolean;
  primaryAction?: { id: string; label: string; detail: string; severity: string; tab?: string };
} = {}) {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", route => route.fulfill({ json: {
    user: { id: "test-financial-reviewer", username: "test", role: "admin" },
    permissions: ["purchasing:view", "purchasing:create", "purchasing:approve"], roles: ["admin"],
  } }));
  await page.route("**/api/purchase-orders/17", route => route.fulfill({ json: {
    ...po(17), status: options.cancelled ? "cancelled" : "received", physicalStatus: options.cancelled ? "cancelled" : "received", financialStatus: options.paidStatus ? "paid" : "partially_paid",
    // Deliberately contradictory cached whole-document figures must never become PO amounts.
    invoicedTotalCents: 990000, paidTotalCents: 990000, outstandingCents: 0,
    financialWorkflow: options.workflow,
    createdAt: "2026-10-01T00:00:00Z", firstInvoicedAt: "2026-09-01T00:00:00Z",
    ...(options.autoDraft ? { autoDraftActionPlan: {
      primaryAction: options.primaryAction ?? { id: "done", label: "No next action", detail: "Invoice and payment are complete.", severity: "success" },
      checklist: [{ id: "ap_closeout", label: "AP closeout", status: options.primaryAction ? "current" : "done", detail: options.primaryAction?.detail ?? "Invoice and payment are complete." }],
      context: { lineCount: 0, openExceptionCount: 0, availableLifecycleActionIds: [] },
    } } : {}),
  } }));
  await page.route("**/api/purchase-orders/17/financial-evidence", route => route.fulfill({ json: evidence }));
  await page.route("**/api/purchase-orders/17/invoices", route => route.fulfill({ json: { invoices: [{
    id: 71, invoiceNumber: "TEST-SHARED-71", status: options.invoiceStatus ?? "partially_paid", currency: "USD",
    invoicedAmountCents: 30000, paidAmountCents: 10000, balanceCents: 20000,
  }] } }));
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: {
    sourceCapabilities: invoiceSourceFixture(), id: 71, invoiceNumber: "TEST-SHARED-71", vendorId: 2, vendorName: "Test vendor", status: options.invoiceStatus ?? "partially_paid", currency: "USD",
    invoicedAmountCents: 30000, paidAmountCents: 10000, balanceCents: 20000, paymentReviewRequired: false,
    lines: [], poLinks: [{ id: 1, purchaseOrderId: 17, poNumber: "TEST-PO-17" }], attachments: [], payments: [],
  } }));
  await page.route("**/api/purchase-orders/17/payments", route => route.fulfill({ json: { payments: [{
    allocationId: 81, apPaymentId: 91, appliedAmountCents: 10000, invoiceNumber: "TEST-SHARED-71",
    paymentDate: "2026-10-01", paymentMethod: "ach", paymentNumber: "TEST-PAY-91",
  }] } }));
  return failures;
}

const financialCard = (page: Page) => page.getByRole("region", { name: "Purchase order financial evidence", exact: true });
const amountField = (page: Page, label: string) => financialCard(page).locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });

async function openLinkedInvoice(page: Page) {
  await page.getByRole("tab", { name: "Invoices", exact: true }).click();
  await page.getByRole("link", { name: "View →", exact: true }).click();
  await expect(page).toHaveURL(/\/ap-invoices\/71/);
}

async function openInvoicePayment(page: Page) {
  await openLinkedInvoice(page);
  await page.getByRole("button", { name: "Record Payment", exact: true }).first().click();
  return page.getByRole("dialog", { name: "Record Payment", exact: true });
}

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
  await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
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
  await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
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
  await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
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

test("shared invoice payment remains available from its invoice owner with the whole balance", async ({ page }) => {
  const failures = await installFinancialFixtures(page, sharedPartial());
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(financialCard(page)).toContainText("Financial attribution needs review");
  await expect(page.getByRole("button", { name: "Record invoice payment", exact: true })).toHaveCount(0);
  await page.getByRole("region", { name: "Purchase order actions", exact: true }).getByRole("button", { name: "Review linked invoices", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Invoices", exact: true })).toHaveAttribute("data-state", "active");
  const dialog = await openInvoicePayment(page);
  await expect(dialog).toContainText("Balance due: $200.00");
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

test("recording an invoice payment reloads the PO evidence on return from its invoice owner", async ({ page }) => {
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
    return route.fulfill({ json: { ...recordedPaymentReply(route.request().postDataJSON(), route.request().headers()["idempotency-key"], "test-financial-reviewer", 91), apLedgerOutcome: { affectedPurchaseOrderIds: [17, 99] } } });
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this POUnknown");
  const dialog = await openInvoicePayment(page);
  await dialog.getByRole("button", { name: "Record Payment", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.goBack();
  await expect(financialCard(page)).toContainText("Refreshing purchase order financial evidence…");
  await expect(financialCard(page).locator("dd")).toHaveCount(0);
  release();
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this PO$100.00");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this PO$0.00");
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(failures).toEqual([]);
});

test("a lost payment response retains its exact request while PO evidence refreshes", async ({ page }) => {
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
  const dialog = await openInvoicePayment(page);
  await dialog.getByRole("button", { name: "Record Payment", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Record Payment", exact: true })).toBeDisabled();
  for (let attempt = 2; attempt <= 4; attempt += 1) {
    const retry = dialog.getByRole("button", { name: "Recover saved payment request", exact: true });
    await expect(retry).toBeEnabled(); await retry.click(); await expect.poll(() => keys.length).toBe(attempt);
  }
  await expect(dialog.getByRole("button", { name: "Recover saved payment request", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.goBack();
  await expect(amountField(page, "Paid for this PO")).toHaveText("Paid for this PO$100.00");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this PO$0.00");
  expect(keys).toHaveLength(4);
  expect(new Set(keys).size).toBe(1);
  expect(failures).toEqual([]);
});

for (const scenario of [
  { state: "review_required", id: "review_financial_evidence", label: "Review linked invoices", detail: "Current server evidence requires invoice review." },
  { state: "awaiting_approval", id: "review_invoice_approval", label: "Review invoice approval", detail: "The linked invoice is awaiting approval." },
  { state: "payment_due", id: "record_payment", label: "Review invoice payment", detail: "Review the outstanding linked invoice before recording payment." },
] as const) {
  test(`preserves the server ${scenario.state} action despite cached paid status`, async ({ page }) => {
    const workflow = financialWorkflowFixture(17, scenario.state);
    const failures = await installFinancialFixtures(page, workflow.evidence, {
      paidStatus: true, autoDraft: true, workflow,
      invoiceStatus: scenario.state === "awaiting_approval" ? "received" : "partially_paid",
      primaryAction: { ...scenario, severity: "warning", tab: "invoices" },
    });
    await page.goto("/purchase-orders/17?tab=lines");
    await expect(page.getByRole("heading", { name: scenario.label, exact: true })).toBeVisible();
    await expect(page.getByText(scenario.detail, { exact: true }).first()).toBeVisible();
    await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
    await page.getByRole("region", { name: "Auto-draft next action", exact: true }).getByRole("button", { name: scenario.label, exact: true }).click();
    await expect(page.getByRole("tab", { name: "Invoices", exact: true })).toHaveAttribute("data-state", "active");
    await expect(page.getByRole("dialog", { name: "Record invoice payment", exact: true })).toHaveCount(0);
    if (scenario.state === "awaiting_approval") {
      await openLinkedInvoice(page);
      await expect(page.getByRole("button", { name: "Approve", exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Record Payment", exact: true })).toHaveCount(0);
    }
    expect(failures).toEqual([]);
  });
}

test("a zero-balance unapproved invoice cannot claim completion", async ({ page }) => {
  const workflow = financialWorkflowFixture(17, "awaiting_approval");
  workflow.evidence.invoicedAmountCents = 0;
  workflow.evidence.outstandingAmountCents = 0;
  const failures = await installFinancialFixtures(page, workflow.evidence, {
    paidStatus: true, autoDraft: true, workflow,
    primaryAction: { id: "review_invoice_approval", label: "Review invoice approval", detail: "Approve the zero-value invoice before closeout.", severity: "info", tab: "invoices" },
  });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(amountField(page, "Outstanding for this PO")).toHaveText("Outstanding for this PO$0.00");
  await expect(page.getByRole("heading", { name: "Review invoice approval", exact: true })).toBeVisible();
  await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("verified settled workflow permits completion independently of the cached status", async ({ page }) => {
  const workflow = financialWorkflowFixture(17, "settled");
  const failures = await installFinancialFixtures(page, workflow.evidence, { autoDraft: true, workflow });
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByRole("heading", { name: "No next action", exact: true })).toBeVisible();
  await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

for (const currentState of ["payment_due", "unbilled"] as const) {
  test(`conflicting successful reads cannot inherit settlement after evidence becomes ${currentState}`, async ({ page }) => {
    const workflow = financialWorkflowFixture(17, "settled");
    const failures = await installFinancialFixtures(page, financialWorkflowFixture(17, currentState).evidence, { paidStatus: true, autoDraft: true, workflow });
    await page.goto("/purchase-orders/17?tab=lines");
    await expect(page.getByRole("heading", { name: "Reload financial evidence", exact: true })).toBeVisible();
    await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Invoice and payment are complete.", { exact: true })).toHaveCount(0);
    expect(failures).toEqual([]);
  });
}

test("a new invoice read cannot reuse older unbilled creation guidance", async ({ page }) => {
  const failures = await installFinancialFixtures(page, financialWorkflowFixture(17, "payment_due").evidence, {
    autoDraft: true, workflow: financialWorkflowFixture(17, "unbilled"),
    primaryAction: { id: "create_invoice", label: "Create vendor invoice", detail: "No active invoice was recorded in this older snapshot.", severity: "info", tab: "invoices" },
  });
  await page.goto("/purchase-orders/17?tab=lines");
  const guidance = page.getByRole("region", { name: "Auto-draft next action", exact: true });
  await expect(guidance.getByRole("heading", { name: "Reload financial evidence", exact: true })).toBeVisible();
  await expect(guidance).toContainText("Invoice evidence changed between reads.");
  await expect(guidance.getByRole("button", { name: "Create invoice", exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("a refreshed amount read cannot revive a stale completed workflow when the PO read fails", async ({ page }) => {
  const workflow = financialWorkflowFixture(17, "settled");
  const failures = await installFinancialFixtures(page, workflow.evidence, { autoDraft: true, workflow });
  await page.goto("/purchase-orders/17?tab=invoices");
  await expect(page.getByRole("heading", { name: "No next action", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "View →", exact: true }).click();
  await expect(page).toHaveURL(/\/ap-invoices\/71/);
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  let unavailable = true;
  await page.route("**/api/purchase-orders/17", async route => {
    if (!unavailable) return route.fallback();
    await pending;
    return route.fulfill({ status: 503, json: { error: "Current workflow unavailable" } });
  });
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Loading financial evidence…", exact: true })).toBeVisible();
  await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
  release();
  const guidance = page.getByRole("region", { name: "Auto-draft next action", exact: true });
  await expect(guidance.getByRole("heading", { name: "Reload financial evidence", exact: true })).toBeVisible();
  await expect(page.getByText("PO fully received and paid. Review the cost summary for any remaining cost follow-ups.", { exact: true })).toHaveCount(0);
  unavailable = false;
  await guidance.getByRole("button", { name: "Reload financial evidence", exact: true }).click();
  await expect(guidance.getByRole("heading", { name: "No next action", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("a cached paid PO with no active invoices keeps the invoice creation path", async ({ page }) => {
  const workflow = financialWorkflowFixture(17, "unbilled");
  const failures = await installFinancialFixtures(page, workflow.evidence, { paidStatus: true, workflow });
  await page.route("**/api/purchase-orders/17/invoices", route => route.fulfill({ json: { invoices: [] } }));
  await page.route("**/api/vendor-invoices/next-number", route => route.fulfill({ json: { invoiceNumber: "TEST-NEW-INVOICE" } }));
  await page.goto("/purchase-orders/17?tab=lines");
  await page.getByRole("region", { name: "Purchase order actions", exact: true }).getByRole("button", { name: "Review linked invoices", exact: true }).click();
  await page.getByRole("button", { name: "Add invoice", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("TEST-PO-17");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Create Invoice", exact: true })).toBeEnabled();
  expect(failures).toEqual([]);
});

test("cancelled physical work still exposes linked invoice payment review", async ({ page }) => {
  const workflow = financialWorkflowFixture(17, "payment_due");
  const failures = await installFinancialFixtures(page, workflow.evidence, { cancelled: true, paidStatus: true, autoDraft: true, workflow,
    primaryAction: { id: "record_payment", label: "Review invoice payment", detail: "Cancelled receiving does not settle this invoice.", severity: "info", tab: "invoices" } });
  await page.route("**/api/purchase-orders/17/payments", route => route.fulfill({ json: { payments: [81, 82].map(allocationId => ({
    allocationId, apPaymentId: 91, appliedAmountCents: 5000, invoiceNumber: "TEST-SHARED-71", paymentMethod: "ach", paymentNumber: "TEST-PAY-91",
    paymentCalendarDate: "2026-10-19", paymentDateSource: "recorded_calendar_date",
  })) } }));
  await page.goto("/purchase-orders/17?tab=lines");
  await page.getByRole("tab", { name: "Payments", exact: true }).click();
  await expect(page.getByRole("button", { name: "2 payment applications recorded", exact: true })).toBeVisible();
  await expect(page.getByText("2 payments recorded", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Review invoice payment", exact: true })).toBeVisible();
  await page.getByRole("region", { name: "Auto-draft next action", exact: true }).getByRole("button", { name: "Review invoice payment", exact: true }).click();
  await openLinkedInvoice(page);
  await expect(page.getByRole("button", { name: "Record Payment", exact: true }).first()).toBeVisible();
  expect(failures).toEqual([]);
});

for (const document of [
  { path: "invoices", tab: "Invoices", loading: "Loading linked invoices…", unavailable: "Linked invoices could not be loaded.",
    empty: "No invoices linked to this PO yet.", retry: "Reload linked invoices", header: "Entire invoice amount" },
  { path: "payments", tab: "Payments", loading: "Loading invoice payments…", unavailable: "Linked invoice payments could not be loaded.",
    empty: "No completed payments recorded against linked invoices.", retry: "Reload invoice payments", header: "Applied to entire invoice" },
]) {
  test(`${document.path} loading and failed reads never claim an empty financial history`, async ({ page }) => {
    const failures = await installFinancialFixtures(page, sharedPartial());
    let release: () => void = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    let unavailable = true;
    await page.route(`**/api/purchase-orders/17/${document.path}`, async route => {
      if (!unavailable) return route.fallback();
      await pending;
      return route.fulfill({ status: 503, json: { error: "Document read unavailable" } });
    });
    await page.goto(`/purchase-orders/17?tab=${document.path}`);
    await expect(page.getByText(document.loading, { exact: true })).toBeVisible();
    await expect(page.getByText(document.empty, { exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("alert").filter({ hasText: document.unavailable })).toBeVisible();
    await expect(page.getByText(document.empty, { exact: true })).toHaveCount(0);
    unavailable = false;
    await page.getByRole("button", { name: document.retry, exact: true }).click();
    await expect(page.getByRole("columnheader", { name: document.header, exact: true })).toBeVisible();
    expect(failures).toEqual([]);
  });
}

test("missing invoice-link evidence still opens the identified invoice for review", async ({ page }) => {
  const failures = await installFinancialFixtures(page, {
    ...sharedPartial(), invoicedAmountCents: null,
    reviewReasons: [{ code: "PO_INVOICE_OWNERSHIP_INVALID", invoiceId: 71, message: "Invoice 71 owns a PO line but its header link is missing." }],
  });
  await page.route("**/api/purchase-orders/17/invoices", route => route.fulfill({ json: { invoices: [] } }));
  await page.goto("/purchase-orders/17?tab=lines");
  await financialCard(page).getByRole("link", { name: "Open invoice 71", exact: true }).click();
  await expect(page).toHaveURL(/\/ap-invoices\/71/);
  await expect(page.getByRole("heading", { name: "Invoice #TEST-SHARED-71", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("read-only PO review reaches the invoice without exposing its payment or creation controls", async ({ page }) => {
  const failures = await installFinancialFixtures(page, sharedPartial());
  await page.route("**/api/auth/me", route => route.fulfill({ json: {
    user: { id: "test-reader", username: "reader", role: "lead" }, permissions: ["purchasing:view"], roles: ["lead"],
  } }));
  await page.goto("/purchase-orders/17?tab=invoices");
  await expect(page.getByRole("button", { name: "Add invoice", exact: true })).toHaveCount(0);
  await openLinkedInvoice(page);
  await expect(page.getByRole("button", { name: "Record Payment", exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});
