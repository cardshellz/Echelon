import { invoiceSourceFixture, unbilledOwnershipFixture } from "../fixtures/invoice-source";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";
import { invoiceListItem, paymentListItem, workListPage } from "./procurement-ap-work-list-fixtures";

async function setup(page: Page) {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "ap-reader", username: "ap-reader", role: "admin" }, permissions: ["purchasing:view", "purchasing:create", "purchasing:edit", "purchasing:approve"], roles: ["admin"] } }));
  await page.route("**/api/vendors", route => route.fulfill({ json: [{ id: 2, name: "Older supplier" }, { id: 3, name: "Large supplier" }] }));
  return failures;
}
for (const kind of ["invoices", "payments"] as const) {
  test(`${kind} uses complete server pages, counts and search and resets the page on search`, async ({ page }) => {
    const failures = await setup(page); const requests: URLSearchParams[] = []; let changed = false;
    const items = Array.from({ length: 225 }, (_, index) => kind === "invoices" ? invoiceListItem({ id: index + 1, invoiceNumber: `INV-${index + 1}` }) : paymentListItem({ id: index + 1, paymentNumber: `PAY-${index + 1}` }));
    await page.route(`**/api/${kind === "invoices" ? "vendor-invoices" : "ap-payments"}/work-list?*`, route => {
      const params = new URL(route.request().url()).searchParams; requests.push(params);
      const search = params.get("search");
      const filtered = search ? items.filter(row => ("invoiceNumber" in row ? row.invoiceNumber : row.paymentNumber) === search) : items.map((row, index) => changed && index === 0 ? { ...row, ...("invoiceNumber" in row ? { invoiceNumber: "UPDATED-1" } : { paymentNumber: "UPDATED-1" }) } : row);
      return route.fulfill({ json: workListPage(filtered, route.request().url()) });
    });
    await page.goto(`/ap-${kind}`);
    const navigation = page.getByRole("navigation", { name: `${kind} pages` });
    await expect(navigation).toContainText(`1–50 of 225 ${kind}`);
    await navigation.getByRole("button", { name: "Next", exact: true }).click();
    await expect(navigation).toContainText(`51–100 of 225 ${kind}`);
    await page.getByPlaceholder(`Search ${kind}...`).fill(kind === "invoices" ? "INV-225" : "PAY-225");
    await expect(navigation).toContainText(`1–1 of 1 ${kind}`);
    expect(requests.at(-1)?.get("offset")).toBe("0");
    await expect(page.getByText(kind === "invoices" ? "INV-225" : "PAY-225", { exact: true })).toBeVisible();
    changed = true;
    await page.getByPlaceholder(`Search ${kind}...`).fill("");
    await expect(page.getByText("UPDATED-1", { exact: true })).toBeVisible();
    expect(failures).toEqual([]);
  });
  test(`${kind} reports failed or malformed responses as unavailable and allows retry`, async ({ page }) => {
    const failures = await setup(page); let broken = true;
    await page.route(`**/api/${kind === "invoices" ? "vendor-invoices" : "ap-payments"}/work-list?*`, route => route.fulfill({ json: broken ? { items: [], total: 200 } : workListPage([], route.request().url()) }));
    await page.goto(`/ap-${kind}`);
    await expect(page.getByRole("alert").filter({ hasText: `Unable to load ${kind}` })).toBeVisible();
    await expect(page.getByText(kind === "invoices" ? "No invoices found" : "No payments recorded yet", { exact: true })).toHaveCount(0);
    broken = false; await page.getByRole("button", { name: `Retry ${kind}`, exact: true }).click();
    await expect(page.getByRole("navigation", { name: `${kind} pages` })).toContainText(`0 of 0 ${kind}`);
    expect(failures).toEqual([]);
  });
}

