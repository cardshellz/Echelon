import { and, eq } from "drizzle-orm";
import {
  purchaseForecastObservations as purchaseForecastObservationsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  purchaseRecommendationRuns as purchaseRecommendationRunsTable,
} from "@shared/schema";
import type {
  AutoDraftRecommendationSettings,
  PurchasingRecommendationItem,
} from "./purchasing-recommendation.engine";
import { buildPurchasingRfqQueue } from "./purchasing-rfq.service";

const MAX_RECOMMENDATION_LINES = 2_000;
const MAX_FORECAST_OBSERVATIONS = 10_000;
const PIECE_MICRO_SCALE = 1_000_000;

export type PurchaseRecommendationRunSource = "manual" | "auto_draft" | "api";

export type PurchaseRecommendationSnapshotLine = {
  recommendationKey: string;
  productId: number;
  productVariantId: number | null;
  warehouseId?: number | null;
  sku: string;
  productName: string;
  requiredByDate?: string | null;
  recommendedPieces: number;
  preferredVendorId?: number | null;
  preferredVendorProductId?: number | null;
  evidenceSnapshot: Record<string, unknown>;
};

export type PurchaseForecastObservationInput = {
  observationKey: string;
  productId: number;
  selectedReceiveVariantId: number | null;
  scope: "product_all_warehouses";
  productSku: string;
  productName: string;
  forecastMethod: string;
  forecastVersion: number;
  forecastDailyPiecesMicros: number;
  baselineDailyPiecesMicros: number;
  forwardDemandPieces: number;
  forwardDemandRawPieces: number;
  evidenceSnapshot: Record<string, unknown>;
};

export type CreatePurchaseRecommendationRunInput = {
  calculationVersion: string;
  source?: PurchaseRecommendationRunSource;
  sourceRunKey?: string | null;
  asOf: Date;
  lookbackDays: number;
  policySnapshot: Record<string, unknown>;
  inputSummary?: Record<string, unknown>;
  lines: PurchaseRecommendationSnapshotLine[];
  observations?: PurchaseForecastObservationInput[];
};

function assertPositiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

function assertNonnegativeInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
}

function piecesToMicros(value: unknown, field: string): number {
  const pieces = Number(value);
  if (!Number.isFinite(pieces) || pieces < 0) {
    throw new RangeError(`${field} must be a non-negative finite number`);
  }
  const micros = Math.round(pieces * PIECE_MICRO_SCALE);
  if (!Number.isSafeInteger(micros)) {
    throw new RangeError(`${field} exceeds the supported precision range`);
  }
  return micros;
}

