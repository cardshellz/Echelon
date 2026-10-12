import { describe, expect, it } from "vitest";
import { deriveInvoiceFinancialState } from "../../domain/invoice-financial-state";
describe("exact invoice financial projection shared by previews and ledger writes", () => {
  it.each([
    ["paid", 1338750, 669375, "partially_paid", 669375],
    ["partially_paid", 100, 100, "paid", 0], ["paid", 100, 0, "approved", 100],
    ["received", 100, 0, "received", 100], ["approved", 100, 0, "approved", 100],
    ["approved", 0, 0, "paid", 0], ["approved", 100, 101, "paid", 0],
    ["disputed", 100, 50, "disputed", 50], ["voided", 100, 0, "voided", 100],
    ["approved", Number.MAX_SAFE_INTEGER, 1, "partially_paid", Number.MAX_SAFE_INTEGER - 1],
  ] as const)("projects %s/%s/%s deterministically", (status, invoiceAmountCents, paidAmountCents, afterStatus, balanceCents) => {
    expect(deriveInvoiceFinancialState({ status, invoiceAmountCents, paidAmountCents })).toEqual({ status: afterStatus, balanceCents });
  });
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid amounts %s", amount => {
    expect(() => deriveInvoiceFinancialState({ status: "paid", invoiceAmountCents: amount, paidAmountCents: 0 })).toThrow();
    expect(() => deriveInvoiceFinancialState({ status: "paid", invoiceAmountCents: 0, paidAmountCents: amount })).toThrow();
  });
});
