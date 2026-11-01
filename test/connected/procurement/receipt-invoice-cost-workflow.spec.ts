import type { Page } from "@playwright/test";
import { test, expect, login, type Backend } from "./fixtures";

type Row = Record<string, unknown>;
interface State {
  receipts: Row[];
  receivingLines: Row[];
  lots: Row[];
  invoices: Row[];
  payments: Row[];
  receiptCostAttempts: Row[];
  receiptCostRequests: Row[];
  receiptInvoiceAllocations: Row[];
  receiptInvoiceApprovals: Row[];
  purchaseLines: Row[];
}
const state = (backend: Backend) => backend.control<State>("workflow-state");

async function receive(page: Page, backend: Backend, shipmentId: number) {
  await page.goto(`${backend.url}/shipments/${shipmentId}`);
  await page.getByRole("button", { name: "Delivered", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create Receipt", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create Receipt", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Receive shipment — choose a PO",
    exact: true,
  });
  await expect
    .poll(
      async () =>
        new URL(page.url()).pathname === "/receiving" ||
        (await picker.isVisible()),
    )
    .toBe(true);
  if (await picker.isVisible())
    await picker
      .getByTestId("shipment-receive-option-11")
      .getByRole("button", { name: "Receive", exact: true })
      .click();
  await expect(page).toHaveURL(/\/receiving\?open=\d+/);
  const receiptId = Number(new URL(page.url()).searchParams.get("open"));
  const [line] = (await state(backend)).receivingLines.filter(
    (row) => Number(row.receiving_order_id) === receiptId,
  );
  expect(line).toMatchObject({
    units_per_variant_snapshot: 5,
    expected_qty: 5,
  });
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  const warehouse = page.getByRole("combobox", {
    name: "Receiving warehouse",
    exact: true,
  });
  if (await warehouse.isVisible()) {
    await warehouse.click();
    await page.getByRole("option", { name: /MAIN/ }).click();
  }
  await page
    .getByRole("combobox", { name: "Default receiving location", exact: true })
    .click();
  await page.getByRole("option", { name: /PICK/ }).click();
  await expect
    .poll(
      async () =>
        (await state(backend)).receivingLines.find((row) => row.id === line.id)
          ?.putaway_location_id,
    )
    .toBe(100);
  await page
    .getByLabel(`Received count for line ${line.id}`, { exact: true })
    .filter({ visible: true })
    .fill("5");
  await page
    .getByTestId(`btn-complete-line-${line.id}`)
    .filter({ visible: true })
    .click();
  await expect(
    page
      .getByLabel(`Received count confirmed for line ${line.id}`, {
        exact: true,
      })
      .filter({ visible: true }),
  ).toBeVisible();
  await page.getByTestId("btn-close-receipt").click();
  await expect
    .poll(
      async () =>
        (await state(backend)).receipts.find(
          (row) => Number(row.id) === receiptId,
        )?.status,
    )
    .toBe("closed");
  return receiptId;
}

test("admin assigns two invoice prices to separate receipts without changing counts or bills", async ({
  page,
  backend,
}, info) => {
  await backend.control("receipt-invoice-workflow", {});
  const admin = backend.actors.find((actor) => actor.id === "connected-admin");
  if (!admin) throw new Error("Connected administrator missing");
  await login(page, backend, admin);
  const original = await state(backend);
  const first = await receive(page, backend, 31),
    second = await receive(page, backend, 32);
  await expect
    .poll(async () => {
      const snapshot = await state(backend);
      const requestIds = new Set(
        snapshot.receiptCostRequests
          .filter((row) => row.purchase_order_line_id === 21)
          .map((row) => row.id),
      );
      return snapshot.receiptCostAttempts
        .filter((row) => requestIds.has(row.request_id))
        .map((row) => row.state);
    })
    .toEqual(["applied", "applied"]);
  const received = await state(backend),
    lots = received.lots.filter((row) => row.po_line_id === 21);
  expect(lots.map((row) => String(row.product_total_cost_mills))).toEqual([
    "250000",
    "250000",
  ]);
  expect(received.receiptInvoiceApprovals).toEqual([]);

  await page.goto(`${backend.url}/ap-invoices/71?tab=lines`);
  await page
    .getByRole("button", { name: "Receipt invoice costs", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Add invoice assignment", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Add invoice assignment", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Pieces covered 1", { exact: true }),
  ).toHaveValue("25");
  await expect(
    dialog.getByLabel("Pieces covered 2", { exact: true }),
  ).toHaveValue("25");
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Reason / supplier reference", { exact: true }),
  ).toBeVisible();
  const receipt = received.receipts.find((row) => Number(row.id) === second)!;
  await expect(
    dialog.getByRole("table", {
      name: `${receipt.receipt_number} before and after`,
      exact: true,
    }),
  ).toContainText("$30.00");
  expect((await state(backend)).receiptInvoiceAllocations).toEqual([]);
  expect((await state(backend)).lots).toEqual(received.lots);
  await dialog.screenshot({
    path: info.outputPath("receipt-invoice-before-after.png"),
  });
  const reason =
    "Checked both received batches against their distinct supplier invoices";
  await dialog
    .getByLabel("Reason / supplier reference", { exact: true })
    .fill(reason);
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Approve & update costs", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Assignment approved and saved",
  );
  const saved = await state(backend),
    savedLots = saved.lots.filter((row) => row.po_line_id === 21);
  expect(savedLots.map((row) => String(row.product_total_cost_mills))).toEqual([
    "250000",
    "300000",
  ]);
  expect(savedLots.map((row) => [row.qty_received, row.qty_on_hand])).toEqual(
    lots.map((row) => [row.qty_received, row.qty_on_hand]),
  );
  expect(saved.invoices).toEqual(original.invoices);
  expect(saved.payments).toEqual(original.payments);
  expect(saved.receiptInvoiceAllocations).toHaveLength(2);
  expect(saved.receiptInvoiceApprovals).toHaveLength(1);
  expect(saved.receivingLines).toEqual(received.receivingLines);
  expect(saved.purchaseLines.find((row) => row.id === 21)?.received_qty).toBe(
    50,
  );
  expect(
    saved.receipts
      .filter((row) => [first, second].includes(Number(row.id)))
      .map((row) => row.status),
  ).toEqual(["closed", "closed"]);

  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.goto(`${backend.url}/purchase-orders/11?tab=history`);
  const history = page.getByRole("region", {
    name: "Approved receipt invoice costs",
    exact: true,
  });
  await expect(history.locator("summary").first()).toContainText(
    admin.username,
  );
  await history.locator("summary").first().click();
  await expect(history).toContainText(reason);
  await expect(
    history.getByRole("table", {
      name: `${receipt.receipt_number} before and after`,
      exact: true,
    }),
  ).toContainText("$30.00");
  expect((await state(backend)).receiptInvoiceApprovals).toEqual(
    saved.receiptInvoiceApprovals,
  );
});
