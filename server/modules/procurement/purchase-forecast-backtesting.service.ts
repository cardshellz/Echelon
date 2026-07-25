import type { PurchaseForecastEvaluationHorizonDays } from "@shared/schema";
import {
  buildPurchaseForecastEvaluation,
  buildPurchaseForecastEvaluationSummariesFromAggregates,
  PURCHASE_FORECAST_EVALUATION_HORIZONS,
  PURCHASE_FORECAST_EVALUATION_VERSION,
  PURCHASE_FORECAST_OVERLAY_ATTRIBUTION_VERSION,
} from "./purchase-forecast-backtesting.domain";
import {
  createPurchaseForecastBacktestingRepository,
  type PurchaseForecastBacktestingRepository,
  type PurchaseForecastPolicyCohortEvidence,
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

function normalizePolicyFingerprint(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError("forecastPolicyFingerprint must be a lowercase SHA-256");
  }
  return value;
}

function normalizeForecastVersion(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("forecastVersion must be a positive safe integer");
  }
  return parsed;
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
    forecastPolicyFingerprint?: string;
    forecastVersion?: number | string;
  } = {}) {
    const horizonDays = normalizeHorizon(options.horizonDays);
    const limit = boundedLimit(options.limit, DEFAULT_REPORT_LIMIT, MAX_REPORT_LIMIT, "limit");
    const requestedPolicyFingerprint = normalizePolicyFingerprint(options.forecastPolicyFingerprint);
    const requestedForecastVersion = normalizeForecastVersion(options.forecastVersion);
    if ((requestedPolicyFingerprint === undefined) !== (requestedForecastVersion === undefined)) {
      throw new RangeError("forecastPolicyFingerprint and forecastVersion must be provided together");
    }
    return repository.inRepeatableReadTransaction(async (transactionRepository) => {
      const policyEvidence = await transactionRepository.loadPolicyCohorts({
        evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
        horizonDays,
      });
      const policyCohorts = policyEvidence.filter(
        (
          cohort,
        ): cohort is Extract<PurchaseForecastPolicyCohortEvidence, { captureVersion: 1 }> => (
          cohort.captureVersion === 1
        ),
      );
      const seenCohortKeys = new Set<string>();
      for (const cohort of policyCohorts) {
        const cohortKey = `${cohort.fingerprint}:${cohort.forecastVersion}`;
        if (seenCohortKeys.has(cohortKey)) {
          throw new Error(`Forecast policy cohort ${cohortKey} maps to multiple policy snapshots`);
        }
        seenCohortKeys.add(cohortKey);
      }
      const legacyEvidence = policyEvidence.filter((cohort) => cohort.captureVersion === 0);
      if (legacyEvidence.length > 1) {
        throw new Error("Forecast backtesting returned multiple legacy policy evidence groups");
      }
      const selectedPolicyCohort = requestedPolicyFingerprint === undefined
        ? policyCohorts[0] ?? null
        : policyCohorts.find((cohort) => (
            cohort.fingerprint === requestedPolicyFingerprint
            && cohort.forecastVersion === requestedForecastVersion
          )) ?? null;
      if (requestedPolicyFingerprint !== undefined && selectedPolicyCohort === null) {
        throw new RangeError("No forecast backtesting evidence exists for forecastPolicyFingerprint");
      }

      let aggregates: Awaited<ReturnType<typeof transactionRepository.loadAggregates>> = [];
      let items: Awaited<ReturnType<typeof transactionRepository.loadRecent>> = [];
      if (selectedPolicyCohort !== null) {
        [aggregates, items] = await Promise.all([
          transactionRepository.loadAggregates({
            evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
            horizonDays,
            policyFingerprint: selectedPolicyCohort.fingerprint,
            forecastMethod: selectedPolicyCohort.forecastMethod,
            forecastVersion: selectedPolicyCohort.forecastVersion,
          }),
          transactionRepository.loadRecent({
            evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
            horizonDays,
            limit,
            policyFingerprint: selectedPolicyCohort.fingerprint,
            forecastMethod: selectedPolicyCohort.forecastMethod,
            forecastVersion: selectedPolicyCohort.forecastVersion,
          }),
        ]);
      }
      const summaries = selectedPolicyCohort === null
        ? []
        : buildPurchaseForecastEvaluationSummariesFromAggregates(aggregates).map((summary) => ({
            ...summary,
            forecastPolicyCaptureVersion: selectedPolicyCohort.captureVersion,
            forecastPolicyFingerprint: selectedPolicyCohort.fingerprint,
            forecastMethod: selectedPolicyCohort.forecastMethod,
            forecastVersion: selectedPolicyCohort.forecastVersion,
          }));
      const legacyObservationCount = legacyEvidence[0]?.observationCount ?? 0;
      const legacyEvaluationCount = legacyEvidence[0]?.evaluationCount ?? 0;
      const selectedCohortEvaluationCount = selectedPolicyCohort?.evaluationCount ?? 0;
      const otherPolicyCohortEvaluationCount = policyCohorts.reduce(
        (total, cohort) => total + (
          cohort.fingerprint === selectedPolicyCohort?.fingerprint
            && cohort.forecastVersion === selectedPolicyCohort.forecastVersion
            ? 0
            : cohort.evaluationCount
        ),
        0,
      );
      return {
        evaluationVersion: PURCHASE_FORECAST_EVALUATION_VERSION,
        measurement: {
          scope: "product_all_warehouses",
          predictionScope: "historical_rate_with_optional_start_date_overlay",
          historicalPredictionScope: "historical_rate_only",
          horizons: [...PURCHASE_FORECAST_EVALUATION_HORIZONS],
          wapeUnit: "basis_points",
          quantityUnit: "base_piece",
          predictionPrecision: "micro_piece",
          overlayAttributionVersion: PURCHASE_FORECAST_OVERLAY_ATTRIBUTION_VERSION,
          overlayAttributionInterval: "[planningAsOfDate, planningAsOfDate + horizonDays)",
          overlayEligibility: "capture_version_2_and_capture_horizon_covers_evaluation_horizon",
          policyCohortIsolation: "exact_policy_fingerprint_method_and_forecast_version",
        },
        policyCohorts,
        selectedPolicyCohort,
        cohortCoverage: {
          capturedPolicyCohortCount: policyCohorts.length,
          capturedObservationCount: policyCohorts.reduce(
            (total, cohort) => total + cohort.observationCount,
            0,
          ),
          capturedEvaluationCount: policyCohorts.reduce(
            (total, cohort) => total + cohort.evaluationCount,
            0,
          ),
          legacyObservationCount,
          legacyEvaluationCount,
        },
        accuracyTrustAssessment: {
          status: "not_assessed" as const,
          reason: selectedPolicyCohort === null
            ? "no_captured_policy_cohort" as const
            : selectedCohortEvaluationCount === 0
              ? "no_mature_evaluations" as const
              : "accuracy_thresholds_not_configured" as const,
          selectedPolicyFingerprint: selectedPolicyCohort?.fingerprint ?? null,
          selectedForecastVersion: selectedPolicyCohort?.forecastVersion ?? null,
          cohortIsolated: selectedPolicyCohort !== null,
          selectedCohortEvaluationCount,
          excludedLegacyEvaluationCount: legacyEvaluationCount,
          excludedOtherPolicyCohortEvaluationCount: otherPolicyCohortEvaluationCount,
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
          forwardDemandOverlayIncluded:
            item.overlayEvaluable && Number(item.overlayWeightedDemandPieces) > 0,
          overlayExclusionReason: item.overlayExclusionReason,
          overlayOutcome: !item.overlayEvaluable
            ? null
            : item.overlayAdjustedAbsoluteErrorMicros! < item.forecastAbsoluteErrorMicros
              ? "overlay_wins"
              : item.forecastAbsoluteErrorMicros < item.overlayAdjustedAbsoluteErrorMicros!
                ? "historical_forecast_wins"
                : "tie",
          overlayErrorImprovementMicros: !item.overlayEvaluable
            ? null
            : item.forecastAbsoluteErrorMicros - item.overlayAdjustedAbsoluteErrorMicros!,
        })),
      };
    });
  }

  return { evaluateMatured, getReport };
}

export type PurchaseForecastBacktestingService = ReturnType<typeof createPurchaseForecastBacktestingService>;
