import { describe, expect, it } from "vitest";
import {
  buildOrderEditFinancials,
  equivalentOrderEditFinancialEvidence,
  matchesOrderEditFinancials,
  presentOrderEditSettlement,
  sumOrderEditCents,
} from "../../domain/order-edit-financials";
import { orderEditFinancialsSchema } from "@shared/order-edits/order-edit-financials";

const input = () => ({
  lines: [
    { id: "line-1", grossCents: 1996, netCents: 1796 },
    { id: "line-2", grossCents: 9999, netCents: 9000 },
  ],
  itemsNetCents: 10796,
  itemDiscountLabels: ["AMAZZIN'"],
  shippingGrossCents: 1299,
  shippingCents: 0,
  shippingDiscountLabels: ["Free shipping"],
  taxCents: 0,
  taxesIncluded: false,
  totalCents: 10796,
});
const payment = (
  id: string,
  kind = "SALE",
  status = "SUCCESS",
  amountCents = 2000,
) => ({ id, kind, status, amountCents });

describe("exact order edit financials", () => {
  const details = () => [
    {
      key: "code:AMAZZIN'",
      label: "AMAZZIN'",
      amountCents: 1199,
      value: { type: "percentage" as const, percentage: "10" },
    },
  ];
  it("reconciles named discount amounts to the aggregate without changing older financial evidence", () => {
    const legacy = buildOrderEditFinancials(input());
    const enriched = buildOrderEditFinancials({
      ...input(),
      itemDiscounts: details(),
    });
    expect(enriched.itemDiscounts).toEqual(details());
    expect(legacy.itemDiscounts).toBeUndefined();
    expect(orderEditFinancialsSchema.safeParse(legacy).success).toBe(true);
    expect(matchesOrderEditFinancials(enriched, legacy)).toBe(true);
    expect(equivalentOrderEditFinancialEvidence(enriched, legacy)).toBe(true);
    expect(
      equivalentOrderEditFinancialEvidence(
        { ...enriched, totalCents: 10795 },
        legacy,
      ),
    ).toBe(false);
    expect(
      equivalentOrderEditFinancialEvidence(
        {
          ...enriched,
          lines: enriched.lines.map((line) => ({
            ...line,
            netCents: line.netCents - 1,
          })),
        },
        legacy,
      ),
    ).toBe(false);
  });
  it("requires new per-code evidence and catches rule changes even when order totals match", () => {
    const enriched = buildOrderEditFinancials({
      ...input(),
      itemDiscounts: details(),
    });
    const legacy = buildOrderEditFinancials(input());
    expect(matchesOrderEditFinancials(legacy, enriched)).toBe(false);
    expect(equivalentOrderEditFinancialEvidence(legacy, enriched)).toBe(false);
    const changed = {
      ...enriched,
      itemDiscounts: [
        {
          ...details()[0],
          value: { type: "percentage" as const, percentage: "20" },
        },
      ],
    };
    expect(matchesOrderEditFinancials(changed, enriched)).toBe(false);
    expect(equivalentOrderEditFinancialEvidence(changed, enriched)).toBe(false);
  });
  it.each(
    [
      [
        {
          key: "code",
          label: "Code",
          amountCents: 1198,
          value: { type: "percentage", percentage: "10" },
        },
      ],
      [
        {
          key: "code",
          label: "Code",
          amountCents: 1199,
          value: { type: "percentage", percentage: "100.01" },
        },
      ],
      [
        {
          key: "code",
          label: "Code",
          amountCents: 1199,
          value: { type: "fixed", amountCents: 1000 },
        },
      ],
      [
        {
          key: "same",
          label: "Code",
          amountCents: 1199,
          value: { type: "allocated" },
        },
        {
          key: "same",
          label: "Code",
          amountCents: 0,
          value: { type: "allocated" },
        },
      ],
      [
        {
          key: "code",
          label: "Code",
          amountCents: 1199.5,
          value: { type: "allocated" },
        },
      ],
      [
        {
          key: "code",
          label: "Code",
          amountCents: -1,
          value: { type: "allocated" },
        },
      ],
    ].map((itemDiscounts) => ({ itemDiscounts })),
  )(
    "rejects invalid or contradictory per-code display evidence",
    ({ itemDiscounts }) => {
      expect(
        orderEditFinancialsSchema.safeParse({
          ...buildOrderEditFinancials(input()),
          itemDiscounts,
        }).success,
      ).toBe(false);
    },
  );
  it("reconciles discounts separately and does not mutate input", () => {
    const original = input();
    const before = structuredClone(original);
    const result = buildOrderEditFinancials(original);
    expect(result).toMatchObject({
      itemsGrossCents: 11995,
      itemsDiscountCents: 1199,
      shippingDiscountCents: 1299,
      totalCents: 10796,
    });
    expect(original).toEqual(before);
    result.lines[0].netCents = 0;
    expect(original).toEqual(before);
  });
  it("handles zero-priced orders, tax-exclusive amounts, and included tax without adding it twice", () => {
    const zero = {
      ...input(),
      lines: [],
      itemsNetCents: 0,
      shippingGrossCents: 0,
      taxCents: 0,
      totalCents: 0,
    };
    expect(buildOrderEditFinancials(zero).totalCents).toBe(0);
    expect(
      buildOrderEditFinancials({ ...input(), taxCents: 648, totalCents: 11444 })
        .totalCents,
    ).toBe(11444);
    expect(
      buildOrderEditFinancials({
        ...input(),
        taxesIncluded: true,
        taxCents: 600,
      }).totalCents,
    ).toBe(10796);
  });
  it.each([
    { totalCents: 10795 },
    { itemsNetCents: 10795 },
    { shippingCents: 1300 },
    { taxCents: 1.5 },
    { lines: [{ id: "line-1", grossCents: 100, netCents: 101 }] },
    {
      lines: [
        { id: "same", grossCents: 1996, netCents: 1796 },
        { id: "same", grossCents: 9999, netCents: 9000 },
      ],
    },
  ])("rejects a contradictory or invalid breakdown %j", (patch) => {
    expect(() => buildOrderEditFinancials({ ...input(), ...patch })).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_FINANCIAL_MISMATCH" }),
    );
  });
  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cent input %s",
    (value) => {
      expect(() => sumOrderEditCents([value])).toThrow(
        expect.objectContaining({ code: "ORDER_EDIT_MONEY_INVALID" }),
      );
    },
  );
  it("supports the exact safe-integer boundary and rejects an overflowing sum", () => {
    expect(sumOrderEditCents([Number.MAX_SAFE_INTEGER - 1, 1])).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => sumOrderEditCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(
      expect.objectContaining({ code: "ORDER_EDIT_MONEY_INVALID" }),
    );
  });
  it("validates mismatches even when only an allocation changes", () => {
    const value = buildOrderEditFinancials(input());
    expect(
      orderEditFinancialsSchema.safeParse({
        ...value,
        lines: [{ ...value.lines[0], discountCents: 201 }, value.lines[1]],
      }).success,
    ).toBe(false);
    expect(matchesOrderEditFinancials(undefined, value)).toBe(false);
    expect(matchesOrderEditFinancials(value, undefined)).toBe(true); // Legacy saved operations retain their prior contract.
    expect(matchesOrderEditFinancials({ ...value, taxCents: 1 }, value)).toBe(
      false,
    );
    expect(matchesOrderEditFinancials(structuredClone(value), value)).toBe(
      true,
    );
  });
});

