import { describe, expect, it } from "vitest";
import { projectReplacementForecast, purchaseReplacementForecastsSchema } from "@shared/procurement/purchase-replacement-forecast";
import { buildPurchaseSupplyTiming } from "../../purchase-supply-timing";

const range = { productId: 10, startDate: "2026-09-01", endDate: "2026-09-30", totalPieces: 600, reference: "September plan" };
const project = (fromDate: string, days: number, ranges = [range]) => projectReplacementForecast({ productId: 10, fromDate, days, ranges, baselineDailyMicros: 10_000_000 });

describe("explicit replacement forecast intervals", () => {
  it("replaces baseline within dates while retaining the surrounding baseline", () => {
    expect(project("2026-09-01", 30).totalMicros).toBe(600_000_000);
    expect(project("2026-08-31", 32).totalMicros).toBe(620_000_000);
    expect(project("2026-10-01", 7).totalMicros).toBe(70_000_000);
    expect(project("2026-09-01", 7, [{ ...range, productId: 11 }]).totalMicros).toBe(70_000_000);
  });
  it("conserves odd totals over partial periods and leap-day boundaries", () => {
    const odd = [{ ...range, startDate: "2028-02-28", endDate: "2028-03-01", totalPieces: 1 }];
    const days = ["2028-02-28", "2028-02-29", "2028-03-01"].map((date) => project(date, 1, odd).totalMicros);
    expect(days).toEqual([333_333, 333_333, 333_334]);
    expect(days.reduce((sum, value) => sum + value, 0)).toBe(project("2028-02-28", 3, odd).totalMicros);
  });
  it("supports an explicit zero forecast and does not reapply uniform growth", () => {
    expect(project("2026-09-01", 30, [{ ...range, totalPieces: 0 }]).totalMicros).toBe(0);
    expect(projectReplacementForecast({ productId: 10, fromDate: range.startDate, days: 30, ranges: [range], baselineDailyMicros: 99_000_000 }).totalMicros).toBe(600_000_000);
  });
  it("captures source and replaced baseline without mutating the ranges", () => {
    const input = Object.freeze([Object.freeze(range)]);
    const result = projectReplacementForecast({ productId: 10, fromDate: "2026-09-11", days: 10, ranges: input, baselineDailyMicros: 10_000_000 });
    expect(result.contributions[0]).toMatchObject({ reference: "September plan", totalPieces: 600, intervalStartDate: "2026-09-11", intervalEndExclusive: "2026-09-21", replacedBaselineMicros: 100_000_000, replacementMicros: 200_000_000 });
    expect(input[0]).toEqual(range);
  });
  it.each([
    [{ ...range, startDate: "2026-02-30" }],
    [{ ...range, endDate: "2026-08-31" }],
    [{ ...range, totalPieces: -1 }],
    [{ ...range, totalPieces: "600" }],
    [{ ...range, reference: " " }],
    [{ ...range, startDate: "9999-12-01", endDate: "9999-12-31" }],
    [range, { ...range, startDate: "2026-09-30", endDate: "2026-10-31" }],
  ])("rejects invalid or overlapping ranges: %j", (ranges) => {
    expect(purchaseReplacementForecastsSchema.safeParse(ranges).success).toBe(false);
  });
  it("uses the replacement demand in the receipt sequence and the order-by calculation", () => {
    const result = buildPurchaseSupplyTiming({ asOfDate: "2026-09-01", availablePieces: 100, dailyPieces: 10,
      leadTimeDays: 30, safetyStockDays: 5, onOrderPieces: 600,
      replacementForecasts: { productId: 10, ranges: [range] },
      rawSchedule: [{ purchaseOrderId: 1, purchaseOrderNumber: "PO-1", purchaseOrderLineId: 11, remainingPieces: 600, expectedDate: "2026-09-10" }],
      forwardDemand: { pieces: 40, captureComplete: true, events: [{ eventStartDate: "2026-09-03", weightedPieces: 40 }] },
    });
    expect(result).toMatchObject({ firstGapDate: "2026-09-04", stockoutDateWithoutReceipts: "2026-09-04", orderByDateWithoutReceipts: "2026-07-31", reviewRequired: true });
  });
  it("validates product identity and supports valid distant calendar ranges", () => {
    expect(() => projectReplacementForecast({ productId: 0, fromDate: range.startDate, days: 1, ranges: [range], baselineDailyMicros: 1 })).toThrow();
    const future = { ...range, startDate: "3000-01-01", endDate: "3000-01-30", totalPieces: 30 };
    const result = buildPurchaseSupplyTiming({ asOfDate: "2026-09-01", availablePieces: 0, dailyPieces: 0,
      leadTimeDays: 30, safetyStockDays: 0, onOrderPieces: 0, rawSchedule: [], replacementForecasts: { productId: 10, ranges: [future] } });
    expect(result.stockoutDateWithoutReceipts).toBe("3000-01-01");
  });
  it("can forecast a launch with zero historical demand", () => {
    const result = buildPurchaseSupplyTiming({ asOfDate: "2026-09-01", availablePieces: 100, dailyPieces: 0,
      leadTimeDays: 30, safetyStockDays: 0, onOrderPieces: 0, rawSchedule: [], replacementForecasts: { productId: 10, ranges: [range] } });
    expect(result.stockoutDateWithoutReceipts).toBe("2026-09-06");
  });
});
