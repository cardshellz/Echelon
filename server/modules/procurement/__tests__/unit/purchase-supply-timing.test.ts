import { describe, expect, it } from "vitest";
import { buildPurchaseSupplyTiming } from "../../purchase-supply-timing";

const base = { asOfDate: "2026-09-01", availablePieces: 100, dailyPieces: 10, leadTimeDays: 30, safetyStockDays: 5, onOrderPieces: 300 };
const arrival = (id: number, remainingPieces: number, expectedDate: string | null) => ({ purchaseOrderId: id, purchaseOrderNumber: `PO-${id}`, purchaseOrderLineId: id, remainingPieces, expectedDate });

describe("purchase arrival timing", () => {
  it("keeps dates deterministic with an injected calendar date", () => {
    expect(buildPurchaseSupplyTiming({ ...base, onOrderPieces: 0, rawSchedule: [] })).toMatchObject({
      stockoutDateWithoutReceipts: "2026-09-11", orderByDateWithoutReceipts: "2026-08-07", newOrderArrivalDate: "2026-10-01",
      signal: "no_open_supply", reviewRequired: false,
    });
  });
  it("validates a continuous chain of partial PO arrivals instead of pooling the earliest ETA", () => {
    expect(buildPurchaseSupplyTiming({ ...base, rawSchedule: [arrival(1, 100, "2026-09-10"), arrival(2, 200, "2026-09-19")] })).toMatchObject({ signal: "scheduled", reviewRequired: false, firstGapDate: null, scheduledWithinCyclePieces: 300 });
    expect(buildPurchaseSupplyTiming({ ...base, rawSchedule: [arrival(1, 100, "2026-09-10"), arrival(2, 200, "2026-09-25")] })).toMatchObject({ signal: "arrival_gap", reviewRequired: true, firstGapDate: "2026-09-21" });
  });
  it("does not consider overdue, undated, or beyond-cycle quantities dependable coverage", () => {
    expect(buildPurchaseSupplyTiming({ ...base, rawSchedule: [arrival(1, 100, "2026-08-31"), arrival(2, 100, null), arrival(3, 100, "2026-12-01")] })).toMatchObject({ signal: "unverified_schedule", reviewRequired: true, pastDuePieces: 100, undatedPieces: 100, beyondCyclePieces: 100, scheduledWithinCyclePieces: 0 });
  });
  it.each([
    undefined,
    [arrival(1, 200, "2026-09-10")],
    [arrival(1, 150, "2026-09-10"), arrival(1, 150, "2026-09-11")],
    [arrival(1, -300, "2026-09-10")],
    [arrival(1, 300, "2026-02-30")],
    [{ ...arrival(1, 300, "2026-09-10"), remainingPieces: "300" }],
  ])("marks incomplete or corrupt source schedules for review: %j", (rawSchedule) => {
    expect(buildPurchaseSupplyTiming({ ...base, rawSchedule })).toMatchObject({ scheduleComplete: false, reviewRequired: true, signal: "unverified_schedule", arrivals: [] });
  });
  it("includes dated lumpy demand before assuming scheduled supply is sufficient", () => {
    const result = buildPurchaseSupplyTiming({ ...base, availablePieces: 200, rawSchedule: [arrival(1, 300, "2026-09-15")], forwardDemand: { pieces: 180, captureComplete: true, events: [{ eventStartDate: "2026-09-06", weightedPieces: 180 }] } });
    expect(result).toMatchObject({ signal: "arrival_gap", firstGapDate: "2026-09-06", reviewRequired: true });
  });
  it("requires dated evidence for a positive event total even without any open POs", () => {
    expect(buildPurchaseSupplyTiming({ ...base, onOrderPieces: 0, rawSchedule: [], forwardDemand: { pieces: 30, captureComplete: false, events: [] } })).toMatchObject({ signal: "unverified_demand_events", reviewRequired: true });
  });
  it("requires zero aggregate quantities to reconcile with nonzero detail", () => {
    expect(buildPurchaseSupplyTiming({ ...base, onOrderPieces: 0, rawSchedule: [arrival(1, 300, "2026-09-10")] })).toMatchObject({ scheduleComplete: false, reviewRequired: true, signal: "unverified_schedule" });
    expect(buildPurchaseSupplyTiming({ ...base, onOrderPieces: 0, rawSchedule: [], forwardDemand: { pieces: 0, captureComplete: true, events: [{ eventStartDate: "2026-09-10", weightedPieces: 20 }] } })).toMatchObject({ reviewRequired: true, signal: "unverified_demand_events", stockoutDateWithoutReceipts: null });
  });
  it("supports zero demand and same-day receipts without fabricated stockout dates", () => {
    expect(buildPurchaseSupplyTiming({ ...base, dailyPieces: 0, rawSchedule: [arrival(1, 300, "2026-09-01")] })).toMatchObject({ stockoutDateWithoutReceipts: null, orderByDateWithoutReceipts: null, firstGapDate: null, reviewRequired: false });
  });
  it("does not mutate the arrival evidence", () => {
    const rawSchedule = Object.freeze([Object.freeze(arrival(2, 200, "2026-09-19")), Object.freeze(arrival(1, 100, "2026-09-10"))]);
    const result = buildPurchaseSupplyTiming({ ...base, rawSchedule });
    expect(result.arrivals.map((row) => row.purchaseOrderLineId)).toEqual([1, 2]);
    expect(rawSchedule[0].purchaseOrderLineId).toBe(2);
  });
  it("rejects invalid clocks, fractional quantities, and unbounded lead times", () => {
    expect(() => buildPurchaseSupplyTiming({ ...base, asOfDate: "2026-02-30", rawSchedule: [] })).toThrow();
    expect(() => buildPurchaseSupplyTiming({ ...base, onOrderPieces: 1.5, rawSchedule: [] })).toThrow();
    expect(() => buildPurchaseSupplyTiming({ ...base, leadTimeDays: Number.MAX_SAFE_INTEGER, rawSchedule: [] })).toThrow(/calendar range/);
  });
});
