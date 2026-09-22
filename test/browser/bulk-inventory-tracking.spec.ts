import { test, expect, type Page } from "playwright/test";
import { resolve } from "node:path";
import { BULK_INVENTORY_TRACKING_PATH, type BulkInventoryTrackingApply, type BulkInventoryTrackingRequest } from "../../shared/catalog/bulk-inventory-tracking";

async function setup(page: Page, edit = true) {
  const products = [
    { id: 1, name: "Group sticker", sku: "STICKER", productLineIds: [10], categoryId: 20, variants: [], inventoryTrackingDefault: true },
    { id: 2, name: "Group card", sku: "CARD", productLineIds: [10], categoryId: 21, variants: [{ id: 21, sku: "CARD-INHERITED" }, { id: 22, sku: "CARD-TRACKED" }], inventoryTrackingDefault: true },
    { id: 3, name: "Other group", sku: "OTHER", productLineIds: [11], categoryId: 20, variants: [], inventoryTrackingDefault: true },
  ].map(product => ({ ...product, isActive: true, status: "active", baseUnit: "piece" }));
  const state = { products, previews: [] as BulkInventoryTrackingRequest[], applies: [] as Array<{ body: BulkInventoryTrackingApply; key: string | undefined }>,
    blocked: false, newlyBlocked: false, stale: false, uncertain: false, errors: [] as string[] };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/api/**", async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "operator", username: "operator", role: "staff" }, permissions: edit ? ["inventory:view", "inventory:edit"] : ["inventory:view"], roles: [] } });
    if (path === "/api/products") return route.fulfill({ json: products });
    if (path === "/api/product-lines") return route.fulfill({ json: [{ id: 10, name: "Promotional group" }, { id: 11, name: "Other line" }] });
    if (path === "/api/product-categories") return route.fulfill({ json: [{ id: 20, name: "Stickers", isActive: true }, { id: 21, name: "Cards", isActive: true }] });
    if (path === `${BULK_INVENTORY_TRACKING_PATH}/preview`) {
      const body = req.postDataJSON() as BulkInventoryTrackingRequest; state.previews.push(body);
      return route.fulfill({ json: { previewHash: (body.productIds.length === 2 ? "a" : "b").repeat(64), inventoryTrackingDefault: body.inventoryTrackingDefault,
        products: body.productIds.map(id => { const product = products.find(p => p.id === id)!; return {
          productId: id, name: product.name, sku: product.sku, currentDefault: product.inventoryTrackingDefault,
          status: (state.blocked && id === 2) || (state.newlyBlocked && id === 1) ? "blocked" : product.inventoryTrackingDefault === body.inventoryTrackingDefault ? "unchanged" : "change",
          variantCount: product.variants.length, changingVariantCount: id === 2 ? 1 : 0, trackedOverrideCount: id === 2 ? 1 : 0, untrackedOverrideCount: 0,
          blockers: state.blocked && id === 2 ? [
            { variantId: 21, code: "stock", message: "CARD-INHERITED: stock or warehouse quantities", evidence: {
              totalCount: 1, records: [{ kind: "stock", recordId: 1284, locationId: 1, locationCode: "UNSORTED",
                onHand: 0, reserved: 0, picked: 1, packed: 0, backorder: 0 }] } },
            { variantId: 21, code: "lots", message: "CARD-INHERITED: inventory lots", evidence: {
              totalCount: 21, records: [{ kind: "lots", recordId: 1300, lotNumber: "LOT-RECON-0121", locationId: 1,
                locationCode: "UNSORTED", onHand: 0, reserved: 0, picked: 1, packed: 0 }] } },
            { variantId: 21, code: "oms_orders", message: "CARD-INHERITED: unfinished sales orders", evidence: {
              totalCount: 1, records: [{ kind: "oms_orders", recordId: 100036, orderId: 35774, orderNumber: "#56076",
                status: "confirmed", fulfillmentStatus: "unfulfilled", quantity: 6, warehouseOrderCount: 1,
                warehouseOrders: [{ orderId: 200540, orderNumber: "#56076", status: "cancelled" }] }] } },
          ] : state.newlyBlocked && id === 1 ? [{ variantId: null, code: "CATALOG_PRODUCT_MISSING", message: "Product no longer exists." }] : [],
        }; }),
      } });
    }
    if (path === `${BULK_INVENTORY_TRACKING_PATH}/apply`) {
      const body = req.postDataJSON() as BulkInventoryTrackingApply;
      state.applies.push({ body, key: req.headers()["idempotency-key"] });
      if (state.stale) { state.stale = false; return route.fulfill({ status: 409, json: { error: "Products changed. Review again.", code: "BULK_INVENTORY_PREVIEW_STALE" } }); }
      if (state.uncertain) { state.uncertain = false; return route.abort("connectionreset"); }
      body.productIds.forEach(id => { products.find(p => p.id === id)!.inventoryTrackingDefault = body.inventoryTrackingDefault; });
      return route.fulfill({ json: { inventoryTrackingDefault: body.inventoryTrackingDefault, changedProductIds: body.productIds,
        unchangedProductIds: [], changingVariantCount: 0, trackedOverrideCount: body.productIds.includes(2) ? 1 : 0, untrackedOverrideCount: 0 } });
    }
    state.errors.push(`Unexpected ${req.method()} ${path}`);
    return route.fulfill({ status: 404, json: { error: "Unexpected test request" } });
  });
  await page.route("**/__bulk-inventory-test*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><main id="root"></main><script type="module" src="/@fs/${resolve("test/browser/fixtures/bulk-inventory-tracking-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__bulk-inventory-test");
  await expect(page.getByTestId("select-productline-filter")).toBeVisible();
  return state;
}

