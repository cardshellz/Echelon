import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createPurchaseRecommendationPipelineHealthRepository } from "../../purchase-recommendation-pipeline-health.repository";

function jobColumns(
  prefix: "snapshot_job" | "evaluation_job",
  values: {
    id: number;
    jobType: "recommendation_snapshot" | "forecast_evaluation";
    asOf: string;
    startedAt: string;
    heartbeatAt: string;
    finishedAt: string;
    recommendationRunId?: number | null;
    recommendationLineCount?: number | null;
    forecastObservationCount?: number | null;
    evaluationInsertedCount?: number | null;
    evaluationBatchCount?: number | null;
    evaluationBacklogMayRemain?: boolean | null;
  },
) {
  return {
    [`${prefix}_id`]: String(values.id),
    [`${prefix}_job_type`]: values.jobType,
    [`${prefix}_status`]: "succeeded",
    [`${prefix}_as_of`]: values.asOf,
    [`${prefix}_started_at`]: values.startedAt,
    [`${prefix}_heartbeat_at`]: values.heartbeatAt,
    [`${prefix}_lease_expires_at`]: null,
    [`${prefix}_finished_at`]: values.finishedAt,
    [`${prefix}_recommendation_run_id`]: values.recommendationRunId ?? null,
    [`${prefix}_recommendation_line_count`]: values.recommendationLineCount ?? null,
    [`${prefix}_forecast_observation_count`]: values.forecastObservationCount ?? null,
    [`${prefix}_evaluation_inserted_count`]: values.evaluationInsertedCount ?? null,
    [`${prefix}_evaluation_batch_count`]: values.evaluationBatchCount ?? null,
    [`${prefix}_evaluation_backlog_may_remain`]: values.evaluationBacklogMayRemain ?? null,
    [`${prefix}_error_code`]: null,
    [`${prefix}_error_message`]: null,
  };
}

