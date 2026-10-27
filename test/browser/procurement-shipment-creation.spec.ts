import { expect, test, type Page, type Route } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";

const NOW = "2026-10-18T12:00:00.000Z";
const STORAGE_KEY = "echelon:shipment-create:v1:test-user";
type Captured = { key: string; body: Record<string, any>; path: string };
async function setup(page: Page, options: { lost?: boolean; malformed?: boolean; failedSources?: boolean; delayed?: boolean; rejected?: boolean; numberExhausted?: boolean; sourcePayload?: unknown; warehousePayload?: unknown } = {}) {
  const failures = await installFixtures(page, { permissions: ["inventory:view", "purchasing:view", "purchasing:create"] });
  const state = { requests: [] as Captured[], creations: 0, shipmentNumber: "RECOVERED-SHIPMENT", sourceReads: 0, sourceFailure: !!options.failedSources, offline: false, sourcePayload: options.sourcePayload, warehousePayload: options.warehousePayload,
    lines: [] as Array<{ id: number; inboundShipmentId: number; purchaseOrderId: number; purchaseOrderLineId: number; sku: string; qtyShipped: number; cartonCount: number }> };
  const replays = new Map<string, Record<string, unknown>>();
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (request.method() === "GET") {
      if (path === "/api/inbound-shipments") return route.fulfill({ json: { shipments: [], total: 0, limit: Number(url.searchParams.get("limit") ?? 50), offset: Number(url.searchParams.get("offset") ?? 0), hasMore: false, costHealthItems: [] } });
      if (path === "/api/procurement/landed-cost-health") return route.fulfill({ json: { status: "healthy", scannedShipments: 0, critical: 0, warning: 0,
        counts: { allocationBlockers: 0, allocationWarnings: 0, pendingFinalization: 0, finalizedNotPushed: 0, staleProvisionalLots: 0 }, items: [] } });
      if (path === "/api/warehouses") return route.fulfill({ json: state.warehousePayload ?? [{ id: 1, code: "TEST", name: "Fixture warehouse" }] });
      if (path === "/api/vendors") return route.fulfill({ json: [{ id: 2, name: "Test vendor", code: "TEST" }] });
      if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), lines: [{ id: 15, purchaseOrderId: 17, lineType: "product", lineNumber: 1, sku: "REVIEWED-ITEM", productName: "Reviewed product", orderQty: 1000, receivedQty: 0, unitCostCents: 10, subtotalCents: 10000 }] } });
      if (path === "/api/purchase-orders/17/shippable-lines") {
        state.sourceReads++;
        if (state.sourceFailure) return route.fulfill({ status: 503, json: { error: "Source evidence unavailable" } });
        if (state.sourcePayload !== undefined) return route.fulfill({ json: state.sourcePayload });
        return route.fulfill({ json: { lines: [{ id: 15, purchaseOrderId: 17, sku: "REVIEWED-ITEM", productName: "Reviewed product", description: null, orderQty: 1000, alreadyShippedQty: 499, directReceivedQty: 0, remainingQty: 501 }], reviewRequiredLines: [] } });
      }
      if (path === "/api/inbound-shipments/42") return route.fulfill({ json: { id: 42, shipmentNumber: state.shipmentNumber, status: "draft", mode: "sea_fcl", lines: state.lines, costs: [], statusHistory: [] } });
      return route.fallback();
    }
    if (request.method() !== "POST" || path !== "/api/inbound-shipments") return route.fallback();
    const command = { key: request.headers()["idempotency-key"], body: request.postDataJSON(), path };
    state.requests.push(command);
    if (state.offline) return route.abort("internetdisconnected");
    if (!command.key) return route.fulfill({ status: 400, json: { error: "Missing request identity" } });
    if (replays.has(command.key)) return route.fulfill({ status: 201, json: replays.get(command.key) });
    if (options.delayed) await gate;
    if ((options.rejected || options.numberExhausted) && first) {
      first = false;
      const rejection = options.numberExhausted
        ? { code: "SHIPMENT_CREATE_NUMBER_EXHAUSTED", error: "Automatic shipment numbering is exhausted for this date. Choose a manual shipment number." }
        : { code: "SHIPMENT_LINE_QUANTITY_EXCEEDED", error: "Purchase quantities changed; review this selection." };
      return route.fulfill({ status: 409, json: { ...rejection, details: { shipmentCreateOutcome: "rejected", idempotencyKey: command.key } } });
    }
    state.creations++;
    state.lines = (command.body.purchaseOrder?.lineSelections ?? []).map((selection: { poLineId: number; qty: number }, index: number) => ({
      id: index + 1, inboundShipmentId: 42, purchaseOrderId: command.body.purchaseOrder.purchaseOrderId,
      purchaseOrderLineId: selection.poLineId, sku: "REVIEWED-ITEM", qtyShipped: selection.qty, cartonCount: 3,
    }));
    const result = { id: 42, shipmentNumber: command.body.shipmentNumber ?? "RECOVERED-SHIPMENT", status: "draft", lineCount: state.lines.length, createdBy: "test-user", createdAt: NOW, updatedAt: NOW };
    state.shipmentNumber = result.shipmentNumber;
    replays.set(command.key, result);
    if (options.lost && first) { first = false; return route.abort("connectionreset"); }
    if (options.malformed && first) { first = false; return route.fulfill({ status: 201, json: { ...result, lineCount: undefined } }); }
    return route.fulfill({ status: 201, json: result });
  });
  return { state, failures, release };
}
async function openListCreate(page: Page) {
  await page.goto("/shipments");
  await page.getByRole("button", { name: "New Shipment", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New Inbound Shipment", exact: true })).toBeVisible();
}
async function openPoCreate(page: Page) {
  await page.goto("/purchase-orders/17?tab=shipments");
  await page.getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Create Inbound Shipment", exact: true })).toBeVisible();
}
async function savedRecovery(page: Page) {
  return page.evaluate(key => { const raw = sessionStorage.getItem(key); return raw ? JSON.parse(raw) : null; }, STORAGE_KEY);
}
async function expectBoundedRecoveryDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading").scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("heading")).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeInViewport({ ratio: 1 });
  const viewport = page.viewportSize()!;
  await expect.poll(async () => { const bounds = await dialog.boundingBox(); return !!bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width; }).toBe(true);
}

test("empty draft lost response survives reload and recovers one shipment with the original key", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { lost: true });
  await openListCreate(page);
  await page.getByPlaceholder("e.g. Maersk", { exact: true }).fill("Reviewed carrier");
  await page.getByRole("button", { name: "Create Draft", exact: true }).click();
  await expect(page.getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("e.g. Maersk", { exact: true })).toBeDisabled();
  expect(state.creations).toBe(1);
  const saved = await savedRecovery(page);
  expect(saved.body).toMatchObject({ carrierName: "Reviewed carrier" });
  expect(saved.body).not.toHaveProperty("purchaseOrder");
  await page.reload();
  await page.getByRole("button", { name: "New Shipment", exact: true }).click();
  await expect(page.getByText(/Saved request creates an empty draft shipment/)).toBeVisible();
  await expectBoundedRecoveryDialog(page);
  await page.screenshot({ path: testInfo.outputPath("empty-draft-recovery.png"), fullPage: true, animations: "disabled" });
  expect(state.requests).toHaveLength(1);
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]); expect(state.creations).toBe(1);
  expect(await savedRecovery(page)).toBeNull(); expect(failures).toEqual([]);
});

