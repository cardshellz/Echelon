import { expect, test, type Locator, type Page } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";
import { openReceivingLineOptions, openReceivingMoreActions, openReceivingPackSelector, openReceivingSetup } from "./procurement-receiving-helpers";

const initialVersion = "a".repeat(64);
const savedVersion = "b".repeat(64);
const products = [
  ["EG-SLV-SLM", "Easy Glide Soft Sleeves - Slim Fit up to 55PT", 10000, 80],
  ["EG-SLV-STD-5PCK", "Easy Glide Soft Sleeves Standard", 10000, 200],
  ["EG-SLV-TOB", "Easy Glide Soft Sleeves Tobacco/Mini", 5000, 25],
  ["GLV-TOP-35PT", "Glove-Fit Sleeve Toploader 35PT-100PT", 5000, 50],
  ["GLV-TOP-130PT", "Glove-Fit Sleeve Toploader 130PT-180PT", 5000, 25],
  ["GLV-MAG-35PT", "Glove-Fit Sleeves Magnetic Holders", 5000, 25],
  ["GLV-GRD-PSA-JRSY", "Glove-Fit Sleeve for Graded Jersey Thick PSA", 1000, 50],
  ["GLV-GRD-SGC-JRSY", "Glove-Fit SGC Jersey Sleeve", 1000, 50],
  ["SHLZ-TOP-35PT", "Premium Seamless Toploader", 1000, 60],
  ["SHLZ-MAG-75PT", "Magnetic Holder with Protective Sleeve", 250, 20],
  ["GLV-TOP-260PT", "Glove-Fit Toploader 260PT", 500, 10],
] as const;

async function setupWorkspace(page: Page, status: "draft" | "open" = "draft", permissions?: readonly string[]) {
  const failures = await installFixtures(page, { permissions });
  const variants = products.flatMap(([sku, name, factor], index) => [
    { id: 100 + index, sku: `${sku}-C${factor}`, name: `${name} case`, productId: 1000 + index, unitsPerVariant: factor },
    { id: 200 + index, sku: `${sku}-P${factor / 2}`, name: `${name} half case`, productId: 1000 + index, unitsPerVariant: factor / 2 },
  ]);
  const state = {
    order: {
      ...receipt(31), sourceType: "shipment", poNumber: "PO-20991231-099", status: status as string,
      warehouseId: 1, receivingLocationId: 5, vendor: { name: "Fixture supplier" },
      lines: products.map(([sku, productName, factor, expectedQty], index) => ({
        id: 7 + index, receivingOrderId: 31, sku: `${sku}-C${factor}`, productName,
        productId: 1000 + index, productVariantId: 100 + index,
        unitsPerVariantSnapshot: Number(factor), unitVersion: initialVersion, inboundShipmentLineId: 157 + index,
        expectedQty: Number(expectedQty), receivedQty: 0, damagedQty: 0, status: "pending",
        putawayLocationId: 5, putawayComplete: 0, unitCost: null, notes: null, purchaseOrderLineId: 9 + index,
      })),
    },
    writes: [] as Array<{ path: string; body: Record<string, unknown> }>,
    conflict: false,
  };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/api/receiving/31") return route.fulfill({ json: state.order });
      if (path === "/api/receiving") return route.fulfill({ json: [state.order] });
      if (path === "/api/warehouses") return route.fulfill({ json: [{ id: 1, code: "LEON", name: "Leonberg" }] });
      if (path === "/api/warehouse/locations") return route.fulfill({ json: [
        { id: 5, code: "FLOOR", name: "Receiving floor", warehouseId: 1, isActive: 1, locationType: "receiving" },
      ] });
      if (path === "/api/product-variants") return route.fulfill({ json: variants });
      return route.fallback();
    }
    if (path === "/api/receiving/31/open" && request.method() === "POST") {
      state.writes.push({ path, body: {} });
      state.order.status = "open";
      return route.fulfill({ json: state.order });
    }
    if (/^\/api\/receiving\/lines\/\d+$/.test(path) && request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.writes.push({ path, body });
      const line = state.order.lines.find(item => item.id === Number(path.split("/").at(-1)));
      if (!line) return route.fulfill({ status: 404, json: { error: "Receipt line missing" } });
      if (state.conflict || body.expectedUnitVersion !== line.unitVersion) {
        return route.fulfill({ status: 409, json: { error: "The saved receipt count changed. Load the latest line before continuing." } });
      }
      if (typeof body.receivedQty === "number") {
        line.receivedQty = body.receivedQty;
        line.status = line.receivedQty === line.expectedQty ? "complete" : "partial";
      }
      if (typeof body.productVariantId === "number") {
        const variant = variants.find(item => item.id === body.productVariantId && item.productId === line.productId);
        if (!variant) return route.fulfill({ status: 409, json: { error: "Receive configuration unavailable" } });
        const oldFactor = line.unitsPerVariantSnapshot;
        if ([line.expectedQty, line.receivedQty, line.damagedQty].some(count => count * oldFactor % variant.unitsPerVariant !== 0)) {
          return route.fulfill({ status: 409, json: { error: "The pieces cannot be represented as whole packs" } });
        }
        line.expectedQty = line.expectedQty * oldFactor / variant.unitsPerVariant;
        line.receivedQty = line.receivedQty * oldFactor / variant.unitsPerVariant;
        line.damagedQty = line.damagedQty * oldFactor / variant.unitsPerVariant;
        line.productVariantId = variant.id;
        line.unitsPerVariantSnapshot = variant.unitsPerVariant;
      }
      line.unitVersion = savedVersion;
      return route.fulfill({ json: line });
    }
    return route.fallback();
  });
  await page.goto("/receiving?open=31");
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  return { state, failures };
}

