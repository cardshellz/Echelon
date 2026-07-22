/**
 * Auto-Draft Job
 *
 * Runs from Heroku Scheduler or an authenticated manual trigger. Recommendation
 * analysis is read-only; every PO mutation is delegated to the atomic handoff
 * service so decisions, PO rows, lines, events, and provenance commit together.
 */

import { db } from "../db";
import { normalizePoLinePricing } from "@shared/utils/po-line-pricing";
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
import { createDrizzleAutoDraftRunLifecycleRepository } from "../modules/procurement/auto-draft-run-lifecycle.repository";
import {
  createAutoDraftRunLifecycleService,
  type AutoDraftRunLifecycleService,
  type AutoDraftRunRecord,
} from "../modules/procurement/auto-draft-run-lifecycle.service";
import {
  buildPurchasingRecommendationRunDetail,
  type PurchasingRecommendationRunPoMutation,
} from "../modules/procurement/purchasing-recommendation.run-detail";
import { createDrizzleRecommendationPoHandoffRepository } from "../modules/procurement/recommendation-po-handoff.repository";
import {
  createRecommendationPoHandoffService,
  type AutomaticRecommendationPoHandoffItem,
  type AutomaticRecommendationPoHandoffResult,
  type CreatedRecommendationPurchaseOrder,
} from "../modules/procurement/recommendation-po-handoff.service";
import {
  buildPurchaseRecommendationRunInput,
  createPurchaseRecommendationSnapshotService,
} from "../modules/procurement/purchase-recommendation-snapshot.service";
import {
  createAutomaticRfqDraftService,
  normalizeAutomaticRfqDraftPolicy,
  summarizeAutomaticRfqDraftResult,
} from "../modules/procurement/automatic-rfq-draft.service";

export interface AutoDraftOptions {
  triggeredBy: "scheduler" | "manual";
  triggeredByUser?: string;
  pilot?: AutomaticPurchasingPilotScope;
}

export interface AutomaticPurchasingPilotScope {
  sku: string;
}

export type AutomaticPurchasingPilotBlockerCode =
  | "sku_not_found"
  | "sku_ambiguous"
  | "review_only_mode"
  | "approval_policy_rejected"
  | "handoff_validation_failed";

export interface AutomaticPurchasingPilotPreview {
  mode: "preflight";
  sku: string;
  generatedAt: string;
  lookbackDays: number;
  itemsAnalyzed: number;
  matchCount: number;
  autoDraftMode: "draft_po" | "review_only";
  approvalPolicy: NonNullable<AutoDraftRecommendationSettings["approvalPolicy"]>;
  eligible: boolean;
  blockers: Array<{ code: AutomaticPurchasingPilotBlockerCode; detail: string }>;
  limits: {
    maximumPurchaseOrders: 1;
    maximumPurchaseOrderLines: 1;
  };
  recommendation: null | {
    recommendationId: string;
    productId: number;
    productVariantId: number | null;
    sku: string;
    productName: string;
    preferredVendorId: number | null;
    vendorProductId: number | null;
    suggestedOrderQty: number;
    suggestedOrderPieces: number;
    orderUomUnits: number;
    orderUomLabel: string;
    pricingBasis: PurchasingRecommendationItem["supplierBasis"]["pricingBasis"];
    purchaseUom: string | null;
    piecesPerPurchaseUom: number | null;
    quotedUnitCostMills: number | null;
    estimatedCostMills: number | null;
    estimatedCostCents: number | null;
    quoteReference: string | null;
    quotedAt: string | Date | null;
    quoteValidUntil: string | null;
    confidence: PurchasingRecommendationItem["confidence"];
    candidateScore: number;
    candidateBand: PurchasingRecommendationItem["recommendationCandidateScore"]["band"];
    qualityGate: PurchasingRecommendationItem["qualityGate"];
    autopilotBlockers: PurchasingRecommendationItem["autopilotBlockers"];
    normalizedLinePricing: ReturnType<typeof normalizePoLinePricing> | null;
  };
}

