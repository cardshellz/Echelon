import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { PoQuantityAmendmentContext, PoQuantityAmendmentPreview, PoQuantityApprovalRequest } from "@shared/procurement/po-quantity-amendment";

const version = "a".repeat(64);
const line = { id: 11, lineNumber: 1, name: "Magnetic holder with a deliberately long supplier product name to verify readable quantity correction cards", orderQty: 12500, receivedQty: 25000, invoicedQty: 12500, unitCostMills: 5000, totalProductCostCents: 625000, lineTotalCents: 625000, status: "received", blockedReason: null };
type Captured = { key: string; body: PoQuantityApprovalRequest };
async function setup(page: Page, options: { admin?: boolean; stale?: boolean; loseAllResponses?: boolean; closeAfterLost?: boolean } = {}) {
  const failures = await installFixtures(page);
  const approvals: Captured[] = []; const previews: unknown[] = [];
  const context: PoQuantityAmendmentContext = { purchaseOrderId: 17, currency: "USD", sourceVersion: version, canApprove: options.admin !== false, blockedReason: null, lines: [line] };
  let lose = options.loseAllResponses ?? false; let committed = false; let denied = false;
  const results = new Map<string, unknown>();
  await page.route("**/api/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" }, roles: ["Administrator"], permissions: ["purchasing:view", "purchasing:approve"] } });
      if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), status: options.closeAfterLost && committed ? "closed" : "received", physicalStatus: "received", financialStatus: "paid" } });
      if (path === "/api/purchase-orders/17/quantity-amendment") return route.fulfill({ json: { ...context, sourceVersion: committed ? "b".repeat(64) : version } });
      return route.fallback();
    }
    if (path === "/api/purchase-orders/17/quantity-amendment/preview") {
      const body = request.postDataJSON(); previews.push(body);
      if (options.stale) return route.fulfill({ status: 409, json: { error: "The receipt changed. Reload and review the correction again.", code: "PO_AMENDMENT_STALE" } });
      const preview: PoQuantityAmendmentPreview = { purchaseOrderId: 17, currency: "USD", sourceVersion: version, reason: body.reason,
        lines: [{ before: line, after: { ...line, orderQty: 25000, unitCostMills: 2500 }, priceTreatment: "keep_product_total" }],
        beforeTotalCents: 625000, afterTotalCents: 625000, beforeStatus: "received", afterStatus: "received",
        warnings: ["Invoice amounts, invoice quantities and payments stay unchanged. Remaining match issues require separate review."], invoiceMatches: [{ invoiceId: 71, invoiceLineId: 81, before: "qty_discrepancy", after: "price_discrepancy" }] };
      return route.fulfill({ json: preview });
    }
    if (path !== "/api/purchase-orders/17/quantity-amendment" || request.method() !== "POST") return route.fallback();
    const command = { key: request.headers()["idempotency-key"], body: request.postDataJSON() as PoQuantityApprovalRequest }; approvals.push(command);
    if (denied) return route.fulfill({ status: 403, json: { error: "Permission denied: purchasing:approve" } });
    if (!results.has(command.key)) { committed = true; results.set(command.key, { purchaseOrderId: 17, revisionNumber: 1, auditEventId: 100, preview: { purchaseOrderId: 17, currency: "USD", sourceVersion: version, reason: command.body.reason, lines: [{ before: line, after: { ...line, orderQty: 25000, unitCostMills: 2500 }, priceTreatment: "keep_product_total" }], beforeTotalCents: 625000, afterTotalCents: 625000, beforeStatus: "received", afterStatus: "received", warnings: [], invoiceMatches: [] } }); }
    if (lose) return route.abort("failed");
    return route.fulfill({ json: results.get(command.key), headers: { "Idempotency-Replayed": "true" } });
  });
  await page.goto("/purchase-orders/17");
  await page.getByRole("button", { name: "Correct quantities", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return { failures, approvals, previews, recover: () => { lose = false; }, deny: (value: boolean) => { denied = value; } };
}
async function review(page: Page) {
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Corrected quantity (pieces)").fill("25000");
  await modal.getByLabel("Price treatment").click();
  await page.getByRole("option", { name: "Keep product amount", exact: true }).click();
  await modal.getByLabel("Correction reason / supplier reference").fill("Supplier confirmed the purchased quantity correction");
  await modal.getByRole("button", { name: "Review correction", exact: true }).click();
  await expect(modal.getByText("PO total:", { exact: false })).toBeVisible();
  return modal;
}
test("admin reviews explicit pricing impact, confirms and saves with visible actions inside the modal", async ({ page }) => {
  const state = await setup(page); const modal = await review(page);
  await expect(modal.getByText(line.name, { exact: false })).toBeVisible();
  const approve = modal.getByRole("button", { name: "Approve & apply correction", exact: true });
  await expect(approve).toBeDisabled(); expect(state.approvals).toHaveLength(0);
  await modal.getByLabel("I reviewed the corrected quantities, price treatment and remaining invoice issues.").check();
  await approve.scrollIntoViewIfNeeded();
  const box = await approve.boundingBox(); const bounds = await modal.boundingBox();
  expect(box && bounds && box.x >= bounds.x && box.x + box.width <= bounds.x + bounds.width + 1).toBeTruthy();
  expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await modal.screenshot({ path: test.info().outputPath("quantity-correction-review.png") });
  await approve.click(); await expect(modal.getByRole("status")).toHaveText(/approved and saved as revision 1/);
  expect(state.previews).toHaveLength(1); expect(state.approvals).toHaveLength(1);
  expect(state.approvals[0].body).toMatchObject({ sourceVersion: version, changes: [{ lineId: 11, quantityPieces: 25000, priceTreatment: "keep_product_total" }], approvalConfirmed: true });
  expect(state.approvals[0].key).toMatch(/^[a-f0-9-]{36}$/); expect(state.failures).toEqual([]);
});
test("a user without current admin approval authority receives a clear explanation and cannot submit", async ({ page }) => {
  const state = await setup(page, { admin: false });
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(/current Administrator/);
  await expect(page.getByRole("button", { name: "Review correction", exact: true })).toHaveCount(0);
  expect(state.previews).toEqual([]); expect(state.approvals).toEqual([]); expect(state.failures).toEqual([]);
});
test("stale evidence requires discard and reload before approval", async ({ page }) => {
  const state = await setup(page, { stale: true }); const modal = page.getByRole("dialog");
  await modal.getByLabel("Corrected quantity (pieces)").fill("25000"); await modal.getByLabel("Price treatment").click(); await page.getByRole("option", { name: "Keep product amount", exact: true }).click();
  await modal.getByLabel("Correction reason / supplier reference").fill("Supplier confirmed the correction"); await modal.getByRole("button", { name: "Review correction", exact: true }).click();
  await expect(modal.getByRole("alert")).toHaveText(/receipt changed/); await expect(modal.getByRole("button", { name: "Review correction", exact: true })).toBeDisabled();
  await modal.getByRole("button", { name: "Discard review and reload PO" }).click(); await expect(modal).toHaveCount(0);
  expect(state.approvals).toEqual([]); expect(state.failures).toEqual([]);
});
for (const closeAfterLost of [false, true]) test(`lost approval responses survive reload and retry the same body and key${closeAfterLost ? " after PO closure" : ""}`, async ({ page }) => {
  const state = await setup(page, { loseAllResponses: true, closeAfterLost }); const modal = await review(page);
  await modal.getByLabel("I reviewed the corrected quantities, price treatment and remaining invoice issues.").check(); await modal.getByRole("button", { name: "Approve & apply correction", exact: true }).click();
  await expect.poll(() => state.approvals.length, { timeout: 20000 }).toBe(4);
  await expect(modal.getByRole("button", { name: "Retry saved approval", exact: true })).toBeEnabled();
  const original = state.approvals[0]; expect(state.approvals.every((command) => JSON.stringify(command) === JSON.stringify(original))).toBe(true);
  state.recover(); await page.reload(); await page.getByRole("button", { name: "Correct quantities", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(/approved and saved/);
  expect(state.approvals.at(-1)).toEqual(original); expect(state.previews).toHaveLength(1); expect(state.failures).toEqual([]);
});
test("permission denial before a replay preserves the unresolved approval key", async ({ page }) => {
  const state = await setup(page, { loseAllResponses: true }); const modal = await review(page);
  await modal.getByLabel("I reviewed the corrected quantities, price treatment and remaining invoice issues.").check(); await modal.getByRole("button", { name: "Approve & apply correction", exact: true }).click();
  await expect.poll(() => state.approvals.length, { timeout: 20000 }).toBe(4);
  await expect(modal.getByRole("button", { name: "Retry saved approval", exact: true })).toBeEnabled();
  const original = state.approvals[0]; state.recover(); state.deny(true);
  await modal.getByRole("button", { name: "Retry saved approval", exact: true }).click(); await expect(modal.getByRole("alert")).toHaveText(/Permission denied/);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("po-quantity-amendment:test-user:17")!).key)).toBe(original.key);
  state.deny(false); await page.reload(); await page.getByRole("button", { name: "Correct quantities", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(/approved and saved/); expect(state.approvals.at(-1)).toEqual(original); expect(state.failures).toEqual([]);
});
