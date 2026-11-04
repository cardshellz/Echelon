import { staffAuthorityFixture } from "./fixtures/staff-authority.fixture";
import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";
import { purchaseTaxContextSchema, purchaseTaxPreviewSchema, type PurchaseTaxTarget, type PurchaseTaxPreview } from "../../shared/procurement/purchase-tax";
import { purchaseTaxSettingsChanges } from "../../shared/procurement/purchase-tax-settings";

const sourceVersion = "a".repeat(64), previewVersion = "b".repeat(64);
const type = { id: 1, code: "VAT", name: "Supplier VAT", treatment: "inventory", revision: 1 };
async function setup(page: Page, options: { target?: PurchaseTaxTarget; canApprove?: boolean; stale?: boolean; loseResponse?: boolean; create?: boolean; denial?: "terminal" | "middleware" } = {}) {
  const failures = await installFixtures(page), writes: { key: string | undefined; body: unknown }[] = [];
  const target = options.target ?? { kind: "tax_type", id: options.create ? null : 1 };
  const components = { contractVersion: 1, packagingTreatment: "separate", productMills: 1100000, packagingMills: 100000, adjustmentMills: 0, source: "operator_review" };
  const current = target.kind === "tax_type" ? target.id === null ? null : { ...target, code: type.code, name: type.name, treatment: type.treatment }
    : target.kind === "purchase_order" ? { ...target, taxTypeId: 1, lineTypes: [{ lineId: 18, taxTypeId: null }] }
    : target.kind === "invoice_line" ? { ...target, taxes: [], components }
    : { ...target, taxTypeId: 1 };
  const document = { kind: target.kind === "invoice_line" ? "invoice" : target.kind === "shipment_charge" ? "shipment" : "purchase_order", id: 17,
    reference: "TEST-PO-17", currency: "USD", taxMills: 100000, inventoryMills: 100000, recoverableMills: 0, unclassifiedMills: 0 };
  const context = purchaseTaxContextSchema.parse({ target, sourceVersion, canApprove: options.canApprove !== false, types: options.create ? [] : [type, { ...type, id: 2, code: "RECOVERABLE", name: "Recoverable VAT", treatment: "recoverable" }], current,
    documents: target.kind === "tax_type" && target.id === null ? [] : [document], lines: [{ id: 18, label: "Test goods", taxMills: 0, taxTypeId: null }],
    invoice: target.kind === "invoice_line" ? { totalCents: 12000, currency: "USD", taxes: [], components } : null, approvals: [] });
  let measured: PurchaseTaxPreview | undefined, lost = options.loseResponse ?? false, denial = options.denial;
  await page.route("**/api/auth/me", route => route.fulfill({ json: staffAuthorityFixture({ user: { id: "tax-admin", username: "tax-admin", role: "admin" }, permissions: ["purchasing:view", "purchasing:approve", "settings:edit"], systemRoles: ["admin"] }) }));
  await page.route("**/api/settings/procurement", route => route.fulfill({ json: { requireApproval: false, autoSendOnApprove: false, requireAcknowledgeBeforeReceive: false, hideIncotermsDomestic: false, enableShipmentTracking: true, autoPutawayLocation: false, autoCloseOnReconcile: false, oneClickReceiveStart: false, useNewPoEditor: true, useNewReorderCockpit: false, revision: 1 } }));
  await page.route("**/api/purchasing/tax-types", route => route.fulfill({ json: options.create ? [] : [type] }));
  await page.route("**/api/purchasing/tax-review/**", route => route.fulfill({ json: context }));
  await page.route("**/api/purchasing/tax-changes/preview", route => {
    if (options.stale) return route.fulfill({ status: 409, json: { code: "PURCHASE_TAX_STALE", error: "The stock or tax source changed. Reload and review again." } });
    const request = route.request().postDataJSON();
    measured = purchaseTaxPreviewSchema.parse({ ...request, previewVersion, settings: purchaseTaxSettingsChanges(context, request.change), before: context.documents,
      after: context.documents.map(row => ({ ...row, inventoryMills: 0, recoverableMills: row.taxMills })), warnings: [],
      impact: { lots: [], orderCosts: [], historicalCosts: [], applications: [], inventoryValues: target.id === null ? [] : [{ lotId: 7, lotNumber: "RECEIVED-STOCK", onHandUnits: 2,
        originalLotTotalMills: { before: 1200000, after: 1100000 }, onHandValueMills: { before: 1200000, after: 1100000 }, valueReviewReason: null }] } });
    return route.fulfill({ json: measured });
  });
  await page.route("**/api/purchasing/tax-changes", route => {
    writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
    if (denial) return route.fulfill({ status: 403, ...(denial === "terminal" ? { headers: { "Idempotency-Replayed": "false" } } : {}), json: denial === "terminal"
      ? { code: "INVOICE_QUANTITY_ADMIN_REQUIRED", error: "An Administrator with purchasing approval permission must confirm this correction." }
      : { error: "Permission required" } });
    if (lost) return route.abort("failed");
    return route.fulfill({ json: { auditEventId: 421, preview: measured } });
  });
  if (target.kind === "tax_type") { await page.goto("/settings/procurement"); await page.getByRole("button", { name: target.id === null ? "Add tax type" : "Review Supplier VAT", exact: true }).click(); }
  else if (target.kind === "purchase_order") { await page.goto("/purchase-orders/17?tab=lines"); await page.getByRole("button", { name: "Tax treatment", exact: true }).click(); }
  else if (target.kind === "invoice_line") {
    await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: { id: 71, invoiceNumber: "TAX-INVOICE", vendorId: 2, status: "approved", currency: "USD", invoicedAmountCents: 12000, paidAmountCents: 0, balanceCents: 12000,
      lines: [{ id: 72, lineNumber: 1, purchaseOrderLineId: 18, productName: "Test goods", qtyInvoiced: 100, qtyOrdered: 100, qtyReceived: 100, unitCostCents: 110, unitCostMills: 11000, lineTotalCents: 12000, costComponentEvidence: components }],
      poLinks: [{ purchaseOrderId: 17, poNumber: "TEST-PO-17" }], attachments: [], payments: [] } }));
    await page.goto("/ap-invoices/71?tab=lines"); await page.getByRole("button", { name: "Tax amounts", exact: true }).click();
  } else {
    await page.route("**/api/inbound-shipments/42", route => route.fulfill({ json: { id: 42, shipmentNumber: "TAX-SHIPMENT", status: "closed", mode: "air", lines: [], costs: [{ id: 31, costType: "duty", actualCents: 1000, currency: "USD", taxTypeId: 1 }], statusHistory: [] } }));
    await page.goto("/shipments/42?tab=costs"); await page.getByRole("button", { name: "Tax treatment", exact: true }).filter({ visible: true }).click();
  }
  const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
  return { dialog, failures, writes, release: () => { lost = false; denial = undefined; } };
}
async function approve(page: Page) {
  const dialog = page.getByRole("dialog"); await dialog.getByLabel("Reason / supporting reference").fill("Supplier tax eligibility and amounts verified");
  await dialog.getByLabel("I reviewed the tax treatment and the cost changes.").check();
  await dialog.getByRole("button", { name: "Approve & update costs", exact: true }).click();
}

