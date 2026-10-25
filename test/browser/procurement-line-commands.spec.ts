import { workListPage } from "./procurement-ap-work-list-fixtures";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { relationshipFixture } from "../fixtures/document-relationships";

const version = "a".repeat(64);
const nextVersion = "b".repeat(64);
const fixtureLine = (id = 7) => ({ id, inboundShipmentId: 42, version, sku: `PARTIAL-CASE-${id}`, productName: "Partial carton fixture",
  purchaseOrderId: 17, purchaseOrderLineId: id, productVariantId: 9, qtyShipped: 501, cartonCount: 11,
  weightKg: "2.000", lengthCm: "10.00", widthCm: "20.00", heightCm: "30.00", notes: null as string | null,
  dimensionBasis: null as "piece" | "carton" | null, unitsPerVariantSnapshot: null as number | null, shipmentUnits: null as null | { productId: number; selectedVariantId: number | null; unitsPerVariantSnapshot: number | null; issue: null; variants: Array<{ id: number; sku: string; name: string; unitsPerVariant: number }> },
  unitsPerVariant: 50, totalVolumeCbm: "0.066", totalWeightKg: "22.000", allocatedCostCents: 0 });
type Line = ReturnType<typeof fixtureLine>;
type Captured = { method: string; path: string; key: string; body: Record<string, any> };

const configuredUnits = { productId: 100, selectedVariantId: null, unitsPerVariantSnapshot: null, issue: null,
  variants: [{ id: 9, sku: "PIECE", name: "Piece", unitsPerVariant: 1 }, { id: 10, sku: "CASE1000", name: "Case of 1000", unitsPerVariant: 1000 }] };
function unitEvidence(body: Record<string, any>) {
  if (!body.unitSelection) return {};
  const unit = body.unitSelection;
  return { productVariantId: unit.productVariantId, unitsPerVariantSnapshot: unit.unitsPerVariant,
    shipmentUnits: { ...configuredUnits, selectedVariantId: unit.productVariantId, unitsPerVariantSnapshot: unit.unitsPerVariant } };
}

