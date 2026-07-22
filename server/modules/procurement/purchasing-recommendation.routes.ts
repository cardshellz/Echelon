import type { Express } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { centsToMills, computeLineTotalCentsFromMills } from "@shared/utils/money";
import { db } from "../../db";
import { requirePermission } from "../../routes/middleware";
import { procurementStorage } from "../procurement";
import { inventoryStorage } from "../inventory";
import {
  generatePurchasingRecommendations,
  passesAutoDraftApprovalPolicy,
  type AutoDraftRecommendationSettings,
  type PurchasingRecommendationItem,
  type PurchasingRecommendationQualityControl,
  type PurchasingRecommendationRawRow,
} from "./purchasing-recommendation.engine";
import {
  buildApprovalPolicyDiagnostics,
} from "./purchasing-recommendation.run-detail";
import {
  buildStaleAutoDraftPoDiagnostics,
  DEFAULT_STALE_AUTO_DRAFT_PO_THRESHOLDS,
  type AutoDraftPoAgingThresholds,
} from "./auto-draft-po-aging.service";
import { fetchAutoDraftPoAgingRows } from "./auto-draft-po-aging.repository";
import {
  buildForecastInputGapDiagnostics,
  forecastInputGapAction,
  type ForecastInputGapAction,
  type ForecastInputGapActionCode,
} from "./forecast-input-gap-diagnostics.service";
import { loadPurchasingRecommendationContext } from "./purchasing-recommendation-context.service";
import { resolveRecommendationPoQuantity } from "./recommendation-po-quantity";
import { buildSupplierSetupGaps } from "./supplier-setup-gaps.service";
import {
  purchaseRecommendationRuns as purchaseRecommendationRunsTable,
  purchaseRecommendationLines as purchaseRecommendationLinesTable,
  requestForQuotes as requestForQuotesTable,
  requestForQuoteLines as requestForQuoteLinesTable,
  vendors as vendorsTable,
} from "@shared/schema";
import { buildPurchaseRecommendationRunInput } from "./purchase-recommendation-snapshot.service";
import { buildPurchasingRfqQueue, purchasingSkuAllocationKey } from "./purchasing-rfq.service";
import {
  normalizePurchasingForecastPolicy,
  type PurchasingForecastPolicy,
} from "./purchasing-forecast-policy";
const storage = { ...procurementStorage, ...inventoryStorage };

function parseRunHistoryLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, 50);
}

function parseStalePoLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, 100);
}

function normalizeApprovalPolicy(value: unknown): AutoDraftRecommendationSettings["approvalPolicy"] {
  return value === "high_confidence_and_strong_candidate"
    ? "high_confidence_and_strong_candidate"
    : "high_confidence_only";
}

function parseCandidateScoreThreshold(value: unknown, fieldName: string): number | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    return { error: `${fieldName} must be an integer between 0 and 100` };
  }
  return value;
}

function parseStalePoThresholds(
  value: unknown,
  base?: Partial<AutoDraftPoAgingThresholds>,
): AutoDraftPoAgingThresholds | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "stalePoThresholds must be an object" };
  }

  const source = value as Record<string, unknown>;
  const next = { ...DEFAULT_STALE_AUTO_DRAFT_PO_THRESHOLDS, ...(base ?? {}) };
  for (const key of Object.keys(DEFAULT_STALE_AUTO_DRAFT_PO_THRESHOLDS) as Array<keyof AutoDraftPoAgingThresholds>) {
    const raw = source[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 365) {
      return { error: `stalePoThresholds.${key} must be an integer between 0 and 365` };
    }
    next[key] = raw;
  }

  const pairs: Array<[keyof AutoDraftPoAgingThresholds, keyof AutoDraftPoAgingThresholds]> = [
    ["reviewPendingWarningDays", "reviewPendingCriticalDays"],
    ["supplierSendWarningDays", "supplierSendCriticalDays"],
    ["supplierFollowupWarningDays", "supplierFollowupCriticalDays"],
    ["receivingWarningDays", "receivingCriticalDays"],
    ["apCloseoutWarningDays", "apCloseoutCriticalDays"],
    ["exceptionBlockedWarningDays", "exceptionBlockedCriticalDays"],
    ["closeoutWarningDays", "closeoutCriticalDays"],
  ];
  for (const [warningKey, criticalKey] of pairs) {
    if (next[warningKey] > next[criticalKey]) {
      return { error: `stalePoThresholds.${warningKey} must be less than or equal to ${criticalKey}` };
    }
  }

  return next;
}

