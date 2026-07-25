import { describe, expect, it } from "vitest";
import type {
  PurchasePipelineJobRunEvidence,
  PurchaseRecommendationPipelineEvidence,
} from "../../purchase-recommendation-pipeline-health.repository";
import {
  buildPurchaseRecommendationPipelineHealth,
  SCHEDULED_RECOMMENDATION_CRITICAL_AGE_HOURS,
  SCHEDULED_RECOMMENDATION_WARNING_AGE_HOURS,
} from "../../purchase-recommendation-pipeline-health.service";

const asOf = new Date("2026-07-26T12:00:00.000Z");

function jobRun(
  jobType: PurchasePipelineJobRunEvidence["jobType"],
  overrides: Partial<PurchasePipelineJobRunEvidence> = {},
): PurchasePipelineJobRunEvidence {
  const isSnapshot = jobType === "recommendation_snapshot";
  return {
    id: isSnapshot ? 101 : 102,
    jobType,
    status: "succeeded",
    asOf: new Date(isSnapshot ? "2026-07-26T05:00:00.000Z" : "2026-07-26T05:30:00.000Z"),
    startedAt: new Date(isSnapshot ? "2026-07-26T05:00:00.000Z" : "2026-07-26T05:30:00.000Z"),
    heartbeatAt: new Date(isSnapshot ? "2026-07-26T05:03:00.000Z" : "2026-07-26T05:32:00.000Z"),
    leaseExpiresAt: null,
    finishedAt: new Date(isSnapshot ? "2026-07-26T05:03:00.000Z" : "2026-07-26T05:32:00.000Z"),
    recommendationRunId: isSnapshot ? 41 : null,
    recommendationLineCount: isSnapshot ? 32 : null,
    forecastObservationCount: isSnapshot ? 278 : null,
    evaluationInsertedCount: isSnapshot ? null : 17,
    evaluationBatchCount: isSnapshot ? null : 1,
    evaluationBacklogMayRemain: isSnapshot ? null : false,
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

function evidence(
  overrides: Partial<PurchaseRecommendationPipelineEvidence> = {},
): PurchaseRecommendationPipelineEvidence {
  return {
    latestScheduledRun: {
      id: 41,
      status: "completed",
      asOf: new Date("2026-07-26T05:00:00.000Z"),
      generatedAt: new Date("2026-07-26T05:02:00.000Z"),
      recommendationLineCount: 32,
      observationCount: 278,
    },
    latestSnapshotJobRun: jobRun("recommendation_snapshot"),
    latestEvaluationJobRun: jobRun("forecast_evaluation"),
    latestEvaluationAt: new Date("2026-07-26T05:31:00.000Z"),
    maturedEvaluationBacklog: 0,
    ...overrides,
  };
}

describe("purchase recommendation pipeline health", () => {
  it("reports recent scheduled executions and matching output evidence as healthy", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence(), { asOf });

    expect(health).toEqual({
      generatedAt: "2026-07-26T12:00:00.000Z",
      status: "healthy",
      critical: 0,
      warning: 0,
      latestScheduledRun: {
        id: 41,
        status: "completed",
        asOf: "2026-07-26T05:00:00.000Z",
        generatedAt: "2026-07-26T05:02:00.000Z",
        ageHours: 6,
        recommendationLineCount: 32,
        observationCount: 278,
      },
      jobs: {
        recommendationSnapshot: {
          id: 101,
          jobType: "recommendation_snapshot",
          status: "succeeded",
          asOf: "2026-07-26T05:00:00.000Z",
          startedAt: "2026-07-26T05:00:00.000Z",
          heartbeatAt: "2026-07-26T05:03:00.000Z",
          leaseExpiresAt: null,
          finishedAt: "2026-07-26T05:03:00.000Z",
          ageHours: 6,
          leaseExpired: false,
          recommendationRunId: 41,
          recommendationLineCount: 32,
          forecastObservationCount: 278,
          evaluationInsertedCount: null,
          evaluationBatchCount: null,
          evaluationBacklogMayRemain: null,
          errorCode: null,
          errorMessage: null,
        },
        forecastEvaluation: {
          id: 102,
          jobType: "forecast_evaluation",
          status: "succeeded",
          asOf: "2026-07-26T05:30:00.000Z",
          startedAt: "2026-07-26T05:30:00.000Z",
          heartbeatAt: "2026-07-26T05:32:00.000Z",
          leaseExpiresAt: null,
          finishedAt: "2026-07-26T05:32:00.000Z",
          ageHours: 6,
          leaseExpired: false,
          recommendationRunId: null,
          recommendationLineCount: null,
          forecastObservationCount: null,
          evaluationInsertedCount: 17,
          evaluationBatchCount: 1,
          evaluationBacklogMayRemain: false,
          errorCode: null,
          errorMessage: null,
        },
      },
      latestEvaluationAt: "2026-07-26T05:31:00.000Z",
      maturedEvaluationBacklog: 0,
      thresholds: {
        warningAgeHours: SCHEDULED_RECOMMENDATION_WARNING_AGE_HOURS,
        criticalAgeHours: SCHEDULED_RECOMMENDATION_CRITICAL_AGE_HOURS,
      },
      detail: "Scheduled snapshot execution #101 and forecast evaluation execution #102 are healthy. "
        + "32 recommendation lines and 278 forecast observations were captured; "
        + "no matured evaluations are waiting.",
    });
  });

  it("treats a successful no-op evaluation as healthy execution evidence", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestEvaluationJobRun: jobRun("forecast_evaluation", {
        evaluationInsertedCount: 0,
      }),
      latestEvaluationAt: null,
    }), { asOf });

    expect(health).toMatchObject({
      status: "healthy",
      jobs: {
        forecastEvaluation: {
          status: "succeeded",
          evaluationInsertedCount: 0,
        },
      },
      latestEvaluationAt: null,
    });
  });

  it("warns before scheduled execution evidence exists", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestScheduledRun: null,
      latestSnapshotJobRun: null,
      latestEvaluationJobRun: null,
      latestEvaluationAt: null,
    }), { asOf });

    expect(health).toMatchObject({
      status: "warning",
      critical: 0,
      warning: 1,
      latestScheduledRun: null,
      jobs: {
        recommendationSnapshot: null,
        forecastEvaluation: null,
      },
    });
    expect(health.detail).toContain("No scheduled recommendation snapshot execution");
    expect(health.detail).toContain("No scheduled forecast evaluation execution");
  });

  it("warns when matured forecast evaluations are waiting", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      maturedEvaluationBacklog: 17,
    }), { asOf });

    expect(health).toMatchObject({
      status: "warning",
      critical: 0,
      warning: 1,
      maturedEvaluationBacklog: 17,
    });
    expect(health.detail).toContain("17 matured evaluations await processing");
  });

  it("escalates a critically stale scheduled snapshot execution", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestSnapshotJobRun: jobRun("recommendation_snapshot", {
        heartbeatAt: new Date("2026-07-24T05:00:00.000Z"),
        finishedAt: new Date("2026-07-24T05:00:00.000Z"),
      }),
    }), {
      asOf,
      warningAgeHours: 24,
      criticalAgeHours: 48,
    });

    expect(health).toMatchObject({
      status: "critical",
      critical: 1,
      warning: 0,
      jobs: {
        recommendationSnapshot: {
          ageHours: 55,
        },
      },
    });
    expect(health.detail).toContain("critically stale");
  });

  it("reports a failed scheduled evaluator as critical", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestEvaluationJobRun: jobRun("forecast_evaluation", {
        status: "failed",
        evaluationInsertedCount: 12,
        evaluationBatchCount: 2,
        evaluationBacklogMayRemain: true,
        errorCode: "DATABASE_UNAVAILABLE",
        errorMessage: "Database unavailable",
      }),
    }), { asOf });

    expect(health).toMatchObject({
      status: "critical",
      critical: 1,
      warning: 0,
    });
    expect(health.detail).toContain("execution #102 is failed (DATABASE_UNAVAILABLE)");
  });

  it("reports a running execution with an expired lease as critical", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestEvaluationJobRun: jobRun("forecast_evaluation", {
        status: "running",
        heartbeatAt: new Date("2026-07-26T10:00:00.000Z"),
        leaseExpiresAt: new Date("2026-07-26T11:00:00.000Z"),
        finishedAt: null,
        evaluationInsertedCount: null,
        evaluationBatchCount: null,
        evaluationBacklogMayRemain: null,
      }),
    }), { asOf });

    expect(health).toMatchObject({
      status: "critical",
      jobs: {
        forecastEvaluation: {
          status: "running",
          leaseExpired: true,
        },
      },
    });
    expect(health.detail).toContain("execution #102 exceeded its lease");
  });

  it("reports mismatched snapshot execution and output evidence as critical", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestSnapshotJobRun: jobRun("recommendation_snapshot", {
        recommendationLineCount: 31,
      }),
    }), { asOf });

    expect(health.status).toBe("critical");
    expect(health.detail).toContain("does not match its immutable output");
  });

  it("reports inserted evaluations without matching persisted evidence as critical", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestEvaluationAt: new Date("2026-07-25T05:31:00.000Z"),
    }), { asOf });

    expect(health.status).toBe("critical");
    expect(health.detail).toContain("inserted rows without matching evaluation evidence");
  });

  it("warns when immutable output evidence is ahead of the health-check clock", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestScheduledRun: {
        ...evidence().latestScheduledRun!,
        generatedAt: new Date("2026-07-26T12:06:00.000Z"),
      },
    }), { asOf });

    expect(health.status).toBe("warning");
    expect(health.detail).toContain("output #41 is ahead of the health-check clock");
  });

  it("rejects inverted freshness thresholds", () => {
    expect(() => buildPurchaseRecommendationPipelineHealth(evidence(), {
      asOf,
      warningAgeHours: 48,
      criticalAgeHours: 24,
    })).toThrow("criticalAgeHours must be greater than warningAgeHours");
  });
});
