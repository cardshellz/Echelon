import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { poLineAmountCents, type PoQuantityAmendmentContext, type PoQuantityAmendmentPreview, type PoQuantityApprovalRequest, type PoQuantityPreviewRequest } from "@shared/procurement/po-quantity-amendment";
import { normalizePoLinePricing } from "@shared/utils/po-line-pricing";

const version = "a".repeat(64);
const confirmation = "I reviewed these changes and the new PO total.";
const saveAction = "Approve & save PO";
const line: PoQuantityAmendmentContext["lines"][number] = {
  id: 11, lineNumber: 1, name: "Magnetic holder with a deliberately long supplier product name to verify readable PO editing cards",
  orderQty: 12500, receivedQty: 25000, invoicedQty: 12500, unitCostMills: 5000, totalProductCostCents: 625000,
  packagingCostCents: 0, discountCents: 0, taxCents: 0, componentTotalCents: 625000, lineType: "product",
  pricing: { basis: "per_piece", quantityPieces: 12500, unitCostMills: 5000 }, lineTotalCents: 625000, status: "received", blockedReason: null,
};
type Captured = { key: string; body: PoQuantityApprovalRequest };
function previewFor(body: PoQuantityPreviewRequest, lines: PoQuantityAmendmentContext["lines"]): PoQuantityAmendmentPreview {
  const changes = body.changes.map(change => {
    const before = lines.find(value => value.id === change.lineId)!;
    let after = { ...before, orderQty: change.quantityPieces };
    if (change.priceTreatment === "edit_charge") after = { ...after, lineTotalCents: change.chargeTotalCents! };
    else {
      const normalized = normalizePoLinePricing(change.pricing ?? { basis: "extended_total", quantityPieces: change.quantityPieces, quotedTotalCents: before.totalProductCostCents });
      const packaging = change.packagingCostCents ?? before.packagingCostCents ?? 0, discount = change.discountCents ?? before.discountCents ?? 0, tax = change.taxCents ?? before.taxCents ?? 0;
      const total = poLineAmountCents(normalized.totalProductCostCents, packaging, discount, tax);
      after = { ...after, unitCostMills: normalized.unitCostMills, totalProductCostCents: normalized.totalProductCostCents,
        packagingCostCents: packaging, discountCents: discount, taxCents: tax, componentTotalCents: total, lineTotalCents: total };
    }
    return { before, after, priceTreatment: change.priceTreatment };
  });
  const sum = (values: number[]) => Number(values.reduce((total, value) => total + BigInt(value), BigInt(0)));
  return { purchaseOrderId: 17, currency: "USD", sourceVersion: body.sourceVersion, reason: body.reason, lines: changes,
    beforeTotalCents: sum(lines.map(value => value.lineTotalCents)), afterTotalCents: sum(lines.map(value => changes.find(change => change.before.id === value.id)?.after.lineTotalCents ?? value.lineTotalCents)),
    beforeStatus: "received", afterStatus: "received", warnings: ["Invoice amounts, invoice quantities and payments stay unchanged."], invoiceMatches: [] };
}
async function setup(page: Page, options: { admin?: boolean; stale?: boolean; loseAllResponses?: boolean; closeAfterLost?: boolean; lines?: PoQuantityAmendmentContext["lines"] } = {}) {
  const failures = await installFixtures(page);
  const approvals: Captured[] = []; const previews: PoQuantityPreviewRequest[] = [];
  const context: PoQuantityAmendmentContext = { purchaseOrderId: 17, currency: "USD", sourceVersion: version, canApprove: options.admin !== false, blockedReason: null, lines: options.lines ?? [line] };
  let lose = options.loseAllResponses ?? false; let committed = false; let denied = false;
  const results = new Map<string, unknown>();
  await page.route("**/api/**", async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" }, roles: ["Administrator"], permissions: ["purchasing:view", "purchasing:approve"] } });
      if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), status: options.closeAfterLost && committed ? "closed" : "received", physicalStatus: "received", financialStatus: "paid" } });
      if (path === "/api/purchase-orders/17/quantity-amendment") return route.fulfill({ json: { ...context, sourceVersion: committed ? "b".repeat(64) : version } });
      return route.fallback();
    }
    if (path === "/api/purchase-orders/17/quantity-amendment/preview") {
      const body = request.postDataJSON() as PoQuantityPreviewRequest; previews.push(body);
      if (options.stale) return route.fulfill({ status: 409, json: { error: "The receipt changed. Reload and review the correction again.", code: "PO_AMENDMENT_STALE" } });
      return route.fulfill({ json: previewFor(body, context.lines) });
    }
    if (path !== "/api/purchase-orders/17/quantity-amendment" || request.method() !== "POST") return route.fallback();
    const command = { key: request.headers()["idempotency-key"], body: request.postDataJSON() as PoQuantityApprovalRequest }; approvals.push(command);
    if (denied) return route.fulfill({ status: 403, json: { error: "Permission denied: purchasing:approve" } });
    if (!results.has(command.key)) { committed = true; results.set(command.key, { purchaseOrderId: 17, revisionNumber: 1, auditEventId: 100, preview: previewFor(command.body, context.lines) }); }
    if (lose) return route.abort("failed");
    return route.fulfill({ json: results.get(command.key), headers: { "Idempotency-Replayed": "true" } });
  });
  await page.goto("/purchase-orders/17"); await page.getByRole("button", { name: "Edit PO", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return { failures, approvals, previews, recover: () => { lose = false; }, deny: (value: boolean) => { denied = value; } };
}
async function review(page: Page, keepProductTotal = false) {
  const modal = page.getByRole("dialog"); await modal.getByLabel("Quantity (pieces)").fill("25000");
  if (keepProductTotal) { await modal.getByLabel("Price entered as").click(); await page.getByRole("option", { name: "Product total", exact: true }).click(); }
  await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier confirmed the revised PO line values");
  await modal.getByRole("button", { name: "Review changes", exact: true }).click(); await expect(modal.getByText("PO total:", { exact: false })).toBeVisible(); return modal;
}
async function save(page: Page) {
  const modal = page.getByRole("dialog"); await modal.getByLabel(confirmation).check(); await modal.getByRole("button", { name: saveAction, exact: true }).click();
  await expect(modal.getByRole("status")).toHaveText(/approved and saved as revision 1/);
}
test("admin reviews explicit pricing impact, confirms and saves with visible actions inside the modal", async ({ page }) => {
  const state = await setup(page); const modal = await review(page);
  await expect(modal.getByText(line.name, { exact: false })).toBeVisible();
  const approve = modal.getByRole("button", { name: "Approve & save PO", exact: true });
  await expect(approve).toBeDisabled(); expect(state.approvals).toHaveLength(0);
  await modal.getByLabel("I reviewed these changes and the new PO total.").check();
  await approve.scrollIntoViewIfNeeded();
  const box = await approve.boundingBox(); const bounds = await modal.boundingBox();
  expect(box && bounds && box.height >= 44 && box.x >= bounds.x && box.y >= bounds.y && box.x + box.width <= bounds.x + bounds.width + 1 && box.y + box.height <= bounds.y + bounds.height + 1).toBeTruthy();
  expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await modal.screenshot({ path: test.info().outputPath("quantity-correction-review.png") });
  await approve.click(); await expect(modal.getByRole("status")).toHaveText(/approved and saved as revision 1/);
  expect(state.previews).toHaveLength(1); expect(state.approvals).toHaveLength(1);
  expect(state.approvals[0].body).toMatchObject({ sourceVersion: version, changes: [{ lineId: 11, quantityPieces: 25000, priceTreatment: "edit_line", pricing: { basis: "per_piece", quantityPieces: 25000, unitCostMills: 5000 }, packagingCostCents: 0, discountCents: 0, taxCents: 0 }], approvalConfirmed: true });
  expect(state.approvals[0].key).toMatch(/^[a-f0-9-]{36}$/); expect(state.failures).toEqual([]);
});
test("a user without current admin approval authority receives a clear explanation and cannot submit", async ({ page }) => {
  const state = await setup(page, { admin: false });
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(/current Administrator/);
  await expect(page.getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
  expect(state.previews).toEqual([]); expect(state.approvals).toEqual([]); expect(state.failures).toEqual([]);
});
test("stale evidence requires discard and reload before approval", async ({ page }) => {
  const state = await setup(page, { stale: true }); const modal = page.getByRole("dialog");
  await modal.getByLabel("Quantity (pieces)").fill("25000"); await modal.getByLabel("Price entered as").click(); await page.getByRole("option", { name: "Product total", exact: true }).click();
  await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier confirmed the correction"); await modal.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(modal.getByRole("alert")).toHaveText(/receipt changed/); await expect(modal.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  await modal.getByRole("button", { name: "Discard review and reload PO" }).click(); await expect(modal).toHaveCount(0);
  expect(state.approvals).toEqual([]); expect(state.failures).toEqual([]);
});
for (const closeAfterLost of [false, true]) test(`lost approval responses survive reload and retry the same body and key${closeAfterLost ? " after PO closure" : ""}`, async ({ page }) => {
  const state = await setup(page, { loseAllResponses: true, closeAfterLost }); const modal = await review(page);
  await modal.getByLabel("I reviewed these changes and the new PO total.").check(); await modal.getByRole("button", { name: "Approve & save PO", exact: true }).click();
  await expect.poll(() => state.approvals.length, { timeout: 20000 }).toBe(4);
  await expect(modal.getByRole("button", { name: "Retry saved approval", exact: true })).toBeEnabled();
  const original = state.approvals[0]; expect(state.approvals.every((command) => JSON.stringify(command) === JSON.stringify(original))).toBe(true);
  state.recover(); await page.reload(); await page.getByRole("button", { name: "Edit PO", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(/approved and saved/);
  expect(state.approvals.at(-1)).toEqual(original); expect(state.previews).toHaveLength(1); expect(state.failures).toEqual([]);
});
test("permission denial before a replay preserves the unresolved approval key", async ({ page }) => {
  const state = await setup(page, { loseAllResponses: true }); const modal = await review(page);
  await modal.getByLabel("I reviewed these changes and the new PO total.").check(); await modal.getByRole("button", { name: "Approve & save PO", exact: true }).click();
  await expect.poll(() => state.approvals.length, { timeout: 20000 }).toBe(4);
  await expect(modal.getByRole("button", { name: "Retry saved approval", exact: true })).toBeEnabled();
  const original = state.approvals[0]; state.recover(); state.deny(true);
  await modal.getByRole("button", { name: "Retry saved approval", exact: true }).click(); await expect(modal.getByRole("alert")).toHaveText(/Permission denied/);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("po-quantity-amendment:test-user:17")!).key)).toBe(original.key);
  state.deny(false); await page.reload(); await page.getByRole("button", { name: "Edit PO", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(/approved and saved/); expect(state.approvals.at(-1)).toEqual(original); expect(state.failures).toEqual([]);
});

test("keeps the prefilled piece price when quantity doubles", async ({ page }) => {
  const state = await setup(page), modal = page.getByRole("dialog");
  await expect(modal.getByLabel("Quantity (pieces)")).toHaveValue("12500"); await expect(modal.getByLabel("Product price per piece (USD)")).toHaveValue("0.5000");
  await review(page); await expect(modal.getByText("PO total: 6250.00 → 12500.00 USD", { exact: true })).toBeVisible();
  await expect(modal.getByRole("row").filter({ hasText: "Product price per piece" })).toHaveText(/0\.5000.*0\.5000/); await save(page); expect(state.failures).toEqual([]);
});
test("edits price and charges without changing quantity", async ({ page }) => {
  const state = await setup(page), modal = page.getByRole("dialog");
  await modal.getByLabel("Product price per piece (USD)").fill("0.5355"); await modal.getByLabel("Packaging total (USD)").fill("100.00");
  await modal.getByLabel("Discount (USD)", { exact: true }).fill("25.00"); await modal.getByLabel("Tax (USD)", { exact: true }).fill("10.00");
  await modal.getByLabel("Reason for editing / supplier reference").fill("Correct price from the supplier document"); await modal.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(modal.getByText("PO total: 6250.00 → 6778.75 USD", { exact: true })).toBeVisible(); await save(page);
  expect(state.approvals[0].body.changes[0]).toMatchObject({ quantityPieces: 12500, pricing: { unitCostMills: 5355 }, packagingCostCents: 10000, discountCents: 2500, taxCents: 1000 }); expect(state.failures).toEqual([]);
});
test("can explicitly preserve the product total and review the resulting unit price", async ({ page }) => {
  const state = await setup(page), modal = await review(page, true);
  await expect(modal.getByText("PO total: 6250.00 → 6250.00 USD", { exact: true })).toBeVisible(); await expect(modal.getByRole("row").filter({ hasText: "Product price per piece" })).toHaveText(/0\.5000.*0\.2500/);
  await save(page); expect(state.approvals[0].body.changes[0]).toMatchObject({ pricing: { basis: "extended_total", quotedTotalCents: 625000 } }); expect(state.failures).toEqual([]);
});
test("shows inconsistent legacy components and allows an explicit reviewed override", async ({ page }) => {
  const legacy = { ...line, unitCostMills: 5023, orderQty: 25000, totalProductCostCents: 1255750, packagingCostCents: 41500, componentTotalCents: 1297250, lineTotalCents: 1338750, pricing: { basis: "per_piece" as const, quantityPieces: 25000, unitCostMills: 5023 } };
  const state = await setup(page, { lines: [legacy] }), modal = page.getByRole("dialog");
  await expect(modal.getByText(/saved line total does not equal/)).toBeVisible(); await expect(modal.getByLabel("Packaging total (USD)")).toHaveValue("415.00");
  await modal.getByLabel("Packaging total (USD)").fill("830.00"); await modal.getByLabel("Reason for editing / supplier reference").fill("Explicit supplier packaging amount reviewed");
  await modal.getByRole("button", { name: "Review changes", exact: true }).click(); await expect(modal.getByText("PO total: 13387.50 → 13387.50 USD", { exact: true })).toBeVisible();
  await save(page); expect(state.approvals[0].body.changes[0].packagingCostCents).toBe(83000); expect(state.failures).toEqual([]);
});
test("edits a credit through one signed amount field", async ({ page }) => {
  const credit = { ...line, id: 12, lineNumber: 2, name: "Supplier discount", lineType: "discount" as const, orderQty: 1, receivedQty: 0, invoicedQty: 0, unitCostMills: -10000, totalProductCostCents: 0, componentTotalCents: -100, lineTotalCents: -100, pricing: null };
  const state = await setup(page, { lines: [line, credit] }), modal = page.getByRole("dialog");
  await modal.getByLabel("Charge / credit total (USD)").fill("-2.50"); await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier confirmed the discount amount");
  await modal.getByRole("button", { name: "Review changes", exact: true }).click(); await expect(modal.getByText("PO total: 6249.00 → 6247.50 USD", { exact: true })).toBeVisible();
  await save(page); expect(state.approvals[0].body.changes).toEqual([{ lineId: 12, quantityPieces: 1, priceTreatment: "edit_charge", chargeTotalCents: -250 }]); expect(state.failures).toEqual([]);
});
test("rejects fractional quantities and fractional cents before submission", async ({ page }) => {
  const state = await setup(page), modal = page.getByRole("dialog"); await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier reference for the requested edit");
  await modal.getByLabel("Quantity (pieces)").fill("1.5"); await modal.getByRole("button", { name: "Review changes", exact: true }).click(); await expect(modal.getByRole("alert")).toHaveText(/whole-piece quantity/);
  await modal.getByLabel("Quantity (pieces)").fill("25000"); await modal.getByLabel("Packaging total (USD)").fill("1.001"); await modal.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(modal.getByRole("alert")).toBeVisible(); expect(state.previews).toEqual([]); expect(state.approvals).toEqual([]); expect(state.failures).toEqual([]);
});
test("short viewports keep the save button inside the modal while content scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 450 }); const state = await setup(page); await review(page);
  const modal = page.getByRole("dialog"), action = modal.getByRole("button", { name: saveAction, exact: true });
  const box = await action.boundingBox(), bounds = await modal.boundingBox(); expect(box && bounds && box.y >= bounds.y && box.y + box.height <= bounds.y + bounds.height + 1 && box.y + box.height <= 450).toBeTruthy(); expect(state.failures).toEqual([]);
});
test("saved legacy quantity approval receipts remain recoverable", async ({ page }) => {
  const state = await setup(page);
  const body: PoQuantityApprovalRequest = { sourceVersion: version, changes: [{ lineId: 11, quantityPieces: 25000, priceTreatment: "keep_product_total" }], reason: "Legacy quantity correction awaiting a safe retry", approvalConfirmed: true };
  const preview = previewFor(body, [line]);
  for (const view of [preview.lines[0].before, preview.lines[0].after]) for (const key of ["packagingCostCents", "discountCents", "taxCents", "lineType", "pricing", "componentTotalCents"] as const) delete view[key];
  await page.evaluate(intent => sessionStorage.setItem("po-quantity-amendment:test-user:17", JSON.stringify(intent)), { key: "a164bb89-79b0-46e5-a912-0c4506a59733", body, preview });
  await page.reload(); await page.getByRole("button", { name: "Edit PO", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(/approved and saved/); expect(state.approvals[0].body).toEqual(body); expect(state.failures).toEqual([]);
});

test("reverted fields are omitted when another line is edited", async ({ page }) => {
  const second = { ...line, id: 12, lineNumber: 2, name: "Second product" };
  const state = await setup(page, { lines: [line, second] }), modal = page.getByRole("dialog");
  await modal.locator("#correct-quantity-11").fill("25000"); await modal.locator("#correct-quantity-11").fill("12500");
  await modal.locator("#correct-price-12").fill("0.6000");
  await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier confirmed the second product price");
  await modal.getByRole("button", { name: "Review changes", exact: true }).click(); await save(page);
  expect(state.approvals[0].body.changes.map(change => change.lineId)).toEqual([12]); expect(state.failures).toEqual([]);
});
test("missing current price fields block new edits instead of inventing defaults", async ({ page }) => {
  const incomplete = { ...line }; delete incomplete.packagingCostCents;
  const state = await setup(page, { lines: [incomplete] });
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText(/Current line pricing could not be loaded/);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
  expect(state.previews).toEqual([]); expect(state.approvals).toEqual([]); expect(state.failures).toEqual([]);
});