test("PO creation sends selected pieces in one command and recovers without an append or duplicate", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { lost: true });
  await openPoCreate(page);
  await expect(page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true })).toHaveValue("501");
  await page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true }).fill("125");
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0].body.purchaseOrder).toEqual({ purchaseOrderId: 17, lineSelections: [{ poLineId: 15, qty: 125 }] });
  await page.reload();
  await page.getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByText(/Saved request includes 1 selected lines from purchase order 17/)).toBeVisible();
  await expectBoundedRecoveryDialog(page);
  await page.screenshot({ path: testInfo.outputPath("po-atomic-create-recovery.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]); expect(state.creations).toBe(1);
  expect(state.lines).toMatchObject([{ purchaseOrderLineId: 15, qtyShipped: 125 }]); expect(failures).toEqual([]);
});

test("malformed success retains recovery and never navigates to an unverifiable shipment", async ({ page }) => {
  const { state, failures } = await setup(page, { malformed: true });
  await openListCreate(page); await page.getByRole("button", { name: "Create Draft", exact: true }).click();
  await expect(page.getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/shipments$/);
  expect(await savedRecovery(page)).not.toBeNull(); expect(state.creations).toBe(1);
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.creations).toBe(1); expect(failures).toEqual([]);
});

test("failed PO source loading blocks creation until explicit successful reload", async ({ page }) => {
  const { state, failures } = await setup(page, { failedSources: true });
  await openPoCreate(page);
  await expect(page.getByText(/Available purchase lines could not be loaded/)).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true })).toBeDisabled();
  expect(state.requests).toEqual([]); expect(await savedRecovery(page)).toBeNull();
  state.sourceFailure = false;
  await page.getByRole("button", { name: "Retry purchase lines", exact: true }).click();
  await expect(page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true })).toHaveValue("501");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true })).toBeEnabled();
  expect(state.sourceReads).toBeGreaterThanOrEqual(2); expect(failures).toEqual([]);
});

