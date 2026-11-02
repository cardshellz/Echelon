import { receiveShipmentPurchase } from "./receiving-workflow";
import { test, expect, login } from "./fixtures";

type Row = Record<string, unknown>;
interface State {
  receivingLines: Row[]; lots: Row[]; invoices: Row[]; invoiceLines: Row[];
  payments: Row[]; paymentAllocations: Row[]; supplierCostApprovals: Array<Row & { payload_json: Row }>;
  transactions: Row[]; quantityCommands: Row[]; commands: Row[];
  receiptCostRequests: Row[]; receiptCostAttempts: Row[];
  historicalCostPostings: Row[]; orderCosts: Row[];
}

test("one reviewed supplier split updates stock components and retains the approval without changing bills or counts", async ({ page, backend }, info) => {
  const actor = backend.actors.find(row => row.id === "connected-admin");
  if (!actor) throw new Error("Connected administrator missing");
  await login(page, backend, actor);
  await receiveShipmentPurchase(page, backend, 31);
  await receiveShipmentPurchase(page, backend, 31, { purchaseOrderId: 12, expectedPacks: 10 });
  await expect.poll(async () => {
    const state = await backend.control<State>("workflow-state");
    const requests = new Set(state.receiptCostRequests.filter(row => [21, 22].includes(Number(row.purchase_order_line_id))).map(row => row.id));
    return state.receiptCostAttempts.filter(row => requests.has(row.request_id)).map(row => row.state);
  }).toEqual(["applied", "applied"]);
  const before = await backend.control<State>("workflow-state");
  const source = before.invoiceLines.find(row => row.vendor_invoice_id === 71 && row.purchase_order_line_id === 21);
  if (!source) throw new Error("Connected supplier invoice line missing");
  const ownedLots = before.lots.filter(row => row.po_line_id === 21);
  expect(ownedLots).toHaveLength(1);
  expect(before.lots.filter(row => row.po_line_id === 22)).toHaveLength(1);
  expect(String(ownedLots[0].product_total_cost_mills)).toBe("250000");
  expect(String(ownedLots[0].packaging_total_cost_mills)).toBe("0");
  await page.goto(`${backend.url}/ap-invoices/71?tab=lines`);
  await page.getByRole("button", { name: "Review costs for PACK", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Is packaging included in the product price?", { exact: true }).click();
  await page.getByRole("option", { name: "No, packaging is charged separately", exact: true }).click();
  await dialog.getByLabel(/^Product total/).fill("20.0000");
  await dialog.getByLabel(/^Packaging total/).fill("5.0000");
  await dialog.getByLabel(/^Other adjustments/).fill("0");
  await dialog.getByLabel("Notes / supplier invoice reference", { exact: true }).fill("Supplier confirms $20 goods and $5 packaging for this receipt.");
  await dialog.getByRole("button", { name: "Review cost changes", exact: true }).click();
  const review = dialog.getByRole("region", { name: "Supplier cost changes", exact: true });
  await expect(review.getByRole("row", { name: /Product amount/ })).toContainText("25.0000 USD");
  await expect(review.getByRole("row", { name: /Product amount/ })).toContainText("20.0000 USD");
  await expect(review.getByRole("row", { name: /Packaging amount/ })).toContainText("5.0000 USD");
  await expect(review.getByRole("row", { name: /stock units on hand/ })).toHaveCount(2);
  await expect(review.getByRole("row").filter({ hasText: String(ownedLots[0].lot_number) })).toContainText("25.0000 USD");
  const otherLot = before.lots.find(row => row.po_line_id === 22)!;
  await expect(review.getByRole("row").filter({ hasText: String(otherLot.lot_number) })).toContainText("50.0000 USD");
  expect(await backend.control<State>("workflow-state")).toEqual(before);
  await page.screenshot({ path: info.outputPath("supplier-cost-before-after.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Approve and apply costs", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Supplier amounts saved. The invoice total is unchanged.");
  const after = await backend.control<State>("workflow-state");
  expect(after.invoices).toEqual(before.invoices);
  expect(after.payments).toEqual(before.payments); expect(after.paymentAllocations).toEqual(before.paymentAllocations);
  expect(after.historicalCostPostings).toEqual(before.historicalCostPostings); expect(after.historicalCostPostings).toEqual([]);
  // The cutover base fixture already contains order cost #9 for unrelated lot
  // #4, including integers beyond JS's safe range. Preserve its exact strings;
  // neither of these newly received lots has a sale or order-cost assignment.
  expect(before.orderCosts).toEqual([expect.objectContaining({ id: 9, unit_cost_mills: "9007199254740995", total_cost_mills: "18014398509481990" })]);
  expect(after.orderCosts).toEqual(before.orderCosts);
  const receiptLotIds = new Set(before.lots.filter(row => [21, 22].includes(Number(row.po_line_id))).map(row => row.id));
  expect(after.orderCosts.filter(row => receiptLotIds.has(row.inventory_lot_id))).toEqual([]);
  expect(after.invoiceLines.filter(row => row.id !== source.id)).toEqual(before.invoiceLines.filter(row => row.id !== source.id));
  const savedLine = after.invoiceLines.find(row => row.id === source.id)!;
  expect(savedLine.qty_invoiced).toEqual(source.qty_invoiced); expect(savedLine.line_total_cents).toEqual(source.line_total_cents);
  const receivedCounts = (lines: Row[]) => lines.map(row => ({ id: row.id, received: row.received_qty, damaged: row.damaged_qty,
    variant: row.product_variant_id, piecesPerUnit: row.units_per_variant_snapshot, location: row.putaway_location_id, status: row.status }));
  expect(receivedCounts(after.receivingLines)).toEqual(receivedCounts(before.receivingLines)); expect(after.transactions).toEqual(before.transactions);
  expect(after.quantityCommands).toEqual(before.quantityCommands);
  expect(after.lots.filter(row => row.po_line_id !== 21)).toEqual(before.lots.filter(row => row.po_line_id !== 21));
  const posted = after.lots.find(row => row.id === ownedLots[0].id)!;
  expect(posted.qty_on_hand).toEqual(ownedLots[0].qty_on_hand);
  expect(String(posted.product_total_cost_mills)).toBe("200000"); expect(String(posted.packaging_total_cost_mills)).toBe("50000");
  expect(posted.landed_total_cost_mills).toEqual(ownedLots[0].landed_total_cost_mills);
  expect(after.supplierCostApprovals).toHaveLength(1);
  expect(after.supplierCostApprovals[0]).toMatchObject({ po_id: 11, actor_id: actor.id, payload_json: {
    actorName: expect.any(String), approvedAt: expect.any(String), reason: "Supplier confirms $20 goods and $5 packaging for this receipt.",
    preview: { before: { productMills: 250000, packagingMills: 0 }, after: { productMills: 200000, packagingMills: 50000 } },
  } });
  const readback = await page.request.get(`${backend.url}/api/vendor-invoices/71`);
  expect(readback.ok()).toBe(true);
  const invoice = await readback.json() as { lines: Array<{ id: number; costComponentEvidence: unknown }> };
  expect(invoice.lines.find(row => row.id === source.id)?.costComponentEvidence).toMatchObject({ productMills: 200000, packagingMills: 50000 });
  expect((await backend.control<State>("workflow-state")).supplierCostApprovals).toEqual(after.supplierCostApprovals);
});
