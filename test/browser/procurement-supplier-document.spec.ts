import { expect, test } from "@playwright/test";
import { buildSupplierPoDocument } from "../../server/modules/procurement/supplier-po-document";
import { renderPoHtml } from "../../server/modules/procurement/po-document";
import { supplierDocumentSource } from "../../server/modules/procurement/__tests__/fixtures/supplier-po-document.fixture";

test("saved terms render with exact pricing, public notes and usable narrow-screen scrolling", async ({ page }, testInfo) => {
  const source = supplierDocumentSource();
  source.po.vendorNotes = '<script>window.SUPPLIER_ATTACK=1</script>\nDeliver to dock 3.';
  source.lines[0].productName = "Long supplier product name requiring wrapping without truncation or hidden terms ".repeat(3);
  Object.assign(source.po, { subtotalCents: 2469, totalCents: 2469 });
  Object.assign(source.lines[0], { orderQty: 100, pricingBasis: "per_purchase_uom", purchaseUom: "Carton",
    purchaseUomQuantity: 2, piecesPerPurchaseUom: 50, quotedUnitCostMills: 123450, unitCostMills: 2469,
    unitCostCents: 25, totalProductCostCents: 2469, lineTotalCents: 2469 });
  const supplierDocument = buildSupplierPoDocument(source);
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
  await page.setContent(renderPoHtml(supplierDocument));
  await expect(page.getByRole("heading", { name: "PURCHASE ORDER", exact: true })).toBeVisible();
  await expect(page.locator(".notice")).toContainText("DRAFT");
  await expect(page.getByRole("table", { name: "Purchase order lines" })).toContainText("$12.345");
  await expect(page.getByRole("table", { name: "Purchase order lines" })).toContainText("50 pieces each");
  await expect(page.getByRole("table", { name: "Purchase order totals" })).toContainText("$24.69");
  await expect(page.locator(".notes")).toContainText("<script>window.SUPPLIER_ATTACK=1</script>");
  expect(await page.evaluate(() => Object.hasOwn(window, "SUPPLIER_ATTACK"))).toBe(false);
  expect(await page.locator("body").innerText()).not.toMatch(/PRIVATE_/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const viewport = page.viewportSize()!;
  const wrapper = page.locator(".table-wrap");
  if (viewport.width < 600) {
    expect(await wrapper.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await wrapper.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect(page.locator(".lines tbody .amount")).toBeInViewport();
    await wrapper.evaluate(element => { element.scrollLeft = 0; });
  }
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("supplier-document-screen.png"), fullPage: true });
});

test("multi-page print keeps commercial rows and total readable", async ({ page }, testInfo) => {
  const source = supplierDocumentSource();
  source.po.status = "sent";
  source.po.physicalStatus = "sent";
  source.lines = Array.from({ length: 24 }, (_, index) => ({ ...source.lines[0], id: index + 11, lineNumber: index + 1,
    productName: `Saved supplier item ${String(index + 1).padStart(2, "0")}`, description: null,
    sku: `SKU-${String(index + 1).padStart(2, "0")}`, vendorSku: `SUPPLIER-${String(index + 1).padStart(2, "0")}` }));
  source.po.subtotalCents = source.po.totalCents = 24 * 12345;
  const supplierDocument = buildSupplierPoDocument(source);
  await page.route("**/*", route => route.abort());
  await page.setContent(renderPoHtml(supplierDocument));
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".lines tbody tr")).toHaveCount(24);
  await expect(page.locator(".notice")).toContainText("CURRENT COMMERCIAL COPY");
  await expect(page.locator(".totals .total")).toContainText("$2,962.80");
  expect(await page.locator("thead").evaluate(element => getComputedStyle(element).display)).toBe("table-header-group");
  expect(await page.locator(".lines tbody tr").first().evaluate(element => getComputedStyle(element).breakInside)).toBe("avoid");
  const pdf = await page.pdf({ path: testInfo.outputPath("supplier-document-print.pdf"), format: "Letter", printBackground: true });
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  await page.screenshot({ path: testInfo.outputPath("supplier-document-print.png"), fullPage: true });
});
