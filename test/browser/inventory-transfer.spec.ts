import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, options: { fixed?: boolean; warehouseFailure?: boolean; lostResponse?: boolean } = {}) {
  const state = { writes: [] as Record<string, unknown>[], errors: [] as string[], unexpected: [] as string[], warehouseFailure: options.warehouseFailure ?? false };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/inventory/transfer") {
      state.writes.push(request.postDataJSON());
      if (options.lostResponse && state.writes.length === 1) return route.abort("failed");
      return route.fulfill({ json: { success: true, reservedMoved: 0, orderItemsRepointed: 0 } });
    }
    if (request.method() !== "GET") {
      state.unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: "Unexpected write" } });
    }
    if (path === "/api/auth/me") return route.fulfill({ json: {
      user: { id: "operator", username: "operator", role: "admin" }, permissions: ["inventory:view", "inventory:adjust"], roles: ["admin"],
    } });
    if (path === "/api/warehouses") return state.warehouseFailure
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.fulfill({ json: [
        { id: 1, code: "LEON", name: "20 Leonberg", isActive: 1 },
        { id: 2, code: "RTE-19", name: "Route 19 reserve", isActive: 1 },
        { id: 3, code: "CLOSED", name: "Closed warehouse", isActive: 0 },
      ] });
    if (path === "/api/warehouse/locations") return route.fulfill({ json: [
      { id: 9, code: "FLOOR-01", locationType: "reserve", warehouseId: 2, zone: "F", isActive: 1 },
      { id: 10, code: "FLOOR-03", locationType: "pick", warehouseId: 1, zone: "F", isActive: 1 },
      { id: 11, code: "FLOOR-02", locationType: "reserve", warehouseId: 2, zone: "F", isActive: 1 },
      { id: 12, code: "INACTIVE", locationType: "pick", warehouseId: 1, zone: "F", isActive: 0 },
      { id: 13, code: "UNASSIGNED", locationType: "pick", warehouseId: null, zone: "F", isActive: 1 },
    ] });
    if (path === "/api/inventory/skus/search") return route.fulfill({ json: [
      { variantId: 174, sku: "SHLZ-SEMI-OVR-C2000", name: "Case of 2000", available: 200 },
    ] });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected read" } });
  });
  await page.route("**/__inventory-transfer-test**", (route) => route.fulfill({ contentType: "text/html", body:
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
    <body><main id="root"></main><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/inventory-transfer-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(`/__inventory-transfer-test?fixed=${options.fixed !== false}`);
  await page.getByRole("button", { name: "Move cases" }).click();
  await expect(page.getByRole("heading", { name: "Transfer Inventory" })).toBeVisible();
  return state;
}

async function selectDestination(page: Page, warehouse = "LEON — 20 Leonberg", location = "FLOOR-03 (pick)") {
  await page.getByLabel("To Warehouse", { exact: true }).click();
  await page.getByRole("option", { name: warehouse, exact: true }).click();
  await page.getByLabel("To Location", { exact: true }).click();
  await expect(page.getByRole("option", { name: /INACTIVE|UNASSIGNED|FLOOR-01/ })).toHaveCount(0);
  await page.getByRole("option", { name: location, exact: true }).click();
}

test("shows both buildings and records an explicitly arrived cross-warehouse transfer", async ({ page }, testInfo) => {
  const state = await setup(page);
  await expect(page.getByLabel("From Warehouse", { exact: true })).toHaveValue("RTE-19 — Route 19 reserve");
  await expect(page.getByLabel("From Location", { exact: true })).toHaveValue("FLOOR-01");
  await page.getByLabel(/^Quantity/).fill("50");
  await selectDestination(page);
  await expect(page.getByTestId("transfer-route")).toContainText("RTE-19 — Route 19 reserve · FLOOR-01 (reserve)");
  await expect(page.getByTestId("transfer-route")).toContainText("LEON — 20 Leonberg · FLOOR-03 (pick)");
  const transfer = page.getByRole("button", { name: "Transfer", exact: true });
  await expect(transfer).toBeDisabled();
  await page.getByLabel("The stock has arrived at the destination location.").check();
  await page.screenshot({ path: testInfo.outputPath("warehouse-transfer.png"), fullPage: true });
  await transfer.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes).toEqual([expect.objectContaining({ fromLocationId: 9, toLocationId: 10, variantId: 174,
    quantity: 50, crossWarehouseArrivalConfirmed: true, commandKey: expect.any(String) })]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("clears destination when warehouse changes and leaves same-warehouse moves unchanged", async ({ page }) => {
  const state = await setup(page);
  await page.getByLabel(/^Quantity/).fill("1.5");
  await selectDestination(page);
  await page.getByLabel("The stock has arrived at the destination location.").check();
  await expect(page.getByRole("button", { name: "Transfer", exact: true })).toBeDisabled();
  await page.getByLabel(/^Quantity/).fill("50");
  await expect(page.getByLabel("The stock has arrived at the destination location.")).not.toBeChecked();
  await page.getByLabel("To Warehouse", { exact: true }).click();
  await page.getByRole("option", { name: "RTE-19 — Route 19 reserve", exact: true }).click();
  await expect(page.getByLabel("To Location", { exact: true })).toContainText("Select location");
  await expect(page.getByRole("button", { name: "Transfer", exact: true })).toBeDisabled();
  await page.getByLabel("To Location", { exact: true }).click();
  await page.getByRole("option", { name: "FLOOR-02 (reserve)", exact: true }).click();
  await expect(page.getByLabel("The stock has arrived at the destination location.")).toHaveCount(0);
  await page.getByRole("button", { name: "Transfer", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes[0]).toMatchObject({ fromLocationId: 9, toLocationId: 11, quantity: 50 });
  expect(state.writes[0]).not.toHaveProperty("crossWarehouseArrivalConfirmed");
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("chooses a source warehouse first and keeps source and destination searches independent", async ({ page }) => {
  const state = await setup(page, { fixed: false });
  await page.getByLabel("From Warehouse", { exact: true }).click();
  await expect(page.getByRole("option", { name: /CLOSED/ })).toHaveCount(0);
  await page.getByRole("option", { name: "RTE-19 — Route 19 reserve", exact: true }).click();
  await page.getByLabel("Search from locations").fill("FLOOR-01");
  await page.getByLabel("From Location", { exact: true }).click();
  await page.getByRole("option", { name: "FLOOR-01 (reserve)", exact: true }).click();
  await page.getByLabel("SKU", { exact: true }).click();
  await page.getByRole("option", { name: /SHLZ-SEMI-OVR-C2000/ }).click();
  await page.getByLabel(/^Quantity/).fill("50");
  await selectDestination(page);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(state.writes).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("blocks transfer when warehouse lookup fails and can reload it", async ({ page }) => {
  const state = await setup(page, { warehouseFailure: true });
  await expect(page.getByRole("alert")).toContainText("Could not load warehouse");
  await expect(page.getByRole("button", { name: "Transfer", exact: true })).toBeDisabled();
  state.warehouseFailure = false;
  await page.getByRole("button", { name: "Retry loading", exact: true }).click();
  await expect(page.getByLabel("From Warehouse", { exact: true })).toHaveValue("RTE-19 — Route 19 reserve");
  await selectDestination(page);
  expect(state.writes).toEqual([]); expect(state.errors).toEqual([]);
});

test("reuses the same transfer command after a lost response", async ({ page }) => {
  const state = await setup(page, { lostResponse: true });
  await page.getByLabel(/^Quantity/).fill("50");
  await selectDestination(page);
  await page.getByLabel("The stock has arrived at the destination location.").check();
  const transfer = page.getByRole("button", { name: "Transfer", exact: true });
  await transfer.click();
  await expect(page.getByText("Transfer failed", { exact: true })).toBeVisible();
  await transfer.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.writes).toHaveLength(2); expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});
