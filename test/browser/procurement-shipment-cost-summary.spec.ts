import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import type { PoShipmentCosts } from "../../shared/procurement/po-shipment-costs";

const uniformIssue = {
  code: "COST_UNIFORM_LOT_RESIDUAL_REVIEW",
  message: "The earlier attempt could not distribute the exact charge.",
};
const costs = (): PoShipmentCosts => ({
  summary: {
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
    appliedLines: 1,
    reviewLines: 5,
    pendingLines: 2,
    inventoryCosting: "review_required",
  },
  supplier: { freightCents: 0, dutyCents: 0 },
  totals: {
    freightCents: 846868,
    dutyCents: 759998,
    combinedCostCents: 8095614,
  },
  lines: [
    ...[119072, 200000, 330000, 166124, 190324].map(
      (allocatedCents, index) => ({
        lineId: 101 + index,
        shipmentId: 42,
        shipmentNumber: "TEST-SEA-42",
        shipmentStatus: "closed",
        sku: `TEST-SKU-${index + 1}`,
        allocatedCents,
        status: "review_required" as const,
        applicationId: 201 + index,
        recordedAt: "2026-10-13T11:18:59.298Z",
        issues: [uniformIssue],
      }),
    ),
    {
      lineId: 106,
      shipmentId: 42,
      shipmentNumber: "TEST-SEA-42",
      shipmentStatus: "closed",
      sku: "TEST-SKU-6",
      allocatedCents: 579884,
      status: "applied",
      applicationId: 206,
      recordedAt: "2026-10-13T11:18:59.298Z",
      issues: [],
    },
    ...[107, 108].map((lineId) => ({
      lineId,
      shipmentId: 43,
      shipmentNumber: "TEST-AIR-43",
      shipmentStatus: "closed",
      sku: `TEST-AIR-${lineId}`,
      allocatedCents: 22330,
      status: "pending" as const,
      applicationId: null,
      recordedAt: null,
      issues: [
        {
          code: "COST_UPDATE_NOT_RECORDED",
          message:
            "No inventory cost update has been recorded for this shipment line.",
        },
      ],
    })),
  ],
});

async function installCostFixtures(page: Page, approver = true) {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "test-user",
          username: "test",
          role: approver ? "admin" : "lead",
        },
        permissions: approver
          ? ["purchasing:view", "purchasing:approve"]
          : ["purchasing:view"],
        roles: approver ? ["admin"] : ["lead"],
      },
    }),
  );
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
  const state = { value: costs() };
  await page.route("**/api/purchase-orders/17/shipment-costs", (route) =>
    route.fulfill({ json: state.value }),
  );
  return { failures, state };
}

