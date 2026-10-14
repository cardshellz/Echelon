import { describe, expect, it } from "vitest";
import { invoiceEditCapability, type InvoiceEditFacts } from "../../domain/ap-invoice-edit-policy";
import { classifyApPaymentState, isRecordableApPaymentStatus } from "../../domain/ap-payment-state";
import { apInvoiceEditCapabilitySchema } from "@shared/procurement/ap-invoice-capabilities";

const unrecognized: InvoiceEditFacts = { status: "received", approvedAt: null, approvedBy: null, paidAmountCents: 0, hasPaymentHistory: false };

describe("AP financial history edit policy", () => {
  it.each([
    { allowed: true, code: "AP_INVOICE_IMMUTABLE" },
    { allowed: false, code: "AP_INVOICE_EDITABLE" },
  ])("rejects a contradictory edit capability %j", (decision) => {
    expect(apInvoiceEditCapabilitySchema.safeParse({ ...decision, requiredPermission: "purchasing:edit", reason: "Recorded decision" }).success).toBe(false);
  });
  it.each(["received", "disputed"])("allows an unrecognized %s invoice", (status) => {
    expect(invoiceEditCapability({ ...unrecognized, status })).toMatchObject({ allowed: true, requiredPermission: "purchasing:edit" });
  });
  it.each(["approved", "partially_paid", "paid", "voided", "unknown"])("blocks %s invoices", (status) => {
    expect(invoiceEditCapability({ ...unrecognized, status })).toMatchObject({ allowed: false, code: "AP_INVOICE_IMMUTABLE" });
  });
  it.each([
    { approvedAt: new Date("2026-10-13T12:00:00Z") }, { approvedBy: "approver" },
    { paidAmountCents: 1 }, { hasPaymentHistory: true },
  ])("dispute never erases financial history %j", (history) => {
    expect(invoiceEditCapability({ ...unrecognized, status: "disputed", ...history })).toMatchObject({ allowed: false, code: "AP_INVOICE_FINANCIAL_HISTORY" });
  });
  it.each([NaN, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])("blocks invalid recorded money %s", (paidAmountCents) => {
    expect(invoiceEditCapability({ ...unrecognized, paidAmountCents })).toMatchObject({ allowed: false, code: "AP_INVOICE_SOURCE_REVIEW_REQUIRED" });
  });
  it("fails closed if the approval evidence is missing", () => {
    expect(invoiceEditCapability({ ...unrecognized, approvedAt: undefined } as unknown as InvoiceEditFacts).allowed).toBe(false);
  });
  it("does not mutate evidence", () => {
    expect(invoiceEditCapability(Object.freeze(unrecognized)).allowed).toBe(true);
  });
});

describe("AP completed payment contract", () => {
  it.each([undefined, "completed"])("accepts record status %s", (status) => expect(isRecordableApPaymentStatus(status)).toBe(true));
  it.each([null, "voided", "scheduled", "returned", "", "COMPLETED", 0])("rejects record status %s", (status) => expect(isRecordableApPaymentStatus(status)).toBe(false));
  it("classifies completed, voided and unsupported historical states explicitly", () => {
    expect(classifyApPaymentState("completed")).toBe("settled");
    expect(classifyApPaymentState("voided")).toBe("voided");
    expect(classifyApPaymentState("returned")).toBe("review_required");
  });
});