const row = (page: Page, lineId = 7) => page.getByTestId(`receipt-line-${lineId}`);
const count = (page: Page, lineId = 7) => page.getByRole("spinbutton", { name: `Received count for line ${lineId}`, exact: true });
const confirm = (page: Page, lineId = 7) => page.getByRole("button", { name: `Confirm received count for line ${lineId}`, exact: true });

async function expectNoOverflow(locator: Locator) {
  const dimensions = await locator.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
}

test("eleven shipment lines fit a compact mobile-first workspace with one count basis per line", async ({ page }, testInfo) => {
  await page.setViewportSize(testInfo.project.name === "mobile" ? { width: 360, height: 780 } : { width: 935, height: 867 });
  const { state, failures } = await setupWorkspace(page);
  const workspace = page.getByTestId("receipt-workspace");
  await expect(row(page)).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("btn-open-receipt")).toBeInViewport({ ratio: 1 });
  await expectNoOverflow(workspace);
  await page.screenshot({ path: testInfo.outputPath("receipt-draft-top.png"), animations: "disabled" });
  await expect(row(page)).toContainText("10,000");
  await expect(row(page)).toContainText("80");
  await expect(row(page).getByText(/Shipment line #/)).not.toBeVisible();
  await expect(page.getByText("Press Start to count", { exact: true })).toHaveCount(0);
  const height = (await row(page).boundingBox())!.height;
  expect(height).toBeLessThan(testInfo.project.name === "mobile" ? 240 : 175);
  await row(page, 17).scrollIntoViewIfNeeded();
  await expect(page.getByTestId("btn-open-receipt")).toBeInViewport({ ratio: 1 });
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("receipt-draft-bottom.png"), animations: "disabled" });
  expect(failures).toEqual([]);
});

test("pack counts save from the same row on mobile and desktop without duplicate fields", async ({ page }, testInfo) => {
  const { state, failures } = await setupWorkspace(page);
  await page.getByTestId("btn-open-receipt").click();
  await expect(count(page)).toHaveCount(1);
  await expect(count(page)).toHaveAccessibleDescription("Count in packs of 10,000 pieces.");
  await expect(count(page)).toHaveAttribute("inputmode", "numeric");
  await count(page).fill("79");
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await expect(confirm(page)).toBeEnabled();
  const bounds = (await confirm(page).boundingBox())!;
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  await confirm(page).click();
  await expect(page.getByText("Count saved", { exact: true })).toBeVisible();
  await expect(row(page)).toContainText("790,000");
  expect(state.order.lines[0].expectedQty).toBe(80);
  expect(state.order.lines[0].unitsPerVariantSnapshot).toBe(10000);
  await count(page).fill("80");
  await count(page).press("Enter");
  await expect(page.getByRole("status", { name: "Received count confirmed for line 7" })).toBeVisible();
  expect(state.writes).toEqual([
    { path: "/api/receiving/31/open", body: {} },
    { path: "/api/receiving/lines/7", body: { receivedQty: 79, expectedUnitVersion: initialVersion } },
    { path: "/api/receiving/lines/7", body: { receivedQty: 80, expectedUnitVersion: savedVersion } },
  ]);
  await expectNoOverflow(page.getByTestId("receipt-workspace"));
  await page.screenshot({ path: testInfo.outputPath("receipt-count-confirmed.png"), animations: "disabled" });
  expect(failures).toEqual([]);
});

test("count conflicts stay actionable outside optional details and preserve the draft", async ({ page }) => {
  const { state, failures } = await setupWorkspace(page, "open");
  state.conflict = true;
  await count(page).fill("79");
  await confirm(page).click();
  await expect(row(page).getByRole("alert")).toContainText("saved receipt count changed");
  await expect(row(page).getByRole("button", { name: "Load latest line and discard count draft" })).toBeVisible();
  await expect(count(page)).toHaveValue("79");
  await expect(confirm(page)).toBeDisabled();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  expect(state.order.lines[0].receivedQty).toBe(0);
  expect(state.writes).toHaveLength(1);
  expect(failures).toEqual([]);
});

