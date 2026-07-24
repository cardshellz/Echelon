import type { PurchaseForecastEvaluationHorizonDays } from "@shared/schema";

export const PURCHASE_FORECAST_EVALUATION_VERSION = 2;
export const PURCHASE_FORECAST_OVERLAY_ATTRIBUTION_VERSION = 1;
export const PURCHASE_FORECAST_DEMAND_QUERY_VERSION = "wms_order_items_product_v1";
export const PURCHASE_FORECAST_EVALUATION_HORIZONS = [7, 30, 90] as const;
export const PIECE_MICRO_SCALE = 1_000_000;

export type PurchaseForecastOverlayExclusionReason =
  | "legacy_evaluation"
  | "capture_incomplete"
  | "capture_coverage_unavailable"
  | "capture_horizon_insufficient"
  | "capture_planning_date_mismatch";

export type PurchaseForecastOverlayContributionCandidate = {
  demandEventId: number;
  demandEventLineId: number;
  eventStartDate: string;
  planningAsOfDate: string;
  expectedPieces: number;
  weightedPieces: number;
};

export type PurchaseForecastEvaluationCandidate = {
  observationId: number;
  runId: number;
  productId: number;
  productSku: string;
  productName: string;
  scope: "product_all_warehouses";
  forecastMethod: string;
  forecastVersion: number;
  horizonDays: PurchaseForecastEvaluationHorizonDays;
  observedFrom: Date;
  observedThroughExclusive: Date;
  forecastDailyPiecesMicros: number;
  baselineDailyPiecesMicros: number;
  forwardDemandPieces: number;
  forwardDemandRawPieces: number;
  overlayCaptureVersion: number;
  overlayCaptureComplete: boolean;
  overlayPlanningAsOfDate: string | null;
  overlayHorizonDays: number | null;
  overlayContributions: PurchaseForecastOverlayContributionCandidate[];
  actualDemandPieces: number;
  actualOrderCount: number;
  actualActiveDays: number;
  latestActualDemandAt: Date | null;
};

export type PurchaseForecastEvaluationInput = {
  observationId: number;
  horizonDays: PurchaseForecastEvaluationHorizonDays;
  evaluationVersion: number;
  demandQueryVersion: string;
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
  overlayAttributionVersion: number;
  overlayEvaluable: boolean;
  overlayExclusionReason: PurchaseForecastOverlayExclusionReason | null;
  overlayContributionCount: number | null;
  overlayRawDemandPieces: number | null;
  overlayWeightedDemandPieces: number | null;
  overlayAdjustedForecastDemandMicros: number | null;
  overlayAdjustedAbsoluteErrorMicros: number | null;
  overlayAdjustedBiasMicros: number | null;
  evidenceSnapshot: Record<string, unknown>;
  evaluatedBy: string | null;
  evaluatedAt: Date;
};

export type PurchaseForecastEvaluationMetricRow = {
  horizonDays: number;
  actualDemandPieces: number;
  forecastDemandMicros: number;
  baselineDemandMicros: number;
  forecastAbsoluteErrorMicros: number;
  baselineAbsoluteErrorMicros: number;
  forecastBiasMicros: number;
  baselineBiasMicros: number;
  forwardDemandPieces: number;
  overlayEvaluable: boolean;
  overlayRawDemandPieces: number | null;
  overlayWeightedDemandPieces: number | null;
  overlayAdjustedForecastDemandMicros: number | null;
  overlayAdjustedAbsoluteErrorMicros: number | null;
  overlayAdjustedBiasMicros: number | null;
};

export type PurchaseForecastEvaluationHorizonSummary = {
  horizonDays: PurchaseForecastEvaluationHorizonDays;
  evaluationCount: number;
  actualDemandPieces: number;
  forecastDemandMicros: number;
  baselineDemandMicros: number;
  forecastAbsoluteErrorMicros: number;
  baselineAbsoluteErrorMicros: number;
  forecastBiasMicros: number;
  baselineBiasMicros: number;
  forecastWapeBasisPoints: number | null;
  baselineWapeBasisPoints: number | null;
  forecastWapeImprovementBasisPoints: number | null;
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
  overlayCohortForecastWapeBasisPoints: number | null;
  overlayAdjustedWapeBasisPoints: number | null;
  overlayWapeImprovementBasisPoints: number | null;
  overlayWinCount: number;
  historicalForecastWinCount: number;
  overlayTieCount: number;
  observationsWithAttributedOverlay: number;
};