function parseSummaryJson(value: unknown): any {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function takeRunSamples<T>(items: T[], limit = 5): T[] {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

function numberField(row: any, camel: string, snake: string): number {
  return Number(row?.[camel] ?? row?.[snake] ?? 0) || 0;
}

type AutoDraftRunRecommendedActionSeverity = "critical" | "warning" | "info";

function formatCountLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildAutoDraftRunRecommendedActions(run: any) {
  const actions: Array<{
    action: string;
    label: string;
    detail: string;
    href: string;
    severity: AutoDraftRunRecommendedActionSeverity;
    count: number;
  }> = [];

  if (run.status === "error" && run.errorMessage) {
    actions.push({
      action: "review_run_error",
      label: "Review run error",
      detail: run.errorMessage,
      href: "/purchasing",
      severity: "critical",
      count: 1,
    });
  }

  if (run.skippedNoVendor > 0) {
    actions.push({
      action: "assign_vendors",
      label: "Assign vendors",
      detail: `${formatCountLabel(run.skippedNoVendor, "recommendation")} skipped because no preferred vendor was available.`,
      href: "/suppliers",
      severity: "critical",
      count: run.skippedNoVendor,
    });
  }

  if (run.approvalPolicyBlockedCount > 0) {
    actions.push({
      action: "review_policy_holds",
      label: "Review policy holds",
      detail: `${formatCountLabel(run.approvalPolicyBlockedCount, "quality-approved recommendation")} held by the active approval policy.`,
      href: "/reorder-analysis?candidateBand=review_candidate&reviewQueue=held_by_policy",
      severity: "warning",
      count: run.approvalPolicyBlockedCount,
    });
  }

  const qualityReviewCount = Math.max(
    Number(run.autoDraftReviewRequiredCount ?? 0) || 0,
    Number(run.forecastDiagnostics?.autopilotBlockerItemCount ?? 0) || 0,
  );
  if (qualityReviewCount > 0) {
    actions.push({
      action: "review_quality_queue",
      label: "Review quality queue",
      detail: `${formatCountLabel(qualityReviewCount, "recommendation")} ${qualityReviewCount === 1 ? "needs" : "need"} demand, lead-time, supplier-cost, or vendor review before autopilot can use them.`,
      href: "/reorder-analysis?reviewQueue=quality_review_required",
      severity: "warning",
      count: qualityReviewCount,
    });
  }

  if (run.skippedOnOrder > 0) {
    actions.push({
      action: "review_open_pos",
      label: "Review open POs",
      detail: `${formatCountLabel(run.skippedOnOrder, "recommendation")} skipped because stock was already on order.`,
      href: "/purchase-orders",
      severity: "info",
      count: run.skippedOnOrder,
    });
  }

  if (run.skippedExcluded > 0) {
    actions.push({
      action: "review_exclusions",
      label: "Review exclusions",
      detail: `${formatCountLabel(run.skippedExcluded, "recommendation")} skipped by purchasing exclusion rules.`,
      href: "/purchasing",
      severity: "info",
      count: run.skippedExcluded,
    });
  }

  if ((run.posCreated + run.posUpdated > 0 || run.linesAdded > 0) && run.status !== "error") {
    actions.push({
      action: "review_draft_pos",
      label: "Review draft POs",
      detail: `${run.posCreated + run.posUpdated} purchase orders changed with ${run.linesAdded} line items.`,
      href: "/purchase-orders",
      severity: "info",
      count: run.posCreated + run.posUpdated,
    });
  }

  const severityPriority: Record<AutoDraftRunRecommendedActionSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  return actions.sort((a, b) => {
    const severityDelta = severityPriority[a.severity] - severityPriority[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return b.count - a.count;
  });
}

function normalizeAutoDraftRun(row: any) {
  const summaryJson = parseSummaryJson(row?.summaryJson ?? row?.summary_json);
  const actionableRecommendations = Array.isArray(summaryJson?.actionableRecommendations)
    ? summaryJson.actionableRecommendations
    : [];
  const approvalPolicyBlockedRecommendations = Array.isArray(summaryJson?.approvalPolicyBlockedRecommendations)
    ? summaryJson.approvalPolicyBlockedRecommendations
    : [];
  const skippedRecommendations = Array.isArray(summaryJson?.skippedRecommendations)
    ? summaryJson.skippedRecommendations
    : [];
  const poMutations = Array.isArray(summaryJson?.poMutations)
    ? summaryJson.poMutations
    : [];
  const approvalPolicyDiagnostics = summaryJson?.approvalPolicyDiagnostics ?? null;

  const normalized = {
    id: Number(row?.id),
    runAt: row?.runAt ?? row?.run_at,
    triggeredBy: row?.triggeredBy ?? row?.triggered_by ?? null,
    triggeredByUser: row?.triggeredByUser ?? row?.triggered_by_user ?? null,
    status: row?.status,
    heartbeatAt: row?.heartbeatAt ?? row?.heartbeat_at ?? null,
    leaseExpiresAt: row?.leaseExpiresAt ?? row?.lease_expires_at ?? null,
    itemsAnalyzed: numberField(row, "itemsAnalyzed", "items_analyzed"),
    posCreated: numberField(row, "posCreated", "pos_created"),
    posUpdated: numberField(row, "posUpdated", "pos_updated"),
    linesAdded: numberField(row, "linesAdded", "lines_added"),
    skippedNoVendor: numberField(row, "skippedNoVendor", "skipped_no_vendor"),
    skippedOnOrder: numberField(row, "skippedOnOrder", "skipped_on_order"),
    skippedExcluded: numberField(row, "skippedExcluded", "skipped_excluded"),
    errorMessage: row?.errorMessage ?? row?.error_message ?? null,
    finishedAt: row?.finishedAt ?? row?.finished_at ?? null,
    mode: summaryJson?.settings?.autoDraftMode === "review_only" ? "review_only" : "draft_po",
    approvalPolicy: normalizeApprovalPolicy(summaryJson?.settings?.approvalPolicy),
    actionableCount: Number(summaryJson?.recommendationSummary?.actionableCount ?? numberField(row, "linesAdded", "lines_added")) || 0,
    autoDraftEligibleCount:
      Number(summaryJson?.recommendationSummary?.autoDraftEligibleCount ?? numberField(row, "linesAdded", "lines_added")) || 0,
    autoDraftReviewRequiredCount:
      Number(summaryJson?.recommendationSummary?.autoDraftReviewRequiredCount ?? 0) || 0,
    approvalPolicyEligibleCount:
      Number(approvalPolicyDiagnostics?.approvalPolicyEligibleCount ?? summaryJson?.recommendationSummary?.autoDraftEligibleCount ?? numberField(row, "linesAdded", "lines_added")) || 0,
    approvalPolicyBlockedCount:
      Number(approvalPolicyDiagnostics?.approvalPolicyBlockedCount ?? 0) || 0,
    draftMutationEligibleCount:
      Number(approvalPolicyDiagnostics?.draftMutationEligibleCount ?? numberField(row, "linesAdded", "lines_added")) || 0,
    approvalPolicyDiagnostics,
    forecastDiagnostics: summaryJson?.forecastDiagnostics ?? null,
    poMutationCount: poMutations.length,
    recommendationSamples: {
      actionable: takeRunSamples(actionableRecommendations),
      approvalPolicyBlocked: takeRunSamples(approvalPolicyBlockedRecommendations),
      skipped: takeRunSamples(skippedRecommendations),
    },
    recommendationSampleCounts: {
      actionable: actionableRecommendations.length,
      approvalPolicyBlocked: approvalPolicyBlockedRecommendations.length,
      skipped: skippedRecommendations.length,
    },
    topActionableRecommendation: actionableRecommendations[0] ?? null,
    topApprovalPolicyBlockedRecommendation: approvalPolicyBlockedRecommendations[0] ?? null,
    topSkippedRecommendation: skippedRecommendations[0] ?? null,
  };

  return {
    ...normalized,
    recommendedActions: buildAutoDraftRunRecommendedActions(normalized),
  };
}

function buildApprovalPolicyImpact(result: ReturnType<typeof generatePurchasingRecommendations>, settings: AutoDraftRecommendationSettings) {
  const diagnostics = buildApprovalPolicyDiagnostics(result, settings);
  const heldRecommendations = result.items
    .filter((item) => item.qualityGate.autoDraftEligible && !passesAutoDraftApprovalPolicy(item, settings))
    .slice(0, 10)
    .map((item) => ({
      recommendationId: item.recommendationId,
      productId: item.productId,
      productVariantId: item.productVariantId ?? null,
      sku: item.sku,
      productName: item.productName,
      suggestedOrderQty: item.suggestedOrderQty,
      suggestedOrderPieces: item.suggestedOrderPieces,
      orderUomUnits: item.orderUomUnits,
      orderUomLabel: item.orderUomLabel,
      preferredVendorName: item.preferredVendorName,
      recommendationCandidateScore: item.recommendationCandidateScore,
      qualityGate: item.qualityGate,
      explanation: item.explanation,
    }));

  return {
    ...diagnostics,
    heldRecommendations,
  };
}

type RecommendationReviewQueueKind = "skipped" | "held_by_policy" | "quality_review_required";
type RecommendationReviewQueueSeverity = "critical" | "warning" | "info";
type RecommendationDecision = "reviewed" | "accepted_for_po" | "deferred" | "dismissed" | "po_handoff_created";

const forecastInputGapActionCodes: ForecastInputGapActionCode[] = [
  "repair_order_velocity_source",
  "rebuild_forecast_windows",
  "verify_recent_demand",
  "monitor_thin_sample",
];

const recommendationDecisionValues: RecommendationDecision[] = [
  "reviewed",
  "accepted_for_po",
  "deferred",
  "dismissed",
];

const RECOMMENDATION_DECISION_NOTE_MIN_LENGTH = 10;
const RECOMMENDATION_DECISION_NOTE_MAX_LENGTH = 2000;
const REVIEW_EVIDENCE_CONTRACT_VERSION = 1;

const reviewQueueKindPriority: Record<RecommendationReviewQueueKind, number> = {
  skipped: 0,
  held_by_policy: 1,
  quality_review_required: 2,
};

const reviewQueueSeverityPriority: Record<RecommendationReviewQueueSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function parseReviewQueueKind(value: unknown): RecommendationReviewQueueKind | null {
  return value === "skipped" || value === "held_by_policy" || value === "quality_review_required"
    ? value
    : null;
}

function parseForecastInputGapActionCode(value: unknown): ForecastInputGapActionCode | null {
  return forecastInputGapActionCodes.includes(value as ForecastInputGapActionCode)
    ? value as ForecastInputGapActionCode
    : null;
}

function parseRecommendationDecision(value: unknown): RecommendationDecision | null {
  return recommendationDecisionValues.includes(value as RecommendationDecision) ? value as RecommendationDecision : null;
}

function parsePurchasingForecastPolicy(
  value: unknown,
  base: PurchasingForecastPolicy,
): PurchasingForecastPolicy | undefined | { error: string } {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "forecastPolicy must be an object" };
  }
  const source = value as Record<string, any>;
  const merged = normalizePurchasingForecastPolicy({
    ...base,
    ...source,
    weights: { ...base.weights, ...(source.weights ?? {}) },
    forwardDemandConfidenceWeights: {
      ...base.forwardDemandConfidenceWeights,
      ...(source.forwardDemandConfidenceWeights ?? {}),
    },
  });
  const integerRanges: Array<[string, unknown, number, number]> = [
    ["shortWindowDays", source.shortWindowDays, 1, 60],
    ["standardWindowDays", source.standardWindowDays, 7, 180],
    ["longWindowDays", source.longWindowDays, 30, 730],
    ["seasonalWindowDays", source.seasonalWindowDays, 7, 120],
    ["forwardDemandHorizonDays", source.forwardDemandHorizonDays, 1, 365],
    ["automationMinimumOrderCount", source.automationMinimumOrderCount, 1, 100],
    ["automationMinimumActiveDays", source.automationMinimumActiveDays, 1, 100],
  ];
  for (const [field, raw, min, max] of integerRanges) {
    const numeric = Number(raw);
    if (raw !== undefined && (!Number.isInteger(numeric) || numeric < min || numeric > max)) {
      return { error: `forecastPolicy.${field} must be an integer between ${min} and ${max}` };
    }
  }
  for (const [group, values] of [
    ["weights", source.weights],
    ["forwardDemandConfidenceWeights", source.forwardDemandConfidenceWeights],
  ] as const) {
    if (values !== undefined && (!values || typeof values !== "object" || Array.isArray(values))) {
      return { error: `forecastPolicy.${group} must be an object` };
    }
    for (const [key, raw] of Object.entries(values ?? {})) {
      const numeric = Number(raw);
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 100) {
        return { error: `forecastPolicy.${group}.${key} must be an integer between 0 and 100` };
      }
    }
  }
  if (source.method !== undefined && !["recent_order_velocity_v1", "weighted_blend_v1"].includes(source.method)) {
    return { error: "forecastPolicy.method must be recent_order_velocity_v1 or weighted_blend_v1" };
  }
  for (const field of ["seasonalEnabled", "forwardDemandEnabled"] as const) {
    if (source[field] !== undefined && typeof source[field] !== "boolean") {
      return { error: `forecastPolicy.${field} must be boolean` };
    }
  }
  if (!(merged.shortWindowDays <= merged.standardWindowDays && merged.standardWindowDays <= merged.longWindowDays)) {
    return { error: "Forecast windows must satisfy shortWindowDays <= standardWindowDays <= longWindowDays" };
  }
  const weightTotal = Object.values(merged.weights).reduce((sum, weight) => sum + weight, 0);
  if (weightTotal !== 100) return { error: "Forecast weights must total 100" };
  const confidence = merged.forwardDemandConfidenceWeights;
  if (!(confidence.high >= confidence.medium && confidence.medium >= confidence.low)) {
    return { error: "Future-demand confidence weights must satisfy high >= medium >= low" };
  }
  if (merged.automationMinimumActiveDays > merged.standardWindowDays) {
    return { error: "automationMinimumActiveDays cannot exceed standardWindowDays" };
  }
  return merged;
}

function parseReviewedControlCodes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const codes = value.map((code) => typeof code === "string" ? code.trim() : "");
  if (codes.some((code) => !code || code.length > 100)) return null;
  const uniqueCodes = Array.from(new Set(codes));
  return uniqueCodes.length === codes.length ? uniqueCodes : null;
}

function validateRecommendationDecisionEvidence(input: {
  decision: RecommendationDecision;
  note: string;
  confirmDecision: unknown;
  acknowledgeAutomationEligibilityUnchanged: unknown;
  reviewedControlCodes: string[];
  currentControls: PurchasingRecommendationQualityControl[];
}): string | null {
  if (input.note.length < RECOMMENDATION_DECISION_NOTE_MIN_LENGTH) {
    return `note must contain at least ${RECOMMENDATION_DECISION_NOTE_MIN_LENGTH} characters`;
  }
  if (input.confirmDecision !== true) {
    return "confirmDecision must be true";
  }

  const currentCodes = Array.from(new Set(input.currentControls.map((control) => control.code)));
  const currentCodeSet = new Set(currentCodes);
  const unknownCodes = input.reviewedControlCodes.filter((code) => !currentCodeSet.has(code));
  if (unknownCodes.length > 0) {
    return `reviewedControlCodes contains controls that are not current: ${unknownCodes.join(", ")}`;
  }

  if (input.decision === "reviewed" || input.decision === "accepted_for_po") {
    if (input.acknowledgeAutomationEligibilityUnchanged !== true) {
      return "acknowledgeAutomationEligibilityUnchanged must be true";
    }
    const reviewedCodeSet = new Set(input.reviewedControlCodes);
    const missingCodes = currentCodes.filter((code) => !reviewedCodeSet.has(code));
    if (missingCodes.length > 0) {
      return `reviewedControlCodes must acknowledge every current control: ${missingCodes.join(", ")}`;
    }
  }

  return null;
}

function recommendationDecisionKey(recommendationId: string, kind: string): string {
  return JSON.stringify([recommendationId, kind]);
}

function normalizeRecommendationDecision(row: any) {
  if (!row) return null;
  return {
    id: Number(row.id),
    recommendationId: row.recommendationId ?? row.recommendation_id,
    kind: row.kind,
    decision: row.decision,
    status: row.status,
    decisionReason: row.decisionReason ?? row.decision_reason ?? null,
    note: row.note ?? null,
    source: row.source,
    autoDraftRunId: row.autoDraftRunId ?? row.auto_draft_run_id ?? null,
    productId: row.productId ?? row.product_id ?? null,
    productVariantId: row.productVariantId ?? row.product_variant_id ?? null,
    vendorId: row.vendorId ?? row.vendor_id ?? null,
    sku: row.sku ?? null,
    productName: row.productName ?? row.product_name ?? null,
    candidateScore: row.candidateScore ?? row.candidate_score ?? null,
    candidateBand: row.candidateBand ?? row.candidate_band ?? null,
    recommendationSnapshot: row.recommendationSnapshot ?? row.recommendation_snapshot ?? {},
    decidedBy: row.decidedBy ?? row.decided_by ?? null,
    decidedAt: row.decidedAt ?? row.decided_at ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
  };
}