test("configures a tax type with one reviewed admin approval", async ({ page }, info) => {
  const proof = await setup(page, { create: true }), dialog = proof.dialog;
  await dialog.getByLabel("Tax code", { exact: true }).fill("VAT"); await dialog.getByLabel("Tax name", { exact: true }).fill("Supplier VAT");
  await dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  expect(proof.writes).toEqual([]); await expect(dialog.getByText("Record separately as recoverable tax", { exact: false })).toBeVisible();
  await approve(page); await expect(dialog.getByRole("status")).toContainText("Approval record #421"); expect(proof.writes).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("approved-purchase-tax.png"), fullPage: true }); expect(proof.failures).toEqual([]);
});
test("shows exact before and after on mobile without hiding the approval footer", async ({ page }, info) => {
  const { dialog, failures, writes } = await setup(page);
  await dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("table", { name: "Tax changes TEST-PO-17" })).toContainText("Recoverable tax");
  await expect(dialog.getByRole("table", { name: "Tax inventory cost changes" })).toContainText("$120.00");
  await expect(dialog.getByRole("table", { name: "Tax inventory cost changes" })).toContainText("$110.00");
  await expect(dialog.getByRole("button", { name: "Approve & update costs", exact: true })).toBeVisible(); expect(writes).toEqual([]);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("tax-before-after.png"), fullPage: true }); await approve(page); expect(failures).toEqual([]);
});
test("receives tax from the PO default instead of asking for a new receiving rule", async ({ page }) => {
  const { dialog, failures } = await setup(page, { target: { kind: "purchase_order", id: 17 } });
  await dialog.getByLabel("Default tax type for this PO", { exact: true }).selectOption("2");
  await expect(dialog.getByText("Receiving inherits this treatment automatically.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click(); await approve(page); expect(failures).toEqual([]);
});
test("records invoice tax and proposes the product total without changing the bill", async ({ page }) => {
  const { dialog, writes, failures } = await setup(page, { target: { kind: "invoice_line", id: 72 } });
  await dialog.getByRole("button", { name: "Add tax", exact: true }).click(); await dialog.getByLabel("Tax type", { exact: true }).selectOption("2");
  await dialog.getByLabel("Tax amount", { exact: true }).fill("10.00");
  await expect(dialog.getByLabel("Product total", { exact: true })).toHaveValue("100.0000");
  await expect(dialog).toContainText("120.00 USD"); await dialog.getByRole("button", { name: "Review changes", exact: true }).click(); await approve(page);
  expect(writes[0].body).toMatchObject({ change: { taxes: [{ taxTypeId: 2, amountMills: 100000 }], components: { productMills: 1000000, packagingMills: 100000, adjustmentMills: 100000 } } }); expect(failures).toEqual([]);
});
test("allows admin tax review on the shipment cost card", async ({ page }) => {
  const { dialog, failures } = await setup(page, { target: { kind: "shipment_charge", id: 31 } });
  await dialog.getByLabel("Tax type for this shipment charge", { exact: true }).selectOption("2");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click(); await approve(page); expect(failures).toEqual([]);
});
test("read-only users cannot approve tax changes", async ({ page }) => {
  const { dialog, writes } = await setup(page, { canApprove: false });
  await expect(dialog.getByRole("button", { name: "Review changes", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("Administrator"); expect(writes).toEqual([]);
});

test("a terminal admin rejection allows a fresh reviewed approval", async ({ page }) => {
  const proof = await setup(page, { denial: "terminal" }), dialog = proof.dialog;
  await dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await approve(page);
  await expect(dialog.getByRole("button", { name: "Reload and review again", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry saved approval", exact: true })).toHaveCount(0);
  proof.release();
  await dialog.getByRole("button", { name: "Reload and review again", exact: true }).click();
  await dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await approve(page);
  await expect(dialog.getByRole("status")).toContainText("Tax change approved and saved.");
  expect(proof.writes).toHaveLength(2);
  expect(proof.writes[1].key).not.toBe(proof.writes[0].key);
  expect(proof.failures).toEqual([]);
});

test("a permission gate retains the original approval key until its outcome can be recovered", async ({ page }) => {
  const proof = await setup(page, { denial: "middleware" }), dialog = proof.dialog;
  await dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await approve(page);
  await expect(dialog.getByRole("button", { name: "Retry saved approval", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reload and review again", exact: true })).toHaveCount(0);
  proof.release();
  await dialog.getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Tax change approved and saved.");
  expect(proof.writes).toHaveLength(2);
  expect(proof.writes[1]).toEqual(proof.writes[0]);
  expect(proof.failures).toEqual([]);
});
test("stale stock or tax evidence requires a fresh preview", async ({ page }) => {
  const { dialog, writes } = await setup(page, { stale: true }); await dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("Reload and review again");
  await expect(dialog.getByRole("button", { name: "Reload and review again", exact: true })).toBeVisible(); expect(writes).toEqual([]);
});
test("recovers a lost approval response with the same immutable key after reload", async ({ page }) => {
  const proof = await setup(page, { loseResponse: true }); await proof.dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await proof.dialog.getByRole("button", { name: "Review changes", exact: true }).click(); await approve(page);
  await expect.poll(() => proof.writes.length).toBeGreaterThan(0); await page.reload();
  await page.getByRole("button", { name: "Review Supplier VAT", exact: true }).click(); proof.release();
  await page.getByRole("dialog").getByRole("button", { name: "Retry saved approval", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Approval record #421");
  expect(new Set(proof.writes.map(row => row.key)).size).toBe(1); expect(proof.writes.every(row => JSON.stringify(row.body) === JSON.stringify(proof.writes[0].body))).toBe(true);
});
