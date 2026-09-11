import { describe, expect, it } from "vitest";
import { buildOrderCOGSReport } from "../../domain/order-cogs-read";

function snapshot() {
  return {
    order: { id: 1, orderNumber: "TEST-1", totalCents: 20000, currency: "USD" },
    items: [{ id: 10, sku: "A", name: "Recorded sale name", quantity: 100, totalPriceCents: 20000 }],
    costs: [{ order_id: 1, order_item_id: 10, lot_id: 20, lot_number: "LOT-20", qty_consumed: 100,
      unit_cost_cents: "230", total_cost_cents: "23000", unit_cost_mills: "0", total_cost_mills: "0" }],
  };
}

describe("order COGS report from recorded financial snapshots", () => {
  it("preserves exact loss cents and lot provenance without mutating input", () => {
    const input = snapshot();
    const original = structuredClone(input);
    expect(buildOrderCOGSReport(input)).toEqual({
      orderId: 1, orderNumber: "TEST-1", totalRevenueCents: 20000, totalCogsCents: 23000,
      grossMarginCents: -3000, marginPercent: -15, totalCogsMills: "2300000",
      lineItems: [{ orderItemId: 10, sku: "A", productName: "Recorded sale name", qty: 100,
        revenueCents: 20000, cogsCents: 23000, cogsMills: "2300000", marginCents: -3000, marginPercent: -15,
        lotBreakdown: [{ lotId: 20, lotNumber: "LOT-20", qty: 100, unitCostCents: 230, totalCostCents: 23000,
          unitCostMills: "23000", totalCostMills: "2300000" }] }],
    });
    expect(input).toEqual(original);
  });

  it("keeps an actual zero revenue and zero quantity, with an empty order distinct from invalid data", () => {
    const result = buildOrderCOGSReport({ order: { id: 1, orderNumber: "ZERO", totalCents: 0, currency: "USD" },
      items: [{ id: 10, sku: "ZERO", name: "Zero line", quantity: 0, totalPriceCents: 0 }], costs: [] });
    expect(result.lineItems[0]).toMatchObject({ qty: 0, revenueCents: 0, cogsCents: 0, marginCents: 0, marginPercent: 0 });
    expect(buildOrderCOGSReport({ order: { id: 1, orderNumber: "EMPTY", totalCents: 0, currency: "USD" }, items: [], costs: [] }).lineItems).toEqual([]);
  });

  it.each([undefined, null, "", "12.50", 12.5, -1, "-1", Infinity, NaN, "9007199254740992", "0x20", "1e3"])(
    "rejects a missing or invalid monetary value %s", (value) => {
      expect(() => buildOrderCOGSReport({ ...snapshot(), order: { id: 1, orderNumber: "TEST-1", totalCents: value, currency: "USD" } }))
        .toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
    },
  );

  it("rejects missing line revenue and cost rows instead of manufacturing zero", () => {
    const input = snapshot();
    expect(() => buildOrderCOGSReport({ ...input, items: [{ ...input.items[0], totalPriceCents: undefined }] }))
      .toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
    expect(() => buildOrderCOGSReport({ ...input, costs: undefined }))
      .toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
    expect(() => buildOrderCOGSReport({ ...input, costs: [{ ...input.costs[0], total_cost_cents: null }] }))
      .toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
  });

  it("rejects duplicate items and costs attributed outside their recorded order line", () => {
    const input = snapshot();
    expect(() => buildOrderCOGSReport({ ...input, items: [...input.items, input.items[0]] }))
      .toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
    for (const mismatch of [{ order_id: 2 }, { order_item_id: 11 }]) {
      expect(() => buildOrderCOGSReport({ ...input, costs: [{ ...input.costs[0], ...mismatch }] }))
        .toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
    }
  });

  it("retains the largest safe amount but rejects aggregate overflow", () => {
    const input = snapshot();
    const amount = Number.MAX_SAFE_INTEGER;
    const valid = { ...input, order: { ...input.order, totalCents: amount },
      items: [{ ...input.items[0], totalPriceCents: amount }],
      costs: [{ ...input.costs[0], total_cost_cents: String(amount) }] };
    expect(buildOrderCOGSReport(valid)).toMatchObject({ totalRevenueCents: amount, totalCogsCents: amount, grossMarginCents: 0 });
    expect(() => buildOrderCOGSReport({ ...valid, costs: [...valid.costs, { ...valid.costs[0], total_cost_cents: "1" }] }))
      .toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
  });

  it("aggregates authoritative subcent extended costs before cent rounding", () => {
    const input = snapshot();
    const tiny = { ...input.costs[0], unit_cost_cents: "0", total_cost_cents: "0", unit_cost_mills: "49", total_cost_mills: "49" };
    const report = buildOrderCOGSReport({ ...input, costs: [tiny, { ...tiny, lot_id: 21 }] });
    expect(report).toMatchObject({ totalCogsCents: 1, totalCogsMills: "98" });
    expect(report.lineItems[0]).toMatchObject({ cogsCents: 1, cogsMills: "98" });
    expect(report.lineItems[0].lotBreakdown.map((lot) => lot.totalCostMills)).toEqual(["49", "49"]);
    expect(report.lineItems[0].lotBreakdown.map((lot) => lot.totalCostCents)).toEqual([0, 0]);
  });

  it("keeps exact order totals across separately rounded lines", () => {
    const input = snapshot();
    const tiny = { ...input.costs[0], unit_cost_cents: "0", total_cost_cents: "0", unit_cost_mills: "49", total_cost_mills: "49" };
    const report = buildOrderCOGSReport({ ...input, items: [...input.items, { ...input.items[0], id: 11 }],
      costs: [tiny, { ...tiny, order_item_id: 11 }] });
    expect(report).toMatchObject({ totalCogsCents: 1, totalCogsMills: "98" });
    expect(report.lineItems.map((line) => line.cogsCents)).toEqual([0, 0]);
  });

  it("refuses to combine foreign-currency revenue with USD inventory cost", () => {
    const input = snapshot();
    for (const currency of ["EUR", "CAD"]) {
      expect(() => buildOrderCOGSReport({ ...input, order: { ...input.order, currency } }))
        .toThrow(expect.objectContaining({ code: "ORDER_COGS_CURRENCY_UNSUPPORTED", currency }));
    }
  });

  it.each([[3, 1, 66.67], [3, 4, -33.33], [0, 1, 0], [20000, 20001, -0.01]])(
    "rounds percentages for revenue %i and cost %i independently of money", (revenue, cost, expected) => {
      const input = snapshot();
      const report = buildOrderCOGSReport({ ...input, order: { ...input.order, totalCents: revenue },
        items: [{ ...input.items[0], totalPriceCents: revenue }], costs: [{ ...input.costs[0], total_cost_cents: String(cost) }] });
      expect(report.marginPercent).toBe(expected);
      expect(report.lineItems[0].marginPercent).toBe(expected);
      expect(report.grossMarginCents).toBe(revenue - cost);
    },
  );
});