function reviewQueueSeverity(item: PurchasingRecommendationItem, kind: RecommendationReviewQueueKind): RecommendationReviewQueueSeverity {
  if (kind === "skipped") return item.reviewSignal?.severity ?? "warning";
  if (kind === "held_by_policy") return "warning";
  return item.autopilotBlockers?.some((control) => control.severity === "block") ? "critical" : "warning";
}

function buildRecommendationReviewHref(
  item: PurchasingRecommendationItem,
  kind: RecommendationReviewQueueKind,
  params: Record<string, string> = {},
): string {
  const query = new URLSearchParams({
    reviewQueue: kind,
    recommendationId: item.recommendationId,
    ...params,
  });
  return `/reorder-analysis?${query.toString()}`;
}

function reviewQueueAction(item: PurchasingRecommendationItem, kind: RecommendationReviewQueueKind) {
  if (kind === "held_by_policy") {
    const band = item.recommendationCandidateScore?.band ?? "review_candidate";
    return {
      action: "review_approval_policy",
      label: "Review policy hold",
      href: buildRecommendationReviewHref(item, kind, { candidateBand: band }),
    };
  }

  if (kind === "quality_review_required") {
    const band = item.recommendationCandidateScore?.band ?? "review_candidate";
    return {
      action: "review_quality_gate",
      label: "Review signal",
      href: buildRecommendationReviewHref(item, kind, {
        candidateBand: band,
        reason: item.qualityGate.reason,
      }),
    };
  }

  switch (item.reviewSignal?.action) {
    case "assign_vendor":
      return {
        action: "prepare_rfq",
        label: "Add to RFQ selection",
        href: buildRecommendationReviewHref(item, kind),
      };
    case "review_open_po":
      return { action: "review_open_po", label: "Review open PO", href: "/purchase-orders" };
    case "review_exclusion":
      return { action: "review_exclusion", label: "Review exclusion", href: "/purchasing" };
    case "create_po":
      return { action: "create_po", label: "Create PO", href: "/purchase-orders" };
    default:
      return {
        action: "review_recommendation",
        label: "Review",
        href: buildRecommendationReviewHref(item, kind),
      };
  }
}

function reviewQueueReason(item: PurchasingRecommendationItem, kind: RecommendationReviewQueueKind): { code: string; label: string; detail: string } {
  if (kind === "held_by_policy") {
    return {
      code: "held_by_approval_policy",
      label: "Held by approval policy",
      detail: "This recommendation passed the quality gate but the active approval policy would keep it out of draft PO mutation.",
    };
  }

  if (kind === "quality_review_required") {
    return {
      code: item.qualityGate.reason,
      label: item.qualityGate.label,
      detail: item.qualityGate.detail,
    };
  }

  return {
    code: item.skippedReason ?? "skipped",
    label: item.reviewSignal?.label ?? "Skipped recommendation",
    detail: item.reviewSignal?.detail ?? item.explanation,
  };
}

function reviewQueueForecastAction(
  item: PurchasingRecommendationItem,
): ForecastInputGapAction | null {
  const trust = item.forecastProvenance.forecastTrust;
  if (trust.severity === "ok" && trust.inputGaps.length === 0 && item.qualityGate.reason !== "forecast_trust_review") {
    return null;
  }
  return forecastInputGapAction(item, { exact: true });
}

function buildRecommendationReviewQueue(result: ReturnType<typeof generatePurchasingRecommendations>, settings: AutoDraftRecommendationSettings) {
  const entries: Array<{
    recommendationId: string;
    kind: RecommendationReviewQueueKind;
    severity: RecommendationReviewQueueSeverity;
    reason: { code: string; label: string; detail: string };
    action: { action: string; label: string; href: string };
    forecastAction: ForecastInputGapAction | null;
    productId: number;
    productVariantId: number | null;
    sku: string;
    productName: string;
    status: string;
    actionable: boolean;
    skippedReason: string | null;
    preferredVendorId: number | null;
    preferredVendorName: string | null;
    vendorProductId: number | null;
    suggestedOrderQty: number;
    suggestedOrderPieces: number;
    orderUomUnits: number;
    orderUomLabel: string;
    estimatedCostMills: number | null;
    estimatedCostCents: number | null;
    pricingBasis: PurchasingRecommendationItem["supplierBasis"]["pricingBasis"];
    purchaseUom: string | null;
    quotedUnitCostMills: number | null;
    piecesPerPurchaseUom: number | null;
    quoteReference: string | null;
    quotedAt: string | Date | null;
    quoteValidUntil: string | null;
    supplierBasis: PurchasingRecommendationItem["supplierBasis"];
    demandEvidence: PurchasingRecommendationItem["demandBasis"] & {
      demandWindowDiagnostics: PurchasingRecommendationItem["forecastProvenance"]["demandWindowDiagnostics"];
    };
    candidateScore: PurchasingRecommendationItem["recommendationCandidateScore"];
    qualityGate: PurchasingRecommendationItem["qualityGate"];
    qualityControls: PurchasingRecommendationQualityControl[];
  }> = [];

  const pushEntry = (item: PurchasingRecommendationItem, kind: RecommendationReviewQueueKind) => {
    const severity = reviewQueueSeverity(item, kind);
    entries.push({
      recommendationId: item.recommendationId,
      kind,
      severity,
      reason: reviewQueueReason(item, kind),
      action: reviewQueueAction(item, kind),
      forecastAction: reviewQueueForecastAction(item),
      productId: item.productId,
      productVariantId: item.productVariantId ?? null,
      sku: item.sku,
      productName: item.productName,
      status: item.status,
      actionable: item.actionable,
      skippedReason: item.skippedReason,
      preferredVendorId: item.preferredVendorId,
      preferredVendorName: item.preferredVendorName,
      vendorProductId: item.supplierBasis.vendorProductId,
      suggestedOrderQty: item.suggestedOrderQty,
      suggestedOrderPieces: item.suggestedOrderPieces,
      orderUomUnits: item.orderUomUnits,
      orderUomLabel: item.orderUomLabel,
      estimatedCostMills: item.estimatedCostMills,
      estimatedCostCents: item.estimatedCostCents,
      pricingBasis: item.supplierBasis.pricingBasis,
      purchaseUom: item.supplierBasis.purchaseUom,
      quotedUnitCostMills: item.supplierBasis.quotedUnitCostMills,
      piecesPerPurchaseUom: item.supplierBasis.piecesPerPurchaseUom,
      quoteReference: item.supplierBasis.quoteReference,
      quotedAt: item.supplierBasis.quotedAt,
      quoteValidUntil: item.supplierBasis.quoteValidUntil,
      supplierBasis: item.supplierBasis,
      demandEvidence: {
        ...item.demandBasis,
        demandWindowDiagnostics: item.forecastProvenance.demandWindowDiagnostics,
      },
      candidateScore: item.recommendationCandidateScore,
      qualityGate: item.qualityGate,
      qualityControls: item.autopilotBlockers?.length ? item.autopilotBlockers : item.qualityControls ?? [],
    });
  };

  const skippedById = new Set<string>();
  for (const item of result.skippedItems) {
    if (!item.skippedReason) continue;
    skippedById.add(item.recommendationId);
    pushEntry(item, "skipped");
  }

  for (const item of result.items) {
    if (skippedById.has(item.recommendationId)) continue;
    if (item.qualityGate.autoDraftEligible && !passesAutoDraftApprovalPolicy(item, settings)) {
      pushEntry(item, "held_by_policy");
    } else if (item.actionable && !item.qualityGate.autoDraftEligible) {
      pushEntry(item, "quality_review_required");
    }
  }

  const summary = {
    total: entries.length,
    skipped: entries.filter((entry) => entry.kind === "skipped").length,
    heldByPolicy: entries.filter((entry) => entry.kind === "held_by_policy").length,
    qualityReviewRequired: entries.filter((entry) => entry.kind === "quality_review_required").length,
    critical: entries.filter((entry) => entry.severity === "critical").length,
    warning: entries.filter((entry) => entry.severity === "warning").length,
    info: entries.filter((entry) => entry.severity === "info").length,
  };

  const reasonCounts: Record<string, number> = {};
  const actionCounts: Record<string, number> = {};
  const forecastActionCounts: Record<string, number> = {};
  const candidateBandCounts: Record<string, number> = {};
  for (const entry of entries) {
    reasonCounts[entry.reason.code] = (reasonCounts[entry.reason.code] ?? 0) + 1;
    actionCounts[entry.action.action] = (actionCounts[entry.action.action] ?? 0) + 1;
    if (entry.forecastAction) {
      forecastActionCounts[entry.forecastAction.code] = (forecastActionCounts[entry.forecastAction.code] ?? 0) + 1;
    }
    const band = entry.candidateScore?.band ?? "unscored";
    candidateBandCounts[band] = (candidateBandCounts[band] ?? 0) + 1;
  }

  return {
    summary,
    reasonCounts,
    actionCounts,
    forecastActionCounts,
    candidateBandCounts,
    items: entries.sort((a, b) => {
      const severityDelta = reviewQueueSeverityPriority[a.severity] - reviewQueueSeverityPriority[b.severity];
      if (severityDelta !== 0) return severityDelta;
      const kindDelta = reviewQueueKindPriority[a.kind] - reviewQueueKindPriority[b.kind];
      if (kindDelta !== 0) return kindDelta;
      return (b.candidateScore?.score ?? 0) - (a.candidateScore?.score ?? 0);
    }),
  };
}

async function loadRecommendationReviewQueueData() {
  const configuredLookback = await storage.getVelocityLookbackDays();
  const rawRows = await storage.getReorderAnalysisData(configuredLookback);
  const settings = (await storage.getAutoDraftSettings()) as AutoDraftRecommendationSettings;
  const context = await loadPurchasingRecommendationContext();
  const recommendationResult = generatePurchasingRecommendations({
    rows: rawRows as PurchasingRecommendationRawRow[],
    lookbackDays: configuredLookback,
    autoDraftSettings: settings,
    requireVendor: Boolean(settings.skipNoVendor),
    ...context,
  });

  return {
    configuredLookback,
    evaluatedCount: rawRows.length,
    settings,
    recommendationResult,
    queue: buildRecommendationReviewQueue(recommendationResult, settings),
  };
}

function buildLatestDecisionMap(decisions: any[]) {
  const latest = new Map<string, ReturnType<typeof normalizeRecommendationDecision>>();
  for (const row of decisions) {
    const decision = normalizeRecommendationDecision(row);
    if (!decision || decision.status !== "active") continue;
    const key = recommendationDecisionKey(decision.recommendationId, decision.kind);
    if (!latest.has(key)) latest.set(key, decision);
  }
  return latest;
}

