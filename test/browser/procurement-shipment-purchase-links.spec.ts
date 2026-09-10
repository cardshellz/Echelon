import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const reference = (id: number) => ({ id, poNumber: `TEST-PO-${id}` });
const shipments = [
  { id: 41, purchaseOrders: [reference(17)] },
  { id: 42, purchaseOrders: [reference(17), reference(99)] },
  { id: 43, purchaseOrders: [reference(17)] },
  { id: 44, purchaseOrders: [] },
].map((shipment) => ({
  ...shipment, shipmentNumber: `TEST-SHIP-${shipment.id}`, status: "booked", mode: "sea_fcl",
  carrierName: "Test carrier", createdAt: "2026-09-01T12:00:00Z", lines: [], costs: [], statusHistory: [],
}));

async function installShipmentFixtures(page: Page) {
  const failures = await installFixtures(page);
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET") {
      failures.push(`Unexpected mutation: ${request.method()} ${request.url()}`);
    }
  });
  await page.route(/\/api\/inbound-shipments\?/, (route) => route.fulfill({ json: { shipments, total: 4 } }));
  await page.route(/\/api\/procurement\/landed-cost-health\?/, (route) => route.fulfill({ json: {
    status: "healthy", scannedShipments: shipments.length, critical: 0, warning: 0,
    counts: { allocationBlockers: 0, allocationWarnings: 0, pendingFinalization: 0, finalizedNotPushed: 0, staleProvisionalLots: 0 },
    items: [],
  } }));
  await page.route(/\/api\/inbound-shipments\/(41|42|43|44)$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/").at(-1));
    return route.fulfill({ json: shipments.find((shipment) => shipment.id === id) });
  });
  await page.route(/\/api\/inbound-shipments\/(41|42|43|44)\/allocation-status$/, (route) => route.fulfill({ json: {
    status: "no_costs", issues: [], costs: [], lineCount: 0, blockerCount: 0, warningCount: 0,
    allocatableCostCount: 0, effectiveCostCents: 0, unallocatedCents: 0,
  } }));
  await page.route(/\/api\/inbound-shipments\/(41|42|43|44)\/invoices$/, (route) => route.fulfill({ json: { invoices: [], summary: { invoiceCount: 0 } } }));
  return failures;
}

test("shipment list shows single, shared and split purchase numbers and links into the selected purchase", async ({ page }) => {
  const failures = await installShipmentFixtures(page);
  await page.goto("/shipments");
  const purchases = (id: number) => page.locator(`[data-testid="shipment-purchases-${id}"]:visible`);
  await expect(purchases(41).getByRole("link", { name: "TEST-PO-17", exact: true })).toBeVisible();
  await expect(purchases(42).getByRole("link")).toHaveCount(2);
  await expect(purchases(43).getByRole("link", { name: "TEST-PO-17", exact: true })).toBeVisible();
  await expect(purchases(44)).toHaveText("No linked purchase orders");
  await expect(purchases(44).getByRole("link")).toHaveCount(0);

  await purchases(42).getByRole("link", { name: "TEST-PO-99", exact: true }).click();
  await expect(page).toHaveURL(/\/purchase-orders\/99\?tab=shipments/);
  await expect(page.getByRole("tab", { name: /^Shipments/ })).toHaveAttribute("data-state", "active");
  await page.getByRole("link", { name: "Back to shipment #42", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "TEST-SHIP-42", exact: true })).toBeVisible();
  await expect(page.getByTestId("shipment-purchase-links").getByRole("link")).toHaveCount(2);
  expect(failures).toEqual([]);
});

test("shipment detail names every purchase and preserves its tab across purchase navigation and reload", async ({ page }) => {
  const failures = await installShipmentFixtures(page);
  await page.goto("/shipments/42?tab=tracking");
  const shipmentUrl = page.url();
  const links = page.getByTestId("shipment-purchase-links");
  await expect(links.getByRole("link", { name: "TEST-PO-17", exact: true })).toBeVisible();
  await links.getByRole("link", { name: "TEST-PO-99", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/purchase-orders\/99\?tab=shipments/);
  await page.reload();
  await page.getByRole("link", { name: "Back to shipment #42", exact: true }).first().click();
  await expect(page).toHaveURL(shipmentUrl);
  await expect(page.getByRole("tab", { name: /^Tracking/ })).toHaveAttribute("data-state", "active");
  await page.goBack();
  await expect(page).toHaveURL(/\/purchase-orders\/99\?tab=shipments/);
  await page.goForward();
  await expect(page.getByRole("tab", { name: /^Tracking/ })).toHaveAttribute("data-state", "active");
  expect(failures).toEqual([]);
});

test("malformed purchase references show an explicit error rather than a fabricated link or empty relationship", async ({ page }) => {
  const failures = await installShipmentFixtures(page);
  await page.route("**/api/inbound-shipments/42", (route) => route.fulfill({ json: {
    ...shipments[1], purchaseOrders: [{ id: "99", poNumber: "TEST-PO-99" }], purchaseOrderId: 17,
  } }));
  await page.goto("/shipments/42");
  const links = page.getByTestId("shipment-purchase-links");
  await expect(links.getByRole("status")).toHaveText("Purchase links unavailable");
  await expect(links.getByRole("link")).toHaveCount(0);
  expect(failures).toEqual([]);
});