function validateRunInput(input: CreatePurchaseRecommendationRunInput) {
  if (!input.calculationVersion?.trim() || input.calculationVersion.length > 80) {
    throw new RangeError("calculationVersion is required and cannot exceed 80 characters");
  }
  const source = input.source ?? "manual";
  if (!(["manual", "auto_draft", "api"] as const).includes(source)) {
    throw new RangeError("source is invalid");
  }
  const sourceRunKey = input.sourceRunKey?.trim() || null;
  if (sourceRunKey && sourceRunKey.length > 160) {
    throw new RangeError("sourceRunKey cannot exceed 160 characters");
  }
  if (source === "auto_draft" && !sourceRunKey) {
    throw new RangeError("sourceRunKey is required for auto-draft recommendation runs");
  }
  if (!(input.asOf instanceof Date) || Number.isNaN(input.asOf.getTime())) {
    throw new RangeError("asOf must be a valid date");
  }
  assertPositiveInteger(input.lookbackDays, "lookbackDays");
  if (!Array.isArray(input.lines) || input.lines.length > MAX_RECOMMENDATION_LINES) {
    throw new RangeError(`lines cannot contain more than ${MAX_RECOMMENDATION_LINES} items`);
  }
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    const key = line.recommendationKey?.trim();
    if (!key || key.length > 160 || seen.has(key)) {
      throw new RangeError(`lines[${index}].recommendationKey must be unique and no longer than 160 characters`);
    }
    seen.add(key);
    assertPositiveInteger(line.productId, `lines[${index}].productId`);
    if (line.productVariantId !== null) assertPositiveInteger(line.productVariantId, `lines[${index}].productVariantId`);
    if (line.warehouseId != null) assertPositiveInteger(line.warehouseId, `lines[${index}].warehouseId`);
    assertPositiveInteger(line.recommendedPieces, `lines[${index}].recommendedPieces`);
  });
  const observations = input.observations ?? [];
  if (!Array.isArray(observations) || observations.length > MAX_FORECAST_OBSERVATIONS) {
    throw new RangeError(`observations cannot contain more than ${MAX_FORECAST_OBSERVATIONS} items`);
  }
  const observedProducts = new Set<number>();
  const observationKeys = new Set<string>();
  observations.forEach((observation, index) => {
    const key = observation.observationKey?.trim();
    if (!key || key.length > 160 || observationKeys.has(key)) {
      throw new RangeError(`observations[${index}].observationKey must be unique and no longer than 160 characters`);
    }
    observationKeys.add(key);
    assertPositiveInteger(observation.productId, `observations[${index}].productId`);
    if (observedProducts.has(observation.productId)) {
      throw new RangeError(`observations[${index}].productId must be unique within a product-level run`);
    }
    observedProducts.add(observation.productId);
    if (observation.selectedReceiveVariantId !== null) {
      assertPositiveInteger(observation.selectedReceiveVariantId, `observations[${index}].selectedReceiveVariantId`);
    }
    if (observation.scope !== "product_all_warehouses") {
      throw new RangeError(`observations[${index}].scope is invalid`);
    }
    if (!observation.productSku?.trim() || observation.productSku.length > 100) {
      throw new RangeError(`observations[${index}].productSku is required and cannot exceed 100 characters`);
    }
    if (!observation.productName?.trim()) {
      throw new RangeError(`observations[${index}].productName is required`);
    }
    if (!observation.forecastMethod?.trim() || observation.forecastMethod.length > 40) {
      throw new RangeError(`observations[${index}].forecastMethod is required and cannot exceed 40 characters`);
    }
    assertPositiveInteger(observation.forecastVersion, `observations[${index}].forecastVersion`);
    assertNonnegativeInteger(observation.forecastDailyPiecesMicros, `observations[${index}].forecastDailyPiecesMicros`);
    assertNonnegativeInteger(observation.baselineDailyPiecesMicros, `observations[${index}].baselineDailyPiecesMicros`);
    assertNonnegativeInteger(observation.forwardDemandPieces, `observations[${index}].forwardDemandPieces`);
    assertNonnegativeInteger(observation.forwardDemandRawPieces, `observations[${index}].forwardDemandRawPieces`);
  });
  return { source, sourceRunKey };
}

function resolveEvaluatedCount(input: {
  recommendationResult: { items: PurchasingRecommendationItem[]; skippedItems: PurchasingRecommendationItem[] };
  evaluatedCount?: number;
}): number {
  if (input.evaluatedCount !== undefined) {
    if (!Number.isSafeInteger(input.evaluatedCount) || input.evaluatedCount < 0) {
      throw new RangeError("evaluatedCount must be a non-negative integer");
    }
    return input.evaluatedCount;
  }

  const recommendationIds = new Set<string>();
  for (const item of [...input.recommendationResult.items, ...input.recommendationResult.skippedItems]) {
    const recommendationId = item.recommendationId?.trim();
    if (recommendationId) recommendationIds.add(recommendationId);
  }
  return recommendationIds.size;
}