export type PurchaseForecastEvaluationAggregateInput = Omit<
  PurchaseForecastEvaluationHorizonSummary,
  | "forecastWapeBasisPoints"
  | "baselineWapeBasisPoints"
  | "forecastWapeImprovementBasisPoints"
  | "overlayCohortForecastWapeBasisPoints"
  | "overlayAdjustedWapeBasisPoints"
  | "overlayWapeImprovementBasisPoints"
>;

function assertSafeInteger(value: unknown, field: string, minimum = Number.MIN_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new RangeError(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
}

function assertValidDate(value: unknown, field: string): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
}

function assertHorizon(value: number): asserts value is PurchaseForecastEvaluationHorizonDays {
  if (!(PURCHASE_FORECAST_EVALUATION_HORIZONS as readonly number[]).includes(value)) {
    throw new RangeError("horizonDays must be one of 7, 30, or 90");
  }
}

function checkedMultiply(left: number, right: number, field: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError(`${field} exceeds the supported integer range`);
  }
  return product;
}

function safeBigIntToNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`${field} exceeds the supported integer range`);
  }
  return Number(value);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validCalendarDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new RangeError(`${field} must be an ISO calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a valid ISO calendar date`);
  }
  return value;
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function excludedOverlayEvaluation(exclusionReason: PurchaseForecastOverlayExclusionReason) {
  return {
    overlayAttributionVersion: 0,
    overlayEvaluable: false,
    overlayExclusionReason: exclusionReason,
    overlayContributionCount: null,
    overlayRawDemandPieces: null,
    overlayWeightedDemandPieces: null,
    overlayAdjustedForecastDemandMicros: null,
    overlayAdjustedAbsoluteErrorMicros: null,
    overlayAdjustedBiasMicros: null,
  } as const;
}

