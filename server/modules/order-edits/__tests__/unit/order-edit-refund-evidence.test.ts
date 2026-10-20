import { describe, expect, it } from "vitest";
import {
  financialsForQuotedLines,
  isUnpaidRecoveryRestored,
  unchangedOrderEditRefundPayments,
} from "../../application/order-edit-evidence";
import type { OrderEditRefund } from "../../application/order-edit-provider";
import {
  baseline,
  serviceHarness,
} from "../fixtures/order-edit-service.fixture";
import { orderEditEligibilityReasons } from "../../application/order-edit-identity";
import { buildOrderEditFinancials } from "../../domain/order-edit-financials";

const bookkeeping: OrderEditRefund = {
  id: "gid://shopify/Refund/2",
  note: null,
  amountCents: 0,
  transactions: [],
};
describe("unpaid recovery refund evidence", () => {
  it("permits new transaction-free zero bookkeeping while preserving every original record", () => {
    const before = baseline();
    const after = { ...structuredClone(before), refunds: [bookkeeping] };
    expect(
      unchangedOrderEditRefundPayments(after.refunds, before.refunds),
    ).toBe(true);
    expect(isUnpaidRecoveryRestored(after, before)).toBe(true);
    expect(orderEditEligibilityReasons(after)).not.toContain(
      "Orders with previous refunds require staff review before editing.",
    );
    expect(after.refunds).toEqual([bookkeeping]);
  });
  it("rejects amounts, refund intents and every transaction status including zero-value pending", () => {
    const invalid: OrderEditRefund[] = [
      { ...bookkeeping, amountCents: 1 },
      { ...bookkeeping, note: "order-edit:refund-request" },
      ...["PENDING", "AWAITING_RESPONSE", "UNKNOWN", "SUCCESS", "FAILURE"].map(
        (status) => ({
          ...bookkeeping,
          transactions: [
            {
              id: "gid://shopify/OrderTransaction/3",
              parentId: null,
              kind: "REFUND",
              status,
              gateway: "test",
              amountCents: 0,
              manual: false,
            },
          ],
        }),
      ),
    ];
    for (const refund of invalid) {
      expect(unchangedOrderEditRefundPayments([refund], [])).toBe(false);
      expect(
        isUnpaidRecoveryRestored(
          { ...baseline(), refunds: [refund] },
          baseline(),
        ),
      ).toBe(false);
      expect(
        orderEditEligibilityReasons({ ...baseline(), refunds: [refund] }),
      ).toContain(
        "Orders with previous refunds require staff review before editing.",
      );
    }
  });
  it("rejects removed, changed or duplicated original refunds", () => {
    expect(unchangedOrderEditRefundPayments([], [bookkeeping])).toBe(false);
    expect(
      unchangedOrderEditRefundPayments(
        [{ ...bookkeeping, amountCents: 1 }],
        [bookkeeping],
      ),
    ).toBe(false);
    expect(
      unchangedOrderEditRefundPayments([bookkeeping, bookkeeping], []),
    ).toBe(false);
    expect(
      unchangedOrderEditRefundPayments(
        [bookkeeping],
        [bookkeeping, bookkeeping],
      ),
    ).toBe(false);
  });
  it("omits historical zero rows from a new quote without hiding amounts or mutating native evidence", () => {
    const { quote } = serviceHarness();
    const financials = buildOrderEditFinancials({
      lines: quote.lines.map((line) => ({
        id: line.calculatedLineId,
        grossCents: line.totalCents,
        netCents: line.totalCents,
      })),
      itemsNetCents: quote.totalCents,
      itemDiscountLabels: [],
      shippingGrossCents: 0,
      shippingCents: 0,
      shippingDiscountLabels: [],
      taxCents: 0,
      taxesIncluded: false,
      totalCents: quote.totalCents,
    });
    const historical = {
      id: "historical",
      grossCents: 0,
      netCents: 0,
      discountCents: 0,
    };
    const native = { ...financials, lines: [...financials.lines, historical] };
    expect(financialsForQuotedLines(native, quote.lines)).toEqual(financials);
    expect(native.lines).toHaveLength(financials.lines.length + 1);
    expect(() =>
      financialsForQuotedLines(
        {
          ...native,
          lines: [
            ...financials.lines,
            { ...historical, grossCents: 1, netCents: 1 },
          ],
        },
        quote.lines,
      ),
    ).toThrow("The quote contains unexpected item amounts.");
  });
});
