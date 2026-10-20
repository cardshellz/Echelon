import { describe, expect, it } from "vitest";
import { projectPaymentBalance, type PaymentAllocationEvidence } from "../../domain/ap-payment-balance";
import { paymentApplicationInputSchema, paymentCalendarDateSchema, paymentCalendarDateToUtc, formatPaymentCalendarDate } from "@shared/procurement/ap-payment-contract";
const payment = { id: 1, vendorId: 2, totalAmountCents: 1000, currency: "USD", status: "completed" };
const row: PaymentAllocationEvidence = { id: 11, apPaymentId: 1, vendorInvoiceId: 3, appliedAmountCents: 250, invoiceVendorId: 2, invoiceCurrency: "USD", invoiceStatus: "partially_paid" };
describe("recorded payment balance evidence", () => {
  it("retains independent repeated applications and conserves remaining cash", () => {
    expect(projectPaymentBalance(payment, [row, { ...row, id: 12 }])).toMatchObject({ state: "available", appliedAmountCents: 500, unappliedAmountCents: 500, issue: null });
  });
  it("does not mutate evidence and versions the same canonical facts regardless of selected header columns", () => {
    const rows = Object.freeze([Object.freeze({ ...row, id: 12 }), Object.freeze(row)]);
    const first = projectPaymentBalance(payment, rows);
    expect(projectPaymentBalance({ ...payment, extra: "display" } as typeof payment, [...rows].reverse()).version).toBe(first.version);
    expect(rows[0].id).toBe(12);
    expect(projectPaymentBalance(payment, [row]).version).not.toBe(first.version);
  });
  it.each([0, -1, 0.1, Number.MAX_SAFE_INTEGER + 1, "not money", "01", null])("fails closed for malformed payment total %j", totalAmountCents => {
    expect(projectPaymentBalance({ ...payment, totalAmountCents }, [])).toMatchObject({ state: "review_required", appliedAmountCents: null, unappliedAmountCents: null });
  });
  it.each([{ appliedAmountCents: -1 }, { appliedAmountCents: 0.5 }, { invoiceVendorId: 99 }, { invoiceCurrency: "CAD" }, { invoiceStatus: null }, { invoiceStatus: "voided" }, { apPaymentId: 999 }])("refuses incompatible allocation evidence %j", patch => {
    expect(projectPaymentBalance(payment, [{ ...row, ...patch }])).toMatchObject({ state: "review_required", appliedAmountCents: null });
  });
  it("does not hide duplicate record identities or over-application", () => {
    expect(projectPaymentBalance(payment, [row, row]).state).toBe("review_required");
    expect(projectPaymentBalance(payment, [{ ...row, appliedAmountCents: 1001 }]).issue?.code).toBe("AP_PAYMENT_OVERALLOCATED");
  });
  it("keeps void history but provides no spendable remainder", () => {
    expect(projectPaymentBalance({ ...payment, status: "voided" }, [{ ...row, invoiceStatus: "voided" }])).toMatchObject({ state: "voided", appliedAmountCents: 0, unappliedAmountCents: 0 });
  });
  it("supports exact maximum safe amount and full application", () => {
    expect(projectPaymentBalance({ ...payment, totalAmountCents: String(Number.MAX_SAFE_INTEGER) }, [{ ...row, appliedAmountCents: String(Number.MAX_SAFE_INTEGER) }])).toMatchObject({ state: "fully_applied", appliedAmountCents: Number.MAX_SAFE_INTEGER, unappliedAmountCents: 0 });
  });
  it.each([0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("invalid application amount %s rejects without throwing", appliedAmountCents => {
    expect(() => paymentApplicationInputSchema.safeParse({ expectedVersion: "a".repeat(64), reason: "Review", allocations: [{ vendorInvoiceId: 1, appliedAmountCents }] })).not.toThrow();
    expect(paymentApplicationInputSchema.safeParse({ expectedVersion: "a".repeat(64), reason: "Review", allocations: [{ vendorInvoiceId: 1, appliedAmountCents }] }).success).toBe(false);
  });
  it("rejects duplicate targets and overflow in one reviewed request", () => {
    const base = { expectedVersion: "a".repeat(64), reason: "Supplier invoice received" };
    expect(paymentApplicationInputSchema.safeParse({ ...base, allocations: [{ vendorInvoiceId: 1, appliedAmountCents: 1 }, { vendorInvoiceId: 1, appliedAmountCents: 2 }] }).success).toBe(false);
    expect(paymentApplicationInputSchema.safeParse({ ...base, allocations: [{ vendorInvoiceId: 1, appliedAmountCents: Number.MAX_SAFE_INTEGER }, { vendorInvoiceId: 2, appliedAmountCents: 1 }] }).success).toBe(false);
  });
});
describe("payment calendar date contract", () => {
  it.each(["2026-10-01", "2024-02-29", "0099-01-01"])("round trips calendar date %s", value => {
    expect(paymentCalendarDateSchema.parse(value)).toBe(value);
    expect(paymentCalendarDateToUtc(value).toISOString()).toBe(`${value}T00:00:00.000Z`);
  });
  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-10-01T00:00:00Z", "0000-01-01", "2026-1-1", "bad"])("rejects non-calendar input %s", value => {
    expect(paymentCalendarDateSchema.safeParse(value).success).toBe(false);
  });
  it("shows the selected day regardless of the process timezone", () => {
    const old = process.env.TZ;
    try { for (const zone of ["America/New_York", "Pacific/Honolulu", "Asia/Tokyo", "UTC"]) { process.env.TZ = zone;
      expect(formatPaymentCalendarDate({ paymentCalendarDate: "2026-10-01", paymentDateSource: "recorded_calendar_date" })).toBe("Oct 1, 2026"); } }
    finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
  });
  it("does not infer an intended date from historical timestamps or malformed evidence", () => {
    expect(formatPaymentCalendarDate({ paymentCalendarDate: null, paymentDateSource: "legacy_timestamp" })).toBe("Date not verified");
    expect(formatPaymentCalendarDate({ paymentCalendarDate: "2026-02-30", paymentDateSource: "recorded_calendar_date" })).toBe("Date not verified");
  });
});