function buildOverlayEvaluation(
  candidate: PurchaseForecastEvaluationCandidate,
  forecastDemandMicros: number,
  actualDemandMicros: number,
) {
  assertSafeInteger(candidate.overlayCaptureVersion, "overlayCaptureVersion", 0);
  if (typeof candidate.overlayCaptureComplete !== "boolean") {
    throw new RangeError("overlayCaptureComplete must be boolean");
  }
  if (!Array.isArray(candidate.overlayContributions)) {
    throw new RangeError("overlayContributions must be an array");
  }
  if (!candidate.overlayCaptureComplete) {
    if (candidate.overlayContributions.length > 0) {
      throw new RangeError("Incomplete overlay capture cannot contain contribution evidence");
    }
    return excludedOverlayEvaluation("capture_incomplete");
  }
  if (
    candidate.overlayCaptureVersion < 2
    || candidate.overlayPlanningAsOfDate === null
    || candidate.overlayHorizonDays === null
  ) {
    return excludedOverlayEvaluation("capture_coverage_unavailable");
  }

  const planningAsOfDate = validCalendarDate(candidate.overlayPlanningAsOfDate, "overlayPlanningAsOfDate");
  assertSafeInteger(candidate.overlayHorizonDays, "overlayHorizonDays", 1);
  if (candidate.overlayHorizonDays > 365) {
    throw new RangeError("overlayHorizonDays cannot exceed 365");
  }

  let capturedRawPieces = BigInt(0);
  let capturedWeightedPieces = BigInt(0);
  const seenLineIds = new Set<number>();
  const captureEndInclusive = addCalendarDays(planningAsOfDate, candidate.overlayHorizonDays);
  for (const contribution of candidate.overlayContributions) {
    assertSafeInteger(contribution.demandEventId, "overlayContributions.demandEventId", 1);
    assertSafeInteger(contribution.demandEventLineId, "overlayContributions.demandEventLineId", 1);
    if (seenLineIds.has(contribution.demandEventLineId)) {
      throw new RangeError(`Duplicate overlay contribution line ${contribution.demandEventLineId}`);
    }
    seenLineIds.add(contribution.demandEventLineId);
    const eventStartDate = validCalendarDate(
      contribution.eventStartDate,
      "overlayContributions.eventStartDate",
    );
    if (eventStartDate > captureEndInclusive) {
      throw new RangeError(`Overlay contribution ${contribution.demandEventLineId} falls outside capture coverage`);
    }
    const contributionPlanningDate = validCalendarDate(
      contribution.planningAsOfDate,
      "overlayContributions.planningAsOfDate",
    );
    if (contributionPlanningDate !== planningAsOfDate) {
      throw new RangeError(`Overlay contribution ${contribution.demandEventLineId} has a mismatched planning date`);
    }
    assertSafeInteger(contribution.expectedPieces, "overlayContributions.expectedPieces", 0);
    assertSafeInteger(contribution.weightedPieces, "overlayContributions.weightedPieces", 0);
    capturedRawPieces += BigInt(contribution.expectedPieces);
    capturedWeightedPieces += BigInt(contribution.weightedPieces);
  }
  if (
    capturedRawPieces !== BigInt(candidate.forwardDemandRawPieces)
    || capturedWeightedPieces !== BigInt(candidate.forwardDemandPieces)
  ) {
    throw new RangeError("Overlay contribution totals do not match the forecast observation");
  }

  if (planningAsOfDate !== candidate.observedFrom.toISOString().slice(0, 10)) {
    return excludedOverlayEvaluation("capture_planning_date_mismatch");
  }
  if (candidate.overlayHorizonDays < candidate.horizonDays) {
    return excludedOverlayEvaluation("capture_horizon_insufficient");
  }

  const horizonEndExclusive = addCalendarDays(planningAsOfDate, candidate.horizonDays);
  const attributed = candidate.overlayContributions.filter(
    (contribution) => contribution.eventStartDate >= planningAsOfDate
      && contribution.eventStartDate < horizonEndExclusive,
  );
  const overlayRawDemandPieces = safeBigIntToNumber(
    attributed.reduce((sum, contribution) => sum + BigInt(contribution.expectedPieces), BigInt(0)),
    "overlayRawDemandPieces",
  );
  const overlayWeightedDemandPieces = safeBigIntToNumber(
    attributed.reduce((sum, contribution) => sum + BigInt(contribution.weightedPieces), BigInt(0)),
    "overlayWeightedDemandPieces",
  );
  const overlayAdjustedForecastDemandMicros = safeBigIntToNumber(
    BigInt(forecastDemandMicros) + BigInt(overlayWeightedDemandPieces) * BigInt(PIECE_MICRO_SCALE),
    "overlayAdjustedForecastDemandMicros",
  );
  const overlayAdjustedBiasMicros = safeBigIntToNumber(
    BigInt(overlayAdjustedForecastDemandMicros) - BigInt(actualDemandMicros),
    "overlayAdjustedBiasMicros",
  );
  return {
    overlayAttributionVersion: PURCHASE_FORECAST_OVERLAY_ATTRIBUTION_VERSION,
    overlayEvaluable: true,
    overlayExclusionReason: null,
    overlayContributionCount: attributed.length,
    overlayRawDemandPieces,
    overlayWeightedDemandPieces,
    overlayAdjustedForecastDemandMicros,
    overlayAdjustedAbsoluteErrorMicros: Math.abs(overlayAdjustedBiasMicros),
    overlayAdjustedBiasMicros,
  } as const;
}

function roundedBasisPoints(numerator: bigint, denominator: bigint): number | null {
  if (denominator === BigInt(0)) return null;
  const rounded = (numerator * BigInt(10_000) + denominator / BigInt(2)) / denominator;
  return safeBigIntToNumber(rounded, "basisPoints");
}

