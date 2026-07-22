import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Box,
  BrainCircuit,
  CheckCircle2,
  Clock,
  DollarSign,
  History,
  MoreHorizontal,
  PackageSearch,
  ShoppingCart,
  SlidersHorizontal,
  XCircle
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { reorderAnalysisSearchParams } from "@/features/purchasing/reorderAnalysisDeepLink";
import { ExclusionRulesModal } from "@/components/purchasing/ExclusionRulesModal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface DashboardKPIs {
  criticalRestocks: number;
  upcomingRestocks: number;
  idleCapitalCents: number;
  inboundPipelineValueCents: number;
  totalOpenLines: number;
  lastComputedAt: string;
}

interface RecommendationQualityControl {
  area: "demand" | "lead_time" | "supplier_cost" | "vendor" | "receive_configuration" | "supplier_catalog";
  severity: "review" | "block";
  code: string;
  label: string;
  detail: string;
}

interface ReorderItem {
  productId: number;
  productVariantId?: number;
  sku: string;
  productName: string;
  totalOnHand: number;
  totalReserved: number;
  available: number;
  periodUsage: number;
  avgDailyUsage: number;
  daysOfSupply: number;
  leadTimeDays: number;
  safetyStockDays: number;
  reorderPoint: number;
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  orderUomUnits: number;
  orderUomLabel: string;
  onOrderPieces: number;
  openPoCount: number;
  status: string;
  confidence?: "low" | "medium" | "high";
  confidenceFactors?: string[];
  forecastProvenance?: {
    forecastMethod?: "recent_order_velocity_v1";
    forecastVersion?: number;
    demandSource: "recent_order_velocity";
    demandWindowDays: number;
    demandQuality: "no_recent_demand" | "thin_history" | "normal";
    demandTrend?: "not_available" | "no_recent_demand" | "new_demand" | "rising" | "stable" | "falling";
    periodUsagePieces: number;
    priorPeriodUsagePieces?: number | null;
    avgDailyUsagePieces: number;
    demandOrderCount?: number | null;
    demandActiveDays?: number | null;
    latestDemandAt?: string | null;
    paidDemandPieces?: number | null;
    zeroRevenueDemandPieces?: number | null;
    couponDiscountDemandPieces?: number | null;
    zeroRevenueDemandShare?: number | null;
    couponDiscountDemandShare?: number | null;
    demandMixSignal?: "not_available" | "mostly_paid" | "mixed_discounted_or_free" | "mostly_zero_revenue";
    demandSuppressionRisk?: {
      signal: "none" | "stockout_velocity_suppression" | "low_supply_velocity_suppression";
      severity: "none" | "watch" | "review";
      detail: string;
      constrainedAvailablePieces: number;
      daysOfSupply: number;
    };
    forecastTrust?: {
      signal:
        | "trusted"
        | "no_recent_demand"
        | "stale_recent_demand"
        | "thin_sample"
        | "missing_latest_demand_timestamp"
        | "missing_prior_baseline";
      severity: "ok" | "watch" | "review";
      detail: string;
      latestDemandAgeDays?: number | null;
      staleDemandThresholdDays?: number;
      inputGaps?: string[];
    };
    leadTimeSource: "vendor_product" | "product" | "default";
    safetyStockSource: "product" | "default";
    orderUomSource: "supplier_quote" | "base_piece" | "variant" | "default_each";
    demandWindowDiagnostics?: {
      shortWindow?: {
        lookbackDays?: number;
        periodUsagePieces?: number;
        avgDailyUsagePieces?: number;
        demandQuality?: "no_recent_demand" | "thin_history" | "normal";
        demandTrend?: "not_available" | "no_recent_demand" | "new_demand" | "rising" | "stable" | "falling";
      };
      longWindow?: {
        lookbackDays?: number;
        periodUsagePieces?: number;
        avgDailyUsagePieces?: number;
        demandQuality?: "no_recent_demand" | "thin_history" | "normal";
        demandTrend?: "not_available" | "no_recent_demand" | "new_demand" | "rising" | "stable" | "falling";
      };
      seasonalWindow?: {
        lookbackDays?: number;
        periodUsagePieces?: number;
        avgDailyUsagePieces?: number;
        demandQuality?: "no_recent_demand" | "thin_history" | "normal";
        demandTrend?: "not_available" | "no_recent_demand" | "new_demand" | "rising" | "stable" | "falling";
      };
      accelerationRatio?: number | null;
      accelerationSignal?: "not_available" | "accelerating" | "steady" | "decelerating";
      baselineRatio?: number | null;
      baselineSignal?: "not_available" | "above_baseline" | "near_baseline" | "below_baseline";
      seasonalRatio?: number | null;
      seasonalSignal?: "not_available" | "above_seasonal" | "near_seasonal" | "below_seasonal";
    };
  };
  supplierBasis?: {
    vendorProductId: number | null;
    costSource: "vendor_unit_cost_mills" | "vendor_unit_cost_cents" | "last_purchase_cost" | "missing";
    costQuality: "current" | "stale" | "unverified" | "missing";
    estimatedCostMills: number | null;
    estimatedCostCents: number | null;
    lastCostCents: number | null;
    lastPurchasedAt?: string | null;
    vendorProductUpdatedAt?: string | null;
  };
  supplierCycleDiagnostics?: {
    signal: string;
    detail: string;
    cycleDays: number;
    supplyCoverageRatio: number | null;
    openPoCoverageRatio: number | null;
    daysUntilEarliestExpected: number | null;
    daysSinceLastReceipt: number | null;
  };
  recommendationCandidateScore?: {
    score: number;
    band: string;
    demandScore: number;
    supplyScore: number;
    readinessScore: number;
    signals: string[];
    blockers: string[];
    detail: string;
  };
  qualityControls?: RecommendationQualityControl[];
  autopilotBlockers?: RecommendationQualityControl[];
  actionable?: boolean;
  skippedReason?: string | null;
  explanation?: string;
  reviewSignal?: {
    action: "create_po" | "assign_vendor" | "review_open_po" | "review_exclusion" | "monitor" | "none";
    severity: "critical" | "warning" | "info";
    label: string;
    detail: string;
  };
  qualityGate?: {
    autoDraftEligible: boolean;
    reason:
      | "high_confidence"
      | "medium_confidence_review"
      | "low_confidence_review"
      | "not_actionable"
      | "forecast_trust_review";
    label: string;
    detail: string;
  };
}

type AutoDraftApprovalPolicy = "high_confidence_only" | "high_confidence_and_strong_candidate";

interface ApprovalPolicyImpact {
  policy: AutoDraftApprovalPolicy;
  mode: "draft_po" | "review_only";
  candidateScoreGateActive: boolean;
  qualityGateEligibleCount: number;
  approvalPolicyEligibleCount: number;
  approvalPolicyBlockedCount: number;
  draftMutationEligibleCount: number;
  approvedCandidateBandCounts: Record<string, number>;
  blockedCandidateBandCounts: Record<string, number>;
  heldRecommendations: Array<{
    recommendationId: string;
    productId: number;
    productVariantId: number | null;
    sku: string;
    productName: string;
    suggestedOrderQty: number;
    suggestedOrderPieces: number;
    orderUomUnits: number;
    orderUomLabel: string;
    preferredVendorName: string | null;
    explanation: string;
    recommendationCandidateScore?: ReorderItem["recommendationCandidateScore"];
    qualityGate?: ReorderItem["qualityGate"];
  }>;
}

interface ReorderAnalysis {
  items: ReorderItem[];
  skippedItems: ReorderItem[];
  summary?: {
    actionableCount: number;
    highConfidenceCount: number;
    mediumConfidenceCount: number;
    lowConfidenceCount: number;
    autoDraftEligibleCount: number;
    autoDraftReviewRequiredCount: number;
  };
  approvalPolicyImpact?: ApprovalPolicyImpact;
  lookbackDays: number;
}

type ReviewQueueKind = "all" | "skipped" | "held_by_policy" | "quality_review_required";
type RecommendationDecisionValue = "reviewed" | "accepted_for_po" | "deferred" | "dismissed" | "po_handoff_created";

interface RecommendationDecision {
  id: number;
  recommendationId: string;
  kind: Exclude<ReviewQueueKind, "all">;
  decision: RecommendationDecisionValue;
  status: string;
  decisionReason: string | null;
  note: string | null;
  source: string;
  sku: string | null;
  productName: string | null;
  candidateScore: number | null;
  candidateBand: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string | null;
}

interface RecommendationReviewQueueItem {
  recommendationId: string;
  kind: Exclude<ReviewQueueKind, "all">;
  severity: "critical" | "warning" | "info";
  reason: {
    code: string;
    label: string;
    detail: string;
  };
  action: {
    action: string;
    label: string;
    href: string;
  };
  forecastAction?: {
    code: string;
    label: string;
    detail: string;
    href: string;
    severity: "warning" | "info";
  } | null;
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
  candidateScore?: ReorderItem["recommendationCandidateScore"];
  qualityGate?: ReorderItem["qualityGate"];
  qualityControls?: RecommendationQualityControl[];
  demandEvidence?: {
    lookbackDays: number;
    periodUsagePieces: number;
    priorPeriodUsagePieces: number | null;
    avgDailyUsagePieces: number;
    demandQuality: "no_recent_demand" | "thin_history" | "normal";
    demandTrend: "not_available" | "no_recent_demand" | "new_demand" | "rising" | "stable" | "falling";
    demandOrderCount: number | null;
    demandActiveDays: number | null;
    latestDemandAt: string | null;
    paidDemandPieces: number | null;
    zeroRevenueDemandPieces: number | null;
    couponDiscountDemandPieces: number | null;
    zeroRevenueDemandShare: number | null;
    couponDiscountDemandShare: number | null;
    demandMixSignal: string;
    forecastTrust?: {
      signal: string;
      severity: string;
      detail: string;
      latestDemandAgeDays: number | null;
    };
    demandWindowDiagnostics?: Record<string, unknown>;
  };
  latestDecision?: RecommendationDecision | null;
}

interface RecommendationReviewQueueResponse {
  generatedAt: string;
  lookbackDays: number;
  summary: {
    total: number;
    skipped: number;
    heldByPolicy: number;
    qualityReviewRequired: number;
    critical: number;
    warning: number;
    info: number;
  };
  reasonCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  forecastActionCounts: Record<string, number>;
  candidateBandCounts: Record<string, number>;
  decisionCounts?: {
    reviewed: number;
    acceptedForPo: number;
    poHandoffCreated: number;
    deferred: number;
    dismissed: number;
  };
  filteredCount: number;
  items: RecommendationReviewQueueItem[];
}

