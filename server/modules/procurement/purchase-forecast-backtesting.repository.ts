import { sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  purchaseForecastEvaluations as purchaseForecastEvaluationsTable,
  type PurchaseForecastEvaluationHorizonDays,
} from "@shared/schema";
import {
  buildPurchasingForecastPolicyCohort,
  PURCHASING_FORECAST_POLICY_CAPTURE_VERSION,
  type PurchasingForecastPolicyCohortSnapshot,
} from "./purchasing-forecast-policy";
import type {
  PurchaseForecastEvaluationCandidate,
  PurchaseForecastEvaluationInput,
  PurchaseForecastOverlayExclusionReason,
} from "./purchase-forecast-backtesting.domain";

export type PurchaseForecastPolicyCohortEvidence =
  | {
      captureVersion: 0;
      fingerprint: null;
      snapshot: null;
      forecastMethod: null;
      forecastVersion: null;
      observationCount: number;
      evaluationCount: number;
      firstObservedFrom: Date;
      latestObservedFrom: Date;
      latestEvaluationAt: Date | null;
    }
  | {
      captureVersion: typeof PURCHASING_FORECAST_POLICY_CAPTURE_VERSION;
      fingerprint: string;
      snapshot: PurchasingForecastPolicyCohortSnapshot;
      forecastMethod: string;
      forecastVersion: number;
      observationCount: number;
      evaluationCount: number;
      firstObservedFrom: Date;
      latestObservedFrom: Date;
      latestEvaluationAt: Date | null;
    };

export type PurchaseForecastEvaluationAggregateRow = {
  horizonDays: PurchaseForecastEvaluationHorizonDays;
  evaluationCount: number;
  actualDemandPieces: number;
  forecastDemandMicros: number;
  baselineDemandMicros: number;
  forecastAbsoluteErrorMicros: number;
  baselineAbsoluteErrorMicros: number;
  forecastBiasMicros: number;
  baselineBiasMicros: number;
  forecastWinCount: number;
  baselineWinCount: number;
  tieCount: number;
  zeroActualCount: number;
  observationsWithForwardDemand: number;
  overlayEvaluationCount: number;
  overlayActualDemandPieces: number;
  overlayRawDemandPieces: number;
  overlayWeightedDemandPieces: number;
  overlayCohortForecastAbsoluteErrorMicros: number;
  overlayAdjustedForecastDemandMicros: number;
  overlayAdjustedAbsoluteErrorMicros: number;
  overlayAdjustedBiasMicros: number;
  overlayWinCount: number;
  historicalForecastWinCount: number;
  overlayTieCount: number;
  observationsWithAttributedOverlay: number;
};

export type PurchaseForecastEvaluationReportItem = {
  id: number;
  observationId: number;
  runId: number;
  productId: number;
  productSku: string;
  productName: string;
  horizonDays: PurchaseForecastEvaluationHorizonDays;
  forecastMethod: string;
  forecastVersion: number;
  forecastPolicyCaptureVersion: typeof PURCHASING_FORECAST_POLICY_CAPTURE_VERSION;
  forecastPolicyFingerprint: string;
  evaluationVersion: number;
  observedFrom: Date;
  observedThroughExclusive: Date;
  actualDemandPieces: number;
  actualOrderCount: number;
  actualActiveDays: number;
  latestActualDemandAt: Date | null;
  forecastDemandMicros: number;
  baselineDemandMicros: number;
  forecastAbsoluteErrorMicros: number;
  baselineAbsoluteErrorMicros: number;
  forecastBiasMicros: number;
  baselineBiasMicros: number;
  forwardDemandPieces: number;
  forwardDemandRawPieces: number;
  overlayCaptureVersion: number;
  overlayCaptureComplete: boolean;
  overlayPlanningAsOfDate: string | null;
  overlayHorizonDays: number | null;
  overlayAttributionVersion: number;
  overlayEvaluable: boolean;
  overlayExclusionReason: PurchaseForecastOverlayExclusionReason | null;
  overlayContributionCount: number | null;
  overlayRawDemandPieces: number | null;
  overlayWeightedDemandPieces: number | null;
  overlayAdjustedForecastDemandMicros: number | null;
  overlayAdjustedAbsoluteErrorMicros: number | null;
  overlayAdjustedBiasMicros: number | null;
  demandQueryVersion: string;
  evaluatedBy: string | null;
  evaluatedAt: Date;
};

function safeInteger(value: unknown, field: string, minimum = Number.MIN_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new RangeError(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function validDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`${field} must be a valid date`);
  return parsed;
}

function nullableDate(value: unknown, field: string): Date | null {
  return value == null ? null : validDate(value, field);
}

function booleanValue(value: unknown, field: string): boolean {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RangeError(`${field} must be boolean`);
}

function nullableSafeInteger(value: unknown, field: string, minimum = Number.MIN_SAFE_INTEGER): number | null {
  return value == null ? null : safeInteger(value, field, minimum);
}