export function buildPurchaseForecastEvaluation(input: {
  candidate: PurchaseForecastEvaluationCandidate;
  evaluatedAt: Date;
  evaluatedBy?: string | null;
}): PurchaseForecastEvaluationInput {
  const { candidate } = input;
  assertSafeInteger(candidate.observationId, "observationId", 1);
  assertSafeInteger(candidate.runId, "runId", 1);
  assertSafeInteger(candidate.productId, "productId", 1);
  assertHorizon(candidate.horizonDays);
  assertValidDate(candidate.observedFrom, "observedFrom");
  assertValidDate(candidate.observedThroughExclusive, "observedThroughExclusive");
  assertValidDate(input.evaluatedAt, "evaluatedAt");
  if (candidate.observedThroughExclusive <= candidate.observedFrom) {
    throw new RangeError("observedThroughExclusive must be after observedFrom");
  }
  if (input.evaluatedAt < candidate.observedThroughExclusive) {
    throw new RangeError("Forecast horizon has not matured at evaluatedAt");
  }
  assertSafeInteger(candidate.forecastDailyPiecesMicros, "forecastDailyPiecesMicros", 0);
  assertSafeInteger(candidate.baselineDailyPiecesMicros, "baselineDailyPiecesMicros", 0);
  assertSafeInteger(candidate.forwardDemandPieces, "forwardDemandPieces", 0);
  assertSafeInteger(candidate.forwardDemandRawPieces, "forwardDemandRawPieces", 0);
  assertSafeInteger(candidate.actualDemandPieces, "actualDemandPieces", 0);
  assertSafeInteger(candidate.actualOrderCount, "actualOrderCount", 0);
  assertSafeInteger(candidate.actualActiveDays, "actualActiveDays", 0);
  if (candidate.latestActualDemandAt !== null) {
    assertValidDate(candidate.latestActualDemandAt, "latestActualDemandAt");
  }

  const forecastDemandMicros = checkedMultiply(
    candidate.forecastDailyPiecesMicros,
    candidate.horizonDays,
    "forecastDemandMicros",
  );
  const baselineDemandMicros = checkedMultiply(
    candidate.baselineDailyPiecesMicros,
    candidate.horizonDays,
    "baselineDemandMicros",
  );
  const actualDemandMicros = checkedMultiply(
    candidate.actualDemandPieces,
    PIECE_MICRO_SCALE,
    "actualDemandMicros",
  );
  const forecastBiasMicros = forecastDemandMicros - actualDemandMicros;
  const baselineBiasMicros = baselineDemandMicros - actualDemandMicros;
  if (!Number.isSafeInteger(forecastBiasMicros) || !Number.isSafeInteger(baselineBiasMicros)) {
    throw new RangeError("Forecast evaluation bias exceeds the supported integer range");
  }

  const evaluatedBy = input.evaluatedBy?.trim() || null;
  if (evaluatedBy && evaluatedBy.length > 255) {
    throw new RangeError("evaluatedBy cannot exceed 255 characters");
  }
  const overlayEvaluation = buildOverlayEvaluation(candidate, forecastDemandMicros, actualDemandMicros);

  return {
    observationId: candidate.observationId,
    horizonDays: candidate.horizonDays,
    evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
    demandQueryVersion: PURCHASE_FORECAST_DEMAND_QUERY_VERSION,
    observedFrom: candidate.observedFrom,
    observedThroughExclusive: candidate.observedThroughExclusive,
    actualDemandPieces: candidate.actualDemandPieces,
    actualOrderCount: candidate.actualOrderCount,
    actualActiveDays: candidate.actualActiveDays,
    latestActualDemandAt: candidate.latestActualDemandAt,
    forecastDemandMicros,
    baselineDemandMicros,
    forecastAbsoluteErrorMicros: Math.abs(forecastBiasMicros),
    baselineAbsoluteErrorMicros: Math.abs(baselineBiasMicros),
    forecastBiasMicros,
    baselineBiasMicros,
    overlayAttributionVersion: overlayEvaluation.overlayAttributionVersion,
    overlayEvaluable: overlayEvaluation.overlayEvaluable,
    overlayExclusionReason: overlayEvaluation.overlayExclusionReason,
    overlayContributionCount: overlayEvaluation.overlayContributionCount,
    overlayRawDemandPieces: overlayEvaluation.overlayRawDemandPieces,
    overlayWeightedDemandPieces: overlayEvaluation.overlayWeightedDemandPieces,
    overlayAdjustedForecastDemandMicros: overlayEvaluation.overlayAdjustedForecastDemandMicros,
    overlayAdjustedAbsoluteErrorMicros: overlayEvaluation.overlayAdjustedAbsoluteErrorMicros,
    overlayAdjustedBiasMicros: overlayEvaluation.overlayAdjustedBiasMicros,
    evidenceSnapshot: {
      scope: candidate.scope,
      productId: candidate.productId,
      productSku: candidate.productSku,
      productName: candidate.productName,
      runId: candidate.runId,
      forecastMethod: candidate.forecastMethod,
      forecastVersion: candidate.forecastVersion,
      demandInterval: "[observedFrom, observedThroughExclusive)",
      demandSource: "wms.orders+wms.order_items+catalog.product_variants",
      demandFilters: {
        orderCancelledAt: "null",
        orderWarehouseStatus: "not_cancelled",
        orderItemStatus: "not_cancelled",
        requiresShipping: true,
        activeVariantSkuMatch: true,
      },
      predictionScope: "historical_rate_only",
      overlayAdjustedPredictionScope: overlayEvaluation.overlayEvaluable
        ? "historical_rate_plus_start_date_overlay"
        : null,
      forwardDemandOverlayIncluded:
        overlayEvaluation.overlayEvaluable && Number(overlayEvaluation.overlayWeightedDemandPieces) > 0,
      forwardDemandPieces: candidate.forwardDemandPieces,
      forwardDemandRawPieces: candidate.forwardDemandRawPieces,
      overlayEvaluation: {
        captureVersion: candidate.overlayCaptureVersion,
        captureComplete: candidate.overlayCaptureComplete,
        planningAsOfDate: candidate.overlayPlanningAsOfDate,
        captureHorizonDays: candidate.overlayHorizonDays,
        attributionVersion: overlayEvaluation.overlayAttributionVersion,
        evaluable: overlayEvaluation.overlayEvaluable,
        contributionCount: overlayEvaluation.overlayContributionCount,
        rawDemandPieces: overlayEvaluation.overlayRawDemandPieces,
        weightedDemandPieces: overlayEvaluation.overlayWeightedDemandPieces,
        attributionInterval: overlayEvaluation.overlayEvaluable
          ? `[${candidate.overlayPlanningAsOfDate}, ${addCalendarDays(candidate.overlayPlanningAsOfDate!, candidate.horizonDays)})`
          : null,
        exclusionReason: overlayEvaluation.overlayExclusionReason,
      },
    },
    evaluatedBy,
    evaluatedAt: input.evaluatedAt,
  };
}

