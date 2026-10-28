import { expect, test, type Page } from "@playwright/test";
import { generatePurchasingRecommendations } from "../../server/modules/procurement/purchasing-recommendation.engine";
import { installFixtures } from "./procurement-fixtures";

const SAVED = "echelon:order-supplier-handoff:v1:test-user";
const base = { product_id: 10, variant_id: 100, base_sku: "NEEDS-SUPPLIER", product_name: "Synthetic supplier setup item",
  total_pieces: 0, total_reserved_pieces: 0, total_outbound_pieces: 300, previous_outbound_pieces: 300,
  demand_order_count: 20, demand_active_days: 15, latest_demand_at: "2026-10-27T12:00:00.000Z",
  on_order_pieces: 0, open_po_count: 0, inbound_schedule: [], vendor_lead_time_days: 14, safety_stock_days: 7, order_uom_units: 1,
  vendor_product_id: null, preferred_vendor_id: null };

async function setup(page: Page, canEdit = true) {
  const failures = await installFixtures(page);
  const state = { mapped: false, analysisUnavailable: false, changedUnit: false, writes: [] as Array<Record<string, unknown>> };
  const vendors = [{ id: 7, code: "HANDOFF", name: "Synthetic handoff supplier", active: 1, currency: "USD", defaultLeadTimeDays: 14 }];
  const products = [{ id: 10, baseSku: "NEEDS-SUPPLIER", name: "Synthetic supplier setup item" },
    { id: 11, baseSku: "EXISTING-SUPPLIER", name: "Synthetic existing supplier item" }];
  const variants = products.map((product, index) => ({ id: 100 + index, productId: product.id, sku: product.baseSku,
    name: "Piece", unitsPerVariant: 1, hierarchyLevel: 1, isActive: true, isBaseUnit: true }));
  function analysis() {
    const assigned = { ...base, vendor_product_id: 71, preferred_vendor_id: 7, preferred_vendor_name: vendors[0].name,
      vendor_currency: "USD", vendor_pricing_basis: "per_piece", vendor_quoted_unit_cost_mills: 123456,
      vendor_quoted_at: "2026-10-28T00:00:00.000Z", vendor_product_updated_at: "2026-10-28T00:00:00.000Z" };
    return generatePurchasingRecommendations({ asOf: "2026-10-28T12:00:00.000Z", lookbackDays: 30,
      rows: [{ ...(state.mapped ? assigned : base), variant_id: state.changedUnit ? 102 : 100 },
        { ...assigned, product_id: 11, variant_id: 101, base_sku: "EXISTING-SUPPLIER", vendor_product_id: 72 }] });
  }
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/vendor-products") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push(body); state.mapped = true;
      return route.fulfill({ status: 201, json: { id: 71, ...body } });
    }
    if (request.method() !== "GET") return route.fallback();
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "test-user", username: "test", role: "admin" }, roles: ["admin"],
      permissions: ["purchasing:view", "inventory:view", ...(canEdit ? ["purchasing:edit"] : [])] } });
    if (path === "/api/settings/procurement") return route.fulfill({ json: { useNewReorderCockpit: true } });
    if (path === "/api/purchasing/reorder-analysis") return route.fulfill(state.analysisUnavailable
      ? { status: 503, json: { error: "Synthetic current analysis unavailable" } } : { json: analysis() });
    if (path === "/api/purchasing/kpis") return route.fulfill({ json: { criticalRestocks: 0, upcomingRestocks: 0,
      idleCapitalCents: 0, inboundPipelineValueCents: 0, totalOpenLines: 0, lastComputedAt: "2026-10-28T12:00:00.000Z" } });
    if (path === "/api/purchasing/rfq-queue") return route.fulfill({ json: { items: [] } });
    if (path === "/api/vendors") return route.fulfill({ json: vendors });
    if (path === "/api/products") return route.fulfill({ json: products });
    if (path === "/api/product-variants") return route.fulfill({ json: variants });
    if (path === "/api/vendors/7/products") return route.fulfill({ json: [] });
    return route.fallback();
  });
  await page.goto("/reorder-analysis");
  await page.getByRole("checkbox", { name: "Add NEEDS-SUPPLIER to order", exact: true }).check();
  await page.getByRole("checkbox", { name: "Add EXISTING-SUPPLIER to order", exact: true }).check();
  await page.getByRole("button", { name: "Open order builder", exact: true }).click();
  const builder = page.getByRole("dialog");
  await builder.getByLabel("Pieces for EXISTING-SUPPLIER", { exact: true }).fill("200");
  await builder.getByLabel("Pieces for EXISTING-SUPPLIER", { exact: true }).blur();
  return { failures, state, builder };
}
async function handoff(page: Page) {
  await page.getByRole("button", { name: "Set up supplier for NEEDS-SUPPLIER", exact: true }).click();
  await expect(page).toHaveURL(/\/suppliers\?setupProductId=10&/);
  expect(new URL(page.url()).searchParams.get("setupVariantId")).toBe("100");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/reorder-analysis");
  expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).body.lines.map((line: { pieces: number }) => line.pieces), SAVED)).toEqual([210, 200]);
}

