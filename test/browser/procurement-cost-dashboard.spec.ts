import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

// These are the existing API's units: totals are cents, while lot rows also
// expose integer mills (USD / 10,000), often as PostgreSQL BIGINT strings.
const valuation = {
  totalValueCents: 450000, totalQty: 1500, zeroCostQty: 0, provisionalQty: 600,
  landedPendingLots: 1, landedPendingValueCents: 138000,
  byProduct: [
    { productId: 1, productName: "Synthetic A", baseSku: "COST-A", totalQty: 1000, avgCostPerPiece: 230, totalValueCents: 230000, activeLots: 2, zeroCostQty: 0, hasLandedPending: true },
    { productId: 2, productName: "Synthetic B", baseSku: "COST-B", totalQty: 500, avgCostPerPiece: 440, totalValueCents: 220000, activeLots: 1, zeroCostQty: 0, hasLandedPending: false },
  ],
};
const orderCogs = {
  orderId: 7, orderNumber: "TEST-COST-7", totalRevenueCents: 20000,
  totalCogsCents: 23000, grossMarginCents: -3000, marginPercent: -15,
  lineItems: [{ orderItemId: 8, sku: "COST-A", productName: "Synthetic A", qty: 100,
    revenueCents: 20000, cogsCents: 23000, marginCents: -3000, marginPercent: -15,
    lotBreakdown: [{ lotId: 9, lotNumber: "TEST-LOT-9", qty: 100, unitCostCents: 230, totalCostCents: 23000 }] }],
};
const lots = [
  { id: 9, lot_number: "PRECISE-LOT", product_id: 1, product_name: "Synthetic precision", base_sku: "COST-PRECISION", sku: "COST-PRECISION-1",
    qty_on_hand: 100, qty_received: 100, po_unit_cost_mills: "350", landed_cost_mills: "25", total_unit_cost_mills: "375", unit_cost_mills: "375",
    po_unit_cost_cents: "4", landed_cost_cents: "0", total_unit_cost_cents: "4", unit_cost_cents: "4", cost_provisional: 0, cost_source: "manual", units_per_variant: 1 },
  { id: 10, lot_number: "LEGACY-LOT", product_id: 1, product_name: "Synthetic precision", base_sku: "COST-PRECISION", sku: "COST-PRECISION-1",
    qty_on_hand: 10, qty_received: 10, po_unit_cost_mills: "0", landed_cost_mills: "0", total_unit_cost_mills: "0", unit_cost_mills: "0",
    po_unit_cost_cents: "230", landed_cost_cents: "0", total_unit_cost_cents: "230", unit_cost_cents: "230", cost_provisional: 0, cost_source: "manual", units_per_variant: 1 },
  { id: 11, lot_number: "ZERO-LOT", product_id: 1, product_name: "Synthetic precision", base_sku: "COST-PRECISION", sku: "COST-PRECISION-1",
    qty_on_hand: 1, qty_received: 1, po_unit_cost_mills: "0", landed_cost_mills: "0", total_unit_cost_mills: "0", unit_cost_mills: "0",
    po_unit_cost_cents: "0", landed_cost_cents: "0", total_unit_cost_cents: "0", unit_cost_cents: "0", cost_provisional: 0, cost_source: "manual", units_per_variant: 1 },
];

