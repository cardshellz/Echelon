import { expect, test, type Page, type Route } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";

const version = "a".repeat(64);
const nextVersion = "b".repeat(64);
const fixtureLine = (id = 7) => ({ id, inboundShipmentId: 42, version, sku: `PARTIAL-CASE-${id}`, productName: "Partial carton fixture",
  purchaseOrderId: 17, purchaseOrderLineId: id, productVariantId: 9, qtyShipped: 501, cartonCount: 11,
  weightKg: "2.000", lengthCm: "10.00", widthCm: "20.00", heightCm: "30.00", notes: null as string | null,
  unitsPerVariant: 50, totalVolumeCbm: "0.066", totalWeightKg: "22.000", allocatedCostCents: 0 });
type Line = ReturnType<typeof fixtureLine>;
type Captured = { method: string; path: string; key: string; body: Record<string, any> };

async function setup(page: Page, options: { conflict?: boolean; lostImport?: boolean; dimensions?: boolean; failSecondDimension?: boolean; delayPatch?: boolean; delayImport?: boolean; allocateSiblings?: boolean; poCaller?: boolean; lostAdd?: boolean; failRefresh?: boolean } = {}) {
  const failures = await installFixtures(page);
  const state = { lines: options.dimensions ? [{ ...fixtureLine(), lengthCm: "0.00" }, { ...fixtureLine(8), lengthCm: "0.00" }] : [fixtureLine()],
    status: "booked", commands: [] as Captured[], committed: false, detailReads: 0, nextId: 10, released: false };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const replays = new Map<string, unknown>(); let lost = false; let conflicted = false; let secondFailed = false;
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (options.poCaller && path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), lines: [{ id: 15, purchaseOrderId: 17, lineType: "product", lineNumber: 1, sku: "PO-REMAINING", productName: "PO product", orderQty: 1000, receivedQty: 0, unitCostCents: 10, subtotalCents: 10000 }] } });
      if (path === "/api/vendors") return route.fulfill({ json: [{ id: 2, name: "Test vendor" }] });
      if (path === "/api/purchase-orders") return route.fulfill({ json: { purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }] } });
      if (path === "/api/purchase-orders/17/shippable-lines") return route.fulfill({ json: { lines: [{ id: 15, sku: "PO-REMAINING", remainingQty: 501, orderQty: 1000 }], reviewRequiredLines: [{ id: 16, sku: "REVIEW-PO", remainingQty: null, code: "SOURCE_REVIEW_REQUIRED", error: "Finish or cancel the pending receipt, then review this line." }] } });
      if (path === "/api/inbound-shipments/42" || path === "/api/inbound-shipments/43") {
        state.detailReads += 1;
        if (options.failRefresh && state.committed) return route.fulfill({ status: 503, json: { error: "Fixture refresh failed" } });
        const id = Number(path.split("/").at(-1));
        return route.fulfill({ json: { id, shipmentNumber: `TEST-SHIP-${id}`, status: state.status, mode: "ocean", purchaseOrderId: 17,
          lines: id === 42 ? state.lines : [{ ...fixtureLine(27), inboundShipmentId: 43, sku: "OTHER-SHIPMENT" }], costs: [], statusHistory: [] } });
      }
      if (path === "/api/inbound-shipments/43/allocation-status") return route.fulfill({ json: { issues: [], costs: [], status: "allocated", blockerCount: 0, warningCount: 0, lineCount: 1, allocatableCostCount: 0, effectiveCostCents: 0, unallocatedCents: 0 } });
      if (path === "/api/inbound-shipments/43/invoices") return route.fulfill({ json: { invoices: [], summary: { invoiceCount: 0 } } });
      if (options.dimensions && path === "/api/inbound-shipments/42/allocation-status") return route.fulfill({ json: {
        issues: [{ code: "missing_dimensions", message: "Carton dimensions required" }], costs: [{ costId: 1, costType: "freight", method: "by_volume", methodSource: "shipment_default", effectiveCents: 100, allocatedCents: 0, status: "needs_allocation" }], status: "blocked", blockerCount: 1,
        warningCount: 0, lineCount: 2, allocatableCostCount: 1, effectiveCostCents: 100, unallocatedCents: 100,
      } });
      return route.fallback();
    }
    if (options.poCaller && path === "/api/inbound-shipments" && request.method() === "POST") { state.lines = []; return route.fulfill({ status: 201, json: { id: 42, shipmentNumber: "TEST-SHIP-42" } }); }
    if (!/^\/api\/inbound-shipments\/(42\/lines\/(from-po|import-packing-list|resolve-dimensions)|lines\/\d+)$/.test(path)) return route.fallback();
    const command = { method: request.method(), path, key: request.headers()["idempotency-key"], body: request.postDataJSON() };
    state.commands.push(command);
    if (!command.key) return route.fulfill({ status: 400, json: { error: "Missing command key" } });
    if (replays.has(command.key)) return route.fulfill({ json: replays.get(command.key) });
    if ((options.delayPatch && command.method === "PATCH" || options.delayImport && path.endsWith("/import-packing-list")) && !state.released) await gate;
    if ((options.conflict && command.method === "PATCH" && !conflicted) || (options.failSecondDimension && path.endsWith("/8") && !secondFailed)) {
      conflicted = true; secondFailed = true;
      const id = Number(path.split("/").at(-1)); const line = state.lines.find((item) => item.id === id)!;
      line.version = nextVersion; line.notes = "Another operator updated this line";
      return route.fulfill({ status: 409, json: { error: "Line changed; load latest", details: { code: "SHIPMENT_LINE_VERSION_CONFLICT" } } });
    }
    let result: unknown;
    if (command.method === "PATCH" || command.method === "DELETE") {
      const id = Number(path.split("/").at(-1)); const line = state.lines.find((item) => item.id === id);
      if (!line) return route.fulfill({ status: 404, json: { error: "Line no longer exists" } });
      if (line.version !== command.body.expectedVersion) return route.fulfill({ status: 409, json: { error: "Line changed", details: { code: "SHIPMENT_LINE_VERSION_CONFLICT" } } });
      if (command.method === "DELETE") { state.lines = state.lines.filter((item) => item.id !== id); result = { success: true }; }
      else { Object.assign(line, command.body, { version: nextVersion }); result = { ...line }; }
    } else if (path.endsWith("/import-packing-list")) {
      const errors: Array<{ row: number; error: string }> = []; const created: Line[] = [];
      command.body.rows.forEach((row: Record<string, unknown>, index: number) => {
        if (!Number.isInteger(row.qtyShipped) || Number(row.qtyShipped) <= 0) { errors.push({ row: index + 1, error: "Quantity must be a positive whole number" }); return; }
        created.push({ ...fixtureLine(state.nextId++), ...row, version: nextVersion } as Line);
      });
      state.lines.push(...created); result = { imported: created.length, errors, lines: created };
    } else if (path.endsWith("/from-po")) {
      const created = command.body.lineSelections.map((selected: { poLineId: number; qty: number }) => ({ ...fixtureLine(state.nextId++), purchaseOrderLineId: selected.poLineId, qtyShipped: selected.qty, version: nextVersion }));
      state.lines.push(...created); result = created;
    } else result = { updated: 1, total: state.lines.length };
    if (options.allocateSiblings && command.method === "PATCH") state.lines.forEach((line) => { line.version = nextVersion; });
    state.committed = true; replays.set(command.key, result);
    if ((options.lostImport && path.endsWith("/import-packing-list") || options.lostAdd && path.endsWith("/from-po")) && !lost) { lost = true; return route.abort("connectionreset"); }
    return route.fulfill({ json: result });
  });
  await page.goto("/shipments/42?tab=lines");
  await expect(page.getByRole("heading", { name: "TEST-SHIP-42", exact: true })).toBeVisible();
  return { state, failures, release: () => { state.released = true; release(); } };
}
async function openEditor(page: Page) {
  const button = page.locator('button[aria-label="Edit shipment line"]:visible').first();
  if (await button.count()) await button.click();
  else await page.getByText("PARTIAL-CASE-7", { exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function upload(page: Page, csv: string) {
  await page.getByRole("button", { name: "Import Packing List", exact: true }).click();
  await page.getByLabel("Packing list CSV", { exact: true }).setInputFiles({ name: "packing.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview rows", exact: true }).click();
}
test("dimension-only edit preserves partial carton pieces and validates explicit quantity", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page); await openEditor(page);
  await expect(page.getByLabel("Pieces shipped", { exact: true })).toHaveValue("501");
  await expect(page.getByLabel("Cartons", { exact: true })).toHaveValue("11");
  await expect(page.getByText(/Live catalog pack reference: 50/)).toBeVisible();
  await page.getByLabel("Pieces shipped", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("qtyShipped"); expect(state.commands).toHaveLength(0);
  await page.getByLabel("Pieces shipped", { exact: true }).fill("501");
  await page.getByLabel("Length (cm)", { exact: true }).fill("12.50");
  await page.screenshot({ path: testInfo.outputPath("partial-carton-line-editor.png"), fullPage: true });
  await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.commands[0].body).toEqual({ expectedVersion: version, lengthCm: "12.50" });
  expect(state.lines[0].qtyShipped).toBe(501); expect(state.lines[0].cartonCount).toBe(11);
  expect(failures).toEqual([]);
});
test("CSV sends camelCase; partial rejection retains only failed rows for correction", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page);
  await upload(page, "sku,qty_shipped,carton_count,weight_kg\nGOOD,501,11,2.125\nBAD,0,1,1.000");
  await page.getByRole("button", { name: "Import 2 rows", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("1 rows imported; 1 rows rejected.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Data row 1 SKU", { exact: true })).toHaveValue("BAD");
  await expect(page.getByText(/Submitted data row 2: Quantity/)).toBeVisible();
  expect(state.commands[0].body.rows).toEqual([{ sku: "GOOD", qtyShipped: 501, cartonCount: 11, weightKg: "2.125" }, { sku: "BAD", qtyShipped: 0, cartonCount: 1, weightKg: "1.000" }]);
  const dialogBounds = await page.getByRole("dialog").boundingBox();
  const tableBounds = await page.getByRole("region", { name: "Packing list rows", exact: true }).boundingBox();
  expect(tableBounds!.x + tableBounds!.width).toBeLessThanOrEqual(dialogBounds!.x + dialogBounds!.width);
  const closeBounds = await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last().boundingBox();
  expect(closeBounds!.x + closeBounds!.width).toBeLessThanOrEqual(dialogBounds!.x + dialogBounds!.width);
  await page.screenshot({ path: testInfo.outputPath("packing-list-partial-results.png"), fullPage: true });
  await page.getByLabel("Data row 1 Pieces shipped", { exact: true }).fill("25");
  await page.getByRole("button", { name: "Import 1 rows", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("All submitted rows were imported.")).toBeVisible();
  expect(state.commands[1].body.rows).toEqual([{ sku: "BAD", qtyShipped: 25, cartonCount: 1, weightKg: "1.000" }]);
  expect(state.commands[1].key).not.toBe(state.commands[0].key); expect(state.lines.filter((line) => line.sku === "GOOD")).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(failures).toEqual([]);
});
test("lost import response can be dismissed, reloaded, and retried with exactly the original key", async ({ page }) => {
  const { state, failures } = await setup(page, { lostImport: true });
  await upload(page, "sku,qty_shipped\nONE,5"); await page.getByRole("button", { name: "Import 1 rows", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("request could not be completed");
  await expect(page.getByLabel("Data row 1 SKU", { exact: true })).toBeDisabled();
  await page.keyboard.press("Escape"); await page.getByRole("tab", { name: /^Costs/ }).click();
  await expect(page.getByText("Shipment line change needs review", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept()); await page.reload();
  await page.getByRole("button", { name: "Review pending line command", exact: true }).click();
  expect(state.commands).toHaveLength(1);
  await page.getByRole("button", { name: "Retry original line command", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("All submitted rows were imported.")).toBeVisible();
  expect(state.commands).toHaveLength(2); expect(state.commands[0].key).toBe(state.commands[1].key);
  expect(state.commands[0].body).toEqual(state.commands[1].body); expect(state.lines.filter((line) => line.sku === "ONE")).toHaveLength(1);
  expect(failures).toEqual([]);
});
test("version conflict preserves draft until explicit load-latest and rotates the key", async ({ page }) => {
  const { state, failures } = await setup(page, { conflict: true }); await openEditor(page);
  await page.getByLabel("Notes", { exact: true }).fill("My original draft"); await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load latest line", exact: true })).toBeVisible();
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("My original draft");
  await expect(page.getByRole("button", { name: "Save line", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Load latest line", exact: true }).click();
  await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("Another operator updated this line");
  await page.getByLabel("Notes", { exact: true }).fill("Reviewed latest"); await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.commands[1].body.expectedVersion).toBe(nextVersion); expect(state.commands[1].key).not.toBe(state.commands[0].key);
  expect(failures).toEqual([]);
});
test("add uses explicit remaining piece selections; resolve and delete have safe command bodies", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.getByRole("button", { name: "Add from PO", exact: true }).click(); await page.getByLabel("Purchase order", { exact: true }).selectOption("17");
  await page.getByRole("checkbox", { name: "PO-REMAINING" }).check(); await page.getByLabel("Pieces for PO-REMAINING", { exact: true }).fill("501");
  await page.getByRole("button", { name: "Add selected lines", exact: true }).click(); await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.commands[0].body).toEqual({ purchaseOrderId: 17, lineSelections: [{ poLineId: 15, qty: 501 }] });
  await page.getByRole("button", { name: "Resolve Dimensions", exact: true }).click();
  await expect(page.getByText("1 of 2 lines updated from product data", { exact: true }).first()).toBeVisible();
  expect(state.commands[1].body).toEqual({});
  page.once("dialog", (dialog) => dialog.accept()); await page.locator('button[aria-label="Remove shipment line"]:visible').first().click();
  await expect.poll(() => state.commands.length).toBe(3); expect(state.commands[2].body).toEqual({ expectedVersion: version });
  expect(failures).toEqual([]);
});
test("dimension batch reports saved rows and retries only rows remaining after conflict review", async ({ page }) => {
  const { state, failures } = await setup(page, { dimensions: true, failSecondDimension: true });
  await page.getByRole("button", { name: "Enter dimensions", exact: true }).click();
  await page.locator("#dimension-7-lengthCm").fill("12.50"); await page.locator("#dimension-8-lengthCm").fill("15.00");
  await page.getByRole("button", { name: "Save remaining dimensions", exact: true }).click();
  await expect(page.getByText("PARTIAL-CASE-7 — Saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load latest for PARTIAL-CASE-8", exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(2);
  await page.getByRole("button", { name: "Load latest for PARTIAL-CASE-8", exact: true }).click();
  await page.locator("#dimension-8-lengthCm").fill("15.00"); await page.getByRole("button", { name: "Save remaining dimensions", exact: true }).click();
  await expect(page.getByText("PARTIAL-CASE-8 — Saved", { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(3); expect(state.commands.filter((command) => command.path.endsWith("/7"))).toHaveLength(1);
  expect(state.commands[2].body).toEqual({ expectedVersion: nextVersion, lengthCm: "15.00" });
  expect(state.lines.every((line) => line.qtyShipped === 501)).toBe(true); expect(failures).toEqual([]);
});
test("late line response refreshes its source without replacing a different shipment visit", async ({ page }) => {
  const { state, failures, release } = await setup(page, { delayPatch: true }); await openEditor(page);
  await page.getByLabel("Notes", { exact: true }).fill("Original shipment only"); await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect.poll(() => state.commands.length).toBe(1); await page.keyboard.press("Escape");
  await page.evaluate(() => { window.history.pushState(null, "", "/shipments/43?tab=lines"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: "TEST-SHIP-43", exact: true })).toBeVisible(); release();
  await expect.poll(() => state.lines[0].notes).toBe("Original shipment only");
  await expect(page.getByRole("heading", { name: "TEST-SHIP-43", exact: true })).toBeVisible(); await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Resolve Dimensions", exact: true })).toBeEnabled(); expect(failures).toEqual([]);
});
test("confirmed line save with failed refresh does not create an unresolved retry", async ({ page }) => {
  const { state, failures } = await setup(page, { failRefresh: true }); await openEditor(page);
  await page.getByLabel("Notes", { exact: true }).fill("Saved before refresh failure"); await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByText(/command completed, but this view could not refresh/).first()).toBeVisible(); expect(state.commands).toHaveLength(1);
  expect(await page.evaluate(() => sessionStorage.getItem("echelon:shipment-lines:v1:test-user:42"))).toBeNull(); expect(failures).toEqual([]);
});

test("a completed A→B→A import recovery card retries the original key rather than duplicating the import", async ({ page }) => {
  const { state, failures, release } = await setup(page, { delayImport: true });
  await upload(page, "sku,qty_shipped\nDELAYED,7"); await page.getByRole("button", { name: "Import 1 rows", exact: true }).click();
  await expect.poll(() => state.commands.length).toBe(1); await page.keyboard.press("Escape");
  await page.evaluate(() => { window.history.pushState(null, "", "/shipments/43?tab=lines"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: "TEST-SHIP-43", exact: true })).toBeVisible();
  await page.evaluate(() => { window.history.pushState(null, "", "/shipments/42?tab=lines"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("button", { name: "Review pending line command", exact: true })).toBeVisible();
  release();
  await expect.poll(() => state.lines.filter((line) => line.sku === "DELAYED").length).toBe(1);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("echelon:shipment-lines:v1:test-user:42"))).toBeNull();
  await page.getByRole("button", { name: "Review pending line command", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry original line command", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry original line command", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("All submitted rows were imported.")).toBeVisible();
  expect(state.commands).toHaveLength(2); expect(state.commands[1].key).toBe(state.commands[0].key);
  expect(state.lines.filter((line) => line.sku === "DELAYED")).toHaveLength(1); expect(failures).toEqual([]);
});

test("an uncertain command remains replayable after the shipment becomes read-only", async ({ page }) => {
  const { state, failures } = await setup(page, { lostImport: true });
  await upload(page, "sku,qty_shipped\nCLOSED-REPLAY,2"); await page.getByRole("button", { name: "Import 1 rows", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("request could not be completed");
  state.status = "closed"; page.once("dialog", (dialog) => dialog.accept()); await page.reload();
  await page.getByRole("button", { name: "Review pending line command", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry original line command", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry original line command", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("All submitted rows were imported.")).toBeVisible();
  expect(state.commands[1].key).toBe(state.commands[0].key); expect(state.lines.filter((line) => line.sku === "CLOSED-REPLAY")).toHaveLength(1); expect(failures).toEqual([]);
});

test("dimension batch adopts only allocation-induced sibling versions without mandatory conflicts", async ({ page }) => {
  const { state, failures } = await setup(page, { dimensions: true, allocateSiblings: true });
  await page.getByRole("button", { name: "Enter dimensions", exact: true }).click();
  await page.locator("#dimension-7-lengthCm").fill("12.50"); await page.locator("#dimension-8-lengthCm").fill("15.00");
  await page.getByRole("button", { name: "Save remaining dimensions", exact: true }).click();
  await expect(page.getByText("PARTIAL-CASE-8 — Saved", { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(2);
  expect(state.commands[0].body.expectedVersion).toBe(version); expect(state.commands[1].body.expectedVersion).toBe(nextVersion);
  expect(state.lines.every((line) => line.qtyShipped === 501)).toBe(true); expect(failures).toEqual([]);
});

test("PO shipment creation appends explicit pieces and hands uncertain append recovery to the shipment", async ({ page }) => {
  const { state, failures } = await setup(page, { poCaller: true, lostAdd: true });
  await page.goto("/purchase-orders/17?tab=shipments");
  await page.getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(/REVIEW-PO: Finish or cancel/)).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("spinbutton")).toHaveValue("501");
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "TEST-SHIP-42", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review pending line command", exact: true }).click();
  await page.getByRole("button", { name: "Retry original line command", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.commands).toHaveLength(2);
  expect(state.commands[0].body).toEqual({ purchaseOrderId: 17, lineSelections: [{ poLineId: 15, qty: 501 }] });
  expect(state.commands[1].key).toBe(state.commands[0].key);
  expect(state.lines).toHaveLength(1); expect(state.lines[0].qtyShipped).toBe(501); expect(failures).toEqual([]);
});

test("failed import optional values can be cleared before retrying only rejected rows", async ({ page }) => {
  const { state, failures } = await setup(page);
  await upload(page, "sku,qty_shipped,weight_kg\nGOOD,5,1.000\nBAD,0,bad-weight");
  await page.getByRole("button", { name: "Import 2 rows", exact: true }).click();
  await expect(page.getByLabel("Data row 1 SKU", { exact: true })).toHaveValue("BAD");
  await page.getByLabel("Data row 1 Weight (kg)", { exact: true }).fill("");
  await page.getByLabel("Data row 1 Pieces shipped", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Import 1 rows", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("All submitted rows were imported.")).toBeVisible();
  expect(state.commands[1].body.rows).toEqual([{ sku: "BAD", qtyShipped: 6 }]);
  expect(state.lines.filter((line) => line.sku === "GOOD")).toHaveLength(1); expect(failures).toEqual([]);
});
