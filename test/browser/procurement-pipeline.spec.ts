import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/utils/canonical-json";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  projectPurchasePipeline,
  type PipelineEvidence,
} from "../../server/modules/procurement/purchase-pipeline.service";
import {
  pipelineEvidence,
  pipelineLine,
  pipelinePartialReceipt,
  pipelineShipment,
  pipelineTime,
} from "../fixtures/purchase-pipeline";
import { installFixtures } from "./procurement-fixtures";
import { INFINITE_DAYS_OF_SUPPLY } from "../../client/src/features/purchasing/reorderEngine";

function dashboardFixture() {
  return {
    stockouts: 2,
    orderNow: 3,
    draftPoCount: 2,
    inTransitCount: 1,
    openPoValueCents: 450000,
    noVendorCount: 0,
    stockoutItems: [
      {
        productId: 901,
        sku: "DAILY-STOCKOUT",
        productName: "Fictional urgent item",
        totalOnHand: 0,
      },
      {
        productId: 902,
        sku: "DAILY-STOCKOUT-2",
        productName: "Fictional second urgent item",
        totalOnHand: 0,
      },
    ],
    draftPos: [
      {
        id: 701,
        poNumber: "DAILY-DRAFT-701",
        vendorName: "Daily test supplier",
        lineCount: 2,
        totalCents: 12500,
        source: "manual",
      },
      {
        id: 702,
        poNumber: "DAILY-DRAFT-702",
        vendorName: "Second daily supplier",
        lineCount: 3,
        totalCents: 25000,
        source: "auto_draft",
      },
    ],
    inFlightPos: [],
    noVendorItems: [],
    orderNowItems: [
      {
        productId: 903,
        sku: "DAILY-REORDER",
        productName: "Fictional reorder item",
        daysOfSupply: 20,
        suggestedOrderQty: 12,
        orderUomLabel: "cases",
        preferredVendorId: 2,
      },
    ],
    healthBreakdown: {
      stockout: 2,
      order_now: 3,
      order_soon: 1,
      on_order: 1,
      ok: 3,
      no_movement: 0,
      total: 10,
    },
    spend: {
      totalReceivedCents: 0,
      openPoValueCents: 450000,
      avgPoCents: 0,
      topSupplierName: null,
      topSupplierCents: 0,
      activeSupplierCount: 0,
    },
    lastAutoDraftRun: null,
  };
}

function splitPurchaseFixture(): PipelineEvidence {
  const data = pipelinePartialReceipt();
  data.lines.push(
    pipelineLine({
      id: 22,
      purchaseOrderId: 2,
      poNumber: "TEST-PO-2",
      sku: "TEST-EUR",
      currency: "EUR",
      expectedDate: null,
    }),
  );
  return data;
}

function manyPurchaseLines(
  purchaseCount: number,
  linesPerPurchase: number,
): PipelineEvidence {
  const data: PipelineEvidence = {
    lines: [],
    shipments: [],
    receipts: [],
    postings: [],
    reversals: [],
    revisions: [],
  };
  for (
    let purchaseOrderId = 1;
    purchaseOrderId <= purchaseCount;
    purchaseOrderId += 1
  ) {
    for (let line = 1; line <= linesPerPurchase; line += 1) {
      data.lines.push(
        pipelineLine({
          id: purchaseOrderId * 100 + line,
          purchaseOrderId,
          poNumber: `BULK-PO-${purchaseOrderId}`,
          vendorName: `BULK-SUPPLIER-${purchaseOrderId}`,
          sku: `BULK-SKU-${purchaseOrderId}-${line}`,
          productName:
            "Fictional premium protective product with a long catalogue name",
          ordered: 400000,
          expectedDate: null,
        }),
      );
    }
  }
  return data;
}

async function setup(
  page: Page,
  canEdit = true,
  healthyDashboard = false,
  data = splitPurchaseFixture(),
) {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        user: { id: "test-user", username: "test", role: "admin" },
        permissions: canEdit
          ? ["purchasing:view", "purchasing:edit"]
          : ["purchasing:view"],
        roles: ["admin"],
      },
    }),
  );
  // A failed daily-review request must not remove the independently loaded purchases.
  await page.route("**/api/purchasing/dashboard", (route) =>
    route.fulfill(
      healthyDashboard
        ? { json: dashboardFixture() }
        : {
            status: 503,
            json: { error: "Synthetic unrelated dashboard outage" },
          },
    ),
  );
  for (const path of [
    "procurement/landed-cost-health",
    "purchasing/supplier-setup-gaps",
    "purchasing/forecast-input-gaps",
    "purchasing/auto-draft/stale-pos",
    "procurement/health",
  ]) {
    await page.route(`**/api/${path}*`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Synthetic optional widget unavailable" },
      }),
    );
  }
  await page.route("**/api/purchasing/pipeline?*", (route) =>
    route.fulfill({
      json: projectPurchasePipeline(
        data,
        pipelineTime,
        new URL(route.request().url()).searchParams.get("horizonDays") === "30"
          ? 30
          : 90,
      ),
    }),
  );
  return { failures, data };
}

