import { and, eq, inArray } from "drizzle-orm";
import {
  purchaseForecastOverlayContributions as purchaseForecastOverlayContributionsTable,
  purchaseForecastObservations as purchaseForecastObservationsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  purchaseRecommendationRuns as purchaseRecommendationRunsTable,
  type PurchaseForecastOverlayContribution,
} from "@shared/schema";
import type {
  AutoDraftRecommendationSettings,
  PurchasingRecommendationItem,
} from "./purchasing-recommendation.engine";
import type { PurchasingForwardDemandContribution } from "./purchasing-forward-demand-contribution";
import { buildPurchasingRfqQueue } from "./purchasing-rfq.service";

const MAX_RECOMMENDATION_LINES = 2_000;
const MAX_FORECAST_OBSERVATIONS = 10_000;
const MAX_FORECAST_OVERLAY_CONTRIBUTIONS = 100_000;
const OVERLAY_INSERT_BATCH_SIZE = 1_000;
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
  overlayCaptureVersion?: number;
  overlayCaptureComplete?: boolean;
  overlayPlanningAsOfDate?: string | null;
  overlayHorizonDays?: number | null;
  overlayContributions?: PurchasingForwardDemandContribution[];
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

function validateCalendarDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${field} must be an ISO calendar date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be a valid ISO calendar date`);
  }
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validateOverlayContributions(
  observation: PurchaseForecastObservationInput,
  observationIndex: number,
): PurchasingForwardDemandContribution[] {
  const complete = observation.overlayCaptureComplete ?? false;
  const version = observation.overlayCaptureVersion ?? 0;
  const planningAsOfDate = observation.overlayPlanningAsOfDate ?? null;
  const horizonDays = observation.overlayHorizonDays ?? null;
  const contributions = observation.overlayContributions ?? [];
  if (typeof complete !== "boolean") {
    throw new RangeError(`observations[${observationIndex}].overlayCaptureComplete must be boolean`);
  }
  assertNonnegativeInteger(version, `observations[${observationIndex}].overlayCaptureVersion`);
  if (!Array.isArray(contributions)) {
    throw new RangeError(`observations[${observationIndex}].overlayContributions must be an array`);
  }
  if ((complete && version <= 0) || (!complete && version !== 0)) {
    throw new RangeError(`observations[${observationIndex}] has inconsistent overlay capture state`);
  }
  if (!complete && (planningAsOfDate !== null || horizonDays !== null)) {
    throw new RangeError(`observations[${observationIndex}] cannot contain incomplete overlay coverage`);
  }
  if (complete && version === 1 && (planningAsOfDate !== null || horizonDays !== null)) {
    throw new RangeError(`observations[${observationIndex}] version 1 cannot contain parent overlay coverage`);
  }
  if (complete && version >= 2) {
    validateCalendarDate(planningAsOfDate, `observations[${observationIndex}].overlayPlanningAsOfDate`);
    assertPositiveInteger(horizonDays, `observations[${observationIndex}].overlayHorizonDays`);
    if (Number(horizonDays) > 365) {
      throw new RangeError(`observations[${observationIndex}].overlayHorizonDays cannot exceed 365`);
    }
  }
  if (!complete && contributions.length > 0) {
    throw new RangeError(`observations[${observationIndex}] cannot contain incomplete overlay evidence`);
  }

  let rawPieces = BigInt(0);
  let weightedPieces = BigInt(0);
  const lineIds = new Set<number>();
  const captureThroughDate = complete && version >= 2
    ? addCalendarDays(planningAsOfDate!, Number(horizonDays))
    : null;
  contributions.forEach((contribution, contributionIndex) => {
    const prefix = `observations[${observationIndex}].overlayContributions[${contributionIndex}]`;
    assertPositiveInteger(contribution.productId, `${prefix}.productId`);
    if (contribution.productId !== observation.productId) {
      throw new RangeError(`${prefix}.productId must match its forecast observation`);
    }
    if (contribution.productVariantId !== null) {
      assertPositiveInteger(contribution.productVariantId, `${prefix}.productVariantId`);
    }
    assertPositiveInteger(contribution.demandEventId, `${prefix}.demandEventId`);
    assertPositiveInteger(contribution.demandEventLineId, `${prefix}.demandEventLineId`);
    if (lineIds.has(contribution.demandEventLineId)) {
      throw new RangeError(`${prefix}.demandEventLineId must be unique within its observation`);
    }
    lineIds.add(contribution.demandEventLineId);
    if (
      typeof contribution.eventName !== "string"
      || !contribution.eventName.trim()
      || contribution.eventName.length > 255
    ) {
      throw new RangeError(`${prefix}.eventName is required and cannot exceed 255 characters`);
    }
    if (!["drop", "preorder", "promotion", "wholesale", "seasonal", "manual_forecast"].includes(contribution.eventType)) {
      throw new RangeError(`${prefix}.eventType is invalid`);
    }
    if (!["planned", "active"].includes(contribution.eventStatus)) {
      throw new RangeError(`${prefix}.eventStatus is invalid`);
    }
    if (!["high", "medium", "low"].includes(contribution.confidence)) {
      throw new RangeError(`${prefix}.confidence is invalid`);
    }
    validateCalendarDate(contribution.eventStartDate, `${prefix}.eventStartDate`);
    if (contribution.eventEndDate !== null) {
      validateCalendarDate(contribution.eventEndDate, `${prefix}.eventEndDate`);
      if (contribution.eventEndDate < contribution.eventStartDate) {
        throw new RangeError(`${prefix}.eventEndDate cannot precede eventStartDate`);
      }
    }
    validateCalendarDate(contribution.planningAsOfDate, `${prefix}.planningAsOfDate`);
    if (complete && version >= 2 && contribution.planningAsOfDate !== planningAsOfDate) {
      throw new RangeError(`${prefix}.planningAsOfDate must match its forecast observation`);
    }
    if (captureThroughDate !== null && contribution.eventStartDate > captureThroughDate) {
      throw new RangeError(`${prefix}.eventStartDate falls outside its forecast observation horizon`);
    }
    if (contribution.eventEndDate !== null && contribution.eventEndDate < contribution.planningAsOfDate) {
      throw new RangeError(`${prefix}.eventEndDate cannot precede planningAsOfDate`);
    }
    assertNonnegativeInteger(contribution.expectedPieces, `${prefix}.expectedPieces`);
    assertNonnegativeInteger(contribution.weightedPieces, `${prefix}.weightedPieces`);
    assertNonnegativeInteger(contribution.confidenceWeightPercent, `${prefix}.confidenceWeightPercent`);
    if (contribution.confidenceWeightPercent > 100) {
      throw new RangeError(`${prefix}.confidenceWeightPercent cannot exceed 100`);
    }
    if (
      typeof contribution.eventUpdatedAt !== "string"
      || Number.isNaN(new Date(contribution.eventUpdatedAt).getTime())
    ) {
      throw new RangeError(`${prefix}.eventUpdatedAt must be a valid timestamp`);
    }
    if (
      typeof contribution.lineUpdatedAt !== "string"
      || Number.isNaN(new Date(contribution.lineUpdatedAt).getTime())
    ) {
      throw new RangeError(`${prefix}.lineUpdatedAt must be a valid timestamp`);
    }
    const expectedWeightedPieces = (
      BigInt(contribution.expectedPieces) * BigInt(contribution.confidenceWeightPercent) + BigInt(99)
    ) / BigInt(100);
    if (BigInt(contribution.weightedPieces) !== expectedWeightedPieces) {
      throw new RangeError(`${prefix}.weightedPieces does not match expectedPieces and confidenceWeightPercent`);
    }
    rawPieces += BigInt(contribution.expectedPieces);
    weightedPieces += BigInt(contribution.weightedPieces);
  });

  if (
    complete
    && (
      rawPieces !== BigInt(observation.forwardDemandRawPieces)
      || weightedPieces !== BigInt(observation.forwardDemandPieces)
    )
  ) {
    throw new RangeError(`observations[${observationIndex}] overlay contribution totals do not match its aggregate`);
  }
  return contributions;
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
  let overlayContributionCount = 0;
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
    overlayContributionCount += validateOverlayContributions(observation, index).length;
    if (overlayContributionCount > MAX_FORECAST_OVERLAY_CONTRIBUTIONS) {
      throw new RangeError(
        `observations cannot contain more than ${MAX_FORECAST_OVERLAY_CONTRIBUTIONS} overlay contributions`,
      );
    }
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
      overlayCaptureComplete: observations.every((observation) => observation.overlayCaptureComplete === true),
      overlayCoverageComplete: observations.every(
        (observation) => observation.overlayCaptureComplete === true
          && Number(observation.overlayCaptureVersion) >= 2
          && observation.overlayPlanningAsOfDate != null
          && observation.overlayHorizonDays != null,
      ),
      overlayContributionCount: observations.reduce(
        (count, observation) => count + (observation.overlayContributions?.length ?? 0),
        0,
      ),
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
      const overlayCaptureComplete = item.forwardDemandBasis.overlayCaptureComplete === true;
      const overlayCaptureVersion = overlayCaptureComplete
        ? item.forwardDemandBasis.overlayCaptureVersion
        : 0;
      const overlayPlanningAsOfDate = overlayCaptureComplete
        ? item.forwardDemandBasis.overlayPlanningAsOfDate
        : null;
      const overlayHorizonDays = overlayCaptureComplete
        ? item.forwardDemandBasis.overlayHorizonDays
        : null;
      const overlayContributions = overlayCaptureComplete
        ? item.forwardDemandBasis.contributions
        : [];
      const {
        contributions: _overlayContributions,
        ...forwardDemandBasisSummary
      } = item.forwardDemandBasis;
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
        overlayCaptureVersion,
        overlayCaptureComplete,
        overlayPlanningAsOfDate,
        overlayHorizonDays,
        overlayContributions,
        evidenceSnapshot: {
          recommendationId: item.recommendationId,
          status: item.status,
          skippedReason: item.skippedReason,
          actionable: item.actionable,
          demandBasis: item.demandBasis,
          forecastBlend: item.forecastProvenance.forecastBlend,
          demandWindowDiagnostics: item.forecastProvenance.demandWindowDiagnostics,
          forecastTrust: item.forecastProvenance.forecastTrust,
          forwardDemandBasis: forwardDemandBasisSummary,
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
    const overlayContributions = observations.length === 0
      ? []
      : await database.select().from(purchaseForecastOverlayContributionsTable).where(
        inArray(
          purchaseForecastOverlayContributionsTable.observationId,
          observations.map((observation: { id: number }) => observation.id),
        ),
      ).orderBy(
        purchaseForecastOverlayContributionsTable.observationId,
        purchaseForecastOverlayContributionsTable.eventStartDate,
        purchaseForecastOverlayContributionsTable.demandEventId,
        purchaseForecastOverlayContributionsTable.demandEventLineId,
      );
    return { run, lines, observations, overlayContributions, reused: true as const };
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
              overlayCaptureVersion: observation.overlayCaptureVersion ?? 0,
              overlayCaptureComplete: observation.overlayCaptureComplete ?? false,
              overlayPlanningAsOfDate: observation.overlayPlanningAsOfDate ?? null,
              overlayHorizonDays: observation.overlayHorizonDays ?? null,
              evidenceSnapshot: observation.evidenceSnapshot,
            })),
          ).returning();
        const observationByProductId = new Map<number, { id: number }>(
          observations.map((observation: { id: number; productId: number }) => [
            observation.productId,
            observation,
          ]),
        );
        const overlayContributionInputs = (input.observations ?? []).flatMap((observation) => {
          const savedObservation = observationByProductId.get(observation.productId);
          if (!savedObservation) {
            throw new Error(`Saved forecast observation is missing for product ${observation.productId}`);
          }
          return (observation.overlayContributions ?? []).map((contribution) => ({
            observationId: savedObservation.id,
            demandEventId: contribution.demandEventId,
            demandEventLineId: contribution.demandEventLineId,
            productVariantId: contribution.productVariantId,
            eventName: contribution.eventName.trim(),
            eventType: contribution.eventType,
            eventStatus: contribution.eventStatus,
            eventStartDate: contribution.eventStartDate,
            eventEndDate: contribution.eventEndDate,
            planningAsOfDate: contribution.planningAsOfDate,
            expectedPieces: contribution.expectedPieces,
            confidence: contribution.confidence,
            confidenceWeightPercent: contribution.confidenceWeightPercent,
            weightedPieces: contribution.weightedPieces,
            eventUpdatedAt: new Date(contribution.eventUpdatedAt),
            lineUpdatedAt: new Date(contribution.lineUpdatedAt),
          }));
        });
        const overlayContributions: PurchaseForecastOverlayContribution[] = [];
        for (
          let offset = 0;
          offset < overlayContributionInputs.length;
          offset += OVERLAY_INSERT_BATCH_SIZE
        ) {
          const inserted = await tx.insert(purchaseForecastOverlayContributionsTable).values(
            overlayContributionInputs.slice(offset, offset + OVERLAY_INSERT_BATCH_SIZE),
          ).returning();
          overlayContributions.push(...inserted);
        }
        return { run, lines, observations, overlayContributions, reused: false as const };
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
