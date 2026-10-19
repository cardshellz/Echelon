import { describe, expect, it } from "vitest";
import { resolveShipmentBillingOwnership } from "../../domain/shipment-billing-ownership";
import { shipmentCostBillingOwnershipSchema, invoiceSourceCapabilitySchema } from "@shared/procurement/shipment-billing-ownership";
const cost = { id: 31, shipmentId: 1, vendorId: 6, invoiceId: 71, currency: "USD" };
const invoice = { id: 71, shipmentId: 1, vendorId: 6, currency: "USD", status: "received", invoiceNumber: "FREIGHT-1", replacesInvoiceId: null };
const line = { id: 81, invoiceId: 71, freightCostId: 31, purchaseOrderLineId: null, productVariantId: null };
const resolve = (patch: Record<string, unknown> = {}) => shipmentCostBillingOwnershipSchema.parse(resolveShipmentBillingOwnership({ cost, invoices: [invoice], lines: [line], ...patch }));
describe("canonical shipment billing ownership", () => {
  it("allows billing only with no pointer and no source lines", () => {
    expect(resolve({ cost: { ...cost, invoiceId: null }, invoices: [], lines: [] })).toMatchObject({ state: "unbilled", canCreateInvoice: true, canLinkExistingLine: true });
  });
  it.each([null, "EUR", "usd"])("does not offer a charge with currency %s as a new USD invoice", currency => {
    expect(resolve({ cost: { ...cost, invoiceId: null, currency }, invoices: [], lines: [] })).toMatchObject({
      state: "review_required", issueCode: "AP_SHIPMENT_BILLING_CURRENCY_UNSUPPORTED", canCreateInvoice: false, canLinkExistingLine: false,
    });
  });
  it("separates a header-only association from recorded billing", () => {
    expect(resolve({ lines: [] })).toMatchObject({ state: "review_required", canCreateInvoice: false, canUnlink: false, canLinkExistingLine: true });
  });
  it.each(["draft", "received", "disputed", "approved", "partially_paid", "paid"])("recognizes one %s invoice owner without treating status as costing or payment evidence", status => {
    expect(resolve({ invoices: [{ ...invoice, status }] })).toMatchObject({ state: "billed", activeInvoiceId: 71, activeInvoiceLineIds: [81], canCreateInvoice: false, canUnlink: false });
  });
  it("retains supported multiple source lines within one invoice", () => {
    expect(resolve({ lines: [line, { ...line, id: 82 }] })).toMatchObject({ state: "billed", activeInvoiceLineId: null, activeInvoiceLineIds: [81, 82] });
  });
  it.each([null, 73])("rejects missing or mismatched pointer %s despite a source line", invoiceId => {
    expect(resolve({ cost: { ...cost, invoiceId } }).state).toBe("review_required");
  });
  it("rejects multiple active owners regardless of equal money", () => {
    expect(resolve({ invoices: [invoice, { ...invoice, id: 72 }], lines: [line, { ...line, id: 82, invoiceId: 72 }] })).toMatchObject({ state: "review_required", issueCode: "AP_SHIPMENT_BILLING_MULTIPLE_OWNERS" });
  });
  it.each([{ vendorId: 7 }, { shipmentId: 2 }, { shipmentId: null }, { currency: "EUR" }, { status: "unknown" }])("rejects inconsistent owner identity %j", patch => {
    expect(resolve({ invoices: [{ ...invoice, ...patch }] }).state).toBe("review_required");
  });
  it.each([{ purchaseOrderLineId: 11 }, { productVariantId: 200 }])("rejects mixed product/freight source %j", patch => {
    expect(resolve({ lines: [{ ...line, ...patch }] }).state).toBe("review_required");
  });
  it("retains a voided source until explicit replacement", () => {
    expect(resolve({ invoices: [{ ...invoice, status: "voided" }] })).toMatchObject({ state: "voided", activeInvoiceId: null, canCreateInvoice: false });
  });
  it("accepts the current owner plus complete voided replacement ancestry", () => {
    expect(resolve({ cost: { ...cost, invoiceId: 72 }, invoices: [{ ...invoice, status: "voided" }, { ...invoice, id: 72, replacesInvoiceId: 71 }], lines: [line, { ...line, id: 82, invoiceId: 72 }] })).toMatchObject({ state: "billed", activeInvoiceId: 72, referencedInvoiceIds: [71, 72] });
  });
  it("does not hide unrelated voided claims or missing predecessor evidence", () => {
    expect(resolve({ invoices: [invoice, { ...invoice, id: 72, status: "voided" }], lines: [line, { ...line, id: 82, invoiceId: 72 }] }).state).toBe("review_required");
    expect(resolve({ invoices: [{ ...invoice, replacesInvoiceId: 70 }] }).state).toBe("review_required");
  });
  it("rejects duplicate line identities and replacement cycles", () => {
    expect(resolve({ lines: [line, line] }).state).toBe("review_required");
    expect(resolve({ invoices: [{ ...invoice, replacesInvoiceId: 71 }] }).state).toBe("review_required");
  });
  it.each([null, {}, { cost: { ...cost, id: NaN }, invoices: [], lines: [] }])("fails closed on invalid source %j", value => {
    expect(resolveShipmentBillingOwnership(value)).toMatchObject({ state: "review_required", canCreateInvoice: false });
  });
  it("validates capability contradictions at the shared boundary", () => {
    const billed = resolve();
    expect(shipmentCostBillingOwnershipSchema.safeParse({ ...billed, canCreateInvoice: true }).success).toBe(false);
    expect(shipmentCostBillingOwnershipSchema.safeParse({ ...billed, activeInvoiceLineIds: [] }).success).toBe(false);
    expect(invoiceSourceCapabilitySchema.safeParse({ allowed: true, code: "AP_INVOICE_BILLING_REVIEW_REQUIRED", reason: "review" }).success).toBe(false);
  });
});
