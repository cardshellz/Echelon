import { expect, test, type Page, type Locator } from "@playwright/test";
import { installFixtures, receipt } from "./procurement-fixtures";

const version = "a".repeat(64), nextVersion = "b".repeat(64);
const variants = [
  { id: 2, sku: "TEST-PC1", name: "Piece", productId: 10, unitsPerVariant: 1 },
  { id: 3, sku: "TEST-C50", name: "Case", productId: 10, unitsPerVariant: 50 },
];
const makeLine = () => ({ id: 7, receivingOrderId: 31, sku: "TEST-PC1", productName: "Partial carton product", productId: 10, productVariantId: 2 as number | null,
  unitsPerVariantSnapshot: 1 as number | null, unitVersion: version, inboundShipmentLineId: 17, expectedQty: 501, receivedQty: 401, damagedQty: 3,
  status: "partial", putawayLocationId: 5, putawayComplete: 0, unitCost: 25, notes: null, purchaseOrderLineId: 9 });
type Command = { path: string; body: Record<string, any> };

async function setup(page: Page, options: { legacy?: boolean; unresolved?: boolean; conflict?: boolean; failRefresh?: boolean; delay?: boolean; exact?: boolean; lost?: boolean; drift?: boolean; manualConflict?: boolean; legacyFactorDrift?: boolean } = {}) {
  const failures = await installFixtures(page);
  const catalog = variants.map((variant) => ({ ...variant }));
  const state = { line: { ...makeLine(), ...(options.exact ? { expectedQty: 500, receivedQty: 400, damagedQty: 50 } : {}),
    ...(options.legacy ? { unitsPerVariantSnapshot: null } : {}), ...(options.unresolved ? { productVariantId: null } : {}),
    ...(options.drift ? { unitsPerVariantSnapshot: 50, expectedQty: 10, receivedQty: 8, damagedQty: 1 } : {}) }, commands: [] as Command[], conflictUsed: false, reads: 0, committed: false, manualConflictUsed: false, catalogConflictUsed: false };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const order = (id: number) => ({ ...receipt(id), status: "receiving", sourceType: "shipment", warehouseId: 1, receivingLocationId: 5,
      lines: [{ ...state.line, ...(id === 32 ? { id: 8, receivingOrderId: 32, sku: "OTHER-RECEIPT", receivedQty: 12 } : {}) }] });
    if (req.method() === "GET") {
      if (path === "/api/product-variants") return route.fulfill({ json: catalog });
      if (path === "/api/warehouse/locations") return route.fulfill({ json: [{ id: 5, code: "RCV-01", name: "Receiving", warehouseId: 1, isActive: 1, locationType: "receiving" }] });
      if (/^\/api\/receiving\/(31|32)$/.test(path)) {
        state.reads++;
        if (options.failRefresh && state.commands.length) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
        return route.fulfill({ json: order(Number(path.split("/").at(-1))) });
      }
      if (path.includes("search") && path.includes("sku")) return route.fulfill({ json: catalog.map((variant) => ({ ...variant, productVariantId: variant.id })) });
      return route.fallback();
    }
    if (path === "/api/receiving/31/lines") {
      const body = req.postDataJSON(); state.commands.push({ path, body });
      if (options.manualConflict && !state.manualConflictUsed) {
        state.manualConflictUsed = true; catalog[1].unitsPerVariant = 100;
        return route.fulfill({ status: 409, json: { error: "The catalog factor changed.", code: "RECEIVING_UNIT_CHANGED" } });
      }
      if (body.expectedUnitsPerVariant !== catalog.find((variant) => variant.id === body.productVariantId)?.unitsPerVariant) return route.fulfill({ status: 409, json: { error: "The selected factor was not reviewed" } });
      const current = order(31);
      return route.fulfill({ status: 201, json: { ...current, lines: [...current.lines, { ...makeLine(), ...body, id: 9, unitsPerVariantSnapshot: body.expectedUnitsPerVariant, unitVersion: nextVersion }] } });
    }
    if (path === "/api/receiving/31/complete-all") {
      state.commands.push({ path, body: req.postDataJSON() });
      return route.fulfill({ json: { order: order(31) } });
    }
    if (path === "/api/receiving/lines/7/create-variant") {
      state.commands.push({ path, body: {} });
      return route.fulfill({ json: { line: state.line, variant: variants[1], product: { id: 10, name: "Test" }, requiresUnitConfirmation: true } });
    }
    if (path !== "/api/receiving/lines/7" || req.method() !== "PATCH") return route.fallback();
    const body = req.postDataJSON(); state.commands.push({ path, body });
    if (options.delay) await gate;
    if (options.conflict && !state.conflictUsed) {
      state.conflictUsed = true; state.line.unitVersion = nextVersion; state.line.receivedQty = 402;
      return route.fulfill({ status: 409, json: { error: "Receive unit changed. Load latest before continuing." } });
    }
    if (body.expectedUnitVersion !== state.line.unitVersion) return route.fulfill({ status: 409, json: { error: "Stale unit version" } });
    if (body.productVariantId) {
      if (options.legacyFactorDrift && body.confirmLegacyUnit && !state.catalogConflictUsed) {
        state.catalogConflictUsed = true; catalog[0].unitsPerVariant = 2;
        return route.fulfill({ status: 409, json: { error: "The catalog factor changed; review it again.", code: "RECEIVING_UNIT_CHANGED" } });
      }
      const factor = catalog.find((variant) => variant.id === body.productVariantId)!.unitsPerVariant;
      if (body.confirmLegacyUnit && body.expectedUnitsPerVariant !== factor) return route.fulfill({ status: 409, json: { error: "Reviewed factor does not match" } });
      if (state.line.unitsPerVariantSnapshot !== null) {
        const oldFactor = state.line.unitsPerVariantSnapshot;
        if ([state.line.expectedQty, state.line.receivedQty, state.line.damagedQty].some((qty) => qty * oldFactor % factor !== 0)) {
          return route.fulfill({ status: 409, json: { error: "These base pieces cannot be represented as whole units of the selected variant." } });
        }
        state.line.expectedQty = state.line.expectedQty * oldFactor / factor;
        state.line.receivedQty = state.line.receivedQty * oldFactor / factor;
        state.line.damagedQty = state.line.damagedQty * oldFactor / factor;
      }
      state.line.productVariantId = body.productVariantId; state.line.unitsPerVariantSnapshot = factor;
    }
    if ("receivedQty" in body) state.line.receivedQty = body.receivedQty;
    state.line.unitVersion = nextVersion; state.committed = true;
    if (options.lost) return route.abort("connectionreset");
    return route.fulfill({ json: state.line });
  });
  await page.goto("/receiving?open=31");
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  return { state, failures, release };
}
const control = (page: Page) => page.locator('[aria-label="Receive unit for line 7"]:visible');
const count = (page: Page) => page.locator('input[aria-label="Received count for line 7"]:visible');
const done = (page: Page) => page.locator('[data-testid="btn-complete-line-7"]:visible, [data-testid="btn-complete-line-mobile-7"]:visible');