export function buildPurchaseRecommendationRunInput(input: {
  recommendationResult: { items: PurchasingRecommendationItem[]; skippedItems: PurchasingRecommendationItem[]; summary: unknown };
  settings: AutoDraftRecommendationSettings;
  lookbackDays: number;
  asOf: Date;
  source?: PurchaseRecommendationRunSource;
  sourceRunKey?: string | null;
  evaluatedCount?: number;
}): CreatePurchaseRecommendationRunInput {
  const candidates = buildPurchasingRfqQueue(input.recommendationResult);
  const evaluatedCount = resolveEvaluatedCount(input);
  const observations = buildPurchaseForecastObservations(input.recommendationResult);
  if (observations.length !== evaluatedCount) {
    throw new RangeError(
      `Forecast observation coverage is incomplete: expected ${evaluatedCount}, captured ${observations.length}`,
    );
  }
  return {
    calculationVersion: "purchasing-recommendation-v2",
    source: input.source ?? "manual",
    sourceRunKey: input.sourceRunKey ?? null,
    asOf: input.asOf,
    lookbackDays: input.lookbackDays,
    policySnapshot: { ...input.settings },
    inputSummary: {
      candidateCount: candidates.length,
      evaluatedCount,
      observationCount: observations.length,
      observationCoverageComplete: true,
      summary: input.recommendationResult.summary,
    },
    lines: candidates.map((item) => ({
      recommendationKey: item.recommendationId,
      productId: item.productId,
      productVariantId: item.productVariantId,
      warehouseId: null,
      sku: item.sku,
      productName: item.productName,
      requiredByDate: null,
      recommendedPieces: item.requestedPieces,
      preferredVendorId: item.preferredVendorId,
      preferredVendorProductId: item.vendorProductId,
      evidenceSnapshot: {
        ...item.demandSnapshot,
        availablePieces: item.availablePieces,
        onOrderPieces: item.onOrderPieces,
        reorderPointPieces: item.reorderPointPieces,
        forecastMethod: item.forecastMethod,
        forecastDailyPieces: item.forecastDailyPieces,
        leadTimeDays: item.leadTimeDays,
        safetyStockDays: item.safetyStockDays,
        forwardDemandPieces: item.forwardDemandPieces,
        confidence: item.confidence,
        rfqConfidence: item.rfqConfidence,
        candidateScore: item.recommendationCandidateScore,
        forecastTrust: item.forecastTrust,
        qualityGate: item.qualityGate,
        autopilotBlockers: item.autopilotBlockers,
        supplierBasis: item.supplierBasis,
      },
    })),
    observations,
  };
}

export function buildPurchaseForecastObservations(
  recommendationResult: { items: PurchasingRecommendationItem[]; skippedItems: PurchasingRecommendationItem[] },
): PurchaseForecastObservationInput[] {
  const byProduct = new Map<number, PurchasingRecommendationItem>();
  for (const item of [...recommendationResult.items, ...recommendationResult.skippedItems]) {
    const existing = byProduct.get(item.productId);
    if (existing && existing.recommendationId !== item.recommendationId) {
      throw new RangeError(`Product ${item.productId} produced multiple forecast identities in one recommendation run`);
    }
    if (!existing) byProduct.set(item.productId, item);
  }

  return Array.from(byProduct.values())
    .map((item) => {
      const forecastMethod = item.forecastProvenance.forecastMethod;
      const forecastVersion = item.forecastProvenance.forecastVersion
        ?? (forecastMethod === "weighted_blend_v1" ? 2 : 1);
      const baselineDailyPieces = item.demandBasis.lookbackDays > 0
        ? item.demandBasis.periodUsagePieces / item.demandBasis.lookbackDays
        : 0;
      return {
        observationKey: `${item.productId}:product_all_warehouses`,
        productId: item.productId,
        selectedReceiveVariantId: item.productVariantId ?? null,
        scope: "product_all_warehouses" as const,
        productSku: item.sku.trim().slice(0, 100),
        productName: item.productName.trim(),
        forecastMethod,
        forecastVersion,
        forecastDailyPiecesMicros: piecesToMicros(
          item.forecastProvenance.forecastBlend.avgDailyUsagePieces,
          "forecastDailyPieces",
        ),
        baselineDailyPiecesMicros: piecesToMicros(baselineDailyPieces, "baselineDailyPieces"),
        forwardDemandPieces: item.forwardDemandBasis.forwardDemandPieces,
        forwardDemandRawPieces: item.forwardDemandBasis.forwardDemandRawPieces,
        evidenceSnapshot: {
          recommendationId: item.recommendationId,
          status: item.status,
          skippedReason: item.skippedReason,
          actionable: item.actionable,
          demandBasis: item.demandBasis,
          forecastBlend: item.forecastProvenance.forecastBlend,
          demandWindowDiagnostics: item.forecastProvenance.demandWindowDiagnostics,
          forecastTrust: item.forecastProvenance.forecastTrust,
          forwardDemandBasis: item.forwardDemandBasis,
        },
      };
    })
    .sort((left, right) => left.productId - right.productId);
}

