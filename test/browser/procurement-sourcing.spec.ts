import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_SUPPLIER_SOURCING_POLICY, supplierSourcingUpdateSchema, type SupplierSourcingRecord } from "../../shared/procurement/supplier-sourcing";
import { installFixtures } from "./procurement-fixtures";

async function setup(page: Page, canEdit = true) {
  const failures = await installFixtures(page);
  const writes: unknown[] = [];
  let record: SupplierSourcingRecord = { vendorProductId: 1, revision: 0, policy: DEFAULT_SUPPLIER_SOURCING_POLICY, recordedBy: null, recordedAt: null, reason: null };
  const records: SupplierSourcingRecord[] = [];
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "sourcing-operator", username: "test", role: "admin" }, permissions: canEdit ? ["purchasing:edit", "inventory:view"] : ["inventory:view"], roles: ["admin"] } }));
  await page.route("**/api/vendors", (route) => route.fulfill({ json: [{ id: 1, code: "SYNTHETIC", name: "Synthetic sourcing vendor", active: 1, currency: "USD", defaultLeadTimeDays: 120, minimumOrderCents: 0 }] }));
  await page.route("**/api/products", (route) => route.fulfill({ json: [{ id: 10, sku: "SOURCE-TEST", baseSku: "SOURCE-TEST", name: "Fictional source product" }] }));
  await page.route("**/api/vendors/1/products", (route) => route.fulfill({ json: [{ id: 1, vendorId: 1, productId: 10, productVariantId: null, vendorSku: "SOURCE-TEST", vendorProductName: "Fictional source product", pricingBasis: "legacy_unknown", unitCostMills: null, unitCostCents: null, isPreferred: 1, isActive: 1, packSize: 50, moq: 50 }] }));
  await page.route("**/api/vendor-products/1/sourcing", async (route) => {
    if (route.request().method() === "PUT") {
      const input = supplierSourcingUpdateSchema.parse(route.request().postDataJSON());
      writes.push(input);
      record = { vendorProductId: 1, revision: record.revision + 1, policy: input.policy, recordedBy: "sourcing-operator", recordedAt: "2026-09-07T12:00:00Z", reason: input.reason };
      records.unshift(record);
    }
    return route.fulfill({ json: record });
  });
  await page.route("**/api/vendor-products/1/sourcing/history*", (route) => route.fulfill({ json: { records, nextBeforeRevision: null } }));
  await page.goto("/suppliers");
  await page.getByText("Synthetic sourcing vendor", { exact: true }).filter({ visible: true }).click();
  await page.getByRole("button", { name: "Sourcing settings for SOURCE-TEST" }).filter({ visible: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  return { failures, writes };
}

test("supplier price tiers save exact quoted units and retain revision history", async ({ page }, testInfo) => {
  const { failures, writes } = await setup(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Sourcing priority").fill("5");
  await dialog.getByLabel("Use a quoted quantity price list").check();
  await dialog.getByLabel("Price and threshold unit").selectOption("per_purchase_uom");
  await dialog.getByLabel("Purchase unit name", { exact: true }).fill("case");
  await dialog.getByLabel("Pieces per purchase unit").fill("50");
  await dialog.getByLabel("Quote reference").fill("SYNTHETIC-QUOTE-REV1");
  await dialog.getByLabel("Quote date", { exact: true }).fill("2026-09-01");
  await dialog.getByLabel("Valid from").fill("2026-09-01");
  await dialog.getByLabel("Valid through").fill("2026-10-31");
  await dialog.getByLabel("Price per unit (USD)").fill("100.0001");
  await dialog.getByRole("button", { name: "Add price tier" }).click();
  await dialog.getByLabel("From quantity 2").fill("10");
  await dialog.getByLabel("Price per unit (USD)").nth(1).fill("90.0001");
  await dialog.getByLabel("Reason for change").fill("Confirmed synthetic supplier quantity quote");
  await dialog.getByRole("button", { name: "Save sourcing revision" }).click();
  await expect(dialog).toContainText("Revision 1.");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ expectedRevision: 0, policy: { priority: 5, priceList: { currency: "USD", basis: "per_purchase_uom", piecesPerPurchaseUom: 50, tiers: [{ minimumQuantity: 1, unitCostMills: 1_000_001 }, { minimumQuantity: 10, unitCostMills: 900_001 }] } } });
  await dialog.getByRole("button", { name: "View sourcing history" }).click();
  await expect(dialog).toContainText("Confirmed synthetic supplier quantity quote");
  await expect(dialog).toContainText("100.0001 per unit");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("supplier-quantity-pricing.png"), fullPage: true });
  expect(failures).toEqual([]);
});

test("invalid priority is rejected before any network mutation", async ({ page }) => {
  const { failures, writes } = await setup(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Sourcing priority").fill("-1");
  await dialog.getByLabel("Reason for change").fill("Synthetic validation check");
  await dialog.getByRole("button", { name: "Save sourcing revision" }).click();
  await expect(dialog.getByRole("alert")).toContainText("priority");
  expect(writes).toEqual([]); expect(failures).toEqual([]);
});

test("view-only operators can inspect sourcing without saving changes", async ({ page }) => {
  const { failures, writes } = await setup(page, false);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Sourcing priority")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save sourcing revision" })).toHaveCount(0);
  expect(writes).toEqual([]); expect(failures).toEqual([]);
});
