import { expect, test, type Page } from "@playwright/test";
import { invoiceAmountPerPiece, type InvoiceQuantityApprovalRequest, type InvoiceQuantityContext, type InvoiceQuantityPreview, type InvoiceQuantityResult } from "../../shared/procurement/invoice-quantity-correction";
import { installFixtures, po } from "./procurement-fixtures";
import { normalizePoLinePricing } from "@shared/utils/po-line-pricing";
import { poLineAmountCents, type PoQuantityAmendmentContext, type PoQuantityAmendmentPreview, type PoQuantityPreviewRequest, type PoQuantityApprovalRequest } from "@shared/procurement/po-quantity-amendment";

const initialVersion = "a".repeat(64), nextVersion = "b".repeat(64);
const receiptKey = "invoice-quantity-correction:quantity-admin:72";
async function setup(page: Page, options: { canApprove?: boolean; stale?: boolean; loss?: "once" | "untilReleased"; otherQuantity?: number; disagree?: boolean; openModal?: boolean; multiplePos?: boolean; closedPo?: boolean } = {}) {
  const failures = await installFixtures(page);
  let version = initialVersion, stale = options.stale ?? false, acknowledged = options.loss === undefined;
  const otherQuantity = options.otherQuantity ?? 0;
  const line = { id: 72, lineNumber: 1, purchaseOrderLineId: 18, sku: "QUANTITY-SKU", productName: "Synthetic quantity correction",
    qtyInvoiced: 12500, qtyOrdered: 12500, qtyReceived: 25000, unitCostCents: 50, unitCostMills: 5023, lineTotalCents: 669375,
    matchStatus: "qty_discrepancy", costComponentEvidence: null,
    poQuantities: { status: "current", purchaseOrderId: 17, purchaseOrderLineId: 18, orderedQty: 25000, receivedQty: options.disagree ? 20000 : 25000 } };
  const invoice = { id: 71, invoiceNumber: "TEST-INV-71", vendorId: 2, vendorName: "Test vendor", status: "paid", currency: "USD",
    invoicedAmountCents: 669375, balanceCents: 0, paidAmountCents: 669375, attachments: [], payments: [], lines: [line],
    poLinks: [{ id: 1, purchaseOrderId: 17, poNumber: "TEST-PO-17" }, ...(options.multiplePos ? [{ id: 2, purchaseOrderId: 99, poNumber: "TEST-PO-99" }] : [])] };
  const preview = (quantity: number): InvoiceQuantityPreview => {
    const match = (pieces: number) => pieces + otherQuantity === line.poQuantities.receivedQty && pieces + otherQuantity === 25000 ? "matched" as const : "qty_discrepancy" as const;
    return { invoiceId: 71, invoiceLineId: 72, purchaseOrderId: 17, sourceVersion: version,
      beforeQuantity: line.qtyInvoiced, afterQuantity: quantity, orderedQuantity: 25000, receivedQuantity: line.poQuantities.receivedQty, otherInvoicedQuantity: otherQuantity,
      invoiceLineAmountCents: 669375, invoiceAmountCents: 669375, paidAmountCents: 669375, balanceCents: 0, recordedUnitCostMills: 5023,
      beforeAmountPerPiece: invoiceAmountPerPiece(669375, line.qtyInvoiced), afterAmountPerPiece: invoiceAmountPerPiece(669375, quantity),
      beforeMatch: match(line.qtyInvoiced), afterMatch: match(quantity),
      remainingIssues: match(quantity) === "matched" ? [] : [{ invoiceId: 71, lineId: 72, status: "qty_discrepancy" }],
      warnings: ["The product and packaging amounts have not been recorded. This correction does not guess their split or change inventory costs."],
    };
  };
  const context = (): InvoiceQuantityContext => ({
    invoiceId: 71, invoiceLineId: 72, purchaseOrderId: 17, lineNumber: 1, name: line.productName, currency: "USD", sourceVersion: version,
    canApprove: options.canApprove !== false, blockedReason: null, current: preview(line.qtyInvoiced),
    suggestedQuantity: options.disagree ? null : 25000 - otherQuantity,
    suggestionReason: options.disagree ? "The PO and received quantities differ. Check the supplier invoice before choosing a quantity." : "Suggested from the matching PO and received quantities, after subtracting other invoice lines.",
    suggested: options.disagree ? null : preview(25000 - otherQuantity),
  });
  const commands: Array<{ key: string; body: InvoiceQuantityApprovalRequest }> = [];
  const previews: unknown[] = [], replay = new Map<string, InvoiceQuantityResult>();
  const poCommands: { purchaseOrderId: number; key: string; body: PoQuantityApprovalRequest }[] = [];
  const poPreviews: { purchaseOrderId: number; body: PoQuantityPreviewRequest }[] = [];
  const poContextReads: number[] = [];
  function poContext(purchaseOrderId: number): PoQuantityAmendmentContext {
    return { purchaseOrderId, currency: "USD", sourceVersion: initialVersion, canApprove: options.canApprove !== false,
      blockedReason: options.closedPo ? "Closed or cancelled POs cannot be amended." : null,
      lines: [{ id: purchaseOrderId === 17 ? 18 : 19, lineNumber: 1, name: `Synthetic PO ${purchaseOrderId} product`,
        orderQty: 25000, receivedQty: 25000, invoicedQty: 12500, unitCostMills: 5000, totalProductCostCents: 1250000,
        packagingCostCents: 0, discountCents: 0, taxCents: 0, componentTotalCents: 1250000, lineType: "product",
        pricing: { basis: "per_piece", quantityPieces: 25000, unitCostMills: 5000 }, lineTotalCents: 1250000, status: "received", blockedReason: null }],
    };
  }
  function poPreview(purchaseOrderId: number, body: PoQuantityPreviewRequest): PoQuantityAmendmentPreview {
    const before = poContext(purchaseOrderId).lines[0], change = body.changes[0];
    const pricing = normalizePoLinePricing(change.pricing!);
    const lineTotalCents = poLineAmountCents(pricing.totalProductCostCents, change.packagingCostCents!, change.discountCents!, change.taxCents!);
    const after = { ...before, orderQty: change.quantityPieces, unitCostMills: pricing.unitCostMills,
      totalProductCostCents: pricing.totalProductCostCents, packagingCostCents: change.packagingCostCents!,
      discountCents: change.discountCents!, taxCents: change.taxCents!, componentTotalCents: lineTotalCents, lineTotalCents };
    return { purchaseOrderId, currency: "USD", sourceVersion: body.sourceVersion, reason: body.reason,
      beforeTotalCents: before.lineTotalCents, afterTotalCents: lineTotalCents, beforeStatus: "received", afterStatus: "received",
      lines: [{ before, after, priceTreatment: change.priceTreatment }], warnings: [], invoiceMatches: [] };
  }
  await page.route("**/api/purchase-orders/**", route => {
    const request = route.request(), match = /^\/api\/purchase-orders\/(17|99)(\/quantity-amendment(?:\/preview)?)?$/.exec(new URL(request.url()).pathname);
    if (!match) return route.fallback();
    const purchaseOrderId = Number(match[1]);
    if (request.method() === "GET" && !match[2]) return route.fulfill({ json: { ...po(purchaseOrderId), status: options.closedPo ? "closed" : "received", physicalStatus: options.closedPo ? "closed" : "received", subtotalCents: 1250000, totalCents: 1250000 } });
    if (request.method() === "GET" && match[2] === "/quantity-amendment") { poContextReads.push(purchaseOrderId); return route.fulfill({ json: poContext(purchaseOrderId) }); }
    if (request.method() === "POST" && match[2] === "/quantity-amendment/preview") {
      const body = request.postDataJSON() as PoQuantityPreviewRequest; poPreviews.push({ purchaseOrderId, body });
      return route.fulfill({ json: poPreview(purchaseOrderId, body) });
    }
    if (request.method() === "POST" && match[2] === "/quantity-amendment") {
      const body = request.postDataJSON() as PoQuantityApprovalRequest;
      poCommands.push({ purchaseOrderId, key: request.headers()["idempotency-key"], body });
      return route.fulfill({ json: { purchaseOrderId, revisionNumber: 1, auditEventId: 610, preview: poPreview(purchaseOrderId, body) } });
    }
    return route.fallback();
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "quantity-admin", username: "test", role: "admin" }, permissions: options.canApprove === false ? ["purchasing:view"] : ["purchasing:view", "purchasing:approve"], roles: ["admin"] } }));
  await page.route("**/api/vendor-invoices/71", (route) => route.fulfill({ json: invoice }));
  await page.route("**/api/vendor-invoice-lines/72/quantity-correction/preview", (route) => {
    const body = route.request().postDataJSON(); previews.push(body);
    return route.fulfill({ json: preview(body.quantityPieces) });
  });
  await page.route("**/api/vendor-invoice-lines/72/quantity-correction", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: context() });
    const key = route.request().headers()["idempotency-key"], body = route.request().postDataJSON() as InvoiceQuantityApprovalRequest;
    commands.push({ key, body });
    if (stale) { stale = false; version = nextVersion; return route.fulfill({ status: 409, json: { error: "The invoice or PO changed. Reload and review the new values.", code: "INVOICE_QUANTITY_STALE" } }); }
    if (!replay.has(key)) {
      const result: InvoiceQuantityResult = { invoiceLineId: 72, auditEventId: 901, preview: preview(body.quantityPieces) };
      line.qtyInvoiced = body.quantityPieces; line.matchStatus = result.preview.afterMatch; version = nextVersion; replay.set(key, result);
    }
    if (!acknowledged) { if (options.loss === "once") acknowledged = true; return route.abort("connectionreset"); }
    return route.fulfill({ json: replay.get(key) });
  });
  await page.goto("/ap-invoices/71?tab=lines");
  if (options.openModal !== false) {
    await page.getByRole("button", { name: "Correct invoice quantity for line 1", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("Correct invoice quantity (pieces)")).toBeVisible();
  }
  return { failures, invoice, commands, previews, poCommands, poPreviews, poContextReads, releaseAcknowledgement: () => { acknowledged = true; } };
}
const approval = (page: Page) => page.getByRole("checkbox", { name: "I checked the supplier invoice and reviewed these changes." });
const impactRow = (page: Page, name: string) => page.getByRole("table", { name: "Quantity correction impact" }).getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });

