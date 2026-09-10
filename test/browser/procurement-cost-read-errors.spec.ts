import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";

const product = {
  productId: 1, productName: "Cost test product", baseSku: "COST-READ",
  totalQty: 100, avgCostPerPiece: 4, totalValueCents: 375, activeLots: 1,
  zeroCostQty: 0, hasLandedPending: false,
};
const valuation = {
  totalValueCents: 375, totalQty: 100, zeroCostQty: 0, provisionalQty: 0,
  landedPendingLots: 0, landedPendingValueCents: 0, byProduct: [product],
};
const emptyValuation = { ...valuation, totalValueCents: 0, totalQty: 0, byProduct: [] };
const lot = {
  id: 1, lot_number: "COST-READ-LOT", product_id: 1, product_name: product.productName,
  base_sku: product.baseSku, sku: "COST-READ-PACK", qty_on_hand: 100, qty_received: 100, units_per_variant: 100,
  po_unit_cost_mills: "350", landed_cost_mills: "25", total_unit_cost_mills: "375", unit_cost_mills: "375",
  po_unit_cost_cents: "4", landed_cost_cents: "0", total_unit_cost_cents: "4", unit_cost_cents: "4",
  cost_provisional: 0, cost_source: "manual", received_at: "2026-09-01T12:00:00.000Z",
};

type Reply = { status: number; body: unknown; raw?: boolean };
const surfaces = [
  { name: "valuation", tab: "Valuation", title: "Inventory valuation", endpoint: "/api/cogs/valuation", valid: valuation, empty: emptyValuation,
    malformed: { ...valuation, totalValueCents: null }, emptyMessage: "No active cost lots with remaining inventory were found." },
  { name: "explorer", tab: "Explorer", title: "Cost explorer", endpoint: "/api/cogs/lots", valid: { lots: [lot], total: 1 }, empty: { lots: [], total: 0 },
    malformed: { lots: [{ ...lot, qty_on_hand: "100" }], total: 1 }, emptyMessage: "No lots found." },
] as const;

async function setup(page: Page, surface: typeof surfaces[number], reply: () => Reply) {
  const failures = await installFixtures(page);
  await page.route("**/api/cogs/**", async (route) => {
    if (route.request().method() !== "GET") {
      failures.push(`Unexpected cost mutation: ${route.request().method()}`);
      return route.abort();
    }
    const endpoint = new URL(route.request().url()).pathname;
    if (!["/api/cogs/valuation", "/api/cogs/lots"].includes(endpoint)) {
      failures.push(`Unexpected cost read: ${endpoint}`);
      return route.abort();
    }
    const response: Reply = endpoint === surface.endpoint ? reply() : {
      status: 200, body: endpoint === "/api/cogs/lots" ? { lots: [lot], total: 1 } : valuation,
    };
    return route.fulfill({ status: response.status, contentType: "application/json", body: response.raw ? String(response.body) : JSON.stringify(response.body) });
  });
  await page.goto("/inventory/costs");
  await page.getByRole("tab", { name: surface.tab, exact: true }).click();
  return failures;
}

for (const surface of surfaces) {
  test(`${surface.name}: HTTP failure is visible and retry loads the recorded report`, async ({ page }) => {
    let reply: Reply = { status: 500, body: { error: "private database details" } };
    const failures = await setup(page, surface, () => reply);
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("alert")).toContainText(`${surface.title} could not be loaded`);
    await expect(panel.getByRole("alert")).toContainText("HTTP 500");
    await expect(panel).not.toContainText("private database details");
    await expect(panel.getByText(surface.emptyMessage, { exact: true })).toHaveCount(0);
    await expect(panel.getByText("$0.00", { exact: true })).toHaveCount(0);
    reply = { status: 200, body: surface.valid };
    await panel.getByRole("button", { name: `Retry ${surface.title.toLowerCase()}`, exact: true }).click();
    await expect(panel.getByText(product.productName, { exact: true })).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(failures).toEqual([]);
  });

  test(`${surface.name}: malformed success cannot impersonate an empty report`, async ({ page }) => {
    let reply: Reply = { status: 200, body: surface.malformed };
    const failures = await setup(page, surface, () => reply);
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByRole("alert")).toContainText("response is incomplete or invalid");
    await expect(panel.getByText(surface.emptyMessage, { exact: true })).toHaveCount(0);
    reply = { status: 200, body: "not valid JSON", raw: true };
    await panel.getByRole("button", { name: `Retry ${surface.title.toLowerCase()}`, exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("response is incomplete or invalid");
    reply = { status: 200, body: surface.valid };
    await panel.getByRole("button", { name: `Retry ${surface.title.toLowerCase()}`, exact: true }).click();
    await expect(panel.getByText(product.productName, { exact: true })).toBeVisible();
    expect(failures).toEqual([]);
  });

  test(`${surface.name}: explicit successful empty state is distinct from failure`, async ({ page }) => {
    const failures = await setup(page, surface, () => ({ status: 200, body: surface.empty }));
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText(surface.emptyMessage, { exact: true })).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    if (surface.name === "valuation") {
      await expect(panel.getByText("$0.00", { exact: true })).toBeVisible();
      await expect(panel.getByText("Not recorded", { exact: true })).toHaveCount(0);
    }
    expect(failures).toEqual([]);
  });

  test(`${surface.name}: failed remount hides cached report values until retry succeeds`, async ({ page }) => {
    let reply: Reply = { status: 200, body: surface.valid };
    const failures = await setup(page, surface, () => reply);
    const panel = page.getByRole("tabpanel");
    await expect(panel.getByText(product.productName, { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: surface.tab === "Valuation" ? "Explorer" : "Valuation", exact: true }).click();
    reply = { status: 500, body: { error: "offline" } };
    await page.getByRole("tab", { name: surface.tab, exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("HTTP 500");
    await expect(panel.getByText(product.productName, { exact: true })).toHaveCount(0);
    reply = { status: 200, body: surface.valid };
    await panel.getByRole("button", { name: `Retry ${surface.title.toLowerCase()}`, exact: true }).click();
    await expect(panel.getByText(product.productName, { exact: true })).toBeVisible();
    expect(failures).toEqual([]);
  });
}