test("a late create result cannot redirect an operator visiting a different purchase", async ({ page }) => {
  const { state, failures, release } = await setup(page, { delayed: true });
  await openPoCreate(page);
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.history.pushState(null, "", "/purchase-orders/99?tab=shipments"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: "TEST-PO-99", exact: true })).toBeVisible();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/inbound-shipments" && response.request().method() === "POST");
  release(); await (await response).finished();
  await expect.poll(() => state.creations).toBe(1);
  await expect(page).toHaveURL(/\/purchase-orders\/99\?tab=shipments$/);
  await expect(page.getByRole("heading", { name: "TEST-PO-99", exact: true })).toBeVisible();
  await expect(page.getByText("Shipment confirmed", { exact: true })).toHaveCount(0);
  expect(await savedRecovery(page)).toBeNull(); expect(failures).toEqual([]);
});

test("an unresolved PO request blocks an unrelated empty draft and can be recovered from the shipment list", async ({ page }) => {
  const { state, failures } = await setup(page, { lost: true });
  await openPoCreate(page);
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  await openListCreate(page);
  await expect(page.getByText(/Saved request includes 1 selected lines from purchase order 17/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Draft", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.creations).toBe(1); expect(failures).toEqual([]);
});

test("PO creation requires an explicit nonempty selection of positive reviewed pieces", async ({ page }) => {
  const { state, failures } = await setup(page);
  await openPoCreate(page);
  await page.getByRole("button", { name: "Deselect all", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true }).fill("0");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true })).toBeDisabled();
  await page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true }).fill("502");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true })).toBeDisabled();
  expect(state.requests).toEqual([]); expect(failures).toEqual([]);
});

test("durable rejection clears only its own saved intent and a reviewed correction gets a new key", async ({ page }) => {
  const { state, failures } = await setup(page, { rejected: true });
  await openPoCreate(page);
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByText("Purchase quantities changed; review this selection.", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true })).toBeEnabled();
  expect(await savedRecovery(page)).toBeNull(); expect(state.creations).toBe(0);
  await page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true }).fill("100");
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests[1].key).not.toBe(state.requests[0].key); expect(state.requests[1].body.purchaseOrder.lineSelections).toEqual([{ poLineId: 15, qty: 100 }]);
  expect(state.creations).toBe(1); expect(failures).toEqual([]);
});


test("exhausted automatic numbers allow a reviewed manual number under a new command key", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { numberExhausted: true });
  await openListCreate(page);
  await page.getByRole("button", { name: "Create Draft", exact: true }).click();
  await expect(page.getByText("Automatic shipment numbering is exhausted for this date. Choose a manual shipment number.", { exact: true }).first()).toBeVisible();
  const manualNumber = page.getByLabel("Shipment number (optional)", { exact: true });
  await expect(manualNumber).toBeEnabled();
  await expect(manualNumber).toHaveAttribute("maxlength", "30");
  expect(await savedRecovery(page)).toBeNull(); expect(state.creations).toBe(0);
  expect(state.requests).toHaveLength(1); expect(state.requests[0].body).not.toHaveProperty("shipmentNumber");
  await manualNumber.fill("MANUAL-AFTER-EXHAUSTION");
  await expectBoundedRecoveryDialog(page);
  await page.screenshot({ path: testInfo.outputPath("manual-number-recovery.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Create Draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "MANUAL-AFTER-EXHAUSTION", exact: true })).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[1].key).not.toBe(state.requests[0].key);
  expect(state.requests[1].body.shipmentNumber).toBe("MANUAL-AFTER-EXHAUSTION");
  expect(state.creations).toBe(1); expect(await savedRecovery(page)).toBeNull(); expect(failures).toEqual([]);
});

test("offline submission saves recovery immediately and reconnecting after navigation never creates automatically", async ({ page }) => {
  const { state, failures } = await setup(page);
  await openListCreate(page);
  state.offline = true;
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Create Draft", exact: true }).click();
  await expect.poll(() => savedRecovery(page)).not.toBeNull();
  await expect(page.getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  const saved = await savedRecovery(page);
  expect(state.creations).toBe(0);
  await page.keyboard.press("Escape");
  await page.evaluate(() => { window.history.pushState(null, "", "/purchase-orders/99?tab=shipments"); window.dispatchEvent(new PopStateEvent("popstate")); });
  state.offline = false;
  await page.context().setOffline(false);
  await expect(page.getByRole("heading", { name: "TEST-PO-99", exact: true })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(state.creations).toBe(0);
  expect(await savedRecovery(page)).toEqual(saved);
  await openListCreate(page);
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests.at(-1)?.key).toBe(saved.key); expect(state.creations).toBe(1); expect(failures).toEqual([]);
});

test("blocked recovery reads preserve the saved request and expose an explicit retry after storage is restored", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.addInitScript(({ storageKey }) => {
    sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, userId: "test-user", key: "blocked-recovery-fixture", body: { mode: "air" } }));
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key: string) {
      if (key === storageKey) throw new DOMException("Fixture session storage blocked", "SecurityError");
      return original.call(this, key);
    };
    Object.defineProperty(window, "restoreShipmentRecovery", { value: () => { Storage.prototype.getItem = original; } });
  }, { storageKey: STORAGE_KEY });
  await openListCreate(page);
  await expect(page.getByText(/Shipment recovery cannot be read/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Draft", exact: true })).toBeDisabled();
  expect(state.requests).toEqual([]);
  await page.evaluate(() => (window as typeof window & { restoreShipmentRecovery: () => void }).restoreShipmentRecovery());
  await page.getByRole("button", { name: "Retry recovery read", exact: true }).click();
  await expect(page.getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  expect((await savedRecovery(page)).key).toBe("blocked-recovery-fixture");
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests[0].key).toBe("blocked-recovery-fixture"); expect(state.creations).toBe(1); expect(failures).toEqual([]);
});


