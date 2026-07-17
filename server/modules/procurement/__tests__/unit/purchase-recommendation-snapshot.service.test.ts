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
    demandBasis: { forecastTrust: "trusted" },
    forecastProvenance: { forecastMethod: "weighted_blend_v1", demandWindowDays: 30 },
    forwardDemandBasis: { forwardDemandPieces: 8 },
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
      evaluatedCount: 12,
    });

    expect(input).toMatchObject({
      source: "auto_draft",
      sourceRunKey: "501",
      lookbackDays: 30,
      inputSummary: { candidateCount: 1, evaluatedCount: 12 },
      lines: [{
        recommendationKey: "10:100:30",
        recommendedPieces: 48,
        preferredVendorId: null,
        evidenceSnapshot: {
          forecastMethod: "weighted_blend_v1",
          forwardDemandPieces: 8,
        },
      }],
    });
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
    }, "buyer-1");

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ run: { id: 91 }, reused: false });
    expect(result.lines).toHaveLength(1);
  });

  it("replays an existing source-scoped run without opening a write transaction", async () => {
    const selectResults = [
      [{ id: 92, source: "auto_draft", sourceRunKey: "500" }],
      [{ id: 101, runId: 92, recommendationKey: "10:100:30" }],
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
    expect(database.transaction).not.toHaveBeenCalled();
  });
});

