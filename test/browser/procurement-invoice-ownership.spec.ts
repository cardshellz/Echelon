import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFixtures, po } from "./procurement-fixtures";
import { invoiceSourceFixture, unbilledOwnershipFixture } from "../fixtures/invoice-source";
import { financialWorkflowFixture } from "../fixtures/po-financial-workflow";

const emptyInvoices = { invoices: [], summary: { totalInvoicedCents: 0, totalPaidCents: 0, outstandingCents: 0, invoiceCount: 0, activeInvoiceCount: 0 } };
async function shipmentSetup(page: Page, options: { lose?: boolean; malformed?: boolean; reject?: boolean; vendorsFail?: boolean; costsFail?: boolean; invoicesFail?: boolean } = {}) {
  const failures = await installFixtures(page);
  const state = { committed: false, lose: options.lose ?? false, malformed: options.malformed ?? false, reject: options.reject ?? false, actor: "freight-operator", canEdit: true, vendorsFail: options.vendorsFail ?? false, costsFail: options.costsFail ?? false, invoicesFail: options.invoicesFail ?? false, commands: [] as Array<{ key: string; body: any }> };
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: state.actor, username: state.actor, role: "admin" }, permissions: ["purchasing:view", ...(state.canEdit ? ["purchasing:edit", "purchasing:create", "purchasing:approve"] : [])], roles: ["admin"] } }));
  await page.route("**/api/inbound-shipments/42", route => route.fulfill({ json: {
    id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "sea_fcl", lines: [], statusHistory: [],
    costs: [{ id: 9, costType: "freight", vendorId: 2, vendorName: "Carrier", description: "Shipment freight", estimatedCents: 10000, actualCents: null,
      vendorInvoiceId: state.committed ? 71 : null, derivedStatus: state.committed ? "invoiced" : "unbilled",
      billingOwnership: state.committed ? { ...unbilledOwnershipFixture(), state: "billed", activeInvoiceId: 71, activeInvoiceLineId: 51, activeInvoiceLineIds: [51], referencedInvoiceIds: [71], canCreateInvoice: false, canLinkExistingLine: false } : unbilledOwnershipFixture(),
    }],
  } }));
  await page.route("**/api/inbound-shipments/42/invoices", route => route.fulfill(state.invoicesFail ? { status: 503, json: { error: "Invoice read unavailable" } } : { json: emptyInvoices }));
  await page.route("**/api/inbound-shipments/42/cost-vendors", route => route.fulfill(state.vendorsFail ? { status: 503, json: { error: "Unavailable" } } : { json: { vendors: state.committed ? [] : [{ vendorId: 2, vendorName: "Carrier", unbilledCostCount: 1, unbilledTotalCents: 10000 }] } }));
  await page.route("**/api/inbound-shipments/42/cost-vendors/2/costs", route => route.fulfill({ json: state.costsFail ? { costs: [{}] } : { costs: state.committed ? [] : [{ id: 9, inboundShipmentId: 42, vendorId: 2, costType: "freight", description: "Shipment freight", performedByName: null, actualCents: null, estimatedCents: 10000, billingOwnership: unbilledOwnershipFixture() }] } }));
  await page.route("**/api/inbound-shipments/42/create-invoice", async route => {
    const body = route.request().postDataJSON(); const key = route.request().headers()["idempotency-key"];
    state.commands.push({ key, body });
    if (state.reject) return route.fulfill({ status: 409, json: { code: "AP_SHIPMENT_COST_ALREADY_BILLED", error: "The charge now belongs to an invoice. Reload its ownership.", commandOutcome: "rejected", shipmentId: 42, actorId: state.actor, idempotencyKey: key } });
    state.committed = true;
    if (state.lose) return route.abort();
    return route.fulfill({ json: state.malformed ? { id: 71 } : { id: 71, invoiceId: 71, shipmentId: 42, inboundShipmentId: 42, vendorId: 2, invoiceNumber: body.invoiceNumber, actorId: state.actor, idempotencyKey: key, costRowIds: [9], totalCents: body.lineOverrides?.[0]?.unitCostCents ?? 10000, currency: "USD" } });
  });
  await page.goto("/shipments/42?tab=costs");
  return { state, failures };
}
async function prepareInvoice(page: Page) {
  await page.getByRole("button", { name: "Add Invoice", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /^Carrier / }).click();
  await dialog.getByLabel("Invoice Number *", { exact: true }).fill("FREIGHT-71");
  await dialog.getByLabel("Invoice amount for charge 9", { exact: true }).fill("0.29");
  return dialog;
}
test("creates one freight bill from verified ownership with an exact cent override", async ({ page }, info) => {
  const { state, failures } = await shipmentSetup(page); const dialog = await prepareInvoice(page);
  await page.screenshot({ path: info.outputPath("freight-invoice-review.png"), fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open invoice FREIGHT-71", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open invoice FREIGHT-71", exact: true })).toHaveAttribute("href", /via=shipment%3A42%3Acosts/);
  expect(state.commands).toHaveLength(1); expect(state.commands[0].body.costRowIds).toEqual([9]); expect(state.commands[0].body.lineOverrides[0].unitCostCents).toBe(29);
  await page.screenshot({ path: info.outputPath("freight-invoice-created.png"), fullPage: true, animations: "disabled" }); expect(failures).toEqual([]);
});
test("an unchanged reviewed amount is part of the saved command", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page); const dialog = await prepareInvoice(page);
  await dialog.getByLabel("Invoice amount for charge 9", { exact: true }).fill("100.00");
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open invoice FREIGHT-71", exact: true })).toBeVisible();
  expect(state.commands[0].body.lineOverrides).toEqual([{ freightCostId: 9, qtyInvoiced: 1, unitCostCents: 10000, description: "Shipment freight" }]);
  expect(failures).toEqual([]);
});
for (const outcome of ["lost", "malformed"] as const) test(`${outcome} response recovers the saved invoice after reload even when charges are now billed`, async ({ page }, info) => {
  const { state, failures } = await shipmentSetup(page, outcome === "lost" ? { lose: true } : { malformed: true }); const dialog = await prepareInvoice(page);
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Retry saved invoice", exact: true })).toBeEnabled();
  expect(state.commands).toHaveLength(1);
  await page.reload(); await expect(page.getByRole("button", { name: "Add Invoice", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review pending shipment invoice", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("FREIGHT-71"); await page.screenshot({ path: info.outputPath(`freight-${outcome}-recovery.png`), fullPage: true, animations: "disabled" });
  state.lose = false; state.malformed = false;
  await page.getByRole("button", { name: "Retry saved invoice", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open invoice FREIGHT-71", exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(2); expect(state.commands[1]).toEqual(state.commands[0]); expect(failures).toEqual([]);
});
test("a matching durable stale-source rejection requires a source reload before a new request", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page, { reject: true }); const dialog = await prepareInvoice(page);
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(dialog.getByText("The charge now belongs to an invoice. Reload its ownership.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create Invoice", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Reload invoice sources", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Create Invoice", exact: true })).toBeEnabled(); expect(state.commands).toHaveLength(1); expect(failures).toEqual([]);
});
for (const source of ["vendors", "costs"] as const) test(`${source} read failure is unavailable and can be retried`, async ({ page }) => {
  const { state, failures } = await shipmentSetup(page, source === "vendors" ? { vendorsFail: true } : { costsFail: true });
  await page.getByRole("button", { name: "Add Invoice", exact: true }).click(); const dialog = page.getByRole("dialog");
  if (source === "costs") await dialog.getByRole("button", { name: /^Carrier / }).click();
  await expect(dialog.getByRole("alert")).toContainText(source === "vendors" ? "Invoice suppliers could not be loaded" : "Supplier charges could not be verified");
  await expect(dialog.getByText("No verified unbilled charges with a supplier are available.", { exact: false })).toHaveCount(0);
  state.vendorsFail = false; state.costsFail = false;
  await dialog.getByRole("button", { name: source === "vendors" ? "Retry invoice suppliers" : "Retry supplier charges", exact: true }).click();
  await expect(source === "vendors" ? dialog.getByRole("button", { name: /^Carrier / }) : dialog.getByLabel("Invoice Number *", { exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(0); expect(failures).toEqual([]);
});
test("a failed shipment invoice read does not claim no invoices or zero debt", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page, { invoicesFail: true });
  await page.getByRole("tab", { name: /^Invoices/ }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Shipment invoices could not be loaded" })).toBeVisible();
  await expect(page.getByText("No invoices linked to this shipment yet.", { exact: true })).toHaveCount(0);
  state.invoicesFail = false; await page.getByRole("button", { name: "Reload shipment invoices", exact: true }).click();
  await expect(page.getByText("No invoices linked to this shipment yet.", { exact: true })).toBeVisible(); expect(failures).toEqual([]);
});
test("permission loss preserves the original request without allowing a new dispatch", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page, { lose: true }); const dialog = await prepareInvoice(page);
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click(); await expect(dialog.getByRole("button", { name: "Retry saved invoice", exact: true })).toBeEnabled();
  state.canEdit = false; await page.reload(); await page.getByRole("button", { name: "Review pending shipment invoice", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry saved invoice", exact: true })).toBeDisabled(); expect(state.commands).toHaveLength(1); expect(failures).toEqual([]);
});
test("another operator cannot see or retry the prior operator's invoice request", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page, { lose: true }); const dialog = await prepareInvoice(page);
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click(); await expect(dialog.getByRole("button", { name: "Retry saved invoice", exact: true })).toBeEnabled();
  state.actor = "other-operator"; await page.reload(); await expect(page.getByRole("button", { name: "Review pending shipment invoice", exact: true })).toHaveCount(0); expect(state.commands).toHaveLength(1); expect(failures).toEqual([]);
});

for (const kind of ["ordinary", "shipment", "review", "malformed"] as const) test(`invoice ${kind} ownership controls PO links and financial actions`, async ({ page }) => {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "source-reviewer", username: "source-reviewer", role: "admin" }, roles: ["admin"], permissions: ["purchasing:view", "purchasing:edit", "purchasing:approve"] } }));
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: {
    id: 71, invoiceNumber: "SOURCE-71", vendorId: 2, vendorName: "Carrier", status: "received", currency: "USD", invoicedAmountCents: 10000, hasSupplierCreditHistory: false, creditedAmountCents: 0, paidAmountCents: 0, balanceCents: 10000, lines: [], attachments: [], payments: [], poLinks: [{ id: 1, purchaseOrderId: 17, poNumber: "PO-17" }],
    capabilities: { edit: { allowed: true, requiredPermission: "purchasing:edit", code: "AP_INVOICE_EDITABLE", reason: "This invoice is editable." } }, sourceCapabilities: kind === "malformed" ? {} : invoiceSourceFixture(kind),
  } }));
  await page.goto("/ap-invoices/71");
  await expect(page.getByRole("button", { name: "Link PO", exact: true })).toHaveCount(kind === "ordinary" ? 1 : 0);
  await expect(page.getByRole("button", { name: "Unlink PO PO-17", exact: true })).toHaveCount(kind === "ordinary" ? 1 : 0);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(kind === "ordinary" || kind === "shipment" ? 1 : 0);
  if (kind === "shipment") await expect(page.getByText("Shipment charge invoices cannot import or remove purchase order lines.", { exact: true })).toBeVisible();
  if (kind === "review" || kind === "malformed") await expect(page.getByRole("button", { name: "Reload invoice ownership", exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});

test("PO list uses canonical financial states and server filter despite conflicting legacy paid cache", async ({ page }) => {
  const failures = await installFixtures(page); const requests: URLSearchParams[] = [];
  await page.route("**/api/purchase-orders?*", route => { const params = new URL(route.request().url()).searchParams; requests.push(params); return route.fulfill({ json: { total: 1, purchaseOrders: [{ ...po(17), createdAt: "2026-10-19T00:00:00.000Z", financialStatus: "paid", financialWorkflow: financialWorkflowFixture(17, "review_required") }] } }); });
  await page.goto("/purchase-orders");
  await expect(page.getByText("Review required", { exact: true }).filter({ visible: true })).toHaveCount(2);
  await page.getByRole("button", { name: "Financial: Review required", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.get("financial_workflow")).toBe("review_required"); expect(requests.at(-1)?.has("financial_status")).toBe(false);
  await expect(page.getByText("Financial evidence unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Linked invoices:/)).toHaveCount(0); expect(failures).toEqual([]);
});
test("PO list malformed workflow and read failures do not display cached settlement", async ({ page }) => {
  const failures = await installFixtures(page); let failed = false;
  await page.route("**/api/purchase-orders?*", route => route.fulfill(failed ? { status: 503, json: { error: "Unavailable" } } : { json: { total: 1, purchaseOrders: [{ ...po(17), createdAt: "2026-10-19T00:00:00.000Z", financialStatus: "paid", financialWorkflow: {} }] } }));
  await page.goto("/purchase-orders"); await expect(page.getByText("Financial evidence unavailable", { exact: true }).filter({ visible: true })).toBeVisible();
  failed = true; await page.getByRole("button", { name: "Financial: Settled", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Purchase orders and financial evidence could not be loaded" })).toBeVisible();
  await expect(page.getByText("No purchase orders found.", { exact: true })).toHaveCount(0); expect(failures).toEqual([]);
});

for (const source of ["freight-id", "capability-id", "unverified"] as const) test(`invoice source line deletion is blocked by ${source} evidence`, async ({ page }) => {
  const failures = await installFixtures(page);
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "source-reviewer", username: "source-reviewer", role: "admin" }, roles: ["admin"], permissions: ["purchasing:view", "purchasing:edit", "purchasing:approve"] } }));
  const commands: string[] = [];
  const line = { id: 51, lineNumber: 1, qtyInvoiced: 1, unitCostCents: 10000, unitCostMills: 1000000, lineTotalCents: 10000, productName: "Freight source", matchStatus: "pending", freightCostId: source === "freight-id" ? 9 : null };
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: {
    id: 71, invoiceNumber: "SOURCE-71", vendorId: 2, vendorName: "Carrier", status: "received", currency: "USD", invoicedAmountCents: 10100, hasSupplierCreditHistory: false, creditedAmountCents: 0, paidAmountCents: 0, balanceCents: 10100,
    lines: [line, { ...line, id: 52, lineNumber: 2, productName: "Manual fee", freightCostId: null, unitCostCents: 100, lineTotalCents: 100 }], poLinks: [], attachments: [], payments: [],
    capabilities: { edit: { allowed: true, requiredPermission: "purchasing:edit", code: "AP_INVOICE_EDITABLE", reason: "This invoice is editable." } },
    sourceCapabilities: source === "unverified" ? {} : invoiceSourceFixture(source === "freight-id" ? "ordinary" : "shipment"),
  } }));
  await page.route("**/api/vendor-invoice-lines/*", route => { commands.push(route.request().method()); return route.fulfill({ json: {} }); });
  await page.goto("/ap-invoices/71");
  await expect(page.getByRole("button", { name: "Remove invoice line 1", exact: true })).toBeDisabled();
  const manualRemoval = page.getByRole("button", { name: "Remove invoice line 2", exact: true });
  if (source === "unverified") await expect(manualRemoval).toBeDisabled();
  else {
    await expect(manualRemoval).toBeEnabled();
    await expect(page.getByText("Shipment source retained. Review voiding and replacing the invoice to correct its source.", { exact: true })).toBeVisible();
  }
  expect(commands).toEqual([]); expect(failures).toEqual([]);
});

