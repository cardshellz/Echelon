import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { expectFinancialRetryBoundaries, installFinancialRetryClock } from "./procurement-retry-clock";
import { poLineAmountCents, type PoQuantityAmendmentContext, type PoQuantityAmendmentPreview, type PoQuantityAmendmentResult, type PoQuantityApprovalRequest, type PoQuantityPreviewRequest } from "@shared/procurement/po-quantity-amendment";
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
    // Each preview owns its snapshots; legacy receipt tests intentionally omit
    // new fields without changing the current fixture or later tests.
    const before = structuredClone(lines.find(value => value.id === change.lineId)!);
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
    previewVersion: "c".repeat(64),
    impact: { quantities: changes.filter(line => line.before.lineType === "product").map(({before,after}) => ({ lineId: before.id, name: before.name,
      ordered: { before: before.orderQty, after: after.orderQty }, received: before.receivedQty, shipped: before.receivedQty, invoiced: before.invoicedQty,
      shipmentCapacityReview: null,
      remainingToReceive: {before: Math.max(0,before.orderQty-before.receivedQty),after: Math.max(0,after.orderQty-before.receivedQty)},
      remainingToShip: {before: Math.max(0,before.orderQty-before.receivedQty),after: Math.max(0,after.orderQty-before.receivedQty)},
      remainingToInvoice: {before: Math.max(0,before.orderQty-before.invoicedQty),after: Math.max(0,after.orderQty-before.invoicedQty)} })),
      shipments: [], lots: [], orderCosts: [], historicalCosts: [], applications: [] },
    beforeStatus: "received", afterStatus: "received", warnings: ["Invoice amounts, invoice quantities and payments stay unchanged."], invoiceMatches: [] };
}
async function setup(page: Page, options: { admin?: boolean; stale?: boolean; loseAllResponses?: boolean; closeAfterLost?: boolean; lines?: PoQuantityAmendmentContext["lines"]; request?: string; openModal?: boolean; wrongContext?: boolean; measuredCosts?: boolean; returnedValue?: "increase" | "decrease" } = {}) {
  const failures = await installFixtures(page);
  const approvals: Captured[] = []; const previews: PoQuantityPreviewRequest[] = [];
  const context: PoQuantityAmendmentContext = { purchaseOrderId: options.wrongContext ? 99 : 17, currency: "USD", sourceVersion: version, canApprove: options.admin !== false, blockedReason: null, lines: options.lines ?? [line] };
  let lose = options.loseAllResponses ?? false; let committed = false; let denied = false;
  const results = new Map<string, PoQuantityAmendmentResult>();
  const reads: string[] = [];
  const makePreview = (body: PoQuantityPreviewRequest) => {
    const preview = previewFor(body, context.lines);
    if (options.measuredCosts) {
      preview.impact!.shipments = [{ shipmentId: 88, shipmentNumber: "SHIP-88", status: "closed", chargeCents: 5000,
        lines: [{ lineId: 91, purchaseOrderId: 17, name: "Product", shippedPieces: 25000,
          allocatedCents: { before: 5000, after: 5000 }, landedTotalCents: { before: 630000, after: 1255000 } }] }];
      preview.impact!.lots = [{ lotId: 101, lotNumber: "LOT-101", onHandUnits: 10, unitCostMills: { before: 5000, after: 10000 } }];
      preview.impact!.orderCosts = [{ costId: 201, orderId: 301, quantity: 2, totalMills: { before: 10000, after: 20000 } }];
      preview.impact!.applications = [{ purchaseOrderLineId: 11, shipmentId: null, component: "product", status: "review_required",
        lotsUpdated: 1, orderCostsUpdated: 1, orderCostDeltaCents: 100,
        issues: [{ code: "TEST_MISSING_EVIDENCE", message: "Supplier packaging amount requires confirmation." }] }];
    }
    if (options.returnedValue) {
      const beforeMills = options.returnedValue === "increase" ? 10001 : 20002;
      const afterMills = options.returnedValue === "increase" ? 20002 : 10001;
      preview.impact!.applications.push({ purchaseOrderLineId: 11, shipmentId: null, component: "product", status: "applied",
        lotsUpdated: 0, orderCostsUpdated: 0, orderCostDeltaCents: 0, issues: [],
        returnedCosts: [{ returnId: 9, returnLineId: 91, returnAllocationId: 191, costQuantityAllocationId: 391,
          inventoryLotId: 501, quantity: 2, component: "product", beforeMills, afterMills, deltaMills: afterMills - beforeMills }],
        returnedCostDeltaMills: afterMills - beforeMills });
    }
    return preview;
  };
  await page.route("**/api/**", async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      reads.push(path);
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" }, roles: ["Administrator"], permissions: ["purchasing:view", "purchasing:approve"] } });
      if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), status: options.closeAfterLost && committed ? "closed" : "received", physicalStatus: "received", financialStatus: "paid" } });
      if (path === "/api/purchase-orders/17/quantity-amendment") return route.fulfill({ json: { ...context, sourceVersion: committed ? "b".repeat(64) : version } });
      if (path === "/api/purchase-orders/17/quantity-amendment/history") return route.fulfill({ json: {
        entries: [...results.values()].map(result => ({ id: result.auditEventId, actorId: "test-user", actorName: "Approving Admin",
          approvedAt: "2026-10-19T12:00:00.000Z", revisionNumber: result.revisionNumber, preview: result.preview })), nextCursor: null,
      } });
      return route.fallback();
    }
    if (path === "/api/purchase-orders/17/quantity-amendment/preview") {
      const body = request.postDataJSON() as PoQuantityPreviewRequest; previews.push(body);
      if (options.stale) return route.fulfill({ status: 409, json: { error: "The receipt changed. Reload and review the correction again.", code: "PO_AMENDMENT_STALE" } });
      return route.fulfill({ json: makePreview(body) });
    }
    if (path !== "/api/purchase-orders/17/quantity-amendment" || request.method() !== "POST") return route.fallback();
    const command = { key: request.headers()["idempotency-key"], body: request.postDataJSON() as PoQuantityApprovalRequest }; approvals.push(command);
    if (denied) return route.fulfill({ status: 403, json: { error: "Permission denied: purchasing:approve" } });
    if (!results.has(command.key)) {
      committed = true;
      const preview = makePreview(command.body);
      // An already committed legacy command replays its original result shape.
      if (!command.body.previewVersion) { delete preview.previewVersion; delete preview.impact; }
      results.set(command.key, { purchaseOrderId: 17, revisionNumber: 1, auditEventId: 100, preview });
    }
    if (lose) return route.abort("failed");
    return route.fulfill({ json: results.get(command.key), headers: { "Idempotency-Replayed": "true" } });
  });
  await page.goto(`/purchase-orders/17${options.request ? `?tab=lines&${options.request}` : ""}`);
  if (options.openModal !== false) {
    await page.getByRole("button", { name: "Edit PO", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  }
  return { failures, approvals, previews, reads, recover: () => { lose = false; }, deny: (value: boolean) => { denied = value; } };
}
async function review(page: Page, keepProductTotal = false) {
  const modal = page.getByRole("dialog"); await modal.getByLabel("Quantity (pieces)").fill("25000");
  if (keepProductTotal) { await modal.getByRole("button", { name: "Pricing options for line 1" }).click(); await page.getByLabel("Price entered as").click(); await page.getByRole("option", { name: "Product total", exact: true }).click(); await page.keyboard.press("Escape"); }
  await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier confirmed the revised PO line values");
  await modal.getByRole("button", { name: "Review changes", exact: true }).click(); await expect(modal.getByText("PO total:", { exact: false })).toBeVisible(); return modal;
}
async function save(page: Page) {
  const modal = page.getByRole("dialog"); await modal.getByLabel(confirmation).check(); await modal.getByRole("button", { name: saveAction, exact: true }).click();
  await expect(modal.getByRole("status")).toHaveText(/approved and saved as revision 1/);
}
test("admin reviews explicit pricing impact, confirms and saves with visible actions inside the modal", async ({ page }) => {
  const state = await setup(page); const modal = await review(page);
  await expect(modal.getByText(line.name, { exact: false }).first()).toBeVisible();
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

test("approved dependency impact remains visible in history and connected reads refresh", async ({ page }) => {
  const state = await setup(page, { measuredCosts: true }), modal = await review(page);
  const impact = modal.getByRole("region", { name: "Dependent quantity and cost changes" });
  await expect(impact.getByText("Actual quantities: 25,000 received · 25,000 shipped · 12,500 invoiced")).toBeVisible();
  await impact.locator("summary").filter({ hasText: "Inventory and sold-cost changes" }).click();
  await expect(impact.getByRole("row").filter({ hasText: "LOT-101" })).toHaveText(/0.5000 USD.*1.0000 USD/);
  await expect(impact.getByRole("row").filter({ hasText: "Order #301" })).toHaveText(/1.0000 USD.*2.0000 USD/);
  await expect(impact.getByText("Supplier packaging amount requires confirmation.")).toBeVisible();
  await expect(impact.getByRole("link", { name: "Open cost review" })).toHaveAttribute("href", /purchase-orders\/17\?.*costReview=1/);
  const readsBeforeSave = state.reads.filter(path => path === "/api/purchase-orders/17").length;
  await save(page);
  await expect.poll(() => state.reads.filter(path => path === "/api/purchase-orders/17").length).toBeGreaterThan(readsBeforeSave);
  expect(state.approvals[0].body.previewVersion).toBe("c".repeat(64));
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Approved PO edits" });
  await history.locator("summary").filter({ hasText: "Revision 1 · approved by Approving Admin" }).click();
  await expect(history.getByRole("region", { name: "Dependent quantity and cost changes" })).toBeVisible();
  await expect(history.getByText("Supplier confirmed the revised PO line values")).toBeVisible();
  await expect(history.getByText("Cost work recorded at approval", { exact: true })).toBeVisible();
  await expect(history.getByText("These issues were recorded with this approval. Open the current cost review to see what remains outstanding.")).toBeVisible();
  await expect(history.getByRole("table", { name: "PO change summary" }).getByRole("columnheader", { name: "Before", exact: true })).toBeVisible();
  const historyBounds = await history.boundingBox();
  expect(historyBounds && historyBounds.x >= 0 && historyBounds.x + historyBounds.width <= page.viewportSize()!.width).toBeTruthy();
  await history.screenshot({ path: test.info().outputPath("po-edit-approval-history.png") });
  expect(state.failures).toEqual([]);
});
test("stale evidence requires discard and reload before approval", async ({ page }) => {
  const state = await setup(page, { stale: true }); const modal = page.getByRole("dialog");
  await modal.getByLabel("Quantity (pieces)").fill("25000"); await modal.getByRole("button", { name: "Pricing options for line 1" }).click(); await page.getByLabel("Price entered as").click(); await page.getByRole("option", { name: "Product total", exact: true }).click(); await page.keyboard.press("Escape");
  await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier confirmed the correction"); await modal.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(modal.getByRole("alert")).toHaveText(/receipt changed/); await expect(modal.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  await modal.getByRole("button", { name: "Discard review and reload PO" }).click(); await expect(modal).toHaveCount(0);
  expect(state.approvals).toEqual([]); expect(state.failures).toEqual([]);
});
for (const closeAfterLost of [false, true]) test(`lost approval responses survive reload and retry the same body and key${closeAfterLost ? " after PO closure" : ""}`, async ({ page }) => {
  await installFinancialRetryClock(page);
  const state = await setup(page, { loseAllResponses: true, closeAfterLost }); const modal = await review(page);
  await modal.getByLabel("I reviewed these changes and the new PO total.").check();
  await expectFinancialRetryBoundaries(page,
    () => modal.getByRole("button", { name: "Approve & save PO", exact: true }).click(),
    () => state.approvals.length);
  await expect(modal.getByRole("button", { name: "Retry saved approval", exact: true })).toBeEnabled();
  const original = state.approvals[0]; expect(state.approvals.every((command) => JSON.stringify(command) === JSON.stringify(original))).toBe(true);
  state.recover(); await page.reload(); await page.getByRole("button", { name: "Edit PO", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText(/approved and saved/);
  expect(state.approvals.at(-1)).toEqual(original); expect(state.previews).toHaveLength(1); expect(state.failures).toEqual([]);
});
test("permission denial before a replay preserves the unresolved approval key", async ({ page }) => {
  await installFinancialRetryClock(page);
  const state = await setup(page, { loseAllResponses: true }); const modal = await review(page);
  await modal.getByLabel("I reviewed these changes and the new PO total.").check();
  await expectFinancialRetryBoundaries(page,
    () => modal.getByRole("button", { name: "Approve & save PO", exact: true }).click(),
    () => state.approvals.length);
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
  await expect(modal.getByRole("row").filter({ hasText: "Product price per piece" })).toHaveCount(0); await save(page); expect(state.failures).toEqual([]);
});
test("edits price and charges without changing quantity", async ({ page }) => {
  const state = await setup(page), modal = page.getByRole("dialog");
  await modal.getByLabel("Product price per piece (USD)").fill("0.5355"); await modal.getByLabel("Packaging total (USD)").fill("100.00");
  await modal.getByRole("button", { name: "Tax and discount for line 1" }).click();
  await page.getByLabel("Discount (USD)", { exact: true }).fill("25.00"); await page.getByLabel("Tax (USD)", { exact: true }).fill("10.00"); await page.keyboard.press("Escape");
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
  await page.setViewportSize({ width: 800, height: 450 }); const state = await setup(page);
  await expect(page.getByLabel("Reason for editing / supplier reference")).toBeInViewport({ ratio: 1 });
  await review(page);
  await expect(page.getByLabel(confirmation)).toBeInViewport({ ratio: 1 });
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


for (const request of ["editPo=0", "editPo=1&editPo=1", "editPo=1&editPo=0"]) test(`ignores malformed or duplicate PO editor requests: ${request}`, async ({ page }) => {
  const state = await setup(page, { request, openModal: false });
  await expect(page.getByRole("button", { name: "Edit PO", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.approvals).toEqual([]); expect(state.previews).toEqual([]); expect(state.failures).toEqual([]);
});


test("rejects a context for another PO before exposing editable values", async ({ page }) => {
  const state = await setup(page, { wrongContext: true });
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("does not match this PO");
  await expect(page.getByRole("dialog").getByLabel("Quantity (pieces)")).toHaveCount(0);
  expect(state.approvals).toEqual([]); expect(state.previews).toEqual([]); expect(state.failures).toEqual([]);
});

test("uses compact rows for eleven lines and summarizes only the edited fields", async ({ page }, testInfo) => {
  const lines = Array.from({ length: 11 }, (_, i) => ({ ...line, id: 11 + i, lineNumber: 1 + i, name: `Product ${i + 1} with the supplier name` }));
  const state = await setup(page, { lines }), modal = page.getByRole("dialog");
  await expect(modal.getByRole("table")).toBeVisible();
  const rows = modal.getByRole("row"); await expect(rows).toHaveCount(12);
  if (testInfo.project.name === "desktop") {
    const row = await rows.nth(1).boundingBox(); expect(row!.height).toBeLessThan(110);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await modal.screenshot({ path: testInfo.outputPath("compact-po-eleven-lines.png") });
  await modal.locator("#correct-price-18").fill("0.5355");
  await modal.getByLabel("Reason for editing / supplier reference").fill("Supplier price confirmed for line eight");
  await modal.getByRole("button", { name: "Review changes", exact: true }).click();
  const summary = modal.getByRole("table", { name: "PO change summary" });
  await expect(summary.getByRole("row")).toHaveCount(4);
  await expect(summary).toContainText("8 · Product 8"); await expect(summary).not.toContainText("Quantity");
  expect(state.previews[0].changes.map(row => row.lineId)).toEqual([18]); expect(state.failures).toEqual([]);
});


test("returned stock value is reviewed before approval and retained with its source in history", async ({ page }, info) => {
  const state = await setup(page, { measuredCosts: true, returnedValue: "increase" });
  const modal = await review(page);
  const returned = modal.getByRole("region", { name: "Supplier-return value changes" });
  await expect(returned).toContainText("2 returned units");
  await expect(returned).toContainText("Change: 1.0001 USD");
  const before = returned.getByText("1.0001 USD", { exact: true });
  const after = returned.getByText("2.0002 USD", { exact: true });
  await before.scrollIntoViewIfNeeded();
  await expect(before).toBeInViewport();
  await expect(after).toBeInViewport();
  await expect(returned.getByRole("link", { name: "Return #9", exact: true })).toHaveAttribute("href", /supplier-returns\/9/);
  await expect(returned).toContainText("do not record a new physical return or supplier credit");
  await expect(modal.getByRole("button", { name: saveAction, exact: true })).toBeDisabled();
  expect(state.approvals).toEqual([]);
  await returned.scrollIntoViewIfNeeded();
  await returned.screenshot({ path: info.outputPath("po-amendment-return-value.png") });
  await save(page);
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByRole("region", { name: "Approved PO edits" });
  await history.locator("summary").filter({ hasText: "Revision 1 · approved by Approving Admin" }).click();
  const approved = history.getByRole("region", { name: "Supplier-return value changes" });
  await expect(approved).toContainText("Returned value recorded at approval");
  await expect(approved).toContainText("Change: 1.0001 USD");
  expect(state.approvals).toHaveLength(1);
  expect(state.failures).toEqual([]);
});

test("a returned-value reduction can be declined without approving a PO edit", async ({ page }) => {
  const state = await setup(page, { returnedValue: "decrease" });
  const modal = await review(page);
  const returned = modal.getByRole("region", { name: "Supplier-return value changes" });
  await expect(returned).toContainText("Change: -1.0001 USD");
  await expect(returned.getByText("2.0002 USD", { exact: true })).toBeVisible();
  await expect(returned.getByText("1.0001 USD", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  expect(state.approvals).toEqual([]);
  expect(state.failures).toEqual([]);
});