export type AutomaticPurchasingReadinessStatus =
  | "eligible"
  | "automation_disabled"
  | "configuration_required"
  | "demand_review_required"
  | "configuration_and_demand_review_required"
  | "policy_review_required";

export interface AutomaticPurchasingReadinessReport {
  mode: "readiness";
  generatedAt: string;
  limit: number;
  lookbackDays: number;
  itemsAnalyzed: number;
  autoDraftMode: "draft_po" | "review_only";
  approvalPolicy: NonNullable<AutoDraftRecommendationSettings["approvalPolicy"]>;
  recommendationSummary: ReturnType<typeof generatePurchasingRecommendations>["summary"];
  summary: {
    candidateCount: number;
    returnedCandidateCount: number;
    eligibleCount: number;
    automationDisabledCount: number;
    configurationRequiredCount: number;
    demandReviewRequiredCount: number;
    configurationAndDemandReviewRequiredCount: number;
    policyReviewRequiredCount: number;
  };
  blockerCounts: Record<string, number>;
  candidates: Array<{
    readinessStatus: AutomaticPurchasingReadinessStatus;
    approvalPolicyEligible: boolean;
    executionEligible: boolean;
    sku: string;
    productName: string;
    recommendationId: string;
    productId: number;
    productVariantId: number | null;
    status: PurchasingRecommendationItem["status"];
    skippedReason: PurchasingRecommendationItem["skippedReason"];
    suggestedOrderPieces: number;
    orderUomUnits: number;
    orderUomLabel: string;
    preferredVendorId: number | null;
    preferredVendorName: string | null;
    vendorProductId: number | null;
    confidence: PurchasingRecommendationItem["confidence"];
    candidateScore: number;
    candidateBand: PurchasingRecommendationItem["recommendationCandidateScore"]["band"];
    forecastTrust: PurchasingRecommendationItem["demandBasis"]["forecastTrust"];
    demandOrderCount: number | null;
    demandActiveDays: number | null;
    latestDemandAt: string | Date | null;
    pricingBasis: PurchasingRecommendationItem["supplierBasis"]["pricingBasis"];
    purchaseUom: string | null;
    piecesPerPurchaseUom: number | null;
    minimumOrderPieces: number | null;
    quotedUnitCostMills: number | null;
    quoteReference: string | null;
    quotedAt: string | Date | null;
    quoteValidUntil: string | null;
    blockers: PurchasingRecommendationItem["autopilotBlockers"];
    nextActions: Array<{
      code: string;
      detail: string;
    }>;
  }>;
}

export class AutomaticPurchasingPilotError extends Error {
  readonly code = "AUTOMATIC_PURCHASING_PILOT_BLOCKED";

  constructor(readonly preview: AutomaticPurchasingPilotPreview) {
    super(`Automatic purchasing pilot blocked: ${preview.blockers.map((blocker) => blocker.detail).join("; ")}`);
    this.name = "AutomaticPurchasingPilotError";
  }
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
  purchaseRecommendationRun: {
    id: number;
    lineCount: number;
    observationCount: number;
    reused: boolean;
  };
  automaticRfqDrafts: {
    mode: "manual" | "preferred_vendor";
    suppressedForPilot: boolean;
    rfqCount: number;
    lineCount: number;
    skippedCount: number;
    skippedByCode: Record<string, number>;
    reused: boolean;
  };
  pilot?: Omit<AutomaticPurchasingPilotPreview, "mode"> & {
    mode: "execute";
    outcome: "created" | "stale_snapshot_skipped";
    mapping: AutomaticRecommendationPoHandoffResult["handedOff"][number] | null;
    skip: AutomaticRecommendationPoHandoffResult["skipped"][number] | null;
  };
}