test("ambiguous shipment ownership stays visible for invoice review while billing totals are unavailable", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page);
  await page.route("**/api/inbound-shipments/42", route => route.fulfill({ json: {
    id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "sea_fcl", lines: [], statusHistory: [], paymentStatus: null,
    costs: [{ id: 9, costType: "freight", vendorId: 2, vendorName: "Carrier", description: "Shipment freight", estimatedCents: 10000, actualCents: null,
      vendorInvoiceId: 71, derivedStatus: "review_required", billingOwnership: { ...unbilledOwnershipFixture(), state: "review_required", referencedInvoiceIds: [71, 72], canCreateInvoice: false, canLinkExistingLine: false, issueCode: "AP_SHIPMENT_BILLING_CONFLICT", message: "Two invoices claim this charge. Review its source lines." } }],
  } }));
  await page.reload();
  await expect(page.getByText("TEST-SHIP-42", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Shipment billing totals are unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review invoice #71", exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Review invoice #72", exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Invoice", exact: true })).toHaveCount(0);
  await expect(page.getByText(/^Outstanding:/)).toHaveCount(0); expect(state.commands).toHaveLength(0); expect(failures).toEqual([]);
});

test("unbilled charges without a supplier do not offer invoice creation", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page);
  await page.route("**/api/inbound-shipments/42", route => route.fulfill({ json: {
    id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "sea_fcl", lines: [], statusHistory: [],
    costs: [{ id: 9, costType: "freight", vendorId: null, vendorName: null, description: "Shipment freight", estimatedCents: 10000, actualCents: null, billingOwnership: unbilledOwnershipFixture() }],
  } }));
  await page.reload(); await expect(page.getByText("Unbilled", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Invoice", exact: true })).toHaveCount(0); expect(state.commands).toHaveLength(0); expect(failures).toEqual([]);
});