async function scrollDashboardTo(target: Locator) {
  await target.evaluate((element) => {
    let container = element.parentElement;
    while (
      container &&
      !["auto", "scroll"].includes(getComputedStyle(container).overflowY)
    ) {
      container = container.parentElement;
    }
    if (!container)
      throw new Error(
        "The purchase view has no scrollable dashboard container",
      );
    const viewportInset = 16;
    container.scrollTop +=
      element.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      viewportInset;
  });
}

async function showPurchaseDetails(page: Page, poNumber: string) {
  await expect(page.getByTestId("purchase-pipeline")).toBeVisible();
  const show = page.getByRole("button", {
    name: `Show details for ${poNumber}`,
    exact: true,
  });
  // Changing the horizon may preserve or remount the loaded purchase view.
  // Either way the operator can reach the same complete order details.
  if (await show.count()) await show.click();
}

test("purchase summaries retain split quantities, currency separation and complete context when filtering arrivals", async ({
  page,
}, testInfo) => {
  const { failures } = await setup(page, true, true);
  await page.goto("/purchasing");
  const pipeline = page.getByTestId("purchase-pipeline");
  await expect(
    pipeline.getByRole("heading", { name: "Open purchases", exact: true }),
  ).toBeVisible();
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(2);
  await expect(pipeline.locator("[data-pipeline-row]:visible")).toHaveCount(0);
  await expect(
    pipeline.getByRole("button", { name: "All purchases (2)", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const detailsButton = page.getByRole("button", {
    name: "Show details for TEST-PO-1",
    exact: true,
  });
  await expect(detailsButton).toHaveAttribute("aria-expanded", "false");
  await detailsButton.focus();
  await page.keyboard.press("Enter");
  const hideDetails = page.getByRole("button", {
    name: "Hide details for TEST-PO-1",
    exact: true,
  });
  await expect(hideDetails).toBeFocused();
  await expect(hideDetails).toHaveAttribute("aria-expanded", "true");
  await expect(
    pipeline.locator('[data-purchase-order="2"] [data-pipeline-row]:visible'),
  ).toHaveCount(0);
  await expect(
    pipeline
      .locator('[data-purchase-order="1"]')
      .getByRole("link", { name: "TEST-PO-1", exact: true })
      .first(),
  ).toHaveAttribute("href", "/purchase-orders/1?tab=lifecycle");
  const transit = page.locator('[data-pipeline-row="11:111:in_transit"]');
  const lineTable = pipeline
    .locator('[data-purchase-order="1"]')
    .getByRole("table", { name: "Line items for TEST-PO-1", exact: true });
  await expect(lineTable).toHaveCount(1);
  await expect(transit).toHaveJSProperty("tagName", "TR");
  await expect(
    transit.getByRole("cell", { name: /^40(?: pieces)?$/ }),
  ).toBeVisible();
  await expect(transit.getByText("$40.00", { exact: true })).toBeVisible();
  await expect(transit.getByText("$4.00", { exact: true })).toBeVisible();
  await expect(transit.getByText("$44.00", { exact: true })).toBeVisible();
  await expect(lineTable).not.toContainText("40.0000 USD");
  await expect(lineTable).not.toContainText("TEST-PO-1");
  await expect(lineTable).not.toContainText("Test supplier");
  await expect(transit).toContainText("Shipment ETA");
  await expect(
    transit.getByRole("link", { name: "TEST-SHIP-7", exact: true }),
  ).toHaveAttribute(
    "href",
    "/purchase-orders/1?inspect=shipment%3A7&tab=lifecycle",
  );
  await expect(
    page
      .locator('[data-pipeline-row="11:0:in_production"]')
      .getByRole("cell", { name: /^30(?: pieces)?$/ }),
  ).toBeVisible();
  await expect(pipeline).toContainText("EUR");
  const transitFilter = pipeline.getByRole("button", {
    name: "Filter purchases: In transit",
    exact: true,
  });
  await transitFilter.click();
  await expect(transitFilter).toHaveAttribute("aria-pressed", "true");
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(1);
  await expect(
    page.locator('[data-pipeline-row="11:0:in_production"]'),
  ).toBeVisible();
  await transitFilter.click();
  await expect(transitFilter).toHaveAttribute("aria-pressed", "false");
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(2);

  await page.getByLabel("Arrival horizon", { exact: true }).selectOption("30");
  await page.getByRole("button", { name: "Later (1)", exact: true }).click();
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(1);
  await showPurchaseDetails(page, "TEST-PO-1");
  // A later slice selects the purchase; it must not hide that purchase's other shipment.
  await expect(transit).toBeVisible();
  await expect(
    page.locator('[data-pipeline-row="11:0:ready_to_ship"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "No ETA (1)", exact: true }).click();
  await expect(pipeline.locator('[data-purchase-order="2"]')).toBeVisible();
  await expect(pipeline.locator('[data-purchase-order="1"]')).toHaveCount(0);
  await showPurchaseDetails(page, "TEST-PO-2");
  await expect(pipeline).toContainText("TEST-EUR");
  await page.screenshot({
    path: testInfo.outputPath("pipeline-arrivals.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(failures).toEqual([]);
});

test("daily buying priorities stay ahead of forty purchase slices and diagnostics stay closed", async ({
  page,
}, testInfo) => {
  const data = manyPurchaseLines(4, 10);
  const { failures } = await setup(page, true, true, data);
  const dailySnapshot = dashboardFixture();
  dailySnapshot.orderNowItems[0].daysOfSupply = INFINITE_DAYS_OF_SUPPLY;
  await page.route("**/api/purchasing/dashboard", (route) =>
    route.fulfill({ json: dailySnapshot }),
  );
  await page.route("**/api/procurement/health?*", (route) =>
    route.fulfill({
      json: {
        generatedAt: pipelineTime.toISOString(),
        status: "critical",
        critical: 2,
        warning: 3,
        total: 5,
        sources: [
          {
            key: "test_guardrails",
            label: "Fictional guardrail follow-up",
            status: "critical",
            critical: 2,
            warning: 3,
            total: 5,
            href: "/purchase-orders",
            actionLabel: "Review fictional records",
            detail:
              "Two critical and three warning signals in the synthetic fixture.",
          },
        ],
      },
    }),
  );
  await page.goto("/purchasing");
  const dailyReview = page.getByRole("heading", {
    name: "Daily buying review",
    exact: true,
  });
  const recommendations = page.getByRole("button", {
    name: "Review recommendations",
    exact: true,
  });
  const pipeline = page.getByTestId("purchase-pipeline");
  const purchases = pipeline.getByRole("heading", {
    name: "Open purchases",
    exact: true,
  });
  await expect(dailyReview).toBeVisible();
  const dailyRegion = page.getByTestId("daily-buying-review");
  await expect(
    dailyRegion.getByRole("button", { name: "2 Out of stock", exact: true }),
  ).toBeVisible();
  await expect(
    dailyRegion.getByRole("button", {
      name: "3 Below reorder point",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dailyRegion.getByRole("button", {
      name: "Review DAILY-DRAFT-701",
      exact: true,
    }),
  ).toBeVisible();
  await expect(dailyRegion).toContainText("No recent demand");
  await expect(dailyRegion).not.toContainText("9,999 days cover");
  await expect(recommendations).toBeVisible();
  await expect(purchases).toBeVisible();
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(4);
  await expect(
    pipeline.getByRole("button", { name: "All purchases (4)", exact: true }),
  ).toBeVisible();
  await expect(pipeline.locator("[data-pipeline-row]:visible")).toHaveCount(0);
  await expect(
    pipeline.getByRole("button", {
      name: "Record supplier progress",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    pipeline.getByText("400,000.0000 USD", { exact: false }),
  ).toHaveCount(0);
  const dailyBox = await dailyReview.boundingBox();
  const actionBox = await recommendations.boundingBox();
  const pipelineBox = await purchases.boundingBox();
  expect(dailyBox).not.toBeNull();
  expect(actionBox).not.toBeNull();
  expect(pipelineBox).not.toBeNull();
  expect(dailyBox!.y).toBeLessThan(pipelineBox!.y);
  expect(actionBox!.y).toBeLessThan(pipelineBox!.y);
  expect(dailyBox!.y).toBeLessThan(page.viewportSize()!.height);
  expect(actionBox!.y).toBeGreaterThanOrEqual(0);
  expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  const purchaseOrdersBox = await page
    .getByRole("button", { name: "Purchase orders", exact: true })
    .boundingBox();
  expect(purchaseOrdersBox).not.toBeNull();
  expect(purchaseOrdersBox!.x).toBeGreaterThanOrEqual(0);
  expect(purchaseOrdersBox!.x + purchaseOrdersBox!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  const diagnostics = page
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Planning and system details" }),
    });
  await expect(diagnostics).toHaveCount(1);
  await expect(diagnostics).not.toHaveAttribute("open", "");
  await expect(
    diagnostics
      .locator("summary")
      .first()
      .getByText("2 critical", { exact: true }),
  ).toBeVisible();
  await expect(
    diagnostics
      .locator("summary")
      .first()
      .getByText("3 warnings", { exact: true }),
  ).toBeVisible();
  await expect(
    diagnostics.getByRole("button", {
      name: "Run Auto-Draft Now",
      exact: true,
    }),
  ).not.toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("daily-buying-review-dense.png"),
    fullPage: false,
  });
  const firstPurchase = pipeline.locator('[data-purchase-order="1"]');
  await scrollDashboardTo(firstPurchase);
  await page.screenshot({
    path: testInfo.outputPath("open-purchases-dense.png"),
    fullPage: false,
  });
  await firstPurchase
    .getByRole("button", { name: "Show details for BULK-PO-1", exact: true })
    .click();
  const lineTable = firstPurchase.getByRole("table", {
    name: "Line items for BULK-PO-1",
    exact: true,
  });
  await expect(lineTable).toHaveCount(1);
  await expect(lineTable.locator("[data-pipeline-row]")).toHaveCount(10);
  await expect(lineTable.locator("tbody")).toHaveCount(10);
  await expect(lineTable.getByRole("columnheader")).toHaveText([
    "Product",
    "Qty (pieces)",
    "Stage / shipment",
    "Arrival",
    "Product cost",
    "Packaging",
    "Freight & other",
    "Known total",
  ]);
  await expect(
    lineTable.getByTitle(
      "Fictional premium protective product with a long catalogue name",
      { exact: true },
    ),
  ).toHaveCount(10);
  await expect(
    firstPurchase.getByText("BULK-SUPPLIER-1", { exact: true }),
  ).toHaveCount(1);
  await expect(
    firstPurchase.getByRole("link", { name: "BULK-PO-1", exact: true }),
  ).toHaveCount(1);
  await expect(lineTable.locator("article")).toHaveCount(0);
  await expect(lineTable.getByRole("button")).toHaveCount(0);
  await expect(lineTable).not.toContainText("BULK-PO-1");
  await expect(lineTable).not.toContainText("BULK-SUPPLIER-1");
  const sources = firstPurchase
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Cost sources and notes" }),
    });
  await expect(sources).toHaveCount(1);
  await expect(sources).not.toHaveAttribute("open", "");
  const rowHeights = await lineTable
    .locator("[data-pipeline-row]")
    .evaluateAll((rows) =>
      rows.map((row) => row.getBoundingClientRect().height),
    );
  expect(rowHeights.every((height) => height < 80)).toBe(true);
  await scrollDashboardTo(firstPurchase);
  await page.screenshot({
    path: testInfo.outputPath("expanded-purchase-dense.png"),
    fullPage: false,
  });
  const scrollRegion = firstPurchase.getByRole("region", {
    name: "Scroll line items for BULK-PO-1",
    exact: true,
  });
  await expect(scrollRegion).toHaveAttribute("tabindex", "0");
  if (testInfo.project.name === "desktop") {
    const costColumn = await lineTable
      .getByRole("columnheader", { name: "Known total", exact: true })
      .boundingBox();
    const regionBox = await scrollRegion.boundingBox();
    expect(costColumn).not.toBeNull();
    expect(regionBox).not.toBeNull();
    // Desktop must expose its rightmost cost column without horizontal scrolling.
    expect(costColumn!.x + costColumn!.width).toBeLessThanOrEqual(
      regionBox!.x + regionBox!.width + 1,
    );
    const unreadableAmounts = await lineTable
      .locator("td span")
      .evaluateAll((spans) =>
        spans.flatMap((span) => {
          const amount = span.textContent ?? "";
          if (!amount.startsWith("$")) return [];
          const cell = span.closest("td")!;
          const textBox = span.getBoundingClientRect();
          const cellBox = cell.getBoundingClientRect();
          return span.getClientRects().length === 1 &&
            textBox.left >= cellBox.left &&
            textBox.right <= cellBox.right
            ? []
            : [
                {
                  amount,
                  lineCount: span.getClientRects().length,
                  textWidth: textBox.width,
                  cellWidth: cellBox.width,
                },
              ];
        }),
      );
    expect(unreadableAmounts).toEqual([]);
  }
  if (testInfo.project.name === "mobile") {
    expect(
      await scrollRegion.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    await scrollRegion.focus();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => scrollRegion.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await scrollRegion.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await page.screenshot({
      path: testInfo.outputPath("expanded-purchase-costs-mobile.png"),
      fullPage: false,
    });
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(failures).toEqual([]);
});

test("unresolved receipt quantities stay unknown in the collapsed purchase summary", async ({
  page,
}, testInfo) => {
  const data = pipelinePartialReceipt();
  // The receipt exists but its frozen pack factor is missing. The owner cannot
  // establish how many base pieces remain, so every resulting slice is unknown.
  data.receipts[0].units = null;
  const projected = projectPurchasePipeline(data, pipelineTime, 90);
  expect(projected.rows.length).toBeGreaterThan(0);
  expect(projected.rows.every((row) => row.quantityPieces === null)).toBe(true);
  const { failures } = await setup(page, true, true, data);
  await page.goto("/purchasing");
  const purchase = page.locator('[data-purchase-order="1"]');
  await expect(
    purchase.getByText("Quantity needs review", { exact: true }),
  ).toBeVisible();
  await expect(purchase).not.toContainText("0 pieces outstanding");
  await expect(purchase.locator("[data-pipeline-row]:visible")).toHaveCount(0);
  await showPurchaseDetails(page, "TEST-PO-1");
  const table = purchase.getByRole("table", {
    name: "Line items for TEST-PO-1",
    exact: true,
  });
  await expect(table).toContainText("Needs review");
  await expect(table.getByText(/\$[0-9]/)).toHaveCount(0);
  await expect(table).not.toContainText("0 pieces");
  await purchase.screenshot({
    path: testInfo.outputPath("purchase-quantity-review.png"),
  });
  expect(failures).toEqual([]);
});

test("part-delivered purchases still expose missing arrival dates for the remainder", async ({
  page,
}, testInfo) => {
  const data: PipelineEvidence = {
    lines: [pipelineLine({ expectedDate: null })],
    shipments: [
      pipelineShipment({
        status: "delivered",
        eta: null,
        deliveredAt: pipelineTime.toISOString(),
      }),
    ],
    receipts: [],
    postings: [],
    reversals: [],
    revisions: [],
  };
  const { failures } = await setup(page, true, true, data);
  await page.goto("/purchasing");
  const purchase = page.locator('[data-purchase-order="1"]');
  await expect(
    purchase.getByText("Part delivered · dates missing", { exact: true }),
  ).toBeVisible();
  await expect(
    purchase.getByText("Remaining arrival dates need confirmation", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(purchase.locator("[data-pipeline-row]:visible")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Delivered (1)", exact: true })
    .click();
  await expect(
    purchase.getByText("Remaining arrival dates need confirmation", {
      exact: true,
    }),
  ).toBeVisible();
  await purchase.screenshot({
    path: testInfo.outputPath("purchase-part-delivered-missing-eta.png"),
  });
  expect(failures).toEqual([]);
});

test("purchase paging is bounded and search reaches orders, suppliers and items beyond the first page", async ({
  page,
}) => {
  const { failures } = await setup(page, true, true, manyPurchaseLines(10, 2));
  await page.goto("/purchasing");
  const pipeline = page.getByTestId("purchase-pipeline");
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(8);
  const firstPageIds = await pipeline
    .locator("[data-purchase-order]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-purchase-order")),
    );
  await pipeline
    .getByRole("button", { name: "Next page", exact: true })
    .click();
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(2);
  const secondPageIds = await pipeline
    .locator("[data-purchase-order]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-purchase-order")),
    );
  expect(new Set([...firstPageIds, ...secondPageIds]).size).toBe(10);
  await expect(
    pipeline.getByRole("button", { name: "Next page", exact: true }),
  ).toBeDisabled();
  await pipeline
    .getByRole("button", { name: "Previous page", exact: true })
    .click();
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(8);
  const search = pipeline.getByLabel("Search purchases", { exact: true });
  for (const query of ["BULK-PO-10", "BULK-SUPPLIER-10", "BULK-SKU-10-2"]) {
    await search.fill(query);
    await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(1);
    await expect(pipeline.locator('[data-purchase-order="10"]')).toBeVisible();
    await expect(pipeline.locator("[data-pipeline-row]:visible")).toHaveCount(
      0,
    );
  }
  await search.fill("NO-PURCHASE-MATCH");
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(0);
  await search.fill("");
  await expect(pipeline.locator("[data-purchase-order]")).toHaveCount(8);
  expect(failures).toEqual([]);
});

for (const canEdit of [true, false]) {
  test(`${canEdit ? "Editor" : "View-only operator"} can inspect costs and lazy supplier report history without a mutation control`, async ({
    page,
  }, testInfo) => {
    const data = pipelinePartialReceipt();
    const originalReport = data.lines[0].progress.report!;
    const revisedReport = {
      ...originalReport,
      completedPieces: 80,
      reference: "Supplier report B",
      notes: "Fictional revised completion confirmation",
    };
    data.lines[0].progress = {
      revision: 2,
      report: revisedReport,
      recordedBy: "history-editor-B",
      recordedAt: pipelineTime.toISOString(),
    };
    const { failures } = await setup(page, canEdit, true, data);
    const progressRequests: string[] = [];
    page.on("request", (request) => {
      if (
        /\/api\/purchasing\/pipeline\/lines\/\d+\/progress$/.test(
          new URL(request.url()).pathname,
        )
      )
        progressRequests.push(request.method());
    });
    await page.route(
      "**/api/purchasing/pipeline/lines/11/progress",
      (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        return route.fulfill({
          json: {
            purchaseOrderLineId: 11,
            current: data.lines[0].progress,
            changes: [
              {
                revision: 1,
                before: null,
                after: originalReport,
                recordedBy: "history-editor-A",
                recordedAt: "2026-09-06T13:00:00.000Z",
              },
              {
                revision: 2,
                before: originalReport,
                after: revisedReport,
                recordedBy: "history-editor-B",
                recordedAt: pipelineTime.toISOString(),
              },
            ],
          },
        });
      },
    );
    await page.goto("/purchasing");
    await showPurchaseDetails(page, "TEST-PO-1");
    const purchase = page.locator('[data-purchase-order="1"]');
    const table = purchase.getByRole("table", {
      name: "Line items for TEST-PO-1",
      exact: true,
    });
    await expect(table.locator("[data-pipeline-row]")).toHaveCount(3);
    await expect(table.locator("tbody")).toHaveCount(1);
    await expect(table.getByText("TEST-ITEM", { exact: true })).toHaveCount(1);
    await expect(
      purchase.getByRole("button", {
        name: /Record supplier progress|Save supplier progress|Retry saved progress/i,
      }),
    ).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const sources = purchase
      .locator("details")
      .filter({
        has: page.locator("summary", { hasText: "Cost sources and notes" }),
      });
    await expect(sources).toHaveCount(1);
    await expect(sources).not.toHaveAttribute("open", "");
    expect(progressRequests).toEqual([]);
    await sources.locator("summary").first().click();
    await expect(sources).toHaveAttribute("open", "");
    await expect(sources).toContainText("TEST-QUOTE");
    await expect(sources).toContainText("40.0000 USD");
    await expect(sources).toContainText("Supplier report B");
    await expect(sources).toContainText(
      "shipment destination; warehouse arrival not confirmed",
    );
    expect(progressRequests).toEqual([]);
    const history = sources
      .locator("details")
      .filter({
        has: page.locator("summary", { hasText: "Supplier report history" }),
      });
    await expect(history).not.toHaveAttribute("open", "");
    await history.locator("summary").click();
    await expect(
      history.getByText("Revision 1", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText("Revision 2", { exact: true }),
    ).toBeVisible();
    await expect(history).toContainText("Supplier report A");
    await expect(history).toContainText("Supplier report B");
    await expect(history).toContainText("Recorded by history-editor-A");
    await expect(history).toContainText("Recorded by history-editor-B");
    await expect(history).toContainText(
      "Fictional revised completion confirmation",
    );
    await expect(history).toContainText("2026-09-06T13:00:00.000Z");
    expect(progressRequests).toEqual(["GET"]);
    await expect(
      history.getByRole("button", {
        name: /Record supplier progress|Save supplier progress|Retry saved progress/i,
      }),
    ).toHaveCount(0);
    await history.locator("summary").click();
    await sources.locator("summary").first().click();
    await expect(sources).not.toHaveAttribute("open", "");
    await purchase.screenshot({
      path: testInfo.outputPath("purchase-read-only-details.png"),
    });
    expect(failures).toEqual([]);
  });
}

test("supplier history failures retry only on demand and reject another purchase line's records", async ({
  page,
}) => {
  const data = pipelinePartialReceipt();
  const { failures } = await setup(page, false, true, data);
  let attempts = 0;
  await page.route("**/api/purchasing/pipeline/lines/11/progress", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    attempts += 1;
    if (attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Synthetic history unavailable" },
      });
    const report =
      attempts === 2
        ? { ...data.lines[0].progress.report!, reference: "WRONG-LINE-REPORT" }
        : data.lines[0].progress.report!;
    return route.fulfill({
      json: {
        purchaseOrderLineId: attempts === 2 ? 999 : 11,
        current: { ...data.lines[0].progress, report },
        changes: [
          {
            revision: 1,
            before: null,
            after: report,
            recordedBy: "history-reviewer",
            recordedAt: pipelineTime.toISOString(),
          },
        ],
      },
    });
  });
  await page.goto("/purchasing");
  await showPurchaseDetails(page, "TEST-PO-1");
  const purchase = page.locator('[data-purchase-order="1"]');
  const sources = purchase
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Cost sources and notes" }),
    });
  await sources.locator("summary").first().click();
  expect(attempts).toBe(0);
  const history = sources
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Supplier report history" }),
    });
  await history.locator("summary").click();
  await expect(history.getByRole("alert")).toContainText(
    "Supplier report history could not be loaded",
  );
  expect(attempts).toBe(1);
  await history
    .getByRole("button", { name: "Retry history", exact: true })
    .click();
  await expect.poll(() => attempts).toBe(2);
  await expect(history.getByRole("alert")).toContainText(
    "Supplier report history could not be loaded",
  );
  await expect(history).not.toContainText("WRONG-LINE-REPORT");
  await history
    .getByRole("button", { name: "Retry history", exact: true })
    .click();
  await expect(history.getByText("Revision 1", { exact: true })).toBeVisible();
  await expect(history).toContainText("Supplier report A");
  await expect(history).toContainText("Recorded by history-reviewer");
  await expect(history.getByRole("alert")).toHaveCount(0);
  expect(attempts).toBe(3);
  expect(failures).toEqual([]);
});

test("history loading preserves the current recorded report when earlier revisions are unavailable", async ({
  page,
}) => {
  const data = pipelinePartialReceipt();
  const { failures } = await setup(page, false, true, data);
  let releaseHistory!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await page.route(
    "**/api/purchasing/pipeline/lines/11/progress",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await responseReady;
      return route.fulfill({
        json: {
          purchaseOrderLineId: 11,
          current: data.lines[0].progress,
          changes: [],
        },
      });
    },
  );
  await page.goto("/purchasing");
  await showPurchaseDetails(page, "TEST-PO-1");
  const purchase = page.locator('[data-purchase-order="1"]');
  const sources = purchase
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Cost sources and notes" }),
    });
  await sources.locator("summary").first().click();
  const history = sources
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Supplier report history" }),
    });
  await history.locator("summary").click();
  try {
    await expect(history.getByRole("status")).toContainText(
      "Loading supplier report history",
    );
  } finally {
    releaseHistory();
  }
  await expect(history).toContainText("Supplier report A");
  await expect(history).toContainText("Recorded by test-operator");
  await expect(history).toContainText("2026-09-06T12:00:00.000Z");
  await expect(history).toContainText(
    "No earlier report revisions are available",
  );
  await expect(history).not.toContainText(
    "No supplier report history has been recorded",
  );
  expect(failures).toEqual([]);
});