function buildRecommendationDecisionHistorySummary(decisions: Array<ReturnType<typeof normalizeRecommendationDecision>>) {
  const decisionCounts: Record<string, number> = {};
  const kindCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  let latestDecidedAt: string | Date | null = null;

  for (const decision of decisions) {
    if (!decision) continue;
    decisionCounts[decision.decision] = (decisionCounts[decision.decision] ?? 0) + 1;
    kindCounts[decision.kind] = (kindCounts[decision.kind] ?? 0) + 1;
    statusCounts[decision.status] = (statusCounts[decision.status] ?? 0) + 1;
    if (decision.decidedAt) {
      const current = new Date(decision.decidedAt).getTime();
      const latest = latestDecidedAt ? new Date(latestDecidedAt).getTime() : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(current) && current > latest) latestDecidedAt = decision.decidedAt;
    }
  }

  return {
    total: decisions.filter(Boolean).length,
    active: decisions.filter((decision) => decision?.status === "active").length,
    acceptedForPo: decisionCounts.accepted_for_po ?? 0,
    poHandoffCreated: decisionCounts.po_handoff_created ?? 0,
    deferred: decisionCounts.deferred ?? 0,
    dismissed: decisionCounts.dismissed ?? 0,
    reviewed: decisionCounts.reviewed ?? 0,
    latestDecidedAt,
    decisionCounts,
    kindCounts,
    statusCounts,
  };
}