async function setup(page: Page) {
  const failures = await installFixtures(page);
  await page.route("**/api/cogs/**", async (route) => {
    if (route.request().method() !== "GET") {
      failures.push(`Unexpected cost mutation: ${route.request().method()}`);
      return route.abort();
    }
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/cogs/valuation") return route.fulfill({ json: valuation });
    if (path === "/api/cogs/order") return route.fulfill({ json: orderCogs });
    if (path === "/api/cogs/lots") return route.fulfill({ json: { lots, total: lots.length } });
    if (path === "/api/cogs/manual-lots") return route.fulfill({ json: lots });
    if (path === "/api/cogs/adjustments") return route.fulfill({ json: [
      { lotId: 9, lotNumber: "INCREASE-LOT", sku: "COST-A", oldCostCents: 230, newCostCents: 240, deltaCents: 10, adjustedAt: "2026-09-08T12:00:00Z", reason: "freight_revision" },
      { lotId: 10, lotNumber: "DECREASE-LOT", sku: "COST-B", oldCostCents: 440, newCostCents: 430, deltaCents: -10, adjustedAt: "2026-09-08T12:00:00Z", reason: "cost_credit" },
    ] });
    failures.push(`Unexpected cost read: ${path}`);
    return route.abort();
  });
  await page.goto("/inventory/costs");
  await expect(page.getByRole("heading", { name: "Inventory Cost Dashboard" })).toBeVisible();
  return failures;
}

