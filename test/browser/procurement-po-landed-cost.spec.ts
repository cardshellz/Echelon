import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { PoShipmentCosts } from "../../shared/procurement/po-shipment-costs";

async function installLandedCosts(page: Page) {
  const failures = await installFixtures(page);
  const state: { value: PoShipmentCosts } = {
    value: {
      summary: {
        currency: "USD",
        shipmentCount: 2,
        chargeCount: 2,
        freightCents: 3000,
        dutyCents: 1500,
        otherCents: 500,
        totalCents: 5000,
        poAmountCents: 35000,
        combinedCostCents: 40000,
        estimatedCents: 0,
        unallocatedChargeCount: 0,
        unsupportedCurrencyCount: 0,
        appliedLines: 3,
        pendingLines: 0,
        reviewLines: 0,
        inventoryCosting: "applied",
      },
      supplier: { freightCents: 0, dutyCents: 0 },
      totals: { freightCents: 3000, dutyCents: 1500, combinedCostCents: 40000 },
      lines: [
        {
          lineId: 100,
          purchaseOrderLineId: 171,
          shipmentId: 42,
          shipmentNumber: "TEST-SEA",
          allocatedCents: 2500,
        },
        {
          lineId: 101,
          purchaseOrderLineId: 172,
          shipmentId: 42,
          shipmentNumber: "TEST-SEA",
          allocatedCents: 1500,
        },
        {
          lineId: 102,
          purchaseOrderLineId: 171,
          shipmentId: 43,
          shipmentNumber: "TEST-AIR",
          allocatedCents: 1000,
        },
      ].map((line) => ({
        ...line,
        shipmentStatus: "closed",
        sku: "SAME-SKU",
        status: "applied",
        applicationId: line.lineId,
        recordedAt: "2026-01-01T00:00:00Z",
        issues: [],
      })),
    },
  };
  await page.route("**/api/purchase-orders/17", (route) =>
    route.fulfill({
      json: {
        ...po(17),
        status: "received",
        physicalStatus: "received",
        currency: "USD",
        subtotalCents: 35000,
        totalCents: 35000,
        lines: [
          {
            id: 171,
            lineNumber: 1,
            productName: "Test product A",
            orderQty: 100,
            unitCostMills: 10000,
            lineTotalCents: 12000,
          },
          {
            id: 172,
            lineNumber: 2,
            productName: "Test product B",
            orderQty: 200,
            unitCostMills: 10000,
            lineTotalCents: 23000,
          },
        ].map((line) => ({
          ...line,
          purchaseOrderId: 17,
          sku: "SAME-SKU",
              receivedQty: line.orderQty,
          status: "received",
          pricingBasis: null,
        })),
      },
    }),
  );
  await page.route("**/api/purchase-orders/17/shipment-costs", (route) =>
    route.fulfill({ json: state.value }),
  );
  return { failures, state };
}

test("shows exact landed totals including packaging and split shipments on desktop and mobile", async ({
  page,
}, info) => {
  const { failures } = await installLandedCosts(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByTestId("po-landed-cost-breakdown")).toContainText(
    "$400.00",
  );
  await expect(page.getByTestId("po-landed-cost-breakdown")).toContainText(
    "Supplier PO $350.00 + shipment charges $50.00",
  );
  const lines = page
    .getByTestId("po-line-landed-total")
    .filter({ visible: true });
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toContainText("$155.00");
  await expect(lines.nth(0)).toContainText("Supplier $120.00");
  await expect(lines.nth(0)).toContainText("Shipment $35.00");
  await expect(lines.nth(1)).toContainText("$245.00");
  await expect(
    page.getByText("$1.550000", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(
    page.getByText("$1.225000", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByText(/Legacy price/)).toHaveCount(0);
  await lines.nth(0).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("po-landed-cost-lines.png") });
  expect(failures).toEqual([]);
});

test("a missing PO line link does not invent a split or hide the known supplier amount", async ({
  page,
}) => {
  const { failures, state } = await installLandedCosts(page);
  state.value.lines[0].purchaseOrderLineId = null;
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(
    page.getByText(
      "Shipment charges are missing a unique purchase order line link.",
    ),
  ).toBeVisible();
  const lines = page
    .getByTestId("po-line-landed-total")
    .filter({ visible: true });
  await expect(lines.nth(0)).toContainText("—");
  await expect(lines.nth(0)).toContainText("Supplier $120.00");
  await expect(lines.nth(0)).not.toContainText("$155.00");
  await expect(page.getByTestId("po-landed-cost-breakdown")).toContainText(
    "$400.00",
  );
  expect(failures).toEqual([]);
});

test("unallocated charges keep the total incomplete rather than presenting a partial landed amount", async ({
  page,
}) => {
  const { state } = await installLandedCosts(page);
  state.value.summary.unallocatedChargeCount = 1;
  state.value.summary.combinedCostCents = null;
  state.value.totals.combinedCostCents = null;
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByTestId("po-landed-cost-breakdown")).toContainText(
    "Incomplete",
  );
  await expect(
    page.getByText(
      "Complete the shipment charge allocation and currency review to calculate landed costs.",
    ),
  ).toBeVisible();
  await expect(page.getByText("$1.550000", { exact: true })).toHaveCount(0);
});