function buildAcceptedRecommendationReviewQueue(decisionRows: any[], queue: ReturnType<typeof buildRecommendationReviewQueue>, limit: number) {
  const latestDecisions = Array.from(buildLatestDecisionMap(decisionRows).values())
    .filter((decision) => decision?.decision === "accepted_for_po");
  const currentByKey = new Map(
    queue.items.map((item) => [recommendationDecisionKey(item.recommendationId, item.kind), item]),
  );

  const items = latestDecisions
    .map((decision) => {
      if (!decision) return null;
      const key = recommendationDecisionKey(decision.recommendationId, decision.kind);
      const currentItem = currentByKey.get(key);
      const snapshot = decision.recommendationSnapshot && typeof decision.recommendationSnapshot === "object"
        ? decision.recommendationSnapshot as Record<string, any>
        : {};
      const snapshotItem = snapshot.item && typeof snapshot.item === "object" ? snapshot.item : {};
      const sourceItem = currentItem ?? snapshotItem;
      const candidateScore = currentItem?.candidateScore ?? snapshotItem.candidateScore ?? null;
      const actionHref =
        currentItem?.action?.href ??
        (candidateScore?.band ? `/reorder-analysis?candidateBand=${candidateScore.band}&reviewQueue=${decision.kind}` : "/reorder-analysis");

      return {
        recommendationId: decision.recommendationId,
        kind: decision.kind,
        decision,
        acceptedItem: snapshotItem,
        source: currentItem ? "current_recommendation" : "decision_snapshot",
        current: Boolean(currentItem),
        sku: sourceItem.sku ?? decision.sku,
        productName: sourceItem.productName ?? decision.productName,
        productId: sourceItem.productId ?? decision.productId,
        productVariantId: sourceItem.productVariantId ?? decision.productVariantId,
        preferredVendorId: sourceItem.preferredVendorId ?? decision.vendorId,
        preferredVendorName: sourceItem.preferredVendorName ?? null,
        vendorProductId: sourceItem.vendorProductId ?? sourceItem.supplierBasis?.vendorProductId ?? null,
        suggestedOrderQty: Number(sourceItem.suggestedOrderQty ?? 0) || 0,
        suggestedOrderPieces: Number(sourceItem.suggestedOrderPieces ?? 0) || 0,
        orderUomUnits: Number(sourceItem.orderUomUnits ?? 0) || 0,
        orderUomLabel: sourceItem.orderUomLabel ?? "units",
        estimatedCostMills: sourceItem.estimatedCostMills ?? sourceItem.supplierBasis?.estimatedCostMills ?? null,
        estimatedCostCents: sourceItem.estimatedCostCents ?? sourceItem.supplierBasis?.estimatedCostCents ?? null,
        pricingBasis: sourceItem.pricingBasis ?? sourceItem.supplierBasis?.pricingBasis ?? "legacy_unknown",
        purchaseUom: sourceItem.purchaseUom ?? sourceItem.supplierBasis?.purchaseUom ?? null,
        quotedUnitCostMills: sourceItem.quotedUnitCostMills ?? sourceItem.supplierBasis?.quotedUnitCostMills ?? null,
        piecesPerPurchaseUom: sourceItem.piecesPerPurchaseUom ?? sourceItem.supplierBasis?.piecesPerPurchaseUom ?? null,
        quoteReference: sourceItem.quoteReference ?? sourceItem.supplierBasis?.quoteReference ?? null,
        quotedAt: sourceItem.quotedAt ?? sourceItem.supplierBasis?.quotedAt ?? null,
        quoteValidUntil: sourceItem.quoteValidUntil ?? sourceItem.supplierBasis?.quoteValidUntil ?? null,
        supplierBasis: sourceItem.supplierBasis ?? null,
        candidateScore,
        qualityGate: currentItem?.qualityGate ?? snapshotItem.qualityGate ?? null,
        reason: currentItem?.reason ?? snapshotItem.reason ?? null,
        statusReason: currentItem
          ? "Still present in the current recommendation review queue."
          : "No longer present in the current recommendation review queue; review the accepted snapshot before creating a PO.",
        action: {
          action: currentItem ? "review_current_recommendation" : "review_accepted_snapshot",
          label: currentItem ? "Review current" : "Review snapshot",
          href: actionHref,
        },
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => {
      const currentDelta = Number(b.current) - Number(a.current);
      if (currentDelta !== 0) return currentDelta;
      return new Date(b.decision?.decidedAt ?? 0).getTime() - new Date(a.decision?.decidedAt ?? 0).getTime();
    })
    .slice(0, limit);

  const vendorIds = new Set(items.map((item: any) => item.preferredVendorId).filter(Boolean));
  return {
    summary: {
      total: items.length,
      current: items.filter((item: any) => item.current).length,
      stale: items.filter((item: any) => !item.current).length,
      vendorCount: vendorIds.size,
    },
    items,
  };
}

function recommendationEconomicBasis(item: any) {
  const rawQuotedAt = item?.quotedAt ?? item?.supplierBasis?.quotedAt ?? null;
  const parsedQuotedAt = rawQuotedAt ? new Date(rawQuotedAt) : null;
  const rawMinimumOrderPieces = item?.minimumOrderPieces ??
    item?.supplierBasis?.minimumOrderPieces ??
    null;
  return {
    productId: Number(item?.productId),
    productVariantId: Number(item?.productVariantId),
    preferredVendorId: Number(item?.preferredVendorId),
    vendorProductId: Number(item?.vendorProductId ?? item?.supplierBasis?.vendorProductId),
    suggestedOrderQty: Number(item?.suggestedOrderQty),
    suggestedOrderPieces: Number(item?.suggestedOrderPieces),
    orderUomUnits: Number(item?.orderUomUnits),
    estimatedCostMills: item?.estimatedCostMills ?? item?.supplierBasis?.estimatedCostMills ?? null,
    estimatedCostCents: item?.estimatedCostCents ?? item?.supplierBasis?.estimatedCostCents ?? null,
    pricingBasis: item?.pricingBasis ?? item?.supplierBasis?.pricingBasis ?? "legacy_unknown",
    purchaseUom: item?.purchaseUom ?? item?.supplierBasis?.purchaseUom ?? null,
    quotedUnitCostMills: item?.quotedUnitCostMills ?? item?.supplierBasis?.quotedUnitCostMills ?? null,
    piecesPerPurchaseUom: item?.piecesPerPurchaseUom ?? item?.supplierBasis?.piecesPerPurchaseUom ?? null,
    minimumOrderPieces: rawMinimumOrderPieces === null ? null : Number(rawMinimumOrderPieces),
    quoteReference: item?.quoteReference ?? item?.supplierBasis?.quoteReference ?? null,
    quotedAt: parsedQuotedAt && !Number.isNaN(parsedQuotedAt.getTime()) ? parsedQuotedAt.toISOString() : null,
    quoteValidUntil: item?.quoteValidUntil ?? item?.supplierBasis?.quoteValidUntil ?? null,
  };
}

function hasCompleteExplicitRecommendationQuote(item: any): boolean {
  const basis = recommendationEconomicBasis(item);
  if (!basis.quotedAt) return false;
  if (basis.pricingBasis === "per_piece") {
    return Number.isSafeInteger(Number(basis.quotedUnitCostMills)) &&
      Number(basis.quotedUnitCostMills) >= 0 &&
      basis.purchaseUom === null &&
      basis.piecesPerPurchaseUom === null;
  }
  return basis.pricingBasis === "per_purchase_uom" &&
    typeof basis.purchaseUom === "string" &&
    basis.purchaseUom.trim().length > 0 &&
    Number.isSafeInteger(Number(basis.quotedUnitCostMills)) &&
    Number(basis.quotedUnitCostMills) >= 0 &&
    Number.isSafeInteger(Number(basis.piecesPerPurchaseUom)) &&
    Number(basis.piecesPerPurchaseUom) > 0 &&
    Number.isSafeInteger(Number(basis.suggestedOrderPieces)) &&
    Number(basis.suggestedOrderPieces) > 0 &&
    Number(basis.suggestedOrderPieces) % Number(basis.piecesPerPurchaseUom) === 0;
}

function changedRecommendationEconomicFields(currentItem: any, acceptedItem: any): string[] {
  const current = recommendationEconomicBasis(currentItem);
  const accepted = recommendationEconomicBasis(acceptedItem);
  return Object.keys(current).filter((key) => (
    current[key as keyof typeof current] !== accepted[key as keyof typeof accepted]
  ));
}

function parseAcceptedRecommendationHandoffSelections(body: any):
  | { selections: Array<{ recommendationId: string; kind: RecommendationReviewQueueKind; key: string }> }
  | { error: string } {
  const rawItems = Array.isArray(body?.items)
    ? body.items
    : body?.recommendationId
      ? [body]
      : [];

  if (rawItems.length === 0) {
    return { error: "items must include at least one accepted recommendation" };
  }
  if (rawItems.length > 25) {
    return { error: "items cannot include more than 25 accepted recommendations" };
  }

  const seen = new Set<string>();
  const selections: Array<{ recommendationId: string; kind: RecommendationReviewQueueKind; key: string }> = [];
  for (const rawItem of rawItems) {
    const recommendationId = typeof rawItem?.recommendationId === "string" ? rawItem.recommendationId.trim() : "";
    const kind = parseReviewQueueKind(rawItem?.kind);
    if (!recommendationId) {
      return { error: "items[].recommendationId is required" };
    }
    if (!kind) {
      return { error: "items[].kind must be one of: skipped, held_by_policy, quality_review_required" };
    }

    const key = recommendationDecisionKey(recommendationId, kind);
    if (seen.has(key)) continue;
    seen.add(key);
    selections.push({ recommendationId, kind, key });
  }

  return { selections };
}

function buildAcceptedRecommendationHandoffSkipped(
  selection: { recommendationId: string; kind: RecommendationReviewQueueKind },
  reason: string,
  item?: any,
  context?: Record<string, unknown>,
) {
  return {
    recommendationId: selection.recommendationId,
    kind: selection.kind,
    sku: item?.sku ?? null,
    reason,
    ...(context ? { context } : {}),
  };
}

export function registerPurchasingRecommendationRoutes(app: Express) {
  // ── Purchasing / Reorder Analysis ──────────────────────────────────
  app.get("/api/purchasing/kpis", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);
      const settings = (await storage.getAutoDraftSettings()) as AutoDraftRecommendationSettings;
      const context = await loadPurchasingRecommendationContext();
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays: configuredLookback,
        autoDraftSettings: settings,
        ...context,
      });

      let criticalRestocks = 0;
      let upcomingRestocks = 0;
      let idleCapitalCents = 0;

      for (const item of recommendationResult.items) {
        const effectiveSupply = item.currentSupply.effectiveSupplyPieces;
        const avgDailyUsage = item.demandBasis.avgDailyUsagePieces;
        const costMills = item.estimatedCostMills ?? centsToMills(item.estimatedCostCents ?? 0);

        if (effectiveSupply < item.reorderPoint) {
          criticalRestocks++;
        } else if (effectiveSupply < item.reorderPoint + 14 * avgDailyUsage && avgDailyUsage > 0) {
          upcomingRestocks++;
        }

        if (item.daysOfSupply > 180 && item.totalOnHand > 0) {
          idleCapitalCents += computeLineTotalCentsFromMills(costMills, item.totalOnHand);
        }
      }

      // Pipeline Value Calculation
      const openPoSummary = await storage.getOpenPoSummaryReport();
      let inboundPipelineValueCents = 0;
      let totalOpenLines = 0;
      openPoSummary.forEach((po) => {
        if (['approved', 'sent', 'acknowledged', 'partially_received'].includes(po.status)) {
          inboundPipelineValueCents += Number(po.total_value_cents) || 0;
          totalOpenLines += Number(po.total_lines) || 0;
        }
      });

      res.json({
        criticalRestocks,
        upcomingRestocks,
        idleCapitalCents,
        inboundPipelineValueCents,
        totalOpenLines,
        lastComputedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Error fetching purchasing dashboard KPIs:", error);
      res.status(500).json({ error: "Failed to fetch purchasing dashboard KPIs" });
    }
  });

  app.get("/api/purchasing/supplier-setup-gaps", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);
      const settings = (await storage.getAutoDraftSettings()) as AutoDraftRecommendationSettings;
      const context = await loadPurchasingRecommendationContext();
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays: configuredLookback,
        autoDraftSettings: settings,
        requireVendor: Boolean(settings.skipNoVendor),
        ...context,
      });

      res.json({
        generatedAt: new Date().toISOString(),
        lookbackDays: configuredLookback,
        autoDraftMode: settings.autoDraftMode ?? "draft_po",
        approvalPolicy: normalizeApprovalPolicy(settings.approvalPolicy),
        ...buildSupplierSetupGaps(recommendationResult),
      });
    } catch (error) {
      console.error("Error fetching supplier setup gaps:", error);
      res.status(500).json({ error: "Failed to fetch supplier setup gaps" });
    }
  });

  app.post("/api/purchasing/recommendation-runs", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const purchasing = app.locals.services?.purchasing;
      if (!purchasing?.snapshotPurchaseRecommendations) {
        return res.status(503).json({ error: "Purchasing recommendation service is unavailable" });
      }
      const { configuredLookback, evaluatedCount, settings, recommendationResult } = await loadRecommendationReviewQueueData();
      const userId = (req as any).user?.id ?? req.session?.user?.id ?? null;
      const asOf = new Date();
      const result = await purchasing.snapshotPurchaseRecommendations(buildPurchaseRecommendationRunInput({
        recommendationResult,
        settings,
        lookbackDays: configuredLookback,
        asOf,
        source: "manual",
        evaluatedCount,
      }), userId);
      res.status(201).json({
        run: result.run,
        lineCount: result.lines.length,
        observationCount: result.observations.length,
      });
    } catch (error) {
      console.error("Error generating purchasing recommendation run:", error);
      res.status(500).json({ error: "Failed to generate purchasing recommendations" });
    }
  });

  app.get("/api/purchasing/rfq-queue", requirePermission("inventory", "view"), async (_req, res) => {
    try {
      const latestRuns = await db.select().from(purchaseRecommendationRunsTable)
        .where(eq(purchaseRecommendationRunsTable.status, "completed"))
        .orderBy(desc(purchaseRecommendationRunsTable.generatedAt), desc(purchaseRecommendationRunsTable.id))
        .limit(1);
      const run = latestRuns[0] ?? null;
      if (!run) {
        return res.json({
          run: null,
          generatedAt: null,
          lookbackDays: null,
          summary: {
            total: 0,
            open: 0,
            partiallyAllocated: 0,
            fullyAllocated: 0,
            supplierAssignmentRequired: 0,
            activeRfqs: 0,
            aboveRecommendation: 0,
            excessPieces: 0,
          },
          items: [],
        });
      }

      const lines = await db.select().from(purchaseRecommendationLinesTable)
        .where(eq(purchaseRecommendationLinesTable.runId, run.id))
        .orderBy(purchaseRecommendationLinesTable.id);
      const productIds = Array.from(new Set(lines.map((line) => line.productId)));
      const allocatedRecommendation = alias(purchaseRecommendationLinesTable, "allocated_recommendation");
      const allocations = productIds.length === 0 ? [] : await db.select({
        id: requestForQuoteLinesTable.id,
        recommendationLineId: requestForQuoteLinesTable.recommendationLineId,
        productId: allocatedRecommendation.productId,
        productVariantId: allocatedRecommendation.productVariantId,
        warehouseId: allocatedRecommendation.warehouseId,
        requestedPieces: requestForQuoteLinesTable.requestedPieces,
        quantityOverrideReason: requestForQuoteLinesTable.quantityOverrideReason,
        allocationOverrideReason: requestForQuoteLinesTable.allocationOverrideReason,
        allocationOverrideApprovedBy: requestForQuoteLinesTable.allocationOverrideApprovedBy,
        allocationOverrideApprovedAt: requestForQuoteLinesTable.allocationOverrideApprovedAt,
        allocationOverrideBaselinePieces: requestForQuoteLinesTable.allocationOverrideBaselinePieces,
        allocationOverrideExcessPieces: requestForQuoteLinesTable.allocationOverrideExcessPieces,
        lineStatus: requestForQuoteLinesTable.status,
        rfqId: requestForQuotesTable.id,
        rfqNumber: requestForQuotesTable.rfqNumber,
        rfqStatus: requestForQuotesTable.status,
        vendorId: requestForQuotesTable.vendorId,
        createdAt: requestForQuotesTable.createdAt,
      }).from(requestForQuoteLinesTable)
        .innerJoin(allocatedRecommendation, eq(requestForQuoteLinesTable.recommendationLineId, allocatedRecommendation.id))
        .innerJoin(requestForQuotesTable, eq(requestForQuoteLinesTable.rfqId, requestForQuotesTable.id))
        .where(and(
          inArray(allocatedRecommendation.productId, productIds),
          inArray(requestForQuoteLinesTable.status, ["draft", "sent", "quoted", "accepted", "ordered"]),
        ));
      const vendorIds = Array.from(new Set([
        ...lines.map((line) => line.preferredVendorId).filter((id): id is number => id != null),
        ...allocations.map((allocation) => allocation.vendorId),
      ]));
      const vendorRows = vendorIds.length === 0 ? [] : await db.select({
        id: vendorsTable.id,
        name: vendorsTable.name,
      }).from(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
      const vendorNameById = new Map(vendorRows.map((vendor) => [vendor.id, vendor.name]));
      const allocationsBySku = new Map<string, typeof allocations>();
      for (const allocation of allocations) {
        const key = purchasingSkuAllocationKey(allocation);
        const group = allocationsBySku.get(key) ?? [];
        group.push(allocation);
        allocationsBySku.set(key, group);
      }
      const items = lines.map((line) => {
        const lineAllocations = allocationsBySku.get(purchasingSkuAllocationKey(line)) ?? [];
        const allocatedPieces = lineAllocations.reduce((sum, allocation) => sum + Number(allocation.requestedPieces), 0);
        const remainingPieces = Math.max(Number(line.recommendedPieces) - allocatedPieces, 0);
        const excessPieces = Math.max(allocatedPieces - Number(line.recommendedPieces), 0);
        const evidence = (line.evidenceSnapshot ?? {}) as Record<string, any>;
        return {
          recommendationLineId: line.id,
          recommendationId: line.recommendationKey,
          runId: line.runId,
          productId: line.productId,
          productVariantId: line.productVariantId,
          warehouseId: line.warehouseId,
          requiredByDate: line.requiredByDate,
          sku: line.sku,
          productName: line.productName,
          recommendedPieces: line.recommendedPieces,
          allocatedPieces,
          remainingPieces,
          excessPieces,
          sourcingStatus: remainingPieces === 0 ? "fully_allocated" : allocatedPieces > 0 ? "partially_allocated" : "open",
          availablePieces: Number(evidence.availablePieces ?? 0),
          onOrderPieces: Number(evidence.onOrderPieces ?? 0),
          reorderPointPieces: Number(evidence.reorderPointPieces ?? 0),
          forecastMethod: String(evidence.forecastMethod ?? "unknown"),
          forecastDailyPieces: Number(evidence.forecastDailyPieces ?? 0),
          leadTimeDays: Number(evidence.leadTimeDays ?? 0),
          safetyStockDays: Number(evidence.safetyStockDays ?? 0),
          forwardDemandPieces: Number(evidence.forwardDemandPieces ?? 0),
          preferredVendorId: line.preferredVendorId,
          preferredVendorName: line.preferredVendorId ? vendorNameById.get(line.preferredVendorId) ?? null : null,
          vendorProductId: line.preferredVendorProductId,
          supplierAssignmentRequired: !line.preferredVendorId,
          allocations: lineAllocations.map((allocation) => ({
            ...allocation,
            vendorName: vendorNameById.get(allocation.vendorId) ?? null,
          })),
        };
      });
      const activeRfqIds = new Set(allocations.map((allocation) => allocation.rfqId));
      res.json({
        run: {
          id: run.id,
          calculationVersion: run.calculationVersion,
          source: run.source,
          sourceRunKey: run.sourceRunKey,
          asOf: run.asOf,
          policySnapshot: run.policySnapshot,
        },
        generatedAt: run.generatedAt,
        lookbackDays: run.lookbackDays,
        summary: {
          total: items.length,
          open: items.filter((item) => item.sourcingStatus === "open").length,
          partiallyAllocated: items.filter((item) => item.sourcingStatus === "partially_allocated").length,
          fullyAllocated: items.filter((item) => item.sourcingStatus === "fully_allocated").length,
          supplierAssignmentRequired: items.filter((item) => item.supplierAssignmentRequired && item.remainingPieces > 0).length,
          activeRfqs: activeRfqIds.size,
          aboveRecommendation: items.filter((item) => item.excessPieces > 0).length,
          excessPieces: items.reduce((sum, item) => sum + item.excessPieces, 0),
        },
        items,
      });
    } catch (error) {
      console.error("Error fetching purchasing recommendation queue:", error);
      res.status(500).json({ error: "Failed to fetch purchasing recommendations" });
    }
  });

  app.post("/api/purchasing/rfq-queue", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      if (!Array.isArray(req.body?.lines) || req.body.lines.length === 0) {
        return res.status(400).json({ error: "lines must include at least one recommendation selection" });
      }
      const purchasing = app.locals.services?.purchasing;
      if (!purchasing?.createRfqBatch) {
        return res.status(503).json({ error: "Purchasing RFQ service is unavailable" });
      }
      const userId = (req as any).user?.id ?? req.session?.user?.id ?? null;
      const result = await purchasing.createRfqBatch({
        idempotencyKey: typeof req.body.idempotencyKey === "string" ? req.body.idempotencyKey : "",
        requestNote: req.body.requestNote == null ? null : String(req.body.requestNote),
        responseDueDate: req.body.responseDueDate == null ? null : String(req.body.responseDueDate),
        lines: req.body.lines.map((line: any) => ({
          recommendationLineId: Number(line?.recommendationLineId),
          vendorId: Number(line?.vendorId),
          vendorSku: line?.vendorSku == null ? null : String(line.vendorSku),
          requestedPieces: Number(line?.requestedPieces),
          quantityOverrideReason: line?.quantityOverrideReason == null ? null : String(line.quantityOverrideReason),
          allocationOverrideApproved: line?.allocationOverrideApproved === true,
        })),
      }, userId);
      res.status(result.reused ? 200 : 201).json(result);
    } catch (error: any) {
      console.error("Error creating purchasing RFQ batch:", error);
      const statusCode = Number(error?.statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return res.status(statusCode).json({
          error: error.message,
          code: error.code ?? error.context?.code ?? "RFQ_CREATE_REJECTED",
          context: error.context ?? {},
        });
      }
      res.status(500).json({ error: "Failed to create RFQ drafts" });
    }
  });

  app.get("/api/purchasing/forecast-input-gaps", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const rawRows = await storage.getReorderAnalysisData(configuredLookback);
      const settings = (await storage.getAutoDraftSettings()) as AutoDraftRecommendationSettings;
      const context = await loadPurchasingRecommendationContext();
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays: configuredLookback,
        autoDraftSettings: settings,
        requireVendor: Boolean(settings.skipNoVendor),
        ...context,
      });
      const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "10"), 10) || 10, 1), 50);

      res.json({
        generatedAt: new Date().toISOString(),
        lookbackDays: configuredLookback,
        autoDraftMode: settings.autoDraftMode ?? "draft_po",
        approvalPolicy: normalizeApprovalPolicy(settings.approvalPolicy),
        ...buildForecastInputGapDiagnostics(recommendationResult, { limit }),
      });
    } catch (error) {
      console.error("Error fetching forecast input gaps:", error);
      res.status(500).json({ error: "Failed to fetch forecast input gaps" });
    }
  });

  app.get("/api/purchasing/recommendation-review-queue", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { configuredLookback, settings, queue } = await loadRecommendationReviewQueueData();
      const kind = typeof req.query.kind === "string" ? req.query.kind : "all";
      const severity = typeof req.query.severity === "string" ? req.query.severity : "all";
      const reason = typeof req.query.reason === "string" && req.query.reason.trim()
        ? req.query.reason.trim()
        : "all";
      const forecastAction = typeof req.query.forecastAction === "string" && req.query.forecastAction.trim()
        ? req.query.forecastAction.trim()
        : "all";
      const recommendationId = typeof req.query.recommendationId === "string" && req.query.recommendationId.trim()
        ? req.query.recommendationId.trim()
        : "all";
      if (recommendationId !== "all" && recommendationId.length > 160) {
        return res.status(400).json({ error: "recommendationId cannot exceed 160 characters" });
      }
      if (forecastAction !== "all" && !parseForecastInputGapActionCode(forecastAction)) {
        return res.status(400).json({
          error: `forecastAction must be one of: all, ${forecastInputGapActionCodes.join(", ")}`,
        });
      }
      const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);
      const filteredItems = queue.items
        .filter((item) => kind === "all" || item.kind === kind)
        .filter((item) => severity === "all" || item.severity === severity)
        .filter((item) => reason === "all" || item.reason.code === reason)
        .filter((item) => forecastAction === "all" || item.forecastAction?.code === forecastAction)
        .filter((item) => recommendationId === "all" || item.recommendationId === recommendationId)
        .slice(0, limit);
      const latestDecisionRows = await storage.getLatestRecommendationDecisions(
        filteredItems.map((item) => item.recommendationId),
        filteredItems.map((item) => item.kind),
      );
      const latestDecisionByKey = buildLatestDecisionMap(latestDecisionRows);
      const items = filteredItems.map((item) => ({
        ...item,
        latestDecision: latestDecisionByKey.get(recommendationDecisionKey(item.recommendationId, item.kind)) ?? null,
      }));
      const decisionCounts = {
        reviewed: items.filter((item) => item.latestDecision?.decision === "reviewed").length,
        acceptedForPo: items.filter((item) => item.latestDecision?.decision === "accepted_for_po").length,
        poHandoffCreated: items.filter((item) => item.latestDecision?.decision === "po_handoff_created").length,
        deferred: items.filter((item) => item.latestDecision?.decision === "deferred").length,
        dismissed: items.filter((item) => item.latestDecision?.decision === "dismissed").length,
      };

      res.json({
        generatedAt: new Date().toISOString(),
        lookbackDays: configuredLookback,
        autoDraftMode: settings.autoDraftMode ?? "draft_po",
        approvalPolicy: normalizeApprovalPolicy(settings.approvalPolicy),
        filters: { kind, severity, reason, forecastAction, recommendationId, limit },
        ...queue,
        filteredCount: filteredItems.length,
        decisionCounts,
        items,
      });
    } catch (error) {
      console.error("Error fetching recommendation review queue:", error);
      res.status(500).json({ error: "Failed to fetch recommendation review queue" });
    }
  });

  app.get("/api/purchasing/recommendation-decisions", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 100);
      const rows = await storage.getRecentRecommendationDecisions(limit);
      const decisions = rows.map(normalizeRecommendationDecision);
      res.json({
        generatedAt: new Date().toISOString(),
        limit,
        summary: buildRecommendationDecisionHistorySummary(decisions),
        decisions,
      });
    } catch (error) {
      console.error("Error fetching recommendation decisions:", error);
      res.status(500).json({ error: "Failed to fetch recommendation decisions" });
    }
  });

  app.get("/api/purchasing/recommendation-accepted-queue", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? "25"), 10) || 25, 1), 100);
      const [{ configuredLookback, settings, queue }, decisionRows] = await Promise.all([
        loadRecommendationReviewQueueData(),
        storage.getLatestRecommendationDecisionsByDecision("accepted_for_po", limit),
      ]);
      const acceptedQueue = buildAcceptedRecommendationReviewQueue(decisionRows, queue, limit);

      res.json({
        generatedAt: new Date().toISOString(),
        lookbackDays: configuredLookback,
        autoDraftMode: settings.autoDraftMode ?? "draft_po",
        approvalPolicy: normalizeApprovalPolicy(settings.approvalPolicy),
        limit,
        loadedDecisionCount: decisionRows.length,
        scannedDecisionCount: decisionRows.length,
        ...acceptedQueue,
      });
    } catch (error) {
      console.error("Error fetching accepted recommendation queue:", error);
      res.status(500).json({ error: "Failed to fetch accepted recommendation queue" });
    }
  });

  app.post(
    "/api/purchasing/recommendation-accepted-queue/create-po",
    requirePermission("inventory", "adjust"),
    async (req, res) => {
      try {
        const parsed = parseAcceptedRecommendationHandoffSelections(req.body);
        if ("error" in parsed) {
          return res.status(400).json({ error: parsed.error });
        }

        const recommendationPoHandoff = app.locals.services?.recommendationPoHandoff;
        if (!recommendationPoHandoff?.createAcceptedHandoff) {
          return res.status(500).json({ error: "Recommendation PO handoff service is not available" });
        }

        const [{ configuredLookback, settings, queue }, decisionRows] = await Promise.all([
          loadRecommendationReviewQueueData(),
          storage.getLatestRecommendationDecisions(
            parsed.selections.map((selection) => selection.recommendationId),
            parsed.selections.map((selection) => selection.kind),
          ),
        ]);
        const acceptedQueue = buildAcceptedRecommendationReviewQueue(decisionRows, queue, 100);
        const acceptedByKey = new Map(
          acceptedQueue.items.map((item: any) => [recommendationDecisionKey(item.recommendationId, item.kind), item]),
        );

        const eligible: any[] = [];
        const skipped: Array<ReturnType<typeof buildAcceptedRecommendationHandoffSkipped>> = [];
        for (const selection of parsed.selections) {
          const item = acceptedByKey.get(selection.key);
          if (!item) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "not_accepted_or_missing"));
            continue;
          }
          if (!item.current) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "stale_accepted_snapshot", item));
            continue;
          }
          const handoffItem = item.acceptedItem;
          if (!handoffItem || typeof handoffItem !== "object") {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "accepted_snapshot_incomplete", item));
            continue;
          }
          if (!hasCompleteExplicitRecommendationQuote(handoffItem)) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(
              selection,
              "supplier_quote_basis_review_required",
              item,
              { pricingBasis: recommendationEconomicBasis(handoffItem).pricingBasis },
            ));
            continue;
          }
          const changedEconomicFields = changedRecommendationEconomicFields(item, handoffItem);
          if (changedEconomicFields.length > 0) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(
              selection,
              "accepted_economics_changed",
              item,
              { changedFields: changedEconomicFields },
            ));
            continue;
          }
          if (!Number.isFinite(Number(handoffItem.productId)) || Number(handoffItem.productId) <= 0) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "missing_product", item));
            continue;
          }
          if (!Number.isFinite(Number(handoffItem.productVariantId)) || Number(handoffItem.productVariantId) <= 0) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "missing_variant", item));
            continue;
          }
          if (!Number.isFinite(Number(handoffItem.suggestedOrderQty)) || Number(handoffItem.suggestedOrderQty) <= 0) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "invalid_qty", item));
            continue;
          }
          try {
            resolveRecommendationPoQuantity(handoffItem);
          } catch {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "invalid_piece_qty", item));
            continue;
          }
          if (!Number.isFinite(Number(handoffItem.preferredVendorId)) || Number(handoffItem.preferredVendorId) <= 0) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "missing_vendor", item));
            continue;
          }
          const acceptedVendorProductId = handoffItem.vendorProductId ?? handoffItem.supplierBasis?.vendorProductId;
          if (!Number.isSafeInteger(Number(acceptedVendorProductId)) || Number(acceptedVendorProductId) <= 0) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "missing_vendor_product", item));
            continue;
          }
          if (!Number.isSafeInteger(Number(item.decision?.id)) || Number(item.decision.id) <= 0) {
            skipped.push(buildAcceptedRecommendationHandoffSkipped(selection, "missing_accepted_decision", item));
            continue;
          }
          eligible.push({ ...item, handoffItem });
        }

        if (eligible.length === 0) {
          return res.status(409).json({
            error: "No current accepted recommendations are eligible for PO handoff",
            skipped,
          });
        }

        const userId = (req as any).user?.id ?? req.session?.user?.id ?? "SYSTEM";
        const result = await recommendationPoHandoff.createAcceptedHandoff({
          actorId: userId,
          items: eligible.map((item) => {
            const acceptedItem = item.handoffItem;
            const quantity = resolveRecommendationPoQuantity(acceptedItem);
            return {
              acceptedDecisionId: Number(item.decision.id),
              recommendationId: item.recommendationId,
              kind: item.kind,
              productId: Number(acceptedItem.productId),
              productVariantId: Number(acceptedItem.productVariantId),
              suggestedPieces: quantity.orderQtyPieces,
              orderUomUnits: quantity.orderUomUnits,
              orderUomLabel: acceptedItem.orderUomLabel,
              vendorProductId: Number(acceptedItem.vendorProductId ?? acceptedItem.supplierBasis?.vendorProductId),
              vendorId: Number(acceptedItem.preferredVendorId),
              sku: acceptedItem.sku ?? null,
              productName: acceptedItem.productName ?? null,
              candidateScore: acceptedItem.candidateScore?.score ?? null,
              candidateBand: acceptedItem.candidateScore?.band ?? null,
              recommendationSnapshot: {
                lookbackDays: configuredLookback,
                autoDraftMode: settings.autoDraftMode ?? "draft_po",
                approvalPolicy: normalizeApprovalPolicy(settings.approvalPolicy),
                item: acceptedItem,
              },
            };
          }),
        });

        res.status(201).json({
          success: true,
          count: result.pos.length,
          itemsDrafted: eligible.length,
          pos: result.pos,
          handedOff: result.handedOff,
          skipped,
          decisions: result.decisions.map(normalizeRecommendationDecision),
        });
      } catch (error) {
        console.error("Error creating PO from accepted recommendation queue:", error);
        const statusCode = Number((error as any)?.statusCode);
        if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
          return res.status(statusCode).json({
            error: (error as Error).message,
            code: (error as any)?.code ?? "RECOMMENDATION_PO_HANDOFF_REJECTED",
            context: (error as any)?.context ?? {},
          });
        }
        res.status(500).json({ error: "Failed to create PO from accepted recommendation queue" });
      }
    },
  );

  app.post("/api/purchasing/recommendation-decisions", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const recommendationId = typeof req.body?.recommendationId === "string" ? req.body.recommendationId.trim() : "";
      const kind = parseReviewQueueKind(req.body?.kind);
      const decision = parseRecommendationDecision(req.body?.decision);
      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      const reviewedControlCodes = parseReviewedControlCodes(req.body?.reviewedControlCodes);

      if (!recommendationId) {
        return res.status(400).json({ error: "recommendationId is required" });
      }
      if (recommendationId.length > 160) {
        return res.status(400).json({ error: "recommendationId cannot exceed 160 characters" });
      }
      if (!kind) {
        return res.status(400).json({ error: "kind must be one of: skipped, held_by_policy, quality_review_required" });
      }
      if (!decision) {
        return res.status(400).json({ error: `decision must be one of: ${recommendationDecisionValues.join(", ")}` });
      }
      if (note.length > RECOMMENDATION_DECISION_NOTE_MAX_LENGTH) {
        return res.status(400).json({ error: `note cannot exceed ${RECOMMENDATION_DECISION_NOTE_MAX_LENGTH} characters` });
      }
      if (!reviewedControlCodes) {
        return res.status(400).json({ error: "reviewedControlCodes must be an array of unique current control codes" });
      }

      const { configuredLookback, settings, queue } = await loadRecommendationReviewQueueData();
      const item = queue.items.find((entry) => entry.recommendationId === recommendationId && entry.kind === kind);
      if (!item) {
        return res.status(404).json({ error: "Recommendation is not currently in the review queue" });
      }
      const evidenceError = validateRecommendationDecisionEvidence({
        decision,
        note,
        confirmDecision: req.body?.confirmDecision,
        acknowledgeAutomationEligibilityUnchanged: req.body?.acknowledgeAutomationEligibilityUnchanged,
        reviewedControlCodes,
        currentControls: item.qualityControls,
      });
      if (evidenceError) {
        return res.status(400).json({ error: evidenceError });
      }

      const userId = (req as any).user?.id ?? req.session?.user?.id ?? "SYSTEM";
      const recommendationPoHandoff = app.locals.services?.recommendationPoHandoff;
      if (!recommendationPoHandoff?.recordDecision) {
        return res.status(500).json({ error: "Recommendation PO handoff service is not available" });
      }
      const created = await recommendationPoHandoff.recordDecision({
        recommendationId: item.recommendationId,
        kind: item.kind,
        decision,
        status: "active",
        decisionReason: item.reason.code,
        note,
        source: "operator",
        productId: item.productId,
        productVariantId: item.productVariantId,
        vendorId: item.preferredVendorId,
        sku: item.sku,
        productName: item.productName,
        candidateScore: item.candidateScore?.score ?? null,
        candidateBand: item.candidateScore?.band ?? null,
        recommendationSnapshot: {
          lookbackDays: configuredLookback,
          autoDraftMode: settings.autoDraftMode ?? "draft_po",
          approvalPolicy: normalizeApprovalPolicy(settings.approvalPolicy),
          item,
          reviewEvidence: {
            contractVersion: REVIEW_EVIDENCE_CONTRACT_VERSION,
            reviewedControlCodes,
            controlsAtDecision: item.qualityControls,
            automationEligibilityAcknowledged: req.body?.acknowledgeAutomationEligibilityUnchanged === true,
            decisionConfirmed: true,
          },
        },
        decidedBy: userId,
      });

      res.status(201).json({
        decision: normalizeRecommendationDecision(created),
      });
    } catch (error) {
      console.error("Error recording recommendation decision:", error);
      const statusCode = Number((error as any)?.statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return res.status(statusCode).json({
          error: (error as Error).message,
          code: (error as any)?.code ?? "RECOMMENDATION_DECISION_REJECTED",
          context: (error as any)?.context ?? {},
        });
      }
      res.status(500).json({ error: "Failed to record recommendation decision" });
    }
  });

  app.post("/api/purchasing/auto-draft-run", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session?.user?.id ?? "SYSTEM";
      const { runAutoDraftJob } = await import("../../jobs/auto-draft.job");
      const result = await runAutoDraftJob({ triggeredBy: "manual", triggeredByUser: userId });
      res.json(result);
    } catch (error: any) {
      console.error("Error running auto-draft:", error);
      const statusCode = Number(error?.statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return res.status(statusCode).json({
          error: error.message,
          code: error.code ?? "AUTO_DRAFT_REJECTED",
          context: error.context ?? {},
        });
      }
      res.status(500).json({ error: "Failed to run auto-draft" });
    }
  });

  // ── Purchasing / Reorder Analysis ──────────────────────────────────
  app.get("/api/purchasing/reorder-analysis", requirePermission("inventory", "view"), async (req, res) => {
    try {
      // Use velocity_lookback_days from warehouse_settings as the default lookback
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;

      // Product-level query: aggregate inventory and velocity in base units (pieces)
      // Also fetch the highest-level variant (ordering UOM) for rounding order quantities
      const rawRows = await storage.getReorderAnalysisData(lookbackDays);
      const settings = (await storage.getAutoDraftSettings()) as AutoDraftRecommendationSettings;
      const approvalPolicySettings: AutoDraftRecommendationSettings = {
        autoDraftMode: settings.autoDraftMode,
        approvalPolicy: settings.approvalPolicy,
        candidateScoreStrongThreshold: settings.candidateScoreStrongThreshold,
        candidateScoreReviewThreshold: settings.candidateScoreReviewThreshold,
        forecastPolicy: settings.forecastPolicy,
      };
      const context = await loadPurchasingRecommendationContext();
      const recommendationResult = generatePurchasingRecommendations({
        rows: rawRows as PurchasingRecommendationRawRow[],
        lookbackDays,
        autoDraftSettings: approvalPolicySettings,
        ...context,
      });

      res.json({
        items: recommendationResult.items,
        summary: recommendationResult.summary,
        approvalPolicyImpact: buildApprovalPolicyImpact(recommendationResult, approvalPolicySettings),
        skippedItems: recommendationResult.skippedItems,
        lookbackDays,
      });
    } catch (error) {
      console.error("Error fetching reorder analysis:", error);
      res.status(500).json({ error: "Failed to fetch reorder analysis" });
    }
  });

  // PATCH velocity lookback days
  app.patch("/api/purchasing/velocity-lookback", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const days = parseInt(req.body.days);
      if (!days || days < 7 || days > 365) {
        return res.status(400).json({ error: "Days must be between 7 and 365" });
      }
      await storage.updateVelocityLookbackDays(days);
      res.json({ ok: true, days });
    } catch (error) {
      console.error("Error updating velocity lookback:", error);
      res.status(500).json({ error: "Failed to update velocity lookback" });
    }
  });

}