test("prefills the correction and clearly shows quantity and financial impact before approval", async ({ page }, testInfo) => {
  const proof = await setup(page);
  await expect(page.getByLabel("Correct invoice quantity (pieces)")).toHaveValue("25000");
  await expect(impactRow(page, "Invoice quantity")).toHaveText("Invoice quantity12,50025,000");
  await expect(impactRow(page, "Bill per piece")).toHaveText("Bill per piece$0.535500$0.267750");
  await expect(impactRow(page, "This line's amount")).toHaveText("This line's amount$6,693.75$6,693.75");
  await expect(page.getByRole("dialog")).toContainText("Unit price on invoice: 0.5023 USD (unchanged).");
  await expect(page.getByRole("dialog").locator("dl")).toContainText("Paid$6,693.75");
  await expect(page.getByRole("dialog")).not.toContainText("Packaging treatment");
  await expect(page.getByRole("button", { name: "Confirm quantity", exact: true })).toBeDisabled();
  expect(proof.commands).toEqual([]);
  await approval(page).check();
  await expect(page.getByRole("button", { name: "Confirm quantity", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("invoice-quantity-before-after.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Confirm quantity", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice quantity confirmed and saved" })).toBeVisible();
  expect(proof.commands).toHaveLength(1);
  expect(proof.commands[0].body).toMatchObject({ sourceVersion: initialVersion, quantityPieces: 25000, approvalConfirmed: true });
  expect(proof.invoice).toMatchObject({ invoicedAmountCents: 669375, paidAmountCents: 669375, balanceCents: 0, lines: [{ qtyInvoiced: 25000, lineTotalCents: 669375, unitCostMills: 5023 }] });
  expect(await page.evaluate((key) => sessionStorage.getItem(key), receiptKey)).toBeNull();
  await page.reload();
  await expect(page.getByText("Qty Mismatch", { exact: true })).toHaveCount(0);
  expect(proof.failures).toEqual([]);
});

test("allows an override only after updating the preview and rechecking confirmation", async ({ page }) => {
  const proof = await setup(page);
  await approval(page).check();
  await page.getByLabel("Correct invoice quantity (pieces)").fill("20000");
  await expect(page.getByRole("button", { name: "Confirm quantity", exact: true })).toBeDisabled();
  await expect(approval(page)).not.toBeChecked();
  await page.getByRole("button", { name: "Update preview", exact: true }).click();
  await expect(impactRow(page, "Invoice quantity")).toHaveText("Invoice quantity12,50020,000");
  await expect(page.getByText("After this change, 1 invoice line(s) on this PO still need review.")).toBeVisible();
  await approval(page).check();
  await page.getByRole("button", { name: "Confirm quantity", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice quantity confirmed and saved" })).toBeVisible();
  expect(proof.previews).toEqual([{ sourceVersion: initialVersion, quantityPieces: 20000 }]);
  expect(proof.commands[0].body.quantityPieces).toBe(20000); expect(proof.failures).toEqual([]);
});

test("keeps inspection available but prevents nonadmins from changing the quantity", async ({ page }) => {
  const proof = await setup(page, { canApprove: false });
  await expect(page.getByRole("alert")).toContainText("An Administrator");
  await expect(page.getByLabel("Correct invoice quantity (pieces)")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Confirm quantity", exact: true })).toBeDisabled();
  expect(proof.commands).toEqual([]); expect(proof.previews).toEqual([]); expect(proof.failures).toEqual([]);
});

test("retries a lost acknowledgement with the same exact confirmation", async ({ page }) => {
  const proof = await setup(page, { loss: "once" });
  await approval(page).check(); await page.getByRole("button", { name: "Confirm quantity", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice quantity confirmed and saved" })).toBeVisible();
  expect(proof.commands).toHaveLength(2); expect(proof.commands[0]).toEqual(proof.commands[1]); expect(proof.failures).toEqual([]);
});

test("recovers a saved confirmation after reload even when the committed change already cleared the mismatch", async ({ page }) => {
  const proof = await setup(page, { loss: "untilReleased" });
  await approval(page).check(); await page.getByRole("button", { name: "Confirm quantity", exact: true }).click();
  await expect.poll(() => proof.commands.length).toBe(1);
  await page.reload(); proof.releaseAcknowledgement();
  await page.getByRole("button", { name: "Verify quantity confirmation for line 1" }).click();
  await expect(impactRow(page, "Invoice quantity")).toHaveText("Invoice quantity12,50025,000");
  await page.getByRole("button", { name: "Retry saved confirmation", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice quantity confirmed and saved" })).toBeVisible();
  expect(proof.commands).toHaveLength(2); expect(proof.commands[0]).toEqual(proof.commands[1]); expect(proof.failures).toEqual([]);
});

test("requires explicit reload after a stale source response and keeps the reviewed values visible", async ({ page }) => {
  const proof = await setup(page, { stale: true });
  await approval(page).check(); await page.getByRole("button", { name: "Confirm quantity", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Reload and review");
  await expect(page.getByLabel("Correct invoice quantity (pieces)")).toHaveValue("25000");
  await expect(page.getByRole("button", { name: "Confirm quantity", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Reload invoice and review again" }).click();
  await page.getByRole("button", { name: "Correct invoice quantity for line 1", exact: true }).click();
  await approval(page).check(); await page.getByRole("button", { name: "Confirm quantity", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice quantity confirmed and saved" })).toBeVisible();
  expect(proof.commands.map(({ body }) => body.sourceVersion)).toEqual([initialVersion, nextVersion]);
  expect(proof.commands[0].key).not.toBe(proof.commands[1].key); expect(proof.failures).toEqual([]);
});

test("subtracts other bill coverage from the suggested quantity", async ({ page }) => {
  const proof = await setup(page, { otherQuantity: 5000 });
  await expect(page.getByLabel("Correct invoice quantity (pieces)")).toHaveValue("20000");
  await expect(page.getByText("Other invoice lines already cover 5,000 pieces.")).toBeVisible();
  expect(proof.commands).toEqual([]); expect(proof.failures).toEqual([]);
});

test("does not invent a default when the PO and receipt disagree", async ({ page }) => {
  const proof = await setup(page, { disagree: true });
  await expect(page.getByLabel("Correct invoice quantity (pieces)")).toHaveValue("12500");
  await expect(page.getByText("The PO and received quantities differ. Check the supplier invoice before choosing a quantity.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm quantity", exact: true })).toBeDisabled();
  expect(proof.commands).toEqual([]); expect(proof.failures).toEqual([]);
});

test("keeps the confirmation action visible within a short screen while details scroll", async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 560 });
  const proof = await setup(page);
  const confirm = page.getByRole("button", { name: "Confirm quantity", exact: true });
  // Wait for the dialog's entry animation before measuring the touch target.
  await expect.poll(async () => (await confirm.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const box = await confirm.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(560);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await page.getByLabel("Correct invoice quantity (pieces)").fill("20000");
  await page.getByRole("button", { name: "Update preview", exact: true }).click();
  const after = await confirm.boundingBox();
  expect(after!.y + after!.height).toBeLessThanOrEqual(560); expect(proof.failures).toEqual([]);
});

test("blocks a corrupt browser confirmation receipt instead of silently creating another command", async ({ page }) => {
  const proof = await setup(page);
  await page.evaluate((key) => sessionStorage.setItem(key, "broken receipt"), receiptKey);
  await page.getByRole("button", { name: "Close quantity correction", exact: true }).click();
  await page.getByRole("button", { name: "Correct invoice quantity for line 1", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("saved confirmation could not be read");
  await expect(page.getByRole("button", { name: "Confirm quantity", exact: true })).toBeDisabled();
  expect(proof.commands).toEqual([]); expect(proof.failures).toEqual([]);
});


test("edits and saves the linked PO directly from a paid invoice without changing its invoice quantity or amount", async ({ page }) => {
  const proof = await setup(page, { openModal: false });
  await page.getByRole("link", { name: "Edit PO TEST-PO-17", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByRole("heading", { name: "Edit purchase order", exact: true })).toBeVisible();
  await expect(editor.getByLabel("Quantity (pieces)")).toHaveValue("25000");
  await expect(editor.getByLabel("Product price per piece (USD)")).toHaveValue("0.5000");
  expect(proof.commands).toEqual([]); expect(proof.poCommands).toEqual([]);
  await editor.getByLabel("Product price per piece (USD)").fill("0.5355");
  await editor.getByLabel("Reason for editing / supplier reference").fill("Supplier confirmed the corrected PO price");
  await editor.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(editor.getByText("PO total: 12500.00 → 13387.50 USD", { exact: true })).toBeVisible();
  await editor.getByLabel("I reviewed these changes and the new PO total.").check();
  await editor.getByRole("button", { name: "Approve & save PO", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("approved and saved as revision 1");
  expect(proof.poCommands).toHaveLength(1);
  expect(proof.poCommands[0]).toMatchObject({ purchaseOrderId: 17, body: { changes: [{ lineId: 18, quantityPieces: 25000, priceTreatment: "edit_line", pricing: { basis: "per_piece", unitCostMills: 5355 }, packagingCostCents: 0, discountCents: 0, taxCents: 0 }] } });
  expect(proof.commands).toEqual([]);
  expect(proof.invoice).toMatchObject({ invoicedAmountCents: 669375, paidAmountCents: 669375, balanceCents: 0, lines: [{ qtyInvoiced: 12500, lineTotalCents: 669375 }] });
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  expect(new URL(page.url()).searchParams.has("editPo")).toBe(false);
  await page.getByRole("link", { name: "Back to invoice #71", exact: true }).click();
  await expect(page).toHaveURL(/\/ap-invoices\/71\?tab=lines$/);
  await expect(page.getByRole("link", { name: "Edit PO TEST-PO-17", exact: true })).toBeVisible();
  expect(proof.failures).toEqual([]);
});

test("switches the invoice quantity dialog straight to the PO editor with visible actions", async ({ page }, testInfo) => {
  const proof = await setup(page);
  const editPo = page.getByRole("dialog").getByRole("button", { name: "Edit PO", exact: true });
  await expect(editPo).toBeVisible();
  await expect.poll(async () => (await editPo.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await editPo.click();
  await expect(page.getByRole("heading", { name: "Correct invoice quantity · Line 1", exact: true })).toHaveCount(0);
  const editor = page.getByRole("dialog");
  await expect(editor.getByRole("heading", { name: "Edit purchase order", exact: true })).toBeVisible();
  await expect(editor.getByLabel("Product price per piece (USD)")).toBeEditable();
  await expect(editor.getByRole("button", { name: "Review changes", exact: true })).toBeVisible();
  await editor.screenshot({ path: testInfo.outputPath("edit-po-from-invoice.png") });
  expect(proof.poContextReads).toEqual([17]);
  expect(proof.commands).toEqual([]); expect(proof.poCommands).toEqual([]); expect(proof.poPreviews).toEqual([]);
  expect(proof.failures).toEqual([]);
});

test("opens the chosen PO on a multi-PO invoice rather than selecting the first linked PO", async ({ page }) => {
  const proof = await setup(page, { openModal: false, multiplePos: true });
  await page.getByRole("link", { name: "Edit PO TEST-PO-99", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Line 1 · Synthetic PO 99 product", { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/purchase-orders/99");
  expect(proof.poContextReads).toEqual([99]); expect(proof.poCommands).toEqual([]); expect(proof.commands).toEqual([]);
  expect(proof.failures).toEqual([]);
});

test("direct PO edit navigation keeps the administrator approval gate", async ({ page }) => {
  const proof = await setup(page, { openModal: false, canApprove: false });
  await page.getByRole("link", { name: "Edit PO TEST-PO-17", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("current Administrator");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Review changes", exact: true })).toHaveCount(0);
  expect(proof.poCommands).toEqual([]); expect(proof.poPreviews).toEqual([]); expect(proof.commands).toEqual([]);
  expect(proof.failures).toEqual([]);
});

test("direct PO edit navigation explains a closed PO instead of hiding its editor", async ({ page }) => {
  const proof = await setup(page, { openModal: false, closedPo: true });
  await page.getByRole("link", { name: "Edit PO TEST-PO-17", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Closed or cancelled POs cannot be amended.");
  expect(proof.poCommands).toEqual([]); expect(proof.poPreviews).toEqual([]); expect(proof.commands).toEqual([]);
  expect(proof.failures).toEqual([]);
});

test("rejects a mismatched invoice-line context before exposing its PO edit action", async ({ page }) => {
  const proof = await setup(page, { openModal: false });
  await page.route("**/api/vendor-invoice-lines/72/quantity-correction", route => route.fulfill({ json: {
    invoiceId: 71, invoiceLineId: 73, purchaseOrderId: 99, lineNumber: 2, name: "Incorrect line context", currency: "USD", sourceVersion: initialVersion,
    canApprove: true, blockedReason: null, suggestedQuantity: null, suggestionReason: "Check the supplier invoice.",
    current: { invoiceId: 71, invoiceLineId: 73, purchaseOrderId: 99, sourceVersion: initialVersion, beforeQuantity: 12500, afterQuantity: 12500,
      orderedQuantity: 25000, receivedQuantity: 25000, otherInvoicedQuantity: 0, invoiceLineAmountCents: 669375, invoiceAmountCents: 669375,
      paidAmountCents: 669375, balanceCents: 0, recordedUnitCostMills: 5023, beforeAmountPerPiece: "0.535500", afterAmountPerPiece: "0.535500",
      beforeMatch: "qty_discrepancy", afterMatch: "qty_discrepancy", remainingIssues: [], warnings: [] }, suggested: null,
  } }));
  await page.getByRole("button", { name: "Correct invoice quantity for line 1", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("does not match this invoice line");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Edit PO", exact: true })).toHaveCount(0);
  expect(proof.poContextReads).toEqual([]); expect(proof.poCommands).toEqual([]); expect(proof.commands).toEqual([]);
  expect(proof.failures).toEqual([]);
});
