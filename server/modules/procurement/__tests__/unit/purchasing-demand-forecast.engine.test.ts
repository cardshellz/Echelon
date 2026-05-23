import { describe, expect, it } from "vitest";
import {
  buildPurchasingDemandForecastBasis,
  buildPurchasingDemandForecastWindowDiagnostics,
} from "../../purchasing-demand-forecast.engine";

describe("purchasing demand forecast engine", () => {
  it("builds an auditable recent-order velocity forecast basis", () => {
    const basis = buildPurchasingDemandForecastBasis({
      lookbackDays: 30,
      periodUsagePieces: 90,
      priorPeriodUsagePieces: 75,
      demandOrderCount: 18,
      demandActiveDays: 12,
      latestDemandAt: "2026-05-18T12:00:00.000Z",
      paidDemandPieces: 80,
      zeroRevenueDemandPieces: 10,
      couponDiscountDemandPieces: 15,
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
      paidDemandPieces: 80,
      zeroRevenueDemandPieces: 10,
      couponDiscountDemandPieces: 15,
      zeroRevenueDemandShare: 0.11,
      couponDiscountDemandShare: 0.17,
      demandMixSignal: "mixed_discounted_or_free",
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

  it("compares short-window demand against the standard forecast without changing the basis", () => {
    const standardWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 30,
      periodUsagePieces: 60,
      priorPeriodUsagePieces: 55,
      demandOrderCount: 18,
      demandActiveDays: 12,
    });
    const shortWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 7,
      periodUsagePieces: 35,
      priorPeriodUsagePieces: 14,
      demandOrderCount: 9,
      demandActiveDays: 6,
    });

    expect(buildPurchasingDemandForecastWindowDiagnostics({ standardWindow, shortWindow })).toEqual({
      standardWindow: {
        label: "standard",
        ...standardWindow,
      },
      shortWindow: {
        label: "short",
        ...shortWindow,
      },
      longWindow: {
        label: "long",
        ...standardWindow,
      },
      accelerationRatio: 2.5,
      accelerationSignal: "accelerating",
      baselineRatio: 1,
      baselineSignal: "near_baseline",
      seasonalRatio: null,
      seasonalSignal: "not_available",
    });
  });

  it("compares the standard forecast against a longer baseline without changing the basis", () => {
    const standardWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 30,
      periodUsagePieces: 120,
      priorPeriodUsagePieces: 90,
      demandOrderCount: 24,
      demandActiveDays: 18,
    });
    const shortWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 7,
      periodUsagePieces: 28,
      priorPeriodUsagePieces: 21,
      demandOrderCount: 8,
      demandActiveDays: 5,
    });
    const longWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 90,
      periodUsagePieces: 180,
      priorPeriodUsagePieces: 210,
      demandOrderCount: 45,
      demandActiveDays: 30,
    });

    expect(
      buildPurchasingDemandForecastWindowDiagnostics({
        standardWindow,
        shortWindow,
        longWindow,
      }),
    ).toMatchObject({
      longWindow: {
        label: "long",
        lookbackDays: 90,
        avgDailyUsagePieces: 2,
        demandQuality: "normal",
        demandTrend: "stable",
      },
      baselineRatio: 2,
      baselineSignal: "above_baseline",
      seasonalSignal: "not_available",
    });
  });

  it("compares the standard forecast against the same seasonal window last year", () => {
    const standardWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 30,
      periodUsagePieces: 90,
      priorPeriodUsagePieces: 80,
      demandOrderCount: 20,
      demandActiveDays: 15,
    });
    const shortWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 7,
      periodUsagePieces: 21,
      priorPeriodUsagePieces: 14,
      demandOrderCount: 7,
      demandActiveDays: 5,
    });
    const longWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 90,
      periodUsagePieces: 270,
      priorPeriodUsagePieces: 240,
      demandOrderCount: 45,
      demandActiveDays: 30,
    });
    const seasonalWindow = buildPurchasingDemandForecastBasis({
      lookbackDays: 30,
      periodUsagePieces: 45,
      priorPeriodUsagePieces: 50,
      demandOrderCount: 12,
      demandActiveDays: 9,
    });

    expect(
      buildPurchasingDemandForecastWindowDiagnostics({
        standardWindow,
        shortWindow,
        longWindow,
        seasonalWindow,
      }),
    ).toMatchObject({
      seasonalWindow: {
        label: "seasonal",
        lookbackDays: 30,
        avgDailyUsagePieces: 1.5,
        demandQuality: "normal",
        demandTrend: "stable",
      },
      seasonalRatio: 2,
      seasonalSignal: "above_seasonal",
    });
  });

  it("keeps zero-revenue demand in usage while surfacing demand mix provenance", () => {
    const basis = buildPurchasingDemandForecastBasis({
      lookbackDays: 30,
      periodUsagePieces: 100,
      priorPeriodUsagePieces: 60,
      demandOrderCount: 12,
      demandActiveDays: 8,
      paidDemandPieces: 40,
      zeroRevenueDemandPieces: 60,
      couponDiscountDemandPieces: 70,
    });

    expect(basis).toMatchObject({
      periodUsagePieces: 100,
      avgDailyUsagePieces: 100 / 30,
      paidDemandPieces: 40,
      zeroRevenueDemandPieces: 60,
      couponDiscountDemandPieces: 70,
      zeroRevenueDemandShare: 0.6,
      couponDiscountDemandShare: 0.7,
      demandMixSignal: "mostly_zero_revenue",
    });
  });
});
