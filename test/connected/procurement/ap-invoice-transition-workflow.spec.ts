import { receiveShipmentPurchase } from "./receiving-workflow";
import { test, expect, login } from "./fixtures";
type Row = Record<string, unknown>;
interface State {
  invoices: Row[]; invoiceLines: Row[]; lots: Row[]; receivingLines: Row[]; transactions: Row[];
  shipments: Row[]; shipmentLines: Row[]; payments: Row[]; paymentAllocations: Row[];
  invoiceTransitionReviews: Row[]; historicalCostPostings: Row[]; orderCosts: Row[];
  receiptCostRequests: Row[]; receiptCostAttempts: Row[];
}

test("AP approval, dispute, restored approval and void share the reviewed costing flow across two purchases", async ({ page, backend }, info) => {
  await backend.control("seed-ap-transition-workflow", {});
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
  const first = before.lots.find(row => row.po_line_id === 21), second = before.lots.find(row => row.po_line_id === 22);
  if (!first || !second) throw new Error("Both receipt lots are required");
  expect(String(first.product_total_cost_mills)).toBe("250000");
  await page.goto(`${backend.url}/ap-invoices/71?tab=lines`);
  let originalApproval: { approved_by: unknown; approved_at: unknown } | null = null;
  for (const [index, action, beforeValue, afterValue] of [[0, "Approve", "25.0000 USD", "30.0000 USD"],
    [1, "Dispute", "30.0000 USD", "25.0000 USD"], [2, "Approve", "25.0000 USD", "30.0000 USD"],
    [3, "Void", "30.0000 USD", "25.0000 USD"]] as const) {
    const start = await backend.control<State>("workflow-state");
    await page.getByRole("button", { name: action, exact: true }).click();
    const dialog = page.getByRole("dialog");
    if (action !== "Approve") await dialog.getByLabel("Reason / supplier reference", { exact: true }).fill(`Verified supplier ${action.toLowerCase()} source for this test.`);
    await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
    const row = dialog.getByRole("row").filter({ hasText: String(first.lot_number) });
    await expect(row).toContainText(beforeValue); await expect(row).toContainText(afterValue);
    await expect(dialog.getByRole("row").filter({ hasText: String(second.lot_number) })).toContainText("50.0000 USD");
    expect(await backend.control<State>("workflow-state")).toEqual(start);
    if (index === 0) await page.screenshot({ path: info.outputPath("invoice-approval-before-after.png"), fullPage: true });
    await dialog.getByRole("button", { name: `${action} invoice`, exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("Saved by");
    const saved = await backend.control<State>("workflow-state");
    expect(saved.invoiceTransitionReviews).toHaveLength(index + 1);
    for (const field of ["invoiceLines", "receivingLines", "transactions", "shipments", "shipmentLines", "payments", "paymentAllocations", "historicalCostPostings", "orderCosts"] as const)
      expect(saved[field]).toEqual(before[field]);
    const other = saved.lots.find(row => row.id === second.id)!;
    for (const field of ["product_total_cost_mills", "packaging_total_cost_mills", "landed_total_cost_mills", "qty_received", "qty_on_hand", "product_variant_id", "warehouse_location_id"])
      expect(other[field]).toEqual(second[field]);
    expect(saved.lots.find(row => row.id === first.id)?.qty_on_hand).toEqual(first.qty_on_hand);
    expect(saved.invoices.find(row => row.id === 71)).toMatchObject({ invoiced_amount_cents: 8000, paid_amount_cents: 0 });
    const invoice = saved.invoices.find(row => row.id === 71)!;
    if (originalApproval) expect(invoice).toMatchObject(originalApproval);
    else originalApproval = { approved_by: invoice.approved_by, approved_at: invoice.approved_at };
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("region", { name: "Invoice approval history", exact: true }).locator("details")).toHaveCount(index + 1);
  }
  const history = await page.request.get(`${backend.url}/api/vendor-invoices/71/transition-history`);
  expect(history.ok()).toBe(true); expect(await history.json()).toHaveLength(4);
});
