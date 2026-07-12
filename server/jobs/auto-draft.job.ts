/**
 * Auto-Draft Job
 *
 * Runs from Heroku Scheduler or an authenticated manual trigger. Recommendation
 * analysis is read-only; every PO mutation is delegated to the atomic handoff
 * service so decisions, PO rows, lines, events, and provenance commit together.
 */

import { db } from "../db";
import { inventoryStorage } from "../modules/inventory";
import { runStaleAutoDraftPoEscalationCheck } from "../modules/procurement/auto-draft-po-escalation.service";
import { procurementMethods } from "../modules/procurement/procurement.storage";
import {
  generatePurchasingRecommendations,
  passesAutoDraftApprovalPolicy,
  type AutoDraftRecommendationSettings,
  type PurchasingRecommendationItem,
  type PurchasingRecommendationRawRow,
} from "../modules/procurement/purchasing-recommendation.engine";
import { loadPurchasingRecommendationContext } from "../modules/procurement/purchasing-recommendation-context.service";
import {
  buildPurchasingRecommendationRunDetail,
  type PurchasingRecommendationRunPoMutation,
} from "../modules/procurement/purchasing-recommendation.run-detail";
import { createDrizzleRecommendationPoHandoffRepository } from "../modules/procurement/recommendation-po-handoff.repository";
import {
  createRecommendationPoHandoffService,
  type AutomaticRecommendationPoHandoffItem,
  type CreatedRecommendationPurchaseOrder,
} from "../modules/procurement/recommendation-po-handoff.service";

interface AutoDraftOptions {
  triggeredBy: "scheduler" | "manual";
  triggeredByUser?: string;
}

type AutoDraftJobSettings = AutoDraftRecommendationSettings & {
  stalePoThresholds?: NonNullable<Parameters<typeof runStaleAutoDraftPoEscalationCheck>[0]>["thresholds"];
};

export interface AutoDraftJobResult {
  success: true;
  pos: CreatedRecommendationPurchaseOrder[];
  count: number;
  itemsDrafted: number;
  itemsSkippedAfterAnalysis: number;
  reviewOnly: boolean;
  recommendationSummary: ReturnType<typeof generatePurchasingRecommendations>["summary"];
  recommendationRun: {
    id: number;
    detail: ReturnType<typeof buildPurchasingRecommendationRunDetail>;
  };
}

function toAutomaticHandoffItem(
  item: PurchasingRecommendationItem,
  lookbackDays: number,
  settings: AutoDraftRecommendationSettings,
): AutomaticRecommendationPoHandoffItem {
  const productVariantId = item.productVariantId;
  const vendorId = item.preferredVendorId;
  const vendorProductId = item.supplierBasis.vendorProductId;
  if (!Number.isSafeInteger(productVariantId) || Number(productVariantId) <= 0) {
    throw new RangeError(`Recommendation ${item.recommendationId} has no valid receive configuration`);
  }
  if (!Number.isSafeInteger(vendorId) || Number(vendorId) <= 0) {
    throw new RangeError(`Recommendation ${item.recommendationId} has no valid preferred vendor`);
  }
  if (!Number.isSafeInteger(vendorProductId) || Number(vendorProductId) <= 0) {
    throw new RangeError(`Recommendation ${item.recommendationId} has no valid supplier catalog binding`);
  }

  return {
    recommendationId: item.recommendationId,
    productId: item.productId,
    productVariantId: Number(productVariantId),
    suggestedOrderQty: item.suggestedOrderQty,
    suggestedOrderPieces: item.suggestedOrderPieces,
    orderUomUnits: item.orderUomUnits,
    orderUomLabel: item.orderUomLabel,
    vendorId: Number(vendorId),
    vendorProductId: Number(vendorProductId),
    sku: item.sku,
    productName: item.productName,
    estimatedCostMills: item.estimatedCostMills,
    estimatedCostCents: item.estimatedCostCents,
    candidateScore: item.recommendationCandidateScore.score,
    candidateBand: item.recommendationCandidateScore.band,
    recommendationSnapshot: {
      item,
      analysis: { lookbackDays },
      approvalPolicy: {
        mode: settings.autoDraftMode ?? "draft_po",
        policy: settings.approvalPolicy ?? "high_confidence_only",
      },
    },
  };
}

function shouldCreateDraftPos(settings: AutoDraftRecommendationSettings): boolean {
  return settings.autoDraftMode !== "review_only";
}