interface RfqQueueItem {
  recommendationLineId: number;
  recommendationId: string;
  runId: number;
  productId: number;
  productVariantId: number | null;
  warehouseId: number | null;
  requiredByDate: string | null;
  sku: string;
  productName: string;
  recommendedPieces: number;
  allocatedPieces: number;
  remainingPieces: number;
  excessPieces: number;
  sourcingStatus: "open" | "partially_allocated" | "fully_allocated";
  availablePieces: number;
  onOrderPieces: number;
  reorderPointPieces: number;
  forecastMethod: string;
  forecastDailyPieces: number;
  leadTimeDays: number;
  safetyStockDays: number;
  forwardDemandPieces: number;
  preferredVendorId: number | null;
  preferredVendorName: string | null;
  vendorProductId: number | null;
  supplierAssignmentRequired: boolean;
  allocations: Array<{
    id: number;
    rfqId: number;
    rfqNumber: string;
    rfqStatus: string;
    vendorId: number;
    requestedPieces: number;
    quantityOverrideReason: string | null;
    allocationOverrideReason: string | null;
    allocationOverrideApprovedBy: string | null;
    allocationOverrideApprovedAt: string | null;
    allocationOverrideBaselinePieces: number | null;
    allocationOverrideExcessPieces: number | null;
    lineStatus: string;
    vendorName: string | null;
    createdAt: string;
  }>;
}

interface RfqQueueResponse {
  run: {
    id: number;
    calculationVersion: string;
    source: "manual" | "auto_draft" | "api";
    sourceRunKey: string | null;
    asOf: string;
    policySnapshot: Record<string, unknown>;
  } | null;
  generatedAt: string | null;
  lookbackDays: number | null;
  summary: {
    total: number;
    open: number;
    partiallyAllocated: number;
    fullyAllocated: number;
    supplierAssignmentRequired: number;
    activeRfqs: number;
    aboveRecommendation: number;
    excessPieces: number;
  };
  items: RfqQueueItem[];
}

interface RfqSelection {
  requestedPieces: number;
  vendorId: string;
  vendorSku: string;
  quantityOverrideReason: string;
  allocationOverrideApproved: boolean;
}

interface RfqVendor {
  id: number;
  code: string;
  name: string;
  active: number;
}

interface AcceptedRecommendationQueueItem {
  recommendationId: string;
  kind: Exclude<ReviewQueueKind, "all">;
  decision: RecommendationDecision;
  source: "current_recommendation" | "decision_snapshot";
  current: boolean;
  sku: string | null;
  productName: string | null;
  productId: number | null;
  productVariantId: number | null;
  preferredVendorId: number | null;
  preferredVendorName: string | null;
  vendorProductId: number | null;
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  orderUomUnits: number;
  orderUomLabel: string;
  candidateScore?: ReorderItem["recommendationCandidateScore"] | null;
  statusReason: string;
  action: {
    action: string;
    label: string;
    href: string;
  };
}

interface AcceptedRecommendationQueueResponse {
  generatedAt: string;
  lookbackDays: number;
  summary: {
    total: number;
    current: number;
    stale: number;
    vendorCount: number;
  };
  items: AcceptedRecommendationQueueItem[];
}

interface RecommendationDecisionHistoryResponse {
  generatedAt: string;
  limit: number;
  summary: {
    total: number;
    active: number;
    acceptedForPo: number;
    poHandoffCreated: number;
    deferred: number;
    dismissed: number;
    reviewed: number;
    latestDecidedAt: string | null;
    decisionCounts: Record<string, number>;
    kindCounts: Record<string, number>;
    statusCounts: Record<string, number>;
  };
  decisions: RecommendationDecision[];
}

const STATUS_CONFIG: Record<string, { label: string; bg: string; text: string; icon: any; priority: number }> = {
  stockout: { label: "Stockout Imminent", bg: "bg-red-500/10", text: "text-red-500", icon: AlertTriangle, priority: 0 },
  order_now: { label: "Critical Restock", bg: "bg-orange-500/10", text: "text-orange-500", icon: AlertTriangle, priority: 1 },
  order_soon: { label: "Burn Rate High", bg: "bg-amber-500/10", text: "text-amber-500", icon: Activity, priority: 2 },
  on_order: { label: "Inbound Pipeline", bg: "bg-blue-500/10", text: "text-blue-500", icon: PackageSearch, priority: 2.5 },
  ok: { label: "Healthy", bg: "bg-green-500/10", text: "text-green-500", icon: CheckCircle2, priority: 3 },
  no_movement: { label: "Stagnant", bg: "bg-zinc-500/10", text: "text-zinc-500", icon: Box, priority: 4 },
};

type CandidateBandFilter = "all" | "strong_candidate" | "review_candidate" | "watch" | "blocked";

const CANDIDATE_BAND_OPTIONS: Array<{ value: CandidateBandFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "strong_candidate", label: "Strong" },
  { value: "review_candidate", label: "Review" },
  { value: "watch", label: "Watch" },
  { value: "blocked", label: "Blocked" },
];

const REVIEW_QUEUE_FILTERS: Array<{ value: ReviewQueueKind; label: string }> = [
  { value: "all", label: "All" },
  { value: "skipped", label: "Skipped" },
  { value: "held_by_policy", label: "Policy Holds" },
  { value: "quality_review_required", label: "Quality Review" },
];

function isCandidateBandFilter(value: string | null): value is CandidateBandFilter {
  return CANDIDATE_BAND_OPTIONS.some((option) => option.value === value);
}

function isReviewQueueKind(value: string | null): value is ReviewQueueKind {
  return REVIEW_QUEUE_FILTERS.some((option) => option.value === value);
}

function formatCandidateBand(band?: string | null): string {
  if (!band) return "Unscored";
  return band.replace(/_/g, " ");
}

function candidateBandClass(band?: string | null): string {
  if (band === "strong_candidate") return "bg-green-50 text-green-700 border-green-200";
  if (band === "review_candidate") return "bg-blue-50 text-blue-700 border-blue-200";
  if (band === "blocked") return "bg-red-50 text-red-700 border-red-200";
  return "bg-zinc-50 text-zinc-600 border-zinc-200";
}

function reviewQueueSeverityClass(severity: string): string {
  if (severity === "critical") return "bg-red-50 text-red-700 border-red-200";
  if (severity === "warning") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-blue-50 text-blue-700 border-blue-200";
}

function formatReviewQueueKind(kind: string): string {
  if (kind === "held_by_policy") return "Policy hold";
  if (kind === "quality_review_required") return "Quality review";
  return "Skipped";
}

function formatReviewQueueReason(reason: string): string {
  if (reason === "forecast_trust_review") return "Forecast trust review";
  if (reason === "medium_confidence_review") return "Medium confidence review";
  if (reason === "low_confidence_review") return "Low confidence review";
  if (reason === "held_by_approval_policy") return "Held by approval policy";
  if (reason === "no_vendor") return "No vendor";
  return reason.replace(/_/g, " ");
}

function formatForecastAction(action: string): string {
  if (action === "repair_order_velocity_source") return "Repair velocity source";
  if (action === "rebuild_forecast_windows") return "Rebuild forecast windows";
  if (action === "verify_recent_demand") return "Verify recent demand";
  if (action === "monitor_thin_sample") return "Monitor thin sample";
  return action.replace(/_/g, " ");
}

function formatRecommendationDecision(decision?: RecommendationDecisionValue | null): string {
  if (decision === "accepted_for_po") return "Accepted";
  if (decision === "po_handoff_created") return "PO handoff";
  if (decision === "deferred") return "Deferred";
  if (decision === "dismissed") return "Dismissed";
  return "Reviewed";
}

function recommendationDecisionClass(decision?: RecommendationDecisionValue | null): string {
  if (decision === "accepted_for_po") return "bg-green-50 text-green-700 border-green-200";
  if (decision === "po_handoff_created") return "bg-purple-50 text-purple-700 border-purple-200";
  if (decision === "deferred") return "bg-blue-50 text-blue-700 border-blue-200";
  if (decision === "dismissed") return "bg-zinc-100 text-zinc-700 border-zinc-200";
  return "bg-emerald-50 text-emerald-700 border-emerald-200";
}

function reviewQueueFilterCount(summary: RecommendationReviewQueueResponse["summary"] | undefined, filter: ReviewQueueKind): number {
  if (!summary) return 0;
  if (filter === "all") return summary.total;
  if (filter === "skipped") return summary.skipped;
  if (filter === "held_by_policy") return summary.heldByPolicy;
  return summary.qualityReviewRequired;
}

function formatApprovalPolicy(policy?: AutoDraftApprovalPolicy | null): string {
  return policy === "high_confidence_and_strong_candidate"
    ? "High confidence + strong candidate"
    : "High confidence only";
}

function formatRecommendationPurchaseQuantity(item: {
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  orderUomUnits: number;
  orderUomLabel: string;
}): string {
  const orderUom = `${item.suggestedOrderQty.toLocaleString()} ${item.orderUomLabel}`;
  if (item.orderUomUnits <= 1) return `${item.suggestedOrderPieces.toLocaleString()} pieces`;
  return `${orderUom} (${item.suggestedOrderPieces.toLocaleString()} pieces)`;
}

function createPurchasingCommandIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function PurchasingView() {
  const [sortField, setSortField] = useState("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [location, navigate] = useLocation();
  const [candidateBandFilter, setCandidateBandFilter] = useState<CandidateBandFilter>(() => {
    const params = reorderAnalysisSearchParams(location);
    const requested = params.get("candidateBand");
    return isCandidateBandFilter(requested) ? requested : "all";
  });
  const [reviewQueueFilter, setReviewQueueFilter] = useState<ReviewQueueKind>(() => {
    const params = reorderAnalysisSearchParams(location);
    const requested = params.get("reviewQueue");
    return isReviewQueueKind(requested) ? requested : "all";
  });
  const [reviewQueueReasonFilter, setReviewQueueReasonFilter] = useState<string>(() => {
    const params = reorderAnalysisSearchParams(location);
    return params.get("reason")?.trim() || "all";
  });
  const [reviewQueueForecastActionFilter, setReviewQueueForecastActionFilter] = useState<string>(() => {
    const params = reorderAnalysisSearchParams(location);
    return params.get("forecastAction")?.trim() || "all";
  });
  const [reviewQueueRecommendationId, setReviewQueueRecommendationId] = useState<string>(() => {
    const params = reorderAnalysisSearchParams(location);
    return params.get("recommendationId")?.trim() || "all";
  });
  const [decisionDialog, setDecisionDialog] = useState<{
    item: RecommendationReviewQueueItem;
    decision: Exclude<RecommendationDecisionValue, "po_handoff_created">;
  } | null>(null);
  const [selectedRfqLineIds, setSelectedRfqLineIds] = useState<Set<number>>(new Set());
  const [rfqSelections, setRfqSelections] = useState<Record<number, RfqSelection>>({});
  const [rfqBatchDialogOpen, setRfqBatchDialogOpen] = useState(false);
  const [rfqBatchIdempotencyKey, setRfqBatchIdempotencyKey] = useState("");
  const [rfqRequestNote, setRfqRequestNote] = useState("");
  const [rfqResponseDueDate, setRfqResponseDueDate] = useState("");
  const [planningPolicyOpen, setPlanningPolicyOpen] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");
  const [reviewedControlCodes, setReviewedControlCodes] = useState<Set<string>>(new Set());
  const [automationEligibilityAcknowledged, setAutomationEligibilityAcknowledged] = useState(false);
  const [decisionConfirmed, setDecisionConfirmed] = useState(false);
  const openedForecastDeepLinkRef = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: kpis, isLoading: isLoadingKpis } = useQuery<DashboardKPIs>({
    queryKey: ["/api/purchasing/kpis"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/kpis");
      if (!res.ok) throw new Error("Failed to fetch KPIs");
      return res.json();
    },
    refetchInterval: 30000, // Refresh every 30s
  });

  const { data: analysis, isLoading: isLoadingAnalysis } = useQuery<ReorderAnalysis>({
    queryKey: ["/api/purchasing/reorder-analysis"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/reorder-analysis");
      if (!res.ok) throw new Error("Failed to fetch reorder analysis");
      return res.json();
    },
  });

  const { data: recommendationReviewQueue } = useQuery<RecommendationReviewQueueResponse>({
    queryKey: [
      "/api/purchasing/recommendation-review-queue",
      reviewQueueFilter,
      reviewQueueReasonFilter,
      reviewQueueForecastActionFilter,
      reviewQueueRecommendationId,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (reviewQueueFilter !== "all") params.set("kind", reviewQueueFilter);
      if (reviewQueueReasonFilter !== "all") params.set("reason", reviewQueueReasonFilter);
      if (reviewQueueForecastActionFilter !== "all") params.set("forecastAction", reviewQueueForecastActionFilter);
      if (reviewQueueRecommendationId !== "all") params.set("recommendationId", reviewQueueRecommendationId);
      const res = await fetch(`/api/purchasing/recommendation-review-queue?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch recommendation review queue");
      return res.json();
    },
  });

  const { data: rfqQueue, isLoading: isLoadingRfqQueue } = useQuery<RfqQueueResponse>({
    queryKey: ["/api/purchasing/rfq-queue"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/rfq-queue");
      if (!res.ok) throw new Error("Failed to fetch RFQ queue");
      return res.json();
    },
  });

  const { data: rfqVendors = [] } = useQuery<RfqVendor[]>({
    queryKey: ["/api/vendors"],
  });

  const { data: acceptedRecommendationQueue } = useQuery<AcceptedRecommendationQueueResponse>({
    queryKey: ["/api/purchasing/recommendation-accepted-queue"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/recommendation-accepted-queue?limit=25");
      if (!res.ok) throw new Error("Failed to fetch accepted recommendation queue");
      return res.json();
    },
  });

  const { data: recommendationDecisionHistory } = useQuery<RecommendationDecisionHistoryResponse>({
    queryKey: ["/api/purchasing/recommendation-decisions"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/recommendation-decisions?limit=12");
      if (!res.ok) throw new Error("Failed to fetch recommendation decision history");
      return res.json();
    },
  });

  const recommendationDecisionMutation = useMutation({
    mutationFn: async ({
      item,
      decision,
      note,
      reviewedControlCodes: acknowledgedControlCodes,
      acknowledgeAutomationEligibilityUnchanged,
    }: {
      item: RecommendationReviewQueueItem;
      decision: Exclude<RecommendationDecisionValue, "po_handoff_created">;
      note: string;
      reviewedControlCodes: string[];
      acknowledgeAutomationEligibilityUnchanged: boolean;
    }) => {
      const res = await fetch("/api/purchasing/recommendation-decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendationId: item.recommendationId,
          kind: item.kind,
          decision,
          note,
          reviewedControlCodes: acknowledgedControlCodes,
          acknowledgeAutomationEligibilityUnchanged,
          confirmDecision: true,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to record recommendation decision");
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-review-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-accepted-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-decisions"] });
      setDecisionDialog(null);
      setDecisionNote("");
      setReviewedControlCodes(new Set());
      setAutomationEligibilityAcknowledged(false);
      setDecisionConfirmed(false);
      toast({
        title: "Recommendation Decision Recorded",
        description: `${variables.item.sku} marked ${formatRecommendationDecision(variables.decision).toLowerCase()}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Decision Not Recorded",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const acceptedRecommendationPoMutation = useMutation({
    mutationFn: async (item: AcceptedRecommendationQueueItem) => {
      const res = await fetch("/api/purchasing/recommendation-accepted-queue/create-po", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": createPurchasingCommandIdempotencyKey("accepted-recommendation-po"),
        },
        body: JSON.stringify({
          items: [
            {
              recommendationId: item.recommendationId,
              kind: item.kind,
            },
          ],
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to create draft PO from accepted recommendation");
      }
      return res.json();
    },
    onSuccess: (data, item) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-review-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-accepted-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-decisions"] });
      toast({
        title: "Draft PO Updated",
        description: `${item.sku} handed off to ${data.count ?? 0} draft PO${data.count === 1 ? "" : "s"}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "PO Handoff Blocked",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const createRfqMutation = useMutation({
    mutationFn: async (input: {
      idempotencyKey: string;
      lines: Array<{
        recommendationLineId: number;
        vendorId: number;
        vendorSku: string;
        requestedPieces: number;
        quantityOverrideReason: string;
        allocationOverrideApproved: boolean;
      }>;
      requestNote: string;
      responseDueDate: string;
    }) => {
      const res = await fetch("/api/purchasing/rfq-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: input.idempotencyKey,
          lines: input.lines.map((line) => ({
            ...line,
            vendorSku: line.vendorSku.trim() || null,
            quantityOverrideReason: line.quantityOverrideReason.trim() || null,
            allocationOverrideApproved: line.allocationOverrideApproved,
          })),
          requestNote: input.requestNote.trim() || null,
          responseDueDate: input.responseDueDate || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Failed to create RFQ draft");
      return body;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-review-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/supplier-setup-gaps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vendor-products"] });
      setRfqBatchDialogOpen(false);
      setSelectedRfqLineIds(new Set());
      setRfqSelections({});
      setRfqBatchIdempotencyKey("");
      setRfqRequestNote("");
      setRfqResponseDueDate("");
      toast({
        title: "RFQ drafts prepared",
        description: `${data.rfqs?.length ?? 0} supplier RFQ${data.rfqs?.length === 1 ? "" : "s"} created from ${data.lines?.length ?? 0} recommendation line${data.lines?.length === 1 ? "" : "s"}.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "RFQ not created", description: error.message, variant: "destructive" });
    },
  });

  const refreshRecommendationsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/purchasing/recommendation-runs", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Failed to generate recommendations");
      return body;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      setSelectedRfqLineIds(new Set());
      setRfqSelections({});
      toast({
        title: "Purchase recommendations refreshed",
        description: `${data.lineCount ?? 0} current requirements were saved as a new calculation run.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Recommendations not refreshed", description: error.message, variant: "destructive" });
    },
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir(field === "candidateScore" ? "desc" : "asc");
    }
  };

  const allReorderItems = analysis?.items ?? [];
  const candidateBandCounts = allReorderItems.reduce<Record<CandidateBandFilter, number>>(
    (counts, item) => {
      counts.all += 1;
      const band = item.recommendationCandidateScore?.band;
      if (band && isCandidateBandFilter(band) && band !== "all") counts[band] += 1;
      return counts;
    },
    { all: 0, strong_candidate: 0, review_candidate: 0, watch: 0, blocked: 0 },
  );
  const candidateReviewQueue = allReorderItems
    .filter((item) => {
      const band = item.recommendationCandidateScore?.band;
      return band === "strong_candidate" || band === "review_candidate";
    })
    .sort((a, b) => (b.recommendationCandidateScore?.score ?? 0) - (a.recommendationCandidateScore?.score ?? 0))
    .slice(0, 6);
  const filtered = allReorderItems
    .filter((item) => candidateBandFilter === "all" || item.recommendationCandidateScore?.band === candidateBandFilter)
    .sort((a, b) => {
      let aVal: any, bVal: any;
      switch (sortField) {
        case "sku": aVal = a.sku; bVal = b.sku; break;
        case "onHand": aVal = a.totalOnHand; bVal = b.totalOnHand; break;
        case "onOrder": aVal = a.onOrderPieces; bVal = b.onOrderPieces; break;
        case "candidateScore":
          aVal = a.recommendationCandidateScore?.score ?? -1;
          bVal = b.recommendationCandidateScore?.score ?? -1;
          break;
        case "health": aVal = a.available / (a.reorderPoint || 1); bVal = b.available / (b.reorderPoint || 1); break;
        case "status":
          aVal = STATUS_CONFIG[a.status]?.priority ?? 99;
          bVal = STATUS_CONFIG[b.status]?.priority ?? 99;
          break;
        default: aVal = a.sku; bVal = b.sku;
      }
      if (typeof aVal === "string") {
        return sortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === "asc" ? aVal - bVal : bVal - aVal;
    });
  const filteredReviewQueue = (recommendationReviewQueue?.items ?? [])
    .filter((item) => reviewQueueFilter === "all" || item.kind === reviewQueueFilter)
    .filter((item) => reviewQueueReasonFilter === "all" || item.reason.code === reviewQueueReasonFilter)
    .filter((item) => reviewQueueForecastActionFilter === "all" || item.forecastAction?.code === reviewQueueForecastActionFilter)
    .filter((item) => reviewQueueRecommendationId === "all" || item.recommendationId === reviewQueueRecommendationId)
    .slice(0, 12);
  const acceptedQueueItems = (acceptedRecommendationQueue?.items ?? []).slice(0, 8);
  const recentRecommendationDecisions = (recommendationDecisionHistory?.decisions ?? []).slice(0, 8);
  const approvalPolicyImpact = analysis?.approvalPolicyImpact;

  useEffect(() => {
    if (reviewQueueRecommendationId === "all" || filteredReviewQueue.length !== 1) return;
    document.getElementById("recommendation-review-target")?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (reviewQueueForecastActionFilter === "all") return;

    const deepLinkKey = `${reviewQueueRecommendationId}:${reviewQueueForecastActionFilter}`;
    if (openedForecastDeepLinkRef.current === deepLinkKey) return;
    openedForecastDeepLinkRef.current = deepLinkKey;
    setDecisionDialog({ item: filteredReviewQueue[0], decision: "reviewed" });
    setDecisionNote("");
    setReviewedControlCodes(new Set());
    setAutomationEligibilityAcknowledged(false);
    setDecisionConfirmed(false);
  }, [
    reviewQueueRecommendationId,
    reviewQueueForecastActionFilter,
    recommendationReviewQueue?.generatedAt,
  ]);

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 text-muted-foreground ml-1" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3 ml-1" /> : <ArrowDown className="h-3 w-3 ml-1" />;
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
  };

  const formatProvenance = (item: ReorderItem) => {
    const provenance = item.forecastProvenance;
    if (!provenance) return "Forecast basis unavailable";
    const methodLabel = (provenance.forecastMethod ?? provenance.demandSource).replace(/_/g, " ");
    const demandLabel =
      provenance.demandQuality === "normal"
        ? "Demand stable"
        : provenance.demandQuality === "thin_history"
          ? "Thin demand"
          : "No recent demand";
    const leadLabel =
      provenance.leadTimeSource === "vendor_product"
        ? "vendor lead"
        : provenance.leadTimeSource === "product"
          ? "product lead"
          : "default lead";
    const trendLabel =
      provenance.demandTrend === "rising"
        ? "rising"
        : provenance.demandTrend === "falling"
          ? "falling"
          : provenance.demandTrend === "stable"
            ? "stable"
            : provenance.demandTrend === "new_demand"
              ? "new"
              : null;
    const sampleLabel =
      provenance.demandOrderCount != null && provenance.demandActiveDays != null
        ? `${provenance.demandOrderCount} orders/${provenance.demandActiveDays}d`
        : `${provenance.periodUsagePieces} pcs/${provenance.demandWindowDays}d`;
    const usageLabel = `${provenance.avgDailyUsagePieces.toLocaleString(undefined, { maximumFractionDigits: 2 })} pcs/day`;
    const shortWindow = provenance.demandWindowDiagnostics?.shortWindow;
    const shortWindowLabel = shortWindow
      ? ` - ${shortWindow.lookbackDays ?? 7}d ${Number(shortWindow.avgDailyUsagePieces ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}/day`
      : "";
    const accelerationLabel = provenance.demandWindowDiagnostics?.accelerationSignal
      ? ` - ${provenance.demandWindowDiagnostics.accelerationSignal.replace(/_/g, " ")}`
      : "";
    const longWindow = provenance.demandWindowDiagnostics?.longWindow;
    const baselineLabel = provenance.demandWindowDiagnostics?.baselineSignal
      ? ` - baseline ${provenance.demandWindowDiagnostics.baselineSignal.replace(/_/g, " ")}${
          longWindow?.lookbackDays ? ` (${longWindow.lookbackDays}d)` : ""
        }`
      : "";
    const seasonalWindow = provenance.demandWindowDiagnostics?.seasonalWindow;
    const seasonalLabel =
      provenance.demandWindowDiagnostics?.seasonalSignal &&
      provenance.demandWindowDiagnostics.seasonalSignal !== "not_available"
        ? ` - seasonal ${provenance.demandWindowDiagnostics.seasonalSignal.replace(/_/g, " ")}${
            seasonalWindow?.lookbackDays ? ` (${seasonalWindow.lookbackDays}d)` : ""
          }`
        : "";
    const cycleLabel = item.supplierCycleDiagnostics
      ? ` - cycle ${item.supplierCycleDiagnostics.signal.replace(/_/g, " ")}`
      : "";
    const scoreLabel = item.recommendationCandidateScore
      ? ` - score ${item.recommendationCandidateScore.score} ${item.recommendationCandidateScore.band.replace(/_/g, " ")}`
      : "";
    const suppressionLabel =
      provenance.demandSuppressionRisk && provenance.demandSuppressionRisk.signal !== "none"
        ? ` - suppression ${provenance.demandSuppressionRisk.signal.replace(/_/g, " ")}`
        : "";
    const trustLabel =
      provenance.forecastTrust && provenance.forecastTrust.signal !== "trusted"
        ? ` - trust ${provenance.forecastTrust.signal.replace(/_/g, " ")}`
        : "";
    const costLabel =
      item.supplierBasis?.costQuality === "current"
        ? "cost current"
        : item.supplierBasis?.costQuality === "stale"
          ? "cost stale"
          : item.supplierBasis?.costQuality === "unverified"
            ? "cost unverified"
            : "cost missing";
    return `${methodLabel} - ${demandLabel} - ${sampleLabel} - ${usageLabel}${shortWindowLabel}${trendLabel ? ` - ${trendLabel}` : ""}${accelerationLabel}${baselineLabel}${seasonalLabel}${cycleLabel}${scoreLabel}${suppressionLabel}${trustLabel} - ${leadLabel} - ${costLabel}`;
  };

  const getAutopilotBlockers = (item: ReorderItem) => {
    return item.autopilotBlockers?.length
      ? item.autopilotBlockers
      : item.qualityControls?.filter((control) => control.severity === "review" || control.severity === "block") ?? [];
  };

  const formatAutopilotBlockers = (item: ReorderItem) => {
    const blockers = getAutopilotBlockers(item);
    if (!blockers.length) return null;
    const labels = blockers.slice(0, 2).map((control) => control.label).join(", ");
    const remainder = blockers.length > 2 ? ` +${blockers.length - 2} more` : "";
    return `${blockers.some((control) => control.severity === "block") ? "Blocked" : "Review"}: ${labels}${remainder}`;
  };

  const confidenceClass = (confidence?: string) => {
    if (confidence === "high") return "bg-green-50 text-green-700 border-green-200";
    if (confidence === "medium") return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-zinc-50 text-zinc-600 border-zinc-200";
  };

  const handleRecommendationHref = (href: string) => {
    if (href.startsWith("/reorder-analysis")) {
      const params = new URLSearchParams(href.split("?")[1] ?? "");
      const requestedBand = params.get("candidateBand");
      if (isCandidateBandFilter(requestedBand)) setCandidateBandFilter(requestedBand);
      const requestedQueue = params.get("reviewQueue");
      if (isReviewQueueKind(requestedQueue)) setReviewQueueFilter(requestedQueue);
      setReviewQueueReasonFilter(params.get("reason")?.trim() || "all");
      setReviewQueueForecastActionFilter(params.get("forecastAction")?.trim() || "all");
      setReviewQueueRecommendationId(params.get("recommendationId")?.trim() || "all");
      return;
    }
    navigate(href);
  };

  const handleReviewQueueAction = (item: RecommendationReviewQueueItem) => {
    if (item.action.action === "prepare_rfq") {
      const rfqItem = rfqQueue?.items.find((candidate) => candidate.recommendationId === item.recommendationId);
      if (rfqItem) {
        selectRecommendationForRfq(rfqItem);
        document.getElementById("rfq-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      toast({
        title: "RFQ requirement changed",
        description: "Refresh the queue to load the current required-piece quantity.",
        variant: "destructive",
      });
      return;
    }
    handleRecommendationHref(item.action.href);
  };

  const selectionForRfqItem = (item: RfqQueueItem): RfqSelection => rfqSelections[item.recommendationLineId] ?? {
    requestedPieces: Math.max(item.remainingPieces, 1),
    vendorId: item.preferredVendorId ? String(item.preferredVendorId) : "",
    vendorSku: "",
    quantityOverrideReason: "",
    allocationOverrideApproved: false,
  };

  const selectRecommendationForRfq = (item: RfqQueueItem) => {
    setSelectedRfqLineIds((current) => new Set(current).add(item.recommendationLineId));
    setRfqSelections((current) => current[item.recommendationLineId] ? current : {
      ...current,
      [item.recommendationLineId]: {
        requestedPieces: Math.max(item.remainingPieces, 1),
        vendorId: item.preferredVendorId ? String(item.preferredVendorId) : "",
        vendorSku: "",
        quantityOverrideReason: "",
        allocationOverrideApproved: false,
      },
    });
  };

  const toggleRecommendationForRfq = (item: RfqQueueItem, selected: boolean) => {
    if (selected) {
      selectRecommendationForRfq(item);
      return;
    }
    setSelectedRfqLineIds((current) => {
      const next = new Set(current);
      next.delete(item.recommendationLineId);
      return next;
    });
  };

  const updateRfqSelection = (item: RfqQueueItem, patch: Partial<RfqSelection>) => {
    setRfqSelections((current) => {
      const prior = current[item.recommendationLineId] ?? selectionForRfqItem(item);
      const quantityChanged = patch.requestedPieces !== undefined
        && patch.requestedPieces !== prior.requestedPieces;
      return {
        ...current,
        [item.recommendationLineId]: {
          ...prior,
          ...patch,
          ...(quantityChanged ? { allocationOverrideApproved: false } : {}),
        },
      };
    });
  };

  const selectedRfqItems = (rfqQueue?.items ?? []).filter((item) => selectedRfqLineIds.has(item.recommendationLineId));
  const selectedRfqGroups = selectedRfqItems.reduce<Map<string, { vendorName: string; items: RfqQueueItem[]; pieces: number }>>(
    (groups, item) => {
      const selection = selectionForRfqItem(item);
      const vendor = rfqVendors.find((candidate) => String(candidate.id) === selection.vendorId);
      const key = selection.vendorId || "unassigned";
      const group = groups.get(key) ?? { vendorName: vendor?.name ?? "Supplier not assigned", items: [], pieces: 0 };
      group.items.push(item);
      group.pieces += Number(selection.requestedPieces) || 0;
      groups.set(key, group);
      return groups;
    },
    new Map(),
  );

  const openRfqBatchDialog = () => {
    const invalid = selectedRfqItems.find((item) => {
      const selection = selectionForRfqItem(item);
      return !selection.vendorId
        || !Number.isSafeInteger(selection.requestedPieces)
        || selection.requestedPieces <= 0
        || (selection.requestedPieces !== item.remainingPieces && selection.quantityOverrideReason.trim().length < 3)
        || (selection.requestedPieces > item.remainingPieces && !selection.allocationOverrideApproved);
    });
    if (invalid) {
      toast({
        title: "Complete the RFQ selections",
        description: `${invalid.sku} needs a supplier, a positive whole-piece quantity, a reason for any adjustment, and approval for any amount above the recommendation.`,
        variant: "destructive",
      });
      return;
    }
    const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    setRfqBatchIdempotencyKey(`purchasing-rfq-${randomPart}`);
    setRfqRequestNote("");
    const defaultDueDate = new Date();
    defaultDueDate.setDate(defaultDueDate.getDate() + 7);
    setRfqResponseDueDate(defaultDueDate.toISOString().slice(0, 10));
    setRfqBatchDialogOpen(true);
  };

  const submitRfqDraft = () => {
    if (!rfqBatchIdempotencyKey || selectedRfqItems.length === 0) return;
    createRfqMutation.mutate({
      idempotencyKey: rfqBatchIdempotencyKey,
      lines: selectedRfqItems.map((item) => {
        const selection = selectionForRfqItem(item);
        return {
          recommendationLineId: item.recommendationLineId,
          vendorId: Number(selection.vendorId),
          vendorSku: selection.vendorSku,
          requestedPieces: selection.requestedPieces,
          quantityOverrideReason: selection.quantityOverrideReason,
          allocationOverrideApproved: selection.allocationOverrideApproved,
        };
      }),
      requestNote: rfqRequestNote,
      responseDueDate: rfqResponseDueDate,
    });
  };

  const openRecommendationDecision = (
    item: RecommendationReviewQueueItem,
    decision: Exclude<RecommendationDecisionValue, "po_handoff_created">,
  ) => {
    setDecisionDialog({ item, decision });
    setDecisionNote("");
    setReviewedControlCodes(new Set());
    setAutomationEligibilityAcknowledged(false);
    setDecisionConfirmed(false);
  };

  const decisionRequiresControlReview =
    decisionDialog?.decision === "reviewed" || decisionDialog?.decision === "accepted_for_po";
  const decisionControls = decisionDialog?.item.qualityControls ?? [];
  const everyDecisionControlReviewed = decisionControls.every((control) => reviewedControlCodes.has(control.code));
  const decisionCanSubmit = Boolean(
    decisionDialog &&
    decisionNote.trim().length >= 10 &&
    decisionConfirmed &&
    (!decisionRequiresControlReview || (everyDecisionControlReviewed && automationEligibilityAcknowledged)),
  );

  const submitRecommendationDecision = () => {
    if (!decisionDialog || !decisionCanSubmit) return;
    recommendationDecisionMutation.mutate({
      item: decisionDialog.item,
      decision: decisionDialog.decision,
      note: decisionNote.trim(),
      reviewedControlCodes: Array.from(reviewedControlCodes),
      acknowledgeAutomationEligibilityUnchanged: automationEligibilityAcknowledged,
    });
  };

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-zinc-950">
      {/* HEADER */}
      <div className="border-b bg-white dark:bg-zinc-900 sticky top-0 z-10 px-6 py-4 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 flex items-center gap-3">
              <BrainCircuit className="h-6 w-6 text-primary" />
              Supply Chain Command Center
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              Inventory demand planning and supplier RFQ coordination
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="lg" className="gap-2" onClick={() => setPlanningPolicyOpen(true)}>
              <SlidersHorizontal className="h-4 w-4" />
              Planning Policy
            </Button>
            <Button
              size="lg"
              className="gap-2 shadow-lg hover:shadow-xl transition-all"
              onClick={() => document.getElementById("rfq-queue")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              <PackageSearch className="h-4 w-4" />
              Review Purchase Recommendations
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-6 overflow-auto">
        {/* KPI CARDS */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Critical Restocks</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : kpis?.criticalRestocks || 0}
              </div>
              <p className="text-xs text-zinc-500 mt-1">SKUs below Reorder Point</p>
            </CardContent>
          </Card>
          
          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Upcoming Restocks</CardTitle>
              <Activity className="h-4 w-4 text-amber-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : kpis?.upcomingRestocks || 0}
              </div>
              <p className="text-xs text-zinc-500 mt-1">Approaching 14-day threshold</p>
            </CardContent>
          </Card>

          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Inbound Pipeline</CardTitle>
              <PackageSearch className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : formatCurrency(kpis?.inboundPipelineValueCents || 0)}
              </div>
              <p className="text-xs text-zinc-500 mt-1">{kpis?.totalOpenLines || 0} Active PO Lines Transit</p>
            </CardContent>
          </Card>

          <Card className="bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Capital Efficiency</CardTitle>
              <DollarSign className="h-4 w-4 text-zinc-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">
                {isLoadingKpis ? "..." : formatCurrency(kpis?.idleCapitalCents || 0)}
              </div>
              <p className="text-xs text-zinc-500 mt-1">Capital in stagnant inventory {'(>180d)'}</p>
            </CardContent>
          </Card>
        </div>

        {analysis?.summary && (
          <Card className="mb-6 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
              <CardTitle className="text-lg">Autopilot Quality Gate</CardTitle>
              <CardDescription>Recommendation confidence and PO draft eligibility</CardDescription>
            </CardHeader>
            <CardContent className="p-4">
              <div className="grid grid-cols-2 md:grid-cols-5 rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden divide-y md:divide-y-0 md:divide-x divide-zinc-200 dark:divide-zinc-800">
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Eligible</div>
                  <div className="text-2xl font-bold text-green-700">{analysis.summary.autoDraftEligibleCount}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Needs Review</div>
                  <div className="text-2xl font-bold text-amber-700">{analysis.summary.autoDraftReviewRequiredCount}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">High Confidence</div>
                  <div className="text-2xl font-bold">{analysis.summary.highConfidenceCount}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Medium</div>
                  <div className="text-2xl font-bold">{analysis.summary.mediumConfidenceCount}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Low</div>
                  <div className="text-2xl font-bold">{analysis.summary.lowConfidenceCount}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {approvalPolicyImpact && (
          <Card className="mb-6 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
              <CardTitle className="text-lg">Approval Policy Impact</CardTitle>
              <CardDescription>Read-only preview of the active auto-draft approval policy before running auto-draft.</CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-5 rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden divide-y md:divide-y-0 md:divide-x divide-zinc-200 dark:divide-zinc-800">
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Active Policy</div>
                  <div className="text-sm font-semibold mt-1">{formatApprovalPolicy(approvalPolicyImpact.policy)}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Quality Eligible</div>
                  <div className="text-2xl font-bold">{approvalPolicyImpact.qualityGateEligibleCount}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Policy Approved</div>
                  <div className="text-2xl font-bold text-green-700">{approvalPolicyImpact.approvalPolicyEligibleCount}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Held By Policy</div>
                  <div className="text-2xl font-bold text-amber-700">{approvalPolicyImpact.approvalPolicyBlockedCount}</div>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-3">
                  <div className="text-xs text-zinc-500">Draft Eligible</div>
                  <div className="text-2xl font-bold">{approvalPolicyImpact.draftMutationEligibleCount}</div>
                </div>
              </div>

              {approvalPolicyImpact.approvalPolicyBlockedCount > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3">
                  <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <div className="text-sm font-semibold text-amber-800">Strict policy would hold recommendations</div>
                      <p className="text-xs text-amber-700">
                        {approvalPolicyImpact.blockedCandidateBandCounts.review_candidate ?? 0} review candidates and{" "}
                        {approvalPolicyImpact.blockedCandidateBandCounts.watch ?? 0} watch items would stay out of draft PO mutation.
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-[11px] border-amber-300 text-amber-700 hover:bg-amber-100" onClick={() => setCandidateBandFilter("review_candidate")}>
                      Review Held Items
                    </Button>
                  </div>
                  {approvalPolicyImpact.heldRecommendations.length > 0 && (
                    <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-2">
                      {approvalPolicyImpact.heldRecommendations.slice(0, 4).map((item) => (
                        <div key={item.recommendationId} className="rounded border bg-white/80 p-2 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-semibold text-primary truncate">{item.sku}</span>
                            {item.recommendationCandidateScore ? (
                              <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(item.recommendationCandidateScore.band)}`}>
                                {item.recommendationCandidateScore.score} - {formatCandidateBand(item.recommendationCandidateScore.band)}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 truncate font-medium">{item.productName}</div>
                          <div className="mt-1 text-zinc-500">
                            {formatRecommendationPurchaseQuantity(item)}
                            {item.preferredVendorName ? ` - ${item.preferredVendorName}` : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card id="rfq-queue" className="mb-6 scroll-mt-24 border-blue-200 shadow-sm dark:border-blue-900 dark:bg-zinc-900">
            <CardHeader className="border-b border-blue-100 bg-blue-50/60 pb-4 dark:border-blue-900 dark:bg-blue-950/20">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <PackageSearch className="h-5 w-5 text-blue-700" />
                    Purchase Recommendations
                  </CardTitle>
                  <CardDescription>
                    Select requirements, adjust quantities, and assign suppliers. One multi-line RFQ draft is created per supplier; pricing comes later.
                  </CardDescription>
                  {rfqQueue?.generatedAt && (
                    <div className="mt-1 text-[11px] text-zinc-500">
                      Run #{rfqQueue.run?.id} generated {new Date(rfqQueue.generatedAt).toLocaleString()} via {rfqQueue.run?.source === "auto_draft" ? "scheduled purchasing" : "manual refresh"} using {rfqQueue.run?.calculationVersion}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">{rfqQueue?.summary.open ?? 0} open</Badge>
                  <Badge variant="outline" className="border-amber-300 text-amber-700">
                    {rfqQueue?.summary.supplierAssignmentRequired ?? 0} need supplier
                  </Badge>
                  <Badge variant="outline" className="border-blue-300 text-blue-700">
                    {rfqQueue?.summary.activeRfqs ?? 0} active RFQs
                  </Badge>
                  <Button size="sm" variant="outline" disabled={refreshRecommendationsMutation.isPending} onClick={() => refreshRecommendationsMutation.mutate()}>
                    {refreshRecommendationsMutation.isPending ? "Calculating..." : "Refresh recommendations"}
                  </Button>
                  <Button size="sm" disabled={selectedRfqLineIds.size === 0} onClick={openRfqBatchDialog}>
                    Create RFQ drafts ({selectedRfqLineIds.size})
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {isLoadingRfqQueue ? (
                <div className="py-6 text-center text-sm text-zinc-500">Loading RFQ requirements...</div>
              ) : !rfqQueue?.run ? (
                <div className="rounded-md border border-dashed p-6 text-center">
                  <div className="font-medium">No saved recommendation run yet</div>
                  <p className="mt-1 text-sm text-zinc-500">Generate a versioned set of requirements from the active planning policy.</p>
                  <Button className="mt-3" disabled={refreshRecommendationsMutation.isPending} onClick={() => refreshRecommendationsMutation.mutate()}>
                    {refreshRecommendationsMutation.isPending ? "Calculating..." : "Generate recommendations"}
                  </Button>
                </div>
              ) : (rfqQueue?.items.length ?? 0) === 0 ? (
                <div className="py-6 text-center text-sm text-zinc-500">This recommendation run has no purchase requirements.</div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {(rfqQueue?.items ?? []).map((item) => (
                  <div key={item.recommendationLineId} className={`rounded-md border p-3 dark:bg-zinc-900 ${selectedRfqLineIds.has(item.recommendationLineId) ? "border-blue-400 bg-blue-50/30" : "bg-white"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-primary">{item.sku}</span>
                          {item.supplierAssignmentRequired ? (
                            <Badge variant="outline" className="border-amber-300 text-amber-700">Supplier needed</Badge>
                          ) : (
                            <Badge variant="outline" className="border-green-300 text-green-700">{item.preferredVendorName}</Badge>
                          )}
                          <Badge variant="outline" className="capitalize">{item.sourcingStatus.replaceAll("_", " ")}</Badge>
                        </div>
                        <div className="mt-1 truncate text-sm">{item.productName}</div>
                        <div className="mt-3 flex items-end gap-5">
                          <div>
                            <div className="text-2xl font-bold text-blue-800">{item.remainingPieces.toLocaleString()}</div>
                            <div className="text-[11px] text-zinc-500">pieces remaining</div>
                          </div>
                          <div className="text-xs text-zinc-500">
                            <div>{item.availablePieces.toLocaleString()} available</div>
                            <div>{item.onOrderPieces.toLocaleString()} already on order</div>
                          </div>
                        </div>
                        {item.allocatedPieces > 0 && (
                          <div className="mt-2 text-xs text-blue-700">
                            {item.allocatedPieces.toLocaleString()} of {item.recommendedPieces.toLocaleString()} recommended pieces are already allocated to active RFQs.
                          </div>
                        )}
                        {item.excessPieces > 0 && (
                          <div className="mt-2 text-xs font-medium text-amber-700">
                            {item.excessPieces.toLocaleString()} pieces above the recommendation are covered by approved sourcing exceptions.
                          </div>
                        )}
                        <div className="mt-2 text-[11px] text-zinc-500">
                          {item.forecastMethod === "weighted_blend_v1" ? "Weighted forecast" : "Recent velocity"} {item.forecastDailyPieces.toFixed(2)} pieces/day · {item.leadTimeDays} lead days + {item.safetyStockDays} safety days
                          {item.forwardDemandPieces > 0 ? ` · ${item.forwardDemandPieces.toLocaleString()} future-demand pieces` : ""}
                          {` · ${item.reorderPointPieces.toLocaleString()}-piece target`}
                        </div>
                      </div>
                      <div className="w-64 space-y-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={selectedRfqLineIds.has(item.recommendationLineId)}
                            onCheckedChange={(checked) => toggleRecommendationForRfq(item, Boolean(checked))}
                          />
                          <span className="text-xs font-medium">Add to RFQ</span>
                        </div>
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          disabled={!selectedRfqLineIds.has(item.recommendationLineId)}
                          value={selectionForRfqItem(item).requestedPieces}
                          onChange={(event) => updateRfqSelection(item, { requestedPieces: Number(event.target.value) })}
                        />
                        {selectedRfqLineIds.has(item.recommendationLineId) && selectionForRfqItem(item).requestedPieces !== item.remainingPieces && (
                          <Input
                            value={selectionForRfqItem(item).quantityOverrideReason}
                            onChange={(event) => updateRfqSelection(item, { quantityOverrideReason: event.target.value })}
                            placeholder={selectionForRfqItem(item).requestedPieces > item.remainingPieces
                              ? "Above-recommendation reason *"
                              : "Quantity adjustment reason *"}
                            maxLength={2000}
                          />
                        )}
                        {selectedRfqLineIds.has(item.recommendationLineId)
                          && selectionForRfqItem(item).requestedPieces > item.remainingPieces && (
                          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-950">
                            <div className="text-xs font-medium">
                              {(selectionForRfqItem(item).requestedPieces - item.remainingPieces).toLocaleString()} pieces above the remaining recommendation
                            </div>
                            <div className="flex items-start gap-2">
                              <Checkbox
                                id={`rfq-allocation-override-${item.recommendationLineId}`}
                                checked={selectionForRfqItem(item).allocationOverrideApproved}
                                onCheckedChange={(checked) => updateRfqSelection(item, {
                                  allocationOverrideApproved: Boolean(checked),
                                })}
                              />
                              <Label
                                htmlFor={`rfq-allocation-override-${item.recommendationLineId}`}
                                className="text-xs leading-4"
                              >
                                Approve this sourcing exception
                              </Label>
                            </div>
                          </div>
                        )}
                        <Select
                          disabled={!selectedRfqLineIds.has(item.recommendationLineId)}
                          value={selectionForRfqItem(item).vendorId}
                          onValueChange={(value) => updateRfqSelection(item, { vendorId: value })}
                        >
                          <SelectTrigger><SelectValue placeholder="Assign supplier" /></SelectTrigger>
                          <SelectContent>
                            {rfqVendors.filter((vendor) => vendor.active === 1).sort((a, b) => a.name.localeCompare(b.name)).map((vendor) => (
                              <SelectItem key={vendor.id} value={String(vendor.id)}>{vendor.name} ({vendor.code})</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedRfqLineIds.has(item.recommendationLineId) && (
                          <Input
                            value={selectionForRfqItem(item).vendorSku}
                            onChange={(event) => updateRfqSelection(item, { vendorSku: event.target.value })}
                            placeholder="Supplier SKU (optional)"
                            maxLength={100}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                </div>
              )}
            </CardContent>
          </Card>

        {(recommendationReviewQueue?.summary.total ?? 0) > 0 && (
          <Card className="mb-6 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="text-lg">Recommendation Review Queue</CardTitle>
                  <CardDescription>Skipped, held, and quality-review recommendations that need operator action before autopilot can use them.</CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {REVIEW_QUEUE_FILTERS.map((option) => (
                    <Button
                      key={option.value}
                      size="sm"
                      variant={reviewQueueFilter === option.value ? "default" : "outline"}
                      className="h-7 text-[11px] gap-1"
                      onClick={() => {
                        setReviewQueueFilter(option.value);
                        setReviewQueueReasonFilter("all");
                        setReviewQueueForecastActionFilter("all");
                      }}
                    >
                      {option.label}
                      <span className="rounded bg-white/20 px-1">
                        {reviewQueueFilterCount(recommendationReviewQueue?.summary, option.value)}
                      </span>
                    </Button>
                  ))}
                  {reviewQueueReasonFilter !== "all" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] gap-1 border-amber-200 bg-amber-50 text-amber-700"
                      onClick={() => setReviewQueueReasonFilter("all")}
                    >
                      {formatReviewQueueReason(reviewQueueReasonFilter)}
                      <span className="rounded bg-white/60 px-1">Clear</span>
                    </Button>
                  )}
                  {reviewQueueForecastActionFilter !== "all" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] gap-1 border-blue-200 bg-blue-50 text-blue-700"
                      onClick={() => setReviewQueueForecastActionFilter("all")}
                    >
                      {formatForecastAction(reviewQueueForecastActionFilter)}
                      <span className="rounded bg-white/60 px-1">Clear</span>
                    </Button>
                  )}
                  {reviewQueueRecommendationId !== "all" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[11px] gap-1 border-violet-200 bg-violet-50 text-violet-700"
                      onClick={() => setReviewQueueRecommendationId("all")}
                    >
                      Exact recommendation
                      <span className="rounded bg-white/60 px-1">Clear</span>
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {filteredReviewQueue.length === 0 ? (
                <div className="rounded-md border border-dashed bg-white dark:bg-zinc-900 p-4 text-sm text-zinc-500">
                  No recommendations match this review filter.
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                  {filteredReviewQueue.map((item) => (
                    <div
                      key={`${item.recommendationId}-${item.kind}`}
                      id={item.recommendationId === reviewQueueRecommendationId ? "recommendation-review-target" : undefined}
                      className={`rounded-md border bg-white dark:bg-zinc-900 p-3 ${
                        item.recommendationId === reviewQueueRecommendationId
                          ? "border-violet-400 ring-2 ring-violet-200"
                          : ""
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-primary truncate">{item.sku}</span>
                            <Badge variant="outline" className={`text-[10px] ${reviewQueueSeverityClass(item.severity)}`}>
                              {item.reason.label}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] bg-zinc-50 text-zinc-600 border-zinc-200">
                              {formatReviewQueueKind(item.kind)}
                            </Badge>
                            {item.candidateScore ? (
                              <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(item.candidateScore.band)}`}>
                                {item.candidateScore.score} - {formatCandidateBand(item.candidateScore.band)}
                              </Badge>
                            ) : null}
                            {item.forecastAction ? (
                              <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 border-blue-200">
                                {item.forecastAction.label}
                              </Badge>
                            ) : null}
                            {item.latestDecision ? (
                              <Badge variant="outline" className={`text-[10px] ${recommendationDecisionClass(item.latestDecision.decision)}`}>
                                {formatRecommendationDecision(item.latestDecision.decision)}
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 text-sm font-medium truncate">{item.productName}</div>
                          <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{item.reason.detail}</p>
                          <div className="mt-2 text-[11px] text-zinc-500">
                            {formatRecommendationPurchaseQuantity(item)}
                            {item.preferredVendorName ? ` - ${item.preferredVendorName}` : ""}
                            {item.latestDecision?.decidedAt ? (
                              <span className="ml-2">
                                Decision {new Date(item.latestDecision.decidedAt).toLocaleDateString()}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => handleReviewQueueAction(item)}>
                            {item.action.label}
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="outline" className="h-7 w-7" disabled={recommendationDecisionMutation.isPending}>
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openRecommendationDecision(item, "reviewed")}>
                                <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                                Mark reviewed
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openRecommendationDecision(item, "accepted_for_po")}>
                                <ShoppingCart className="mr-2 h-3.5 w-3.5" />
                                Accept for PO review
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openRecommendationDecision(item, "deferred")}>
                                <Clock className="mr-2 h-3.5 w-3.5" />
                                Defer
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openRecommendationDecision(item, "dismissed")}>
                                <XCircle className="mr-2 h-3.5 w-3.5" />
                                Dismiss
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {(acceptedRecommendationQueue?.summary.total ?? 0) > 0 && (
          <Card className="mb-6 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="text-lg">Accepted PO Review Queue</CardTitle>
                  <CardDescription>Recommendations accepted by operators and ready for explicit PO review before any purchase mutation.</CardDescription>
                </div>
                <div className="grid grid-cols-3 gap-2 text-right text-xs">
                  <div className="rounded-md border bg-white px-2 py-1 dark:bg-zinc-900">
                    <div className="font-semibold">{acceptedRecommendationQueue?.summary.current ?? 0}</div>
                    <div className="text-zinc-500">Current</div>
                  </div>
                  <div className="rounded-md border bg-white px-2 py-1 dark:bg-zinc-900">
                    <div className="font-semibold">{acceptedRecommendationQueue?.summary.stale ?? 0}</div>
                    <div className="text-zinc-500">Stale</div>
                  </div>
                  <div className="rounded-md border bg-white px-2 py-1 dark:bg-zinc-900">
                    <div className="font-semibold">{acceptedRecommendationQueue?.summary.vendorCount ?? 0}</div>
                    <div className="text-zinc-500">Vendors</div>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {acceptedQueueItems.map((item) => (
                  <div key={`${item.recommendationId}-${item.kind}-accepted`} className="rounded-md border bg-white dark:bg-zinc-900 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-primary truncate">{item.sku}</span>
                          <Badge variant="outline" className={item.current ? "text-[10px] bg-green-50 text-green-700 border-green-200" : "text-[10px] bg-amber-50 text-amber-700 border-amber-200"}>
                            {item.current ? "Current" : "Snapshot"}
                          </Badge>
                          <Badge variant="outline" className={`text-[10px] ${recommendationDecisionClass(item.decision.decision)}`}>
                            {formatRecommendationDecision(item.decision.decision)}
                          </Badge>
                          {item.candidateScore ? (
                            <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(item.candidateScore.band)}`}>
                              {item.candidateScore.score} - {formatCandidateBand(item.candidateScore.band)}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-sm font-medium truncate">{item.productName}</div>
                        <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{item.statusReason}</p>
                        <div className="mt-2 text-[11px] text-zinc-500">
                          {formatRecommendationPurchaseQuantity(item)}
                          {item.preferredVendorName ? ` - ${item.preferredVendorName}` : ""}
                          {item.decision.decidedAt ? (
                            <span className="ml-2">
                              Accepted {new Date(item.decision.decidedAt).toLocaleDateString()}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 flex-col gap-1 sm:flex-row">
                        <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => handleRecommendationHref(item.action.href)}>
                          {item.action.label}
                        </Button>
                        {item.current ? (
                          <Button
                            size="sm"
                            className="h-7 text-[11px] gap-1"
                            disabled={acceptedRecommendationPoMutation.isPending}
                            onClick={() => acceptedRecommendationPoMutation.mutate(item)}
                          >
                            <ShoppingCart className="h-3.5 w-3.5" />
                            Draft PO
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {(recommendationDecisionHistory?.summary.total ?? 0) > 0 && (
          <Card className="mb-6 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <History className="h-4 w-4" />
                    Recommendation Decision History
                  </CardTitle>
                  <CardDescription>Recent operator decisions and PO handoffs for purchasing recommendations.</CardDescription>
                </div>
                <div className="grid grid-cols-4 gap-2 text-right text-xs">
                  <div className="rounded-md border bg-white px-2 py-1 dark:bg-zinc-900">
                    <div className="font-semibold">{recommendationDecisionHistory?.summary.acceptedForPo ?? 0}</div>
                    <div className="text-zinc-500">Accepted</div>
                  </div>
                  <div className="rounded-md border bg-white px-2 py-1 dark:bg-zinc-900">
                    <div className="font-semibold">{recommendationDecisionHistory?.summary.poHandoffCreated ?? 0}</div>
                    <div className="text-zinc-500">Handoff</div>
                  </div>
                  <div className="rounded-md border bg-white px-2 py-1 dark:bg-zinc-900">
                    <div className="font-semibold">{recommendationDecisionHistory?.summary.deferred ?? 0}</div>
                    <div className="text-zinc-500">Deferred</div>
                  </div>
                  <div className="rounded-md border bg-white px-2 py-1 dark:bg-zinc-900">
                    <div className="font-semibold">{recommendationDecisionHistory?.summary.dismissed ?? 0}</div>
                    <div className="text-zinc-500">Dismissed</div>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {recentRecommendationDecisions.map((decision) => (
                  <div key={decision.id} className="rounded-md border bg-white dark:bg-zinc-900 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-primary truncate">{decision.sku ?? decision.recommendationId}</span>
                          <Badge variant="outline" className={`text-[10px] ${recommendationDecisionClass(decision.decision)}`}>
                            {formatRecommendationDecision(decision.decision)}
                          </Badge>
                          <Badge variant="outline" className="text-[10px] bg-zinc-50 text-zinc-600 border-zinc-200">
                            {formatReviewQueueKind(decision.kind)}
                          </Badge>
                          {decision.candidateScore != null ? (
                            <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(decision.candidateBand)}`}>
                              {decision.candidateScore} - {formatCandidateBand(decision.candidateBand)}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-sm font-medium truncate">{decision.productName ?? "Recommendation snapshot"}</div>
                        <div className="mt-2 text-[11px] text-zinc-500">
                          {decision.decisionReason ? decision.decisionReason.replace(/_/g, " ") : "No decision reason"}
                          {decision.decidedAt ? (
                            <span className="ml-2">
                              {new Date(decision.decidedAt).toLocaleString()}
                            </span>
                          ) : null}
                          {decision.decidedBy ? <span className="ml-2">by {decision.decidedBy}</span> : null}
                        </div>
                        {decision.note ? <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{decision.note}</p> : null}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {candidateReviewQueue.length > 0 && (
          <Card className="mb-6 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
            <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
              <CardTitle className="text-lg">Candidate Score Review</CardTitle>
              <CardDescription>High-scoring purchasing candidates for operator review before score-driven automation is enabled.</CardDescription>
            </CardHeader>
            <CardContent className="p-4">
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
                {candidateReviewQueue.map((item) => {
                  const score = item.recommendationCandidateScore;
                  const targetBand = score?.band === "strong_candidate" ? "strong_candidate" : "review_candidate";
                  return (
                    <div key={`${item.productId}-${item.productVariantId ?? "product"}-candidate`} className="rounded-md border bg-white dark:bg-zinc-900 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs font-semibold text-primary truncate">{item.sku}</span>
                            <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(score?.band)}`}>
                              {score?.score ?? 0} - {formatCandidateBand(score?.band)}
                            </Badge>
                          </div>
                          <div className="mt-1 text-sm font-medium truncate">{item.productName}</div>
                          <div className="mt-2 grid grid-cols-3 gap-1 text-[11px] text-zinc-500">
                            <span>D {score?.demandScore ?? 0}</span>
                            <span>S {score?.supplyScore ?? 0}</span>
                            <span>R {score?.readinessScore ?? 0}</span>
                          </div>
                          <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{score?.detail}</p>
                        </div>
                        <Button size="sm" variant="outline" className="h-7 text-[11px] flex-shrink-0" onClick={() => setCandidateBandFilter(targetBand)}>
                          Filter
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* DATA TABLE */}
        <Card className="dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 shadow-sm">
          <CardHeader className="border-b dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 pb-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <CardTitle className="text-lg">Inventory Burn Telemetry</CardTitle>
                <CardDescription>Live health monitoring of catalog velocity against system reorder parameters.</CardDescription>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CANDIDATE_BAND_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    variant={candidateBandFilter === option.value ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-[11px]"
                    onClick={() => setCandidateBandFilter(option.value)}
                  >
                    {option.label}
                    <span className="ml-1 text-[10px] opacity-75">{candidateBandCounts[option.value]}</span>
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[80px]" />
                  <TableHead className="cursor-pointer font-semibold" onClick={() => handleSort("sku")}>
                    <div className="flex items-center">SKU <SortIcon field="sku" /></div>
                  </TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead className="w-[200px] cursor-pointer font-semibold" onClick={() => handleSort("health")}>
                    <div className="flex items-center">Health Indicator <SortIcon field="health" /></div>
                  </TableHead>
                  <TableHead className="text-right cursor-pointer font-semibold" onClick={() => handleSort("onHand")}>
                    <div className="flex justify-end items-center">Available <SortIcon field="onHand" /></div>
                  </TableHead>
                  <TableHead className="text-right">Reorder Pt</TableHead>
                  <TableHead className="text-right">Supply</TableHead>
                  <TableHead className="w-[140px] cursor-pointer font-semibold" onClick={() => handleSort("candidateScore")}>
                    <div className="flex items-center">Candidate <SortIcon field="candidateScore" /></div>
                  </TableHead>
                  <TableHead>Forecast Basis</TableHead>
                  <TableHead className="text-right cursor-pointer font-semibold" onClick={() => handleSort("status")}>
                    <div className="flex justify-end items-center">Status <SortIcon field="status" /></div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoadingAnalysis ? (
                   <TableRow>
                     <TableCell colSpan={10} className="text-center py-12 text-zinc-500">Loading telemetry data...</TableCell>
                   </TableRow>
                ) : filtered.length === 0 ? (
                   <TableRow>
                     <TableCell colSpan={10} className="text-center py-12 text-zinc-500">No data matching current criteria.</TableCell>
                   </TableRow>
                ) : (
                  filtered.map((item) => {
                    const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.ok;
                    const StatusIcon = cfg.icon;
                    // Health Calculation: Available / Reorder Point
                    const healthPct = item.reorderPoint > 0 
                                      ? Math.min(100, Math.max(0, (item.available / item.reorderPoint) * 100)) 
                                      : 100;
                    
                    let progressColor = "bg-green-500";
                    if (healthPct < 25) progressColor = "bg-red-500";
                    else if (healthPct < 75) progressColor = "bg-amber-500";
                    const autopilotBlockerText = formatAutopilotBlockers(item);
                    const candidateScore = item.recommendationCandidateScore;

                    return (
                      <TableRow key={item.productId} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                        <TableCell>
                           {/* Intentionally left blank or for manual selection if needed */}
                        </TableCell>
                        <TableCell className="font-mono font-medium">{item.sku}</TableCell>
                        <TableCell className="max-w-[200px] truncate text-sm" title={item.productName}>
                          {item.productName}
                          {item.onOrderPieces > 0 && <div className="text-xs text-blue-500 mt-1">+{item.onOrderPieces} Inbound</div>}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1.5">
                            <div className="flex justify-between text-xs font-medium">
                              <span>Health</span>
                              <span>{Math.round(healthPct)}%</span>
                            </div>
                            <Progress value={healthPct} className={`h-1.5 [&>div]:${progressColor}`} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">{item.available.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono text-zinc-500">{item.reorderPoint.toLocaleString()}</TableCell>
                        <TableCell className="text-right text-xs">
                          {item.daysOfSupply >= 9999 ? "∞" : `${item.daysOfSupply}d`}
                        </TableCell>
                        <TableCell className="text-xs">
                          {candidateScore ? (
                            <div className="space-y-1">
                              <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(candidateScore.band)}`}>
                                {candidateScore.score} - {formatCandidateBand(candidateScore.band)}
                              </Badge>
                              <div className="text-[10px] text-zinc-500">
                                D {candidateScore.demandScore} S {candidateScore.supplyScore} R {candidateScore.readinessScore}
                              </div>
                            </div>
                          ) : (
                            <span className="text-zinc-400">Unscored</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs min-w-[190px]">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-[10px] capitalize ${confidenceClass(item.confidence)}`}>
                              {item.confidence ?? "low"} confidence
                            </Badge>
                          </div>
                          <div className="text-[11px] text-zinc-500 mt-1">{formatProvenance(item)}</div>
                          {autopilotBlockerText ? (
                            <div className="text-[11px] text-amber-700 mt-1">{autopilotBlockerText}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className={`${cfg.bg} ${cfg.text} border-transparent gap-1 font-medium`}>
                            <StatusIcon className="h-3 w-3" />
                            {cfg.label}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      <Dialog
        open={rfqBatchDialogOpen}
        onOpenChange={(open) => {
          if (!createRfqMutation.isPending) setRfqBatchDialogOpen(open);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create supplier RFQ drafts</DialogTitle>
            <DialogDescription>
              The selected recommendation quantities will be grouped into one multi-line draft per supplier. Missing catalog SKUs are created without a price.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {Array.from(selectedRfqGroups.entries()).map(([vendorId, group]) => (
              <div key={vendorId} className="rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-semibold">{group.vendorName}</div>
                  <Badge variant="outline">{group.items.length} line{group.items.length === 1 ? "" : "s"} · {group.pieces.toLocaleString()} pieces</Badge>
                </div>
                <div className="mt-2 space-y-1 text-xs text-zinc-600">
                  {group.items.map((item) => {
                    const selection = selectionForRfqItem(item);
                    const excessPieces = Math.max(selection.requestedPieces - item.remainingPieces, 0);
                    return (
                      <div key={item.recommendationLineId} className="border-t py-2 first:border-t-0 first:pt-0 last:pb-0">
                        <div className="flex justify-between gap-3">
                          <span><span className="font-mono font-medium">{item.sku}</span> · {item.productName}</span>
                          <span className="whitespace-nowrap font-medium">{selection.requestedPieces.toLocaleString()} pieces</span>
                        </div>
                        {excessPieces > 0 && (
                          <div className="mt-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-950">
                            <div className="font-medium">
                              Approved sourcing exception: {excessPieces.toLocaleString()} pieces above remaining demand
                            </div>
                            <div className="mt-1">Reason: {selection.quantityOverrideReason.trim()}</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor="rfq-response-due-date">Requested response date</Label>
              <Input
                id="rfq-response-due-date"
                type="date"
                value={rfqResponseDueDate}
                onChange={(event) => setRfqResponseDueDate(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rfq-request-note">Instructions for all supplier drafts (optional)</Label>
              <Textarea
                id="rfq-request-note"
                value={rfqRequestNote}
                onChange={(event) => setRfqRequestNote(event.target.value)}
                placeholder="Packaging, delivery, quote-validity, or response instructions"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={createRfqMutation.isPending} onClick={() => setRfqBatchDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={selectedRfqItems.length === 0 || createRfqMutation.isPending} onClick={submitRfqDraft}>
              {createRfqMutation.isPending ? "Creating drafts..." : `Create ${selectedRfqGroups.size} RFQ draft${selectedRfqGroups.size === 1 ? "" : "s"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ExclusionRulesModal open={planningPolicyOpen} onOpenChange={setPlanningPolicyOpen} />

      <Dialog
        open={Boolean(decisionDialog)}
        onOpenChange={(open) => {
          if (!open && !recommendationDecisionMutation.isPending) setDecisionDialog(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {decisionDialog ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {formatRecommendationDecision(decisionDialog.decision)}: {decisionDialog.item.sku}
                </DialogTitle>
                <DialogDescription>
                  Record an attributable evidence review for {decisionDialog.item.productName}. This decision is audited but does not remove quality controls or make the recommendation eligible for automatic purchasing.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="rounded-md border bg-zinc-50 p-3 dark:bg-zinc-900">
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Current demand evidence</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <div><span className="block text-[11px] text-zinc-500">Lookback</span>{decisionDialog.item.demandEvidence?.lookbackDays ?? "-"} days</div>
                    <div><span className="block text-[11px] text-zinc-500">Usage</span>{decisionDialog.item.demandEvidence?.periodUsagePieces?.toLocaleString() ?? "-"} pieces</div>
                    <div><span className="block text-[11px] text-zinc-500">Paid demand</span>{decisionDialog.item.demandEvidence?.paidDemandPieces?.toLocaleString() ?? "-"} pieces</div>
                    <div><span className="block text-[11px] text-zinc-500">Orders / active days</span>{decisionDialog.item.demandEvidence?.demandOrderCount ?? "-"} / {decisionDialog.item.demandEvidence?.demandActiveDays ?? "-"}</div>
                    <div><span className="block text-[11px] text-zinc-500">Prior usage</span>{decisionDialog.item.demandEvidence?.priorPeriodUsagePieces?.toLocaleString() ?? "-"} pieces</div>
                    <div><span className="block text-[11px] text-zinc-500">Daily velocity</span>{decisionDialog.item.demandEvidence?.avgDailyUsagePieces?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "-"}</div>
                    <div><span className="block text-[11px] text-zinc-500">Zero-revenue</span>{decisionDialog.item.demandEvidence?.zeroRevenueDemandPieces?.toLocaleString() ?? "-"} pieces</div>
                    <div><span className="block text-[11px] text-zinc-500">Coupon-discounted</span>{decisionDialog.item.demandEvidence?.couponDiscountDemandPieces?.toLocaleString() ?? "-"} pieces</div>
                  </div>
                  <div className="mt-3 space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                    <p>Quality: {decisionDialog.item.demandEvidence?.demandQuality?.replace(/_/g, " ") ?? "unavailable"}; trend: {decisionDialog.item.demandEvidence?.demandTrend?.replace(/_/g, " ") ?? "unavailable"}; mix: {decisionDialog.item.demandEvidence?.demandMixSignal?.replace(/_/g, " ") ?? "unavailable"}.</p>
                    {decisionDialog.item.demandEvidence?.forecastTrust?.detail ? (
                      <p>{decisionDialog.item.demandEvidence.forecastTrust.detail}</p>
                    ) : null}
                  </div>
                </div>

                {decisionRequiresControlReview ? (
                  <div className="space-y-2">
                    <div>
                      <Label>Current controls reviewed</Label>
                      <p className="text-xs text-zinc-500">Acknowledge each live control. This records review; it does not clear the control.</p>
                    </div>
                    {decisionControls.length === 0 ? (
                      <p className="rounded-md border border-dashed p-3 text-sm text-zinc-500">No recommendation quality controls are currently active.</p>
                    ) : (
                      decisionControls.map((control) => (
                        <div key={control.code} className="flex items-start gap-2 rounded-md border p-3">
                          <Checkbox
                            id={`review-control-${control.code}`}
                            checked={reviewedControlCodes.has(control.code)}
                            onCheckedChange={(checked) => {
                              setReviewedControlCodes((current) => {
                                const next = new Set(current);
                                if (checked) next.add(control.code);
                                else next.delete(control.code);
                                return next;
                              });
                            }}
                          />
                          <Label htmlFor={`review-control-${control.code}`} className="cursor-pointer font-normal">
                            <span className="font-medium">{control.label}</span>
                            <span className="mt-0.5 block text-xs text-zinc-500">{control.detail}</span>
                          </Label>
                        </div>
                      ))
                    )}
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3">
                      <Checkbox
                        id="acknowledge-automation-unchanged"
                        checked={automationEligibilityAcknowledged}
                        onCheckedChange={(checked) => setAutomationEligibilityAcknowledged(Boolean(checked))}
                      />
                      <Label htmlFor="acknowledge-automation-unchanged" className="cursor-pointer font-normal text-amber-900">
                        I understand this decision does not change automatic-purchasing eligibility or bypass the active approval policy.
                      </Label>
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor="recommendation-decision-note">Evidence and rationale</Label>
                  <Textarea
                    id="recommendation-decision-note"
                    value={decisionNote}
                    onChange={(event) => setDecisionNote(event.target.value.slice(0, 2000))}
                    placeholder="Describe the business evidence reviewed and why this disposition is appropriate."
                    rows={4}
                  />
                  <div className="flex justify-between text-[11px] text-zinc-500">
                    <span>At least 10 characters required.</span>
                    <span>{decisionNote.length}/2000</span>
                  </div>
                </div>

                <div className="flex items-start gap-2 rounded-md border p-3">
                  <Checkbox
                    id="confirm-recommendation-decision"
                    checked={decisionConfirmed}
                    onCheckedChange={(checked) => setDecisionConfirmed(Boolean(checked))}
                  />
                  <Label htmlFor="confirm-recommendation-decision" className="cursor-pointer font-normal">
                    Confirm this {formatRecommendationDecision(decisionDialog.decision).toLowerCase()} decision and preserve the current recommendation evidence snapshot in the audit trail.
                  </Label>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" disabled={recommendationDecisionMutation.isPending} onClick={() => setDecisionDialog(null)}>
                  Cancel
                </Button>
                <Button disabled={!decisionCanSubmit || recommendationDecisionMutation.isPending} onClick={submitRecommendationDecision}>
                  {recommendationDecisionMutation.isPending ? "Recording..." : `Record ${formatRecommendationDecision(decisionDialog.decision)}`}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