async function selectGroup(page: Page) {
  await page.getByTestId("select-productline-filter").click();
  await page.getByRole("option", { name: "Promotional group", exact: true }).click();
  await page.getByRole("button", { name: "Select all 2 matching", exact: true }).click();
  await page.getByRole("button", { name: "Inventory tracking", exact: true }).click();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-review")).toBeVisible();
}

test("selects the filtered group, reviews product-only defaults and overrides, and refreshes after apply", async ({ page }, testInfo) => {
  const state = await setup(page); await selectGroup(page);
  expect(state.previews).toEqual([{ productIds: [1, 2], inventoryTrackingDefault: false }]);
  await expect(page.getByTestId("bulk-inventory-product-1")).toContainText("No variants");
  await expect(page.getByTestId("bulk-inventory-product-2")).toContainText("1 explicit Track");
  await expect(page.getByTestId("bulk-inventory-review")).toContainText("1 variant overrides preserved");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("bulk-review.png"), fullPage: true });
  await page.getByTestId("bulk-inventory-apply").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  await expect(page.getByText("Do not track", { exact: true }).filter({ visible: true })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("bulk-products.png"), fullPage: true });
  expect(state.applies[0]).toMatchObject({ body: { productIds: [1, 2], inventoryTrackingDefault: false, expectedPreviewHash: "a".repeat(64) } });
  expect(state.applies[0].key).toBeTruthy();
  expect(state.products[2].inventoryTrackingDefault).toBe(true); expect(state.errors).toEqual([]);
});

test("clears selection across filters and selects grid cards without navigating", async ({ page }) => {
  const state = await setup(page);
  await page.getByRole("button", { name: "Select all 3 matching" }).click();
  await page.getByTestId("select-category-filter").click(); await page.getByRole("option", { name: "Stickers", exact: true }).click();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Inventory tracking", exact: true })).toBeDisabled();
  await page.getByTestId("select-category-filter").click(); await page.getByRole("option", { name: "All Categories", exact: true }).click();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  await page.getByTestId("input-search-products").fill("CARD");
  await page.getByTestId("btn-view-grid").click();
  await page.getByTestId("product-card-2").getByRole("checkbox").click();
  await expect(page).toHaveURL(/__bulk-inventory-test/);
  await page.getByRole("button", { name: "Inventory tracking", exact: true }).click();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-review")).toBeVisible();
  expect(state.previews[0].productIds).toEqual([2]); expect(state.errors).toEqual([]);
});

