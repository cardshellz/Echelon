import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po, receipt } from "./procurement-fixtures";
import type { ShipmentReceiptUnitSelection } from "../../shared/procurement/shipment-receipt-plan";

async function setup(page: Page, options: { empty?: boolean; drift?: boolean; conflict?: boolean; catalogPermission?: boolean; fromPo?: boolean; scopeChange?: boolean } = {}) {
  const failures = await installFixtures(page);
  const state = { variants: options.empty ? [] : [
    { id: 3, productId: 10, sku: "RECEIVE-CASE", name: "Case of 50", unitsPerVariant: 50 },
    { id: 4, productId: 10, sku: "RECEIVE-PACK", name: "Pack of 10", unitsPerVariant: 10 },
  ], previews: [] as ShipmentReceiptUnitSelection[][], receipts: [] as Record<string, unknown>[], configurations: [] as Record<string, unknown>[], drifted: false, scopeChanged: false };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: {
      user: { id: "receiver", username: "receiver", role: "lead" }, roles: ["Receiver"],
      permissions: ["purchasing:view", "inventory:receive", ...(options.catalogPermission === false ? [] : ["inventory:create"])],
    } });
    if (path === "/api/purchase-orders/17" && request.method() === "GET") return route.fulfill({ json: po(17) });
    if (path === "/api/purchase-orders/17/receive-options") return route.fulfill({ json: {
      shipmentOptions: [{ shipmentId: 42, shipmentNumber: "RECEIVE-SHIPMENT", purchaseOrderId: 17, status: "delivered", lineCount: 1,
        qtyShipped: 1000, receivedBaseQty: 0, remainingBaseQty: 1000, receivable: true, action: "create_receipt", freightWillCarry: true }],
      poDirect: { allowed: false, warning: "Receive against the linked shipment." },
    } });
    if (path === "/api/inbound-shipments/42" && request.method() === "GET") return route.fulfill({ json: {
      id: 42, shipmentNumber: "RECEIVE-SHIPMENT", status: "delivered", mode: "ocean", purchaseOrderId: 17, costs: [], statusHistory: [],
      lines: [{ id: 7, purchaseOrderId: 17, purchaseOrderLineId: 9, productVariantId: null, sku: "RECEIVE-SKU", productName: "Receiving product", qtyShipped: 1000, cartonCount: 2 }],
    } });
    if (path === "/api/inbound-shipments/42/receipt-pack-resolution") {
      const selections: ShipmentReceiptUnitSelection[] = request.method() === "POST" ? request.postDataJSON().receiptUnitSelections : [];
      if (options.scopeChange && selections.length && !state.scopeChanged) {
        state.scopeChanged = true;
        return route.fulfill({ status: 409, json: { error: "The receiving source scope changed", details: { code: "SHIPMENT_RECEIPT_SELECTION_SCOPE_CHANGED" } } });
      }
      if (request.method() === "POST") state.previews.push(selections);
      if (options.drift && !state.drifted && selections.length) {
        state.variants[0].unitsPerVariant = 100;
        state.drifted = true;
      }
      const selected = selections[0], variant = state.variants.find(value => value.id === selected?.productVariantId);
      const valid = !!selected && !!variant && selected.unitsPerVariant === variant.unitsPerVariant;
      return route.fulfill({ json: {
        shipmentId: 42, shipmentNumber: "RECEIVE-SHIPMENT", status: "delivered", purchaseOrderId: 17, poNumber: "TEST-PO-17",
        canCreateReceipt: valid, unresolvedCount: valid ? 0 : 1, lineCount: 1, issue: null, receiptUnitSelections: selections,
        lines: [{ shipmentLineId: 7, purchaseOrderLineId: 9, sku: "RECEIVE-SKU", productId: 10, productName: "Receiving product",
          qtyShipped: 1000, cartonCount: 2, unitsPerCarton: null, status: valid ? "resolved" : selected ? "unit_mismatch" : "selection_required", blocking: !valid,
          issue: valid ? null : selected ? "The chosen unit's pack size changed. Refresh and review its current piece count." : "Choose the configuration that arrived.",
          activeVariants: state.variants, matchedVariant: valid ? variant : null,
          receivePlan: valid ? { productVariantId: variant.id, unitsPerVariant: variant.unitsPerVariant, expectedQty: 1000 / variant.unitsPerVariant,
            countsAsPieces: variant.unitsPerVariant === 1, preferredVariantId: null, preferredUnitsPerVariant: null } : null,
        }],
      } });
    }
    if (path === "/api/products/10/variants" && request.method() === "POST") {
      const body = request.postDataJSON(); state.configurations.push(body);
      if (options.conflict && state.configurations.length === 1) return route.fulfill({ status: 409, json: { error: "SKU already exists" } });
      const variant = { id: 5, productId: 10, sku: body.sku, name: body.name, unitsPerVariant: body.unitsPerVariant };
      state.variants.push(variant);
      return route.fulfill({ json: variant });
    }
    if (path === "/api/inbound-shipments/42/create-receipt" && request.method() === "POST") {
      state.receipts.push(request.postDataJSON());
      return route.fulfill({ json: receipt(31) });
    }
    return route.fallback();
  });
  await page.goto(options.fromPo ? "/purchase-orders/17?tab=lines" : "/shipments/42?tab=lines");
  if (options.fromPo) {
    await page.getByRole("region", { name: "Purchase order actions", exact: true }).getByRole("button", { name: "Receive", exact: true }).click();
    await page.getByTestId("po-receive-option-42").getByRole("button", { name: "Receive this shipment", exact: true }).click();
  } else await page.getByRole("button", { name: "Create Receipt", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Receive shipment items", exact: true });
  await expect(dialog).toBeVisible();
  return { state, failures, dialog };
}

test("receives the operator's chosen existing product configuration and preserves carton independence", async ({ page }, testInfo) => {
  const { state, failures, dialog } = await setup(page);
  const selection = dialog.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true });
  await expect(selection).toHaveValue("");
  await selection.selectOption("4");
  await expect(dialog).toContainText("100 × 10 pieces = 1,000 pieces");
  await expect(dialog.getByRole("button", { name: "Create receipt", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Review receiving counts", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Create receipt", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("configuration-review.png"), animations: "disabled" });
  expect(state.configurations).toEqual([]);
  await dialog.getByRole("button", { name: "Create receipt", exact: true }).click();
  await expect(page).toHaveURL(/\/receiving\?open=31/);
  expect(state.receipts).toEqual([{ purchaseOrderId: 17, receiptUnitSelections: [{ shipmentLineId: 7, productVariantId: 4, unitsPerVariant: 10, expectedBaseQty: 1000 }] }]);
  expect(failures).toEqual([]);
});

