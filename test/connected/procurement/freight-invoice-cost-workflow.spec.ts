import { test, expect, login, type Backend } from "./fixtures";
import { receiveShipmentPurchase } from "./receiving-workflow";

type Row = Record<string, unknown>;
interface State { receipts: Row[]; receivingLines: Row[]; lots: Row[]; invoices: Row[]; payments: Row[];
  paymentAllocations: Row[]; freightCosts: Row[]; freightAllocations: Row[]; freightInvoiceApprovals: Row[]; shipmentLines: Row[] }
const state = (backend: Backend) => backend.control<State>("workflow-state");

test("late freight invoice updates both PO shares and receipt stock with one reviewed admin approval", async ({ page, backend }, info) => {
  await backend.control("freight-invoice-workflow", {});
  const admin = backend.actors.find(actor => actor.id === "connected-admin");
  if (!admin) throw new Error("Connected administrator missing");
  await login(page, backend, admin);
  const first = await receiveShipmentPurchase(page, backend, 31),
    second = await receiveShipmentPurchase(page, backend, 31, { purchaseOrderId: 12, expectedPacks: 10 });
  await page.goto(`${backend.url}/shipments/31`);
  await page.getByRole("button", { name: "Start Costing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close Shipment", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close Shipment", exact: true }).click();
  await expect.poll(async () => (await state(backend)).lots.filter(row => row.receiving_order_id === first || row.receiving_order_id === second)
    .map(row => String(row.landed_total_cost_mills))).toEqual(["50000", "100000"]);
  const original = await state(backend);
  await page.getByRole("tab", { name: /Costs \(/ }).click();
  await page.getByRole("button", { name: "Add Invoice", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Connected freight supplier/ }).click();
  await dialog.getByLabel("Invoice Number *", { exact: true }).fill("CONNECTED-FINAL-FREIGHT");
  await dialog.getByLabel("Invoice amount for charge 61", { exact: true }).fill("18.00");
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const created = await state(backend), invoice = created.invoices.find(row => row.invoice_number === "CONNECTED-FINAL-FREIGHT");
  expect(invoice).toBeDefined(); expect(invoice?.status).toBe("received");
  expect(created.lots).toEqual(original.lots);
  expect(String(created.freightCosts.find(row => row.id === 61)?.actual_cents)).toBe("1500");
  await page.getByRole("link", { name: "Open invoice CONNECTED-FINAL-FREIGHT", exact: true }).click();
  await page.getByRole("button", { name: "Review & approve", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByLabel("Reason / supplier reference", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("table")).toContainText("$15.00");
  await expect(dialog.getByRole("table")).toContainText("$18.00");
  await dialog.getByText("Shipment and PO cost shares", { exact: true }).click();
  await expect(dialog.getByRole("list")).toContainText("CONNECTED-PO-A");
  await expect(dialog.getByRole("list")).toContainText("$6.00");
  await expect(dialog.getByRole("list")).toContainText("CONNECTED-PO-B");
  await expect(dialog.getByRole("list")).toContainText("$12.00");
  expect((await state(backend)).lots).toEqual(created.lots); expect((await state(backend)).freightInvoiceApprovals).toEqual([]);
  await dialog.screenshot({ path: info.outputPath("late-freight-before-after.png") });
  const reason = "Checked the final freight bill for both received PO batches";
  await dialog.getByLabel("Reason / supplier reference", { exact: true }).fill(reason);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Approve & update costs", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Approved cost update", exact: true })).toBeVisible();
  const saved = await state(backend);
  expect(saved.freightInvoiceApprovals).toHaveLength(1);
  expect(saved.lots.filter(row => row.receiving_order_id === first || row.receiving_order_id === second).map(row => String(row.landed_total_cost_mills)))
    .toEqual(["60000", "120000"]);
  expect(saved.lots.map(row => [row.id, row.qty_received, row.qty_on_hand])).toEqual(created.lots.map(row => [row.id, row.qty_received, row.qty_on_hand]));
  expect(saved.receivingLines).toEqual(created.receivingLines); expect(saved.shipmentLines.map(row => [row.id, row.qty_shipped, row.carton_count]))
    .toEqual(created.shipmentLines.map(row => [row.id, row.qty_shipped, row.carton_count]));
  expect(saved.payments).toEqual(created.payments); expect(saved.paymentAllocations).toEqual(created.paymentAllocations);
  expect(saved.invoices.find(row => row.id === invoice!.id)).toMatchObject({ status: "approved", invoiced_amount_cents: 1800, paid_amount_cents: 0, balance_cents: 1800 });
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.goto(`${backend.url}/purchase-orders/11?tab=history`);
  const history = page.getByRole("region", { name: "Approved freight invoice costs", exact: true });
  await expect(history).toContainText("CONNECTED-FINAL-FREIGHT");
  await history.locator("summary").filter({ hasText: "CONNECTED-FINAL-FREIGHT" }).click(); await expect(history).toContainText(reason);
  await expect(history.getByRole("table")).toContainText("$18.00");
  expect((await state(backend)).freightInvoiceApprovals).toEqual(saved.freightInvoiceApprovals);
});
