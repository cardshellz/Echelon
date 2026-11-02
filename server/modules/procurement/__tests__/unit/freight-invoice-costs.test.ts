import { describe, expect, it } from "vitest";
import { planFreightInvoiceCosts, FreightInvoiceCostError, type FreightInvoiceFacts } from "../../domain/freight-invoice-costs";

function facts(): FreightInvoiceFacts {
  const allowed = { allowed: true, code: "AP_INVOICE_SOURCE_VERIFIED" as const, reason: "Explicit invoice ownership" };
  return {
    invoice: { id: 1, number: "FREIGHT-1", vendorId: 2, shipmentId: 3, currency: "USD", status: "received", amountCents: 22000, paidCents: 0, balanceCents: 22000 },
    lines: [{ id: 4, freightCostId: 5, purchaseOrderLineId: null, productVariantId: null, quantity: 1, unitMills: 2200000, amountCents: 22000 }],
    charges: [{ id: 5, shipmentId: 3, vendorId: 2, invoiceId: 1, currency: "USD", label: "Freight", estimatedCents: 20000, actualCents: null }],
    capabilities: { approval: allowed, payment: allowed, purchaseOrderLinks: { allowed: false, code: "AP_INVOICE_SHIPMENT_SOURCE_OWNED", reason: "Owned by shipment" }, freightSourceLineIds: [4] },
    hasCreditHistory: false, hasPurchaseOrderLinks: false,
  };
}
function code(value: unknown) {
  try { planFreightInvoiceCosts(value); throw new Error("Expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(FreightInvoiceCostError); return (error as FreightInvoiceCostError).code; }
}
describe("explicit freight invoice cost planning", () => {
  it("replaces the charge's estimate with its exact billed amount without mutating the evidence", () => {
    const source = facts(), before = structuredClone(source);
    expect(planFreightInvoiceCosts(source)).toEqual({ requiresChange: true, charges: [{ chargeId: 5, shipmentId: 3, label: "Freight", estimatedCents: 20000, actualCents: null, invoiceCents: 22000 }] });
    expect(source).toEqual(before);
  });
  it.each(["approved", "partially_paid", "paid"])("recognizes unchanged %s invoice costs without another approval", status => {
    const source = facts(); source.invoice.status = status; source.charges[0].actualCents = 22000;
    expect(planFreightInvoiceCosts(source).requiresChange).toBe(false);
  });
  it("conserves split invoice lines belonging to one charge", () => {
    const source = facts(); source.lines = [ { ...source.lines[0], unitMills: 1000000, amountCents: 10000 },
      { ...source.lines[0], id: 6, unitMills: 1200000, amountCents: 12000 } ];
    source.capabilities.freightSourceLineIds = [4, 6];
    expect(planFreightInvoiceCosts(source).charges[0].invoiceCents).toBe(22000);
  });
  it("accepts explicitly billed zero without replacing it with an estimate", () => {
    const source = facts(); source.invoice.amountCents = 0; source.lines[0].amountCents = 0; source.lines[0].unitMills = 0;
    expect(planFreightInvoiceCosts(source).charges[0].invoiceCents).toBe(0);
  });
  it("uses exact sub-cent AP rounding", () => {
    const source = facts(); source.invoice.amountCents = 2; source.lines[0] = { ...source.lines[0], quantity: 3, unitMills: 50, amountCents: 2 };
    expect(planFreightInvoiceCosts(source).charges[0].invoiceCents).toBe(2);
  });
  it.each(["draft", "voided", "unknown"])("does not approve an unsupported %s invoice", status => {
    const source = facts(); source.invoice.status = status; expect(code(source)).toBe("FREIGHT_INVOICE_STATUS_REVIEW");
  });
  it("rejects unallocated header amounts", () => {
    const source = facts(); source.invoice.amountCents++; expect(code(source)).toBe("FREIGHT_INVOICE_TOTAL_REVIEW");
  });
  it("rejects inconsistent extended line amounts", () => {
    const source = facts(); source.lines[0].quantity = 2; expect(code(source)).toBe("FREIGHT_INVOICE_TOTAL_REVIEW");
  });
  it("does not guess a supplier-credit disposition", () => {
    const source = facts(); source.hasCreditHistory = true; expect(code(source)).toBe("FREIGHT_INVOICE_CREDIT_REVIEW");
  });
  it("rejects manual PO billing links and mixed product lines", () => {
    const source = facts(); source.hasPurchaseOrderLinks = true; expect(code(source)).toBe("FREIGHT_INVOICE_SCOPE_REVIEW");
    source.hasPurchaseOrderLinks = false; source.lines[0].purchaseOrderLineId = 9; expect(code(source)).toBe("FREIGHT_INVOICE_SCOPE_REVIEW");
  });
  it.each(["currency", "vendorId", "shipmentId", "invoiceId"] as const)("rejects changed charge %s ownership", field => {
    const source = facts(); if (field === "currency") source.charges[0].currency = "EUR";
    else source.charges[0][field] = 99;
    expect(code(source)).toBe(field === "currency" ? "FREIGHT_INVOICE_CURRENCY_REVIEW" : "FREIGHT_INVOICE_OWNERSHIP_REVIEW");
  });
  it("keeps conflicting AP ownership blocked", () => {
    const source = facts(); source.capabilities.approval = { allowed: false, code: "AP_INVOICE_BILLING_REVIEW_REQUIRED", reason: "Competing documents" };
    expect(code(source)).toBe("FREIGHT_INVOICE_OWNERSHIP_REVIEW");
  });
  it.each([{ ids: [6] }, { ids: [4, 6] }])("rejects incomplete or extra AP source identities $ids", ({ ids }) => {
    const source = facts(); source.capabilities.freightSourceLineIds = ids;
    expect(code(source)).toBe("FREIGHT_INVOICE_OWNERSHIP_REVIEW");
  });
  it("rejects duplicated AP source identities at the evidence boundary", () => {
    const source = facts(); source.capabilities.freightSourceLineIds = [4, 4];
    expect(code(source)).toBe("FREIGHT_INVOICE_EVIDENCE_INVALID");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantity %s", quantity => {
    const source = facts(); source.lines[0].quantity = quantity; expect(code(source)).toBe("FREIGHT_INVOICE_EVIDENCE_INVALID");
  });
  it("does not round an unsafe aggregate into a valid invoice total", () => {
    const source = facts(); source.lines[0].unitMills = Number.MAX_SAFE_INTEGER; source.lines[0].quantity = Number.MAX_SAFE_INTEGER;
    expect(code(source)).toBe("FREIGHT_INVOICE_TOTAL_REVIEW");
  });
});
