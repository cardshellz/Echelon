import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createPurchaseRecommendationPipelineHealthRepository } from "../../purchase-recommendation-pipeline-health.repository";

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
      latestEvaluationAt: new Date("2026-07-26T05:31:00.000Z"),
      maturedEvaluationBacklog: 17,
    });

    const rendered = new PgDialect().sqlToQuery(database.execute.mock.calls[0][0]);
    expect(rendered.sql).toContain("recommendation_run.source = 'scheduled'");
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
