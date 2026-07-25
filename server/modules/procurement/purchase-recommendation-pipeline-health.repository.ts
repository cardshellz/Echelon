import { sql } from "drizzle-orm";
import {
  PURCHASE_FORECAST_EVALUATION_HORIZONS,
  PURCHASE_FORECAST_EVALUATION_VERSION,
} from "./purchase-forecast-backtesting.domain";

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows?: unknown[] } | unknown[]>;
};

export type ScheduledPurchaseRecommendationRunEvidence = {
  id: number;
  status: "completed" | "failed";
  asOf: Date;
  generatedAt: Date;
  recommendationLineCount: number;
  observationCount: number;
};

export type PurchaseRecommendationPipelineEvidence = {
  latestScheduledRun: ScheduledPurchaseRecommendationRunEvidence | null;
  latestEvaluationAt: Date | null;
  maturedEvaluationBacklog: number;
};

function rowsOf(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : Array.isArray(result) ? result : [];
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function validDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
  return parsed;
}

function nullableDate(value: unknown, field: string): Date | null {
  return value == null ? null : validDate(value, field);
}

function mapLatestScheduledRun(row: any): ScheduledPurchaseRecommendationRunEvidence | null {
  if (row.latest_scheduled_run_id == null) return null;
  if (row.latest_scheduled_run_status !== "completed" && row.latest_scheduled_run_status !== "failed") {
    throw new RangeError("latestScheduledRun.status is unsupported");
  }
  return {
    id: safeInteger(row.latest_scheduled_run_id, "latestScheduledRun.id", 1),
    status: row.latest_scheduled_run_status,
    asOf: validDate(row.latest_scheduled_run_as_of, "latestScheduledRun.asOf"),
    generatedAt: validDate(row.latest_scheduled_run_generated_at, "latestScheduledRun.generatedAt"),
    recommendationLineCount: safeInteger(
      row.latest_scheduled_run_line_count,
      "latestScheduledRun.recommendationLineCount",
    ),
    observationCount: safeInteger(
      row.latest_scheduled_run_observation_count,
      "latestScheduledRun.observationCount",
    ),
  };
}

export function createPurchaseRecommendationPipelineHealthRepository(database: DbWithExecute) {
  return {
    async loadEvidence(input: { asOf: Date }): Promise<PurchaseRecommendationPipelineEvidence> {
      const asOf = validDate(input.asOf, "asOf");
      const horizonSql = sql.join(
        PURCHASE_FORECAST_EVALUATION_HORIZONS.map((value) => sql`${value}`),
        sql`, `,
      );
      const result = await database.execute(sql`
        WITH latest_scheduled_run AS (
          SELECT
            recommendation_run.id,
            recommendation_run.status,
            recommendation_run.as_of,
            recommendation_run.generated_at
          FROM procurement.purchase_recommendation_runs recommendation_run
          WHERE recommendation_run.source = 'scheduled'
          ORDER BY recommendation_run.generated_at DESC, recommendation_run.id DESC
          LIMIT 1
        ),
        latest_scheduled_evidence AS (
          SELECT
            recommendation_run.id,
            recommendation_run.status,
            recommendation_run.as_of,
            recommendation_run.generated_at,
            (
              SELECT COUNT(*)::bigint
              FROM procurement.purchase_recommendation_lines recommendation_line
              WHERE recommendation_line.run_id = recommendation_run.id
            ) AS recommendation_line_count,
            (
              SELECT COUNT(*)::bigint
              FROM procurement.purchase_forecast_observations observation
              WHERE observation.run_id = recommendation_run.id
            ) AS observation_count
          FROM latest_scheduled_run recommendation_run
        ),
        evaluation_state AS (
          SELECT MAX(evaluation.evaluated_at) AS latest_evaluation_at
          FROM procurement.purchase_forecast_evaluations evaluation
          WHERE evaluation.evaluation_version = ${PURCHASE_FORECAST_EVALUATION_VERSION}
        ),
        matured_evaluation_backlog AS (
          SELECT COUNT(*)::bigint AS backlog_count
          FROM procurement.purchase_forecast_observations observation
          JOIN procurement.purchase_recommendation_runs recommendation_run
            ON recommendation_run.id = observation.run_id
          CROSS JOIN UNNEST(ARRAY[${horizonSql}]::int[]) AS horizon(horizon_days)
          LEFT JOIN procurement.purchase_forecast_evaluations evaluation
            ON evaluation.observation_id = observation.id
           AND evaluation.horizon_days = horizon.horizon_days
           AND evaluation.evaluation_version = ${PURCHASE_FORECAST_EVALUATION_VERSION}
          WHERE recommendation_run.status = 'completed'
            AND observation.scope = 'product_all_warehouses'
            AND recommendation_run.as_of + MAKE_INTERVAL(days => horizon.horizon_days) <= ${asOf}
            AND evaluation.id IS NULL
        )
        SELECT
          latest.id AS latest_scheduled_run_id,
          latest.status AS latest_scheduled_run_status,
          latest.as_of AS latest_scheduled_run_as_of,
          latest.generated_at AS latest_scheduled_run_generated_at,
          latest.recommendation_line_count AS latest_scheduled_run_line_count,
          latest.observation_count AS latest_scheduled_run_observation_count,
          evaluation_state.latest_evaluation_at,
          matured_evaluation_backlog.backlog_count AS matured_evaluation_backlog
        FROM evaluation_state
        CROSS JOIN matured_evaluation_backlog
        LEFT JOIN latest_scheduled_evidence latest ON TRUE
      `);
      const row = rowsOf(result)[0];
      if (!row) {
        throw new Error("Purchase recommendation pipeline health query returned no row");
      }
      return {
        latestScheduledRun: mapLatestScheduledRun(row),
        latestEvaluationAt: nullableDate(row.latest_evaluation_at, "latestEvaluationAt"),
        maturedEvaluationBacklog: safeInteger(
          row.matured_evaluation_backlog,
          "maturedEvaluationBacklog",
        ),
      };
    },
  };
}
