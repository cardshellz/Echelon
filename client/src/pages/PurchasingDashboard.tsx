import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  LayoutDashboard,
  Filter,
  Plus,
  ShoppingCart,
  FileText,
  Truck,
  Package,
  BarChart3,
  AlertTriangle,
  ArrowRight,
  Clock,
  CheckCircle2,
  XCircle,
  Zap,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { ExclusionRulesModal } from "@/components/purchasing/ExclusionRulesModal";
import { isImmutableRecommendationPurchaseOrder } from "@/features/po-edit/purchase-order-editability";

interface ForecastDiagnostics {
  recommendationCount: number;
  forecastMethodCounts: Record<string, number>;
  demandQualityCounts: Record<string, number>;
  demandTrendCounts: Record<string, number>;
  shortWindowDemandQualityCounts?: Record<string, number>;
  shortWindowDemandTrendCounts?: Record<string, number>;
  longWindowDemandQualityCounts?: Record<string, number>;
  longWindowDemandTrendCounts?: Record<string, number>;
  seasonalWindowDemandQualityCounts?: Record<string, number>;
  seasonalWindowDemandTrendCounts?: Record<string, number>;
  demandAccelerationSignalCounts?: Record<string, number>;
  demandBaselineSignalCounts?: Record<string, number>;
  demandSeasonalitySignalCounts?: Record<string, number>;
  demandMixSignalCounts?: Record<string, number>;
  demandSuppressionSignalCounts?: Record<string, number>;
  demandSuppressionReviewCount?: number;
  forecastTrustSignalCounts?: Record<string, number>;
  forecastTrustSeverityCounts?: Record<string, number>;
  forecastTrustWatchCount?: number;
  forecastTrustReviewCount?: number;
  forecastInputGapCounts?: Record<string, number>;
  supplierCycleSignalCounts?: Record<string, number>;
  supplierCycleOpenPoPastDueCount?: number;
  avgSupplierCycleSupplyCoverageRatio?: number | null;
  recommendationCandidateBandCounts?: Record<string, number>;
  avgRecommendationCandidateScore?: number;
  strongRecommendationCandidateCount?: number;
  qualityControlCounts?: Record<string, number>;
  qualityControlAreaCounts?: Record<string, number>;
  qualityControlSeverityCounts?: Record<string, number>;
  autopilotBlockerCounts?: Record<string, number>;
  autopilotBlockerAreaCounts?: Record<string, number>;
  autopilotBlockerSeverityCounts?: Record<string, number>;
  autopilotBlockerItemCount?: number;
  totalPeriodUsagePieces: number;
  totalPaidDemandPieces?: number;
  totalZeroRevenueDemandPieces?: number;
  totalCouponDiscountDemandPieces?: number;
  avgDailyUsagePieces: number;
  latestDemandAt: string | null;
}

interface RecommendationForecastProvenance {
  forecastMethod?: string;
  forecastVersion?: number;
  demandWindowDays?: number;
  demandQuality?: string;
  demandTrend?: string;
  periodUsagePieces?: number;
  avgDailyUsagePieces?: number;
  demandOrderCount?: number | null;
  demandActiveDays?: number | null;
  latestDemandAt?: string | null;
  paidDemandPieces?: number | null;
  zeroRevenueDemandPieces?: number | null;
  couponDiscountDemandPieces?: number | null;
  zeroRevenueDemandShare?: number | null;
  couponDiscountDemandShare?: number | null;
  demandMixSignal?: string;
  demandSuppressionRisk?: {
    signal: string;
    severity: string;
    detail: string;
  };
  forecastTrust?: {
    signal: string;
    severity: string;
    detail: string;
    latestDemandAgeDays?: number | null;
    staleDemandThresholdDays?: number;
    inputGaps?: string[];
  };
  demandWindowDiagnostics?: {
    shortWindow?: {
      lookbackDays?: number;
      periodUsagePieces?: number;
      avgDailyUsagePieces?: number;
      demandQuality?: string;
      demandTrend?: string;
    };
    longWindow?: {
      lookbackDays?: number;
      periodUsagePieces?: number;
      avgDailyUsagePieces?: number;
      demandQuality?: string;
      demandTrend?: string;
    };
    seasonalWindow?: {
      lookbackDays?: number;
      periodUsagePieces?: number;
      avgDailyUsagePieces?: number;
      demandQuality?: string;
      demandTrend?: string;
    };
    accelerationRatio?: number | null;
    accelerationSignal?: string;
    baselineRatio?: number | null;
    baselineSignal?: string;
    seasonalRatio?: number | null;
    seasonalSignal?: string;
  };
}

interface RecommendationQualityControl {
  area: "demand" | "lead_time" | "supplier_cost" | "vendor";
  severity: "review" | "block";
  code: string;
  label: string;
  detail: string;
}

interface RecommendationSupplierCycleDiagnostics {
  signal: string;
  detail: string;
  cycleDays: number;
  supplyCoverageRatio: number | null;
  openPoCoverageRatio: number | null;
  daysUntilEarliestExpected: number | null;
  daysSinceLastReceipt: number | null;
}

interface RecommendationCandidateScore {
  score: number;
  band: string;
  demandScore: number;
  supplyScore: number;
  readinessScore: number;
  signals: string[];
  blockers: string[];
  detail: string;
}

type AutoDraftApprovalPolicy = "high_confidence_only" | "high_confidence_and_strong_candidate";
type AutoDraftRunStatus = "running" | "success" | "error" | "interrupted";

interface AutoDraftRunRecommendationSample {
  sku: string;
  productName: string;
  suggestedOrderQty?: number;
  orderUomLabel?: string;
  preferredVendorName?: string | null;
  skippedReason?: string | null;
  explanation: string;
  forecastProvenance?: RecommendationForecastProvenance;
  supplierCycleDiagnostics?: RecommendationSupplierCycleDiagnostics;
  recommendationCandidateScore?: RecommendationCandidateScore;
  qualityControls?: RecommendationQualityControl[];
  autopilotBlockers?: RecommendationQualityControl[];
}

interface ApprovalPolicyDiagnostics {
  policy: AutoDraftApprovalPolicy;
  mode: "draft_po" | "review_only";
  candidateScoreGateActive: boolean;
  qualityGateEligibleCount: number;
  approvalPolicyEligibleCount: number;
  approvalPolicyBlockedCount: number;
  draftMutationEligibleCount: number;
  approvedCandidateBandCounts: Record<string, number>;
  blockedCandidateBandCounts: Record<string, number>;
}

interface DashboardData {
  stockouts: number;
  orderNow: number;
  draftPoCount: number;
  inTransitCount: number;
  openPoValueCents: number;
  noVendorCount: number;
  stockoutItems: Array<{ productId: number; sku: string; productName: string; totalOnHand: number }>;
  draftPos: Array<{ id: number; poNumber: string; vendorName: string; lineCount: number; totalCents: number | null; source: string }>;
  inFlightPos: Array<{ id: number; poNumber: string; vendorName: string; status: string; lineCount: number; receivedLineCount: number; totalCents: number | null; expectedDeliveryDate: string | null }>;
  noVendorItems: Array<{ productId: number; sku: string; productName: string; totalOnHand: number }>;
  orderNowItems: Array<{ productId: number; sku: string; productName: string; daysOfSupply: number; suggestedOrderQty: number; orderUomLabel: string; preferredVendorId: number | null }>;
  healthBreakdown: { stockout: number; order_now: number; order_soon: number; on_order: number; ok: number; no_movement: number; total: number };
  spend: { totalReceivedCents: number; openPoValueCents: number; avgPoCents: number; topSupplierName: string | null; topSupplierCents: number; activeSupplierCount: number };
  lastAutoDraftRun: {
    runAt: string;
    status: AutoDraftRunStatus;
    heartbeatAt: string | null;
    leaseExpiresAt: string | null;
    finishedAt: string | null;
    itemsAnalyzed: number;
    posCreated: number;
    posUpdated: number;
    linesAdded: number;
    skippedNoVendor: number;
    skippedExcluded: number;
    skippedOnOrder: number;
    errorMessage: string | null;
    summaryJson?: {
      settings?: {
        autoDraftMode?: "draft_po" | "review_only";
        approvalPolicy?: AutoDraftApprovalPolicy;
      };
      recommendationSummary?: {
        actionableCount?: number;
        autoDraftEligibleCount?: number;
        autoDraftReviewRequiredCount?: number;
      };
      approvalPolicyDiagnostics?: ApprovalPolicyDiagnostics | null;
      forecastDiagnostics?: ForecastDiagnostics | null;
      skippedReasonCounts?: Record<string, number>;
      actionableRecommendations?: AutoDraftRunRecommendationSample[];
      skippedRecommendations?: AutoDraftRunRecommendationSample[];
      approvalPolicyBlockedRecommendations?: AutoDraftRunRecommendationSample[];
    } | null;
  } | null;
}

