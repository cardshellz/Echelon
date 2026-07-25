import { describe, expect, it } from "vitest";
import {
  buildPurchaseRecommendationPipelineHealth,
  SCHEDULED_RECOMMENDATION_CRITICAL_AGE_HOURS,
  SCHEDULED_RECOMMENDATION_WARNING_AGE_HOURS,
} from "../../purchase-recommendation-pipeline-health.service";

const asOf = new Date("2026-07-26T12:00:00.000Z");

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    latestScheduledRun: {
      id: 41,
      status: "completed" as const,
      asOf: new Date("2026-07-26T05:00:00.000Z"),
      generatedAt: new Date("2026-07-26T05:02:00.000Z"),
      recommendationLineCount: 32,
      observationCount: 278,
    },
    latestEvaluationAt: new Date("2026-07-26T05:31:00.000Z"),
    maturedEvaluationBacklog: 0,
    ...overrides,
  };
}

describe("purchase recommendation pipeline health", () => {
  it("reports a recent completed scheduled snapshot as healthy", () => {
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
      latestEvaluationAt: "2026-07-26T05:31:00.000Z",
      maturedEvaluationBacklog: 0,
      thresholds: {
        warningAgeHours: SCHEDULED_RECOMMENDATION_WARNING_AGE_HOURS,
        criticalAgeHours: SCHEDULED_RECOMMENDATION_CRITICAL_AGE_HOURS,
      },
      detail: "Scheduled snapshot #41 is 6h old with 32 recommendation lines and 278 forecast observations. No matured forecast evaluations are waiting.",
    });
  });

  it("warns before the first scheduled snapshot is recorded", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestScheduledRun: null,
      latestEvaluationAt: null,
    }), { asOf });

    expect(health).toMatchObject({
      status: "warning",
      critical: 0,
      warning: 1,
      latestScheduledRun: null,
      latestEvaluationAt: null,
      detail: "No scheduled recommendation snapshot has been recorded.",
    });
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

  it("escalates a critically stale scheduled snapshot", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestScheduledRun: {
        ...evidence().latestScheduledRun,
        generatedAt: new Date("2026-07-24T05:00:00.000Z"),
      },
    }), {
      asOf,
      warningAgeHours: 24,
      criticalAgeHours: 48,
    });

    expect(health).toMatchObject({
      status: "critical",
      critical: 1,
      warning: 0,
      latestScheduledRun: {
        ageHours: 55,
      },
    });
    expect(health.detail).toContain("critically stale");
  });

  it("treats an explicitly failed scheduled run as critical", () => {
    const health = buildPurchaseRecommendationPipelineHealth(evidence({
      latestScheduledRun: {
        ...evidence().latestScheduledRun,
        status: "failed",
      },
    }), { asOf });

    expect(health).toMatchObject({
      status: "critical",
      critical: 1,
      warning: 0,
      detail: "Scheduled snapshot #41 is marked failed.",
    });
  });

  it("rejects inverted freshness thresholds", () => {
    expect(() => buildPurchaseRecommendationPipelineHealth(evidence(), {
      asOf,
      warningAgeHours: 48,
      criticalAgeHours: 24,
    })).toThrow("criticalAgeHours must be greater than warningAgeHours");
  });
});
