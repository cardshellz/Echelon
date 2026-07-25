import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  analysis: vi.fn(),
  buildRunInput: vi.fn(),
  createRun: vi.fn(),
  procurement: {},
  inventory: {},
  jobLifecycle: {
    startRun: vi.fn(),
    heartbeatRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  },
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
    mocks.jobLifecycle.startRun.mockResolvedValue({
      run: { id: 701 },
      interruptedRunIds: [],
    });
    mocks.jobLifecycle.heartbeatRun.mockResolvedValue({ id: 701, status: "running" });
    mocks.jobLifecycle.completeRun.mockResolvedValue({ id: 701, status: "succeeded" });
    mocks.jobLifecycle.failRun.mockResolvedValue({ run: { id: 701 }, transitioned: true });
  });

  it("writes one source-keyed immutable snapshot without invoking downstream purchasing writers", async () => {
    const asOf = new Date("2026-07-25T02:00:00.000Z");

    const result = await runPurchaseRecommendationSnapshotJob({
      asOf,
      actor: "system:test-scheduler",
      jobLifecycle: mocks.jobLifecycle as any,
    });

    expect(mocks.jobLifecycle.startRun).toHaveBeenCalledWith({
      jobType: "recommendation_snapshot",
      triggerType: "scheduled",
      asOf,
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
      jobRunId: 701,
      runId: 41,
      sourceRunKey: "scheduled-recommendation:v1:2026-07-25",
      asOf: "2026-07-25T02:00:00.000Z",
      evaluatedCount: 2,
      lineCount: 1,
      observationCount: 2,
      reused: false,
    });
    expect(mocks.jobLifecycle.heartbeatRun).toHaveBeenCalledWith({ runId: 701 });
    expect(mocks.jobLifecycle.completeRun).toHaveBeenCalledWith({
      runId: 701,
      completion: {
        jobType: "recommendation_snapshot",
        recommendationRunId: 41,
        recommendationLineCount: 1,
        forecastObservationCount: 2,
        resultJson: {
          sourceRunKey: "scheduled-recommendation:v1:2026-07-25",
          asOf: "2026-07-25T02:00:00.000Z",
          evaluatedCount: 2,
          reused: false,
        },
      },
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
      jobLifecycle: mocks.jobLifecycle as any,
    });

    expect(result).toMatchObject({
      sourceRunKey: "scheduled-recommendation:v1:2026-07-25",
      reused: true,
    });
  });

  it("rejects an invalid clock value before loading recommendation inputs", async () => {
    await expect(runPurchaseRecommendationSnapshotJob({
      asOf: new Date(Number.NaN),
      jobLifecycle: mocks.jobLifecycle as any,
    })).rejects.toThrow("asOf must be a valid date");

    expect(mocks.jobLifecycle.startRun).not.toHaveBeenCalled();
    expect(mocks.analysis).not.toHaveBeenCalled();
    expect(mocks.createRun).not.toHaveBeenCalled();
  });

  it("records a sanitized terminal failure and preserves the original error", async () => {
    const error = Object.assign(
      new Error("connect postgres://owner:password@db/echelon token=abc123"),
      { code: "ECONNREFUSED" },
    );
    mocks.analysis.mockRejectedValue(error);

    await expect(runPurchaseRecommendationSnapshotJob({
      asOf: new Date("2026-07-25T02:00:00.000Z"),
      jobLifecycle: mocks.jobLifecycle as any,
    })).rejects.toBe(error);

    expect(mocks.jobLifecycle.failRun).toHaveBeenCalledWith({
      runId: 701,
      errorCode: "ECONNREFUSED",
      errorMessage: "connect postgres://[REDACTED]@db/echelon token=[REDACTED]",
    });
    expect(mocks.jobLifecycle.completeRun).not.toHaveBeenCalled();
  });

  it("derives the idempotency key from the UTC calendar day", () => {
    expect(buildScheduledPurchaseRecommendationSourceRunKey(
      new Date("2026-07-25T23:59:59.999-04:00"),
    )).toBe("scheduled-recommendation:v1:2026-07-26");
  });
});
