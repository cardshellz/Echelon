import { test, expect, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";
import { invoiceSourceFixture } from "../fixtures/invoice-source";
import type { ApInvoiceTransitionPreview, ApInvoiceTransitionReceipt } from "../../shared/procurement/ap-invoice-transition";

async function setup(page: Page, options: { lost?: boolean; stale?: boolean; allowed?: boolean } = {}) {
  const failures = await installFixtures(page, { permissions: ["purchasing:view", ...(options.allowed === false ? [] : ["purchasing:approve"])] });
  const invoice = { id: 71, invoiceNumber: "REVIEW-71", vendorId: 2, vendorName: "Test supplier", currency: "USD", status: "received",
    invoicedAmountCents: 12000, paidAmountCents: 0, creditedAmountCents: 0, balanceCents: 12000, hasSupplierCreditHistory: false,
    sourceCapabilities: invoiceSourceFixture("ordinary"), lines: [], poLinks: [], payments: [], attachments: [] };
  const history: ApInvoiceTransitionReceipt[] = [], requests: Array<{ key: string; body: unknown }> = [];
  let lost = options.lost ?? false, stale = options.stale ?? false, previewCount = 0;
  let preview: ApInvoiceTransitionPreview;
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: invoice }));
  await page.route("**/api/vendor-invoices/71/transition-history", route => route.fulfill({ json: history }));
  await page.route("**/api/vendor-invoices/71/approve/preview", route => {
    preview = { invoiceId: 71, action: "approve", reason: route.request().postDataJSON().reason.trim(), previewVersion: (++previewCount === 1 ? "a" : "b").repeat(64),
      before: { status: "received", currency: "USD", amountCents: 12000, paidCents: 0, balanceCents: 12000, approvedBy: null, approvedAt: null },
      after: { status: "approved", currency: "USD", amountCents: 12000, paidCents: 0, balanceCents: 12000, approvedBy: "reviewer", approvedAt: "2026-11-03T12:00:00.000Z" },
      impact: { lots: [], orderCosts: [], historicalCosts: [] }, inventoryValues: [{ lotId: 1, lotNumber: "TEST-LOT", onHandUnits: 2, beforeMills: 1000000, afterMills: 1200000, reviewReason: null }], costReviews: [] };
    return route.fulfill({ json: preview });
  });
  const receipts = new Map<string, ApInvoiceTransitionReceipt>();
  await page.route("**/api/vendor-invoices/71/approve", route => {
    const key = route.request().headers()["idempotency-key"], body = route.request().postDataJSON(); requests.push({ key, body });
    if (stale) { stale = false; return route.fulfill({ status: 409, json: { error: "The invoice changed. Review it again.", details: { code: "AP_INVOICE_TRANSITION_STALE" } } }); }
    if (!receipts.has(key)) { const receipt = { preview, actorId: "reviewer", actorName: "Purchasing approver", approvedAt: "2026-11-03T12:00:00.000Z" }; receipts.set(key, receipt); history.push(receipt); invoice.status = "approved"; }
    if (lost) { lost = false; return route.abort("connectionreset"); }
    return route.fulfill({ json: { id: 71, transitionReview: receipts.get(key) } });
  });
  await page.goto("/ap-invoices/71?tab=lines");
  return { failures, requests, history };
}

test("invoice approval reviews the exact impact and retains a readable history", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Approve", exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  const row = dialog.getByRole("row", { name: /TEST-LOT/ }); await expect(row).toContainText("100.0000 USD"); await expect(row).toContainText("120.0000 USD");
  expect(state.requests).toEqual([]);
  await dialog.getByRole("button", { name: "Approve invoice", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved by Purchasing approver");
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(page.getByRole("region", { name: "Invoice approval history", exact: true })).toContainText("Purchasing approver");
  expect(state.history).toHaveLength(1); expect(state.failures).toEqual([]);
});
test("a lost response retries the same reviewed approval and keeps one retained posting", async ({ page }) => {
  const state = await setup(page, { lost: true });
  await page.getByRole("button", { name: "Approve", exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Approve invoice", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved by");
  expect(state.requests.length).toBeGreaterThan(1); expect(new Set(state.requests.map(request => request.key)).size).toBe(1);
  expect(state.requests.every(request => JSON.stringify(request.body) === JSON.stringify(state.requests[0].body))).toBe(true);
  expect(state.history).toHaveLength(1); expect(state.failures).toEqual([]);
});
test("a stale impact requires a fresh preview before another approval", async ({ page }) => {
  const state = await setup(page, { stale: true });
  await page.getByRole("button", { name: "Approve", exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Approve invoice", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Review it again");
  await expect(dialog.getByRole("button", { name: "Approve invoice", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Review again", exact: true }).click();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByRole("button", { name: "Approve invoice", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved by");
  expect(state.requests).toHaveLength(2); expect(state.requests[1].key).not.toEqual(state.requests[0].key);
  expect(state.history).toHaveLength(1); expect(state.failures).toEqual([]);
});
test("view permission does not expose an invoice approval action", async ({ page }) => {
  const state = await setup(page, { allowed: false });
  await expect(page.getByRole("heading", { name: "Invoice #REVIEW-71" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  expect(state.requests).toEqual([]); expect(state.failures).toEqual([]);
});
