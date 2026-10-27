import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po, receipt } from "./procurement-fixtures";
import { reviewReceivingConfiguration } from "../../shared/procurement/receiving-configuration";
import type { ShipmentEditorContext, ShipmentEditorPreview, ShipmentEditorRequest } from "../../shared/procurement/shipment-editor";

const sourceVersion = "a".repeat(64), previewVersion = "b".repeat(64);
async function setup(page: Page, options: { noCatalogPermission?: boolean; unavailable?: boolean } = {}) {
  const failures = await installFixtures(page);
  const state = { status: "draft", variantId: null as number | null, factor: null as number | null,
    variants: [] as { id: number; sku: string; name: string; unitsPerVariant: number }[],
    creations: [] as any[], configurations: [] as any[], approvals: [] as any[], transitions: [] as string[], receipts: [] as any[], unavailable: !!options.unavailable };
  const units = () => ({ productId: 10, selectedVariantId: state.variantId, unitsPerVariantSnapshot: state.factor, variants: state.variants, issue: null });
  const line = (): ShipmentEditorContext["lines"][number] => ({ key: "line:7", id: 7, sku: "ITEM", name: "Fixture product",
    purchaseOrderId: 17, purchaseOrderLineId: 9, poNumber: "TEST-PO-17", shipmentUnits: units(),
    fields: { qtyShipped: 1000, cartonCount: 2, dimensionBasis: "carton", weightKg: "1.000", lengthCm: "10.00", widthCm: "10.00", heightCm: "10.00", notes: null },
    allocatedCostCents: 500, totalWeightKg: "2.000", totalVolumeCbm: "0.002000" });
  let preview: ShipmentEditorPreview;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: {
      user: { id: "test-user", username: "admin", role: "admin" }, roles: ["Administrator"],
      permissions: ["purchasing:view", "purchasing:create", "purchasing:edit", "purchasing:approve", "inventory:receive",
        ...(options.noCatalogPermission ? [] : ["inventory:create"])],
    } });
    if (path === "/api/vendors") return route.fulfill({ json: [{ id: 2, name: "Test vendor", code: "TEST" }] });
    if (path === "/api/purchase-orders/17") return route.fulfill({ json: { ...po(17), lines: [{ id: 9, purchaseOrderId: 17, productId: 10,
      lineNumber: 1, lineType: "product", sku: "ITEM", productName: "Fixture product", orderQty: 1000, receivedQty: 0, unitCostCents: 10, subtotalCents: 10000 }] } });
    if (path === "/api/purchase-orders/17/shippable-lines") return route.fulfill({ json: { lines: [{ id: 9, purchaseOrderId: 17,
      productName: "Fixture product", description: null, sku: "ITEM", orderQty: 1000, alreadyShippedQty: 0, directReceivedQty: 0, remainingQty: 1000, shipmentUnits: units() }], reviewRequiredLines: [] } });
    if (path === "/api/products/10/variants" && request.method() === "POST") {
      const body = request.postDataJSON(); state.configurations.push(body);
      const variant = { id: 5, sku: body.sku, name: body.name, unitsPerVariant: body.unitsPerVariant }; state.variants.push(variant);
      return route.fulfill({ json: { ...variant, productId: 10 } });
    }
    if (path === "/api/inbound-shipments" && request.method() === "POST") {
      const body = request.postDataJSON(); state.creations.push(body);
      const selected = body.purchaseOrder?.lineSelections[0]?.unitSelection;
      state.variantId = selected?.productVariantId ?? null; state.factor = selected?.unitsPerVariant ?? null;
      return route.fulfill({ status: 201, json: { id: 42, shipmentNumber: "SETUP-SHIPMENT", status: "draft", lineCount: 1,
        createdBy: "test-user", createdAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-20T12:00:00Z" } });
    }
    if (path === "/api/inbound-shipments/42") return route.fulfill({ json: { id: 42, shipmentNumber: "SETUP-SHIPMENT", status: state.status,
      mode: "air", purchaseOrderId: 17, costs: [], statusHistory: [],
      lines: [{ ...line().fields, id: 7, inboundShipmentId: 42, purchaseOrderId: 17, purchaseOrderLineId: 9,
        productVariantId: state.variantId, unitsPerVariantSnapshot: state.factor, sku: "ITEM", productName: "Fixture product", shipmentUnits: units() }] } });
    if (path === "/api/inbound-shipments/42/receiving-setup") {
      if (state.unavailable) return route.fulfill({ status: 503, json: { error: "Setup temporarily unavailable" } });
      const review = reviewReceivingConfiguration({ pieces: 1000, variantId: state.variantId, recordedUnits: state.factor, activeVariants: state.variants });
      return route.fulfill({ json: { shipmentId: 42, ready: review.ready, issueCount: review.issue ? 1 : 0,
        lines: [{ lineId: 7, purchaseOrderId: 17, sku: "ITEM", name: "Fixture product", pieces: 1000, units: units(), count: review.count, issue: review.issue }] } });
    }
    if (["book", "in-transit", "delivered"].some(action => path === `/api/inbound-shipments/42/${action}`)) {
      const action = path.split("/").at(-1)!; state.transitions.push(action);
      state.status = action === "book" ? "booked" : action === "in-transit" ? "in_transit" : "delivered";
      return route.fulfill({ json: { id: 42, status: state.status } });
    }
    if (path === "/api/inbound-shipments/42/editor" && request.method() === "GET") return route.fulfill({ json: {
      shipmentId: 42, shipmentNumber: "SETUP-SHIPMENT", status: state.status, sourceVersion, canApprove: true, blockedReason: null,
      lines: [line()], charges: [{ currency: "USD", cents: 500 }], receipts: [],
    } });
    if (path === "/api/inbound-shipments/42/editor/preview") {
      const body = request.postDataJSON() as ShipmentEditorRequest;
      const before = line(), selection = body.changes[0].unitSelection!;
      const current = state.variants.find(variant => variant.id === selection.productVariantId);
      if (!current || current.unitsPerVariant !== selection.unitsPerVariant) return route.fulfill({ status: 409,
        json: { code: "SHIPMENT_RECEIVING_SETUP_REQUIRED", error: "Receiving setup changed. Review its configuration." } });
      preview = { previewVersion, review: { shipmentId: 42, sourceVersion, reason: body.reason, before: [before],
        after: [{ ...before, shipmentUnits: { ...units(), selectedVariantId: selection.productVariantId, unitsPerVariantSnapshot: selection.unitsPerVariant } }],
        charges: [{ currency: "USD", cents: 500 }], costShares: [{ purchaseOrderId: 17, poNumber: "TEST-PO-17", beforeCents: 500, afterCents: 500 }] } };
      return route.fulfill({ json: preview });
    }
    if (path === "/api/inbound-shipments/42/editor" && request.method() === "POST") {
      const body = request.postDataJSON(); state.approvals.push(body);
      state.variantId = body.changes[0].unitSelection.productVariantId; state.factor = body.changes[0].unitSelection.unitsPerVariant;
      return route.fulfill({ json: { auditId: 100, actorName: "Fixture admin", approvedAt: "2026-10-20T12:00:00Z", preview } });
    }
    if (path === "/api/inbound-shipments/42/receipt-pack-resolution") return route.fulfill({ json: {
      shipmentId: 42, shipmentNumber: "SETUP-SHIPMENT", status: "delivered", purchaseOrderId: 17, poNumber: "TEST-PO-17",
      canCreateReceipt: true, unresolvedCount: 0, lineCount: 1, issue: null,
      lines: [{ shipmentLineId: 7, purchaseOrderLineId: 9, sku: "ITEM", productId: 10, productName: "Fixture product", qtyShipped: 1000,
        cartonCount: 2, unitsPerCarton: null, status: "resolved", blocking: false, issue: null, activeVariants: state.variants,
        matchedVariant: state.variants[0], receivePlan: { productVariantId: state.variantId, unitsPerVariant: state.factor,
          expectedQty: 1000 / state.factor!, countsAsPieces: false, preferredVariantId: state.variantId, preferredUnitsPerVariant: state.factor } }],
    } });
    if (path === "/api/inbound-shipments/42/create-receipt") { state.receipts.push(request.postDataJSON()); return route.fulfill({ json: receipt(31) }); }
    return route.fallback();
  });
  return { state, failures };
}

