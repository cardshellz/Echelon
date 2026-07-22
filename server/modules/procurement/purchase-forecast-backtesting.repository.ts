import { sql } from "drizzle-orm";
import {
  purchaseForecastEvaluations as purchaseForecastEvaluationsTable,
  type PurchaseForecastEvaluationHorizonDays,
} from "@shared/schema";
import type {
  PurchaseForecastEvaluationCandidate,
  PurchaseForecastEvaluationInput,
} from "./purchase-forecast-backtesting.domain";

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
  };
}

function mapReportItem(row: any): PurchaseForecastEvaluationReportItem {
  return {
    id: safeInteger(row.id, "id", 1),
    observationId: safeInteger(row.observation_id, "observationId", 1),
    runId: safeInteger(row.run_id, "runId", 1),
    productId: safeInteger(row.product_id, "productId", 1),
    productSku: String(row.product_sku ?? ""),
    productName: String(row.product_name ?? ""),
    horizonDays: horizonDays(row.horizon_days),
    forecastMethod: String(row.forecast_method ?? ""),
    forecastVersion: safeInteger(row.forecast_version, "forecastVersion", 1),
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
    demandQueryVersion: String(row.demand_query_version ?? ""),
    evaluatedBy: row.evaluated_by == null ? null : String(row.evaluated_by),
    evaluatedAt: validDate(row.evaluated_at, "evaluatedAt"),
  };
}

export function createPurchaseForecastBacktestingRepository(database: any) {
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
        COUNT(*) FILTER (WHERE observation.forward_demand_pieces > 0)::int AS observations_with_forward_demand
      FROM procurement.purchase_forecast_evaluations evaluation
      JOIN procurement.purchase_forecast_observations observation
        ON observation.id = evaluation.observation_id
      WHERE evaluation.evaluation_version = ${input.evaluationVersion}
        AND (${input.horizonDays ?? null}::int IS NULL OR evaluation.horizon_days = ${input.horizonDays ?? null})
      GROUP BY evaluation.horizon_days
      ORDER BY evaluation.horizon_days
    `);
    return rowsOf(result).map(mapAggregate);
  }

  async function loadRecent(input: {
    evaluationVersion: number;
    horizonDays?: PurchaseForecastEvaluationHorizonDays;
    limit: number;
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
        evaluation.demand_query_version,
        evaluation.evaluated_by,
        evaluation.evaluated_at
      FROM procurement.purchase_forecast_evaluations evaluation
      JOIN procurement.purchase_forecast_observations observation
        ON observation.id = evaluation.observation_id
      WHERE evaluation.evaluation_version = ${input.evaluationVersion}
        AND (${input.horizonDays ?? null}::int IS NULL OR evaluation.horizon_days = ${input.horizonDays ?? null})
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
    loadMaturedCandidates,
    insertEvaluations,
    loadAggregates,
    loadRecent,
    inRepeatableReadTransaction,
  };
}

export type PurchaseForecastBacktestingRepository = ReturnType<typeof createPurchaseForecastBacktestingRepository>;
