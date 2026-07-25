import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  analysis: vi.fn(),
  buildRunInput: vi.fn(),
  createRun: vi.fn(),
  procurement: {},
  inventory: {},
}));

vi.mock("../../../db", () => ({ db: mocks.db }));
vi.mock("../../../modules/procurement/procurement.storage", () => ({
  procurementMethods: mocks.procurement,
}));
vi.mock("../../../modules/inventory", () => ({
  inventoryStorage: mocks.inventory,
}));
vi.mock("../../../modules/procurement/purchase-recommendation-analysis.service", () => ({
  loadPurchaseRecommendationSnapshotAnalysis: mocks.analysis,
}));
vi.mock("../../../modules/procurement/purchase-recommendation-snapshot.service", () => ({
  buildPurchaseRecommendationRunInput: mocks.buildRunInput,
  createPurchaseRecommendationSnapshotService: () => ({ createRun: mocks.createRun }),
}));

import {
  buildScheduledPurchaseRecommendationSourceRunKey,
  runPurchaseRecommendationSnapshotJob,
} from "../../purchase-recommendation-snapshot.job";

describe("scheduled purchase recommendation snapshot job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analysis.mockResolvedValue({
      settings: { autoDraftMode: "review_only" },
      lookbackDays: 90,
      rawRows: [{ productId: 1 }, { productId: 2 }],
      evaluatedCount: 2,
      recommendationResult: { items: [], skippedItems: [], summary: {} },
    });
    mocks.buildRunInput.mockReturnValue({ source: "scheduled" });
    mocks.createRun.mockResolvedValue({
      run: { id: 41 },
      lines: [{ id: 51 }],
      observations: [{ id: 61 }, { id: 62 }],
      reused: false,
    });
  });

  it("writes one source-keyed immutable snapshot without invoking downstream purchasing writers", async () => {
    const asOf = new Date("2026-07-25T02:00:00.000Z");

    const result = await runPurchaseRecommendationSnapshotJob({
      asOf,
      actor: "system:test-scheduler",
    });

    expect(mocks.buildRunInput).toHaveBeenCalledWith(expect.objectContaining({
      asOf,
      source: "scheduled",
      sourceRunKey: "scheduled-recommendation:v1:2026-07-25",
      lookbackDays: 90,
      evaluatedCount: 2,
    }));
    expect(mocks.createRun).toHaveBeenCalledWith(
      { source: "scheduled" },
      "system:test-scheduler",
    );
    expect(result).toEqual({
      runId: 41,
      sourceRunKey: "scheduled-recommendation:v1:2026-07-25",
      asOf: "2026-07-25T02:00:00.000Z",
      evaluatedCount: 2,
      lineCount: 1,
      observationCount: 2,
      reused: false,
    });
  });

  it("reports an idempotently reused daily snapshot", async () => {
    mocks.createRun.mockResolvedValue({
      run: { id: 41 },
      lines: [],
      observations: [{ id: 61 }],
      reused: true,
    });

    const result = await runPurchaseRecommendationSnapshotJob({
      asOf: new Date("2026-07-25T18:30:00.000Z"),
    });

    expect(result).toMatchObject({
      sourceRunKey: "scheduled-recommendation:v1:2026-07-25",
      reused: true,
    });
  });

  it("rejects an invalid clock value before loading recommendation inputs", async () => {
    await expect(runPurchaseRecommendationSnapshotJob({
      asOf: new Date(Number.NaN),
    })).rejects.toThrow("asOf must be a valid date");

    expect(mocks.analysis).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("derives the idempotency key from the UTC calendar day", () => {
    expect(buildScheduledPurchaseRecommendationSourceRunKey(
      new Date("2026-07-25T23:59:59.999-04:00"),
    )).toBe("scheduled-recommendation:v1:2026-07-26");
  });
});