export function buildPurchaseForecastEvaluationSummaries(
  rows: PurchaseForecastEvaluationMetricRow[],
): PurchaseForecastEvaluationHorizonSummary[] {
  const grouped = new Map<PurchaseForecastEvaluationHorizonDays, PurchaseForecastEvaluationMetricRow[]>();
  for (const row of rows) {
    assertHorizon(row.horizonDays);
    const fields: Array<[unknown, string, number]> = [
      [row.actualDemandPieces, "actualDemandPieces", 0],
      [row.forecastDemandMicros, "forecastDemandMicros", 0],
      [row.baselineDemandMicros, "baselineDemandMicros", 0],
      [row.forecastAbsoluteErrorMicros, "forecastAbsoluteErrorMicros", 0],
      [row.baselineAbsoluteErrorMicros, "baselineAbsoluteErrorMicros", 0],
      [row.forecastBiasMicros, "forecastBiasMicros", Number.MIN_SAFE_INTEGER],
      [row.baselineBiasMicros, "baselineBiasMicros", Number.MIN_SAFE_INTEGER],
      [row.forwardDemandPieces, "forwardDemandPieces", 0],
    ];
    for (const [value, field, minimum] of fields) assertSafeInteger(value, field, minimum);
    if (typeof row.overlayEvaluable !== "boolean") {
      throw new RangeError("overlayEvaluable must be boolean");
    }
    const overlayValues = [
      row.overlayWeightedDemandPieces,
      row.overlayRawDemandPieces,
      row.overlayAdjustedForecastDemandMicros,
      row.overlayAdjustedAbsoluteErrorMicros,
      row.overlayAdjustedBiasMicros,
    ];
    if (!row.overlayEvaluable && overlayValues.some((value) => value !== null)) {
      throw new RangeError("Non-evaluable overlay rows cannot contain overlay metrics");
    }
    if (row.overlayEvaluable) {
      assertSafeInteger(row.overlayWeightedDemandPieces, "overlayWeightedDemandPieces", 0);
      assertSafeInteger(row.overlayRawDemandPieces, "overlayRawDemandPieces", 0);
      assertSafeInteger(row.overlayAdjustedForecastDemandMicros, "overlayAdjustedForecastDemandMicros", 0);
      assertSafeInteger(row.overlayAdjustedAbsoluteErrorMicros, "overlayAdjustedAbsoluteErrorMicros", 0);
      assertSafeInteger(row.overlayAdjustedBiasMicros, "overlayAdjustedBiasMicros");
    }
    const horizonRows = grouped.get(row.horizonDays) ?? [];
    horizonRows.push(row);
    grouped.set(row.horizonDays, horizonRows);
  }

  return PURCHASE_FORECAST_EVALUATION_HORIZONS
    .filter((horizonDays) => grouped.has(horizonDays))
    .map((horizonDays) => {
      const horizonRows = grouped.get(horizonDays)!;
      let actualPieces = BigInt(0);
      let forecastDemand = BigInt(0);
      let baselineDemand = BigInt(0);
      let forecastError = BigInt(0);
      let baselineError = BigInt(0);
      let forecastBias = BigInt(0);
      let baselineBias = BigInt(0);
      let forecastWinCount = 0;
      let baselineWinCount = 0;
      let tieCount = 0;
      let zeroActualCount = 0;
      let observationsWithForwardDemand = 0;
      let overlayEvaluationCount = 0;
      let overlayActualDemandPieces = BigInt(0);
      let overlayRawDemandPieces = BigInt(0);
      let overlayWeightedDemandPieces = BigInt(0);
      let overlayCohortForecastAbsoluteError = BigInt(0);
      let overlayAdjustedForecastDemand = BigInt(0);
      let overlayAdjustedAbsoluteError = BigInt(0);
      let overlayAdjustedBias = BigInt(0);
      let overlayWinCount = 0;
      let historicalForecastWinCount = 0;
      let overlayTieCount = 0;
      let observationsWithAttributedOverlay = 0;

      for (const row of horizonRows) {
        actualPieces += BigInt(row.actualDemandPieces);
        forecastDemand += BigInt(row.forecastDemandMicros);
        baselineDemand += BigInt(row.baselineDemandMicros);
        forecastError += BigInt(row.forecastAbsoluteErrorMicros);
        baselineError += BigInt(row.baselineAbsoluteErrorMicros);
        forecastBias += BigInt(row.forecastBiasMicros);
        baselineBias += BigInt(row.baselineBiasMicros);
        if (row.forecastAbsoluteErrorMicros < row.baselineAbsoluteErrorMicros) forecastWinCount += 1;
        else if (row.baselineAbsoluteErrorMicros < row.forecastAbsoluteErrorMicros) baselineWinCount += 1;
        else tieCount += 1;
        if (row.actualDemandPieces === 0) zeroActualCount += 1;
        if (row.forwardDemandPieces > 0) observationsWithForwardDemand += 1;
        if (row.overlayEvaluable) {
          overlayEvaluationCount += 1;
          overlayActualDemandPieces += BigInt(row.actualDemandPieces);
          overlayRawDemandPieces += BigInt(row.overlayRawDemandPieces!);
          overlayWeightedDemandPieces += BigInt(row.overlayWeightedDemandPieces!);
          overlayCohortForecastAbsoluteError += BigInt(row.forecastAbsoluteErrorMicros);
          overlayAdjustedForecastDemand += BigInt(row.overlayAdjustedForecastDemandMicros!);
          overlayAdjustedAbsoluteError += BigInt(row.overlayAdjustedAbsoluteErrorMicros!);
          overlayAdjustedBias += BigInt(row.overlayAdjustedBiasMicros!);
          if (row.overlayAdjustedAbsoluteErrorMicros! < row.forecastAbsoluteErrorMicros) overlayWinCount += 1;
          else if (row.forecastAbsoluteErrorMicros < row.overlayAdjustedAbsoluteErrorMicros!) {
            historicalForecastWinCount += 1;
          } else overlayTieCount += 1;
          if (row.overlayWeightedDemandPieces! > 0) observationsWithAttributedOverlay += 1;
        }
      }

      const actualMicros = actualPieces * BigInt(PIECE_MICRO_SCALE);
      const forecastWapeBasisPoints = roundedBasisPoints(forecastError, actualMicros);
      const baselineWapeBasisPoints = roundedBasisPoints(baselineError, actualMicros);
      const overlayActualMicros = overlayActualDemandPieces * BigInt(PIECE_MICRO_SCALE);
      const overlayCohortForecastWapeBasisPoints = roundedBasisPoints(
        overlayCohortForecastAbsoluteError,
        overlayActualMicros,
      );
      const overlayAdjustedWapeBasisPoints = roundedBasisPoints(
        overlayAdjustedAbsoluteError,
        overlayActualMicros,
      );
      return {
        horizonDays,
        evaluationCount: horizonRows.length,
        actualDemandPieces: safeBigIntToNumber(actualPieces, "actualDemandPieces"),
        forecastDemandMicros: safeBigIntToNumber(forecastDemand, "forecastDemandMicros"),
        baselineDemandMicros: safeBigIntToNumber(baselineDemand, "baselineDemandMicros"),
        forecastAbsoluteErrorMicros: safeBigIntToNumber(forecastError, "forecastAbsoluteErrorMicros"),
        baselineAbsoluteErrorMicros: safeBigIntToNumber(baselineError, "baselineAbsoluteErrorMicros"),
        forecastBiasMicros: safeBigIntToNumber(forecastBias, "forecastBiasMicros"),
        baselineBiasMicros: safeBigIntToNumber(baselineBias, "baselineBiasMicros"),
        forecastWapeBasisPoints,
        baselineWapeBasisPoints,
        forecastWapeImprovementBasisPoints:
          forecastWapeBasisPoints === null || baselineWapeBasisPoints === null
            ? null
            : baselineWapeBasisPoints - forecastWapeBasisPoints,
        forecastWinCount,
        baselineWinCount,
        tieCount,
        zeroActualCount,
        observationsWithForwardDemand,
        overlayEvaluationCount,
        overlayActualDemandPieces: safeBigIntToNumber(overlayActualDemandPieces, "overlayActualDemandPieces"),
        overlayRawDemandPieces: safeBigIntToNumber(overlayRawDemandPieces, "overlayRawDemandPieces"),
        overlayWeightedDemandPieces: safeBigIntToNumber(
          overlayWeightedDemandPieces,
          "overlayWeightedDemandPieces",
        ),
        overlayCohortForecastAbsoluteErrorMicros: safeBigIntToNumber(
          overlayCohortForecastAbsoluteError,
          "overlayCohortForecastAbsoluteErrorMicros",
        ),
        overlayAdjustedForecastDemandMicros: safeBigIntToNumber(
          overlayAdjustedForecastDemand,
          "overlayAdjustedForecastDemandMicros",
        ),
        overlayAdjustedAbsoluteErrorMicros: safeBigIntToNumber(
          overlayAdjustedAbsoluteError,
          "overlayAdjustedAbsoluteErrorMicros",
        ),
        overlayAdjustedBiasMicros: safeBigIntToNumber(overlayAdjustedBias, "overlayAdjustedBiasMicros"),
        overlayCohortForecastWapeBasisPoints,
        overlayAdjustedWapeBasisPoints,
        overlayWapeImprovementBasisPoints:
          overlayCohortForecastWapeBasisPoints === null || overlayAdjustedWapeBasisPoints === null
            ? null
            : overlayCohortForecastWapeBasisPoints - overlayAdjustedWapeBasisPoints,
        overlayWinCount,
        historicalForecastWinCount,
        overlayTieCount,
        observationsWithAttributedOverlay,
      };
    });
}