async function setup(page: Page, options: { configured?: boolean; dimensionReview?: boolean; lostThenAuth?: boolean; conflict?: boolean; lostImport?: boolean; dimensions?: boolean; failSecondDimension?: boolean; delayPatch?: boolean; delayImport?: boolean; allocateSiblings?: boolean; poCaller?: boolean; lostAdd?: boolean; failRefresh?: boolean } = {}) {
  const failures = await installFixtures(page);
  const state = { lines: options.dimensions ? [{ ...fixtureLine(), lengthCm: "0.00" }, { ...fixtureLine(8), lengthCm: "0.00" }] : [fixtureLine()],
    status: "booked", commands: [] as Captured[], committed: false, detailReads: 0, nextId: 10, released: false };
  if (options.configured) Object.assign(state.lines[0], { qtyShipped: 525000, shipmentUnits: configuredUnits });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const replays = new Map<string, unknown>(); let lost = false; let conflicted = false; let secondFailed = false;
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (/^\/api\/procurement\/relationships\/shipment\/(42|43)$/.test(path)) {
        const id = Number(path.split("/").at(-1));
        const lines = id === 42 ? state.lines : [{ ...fixtureLine(27), inboundShipmentId: 43, sku: "OTHER-SHIPMENT" }];
        const relationships = relationshipFixture({ kind: "shipment", id });
        relationships.shipments = [{ id, number: `TEST-SHIP-${id}`, status: state.status }];
        relationships.purchases = [{ id: 17, number: "TEST-PO-17" }];
        relationships.purchaseLines = lines.map(line => ({ id: line.purchaseOrderLineId, purchaseId: 17, lineNumber: line.id, sku: line.sku, product: line.productName, orderedPieces: 525000 }));
        relationships.shipmentLines = lines.map(line => ({ id: line.id, shipmentId: id, purchaseId: 17, purchaseLineId: line.purchaseOrderLineId, sku: line.sku, product: line.productName, shippedPieces: line.qtyShipped }));
        relationships.allocations = []; relationships.charges = []; relationships.receipts = []; relationships.receiptLines = [];
        return route.fulfill({ json: relationships });
      }
      if (options.poCaller && path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), lines: [{ id: 15, purchaseOrderId: 17, lineType: "product", lineNumber: 1, sku: "PO-REMAINING", productName: "PO product", orderQty: 1000, receivedQty: 0, unitCostCents: 10, subtotalCents: 10000 }] } });
      if (path === "/api/vendors") return route.fulfill({ json: [{ id: 2, name: "Test vendor" }] });
      if (path === "/api/purchase-orders") return route.fulfill({ json: { purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }] } });
      if (path === "/api/purchase-orders/work-list") return route.fulfill({ json: workListPage([{ id: 17, poNumber: "TEST-PO-17", vendorId: 2, status: "received", totalCents: 10000 }], request.url()) });
      if (path === "/api/purchase-orders/17/shippable-lines") return route.fulfill({ json: { lines: [{ id: 15, purchaseOrderId: 17, sku: "PO-REMAINING", productName: "PO product", description: null, remainingQty: options.configured ? 525000 : 501, orderQty: options.configured ? 525000 : 1000, alreadyShippedQty: options.configured ? 0 : 499, directReceivedQty: 0, ...(options.configured ? { shipmentUnits: configuredUnits } : {}) }], reviewRequiredLines: [{ id: 16, purchaseOrderId: 17, sku: "REVIEW-PO", remainingQty: null, code: "SOURCE_REVIEW_REQUIRED", error: "Finish or cancel the pending receipt, then review this line." }] } });
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
    if (path === "/api/inbound-shipments/42/lines/unit-options") return route.fulfill({ json: { shipmentId: 42, rows: request.postDataJSON().rows.map((row: unknown, index: number) => ({ row: index + 1, units: options.configured ? configuredUnits : { productId: null, selectedVariantId: null, unitsPerVariantSnapshot: null, variants: [], issue: null } })) } });
    if (options.poCaller && path === "/api/inbound-shipments" && request.method() === "POST") {
      const command = { method: request.method(), path, key: request.headers()["idempotency-key"], body: request.postDataJSON() };
      state.commands.push(command);
      if (!command.key) return route.fulfill({ status: 400, json: { error: "Missing command key" } });
      if (replays.has(command.key)) return route.fulfill({ status: 201, json: replays.get(command.key) });
      state.lines = command.body.purchaseOrder.lineSelections.map((selected: { poLineId: number; qty: number; unitSelection?: unknown }) => ({ ...fixtureLine(state.nextId++), purchaseOrderLineId: selected.poLineId, qtyShipped: selected.qty, ...unitEvidence(selected) }));
      const result = { id: 42, shipmentNumber: "TEST-SHIP-42", status: "draft", lineCount: state.lines.length, createdBy: "test-user", createdAt: "2026-10-18T12:00:00.000Z", updatedAt: "2026-10-18T12:00:00.000Z" };
      replays.set(command.key, result);
      if (options.lostAdd && !lost) { lost = true; return route.abort("connectionreset"); }
      return route.fulfill({ status: 201, json: result });
    }
    if (!/^\/api\/inbound-shipments\/(42\/lines\/(from-po|import-packing-list|resolve-dimensions)|lines\/\d+)$/.test(path)) return route.fallback();
    const command = { method: request.method(), path, key: request.headers()["idempotency-key"], body: request.postDataJSON() };
    state.commands.push(command);
    if (!command.key) return route.fulfill({ status: 400, json: { error: "Missing command key" } });
    if (options.lostThenAuth && state.commands.length === 2) return route.fulfill({ status: 401, json: { error: "Sign in again to retry the original command" } });
    if (replays.has(command.key)) return route.fulfill({ json: replays.get(command.key) });
    if ((options.delayPatch && command.method === "PATCH" || options.delayImport && path.endsWith("/import-packing-list")) && !state.released) await gate;
    if ((options.conflict && command.method === "PATCH" && !conflicted) || (options.failSecondDimension && path.endsWith("/8") && !secondFailed)) {
      conflicted = true; secondFailed = true;
      const id = Number(path.split("/").at(-1)); const line = state.lines.find((item) => item.id === id)!;
      line.version = nextVersion; line.notes = "Another operator updated this line";
      return route.fulfill({ status: 409, json: { error: "Line changed; load latest", details: { code: "SHIPMENT_LINE_VERSION_CONFLICT", shipmentLineOutcome: "rejected", idempotencyKey: command.key } } });
    }
    let result: unknown;
    if (command.method === "PATCH" || command.method === "DELETE") {
      const id = Number(path.split("/").at(-1)); const line = state.lines.find((item) => item.id === id);
      if (!line) return route.fulfill({ status: 404, json: { error: "Line no longer exists" } });
      if (line.version !== command.body.expectedVersion) return route.fulfill({ status: 409, json: { error: "Line changed", details: { code: "SHIPMENT_LINE_VERSION_CONFLICT", shipmentLineOutcome: "rejected", idempotencyKey: command.key } } });
      if (command.method === "DELETE") { state.lines = state.lines.filter((item) => item.id !== id); result = { success: true }; }
      else { Object.assign(line, command.body, unitEvidence(command.body), { version: nextVersion }); result = { ...line }; }
    } else if (path.endsWith("/import-packing-list")) {
      const errors: Array<{ row: number; error: string }> = []; const created: Line[] = [];
      command.body.rows.forEach((row: Record<string, unknown>, index: number) => {
        if (!Number.isInteger(row.qtyShipped) || Number(row.qtyShipped) <= 0) { errors.push({ row: index + 1, error: "Quantity must be a positive whole number" }); return; }
        created.push({ ...fixtureLine(state.nextId++), ...row, ...unitEvidence(row), version: nextVersion } as Line);
      });
      state.lines.push(...created); result = { imported: created.length, errors, lines: created };
    } else if (path.endsWith("/from-po")) {
      const created = command.body.lineSelections.map((selected: { poLineId: number; qty: number; unitSelection?: unknown }) => ({ ...fixtureLine(state.nextId++), purchaseOrderLineId: selected.poLineId, qtyShipped: selected.qty, ...unitEvidence(selected), version: nextVersion }));
      state.lines.push(...created); result = created;
    } else result = { updated: options.dimensionReview ? 0 : 1, total: state.lines.length, reviewRequiredLines: options.dimensionReview ? [{ lineId: 7, code: "SHIPMENT_DIMENSIONS_REQUIRE_PACKING_EVIDENCE", message: "Enter the actual shipping carton count and measured dimensions." }] : [] };
    if (options.allocateSiblings && command.method === "PATCH") state.lines.forEach((line) => { line.version = nextVersion; });
    state.committed = true; replays.set(command.key, result);
    if (((options.lostImport || options.lostThenAuth) && path.endsWith("/import-packing-list") || options.lostAdd && path.endsWith("/from-po")) && !lost) { lost = true; return route.abort("connectionreset"); }
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
  await expect(page.getByLabel("Shipping cartons", { exact: true })).toHaveValue("11");
  await expect(page.getByText(/Configured receive units could not be verified/)).toBeVisible();
  await page.getByLabel("Pieces shipped", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert").first()).toContainText("positive whole"); expect(state.commands).toHaveLength(0);
  await page.getByLabel("Pieces shipped", { exact: true }).fill("501");
  await page.getByLabel("Length (cm)", { exact: true }).fill("12.50");
  await page.screenshot({ path: testInfo.outputPath("partial-carton-line-editor.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.commands[0].body).toEqual({ expectedVersion: version, lengthCm: "12.50", dimensionBasis: "carton" });
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
  await page.screenshot({ path: testInfo.outputPath("packing-list-partial-results.png"), fullPage: true, animations: "disabled" });
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
  await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "request could not be completed" })).toContainText("request could not be completed");
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
  expect(state.commands[2].body).toEqual({ expectedVersion: nextVersion, lengthCm: "15.00", dimensionBasis: "carton" });
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
  await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "request could not be completed" })).toContainText("request could not be completed");
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

