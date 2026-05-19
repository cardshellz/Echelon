import { describe, expect, it } from "vitest";
import { buildPurchasingDemandForecastBasis } from "../../purchasing-demand-forecast.engine";

describe("purchasing demand forecast engine", () => {
  it("builds an auditable recent-order velocity forecast basis", () => {
    const basis = buildPurchasingDemandForecastBasis({
      lookbackDays: 30,
      periodUsagePieces: 90,
      priorPeriodUsagePieces: 75,
      demandOrderCount: 18,
      demandActiveDays: 12,
      latestDemandAt: "2026-05-18T12:00:00.000Z",
    });

    expect(basis).toEqual({
      method: "recent_order_velocity_v1",
      version: 1,
      demandSource: "recent_order_velocity",
      lookbackDays: 30,
      periodUsagePieces: 90,
      priorPeriodUsagePieces: 75,
      avgDailyUsagePieces: 3,
      demandQuality: "normal",
      demandTrend: "stable",
      demandOrderCount: 18,
      demandActiveDays: 12,
      latestDemandAt: "2026-05-18T12:00:00.000Z",
    });
  });

  it("classifies no recent demand separately from thin history", () => {
    expect(
      buildPurchasingDemandForecastBasis({
        lookbackDays: 30,
        periodUsagePieces: 0,
        priorPeriodUsagePieces: 25,
        demandOrderCount: 0,
        demandActiveDays: 0,
      }),
    ).toMatchObject({
      avgDailyUsagePieces: 0,
      demandQuality: "no_recent_demand",
      demandTrend: "no_recent_demand",
    });

    expect(
      buildPurchasingDemandForecastBasis({
        lookbackDays: 30,
        periodUsagePieces: 2,
        priorPeriodUsagePieces: 0,
        demandOrderCount: 1,
        demandActiveDays: 1,
      }),
    ).toMatchObject({
      demandQuality: "thin_history",
      demandTrend: "new_demand",
    });
  });

  it("classifies material trend changes against the prior lookback window", () => {
    expect(
      buildPurchasingDemandForecastBasis({
        lookbackDays: 30,
        periodUsagePieces: 150,
        priorPeriodUsagePieces: 75,
        demandOrderCount: 20,
        demandActiveDays: 10,
      }).demandTrend,
    ).toBe("rising");

    expect(
      buildPurchasingDemandForecastBasis({
        lookbackDays: 30,
        periodUsagePieces: 40,
        priorPeriodUsagePieces: 100,
        demandOrderCount: 20,
        demandActiveDays: 10,
      }).demandTrend,
    ).toBe("falling");
  });

  it("normalizes invalid inputs without hiding forecast provenance", () => {
    const basis = buildPurchasingDemandForecastBasis({
      lookbackDays: "0",
      periodUsagePieces: "10",
      priorPeriodUsagePieces: "",
      demandOrderCount: "5",
      demandActiveDays: "3",
    });

    expect(basis).toMatchObject({
      method: "recent_order_velocity_v1",
      lookbackDays: 30,
      periodUsagePieces: 10,
      priorPeriodUsagePieces: null,
      avgDailyUsagePieces: 10 / 30,
      demandQuality: "normal",
      demandTrend: "not_available",
      demandOrderCount: 5,
      demandActiveDays: 3,
    });
  });
});
