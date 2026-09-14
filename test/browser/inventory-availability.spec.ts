import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const variantLevels = [
  {
    variantId: 200,
    sku: "CARD-P5",
    name: "Pack of 5",
    unitsPerVariant: 5,
    parentVariantId: null,
    hierarchyLevel: 1,
    isBaseUnit: false,
    baseSku: "CARD",
    productId: 10,
    productName: "Card",
    inventoryStrategy: "physical_fungible",
    variantQty: 2,
    reservedQty: 0,
    pickedQty: 4,
    unreservedQty: 2,
    atpUnits: 7,
    available: 7,
    locationCount: 1,
    pickableQty: 2,
    isDuplicate: false,
    barcode: "P5",
    binCount: 1,
    noBin: false,
    noCaseBreak: false,
    noBarcode: false,
    noReplen: false,
    overReserved: false,
    negativeQty: false,
  },
  {
    variantId: 300,
    sku: "CARD-C25",
    name: "Case of 25",
    unitsPerVariant: 25,
    parentVariantId: 200,
    hierarchyLevel: 2,
    isBaseUnit: false,
    baseSku: "CARD",
    productId: 10,
    productName: "Card",
    inventoryStrategy: "physical_fungible",
    variantQty: 84,
    reservedQty: 0,
    pickedQty: 0,
    unreservedQty: 84,
    atpUnits: 3,
    available: 3,
    locationCount: 1,
    pickableQty: 84,
    isDuplicate: false,
    barcode: "C25",
    binCount: 1,
    noBin: false,
    noCaseBreak: false,
    noBarcode: false,
    noReplen: false,
    overReserved: false,
    negativeQty: false,
  },
];

async function setup(page: Page) {
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1"
    ? route.continue()
    : route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET") {
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: "Unexpected write" } });
    }
    if (path === "/api/auth/me") return route.fulfill({ json: {
      user: { id: "operator-1", username: "operator", role: "operator" },
      permissions: ["inventory:view", "inventory:edit"],
      roles: ["operator"],
    } });
    if (path === "/api/inventory/quantity-capabilities") {
      return route.fulfill({ json: { legacyQuantityImportAllowed: false } });
    }
    if (path === "/api/warehouses") return route.fulfill({ json: [] });
    if (path === "/api/operations/location-health") return route.fulfill({ json: {
      totalLocations: 1,
      emptyLocations: 0,
      recentTransferCount: 0,
      recentAdjustmentCount: 0,
    } });
    if (path === "/api/purchasing/reorder-analysis") return route.fulfill({ json: {
      items: [],
      summary: { outOfStock: 0, belowReorderPoint: 0, orderSoon: 0, noMovement: 0 },
    } });
    if (path === "/api/inventory/levels") return route.fulfill({ json: variantLevels });
    if (path === "/api/inventory/variants/200/locations") return route.fulfill({ json: [{
      id: 91,
      variantQty: 2,
      reservedQty: 1,
      pickedQty: 4,
      unreservedQty: 1,
      available: 1,
      isAssigned: true,
      location: { id: 8, code: "PICK-1", name: "Pick one", locationType: "pick", isPickable: 1, warehouseId: 1 },
    }] });
    if (path === "/api/inventory/variants/300/locations") return route.fulfill({ json: [{
      id: 92,
      variantQty: 84,
      reservedQty: 0,
      pickedQty: 0,
      unreservedQty: 84,
      available: 999,
      isAssigned: true,
      location: { id: 9, code: "RESERVE-1", name: "Reserve one", locationType: "reserve", isPickable: 0, warehouseId: 1 },
    }] });
    if (path === "/api/warehouse/locations") return route.fulfill({ json: [
      { id: 8, code: "PICK-1", locationType: "pick", zone: "A", warehouseId: 1, isActive: 1 },
      { id: 9, code: "RESERVE-1", locationType: "reserve", zone: "A", warehouseId: 1, isActive: 1 },
    ] });
    if (path === "/api/inventory/by-bin") return route.fulfill({ json: [{
      locationId: 8,
      locationCode: "PICK-1",
      locationType: "pick",
      zone: "A",
      isPickable: true,
      warehouseId: 1,
      warehouseCode: "MAIN",
      assignedSku: "CARD-P5",
      items: [{ inventoryLevelId: 91, variantId: 200, sku: "CARD-P5", variantName: "Pack of 5",
        productName: "Card", variantQty: 10, reservedQty: 3, pickedQty: 8, unreservedQty: 7,
        available: 999, isAssigned: true }],
      totalQty: 10,
      totalReserved: 3,
      totalUnreservedQty: 7,
      totalAvailable: 999,
      skuCount: 1,
      hasUnassigned: false,
    }] });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected request" } });
  });
  await page.route("**/__inventory-availability-test", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" />
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head>
      <body><main id="root" style="height:900px"></main><script type="module" src="/@fs/${resolve(process.cwd(), "test/browser/fixtures/inventory-availability-harness.tsx").replaceAll("\\", "/")}"></script></body></html>`,
  }));
  await page.goto("/__inventory-availability-test");
  await expect(page.getByRole("heading", { name: "Inventory", exact: true }), JSON.stringify(errors)).toBeVisible();
  return { unexpected, errors };
}

test("renders authority ATP and keeps physical bin stock explicitly unreserved", async ({ page }, testInfo) => {
  const state = await setup(page);
  const mobile = testInfo.project.name === "mobile";
  const variant = mobile
    ? page.getByTestId("card-variant-200")
    : page.getByTestId("row-variant-200");
  await expect(variant).toContainText("CARD-P5");
  await expect(variant).toContainText("7");
  await expect(page.getByText("422", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Fungible pool", { exact: false })).toHaveCount(0);
  if (mobile) {
    await expect(variant.getByText("ATP", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("columnheader", { name: "ATP", exact: true })).toBeVisible();
    await variant.click();
    await expect(page.getByText("Unreserved", { exact: true })).toBeVisible();
    await expect(page.getByText("PICK-1", { exact: true })).toBeVisible();
    await expect(page.getByText("Legacy case-break controls — physical stock only; ATP above is server-calculated", { exact: true })).toBeVisible();
    await expect(page.getByText("RESERVE-1", { exact: true })).toBeVisible();
    const breakCaseButton = page.getByRole("button", { name: "Break Case", exact: true });
    await expect(breakCaseButton).toBeEnabled();
    await breakCaseButton.click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Break Case", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("CARD-C25");
    await expect(page.getByRole("dialog")).toContainText("CARD-P5");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  }

  await page.getByRole("tab", { name: "By Bin", exact: true }).click();
  if (mobile) {
    await expect(page.getByLabel("Unreserved 7", { exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("columnheader", { name: "Unreserved", exact: true })).toBeVisible();
    const zoneRow = page.getByRole("row").filter({ hasText: "MAIN — A" });
    await expect(zoneRow).toContainText("7");
    await zoneRow.click();
    const row = page.getByRole("row").filter({ hasText: "CARD-P5" });
    await expect(row).toContainText("7");
    await expect(row).not.toContainText("999");
  }
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});
