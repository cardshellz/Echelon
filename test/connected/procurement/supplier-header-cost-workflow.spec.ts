import { randomUUID } from "node:crypto";
import { test, expect, login, type Backend } from "./fixtures";
import { receiveShipmentPurchase } from "./receiving-workflow";
import { supplierHeaderContextSchema, supplierHeaderPreviewSchema } from "../../../shared/procurement/supplier-header-costs";
import { receiptInvoiceContextSchema, receiptInvoicePreviewSchema } from "../../../shared/procurement/receipt-invoice-costs";

type Row = Record<string, unknown>;
interface State { lots: Row[]; invoices: Row[]; payments: Row[]; receivingLines: Row[]; headerReviews: Row[]; receiptInvoiceApprovals: Row[] }
const state = (backend: Backend) => backend.control<State>("workflow-state");

test("combined goods and classified header shares update the correct receipt with one auditable approval", async ({ page, backend }, info) => {
  await backend.control("supplier-header-workflow", {});
  const admin = backend.actors.find(actor => actor.id === "connected-admin");
  if (!admin) throw new Error("Connected administrator missing");
  await login(page, backend, admin);
  await receiveShipmentPurchase(page, backend, 31);
  await receiveShipmentPurchase(page, backend, 32);
  // Receipt assignment deliberately refuses an unclassified header. Establish
  // the original rule through its real approval owner before assigning invoices.
  const headerEndpoint = `${backend.url}/api/purchasing/supplier-header-costs`;
  const initialHeader = supplierHeaderContextSchema.parse(await (await page.request.get(`${headerEndpoint}?kind=invoice&id=71`)).json());
  const headerDraft = { target: initialHeader.source.target, sourceVersion: initialHeader.sourceVersion,
    entries: initialHeader.proposed, reason: "Verified original supplier header before assigning receipt invoices" };
  const headerReply = await page.request.post(`${headerEndpoint}/preview`, { data: headerDraft });
  expect(headerReply.status(), await headerReply.text()).toBe(200);
  const headerPreview = supplierHeaderPreviewSchema.parse(await headerReply.json());
  const headerSaved = await page.request.post(`${headerEndpoint}/approve`, { headers: { "Idempotency-Key": randomUUID() },
    data: { ...headerDraft, previewVersion: headerPreview.previewVersion, approvalConfirmed: true } });
  expect(headerSaved.status(), await headerSaved.text()).toBe(200);
  const reply = await page.request.get(`${backend.url}/api/purchasing/receipt-invoice-costs/21`);
  expect(reply.status()).toBe(200);
  const context = receiptInvoiceContextSchema.parse(await reply.json());
  const draft = { sourceVersion: context.sourceVersion, change: { purchaseOrderLineId: 21, allocations: context.receipts.map((receipt, i) => ({
    receivingLineId: receipt.receivingLineId, invoiceLineId: context.invoices[i].id, receiptStartPiece: 0, invoiceStartPiece: 0, pieces: receipt.pieces })) } };
  const reviewed = await page.request.post(`${backend.url}/api/purchasing/receipt-invoice-costs/preview`, { data: draft });
  expect(reviewed.status()).toBe(200);
  const assignment = receiptInvoicePreviewSchema.parse(await reviewed.json());
  expect((await page.request.post(`${backend.url}/api/purchasing/receipt-invoice-costs`, { headers: { "Idempotency-Key": randomUUID() }, data: {
    ...draft, previewVersion: assignment.previewVersion, reason: "Verified each original receipt and supplier invoice", approvalConfirmed: true } })).status()).toBe(200);

  await page.goto(`${backend.url}/ap-invoices/71?tab=lines`);
  await page.getByRole("button", { name: /^Review costs for/ }).first().click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Is packaging included in the product price?", exact: true }).click();
  await page.getByRole("option", { name: "One goods total; the split is not shown", exact: true }).click();
  await expect(dialog.getByLabel(/^Goods total/)).toHaveValue("25.0000");
  await dialog.getByLabel("Notes / supplier invoice reference", { exact: true }).fill("The invoice shows one goods total without a separate packaging split");
  await dialog.getByRole("button", { name: "Review cost changes", exact: true }).click();
  await expect(dialog).toContainText("Goods total (product and packaging)");
  await dialog.getByRole("button", { name: "Approve and apply costs", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Supplier amounts saved");
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  const original = await state(backend);

  await page.getByRole("button", { name: "Discounts & header charges", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Supplier discounts and header charges", exact: true });
  await expect(dialog).toContainText("$2.0000");
  await dialog.getByLabel("Description", { exact: true }).first().fill("Supplier discount");
  await dialog.getByLabel("Amount (USD)", { exact: true }).first().fill("-1.00");
  await dialog.getByRole("combobox", { name: /^Type/ }).first().selectOption("discount");
  await dialog.getByRole("button", { name: "Add header amount", exact: true }).click();
  await dialog.getByLabel("Description", { exact: true }).nth(1).fill("Service outside inventory");
  await dialog.getByLabel("Amount (USD)", { exact: true }).nth(1).fill("3.00");
  await dialog.getByRole("combobox", { name: /^Where it belongs/ }).nth(1).selectOption("excluded");
  await dialog.getByLabel("Reason / supplier reference", { exact: true }).fill("Checked the supplier discount and separately billed service");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Header cost changes", exact: true })).toContainText("-$0.3300");
  expect((await state(backend)).headerReviews).toEqual(original.headerReviews);
  expect((await state(backend)).lots).toEqual(original.lots);
  await dialog.screenshot({ path: info.outputPath("supplier-header-before-after.png") });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.getByLabel("I checked the original supplier document and these exact changes.", { exact: true }).check();
  await dialog.getByRole("button", { name: "Approve & apply costs", exact: true }).click();
  await expect.poll(async () => (await state(backend)).headerReviews.length).toBe(2);
  await dialog.getByRole("button", { name: "Close review", exact: true }).click();
  const applied = await state(backend);
  expect(applied.lots.filter(row => row.po_line_id === 21).map(row => String(row.product_total_cost_mills))).toEqual(["246700", "300000"]);
  expect(applied.invoices).toEqual(original.invoices);
  expect(applied.payments).toEqual(original.payments);
  expect(applied.receivingLines).toEqual(original.receivingLines);
  expect(applied.receiptInvoiceApprovals).toEqual(original.receiptInvoiceApprovals);
  await page.reload();
  await page.getByRole("button", { name: "Discounts & header charges", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Supplier discounts and header charges", exact: true });
  await expect(dialog.getByRole("status")).toContainText("already allocated");
  await expect(dialog).toContainText(admin.username);
  expect((await state(backend)).headerReviews).toEqual(applied.headerReviews);
});