interface AutoDraftRunHistoryItem {
  id: number;
  runAt: string;
  triggeredBy: string | null;
  status: AutoDraftRunStatus;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  mode: "draft_po" | "review_only";
  approvalPolicy: AutoDraftApprovalPolicy;
  itemsAnalyzed: number;
  actionableCount: number;
  autoDraftEligibleCount: number;
  autoDraftReviewRequiredCount: number;
  approvalPolicyEligibleCount: number;
  approvalPolicyBlockedCount: number;
  draftMutationEligibleCount: number;
  approvalPolicyDiagnostics: ApprovalPolicyDiagnostics | null;
  forecastDiagnostics: ForecastDiagnostics | null;
  posCreated: number;
  posUpdated: number;
  linesAdded: number;
  skippedNoVendor: number;
  skippedOnOrder: number;
  skippedExcluded: number;
  errorMessage: string | null;
  recommendationSamples?: {
    actionable?: AutoDraftRunRecommendationSample[];
    approvalPolicyBlocked?: AutoDraftRunRecommendationSample[];
    skipped?: AutoDraftRunRecommendationSample[];
  };
  recommendationSampleCounts?: {
    actionable: number;
    approvalPolicyBlocked: number;
    skipped: number;
  };
  topActionableRecommendation: AutoDraftRunRecommendationSample | null;
  topApprovalPolicyBlockedRecommendation: AutoDraftRunRecommendationSample | null;
  topSkippedRecommendation: AutoDraftRunRecommendationSample | null;
  recommendedActions: Array<{
    action: string;
    label: string;
    detail: string;
    href: string;
    severity: "critical" | "warning" | "info";
    count: number;
  }>;
}

interface AutoDraftRunHistoryResponse {
  limit: number;
  runs: AutoDraftRunHistoryItem[];
}

type LandedCostHealth = {
  status: "healthy" | "warning" | "critical";
  scannedShipments: number;
  critical: number;
  warning: number;
  counts: {
    allocationBlockers: number;
    allocationWarnings: number;
    pendingFinalization: number;
    finalizedNotPushed: number;
    staleProvisionalLots: number;
  };
  items: Array<{
    id: string;
    type: string;
    severity: "critical" | "warning";
    shipmentId: number;
    shipmentNumber: string | null;
    shipmentStatus: string;
    detail: string;
    action: string;
  }>;
};

type SupplierSetupGaps = {
  generatedAt: string;
  lookbackDays: number;
  autoDraftMode: "draft_po" | "review_only";
  approvalPolicy: AutoDraftApprovalPolicy;
  scannedRecommendations: number;
  skippedRecommendations: number;
  totalGapItems: number;
  counts: {
    missingVendor: number;
    missingSupplierCost: number;
    lastPurchaseCost: number;
    staleSupplierCost: number;
    unverifiedSupplierCost: number;
    defaultLeadTime: number;
    productLeadTimeFallback: number;
    blockedRecommendations: number;
    reviewRecommendations: number;
  };
  codeCounts: Record<string, number>;
  items: Array<{
    recommendationId: string;
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
    orderUomLabel: string;
    blocksCurrentRecommendation: boolean;
    candidateScore?: RecommendationCandidateScore;
    gaps: RecommendationQualityControl[];
    action: {
      action: string;
      label: string;
      href: string;
    };
  }>;
};

type ForecastInputGapDiagnostics = {
  generatedAt: string;
  lookbackDays: number;
  autoDraftMode: "draft_po" | "review_only";
  approvalPolicy: AutoDraftApprovalPolicy;
  totalRecommendations: number;
  totalIssueItems: number;
  inputGapItems: number;
  reviewItems: number;
  watchItems: number;
  trustedItems: number;
  forecastTrustHeldAutoDraft: number;
  gapCounts: Record<string, number>;
  trustSignalCounts: Record<string, number>;
  trustSeverityCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  actions: Array<{
    code: string;
    label: string;
    detail: string;
    href: string;
    severity: "warning" | "info";
    count: number;
  }>;
  samples: Array<{
    recommendationId: string;
    sku: string;
    productName: string;
    productId: number;
    productVariantId: number | null;
    status: string;
    confidence: string;
    candidateBand: string;
    candidateScore: number;
    qualityGateReason: string;
    forecastTrustSignal: string;
    forecastTrustSeverity: string;
    forecastTrustDetail: string;
    latestDemandAgeDays: number | null;
    inputGaps: string[];
    action: {
      code: string;
      label: string;
      detail: string;
      href: string;
      severity?: "warning" | "info";
    };
  }>;
};

type StaleAutoDraftPoDiagnostics = {
  generatedAt: string;
  scannedAutoDraftPos: number;
  totalStale: number;
  counts: {
    critical: number;
    warning: number;
    info: number;
    reviewPending: number;
    supplierSendPending: number;
    supplierFollowupPending: number;
    receivingPending: number;
    apCloseoutPending: number;
    exceptionBlocked: number;
    closeoutPending: number;
  };
  items: Array<{
    id: string;
    poId: number;
    poNumber: string;
    vendorId: number | null;
    vendorName: string | null;
    status: string | null;
    physicalStatus: string | null;
    financialStatus: string | null;
    stage: string;
    stageLabel: string;
    stageStartedAt: string | null;
    ageDays: number;
    severity: "critical" | "warning" | "info";
    detail: string;
    action: {
      action: string;
      label: string;
      href: string;
    };
    lineCount: number | null;
    totalCents: number | null;
    expectedDeliveryDate: string | null;
    openExceptionCount: number;
  }>;
};

type ProcurementHealthSummary = {
  generatedAt: string;
  status: "healthy" | "warning" | "critical";
  critical: number;
  warning: number;
  total: number;
  sources: Array<{
    key: string;
    label: string;
    status: "healthy" | "warning" | "critical";
    critical: number;
    warning: number;
    total: number;
    href: string;
    actionLabel: string;
    detail: string;
  }>;
};

function formatCents(cents: number): string {
  if (cents >= 100000) return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function formatRelativeTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatHealthType(type: string): string {
  return type.replace(/_/g, " ");
}

function formatForecastMethod(method?: string | null): string {
  if (!method) return "No forecast method";
  return method.replace(/_/g, " ");
}

function topCountLabel(counts?: Record<string, number> | null): string {
  if (!counts) return "None";
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top) return "None";
  return `${top[0].replace(/_/g, " ")} (${top[1]})`;
}

function formatGapCode(code: string): string {
  return code.replace(/_/g, " ");
}