async function addConfiguration(page: Page) {
  await page.getByRole("button", { name: "Add receiving configuration", exact: true }).click();
  const form = page.getByRole("region", { name: /New configuration for/ });
  await form.getByRole("combobox", { name: "Configuration type", exact: true }).selectOption("case");
  await form.getByLabel("Pieces in each configuration", { exact: true }).fill("100");
  await form.getByLabel("SKU", { exact: true }).fill("SETUP-CASE-100");
  await form.getByLabel("Configuration name", { exact: true }).fill("Case of one hundred");
  await form.getByRole("button", { name: "Save configuration and use it", exact: true }).click();
  await expect(form).toHaveCount(0);
}

test("adds a receiving configuration during PO shipment creation and carries it through booking, departure and receiving", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.goto("/purchase-orders/17?tab=shipments");
  await page.getByRole("button", { name: "Create Shipment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Inbound Shipment", exact: true });
  await expect(dialog.getByText(/You can save an incomplete draft/)).toBeVisible();
  await addConfiguration(page);
  await expect(dialog.getByText(/Receiving configuration ready/)).toBeVisible();
  await dialog.getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SETUP-SHIPMENT", exact: true })).toBeVisible();
  expect(state.creations[0].purchaseOrder.lineSelections[0]).toMatchObject({ qty: 1000, unitSelection: { productVariantId: 5, unitsPerVariant: 100, quantity: 10 } });
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Mark In Transit", exact: true }).click();
  await page.getByRole("button", { name: "Delivered", exact: true }).click();
  await page.getByRole("button", { name: "Create Receipt", exact: true }).click();
  await expect.poll(() => state.receipts.length).toBe(1);
  expect(state.transitions).toEqual(["book", "in-transit", "delivered"]);
  expect(state.configurations[0]).toMatchObject({ unitsPerVariant: 100, salesEligibility: "internal_only" });
  expect(failures).toEqual([]);
});

