import { describe, expect, it, vi } from "vitest";
import {
  buildPurchaseRecommendationRunInput,
  createPurchaseRecommendationSnapshotService,
} from "../../purchase-recommendation-snapshot.service";
import {
  buildPurchasingForecastPolicyCohort,
  DEFAULT_PURCHASING_FORECAST_POLICY,
} from "../../purchasing-forecast-policy";
import type { PurchasingRecommendationItem } from "../../purchasing-recommendation.engine";

function recommendation(overrides: Partial<PurchasingRecommendationItem> = {}): PurchasingRecommendationItem {
  return {
    recommendationId: "10:100:30",
    productId: 10,
    productVariantId: 100,
    sku: "SKU-10",
    productName: "Product 10",
    suggestedOrderPieces: 48,
    status: "order_now",
    skippedReason: null,
    available: 2,
    onOrderPieces: 0,
    reorderPoint: 50,
    avgDailyUsage: 4,
    leadTimeDays: 10,
    safetyStockDays: 3,
    preferredVendorId: null,
    preferredVendorName: null,
    currentSupply: { effectiveSupplyPieces: 2 },
    supplierBasis: { vendorProductId: null },
    demandBasis: {
      lookbackDays: 30,
      periodUsagePieces: 120,
      avgDailyUsagePieces: 4,
      forecastTrust: { signal: "trusted" },
    },
    forecastProvenance: {
      forecastMethod: "weighted_blend_v1",
      forecastVersion: 2,
      demandWindowDays: 30,
      forecastBlend: { avgDailyUsagePieces: 4 },
      demandWindowDiagnostics: { standardWindow: { avgDailyUsagePieces: 4 } },
      planningPolicy: DEFAULT_PURCHASING_FORECAST_POLICY,
      forecastTrust: { signal: "trusted" },
    },
    forwardDemandBasis: {
      forwardDemandPieces: 8,
      forwardDemandRawPieces: 10,
      forwardDemandEventCount: 1,
      adjustedReorderPoint: 58,
      overlayCaptureVersion: 2,
      overlayCaptureComplete: true,
      overlayPlanningAsOfDate: "2026-07-17",
      overlayHorizonDays: 90,
      contributions: [{
        productId: 10,
        productVariantId: 100,
        demandEventId: 700,
        demandEventLineId: 701,
        eventName: "Launch",
        eventType: "drop",
        eventStatus: "planned",
        eventStartDate: "2026-07-25",
        eventEndDate: null,
        planningAsOfDate: "2026-07-17",
        expectedPieces: 10,
        confidence: "high",
        confidenceWeightPercent: 80,
        weightedPieces: 8,
        eventUpdatedAt: "2026-07-16T12:00:00.000Z",
        lineUpdatedAt: "2026-07-16T12:05:00.000Z",
      }],
    },
    ...overrides,
  } as PurchasingRecommendationItem;
}