function formatForecastDiagnostics(diagnostics?: ForecastDiagnostics | null): string {
  if (!diagnostics) return "No forecast diagnostics";
  const topMethod = Object.entries(diagnostics.forecastMethodCounts ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  const blocker = topCountLabel(diagnostics.autopilotBlockerCounts);
  const blockerLabel = blocker === "None" ? "no blockers" : blocker;
  const demandMix = topCountLabel(diagnostics.demandMixSignalCounts);
  const demandMixLabel = demandMix === "None" ? "mix n/a" : demandMix;
  const suppressionCount = diagnostics.demandSuppressionReviewCount ?? 0;
  const suppressionLabel = suppressionCount > 0 ? ` - ${suppressionCount} suppression review` : "";
  const trustReviewCount = diagnostics.forecastTrustReviewCount ?? 0;
  const trustWatchCount = diagnostics.forecastTrustWatchCount ?? 0;
  const trustLabel =
    trustReviewCount > 0
      ? ` - ${trustReviewCount} trust review`
      : trustWatchCount > 0
        ? ` - ${trustWatchCount} trust watch`
        : "";
  return `${formatForecastMethod(topMethod)} - ${topCountLabel(diagnostics.demandQualityCounts)} - ${demandMixLabel} - ${diagnostics.totalPeriodUsagePieces.toLocaleString()} pcs - ${blockerLabel}${suppressionLabel}${trustLabel}`;
}

function formatApprovalPolicy(policy?: AutoDraftApprovalPolicy | null): string {
  return policy === "high_confidence_and_strong_candidate"
    ? "High confidence + strong candidate"
    : "High confidence only";
}

function autoDraftActionClass(severity: string): string {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700 hover:bg-red-100";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100";
  return "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50";
}

function stalePoSeverityClass(severity: string): string {
  if (severity === "critical") return "bg-red-50 text-red-700 border-red-200";
  if (severity === "warning") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-zinc-50 text-zinc-700 border-zinc-200";
}

function procurementHealthClass(status: string): string {
  if (status === "critical") return "border-red-300 bg-red-50/40";
  if (status === "warning") return "border-amber-300 bg-amber-50/40";
  return "border-emerald-300 bg-emerald-50/40";
}

function forecastActionClass(severity: string): string {
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100";
  return "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50";
}

function formatPoTrack(status?: string | null): string {
  return status ? status.replace(/_/g, " ") : "n/a";
}

function formatRecommendationForecast(
  provenance?: RecommendationForecastProvenance,
  supplierCycleDiagnostics?: RecommendationSupplierCycleDiagnostics,
  candidateScore?: RecommendationCandidateScore,
): string {
  if (!provenance) return "Forecast basis unavailable";
  const sample =
    provenance.demandOrderCount != null && provenance.demandActiveDays != null
      ? `${provenance.demandOrderCount} orders/${provenance.demandActiveDays} active days`
      : `${provenance.periodUsagePieces ?? 0} pcs`;
  const trend = provenance.demandTrend ? provenance.demandTrend.replace(/_/g, " ") : "trend n/a";
  const acceleration = provenance.demandWindowDiagnostics?.accelerationSignal;
  const accelerationLabel = acceleration ? ` - ${acceleration.replace(/_/g, " ")}` : "";
  const baseline = provenance.demandWindowDiagnostics?.baselineSignal;
  const baselineLabel = baseline ? ` - ${baseline.replace(/_/g, " ")}` : "";
  const seasonal = provenance.demandWindowDiagnostics?.seasonalSignal;
  const seasonalLabel = seasonal && seasonal !== "not_available" ? ` - ${seasonal.replace(/_/g, " ")}` : "";
  const mixLabel = provenance.demandMixSignal && provenance.demandMixSignal !== "not_available"
    ? ` - ${provenance.demandMixSignal.replace(/_/g, " ")}`
    : "";
  const cycleLabel = supplierCycleDiagnostics ? ` - cycle ${supplierCycleDiagnostics.signal.replace(/_/g, " ")}` : "";
  const scoreLabel = candidateScore ? ` - score ${candidateScore.score} ${candidateScore.band.replace(/_/g, " ")}` : "";
  const trustLabel =
    provenance.forecastTrust && provenance.forecastTrust.signal !== "trusted"
      ? ` - trust ${provenance.forecastTrust.signal.replace(/_/g, " ")}`
      : "";
  return `${formatForecastMethod(provenance.forecastMethod)} - ${sample} - ${trend}${accelerationLabel}${baselineLabel}${seasonalLabel}${mixLabel}${cycleLabel}${scoreLabel}${trustLabel}`;
}

function formatQualityControlSummary(controls?: RecommendationQualityControl[] | null): string | null {
  if (!controls?.length) return null;
  const labels = controls.slice(0, 2).map((control) => control.label).join(", ");
  const remainder = controls.length > 2 ? ` +${controls.length - 2} more` : "";
  return `${controls.some((control) => control.severity === "block") ? "Blocked" : "Review"}: ${labels}${remainder}`;
}

function runRecommendationSampleText(item?: AutoDraftRunRecommendationSample | null): string {
  if (!item) return "";
  return [
    item.sku,
    item.productName,
    item.preferredVendorName,
    item.skippedReason,
    item.forecastProvenance?.demandSuppressionRisk?.signal,
    item.forecastProvenance?.demandSuppressionRisk?.detail,
    item.forecastProvenance?.forecastTrust?.signal,
    item.forecastProvenance?.forecastTrust?.detail,
    item.forecastProvenance?.forecastTrust?.inputGaps?.join(" "),
    item.recommendationCandidateScore?.band,
    item.recommendationCandidateScore?.signals?.join(" "),
    item.recommendationCandidateScore?.blockers?.join(" "),
    item.qualityControls?.map((control) => `${control.code} ${control.label}`).join(" "),
    item.autopilotBlockers?.map((control) => `${control.code} ${control.label}`).join(" "),
  ].filter(Boolean).join(" ").toLowerCase();
}

function autoDraftRunSearchText(run: AutoDraftRunHistoryItem): string {
  const samples = [
    ...(run.recommendationSamples?.actionable ?? []),
    ...(run.recommendationSamples?.approvalPolicyBlocked ?? []),
    ...(run.recommendationSamples?.skipped ?? []),
    run.topActionableRecommendation,
    run.topApprovalPolicyBlockedRecommendation,
    run.topSkippedRecommendation,
  ];
  return [
    String(run.id),
    run.status,
    run.mode,
    run.approvalPolicy,
    run.errorMessage,
    formatForecastDiagnostics(run.forecastDiagnostics),
    ...samples.map(runRecommendationSampleText),
  ].filter(Boolean).join(" ").toLowerCase();
}

function autoDraftRunStatusLabel(status: AutoDraftRunStatus): string {
  switch (status) {
    case "success": return "Success";
    case "running": return "Running";
    case "interrupted": return "Interrupted";
    case "error": return "Error";
  }
}

function autoDraftRunStatusDotClass(status: AutoDraftRunStatus): string {
  switch (status) {
    case "success": return "bg-green-500";
    case "running": return "bg-blue-500";
    case "interrupted": return "bg-amber-500";
    case "error": return "bg-red-500";
  }
}

function autoDraftRunHasActiveLease(run: DashboardData["lastAutoDraftRun"]): boolean {
  if (!run || run.status !== "running" || !run.leaseExpiresAt) return false;
  const leaseExpiresAt = Date.parse(run.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  sent: { label: "Sent", className: "bg-blue-50 text-blue-700 border-blue-200" },
  acknowledged: { label: "Acknowledged", className: "bg-purple-50 text-purple-700 border-purple-200" },
  partially_received: { label: "Partial", className: "bg-orange-50 text-orange-700 border-orange-200" },
  draft: { label: "Draft", className: "bg-amber-50 text-amber-700 border-amber-200" },
};

export default function PurchasingDashboard() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [exclusionModalOpen, setExclusionModalOpen] = useState(false);
  const [runHistorySearch, setRunHistorySearch] = useState("");

  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ["/api/purchasing/dashboard"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: autoDraftRunHistory } = useQuery<AutoDraftRunHistoryResponse>({
    queryKey: ["/api/purchasing/auto-draft/runs?limit=5"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: landedCostHealth } = useQuery<LandedCostHealth>({
    queryKey: ["/api/procurement/landed-cost-health"],
    queryFn: async () => {
      const res = await fetch("/api/procurement/landed-cost-health?limit=25", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch landed cost health");
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: supplierSetupGaps } = useQuery<SupplierSetupGaps>({
    queryKey: ["/api/purchasing/supplier-setup-gaps"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: forecastInputGaps } = useQuery<ForecastInputGapDiagnostics>({
    queryKey: ["/api/purchasing/forecast-input-gaps?limit=5"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: staleAutoDraftPos } = useQuery<StaleAutoDraftPoDiagnostics>({
    queryKey: ["/api/purchasing/auto-draft/stale-pos?limit=25"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: procurementHealth } = useQuery<ProcurementHealthSummary>({
    queryKey: ["/api/procurement/health"],
    queryFn: async () => {
      const res = await fetch("/api/procurement/health?limit=25", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch procurement health");
      return res.json();
    },
    refetchInterval: 5 * 60 * 1000,
  });

  // Feature flag: when new PO editor is enabled, draft "Review" buttons
  // should open the inline editor (/edit) instead of the old detail page.
  const { data: procurementSettings } = useQuery<{ useNewPoEditor?: boolean }>({
    queryKey: ["/api/settings/procurement"],
    staleTime: 60_000,
  });
  const useNewPoEditor = procurementSettings?.useNewPoEditor === true;

  const runAutoDraftMutation = useMutation({
    mutationFn: async (): Promise<{ runId: number; interruptedRunIds: number[] }> => {
      const res = await fetch("/api/purchasing/auto-draft/run", { method: "POST" });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Failed to trigger auto-draft");
      return payload;
    },
    onSuccess: (started) => {
      toast({ title: "Auto-draft started", description: `Run ${started.runId} has an active processing lease.` });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/runs?limit=5"] });
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/runs?limit=5"] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/supplier-setup-gaps"] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/forecast-input-gaps?limit=5"] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/stale-pos?limit=25"] });
      }, 15000);
    },
    onError: (err: Error) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

  const sentOrAcked = data.inFlightPos.filter((po) => ["sent", "acknowledged"].includes(po.status));
  const partialOrIncoming = data.inFlightPos.filter((po) => ["partially_received"].includes(po.status));

  // Build delivery timeline (next 7 days)
  const timelineDays: Array<{ label: string; pos: typeof data.inFlightPos }> = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    const label = i === 0
      ? `Today · ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
      : i === 1
      ? `Tomorrow · ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`
      : d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    const dayPOs = data.inFlightPos.filter((po) => {
      if (!po.expectedDeliveryDate) return false;
      return po.expectedDeliveryDate.split("T")[0] === dateStr;
    });
    timelineDays.push({ label, pos: dayPOs });
  }

  const health = data.healthBreakdown;
  const showLandedCostHealth = landedCostHealth && landedCostHealth.status !== "healthy";
  const landedCostCounts = landedCostHealth
    ? [
        { label: "Allocation blockers", value: landedCostHealth.counts.allocationBlockers },
        { label: "Allocation warnings", value: landedCostHealth.counts.allocationWarnings },
        { label: "Needs finalization", value: landedCostHealth.counts.pendingFinalization },
        { label: "Ready to push", value: landedCostHealth.counts.finalizedNotPushed },
        { label: "Stale provisional lots", value: landedCostHealth.counts.staleProvisionalLots },
      ]
    : [];
  const showSupplierSetupGaps = Boolean(supplierSetupGaps?.totalGapItems);
  const supplierGapCounts = supplierSetupGaps
    ? [
        { label: "No vendor", value: supplierSetupGaps.counts.missingVendor },
        { label: "Missing cost", value: supplierSetupGaps.counts.missingSupplierCost },
        { label: "Verify cost", value: supplierSetupGaps.counts.lastPurchaseCost + supplierSetupGaps.counts.staleSupplierCost + supplierSetupGaps.counts.unverifiedSupplierCost },
        { label: "Lead time", value: supplierSetupGaps.counts.defaultLeadTime + supplierSetupGaps.counts.productLeadTimeFallback },
      ]
    : [];
  const showForecastInputGaps = Boolean(forecastInputGaps?.totalIssueItems);
  const forecastGapCounts = forecastInputGaps
    ? Object.entries(forecastInputGaps.gapCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([label, value]) => ({ label: formatGapCode(label), value }))
    : [];
  const showStaleAutoDraftPos = Boolean(staleAutoDraftPos?.totalStale);
  const showProcurementHealth = Boolean(procurementHealth && procurementHealth.status !== "healthy");
  const staleAutoDraftPoCounts = staleAutoDraftPos
    ? [
        { label: "Review", value: staleAutoDraftPos.counts.reviewPending + staleAutoDraftPos.counts.exceptionBlocked },
        { label: "Supplier", value: staleAutoDraftPos.counts.supplierSendPending + staleAutoDraftPos.counts.supplierFollowupPending },
        { label: "Receiving", value: staleAutoDraftPos.counts.receivingPending },
        { label: "AP", value: staleAutoDraftPos.counts.apCloseoutPending + staleAutoDraftPos.counts.closeoutPending },
      ]
    : [];
  const recentAutoDraftRuns = autoDraftRunHistory?.runs ?? [];
  // This only controls button availability. The API claim transaction remains authoritative.
  const autoDraftRunActive = autoDraftRunHasActiveLease(data.lastAutoDraftRun);
  const normalizedRunHistorySearch = runHistorySearch.trim().toLowerCase();
  const visibleAutoDraftRuns = normalizedRunHistorySearch
    ? recentAutoDraftRuns.filter((run) => autoDraftRunSearchText(run).includes(normalizedRunHistorySearch))
    : recentAutoDraftRuns;
  const lastRunForecastDiagnostics = data.lastAutoDraftRun?.summaryJson?.forecastDiagnostics ?? null;
  const lastRunApprovalDiagnostics = data.lastAutoDraftRun?.summaryJson?.approvalPolicyDiagnostics ?? null;

  return (
    <div className="flex flex-col h-full">
      {/* Topbar */}
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 sticky top-0 z-10 px-4 py-3 md:px-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-lg md:text-xl font-bold tracking-tight flex items-center gap-2">
              <LayoutDashboard className="h-5 w-5" />
              Purchasing Dashboard
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">Procurement Command Center · {today}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setExclusionModalOpen(true)}>
              <Filter className="h-3.5 w-3.5 mr-1.5" />
              Exclusions
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate("/reorder-analysis")}>
              <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
              Reorder Analysis
            </Button>
            <Button size="sm" onClick={() => navigate("/purchase-orders")}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New PO
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-5">
        {/* Alert Banner */}
        {(data.lastAutoDraftRun && (data.draftPoCount > 0 || data.lastAutoDraftRun.skippedNoVendor > 0)) && (
          <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 flex items-center gap-4 text-sm">
            <span className="text-lg flex-shrink-0">🤖</span>
            <div className="flex-1">
              <strong className="text-amber-700">Nightly Auto-Draft Ready</strong>
              <p className="text-muted-foreground text-xs mt-0.5">
                Job ran {data.lastAutoDraftRun ? formatRelativeTime(data.lastAutoDraftRun.runAt) : "N/A"} ·{" "}
                {data.lastAutoDraftRun.posCreated} POs created with {data.lastAutoDraftRun.linesAdded} items
                {data.lastAutoDraftRun.skippedNoVendor > 0 && (
                  <> · ⚠️ {data.lastAutoDraftRun.skippedNoVendor} items skipped — no preferred vendor</>
                )}
              </p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <Button variant="outline" size="sm" className="bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100" onClick={() => navigate("/purchase-orders?status=draft")}>
                Review Drafts →
              </Button>
              <Button variant="ghost" size="sm" onClick={() => navigate("/reorder-analysis")}>View Skipped</Button>
            </div>
          </div>
        )}

        {showProcurementHealth && procurementHealth && (
          <Card className={procurementHealthClass(procurementHealth.status)}>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-full p-1.5 ${procurementHealth.status === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">Procurement Health Monitor</h2>
                      <Badge variant={procurementHealth.status === "critical" ? "destructive" : "outline"} className="text-[10px] uppercase">
                        {procurementHealth.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {procurementHealth.critical} critical / {procurementHealth.warning} warning across {procurementHealth.total} active signal{procurementHealth.total === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Existing purchasing guardrails rolled into one status so autopilot drift is visible before it affects inventory or financial reporting.
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="self-start lg:self-center" onClick={() => navigate("/purchase-orders")}>
                  Open Work Queues
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {procurementHealth.sources.map((source) => (
                  <button
                    key={source.key}
                    type="button"
                    className="rounded-md border bg-background/90 p-3 text-left hover:bg-background"
                    onClick={() => navigate(source.href)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {source.status === "healthy" ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : (
                          <AlertTriangle className={`h-4 w-4 ${source.status === "critical" ? "text-red-600" : "text-amber-600"}`} />
                        )}
                        <span className="text-sm font-medium">{source.label}</span>
                      </div>
                      <Badge variant={source.status === "critical" ? "destructive" : "outline"} className="text-[10px] uppercase">
                        {source.status}
                      </Badge>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{source.detail}</div>
                    <div className="mt-2 flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">
                        {source.critical} critical / {source.warning} warning
                      </span>
                      <span className="text-primary font-medium">{source.actionLabel}</span>
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {showForecastInputGaps && forecastInputGaps && (
          <Card className="border-amber-300 bg-amber-50/40">
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-full bg-amber-100 p-1.5 text-amber-700">
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">Forecast Input Gaps</h2>
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {forecastInputGaps.reviewItems} review / {forecastInputGaps.watchItems} watch
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {forecastInputGaps.totalIssueItems} affected of {forecastInputGaps.totalRecommendations} recommendations
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Live source-data gaps behind forecast trust so backfill work can target the real missing inputs.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start lg:self-center"
                  onClick={() => navigate("/reorder-analysis?reviewQueue=quality_review_required&reason=forecast_trust_review")}
                >
                  Review Forecasts
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-md border bg-background/90 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Action Queues</div>
                  <div className="space-y-2">
                    {(forecastInputGaps.actions ?? []).slice(0, 4).map((action) => (
                      <button
                        key={action.code}
                        type="button"
                        onClick={() => navigate(action.href)}
                        className={`w-full rounded-md border p-2 text-left text-xs transition-colors ${forecastActionClass(action.severity)}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-semibold">{action.label}</span>
                          <span className="font-mono text-[11px]">{action.count}</span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-[11px] opacity-80">{action.detail}</div>
                      </button>
                    ))}
                    {forecastGapCounts.length > 0 && (
                      <div className="border-t pt-2 text-[11px] text-muted-foreground">
                        Top missing field: {forecastGapCounts[0].label} ({forecastGapCounts[0].value})
                      </div>
                    )}
                  </div>
                </div>
                <div className="rounded-md border bg-background/90 p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Top Samples</div>
                  <div className="space-y-2">
                    {forecastInputGaps.samples.slice(0, 3).map((sample) => (
                      <div key={sample.recommendationId} className="rounded border bg-muted/30 p-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono font-semibold">{sample.sku}</span>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {sample.forecastTrustSeverity}
                          </Badge>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{sample.action.detail}</p>
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="mt-1 h-auto p-0 text-[11px] text-amber-700"
                          onClick={() => navigate(sample.action.href)}
                        >
                          {sample.action.label}
                          <ArrowRight className="ml-1 h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {showLandedCostHealth && landedCostHealth && (
          <Card className={landedCostHealth.status === "critical" ? "border-red-300 bg-red-50/40" : "border-amber-300 bg-amber-50/40"}>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-full p-1.5 ${landedCostHealth.status === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                    <AlertTriangle className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">Landed Cost Health</h2>
                      <Badge variant={landedCostHealth.status === "critical" ? "destructive" : "outline"} className="text-[10px] uppercase">
                        {landedCostHealth.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {landedCostHealth.critical} critical / {landedCostHealth.warning} warning across {landedCostHealth.scannedShipments} shipments
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Inbound costs need attention before receiving history, lots, and financial reporting can be treated as final.
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="self-start lg:self-center" onClick={() => navigate("/shipments")}>
                  Open Inbound
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                {landedCostCounts.map((row) => (
                  <div key={row.label} className="rounded-md border bg-background/80 p-2">
                    <div className="text-lg font-bold">{row.value}</div>
                    <div className="text-[10px] text-muted-foreground">{row.label}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                {landedCostHealth.items.slice(0, 3).map((item) => (
                  <div key={item.id} className="flex flex-col gap-2 rounded-md border bg-background/90 p-2.5 md:flex-row md:items-center">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={item.severity === "critical" ? "destructive" : "outline"} className="text-[10px]">
                          {formatHealthType(item.type)}
                        </Badge>
                        <span className="font-mono text-[11px] text-primary font-semibold">
                          {item.shipmentNumber ?? `Shipment ${item.shipmentId}`}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{item.shipmentStatus}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 truncate">{item.detail}</div>
                    </div>
                    <Button size="sm" variant="outline" className="text-[11px] h-7 flex-shrink-0" onClick={() => navigate(`/shipments/${item.shipmentId}`)}>
                      Review
                    </Button>
                  </div>
                ))}
                {landedCostHealth.items.length > 3 && (
                  <Button variant="ghost" size="sm" className="text-[11px] text-muted-foreground h-7" onClick={() => navigate("/shipments")}>
                    + {landedCostHealth.items.length - 3} more landed-cost health items
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {showSupplierSetupGaps && supplierSetupGaps && (
          <Card className={supplierSetupGaps.counts.blockedRecommendations > 0 ? "border-red-300 bg-red-50/30" : "border-amber-300 bg-amber-50/30"}>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-full p-1.5 ${supplierSetupGaps.counts.blockedRecommendations > 0 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                    <Package className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">Supplier Setup Gaps</h2>
                      <Badge variant={supplierSetupGaps.counts.blockedRecommendations > 0 ? "destructive" : "outline"} className="text-[10px] uppercase">
                        {supplierSetupGaps.totalGapItems} items
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {supplierSetupGaps.counts.blockedRecommendations} blocked / {supplierSetupGaps.counts.reviewRecommendations} review from current recommendations
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Fix supplier data before trusting auto-draft output for these SKUs.
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="self-start lg:self-center" onClick={() => navigate("/suppliers")}>
                  Open Suppliers
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {supplierGapCounts.map((row) => (
                  <div key={row.label} className="rounded-md border bg-background/80 p-2">
                    <div className="text-lg font-bold">{row.value}</div>
                    <div className="text-[10px] text-muted-foreground">{row.label}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                {supplierSetupGaps.items.slice(0, 4).map((item) => (
                  <div key={item.recommendationId} className="flex flex-col gap-2 rounded-md border bg-background/90 p-2.5 md:flex-row md:items-center">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={item.blocksCurrentRecommendation ? "destructive" : "outline"} className="text-[10px]">
                          {item.gaps[0]?.label ?? "Supplier setup"}
                        </Badge>
                        <span className="font-mono text-[11px] text-primary font-semibold">{item.sku}</span>
                        <span className="text-[10px] text-muted-foreground truncate">
                          {item.preferredVendorName ?? "No preferred vendor"}
                        </span>
                        {item.candidateScore ? (
                          <span className="text-[10px] text-muted-foreground">
                            score {item.candidateScore.score}
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 truncate">{item.productName}</div>
                      <div className="text-[11px] text-muted-foreground mt-1 line-clamp-1">
                        {item.gaps[0]?.detail}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" className="text-[11px] h-7 flex-shrink-0" onClick={() => navigate(item.action.href)}>
                      {item.action.label}
                    </Button>
                  </div>
                ))}
                {supplierSetupGaps.items.length > 4 && (
                  <Button variant="ghost" size="sm" className="text-[11px] text-muted-foreground h-7" onClick={() => navigate("/reorder-analysis")}>
                    + {supplierSetupGaps.items.length - 4} more supplier setup items
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {showStaleAutoDraftPos && staleAutoDraftPos && (
          <Card className={staleAutoDraftPos.counts.critical > 0 ? "border-red-300 bg-red-50/30" : "border-amber-300 bg-amber-50/30"}>
            <CardContent className="p-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 rounded-full p-1.5 ${staleAutoDraftPos.counts.critical > 0 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                    <Clock className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">Stale Auto-Draft POs</h2>
                      <Badge variant={staleAutoDraftPos.counts.critical > 0 ? "destructive" : "outline"} className="text-[10px] uppercase">
                        {staleAutoDraftPos.totalStale} stale
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {staleAutoDraftPos.counts.critical} critical / {staleAutoDraftPos.counts.warning} warning
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Auto-created POs that aged past review, supplier, receiving, or AP thresholds.
                    </p>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="self-start lg:self-center" onClick={() => navigate("/purchase-orders")}>
                  Open POs
                  <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
                </Button>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {staleAutoDraftPoCounts.map((row) => (
                  <div key={row.label} className="rounded-md border bg-background/80 p-2">
                    <div className="text-lg font-bold">{row.value}</div>
                    <div className="text-[10px] text-muted-foreground">{row.label}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                {staleAutoDraftPos.items.slice(0, 4).map((item) => (
                  <div key={item.id} className="flex flex-col gap-2 rounded-md border bg-background/90 p-2.5 md:flex-row md:items-center">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] ${stalePoSeverityClass(item.severity)}`}>
                          {item.stageLabel}
                        </Badge>
                        <span className="font-mono text-[11px] text-primary font-semibold">{item.poNumber}</span>
                        <span className="text-[10px] text-muted-foreground truncate">{item.vendorName ?? "No vendor"}</span>
                        <span className="text-[10px] text-muted-foreground">{item.ageDays}d</span>
                        {item.totalCents != null && <span className="text-[10px] text-muted-foreground">{formatCents(item.totalCents)}</span>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 truncate">{item.detail}</div>
                      <div className="text-[11px] text-muted-foreground mt-1 truncate">
                        {formatPoTrack(item.physicalStatus)} / {formatPoTrack(item.financialStatus)}
                        {item.expectedDeliveryDate ? ` - ETA ${formatDate(item.expectedDeliveryDate)}` : ""}
                        {item.openExceptionCount > 0 ? ` - ${item.openExceptionCount} open exception${item.openExceptionCount === 1 ? "" : "s"}` : ""}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" className="text-[11px] h-7 flex-shrink-0" onClick={() => navigate(item.action.href)}>
                      {item.action.label}
                    </Button>
                  </div>
                ))}
                {staleAutoDraftPos.items.length > 4 && (
                  <Button variant="ghost" size="sm" className="text-[11px] text-muted-foreground h-7" onClick={() => navigate("/purchase-orders")}>
                    + {staleAutoDraftPos.items.length - 4} more stale auto-draft POs
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* KPI Cards */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Inventory Status · {health.total} Active SKUs</span>
            <a className="text-xs text-primary cursor-pointer hover:underline" onClick={() => navigate("/reorder-analysis")}>View full analysis →</a>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            <Card className="border-t-2 border-t-red-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/reorder-analysis?status=stockout")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-red-500">{data.stockouts}</div>
                <div className="text-xs text-muted-foreground">Stockouts</div>
                <div className="text-[10px] text-muted-foreground mt-1">No open PO ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-orange-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/reorder-analysis?status=order_now")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-orange-500">{data.orderNow}</div>
                <div className="text-xs text-muted-foreground">Order Now</div>
                <div className="text-[10px] text-muted-foreground mt-1">Below reorder pt ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-amber-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/purchase-orders?status=draft")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-amber-600">{data.draftPoCount}</div>
                <div className="text-xs text-muted-foreground">Draft POs</div>
                <div className="text-[10px] text-muted-foreground mt-1">Awaiting review ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-blue-500 cursor-pointer hover:shadow-sm" onClick={() => navigate("/purchase-orders?status=sent")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-blue-500">{data.inTransitCount}</div>
                <div className="text-xs text-muted-foreground">In Transit</div>
                <div className="text-[10px] text-muted-foreground mt-1">Sent / acked ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-green-600 cursor-pointer hover:shadow-sm" onClick={() => navigate("/purchase-orders")}>
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-green-700">{formatCents(data.openPoValueCents)}</div>
                <div className="text-xs text-muted-foreground">Open PO Value</div>
                <div className="text-[10px] text-muted-foreground mt-1">All open POs ↗</div>
              </CardContent>
            </Card>
            <Card className="border-t-2 border-t-slate-400 cursor-pointer hover:shadow-sm">
              <CardContent className="p-3">
                <div className="text-2xl font-bold text-muted-foreground">{data.noVendorCount}</div>
                <div className="text-xs text-muted-foreground">No Vendor</div>
                <div className="text-[10px] text-muted-foreground mt-1">Fix assignments ↗</div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Workflow Steps */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Today's Workflow</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {/* Step 1: Review & Send Drafts */}
            <Card className={data.draftPoCount > 0 ? "border-t-2 border-t-orange-500" : ""}>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${data.draftPoCount > 0 ? "bg-orange-500 text-white" : "bg-muted text-muted-foreground border"}`}>1</div>
                <h3 className="text-xs font-semibold">Review &amp; Send Drafts</h3>
                <span className="text-[10px] text-muted-foreground ml-auto">{data.draftPoCount} ready</span>
              </div>
              <CardContent className="p-3 space-y-2">
                {data.draftPos.slice(0, 3).map((po) => (
                  <div key={po.id} className="flex items-center gap-2 p-2 bg-muted/50 border rounded-md text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[11px] text-primary font-semibold">{po.poNumber}</div>
                      <div className="text-xs font-medium mt-0.5">{po.vendorName}</div>
                      <div className="text-[10px] text-muted-foreground">{po.lineCount} items · {po.source === "auto_draft" ? "Auto-draft" : "Manual"}</div>
                    </div>
                    {po.totalCents != null && po.totalCents > 0 && (
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-bold">{formatCents(po.totalCents)}</div>
                        <div className="text-[10px] text-muted-foreground">estimated</div>
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-[11px] h-7 bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100 flex-shrink-0"
                      onClick={() => navigate(
                        useNewPoEditor && !isImmutableRecommendationPurchaseOrder(po)
                          ? `/purchase-orders/${po.id}/edit`
                          : `/purchase-orders/${po.id}`,
                      )}
                    >
                      Review
                    </Button>
                  </div>
                ))}
                {data.draftPos.length > 3 && (
                  <div className="text-[10px] text-muted-foreground">+{data.draftPos.length - 3} more</div>
                )}

                {data.stockoutItems.length > 0 && (
                  <>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground pt-1">Stockouts — manual PO needed</div>
                    {data.stockoutItems.map((item) => (
                      <div key={item.productId} className="flex items-center gap-2 p-1.5 bg-red-50 border border-red-200 rounded-md">
                        <span className="font-mono text-[10px] text-red-600 font-semibold w-[120px] flex-shrink-0 truncate">{item.sku}</span>
                        <span className="text-xs flex-1 truncate">{item.productName}</span>
                        <span className="text-[10px] text-red-600 font-bold flex-shrink-0">0 pcs</span>
                        <Button size="sm" variant="outline" className="text-[10px] h-6 px-2 bg-red-50 border-red-300 text-red-600 hover:bg-red-100 flex-shrink-0" onClick={() => navigate(`/purchase-orders`)}>
                          + Create PO
                        </Button>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Step 2: Awaiting Shipment */}
            <Card>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-muted text-muted-foreground border">2</div>
                <h3 className="text-xs font-semibold">Awaiting Shipment</h3>
                <span className="text-[10px] text-muted-foreground ml-auto">{sentOrAcked.length} POs</span>
              </div>
              <CardContent className="p-3 space-y-2">
                {sentOrAcked.map((po) => {
                  const badge = STATUS_BADGE[po.status] || STATUS_BADGE.draft;
                  return (
                    <div key={po.id} className="bg-muted/50 border rounded-md p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-primary font-semibold">{po.poNumber}</span>
                        <Badge variant="outline" className={`text-[10px] ${badge.className}`}>{badge.label}</Badge>
                      </div>
                      <div className="text-sm font-semibold mt-1">{po.vendorName}</div>
                      <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                        <span>{po.lineCount} items</span>
                        {po.totalCents != null && <span>{formatCents(po.totalCents)}</span>}
                      </div>
                      {po.expectedDeliveryDate && (
                        <div className="text-[11px] mt-1.5 flex items-center gap-1">
                          <span className="text-muted-foreground">ETA</span>
                          <span className="font-medium">{formatDate(po.expectedDeliveryDate)}</span>
                        </div>
                      )}
                      <div className="h-[3px] bg-border rounded mt-2">
                        <div className="h-full rounded bg-blue-500" style={{ width: "0%" }} />
                      </div>
                    </div>
                  );
                })}
                {sentOrAcked.length === 0 && (
                  <div className="text-xs text-muted-foreground text-center py-4">No POs awaiting shipment</div>
                )}
              </CardContent>
            </Card>

            {/* Step 3: Receive Stock */}
            <Card>
              <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30">
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-muted text-muted-foreground border">3</div>
                <h3 className="text-xs font-semibold">Receive Stock</h3>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {data.inFlightPos.length} arriving soon
                </span>
              </div>
              <CardContent className="p-3 space-y-2">
                {data.inFlightPos.slice(0, 3).map((po) => {
                  const badge = STATUS_BADGE[po.status] || STATUS_BADGE.draft;
                  const pct = po.lineCount > 0 ? Math.round((po.receivedLineCount / po.lineCount) * 100) : 0;
                  return (
                    <div key={po.id} className="bg-muted/50 border rounded-md p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-primary font-semibold">{po.poNumber}</span>
                        <Badge variant="outline" className={`text-[10px] ${badge.className}`}>{badge.label}</Badge>
                      </div>
                      <div className="text-sm font-semibold mt-1">{po.vendorName}</div>
                      <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                        <span>{po.receivedLineCount} of {po.lineCount} lines</span>
                        {po.totalCents != null && <span>{formatCents(po.totalCents)}</span>}
                      </div>
                      {po.expectedDeliveryDate && (
                        <div className="text-[11px] mt-1.5 flex items-center gap-1">
                          <span className="text-muted-foreground">{po.status === "partially_received" ? "Remainder ETA" : "ETA"}</span>
                          <span className="font-medium">{formatDate(po.expectedDeliveryDate)}</span>
                        </div>
                      )}
                      <div className="h-[3px] bg-border rounded mt-2">
                        <div className={`h-full rounded ${pct > 0 ? "bg-orange-500" : "bg-blue-500"}`} style={{ width: `${Math.max(pct, pct > 0 ? 5 : 0)}%` }} />
                      </div>
                    </div>
                  );
                })}
                <Button variant="outline" size="sm" className="w-full text-xs justify-center bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100" onClick={() => navigate("/receiving")}>
                  <Truck className="h-3 w-3 mr-1.5" />
                  Open Receiving
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Two Column: Action Queue + Timeline */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-3">
          {/* Left: Action Queue */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Full Action Queue</span>
              <a className="text-xs text-primary cursor-pointer hover:underline" onClick={() => navigate("/reorder-analysis")}>Reorder Analysis →</a>
            </div>
            <Card className="overflow-hidden">
              {/* Order Now */}
              <div className="border-b p-4">
                <div className="flex items-center gap-2 mb-3">
                  <h4 className="text-xs font-semibold">Order Now — Below Reorder Point</h4>
                  <Badge variant="outline" className="text-[10px] bg-orange-50 text-orange-600 border-orange-200">{data.orderNowItems.length}</Badge>
                </div>
                <div className="space-y-1.5">
                  {data.orderNowItems.slice(0, 6).map((item) => (
                    <div key={item.productId} className="flex items-center gap-2 p-1.5 border rounded-md text-sm">
                      <span className="font-mono text-[11px] text-primary w-[140px] flex-shrink-0 truncate">{item.sku}</span>
                      <span className="text-xs flex-1 truncate">{item.productName}</span>
                      <span className={`text-[11px] font-bold w-9 text-right flex-shrink-0 ${item.daysOfSupply < 7 ? "text-red-500" : item.daysOfSupply < 14 ? "text-orange-500" : ""}`}>{item.daysOfSupply}d</span>
                      <Button size="sm" variant="outline" className="text-[10px] h-6 px-2 bg-orange-50 border-orange-200 text-orange-600 hover:bg-orange-100 flex-shrink-0" onClick={() => navigate("/purchase-orders")}>
                        + PO
                      </Button>
                    </div>
                  ))}
                </div>
                {data.orderNowItems.length > 6 && (
                  <div className="pt-2">
                    <Button variant="ghost" size="sm" className="text-[10px] text-muted-foreground h-6" onClick={() => navigate("/reorder-analysis?status=order_now")}>
                      + {data.orderNowItems.length - 6} more items
                    </Button>
                  </div>
                )}
              </div>

              {/* No Vendor */}
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <h4 className="text-xs font-semibold">No Preferred Vendor Assigned</h4>
                  <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">{data.noVendorItems.length}</Badge>
                </div>
                <div className="space-y-1.5">
                  {data.noVendorItems.map((item) => (
                    <div key={item.productId} className="flex items-center gap-2 p-1.5 border rounded-md">
                      <span className="font-mono text-[11px] text-muted-foreground w-[140px] flex-shrink-0 truncate">{item.sku}</span>
                      <span className="text-xs flex-1">{item.productName}</span>
                      <span className="text-[11px] text-muted-foreground flex-shrink-0">{item.totalOnHand} remaining</span>
                      <Button variant="ghost" size="sm" className="text-[10px] h-6 px-2 flex-shrink-0 ml-auto" onClick={() => navigate("/suppliers")}>
                        Assign →
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          {/* Right: Delivery Timeline */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Delivery Timeline</span>
              <a className="text-xs text-primary cursor-pointer hover:underline" onClick={() => navigate("/purchase-orders")}>All POs →</a>
            </div>
            <Card>
              <CardContent className="p-3 space-y-3">
                {timelineDays.map((day, i) => (
                  <div key={i}>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{day.label}</div>
                    {day.pos.length > 0 ? (
                      day.pos.map((po) => (
                        <div key={po.id} className={`flex items-center gap-2 p-2 bg-muted/50 rounded-md border-l-[3px] ${i <= 1 ? "border-l-orange-500" : "border-l-blue-500"}`}>
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-[10px] text-primary">{po.poNumber}</div>
                            <div className="text-xs truncate">{po.vendorName}</div>
                          </div>
                          <span className="text-[10px] text-muted-foreground flex-shrink-0">{po.lineCount} items</span>
                          {(i <= 1) && (
                            <Button size="sm" variant="outline" className="text-[10px] h-6 px-2 bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 flex-shrink-0" onClick={() => navigate("/receiving")}>
                              Receive
                            </Button>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="text-xs text-muted-foreground/60 py-1 px-2">No deliveries expected</div>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Metrics Row */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Metrics</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {/* Inventory Health */}
            <Card className="p-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Inventory Health · {health.total} SKUs</h4>
              <div className="space-y-2">
                {[
                  { label: "Stockout", count: health.stockout, color: "bg-red-500", textColor: "text-red-500" },
                  { label: "Order Now", count: health.order_now, color: "bg-orange-500", textColor: "text-orange-500" },
                  { label: "Order Soon", count: health.order_soon, color: "bg-amber-500", textColor: "text-amber-600" },
                  { label: "OK", count: health.ok, color: "bg-green-500", textColor: "text-green-600" },
                  { label: "No Movement", count: health.no_movement, color: "bg-slate-400", textColor: "text-slate-400" },
                ].map((row) => (
                  <div key={row.label} className="flex items-center gap-2">
                    <span className={`text-xs w-[90px] flex-shrink-0 ${row.textColor}`}>● {row.label}</span>
                    <div className="flex-1 h-[5px] bg-border rounded">
                      <div className={`h-full rounded ${row.color}`} style={{ width: `${health.total > 0 ? (row.count / health.total) * 100 : 0}%` }} />
                    </div>
                    <span className={`text-xs font-semibold w-7 text-right ${row.textColor}`}>{row.count}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Spend */}
            <Card className="p-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Spend · Last 30 Days</h4>
              <div className="space-y-2">
                {[
                  { label: "Total received", value: formatCents(data.spend.totalReceivedCents) },
                  { label: "Open PO value", value: formatCents(data.spend.openPoValueCents) },
                  { label: "Avg per PO", value: formatCents(data.spend.avgPoCents) },
                  { label: "Top supplier", value: data.spend.topSupplierName ? `${data.spend.topSupplierName} · ${formatCents(data.spend.topSupplierCents)}` : "—" },
                  { label: "Active suppliers", value: `${data.spend.activeSupplierCount} this month` },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between py-1 border-b last:border-0 text-xs">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className="font-semibold">{row.value}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* Auto-Draft */}
            <Card className="p-4">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">Nightly Auto-Draft</h4>
              {data.lastAutoDraftRun ? (
                <>
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-2 h-2 rounded-full ${autoDraftRunStatusDotClass(data.lastAutoDraftRun.status)}`} />
                    <span className="text-xs">
                      Last run: {formatRelativeTime(data.lastAutoDraftRun.runAt)} - {autoDraftRunStatusLabel(data.lastAutoDraftRun.status)}
                    </span>
                  </div>
                  {data.lastAutoDraftRun.errorMessage && data.lastAutoDraftRun.status !== "success" ? (
                    <div className={`mb-3 text-xs ${data.lastAutoDraftRun.status === "interrupted" ? "text-amber-700" : "text-red-600"}`}>
                      {data.lastAutoDraftRun.errorMessage}
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    {[
                      { label: "Items analyzed", value: data.lastAutoDraftRun.itemsAnalyzed },
                      {
                        label: "Mode",
                        value: data.lastAutoDraftRun.summaryJson?.settings?.autoDraftMode === "review_only"
                          ? "Recommendation only"
                          : "Create draft POs",
                      },
                      {
                        label: "Approval policy",
                        value: formatApprovalPolicy(data.lastAutoDraftRun.summaryJson?.settings?.approvalPolicy ?? lastRunApprovalDiagnostics?.policy),
                      },
                      { label: "POs created/updated", value: `${data.lastAutoDraftRun.posCreated}/${data.lastAutoDraftRun.posUpdated}` },
                      { label: "Actionable", value: data.lastAutoDraftRun.summaryJson?.recommendationSummary?.actionableCount ?? data.lastAutoDraftRun.linesAdded },
                      { label: "Eligible to draft", value: data.lastAutoDraftRun.summaryJson?.recommendationSummary?.autoDraftEligibleCount ?? data.lastAutoDraftRun.linesAdded },
                      { label: "Policy approved", value: lastRunApprovalDiagnostics?.approvalPolicyEligibleCount ?? data.lastAutoDraftRun.summaryJson?.recommendationSummary?.autoDraftEligibleCount ?? data.lastAutoDraftRun.linesAdded },
                      { label: "Held by policy", value: lastRunApprovalDiagnostics?.approvalPolicyBlockedCount ?? 0, warn: Boolean(lastRunApprovalDiagnostics?.approvalPolicyBlockedCount) },
                      { label: "Draft mutation eligible", value: lastRunApprovalDiagnostics?.draftMutationEligibleCount ?? data.lastAutoDraftRun.linesAdded },
                      { label: "Needs review", value: data.lastAutoDraftRun.summaryJson?.recommendationSummary?.autoDraftReviewRequiredCount ?? 0 },
                      { label: "Forecast model", value: formatForecastDiagnostics(lastRunForecastDiagnostics) },
                      { label: "Demand trend", value: topCountLabel(lastRunForecastDiagnostics?.demandTrendCounts) },
                      {
                        label: "Demand mix",
                        value: topCountLabel(lastRunForecastDiagnostics?.demandMixSignalCounts),
                        warn: Boolean(
                          lastRunForecastDiagnostics?.totalZeroRevenueDemandPieces ||
                            lastRunForecastDiagnostics?.totalCouponDiscountDemandPieces,
                        ),
                      },
                      { label: "Short-window signal", value: topCountLabel(lastRunForecastDiagnostics?.demandAccelerationSignalCounts) },
                      { label: "Baseline signal", value: topCountLabel(lastRunForecastDiagnostics?.demandBaselineSignalCounts) },
                      { label: "Seasonality signal", value: topCountLabel(lastRunForecastDiagnostics?.demandSeasonalitySignalCounts) },
                      {
                        label: "Forecast trust",
                        value: topCountLabel(lastRunForecastDiagnostics?.forecastTrustSignalCounts),
                        warn: Boolean(
                          lastRunForecastDiagnostics?.forecastTrustReviewCount ||
                            lastRunForecastDiagnostics?.forecastTrustWatchCount,
                        ),
                      },
                      {
                        label: "Forecast input gaps",
                        value: topCountLabel(lastRunForecastDiagnostics?.forecastInputGapCounts),
                        warn: Boolean(Object.keys(lastRunForecastDiagnostics?.forecastInputGapCounts ?? {}).length),
                      },
                      { label: "Supplier cycle", value: topCountLabel(lastRunForecastDiagnostics?.supplierCycleSignalCounts), warn: Boolean(lastRunForecastDiagnostics?.supplierCycleOpenPoPastDueCount) },
                      { label: "Candidate score", value: lastRunForecastDiagnostics?.avgRecommendationCandidateScore ?? "n/a" },
                      { label: "Candidate band", value: topCountLabel(lastRunForecastDiagnostics?.recommendationCandidateBandCounts) },
                      { label: "Top quality blocker", value: topCountLabel(lastRunForecastDiagnostics?.autopilotBlockerCounts), warn: Boolean(lastRunForecastDiagnostics?.autopilotBlockerItemCount) },
                      { label: "Blocked items", value: lastRunForecastDiagnostics?.autopilotBlockerItemCount ?? 0, warn: Boolean(lastRunForecastDiagnostics?.autopilotBlockerItemCount) },
                      { label: "Skipped (no vendor)", value: data.lastAutoDraftRun.skippedNoVendor, warn: true },
                      { label: "Skipped (on order)", value: data.lastAutoDraftRun.skippedOnOrder },
                      { label: "Excluded SKUs", value: data.lastAutoDraftRun.skippedExcluded },
                      { label: "Next run", value: "Tonight 2:00am" },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{row.label}</span>
                        <span className={`font-semibold ${row.warn ? "text-amber-600" : ""}`}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                  {data.lastAutoDraftRun.summaryJson?.actionableRecommendations?.length ? (
                    <div className="mt-3 pt-3 border-t">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Top Recommendation
                      </div>
                      {data.lastAutoDraftRun.summaryJson.actionableRecommendations.slice(0, 1).map((item) => (
                        <div key={item.sku} className="text-xs rounded border bg-muted/30 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold truncate">{item.sku}</span>
                            <span className="text-muted-foreground whitespace-nowrap">
                              {item.suggestedOrderQty} {item.orderUomLabel}
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{item.explanation}</p>
                          <p className="text-[11px] text-muted-foreground mt-1 truncate">
                            {formatRecommendationForecast(item.forecastProvenance, item.supplierCycleDiagnostics, item.recommendationCandidateScore)}
                          </p>
                          {formatQualityControlSummary(item.autopilotBlockers) ? (
                            <p className="text-[11px] text-amber-700 mt-1 truncate">
                              {formatQualityControlSummary(item.autopilotBlockers)}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {data.lastAutoDraftRun.summaryJson?.approvalPolicyBlockedRecommendations?.length ? (
                    <div className="mt-3 pt-3 border-t">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                        Held By Approval Policy
                      </div>
                      {data.lastAutoDraftRun.summaryJson.approvalPolicyBlockedRecommendations.slice(0, 1).map((item) => (
                        <div key={item.sku} className="text-xs rounded border border-amber-200 bg-amber-50/50 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold truncate">{item.sku}</span>
                            <span className="text-amber-700 whitespace-nowrap">
                              {item.suggestedOrderQty} {item.orderUomLabel}
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{item.explanation}</p>
                          {item.recommendationCandidateScore ? (
                            <p className="text-[11px] text-amber-700 mt-1 truncate">
                              Score {item.recommendationCandidateScore.score} - {item.recommendationCandidateScore.band.replace(/_/g, " ")}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {recentAutoDraftRuns.length > 0 ? (
                    <div className="mt-3 pt-3 border-t">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Recent Runs
                        </div>
                        <div className="relative w-40">
                          <Filter className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={runHistorySearch}
                            onChange={(event) => setRunHistorySearch(event.target.value)}
                            placeholder="Search SKU"
                            className="h-7 pl-7 text-[11px]"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        {visibleAutoDraftRuns.slice(0, 5).map((run) => (
                          <div key={run.id} className="rounded border bg-muted/20 p-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`h-2 w-2 rounded-full flex-shrink-0 ${autoDraftRunStatusDotClass(run.status)}`} />
                                <span className="font-medium truncate">{formatRelativeTime(run.runAt)}</span>
                                <span className="text-[11px] text-muted-foreground">{autoDraftRunStatusLabel(run.status)}</span>
                              </div>
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {run.mode === "review_only" ? "Recommendation only" : "Draft POs"} - {formatApprovalPolicy(run.approvalPolicy)}
                              </span>
                            </div>
                            <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                              <span>{run.itemsAnalyzed} analyzed</span>
                              <span>{run.autoDraftEligibleCount} eligible</span>
                              <span>{run.approvalPolicyEligibleCount} policy-approved</span>
                              <span className={run.approvalPolicyBlockedCount > 0 ? "text-amber-700" : ""}>
                                {run.approvalPolicyBlockedCount} held
                              </span>
                            </div>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {run.posCreated + run.posUpdated} PO changes - {run.draftMutationEligibleCount} draft-mutation eligible
                            </div>
                            <div className="mt-1 truncate text-[11px] text-muted-foreground">
                              {formatForecastDiagnostics(run.forecastDiagnostics)}
                            </div>
                            {run.topApprovalPolicyBlockedRecommendation ? (
                              <div className="mt-1 truncate text-[11px] text-amber-700">
                                Held: <span className="font-mono font-semibold">{run.topApprovalPolicyBlockedRecommendation.sku}</span>
                                <span> - score {run.topApprovalPolicyBlockedRecommendation.recommendationCandidateScore?.score ?? "n/a"}</span>
                              </div>
                            ) : null}
                            {run.recommendationSamples?.approvalPolicyBlocked?.slice(1, 3).map((item) => (
                              <div key={`held-${run.id}-${item.sku}`} className="mt-1 truncate text-[11px] text-amber-700">
                                Held: <span className="font-mono font-semibold">{item.sku}</span>
                                <span> - score {item.recommendationCandidateScore?.score ?? "n/a"}</span>
                              </div>
                            ))}
                            {run.topActionableRecommendation ? (
                              <div className="mt-1 truncate text-[11px]">
                                <span className="font-mono font-semibold text-primary">{run.topActionableRecommendation.sku}</span>
                                <span className="text-muted-foreground"> · {run.topActionableRecommendation.suggestedOrderQty} {run.topActionableRecommendation.orderUomLabel}</span>
                                {formatQualityControlSummary(run.topActionableRecommendation.autopilotBlockers) ? (
                                  <span className="text-amber-700"> - {formatQualityControlSummary(run.topActionableRecommendation.autopilotBlockers)}</span>
                                ) : null}
                              </div>
                            ) : null}
                            {run.recommendationSamples?.actionable?.slice(1, 3).map((item) => (
                              <div key={`actionable-${run.id}-${item.sku}`} className="mt-1 truncate text-[11px]">
                                Order: <span className="font-mono font-semibold text-primary">{item.sku}</span>
                                <span className="text-muted-foreground"> - {item.suggestedOrderQty ?? "n/a"} {item.orderUomLabel ?? ""}</span>
                              </div>
                            ))}
                            {run.recommendationSamples?.skipped?.slice(0, 2).map((item) => (
                              <div key={`skipped-${run.id}-${item.sku}`} className="mt-1 truncate text-[11px] text-muted-foreground">
                                Skipped: <span className="font-mono font-semibold">{item.sku}</span>
                                {item.skippedReason ? <span> - {item.skippedReason.replace(/_/g, " ")}</span> : null}
                              </div>
                            ))}
                            {run.recommendedActions?.length ? (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {run.recommendedActions.slice(0, 3).map((action) => (
                                  <Button
                                    key={action.action}
                                    variant="outline"
                                    size="sm"
                                    className={`h-7 text-[11px] px-2 ${autoDraftActionClass(action.severity)}`}
                                    title={action.detail}
                                    onClick={() => navigate(action.href)}
                                  >
                                    {action.label}
                                    <ArrowRight className="h-3 w-3 ml-1" />
                                  </Button>
                                ))}
                              </div>
                            ) : null}
                            {(run.status === "error" || run.status === "interrupted") && run.errorMessage ? (
                              <div className={`mt-1 truncate text-[11px] ${run.status === "interrupted" ? "text-amber-700" : "text-red-600"}`}>
                                {run.errorMessage}
                              </div>
                            ) : null}
                          </div>
                        ))}
                        {visibleAutoDraftRuns.length === 0 ? (
                          <div className="rounded border border-dashed bg-muted/10 p-3 text-[11px] text-muted-foreground">
                            No recent runs match this search.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="text-xs text-muted-foreground">Never run</div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-3 text-xs justify-center"
                onClick={() => runAutoDraftMutation.mutate()}
                disabled={runAutoDraftMutation.isPending || autoDraftRunActive}
              >
                <Zap className="h-3 w-3 mr-1.5" />
                {runAutoDraftMutation.isPending || autoDraftRunActive ? "Auto-Draft Running" : "Run Auto-Draft Now"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-1 text-[11px] justify-center text-muted-foreground"
                onClick={() => setExclusionModalOpen(true)}
              >
                ⚙️ Manage Exclusions
              </Button>
            </Card>
          </div>
        </div>
      </div>

      <ExclusionRulesModal open={exclusionModalOpen} onOpenChange={setExclusionModalOpen} />
    </div>
  );
}
