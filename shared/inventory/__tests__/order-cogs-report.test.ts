import { describe, expect, it } from "vitest";
import {
  OrderCOGSResponseError,
  parseOrderCOGSReport,
  unsupportedOrderCOGSCurrencySchema,
} from "../order-cogs-report";

const lot = {
  lotId: 9, lotNumber: "COST-LOT", qty: 100,
  unitCostCents: 230, totalCostCents: 23000,
};
const line = {
  orderItemId: 8, sku: "COST-A", productName: "Test product", qty: 100,
  revenueCents: 20000, cogsCents: 23000, marginCents: -3000, marginPercent: -15,
  lotBreakdown: [lot],
};
const legacy = {
  orderId: 7, orderNumber: "TEST-COST-7", totalRevenueCents: 20000,
  totalCogsCents: 23000, grossMarginCents: -3000, marginPercent: -15,
  lineItems: [line],
};

describe("order COGS report response boundary", () => {
  it("preserves old cent-only responses, signed losses and additive metadata without mutating input", () => {
    const input = { ...legacy, revision: "future", lineItems: [{ ...line, extra: true }] };
    const before = structuredClone(input);
    expect(parseOrderCOGSReport(input)).toEqual(input);
    expect(input).toEqual(before);
  });

  it("accepts recorded zero and an order with no cost rows", () => {
    const input = { ...legacy, totalRevenueCents: 0, totalCogsCents: 0, totalCogsMills: "0",
      grossMarginCents: 0, marginPercent: 0, lineItems: [] };
    expect(parseOrderCOGSReport(input)).toEqual(input);
    expect(parseOrderCOGSReport({ ...input, lineItems: [{ ...line, qty: 0, revenueCents: 0,
      cogsCents: 0, cogsMills: "0", marginCents: 0, marginPercent: 0, lotBreakdown: [] }] }).lineItems).toHaveLength(1);
  });

  it("reconciles exact mills while allowing independently rounded line and order cents", () => {
    const makeLine = (id: number) => ({ ...line, orderItemId: id, qty: 1, revenueCents: 100,
      cogsCents: 0, cogsMills: "49", marginCents: 100, marginPercent: 100,
      lotBreakdown: [{ ...lot, qty: 1, unitCostCents: 0, totalCostCents: 0,
        unitCostMills: "49", totalCostMills: "49" }] });
    const input = { ...legacy, totalRevenueCents: 200, totalCogsCents: 1, totalCogsMills: "98",
      grossMarginCents: 199, marginPercent: 99.5, lineItems: [makeLine(8), makeLine(10)] };
    expect(parseOrderCOGSReport(input)).toEqual(input);
  });

  it("allows optional mills metadata during a compatible server rollout", () => {
    const input = { ...legacy, totalCogsMills: "2300000",
      lineItems: [{ ...line, lotBreakdown: [{ ...lot, unitCostMills: "23000" }] }] };
    expect(parseOrderCOGSReport(input)).toEqual(input);
  });

  it("retains exact mills beyond JavaScript's safe integer range", () => {
    const input = { ...legacy, totalRevenueCents: 0, totalCogsCents: 90071992547410,
      totalCogsMills: "9007199254740993", grossMarginCents: -90071992547410, marginPercent: 0,
      lineItems: [{ ...line, revenueCents: 0, cogsCents: 90071992547410, cogsMills: "9007199254740993",
        marginCents: -90071992547410, marginPercent: 0, lotBreakdown: [{ ...lot, qty: 1,
          unitCostCents: 90071992547410, totalCostCents: 90071992547410,
          unitCostMills: "9007199254740993", totalCostMills: "9007199254740993" }] }] };
    expect(parseOrderCOGSReport(input)).toEqual(input);
  });

  it("does not invent line-to-header revenue equality or reject repeated draws from one lot", () => {
    const input = { ...legacy, totalRevenueCents: 20500, grossMarginCents: -2500,
      marginPercent: -12.2, lineItems: [{ ...line, lotBreakdown: [
        { ...lot, qty: 50, totalCostCents: 11500 }, { ...lot, qty: 50, totalCostCents: 11500 },
      ] }] };
    expect(parseOrderCOGSReport(input)).toEqual(input);
  });

  it.each([
    ["missing body", null], ["empty body", {}], ["array body", []],
    ["missing line items", { ...legacy, lineItems: undefined }],
    ["null line items", { ...legacy, lineItems: null }],
    ["wrong lot shape", { ...legacy, lineItems: [{ ...line, lotBreakdown: {} }] }],
    ["string cents", { ...legacy, totalCogsCents: "23000" }],
    ["null cents", { ...legacy, totalCogsCents: null }],
    ["negative cost", { ...legacy, totalCogsCents: -1 }],
    ["unsafe cents", { ...legacy, totalCogsCents: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional summary cents", { ...legacy, totalCogsCents: 0.25 }],
    ["fractional line cents", { ...legacy, lineItems: [{ ...line, marginCents: 0.25 }] }],
    ["fractional lot cents", { ...legacy, lineItems: [{ ...line, lotBreakdown: [{ ...lot, unitCostCents: 0.25 }] }] }],
    ["infinite percent", { ...legacy, marginPercent: Infinity }],
    ["missing percent", { ...legacy, marginPercent: undefined }],
    ["invalid identity", { ...legacy, orderId: 0 }],
    ["duplicate items", { ...legacy, lineItems: [line, line] }],
    ["inconsistent summary margin", { ...legacy, grossMarginCents: 0 }],
    ["inconsistent line margin", { ...legacy, lineItems: [{ ...line, marginCents: 0 }] }],
    ["numeric mills", { ...legacy, totalCogsMills: 2300000 }],
    ["fractional mills", { ...legacy, totalCogsMills: "2300000.1" }],
    ["negative mills", { ...legacy, totalCogsMills: "-1" }],
    ["overflow mills", { ...legacy, totalCogsMills: "9223372036854775808" }],
    ["unparseable mills", { ...legacy, totalCogsMills: "cost" }],
    ["mismatched cent projection", { ...legacy, totalCogsMills: "0" }],
    ["mismatched exact total", { ...legacy, totalCogsMills: "2300001", lineItems: [{ ...line, cogsMills: "2300000" }] }],
    ["mismatched exact line", { ...legacy, lineItems: [{ ...line, cogsMills: "2300000",
      lotBreakdown: [{ ...lot, totalCostMills: "2300001" }] }] }],
    ["mismatched unit projection", { ...legacy, lineItems: [{ ...line,
      lotBreakdown: [{ ...lot, unitCostMills: "0" }] }] }],
  ])("classifies %s as a response error instead of crashing or inventing zeros", (_name, input) => {
    expect(() => parseOrderCOGSReport(input)).toThrow(OrderCOGSResponseError);
  });

  it("exposes field paths without embedding untrusted payload values", () => {
    let failure: unknown;
    try { parseOrderCOGSReport({ ...legacy, lineItems: [{ ...line, cogsCents: "PRIVATE-VALUE" }] }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(OrderCOGSResponseError);
    expect(failure).toMatchObject({ code: "ORDER_COGS_RESPONSE_INVALID", fields: ["lineItems.0.cogsCents"] });
    expect(String(failure)).not.toContain("PRIVATE-VALUE");
  });

  it("recognizes only the documented unsupported currency code", () => {
    expect(unsupportedOrderCOGSCurrencySchema.safeParse({ code: "ORDER_COGS_CURRENCY_UNSUPPORTED",
      currency: "CAD", error: "Untrusted server text" }).success).toBe(true);
    for (const input of [null, {}, { error: "Currency failed" }, { code: "UNKNOWN" }]) {
      expect(unsupportedOrderCOGSCurrencySchema.safeParse(input).success).toBe(false);
    }
  });
});