test("keeps an incomplete draft and repairs its receiving setup with one reviewed admin approval", async ({ page }, testInfo) => {
  const { state, failures } = await setup(page);
  await page.goto("/shipments/42?tab=lines");
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Set up receiving", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit shipment", exact: true });
  await dialog.getByText("Receiving configuration", { exact: true }).click();
  await addConfiguration(page);
  await dialog.getByLabel("Reason / document reference", { exact: true }).fill("Verified case contents against the supplier packing list");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("row", { name: /Receiving configuration.*Not recorded.*SETUP-CASE-100/ })).toBeVisible();
  await expect(dialog.getByRole("row", { name: "Pieces 1,000 1,000", exact: true })).toBeVisible();
  await dialog.screenshot({ path: testInfo.outputPath("configuration-approval.png") });
  await dialog.getByLabel("I reviewed the line changes and cost shares.", { exact: true }).check();
  await dialog.getByRole("button", { name: "Approve & save shipment", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Approved by Fixture admin");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toBeEnabled();
  expect(state.approvals).toHaveLength(1); expect(state.approvals[0].changes[0].fields).toEqual({});
  expect(state.approvals[0].changes[0].unitSelection).toEqual({ productVariantId: 5, unitsPerVariant: 100, quantity: 10 });
  expect(failures).toEqual([]);
});

test("keeps booking unavailable when receiving setup cannot be read and provides a direct retry", async ({ page }) => {
  const { state, failures } = await setup(page, { unavailable: true });
  await page.goto("/shipments/42");
  await expect(page.getByRole("region", { name: "Shipment receiving setup", exact: true })).toContainText("Receiving setup could not be verified");
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  state.unavailable = false;
  await page.getByRole("button", { name: "Retry receiving setup", exact: true }).click();
  await expect(page.getByRole("button", { name: "Set up receiving", exact: true })).toBeVisible();
  expect(state.transitions).toEqual([]); expect(failures).toEqual([]);
});

