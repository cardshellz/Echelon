import { describe, expect, it } from "vitest";
import { resolveShipmentChargeEvidence } from "../../domain/shipment-charge-evidence";

const finalized = { id: 31, shipmentId: 1, vendorId: 6, invoiceId: null, costType: "freight",
  allocationMethod: "by_weight", currency: "USD", actualCents: "33000", estimatedCents: "22000", status: "finalized" };
const invoiced = { ...finalized, invoiceId: 71, status: "invoiced" };
const line = { id: 72, invoiceId: 71, freightCostId: 31, vendorId: 6, shipmentId: 1, currency: "USD",
  status: "approved", invoiceTotalCents: "33000", documentLinesTotalCents: "33000",
  quantity: 1, unitCostMills: "3300000", unitCostCents: "33000", lineTotalCents: "33000" };

describe("shipment charge confirmation across the AP lifecycle", () => {
  it("retains finalized source authority before invoicing and carries that immutable proof into pending AP", () => {
    const initial = resolveShipmentChargeEvidence({ charge: finalized, invoices: [], priorConfirmedCharge: null });
    expect(initial.evidence).toBe("confirmed");
    const pending = resolveShipmentChargeEvidence({ charge: invoiced, invoices: [{ ...line, status: "received" }],
      priorConfirmedCharge: initial.confirmedCharge });
    expect(pending).toMatchObject({ evidence: "confirmed", issue: null, approvedInvoiceLineIds: [] });
    expect(pending.confirmedCharge).toEqual(initial.confirmedCharge);
    expect(resolveShipmentChargeEvidence({ charge: invoiced, invoices: [{ ...line, status: "received" }],
      priorConfirmedCharge: pending.confirmedCharge })).toEqual(pending);
  });

  it.each(["approved", "partially_paid", "paid"])("accepts exact %s invoice authority even when the charge started as an estimate", (status) => {
    const result = resolveShipmentChargeEvidence({ charge: { ...invoiced, actualCents: null, estimatedCents: "33000" },
      invoices: [{ ...line, status }], priorConfirmedCharge: null });
    expect(result).toEqual({ evidence: "confirmed", issue: null, confirmedCharge: null, approvedInvoiceLineIds: [72] });
  });

  it.each(["draft", "received"])("does not promote a %s invoice copied from an estimate", (status) => {
    const result = resolveShipmentChargeEvidence({ charge: { ...invoiced, actualCents: null, estimatedCents: "33000" },
      invoices: [{ ...line, status }], priorConfirmedCharge: null });
    expect(result).toMatchObject({ evidence: "estimated", issue: null, approvedInvoiceLineIds: [] });
  });

  it("does not accept invoiced or paid status alone as confirmation", () => {
    for (const status of ["invoiced", "paid"]) {
      expect(resolveShipmentChargeEvidence({ charge: { ...invoiced, invoiceId: null, status }, invoices: [], priorConfirmedCharge: null }))
        .toMatchObject({ evidence: "estimated", confirmedCharge: null });
    }
  });

  it("does not reuse finalized evidence after an amount, currency, supplier, method, or identity change", () => {
    for (const patch of [{ actualCents: "34000" }, { currency: "EUR" }, { vendorId: 7 },
      { allocationMethod: "by_volume" }, { shipmentId: 2 }, { costType: "duty" }, { id: 32 }]) {
      const result = resolveShipmentChargeEvidence({ charge: { ...invoiced, invoiceId: null, ...patch },
        invoices: [], priorConfirmedCharge: finalized });
      expect(result.evidence).toBe("estimated");
    }
  });

  it("rejects a header-only link instead of treating invoice presence as allocated evidence", () => {
    expect(resolveShipmentChargeEvidence({ charge: invoiced, invoices: [{ ...line, freightCostId: null }], priorConfirmedCharge: finalized }))
      .toMatchObject({ evidence: "review_required", issue: { code: "LANDED_INVOICE_LINES_MISSING" } });
  });

  it.each(["disputed", "voided", "unknown"])("requires review when the linked invoice is %s", (status) => {
    expect(resolveShipmentChargeEvidence({ charge: invoiced, invoices: [{ ...line, status }], priorConfirmedCharge: finalized }))
      .toMatchObject({ evidence: "review_required", issue: { code: "LANDED_INVOICE_STATUS_REVIEW" } });
  });

  it("requires supplier, shipment, currency and invoice identity to match", () => {
    for (const patch of [{ vendorId: 7 }, { shipmentId: 2 }, { currency: "EUR" }, { invoiceId: 99 }]) {
      expect(resolveShipmentChargeEvidence({ charge: invoiced, invoices: [{ ...line, ...patch }], priorConfirmedCharge: finalized }))
        .toMatchObject({ evidence: "review_required", issue: { code: "LANDED_INVOICE_SOURCE_MISMATCH" } });
    }
  });

  it("requires exact invoice amount equality before accepting authority", () => {
    expect(resolveShipmentChargeEvidence({ charge: { ...invoiced, actualCents: "32000" }, invoices: [line], priorConfirmedCharge: null }))
      .toMatchObject({ evidence: "review_required", issue: { code: "LANDED_INVOICE_AMOUNT_REVIEW" } });
  });

  it("rejects incomplete or inconsistent document totals and unit price math", () => {
    for (const patch of [{ documentLinesTotalCents: "32999" }, { quantity: 2 }, { unitCostMills: "3299900" },
      { lineTotalCents: null }, { quantity: null }, { unitCostMills: null, unitCostCents: null }]) {
      expect(resolveShipmentChargeEvidence({ charge: invoiced, invoices: [{ ...line, ...patch }], priorConfirmedCharge: finalized }))
        .toMatchObject({ evidence: "review_required", issue: { code: "LANDED_INVOICE_TOTAL_REVIEW" } });
    }
  });

  it("supports multiple exact charge lines and legacy cent-unit invoices without double counting", () => {
    const result = resolveShipmentChargeEvidence({ charge: invoiced, priorConfirmedCharge: null, invoices: [
      { ...line, unitCostMills: null, unitCostCents: "16500", lineTotalCents: "16500" },
      { ...line, id: 73, unitCostMills: "1650000", lineTotalCents: "16500" },
      { ...line, id: 74, invoiceId: 91, freightCostId: 35, lineTotalCents: "99900" },
    ] });
    expect(result).toMatchObject({ evidence: "confirmed", approvedInvoiceLineIds: [72, 73] });
  });

  it("accepts explicitly confirmed zero and rejects malformed or unsafe stored money", () => {
    expect(resolveShipmentChargeEvidence({ charge: { ...finalized, actualCents: 0 }, invoices: [], priorConfirmedCharge: null }).evidence)
      .toBe("confirmed");
    for (const actualCents of ["1.5", "NaN", "9007199254740993", Number.MAX_SAFE_INTEGER + 1]) {
      expect(resolveShipmentChargeEvidence({ charge: { ...finalized, actualCents }, invoices: [], priorConfirmedCharge: null }))
        .toMatchObject({ evidence: "review_required", issue: { code: "LANDED_INVOICE_EVIDENCE_INVALID" } });
    }
  });
});