export function createPurchaseRecommendationSnapshotService(database: any) {
  async function findExisting(source: PurchaseRecommendationRunSource, sourceRunKey: string) {
    const runs = await database.select().from(purchaseRecommendationRunsTable).where(and(
      eq(purchaseRecommendationRunsTable.source, source),
      eq(purchaseRecommendationRunsTable.sourceRunKey, sourceRunKey),
    )).limit(1);
    const run = runs[0] ?? null;
    if (!run) return null;
    const lines = await database.select().from(purchaseRecommendationLinesTable).where(
      eq(purchaseRecommendationLinesTable.runId, run.id),
    );
    const observations = await database.select().from(purchaseForecastObservationsTable).where(
      eq(purchaseForecastObservationsTable.runId, run.id),
    );
    return { run, lines, observations, reused: true as const };
  }

  async function createRun(input: CreatePurchaseRecommendationRunInput, generatedBy?: string | null) {
    const { source, sourceRunKey } = validateRunInput(input);
    if (sourceRunKey) {
      const existing = await findExisting(source, sourceRunKey);
      if (existing) return existing;
    }

    try {
      return await database.transaction(async (tx: any) => {
        const insertedRuns = await tx.insert(purchaseRecommendationRunsTable).values({
          calculationVersion: input.calculationVersion.trim(),
          source,
          sourceRunKey,
          status: "completed",
          asOf: input.asOf,
          lookbackDays: input.lookbackDays,
          policySnapshot: input.policySnapshot,
          inputSummary: input.inputSummary ?? {},
          generatedBy: generatedBy ?? null,
        }).returning();
        const run = insertedRuns[0];
        if (!run) throw new Error("Recommendation run was not saved");
        const lines = input.lines.length === 0 ? [] : await tx.insert(purchaseRecommendationLinesTable).values(
          input.lines.map((line) => ({
            runId: run.id,
            recommendationKey: line.recommendationKey.trim(),
            productId: line.productId,
            productVariantId: line.productVariantId ?? null,
            warehouseId: line.warehouseId ?? null,
            sku: line.sku.trim().slice(0, 100),
            productName: line.productName.trim(),
            requiredByDate: line.requiredByDate ?? null,
            recommendedPieces: line.recommendedPieces,
            baseUom: "piece",
            preferredVendorId: line.preferredVendorId ?? null,
            preferredVendorProductId: line.preferredVendorProductId ?? null,
            status: "open",
            evidenceSnapshot: line.evidenceSnapshot,
          })),
        ).returning();
        const observations = (input.observations?.length ?? 0) === 0
          ? []
          : await tx.insert(purchaseForecastObservationsTable).values(
            input.observations!.map((observation) => ({
              runId: run.id,
              observationKey: observation.observationKey.trim(),
              productId: observation.productId,
              selectedReceiveVariantId: observation.selectedReceiveVariantId,
              scope: observation.scope,
              productSku: observation.productSku.trim(),
              productName: observation.productName.trim(),
              forecastMethod: observation.forecastMethod.trim(),
              forecastVersion: observation.forecastVersion,
              forecastDailyPiecesMicros: observation.forecastDailyPiecesMicros,
              baselineDailyPiecesMicros: observation.baselineDailyPiecesMicros,
              forwardDemandPieces: observation.forwardDemandPieces,
              forwardDemandRawPieces: observation.forwardDemandRawPieces,
              evidenceSnapshot: observation.evidenceSnapshot,
            })),
          ).returning();
        return { run, lines, observations, reused: false as const };
      });
    } catch (error: any) {
      if (sourceRunKey && error?.code === "23505" && error?.constraint === "purchase_recommendation_runs_source_key_uidx") {
        const existing = await findExisting(source, sourceRunKey);
        if (existing) return existing;
      }
      throw error;
    }
  }

  return { createRun };
}
