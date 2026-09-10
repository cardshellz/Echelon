import { describe, expect, it } from "vitest";
import { CostReportResponseError, parseCostLotsReport, parseInventoryValuationReport } from "../cost-report-read";

const emptyValuation = {
  totalValueCents: 0, totalQty: 0, zeroCostQty: 0, provisionalQty: 0,
  landedPendingLots: 0, landedPendingValueCents: 0, byProduct: [],
};
const lot = {
  id: 1, lot_number: "TEST-LOT", product_id: 2, product_name: "Test product",
  base_sku: null, sku: "TEST-PACK", qty_on_hand: 2, qty_received: 2, units_per_variant: 100,
  po_unit_cost_mills: "350", landed_cost_mills: "25", total_unit_cost_mills: "375", unit_cost_mills: "375",
  po_unit_cost_cents: "4", landed_cost_cents: "0", total_unit_cost_cents: "4", unit_cost_cents: "4",
  cost_provisional: 0, cost_source: "manual",
};

describe("cost report response contracts", () => {
  it("accepts an explicit empty valuation and retains additive fields", () => {
    expect(parseInventoryValuationReport({ ...emptyValuation, revision: 2 })).toEqual({ ...emptyValuation, revision: 2 });
    expect(parseCostLotsReport({ lots: [], total: 0 })).toEqual({ lots: [], total: 0 });
  });

  it.each([
    null, {}, [], { ...emptyValuation, totalValueCents: null },
    { ...emptyValuation, totalValueCents: "0" },
    { ...emptyValuation, totalValueCents: 0.1 },
    { ...emptyValuation, totalValueCents: Number.MAX_SAFE_INTEGER + 1 },
    { ...emptyValuation, totalValueCents: 100 },
    { ...emptyValuation, totalQty: -1 }, { ...emptyValuation, byProduct: {} },
    { ...emptyValuation, byProduct: [{ productId: 1 }] },
    { ...emptyValuation, byProduct: [{ productId: 1, productName: "Test", baseSku: "TEST", totalQty: 0, avgCostPerPiece: 0,
      totalValueCents: 0.1, activeLots: 1, zeroCostQty: 0, hasLandedPending: false }] },
  ])("rejects incomplete or invalid valuation instead of inventing zero: %j", (input) => {
    expect(() => parseInventoryValuationReport(input)).toThrow(CostReportResponseError);
  });

  it("preserves exact BIGINT lot costs, signed credits, null amounts and recorded zero", () => {
    const input = { lots: [{ ...lot, total_unit_cost_mills: "9223372036854775807", landed_cost_mills: "-25", po_unit_cost_cents: null }], total: 1 };
    expect(parseCostLotsReport(input)).toEqual(input);
    expect(input.lots[0].po_unit_cost_cents).toBeNull();
  });

  it("accepts PostgreSQL and ISO timestamps without rewriting their date semantics", () => {
    for (const received_at of ["2026-09-01 12:00:00", "2026-09-01T12:00:00.000Z", new Date("2026-09-01T12:00:00Z")]) {
      expect(parseCostLotsReport({ lots: [{ ...lot, received_at }], total: 1 }).lots[0].received_at).toEqual(received_at);
    }
  });

  it("does not invent snapshot consistency between independently read count and page", () => {
    expect(parseCostLotsReport({ lots: [lot], total: 0 })).toEqual({ lots: [lot], total: 0 });
  });

  it.each([
    {}, { lots: [], total: null },
    { lots: [{ ...lot, product_id: null }], total: 1 },
    { lots: [{ ...lot, qty_on_hand: "2" }], total: 1 },
    { lots: [{ ...lot, unit_cost_mills: "not money" }], total: 1 },
    { lots: [{ ...lot, unit_cost_mills: "9223372036854775808" }], total: 1 },
    { lots: [{ ...lot, unit_cost_mills: 0.1 }], total: 1 },
    { lots: [{ ...lot, unit_cost_mills: undefined }], total: 1 },
  ])("rejects invalid lot pages before rendering: %j", (input) => {
    expect(() => parseCostLotsReport(input)).toThrow(CostReportResponseError);
  });
});
