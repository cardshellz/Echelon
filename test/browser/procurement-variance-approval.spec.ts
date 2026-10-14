import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { expectFinancialRetryBoundaries, installFinancialRetryClock } from "./procurement-retry-clock";
import type { PoVarianceContext } from "../../shared/procurement/po-variance-approval";
async function setup(page: Page, options: { admin?: boolean; lost?: boolean; stale?: boolean } = {}) {
  const failures = await installFixtures(page), commands: { key: string; body: unknown }[] = [];
  const sourceVersion = "a".repeat(64), sourceFingerprint = "b".repeat(64);
  let resolved = false, lose = options.lost === true;
  const context: PoVarianceContext = { exceptionId: 81, purchaseOrderId: 17, invoiceId: 71, invoiceNumber: "TEST-INV-71", currency: "USD", sourceVersion, sourceFingerprint,
    canApprove: options.admin !== false, blockedReason: null,
    issues: [{ lineId: 72, lineNumber: 1, name: "Synthetic product", invoiceQuantity: 12500, orderedQuantity: 25000, receivedQuantity: 25000,
      invoiceUnitCostMills: 5355, poUnitCostMills: 5000, invoiceLineAmountCents: 669375, status: "qty_discrepancy" }] };
  const results = new Map<string, unknown>();
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" }, roles: ["Administrator"], permissions: ["purchasing:view", "purchasing:approve"] } });
    if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), status: "received", physicalStatus: "received", financialStatus: "paid" } });
    if (path === "/api/purchase-orders/17/exceptions") return route.fulfill({ json: { exceptions: resolved && !url.searchParams.has("includeResolved") ? [] : [
      { id: 81, poId: 17, kind: "match_mismatch", severity: "warn", status: resolved ? "resolved" : "open", title: "Current invoice quantity mismatch", payload: { invoiceId: 71 }, resolutionNote: resolved ? "Supplier variance reviewed by admin" : null }
    ] } });
    if (path !== "/api/po-exceptions/81/variance-approval") return route.fallback();
    if (req.method() === "GET") return resolved ? route.fulfill({ status: 409, json: { error: "Already resolved", code: "PO_VARIANCE_STATE_INVALID" } }) : route.fulfill({ json: context });
    const key = req.headers()["idempotency-key"], body = req.postDataJSON(); commands.push({ key, body });
    if (options.stale) return route.fulfill({ status: 409, json: { error: "The invoice changed. Reload and review this variance.", code: "PO_VARIANCE_STALE" } });
    if (!results.has(key)) { resolved = true; results.set(key, { exceptionId: 81, auditEventId: 901, context }); }
    if (lose) return route.abort("connectionreset");
    return route.fulfill({ json: results.get(key) });
  });
  await page.goto("/purchase-orders/17?tab=exceptions");
  await page.getByRole("button", { name: "Accept current variance", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("table", { name: "Current invoice variance" })).toBeVisible();
  return { failures, commands, recover: () => { lose = false; } };
}
async function approve(page: Page) {
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Why is this variance acceptable?").fill("Supplier variance reviewed by Administrator");
  await modal.getByLabel("I reviewed these values and approve accepting this variance.").check();
  await modal.getByRole("button", { name: "Approve variance", exact: true }).click();
}
test("shows current quantities and prices before a reasoned admin approval", async ({ page }) => {
  const state = await setup(page), modal = page.getByRole("dialog");
  await expect(modal.getByRole("table")).toContainText("12,500"); await expect(modal.getByRole("table")).toContainText("25,000 / 25,000");
  await expect(modal.getByRole("button", { name: "Approve variance", exact: true })).toBeDisabled();
  await approve(page); await expect(page.getByText("Invoice variance approved", { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(1); expect(state.commands[0]).toMatchObject({ body: { approvalConfirmed: true, sourceVersion: "a".repeat(64) } });
  expect(state.commands[0].key).toMatch(/^[a-f0-9-]{36}$/); expect(state.failures).toEqual([]);
});
test("keeps review available but blocks users without admin authority", async ({ page }) => {
  const state = await setup(page, { admin: false });
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("An Administrator");
  await expect(page.getByRole("button", { name: "Approve variance", exact: true })).toBeDisabled(); expect(state.commands).toEqual([]); expect(state.failures).toEqual([]);
});
test("retains the exact saved approval after reload when acceptance already committed", async ({ page }) => {
  await installFinancialRetryClock(page);
  const state = await setup(page, { lost: true });
  await expectFinancialRetryBoundaries(page, () => approve(page), () => state.commands.length);
  state.recover(); await page.reload();
  await page.getByRole("button", { name: "Verify saved variance approval", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Retry saved confirmation", exact: true }).click();
  await expect(page.getByText("Invoice variance approved", { exact: true })).toBeVisible();
  expect(state.commands.at(-1)).toEqual(state.commands[0]); expect(state.failures).toEqual([]);
});
test("a stale review cannot accept a changed variance", async ({ page }) => {
  const state = await setup(page, { stale: true }); await approve(page);
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Reload and review");
  await expect(page.getByRole("button", { name: "Approve variance", exact: true })).toBeDisabled(); expect(state.commands).toHaveLength(1); expect(state.failures).toEqual([]);
});