function nullableCalendarDate(value: unknown, field: string): string | null {
  if (value == null) return null;
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new RangeError(`${field} must be an ISO calendar date`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new RangeError(`${field} must be a valid ISO calendar date`);
  }
  return text;
}

function calendarDate(value: unknown, field: string): string {
  const parsed = nullableCalendarDate(value, field);
  if (parsed === null) throw new RangeError(`${field} is required`);
  return parsed;
}

function overlayContributions(value: unknown): PurchaseForecastEvaluationCandidate["overlayContributions"] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new RangeError("overlayContributions must contain valid JSON");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new RangeError("overlayContributions must be an array");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RangeError(`overlayContributions[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    return {
      demandEventId: safeInteger(row.demandEventId, `overlayContributions[${index}].demandEventId`, 1),
      demandEventLineId: safeInteger(
        row.demandEventLineId,
        `overlayContributions[${index}].demandEventLineId`,
        1,
      ),
      eventStartDate: calendarDate(
        row.eventStartDate,
        `overlayContributions[${index}].eventStartDate`,
      ),
      planningAsOfDate: calendarDate(
        row.planningAsOfDate,
        `overlayContributions[${index}].planningAsOfDate`,
      ),
      expectedPieces: safeInteger(row.expectedPieces, `overlayContributions[${index}].expectedPieces`, 0),
      weightedPieces: safeInteger(row.weightedPieces, `overlayContributions[${index}].weightedPieces`, 0),
    };
  });
}

function overlayExclusionReason(value: unknown): PurchaseForecastOverlayExclusionReason | null {
  if (value == null) return null;
  if (
    value === "legacy_evaluation"
    || value === "capture_incomplete"
    || value === "capture_coverage_unavailable"
    || value === "capture_horizon_insufficient"
    || value === "capture_planning_date_mismatch"
  ) {
    return value;
  }
  throw new RangeError("overlayExclusionReason is not supported");
}

function horizonDays(value: unknown): PurchaseForecastEvaluationHorizonDays {
  const parsed = safeInteger(value, "horizonDays", 1);
  if (parsed !== 7 && parsed !== 30 && parsed !== 90) {
    throw new RangeError("horizonDays must be one of 7, 30, or 90");
  }
  return parsed;
}

function rowsOf(result: any): any[] {
  return Array.isArray(result?.rows) ? result.rows : Array.isArray(result) ? result : [];
}

function jsonObject(value: unknown, field: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new RangeError(`${field} must contain valid JSON`);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RangeError(`${field} must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function capturedPolicyCohort(input: {
  captureVersion: unknown;
  fingerprint: unknown;
  snapshot: unknown;
  field: string;
}) {
  const captureVersion = safeInteger(input.captureVersion, `${input.field}.captureVersion`, 0);
  if (captureVersion !== PURCHASING_FORECAST_POLICY_CAPTURE_VERSION) {
    throw new RangeError(`${input.field}.captureVersion is unsupported`);
  }
  if (typeof input.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(input.fingerprint)) {
    throw new RangeError(`${input.field}.fingerprint must be a lowercase SHA-256`);
  }
  const snapshot = jsonObject(input.snapshot, `${input.field}.snapshot`);
  const canonical = buildPurchasingForecastPolicyCohort(snapshot);
  if (
    canonical.fingerprint !== input.fingerprint
    || !isDeepStrictEqual(canonical.snapshot, snapshot)
  ) {
    throw new RangeError(`${input.field} does not match its canonical policy snapshot`);
  }
  return canonical;
}

function mapPolicyCohort(row: any): PurchaseForecastPolicyCohortEvidence {
  const captureVersion = safeInteger(row.forecast_policy_capture_version, "policyCohort.captureVersion", 0);
  const common = {
    observationCount: safeInteger(row.observation_count, "policyCohort.observationCount", 1),
    evaluationCount: safeInteger(row.evaluation_count, "policyCohort.evaluationCount", 0),
    firstObservedFrom: validDate(row.first_observed_from, "policyCohort.firstObservedFrom"),
    latestObservedFrom: validDate(row.latest_observed_from, "policyCohort.latestObservedFrom"),
    latestEvaluationAt: nullableDate(row.latest_evaluation_at, "policyCohort.latestEvaluationAt"),
  };
  if (captureVersion === 0) {
    if (row.forecast_policy_fingerprint != null || row.forecast_policy_snapshot != null) {
      throw new RangeError("Legacy policy cohort cannot contain captured policy evidence");
    }
    return {
      captureVersion: 0,
      fingerprint: null,
      snapshot: null,
      forecastMethod: null,
      forecastVersion: null,
      ...common,
    };
  }
  const canonical = capturedPolicyCohort({
    captureVersion,
    fingerprint: row.forecast_policy_fingerprint,
    snapshot: row.forecast_policy_snapshot,
    field: "policyCohort",
  });
  const forecastMethod = String(row.forecast_method ?? "");
  if (forecastMethod !== canonical.snapshot.method) {
    throw new RangeError("policyCohort forecast method does not match its canonical policy snapshot");
  }
  return {
    captureVersion: canonical.captureVersion,
    fingerprint: canonical.fingerprint,
    snapshot: canonical.snapshot,
    forecastMethod,
    forecastVersion: safeInteger(row.forecast_version, "policyCohort.forecastVersion", 1),
    ...common,
  };
}

function mapCandidate(row: any): PurchaseForecastEvaluationCandidate {
  if (row.scope !== "product_all_warehouses") {
    throw new RangeError(`Unsupported forecast observation scope: ${String(row.scope)}`);
  }
  return {
    observationId: safeInteger(row.observation_id, "observationId", 1),
    runId: safeInteger(row.run_id, "runId", 1),
    productId: safeInteger(row.product_id, "productId", 1),
    productSku: String(row.product_sku ?? ""),
    productName: String(row.product_name ?? ""),
    scope: row.scope,
    forecastMethod: String(row.forecast_method ?? ""),
    forecastVersion: safeInteger(row.forecast_version, "forecastVersion", 1),
    horizonDays: horizonDays(row.horizon_days),
    observedFrom: validDate(row.observed_from, "observedFrom"),
    observedThroughExclusive: validDate(row.observed_through_exclusive, "observedThroughExclusive"),
    forecastDailyPiecesMicros: safeInteger(row.forecast_daily_pieces_micros, "forecastDailyPiecesMicros", 0),
    baselineDailyPiecesMicros: safeInteger(row.baseline_daily_pieces_micros, "baselineDailyPiecesMicros", 0),
    forwardDemandPieces: safeInteger(row.forward_demand_pieces, "forwardDemandPieces", 0),
    forwardDemandRawPieces: safeInteger(row.forward_demand_raw_pieces, "forwardDemandRawPieces", 0),
    overlayCaptureVersion: safeInteger(row.overlay_capture_version, "overlayCaptureVersion", 0),
    overlayCaptureComplete: booleanValue(row.overlay_capture_complete, "overlayCaptureComplete"),
    overlayPlanningAsOfDate: nullableCalendarDate(row.overlay_planning_as_of_date, "overlayPlanningAsOfDate"),
    overlayHorizonDays: nullableSafeInteger(row.overlay_horizon_days, "overlayHorizonDays", 1),
    overlayContributions: overlayContributions(row.overlay_contributions),
    actualDemandPieces: safeInteger(row.actual_demand_pieces, "actualDemandPieces", 0),
    actualOrderCount: safeInteger(row.actual_order_count, "actualOrderCount", 0),
    actualActiveDays: safeInteger(row.actual_active_days, "actualActiveDays", 0),
    latestActualDemandAt: nullableDate(row.latest_actual_demand_at, "latestActualDemandAt"),
  };
}

function mapAggregate(row: any): PurchaseForecastEvaluationAggregateRow {
  return {
    horizonDays: horizonDays(row.horizon_days),
    evaluationCount: safeInteger(row.evaluation_count, "evaluationCount", 0),
    actualDemandPieces: safeInteger(row.actual_demand_pieces, "actualDemandPieces", 0),
    forecastDemandMicros: safeInteger(row.forecast_demand_micros, "forecastDemandMicros", 0),
    baselineDemandMicros: safeInteger(row.baseline_demand_micros, "baselineDemandMicros", 0),
    forecastAbsoluteErrorMicros: safeInteger(row.forecast_absolute_error_micros, "forecastAbsoluteErrorMicros", 0),
    baselineAbsoluteErrorMicros: safeInteger(row.baseline_absolute_error_micros, "baselineAbsoluteErrorMicros", 0),
    forecastBiasMicros: safeInteger(row.forecast_bias_micros, "forecastBiasMicros"),
    baselineBiasMicros: safeInteger(row.baseline_bias_micros, "baselineBiasMicros"),
    forecastWinCount: safeInteger(row.forecast_win_count, "forecastWinCount", 0),
    baselineWinCount: safeInteger(row.baseline_win_count, "baselineWinCount", 0),
    tieCount: safeInteger(row.tie_count, "tieCount", 0),
    zeroActualCount: safeInteger(row.zero_actual_count, "zeroActualCount", 0),
    observationsWithForwardDemand: safeInteger(row.observations_with_forward_demand, "observationsWithForwardDemand", 0),
    overlayEvaluationCount: safeInteger(row.overlay_evaluation_count, "overlayEvaluationCount", 0),
    overlayActualDemandPieces: safeInteger(row.overlay_actual_demand_pieces, "overlayActualDemandPieces", 0),
    overlayRawDemandPieces: safeInteger(row.overlay_raw_demand_pieces, "overlayRawDemandPieces", 0),
    overlayWeightedDemandPieces: safeInteger(
      row.overlay_weighted_demand_pieces,
      "overlayWeightedDemandPieces",
      0,
    ),
    overlayCohortForecastAbsoluteErrorMicros: safeInteger(
      row.overlay_cohort_forecast_absolute_error_micros,
      "overlayCohortForecastAbsoluteErrorMicros",
      0,
    ),
    overlayAdjustedForecastDemandMicros: safeInteger(
      row.overlay_adjusted_forecast_demand_micros,
      "overlayAdjustedForecastDemandMicros",
      0,
    ),
    overlayAdjustedAbsoluteErrorMicros: safeInteger(
      row.overlay_adjusted_absolute_error_micros,
      "overlayAdjustedAbsoluteErrorMicros",
      0,
    ),
    overlayAdjustedBiasMicros: safeInteger(row.overlay_adjusted_bias_micros, "overlayAdjustedBiasMicros"),
    overlayWinCount: safeInteger(row.overlay_win_count, "overlayWinCount", 0),
    historicalForecastWinCount: safeInteger(
      row.historical_forecast_win_count,
      "historicalForecastWinCount",
      0,
    ),
    overlayTieCount: safeInteger(row.overlay_tie_count, "overlayTieCount", 0),
    observationsWithAttributedOverlay: safeInteger(
      row.observations_with_attributed_overlay,
      "observationsWithAttributedOverlay",
      0,
    ),
  };
}

function mapReportItem(row: any): PurchaseForecastEvaluationReportItem {
  const policyCohort = capturedPolicyCohort({
    captureVersion: row.forecast_policy_capture_version,
    fingerprint: row.forecast_policy_fingerprint,
    snapshot: row.forecast_policy_snapshot,
    field: "forecastReportItem.policyCohort",
  });
  const forecastMethod = String(row.forecast_method ?? "");
  if (forecastMethod !== policyCohort.snapshot.method) {
    throw new RangeError("Forecast report method does not match its policy cohort");
  }
  const overlayAttributionVersion = safeInteger(
    row.overlay_attribution_version,
    "overlayAttributionVersion",
    0,
  );
  const overlayEvaluable = booleanValue(row.overlay_evaluable, "overlayEvaluable");
  const parsedOverlayExclusionReason = overlayExclusionReason(row.overlay_exclusion_reason);
  const overlayContributionCount = nullableSafeInteger(
    row.overlay_contribution_count,
    "overlayContributionCount",
    0,
  );
  const overlayRawDemandPieces = nullableSafeInteger(row.overlay_raw_demand_pieces, "overlayRawDemandPieces", 0);
  const overlayWeightedDemandPieces = nullableSafeInteger(
    row.overlay_weighted_demand_pieces,
    "overlayWeightedDemandPieces",
    0,
  );
  const overlayAdjustedForecastDemandMicros = nullableSafeInteger(
    row.overlay_adjusted_forecast_demand_micros,
    "overlayAdjustedForecastDemandMicros",
    0,
  );
  const overlayAdjustedAbsoluteErrorMicros = nullableSafeInteger(
    row.overlay_adjusted_absolute_error_micros,
    "overlayAdjustedAbsoluteErrorMicros",
    0,
  );
  const overlayAdjustedBiasMicros = nullableSafeInteger(
    row.overlay_adjusted_bias_micros,
    "overlayAdjustedBiasMicros",
  );
  const overlayMetrics = [
    overlayContributionCount,
    overlayRawDemandPieces,
    overlayWeightedDemandPieces,
    overlayAdjustedForecastDemandMicros,
    overlayAdjustedAbsoluteErrorMicros,
    overlayAdjustedBiasMicros,
  ];
  if (
    !overlayEvaluable
    && (
      overlayAttributionVersion !== 0
      || parsedOverlayExclusionReason === null
      || overlayMetrics.some((value) => value !== null)
    )
  ) {
    throw new RangeError("Non-evaluable forecast report row contains overlay metrics");
  }
  if (
    overlayEvaluable
    && (
      overlayAttributionVersion <= 0
      || parsedOverlayExclusionReason !== null
      || overlayMetrics.some((value) => value === null)
    )
  ) {
    throw new RangeError("Evaluable forecast report row is missing overlay metrics");
  }

  return {
    id: safeInteger(row.id, "id", 1),
    observationId: safeInteger(row.observation_id, "observationId", 1),
    runId: safeInteger(row.run_id, "runId", 1),
    productId: safeInteger(row.product_id, "productId", 1),
    productSku: String(row.product_sku ?? ""),
    productName: String(row.product_name ?? ""),
    horizonDays: horizonDays(row.horizon_days),
    forecastMethod,
    forecastVersion: safeInteger(row.forecast_version, "forecastVersion", 1),
    forecastPolicyCaptureVersion: policyCohort.captureVersion,
    forecastPolicyFingerprint: policyCohort.fingerprint,
    evaluationVersion: safeInteger(row.evaluation_version, "evaluationVersion", 1),
    observedFrom: validDate(row.observed_from, "observedFrom"),
    observedThroughExclusive: validDate(row.observed_through_exclusive, "observedThroughExclusive"),
    actualDemandPieces: safeInteger(row.actual_demand_pieces, "actualDemandPieces", 0),
    actualOrderCount: safeInteger(row.actual_order_count, "actualOrderCount", 0),
    actualActiveDays: safeInteger(row.actual_active_days, "actualActiveDays", 0),
    latestActualDemandAt: nullableDate(row.latest_actual_demand_at, "latestActualDemandAt"),
    forecastDemandMicros: safeInteger(row.forecast_demand_micros, "forecastDemandMicros", 0),
    baselineDemandMicros: safeInteger(row.baseline_demand_micros, "baselineDemandMicros", 0),
    forecastAbsoluteErrorMicros: safeInteger(row.forecast_absolute_error_micros, "forecastAbsoluteErrorMicros", 0),
    baselineAbsoluteErrorMicros: safeInteger(row.baseline_absolute_error_micros, "baselineAbsoluteErrorMicros", 0),
    forecastBiasMicros: safeInteger(row.forecast_bias_micros, "forecastBiasMicros"),
    baselineBiasMicros: safeInteger(row.baseline_bias_micros, "baselineBiasMicros"),
    forwardDemandPieces: safeInteger(row.forward_demand_pieces, "forwardDemandPieces", 0),
    forwardDemandRawPieces: safeInteger(row.forward_demand_raw_pieces, "forwardDemandRawPieces", 0),
    overlayCaptureVersion: safeInteger(row.overlay_capture_version, "overlayCaptureVersion", 0),
    overlayCaptureComplete: booleanValue(row.overlay_capture_complete, "overlayCaptureComplete"),
    overlayPlanningAsOfDate: nullableCalendarDate(row.overlay_planning_as_of_date, "overlayPlanningAsOfDate"),
    overlayHorizonDays: nullableSafeInteger(row.overlay_horizon_days, "overlayHorizonDays", 1),
    overlayAttributionVersion,
    overlayEvaluable,
    overlayExclusionReason: parsedOverlayExclusionReason,
    overlayContributionCount,
    overlayRawDemandPieces,
    overlayWeightedDemandPieces,
    overlayAdjustedForecastDemandMicros,
    overlayAdjustedAbsoluteErrorMicros,
    overlayAdjustedBiasMicros,
    demandQueryVersion: String(row.demand_query_version ?? ""),
    evaluatedBy: row.evaluated_by == null ? null : String(row.evaluated_by),
    evaluatedAt: validDate(row.evaluated_at, "evaluatedAt"),
  };
}

export function createPurchaseForecastBacktestingRepository(database: any) {
  async function loadPolicyCohorts(input: {
    evaluationVersion: number;
    horizonDays?: PurchaseForecastEvaluationHorizonDays;
  }): Promise<PurchaseForecastPolicyCohortEvidence[]> {
    const result = await database.execute(sql`
      SELECT
        observation.forecast_policy_capture_version,
        observation.forecast_policy_fingerprint,
        observation.forecast_policy_snapshot,
        CASE
          WHEN observation.forecast_policy_capture_version = ${PURCHASING_FORECAST_POLICY_CAPTURE_VERSION}
            THEN observation.forecast_method
          ELSE NULL
        END AS forecast_method,
        CASE
          WHEN observation.forecast_policy_capture_version = ${PURCHASING_FORECAST_POLICY_CAPTURE_VERSION}
            THEN observation.forecast_version
          ELSE NULL
        END AS forecast_version,
        COUNT(DISTINCT observation.id)::int AS observation_count,
        COUNT(evaluation.id)::int AS evaluation_count,
        MIN(recommendation_run.as_of) AS first_observed_from,
        MAX(recommendation_run.as_of) AS latest_observed_from,
        MAX(evaluation.evaluated_at) AS latest_evaluation_at
      FROM procurement.purchase_forecast_observations observation
      JOIN procurement.purchase_recommendation_runs recommendation_run
        ON recommendation_run.id = observation.run_id
      LEFT JOIN procurement.purchase_forecast_evaluations evaluation
        ON evaluation.observation_id = observation.id
       AND evaluation.evaluation_version = ${input.evaluationVersion}
       AND (${input.horizonDays ?? null}::int IS NULL OR evaluation.horizon_days = ${input.horizonDays ?? null})
      WHERE recommendation_run.status = 'completed'
      GROUP BY
        observation.forecast_policy_capture_version,
        observation.forecast_policy_fingerprint,
        observation.forecast_policy_snapshot,
        CASE
          WHEN observation.forecast_policy_capture_version = ${PURCHASING_FORECAST_POLICY_CAPTURE_VERSION}
            THEN observation.forecast_method
          ELSE NULL
        END,
        CASE
          WHEN observation.forecast_policy_capture_version = ${PURCHASING_FORECAST_POLICY_CAPTURE_VERSION}
            THEN observation.forecast_version
          ELSE NULL
        END
      ORDER BY
        MAX(observation.created_at) DESC,
        observation.forecast_policy_fingerprint NULLS LAST
    `);
    return rowsOf(result).map(mapPolicyCohort);
  }

  async function loadMaturedCandidates(input: {
    asOf: Date;
    horizons: PurchaseForecastEvaluationHorizonDays[];
    evaluationVersion: number;
    limit: number;
  }): Promise<PurchaseForecastEvaluationCandidate[]> {
    const horizonSql = sql.join(input.horizons.map((value) => sql`${value}`), sql`, `);
    const result = await database.execute(sql`
      WITH candidate_windows AS (
        SELECT
          observation.id AS observation_id,
          observation.run_id,
          observation.product_id,
          observation.product_sku,
          observation.product_name,
          observation.scope,
          observation.forecast_method,
          observation.forecast_version,
          observation.forecast_daily_pieces_micros,
          observation.baseline_daily_pieces_micros,
          observation.forward_demand_pieces,
          observation.forward_demand_raw_pieces,
          observation.overlay_capture_version,
          observation.overlay_capture_complete,
          observation.overlay_planning_as_of_date,
          observation.overlay_horizon_days,
          COALESCE((
            SELECT JSONB_AGG(
              JSONB_BUILD_OBJECT(
                'demandEventId', contribution.demand_event_id,
                'demandEventLineId', contribution.demand_event_line_id,
                'eventStartDate', contribution.event_start_date,
                'planningAsOfDate', contribution.planning_as_of_date,
                'expectedPieces', contribution.expected_pieces,
                'weightedPieces', contribution.weighted_pieces
              )
              ORDER BY
                contribution.event_start_date,
                contribution.demand_event_id,
                contribution.demand_event_line_id
            )
            FROM procurement.purchase_forecast_overlay_contributions contribution
            WHERE contribution.observation_id = observation.id
          ), '[]'::jsonb) AS overlay_contributions,
          recommendation_run.as_of AS observed_from,
          horizon.horizon_days,
          recommendation_run.as_of + MAKE_INTERVAL(days => horizon.horizon_days) AS observed_through_exclusive
        FROM procurement.purchase_forecast_observations observation
        JOIN procurement.purchase_recommendation_runs recommendation_run
          ON recommendation_run.id = observation.run_id
        CROSS JOIN UNNEST(ARRAY[${horizonSql}]::int[]) AS horizon(horizon_days)
        LEFT JOIN procurement.purchase_forecast_evaluations evaluation
          ON evaluation.observation_id = observation.id
         AND evaluation.horizon_days = horizon.horizon_days
         AND evaluation.evaluation_version = ${input.evaluationVersion}
        WHERE recommendation_run.status = 'completed'
          AND observation.scope = 'product_all_warehouses'
          AND evaluation.id IS NULL
          AND recommendation_run.as_of + MAKE_INTERVAL(days => horizon.horizon_days) <= ${input.asOf}
        ORDER BY recommendation_run.as_of, observation.id, horizon.horizon_days
        LIMIT ${input.limit}
      )
      SELECT
        candidate.*,
        COALESCE(SUM(
          CASE WHEN variant.id IS NOT NULL
            THEN order_item.quantity::bigint * variant.units_per_variant::bigint
            ELSE 0
          END
        ), 0)::bigint AS actual_demand_pieces,
        COUNT(DISTINCT customer_order.id) FILTER (WHERE variant.id IS NOT NULL)::int AS actual_order_count,
        COUNT(DISTINCT DATE(customer_order.order_placed_at)) FILTER (WHERE variant.id IS NOT NULL)::int AS actual_active_days,
        MAX(customer_order.order_placed_at) FILTER (WHERE variant.id IS NOT NULL) AS latest_actual_demand_at
      FROM candidate_windows candidate
      LEFT JOIN wms.orders customer_order
        ON customer_order.order_placed_at >= candidate.observed_from
       AND customer_order.order_placed_at < candidate.observed_through_exclusive
       AND customer_order.cancelled_at IS NULL
       AND customer_order.warehouse_status != 'cancelled'
      LEFT JOIN wms.order_items order_item
        ON order_item.order_id = customer_order.id
       AND order_item.status != 'cancelled'
       AND COALESCE(order_item.requires_shipping, 1) = 1
      LEFT JOIN catalog.product_variants variant
        ON variant.sku = order_item.sku
       AND variant.product_id = candidate.product_id
       AND variant.is_active = true
      GROUP BY
        candidate.observation_id,
        candidate.run_id,
        candidate.product_id,
        candidate.product_sku,
        candidate.product_name,
        candidate.scope,
        candidate.forecast_method,
        candidate.forecast_version,
        candidate.forecast_daily_pieces_micros,
        candidate.baseline_daily_pieces_micros,
        candidate.forward_demand_pieces,
        candidate.forward_demand_raw_pieces,
        candidate.overlay_capture_version,
        candidate.overlay_capture_complete,
        candidate.overlay_planning_as_of_date,
        candidate.overlay_horizon_days,
        candidate.overlay_contributions,
        candidate.observed_from,
        candidate.horizon_days,
        candidate.observed_through_exclusive
      ORDER BY candidate.observed_from, candidate.observation_id, candidate.horizon_days
    `);
    return rowsOf(result).map(mapCandidate);
  }

  async function insertEvaluations(inputs: PurchaseForecastEvaluationInput[]) {
    if (inputs.length === 0) return [];
    return database.insert(purchaseForecastEvaluationsTable).values(inputs).onConflictDoNothing({
      target: [
        purchaseForecastEvaluationsTable.observationId,
        purchaseForecastEvaluationsTable.horizonDays,
        purchaseForecastEvaluationsTable.evaluationVersion,
      ],
    }).returning({
      id: purchaseForecastEvaluationsTable.id,
      observationId: purchaseForecastEvaluationsTable.observationId,
      horizonDays: purchaseForecastEvaluationsTable.horizonDays,
    });
  }

  async function loadAggregates(input: {
    evaluationVersion: number;
    horizonDays?: PurchaseForecastEvaluationHorizonDays;
    policyFingerprint: string;
    forecastMethod: string;
    forecastVersion: number;
  }): Promise<PurchaseForecastEvaluationAggregateRow[]> {
    const result = await database.execute(sql`
      SELECT
        evaluation.horizon_days,
        COUNT(*)::int AS evaluation_count,
        COALESCE(SUM(evaluation.actual_demand_pieces), 0)::bigint AS actual_demand_pieces,
        COALESCE(SUM(evaluation.forecast_demand_micros), 0)::bigint AS forecast_demand_micros,
        COALESCE(SUM(evaluation.baseline_demand_micros), 0)::bigint AS baseline_demand_micros,
        COALESCE(SUM(evaluation.forecast_absolute_error_micros), 0)::bigint AS forecast_absolute_error_micros,
        COALESCE(SUM(evaluation.baseline_absolute_error_micros), 0)::bigint AS baseline_absolute_error_micros,
        COALESCE(SUM(evaluation.forecast_bias_micros), 0)::bigint AS forecast_bias_micros,
        COALESCE(SUM(evaluation.baseline_bias_micros), 0)::bigint AS baseline_bias_micros,
        COUNT(*) FILTER (
          WHERE evaluation.forecast_absolute_error_micros < evaluation.baseline_absolute_error_micros
        )::int AS forecast_win_count,
        COUNT(*) FILTER (
          WHERE evaluation.baseline_absolute_error_micros < evaluation.forecast_absolute_error_micros
        )::int AS baseline_win_count,
        COUNT(*) FILTER (
          WHERE evaluation.forecast_absolute_error_micros = evaluation.baseline_absolute_error_micros
        )::int AS tie_count,
        COUNT(*) FILTER (WHERE evaluation.actual_demand_pieces = 0)::int AS zero_actual_count,
        COUNT(*) FILTER (WHERE observation.forward_demand_pieces > 0)::int AS observations_with_forward_demand,
        COUNT(*) FILTER (WHERE evaluation.overlay_evaluable)::int AS overlay_evaluation_count,
        COALESCE(SUM(evaluation.actual_demand_pieces) FILTER (
          WHERE evaluation.overlay_evaluable
        ), 0)::bigint AS overlay_actual_demand_pieces,
        COALESCE(SUM(evaluation.overlay_raw_demand_pieces) FILTER (
          WHERE evaluation.overlay_evaluable
        ), 0)::bigint AS overlay_raw_demand_pieces,
        COALESCE(SUM(evaluation.overlay_weighted_demand_pieces) FILTER (
          WHERE evaluation.overlay_evaluable
        ), 0)::bigint AS overlay_weighted_demand_pieces,
        COALESCE(SUM(evaluation.forecast_absolute_error_micros) FILTER (
          WHERE evaluation.overlay_evaluable
        ), 0)::bigint AS overlay_cohort_forecast_absolute_error_micros,
        COALESCE(SUM(evaluation.overlay_adjusted_forecast_demand_micros) FILTER (
          WHERE evaluation.overlay_evaluable
        ), 0)::bigint AS overlay_adjusted_forecast_demand_micros,
        COALESCE(SUM(evaluation.overlay_adjusted_absolute_error_micros) FILTER (
          WHERE evaluation.overlay_evaluable
        ), 0)::bigint AS overlay_adjusted_absolute_error_micros,
        COALESCE(SUM(evaluation.overlay_adjusted_bias_micros) FILTER (
          WHERE evaluation.overlay_evaluable
        ), 0)::bigint AS overlay_adjusted_bias_micros,
        COUNT(*) FILTER (
          WHERE evaluation.overlay_evaluable
            AND evaluation.overlay_adjusted_absolute_error_micros < evaluation.forecast_absolute_error_micros
        )::int AS overlay_win_count,
        COUNT(*) FILTER (
          WHERE evaluation.overlay_evaluable
            AND evaluation.forecast_absolute_error_micros < evaluation.overlay_adjusted_absolute_error_micros
        )::int AS historical_forecast_win_count,
        COUNT(*) FILTER (
          WHERE evaluation.overlay_evaluable
            AND evaluation.overlay_adjusted_absolute_error_micros = evaluation.forecast_absolute_error_micros
        )::int AS overlay_tie_count,
        COUNT(*) FILTER (
          WHERE evaluation.overlay_evaluable
            AND evaluation.overlay_weighted_demand_pieces > 0
        )::int AS observations_with_attributed_overlay
      FROM procurement.purchase_forecast_evaluations evaluation
      JOIN procurement.purchase_forecast_observations observation
        ON observation.id = evaluation.observation_id
      WHERE evaluation.evaluation_version = ${input.evaluationVersion}
        AND (${input.horizonDays ?? null}::int IS NULL OR evaluation.horizon_days = ${input.horizonDays ?? null})
        AND observation.forecast_policy_capture_version = ${PURCHASING_FORECAST_POLICY_CAPTURE_VERSION}
        AND observation.forecast_policy_fingerprint = ${input.policyFingerprint}
        AND observation.forecast_method = ${input.forecastMethod}
        AND observation.forecast_version = ${input.forecastVersion}
      GROUP BY evaluation.horizon_days
      ORDER BY evaluation.horizon_days
    `);
    return rowsOf(result).map(mapAggregate);
  }

  async function loadRecent(input: {
    evaluationVersion: number;
    horizonDays?: PurchaseForecastEvaluationHorizonDays;
    limit: number;
    policyFingerprint: string;
    forecastMethod: string;
    forecastVersion: number;
  }): Promise<PurchaseForecastEvaluationReportItem[]> {
    const result = await database.execute(sql`
      SELECT
        evaluation.id,
        evaluation.observation_id,
        observation.run_id,
        observation.product_id,
        observation.product_sku,
        observation.product_name,
        evaluation.horizon_days,
        observation.forecast_method,
        observation.forecast_version,
        observation.forecast_policy_capture_version,
        observation.forecast_policy_fingerprint,
        observation.forecast_policy_snapshot,
        evaluation.evaluation_version,
        evaluation.observed_from,
        evaluation.observed_through_exclusive,
        evaluation.actual_demand_pieces,
        evaluation.actual_order_count,
        evaluation.actual_active_days,
        evaluation.latest_actual_demand_at,
        evaluation.forecast_demand_micros,
        evaluation.baseline_demand_micros,
        evaluation.forecast_absolute_error_micros,
        evaluation.baseline_absolute_error_micros,
        evaluation.forecast_bias_micros,
        evaluation.baseline_bias_micros,
        observation.forward_demand_pieces,
        observation.forward_demand_raw_pieces,
        observation.overlay_capture_version,
        observation.overlay_capture_complete,
        observation.overlay_planning_as_of_date,
        observation.overlay_horizon_days,
        evaluation.overlay_attribution_version,
        evaluation.overlay_evaluable,
        evaluation.overlay_exclusion_reason,
        evaluation.overlay_contribution_count,
        evaluation.overlay_raw_demand_pieces,
        evaluation.overlay_weighted_demand_pieces,
        evaluation.overlay_adjusted_forecast_demand_micros,
        evaluation.overlay_adjusted_absolute_error_micros,
        evaluation.overlay_adjusted_bias_micros,
        evaluation.demand_query_version,
        evaluation.evaluated_by,
        evaluation.evaluated_at
      FROM procurement.purchase_forecast_evaluations evaluation
      JOIN procurement.purchase_forecast_observations observation
        ON observation.id = evaluation.observation_id
      WHERE evaluation.evaluation_version = ${input.evaluationVersion}
        AND (${input.horizonDays ?? null}::int IS NULL OR evaluation.horizon_days = ${input.horizonDays ?? null})
        AND observation.forecast_policy_capture_version = ${PURCHASING_FORECAST_POLICY_CAPTURE_VERSION}
        AND observation.forecast_policy_fingerprint = ${input.policyFingerprint}
        AND observation.forecast_method = ${input.forecastMethod}
        AND observation.forecast_version = ${input.forecastVersion}
      ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC
      LIMIT ${input.limit}
    `);
    return rowsOf(result).map(mapReportItem);
  }

  async function inRepeatableReadTransaction<T>(
    operation: (transactionRepository: ReturnType<typeof createPurchaseForecastBacktestingRepository>) => Promise<T>,
  ): Promise<T> {
    return database.transaction(
      async (transaction: any) => operation(createPurchaseForecastBacktestingRepository(transaction)),
      { isolationLevel: "repeatable read" },
    );
  }

  return {
    loadPolicyCohorts,
    loadMaturedCandidates,
    insertEvaluations,
    loadAggregates,
    loadRecent,
    inRepeatableReadTransaction,
  };
}

export type PurchaseForecastBacktestingRepository = ReturnType<typeof createPurchaseForecastBacktestingRepository>;
