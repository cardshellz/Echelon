import { describe, expect, it } from "vitest";
import { evaluateInvoiceReplacement, type InvoiceReplacementSource } from "../../domain/invoice-replacement";
import { invoiceReplacementCapabilitySchema, invoiceReplacementResultSchema } from "@shared/procurement/invoice-replacement";

const version = "a".repeat(64);
function source(): InvoiceReplacementSource {
  return { invoice: { id: 1, status: "voided", paidAmountCents: 0, inboundShipmentId: 2,
    currency: "USD", invoiceNumber: "SUPPLIER-123", invoicedAmountCents: 990, balanceCents: 990, vendorId: 3 },
  lines: [{ id: 11, freightCostId: 4, purchaseOrderLineId: null, productVariantId: null, unitCostMills: 99000,
    unitCostCents: 990, qtyInvoiced: 1, lineTotalCents: 990 }],
  costs: [{ id: 4, vendorInvoiceId: 1, vendorId: 3, inboundShipmentId: 2, currency: "USD", actualCents: 990, estimatedCents: null }],
  links: [], paymentHistory: [], successorInvoiceId: null, shipment: { status: "closed" }, shipmentPoIds: [] };
}

describe("explicit invoice replacement eligibility", () => {
  it("accepts a complete unpaid closed-shipment invoice without mutating its input", () => {
    const input = source(), before = structuredClone(input);
    expect(evaluateInvoiceReplacement(input, version)).toMatchObject({ allowed: true, code: null, expectedVersion: version });
    expect(input).toEqual(before);
  });
  it.each([0, Number.MAX_SAFE_INTEGER])("supports exact known value %s", amount => {
    const input = source();
    expect(evaluateInvoiceReplacement({ ...input, invoice: { ...input.invoice, invoicedAmountCents: amount, balanceCents: amount },
      lines: [{ ...input.lines[0], unitCostMills: null, unitCostCents: amount, lineTotalCents: amount }],
      costs: [{ ...input.costs[0], actualCents: amount }] }, version).allowed).toBe(true);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])("rejects invalid quantity %s", qtyInvoiced => {
    const input = source();
    expect(evaluateInvoiceReplacement({ ...input, lines: [{ ...input.lines[0], qtyInvoiced }] }, version))
      .toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_TOTAL_REVIEW" });
  });
  it.each([-1, 0.1, Number.MAX_SAFE_INTEGER + 1, NaN])("rejects invalid or signed line value %s", lineTotalCents => {
    const input = source();
    expect(evaluateInvoiceReplacement({ ...input, lines: [{ ...input.lines[0], lineTotalCents }] }, version).allowed).toBe(false);
  });
  it("preserves distinct split lines for one charge without changing their recorded amounts", () => {
    const input = source();
    const split = { ...input, lines: [
      { ...input.lines[0], unitCostMills: 40000, unitCostCents: 400, lineTotalCents: 400 },
      { ...input.lines[0], id: 12, unitCostMills: 59000, unitCostCents: 590, lineTotalCents: 590 },
    ] };
    const before = structuredClone(split);
    expect(evaluateInvoiceReplacement(split, version)).toMatchObject({ allowed: true, code: null });
    expect(split).toEqual(before);
  });
  it.each([-1, 1])("rejects a split charge whose sum differs by %s even when the invoice total matches", difference => {
    const input = source(), amount = 590 + difference;
    expect(evaluateInvoiceReplacement({ ...input,
      invoice: { ...input.invoice, invoicedAmountCents: 990 + difference, balanceCents: 990 + difference },
      lines: [{ ...input.lines[0], unitCostMills: 40000, unitCostCents: 400, lineTotalCents: 400 },
        { ...input.lines[0], id: 12, unitCostMills: amount * 100, unitCostCents: amount, lineTotalCents: amount }],
    }, version)).toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_TOTAL_REVIEW" });
  });
  it("rejects duplicate charge records even when source lines and invoice totals reconcile", () => {
    const input = source();
    expect(evaluateInvoiceReplacement({ ...input, costs: [...input.costs, ...input.costs] }, version))
      .toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_SOURCE_REVIEW" });
  });
  it("rejects repeated evidence for the same line instead of counting it twice", () => {
    const input = source();
    const half = { ...input.lines[0], unitCostMills: 49500, unitCostCents: 495, lineTotalCents: 495 };
    expect(evaluateInvoiceReplacement({ ...input, lines: [half, half] }, version))
      .toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_SOURCE_REVIEW" });
  });
  it("does not offset an overstated charge against an understated different charge", () => {
    const input = source();
    expect(evaluateInvoiceReplacement({ ...input,
      invoice: { ...input.invoice, invoicedAmountCents: 1000, balanceCents: 1000 },
      costs: [...input.costs, { ...input.costs[0], id: 5, actualCents: 10 }],
      lines: [{ ...input.lines[0], unitCostMills: 99100, unitCostCents: 991, lineTotalCents: 991 },
        { ...input.lines[0], id: 12, freightCostId: 5, unitCostMills: 900, unitCostCents: 9, lineTotalCents: 9 }],
    }, version)).toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_TOTAL_REVIEW" });
  });
  it("rejects a duplicate charge source, unmapped lines, missing charges and product mixtures", () => {
    const input = source();
    for (const changed of [
      { ...input, lines: [...input.lines, ...input.lines] },
      { ...input, lines: [{ ...input.lines[0], freightCostId: null }] },
      { ...input, lines: [{ ...input.lines[0], productVariantId: 1 }] },
      { ...input, costs: [] },
    ]) expect(evaluateInvoiceReplacement(changed, version)).toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_SOURCE_REVIEW" });
  });
  it("rejects every payment history entry even when the header has zero paid amount", () => {
    expect(evaluateInvoiceReplacement({ ...source(), paymentHistory: [{ id: 9 }] }, version))
      .toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_PAYMENT_HISTORY" });
  });
  it("rejects unmatched PO links and excessive or invalid allocated values", () => {
    for (const allocatedAmountCents of [991, -1, Number.NaN]) {
      expect(evaluateInvoiceReplacement({ ...source(), shipmentPoIds: [10], links: [{ purchaseOrderId: 10, allocatedAmountCents }] }, version))
        .toMatchObject({ allowed: false, code: "AP_INVOICE_REPLACEMENT_PO_LINK_REVIEW" });
    }
    expect(evaluateInvoiceReplacement({ ...source(), links: [{ purchaseOrderId: 10, allocatedAmountCents: null }] }, version).allowed).toBe(false);
  });
  it("rejects inconsistent outbound capabilities, self-successors and duplicate charge assignments", () => {
    expect(invoiceReplacementCapabilitySchema.safeParse({ allowed: true, code: "BLOCKED", message: "Blocked", expectedVersion: version, successorInvoiceId: null }).success).toBe(false);
    for (const input of [{ invoiceId: 1, replacesInvoiceId: 1, freightCostIds: [4] }, { invoiceId: 2, replacesInvoiceId: 1, freightCostIds: [4, 4] }]) {
      expect(invoiceReplacementResultSchema.safeParse({ ...input, invoiceNumber: "SUPPLIER-123", status: "received" }).success).toBe(false);
    }
  });
});
