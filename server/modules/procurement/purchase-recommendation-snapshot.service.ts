import { and, eq } from "drizzle-orm";
import {
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  purchaseRecommendationRuns as purchaseRecommendationRunsTable,
} from "@shared/schema";
import type {
  AutoDraftRecommendationSettings,
  PurchasingRecommendationItem,
} from "./purchasing-recommendation.engine";
import { buildPurchasingRfqQueue } from "./purchasing-rfq.service";

const MAX_RECOMMENDATION_LINES = 2_000;

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

export type CreatePurchaseRecommendationRunInput = {
  calculationVersion: string;
  source?: PurchaseRecommendationRunSource;
  sourceRunKey?: string | null;
  asOf: Date;
  lookbackDays: number;
  policySnapshot: Record<string, unknown>;
  inputSummary?: Record<string, unknown>;
  lines: PurchaseRecommendationSnapshotLine[];
};

function assertPositiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
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
  return { source, sourceRunKey };
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
  return {
    calculationVersion: "purchasing-recommendation-v2",
    source: input.source ?? "manual",
    sourceRunKey: input.sourceRunKey ?? null,
    asOf: input.asOf,
    lookbackDays: input.lookbackDays,
    policySnapshot: { ...input.settings },
    inputSummary: {
      candidateCount: candidates.length,
      evaluatedCount: input.evaluatedCount ?? input.recommendationResult.items.length + input.recommendationResult.skippedItems.length,
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
  };
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
    return { run, lines, reused: true as const };
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
        return { run, lines, reused: false as const };
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