test("legacy PO product and packaging amounts remain visible without inventing unrecorded freight", async ({
  page,
}, testInfo) => {
  const data = pipelineEvidence();
  data.lines[0] = pipelineLine({
    ordered: 400000,
    sku: "LEGACY-COSTED-ITEM",
    productName: "Fictional historically quoted product",
    pricingBasis: "legacy_unknown",
    quotedUnitMills: null,
    quotedTotalCents: null,
    purchaseUomQuantity: null,
    piecesPerPurchaseUom: null,
    productCents: "246810",
    packagingCents: "12000",
    quoteReference: null,
  });
  const { failures } = await setup(page, true, true, data);
  await page.goto("/purchasing");
  await showPurchaseDetails(page, "TEST-PO-1");
  const purchase = page.locator('[data-purchase-order="1"]');
  const table = purchase.getByRole("table", {
    name: "Line items for TEST-PO-1",
    exact: true,
  });
  const row = table.locator('[data-pipeline-row="11:0:supplier_unconfirmed"]');
  await expect(
    row.getByRole("cell", { name: /^400,000(?: pieces)?$/ }),
  ).toBeVisible();
  await expect(row.getByText("$2,468.10", { exact: true })).toBeVisible();
  await expect(row.getByText("$120.00", { exact: true })).toBeVisible();
  await expect(row.getByText("$2,588.10", { exact: true })).toBeVisible();
  await expect(row.getByText("Not recorded", { exact: true })).toHaveCount(1);
  await expect(row).not.toContainText("$0.00");
  await expect(table).not.toContainText("2,468.1000 USD");
  await expect(purchase).toContainText("Incomplete cost");
  await expect(purchase).toContainText("includes estimates");
  const sources = purchase
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Cost sources and notes" }),
    });
  await sources.locator("summary").click();
  await expect(sources).toContainText("PO line total");
  await expect(sources).toContainText("2,468.1000 USD");
  await expect(sources).toContainText("120.0000 USD");
  await sources.locator("summary").click();
  await scrollDashboardTo(purchase);
  await page.screenshot({
    path: testInfo.outputPath("legacy-po-costs.png"),
    fullPage: false,
  });
  expect(failures).toEqual([]);
});

