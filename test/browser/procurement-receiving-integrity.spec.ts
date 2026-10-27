import { expect, test, type Page } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";
import { openReceivingLineOptions, openReceivingSetup } from "./procurement-receiving-helpers";

const locations = [
  { id: 5, code: "RCV-01", name: "Receiving one", warehouseId: 1, isActive: 1, locationType: "receiving" },
  { id: 6, code: "RCV-02", name: "Receiving two", warehouseId: 1, isActive: 1, locationType: "receiving" },
  { id: 8, code: "OTHER-01", name: "Other warehouse", warehouseId: 2, isActive: 1, locationType: "receiving" },
];
type Options = { warehouseFailure?: "rejected" | "lost"; close?: "source" | "cached_error" | "cost_pending"; delayDefault?: boolean };

async function setup(page: Page, options: Options = {}) {
  const failures = await installFixtures(page);
  const line = (id: number, putawayLocationId: number | null) => ({
    id, receivingOrderId: 31, sku: `REVIEW-${id}`, productName: `Review product ${id}`, productId: 10, productVariantId: 2,
    unitsPerVariantSnapshot: 1, unitVersion: "a".repeat(64), expectedQty: 2, receivedQty: 2, damagedQty: 0,
    status: "complete", putawayLocationId, putawayComplete: 0, unitCost: 25, notes: null, purchaseOrderLineId: 9,
  });
  const state = {
    order: { ...receipt(31), sourceType: "po", inboundShipmentId: null, status: "open", warehouseId: 1,
      receivingLocationId: 5 as number | null, lines: [line(7, options.warehouseFailure === "lost" ? null : 5), line(8, options.close ? 5 : null)] },
    writes: [] as Array<{ path: string; body: Record<string, unknown> }>,
    reads: 0,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/receiving/31") { state.reads++; return route.fulfill({ json: state.order }); }
      if (path === "/api/warehouse/locations") return route.fulfill({ json: locations });
      if (path === "/api/warehouses") return route.fulfill({ json: [
        { id: 1, code: "W1", name: "Main" }, { id: 2, code: "W2", name: "Other" },
      ] });
      if (path === "/api/product-variants") return route.fulfill({ json: [{ id: 2, sku: "EACH", name: "Piece", productId: 10, unitsPerVariant: 1 }] });
      return route.fallback();
    }
    if (path === "/api/receiving/31" && request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ path, body });
      if (body.warehouseId && options.warehouseFailure === "rejected") return route.fulfill({ status: 409, json: {
        error: "Receipt locations require review.", code: "RECEIVING_CLOSE_INTEGRITY_REVIEW_REQUIRED",
        issues: [{ receivingLineId: 7, code: "RECEIVING_LOCATION_WAREHOUSE_MISMATCH", message: "Clear or review the existing location before changing warehouse." }],
      } });
      if (body.applyDefaultToUnassigned === true && options.delayDefault) await gate;
      if (typeof body.warehouseId === "number") state.order.warehouseId = body.warehouseId;
      if (body.receivingLocationId === null || typeof body.receivingLocationId === "number") state.order.receivingLocationId = body.receivingLocationId;
      if (body.applyDefaultToUnassigned === true) state.order.lines = state.order.lines.map((item) => item.putawayLocationId === null
        ? { ...item, putawayLocationId: state.order.receivingLocationId, unitVersion: "b".repeat(64) } : item);
      if (body.warehouseId && options.warehouseFailure === "lost") return route.abort("connectionreset");
      return route.fulfill({ json: state.order });
    }
    if (path === "/api/receiving/31/close") {
      state.writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      if (options.close === "source") return route.fulfill({ status: 409, json: {
        error: "Receipt source requires review.", code: "RECEIVING_CLOSE_INTEGRITY_REVIEW_REQUIRED",
        issues: [{ receivingLineId: 7, code: "RECEIVING_SOURCE_UNMATCHED", message: "This product has no matching purchase order line." }],
      } });
      if (options.close === "cached_error") return route.fulfill({ status: 200, json: { error: "Source still needs review" } });
      return route.fulfill({ json: { success: true, order: { id: 31, status: "closed" }, unitsReceived: 4, linesProcessed: 2,
        costReconciliation: { state: "retry_required", requests: [] } } });
    }
    return route.fallback();
  });
  await page.goto("/receiving?open=31");
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await openReceivingSetup(page);
  await openReceivingLineOptions(page, 7);
  await openReceivingLineOptions(page, 8);
  return { state, failures, release };
}

const warehouse = (page: Page) => page.getByRole("combobox", { name: "Receiving warehouse", exact: true });
const lineLocations = (page: Page) => page.getByRole("combobox", { name: /^Location for line / }).filter({ visible: true });
const savedLineLocation = (page: Page, lineId: number) => page.getByTestId(`receipt-line-options-${lineId}`).locator("summary");

test("default location fills only unassigned lines with one atomic command", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.getByRole("combobox", { name: "Default receiving location" }).click();
  await page.getByRole("option", { name: /RCV-02/ }).click();
  await expect.poll(() => state.reads).toBeGreaterThan(1);
  await expect(savedLineLocation(page, 7)).toContainText("RCV-01");
  await expect(savedLineLocation(page, 8)).toContainText("RCV-02");
  expect(state.writes).toEqual([{ path: "/api/receiving/31", body: { receivingLocationId: 6, applyDefaultToUnassigned: true } }]);
  expect(failures).toEqual([]);
});