export async function runAutoDraftJob(options: AutoDraftOptions): Promise<AutoDraftJobResult> {
  const storage = { ...procurementMethods, ...inventoryStorage };
  const handoffService = createRecommendationPoHandoffService(
    createDrizzleRecommendationPoHandoffRepository(db),
  );
  const runRecord = await storage.createAutoDraftRun({
    triggeredBy: options.triggeredBy,
    triggeredByUser: options.triggeredByUser,
    status: "running",
  });

  let itemsAnalyzed = 0;
  let posCreated = 0;
  const posUpdated = 0;
  let linesAdded = 0;
  let skippedNoVendor = 0;
  let skippedOnOrder = 0;
  let skippedExcluded = 0;
  let recommendationRunDetail: ReturnType<typeof buildPurchasingRecommendationRunDetail> | null = null;

  try {
    const settings = await storage.getAutoDraftSettings() as AutoDraftJobSettings;
    const lookbackDays = await storage.getVelocityLookbackDays();
    const [rawData, context] = await Promise.all([
      storage.getReorderAnalysisData(lookbackDays),
      loadPurchasingRecommendationContext(),
    ]);
    itemsAnalyzed = rawData.length;

    const recommendationResult = generatePurchasingRecommendations({
      rows: rawData as PurchasingRecommendationRawRow[],
      lookbackDays,
      autoDraftSettings: settings,
      requireVendor: Boolean(settings.skipNoVendor),
      ...context,
    });
    skippedExcluded = recommendationResult.summary.excludedCount;
    skippedNoVendor = recommendationResult.summary.skippedNoVendor;
    skippedOnOrder = recommendationResult.summary.skippedOnOrder;

    const eligibleItems = recommendationResult.items
      .filter((item) => passesAutoDraftApprovalPolicy(item, settings))
      .map((item) => toAutomaticHandoffItem(item, lookbackDays, settings));
    const createDraftPos = shouldCreateDraftPos(settings);
    const handoffResult = createDraftPos && eligibleItems.length > 0
      ? await handoffService.createAutomaticHandoff({
          actorId: options.triggeredByUser ?? "system:auto-draft",
          autoDraftRunId: runRecord.id,
          items: eligibleItems,
        })
      : { pos: [], decisions: [], handedOff: [], skipped: [] };

    posCreated = handoffResult.pos.length;
    linesAdded = handoffResult.handedOff.length;
    const poMutations: PurchasingRecommendationRunPoMutation[] = handoffResult.pos.map((po) => ({
      vendorId: po.vendorId,
      poId: po.id,
      action: "created",
      linesAdded: handoffResult.handedOff.filter((item) => item.poId === po.id).length,
    }));

    recommendationRunDetail = buildPurchasingRecommendationRunDetail(recommendationResult, {
      lookbackDays,
      settings,
      poMutations,
      poMutationSkips: handoffResult.skipped,
    });

    await storage.updateAutoDraftRun(runRecord.id, {
      status: "success",
      itemsAnalyzed,
      posCreated,
      posUpdated,
      linesAdded,
      skippedNoVendor,
      skippedOnOrder,
      skippedExcluded,
      summaryJson: recommendationRunDetail,
      finishedAt: new Date(),
    });

    console.log(
      `[Auto-draft] Complete: ${itemsAnalyzed} analyzed, ${posCreated} created, ${linesAdded} lines added, ` +
      `${handoffResult.skipped.length} stale snapshots skipped, ${skippedNoVendor} skipped (no vendor), ` +
      `${skippedExcluded} excluded`,
    );

    try {
      const escalation = await runStaleAutoDraftPoEscalationCheck({
        thresholds: settings.stalePoThresholds,
      });
      if (escalation.sent) {
        console.warn(`[Auto-draft] Sent critical stale PO escalation for ${escalation.criticalCount} PO(s)`);
      }
    } catch (error: any) {
      console.error("[Auto-draft] Stale PO escalation check failed:", error?.message ?? error);
    }

    return {
      success: true,
      pos: handoffResult.pos,
      count: handoffResult.pos.length,
      itemsDrafted: handoffResult.handedOff.length,
      itemsSkippedAfterAnalysis: handoffResult.skipped.length,
      reviewOnly: !createDraftPos,
      recommendationSummary: recommendationResult.summary,
      recommendationRun: {
        id: runRecord.id,
        detail: recommendationRunDetail,
      },
    };
  } catch (error: any) {
    console.error("[Auto-draft] Failed:", error);
    await storage.updateAutoDraftRun(runRecord.id, {
      status: "error",
      errorMessage: error?.message || "Unknown error",
      itemsAnalyzed,
      posCreated,
      posUpdated,
      linesAdded,
      skippedNoVendor,
      skippedOnOrder,
      skippedExcluded,
      summaryJson: recommendationRunDetail,
      finishedAt: new Date(),
    });
    throw error;
  }
}