export interface StartedAutoDraftJob {
  runId: number;
  interruptedRunIds: number[];
  completion: Promise<AutoDraftJobResult>;
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
  if (item.supplierBasis.pricingBasis === "legacy_unknown") {
    throw new RangeError(`Recommendation ${item.recommendationId} requires supplier quote-basis review`);
  }
  const quotedUnitCostMills = item.supplierBasis.quotedUnitCostMills;
  if (!Number.isSafeInteger(quotedUnitCostMills) || Number(quotedUnitCostMills) < 0) {
    throw new RangeError(`Recommendation ${item.recommendationId} has no valid original supplier quote`);
  }
  const quotedAt = item.supplierBasis.quotedAt
    ? new Date(item.supplierBasis.quotedAt)
    : null;
  if (!quotedAt || Number.isNaN(quotedAt.getTime())) {
    throw new RangeError(`Recommendation ${item.recommendationId} has no verified supplier quote date`);
  }
  if (
    item.supplierBasis.pricingBasis === "per_purchase_uom" &&
    (
      !item.supplierBasis.purchaseUom?.trim() ||
      !Number.isSafeInteger(item.supplierBasis.piecesPerPurchaseUom) ||
      Number(item.supplierBasis.piecesPerPurchaseUom) <= 0 ||
      item.suggestedOrderPieces % Number(item.supplierBasis.piecesPerPurchaseUom) !== 0
    )
  ) {
    throw new RangeError(`Recommendation ${item.recommendationId} has an invalid supplier purchase-UOM quote`);
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
    pricingBasis: item.supplierBasis.pricingBasis,
    purchaseUom: item.supplierBasis.purchaseUom,
    quotedUnitCostMills: Number(quotedUnitCostMills),
    piecesPerPurchaseUom: item.supplierBasis.piecesPerPurchaseUom,
    quoteReference: item.supplierBasis.quoteReference,
    quotedAt,
    quoteValidUntil: item.supplierBasis.quoteValidUntil,
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

function normalizePilotSku(sku: string): string {
  const normalized = sku.trim();
  if (!normalized) throw new RangeError("Automatic purchasing pilot SKU is required");
  if (normalized.length > 100) throw new RangeError("Automatic purchasing pilot SKU must be 100 characters or fewer");
  return normalized.toLocaleUpperCase("en-US");
}

function buildPilotPreview(input: {
  sku: string;
  generatedAt: Date;
  lookbackDays: number;
  itemsAnalyzed: number;
  settings: AutoDraftRecommendationSettings;
  items: PurchasingRecommendationItem[];
}): { preview: AutomaticPurchasingPilotPreview; handoffItem: AutomaticRecommendationPoHandoffItem | null } {
  const normalizedSku = normalizePilotSku(input.sku);
  const matches = input.items.filter((item) => normalizePilotSku(item.sku) === normalizedSku);
  const recommendation = matches.length === 1 ? matches[0] : null;
  const blockers: AutomaticPurchasingPilotPreview["blockers"] = [];
  let handoffItem: AutomaticRecommendationPoHandoffItem | null = null;
  let normalizedLinePricing: ReturnType<typeof normalizePoLinePricing> | null = null;

  if (matches.length === 0) {
    blockers.push({ code: "sku_not_found", detail: `No purchasing recommendation matched SKU ${normalizedSku}` });
  } else if (matches.length > 1) {
    blockers.push({ code: "sku_ambiguous", detail: `${matches.length} purchasing recommendations matched SKU ${normalizedSku}` });
  }

  if (input.settings.autoDraftMode === "review_only") {
    blockers.push({ code: "review_only_mode", detail: "Automatic purchasing is configured for review-only mode" });
  }

  if (recommendation && !passesAutoDraftApprovalPolicy(recommendation, input.settings)) {
    blockers.push({
      code: "approval_policy_rejected",
      detail: `Recommendation ${recommendation.recommendationId} does not pass the configured automatic-draft approval policy`,
    });
  }

  if (recommendation && blockers.length === 0) {
    try {
      handoffItem = toAutomaticHandoffItem(recommendation, input.lookbackDays, input.settings);
      normalizedLinePricing = handoffItem.pricingBasis === "per_piece"
        ? normalizePoLinePricing({
            basis: "per_piece",
            quantityPieces: handoffItem.suggestedOrderPieces,
            unitCostMills: handoffItem.quotedUnitCostMills,
          })
        : normalizePoLinePricing({
            basis: "per_purchase_uom",
            purchaseUom: handoffItem.purchaseUom ?? "",
            uomQuantity: handoffItem.suggestedOrderPieces / Number(handoffItem.piecesPerPurchaseUom),
            piecesPerUom: Number(handoffItem.piecesPerPurchaseUom),
            quotedCostMillsPerUom: handoffItem.quotedUnitCostMills,
          });
    } catch (error) {
      blockers.push({
        code: "handoff_validation_failed",
        detail: error instanceof Error ? error.message : "Recommendation failed automatic handoff validation",
      });
    }
  }

  const preview: AutomaticPurchasingPilotPreview = {
    mode: "preflight",
    sku: normalizedSku,
    generatedAt: input.generatedAt.toISOString(),
    lookbackDays: input.lookbackDays,
    itemsAnalyzed: input.itemsAnalyzed,
    matchCount: matches.length,
    autoDraftMode: input.settings.autoDraftMode ?? "draft_po",
    approvalPolicy: input.settings.approvalPolicy ?? "high_confidence_only",
    eligible: blockers.length === 0 && handoffItem !== null,
    blockers,
    limits: { maximumPurchaseOrders: 1, maximumPurchaseOrderLines: 1 },
    recommendation: recommendation ? {
      recommendationId: recommendation.recommendationId,
      productId: recommendation.productId,
      productVariantId: recommendation.productVariantId ?? null,
      sku: recommendation.sku,
      productName: recommendation.productName,
      preferredVendorId: recommendation.preferredVendorId,
      vendorProductId: recommendation.supplierBasis.vendorProductId,
      suggestedOrderQty: recommendation.suggestedOrderQty,
      suggestedOrderPieces: recommendation.suggestedOrderPieces,
      orderUomUnits: recommendation.orderUomUnits,
      orderUomLabel: recommendation.orderUomLabel,
      pricingBasis: recommendation.supplierBasis.pricingBasis,
      purchaseUom: recommendation.supplierBasis.purchaseUom,
      piecesPerPurchaseUom: recommendation.supplierBasis.piecesPerPurchaseUom,
      quotedUnitCostMills: recommendation.supplierBasis.quotedUnitCostMills,
      estimatedCostMills: recommendation.estimatedCostMills,
      estimatedCostCents: recommendation.estimatedCostCents,
      quoteReference: recommendation.supplierBasis.quoteReference,
      quotedAt: recommendation.supplierBasis.quotedAt,
      quoteValidUntil: recommendation.supplierBasis.quoteValidUntil,
      confidence: recommendation.confidence,
      candidateScore: recommendation.recommendationCandidateScore.score,
      candidateBand: recommendation.recommendationCandidateScore.band,
      qualityGate: recommendation.qualityGate,
      autopilotBlockers: recommendation.autopilotBlockers,
      normalizedLinePricing,
    } : null,
  };
  return { preview, handoffItem };
}

const readinessActionByArea: Record<
  PurchasingRecommendationItem["autopilotBlockers"][number]["area"],
  { code: string; detail: string }
> = {
  demand: {
    code: "review_demand_evidence",
    detail: "Review demand provenance, promotion mix, sample depth, and trend; do not bypass the approval policy.",
  },
  lead_time: {
    code: "configure_vendor_lead_time",
    detail: "Set the supplier-specific lead time on the preferred vendor-product row.",
  },
  supplier_cost: {
    code: "verify_supplier_quote",
    detail: "Record a current verified supplier quote with its date and validity.",
  },
  vendor: {
    code: "assign_preferred_vendor",
    detail: "Create or select one active preferred vendor-product mapping.",
  },
  receive_configuration: {
    code: "configure_receive_variant",
    detail: "Assign an active receive variant with the correct units-per-variant.",
  },
  supplier_catalog: {
    code: "complete_supplier_catalog",
    detail: "Complete the supplier quote basis, purchase UOM, quantity multiple, and MOQ configuration.",
  },
};

function buildReadinessCandidate(input: {
  item: PurchasingRecommendationItem;
  approvalPolicyEligible: boolean;
  executionEnabled: boolean;
}) {
  const { item, approvalPolicyEligible, executionEnabled } = input;
  const executionEligible = executionEnabled && approvalPolicyEligible;
  const hasConfigurationBlocker = item.autopilotBlockers.some((blocker) => blocker.area !== "demand");
  const hasDemandBlocker = item.autopilotBlockers.some((blocker) => blocker.area === "demand");
  let readinessStatus: AutomaticPurchasingReadinessStatus = "policy_review_required";
  if (executionEligible) readinessStatus = "eligible";
  else if (approvalPolicyEligible) readinessStatus = "automation_disabled";
  else if (hasConfigurationBlocker && hasDemandBlocker) {
    readinessStatus = "configuration_and_demand_review_required";
  } else if (hasConfigurationBlocker) readinessStatus = "configuration_required";
  else if (hasDemandBlocker) readinessStatus = "demand_review_required";
  const seenActions = new Set<string>();
  const nextActions = item.autopilotBlockers.flatMap((blocker) => {
    const action = readinessActionByArea[blocker.area];
    if (seenActions.has(action.code)) return [];
    seenActions.add(action.code);
    return [action];
  });
  if (readinessStatus === "automation_disabled") {
    nextActions.push({
      code: "review_automatic_purchasing_mode",
      detail: "Obtain the required operational approval before changing automatic purchasing from review-only mode.",
    });
  } else if (readinessStatus === "policy_review_required" && nextActions.length === 0) {
    nextActions.push({
      code: "review_candidate_score",
      detail: "Review the recommendation evidence and candidate score; do not weaken the configured approval policy.",
    });
  }

  return {
    readinessStatus,
    approvalPolicyEligible,
    executionEligible,
    sku: item.sku,
    productName: item.productName,
    recommendationId: item.recommendationId,
    productId: item.productId,
    productVariantId: item.productVariantId ?? null,
    status: item.status,
    skippedReason: item.skippedReason,
    suggestedOrderPieces: item.suggestedOrderPieces,
    orderUomUnits: item.orderUomUnits,
    orderUomLabel: item.orderUomLabel,
    preferredVendorId: item.preferredVendorId,
    preferredVendorName: item.preferredVendorName,
    vendorProductId: item.supplierBasis.vendorProductId,
    confidence: item.confidence,
    candidateScore: item.recommendationCandidateScore.score,
    candidateBand: item.recommendationCandidateScore.band,
    forecastTrust: item.demandBasis.forecastTrust,
    demandOrderCount: item.demandBasis.demandOrderCount,
    demandActiveDays: item.demandBasis.demandActiveDays,
    latestDemandAt: item.demandBasis.latestDemandAt,
    pricingBasis: item.supplierBasis.pricingBasis,
    purchaseUom: item.supplierBasis.purchaseUom,
    piecesPerPurchaseUom: item.supplierBasis.piecesPerPurchaseUom,
    minimumOrderPieces: item.supplierBasis.minimumOrderPieces,
    quotedUnitCostMills: item.supplierBasis.quotedUnitCostMills,
    quoteReference: item.supplierBasis.quoteReference,
    quotedAt: item.supplierBasis.quotedAt,
    quoteValidUntil: item.supplierBasis.quoteValidUntil,
    blockers: item.autopilotBlockers,
    nextActions,
  };
}

const readinessStatusRank: Record<AutomaticPurchasingReadinessStatus, number> = {
  eligible: 0,
  automation_disabled: 1,
  configuration_required: 2,
  configuration_and_demand_review_required: 3,
  demand_review_required: 4,
  policy_review_required: 5,
};

async function loadAutoDraftAnalysis() {
  const storage = { ...procurementMethods, ...inventoryStorage };
  const settings = await storage.getAutoDraftSettings() as AutoDraftJobSettings;
  const lookbackDays = await storage.getVelocityLookbackDays();
  const [rawData, context] = await Promise.all([
    storage.getReorderAnalysisData(lookbackDays),
    loadPurchasingRecommendationContext(),
  ]);
  const recommendationResult = generatePurchasingRecommendations({
    rows: rawData as PurchasingRecommendationRawRow[],
    lookbackDays,
    autoDraftSettings: settings,
    requireVendor: Boolean(settings.skipNoVendor),
    ...context,
  });
  return { settings, lookbackDays, rawData, recommendationResult };
}

export async function previewAutomaticPurchasingPilot(
  scope: AutomaticPurchasingPilotScope,
): Promise<AutomaticPurchasingPilotPreview> {
  const analysis = await loadAutoDraftAnalysis();
  return buildPilotPreview({
    sku: scope.sku,
    generatedAt: new Date(),
    lookbackDays: analysis.lookbackDays,
    itemsAnalyzed: analysis.rawData.length,
    settings: analysis.settings,
    items: analysis.recommendationResult.items,
  }).preview;
}

export async function reportAutomaticPurchasingReadiness(input: {
  limit?: number;
} = {}): Promise<AutomaticPurchasingReadinessReport> {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new RangeError("Automatic purchasing readiness limit must be between 1 and 100");
  }
  const analysis = await loadAutoDraftAnalysis();
  const candidates = analysis.recommendationResult.items
    .filter((item) =>
      passesAutoDraftApprovalPolicy(item, analysis.settings) ||
      item.actionable ||
      item.skippedReason === "no_vendor",
    )
    .map((item) => buildReadinessCandidate({
      item,
      approvalPolicyEligible: passesAutoDraftApprovalPolicy(item, analysis.settings),
      executionEnabled: shouldCreateDraftPos(analysis.settings),
    }))
    .sort((left, right) =>
      readinessStatusRank[left.readinessStatus] - readinessStatusRank[right.readinessStatus] ||
      left.blockers.length - right.blockers.length ||
      right.candidateScore - left.candidateScore ||
      left.sku.localeCompare(right.sku),
    );
  const blockerCounts = candidates.flatMap((candidate) => candidate.blockers)
    .reduce<Record<string, number>>((counts, blocker) => {
      counts[blocker.code] = (counts[blocker.code] ?? 0) + 1;
      return counts;
    }, {});
  const countStatus = (status: AutomaticPurchasingReadinessStatus) =>
    candidates.filter((candidate) => candidate.readinessStatus === status).length;

  return {
    mode: "readiness",
    generatedAt: new Date().toISOString(),
    limit,
    lookbackDays: analysis.lookbackDays,
    itemsAnalyzed: analysis.rawData.length,
    autoDraftMode: analysis.settings.autoDraftMode ?? "draft_po",
    approvalPolicy: analysis.settings.approvalPolicy ?? "high_confidence_only",
    recommendationSummary: analysis.recommendationResult.summary,
    summary: {
      candidateCount: candidates.length,
      returnedCandidateCount: Math.min(candidates.length, limit),
      eligibleCount: countStatus("eligible"),
      automationDisabledCount: countStatus("automation_disabled"),
      configurationRequiredCount: countStatus("configuration_required"),
      demandReviewRequiredCount: countStatus("demand_review_required"),
      configurationAndDemandReviewRequiredCount: countStatus("configuration_and_demand_review_required"),
      policyReviewRequiredCount: countStatus("policy_review_required"),
    },
    blockerCounts,
    candidates: candidates.slice(0, limit),
  };
}

async function executeAutoDraftJob(
  options: AutoDraftOptions,
  runRecord: AutoDraftRunRecord,
  lifecycle: AutoDraftRunLifecycleService,
): Promise<AutoDraftJobResult> {
  const handoffService = createRecommendationPoHandoffService(
    createDrizzleRecommendationPoHandoffRepository(db),
  );

  let itemsAnalyzed = 0;
  let posCreated = 0;
  let linesAdded = 0;
  let skippedNoVendor = 0;
  let skippedOnOrder = 0;
  let skippedExcluded = 0;
  let recommendationRunDetail: ReturnType<typeof buildPurchasingRecommendationRunDetail> | null = null;
  let purchaseRecommendationRun: AutoDraftJobResult["purchaseRecommendationRun"] | null = null;
  let pilotPreview: AutomaticPurchasingPilotPreview | undefined;

  try {
    const { settings, lookbackDays, rawData, recommendationResult } = await loadAutoDraftAnalysis();
    itemsAnalyzed = rawData.length;
    skippedExcluded = recommendationResult.summary.excludedCount;
    skippedNoVendor = recommendationResult.summary.skippedNoVendor;
    skippedOnOrder = recommendationResult.summary.skippedOnOrder;

    // Persist the complete calculation output before any PO mutation. The
    // source-scoped key makes retries of the same durable auto-draft run exact.
    const snapshot = await createPurchaseRecommendationSnapshotService(db).createRun(
      buildPurchaseRecommendationRunInput({
        recommendationResult,
        settings,
        lookbackDays,
        asOf: runRecord.runAt,
        source: "auto_draft",
        sourceRunKey: String(runRecord.id),
        evaluatedCount: rawData.length,
      }),
      options.triggeredByUser ?? "system:auto-draft",
    );
    purchaseRecommendationRun = {
      id: Number(snapshot.run.id),
      lineCount: snapshot.lines.length,
      observationCount: snapshot.observations.length,
      reused: snapshot.reused,
    };

    recommendationRunDetail = buildPurchasingRecommendationRunDetail(recommendationResult, {
      lookbackDays,
      settings,
      generatedAt: runRecord.runAt,
      poMutations: [],
      poMutationSkips: [],
    });

    const rfqPolicy = normalizeAutomaticRfqDraftPolicy(settings);
    await lifecycle.heartbeatRun({ runId: runRecord.id });
    const automaticRfqResult = options.pilot
      ? { rfqs: [], lines: [], skipped: [], reused: false }
      : await createAutomaticRfqDraftService(db).createDrafts({
          recommendationRunId: Number(snapshot.run.id),
          lines: snapshot.lines as any,
          policy: rfqPolicy,
          actorId: options.triggeredByUser ?? "system:auto-draft",
        });
    const automaticRfqDrafts = {
      ...summarizeAutomaticRfqDraftResult(rfqPolicy, automaticRfqResult),
      suppressedForPilot: Boolean(options.pilot),
    };
    recommendationRunDetail = {
      ...recommendationRunDetail,
      rfqDraftAutomation: automaticRfqDrafts,
    };

    let eligibleItems: AutomaticRecommendationPoHandoffItem[];
    if (options.pilot) {
      const pilot = buildPilotPreview({
        sku: options.pilot.sku,
        generatedAt: runRecord.runAt,
        lookbackDays,
        itemsAnalyzed,
        settings,
        items: recommendationResult.items,
      });
      pilotPreview = pilot.preview;
      if (!pilot.preview.eligible || !pilot.handoffItem) {
        throw new AutomaticPurchasingPilotError(pilot.preview);
      }
      eligibleItems = [pilot.handoffItem];
    } else {
      eligibleItems = recommendationResult.items
        .filter((item) => passesAutoDraftApprovalPolicy(item, settings))
        .map((item) => toAutomaticHandoffItem(item, lookbackDays, settings));
    }
    const createDraftPos = shouldCreateDraftPos(settings);
    await lifecycle.heartbeatRun({ runId: runRecord.id });
    const handoffResult = createDraftPos && eligibleItems.length > 0
      ? await handoffService.createAutomaticHandoff({
          actorId: options.triggeredByUser ?? "system:auto-draft",
          autoDraftRunId: runRecord.id,
          items: eligibleItems,
          completion: {
            itemsAnalyzed,
            skippedNoVendor,
            skippedOnOrder,
            skippedExcluded,
            summaryJson: recommendationRunDetail,
          },
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

    recommendationRunDetail = {
      ...recommendationRunDetail,
      poMutations,
      poMutationSkips: handoffResult.skipped,
    };

    if (!createDraftPos || eligibleItems.length === 0) {
      await lifecycle.completeRun({
        runId: runRecord.id,
        completion: {
          itemsAnalyzed,
          skippedNoVendor,
          skippedOnOrder,
          skippedExcluded,
          summaryJson: recommendationRunDetail,
        },
      });
    }

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
      purchaseRecommendationRun,
      automaticRfqDrafts,
      ...(pilotPreview ? {
        pilot: {
          ...pilotPreview,
          mode: "execute" as const,
          outcome: handoffResult.handedOff.length > 0
            ? "created" as const
            : "stale_snapshot_skipped" as const,
          mapping: handoffResult.handedOff[0] ?? null,
          skip: handoffResult.skipped[0] ?? null,
        },
      } : {}),
    };
  } catch (error: any) {
    console.error("[Auto-draft] Failed:", error);
    try {
      const failure = await lifecycle.failRun({
        runId: runRecord.id,
        errorMessage: error?.message || "Unknown error",
        progress: {
          itemsAnalyzed,
          skippedNoVendor,
          skippedOnOrder,
          skippedExcluded,
          summaryJson: recommendationRunDetail,
        },
      });
      if (!failure.transitioned) {
        console.error(
          `[Auto-draft] Run ${runRecord.id} failure did not replace terminal status ${failure.run?.status ?? "missing"}`,
        );
      }
    } catch (statusError) {
      console.error(`[Auto-draft] Failed to persist run ${runRecord.id} error status:`, statusError);
      throw new AggregateError(
        [error, statusError],
        `Auto-draft failed and its run status could not be persisted: ${error?.message || "Unknown error"}`,
      );
    }
    throw error;
  }
}

export async function startAutoDraftJob(options: AutoDraftOptions): Promise<StartedAutoDraftJob> {
  if (options.pilot) {
    normalizePilotSku(options.pilot.sku);
    if (options.triggeredBy !== "manual") {
      throw new RangeError("Automatic purchasing pilot execution must be triggered manually");
    }
    if (!options.triggeredByUser?.trim()) {
      throw new RangeError("Automatic purchasing pilot execution requires an operator actor ID");
    }
  }
  const lifecycle = createAutoDraftRunLifecycleService(
    createDrizzleAutoDraftRunLifecycleRepository(db),
  );
  const started = await lifecycle.startRun({
    triggeredBy: options.triggeredBy,
    triggeredByUser: options.triggeredByUser ?? null,
  });
  const completion = executeAutoDraftJob(options, started.run, lifecycle);
  void completion.catch(() => undefined);
  return {
    runId: started.run.id,
    interruptedRunIds: started.interruptedRunIds,
    completion,
  };
}

export async function runAutoDraftJob(options: AutoDraftOptions): Promise<AutoDraftJobResult> {
  const started = await startAutoDraftJob(options);
  return started.completion;
}