test("confirmed cost revisions keep their source link and evidence in the purchase disclosure", async ({
  page,
}) => {
  const data = pipelineEvidence();
  const sourceEvidence = {
    invoice: "Fictional vendor invoice for browser validation",
  };
  const input = {
    contractVersion: 1,
    component: "product",
    scope: {
      kind: "purchase_order_line",
      purchaseOrderId: 1,
      purchaseOrderLineId: 11,
    },
    sources: [
      {
        kind: "vendor_invoice_line",
        documentId: 8,
        lineId: 9,
        version: "a".repeat(64),
      },
    ],
    currency: "USD",
    totalMills: 700000,
    basePieces: 100,
    evidence: "confirmed",
    packagingTreatment: "separate",
    issue: null,
    manualOverride: null,
  };
  const fingerprint = createHash("sha256")
    .update(canonicalJson({ input, sourceEvidence }))
    .digest("hex");
  data.revisions.push({
    id: 44,
    purchaseOrderLineId: 11,
    shipmentLineId: null,
    component: "product",
    revision: 1,
    fingerprint,
    contract: { ...input, revision: 1, fingerprint },
    sourceEvidence,
    recordedAt: pipelineTime.toISOString(),
  });
  const { failures } = await setup(page, true, true, data);
  await page.goto("/purchasing");
  await showPurchaseDetails(page, "TEST-PO-1");
  const purchase = page.locator('[data-purchase-order="1"]');
  const row = purchase
    .getByRole("table", { name: "Line items for TEST-PO-1", exact: true })
    .locator("[data-pipeline-row]");
  await expect(row.getByText("$70.00", { exact: true })).toBeVisible();
  await expect(row.getByText("$80.00", { exact: true })).toBeVisible();
  const sources = purchase
    .locator("details")
    .filter({
      has: page.locator("summary", { hasText: "Cost sources and notes" }),
    });
  await sources.locator("summary").click();
  await expect(sources).toContainText("70.0000 USD");
  await expect(sources).toContainText("confirmed");
  await expect(sources).toContainText("Revision 1");
  await expect(sources).toContainText(pipelineTime.toISOString());
  await expect(
    sources.getByRole("link", { name: "Source #44", exact: true }),
  ).toHaveAttribute(
    "href",
    "/purchase-orders/1?inspect=purchase%3A1&tab=lifecycle",
  );
  expect(failures).toEqual([]);
});

test("refresh failure retains a visibly dated snapshot and malformed initial evidence exposes no totals", async ({
  page,
}) => {
  const { failures } = await setup(page);
  await page.goto("/purchasing");
  const pipeline = page.getByTestId("purchase-pipeline");
  await expect(pipeline).toBeVisible();
  await page.route("**/api/purchasing/pipeline?*", (route) =>
    route.fulfill({ json: { rows: [] } }),
  );
  await page
    .getByRole("button", { name: "Refresh pipeline", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Refresh failed" }),
  ).toBeVisible();
  await expect(
    pipeline.locator(`time[datetime="${pipelineTime.toISOString()}"]`),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Purchase records could not be loaded" }),
  ).toBeVisible();
  await expect(page.getByTestId("purchase-pipeline")).toHaveCount(0);
  expect(failures).toEqual([]);
});