test("valuation renders API cents as dollars at summary and product levels", async ({ page }) => {
  const failures = await setup(page);
  await expect(page.getByText("$4,500.00", { exact: true })).toBeVisible();
  await expect(page.getByText("1 lots · $1,380.00", { exact: true })).toBeVisible();
  const a = page.getByRole("row").filter({ hasText: "Synthetic A" });
  await expect(a.getByRole("cell", { name: "$2.30", exact: true })).toBeVisible();
  await expect(a.getByRole("cell", { name: "$2,300.00", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("order revenue, sold cost, loss and consumed lot detail use the same cent scale", async ({ page }) => {
  const failures = await setup(page);
  await page.getByRole("tab", { name: "Order COGS", exact: true }).click();
  await page.getByPlaceholder("Enter order number (e.g., 1234 or #CS-1234)").fill("TEST-COST-7");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("$200.00", { exact: true })).toBeVisible();
  await expect(page.getByText("$230.00", { exact: true })).toBeVisible();
  await expect(page.getByText("-$30.00", { exact: true })).toBeVisible();
  await page.getByRole("button").filter({ hasText: "COGS: $230.00" }).click();
  const row = page.getByRole("row").filter({ hasText: "TEST-LOT-9" });
  await expect(row.getByRole("cell", { name: "$2.30", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "$230.00", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("a failed order cost read is not reported as a missing order", async ({ page }) => {
  const failures = await setup(page);
  let failed = true;
  await page.route("**/api/cogs/order?*", (route) => failed
    ? route.fulfill({ status: 500, json: { error: "Failed to get order COGS" } })
    : route.fulfill({ json: orderCogs }));
  await page.getByRole("tab", { name: "Order COGS", exact: true }).click();
  await page.getByPlaceholder("Enter order number (e.g., 1234 or #CS-1234)").fill("TEST-COST-7");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load order costs");
  await expect(page.getByText('No order found for "TEST-COST-7". Try a different order number.')).toHaveCount(0);
  await expect(page.getByText("Gross Margin", { exact: true })).toHaveCount(0);
  failed = false;
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("$200.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(failures).toEqual([]);
});

for (const malformed of ["incomplete response", "invalid JSON"] as const) {
  test(`order costs reject ${malformed} and recover through explicit retry`, async ({ page }) => {
    const failures = await setup(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let failed = true;
    let attempts = 0;
    await page.route("**/api/cogs/order?*", (route) => {
      attempts++;
      if (!failed) return route.fulfill({ json: orderCogs });
      return malformed === "incomplete response"
        ? route.fulfill({ json: { ...orderCogs, lineItems: null } })
        : route.fulfill({ status: 200, contentType: "application/json", body: "{incomplete" });
    });
    await page.getByRole("tab", { name: "Order COGS", exact: true }).click();
    await expect(page.getByText(/costs recorded so far\. Outstanding or unpicked fulfillment may add costs/)).toBeVisible();
    await page.getByPlaceholder("Enter order number (e.g., 1234 or #CS-1234)").fill("TEST-COST-7");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("The order cost response is incomplete or invalid");
    await expect(page.getByText('No order found for "TEST-COST-7". Try a different order number.')).toHaveCount(0);
    await expect(page.getByText("Gross Margin", { exact: true })).toHaveCount(0);
    expect(attempts).toBe(1);
    failed = false;
    await page.getByRole("button", { name: "Retry order costs", exact: true }).click();
    await expect(page.getByText("$200.00", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(pageErrors).toEqual([]);
    expect(failures).toEqual([]);
  });
}

test("unsupported order currency requests recorded exchange evidence without rendering server text or invented conversion", async ({ page }) => {
  const failures = await setup(page);
  let unsupported = true;
  await page.route("**/api/cogs/order?*", (route) => unsupported
    ? route.fulfill({ status: 422, json: { code: "ORDER_COGS_CURRENCY_UNSUPPORTED", currency: "PRIVATE-CURRENCY",
      error: "PRIVATE-SERVER-TEXT: assume an exchange rate of 1" } })
    : route.fulfill({ json: orderCogs }));
  await page.getByRole("tab", { name: "Order COGS", exact: true }).click();
  await page.getByPlaceholder("Enter order number (e.g., 1234 or #CS-1234)").fill("TEST-COST-7");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Order margins require a recorded exchange rate");
  await expect(page.getByRole("alert")).toContainText("USD inventory costs");
  await expect(page.getByText(/PRIVATE-SERVER-TEXT|PRIVATE-CURRENCY/)).toHaveCount(0);
  await expect(page.getByText("Gross Margin", { exact: true })).toHaveCount(0);
  await expect(page.getByText('No order found for "TEST-COST-7". Try a different order number.')).toHaveCount(0);
  unsupported = false;
  await page.getByRole("button", { name: "Retry order costs", exact: true }).click();
  await expect(page.getByText("$200.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("a malformed refresh hides previously successful order totals until a validated response recovers", async ({ page }) => {
  const failures = await setup(page);
  let malformed = false;
  await page.route("**/api/cogs/order?*", (route) => route.fulfill({
    json: malformed ? { ...orderCogs, marginPercent: null } : orderCogs,
  }));
  await page.getByRole("tab", { name: "Order COGS", exact: true }).click();
  await page.getByPlaceholder("Enter order number (e.g., 1234 or #CS-1234)").fill("TEST-COST-7");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("$200.00", { exact: true })).toBeVisible();
  malformed = true;
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The order cost response is incomplete or invalid");
  await expect(page.getByText("Gross Margin", { exact: true })).toHaveCount(0);
  await expect(page.getByText("$200.00", { exact: true })).toHaveCount(0);
  malformed = false;
  await page.getByRole("button", { name: "Retry order costs", exact: true }).click();
  await expect(page.getByText("$200.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("recorded order zero and a confirmed missing order remain distinct from failed reads", async ({ page }) => {
  const failures = await setup(page);
  await page.route("**/api/cogs/order?*", (route) => new URL(route.request().url()).searchParams.get("orderNumber") === "MISSING"
    ? route.fulfill({ status: 404, json: { error: "Order not found" } })
    : route.fulfill({ json: { ...orderCogs, totalRevenueCents: 0, totalCogsCents: 0,
      totalCogsMills: "0", grossMarginCents: 0, marginPercent: 0, lineItems: [] } }));
  await page.getByRole("tab", { name: "Order COGS", exact: true }).click();
  const input = page.getByPlaceholder("Enter order number (e.g., 1234 or #CS-1234)");
  await input.fill("TEST-COST-7");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("$0.00", { exact: true })).toHaveCount(3);
  await expect(page.getByText("No COGS data recorded for this order yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await input.fill("MISSING");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText('No order found for "MISSING". Try a different order number.')).toBeVisible();
  await expect(page.getByText("Gross Margin", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("order lot detail preserves exact subcent costs while summary cents round after aggregation", async ({ page }) => {
  const failures = await setup(page);
  await page.route("**/api/cogs/order?*", (route) => route.fulfill({ json: {
    ...orderCogs, totalRevenueCents: 1000, totalCogsCents: 1, totalCogsMills: "98", grossMarginCents: 999, marginPercent: 99.9,
    lineItems: [8, 10].map((id) => ({ ...orderCogs.lineItems[0], orderItemId: id, qty: 1, revenueCents: 500,
      cogsCents: 0, cogsMills: "49", marginCents: 500, marginPercent: 100,
      lotBreakdown: [{ ...orderCogs.lineItems[0].lotBreakdown[0], qty: 1, unitCostCents: 0,
        totalCostCents: 0, unitCostMills: "49", totalCostMills: "49" }] })),
  } }));
  await page.getByRole("tab", { name: "Order COGS", exact: true }).click();
  await page.getByPlaceholder("Enter order number (e.g., 1234 or #CS-1234)").fill("TEST-COST-7");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("$0.01", { exact: true })).toBeVisible();
  await expect(page.getByText("$9.99", { exact: true })).toBeVisible();
  await page.getByRole("button").filter({ hasText: "COGS: $0.00" }).first().click();
  await expect(page.getByRole("row").filter({ hasText: "TEST-LOT-9" }).getByRole("cell", { name: "$0.0049", exact: true })).toHaveCount(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(failures).toEqual([]);
});

test("explorer preserves subcent mills, legacy cents, recorded zero and exact extended value", async ({ page }) => {
  const failures = await setup(page);
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  const product = page.getByRole("button").filter({ hasText: "Synthetic precision" });
  await expect(product.getByText("$26.75", { exact: true })).toBeVisible();
  await product.click();
  const precise = page.getByRole("row").filter({ hasText: "PRECISE-LOT" });
  await expect(precise.getByRole("cell", { name: "$0.0350", exact: true })).toBeVisible();
  await expect(precise.getByRole("cell", { name: "$0.0025", exact: true })).toBeVisible();
  await expect(precise.getByRole("cell", { name: "$0.0375", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "LEGACY-LOT" }).getByRole("cell", { name: "$2.30", exact: true })).toHaveCount(2);
  await expect(page.getByRole("row").filter({ hasText: "ZERO-LOT" }).getByRole("cell", { name: "$0.00", exact: true })).toHaveCount(3);
  expect(failures).toEqual([]);
});

test("packed lots stay in recorded lot units across valuation, explorer and manual read tables", async ({ page }) => {
  const failures = await setup(page);
  const packedLot = {
    ...lots[0], id: 12, lot_number: "PACK-LOT", product_id: 3, product_name: "Synthetic 100-piece pack",
    base_sku: "COST-PACK", sku: "COST-PACK-100", units_per_variant: 100, qty_on_hand: 2, qty_received: 2,
    po_unit_cost_mills: "2000000", landed_cost_mills: "300000", total_unit_cost_mills: "2300000", unit_cost_mills: "2300000",
    po_unit_cost_cents: "20000", landed_cost_cents: "3000", total_unit_cost_cents: "23000", unit_cost_cents: "23000",
  };
  await page.route("**/api/cogs/**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/cogs/valuation") return route.fulfill({ json: {
      totalValueCents: 46000, totalQty: 2, zeroCostQty: 0, provisionalQty: 0, landedPendingLots: 0, landedPendingValueCents: 0,
      byProduct: [{ productId: 3, productName: packedLot.product_name, baseSku: packedLot.base_sku,
        totalQty: 2, avgCostPerPiece: 23000, totalValueCents: 46000, activeLots: 1, zeroCostQty: 0, hasLandedPending: false }],
    } });
    if (path === "/api/cogs/lots") return route.fulfill({ json: { lots: [packedLot], total: 1 } });
    if (path === "/api/cogs/manual-lots") return route.fulfill({ json: [packedLot] });
    return route.fallback();
  });
  await page.reload();
  await expect(page.getByText("Recorded Lot Units", { exact: true })).toBeVisible();
  await expect(page.getByText(/Pack sizes may differ; these values are not normalized to base pieces/)).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Avg Cost / Lot Unit", exact: true })).toBeVisible();
  const valuationRow = page.getByRole("row").filter({ hasText: packedLot.product_name });
  await expect(valuationRow.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  await expect(valuationRow.getByRole("cell", { name: "$230.00", exact: true })).toBeVisible();
  await expect(valuationRow.getByRole("cell", { name: "$460.00", exact: true })).toBeVisible();
  await expect(page.getByText("Total Pieces", { exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  const product = page.getByRole("button").filter({ hasText: packedLot.product_name });
  await expect(product.getByText("lot units", { exact: true })).toBeVisible();
  await expect(product.getByText("2", { exact: true })).toBeVisible();
  await expect(product.getByText("$460.00", { exact: true })).toBeVisible();
  await product.click();
  await expect(page.getByRole("columnheader", { name: "Total / Lot Unit", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "PACK-LOT" }).getByRole("cell", { name: "$230.00", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Manual Entry", exact: true }).click();
  await expect(page.getByRole("columnheader", { name: "Cost / Lot Unit", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Lot Units", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "PACK-LOT" }).getByRole("cell", { name: "$230.00", exact: true })).toBeVisible();
  await expect(page.getByText("$2.30", { exact: true })).toHaveCount(0);
  // Existing manual input contracts are intentionally unchanged by read labels.
  await expect(page.getByText("Quantity (pieces)", { exact: true })).toBeVisible();
  await expect(page.getByText("Unit Cost (cents per piece)", { exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("adjustments preserve the direction of increases and credits without multiplying dollars", async ({ page }) => {
  const failures = await setup(page);
  await page.getByRole("tab", { name: "Adjustments", exact: true }).click();
  const increase = page.getByRole("row").filter({ hasText: "INCREASE-LOT" });
  await expect(increase.getByRole("cell", { name: "$2.30", exact: true })).toBeVisible();
  await expect(increase.getByRole("cell", { name: "$2.40", exact: true })).toBeVisible();
  await expect(increase.getByRole("cell", { name: "+$0.10", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "DECREASE-LOT" }).getByRole("cell", { name: "-$0.10", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});


test("recost rejects unsupported inputs without posting and recovers with only a product-per-piece preview", async ({ page }) => {
  const failures = await setup(page);
  const recostRequests: unknown[] = [];
  let saved = false;
  await page.route("**/api/cogs/lots?*", async (route) => {
    // The list exposes the current catalog factor. The writer may retain a
    // different frozen receipt factor, so this value cannot predict its total.
    const displayedLots = lots.map((lot) => lot.id !== 9 ? lot : {
      ...lot, units_per_variant: 100,
      ...(saved ? { po_unit_cost_mills: "375", total_unit_cost_mills: "400", unit_cost_mills: "400" } : {}),
    });
    return route.fulfill({ json: { lots: displayedLots, total: displayedLots.length } });
  });
  await page.route("**/api/cogs/lots/9/recost", async (route) => {
    if (route.request().method() !== "POST") {
      failures.push("Unexpected recost method");
      return route.abort();
    }
    recostRequests.push(route.request().postDataJSON());
    saved = true;
    // A frozen factor of one plus retained freight produces four cents; the
    // displayed catalog factor of 100 would have predicted the wrong amount.
    return route.fulfill({ json: { lotId: 9, lotNumber: "PRECISE-LOT", sku: "COST-PRECISION-1", oldCostCents: 4, newCostCents: 4 } });
  });
  await page.getByRole("tab", { name: "Manual Entry", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "PRECISE-LOT" }).getByRole("cell", { name: "$0.0375", exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "LEGACY-LOT" }).getByRole("cell", { name: "$2.30", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "Synthetic precision" }).click();
  await page.getByRole("row").filter({ hasText: "PRECISE-LOT" }).getByTitle("Recost this lot").click();
  const dialog = page.getByRole("dialog");
  const amount = dialog.getByPlaceholder("0.0000");
  const save = dialog.getByRole("button", { name: "Recost lot", exact: true });
  await expect(dialog.getByText(/current \$0.0375\/lot unit/)).toBeVisible();
  await expect(dialog.getByText(/Existing packaging and freight costs are retained/)).toBeVisible();
  await expect(save).toBeDisabled();
  for (const unsupported of ["0.00015", "0.000049", "1e3"]) {
    await amount.fill(unsupported);
    await expect(dialog.getByRole("alert")).toHaveText("Enter a nonnegative amount with at most 4 decimal places.");
    await expect(save).toBeDisabled();
    await amount.press("Enter");
    await expect(dialog.getByText(/Entered product cost per piece/)).toHaveCount(0);
    expect(recostRequests).toEqual([]);
  }
  await amount.fill("805101709452.9024");
  await expect(dialog.getByRole("alert")).toContainText("exact numeric limit");
  await expect(save).toBeDisabled();
  expect(recostRequests).toEqual([]);
  await amount.fill("0.0375");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByText("Entered product cost per piece: $0.0375", { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText("$3.75");
  await expect(save).toBeEnabled();
  await dialog.getByPlaceholder("e.g. supplier invoice correction").fill("Synthetic product correction");
  await save.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("COST-PRECISION-1 PRECISE-LOT: cost correction saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "PRECISE-LOT" }).getByRole("cell", { name: "$0.04", exact: true })).toBeVisible();
  expect(recostRequests).toEqual([{ cost_per_piece: 0.0375, reason: "Synthetic product correction" }]);
  expect(failures).toEqual([]);
});

test("recost failure keeps the form open and asks the operator to verify the recorded lot before retrying", async ({ page }) => {
  const failures = await setup(page);
  let attempts = 0;
  await page.route("**/api/cogs/lots/9/recost", async (route) => {
    if (route.request().method() !== "POST") {
      failures.push("Unexpected recost method");
      return route.abort();
    }
    attempts++;
    return route.fulfill({ status: 500, json: { error: "Failed to recost lot" } });
  });
  await page.getByRole("tab", { name: "Explorer", exact: true }).click();
  await page.getByRole("button").filter({ hasText: "Synthetic precision" }).click();
  await page.getByRole("row").filter({ hasText: "PRECISE-LOT" }).getByTitle("Recost this lot").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("0.0000").fill("0.0375");
  await dialog.getByRole("button", { name: "Recost lot", exact: true }).click();
  await expect(page.getByText("Failed to recost lot. Refresh the lot and verify its recorded cost before trying again.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Recost lot", exact: true })).toBeEnabled();
  await expect(page.getByText("Lot recosted", { exact: true })).toHaveCount(0);
  expect(attempts).toBe(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(failures).toEqual([]);
});

test("CSV preview distinguishes integer mills from cent totals without a write", async ({ page }) => {
  const failures = await setup(page);
  let previews = 0;
  await page.route("**/api/cogs/lot-cost-upload*", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== "POST" || url.searchParams.has("apply")) {
      failures.push("Unexpected cost upload application");
      return route.abort();
    }
    previews++;
    return route.fulfill({ json: { apply: false, summary: { rows: 1, lotsAffected: 1, errors: 0 },
      results: [{ status: "preview", sku: "COST-PRECISION-100", upv: 100, lotNumber: "UPLOAD-LOT", location: "TEST", qty: 1,
        perPieceMills: 375, perPieceCents: 4, oldCostCents: 230, newCostCents: 375, newCostMills: 37500 }] } });
  });
  await page.getByRole("tab", { name: "Cost Upload", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "synthetic-cost.csv", mimeType: "text/csv", buffer: Buffer.from("sku,cost_per_piece\nCOST-PRECISION-100,0.0375\n") });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "UPLOAD-LOT" });
  await expect(row.getByRole("cell", { name: "$0.0375", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "$2.30", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "$3.75", exact: true })).toBeVisible();
  expect(previews).toBe(1);
  expect(failures).toEqual([]);
});