export function buildPurchaseForecastEvaluationSummariesFromAggregates(
  aggregates: PurchaseForecastEvaluationAggregateInput[],
): PurchaseForecastEvaluationHorizonSummary[] {
  return aggregates
    .map((aggregate) => {
      assertHorizon(aggregate.horizonDays);
      const nonnegativeFields: Array<[unknown, string]> = [
        [aggregate.evaluationCount, "evaluationCount"],
        [aggregate.actualDemandPieces, "actualDemandPieces"],
        [aggregate.forecastDemandMicros, "forecastDemandMicros"],
        [aggregate.baselineDemandMicros, "baselineDemandMicros"],
        [aggregate.forecastAbsoluteErrorMicros, "forecastAbsoluteErrorMicros"],
        [aggregate.baselineAbsoluteErrorMicros, "baselineAbsoluteErrorMicros"],
        [aggregate.forecastWinCount, "forecastWinCount"],
        [aggregate.baselineWinCount, "baselineWinCount"],
        [aggregate.tieCount, "tieCount"],
        [aggregate.zeroActualCount, "zeroActualCount"],
        [aggregate.observationsWithForwardDemand, "observationsWithForwardDemand"],
        [aggregate.overlayEvaluationCount, "overlayEvaluationCount"],
        [aggregate.overlayActualDemandPieces, "overlayActualDemandPieces"],
        [aggregate.overlayRawDemandPieces, "overlayRawDemandPieces"],
        [aggregate.overlayWeightedDemandPieces, "overlayWeightedDemandPieces"],
        [aggregate.overlayCohortForecastAbsoluteErrorMicros, "overlayCohortForecastAbsoluteErrorMicros"],
        [aggregate.overlayAdjustedForecastDemandMicros, "overlayAdjustedForecastDemandMicros"],
        [aggregate.overlayAdjustedAbsoluteErrorMicros, "overlayAdjustedAbsoluteErrorMicros"],
        [aggregate.overlayWinCount, "overlayWinCount"],
        [aggregate.historicalForecastWinCount, "historicalForecastWinCount"],
        [aggregate.overlayTieCount, "overlayTieCount"],
        [aggregate.observationsWithAttributedOverlay, "observationsWithAttributedOverlay"],
      ];
      for (const [value, field] of nonnegativeFields) assertSafeInteger(value, field, 0);
      assertSafeInteger(aggregate.forecastBiasMicros, "forecastBiasMicros");
      assertSafeInteger(aggregate.baselineBiasMicros, "baselineBiasMicros");
      assertSafeInteger(aggregate.overlayAdjustedBiasMicros, "overlayAdjustedBiasMicros");
      if (aggregate.forecastWinCount + aggregate.baselineWinCount + aggregate.tieCount !== aggregate.evaluationCount) {
        throw new RangeError("Forecast evaluation outcome counts do not match evaluationCount");
      }
      if (
        aggregate.zeroActualCount > aggregate.evaluationCount
        || aggregate.observationsWithForwardDemand > aggregate.evaluationCount
        || aggregate.overlayEvaluationCount > aggregate.evaluationCount
      ) {
        throw new RangeError("Forecast evaluation subset counts cannot exceed evaluationCount");
      }
      if (
        aggregate.overlayWinCount + aggregate.historicalForecastWinCount + aggregate.overlayTieCount
        !== aggregate.overlayEvaluationCount
      ) {
        throw new RangeError("Overlay evaluation outcome counts do not match overlayEvaluationCount");
      }
      if (aggregate.observationsWithAttributedOverlay > aggregate.overlayEvaluationCount) {
        throw new RangeError("Attributed overlay count cannot exceed overlayEvaluationCount");
      }

      const actualMicros = BigInt(aggregate.actualDemandPieces) * BigInt(PIECE_MICRO_SCALE);
      const forecastWapeBasisPoints = roundedBasisPoints(
        BigInt(aggregate.forecastAbsoluteErrorMicros),
        actualMicros,
      );
      const baselineWapeBasisPoints = roundedBasisPoints(
        BigInt(aggregate.baselineAbsoluteErrorMicros),
        actualMicros,
      );
      const overlayActualMicros = BigInt(aggregate.overlayActualDemandPieces) * BigInt(PIECE_MICRO_SCALE);
      const overlayCohortForecastWapeBasisPoints = roundedBasisPoints(
        BigInt(aggregate.overlayCohortForecastAbsoluteErrorMicros),
        overlayActualMicros,
      );
      const overlayAdjustedWapeBasisPoints = roundedBasisPoints(
        BigInt(aggregate.overlayAdjustedAbsoluteErrorMicros),
        overlayActualMicros,
      );
      return {
        ...aggregate,
        forecastWapeBasisPoints,
        baselineWapeBasisPoints,
        forecastWapeImprovementBasisPoints:
          forecastWapeBasisPoints === null || baselineWapeBasisPoints === null
            ? null
            : baselineWapeBasisPoints - forecastWapeBasisPoints,
        overlayCohortForecastWapeBasisPoints,
        overlayAdjustedWapeBasisPoints,
        overlayWapeImprovementBasisPoints:
          overlayCohortForecastWapeBasisPoints === null || overlayAdjustedWapeBasisPoints === null
            ? null
            : overlayCohortForecastWapeBasisPoints - overlayAdjustedWapeBasisPoints,
      };
    })
    .sort((left, right) => left.horizonDays - right.horizonDays);
}