describe("purchase recommendation snapshot service", () => {
  it("builds a source-attributed run including requirements that still need a supplier", () => {
    const input = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [], skippedItems: [recommendation({ skippedReason: "no_vendor" })], summary: { actionableCount: 1 } },
      settings: { autoDraftMode: "review_only", skipNoVendor: true },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      source: "auto_draft",
      sourceRunKey: "501",
      evaluatedCount: 1,
    });

    expect(input).toMatchObject({
      source: "auto_draft",
      sourceRunKey: "501",
      lookbackDays: 30,
      inputSummary: {
        candidateCount: 1,
        evaluatedCount: 1,
        observationCount: 1,
        observationCoverageComplete: true,
        overlayCaptureComplete: true,
        overlayCoverageComplete: true,
        overlayContributionCount: 1,
      },
      lines: [{
        recommendationKey: "10:100:30",
        recommendedPieces: 48,
        preferredVendorId: null,
        evidenceSnapshot: {
          forecastMethod: "weighted_blend_v1",
          forwardDemandPieces: 8,
        },
      }],
      observations: [{
        observationKey: "10:product_all_warehouses",
        productId: 10,
        selectedReceiveVariantId: 100,
        scope: "product_all_warehouses",
        forecastMethod: "weighted_blend_v1",
        forecastVersion: 2,
        forecastPolicyCaptureVersion: 1,
        forecastPolicyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        forecastPolicySnapshot: {
          method: "weighted_blend_v1",
          shortWindowDays: 7,
          standardWindowDays: 30,
          longWindowDays: 90,
        },
        forecastDailyPiecesMicros: 4_000_000,
        baselineDailyPiecesMicros: 4_000_000,
        forwardDemandPieces: 8,
        forwardDemandRawPieces: 10,
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2026-07-17",
        overlayHorizonDays: 90,
        overlayContributions: [{
          demandEventId: 700,
          demandEventLineId: 701,
          weightedPieces: 8,
        }],
      }],
    });
  });

  it("does not double-count skipped recommendations that are also visible", () => {
    const skipped = recommendation({ skippedReason: "no_vendor" });
    const input = buildPurchaseRecommendationRunInput({
      recommendationResult: {
        items: [skipped],
        skippedItems: [skipped],
        summary: { totalProducts: 1 },
      },
      settings: { autoDraftMode: "review_only", skipNoVendor: true },
      lookbackDays: 30,
      asOf: new Date("2026-07-20T12:00:00.000Z"),
      source: "manual",
    });

    expect(input.inputSummary).toMatchObject({ candidateCount: 1, evaluatedCount: 1 });
    expect(input.observations).toHaveLength(1);
  });

  it("rejects a recommendation run containing multiple executed forecast policy cohorts", () => {
    const changedPolicy = {
      ...DEFAULT_PURCHASING_FORECAST_POLICY,
      weights: { short: 40, standard: 30, long: 20, seasonal: 10 },
    };
    const second = recommendation({
      recommendationId: "11:101:30",
      productId: 11,
      productVariantId: 101,
      sku: "SKU-11",
      forecastProvenance: {
        ...recommendation().forecastProvenance,
        planningPolicy: changedPolicy,
      },
    });

    expect(() => buildPurchaseRecommendationRunInput({
      recommendationResult: {
        items: [recommendation(), second],
        skippedItems: [],
        summary: { totalProducts: 2 },
      },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-20T12:00:00.000Z"),
    })).toThrow("multiple forecast policy cohorts");
  });

  it("rejects a forecast method that disagrees with its executed planning policy", () => {
    const mismatched = recommendation({
      forecastProvenance: {
        ...recommendation().forecastProvenance,
        planningPolicy: {
          ...DEFAULT_PURCHASING_FORECAST_POLICY,
          method: "recent_order_velocity_v1",
        },
      },
    });

    expect(() => buildPurchaseRecommendationRunInput({
      recommendationResult: {
        items: [mismatched],
        skippedItems: [],
        summary: { totalProducts: 1 },
      },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-20T12:00:00.000Z"),
    })).toThrow("forecast method does not match");
  });

  it("captures non-purchasing products without turning them into sourcing lines", () => {
    const healthy = recommendation({
      recommendationId: "11:101:30",
      productId: 11,
      productVariantId: 101,
      sku: "SKU-11",
      productName: "Product 11",
      suggestedOrderPieces: 0,
      status: "healthy",
      skippedReason: "not_actionable_status",
      actionable: false,
      avgDailyUsage: 2.345678,
      demandBasis: {
        ...recommendation().demandBasis,
        periodUsagePieces: 60,
        avgDailyUsagePieces: 2.345678,
      },
      forecastProvenance: {
        ...recommendation().forecastProvenance,
        forecastBlend: { avgDailyUsagePieces: 2.345678 },
      },
    });
    const input = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [healthy], skippedItems: [healthy], summary: { totalProducts: 1 } },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-20T12:00:00.000Z"),
    });

    expect(input.lines).toEqual([]);
    expect(input.observations).toHaveLength(1);
    expect(input.observations?.[0]).toMatchObject({
      productId: 11,
      selectedReceiveVariantId: 101,
      forecastDailyPiecesMicros: 2_345_678,
      baselineDailyPiecesMicros: 2_000_000,
    });
  });

  it("rejects an invalid explicit evaluated count", () => {
    expect(() => buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-20T12:00:00.000Z"),
      evaluatedCount: -1,
    })).toThrow("evaluatedCount must be a non-negative integer");
  });

  it("fails closed when the evaluated population is not fully observed", () => {
    expect(() => buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-20T12:00:00.000Z"),
      evaluatedCount: 2,
    })).toThrow("Forecast observation coverage is incomplete: expected 2, captured 1");
  });

  it.each(["auto_draft", "scheduled"] as const)(
    "requires a durable source key for %s runs",
    async (source) => {
      const service = createPurchaseRecommendationSnapshotService({ select: vi.fn(), transaction: vi.fn() });
      await expect(service.createRun({
        calculationVersion: "v2",
        source,
        asOf: new Date(),
        lookbackDays: 30,
        policySnapshot: {},
        lines: [],
      })).rejects.toThrow("sourceRunKey is required");
    },
  );

  it("writes a run and all recommendation lines in one transaction", async () => {
    const run = { id: 91, source: "manual", sourceRunKey: null };
    const insert = vi.fn((table: unknown) => ({
      values: vi.fn((values: any) => ({
        returning: vi.fn().mockResolvedValue(Array.isArray(values)
          ? values.map((value, index) => ({ id: index + 100, ...value }))
          : [run]),
      })),
    }));
    const database = {
      select: vi.fn(),
      transaction: vi.fn(async (work: (tx: any) => unknown) => work({ insert })),
    };
    const service = createPurchaseRecommendationSnapshotService(database);
    const policyCohort = buildPurchasingForecastPolicyCohort();
    const result = await service.createRun({
      calculationVersion: "v2",
      source: "manual",
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [{
        recommendationKey: "10:100:30",
        productId: 10,
        productVariantId: 100,
        sku: "SKU-10",
        productName: "Product 10",
        recommendedPieces: 48,
        evidenceSnapshot: { demand: "saved" },
      }],
      observations: [{
        observationKey: "10:product_all_warehouses",
        productId: 10,
        selectedReceiveVariantId: 100,
        scope: "product_all_warehouses",
        productSku: "SKU-10",
        productName: "Product 10",
        forecastMethod: "weighted_blend_v1",
        forecastVersion: 2,
        forecastPolicyCaptureVersion: policyCohort.captureVersion,
        forecastPolicyFingerprint: policyCohort.fingerprint,
        forecastPolicySnapshot: policyCohort.snapshot,
        forecastDailyPiecesMicros: 4_000_000,
        baselineDailyPiecesMicros: 4_000_000,
        forwardDemandPieces: 8,
        forwardDemandRawPieces: 10,
        evidenceSnapshot: { forecast: "saved" },
      }],
    }, "buyer-1");

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ run: { id: 91 }, reused: false });
    expect(result.lines).toHaveLength(1);
    expect(result.observations).toHaveLength(1);
    expect(result.overlayContributions).toEqual([]);
  });

  it("rejects a forecast policy fingerprint that does not match its canonical snapshot", async () => {
    const database = { select: vi.fn(), transaction: vi.fn() };
    const service = createPurchaseRecommendationSnapshotService(database);
    const observation = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
    }).observations![0];

    await expect(service.createRun({
      calculationVersion: "v2",
      source: "manual",
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
      observations: [{
        ...observation,
        forecastPolicyFingerprint: "0".repeat(64),
      }],
    })).rejects.toThrow("forecast policy cohort does not match its canonical snapshot");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rejects newly constructed legacy forecast policy captures", async () => {
    const database = { select: vi.fn(), transaction: vi.fn() };
    const service = createPurchaseRecommendationSnapshotService(database);
    const observation = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
    }).observations![0];

    await expect(service.createRun({
      calculationVersion: "v2",
      source: "manual",
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
      observations: [{
        ...observation,
        forecastPolicyCaptureVersion: 0,
        forecastPolicyFingerprint: null,
        forecastPolicySnapshot: null,
      } as any],
    })).rejects.toThrow("forecastPolicyCaptureVersion is unsupported");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("writes complete overlay contribution evidence in the same transaction as its observation", async () => {
    const run = { id: 93, source: "manual", sourceRunKey: null };
    const writtenBatches: unknown[] = [];
    let insertCall = 0;
    const insert = vi.fn(() => ({
      values: vi.fn((values: any) => {
        writtenBatches.push(values);
        insertCall += 1;
        return {
          returning: vi.fn().mockResolvedValue(
            insertCall === 1
              ? [run]
              : Array.isArray(values)
                ? values.map((value, index) => ({ id: insertCall * 100 + index, ...value }))
                : [],
          ),
        };
      }),
    }));
    const database = {
      select: vi.fn(),
      transaction: vi.fn(async (work: (tx: any) => unknown) => work({ insert })),
    };
    const service = createPurchaseRecommendationSnapshotService(database);
    const input = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      source: "manual",
    });

    const result = await service.createRun(input, "buyer-1");

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(4);
    expect(result.observations).toHaveLength(1);
    expect(result.overlayContributions).toHaveLength(1);
    expect(writtenBatches[2]).toEqual([
      expect.objectContaining({
        forecastPolicyCaptureVersion: 1,
        forecastPolicyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        forecastPolicySnapshot: expect.objectContaining({
          method: "weighted_blend_v1",
          standardWindowDays: 30,
        }),
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2026-07-17",
        overlayHorizonDays: 90,
      }),
    ]);
    expect(writtenBatches[3]).toEqual([
      expect.objectContaining({
        observationId: 300,
        demandEventId: 700,
        demandEventLineId: 701,
        expectedPieces: 10,
        weightedPieces: 8,
      }),
    ]);
  });

  it("rejects complete overlay capture when child evidence does not reconcile", async () => {
    const database = { select: vi.fn(), transaction: vi.fn() };
    const service = createPurchaseRecommendationSnapshotService(database);
    const observation = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
    }).observations![0];

    await expect(service.createRun({
      calculationVersion: "v2",
      source: "manual",
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
      observations: [{ ...observation, forwardDemandPieces: 9 }],
    })).rejects.toThrow("overlay contribution totals do not match its aggregate");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rejects version 2 capture without complete parent coverage metadata", async () => {
    const database = { select: vi.fn(), transaction: vi.fn() };
    const service = createPurchaseRecommendationSnapshotService(database);
    const observation = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
    }).observations![0];

    await expect(service.createRun({
      calculationVersion: "v2",
      source: "manual",
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
      observations: [{ ...observation, overlayPlanningAsOfDate: null }],
    })).rejects.toThrow("overlayPlanningAsOfDate");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("rejects version 2 child evidence outside its parent coverage", async () => {
    const database = { select: vi.fn(), transaction: vi.fn() };
    const service = createPurchaseRecommendationSnapshotService(database);
    const observation = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
    }).observations![0];

    await expect(service.createRun({
      calculationVersion: "v2",
      source: "manual",
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
      observations: [{
        ...observation,
        overlayContributions: observation.overlayContributions!.map((contribution) => ({
          ...contribution,
          planningAsOfDate: "2026-07-16",
        })),
      }],
    })).rejects.toThrow("planningAsOfDate must match its forecast observation");
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("keeps immutable version 1 captures valid without parent coverage metadata", async () => {
    const transactionError = new Error("transaction reached");
    const database = {
      select: vi.fn(),
      transaction: vi.fn().mockRejectedValue(transactionError),
    };
    const service = createPurchaseRecommendationSnapshotService(database);
    const observation = buildPurchaseRecommendationRunInput({
      recommendationResult: { items: [recommendation()], skippedItems: [], summary: {} },
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 30,
      asOf: new Date("2026-07-17T12:00:00.000Z"),
    }).observations![0];

    await expect(service.createRun({
      calculationVersion: "v2",
      source: "manual",
      asOf: new Date("2026-07-17T12:00:00.000Z"),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
      observations: [{
        ...observation,
        overlayCaptureVersion: 1,
        overlayPlanningAsOfDate: null,
        overlayHorizonDays: null,
      }],
    })).rejects.toThrow("transaction reached");
    expect(database.transaction).toHaveBeenCalledTimes(1);
  });

  it("replays an existing source-scoped run without opening a write transaction", async () => {
    const selectResults = [
      [{ id: 92, source: "auto_draft", sourceRunKey: "500" }],
      [{ id: 101, runId: 92, recommendationKey: "10:100:30" }],
      [{ id: 201, runId: 92, observationKey: "10:product_all_warehouses" }],
      [{ id: 301, observationId: 201, demandEventLineId: 701 }],
    ];
    const select = vi.fn(() => {
      const rows = selectResults.shift() ?? [];
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        orderBy: vi.fn().mockResolvedValue(rows),
        limit: vi.fn().mockResolvedValue(rows),
        then: (resolve: (value: any[]) => unknown) => Promise.resolve(rows).then(resolve),
      };
      return chain;
    });
    const database = { select, transaction: vi.fn() };
    const service = createPurchaseRecommendationSnapshotService(database);
    const result = await service.createRun({
      calculationVersion: "v2",
      source: "auto_draft",
      sourceRunKey: "500",
      asOf: new Date(),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
    });

    expect(result).toMatchObject({ run: { id: 92 }, reused: true });
    expect(result.lines).toHaveLength(1);
    expect(result.observations).toHaveLength(1);
    expect(result.overlayContributions).toHaveLength(1);
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

