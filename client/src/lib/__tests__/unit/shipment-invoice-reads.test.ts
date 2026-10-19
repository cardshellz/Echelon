import { describe, expect, it } from "vitest";
import { parseShipmentInvoiceCosts, parseShipmentInvoices, shipmentInvoiceVendorsSchema } from "../../shipment-invoice-reads";
const ownership = { state: "unbilled", activeInvoiceId: null, activeInvoiceLineId: null, activeInvoiceLineIds: [], referencedInvoiceIds: [], issueCode: null, message: "Ready to invoice", canCreateInvoice: true, canUnlink: false, canLinkExistingLine: true };
const cost = { id: 9, inboundShipmentId: 42, vendorId: 2, costType: "freight", description: null, performedByName: null, actualCents: null, estimatedCents: 10000, billingOwnership: ownership };
const invoice = { id: 71, inboundShipmentId: 42, invoiceNumber: "FREIGHT-71", vendorName: "Carrier", status: "received", currency: "USD", invoiceDate: "2026-10-19T00:00:00.000Z", invoicedAmountCents: 10000, paidAmountCents: 0 };
const summary = { totalInvoicedCents: 10000, totalPaidCents: 0, outstandingCents: 10000, invoiceCount: 1, activeInvoiceCount: 1 };
describe("shipment invoice read contracts", () => {
  it("accepts verified charges and complete invoice read", () => {
    expect(parseShipmentInvoiceCosts({ costs: [cost] }, 42, 2).costs).toEqual([cost]);
    expect(parseShipmentInvoices({ invoices: [invoice], summary }, 42).invoices).toEqual([invoice]);
  });
  it.each([{ ...cost, inboundShipmentId: 43 }, { ...cost, vendorId: 3 }, { ...cost, billingOwnership: {} }, { ...cost, actualCents: 0.1 }, { ...cost, estimatedCents: null }])("rejects unverified charge %j", invalid => expect(() => parseShipmentInvoiceCosts({ costs: [invalid] }, 42, 2)).toThrow());
  it("rejects duplicate charge identities", () => expect(() => parseShipmentInvoiceCosts({ costs: [cost, cost] }, 42, 2)).toThrow());
  it.each([{}, { invoices: [], summary }, { invoices: [{ ...invoice, inboundShipmentId: 43 }], summary }, { invoices: [{ ...invoice, paidAmountCents: NaN }], summary }, { invoices: [{ ...invoice, invoiceDate: "yesterday" }], summary }])("does not interpret malformed invoice evidence as empty %j", raw => expect(() => parseShipmentInvoices(raw, 42)).toThrow());
  it.each(["draft", "received", "approved", "partially_paid", "paid", "disputed", "voided"])("accepts existing invoice status %s", status => {
    expect(parseShipmentInvoices({ invoices: [{ ...invoice, status }], summary: { ...summary, activeInvoiceCount: status === "voided" ? 0 : 1 } }, 42).invoices[0].status).toBe(status);
  });
  it("accepts verified empty read", () => expect(parseShipmentInvoices({ invoices: [], summary: { totalInvoicedCents: 0, totalPaidCents: 0, outstandingCents: 0, invoiceCount: 0, activeInvoiceCount: 0 } }, 42).invoices).toEqual([]));
  it("rejects duplicate supplier rows and malformed totals", () => {
    const vendor = { vendorId: 2, vendorName: "Carrier", unbilledCostCount: 1, unbilledTotalCents: 100 };
    expect(shipmentInvoiceVendorsSchema.safeParse({ vendors: [vendor, vendor] }).success).toBe(false);
    expect(shipmentInvoiceVendorsSchema.safeParse({ vendors: [{ ...vendor, unbilledTotalCents: 0.29 }] }).success).toBe(false);
  });
});