test("payment selection scopes the vendor before paging, preserves page allocations and refreshes after record and void", async ({ page }) => {
  const failures = await setup(page); let paid = false; let recorded = false; const requests: URLSearchParams[] = []; let body: any;
  const invoices = () => Array.from({ length: 25 }, (_, index) => invoiceListItem({ id: index + 201, invoiceNumber: `OLD-${index + 201}`, status: "approved", balanceCents: paid ? 5000 : 10000 }));
  await page.route("**/api/vendor-invoices/work-list?*", route => {
    const params = new URL(route.request().url()).searchParams; requests.push(params);
    return route.fulfill({ json: workListPage(params.get("vendorId") === "2" ? invoices() : [], route.request().url()) });
  });
  await page.route("**/api/ap-payments/work-list?*", route => route.fulfill({ json: workListPage(recorded ? [paymentListItem({ id: 90, paymentNumber: "PAY-90", status: paid ? "completed" : "voided" })] : [], route.request().url()) }));
  await page.route("**/api/ap-payments", route => { body = route.request().postDataJSON(); paid = true; recorded = true; return route.fulfill({ json: { id: 90 } }); });
  await page.route("**/api/ap-payments/90/void", route => { paid = false; return route.fulfill({ json: { ok: true } }); });
  await page.goto("/ap-payments"); await page.getByRole("button", { name: "Record Payment", exact: true }).click();
  let dialog = page.getByRole("dialog"); await dialog.getByRole("combobox", { name: "Payment vendor" }).selectOption("2");
  await expect(dialog.getByText("#OLD-201", { exact: true })).toBeVisible();
  await dialog.getByRole("spinbutton", { name: "Apply to invoice OLD-201" }).fill("25.00");
  await dialog.getByRole("navigation", { name: "vendor invoices pages" }).getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "Apply to invoice OLD-225" }).fill("25.00");
  await dialog.getByPlaceholder("0.00", { exact: true }).first().fill("50.00");
  await dialog.getByRole("button", { name: "Record Payment", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(body.allocations).toEqual([{ vendorInvoiceId: 201, appliedAmountCents: 2500 }, { vendorInvoiceId: 225, appliedAmountCents: 2500 }]);
  await page.getByRole("button", { name: "Record Payment", exact: true }).click(); dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Payment vendor" }).selectOption("2");
  await expect(dialog.getByText("Balance: $50.00", { exact: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Void payment PAY-90", exact: true }).click();
  await page.getByPlaceholder("Void reason...").fill("Test reversal"); await page.getByRole("button", { name: "Void Payment", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Record Payment", exact: true }).click(); dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Balance: $100.00", { exact: true }).first()).toBeVisible();
  expect(requests.every(params => params.get("vendorId") === "2")).toBe(true); expect(failures).toEqual([]);
});

test("new invoice PO selection can search beyond the former 100 cap and retains the selection across pages", async ({ page }) => {
  const failures = await setup(page); const requests: URLSearchParams[] = [];
  await page.route("**/api/vendor-invoices/next-number", route => route.fulfill({ json: { invoiceNumber: "NEW-INVOICE" } }));
  await page.route("**/api/purchase-orders/work-list?*", route => {
    const params = new URL(route.request().url()).searchParams; requests.push(params);
    const all = Array.from({ length: 125 }, (_, index) => ({ id: index + 1, poNumber: `PO-${index + 1}`, vendorId: 2, status: "received", totalCents: 10000 }));
    return route.fulfill({ json: workListPage(params.get("search") ? all.filter(po => po.poNumber === params.get("search")) : all, route.request().url()) });
  });
  await page.goto("/ap-invoices"); await page.getByRole("button", { name: "New Invoice" }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("combobox").selectOption("2");
  await dialog.getByRole("textbox", { name: "Search purchase orders" }).fill("PO-125");
  await dialog.getByRole("button", { name: "PO-125 $100.00 · received", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Search purchase orders" }).fill("");
  await expect(dialog.getByText("Selected: PO-125", { exact: false })).toBeVisible();
  expect(requests.every(params => params.get("purpose") === "invoice-create" && params.get("vendorId") === "2")).toBe(true);
  expect(failures).toEqual([]);
});


test("shipment invoice creation refreshes an already mounted AP work list", async ({ page }) => {
  const failures = await setup(page); let created = false; let reads = 0;
  await page.route("**/api/vendor-invoices/work-list?*", route => { reads += 1; return route.fulfill({ json: workListPage(created ? [invoiceListItem({ id: 500, invoiceNumber: "FROM-SHIPMENT", status: "received" })] : [], route.request().url()) }); });
  await page.route("**/api/inbound-shipments/42/cost-vendors", route => route.fulfill({ json: { vendors: [{ vendorId: 2, vendorName: "Older supplier", unbilledCostCount: 1, unbilledTotalCents: 10000 }] } }));
  await page.route("**/api/inbound-shipments/42/cost-vendors/2/costs", route => route.fulfill({ json: { costs: [{ billingOwnership: unbilledOwnershipFixture(), inboundShipmentId: 42, vendorId: 2, id: 1, costType: "freight", description: "Freight", performedByName: null, actualCents: 10000, estimatedCents: null }] } }));
  await page.route("**/api/inbound-shipments/42/create-invoice", route => { created = true; return route.fulfill({ json: { id: 500, invoiceId: 500, shipmentId: 42, inboundShipmentId: 42, vendorId: 2, invoiceNumber: "FROM-SHIPMENT", actorId: "ap-reader", idempotencyKey: route.request().headers()["idempotency-key"], costRowIds: [1], totalCents: 10000, currency: "USD" } }); });
  await page.route("**/__ap-work-list-refresh", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/ap-work-list-refresh-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto("/__ap-work-list-refresh");
  await expect(page.getByText("No invoices found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create shipment invoice", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByText("Older supplier", { exact: true }).click();
  await dialog.getByPlaceholder("Vendor's invoice number").fill("FROM-SHIPMENT");
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(page.getByText("FROM-SHIPMENT", { exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(1); expect(failures).toEqual([]);
});


test("invoice PO linking searches beyond 100 without losing linked exclusions or hiding closed POs", async ({ page }) => {
  const failures = await setup(page); const requests: URLSearchParams[] = [];
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: { sourceCapabilities: invoiceSourceFixture(), id: 71, vendorId: 2, invoiceNumber: "LINK-INVOICE", vendorName: "Older supplier", status: "received", currency: "USD", invoicedAmountCents: 10000, balanceCents: 10000, paidAmountCents: 0, lines: [], attachments: [], payments: [], poLinks: [{ id: 1, purchaseOrderId: 17, poNumber: "PO-17" }], capabilities: { edit: { allowed: true, code: "AP_INVOICE_EDITABLE", requiredPermission: "purchasing:edit", reason: "This invoice can be edited." } } } }));
  await page.route("**/api/purchase-orders/work-list?*", route => {
    const params = new URL(route.request().url()).searchParams; requests.push(params);
    return route.fulfill({ json: workListPage(params.get("search") === "PO-125" ? [{ id: 125, poNumber: "PO-125", vendorId: 2, status: "closed", totalCents: 10000 }] : [], route.request().url()) });
  });
  await page.goto("/ap-invoices/71"); await page.getByRole("button", { name: "Link PO", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("textbox", { name: "Search purchase orders" }).fill("PO-125");
  await dialog.getByRole("button", { name: "PO-125 $100.00 · closed", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Link & Import Lines", exact: true })).toBeEnabled();
  expect(requests.every(params => params.get("purpose") === "invoice-link" && params.get("excludeIds") === "17")).toBe(true); expect(failures).toEqual([]);
});