test("reserves inline catalog creation for permitted operators while keeping the draft inspectable", async ({ page }) => {
  const { state, failures } = await setup(page, { noCatalogPermission: true });
  await page.goto("/shipments/42");
  await page.getByRole("button", { name: "Set up receiving", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit shipment", exact: true });
  await dialog.getByText("Receiving configuration", { exact: true }).click();
  await expect(dialog.getByText("A catalog editor needs to add this product's receiving configuration.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add receiving configuration", exact: true })).toHaveCount(0);
  expect(state.configurations).toEqual([]); expect(state.approvals).toEqual([]); expect(failures).toEqual([]);
});

test("saves a shipment draft with missing receiving setup and prevents booking it", async ({ page }) => {
  const { state, failures } = await setup(page);
  await page.goto("/purchase-orders/17?tab=shipments");
  await page.getByRole("button", { name: "Create Shipment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create Inbound Shipment", exact: true });
  await expect(dialog.getByText(/You can save an incomplete draft/)).toBeVisible();
  await dialog.getByRole("button", { name: "Create Shipment", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SETUP-SHIPMENT", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Set up receiving", exact: true })).toBeVisible();
  expect(state.creations[0].purchaseOrder.lineSelections[0]).toEqual({ poLineId: 9, qty: 1000 });
  expect(state.configurations).toEqual([]); expect(state.transitions).toEqual([]); expect(failures).toEqual([]);
});

test("rechecks a changed catalog configuration before allowing departure", async ({ page }) => {
  const { state, failures } = await setup(page);
  state.status = "booked"; state.variantId = 5; state.factor = 100;
  state.variants.push({ id: 5, sku: "SETUP-CASE-100", name: "Case of one hundred", unitsPerVariant: 100 });
  await page.goto("/shipments/42");
  await expect(page.getByRole("button", { name: "Mark In Transit", exact: true })).toBeEnabled();
  state.variants[0].unitsPerVariant = 200;
  await page.reload();
  await expect(page.getByRole("button", { name: "Mark In Transit", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Shipment receiving setup", exact: true })).toContainText("piece count changed");
  await expect(page.getByRole("button", { name: "Set up receiving", exact: true })).toBeVisible();
  expect(state.transitions).toEqual([]); expect(failures).toEqual([]);
});

test("repairs a catalog change in the same editor without discarding quantities or the review reason", async ({ page }) => {
  const { state, failures } = await setup(page);
  state.status = "booked"; state.variantId = 5; state.factor = 100;
  state.variants.push({ id: 5, sku: "SETUP-CASE-100", name: "Case of one hundred", unitsPerVariant: 100 });
  await page.goto("/shipments/42");
  await page.getByRole("button", { name: "Edit shipment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit shipment", exact: true });
  await dialog.getByText("Receiving configuration", { exact: true }).click();
  const select = dialog.getByRole("combobox", { name: "Count unit shipment-setup-7", exact: true });
  await select.selectOption(""); await select.selectOption("5");
  await dialog.getByLabel("Reason / document reference", { exact: true }).fill("Verified the supplier's revised case configuration");
  state.variants[0].unitsPerVariant = 200;
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Receiving setup changed");
  await expect(dialog.getByLabel("Pieces 7", { exact: true })).toHaveValue("1000");
  await dialog.getByRole("button", { name: "Refresh configurations", exact: true }).click();
  await dialog.getByRole("button", { name: "Use current pack size", exact: true }).click();
  await expect(dialog.getByLabel("Reason / document reference", { exact: true })).toHaveValue("Verified the supplier's revised case configuration");
  await dialog.getByRole("button", { name: "Review changes", exact: true }).click();
  await dialog.getByLabel("I reviewed the line changes and cost shares.", { exact: true }).check();
  await dialog.getByRole("button", { name: "Approve & save shipment", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Approved by Fixture admin");
  expect(state.approvals[0].changes[0]).toEqual({ lineId: 7, fields: {}, unitSelection: { productVariantId: 5, unitsPerVariant: 200, quantity: 5 } });
  expect(failures).toEqual([]);
});
