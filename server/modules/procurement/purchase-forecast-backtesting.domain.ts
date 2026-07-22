import type { PurchaseForecastEvaluationHorizonDays } from "@shared/schema";

export const PURCHASE_FORECAST_EVALUATION_VERSION = 1;
export const PURCHASE_FORECAST_DEMAND_QUERY_VERSION = "wms_order_items_product_v1";
export const PURCHASE_FORECAST_EVALUATION_HORIZONS = [7, 30, 90] as const;
export const PIECE_MICRO_SCALE = 1_000_000;

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
};

export type PurchaseForecastEvaluationAggregateInput = Omit<
  PurchaseForecastEvaluationHorizonSummary,
  "forecastWapeBasisPoints" | "baselineWapeBasisPoints" | "forecastWapeImprovementBasisPoints"
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
      forwardDemandOverlayIncluded: false,
      forwardDemandPieces: candidate.forwardDemandPieces,
      forwardDemandRawPieces: candidate.forwardDemandRawPieces,
      overlayExclusionReason: "Stored forward demand is aggregate planning-horizon evidence and cannot be prorated across evaluation horizons.",
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
      }

      const actualMicros = actualPieces * BigInt(PIECE_MICRO_SCALE);
      const forecastWapeBasisPoints = roundedBasisPoints(forecastError, actualMicros);
      const baselineWapeBasisPoints = roundedBasisPoints(baselineError, actualMicros);
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
      ];
      for (const [value, field] of nonnegativeFields) assertSafeInteger(value, field, 0);
      assertSafeInteger(aggregate.forecastBiasMicros, "forecastBiasMicros");
      assertSafeInteger(aggregate.baselineBiasMicros, "baselineBiasMicros");
      if (aggregate.forecastWinCount + aggregate.baselineWinCount + aggregate.tieCount !== aggregate.evaluationCount) {
        throw new RangeError("Forecast evaluation outcome counts do not match evaluationCount");
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
      return {
        ...aggregate,
        forecastWapeBasisPoints,
        baselineWapeBasisPoints,
        forecastWapeImprovementBasisPoints:
          forecastWapeBasisPoints === null || baselineWapeBasisPoints === null
            ? null
            : baselineWapeBasisPoints - forecastWapeBasisPoints,
      };
    })
    .sort((left, right) => left.horizonDays - right.horizonDays);
}
