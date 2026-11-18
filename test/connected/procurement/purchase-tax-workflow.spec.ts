import type { Page } from "@playwright/test";
import { test, expect, login, type Backend } from "./fixtures";

type Row = Record<string, unknown>;
interface TaxWorkflowState {
  taxTypes: Row[]; invoiceTaxes: Row[]; taxApprovals: Row[]; invoices: Row[];
  receipts: Row[]; receivingLines: Row[]; purchaseLines: Row[]; lots: Row[];
  quantityCommands: Row[]; payments: Row[]; receiptCostAttempts: Row[];
}
const state = (backend: Backend) => backend.control<TaxWorkflowState>("workflow-state");

async function approveTaxChange(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason / supporting reference", { exact: true })
    .fill("Verified the connected supplier tax document and treatment");
  await dialog.getByLabel("I reviewed the tax treatment and the cost changes.", { exact: true }).check();
  await dialog.getByRole("button", { name: "Approve & update costs", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Tax change approved and saved.");
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
}

async function receivePurchase(page: Page, backend: Backend, purchaseOrderId: number, expectedPacks: number): Promise<number> {
  await page.goto(backend.url + "/shipments/31");
  await page.getByRole("button", { name: "Create Receipt", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Receive shipment — choose a PO", exact: true });
  await picker.getByTestId("shipment-receive-option-" + purchaseOrderId).getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page).toHaveURL(/\/receiving\?open=\d+/);
  const receiptId = Number(new URL(page.url()).searchParams.get("open"));
  const receiptLines = (await state(backend)).receivingLines.filter(row => Number(row.receiving_order_id) === receiptId);
  expect(receiptLines).toHaveLength(1);
  const line = receiptLines[0], id = Number(line.id);
  expect(Number(line.expected_qty)).toBe(expectedPacks);
  expect(Number(line.units_per_variant_snapshot)).toBe(5);
  await page.getByRole("button", { name: "Start receiving", exact: true }).click();
  const warehouse = page.getByRole("combobox", { name: "Receiving warehouse", exact: true });
  if (await warehouse.isVisible()) { await warehouse.click(); await page.getByRole("option", { name: /MAIN/ }).click(); }
  await page.getByRole("combobox", { name: "Default receiving location", exact: true }).click();
  await page.getByRole("option", { name: /PICK/ }).click();
  await expect.poll(async () => (await state(backend)).receivingLines.find(row => Number(row.id) === id)?.putaway_location_id).toBe(100);
  await page.getByLabel("Received count for line " + id, { exact: true }).filter({ visible: true }).fill(String(expectedPacks));
  await page.getByTestId("btn-complete-line-" + id).filter({ visible: true }).click();
  await expect(page.getByLabel("Received count confirmed for line " + id, { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByTestId("btn-close-receipt").click();
  await expect.poll(async () => (await state(backend)).receipts.find(row => Number(row.id) === receiptId)?.status).toBe("closed");
  return receiptId;
}

test("admin configures tax once, reviews actual invoice tax and receives the saved cost without changing the bill", async ({ page, backend }, info) => {
  const admin = backend.actors.find(actor => actor.id === "connected-admin");
  if (!admin) throw new Error("Missing connected administrator");
  await login(page, backend, admin);
  const original = await state(backend);

  await page.goto(backend.url + "/settings/procurement");
  await page.getByRole("button", { name: "Add tax type", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tax code", { exact: true }).fill("CONNECTED-VAT");
  await dialog.getByLabel("Tax name", { exact: true }).fill("Connected supplier VAT");
  await dialog.getByLabel("How this tax is recorded", { exact: true }).selectOption("recoverable");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Tax code must start with a letter");
  expect((await state(backend)).taxTypes).toEqual([]);
  await dialog.getByLabel("Tax code", { exact: true }).fill("CONNECTED_VAT");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("checkbox")).toBeVisible();
  expect((await state(backend)).taxTypes).toEqual([]);
  await approveTaxChange(page);
  const configured = await state(backend);
  expect(configured.taxTypes).toHaveLength(1);
  expect(configured.taxTypes[0]).toMatchObject({ code: "CONNECTED_VAT", treatment: "recoverable", updated_by: admin.id });
  expect(configured.taxApprovals).toHaveLength(1);

  await page.goto(backend.url + "/ap-invoices/71?tab=lines");
  await page.getByRole("button", { name: "Tax amounts", exact: true }).first().click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Add tax", exact: true }).click();
  await dialog.getByLabel("Tax type", { exact: true }).selectOption(String(configured.taxTypes[0].id));
  await dialog.getByLabel("Tax amount", { exact: true }).fill("5.00");
  await expect(dialog.getByLabel("Product total", { exact: true })).toHaveValue("20.0000");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("table", { name: "Tax changes CONNECTED-GOODS-INVOICE", exact: true }))
    .toContainText("Recoverable tax");
  await expect(dialog.getByRole("table", { name: "Tax changes CONNECTED-PO-A", exact: true })).toHaveCount(0);
  const previewed = await state(backend);
  expect(previewed.invoiceTaxes).toEqual([]);
  expect(previewed.taxApprovals).toEqual(configured.taxApprovals);
  expect(previewed.lots).toEqual(original.lots);
  await page.screenshot({ path: info.outputPath("invoice-tax-before-after.png"), fullPage: true });
  await approveTaxChange(page);
  const approved = await state(backend);
  expect(approved.invoiceTaxes).toHaveLength(1);
  expect(Number(approved.invoiceTaxes[0].amount_mills)).toBe(50_000);
  expect(approved.taxApprovals).toHaveLength(2);
  expect(approved.invoices).toEqual(original.invoices);
  expect(approved.payments).toEqual(original.payments);
  expect(approved.quantityCommands).toEqual(original.quantityCommands);

  await page.goto(backend.url + "/shipments/31");
  await page.getByRole("button", { name: "Delivered", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create Receipt", exact: true })).toBeVisible();
  const firstReceiptId = await receivePurchase(page, backend, 11, 5);
  const secondReceiptId = await receivePurchase(page, backend, 12, 10);
  await expect.poll(async () => (await state(backend)).receiptCostAttempts.map(row => row.state)).toEqual(["applied", "applied"]);
  const received = await state(backend);
  const lots = received.lots.filter(row => [firstReceiptId, secondReceiptId].includes(Number(row.receiving_order_id)));
  expect(lots).toHaveLength(2);
  const taxedLot = lots.find(row => Number(row.po_line_id) === 21);
  expect(taxedLot).toBeDefined();
  expect(Number(taxedLot!.qty_received)).toBe(5);
  expect(Number(taxedLot!.qty_on_hand)).toBe(5);
  expect(Number(taxedLot!.product_total_cost_mills)).toBe(200_000);
  expect(Number(taxedLot!.packaging_total_cost_mills)).toBe(0);
  expect(received.purchaseLines.find(row => Number(row.id) === 21)?.received_qty).toBe(25);
  expect(received.purchaseLines.find(row => Number(row.id) === 22)?.received_qty).toBe(50);
  expect(received.taxTypes).toEqual(configured.taxTypes);
  expect(received.taxApprovals).toEqual(approved.taxApprovals);
  expect(received.invoiceTaxes).toEqual(approved.invoiceTaxes);
  expect(received.invoices).toEqual(original.invoices);
  expect(received.payments).toEqual(original.payments);
  expect(received.receiptCostAttempts.map(row => row.state)).toEqual(["applied", "applied"]);
  await page.goto(backend.url + "/purchase-orders/11?tab=history");
  const history = page.getByRole("region", { name: "Approved tax changes", exact: true });
  await expect(history.locator("summary").first()).toContainText(admin.username);
  await history.locator("summary").first().click();
  await expect(history).toContainText("Verified the connected supplier tax document and treatment");
  await expect(history.getByRole("table", { name: "Tax changes CONNECTED-GOODS-INVOICE", exact: true })).toContainText("Recoverable tax");
});
