import { describe, expect, it } from "vitest";
import { inspectPurchaseReceiptSupplyCapture } from "@shared/procurement/purchase-receipt-supply-evidence";
import { projectPurchasePlanningSupply, type PurchasePlanningOpenLine } from "../../purchase-planning-receipt-supply";
import type { PurchaseReceiptEvidence } from "../../purchase-receipt-quantity-evidence";
import { buildPurchaseSupplyTiming } from "../../purchase-supply-timing";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";

const line = (overrides: Partial<PurchasePlanningOpenLine> = {}): PurchasePlanningOpenLine => ({
  id: 11, purchaseOrderId: 1, purchaseOrderNumber: "PO-1", productId: 10,
  ordered: 100, received: 0, cancelled: 0, promisedDate: null, expectedDate: null,
  confirmedDate: null, purchaseExpectedDate: "2026-09-10", ...overrides,
});
const receipt = (overrides: Partial<PurchaseReceiptEvidence["receipts"][number]> = {}): PurchaseReceiptEvidence["receipts"][number] => ({
  id: 31, receivingOrderId: 3, purchaseOrderId: 1, purchaseOrderLineId: 11,
  shipmentId: null, shipmentLineId: null, received: 2, reversed: 0, units: 10, status: "closed", ...overrides,
});
const evidence = (overrides: Partial<Omit<PurchaseReceiptEvidence, "lines">> = {}): Omit<PurchaseReceiptEvidence, "lines"> => ({
  shipments: [], receipts: [], postings: [], reversals: [], ...overrides,
});
const posting = { receivingLineId: 31, receivingOrderId: 3, purchaseOrderId: 1, purchaseOrderLineId: 11, qtyReceived: 20 };
const position = (lines = [line()], input = evidence()) => projectPurchasePlanningSupply(lines, input).get(10)!;
const timing = (supply: ReturnType<typeof position>) => buildPurchaseSupplyTiming({
  asOfDate: "2026-09-01", availablePieces: 20, dailyPieces: 2, leadTimeDays: 60, safetyStockDays: 0,
  onOrderPieces: supply.on_order_pieces, rawSchedule: supply.inbound_schedule, rawReceiptEvidence: supply.receipt_supply_evidence,
});