test("failed warehouse save preserves the confirmed warehouse and explains the conflict", async ({ page }) => {
  const { state, failures } = await setup(page, { warehouseFailure: "rejected" });
  await warehouse(page).click();
  await page.getByRole("option", { name: "Other (W2)", exact: true }).click();
  await expect(page.getByText("Receipt settings were not confirmed", { exact: true })).toBeVisible();
  await expect(warehouse(page)).toContainText("Main (W1)");
  await expect(page.getByRole("alert").filter({ hasText: "Clear or review the existing location" })).toBeVisible();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  expect(state.order.warehouseId).toBe(1);
  expect(failures).toEqual([]);
});

test("lost warehouse response requires readback before further receiving", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { warehouseFailure: "lost" });
  await warehouse(page).click();
  await page.getByRole("option", { name: "Other (W2)", exact: true }).click();
  await expect(page.getByText("Receipt settings were not confirmed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("btn-add-line")).toBeDisabled();
  await expect(warehouse(page)).toContainText("Main (W1)");
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  if (testInfo.project.name === "mobile") {
    const defaults = page.getByRole("button", { name: "Use default (RCV-01)", exact: true });
    await expect(defaults).toHaveCount(2);
    await expect(defaults.nth(0)).toBeDisabled();
    await expect(defaults.nth(1)).toBeDisabled();
  }
  await page.getByRole("button", { name: "Load latest receipt and discard unsaved counts" }).click();
  await expect(page.locator('summary[aria-label="Receiving setup"]')).toContainText("Other");
  await openReceivingSetup(page);
  await expect(warehouse(page)).toContainText("Other (W2)");
  expect(state.order.warehouseId).toBe(2);
  expect(state.writes).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("line location choices stay within the receipt warehouse on both layouts", async ({ page }) => {
  const { failures } = await setup(page);
  await lineLocations(page).nth(0).click();
  await expect(page.getByRole("option", { name: /RCV-02/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /OTHER-01/ })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("source rejection remains on the receipt with a persistent actionable explanation", async ({ page }) => {
  const { failures } = await setup(page, { close: "source" });
  await page.getByTestId("btn-close-receipt").click();
  await expect(page.getByRole("alert").filter({ hasText: "This product has no matching purchase order line." })).toBeVisible();
  await expect(page).toHaveURL(/receiving\?open=31$/);
  await expect(page.getByText("Receipt closed — inventory updated", { exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("an HTTP success containing an error cannot show receipt completion", async ({ page }) => {
  const { failures } = await setup(page, { close: "cached_error" });
  await page.getByTestId("btn-close-receipt").click();
  await expect(page.getByRole("alert").filter({ hasText: "close outcome could not be verified" })).toBeVisible();
  await expect(page).toHaveURL(/receiving\?open=31$/);
  await expect(page.getByText("Receipt closed — inventory updated", { exact: true })).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("physical close with pending costs says what remains unfinished", async ({ page }) => {
  const { failures } = await setup(page, { close: "cost_pending" });
  await page.getByTestId("btn-close-receipt").click();
  await expect(page.getByText("Inventory received — costs unfinished", { exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("a pending default save cannot discard a newly edited count", async ({ page }, testInfo) => {
  const { state, release, failures } = await setup(page, { delayDefault: true });
  await page.getByRole("combobox", { name: "Default receiving location" }).click();
  await page.getByRole("option", { name: /RCV-02/ }).click();
  await expect(page.locator('input[aria-label="Received count for line 7"]:visible')).toBeDisabled();
  await expect(page.getByTestId("btn-add-line")).toBeDisabled();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  if (testInfo.project.name === "mobile") {
    await expect(page.getByRole("button", { name: "Use default (RCV-01)", exact: true })).toBeDisabled();
  }
  expect(state.writes).toHaveLength(1);
  release();
  await expect(savedLineLocation(page, 8)).toContainText("RCV-02");
  expect(failures).toEqual([]);
});

test("an unsaved count must be resolved before changing the default", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.locator('input[aria-label="Received count for line 7"]:visible').fill("3");
  await expect(page.getByRole("combobox", { name: "Default receiving location" })).toBeDisabled();
  expect(state.writes).toEqual([]);
  expect(failures).toEqual([]);
});


test("the receipt list offers discard only for drafts and preserves a concurrent-start rejection", async ({ page }) => {
  const failures = await installFixtures(page);
  const orders = [
    { ...receipt(31), status: "draft", receivedTotalUnits: 0 },
    { ...receipt(32), status: "open" },
    { ...receipt(33), status: "closed" },
  ];
  const writes: string[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/receiving") return route.fulfill({ json: orders });
    if (request.method() === "DELETE") {
      writes.push(path);
      return route.fulfill({ status: 409, json: { error: "Cannot discard a started receipt", code: "RECEIVING_DISCARD_STARTED" } });
    }
    return route.fallback();
  });
  await page.goto("/receiving");
  const discard = page.getByRole("button", { name: "Discard draft TEST-RECEIPT-31" }).filter({ visible: true });
  await expect(discard).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Discard draft TEST-RECEIPT-32" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard draft TEST-RECEIPT-33" })).toHaveCount(0);
  page.once("dialog", dialog => dialog.accept());
  await discard.click();
  await expect(page.getByText("Cannot discard a started receipt", { exact: true })).toBeVisible();
  await expect(discard).toBeVisible();
  await expect(page.getByText("Receipt discarded", { exact: true })).toHaveCount(0);
  expect(writes).toEqual(["/api/receiving-orders/31/discard"]);
  expect(failures).toEqual([]);
});