test("PO shipment creation commits explicit pieces atomically and recovers the original create command", async ({ page }) => {
  const { state, failures } = await setup(page, { poCaller: true, lostAdd: true });
  await page.goto("/purchase-orders/17?tab=shipments");
  await page.getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(/REVIEW-PO: Finish or cancel/)).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Pieces shipped", { exact: true })).toHaveValue("501");
  await page.getByRole("dialog").getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Shipment creation needs confirmation", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Recover shipment creation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "TEST-SHIP-42", exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(2);
  expect(state.commands[0].path).toBe("/api/inbound-shipments");
  expect(state.commands[0].body.purchaseOrder).toEqual({ purchaseOrderId: 17, lineSelections: [{ poLineId: 15, qty: 501 }] });
  expect(state.commands[1]).toEqual(state.commands[0]);
  expect(state.lines).toHaveLength(1); expect(state.lines[0].qtyShipped).toBe(501); expect(failures).toEqual([]);
});

test("failed import optional values can be cleared before retrying only rejected rows", async ({ page }) => {
  const { state, failures } = await setup(page);
  await upload(page, "sku,qty_shipped,weight_kg\nGOOD,5,1.000\nBAD,0,bad-weight");
  await page.getByRole("button", { name: "Import 2 rows", exact: true }).click();
  await expect(page.getByLabel("Data row 1 SKU", { exact: true })).toHaveValue("BAD");
  await page.getByLabel("Data row 1 Weight per piece (kg)", { exact: true }).fill("");
  await page.getByLabel("Data row 1 Pieces shipped", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Import 1 rows", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("All submitted rows were imported.")).toBeVisible();
  expect(state.commands[1].body.rows).toEqual([{ sku: "BAD", qtyShipped: 6 }]);
  expect(state.lines.filter((line) => line.sku === "GOOD")).toHaveLength(1); expect(failures).toEqual([]);
});


test("shipment add-lines searches POs beyond 200 and preserves selected quantities across pages and search", async ({ page }) => {
  const { state, failures } = await setup(page); const requests: URLSearchParams[] = [];
  const all = Array.from({ length: 225 }, (_, index) => ({ id: index + 1, poNumber: `OLDER-PO-${index + 1}`, vendorId: 2, status: "received", totalCents: 10000 }));
  await page.route("**/api/purchase-orders/work-list?*", route => {
    const params = new URL(route.request().url()).searchParams; requests.push(params);
    return route.fulfill({ json: workListPage(params.get("search") ? all.filter(po => po.poNumber === params.get("search")) : all, route.request().url()) });
  });
  await page.route("**/api/purchase-orders/225/shippable-lines", route => route.fulfill({ json: { lines: [{ id: 2251, sku: "OLDER-PIECES", remainingQty: 12, orderQty: 12 }], reviewRequiredLines: [] } }));
  await page.getByRole("button", { name: "Add from PO", exact: true }).click();
  const dialog = page.getByRole("dialog"); const pages = dialog.getByRole("navigation", { name: "purchase orders pages" });
  await expect(pages).toContainText("1–20 of 225 purchase orders"); await pages.getByRole("button", { name: "Next", exact: true }).click();
  await expect(pages).toContainText("21–40 of 225 purchase orders");
  await dialog.getByLabel("Find purchase order", { exact: true }).fill("OLDER-PO-225");
  await expect(pages).toContainText("1–1 of 1 purchase orders");
  await dialog.getByLabel("Purchase order", { exact: true }).selectOption("225");
  await dialog.getByRole("checkbox", { name: "OLDER-PIECES" }).check();
  await dialog.getByLabel("Pieces for OLDER-PIECES", { exact: true }).fill("7");
  await dialog.getByLabel("Find purchase order", { exact: true }).fill("");
  await expect(pages).toContainText("1–20 of 225 purchase orders");
  await expect(dialog.getByLabel("Purchase order", { exact: true })).toHaveValue("225");
  await expect(dialog.getByLabel("Pieces for OLDER-PIECES", { exact: true })).toHaveValue("7");
  expect(requests.every(params => params.get("purpose") === "shipment-lines" && !params.has("vendorId"))).toBe(true);
  expect(state.commands).toEqual([]); expect(failures).toEqual([]);
});

test("shipment PO filter failures retry truthfully and stale searches cannot replace the selected PO or a new shipment visit", async ({ page }) => {
  const { state, failures } = await setup(page); let failed = true; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/purchase-orders/work-list?*", async route => {
    if (failed) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    const search = new URL(route.request().url()).searchParams.get("search");
    if (search === "delayed") await gate;
    return route.fulfill({ json: workListPage([{ id: search === "delayed" ? 99 : 17, poNumber: search === "delayed" ? "STALE-PO-99" : "TEST-PO-17", vendorId: 2, status: "received", totalCents: 10000 }], route.request().url()) });
  });
  await page.getByRole("button", { name: "Add from PO", exact: true }).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText("Purchase orders could not be loaded");
  await expect(dialog.getByText("No purchase orders match this search.")).toHaveCount(0);
  failed = false; await dialog.getByRole("button", { name: "Retry purchase orders", exact: true }).click();
  await dialog.getByLabel("Purchase order", { exact: true }).selectOption("17");
  await dialog.getByRole("checkbox", { name: "PO-REMAINING" }).check();
  await dialog.getByLabel("Find purchase order", { exact: true }).fill("delayed");
  await expect(dialog.getByText("Loading purchase orders…", { exact: true })).toBeVisible();
  await dialog.getByLabel("Find purchase order", { exact: true }).fill(""); release();
  await expect(dialog.getByLabel("Purchase order", { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel("Purchase order", { exact: true })).toHaveValue("17");
  await expect(dialog.getByRole("option", { name: "STALE-PO-99" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
  await page.evaluate(() => { window.history.pushState(null, "", "/shipments/43?tab=lines"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await expect(page.getByRole("heading", { name: "TEST-SHIP-43", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add from PO", exact: true }).click();
  await expect(page.getByLabel("Purchase order", { exact: true })).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "PO-REMAINING" })).toHaveCount(0);
  expect(state.commands).toEqual([]); expect(failures).toEqual([]);
});

test("configured case edit converts exactly, preserves physical packing and persists piece selection", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { configured: true }); await openEditor(page);
  await page.getByLabel("Count unit line-edit-7", { exact: true }).selectOption("10");
  await expect(page.getByLabel("Number of receive units", { exact: true })).toHaveValue("525");
  await expect(page.getByText("525 × 1,000 pieces = 525,000 pieces shipped", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Shipping cartons", { exact: true })).toHaveValue("11");
  await expect(page.getByLabel("Length (cm)", { exact: true })).toHaveValue("10.00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("configured-case-editor.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.commands[0].body).toEqual({ expectedVersion: version, qtyShipped: 525000, unitSelection: { productVariantId: 10, unitsPerVariant: 1000, quantity: 525 } });
  await openEditor(page);
  await expect(page.getByLabel("Number of receive units", { exact: true })).toHaveValue("525");
  await page.getByLabel("Count unit line-edit-7", { exact: true }).selectOption("9");
  await expect(page.getByLabel("Pieces shipped", { exact: true })).toHaveValue("525000");
  await page.getByRole("button", { name: "Save line", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible(); await openEditor(page);
  await expect(page.getByLabel("Count unit line-edit-7", { exact: true })).toHaveValue("9");
  expect(state.commands[1].body.unitSelection).toEqual({ productVariantId: 9, unitsPerVariant: 1, quantity: 525000 });
  expect(state.lines[0].cartonCount).toBe(11); expect(failures).toEqual([]);
});
test("Add from PO binds configured cases and recovers same unit selection after lost response", async ({ page }) => {
  const { state, failures } = await setup(page, { configured: true, lostAdd: true });
  await page.getByRole("button", { name: "Add from PO", exact: true }).click(); await page.getByLabel("Purchase order", { exact: true }).selectOption("17");
  await page.getByRole("checkbox", { name: "PO-REMAINING" }).check();
  await page.getByLabel("Count unit po-line-15", { exact: true }).selectOption("10");
  await expect(page.getByLabel("Number of receive units", { exact: true })).toHaveValue("525");
  await page.getByRole("button", { name: "Add selected lines", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "request could not be completed" })).toContainText("request could not be completed");
  await page.keyboard.press("Escape"); page.once("dialog", (dialog) => dialog.accept()); await page.reload();
  await page.getByRole("button", { name: "Review pending line command", exact: true }).click();
  await page.getByRole("button", { name: "Retry original line command", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(state.commands[0].body.lineSelections).toEqual([{ poLineId: 15, qty: 525000, unitSelection: { productVariantId: 10, unitsPerVariant: 1000, quantity: 525 } }]);
  expect(state.commands[1]).toEqual(state.commands[0]); expect(state.lines).toHaveLength(2); expect(failures).toEqual([]);
});
test("CSV mapped cases retain exact evidence through lost response, sign-in failure and reload", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page, { configured: true, lostThenAuth: true });
  await upload(page, "sku,receive_variant_id,receive_unit_quantity,receive_units_per_variant\nCASE1000,10,525,1000");
  await expect(page.getByLabel("Count unit packing-row-1", { exact: true })).toHaveValue("10");
  await expect(page.getByText("525 × 1,000 pieces = 525,000 pieces shipped", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("configured-case-csv.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Import 1 rows", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert").filter({ hasText: "request could not be completed" })).toContainText("request could not be completed");
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Review pending line command", exact: true }).click();
  await page.getByRole("button", { name: "Retry original line command", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Sign in again");
  page.once("dialog", (dialog) => dialog.accept()); await page.reload();
  await page.getByRole("button", { name: "Review pending line command", exact: true }).click();
  await page.getByRole("button", { name: "Retry original line command", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("All submitted rows were imported.")).toBeVisible();
  expect(state.commands).toHaveLength(3); expect(state.commands[1]).toEqual(state.commands[0]); expect(state.commands[2]).toEqual(state.commands[0]);
  expect(state.commands[0].body.rows).toEqual([{ sku: "CASE1000", qtyShipped: 525000, unitSelection: { productVariantId: 10, unitsPerVariant: 1000, quantity: 525 } }]);
  expect(state.lines.filter((line) => line.sku === "CASE1000")).toHaveLength(1); expect(failures).toEqual([]);
});
test("dimension resolution keeps skipped packing evidence visible with correction action", async ({ page }) => {
  const { state, failures } = await setup(page, { configured: true, dimensionReview: true });
  await page.getByRole("button", { name: "Resolve Dimensions", exact: true }).click();
  await expect(page.getByText("Packing measurements still needed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Line #7: Enter the actual shipping carton/)).toBeVisible();
  await page.getByRole("button", { name: "Enter packing measurements", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Enter missing dimensions", exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(1); expect(failures).toEqual([]);
});

test("packing unit lookup is bounded to row identity and exposes a recoverable read failure", async ({ page }) => {
  const { failures } = await setup(page, { configured: true });
  let unavailable = true;
  const lookups: Array<Record<string, unknown>> = [];
  await page.route("**/api/inbound-shipments/42/lines/unit-options", async route => {
    const body = route.request().postDataJSON(); lookups.push(body);
    if (unavailable) return route.fulfill({ status: 503, json: { error: "Unit evidence unavailable" } });
    return route.fulfill({ json: { shipmentId: 42, rows: body.rows.map((row: unknown, index: number) => ({ row: index + 1, units: configuredUnits })) } });
  });
  await upload(page, "sku,qty_shipped,notes\nPIECE,525000,Preserve this note");
  await expect(page.getByRole("dialog").getByText(/Configured receive units could not be loaded/)).toBeVisible();
  await expect(page.getByLabel("Data row 1 Pieces shipped", { exact: true })).toHaveValue("525000");
  expect(lookups[0]).toEqual({ rows: [{ sku: "PIECE" }] });
  unavailable = false;
  await page.getByRole("button", { name: "Retry receive units", exact: true }).click();
  await expect(page.getByLabel("Count unit packing-row-1", { exact: true }).getByRole("option", { name: "Case of 1000 (1000 pieces)", exact: true })).toHaveCount(1);
  await page.getByLabel("Count unit packing-row-1", { exact: true }).selectOption("10");
  await expect(page.getByLabel("Number of receive units", { exact: true })).toHaveValue("525");
  await expect(page.getByLabel("Data row 1 Notes", { exact: true })).toHaveValue("Preserve this note");
  expect(failures).toEqual([]);
});