test("supplier setup returns all selected quantities for fresh review without creating a PO or RFQ", async ({ page }, info) => {
  const { failures, state, builder } = await setup(page);
  await expect(builder.getByRole("button", { name: /Continue/ })).toBeDisabled();
  await handoff(page);
  await page.getByText("Synthetic handoff supplier", { exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: /^Map (?:target SKU|NEEDS-SUPPLIER)$/ }).filter({ visible: true }).click();
  const mapping = page.getByRole("dialog", { name: "Add Product Mapping", exact: true });
  await expect(mapping).toContainText("Synthetic supplier setup item");
  await mapping.getByPlaceholder("2.6320", { exact: true }).fill("12.3456");
  await mapping.getByRole("button", { name: "Add Product", exact: true }).click();
  await expect(page).toHaveURL(/\/reorder-analysis$/);
  await expect(page.getByRole("button", { name: "Review saved order", exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Review saved order", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Pieces for NEEDS-SUPPLIER", { exact: true })).toHaveValue("210");
  await expect(page.getByRole("dialog").getByLabel("Pieces for EXISTING-SUPPLIER", { exact: true })).toHaveValue("200");
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ vendorId: 7, productId: 10, productVariantId: 100, isPreferred: 1,
    pricing: { basis: "per_piece", unitCostMills: 123456 } });
  expect(await page.evaluate(key => sessionStorage.getItem(key), SAVED)).toBeNull();
  expect(failures).toEqual([]);
  await page.screenshot({ path: info.outputPath("restored-supplier-order.png"), fullPage: true });
});

test("cancelled supplier setup keeps the saved order and its missing-supplier action", async ({ page }) => {
  const { failures, state } = await setup(page); await handoff(page);
  await page.getByRole("button", { name: "Back to purchasing", exact: true }).click();
  await page.getByRole("button", { name: "Review saved order", exact: true }).click();
  await expect(page.getByRole("button", { name: "Set up supplier for NEEDS-SUPPLIER", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Pieces for EXISTING-SUPPLIER", { exact: true })).toHaveValue("200");
  expect(state.writes).toEqual([]); expect(failures).toEqual([]);
});

test("storage failure retains the visible order and prevents leaving for setup", async ({ page }) => {
  const { state, builder } = await setup(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("Synthetic storage quota"); }; });
  await page.getByRole("button", { name: "Set up supplier for NEEDS-SUPPLIER", exact: true }).click();
  await expect(builder.getByRole("alert")).toContainText("Supplier setup was not opened");
  await expect(page).toHaveURL(/\/reorder-analysis$/); expect(state.writes).toEqual([]);
  await expect(builder.getByLabel("Pieces for EXISTING-SUPPLIER", { exact: true })).toHaveValue("200");
});

for (const changed of ["unavailable analysis", "changed receive variant"] as const) {
  test(`return with ${changed} retains the exact saved draft`, async ({ page }) => {
    const { state } = await setup(page); await handoff(page);
    const original = await page.evaluate(key => sessionStorage.getItem(key), SAVED);
    if (changed === "unavailable analysis") state.analysisUnavailable = true; else state.changedUnit = true;
    await page.getByRole("button", { name: "Back to purchasing", exact: true }).click();
    await page.getByRole("button", { name: "Review saved order", exact: true }).click();
    await expect(page.getByRole("region", { name: "Supplier setup order recovery" }).getByRole("alert")).toBeVisible();
    expect(await page.evaluate(key => sessionStorage.getItem(key), SAVED)).toBe(original);
    expect(state.writes).toEqual([]);
  });
}

test("view-only purchasing does not dispatch supplier setup", async ({ page }) => {
  const { state, builder } = await setup(page, false);
  await expect(builder.getByRole("button", { name: "Set up supplier for NEEDS-SUPPLIER", exact: true })).toBeDisabled();
  await expect(builder).toContainText("Purchasing edit permission is required"); expect(state.writes).toEqual([]);
});