test("negative invoice amounts are explained before any command is saved or sent", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page); const dialog = await prepareInvoice(page);
  await dialog.getByLabel("Invoice amount for charge 9", { exact: true }).fill("-0.01");
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Shipment invoice amounts cannot be negative");
  expect(state.commands).toHaveLength(0); expect(failures).toEqual([]);
});

test("valid draft shipment invoices remain visible with their financial summary", async ({ page }) => {
  const { failures } = await shipmentSetup(page);
  await page.route("**/api/inbound-shipments/42/invoices", route => route.fulfill({ json: {
    invoices: [{ id: 71, inboundShipmentId: 42, invoiceNumber: "DRAFT-71", vendorName: "Carrier", status: "draft", currency: "USD", invoiceDate: null, invoicedAmountCents: 10000, hasSupplierCreditHistory: false, creditedAmountCents: 0, paidAmountCents: 0 }],
    summary: { totalInvoicedCents: 10000, totalPaidCents: 0, outstandingCents: 10000, invoiceCount: 1, activeInvoiceCount: 1 },
  } }));
  await page.reload(); await page.getByRole("tab", { name: /^Invoices/ }).click();
  await expect(page.getByRole("cell", { name: "DRAFT-71", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "draft", exact: true })).toBeVisible();
  await expect(page.getByText("Total Invoiced:", { exact: false })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Shipment invoices could not be loaded" })).toHaveCount(0); expect(failures).toEqual([]);
});

async function ownershipRefreshHarness(page: Page, screen: "shipment" | "invoice") {
  await page.route("**/__invoice-ownership-refresh?*", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1" /><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/@fs/${resolve("test/browser/fixtures/invoice-ownership-refresh-harness.tsx").replaceAll("\\", "/")}"></script></body></html>` }));
  await page.goto(`/__invoice-ownership-refresh?screen=${screen}`);
}

test("a failed shipment refresh hides cached billing authority until successful reload", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page); let unavailable = false;
  await page.route("**/api/inbound-shipments/42", route => route.fulfill(unavailable ? { status: 503, json: { error: "Read unavailable" } } : { json: {
    id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "sea_fcl", lines: [], statusHistory: [],
    paymentStatus: { summary: { totalCents: 10000, linkedCents: 0, paidCents: 0, outstandingCents: 10000 } },
    costs: [{ id: 9, costType: "freight", vendorId: 2, vendorName: "Carrier", description: "Shipment freight", estimatedCents: 10000, actualCents: null, billingOwnership: unbilledOwnershipFixture() }],
  } }));
  await ownershipRefreshHarness(page, "shipment");
  await expect(page.getByRole("button", { name: "Add Invoice", exact: true })).toBeVisible(); await expect(page.getByText(/^Outstanding:/)).toBeVisible();
  unavailable = true; await page.evaluate(() => window.dispatchEvent(new Event("invoice-ownership-test-refresh-record")));
  await expect(page.getByRole("alert").filter({ hasText: "Shipment ownership could not be refreshed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Invoice", exact: true })).toHaveCount(0); await expect(page.getByText(/^Outstanding:/)).toHaveCount(0);
  await expect(page.getByText("Invoice ownership unavailable", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  unavailable = false; await page.getByRole("button", { name: "Reload shipment ownership", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add Invoice", exact: true })).toBeVisible(); expect(state.commands).toHaveLength(0); expect(failures).toEqual([]);
});

test("a pending invoice remains recoverable when the main shipment refresh fails", async ({ page }) => {
  const { state, failures } = await shipmentSetup(page, { lose: true }); const dialog = await prepareInvoice(page);
  await page.route("**/api/inbound-shipments/42", route => route.fulfill({ status: 503, json: { error: "Read unavailable" } }));
  await dialog.getByRole("button", { name: "Create Invoice", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Retry saved invoice", exact: true })).toBeEnabled();
  state.lose = false; await dialog.getByRole("button", { name: "Retry saved invoice", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open invoice FREIGHT-71", exact: true })).toBeVisible();
  expect(state.commands).toHaveLength(2); expect(state.commands[1]).toEqual(state.commands[0]); expect(failures).toEqual([]);
});

test("revoked approval permission disables an already open payment dialog", async ({ page }) => {
  const failures = await installFixtures(page); let allowed = true; const payments: unknown[] = [];
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "source-reviewer", username: "source-reviewer", role: "admin" }, roles: ["admin"], permissions: ["purchasing:view", "purchasing:edit", ...(allowed ? ["purchasing:approve"] : [])] } }));
  await page.route("**/api/vendor-invoices/71", route => route.fulfill({ json: {
    id: 71, invoiceNumber: "SOURCE-71", vendorId: 2, vendorName: "Carrier", status: "approved", currency: "USD", invoicedAmountCents: 10000, hasSupplierCreditHistory: false, creditedAmountCents: 0, paidAmountCents: 0, balanceCents: 10000, lines: [], poLinks: [], attachments: [], payments: [], sourceCapabilities: invoiceSourceFixture("shipment"),
  } }));
  await page.route("**/api/vendor-payments", route => { payments.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
  await ownershipRefreshHarness(page, "invoice"); await page.getByRole("button", { name: "Record Payment", exact: true }).first().click();
  const dialog = page.getByRole("dialog"); await dialog.locator('input[type="number"]').fill("10.00");
  await expect(dialog.getByRole("button", { name: "Record Payment", exact: true })).toBeEnabled();
  allowed = false; await page.evaluate(() => window.dispatchEvent(new Event("invoice-ownership-test-refresh-auth")));
  await expect(dialog.getByRole("button", { name: "Record Payment", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("Payment recording is unavailable"); expect(payments).toEqual([]); expect(failures).toEqual([]);
});