async function expectModalFits(page: Page, dialog: Locator) {
  await expect(dialog).toHaveCSS("opacity", "1");
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const horizontal = await dialog.evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, left: element.scrollLeft }));
  expect(horizontal.scrollWidth).toBeLessThanOrEqual(horizontal.width + 1);
  expect(horizontal.left).toBe(0);
  const heading = await dialog.getByRole("heading").first().boundingBox();
  expect(heading!.x).toBeGreaterThanOrEqual(box!.x);
  expect(heading!.x + heading!.width).toBeLessThanOrEqual(box!.x + box!.width);
}

test("opening a receipt does not mutate units; Save count preserves partial counts and saved zero", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page);
  await expect(control(page)).toContainText("Expected: 501 pieces; received: 401 pieces; damaged: 3 pieces");
  expect(state.commands).toEqual([]);
  await done(page).click(); await expect.poll(() => state.commands.length).toBe(1);
  expect(state.commands[0].body).toEqual({ receivedQty: 401, expectedUnitVersion: version });
  await count(page).fill("0");
  expect(state.commands).toHaveLength(1);
  await expect(page.getByTestId("btn-complete-all")).toBeDisabled();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await done(page).click(); await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1].body).toEqual({ receivedQty: 0, expectedUnitVersion: nextVersion });
  await expect(count(page)).toHaveValue("0");
  await done(page).click(); await expect.poll(() => state.commands.length).toBe(3);
  expect(state.commands[2].body).toEqual({ receivedQty: 0, expectedUnitVersion: nextVersion });
  await expect(count(page)).toHaveValue("0");
  const dialog = page.getByRole("dialog", { name: /Receipt TEST-RECEIPT-31/ });
  await expectModalFits(page, dialog);
  await page.screenshot({ path: testInfo.outputPath("receiving-unit-counts.png"), fullPage: true, animations: "disabled" });
  await dialog.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath("receiving-unit-header.png"), fullPage: true, animations: "disabled" });
  expect(failures).toEqual([]);
});

