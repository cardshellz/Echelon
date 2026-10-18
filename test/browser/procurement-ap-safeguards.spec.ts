import { invoiceListItem, paymentListItem, workListPage } from "./procurement-ap-work-list-fixtures";
import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const locked = { allowed: false, requiredPermission: "purchasing:edit", code: "AP_INVOICE_FINANCIAL_HISTORY", reason: "This invoice has approval or payment history. Generic edits are locked; use the reviewed quantity correction for supported line corrections." };
const editable = { allowed: true, requiredPermission: "purchasing:edit", code: "AP_INVOICE_EDITABLE", reason: "This invoice can be edited." };
async function setup(page: Page, canEdit = true) {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "ap-reviewer", role: "admin", username: "test" }, permissions: canEdit ? ["purchasing:view", "purchasing:edit", "purchasing:approve"] : ["purchasing:view"], roles: ["admin"] } }));
  return failures;
}
const invoice = (edit = locked) => ({ id: 71, invoiceNumber: "AP-SAFE-71", vendorId: 2, vendorName: "Test vendor", status: "disputed", currency: "USD", invoicedAmountCents: 10000, paidAmountCents: 8000, balanceCents: 2000,
  capabilities: { edit }, paymentReviewRequired: false, lines: [{ id: 72, lineNumber: 1, purchaseOrderLineId: 18, qtyInvoiced: 1, unitCostCents: 10000, unitCostMills: 1000000, lineTotalCents: 10000, productName: "Test item", matchStatus: "qty_discrepancy" }], poLinks: [], attachments: [], payments: [] });

test("recognized disputed bill hides generic edits and retains the reviewed correction and attachments", async ({ page }) => {
  const failures = await setup(page);
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: invoice() }));
  await page.goto("/ap-invoices/71");
  await expect(page.getByText(locked.reason, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Line", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Link PO", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit invoice line for line 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run Match", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Attachments (0)", exact: true }).click();
  await expect(page.getByRole("button", { name: "Upload File", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("stale edit rejection refreshes the server capability and disables resubmission", async ({ page }) => {
  const failures = await setup(page); let protectedHistory = false; let attempts = 0;
  await page.route("**/api/vendor-invoices/71", route => {
    if (route.request().method() === "PATCH") { protectedHistory = true; attempts += 1; return route.fulfill({ status: 409, json: { error: locked.reason, details: { code: locked.code } } }); }
    return route.fulfill({ json: { ...invoice(protectedHistory ? locked : editable), status: "received", paidAmountCents: 0, balanceCents: 10000 } });
  });
  await page.goto("/ap-invoices/71?tab=details");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Save Changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Changes", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: locked.reason }).first()).toBeVisible();
  expect(attempts).toBe(1); expect(failures).toEqual([]);
});

for (const action of ["add-line", "link-po"] as const) {
  test(`already-open ${action} dialog retains its draft and blocks resubmission after a history rejection`, async ({ page }) => {
    const failures = await setup(page); let protectedHistory = false; let attempts = 0;
    await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: { ...invoice(protectedHistory ? locked : editable), status: "received", paidAmountCents: 0, balanceCents: 10000 } }));
    await page.route("**/api/purchase-orders/work-list?*", route => route.fulfill({ json: workListPage([{ id: 17, poNumber: "TEST-PO-17", totalCents: 10000, vendorId: 2, status: "received" }], route.request().url()) }));
    await page.route(`**/api/vendor-invoices/71/${action === "add-line" ? "lines" : "po-links"}`, route => {
      protectedHistory = true; attempts += 1;
      return route.fulfill({ status: 409, json: { error: locked.reason, details: { code: locked.code } } });
    });
    await page.goto("/ap-invoices/71");
    await page.getByRole("button", { name: action === "add-line" ? "Add Line" : "Link PO", exact: true }).click();
    const dialog = page.getByRole("dialog");
    if (action === "add-line") {
      await dialog.getByPlaceholder("1", { exact: true }).fill("2");
      await dialog.getByPlaceholder("0.0000", { exact: true }).fill("1.25");
    } else {
      await dialog.getByRole("button", { name: /TEST-PO-17/ }).click();
    }
    const submit = dialog.getByRole("button", { name: action === "add-line" ? "Add Line" : "Link & Import Lines", exact: true });
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect(dialog.getByRole("alert")).toHaveText(locked.reason);
    if (action === "add-line") await expect(dialog.getByPlaceholder("1", { exact: true })).toHaveValue("2");
    expect(attempts).toBe(1); expect(failures).toEqual([]);
  });
}

for (const scenario of [
  { name: "read-only permission", canEdit: false, capability: editable },
  { name: "missing capability", canEdit: true, capability: undefined },
  { name: "malformed capability", canEdit: true, capability: { allowed: true } },
  { name: "contradictory capability", canEdit: true, capability: { ...locked, allowed: true } },
]) {
  test(`${scenario.name} independently prevents generic edits`, async ({ page }) => {
    const failures = await setup(page, scenario.canEdit);
    await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: { ...invoice(editable), status: "received", capabilities: { edit: scenario.capability } } }));
    await page.goto("/ap-invoices/71");
    await expect(page.getByText(scenario.canEdit ? "Invoice editing availability could not be verified. Reload the invoice before editing." : "You have read-only access to invoice edits.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Line", exact: true })).toHaveCount(0);
    if (!scenario.canEdit) await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    expect(failures).toEqual([]);
  });
}

test("unsupported historical payments require review and cannot be voided", async ({ page }) => {
  const failures = await setup(page);
  await page.route("**/api/ap-payments/work-list?*", route => route.fulfill({ json: workListPage([paymentListItem({ id: 90, paymentNumber: "LEGACY-90", vendorName: "Test vendor", status: "scheduled", totalAmountCents: 2000, paymentDate: "2026-10-13T12:00:00Z", paymentMethod: "ach" })], route.request().url()) }));
  await page.goto("/ap-payments");
  await expect(page.getByText("Historical status requires review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Void", exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("dashboard identifies disputed debt and the open list includes disputed invoices", async ({ page }) => {
  const failures = await setup(page); const statuses: string[] = [];
  await page.route("**/api/ap/summary", route => route.fulfill({ json: { totalOutstandingCents: 2000, disputedOutstandingCents: 2000, disputedInvoiceCount: 1, openInvoiceCount: 1, overdueCents: 2000, paidAllTimeCents: 8000, paidThisMonthCents: 8000, dueSoonCents: 2000, agingBuckets: { current: 2000 }, vendorAging: [], recentPayments: [], recentlyPaid: [] } }));
  await page.route("**/api/vendor-invoices/work-list?*", route => { statuses.push(new URL(route.request().url()).searchParams.get("status") ?? ""); return route.fulfill({ json: workListPage([invoiceListItem(invoice())], route.request().url()) }); });
  await page.goto("/ap");
  await expect(page.getByText("Includes $20.00 in 1 disputed invoice, on hold for review.", { exact: true })).toBeVisible();
  await page.goto("/ap-invoices");
  await expect(page.getByText("AP-SAFE-71", { exact: true })).toBeVisible();
  expect(statuses.some(status => status.split(",").includes("disputed"))).toBe(true);
  expect(failures).toEqual([]);
});
