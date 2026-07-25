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

export type PurchasePipelineJobRunEvidence = {
  id: number;
  jobType: "recommendation_snapshot" | "forecast_evaluation";
  status: "running" | "succeeded" | "failed" | "interrupted";
  asOf: Date;
  startedAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: Date | null;
  finishedAt: Date | null;
  recommendationRunId: number | null;
  recommendationLineCount: number | null;
  forecastObservationCount: number | null;
  evaluationInsertedCount: number | null;
  evaluationBatchCount: number | null;
  evaluationBacklogMayRemain: boolean | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type PurchaseRecommendationPipelineEvidence = {
  latestScheduledRun: ScheduledPurchaseRecommendationRunEvidence | null;
  latestSnapshotJobRun: PurchasePipelineJobRunEvidence | null;
  latestEvaluationJobRun: PurchasePipelineJobRunEvidence | null;
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

function nullableInteger(value: unknown, field: string, minimum = 0): number | null {
  return value == null ? null : safeInteger(value, field, minimum);
}

function nullableBoolean(value: unknown, field: string): boolean | null {
  if (value == null) return null;
  if (value === true || value === false) return value;
  throw new RangeError(`${field} must be a boolean or null`);
}

function nullableString(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new RangeError(`${field} must be a string or null`);
  return value;
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

function mapPipelineJobRun(
  row: any,
  prefix: "snapshot_job" | "evaluation_job",
  expectedJobType: PurchasePipelineJobRunEvidence["jobType"],
): PurchasePipelineJobRunEvidence | null {
  if (row[`${prefix}_id`] == null) return null;
  const jobType = row[`${prefix}_job_type`];
  if (jobType !== expectedJobType) {
    throw new RangeError(`${prefix}.jobType is unsupported`);
  }
  const status = row[`${prefix}_status`];
  if (!["running", "succeeded", "failed", "interrupted"].includes(status)) {
    throw new RangeError(`${prefix}.status is unsupported`);
  }
  return {
    id: safeInteger(row[`${prefix}_id`], `${prefix}.id`, 1),
    jobType,
    status,
    asOf: validDate(row[`${prefix}_as_of`], `${prefix}.asOf`),
    startedAt: validDate(row[`${prefix}_started_at`], `${prefix}.startedAt`),
    heartbeatAt: validDate(row[`${prefix}_heartbeat_at`], `${prefix}.heartbeatAt`),
    leaseExpiresAt: nullableDate(
      row[`${prefix}_lease_expires_at`],
      `${prefix}.leaseExpiresAt`,
    ),
    finishedAt: nullableDate(row[`${prefix}_finished_at`], `${prefix}.finishedAt`),
    recommendationRunId: nullableInteger(
      row[`${prefix}_recommendation_run_id`],
      `${prefix}.recommendationRunId`,
      1,
    ),
    recommendationLineCount: nullableInteger(
      row[`${prefix}_recommendation_line_count`],
      `${prefix}.recommendationLineCount`,
    ),
    forecastObservationCount: nullableInteger(
      row[`${prefix}_forecast_observation_count`],
      `${prefix}.forecastObservationCount`,
    ),
    evaluationInsertedCount: nullableInteger(
      row[`${prefix}_evaluation_inserted_count`],
      `${prefix}.evaluationInsertedCount`,
    ),
    evaluationBatchCount: nullableInteger(
      row[`${prefix}_evaluation_batch_count`],
      `${prefix}.evaluationBatchCount`,
    ),
    evaluationBacklogMayRemain: nullableBoolean(
      row[`${prefix}_evaluation_backlog_may_remain`],
      `${prefix}.evaluationBacklogMayRemain`,
    ),
    errorCode: nullableString(row[`${prefix}_error_code`], `${prefix}.errorCode`),
    errorMessage: nullableString(row[`${prefix}_error_message`], `${prefix}.errorMessage`),
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
        latest_job_runs AS (
          SELECT DISTINCT ON (job_run.job_type)
            job_run.*
          FROM procurement.purchase_pipeline_job_runs job_run
          WHERE job_run.trigger_type = 'scheduled'
            AND job_run.job_type IN ('recommendation_snapshot', 'forecast_evaluation')
          ORDER BY job_run.job_type, job_run.started_at DESC, job_run.id DESC
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
          snapshot_job.id AS snapshot_job_id,
          snapshot_job.job_type AS snapshot_job_job_type,
          snapshot_job.status AS snapshot_job_status,
          snapshot_job.as_of AS snapshot_job_as_of,
          snapshot_job.started_at AS snapshot_job_started_at,
          snapshot_job.heartbeat_at AS snapshot_job_heartbeat_at,
          snapshot_job.lease_expires_at AS snapshot_job_lease_expires_at,
          snapshot_job.finished_at AS snapshot_job_finished_at,
          snapshot_job.recommendation_run_id AS snapshot_job_recommendation_run_id,
          snapshot_job.recommendation_line_count AS snapshot_job_recommendation_line_count,
          snapshot_job.forecast_observation_count AS snapshot_job_forecast_observation_count,
          snapshot_job.evaluation_inserted_count AS snapshot_job_evaluation_inserted_count,
          snapshot_job.evaluation_batch_count AS snapshot_job_evaluation_batch_count,
          snapshot_job.evaluation_backlog_may_remain AS snapshot_job_evaluation_backlog_may_remain,
          snapshot_job.error_code AS snapshot_job_error_code,
          snapshot_job.error_message AS snapshot_job_error_message,
          evaluation_job.id AS evaluation_job_id,
          evaluation_job.job_type AS evaluation_job_job_type,
          evaluation_job.status AS evaluation_job_status,
          evaluation_job.as_of AS evaluation_job_as_of,
          evaluation_job.started_at AS evaluation_job_started_at,
          evaluation_job.heartbeat_at AS evaluation_job_heartbeat_at,
          evaluation_job.lease_expires_at AS evaluation_job_lease_expires_at,
          evaluation_job.finished_at AS evaluation_job_finished_at,
          evaluation_job.recommendation_run_id AS evaluation_job_recommendation_run_id,
          evaluation_job.recommendation_line_count AS evaluation_job_recommendation_line_count,
          evaluation_job.forecast_observation_count AS evaluation_job_forecast_observation_count,
          evaluation_job.evaluation_inserted_count AS evaluation_job_evaluation_inserted_count,
          evaluation_job.evaluation_batch_count AS evaluation_job_evaluation_batch_count,
          evaluation_job.evaluation_backlog_may_remain AS evaluation_job_evaluation_backlog_may_remain,
          evaluation_job.error_code AS evaluation_job_error_code,
          evaluation_job.error_message AS evaluation_job_error_message,
          evaluation_state.latest_evaluation_at,
          matured_evaluation_backlog.backlog_count AS matured_evaluation_backlog
        FROM evaluation_state
        CROSS JOIN matured_evaluation_backlog
        LEFT JOIN latest_scheduled_evidence latest ON TRUE
        LEFT JOIN latest_job_runs snapshot_job
          ON snapshot_job.job_type = 'recommendation_snapshot'
        LEFT JOIN latest_job_runs evaluation_job
          ON evaluation_job.job_type = 'forecast_evaluation'
      `);
      const row = rowsOf(result)[0];
      if (!row) {
        throw new Error("Purchase recommendation pipeline health query returned no row");
      }
      return {
        latestScheduledRun: mapLatestScheduledRun(row),
        latestSnapshotJobRun: mapPipelineJobRun(
          row,
          "snapshot_job",
          "recommendation_snapshot",
        ),
        latestEvaluationJobRun: mapPipelineJobRun(
          row,
          "evaluation_job",
          "forecast_evaluation",
        ),
        latestEvaluationAt: nullableDate(row.latest_evaluation_at, "latestEvaluationAt"),
        maturedEvaluationBacklog: safeInteger(
          row.matured_evaluation_backlog,
          "maturedEvaluationBacklog",
        ),
      };
    },
  };
}