test("legacy units require an explicit same-variant confirmation with counts unchanged", async ({ page }) => {
  const { state, failures } = await setup(page, { legacy: true });
  await expect(control(page)).toContainText("base pieces unknown");
  await expect(count(page)).toBeDisabled();
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  expect(state.commands).toEqual([]);
  await control(page).getByRole("button", { name: /Confirm these counts are in Piece/ }).click();
  await expect(control(page)).toContainText("Expected: 501 pieces; received: 401 pieces");
  expect(state.commands[0].body).toEqual({ productVariantId: 2, confirmLegacyUnit: true, expectedUnitVersion: version, expectedUnitsPerVariant: 1 });
  expect(state.line).toMatchObject({ expectedQty: 501, receivedQty: 401, damagedQty: 3 });
  expect(failures).toEqual([]);
});

test("server converts expected received and damaged counts exactly; an inexact change needs review", async ({ page }) => {
  const { state, failures } = await setup(page, { exact: true });
  await control(page).getByRole("combobox").selectOption("3");
  await expect(control(page)).toContainText("Receive units of 50 pieces");
  await expect(count(page)).toHaveValue("8");
  expect(state.commands[0].body).toEqual({ productVariantId: 3, expectedUnitVersion: version });
  expect(state.line).toMatchObject({ expectedQty: 10, receivedQty: 8, damagedQty: 1 });
  await count(page).fill("7"); await done(page).click();
  await expect(control(page)).toContainText("received: 350 pieces");
  expect(failures).toEqual([]);
});

test("partial-carton conversion is rejected without resetting any count", async ({ page }) => {
  const { state, failures } = await setup(page);
  await control(page).getByRole("combobox").selectOption("3");
  await expect(page.locator('[role="alert"]:visible').filter({ hasText: /cannot be represented/ }).first()).toBeVisible();
  await expect(control(page)).toContainText("Expected: 501 pieces; received: 401 pieces; damaged: 3 pieces");
  expect(state.line.unitsPerVariantSnapshot).toBe(1);
  await expect(count(page)).toBeDisabled();
  expect(failures).toEqual([]);
});

test("conflict retains the draft until explicit refresh then uses the new version", async ({ page }) => {
  const { state, failures } = await setup(page, { conflict: true });
  await count(page).fill("399"); await done(page).click();
  await expect(count(page)).toHaveValue("399"); await expect(count(page)).toBeDisabled();
  await page.locator('button:visible').filter({ hasText: "Load latest line and discard count draft" }).click();
  await expect(count(page)).toHaveValue("402");
  await count(page).fill("400"); await done(page).click();
  await expect.poll(() => state.commands.length).toBe(2);
  expect(state.commands[1].body).toEqual({ receivedQty: 400, expectedUnitVersion: nextVersion });
  expect(failures).toEqual([]);
});

