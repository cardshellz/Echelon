import { describe, expect, it } from "vitest";
import { deriveShopifyRefundFinancialStatus } from "../../domain/shopify-refund-financial-status";

const paid = {
  totalCents: 829,
  previousRefundCents: 0,
  refundCents: 0,
  previousFinancialStatus: "paid",
};

describe("Shopify refund financial status uses money rather than removed quantities", () => {
  it("preserves payment status for the zero-transaction replacement-line refund", () => {
    expect(deriveShopifyRefundFinancialStatus(paid)).toBe("paid");
    expect(
      deriveShopifyRefundFinancialStatus({
        ...paid,
        previousFinancialStatus: null,
      }),
    ).toBeNull();
    expect(deriveShopifyRefundFinancialStatus({ ...paid, totalCents: 0 })).toBe(
      "paid",
    );
  });
  it("classifies partial and cumulative full refunds without any quantity signal", () => {
    expect(
      deriveShopifyRefundFinancialStatus({ ...paid, refundCents: 106 }),
    ).toBe("partially_refunded");
    expect(
      deriveShopifyRefundFinancialStatus({
        ...paid,
        previousRefundCents: "106",
        refundCents: 723,
      }),
    ).toBe("refunded");
    expect(
      deriveShopifyRefundFinancialStatus({
        ...paid,
        previousRefundCents: 106,
        previousFinancialStatus: "partially_refunded",
      }),
    ).toBe("partially_refunded");
    expect(
      deriveShopifyRefundFinancialStatus({
        ...paid,
        totalCents: null,
        refundCents: 106,
      }),
    ).toBe("partially_refunded");
  });
  it.each([
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1.06",
    "-1",
    "invalid",
  ])("rejects invalid money evidence: %s", (value) => {
    expect(() =>
      deriveShopifyRefundFinancialStatus({
        ...paid,
        previousRefundCents: value,
      }),
    ).toThrow("Refund financial evidence contains an invalid amount.");
  });
  it("checks the cumulative integer limit before the audit converts cents to a number", () => {
    expect(() =>
      deriveShopifyRefundFinancialStatus({
        ...paid,
        previousRefundCents: Number.MAX_SAFE_INTEGER,
        refundCents: 1,
      }),
    ).toThrow("Cumulative refund exceeds the supported amount.");
    expect(
      deriveShopifyRefundFinancialStatus({
        ...paid,
        totalCents: Number.MAX_SAFE_INTEGER,
        refundCents: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe("refunded");
  });
});
