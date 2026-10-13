import { expect, test } from "@playwright/test";
import { buildSupplierPoDocument } from "../../server/modules/procurement/supplier-po-document";
import { renderPoHtml } from "../../server/modules/procurement/po-document";
import { supplierDocumentSource } from "../../server/modules/procurement/__tests__/fixtures/supplier-po-document.fixture";
import { installFixtures, po } from "./procurement-fixtures";

test("supplier document failure is actionable, disables delivery actions, and can retry without stale content", async ({ page }, testInfo) => {
  const failures = await installFixtures(page);
  const purchase = po(17);
  await page.route("**/api/purchase-orders/17/workspace", route => route.fulfill({ json: {
    purchase: { ...purchase, currency: "USD", vendorName: "Test vendor", invoicedTotalCents: 0, paidTotalCents: 0,
      outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null },
    shipments: [], receipts: [], invoices: [], edges: [], limitations: [],
  } }));
  const source = supplierDocumentSource();
  Object.assign(source.po, { id: 17, poNumber: "TEST-PO-17", status: "acknowledged", physicalStatus: "acknowledged" });
  source.lines[0].purchaseOrderId = 17;
  const document = buildSupplierPoDocument(source);
  const error = "Recorded PO amounts do not reconcile. Review the saved amounts before producing a supplier document.";
  let requests = 0;
  await page.route("**/api/purchase-orders/17/document", route => {
    requests += 1;
    return route.fulfill(requests === 2
      ? { json: { html: renderPoHtml(document) } }
      : { status: 409, json: { code: "SUPPLIER_DOCUMENT_TOTAL_MISMATCH", error } });
  });
  await page.goto("/purchase-orders/17");
  await page.getByRole("button", { name: "View / Print", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Purchase Order — TEST-PO-17" });
  await expect(dialog.getByRole("alert")).toContainText(error);
  await expect(dialog.getByRole("button", { name: "Print", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Email to Vendor", exact: true })).toBeDisabled();
  await expect(dialog.locator("iframe")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("supplier-document-retry.png"), fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "Retry document", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.frameLocator("iframe").getByRole("table", { name: "Purchase order totals" })).toContainText("$123.45");
  await expect(dialog.getByRole("button", { name: "Print", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Email to Vendor", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "View / Print", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(error);
  await expect(dialog.locator("iframe")).toHaveCount(0);
  expect(requests).toBe(3);
  expect(failures).toEqual([]);
});
