import { db as defaultDb } from "../../db";
import {
  createPurchaseRecommendationPipelineHealthRepository,
  type PurchasePipelineJobRunEvidence,
  type PurchaseRecommendationPipelineEvidence,
} from "./purchase-recommendation-pipeline-health.repository";

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows?: unknown[] } | unknown[]>;
};

export const SCHEDULED_RECOMMENDATION_WARNING_AGE_HOURS = 30;
export const SCHEDULED_RECOMMENDATION_CRITICAL_AGE_HOURS = 54;
const ALLOWED_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type PurchaseRecommendationPipelineHealthStatus = "healthy" | "warning" | "critical";

export type PurchasePipelineJobRunHealth = {
  id: number;
  jobType: "recommendation_snapshot" | "forecast_evaluation";
  status: "running" | "succeeded" | "failed" | "interrupted";
  asOf: string;
  startedAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  ageHours: number;
  leaseExpired: boolean;
  recommendationRunId: number | null;
  recommendationLineCount: number | null;
  forecastObservationCount: number | null;
  evaluationInsertedCount: number | null;
  evaluationBatchCount: number | null;
  evaluationBacklogMayRemain: boolean | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type PurchaseRecommendationPipelineHealth = {
  generatedAt: string;
  status: PurchaseRecommendationPipelineHealthStatus;
  critical: number;
  warning: number;
  latestScheduledRun: {
    id: number;
    status: "completed" | "failed";
    asOf: string;
    generatedAt: string;
    ageHours: number;
    recommendationLineCount: number;
    observationCount: number;
  } | null;
  jobs: {
    recommendationSnapshot: PurchasePipelineJobRunHealth | null;
    forecastEvaluation: PurchasePipelineJobRunHealth | null;
  };
  latestEvaluationAt: string | null;
  maturedEvaluationBacklog: number;
  thresholds: {
    warningAgeHours: number;
    criticalAgeHours: number;
  };
  detail: string;
};

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
  return new Date(value.getTime());
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function plural(count: number, singular: string, pluralValue = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function nullableNonnegativeInteger(value: number | null, field: string): number | null {
  return value === null ? null : nonnegativeInteger(value, field);
}

function nullablePositiveInteger(value: number | null, field: string): number | null {
  return value === null ? null : positiveInteger(value, field);
}

function mapJobRun(
  run: PurchasePipelineJobRunEvidence | null,
  asOf: Date,
): { health: PurchasePipelineJobRunHealth | null; clockSkewDetected: boolean } {
  if (!run) return { health: null, clockSkewDetected: false };
  const startedAt = validDate(run.startedAt, `${run.jobType}.startedAt`);
  const heartbeatAt = validDate(run.heartbeatAt, `${run.jobType}.heartbeatAt`);
  const leaseExpiresAt = run.leaseExpiresAt
    ? validDate(run.leaseExpiresAt, `${run.jobType}.leaseExpiresAt`)
    : null;
  const finishedAt = run.finishedAt
    ? validDate(run.finishedAt, `${run.jobType}.finishedAt`)
    : null;
  const ageReference = finishedAt ?? heartbeatAt;
  const ageMs = asOf.getTime() - ageReference.getTime();
  const clockSkewDetected = (
    startedAt.getTime() > asOf.getTime() + ALLOWED_CLOCK_SKEW_MS
    || heartbeatAt.getTime() > asOf.getTime() + ALLOWED_CLOCK_SKEW_MS
    || (finishedAt?.getTime() ?? 0) > asOf.getTime() + ALLOWED_CLOCK_SKEW_MS
  );
  return {
    health: {
      id: positiveInteger(run.id, `${run.jobType}.id`),
      jobType: run.jobType,
      status: run.status,
      asOf: validDate(run.asOf, `${run.jobType}.asOf`).toISOString(),
      startedAt: startedAt.toISOString(),
      heartbeatAt: heartbeatAt.toISOString(),
      leaseExpiresAt: leaseExpiresAt?.toISOString() ?? null,
      finishedAt: finishedAt?.toISOString() ?? null,
      ageHours: Math.max(0, Math.floor(ageMs / (60 * 60 * 1_000))),
      leaseExpired: run.status === "running"
        && leaseExpiresAt !== null
        && leaseExpiresAt.getTime() <= asOf.getTime(),
      recommendationRunId: nullablePositiveInteger(
        run.recommendationRunId,
        `${run.jobType}.recommendationRunId`,
      ),
      recommendationLineCount: nullableNonnegativeInteger(
        run.recommendationLineCount,
        `${run.jobType}.recommendationLineCount`,
      ),
      forecastObservationCount: nullableNonnegativeInteger(
        run.forecastObservationCount,
        `${run.jobType}.forecastObservationCount`,
      ),
      evaluationInsertedCount: nullableNonnegativeInteger(
        run.evaluationInsertedCount,
        `${run.jobType}.evaluationInsertedCount`,
      ),
      evaluationBatchCount: nullableNonnegativeInteger(
        run.evaluationBatchCount,
        `${run.jobType}.evaluationBatchCount`,
      ),
      evaluationBacklogMayRemain: run.evaluationBacklogMayRemain,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
    },
    clockSkewDetected,
  };
}

type HealthIssue = {
  status: "warning" | "critical";
  detail: string;
};

function jobRunIssue(
  label: string,
  mapped: { health: PurchasePipelineJobRunHealth | null; clockSkewDetected: boolean },
  thresholds: { warningAgeHours: number; criticalAgeHours: number },
): HealthIssue | null {
  const run = mapped.health;
  if (!run) {
    return { status: "warning", detail: `No scheduled ${label} execution has been recorded.` };
  }
  if (run.status === "failed" || run.status === "interrupted") {
    return {
      status: "critical",
      detail: `Scheduled ${label} execution #${run.id} is ${run.status}`
        + `${run.errorCode ? ` (${run.errorCode})` : ""}.`,
    };
  }
  if (run.status === "running") {
    return run.leaseExpired
      ? {
          status: "critical",
          detail: `Scheduled ${label} execution #${run.id} exceeded its lease.`,
        }
      : {
          status: "warning",
          detail: `Scheduled ${label} execution #${run.id} is still running.`,
        };
  }
  if (mapped.clockSkewDetected) {
    return {
      status: "warning",
      detail: `Scheduled ${label} execution #${run.id} is ahead of the health-check clock.`,
    };
  }
  if (run.ageHours >= thresholds.criticalAgeHours) {
    return {
      status: "critical",
      detail: `Scheduled ${label} execution #${run.id} is critically stale at ${run.ageHours}h.`,
    };
  }
  if (run.ageHours >= thresholds.warningAgeHours) {
    return {
      status: "warning",
      detail: `Scheduled ${label} execution #${run.id} is overdue at ${run.ageHours}h.`,
    };
  }
  return null;
}

export function buildPurchaseRecommendationPipelineHealth(
  evidence: PurchaseRecommendationPipelineEvidence,
  options: {
    asOf?: Date;
    warningAgeHours?: number;
    criticalAgeHours?: number;
  } = {},
): PurchaseRecommendationPipelineHealth {
  const asOf = validDate(options.asOf ?? new Date(), "asOf");
  const warningAgeHours = positiveInteger(
    options.warningAgeHours ?? SCHEDULED_RECOMMENDATION_WARNING_AGE_HOURS,
    "warningAgeHours",
  );
  const criticalAgeHours = positiveInteger(
    options.criticalAgeHours ?? SCHEDULED_RECOMMENDATION_CRITICAL_AGE_HOURS,
    "criticalAgeHours",
  );
  if (criticalAgeHours <= warningAgeHours) {
    throw new RangeError("criticalAgeHours must be greater than warningAgeHours");
  }
  const maturedEvaluationBacklog = nonnegativeInteger(
    evidence.maturedEvaluationBacklog,
    "maturedEvaluationBacklog",
  );
  const latestEvaluationAt = evidence.latestEvaluationAt
    ? validDate(evidence.latestEvaluationAt, "latestEvaluationAt")
    : null;
  const latestRun = evidence.latestScheduledRun;
  const snapshotJob = mapJobRun(evidence.latestSnapshotJobRun, asOf);
  const evaluationJob = mapJobRun(evidence.latestEvaluationJobRun, asOf);

  let mappedLatestRun: PurchaseRecommendationPipelineHealth["latestScheduledRun"] = null;
  let latestRunClockSkewDetected = false;
  if (latestRun) {
    const generatedAt = validDate(latestRun.generatedAt, "latestScheduledRun.generatedAt");
    const runAsOf = validDate(latestRun.asOf, "latestScheduledRun.asOf");
    const ageMs = asOf.getTime() - generatedAt.getTime();
    latestRunClockSkewDetected = ageMs < -ALLOWED_CLOCK_SKEW_MS;
    const ageHours = Math.max(0, Math.floor(ageMs / (60 * 60 * 1_000)));
    const recommendationLineCount = nonnegativeInteger(
      latestRun.recommendationLineCount,
      "latestScheduledRun.recommendationLineCount",
    );
    const observationCount = nonnegativeInteger(
      latestRun.observationCount,
      "latestScheduledRun.observationCount",
    );
    const runId = positiveInteger(latestRun.id, "latestScheduledRun.id");
    if (latestRun.status !== "completed" && latestRun.status !== "failed") {
      throw new RangeError("latestScheduledRun.status is unsupported");
    }
    mappedLatestRun = {
      id: runId,
      status: latestRun.status,
      asOf: runAsOf.toISOString(),
      generatedAt: generatedAt.toISOString(),
      ageHours,
      recommendationLineCount,
      observationCount,
    };
  }

  const issues: HealthIssue[] = [];
  const snapshotIssue = jobRunIssue("recommendation snapshot", snapshotJob, {
    warningAgeHours,
    criticalAgeHours,
  });
  if (snapshotIssue) issues.push(snapshotIssue);
  const evaluationIssue = jobRunIssue("forecast evaluation", evaluationJob, {
    warningAgeHours,
    criticalAgeHours,
  });
  if (evaluationIssue) issues.push(evaluationIssue);

  if (snapshotJob.health?.status === "succeeded") {
    if (!mappedLatestRun) {
      issues.push({
        status: "critical",
        detail: `Snapshot execution #${snapshotJob.health.id} succeeded without visible output evidence.`,
      });
    } else if (
      snapshotJob.health.recommendationRunId !== mappedLatestRun.id
      || snapshotJob.health.recommendationLineCount !== mappedLatestRun.recommendationLineCount
      || snapshotJob.health.forecastObservationCount !== mappedLatestRun.observationCount
    ) {
      issues.push({
        status: "critical",
        detail: `Snapshot execution #${snapshotJob.health.id} does not match its immutable output.`,
      });
    }
  }
  if (mappedLatestRun?.status === "failed") {
    issues.push({
      status: "critical",
      detail: `Scheduled recommendation output #${mappedLatestRun.id} is marked failed.`,
    });
  }
  if (mappedLatestRun && latestRunClockSkewDetected) {
    issues.push({
      status: "warning",
      detail: `Scheduled recommendation output #${mappedLatestRun.id} is ahead of the health-check clock.`,
    });
  }
  if (
    evaluationJob.health?.status === "succeeded"
    && (evaluationJob.health.evaluationInsertedCount ?? 0) > 0
    && (
      latestEvaluationAt === null
      || latestEvaluationAt.getTime() < new Date(evaluationJob.health.asOf).getTime()
    )
  ) {
    issues.push({
      status: "critical",
      detail: `Forecast evaluation execution #${evaluationJob.health.id} inserted rows without matching evaluation evidence.`,
    });
  }
  if (evaluationJob.health?.evaluationBacklogMayRemain) {
    issues.push({
      status: "warning",
      detail: `Forecast evaluation execution #${evaluationJob.health.id} reached its batch cap.`,
    });
  }
  if (maturedEvaluationBacklog > 0) {
    issues.push({
      status: "warning",
      detail: `${plural(maturedEvaluationBacklog, "matured evaluation")} await processing.`,
    });
  }

  const status: PurchaseRecommendationPipelineHealthStatus = issues.some(
    (issue) => issue.status === "critical",
  )
    ? "critical"
    : issues.length > 0
      ? "warning"
      : "healthy";
  let detail: string;
  if (issues.length > 0) {
    detail = issues
      .sort((left, right) => (
        left.status === right.status ? 0 : left.status === "critical" ? -1 : 1
      ))
      .map((issue) => issue.detail)
      .join(" ");
  } else {
    if (!snapshotJob.health || !evaluationJob.health || !mappedLatestRun) {
      throw new Error("Healthy purchase recommendation pipeline evidence is incomplete");
    }
    detail = `Scheduled snapshot execution #${snapshotJob.health.id} and forecast evaluation `
      + `execution #${evaluationJob.health.id} are healthy. `
      + `${plural(mappedLatestRun.recommendationLineCount, "recommendation line")} and `
      + `${plural(mappedLatestRun.observationCount, "forecast observation")} were captured; `
      + "no matured evaluations are waiting.";
  }

  return {
    generatedAt: asOf.toISOString(),
    status,
    critical: status === "critical" ? 1 : 0,
    warning: status === "warning" ? 1 : 0,
    latestScheduledRun: mappedLatestRun,
    jobs: {
      recommendationSnapshot: snapshotJob.health,
      forecastEvaluation: evaluationJob.health,
    },
    latestEvaluationAt: latestEvaluationAt?.toISOString() ?? null,
    maturedEvaluationBacklog,
    thresholds: {
      warningAgeHours,
      criticalAgeHours,
    },
    detail,
  };
}

export async function loadPurchaseRecommendationPipelineHealth(options: {
  db?: DbWithExecute;
  asOf?: Date;
  warningAgeHours?: number;
  criticalAgeHours?: number;
} = {}): Promise<PurchaseRecommendationPipelineHealth> {
  const asOf = validDate(options.asOf ?? new Date(), "asOf");
  const repository = createPurchaseRecommendationPipelineHealthRepository(options.db ?? defaultDb);
  const evidence = await repository.loadEvidence({ asOf });
  return buildPurchaseRecommendationPipelineHealth(evidence, {
    asOf,
    warningAgeHours: options.warningAgeHours,
    criticalAgeHours: options.criticalAgeHours,
  });
}
