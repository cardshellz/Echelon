import type { PurchaseForecastEvaluationHorizonDays } from "@shared/schema";
import {
  buildPurchaseForecastEvaluation,
  buildPurchaseForecastEvaluationSummariesFromAggregates,
  PURCHASE_FORECAST_EVALUATION_HORIZONS,
  PURCHASE_FORECAST_EVALUATION_VERSION,
} from "./purchase-forecast-backtesting.domain";
import {
  createPurchaseForecastBacktestingRepository,
  type PurchaseForecastBacktestingRepository,
} from "./purchase-forecast-backtesting.repository";

const DEFAULT_EVALUATION_LIMIT = 1_000;
const MAX_EVALUATION_LIMIT = 5_000;
const DEFAULT_REPORT_LIMIT = 100;
const MAX_REPORT_LIMIT = 500;
const MAX_SERIALIZATION_RETRIES = 2;

function validDate(value: unknown, field: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new RangeError(`${field} must be a valid date`);
  return parsed;
}

function boundedLimit(value: unknown, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return Number(value);
}

function normalizeHorizons(value?: number[]): PurchaseForecastEvaluationHorizonDays[] {
  const requested = value ?? [...PURCHASE_FORECAST_EVALUATION_HORIZONS];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new RangeError("horizons must contain at least one supported horizon");
  }
  const normalized = Array.from(new Set(requested)).sort((left, right) => left - right);
  for (const horizon of normalized) {
    if (!(PURCHASE_FORECAST_EVALUATION_HORIZONS as readonly number[]).includes(horizon)) {
      throw new RangeError("horizons may contain only 7, 30, or 90");
    }
  }
  return normalized as PurchaseForecastEvaluationHorizonDays[];
}

function normalizeHorizon(value: unknown): PurchaseForecastEvaluationHorizonDays | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  const horizons = normalizeHorizons([parsed]);
  return horizons[0];
}

function actor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 255) {
    throw new RangeError("actor must be a string no longer than 255 characters");
  }
  return value.trim();
}

export function createPurchaseForecastBacktestingService(input: {
  database?: any;
  repository?: PurchaseForecastBacktestingRepository;
  clock?: () => Date;
}) {
  if (!input.repository && !input.database) {
    throw new TypeError("database or repository is required");
  }
  const repository = input.repository ?? createPurchaseForecastBacktestingRepository(input.database);
  const clock = input.clock ?? (() => new Date());

  async function evaluateMatured(options: {
    asOf?: Date | string;
    horizons?: number[];
    limit?: number;
    actor?: string | null;
  } = {}) {
    const asOf = options.asOf === undefined ? validDate(clock(), "clock") : validDate(options.asOf, "asOf");
    const horizons = normalizeHorizons(options.horizons);
    const limit = boundedLimit(options.limit, DEFAULT_EVALUATION_LIMIT, MAX_EVALUATION_LIMIT, "limit");
    const evaluatedBy = actor(options.actor);
    let serializationRetryCount = 0;

    while (true) {
      try {
        const result = await repository.inRepeatableReadTransaction(async (transactionRepository) => {
          const candidates = await transactionRepository.loadMaturedCandidates({
            asOf,
            horizons,
            evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
            limit,
          });
          const evaluations = candidates.map((candidate) => buildPurchaseForecastEvaluation({
            candidate,
            evaluatedAt: asOf,
            evaluatedBy,
          }));
          const inserted = await transactionRepository.insertEvaluations(evaluations);
          const candidateCountsByHorizon: Record<string, number> = {};
          const insertedCountsByHorizon: Record<string, number> = {};
          for (const candidate of candidates) {
            const key = String(candidate.horizonDays);
            candidateCountsByHorizon[key] = (candidateCountsByHorizon[key] ?? 0) + 1;
          }
          for (const row of inserted) {
            const key = String(row.horizonDays);
            insertedCountsByHorizon[key] = (insertedCountsByHorizon[key] ?? 0) + 1;
          }

          return {
            evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
            evaluatedAt: asOf,
            horizons,
            limit,
            candidateCount: candidates.length,
            insertedCount: inserted.length,
            concurrentReplayCount: candidates.length - inserted.length,
            batchLimitReached: candidates.length === limit,
            candidateCountsByHorizon,
            insertedCountsByHorizon,
          };
        });
        return { ...result, serializationRetryCount };
      } catch (error: any) {
        if (error?.code !== "40001" || serializationRetryCount >= MAX_SERIALIZATION_RETRIES) throw error;
        serializationRetryCount += 1;
      }
    }
  }

  async function getReport(options: {
    horizonDays?: number | string;
    limit?: number;
  } = {}) {
    const horizonDays = normalizeHorizon(options.horizonDays);
    const limit = boundedLimit(options.limit, DEFAULT_REPORT_LIMIT, MAX_REPORT_LIMIT, "limit");
    return repository.inRepeatableReadTransaction(async (transactionRepository) => {
      const [aggregates, items] = await Promise.all([
        transactionRepository.loadAggregates({
          evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
          horizonDays,
        }),
        transactionRepository.loadRecent({
          evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
          horizonDays,
          limit,
        }),
      ]);
      const summaries = buildPurchaseForecastEvaluationSummariesFromAggregates(aggregates);
      return {
        evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
        measurement: {
          scope: "product_all_warehouses",
          predictionScope: "historical_rate_only",
          horizons: [...PURCHASE_FORECAST_EVALUATION_HORIZONS],
          wapeUnit: "basis_points",
          quantityUnit: "base_piece",
          predictionPrecision: "micro_piece",
          forwardDemandOverlayIncluded: false,
          overlayNote: "Forward-demand evidence remains visible on each result but is excluded until event-level horizon attribution is stored.",
        },
        summaries,
        itemCount: items.length,
        items: items.map((item) => ({
          ...item,
          outcome:
            item.forecastAbsoluteErrorMicros < item.baselineAbsoluteErrorMicros
              ? "forecast_wins"
              : item.baselineAbsoluteErrorMicros < item.forecastAbsoluteErrorMicros
                ? "baseline_wins"
                : "tie",
          forecastErrorImprovementMicros:
            item.baselineAbsoluteErrorMicros - item.forecastAbsoluteErrorMicros,
          forwardDemandOverlayIncluded: false,
        })),
      };
    });
  }

  return { evaluateMatured, getReport };
}

export type PurchaseForecastBacktestingService = ReturnType<typeof createPurchaseForecastBacktestingService>;