test("adds the missing catalog configuration inline and uses it without losing receipt choices", async ({ page }, testInfo) => {
  const { state, failures, dialog } = await setup(page, { empty: true });
  await expect(dialog).toContainText("No active product configurations yet.");
  await dialog.getByRole("button", { name: "Add receiving configuration", exact: true }).click();
  const form = dialog.getByRole("region", { name: "New configuration for Receiving product" });
  await form.getByRole("combobox", { name: "Configuration type", exact: true }).selectOption("case");
  await form.getByLabel("Pieces in each configuration", { exact: true }).fill("100");
  await form.getByLabel("SKU", { exact: true }).fill("RECEIVE-C100");
  await form.getByLabel("Configuration name", { exact: true }).fill("Case of 100");
  await page.screenshot({ path: testInfo.outputPath("add-configuration.png"), animations: "disabled" });
  await form.getByRole("button", { name: "Save configuration and use it", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true })).toHaveValue("5");
  await expect(dialog).toContainText("10 × 100 pieces = 1,000 pieces");
  await dialog.getByRole("button", { name: "Create receipt", exact: true }).click();
  await expect(page).toHaveURL(/\/receiving\?open=31/);
  expect(state.configurations).toHaveLength(1);
  expect(state.configurations[0]).toMatchObject({ unitsPerVariant: 100, uomType: "case", hierarchyLevel: 3, isBaseUnit: false, salesEligibility: "internal_only" });
  expect(state.receipts[0]).toMatchObject({ receiptUnitSelections: [{ productVariantId: 5, unitsPerVariant: 100, expectedBaseQty: 1000 }] });
  expect(failures).toEqual([]);
});