test("shows freight, duties and total cost in the actual summary cards", async ({
  page,
}) => {
  const { failures } = await installCostFixtures(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(
    page
      .getByTestId("po-freight-summary-card")
      .getByText("$8,468.68", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("po-duty-summary-card")
      .getByText("$7,599.98", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("po-total-cost-summary-card")
      .getByText("$80,956.14", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("po-total-cost-summary-card")).toContainText(
    "Supplier PO: $64,655.50",
  );
  await expect(
    page.getByText("$446.60 is estimated or awaiting confirmation.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("$231.98", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "View shipments", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Shipments", exact: false }),
  ).toHaveAttribute("data-state", "active");
  expect(failures).toEqual([]);
});

test("keeps combined cards incomplete when an allocation is missing", async ({
  page,
}) => {
  const { state } = await installCostFixtures(page);
  state.value.summary.combinedCostCents = null;
  state.value.summary.unallocatedChargeCount = 1;
  state.value.totals = {
    freightCents: null,
    dutyCents: null,
    combinedCostCents: null,
  };
  await page.goto("/purchase-orders/17?tab=lines");
  for (const card of [
    "po-freight-summary-card",
    "po-duty-summary-card",
    "po-total-cost-summary-card",
  ]) {
    await expect(
      page.getByTestId(card).getByText("Incomplete", { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByText(/1 charge needs allocation/)).toBeVisible();
  await expect(page.getByText("$80,956.14", { exact: true })).toHaveCount(0);
});

test("shows unavailable cards during a read failure and allows retry", async ({
  page,
}) => {
  await installCostFixtures(page);
  let failed = true;
  await page.route("**/api/purchase-orders/17/shipment-costs", (route) =>
    route.fulfill(
      failed
        ? { status: 500, json: { error: "Unavailable" } }
        : { json: costs() },
    ),
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await expect(
    page.getByText("Shipment costs could not be loaded.", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("po-freight-summary-card")
      .getByText("Unavailable", { exact: true }),
  ).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page
      .getByTestId("po-freight-summary-card")
      .getByText("$8,468.68", { exact: true }),
  ).toBeVisible();
});

test("identifies all five affected SKUs, recorded reasons and the next step", async ({
  page,
}, info) => {
  const { failures } = await installCostFixtures(page);
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 5 lines", exact: true })
    .click();
  const group = page.getByRole("group", {
    name: "Cost review for shipment TEST-SEA-42",
  });
  for (let index = 1; index <= 5; index++)
    await expect(
      group.getByText(`TEST-SKU-${index}`, { exact: true }),
    ).toBeVisible();
  await expect(
    group
      .getByText(
        "The earlier cost update could not distribute the charge exactly across the received units.",
      )
      .first(),
  ).toBeVisible();
  await expect(
    group.getByRole("button", {
      name: "Retry inventory cost update",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    group.getByRole("link", { name: "Open shipment allocation", exact: true }),
  ).toHaveAttribute("href", "/shipments/42?tab=allocation");
  await group
    .getByText("Cost review details · line #101", { exact: true })
    .click();
  await expect(
    group.getByText(uniformIssue.message, { exact: false }).first(),
  ).toBeVisible();
  await group
    .getByText("Cost review details · line #101", { exact: true })
    .click();
  await page
    .getByTestId("po-total-cost-summary-card")
    .locator("..")
    .screenshot({
      path: info.outputPath("po-cost-summary-cards.png"),
    });
  await page.screenshot({
    path: info.outputPath("po-cards-cost-review.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(failures).toEqual([]);
});

test("allows viewers to inspect reasons but reserves retry for purchasing approvers", async ({
  page,
}) => {
  const { failures } = await installCostFixtures(page, false);
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 5 lines", exact: true })
    .click();
  await expect(page.getByText("TEST-SKU-1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Retry inventory cost update",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page
      .getByText(
        "A user with purchasing approval permission can retry this cost update.",
      )
      .first(),
  ).toBeVisible();
  expect(failures).toEqual([]);
});

test("retries through the existing owner and replaces old warnings from persisted results", async ({
  page,
}) => {
  const { failures, state } = await installCostFixtures(page);
  let attempts = 0;
  await page.route(
    "**/api/inbound-shipments/42/push-costs-to-lots",
    (route) => {
      attempts++;
      state.value.lines = state.value.lines.map((line) =>
        line.shipmentId === 42
          ? {
              ...line,
              status: "applied",
              issues: [],
              recordedAt: "2026-10-14T12:00:00Z",
            }
          : line,
      );
      state.value.summary = {
        ...state.value.summary,
        reviewLines: 0,
        appliedLines: 6,
        inventoryCosting: "pending",
      };
      return route.fulfill({
        json: { status: "applied", updated: 5, total: 6, skipped: [] },
      });
    },
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 5 lines", exact: true })
    .click();
  expect(attempts).toBe(0);
  await page
    .getByRole("group", { name: "Cost review for shipment TEST-SEA-42" })
    .getByRole("button", { name: "Retry inventory cost update", exact: true })
    .click();
  await expect(page.getByText("TEST-SKU-1", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      "Inventory cost update completed. Check the latest recorded line results below.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("TEST-AIR-107", { exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  expect(failures).toEqual([]);
});

test("shows the new remaining reason when a retry only fixes some lines", async ({
  page,
}) => {
  const { state } = await installCostFixtures(page);
  const newIssue = {
    code: "COST_HISTORICAL_QUANTITY_INCOMPLETE",
    message: "The recorded receipt quantity still needs review.",
  };
  await page.route(
    "**/api/inbound-shipments/42/push-costs-to-lots",
    (route) => {
      state.value.lines = state.value.lines.map((line) =>
        line.lineId === 101
          ? { ...line, issues: [newIssue] }
          : line.shipmentId === 42
            ? { ...line, status: "applied", issues: [] }
            : line,
      );
      state.value.summary = {
        ...state.value.summary,
        reviewLines: 1,
        appliedLines: 5,
      };
      return route.fulfill({
        json: {
          status: "review_required",
          updated: 4,
          total: 5,
          skipped: [
            {
              applicationId: 201,
              reason: newIssue.code,
              message: newIssue.message,
            },
          ],
        },
      });
    },
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 5 lines", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Cost review for shipment TEST-SEA-42" })
    .getByRole("button", { name: "Retry inventory cost update", exact: true })
    .click();
  await expect(page.getByText(newIssue.message, { exact: true })).toBeVisible();
  await expect(
    page.getByText(/1 shipment line has a recorded cost update/),
  ).toBeVisible();
  await expect(
    page.getByText(
      "All confirmed shipment costs have been applied to inventory.",
      { exact: true },
    ),
  ).toHaveCount(0);
});

test("keeps the exact unresolved portions visible after reloading the PO", async ({ page }) => {
  const { state } = await installCostFixtures(page);
  const messages = [
    "Lot TEST-CASE: 4 case units remain unexplained. 60.9104 USD is retained separately. Known inventory and order costs were updated; stock counts were not changed.",
    "Lot TEST-BOX: 1 box unit remains unexplained. 0.7614 USD is retained separately. Known inventory and order costs were updated; stock counts were not changed.",
  ];
  state.value.lines = state.value.lines.map(line => line.lineId === 101 ? { ...line, issues: messages.map((message,index) => ({
    code:"COST_UNRESOLVED_QUANTITY_RETAINED",message,
    unresolvedQuantity:{inventoryLotId:index === 0 ? 3364 : 4016,allocationId:index+1,lotNumber:index === 0 ? "TEST-CASE" : "TEST-BOX",
      originalQuantity:index === 0 ? 220 : 20,onHandQuantityAtReview:index === 0 ? 157 : 0,
      recordedOutflowQuantityAtReview:index === 0 ? 59 : 19,quantity:index === 0 ? 4 : 1,
      component:"landed" as const,amountMills:index === 0 ? 609104 : 7614},
  })) } : line.shipmentId === 42 ? {...line,status:"applied",issues:[]} : line);
  state.value.summary = {...state.value.summary,reviewLines:1,appliedLines:5};
  await page.goto("/purchase-orders/17?tab=lines");
  for (let visit=0;visit<2;visit++) {
    if (visit>0) await page.reload();
    await page.getByRole("button",{name:"Review 1 line",exact:true}).click();
    for (const message of messages) await expect(page.getByText(message,{exact:true})).toBeVisible();
    await expect(page.getByText(/retrying will not resolve it or change stock counts/)).toBeVisible();
    await expect(page.getByText("All confirmed shipment costs have been applied to inventory.",{exact:true})).toHaveCount(0);
  }
});

test("retains the recorded failures when a retry is denied", async ({
  page,
}) => {
  await installCostFixtures(page);
  await page.route("**/api/inbound-shipments/42/push-costs-to-lots", (route) =>
    route.fulfill({
      status: 403,
      json: { error: "Purchasing approval permission is required." },
    }),
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 5 lines", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Cost review for shipment TEST-SEA-42" })
    .getByRole("button", { name: "Retry inventory cost update", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Purchasing approval permission is required." }),
  ).toBeVisible();
  await expect(page.getByText("TEST-SKU-1", { exact: true })).toBeVisible();
});

test("re-reads a committed result when the retry response is lost", async ({
  page,
}) => {
  const { failures, state } = await installCostFixtures(page);
  let attempts = 0;
  await page.route(
    "**/api/inbound-shipments/42/push-costs-to-lots",
    (route) => {
      attempts++;
      state.value.lines = state.value.lines.map((line) =>
        line.shipmentId === 42
          ? { ...line, status: "applied", issues: [] }
          : line,
      );
      state.value.summary = {
        ...state.value.summary,
        reviewLines: 0,
        appliedLines: 6,
        inventoryCosting: "pending",
      };
      return route.abort("connectionreset");
    },
  );
  await page.goto("/purchase-orders/17?tab=lines");
  await page
    .getByRole("button", { name: "Review 5 lines", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Cost review for shipment TEST-SEA-42" })
    .getByRole("button", { name: "Retry inventory cost update", exact: true })
    .click();
  await expect(page.getByText("TEST-SKU-1", { exact: true })).toHaveCount(0);
  await expect(page.getByText("TEST-AIR-107", { exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  expect(failures).toEqual([]);
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
