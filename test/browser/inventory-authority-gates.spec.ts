import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

type Authority = "legacy" | "canonical" | "unavailable";

async function setup(page: Page, mode: "allocation" | "reserves" | "warehouses", authority: Authority) {
  const state = { unexpected: [] as string[], errors: [] as string[] };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1"
    ? route.continue()
    : route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/auth/me") {
      return route.fulfill({ json: {
        user: { id: "operator-1", username: "operator", role: "admin" },
        permissions: ["channels:view", "channels:edit", "inventory:view", "inventory:edit", "inventory_planning:view"],
        roles: ["admin"],
      } });
    }
    if (request.method() === "GET" && path === "/api/inventory-planning/runtime-authority") {
      if (authority === "unavailable") {
        return route.fulfill({ status: 503, json: { error: { message: "Authority unavailable" } } });
      }
      return route.fulfill({ json: {
        contractVersion: "inventory_runtime_authority_readout_v1",
        authority,
        liveAllocator: authority === "legacy" ? "channel_allocation_rules" : "inventory_exposure",
        revision: "7",
        activationRunId: authority === "legacy" ? null : "42",
        changedBy: "operator-1",
        changeReason: "Approved cutover",
        changedAt: "2026-09-13T12:00:00.000Z",
      } });
    }
    if (request.method() === "GET" && path === "/api/warehouses") {
      return route.fulfill({ json: [{
        id: 1,
        code: "MAIN",
        name: "Main Warehouse",
        warehouseType: "operations",
        hubWarehouseId: null,
        address: null,
        city: "New Castle",
        state: "DE",
        postalCode: "19720",
        country: "US",
        timezone: "America/New_York",
        orderCutoffLocal: null,
        isActive: 1,
        isDefault: 1,
        shopifyLocationId: null,
        inventorySourceType: "internal",
        inventorySourceConfig: null,
        lastInventorySyncAt: null,
        inventorySyncStatus: null,
        feedEnabled: true,
        createdAt: "2026-09-14T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z",
      }] });
    }
    if (request.method() === "GET" && path === "/api/channels") {
      return route.fulfill({ json: [] });
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected request" } });
  });
  await page.route("**/__inventory-authority-gates-test**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
      <body><main id="root"></main><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/inventory-authority-gates-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.goto(`/__inventory-authority-gates-test?mode=${mode}`);
  return state;
}

test.describe("inventory runtime authority gates", () => {
  for (const mode of ["allocation", "reserves"] as const) {
    test(`${mode} retires legacy controls after canonical activation without reading legacy data`, async ({ page }) => {
      const state = await setup(page, mode, "canonical");
      await expect(page.getByText(
        mode === "allocation" ? "Legacy Channel Allocation is retired" : "Legacy channel reserves are retired",
        { exact: true },
      )).toBeVisible();
      await expect(page.getByRole("link", { name: "Open Inventory Exposure", exact: true })).toBeVisible();
      expect(state.unexpected).toEqual([]);
      expect(state.errors).toEqual([]);
    });

    test(`${mode} fails closed when authority cannot be read`, async ({ page }) => {
      const state = await setup(page, mode, "unavailable");
      await expect(page.getByText(
        mode === "allocation" ? "Channel Allocation controls are unavailable" : "Channel reserve controls are unavailable",
        { exact: true },
      )).toBeVisible();
      expect(state.unexpected).toEqual([]);
      expect(state.errors).toEqual([]);
    });
  }

  test("warehouses exposes the legacy feed switch only under confirmed legacy authority", async ({ page }) => {
    const state = await setup(page, "warehouses", "legacy");
    await expect(page.getByRole("switch")).toBeVisible();
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("warehouses replaces the obsolete feed switch under canonical authority", async ({ page }) => {
    const state = await setup(page, "warehouses", "canonical");
    await expect(page.getByText("Inventory Exposure", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test("warehouses fails closed while runtime authority is unknown", async ({ page }) => {
    const state = await setup(page, "warehouses", "unavailable");
    await expect(page.getByText("Authority unknown", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });
});
