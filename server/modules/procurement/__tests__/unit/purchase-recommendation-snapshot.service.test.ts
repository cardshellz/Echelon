import { describe, expect, it, vi } from "vitest";
import {
  buildPurchaseRecommendationRunInput,
  createPurchaseRecommendationSnapshotService,
} from "../../purchase-recommendation-snapshot.service";
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
      forecastTrust: { signal: "trusted" },
    },
    forwardDemandBasis: { forwardDemandPieces: 8, forwardDemandRawPieces: 10 },
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
        forecastDailyPiecesMicros: 4_000_000,
        baselineDailyPiecesMicros: 4_000_000,
        forwardDemandPieces: 8,
        forwardDemandRawPieces: 10,
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

  it("requires a durable source key for automated runs", async () => {
    const service = createPurchaseRecommendationSnapshotService({ select: vi.fn(), transaction: vi.fn() });
    await expect(service.createRun({
      calculationVersion: "v2",
      source: "auto_draft",
      asOf: new Date(),
      lookbackDays: 30,
      policySnapshot: {},
      lines: [],
    })).rejects.toThrow("sourceRunKey is required");
  });

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
  });

  it("replays an existing source-scoped run without opening a write transaction", async () => {
    const selectResults = [
      [{ id: 92, source: "auto_draft", sourceRunKey: "500" }],
      [{ id: 101, runId: 92, recommendationKey: "10:100:30" }],
      [{ id: 201, runId: 92, observationKey: "10:product_all_warehouses" }],
    ];
    const select = vi.fn(() => {
      const rows = selectResults.shift() ?? [];
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
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
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