for (const [name, sourcePayload] of [
  ["malformed", { lines: null, reviewRequiredLines: [] }],
  ["another purchase", { lines: [{ id: 15, purchaseOrderId: 99, sku: "WRONG-PO", productName: "Wrong owner", description: null, orderQty: 1000, alreadyShippedQty: 0, directReceivedQty: 0, remainingQty: 1000 }], reviewRequiredLines: [] }],
] as const) {
  test(`source response from ${name} is blocked and can be explicitly reloaded`, async ({ page }) => {
    const { state, failures } = await setup(page, { sourcePayload });
    await openPoCreate(page);
    await expect(page.getByText(/Available purchase lines could not be loaded/)).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true })).toBeDisabled();
    expect(state.requests).toEqual([]); expect(failures).toEqual([]);
    state.sourcePayload = undefined;
    await page.getByRole("button", { name: "Retry purchase lines", exact: true }).click();
    await expect(page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true })).toHaveValue("501");
    await expect(page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true })).toBeEnabled();
    expect(state.requests).toEqual([]); expect(failures).toEqual([]);
  });
}

for (const [name, warehousePayload] of [
  ["malformed", {}],
  ["duplicate identities", [{ id: 1, code: "A", name: "First" }, { id: 1, code: "B", name: "Second" }]],
] as const) {
  test(`warehouse options with ${name} remain recoverable without crashing the creation dialog`, async ({ page }) => {
    const { state, failures } = await setup(page, { warehousePayload });
    await openListCreate(page);
    await expect(page.getByText(/Warehouse options could not be loaded/)).toBeVisible();
    expect(state.requests).toEqual([]); expect(failures).toEqual([]);
    state.warehousePayload = undefined;
    await page.getByRole("button", { name: "Retry warehouses", exact: true }).click();
    await expect(page.getByText(/Warehouse options could not be loaded/)).toHaveCount(0);
    await page.getByRole("button", { name: "Create Draft", exact: true }).click();
    await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
    expect(state.creations).toBe(1); expect(failures).toEqual([]);
  });
}

test("PO creation sends configured case evidence and preserves it through recovery", async ({ page }, testInfo) => {
  const sourcePayload = { lines: [{ id: 15, purchaseOrderId: 17, sku: "REVIEWED-ITEM", productName: "Reviewed product", description: null,
    orderQty: 525000, alreadyShippedQty: 0, directReceivedQty: 0, remainingQty: 525000,
    shipmentUnits: { productId: 100, selectedVariantId: null, unitsPerVariantSnapshot: null, issue: null,
      variants: [{ id: 9, sku: "PIECE", name: "Piece", unitsPerVariant: 1 }, { id: 10, sku: "CASE1000", name: "Case of 1000", unitsPerVariant: 1000 }] } }], reviewRequiredLines: [] };
  const { state, failures } = await setup(page, { lost: true, sourcePayload }); await openPoCreate(page);
  await page.getByLabel("Count unit create-shipment-line-15", { exact: true }).selectOption("10");
  await expect(page.getByLabel("Number of receive units", { exact: true })).toHaveValue("525");
  await expect(page.getByText("525 × 1,000 pieces = 525,000 pieces shipped", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("configured-case-create.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  expect(state.requests[0].body.purchaseOrder.lineSelections).toEqual([{ poLineId: 15, qty: 525000, unitSelection: { productVariantId: 10, unitsPerVariant: 1000, quantity: 525 } }]);
  await page.reload(); await page.getByRole("button", { name: "Create Shipment", exact: true }).click();
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "RECOVERED-SHIPMENT", exact: true })).toBeVisible();
  expect(state.requests[1]).toEqual(state.requests[0]); expect(state.creations).toBe(1); expect(failures).toEqual([]);
});