test("keeps a failed SKU creation editable without changing stock or creating a receipt", async ({ page }) => {
  const { state, failures, dialog } = await setup(page, { empty: true, conflict: true });
  await dialog.getByRole("button", { name: "Add receiving configuration", exact: true }).click();
  const form = dialog.getByRole("region", { name: "New configuration for Receiving product" });
  await form.getByRole("combobox", { name: "Configuration type", exact: true }).selectOption("pack");
  await form.getByLabel("Pieces in each configuration", { exact: true }).fill("10");
  await form.getByLabel("SKU", { exact: true }).fill("DUPLICATE-SKU");
  await form.getByLabel("Configuration name", { exact: true }).fill("Pack of 10");
  await form.getByRole("button", { name: "Save configuration and use it", exact: true }).click();
  await expect(form.getByRole("alert")).toContainText("SKU already exists");
  await expect(form.getByLabel("Pieces in each configuration", { exact: true })).toHaveValue("10");
  expect(state.receipts).toEqual([]);
  await form.getByLabel("SKU", { exact: true }).fill("NEW-PACK-SKU");
  await form.getByRole("button", { name: "Save configuration and use it", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Create receipt", exact: true })).toBeEnabled();
  expect(state.configurations).toHaveLength(2);
  expect(failures).toEqual([]);
});

test("requires reselecting a changed catalog pack before receipt creation", async ({ page }) => {
  const { state, failures, dialog } = await setup(page, { drift: true });
  const selection = dialog.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true });
  await selection.selectOption("3");
  await dialog.getByRole("button", { name: "Review receiving counts", exact: true }).click();
  await expect(dialog).toContainText("pack size changed");
  await expect(dialog.getByRole("button", { name: "Create receipt", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Use these updated counts", exact: true }).click();
  await dialog.getByRole("button", { name: "Review receiving counts", exact: true }).click();
  await expect(dialog).toContainText("10 × 100 pieces = 1,000 pieces");
  await expect(dialog.getByRole("button", { name: "Create receipt", exact: true })).toBeEnabled();
  expect(state.previews.at(-1)?.[0].unitsPerVariant).toBe(100);
  expect(state.receipts).toEqual([]);
  expect(failures).toEqual([]);
});

test("preserves the scoped choices across reload and still requires the final receipt action", async ({ page }) => {
  const { state, failures, dialog } = await setup(page);
  await dialog.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true }).selectOption("4");
  await page.reload();
  await page.getByRole("button", { name: "Create Receipt", exact: true }).click();
  const reopened = page.getByRole("dialog", { name: "Receive shipment items", exact: true });
  await expect(reopened.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true })).toHaveValue("4");
  await expect(reopened).toContainText("100 × 10 pieces = 1,000 pieces");
  expect(state.receipts).toEqual([]);
  expect(failures).toEqual([]);
});

test("uses the same configuration approval from the PO and preserves its navigation context", async ({ page }) => {
  const { dialog, state, failures } = await setup(page, { fromPo: true });
  await dialog.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true }).selectOption("3");
  await dialog.getByRole("button", { name: "Review receiving counts", exact: true }).click();
  await expect(dialog).toContainText("20 × 50 pieces = 1,000 pieces");
  await dialog.getByRole("button", { name: "Create receipt", exact: true }).click();
  await expect(page).toHaveURL(/\/receiving\?open=31/);
  expect(new URL(page.url()).searchParams.get("purchase")).toContain("purchase:17:lines");
  expect(state.receipts[0]).toMatchObject({ purchaseOrderId: 17, receiptUnitSelections: [{ productVariantId: 3, unitsPerVariant: 50 }] });
  expect(failures).toEqual([]);
});

test("recovers an outdated saved selection with a fresh review instead of automatically creating a receipt", async ({ page }) => {
  const { state, failures, dialog } = await setup(page, { scopeChange: true });
  await dialog.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true }).selectOption("4");
  await page.reload();
  await page.getByRole("button", { name: "Create Receipt", exact: true }).click();
  const reopened = page.getByRole("dialog", { name: "Receive shipment items", exact: true });
  await expect(reopened).toContainText("Previous configuration choices were cleared");
  await expect(reopened.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true })).toHaveValue("");
  await expect(reopened.getByRole("button", { name: "Create receipt", exact: true })).toBeDisabled();
  expect(state.receipts).toEqual([]);
  expect(failures).toEqual([]);
});

test("shows configuration choices while reserving catalog creation for authorized users", async ({ page }) => {
  const { dialog, state, failures } = await setup(page, { catalogPermission: false });
  await expect(dialog.getByRole("combobox", { name: "Receive RECEIVE-SKU as", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add receiving configuration", exact: true })).toHaveCount(0);
  expect(state.configurations).toEqual([]);
  expect(failures).toEqual([]);
});
