import { expect, test } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { PoShipmentCostSummary } from "../../shared/procurement/po-shipment-cost-summary";

const summary = (): PoShipmentCostSummary => ({
  currency: "USD",
  shipmentCount: 2,
  chargeCount: 6,
  freightCents: 846868,
  dutyCents: 759998,
  otherCents: 23198,
  totalCents: 1630064,
  poAmountCents: 6465550,
  combinedCostCents: 8095614,
  estimatedCents: 44660,
  unallocatedChargeCount: 0,
  unsupportedCurrencyCount: 0,
  appliedLines: 2,
  reviewLines: 5,
  pendingLines: 1,
  inventoryCosting: "review_required",
});

test("shows allocated freight/duties, confirmation and costing problems beside supplier totals", async ({
  page,
}, info) => {
  const failures = await installFixtures(page);
  await page.route("**/api/purchase-orders/17", (route) =>
    route.fulfill({
      json: {
        ...po(17),
        subtotalCents: 6465550,
        totalCents: 6465550,
        shippingCostCents: 0,
        taxCents: 0,
      },
    }),
  );
  await page.route("**/api/purchase-orders/17/shipment-cost-summary", (route) =>
    route.fulfill({ json: summary() }),
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(
    page.getByRole("heading", { name: "Shipment costs", exact: true }),
  ).toBeVisible();
  for (const text of [
    "$8,468.68",
    "$7,599.98",
    "$231.98",
    "$80,956.14",
    "$16,300.64",
  ]) {
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByText("$446.60 is estimated or awaiting confirmation.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(/Inventory costing needs review on 5 shipment lines/),
  ).toBeVisible();
  await expect(
    page.getByText("Supplier PO total", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("po-shipment-costs.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "View shipments", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Shipments", exact: false }),
  ).toHaveAttribute("data-state", "active");
  expect(failures).toEqual([]);
});

test("does not show a complete combined total while allocations are missing", async ({
  page,
}) => {
  await installFixtures(page);
  await page.route("**/api/purchase-orders/17/shipment-cost-summary", (route) =>
    route.fulfill({
      json: {
        ...summary(),
        combinedCostCents: null,
        unallocatedChargeCount: 1,
      },
    }),
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(page.getByText("Incomplete", { exact: true })).toBeVisible();
  await expect(page.getByText(/1 charge needs allocation/)).toBeVisible();
  await expect(page.getByText("$80,956.14", { exact: true })).toHaveCount(0);
});

test("shows a fetch error and allows a successful retry without substituting zero", async ({
  page,
}) => {
  await installFixtures(page);
  let failed = true;
  await page.route("**/api/purchase-orders/17/shipment-cost-summary", (route) =>
    route.fulfill(
      failed
        ? { status: 500, json: { error: "Unavailable" } }
        : { json: summary() },
    ),
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(
    page.getByText("Shipment costs could not be loaded.", { exact: true }),
  ).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("$16,300.64", { exact: true })).toBeVisible();
});

for (const status of ["review_required", "retry_required"] as const) {
  test(`shipment closure exposes ${status} inventory costing`, async ({
    page,
  }) => {
    await installFixtures(page);
    await page.route("**/api/inbound-shipments/42", (route) =>
      route.fulfill({
        json: {
          id: 42,
          shipmentNumber: "TEST-SHIP-42",
          status: "costing",
          mode: "air",
          purchaseOrderId: 17,
          lines: [],
          costs: [],
          statusHistory: [],
        },
      }),
    );
    await page.route("**/api/inbound-shipments/42/close", (route) =>
      route.fulfill({
        json: {
          id: 42,
          status: "closed",
          costApplication:
            status === "retry_required"
              ? { status, code: "SHIPMENT_LOT_COST_PUSH_FAILED" }
              : {
                  status,
                  updated: 0,
                  total: 0,
                  skipped: [
                    {
                      applicationId: 1,
                      reason: "COST_HISTORICAL_QUANTITY_INCOMPLETE",
                      message: "Recorded quantity history needs review.",
                    },
                  ],
                },
        },
      }),
    );
    await page.goto("/shipments/42?tab=lines");
    await page
      .getByRole("button", { name: "Close Shipment", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "Allocation", exact: false }),
    ).toHaveAttribute("data-state", "active");
    await expect(
      page.getByText(
        status === "retry_required"
          ? "The shipment is closed, but its inventory cost update failed. Use Push Costs to Lots to retry."
          : "Recorded quantity history needs review.",
        { exact: true },
      ),
    ).toBeVisible();
  });
}
