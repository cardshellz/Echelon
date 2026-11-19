import { describe, expect, it } from "vitest";
import { apSummarySchema, type ApSummary } from "../../ap-summary";

function emptySummary(): ApSummary {
  return {
    totalOutstandingCents: 0, disputedOutstandingCents: 0, disputedInvoiceCount: 0,
    overdueCents: 0, dueSoonCents: 0, paidThisMonthCents: 0, paidAllTimeCents: 0,
    creditedAllTimeCents: 0, openInvoiceCount: 0,
    agingBuckets: { current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0 },
    vendorAging: [], recentPayments: [], recentlyPaid: [],
  };
}

describe("AP summary read evidence", () => {
  it("retains a complete valid zero-activity summary", () => {
    expect(apSummarySchema.parse(emptySummary())).toEqual(emptySummary());
  });

  it.each(["totalOutstandingCents", "disputedOutstandingCents", "overdueCents", "dueSoonCents",
    "paidThisMonthCents", "paidAllTimeCents", "creditedAllTimeCents"])("requires the owner amount %s", field => {
    const value: Record<string, unknown> = emptySummary();
    delete value[field];
    expect(apSummarySchema.safeParse(value).success).toBe(false);
  });

  it.each([null, undefined, [], {}, -1, "9000", 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    "does not invent financial evidence from an invalid amount or document: %j", value => {
      const document = typeof value === "object" || value === undefined ? value : { ...emptySummary(), totalOutstandingCents: value };
      expect(apSummarySchema.safeParse(document).success).toBe(false);
    },
  );

  it("accepts the largest safe integer-cent value without changing it", () => {
    const summary = { ...emptySummary(), paidAllTimeCents: Number.MAX_SAFE_INTEGER };
    expect(apSummarySchema.parse(summary).paidAllTimeCents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("requires both counts, all aging buckets and the three evidence arrays", () => {
    for (const field of ["disputedInvoiceCount", "openInvoiceCount", "agingBuckets", "vendorAging", "recentPayments", "recentlyPaid"]) {
      const summary: Record<string, unknown> = emptySummary(); delete summary[field];
      expect(apSummarySchema.safeParse(summary).success).toBe(false);
    }
    expect(apSummarySchema.safeParse({ ...emptySummary(), agingBuckets: { current: 0 } }).success).toBe(false);
  });

  it("preserves nullable vendor names and dates and a provider-defined payment method", () => {
    const summary = emptySummary();
    summary.recentPayments.push({ id: 1, paymentNumber: "PAY-1", vendorName: null, paymentDate: null,
      paymentCalendarDate: null, paymentDateSource: "legacy_timestamp", paymentMethod: "supplier-specific", totalAmountCents: 1250, status: "completed" });
    summary.recentlyPaid.push({ id: 2, invoiceNumber: "INV-2", vendorName: null, invoicedAmountCents: 1250, paidAmountCents: 1250, creditedAmountCents: 0 });
    expect(apSummarySchema.parse(summary)).toEqual(summary);
    summary.recentPayments[0].totalAmountCents = 0.5;
    expect(apSummarySchema.safeParse(summary).success).toBe(false);
  });
});