test("lost response and failed refresh preserve a blocked count draft", async ({ page }) => {
  const { state, failures } = await setup(page, { lost: true, failRefresh: true });
  await count(page).fill("399"); await done(page).click();
  await expect(count(page)).toBeDisabled();
  await page.locator('button:visible').filter({ hasText: "Load latest line and discard count draft" }).click();
  await expect(page.locator('[role="alert"]:visible').filter({ hasText: /still preserved/ }).first()).toBeVisible();
  await expect(count(page)).toHaveValue("399"); await expect(done(page)).toBeDisabled();
  expect(state.commands).toHaveLength(1); expect(failures).toEqual([]);
});

test("complete-all submits the exact receipt line versions", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.getByTestId("btn-complete-all").click();
  await expect.poll(() => state.commands.length).toBe(1);
  expect(state.commands[0].body).toEqual({ expectedUnitVersions: [{ lineId: 7, unitVersion: version }] });
  expect(state.line.receivedQty).toBe(401); expect(failures).toEqual([]);
});

test("late A response cannot overwrite a later A visit or the intervening receipt", async ({ page }) => {
  const { state, failures, release } = await setup(page, { delay: true });
  await count(page).fill("399"); await done(page).click();
  await expect.poll(() => state.commands.length).toBe(1);
  await page.evaluate(() => { history.pushState(null, "", "/receiving?open=32"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-32/ })).toBeVisible();
  await page.evaluate(() => { history.pushState(null, "", "/receiving?open=31"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await expect(count(page)).toHaveValue("401"); release();
  await expect.poll(() => state.committed).toBe(true);
  await expect(count(page)).toHaveValue("401"); expect(failures).toEqual([]);
});

test("catalog-factor drift requires an explicit server-owned rebase", async ({ page }) => {
  const { state, failures } = await setup(page, { drift: true });
  await expect(control(page)).toContainText("Expected: 500 pieces; received: 400 pieces");
  await expect(page.getByTestId("btn-close-receipt")).toBeDisabled();
  await control(page).getByRole("button", { name: /Review and apply current catalog factor/ }).click();
  await expect(count(page)).toHaveValue("400");
  expect(state.commands[0].body).toEqual({ productVariantId: 2, expectedUnitVersion: version });
  expect(failures).toEqual([]);
});

test("creating a catalog variant leaves receipt counts untouched until explicit unit confirmation", async ({ page }) => {
  const { state, failures } = await setup(page, { legacy: true, unresolved: true });
  await page.getByRole("button", { name: /^(SKU|SKU not linked)$/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Resolve SKU" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Create catalog variant" }).click();
  await expect(dialog.getByRole("button", { name: /Confirm these counts are in Case/ })).toBeVisible();
  expect(state.commands).toHaveLength(1);
  expect(state.line).toMatchObject({ productVariantId: null, unitsPerVariantSnapshot: null, expectedQty: 501, receivedQty: 401, damagedQty: 3 });
  await dialog.getByRole("button", { name: /Confirm these counts are in Case/ }).click();
  await expect(dialog).toBeHidden();
  expect(state.commands[1].body).toEqual({ productVariantId: 3, confirmLegacyUnit: true, expectedUnitVersion: version, expectedUnitsPerVariant: 50 });
  expect(state.line).toMatchObject({ expectedQty: 501, receivedQty: 401, damagedQty: 3, unitsPerVariantSnapshot: 50 });
  expect(failures).toEqual([]);
});

test("existing variant search also requires explicit legacy count-basis confirmation", async ({ page }) => {
  const { state, failures } = await setup(page, { legacy: true, unresolved: true });
  await page.getByRole("button", { name: /^(SKU|SKU not linked)$/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "Resolve SKU" });
  await dialog.getByRole("button", { name: /TEST-PC1 Piece/ }).click();
  expect(state.commands).toEqual([]);
  await dialog.getByRole("button", { name: /Confirm these counts are in Piece/ }).click();
  await expect(dialog).toBeHidden();
  expect(state.commands[0].body).toEqual({ productVariantId: 2, confirmLegacyUnit: true, expectedUnitVersion: version, expectedUnitsPerVariant: 1 });
  expect(failures).toEqual([]);
});

test("partial-carton shipment preflight shows the exact piece receipt before creation", async ({ page }, testInfo) => {
  const failures = await installFixtures(page);
  const commands: Command[] = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path === "/api/inbound-shipments/42") return route.fulfill({ json: {
      id: 42, shipmentNumber: "PARTIAL-SHIPMENT", status: "delivered", mode: "ocean", purchaseOrderId: 17, costs: [], statusHistory: [],
      lines: [{ id: 7, purchaseOrderId: 17, purchaseOrderLineId: 9, productVariantId: 3, sku: "TEST-C50", productName: "Partial carton product", qtyShipped: 501, cartonCount: 11 }],
    } });
    if (req.method() === "GET" && path === "/api/inbound-shipments/42/receipt-pack-resolution") return route.fulfill({ json: {
      shipmentId: 42, shipmentNumber: "PARTIAL-SHIPMENT", status: "delivered", purchaseOrderId: 17, poNumber: "TEST-PO-17", canCreateReceipt: true, unresolvedCount: 0, lineCount: 1, issue: null,
      lines: [{ shipmentLineId: 7, purchaseOrderLineId: 9, sku: "TEST-C50", productId: 10, productName: "Partial carton product", qtyShipped: 501, cartonCount: 11, unitsPerCarton: null,
        status: "resolved", blocking: false, issue: "501 pieces do not fill whole packs of 50. This receipt will be counted in pieces; recorded cartons remain packing information.",
        matchedVariant: { id: 2, sku: "TEST-PC1", name: "Piece", unitsPerVariant: 1 }, activeVariants: [],
        receivePlan: { productVariantId: 2, unitsPerVariant: 1, expectedQty: 501, countsAsPieces: true, preferredVariantId: 3, preferredUnitsPerVariant: 50 } }],
    } });
    if (req.method() === "POST" && path === "/api/inbound-shipments/42/create-receipt") {
      commands.push({ path, body: req.postDataJSON() });
      return route.fulfill({ json: receipt(31) });
    }
    return route.fallback();
  });
  await page.goto("/shipments/42?tab=lines");
  await page.getByRole("button", { name: "Create Receipt", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Shipment receipt pack check" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("501 pieces");
  await expect(dialog).toContainText("Cartons (reference)");
  await expect(dialog).not.toContainText("Units/Carton");
  expect(commands).toEqual([]);
  await expectModalFits(page, dialog);
  await page.screenshot({ path: testInfo.outputPath("partial-carton-preflight.png"), fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "Create receipt", exact: true }).click();
  await expect(page).toHaveURL(/\/receiving\?/);
  expect(commands).toHaveLength(1); expect(commands[0].body).toEqual({ purchaseOrderId: 17 });
  expect(failures).toEqual([]);
});

test("legacy confirmation binds the visible factor and reloads catalog drift before retrying", async ({ page }) => {
  const { state, failures } = await setup(page, { legacy: true, legacyFactorDrift: true });
  await control(page).getByRole("button", { name: /Confirm these counts are in Piece \(1 pieces\)/ }).click();
  await expect(page.locator('[role="alert"]:visible').filter({ hasText: /catalog factor changed/ }).first()).toBeVisible();
  expect(state.commands[0].body.expectedUnitsPerVariant).toBe(1);
  expect(state.line.unitsPerVariantSnapshot).toBeNull();
  await page.locator('button:visible').filter({ hasText: "Load latest line and discard count draft" }).click();
  await control(page).getByRole("button", { name: /Confirm these counts are in Piece \(2 pieces\)/ }).click();
  await expect(control(page)).toContainText("Expected: 1,002 pieces; received: 802 pieces");
  expect(state.commands[1].body).toEqual({ productVariantId: 2, confirmLegacyUnit: true, expectedUnitVersion: version, expectedUnitsPerVariant: 2 });
  expect(failures).toEqual([]);
});

test("manual add retains the selected factor and requires review after a stale catalog rejection", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { manualConflict: true });
  await page.getByRole("button", { name: "Add Line", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add Line", exact: true });
  await dialog.getByTestId("input-add-line-sku").fill("TEST-C50");
  await dialog.getByTestId("sku-option-TEST-C50").click();
  await expect(dialog).toContainText("one receive unit containing 50 pieces");
  await dialog.getByTestId("input-add-line-expected").fill("10");
  await dialog.getByRole("combobox", { name: "Put-away location", exact: true }).click();
  await page.getByRole("option", { name: /RCV-01/ }).click();
  await dialog.getByTestId("btn-confirm-add-line").click();
  await expect(dialog.getByRole("alert")).toContainText("Refresh and reselect");
  expect(state.commands[0].body).toMatchObject({ expectedQty: 10, receivedQty: 0, productVariantId: 3, expectedUnitsPerVariant: 50 });
  expect(state.commands[0].body).not.toHaveProperty("status");
  await expect(dialog.getByTestId("btn-confirm-add-line")).toBeDisabled();
  await expect(dialog.getByTestId("input-add-line-expected")).toHaveValue("10");
  await dialog.getByRole("button", { name: "Refresh selected SKU", exact: true }).click();
  await dialog.getByTestId("sku-option-TEST-C50").click();
  await expect(dialog).toContainText("one receive unit containing 100 pieces");
  await expectModalFits(page, dialog);
  await page.screenshot({ path: testInfo.outputPath("manual-receive-unit-review.png"), fullPage: true, animations: "disabled" });
  await dialog.getByTestId("btn-confirm-add-line").click();
  await expect(dialog).toBeHidden();
  expect(state.commands[1].body.expectedUnitsPerVariant).toBe(100);
  expect(failures).toEqual([]);
});

test("unknown receipt coverage keeps existing receipts openable and other PO choices available", async ({ page }) => {
  const failures = await installFixtures(page);
  await page.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path === "/api/inbound-shipments/42") return route.fulfill({ json: {
      id: 42, shipmentNumber: "SHARED-SHIPMENT", status: "delivered", mode: "ocean", purchaseOrderId: null, costs: [], statusHistory: [],
      lines: [17, 99, 55].map((purchaseOrderId) => ({ id: purchaseOrderId, purchaseOrderId, purchaseOrderLineId: purchaseOrderId, sku: "SHARED", qtyShipped: 501, cartonCount: 11 })),
    } });
    if (req.method() === "GET" && path === "/api/inbound-shipments/42/po-receive-options") return route.fulfill({ json: { purchaseOrders: [
      { shipmentId: 42, purchaseOrderId: 17, poNumber: "PO-EXISTING", action: "open_existing_receipt", existingReceiptId: 31, receivable: true, qtyShipped: 501, lineCount: 1, receivedBaseQty: null, remainingBaseQty: null, reason: "Existing receipt available" },
      { shipmentId: 42, purchaseOrderId: 99, poNumber: "PO-BLOCKED", action: "blocked", receivable: false, qtyShipped: 501, lineCount: 1, receivedBaseQty: null, remainingBaseQty: null, reason: "Closed receipt coverage needs source review" },
      { shipmentId: 42, purchaseOrderId: 55, poNumber: "PO-READY", action: "create_receipt", receivable: true, qtyShipped: 501, lineCount: 1, receivedBaseQty: 0, remainingBaseQty: 501, reason: null },
    ] } });
    return route.fallback();
  });
  await page.goto("/shipments/42?tab=lines");
  await page.getByRole("button", { name: "Create Receipt", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Receive shipment/ });
  await expect(dialog).toContainText("Receipt coverage needs review");
  await expect(dialog).toContainText("Closed receipt coverage needs source review");
  await expect(dialog.getByRole("button", { name: "Receive", exact: true })).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: "Receive", exact: true }).last()).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Open receipt", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Open receipt", exact: true }).click();
  await expect(page).toHaveURL(/open=31/);
  expect(failures).toEqual([]);
});