describe("order edit payments and refunds", () => {
  it("counts successful payments and refunds once while retaining failed and pending history", () => {
    const refund = payment("refund", "REFUND", "SUCCESS", 1000);
    const result = presentOrderEditSettlement({
      transactions: [
        payment("sale"),
        payment("authorization", "AUTHORIZATION"),
        payment("capture", "CAPTURE", "SUCCESS", 500),
        refund,
        payment("pending", "CAPTURE", "PENDING", 100),
        payment("failed", "REFUND", "FAILURE", 100),
      ],
      refunds: [{ transactions: [refund] }],
      netPaidCents: 1500,
      outstandingCents: 0,
      paymentDates: { sale: "2026-10-06T12:00:00.000Z" },
    });
    expect(result).toMatchObject({
      receivedCents: 2500,
      refundedCents: 1000,
      netPaidCents: 1500,
      outstandingCents: 0,
    });
    expect(result.activity).toHaveLength(6);
    expect(
      result.activity.find((entry) => entry.id === "sale")?.processedAt,
    ).toBe("2026-10-06T12:00:00.000Z");
    expect(
      result.activity.find((entry) => entry.id === "pending")?.processedAt,
    ).toBeNull();
  });
  it.each(["original history", "refund history"])(
    "rejects contradictory duplicate IDs in %s",
    (group) => {
      const original = payment("same");
      const changed = payment("same", "SALE", "SUCCESS", 1000);
      expect(() =>
        presentOrderEditSettlement({
          transactions:
            group === "original history" ? [original, changed] : [original],
          refunds:
            group === "refund history" ? [{ transactions: [changed] }] : [],
          netPaidCents: 2000,
          outstandingCents: 0,
        }),
      ).toThrow(
        expect.objectContaining({
          code: "ORDER_EDIT_PAYMENT_EVIDENCE_CONFLICT",
        }),
      );
    },
  );
  it.each([
    payment("id", "UNSUPPORTED"),
    payment("id", "SALE", "UNSUPPORTED"),
    payment("id", "SALE", "SUCCESS", -1),
  ])("rejects incomplete or invalid transaction evidence %j", (transaction) => {
    expect(() =>
      presentOrderEditSettlement({
        transactions: [transaction],
        refunds: [],
        netPaidCents: 2000,
        outstandingCents: 0,
      }),
    ).toThrow();
  });
  it("reports a negative outstanding balance as refund due without claiming it was issued", () => {
    const value = presentOrderEditSettlement({
      transactions: [payment("sale")],
      refunds: [],
      netPaidCents: 2000,
      outstandingCents: -1000,
    });
    expect(value).toMatchObject({
      receivedCents: 2000,
      refundedCents: 0,
      outstandingCents: -1000,
    });
  });
});
