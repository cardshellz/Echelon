import type { Page } from "@playwright/test";
import { expect, type Backend } from "./fixtures";
type Row = Record<string, unknown>;
const state = (backend: Backend) => backend.control<{ receipts: Row[]; receivingLines: Row[] }>("workflow-state");

export async function receiveShipmentPurchase(page: Page, backend: Backend, shipmentId: number, options: { purchaseOrderId?: number; expectedPacks?: number } = {}) {
  await page.goto(`${backend.url}/shipments/${shipmentId}`);
  const delivered = page.getByRole("button", { name: "Delivered", exact: true });
  await expect.poll(async () => await delivered.isVisible() || await page.getByRole("button", { name: "Create Receipt", exact: true }).isVisible()).toBe(true);
  if (await delivered.isVisible()) await delivered.click();
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
      .getByTestId(`shipment-receive-option-${options.purchaseOrderId ?? 11}`)
      .getByRole("button", { name: "Receive", exact: true })
      .click();
  await expect(page).toHaveURL(/\/receiving\?open=\d+/);
  const receiptId = Number(new URL(page.url()).searchParams.get("open"));
  const [line] = (await state(backend)).receivingLines.filter(
    (row) => Number(row.receiving_order_id) === receiptId,
  );
  expect(line).toMatchObject({
    units_per_variant_snapshot: 5,
    expected_qty: options.expectedPacks ?? 5,
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
    .fill(String(options.expectedPacks ?? 5));
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