describe("purchase recommendation pipeline health repository", () => {
  it("loads the latest scheduled evidence and exact matured evaluation backlog", async () => {
    const database = {
      execute: vi.fn().mockResolvedValue({
        rows: [{
          latest_scheduled_run_id: "41",
          latest_scheduled_run_status: "completed",
          latest_scheduled_run_as_of: "2026-07-26T05:00:00.000Z",
          latest_scheduled_run_generated_at: "2026-07-26T05:02:00.000Z",
          latest_scheduled_run_line_count: "32",
          latest_scheduled_run_observation_count: "278",
          ...jobColumns("snapshot_job", {
            id: 101,
            jobType: "recommendation_snapshot",
            asOf: "2026-07-26T05:00:00.000Z",
            startedAt: "2026-07-26T05:00:00.000Z",
            heartbeatAt: "2026-07-26T05:03:00.000Z",
            finishedAt: "2026-07-26T05:03:00.000Z",
            recommendationRunId: 41,
            recommendationLineCount: 32,
            forecastObservationCount: 278,
          }),
          ...jobColumns("evaluation_job", {
            id: 102,
            jobType: "forecast_evaluation",
            asOf: "2026-07-26T05:30:00.000Z",
            startedAt: "2026-07-26T05:30:00.000Z",
            heartbeatAt: "2026-07-26T05:32:00.000Z",
            finishedAt: "2026-07-26T05:32:00.000Z",
            evaluationInsertedCount: 17,
            evaluationBatchCount: 1,
            evaluationBacklogMayRemain: false,
          }),
          latest_evaluation_at: "2026-07-26T05:31:00.000Z",
          matured_evaluation_backlog: "17",
        }],
      }),
    };
    const repository = createPurchaseRecommendationPipelineHealthRepository(database);
    const asOf = new Date("2026-07-26T12:00:00.000Z");

    const result = await repository.loadEvidence({ asOf });

    expect(result).toEqual({
      latestScheduledRun: {
        id: 41,
        status: "completed",
        asOf: new Date("2026-07-26T05:00:00.000Z"),
        generatedAt: new Date("2026-07-26T05:02:00.000Z"),
        recommendationLineCount: 32,
        observationCount: 278,
      },
      latestSnapshotJobRun: {
        id: 101,
        jobType: "recommendation_snapshot",
        status: "succeeded",
        asOf: new Date("2026-07-26T05:00:00.000Z"),
        startedAt: new Date("2026-07-26T05:00:00.000Z"),
        heartbeatAt: new Date("2026-07-26T05:03:00.000Z"),
        leaseExpiresAt: null,
        finishedAt: new Date("2026-07-26T05:03:00.000Z"),
        recommendationRunId: 41,
        recommendationLineCount: 32,
        forecastObservationCount: 278,
        evaluationInsertedCount: null,
        evaluationBatchCount: null,
        evaluationBacklogMayRemain: null,
        errorCode: null,
        errorMessage: null,
      },
      latestEvaluationJobRun: {
        id: 102,
        jobType: "forecast_evaluation",
        status: "succeeded",
        asOf: new Date("2026-07-26T05:30:00.000Z"),
        startedAt: new Date("2026-07-26T05:30:00.000Z"),
        heartbeatAt: new Date("2026-07-26T05:32:00.000Z"),
        leaseExpiresAt: null,
        finishedAt: new Date("2026-07-26T05:32:00.000Z"),
        recommendationRunId: null,
        recommendationLineCount: null,
        forecastObservationCount: null,
        evaluationInsertedCount: 17,
        evaluationBatchCount: 1,
        evaluationBacklogMayRemain: false,
        errorCode: null,
        errorMessage: null,
      },
      latestEvaluationAt: new Date("2026-07-26T05:31:00.000Z"),
      maturedEvaluationBacklog: 17,
    });

    const rendered = new PgDialect().sqlToQuery(database.execute.mock.calls[0][0]);
    expect(rendered.sql).toContain("recommendation_run.source = 'scheduled'");
    expect(rendered.sql).toContain("job_run.trigger_type = 'scheduled'");
    expect(rendered.sql).toContain("ORDER BY recommendation_run.generated_at DESC, recommendation_run.id DESC");
    expect(rendered.sql).toContain("CROSS JOIN UNNEST");
    expect(rendered.sql).toContain("MAKE_INTERVAL(days => horizon.horizon_days)");
    expect(rendered.sql).toContain("evaluation.evaluation_version =");
    expect(rendered.params).toContain(2);
    expect(rendered.params.at(-1)).toEqual(asOf);
  });

  it("maps an empty scheduled history without fabricating a run", async () => {
    const repository = createPurchaseRecommendationPipelineHealthRepository({
      execute: vi.fn().mockResolvedValue({
        rows: [{
          latest_scheduled_run_id: null,
          latest_scheduled_run_status: null,
          latest_scheduled_run_as_of: null,
          latest_scheduled_run_generated_at: null,
          latest_scheduled_run_line_count: null,
          latest_scheduled_run_observation_count: null,
          latest_evaluation_at: null,
          matured_evaluation_backlog: "0",
        }],
      }),
    });

    await expect(repository.loadEvidence({
      asOf: new Date("2026-07-26T12:00:00.000Z"),
    })).resolves.toEqual({
      latestScheduledRun: null,
      latestSnapshotJobRun: null,
      latestEvaluationJobRun: null,
      latestEvaluationAt: null,
      maturedEvaluationBacklog: 0,
    });
  });

  it("rejects unsupported persisted run status", async () => {
    const repository = createPurchaseRecommendationPipelineHealthRepository({
      execute: vi.fn().mockResolvedValue({
        rows: [{
          latest_scheduled_run_id: "41",
          latest_scheduled_run_status: "running",
          latest_scheduled_run_as_of: "2026-07-26T05:00:00.000Z",
          latest_scheduled_run_generated_at: "2026-07-26T05:02:00.000Z",
          latest_scheduled_run_line_count: "0",
          latest_scheduled_run_observation_count: "0",
          latest_evaluation_at: null,
          matured_evaluation_backlog: "0",
        }],
      }),
    });

    await expect(repository.loadEvidence({
      asOf: new Date("2026-07-26T12:00:00.000Z"),
    })).rejects.toThrow("latestScheduledRun.status is unsupported");
  });
});