test("changing a pack preserves the actual pieces and uses the saved receipt version", async ({ page }) => {
  const { state, failures } = await setupWorkspace(page, "open");
  await count(page).fill("79");
  await confirm(page).click();
  await expect(row(page)).toContainText("790,000");
  await openReceivingPackSelector(page, 7);
  await page.getByRole("combobox", { name: "Receive variant for line 7", exact: true }).selectOption("200");
  await expect(count(page)).toHaveValue("158");
  await expect(count(page)).toHaveAccessibleDescription("Count in packs of 5,000 pieces.");
  await expect(row(page)).toContainText("160");
  await expect(row(page)).toContainText("800,000");
  await expect(row(page)).toContainText("790,000");
  expect(state.order.lines[0]).toMatchObject({ expectedQty: 160, receivedQty: 158, unitsPerVariantSnapshot: 5000 });
  expect(state.writes).toEqual([
    { path: "/api/receiving/lines/7", body: { receivedQty: 79, expectedUnitVersion: initialVersion } },
    { path: "/api/receiving/lines/7", body: { productVariantId: 200, expectedUnitVersion: savedVersion } },
  ]);
  await expectNoOverflow(page.getByTestId("receipt-workspace"));
  expect(failures).toEqual([]);
});

test("warehouse settings and import tools remain reachable without crowding the count list", async ({ page }) => {
  const { state, failures } = await setupWorkspace(page);
  await expect(page.getByTestId("btn-import-csv")).not.toBeVisible();
  await openReceivingSetup(page);
  await expect(page.getByRole("combobox", { name: "Receiving warehouse", exact: true })).toContainText("Leonberg");
  await expect(page.getByRole("combobox", { name: "Default receiving location", exact: true })).toContainText("FLOOR");
  await openReceivingMoreActions(page);
  await expect(page.getByTestId("btn-download-template")).toBeVisible();
  await page.getByTestId("btn-import-csv").click();
  const importDialog = page.getByRole("dialog", { name: "Import from CSV", exact: true });
  await expect(importDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(importDialog).toHaveCount(0);
  await expect(row(page)).toContainText("80");
  expect(state.writes).toEqual([]);
  expect(failures).toEqual([]);
});

test("counting remains usable on a small phone and a tablet without sideways scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize(testInfo.project.name === "mobile" ? { width: 320, height: 640 } : { width: 768, height: 900 });
  const { state, failures } = await setupWorkspace(page, "open");
  await count(page).fill("80");
  await count(page).scrollIntoViewIfNeeded();
  await expect(count(page)).toBeInViewport({ ratio: 1 });
  await expect(confirm(page)).toBeInViewport({ ratio: 1 });
  await expectNoOverflow(page.getByTestId("receipt-workspace"));
  await confirm(page).click();
  await expect(page.getByRole("status", { name: "Received count confirmed for line 7" })).toBeVisible();
  expect(state.order.lines[0].receivedQty).toBe(80);
  expect(state.writes).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath("receipt-narrow-count.png"), animations: "disabled" });
  expect(failures).toEqual([]);
});

for (const status of ["draft", "open"] as const) {
  test(`read-only users retain the compact ${status} workspace without quantity or location authority`, async ({ page }) => {
    const { state, failures } = await setupWorkspace(page, status, ["inventory:view"]);
    const workspace = page.getByTestId("receipt-workspace");
    await expect(workspace.getByRole("status").filter({ hasText: "Receiving is read-only" })).toBeVisible();
    await expect(page.getByTestId("btn-add-line")).toBeDisabled();
    if (status === "draft") {
      await expect(page.getByTestId("btn-open-receipt")).toBeDisabled();
      await openReceivingMoreActions(page);
      await expect(page.getByTestId("btn-import-csv")).toBeDisabled();
      await expect(page.getByTestId("btn-discard-receipt")).toBeDisabled();
      await workspace.locator("summary").filter({ hasText: /^More actions$/ }).click();
    } else {
      await expect(count(page)).toBeDisabled();
      await expect(confirm(page)).toBeDisabled();
      await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
      await openReceivingLineOptions(page, 7);
      await expect(page.getByRole("combobox", { name: "Location for line 7", exact: true })).toBeDisabled();
    }
    await openReceivingPackSelector(page, 7);
    await expect(page.getByRole("combobox", { name: "Receive variant for line 7", exact: true })).toBeDisabled();
    await openReceivingSetup(page);
    await expect(page.getByRole("combobox", { name: "Receiving warehouse", exact: true })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Default receiving location", exact: true })).toBeDisabled();
    expect(state.writes).toEqual([]);
    expect(failures).toEqual([]);
  });
}
