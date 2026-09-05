import type { Page } from "@playwright/test";

// Deliberately fictional documents. Empty receiving list proves detail loading
// is independent of list pagination/filtering. Mutations fail every test.
export const po = (id: number) => ({ id, poNumber: `TEST-PO-${id}`, status: "acknowledged", physicalStatus: "acknowledged", financialStatus: "unpaid", vendorId: 2, vendor: { name: "Test vendor" }, lines: [], subtotalCents: 10000, totalCents: 10000 });
const shipment = { id: 42, shipmentNumber: "TEST-SHIP-42", status: "booked", mode: "sea_fcl", purchaseOrderId: 17, lines: [{ id: 1, purchaseOrderId: 99, purchaseOrderLineId: 1, sku: "TEST-SKU", productName: "Test product", qtyShipped: 10, cartonCount: 1 }], costs: [{ id: 1, costType: "freight", description: "Test freight", estimatedCents: 10000, actualCents: 10000, linkedInvoice: { id: 71, invoiceNumber: "TEST-INV-71", status: "paid" } }], statusHistory: [] };
const invoice = { id: 71, invoiceNumber: "TEST-INV-71", vendorId: 2, vendorName: "Test vendor", inboundShipmentId: 42, shipmentNumber: "TEST-SHIP-42", status: "paid", invoicedAmountCents: 10000, balanceCents: 0, paidAmountCents: 10000, lines: [], poLinks: [{ id: 1, purchaseOrderId: 99, poNumber: "TEST-PO-99" }], attachments: [], payments: [] };
export const receipt = (id: number) => ({ id, receiptNumber: `TEST-RECEIPT-${id}`, createdAt: "2026-09-01T12:00:00Z", status: "closed", purchaseOrderId: 99, inboundShipmentId: 42, lines: [], vendorId: 2, vendorName: "Test vendor" });

export async function installFixtures(page: Page) {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      failures.push(`Unexpected mutation: ${request.method()} ${request.url()}`);
      return route.abort();
    }
    const path = new URL(request.url()).pathname;
    let json: unknown = [];
    if (path === "/api/auth/me") json = { user: { id: "test-user", username: "test", role: "admin" }, permissions: [], roles: ["admin"] };
    else if (path === "/api/settings/procurement") json = { useNewPoEditor: true };
    else if (/^\/api\/purchase-orders\/(17|99)$/.test(path)) json = po(Number(path.split("/").at(-1)));
    else if (/\/purchase-orders\/\d+\/shipments$/.test(path)) json = [shipment];
    else if (/\/purchase-orders\/\d+\/receipts$/.test(path)) json = { receipts: [{ id: 1, receivingOrderId: 31, purchaseOrderLineId: 1, qtyReceived: 10 }] };
    else if (/\/purchase-orders\/\d+\/invoices$/.test(path)) json = { invoices: [invoice] };
    else if (/\/purchase-orders\/\d+\/exceptions$/.test(path)) json = { exceptions: [] };
    else if (/\/purchase-orders\/\d+\/history$/.test(path)) json = { history: [] };
    else if (path === "/api/purchase-orders") json = { purchaseOrders: [] };
    else if (path === "/api/inbound-shipments/42") json = shipment;
    else if (path === "/api/inbound-shipments/42/allocation-status") json = { issues: [], costs: [], status: "allocated", blockerCount: 0, warningCount: 0, lineCount: 1, allocatableCostCount: 1, effectiveCostCents: 10000, unallocatedCents: 0 };
    else if (path === "/api/inbound-shipments/42/invoices") json = { invoices: [invoice], summary: { invoiceCount: 1 } };
    else if (path === "/api/vendor-invoices/71") json = invoice;
    else if (/^\/api\/receiving\/\d+$/.test(path)) json = receipt(Number(path.split("/").at(-1)));
    else if (path.endsWith("/validation-warnings")) json = { warnings: [] };
    else if (path.endsWith("/reversals")) json = { reversals: [] };
    await route.fulfill({ json });
  });
  return failures;
}