test("shows exact blockers and order links and prevents a partial apply", async ({ page }, testInfo) => {
  const state = await setup(page); state.blocked = true; await selectGroup(page);
  await expect(page.getByTestId("bulk-inventory-apply")).toBeDisabled();
  await expect(page.getByTestId("bulk-inventory-product-2")).toContainText("stock or warehouse quantities");
  await expect(page.getByTestId("bulk-inventory-review")).toContainText("No products will change");
  const blocked = page.getByTestId("bulk-inventory-product-2");
  await expect(blocked).toContainText("UNSORTED (location 1)");
  await expect(blocked).toContainText("On hand 0 · Reserved 0 · Picked 1 · Packed 0 · Backorder 0");
  await expect(blocked).toContainText("Lot LOT-RECON-0121 (ID 1300)");
  await expect(blocked).toContainText("Showing 1 of 21 blocking records");
  await expect(blocked.getByRole("link", { name: /Sales order #56076/ })).toHaveAttribute("href", "/oms/orders?orderId=35774");
  await expect(blocked.getByRole("link", { name: /Warehouse order #56076/ })).toHaveAttribute("href", "/orders?orderId=200540");
  await expect(blocked).toContainText("confirmed · unfulfilled");
  await expect(blocked).toContainText("cancelled warehouse order does not establish that the sales order is cancelled");
  await page.getByRole("button", { name: "Show blockers only", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-product-1")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("bulk-blocker-details.png"), fullPage: true });
  expect(state.applies).toEqual([]); expect(state.errors).toEqual([]);
});

test("freshly reviews eligible products, retries their exact command, and retains excluded products for follow-up", async ({ page }) => {
  const state = await setup(page); state.blocked = true; await selectGroup(page);
  await page.getByRole("button", { name: "Review eligible products only (1)", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-excluded")).toContainText("1 excluded products will stay unchanged and selected");
  await expect(page.getByTestId("bulk-inventory-apply")).toBeEnabled();
  expect(state.previews).toEqual([{ productIds: [1, 2], inventoryTrackingDefault: false }, { productIds: [1], inventoryTrackingDefault: false }]);
  state.stale = true;
  await page.getByTestId("bulk-inventory-apply").click();
  await expect(page.getByTestId("bulk-inventory-apply")).toHaveCount(0);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-apply")).toBeEnabled();
  expect(state.previews.at(-1)?.productIds).toEqual([1]);
  state.uncertain = true;
  await page.getByTestId("bulk-inventory-apply").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByTestId("bulk-inventory-apply").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.applies).toHaveLength(3);
  expect(state.applies[1]).toEqual(state.applies[2]);
  expect(state.applies[0].key).not.toBe(state.applies[1].key);
  expect(state.applies[2].body).toEqual({ productIds: [1], inventoryTrackingDefault: false, expectedPreviewHash: "b".repeat(64) });
  expect(state.products.map(p => p.inventoryTrackingDefault)).toEqual([false, true, true]);
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inventory tracking", exact: true }).click();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-product-2")).toBeVisible();
  expect(state.previews.at(-1)?.productIds).toEqual([2]);
  expect(state.errors).toEqual([]);
});

test("re-reviews the full selection and refuses a subset that becomes blocked", async ({ page }) => {
  const state = await setup(page); state.blocked = true; await selectGroup(page);
  await page.getByRole("button", { name: "Review eligible products only (1)", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-apply")).toBeEnabled();
  await page.getByRole("button", { name: "Review full selection", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-product-2")).toBeVisible();
  await expect(page.getByTestId("bulk-inventory-apply")).toBeDisabled();
  state.newlyBlocked = true;
  await page.getByRole("button", { name: "Review eligible products only (1)", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-product-1")).toContainText("Product no longer exists");
  await expect(page.getByTestId("bulk-inventory-apply")).toBeDisabled();
  expect(state.previews.map(p => p.productIds)).toEqual([[1, 2], [1], [1, 2], [1]]);
  expect(state.applies).toEqual([]); expect(state.errors).toEqual([]);
});

test("requires a fresh review after stale state and keeps the command key for a transport retry", async ({ page }) => {
  const state = await setup(page); state.stale = true; await selectGroup(page);
  await page.getByTestId("bulk-inventory-apply").click();
  await expect(page.getByRole("alert")).toContainText("Review again");
  await expect(page.getByTestId("bulk-inventory-apply")).toHaveCount(0);
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.getByTestId("bulk-inventory-review")).toBeVisible();
  state.uncertain = true; await page.getByTestId("bulk-inventory-apply").click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByTestId("bulk-inventory-apply").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.applies).toHaveLength(3);
  expect(state.applies[1]).toEqual(state.applies[2]); expect(state.applies[0].key).not.toBe(state.applies[1].key);
  expect(state.errors).toEqual([]);
});

test("hides bulk editing from users without inventory edit permission", async ({ page }) => {
  const state = await setup(page, false);
  await expect(page.getByTestId("bulk-product-actions")).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  expect(state.previews).toEqual([]); expect(state.errors).toEqual([]);
});
