import { db as defaultDb } from "../../db";
import {
  createPurchaseRecommendationPipelineHealthRepository,
  type PurchaseRecommendationPipelineEvidence,
} from "./purchase-recommendation-pipeline-health.repository";

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows?: unknown[] } | unknown[]>;
};

export const SCHEDULED_RECOMMENDATION_WARNING_AGE_HOURS = 30;
export const SCHEDULED_RECOMMENDATION_CRITICAL_AGE_HOURS = 54;
const ALLOWED_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export type PurchaseRecommendationPipelineHealthStatus = "healthy" | "warning" | "critical";

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

  let status: PurchaseRecommendationPipelineHealthStatus = "healthy";
  let detail: string;
  let mappedLatestRun: PurchaseRecommendationPipelineHealth["latestScheduledRun"] = null;

  if (!latestRun) {
    status = "warning";
    detail = "No scheduled recommendation snapshot has been recorded.";
  } else {
    const generatedAt = validDate(latestRun.generatedAt, "latestScheduledRun.generatedAt");
    const runAsOf = validDate(latestRun.asOf, "latestScheduledRun.asOf");
    const ageMs = asOf.getTime() - generatedAt.getTime();
    const clockSkewDetected = ageMs < -ALLOWED_CLOCK_SKEW_MS;
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

    const runSummary = `Scheduled snapshot #${runId} is ${ageHours}h old with `
      + `${plural(recommendationLineCount, "recommendation line")} and `
      + `${plural(observationCount, "forecast observation")}.`;
    if (latestRun.status === "failed") {
      status = "critical";
      detail = `Scheduled snapshot #${runId} is marked failed.`;
    } else if (ageHours >= criticalAgeHours) {
      status = "critical";
      detail = `${runSummary} The daily recommendation pipeline is critically stale.`;
    } else if (clockSkewDetected) {
      status = "warning";
      detail = `${runSummary} Its timestamp is ahead of the health-check clock.`;
    } else if (ageHours >= warningAgeHours) {
      status = "warning";
      detail = `${runSummary} The next daily snapshot is overdue.`;
    } else if (maturedEvaluationBacklog > 0) {
      status = "warning";
      detail = `${runSummary} ${plural(maturedEvaluationBacklog, "matured evaluation")} await processing.`;
    } else {
      detail = `${runSummary} No matured forecast evaluations are waiting.`;
    }
  }

  return {
    generatedAt: asOf.toISOString(),
    status,
    critical: status === "critical" ? 1 : 0,
    warning: status === "warning" ? 1 : 0,
    latestScheduledRun: mappedLatestRun,
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