export function registerPurchasingRecommendationAdminRoutes(app: Express) {
  // ===== PURCHASING DASHBOARD ROUTES =====

  // GET /api/purchasing/dashboard
  app.get("/api/purchasing/dashboard", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;
      const data = await storage.getDashboardData(lookbackDays);
      res.json(data);
    } catch (error) {
      console.error("Error fetching purchasing dashboard:", error);
      res.status(500).json({ error: "Failed to fetch dashboard data" });
    }
  });

  // GET /api/purchasing/exclusion-rules
  app.get("/api/purchasing/exclusion-rules", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const rules = await storage.getReorderExclusionRules();
      const totalExcluded = await storage.getTotalExcludedProducts();

      // Get match counts for each rule
      const rulesWithCounts = await Promise.all(
        rules.map(async (r: any) => ({
          ...r,
          matchCount: await storage.getExclusionRuleMatchCount(r.field, r.value),
        }))
      );

      res.json({ rules: rulesWithCounts, totalExcluded });
    } catch (error) {
      console.error("Error fetching exclusion rules:", error);
      res.status(500).json({ error: "Failed to fetch exclusion rules" });
    }
  });

  // POST /api/purchasing/exclusion-rules
  app.post("/api/purchasing/exclusion-rules", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { field, value } = req.body;
      const validFields = ["category", "brand", "product_type", "sku_prefix", "sku_exact", "tag"];
      if (!field || !validFields.includes(field)) {
        return res.status(400).json({ error: `field must be one of: ${validFields.join(", ")}` });
      }
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        return res.status(400).json({ error: "value is required" });
      }

      const userId = (req as any).user?.id ?? req.session.user?.id;
      const rule = await storage.createReorderExclusionRule({
        field,
        value: value.trim(),
        createdBy: userId,
      });
      const matchCount = await storage.getExclusionRuleMatchCount(rule.field, rule.value);
      res.status(201).json({ ...rule, matchCount });
    } catch (error: any) {
      if (error?.message?.includes("unique") || error?.code === "23505") {
        return res.status(409).json({ error: "Rule already exists" });
      }
      console.error("Error creating exclusion rule:", error);
      res.status(500).json({ error: "Failed to create exclusion rule" });
    }
  });

  // DELETE /api/purchasing/exclusion-rules/:id
  app.delete("/api/purchasing/exclusion-rules/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReorderExclusionRule(id);
      if (!deleted) {
        return res.status(404).json({ error: "Rule not found" });
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting exclusion rule:", error);
      res.status(500).json({ error: "Failed to delete exclusion rule" });
    }
  });

  // GET /api/purchasing/exclusion-rules/field-values?field=category
  // Returns distinct values for a given field from products table
  app.get("/api/purchasing/exclusion-rules/field-values", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { db } = await import("../../db");
      const field = String(req.query.field || "").trim();
      const allowedFields: Record<string, string | null> = {
        category: "category",
        brand: "brand",
        product_type: "product_type",
        tag: null, // handled separately — tags is jsonb array
      };
      if (!field || !(field in allowedFields)) {
        return res.status(400).json({ error: "Invalid field. Must be one of: category, brand, product_type, tag" });
      }
      let values: string[] = [];
      if (field === "tag") {
        // Unnest tags jsonb array
        const rows = await db.execute(sql`
          SELECT DISTINCT trim(tag::text, '"') AS value
          FROM catalog.products, jsonb_array_elements_text(tags) AS tag
          WHERE tags IS NOT NULL AND jsonb_array_length(tags) > 0
          ORDER BY value
        `);
        values = (rows.rows as any[]).map(r => r.value).filter(Boolean);
      } else {
        const col = allowedFields[field]!;
        const rows = await db.execute(sql`
          SELECT DISTINCT ${sql.raw(col)} AS value
          FROM catalog.products
          WHERE is_active = true AND ${sql.raw(col)} IS NOT NULL AND ${sql.raw(col)} != ''
          ORDER BY value
        `);
        values = (rows.rows as any[]).map(r => r.value).filter(Boolean);
      }
      res.json({ field, values });
    } catch (error: any) {
      console.error("Error fetching field values:", error);
      res.status(500).json({ error: "Failed to fetch field values" });
    }
  });

  // PATCH /api/purchasing/products/:productId/reorder-excluded
  app.patch("/api/purchasing/products/:productId/reorder-excluded", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const { excluded } = req.body;
      if (typeof excluded !== "boolean") {
        return res.status(400).json({ error: "excluded must be a boolean" });
      }
      await storage.setProductReorderExcluded(productId, excluded);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error toggling product exclusion:", error);
      res.status(500).json({ error: "Failed to update product exclusion" });
    }
  });

  // GET /api/purchasing/auto-draft/status
  app.get("/api/purchasing/auto-draft/status", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const run = await storage.getLatestAutoDraftRun();
      res.json(run ? normalizeAutoDraftRun(run) : null);
    } catch (error) {
      console.error("Error fetching auto-draft status:", error);
      res.status(500).json({ error: "Failed to fetch auto-draft status" });
    }
  });

  // GET /api/purchasing/auto-draft/runs
  app.get("/api/purchasing/auto-draft/runs", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = parseRunHistoryLimit(req.query.limit);
      const runs = await storage.getRecentAutoDraftRuns(limit);
      res.json({
        limit,
        runs: runs.map(normalizeAutoDraftRun),
      });
    } catch (error) {
      console.error("Error fetching auto-draft run history:", error);
      res.status(500).json({ error: "Failed to fetch auto-draft run history" });
    }
  });

  // GET /api/purchasing/auto-draft/stale-pos
  app.get("/api/purchasing/auto-draft/stale-pos", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = parseStalePoLimit(req.query.limit);
      const includeInfo = req.query.includeInfo === "true";
      const rows = await fetchAutoDraftPoAgingRows(db, { scanLimit: 500 });
      const settings = await storage.getAutoDraftSettings();
      res.json(buildStaleAutoDraftPoDiagnostics(rows, {
        limit,
        includeInfo,
        thresholds: settings.stalePoThresholds,
      }));
    } catch (error) {
      console.error("Error fetching stale auto-draft PO diagnostics:", error);
      res.status(500).json({ error: "Failed to fetch stale auto-draft PO diagnostics" });
    }
  });

  // POST /api/purchasing/auto-draft/run
  app.post("/api/purchasing/auto-draft/run", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const user = (req as any).user ?? req.session.user;
      if (user?.role !== "admin") {
        return res.status(403).json({ error: "Admin role required" });
      }

      const { startAutoDraftJob } = await import("../../jobs/auto-draft.job");
      const started = await startAutoDraftJob({ triggeredBy: "manual", triggeredByUser: user?.id });
      void started.completion
        .catch((err: any) => console.error("[Auto-draft] manual run failed:", err));

      res.status(202).json({
        message: "Auto-draft job started",
        runId: started.runId,
        interruptedRunIds: started.interruptedRunIds,
      });
    } catch (error: any) {
      console.error("Error triggering auto-draft:", error);
      const statusCode = Number(error?.statusCode);
      if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
        return res.status(statusCode).json({
          error: error.message,
          code: error.code ?? "AUTO_DRAFT_RUN_REJECTED",
          context: error.context ?? {},
        });
      }
      res.status(500).json({ error: "Failed to trigger auto-draft" });
    }
  });

  // GET /api/purchasing/auto-draft-settings
  app.get("/api/purchasing/auto-draft-settings", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const settings = await storage.getAutoDraftSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching auto-draft settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // PATCH /api/purchasing/auto-draft-settings
  app.patch("/api/purchasing/auto-draft-settings", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const {
        autoDraftMode,
        approvalPolicy,
        includeOrderSoon,
        skipOnOpenPo,
        skipNoVendor,
        candidateScoreStrongThreshold,
        candidateScoreReviewThreshold,
        rfqDraftAutomationMode,
        rfqDraftMinimumConfidence,
        rfqDraftRequireTrustedForecast,
        rfqDraftMaximumLinesPerRun,
        forecastPolicy,
        stalePoThresholds,
      } = req.body;
      if (autoDraftMode !== undefined && !["draft_po", "review_only"].includes(autoDraftMode)) {
        return res.status(400).json({ error: "autoDraftMode must be one of: draft_po, review_only" });
      }
      if (
        approvalPolicy !== undefined &&
        !["high_confidence_only", "high_confidence_and_strong_candidate"].includes(approvalPolicy)
      ) {
        return res.status(400).json({
          error: "approvalPolicy must be one of: high_confidence_only, high_confidence_and_strong_candidate",
        });
      }
      if (rfqDraftAutomationMode !== undefined && !["manual", "preferred_vendor"].includes(rfqDraftAutomationMode)) {
        return res.status(400).json({ error: "rfqDraftAutomationMode must be one of: manual, preferred_vendor" });
      }
      if (rfqDraftMinimumConfidence !== undefined && !["high", "medium"].includes(rfqDraftMinimumConfidence)) {
        return res.status(400).json({ error: "rfqDraftMinimumConfidence must be one of: high, medium" });
      }
      if (rfqDraftRequireTrustedForecast !== undefined && typeof rfqDraftRequireTrustedForecast !== "boolean") {
        return res.status(400).json({ error: "rfqDraftRequireTrustedForecast must be a boolean" });
      }
      if (rfqDraftMaximumLinesPerRun !== undefined && (
        !Number.isSafeInteger(rfqDraftMaximumLinesPerRun)
        || rfqDraftMaximumLinesPerRun < 1
        || rfqDraftMaximumLinesPerRun > 500
      )) {
        return res.status(400).json({ error: "rfqDraftMaximumLinesPerRun must be an integer between 1 and 500" });
      }
      const parsedStrongThreshold = parseCandidateScoreThreshold(candidateScoreStrongThreshold, "candidateScoreStrongThreshold");
      if (typeof parsedStrongThreshold === "object") {
        return res.status(400).json(parsedStrongThreshold);
      }
      const parsedReviewThreshold = parseCandidateScoreThreshold(candidateScoreReviewThreshold, "candidateScoreReviewThreshold");
      if (typeof parsedReviewThreshold === "object") {
        return res.status(400).json(parsedReviewThreshold);
      }
      const currentSettings = await storage.getAutoDraftSettings();
      const parsedForecastPolicy = parsePurchasingForecastPolicy(
        forecastPolicy,
        normalizePurchasingForecastPolicy(currentSettings.forecastPolicy),
      );
      if (typeof parsedForecastPolicy === "object" && "error" in parsedForecastPolicy) {
        return res.status(400).json(parsedForecastPolicy);
      }
      const parsedStalePoThresholds = parseStalePoThresholds(stalePoThresholds, currentSettings.stalePoThresholds);
      if (typeof parsedStalePoThresholds === "object" && "error" in parsedStalePoThresholds) {
        return res.status(400).json(parsedStalePoThresholds);
      }
      const nextStrongThreshold = parsedStrongThreshold ?? currentSettings.candidateScoreStrongThreshold ?? 80;
      const nextReviewThreshold = parsedReviewThreshold ?? currentSettings.candidateScoreReviewThreshold ?? 60;
      if (nextReviewThreshold > nextStrongThreshold) {
        return res.status(400).json({ error: "candidateScoreReviewThreshold must be less than or equal to candidateScoreStrongThreshold" });
      }
      await storage.updateAutoDraftSettings(undefined, {
        autoDraftMode,
        approvalPolicy,
        includeOrderSoon,
        skipOnOpenPo,
        skipNoVendor,
        candidateScoreStrongThreshold: parsedStrongThreshold,
        candidateScoreReviewThreshold: parsedReviewThreshold,
        rfqDraftAutomationMode,
        rfqDraftMinimumConfidence,
        rfqDraftRequireTrustedForecast,
        rfqDraftMaximumLinesPerRun,
        forecastPolicy: parsedForecastPolicy,
        stalePoThresholds: parsedStalePoThresholds,
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("Error updating auto-draft settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });
}