describe("receipt-aware purchase planning supply", () => {
  it("replaces a lagging PO counter with closed physical receipts and leaves the input unchanged", () => {
    const input = evidence({ receipts: [receipt()] }); const before = structuredClone(input);
    expect(position([line()], input)).toMatchObject({ on_order_pieces: 80, open_po_count: 1,
      receipt_supply_evidence: { lines: [{ poReceivedPieces: 0, closedReceivedPieces: 20, remainingPieces: 80, receivingLineIds: [31], reviewIssues: [] }] } });
    expect(input).toEqual(before);
  });
  it("never subtracts both synced PO received quantity and its exact physical receipt", () => {
    expect(position([line({ received: 20 })], evidence({ receipts: [receipt()], postings: [posting] })).on_order_pieces).toBe(80);
  });
  it("uses net reversed receipt quantity with its atomic PO mirror and holds inconsistent history", () => {
    const input = evidence({ receipts: [receipt({ reversed: 1 })], postings: [posting],
      reversals: [{ id: 41, receivingLineId: 31, receivingOrderId: 3, qty: 1, baseUnitsReversed: 10 }] });
    expect(position([line({ received: 10 })], input)).toMatchObject({ on_order_pieces: 90,
      receipt_supply_evidence: { lines: [{ closedGrossReceivedPieces: 20, closedReceivedPieces: 10, reviewIssues: [] }] } });
    expect(timing(position([line({ received: 20 })], input))).toMatchObject({ signal: "unverified_receipts", reviewRequired: true });
  });
  it.each([null, 0, -1])("holds a receipt with unprovable frozen units %j for explicit review", (units) => {
    const supply = position([line()], evidence({ receipts: [receipt({ units })] }));
    expect(supply.on_order_pieces).toBe(100);
    expect(timing(supply)).toMatchObject({ signal: "unverified_receipts", reviewRequired: true, scheduleComplete: false, arrivals: [] });
    expect(timing(supply).detail).toContain("PO commitment is unresolved");
  });
  it("allows only the original exact posting to resolve legacy missing frozen units", () => {
    const input = evidence({ receipts: [receipt({ units: null })], postings: [posting] });
    expect(position([line({ received: 20 })], input).on_order_pieces).toBe(80);
    expect(input.receipts[0].units).toBeNull();
  });
  it.each([
    { postings: [{ ...posting, purchaseOrderLineId: 12 }] },
    { postings: [posting, posting] },
    { reversals: [{ id: 41, receivingLineId: 31, receivingOrderId: 3, qty: 1, baseUnitsReversed: 9 }] },
  ])("does not guess through conflicting original or reversal evidence: %j", (changes) => {
    const input = evidence({ receipts: [receipt({ reversed: changes.reversals ? 1 : 0 })], ...changes });
    expect(timing(position([line()], input)).signal).toBe("unverified_receipts");
  });
  it("preserves a visibly unresolved mirror when some older closed receipt history is missing", () => {
    const supply = position([line({ received: 50 })], evidence({ receipts: [receipt()] }));
    expect(supply.on_order_pieces).toBe(50);
    expect(supply.receipt_supply_evidence.lines[0].reviewIssues).toContain("The PO records 50 received pieces, but exact posted receipt/reversal evidence supports 0. Unposted physical receipts cannot resolve missing PO history.");
  });
  it("does not let a larger new unposted receipt conceal missing historical posted evidence", () => {
    const supply = position([line({ ordered: 1000, received: 100 })], evidence({ receipts: [receipt({ received: 20 })] }));
    expect(supply.on_order_pieces).toBe(900);
    expect(timing(supply)).toMatchObject({ signal: "unverified_receipts", reviewRequired: true });
    expect(supply.receipt_supply_evidence.lines[0].postedReceivedPieces).toBe(0);
  });
  it("flags unlinked receipt history even when the old remaining commitment is zero", () => {
    const supply = position([line({ received: 100 })], evidence({ receipts: [receipt({ purchaseOrderLineId: null })] }));
    expect(supply).toMatchObject({ on_order_pieces: 0, open_po_count: 0 });
    expect(timing(supply)).toMatchObject({ signal: "unverified_receipts", reviewRequired: true });
  });
  it("sums split receipts exactly once and counts one PO independently of its lines", () => {
    const input = evidence({ receipts: [receipt(), receipt({ id: 32, receivingOrderId: 4, received: 3 }), receipt({ id: 33, receivingOrderId: 5, purchaseOrderLineId: 12, received: 1 })] });
    const supply = position([line(), line({ id: 12, ordered: 40 })], input);
    expect(supply).toMatchObject({ on_order_pieces: 80, open_po_count: 1 });
    expect(supply.inbound_schedule.map((row) => row.remainingPieces)).toEqual([50, 30]);
  });
  it("does not include fully physically received pieces while the PO still says open", () => {
    const supply = position([line()], evidence({ receipts: [receipt({ received: 10 })] }));
    expect(supply).toMatchObject({ on_order_pieces: 0, open_po_count: 0, earliest_expected: null, inbound_schedule: [] });
    expect(timing(supply)).toMatchObject({ signal: "no_open_supply", reviewRequired: false });
  });
  it("flags physical overreceipt and cancellations without inventing negative remaining supply", () => {
    expect(timing(position([line({ cancelled: 90 })], evidence({ receipts: [receipt()] })))).toMatchObject({ signal: "unverified_receipts", reviewRequired: true });
  });
  it("credits only exact shipment-line receipt identities", () => {
    const input = evidence({ receipts: [receipt({ shipmentId: 7, shipmentLineId: 111 })],
      shipments: [{ id: 111, shipmentId: 7, purchaseOrderId: 1, purchaseOrderLineId: 11 }] });
    expect(position([line()], input).on_order_pieces).toBe(80);
    expect(timing(position([line()], { ...input, receipts: [receipt({ shipmentId: 8, shipmentLineId: 111 })] })).signal).toBe("unverified_receipts");
  });
  it("rejects duplicate source identities, invalid calendar dates and fractional quantities", () => {
    expect(() => position([line(), line()])).toThrow(/Duplicate/);
    expect(() => position([line({ promisedDate: "2026-02-30" })])).toThrow();
    expect(() => position([line({ ordered: 1.5 })])).toThrow();
  });

  it.each([
    [{ promisedDate: "2026-11-01", expectedDate: "2026-10-01", confirmedDate: "2026-10-15" }, "2026-11-01", "line_promised"],
    [{ expectedDate: "2026-10-01", confirmedDate: "2026-10-15" }, "2026-10-01", "line_expected"],
    [{ confirmedDate: "2026-10-15" }, "2026-10-15", "purchase_confirmed"],
    [{}, "2026-09-10", "purchase_expected"],
    [{ purchaseExpectedDate: null }, null, null],
  ] as const)("selects documented arrival precedence for %j", (changes, expectedDate, expectedDateSource) => {
    expect(position([line(changes)]).inbound_schedule[0]).toMatchObject({ expectedDate, expectedDateSource });
  });
  it("exposes the stockout gap when confirmed arrival is later than the original request", () => {
    expect(timing(position())).toMatchObject({ signal: "scheduled", firstGapDate: null });
    expect(timing(position([line({ confirmedDate: "2026-10-15" })]))).toMatchObject({ signal: "arrival_gap", firstGapDate: "2026-09-11", reviewRequired: true });
  });
  it("marks zero-buy results for manual review and blocks unattended drafting rather than asserting healthy coverage", () => {
    const supply = position([line()], evidence({ receipts: [receipt({ units: null })] }));
    const result = generatePurchasingRecommendations({ lookbackDays: 30, asOf: "2026-09-01T00:00:00Z", rows: [{
      product_id: 10, variant_id: 101, base_sku: "TEST-10", product_name: "Receipt review test", total_pieces: 20,
      total_reserved_pieces: 0, total_outbound_pieces: 60, previous_outbound_pieces: 60, demand_order_count: 12, demand_active_days: 10,
      latest_demand_at: "2026-08-31", vendor_product_id: 71, preferred_vendor_id: 7, lead_time_days: 60, safety_stock_days: 0, ...supply,
    }] });
    expect(result.items[0]).toMatchObject({ suggestedOrderPieces: 0, reviewSignal: { label: "Review receipt evidence" }, qualityGate: { autoDraftEligible: false },
      autopilotBlockers: expect.arrayContaining([expect.objectContaining({ area: "inbound_supply", code: "unverified_receipts", severity: "block" })]) });
    expect(result.summary.autoDraftReviewRequiredCount).toBe(1);
  });
  it("distinguishes a verified empty capture from absent or tampered historical evidence", () => {
    expect(inspectPurchaseReceiptSupplyCapture({ version: 1, lines: [] }, 0)).toMatchObject({ reviewRequired: false });
    expect(inspectPurchaseReceiptSupplyCapture(undefined, 0)).toMatchObject({ reviewRequired: true });
    expect(inspectPurchaseReceiptSupplyCapture(position().receipt_supply_evidence, 99)).toMatchObject({ reviewRequired: true });
    const capture = position().receipt_supply_evidence; capture.lines[0].closedReceivedPieces = 20;
    expect(inspectPurchaseReceiptSupplyCapture(capture, 100)).toMatchObject({ reviewRequired: true });
  });
});