test("a delayed receipt A reload cannot block receipt B or clear B's newer reload state", async ({ page }) => {
  const failures = await installFixtures(page);
  let releaseA!: () => void, releaseB!: () => void;
  const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
  const gateB = new Promise<void>((resolve) => { releaseB = resolve; });
  const reads = { a: 0, b: 0 };
  const counts = { a: 401, b: 12 };
  await page.route("**/api/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/product-variants") return route.fulfill({ json: variants });
    if (request.method() === "GET" && (path === "/api/receiving/31" || path === "/api/receiving/32")) {
      const isA = path.endsWith("/31"), key = isA ? "a" : "b";
      reads[key]++;
      const id = isA ? 31 : 32;
      const lines = [{ ...makeLine(), id: isA ? 7 : 8, receivingOrderId: id, receivedQty: counts[key] }];
      if (!isA) lines.push({ ...makeLine(), id: 9, receivingOrderId: 32, receivedQty: 21 });
      const snapshot = { ...receipt(id), status: "receiving", sourceType: "shipment", lines };
      if (reads[key] > 1) await (isA ? gateA : gateB);
      return route.fulfill({ json: snapshot });
    }
    if (request.method() === "PATCH" && (path === "/api/receiving/lines/7" || path === "/api/receiving/lines/8")) {
      counts[path.endsWith("/7") ? "a" : "b"]++;
      return route.fulfill({ status: 409, json: { error: "Count changed; reload this receipt." } });
    }
    return route.fallback();
  });
  await page.goto("/receiving?open=31");
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-31/ })).toBeVisible();
  await count(page).fill("399"); await done(page).click();
  const reload = () => page.locator("button:visible").filter({ hasText: "Load latest line and discard count draft" });
  await reload().click();
  await expect.poll(() => reads.a).toBe(2);
  // A change in purchase context is a new navigation visit even when the
  // receipt ID stays the same; it must not inherit an obsolete reload lock.
  await page.evaluate(() => { history.pushState(null, "", "/receiving?open=31&purchase=purchase%3A17%3Alifecycle"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(count(page)).toBeEnabled();
  await expect(count(page)).toHaveValue("401");
  await page.evaluate(() => { history.pushState(null, "", "/receiving?open=32"); dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-32/ })).toBeVisible();
  const bCount = page.locator('input[aria-label="Received count for line 8"]:visible');
  const healthyBCount = page.locator('input[aria-label="Received count for line 9"]:visible');
  await expect(bCount).toBeEnabled();
  await expect(healthyBCount).toBeEnabled();
  await bCount.fill("11");
  await page.locator('[data-testid="btn-complete-line-8"]:visible, [data-testid="btn-complete-line-mobile-8"]:visible').click();
  await reload().click();
  await expect.poll(() => reads.b).toBe(2);
  await expect(healthyBCount).toBeDisabled();
  const responseA = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/receiving/31");
  releaseA();
  await (await responseA).finished();
  // Let the completed A response and React's resulting paint settle while
  // B's response is deliberately withheld; no timeout is used as an outcome.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByRole("heading", { name: /Receipt TEST-RECEIPT-32/ })).toBeVisible();
  await expect(bCount).toHaveValue("11");
  await expect(healthyBCount).toHaveValue("21");
  await expect(healthyBCount).toBeDisabled();
  await expect(reload()).toBeDisabled();
  releaseB();
  await expect(bCount).toHaveValue("13");
  await expect(healthyBCount).toBeEnabled();
  expect(failures).toEqual([]);
});
