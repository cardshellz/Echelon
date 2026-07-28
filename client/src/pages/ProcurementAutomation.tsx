// Automation page — design surface 03 (/procurement/automation, mockup
// 03-automation.html, design spec §5 + §13). This page re-homes everything
// "automation" that previously lived on the legacy PurchasingView and inside
// ExclusionRulesModal's automation sections:
//   1. the automation ladder (honest version — see below) + mode/policy
//      settings PATCHed to /api/purchasing/auto-draft-settings,
//   2. the quality-gate rollup + approval-policy impact preview from the
//      reorder-analysis response,
//   3. the FULL recommendation review queue + audited decision dialog,
//   4. auto-draft run status / history / manual trigger.
//
// HONESTY OVER CHROME (deliberate deviations from the mock): the mock's
// per-vendor stages, category overrides, spend caps, kill switch, anomaly
// rules, and promotion tracking DO NOT exist server-side. The ladder renders
// the two real, switchable modes — Observe (= review_only) and Auto-draft
// (= draft_po) — and shows Auto-send / Full autopilot as locked "Soon" stages
// with no controls. Every rendered value on this page comes from a real
// endpoint; nothing is invented.
//
// Settings sections are composed fresh against the SAME endpoints the legacy
// ExclusionRulesModal uses (GET/PATCH /api/purchasing/auto-draft-settings)
// rather than extracting shared components out of the modal: the modal must
// keep byte-identical behavior while it awaits retirement into Planning
// Policy (design surface 06), and its sections are wired to modal-local state
// (open-gated queries, draft inputs). The server contract is the shared seam.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Lock,
  MoreHorizontal,
  Send,
  ShoppingCart,
  XCircle,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { reorderAnalysisSearchParams } from "@/features/purchasing/reorderAnalysisDeepLink";

// ---------------------------------------------------------------------------
// Engine tab strip — same rev-1 single-entry strip as ReorderEngine.tsx with
// "Automation" as the current page. Runs / RFQs remain inert Soon chips.
// ---------------------------------------------------------------------------

const ENGINE_TABS_COMING_SOON = ["Runs", "RFQs"] as const;

// ---------------------------------------------------------------------------
// API types — client-side mirrors of the real server responses.
// ---------------------------------------------------------------------------

// GET/PATCH /api/purchasing/auto-draft-settings
// (procurement.storage.ts getAutoDraftSettings / purchasing-recommendation.routes.ts PATCH validation)
interface AutoDraftStalePoThresholds {
  reviewPendingWarningDays: number;
  reviewPendingCriticalDays: number;
  supplierSendWarningDays: number;
  supplierSendCriticalDays: number;
  supplierFollowupWarningDays: number;
  supplierFollowupCriticalDays: number;
  receivingWarningDays: number;
  receivingCriticalDays: number;
  apCloseoutWarningDays: number;
  apCloseoutCriticalDays: number;
  exceptionBlockedWarningDays: number;
  exceptionBlockedCriticalDays: number;
  closeoutWarningDays: number;
  closeoutCriticalDays: number;
}

interface AutoDraftSettings {
  autoDraftMode: "draft_po" | "review_only";
  approvalPolicy: AutoDraftApprovalPolicy;
  includeOrderSoon: boolean;
  skipOnOpenPo: boolean;
  skipNoVendor: boolean;
  candidateScoreStrongThreshold: number;
  candidateScoreReviewThreshold: number;
  rfqDraftAutomationMode: "manual" | "preferred_vendor";
  rfqDraftMinimumConfidence: "high" | "medium";
  rfqDraftRequireTrustedForecast: boolean;
  rfqDraftMaximumLinesPerRun: number;
  stalePoThresholds: AutoDraftStalePoThresholds;
}

type AutoDraftApprovalPolicy = "high_confidence_only" | "high_confidence_and_strong_candidate";

interface RecommendationQualityControl {
  area: string;
  severity: "review" | "block";
  code: string;
  label: string;
  detail: string;
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

interface RecommendationQualityGate {
  autoDraftEligible: boolean;
  reason: string;
  label: string;
  detail: string;
}

// GET /api/purchasing/reorder-analysis — only the summary + approvalPolicyImpact
// slices this page consumes (buildApprovalPolicyImpact in purchasing-recommendation.routes.ts).
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
    recommendationCandidateScore?: RecommendationCandidateScore;
    qualityGate?: RecommendationQualityGate;
  }>;
}

interface ReorderAnalysisSlice {
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

// GET /api/purchasing/recommendation-review-queue — full port of the legacy
// PurchasingView contract.
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
  reason: { code: string; label: string; detail: string };
  action: { action: string; label: string; href: string };
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
  candidateScore?: RecommendationCandidateScore;
  qualityGate?: RecommendationQualityGate;
  qualityControls?: RecommendationQualityControl[];
  demandEvidence?: {
    lookbackDays: number;
    periodUsagePieces: number;
    priorPeriodUsagePieces: number | null;
    avgDailyUsagePieces: number;
    demandQuality: string;
    demandTrend: string;
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
  filteredCount: number;
  items: RecommendationReviewQueueItem[];
}

// GET /api/purchasing/auto-draft/status + /runs (normalizeAutoDraftRun in
// purchasing-recommendation.routes.ts) — the simplified subset this page renders.
type AutoDraftRunStatus = "running" | "success" | "error" | "interrupted";

interface AutoDraftRun {
  id: number;
  runAt: string;
  triggeredBy: string | null;
  status: AutoDraftRunStatus;
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
  posCreated: number;
  posUpdated: number;
  linesAdded: number;
  skippedNoVendor: number;
  skippedOnOrder: number;
  skippedExcluded: number;
  errorMessage: string | null;
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
  runs: AutoDraftRun[];
}

// ---------------------------------------------------------------------------
// Constants + pure helpers (ported from PurchasingView / ExclusionRulesModal /
// PurchasingDashboard so behavior matches the legacy surfaces exactly).
// ---------------------------------------------------------------------------

type CandidateBandFilter = "all" | "strong_candidate" | "review_candidate" | "watch" | "blocked";

const CANDIDATE_BAND_FILTERS: CandidateBandFilter[] = [
  "all",
  "strong_candidate",
  "review_candidate",
  "watch",
  "blocked",
];

const REVIEW_QUEUE_FILTERS: Array<{ value: ReviewQueueKind; label: string }> = [
  { value: "all", label: "All" },
  { value: "skipped", label: "Skipped" },
  { value: "held_by_policy", label: "Policy Holds" },
  { value: "quality_review_required", label: "Quality Review" },
];

function isCandidateBandFilter(value: string | null): value is CandidateBandFilter {
  return CANDIDATE_BAND_FILTERS.some((option) => option === value);
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

function reviewQueueFilterCount(
  summary: RecommendationReviewQueueResponse["summary"] | undefined,
  filter: ReviewQueueKind,
): number {
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

function autoDraftRunHasActiveLease(run: AutoDraftRun | null | undefined): boolean {
  if (!run || run.status !== "running" || !run.leaseExpiresAt) return false;
  const leaseExpiresAt = Date.parse(run.leaseExpiresAt);
  return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
}

function autoDraftActionClass(severity: string): string {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700 hover:bg-red-100";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100";
  return "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50";
}

// Stale-PO aging rows — identical to ExclusionRulesModal (same defaults the
// server COALESCEs to in getAutoDraftSettings).
const DEFAULT_STALE_PO_THRESHOLDS: AutoDraftStalePoThresholds = {
  reviewPendingWarningDays: 2,
  reviewPendingCriticalDays: 5,
  supplierSendWarningDays: 2,
  supplierSendCriticalDays: 5,
  supplierFollowupWarningDays: 7,
  supplierFollowupCriticalDays: 14,
  receivingWarningDays: 3,
  receivingCriticalDays: 10,
  apCloseoutWarningDays: 7,
  apCloseoutCriticalDays: 21,
  exceptionBlockedWarningDays: 1,
  exceptionBlockedCriticalDays: 3,
  closeoutWarningDays: 7,
  closeoutCriticalDays: 14,
};

const STALE_PO_THRESHOLD_ROWS: Array<{
  label: string;
  warningKey: keyof AutoDraftStalePoThresholds;
  criticalKey: keyof AutoDraftStalePoThresholds;
}> = [
  { label: "Review", warningKey: "reviewPendingWarningDays", criticalKey: "reviewPendingCriticalDays" },
  { label: "Send", warningKey: "supplierSendWarningDays", criticalKey: "supplierSendCriticalDays" },
  { label: "Supplier", warningKey: "supplierFollowupWarningDays", criticalKey: "supplierFollowupCriticalDays" },
  { label: "Receiving", warningKey: "receivingWarningDays", criticalKey: "receivingCriticalDays" },
  { label: "AP", warningKey: "apCloseoutWarningDays", criticalKey: "apCloseoutCriticalDays" },
  { label: "Exceptions", warningKey: "exceptionBlockedWarningDays", criticalKey: "exceptionBlockedCriticalDays" },
  { label: "Closeout", warningKey: "closeoutWarningDays", criticalKey: "closeoutCriticalDays" },
];

function thresholdInputDefaults(): Record<keyof AutoDraftStalePoThresholds, string> {
  return Object.fromEntries(
    Object.entries(DEFAULT_STALE_PO_THRESHOLDS).map(([key, value]) => [key, String(value)]),
  ) as Record<keyof AutoDraftStalePoThresholds, string>;
}

// ---------------------------------------------------------------------------
// The automation ladder — honest rendering. Stages 1–2 map onto the ONLY real
// server-side switch (`autoDraftMode`: review_only | draft_po). Stages 3–4 are
// design-spec futures (spec §9 steps 5 and 7) with no server implementation:
// locked, no controls.
// ---------------------------------------------------------------------------

const LADDER_STAGES: Array<{
  stage: number;
  name: string;
  mode: AutoDraftSettings["autoDraftMode"] | null;
  icon: typeof Eye;
  description: string;
}> = [
  {
    stage: 1,
    name: "Observe",
    mode: "review_only",
    icon: Eye,
    description:
      "Runs record an auditable recommendation set only. No POs are created or updated.",
  },
  {
    stage: 2,
    name: "Auto-draft",
    mode: "draft_po",
    icon: FileText,
    description:
      "Runs create draft POs for priced recommendations that pass the quality gate and approval policy. A human reviews and sends everything.",
  },
  {
    stage: 3,
    name: "Auto-send",
    mode: null,
    icon: Send,
    description:
      "Eligible POs would send to the vendor automatically inside spend caps. Not built yet — no server support.",
  },
  {
    stage: 4,
    name: "Full autopilot",
    mode: null,
    icon: Zap,
    description:
      "RFQ send, quote award within tolerance, and PO conversion. Not built yet — planned last, after accuracy trust thresholds exist.",
  },
];

export default function ProcurementAutomation() {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ----- deep-link honored filters (same param names PurchasingView reads) -----
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
  // candidateBand filtered the legacy analysis table; that table lives on the
  // cockpit now, so here the param narrows the review queue by scored band —
  // the closest surface that exists on this page.
  const [candidateBandFilter, setCandidateBandFilter] = useState<CandidateBandFilter>(() => {
    const params = reorderAnalysisSearchParams(location);
    const requested = params.get("candidateBand");
    return isCandidateBandFilter(requested) ? requested : "all";
  });

  // ----- decision dialog state (exact legacy evidence contract) -----
  const [decisionDialog, setDecisionDialog] = useState<{
    item: RecommendationReviewQueueItem;
    decision: Exclude<RecommendationDecisionValue, "po_handoff_created">;
  } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const [reviewedControlCodes, setReviewedControlCodes] = useState<Set<string>>(new Set());
  const [automationEligibilityAcknowledged, setAutomationEligibilityAcknowledged] = useState(false);
  const [decisionConfirmed, setDecisionConfirmed] = useState(false);
  const openedForecastDeepLinkRef = useRef<string | null>(null);

  // ----- settings draft state (batched saves, as the legacy modal does) -----
  const [candidateScoreStrongThreshold, setCandidateScoreStrongThreshold] = useState("80");
  const [candidateScoreReviewThreshold, setCandidateScoreReviewThreshold] = useState("60");
  const [stalePoThresholdInputs, setStalePoThresholdInputs] = useState<
    Record<keyof AutoDraftStalePoThresholds, string>
  >(thresholdInputDefaults());

  // ---------------- queries ----------------

  const { data: settings } = useQuery<AutoDraftSettings>({
    queryKey: ["/api/purchasing/auto-draft-settings"],
  });

  const { data: analysis, isLoading: isLoadingAnalysis } = useQuery<ReorderAnalysisSlice>({
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

  const { data: lastRun } = useQuery<AutoDraftRun | null>({
    queryKey: ["/api/purchasing/auto-draft/status"],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: autoDraftRunHistory } = useQuery<AutoDraftRunHistoryResponse>({
    queryKey: ["/api/purchasing/auto-draft/runs?limit=5"],
    refetchInterval: 5 * 60 * 1000,
  });

  // ---------------- mutations ----------------

  const updateSettingsMutation = useMutation({
    mutationFn: async (updates: Partial<AutoDraftSettings>) => {
      const res = await fetch("/api/purchasing/auto-draft-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to update settings");
      }
      return res.json();
    },
    onSuccess: () => {
      // Legacy modal invalidation set, plus the review queue that renders on
      // this page (policy changes move items between held/eligible).
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft-settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/stale-pos?limit=25"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-review-queue"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to update settings", description: err.message, variant: "destructive" });
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

  const runAutoDraftMutation = useMutation({
    mutationFn: async (): Promise<{ runId: number; interruptedRunIds: number[] }> => {
      const res = await fetch("/api/purchasing/auto-draft/run", { method: "POST" });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error ?? "Failed to trigger auto-draft");
      return payload;
    },
    onSuccess: (started) => {
      toast({ title: "Auto-draft started", description: `Run ${started.runId} has an active processing lease.` });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/runs?limit=5"] });
      // Second sweep once the run has had time to finish (same pattern as the
      // purchasing dashboard trigger).
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/status"] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft/runs?limit=5"] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-review-queue"] });
      }, 15000);
    },
    onError: (err: Error) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  // ---------------- settings drafts follow the server copy ----------------

  useEffect(() => {
    if (!settings) return;
    setCandidateScoreStrongThreshold(String(settings.candidateScoreStrongThreshold ?? 80));
    setCandidateScoreReviewThreshold(String(settings.candidateScoreReviewThreshold ?? 60));
    const stalePoThresholds = { ...DEFAULT_STALE_PO_THRESHOLDS, ...(settings.stalePoThresholds ?? {}) };
    setStalePoThresholdInputs(Object.fromEntries(
      Object.entries(stalePoThresholds).map(([key, value]) => [key, String(value)]),
    ) as Record<keyof AutoDraftStalePoThresholds, string>);
  }, [settings]);

  // Validation identical to ExclusionRulesModal.saveCandidateThresholds.
  const saveCandidateThresholds = () => {
    const strongThreshold = Number(candidateScoreStrongThreshold);
    const reviewThreshold = Number(candidateScoreReviewThreshold);
    if (!Number.isInteger(strongThreshold) || strongThreshold < 0 || strongThreshold > 100) {
      toast({ title: "Invalid strong threshold", description: "Use a whole number from 0 to 100.", variant: "destructive" });
      return;
    }
    if (!Number.isInteger(reviewThreshold) || reviewThreshold < 0 || reviewThreshold > 100) {
      toast({ title: "Invalid review threshold", description: "Use a whole number from 0 to 100.", variant: "destructive" });
      return;
    }
    if (reviewThreshold > strongThreshold) {
      toast({
        title: "Invalid thresholds",
        description: "Review threshold must be less than or equal to the strong threshold.",
        variant: "destructive",
      });
      return;
    }
    updateSettingsMutation.mutate({
      candidateScoreStrongThreshold: strongThreshold,
      candidateScoreReviewThreshold: reviewThreshold,
    });
  };

  // Validation identical to ExclusionRulesModal.saveStalePoThresholds.
  const saveStalePoThresholds = () => {
    const parsed = {} as AutoDraftStalePoThresholds;
    for (const key of Object.keys(DEFAULT_STALE_PO_THRESHOLDS) as Array<keyof AutoDraftStalePoThresholds>) {
      const value = Number(stalePoThresholdInputs[key]);
      if (!Number.isInteger(value) || value < 0 || value > 365) {
        toast({ title: "Invalid stale PO threshold", description: "Use whole days from 0 to 365.", variant: "destructive" });
        return;
      }
      parsed[key] = value;
    }
    for (const row of STALE_PO_THRESHOLD_ROWS) {
      if (parsed[row.warningKey] > parsed[row.criticalKey]) {
        toast({
          title: "Invalid stale PO thresholds",
          description: `${row.label} warning days must be less than or equal to critical days.`,
          variant: "destructive",
        });
        return;
      }
    }
    updateSettingsMutation.mutate({ stalePoThresholds: parsed });
  };

  // ---------------- review queue derived data + handlers ----------------

  // The first four filters are the legacy queue behavior verbatim. The band
  // filter is this page's adaptation of candidateBand (see the state comment)
  // with one precedence rule: a pinned recommendationId wins over it. Frozen
  // notification links carry the band as it was at generation time, and score
  // drift must never hide the exact recommendation the link targets — on the
  // legacy page the band never filtered the queue, so the pinned item always
  // surfaced there.
  const filteredReviewQueue = (recommendationReviewQueue?.items ?? [])
    .filter((item) => reviewQueueFilter === "all" || item.kind === reviewQueueFilter)
    .filter((item) => reviewQueueReasonFilter === "all" || item.reason.code === reviewQueueReasonFilter)
    .filter((item) => reviewQueueForecastActionFilter === "all" || item.forecastAction?.code === reviewQueueForecastActionFilter)
    .filter((item) => reviewQueueRecommendationId === "all" || item.recommendationId === reviewQueueRecommendationId)
    .filter(
      (item) =>
        candidateBandFilter === "all" ||
        reviewQueueRecommendationId !== "all" ||
        item.candidateScore?.band === candidateBandFilter,
    )
    .slice(0, 12);

  const approvalPolicyImpact = analysis?.approvalPolicyImpact;

  // Deep-link auto-behavior, ported from PurchasingView: when the link pins a
  // single recommendation, scroll it into view; when it also carries a
  // forecastAction, open the audited review dialog once.
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

  // Server-generated hrefs target /reorder-analysis?… (frozen contract). The
  // review queue lives HERE now, so review-queue hrefs apply as in-page
  // filters — same intercept the legacy page used — and anything else
  // navigates normally.
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
      document.getElementById("recommendation-review-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    navigate(href);
  };

  // prepare_rfq now deep-links to the cockpit (RFQ selection lives there);
  // the legacy page scrolled to its in-page RFQ section instead.
  const handleReviewQueueAction = (item: RecommendationReviewQueueItem) => {
    if (item.action.action === "prepare_rfq") {
      navigate(`/reorder-analysis?recommendationId=${encodeURIComponent(item.recommendationId)}`);
      return;
    }
    handleRecommendationHref(item.action.href);
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

  // ---------------- runs ----------------

  const recentAutoDraftRuns = autoDraftRunHistory?.runs ?? [];
  const autoDraftRunActive = autoDraftRunHasActiveLease(lastRun);
  const activeMode = settings?.autoDraftMode ?? null;

  return (
    <div className="p-4 md:p-6">
      {/* ---------------- Topbar ---------------- */}
      <div className="mb-2 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold md:text-2xl">Automation</h1>
          <div className="mt-0.5 text-xs text-zinc-500">
            Auto-draft mode, approval policy, and the recommendation review queue
            {analysis ? ` · ${analysis.lookbackDays}-day demand lookback` : ""}
          </div>
        </div>
      </div>

      {/* ---------------- Engine tab strip ---------------- */}
      <div className="mb-4 overflow-x-auto">
        <nav aria-label="Reorder Engine sections" className="flex w-max min-w-full items-center gap-1 whitespace-nowrap border-b">
          <Link
            href="/reorder-analysis"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Analysis
          </Link>
          <Link
            href="/demand-planner"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Demand Planner
          </Link>
          <span aria-current="page" className="-mb-px border-b-2 border-primary px-3 py-1.5 text-sm font-semibold text-primary">
            Automation
          </span>
          {ENGINE_TABS_COMING_SOON.map((label) => (
            <span
              key={label}
              aria-disabled="true"
              className="-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground/50"
            >
              {label}
              <span className="rounded-full border border-border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                Soon
              </span>
            </span>
          ))}
        </nav>
      </div>

      {/* ---------------- 1 · The automation ladder ---------------- */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">The automation ladder</CardTitle>
          <CardDescription>
            How much the system is allowed to do on its own. Two stages are live today; auto-send and full
            autopilot are designed but not built.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {LADDER_STAGES.map((stage) => {
              const StageIcon = stage.icon;
              const isReal = stage.mode !== null;
              const isActive = isReal && activeMode === stage.mode;
              return (
                <button
                  key={stage.stage}
                  type="button"
                  disabled={!isReal || updateSettingsMutation.isPending || !settings}
                  onClick={() => {
                    if (!isReal || stage.mode === activeMode) return;
                    updateSettingsMutation.mutate({ autoDraftMode: stage.mode! });
                  }}
                  className={`flex flex-col gap-2 rounded-md border p-3 text-left transition-colors ${
                    isActive
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : isReal
                        ? "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
                        : "cursor-not-allowed border-dashed border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <StageIcon className={`h-4 w-4 ${isReal ? "text-primary" : "text-zinc-400"}`} />
                    <span className={`text-sm font-semibold ${isReal ? "" : "text-zinc-400"}`}>
                      Stage {stage.stage} · {stage.name}
                    </span>
                    {isActive ? (
                      <Badge variant="outline" className="ml-auto border-green-200 bg-green-50 text-[10px] text-green-700">
                        Active
                      </Badge>
                    ) : !isReal ? (
                      <Badge variant="outline" className="ml-auto gap-1 text-[10px] text-zinc-500">
                        <Lock className="h-2.5 w-2.5" />
                        Soon
                      </Badge>
                    ) : null}
                  </div>
                  <p className={`text-xs leading-5 ${isReal ? "text-zinc-500" : "text-zinc-400"}`}>
                    {stage.description}
                  </p>
                </button>
              );
            })}
          </div>
          {!settings ? (
            <div className="mt-2 text-xs text-zinc-500">Loading automation settings…</div>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- 2 · Mode & policy settings ---------------- */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Draft PO guardrails</CardTitle>
            <CardDescription>
              Which actionable recommendations may create or update draft POs. RFQ requirements stay price-free;
              these controls apply only after a supplier and usable quote exist.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border bg-muted/40 p-3">
              <h4 className="mb-1 text-sm font-medium">Approval policy</h4>
              <p className="mb-2 text-[11px] text-muted-foreground">
                Controls which actionable recommendations are allowed to create or update draft POs.
              </p>
              <Select
                value={settings?.approvalPolicy ?? "high_confidence_only"}
                onValueChange={(value) => updateSettingsMutation.mutate({
                  approvalPolicy: value as AutoDraftApprovalPolicy,
                })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high_confidence_only">High confidence only</SelectItem>
                  <SelectItem value="high_confidence_and_strong_candidate">
                    High confidence + strong candidate
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {settings?.approvalPolicy === "high_confidence_and_strong_candidate"
                  ? "Draft POs require the high-confidence quality gate and the strong candidate score band."
                  : "Draft POs require the high-confidence quality gate. Candidate score stays review-only."}
              </p>
            </div>

            <div className="rounded-md border bg-muted/40 p-3 space-y-3">
              <div>
                <h4 className="text-sm font-medium">Candidate score thresholds</h4>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Controls strong and review candidate bands. The stricter approval policy also uses the strong band.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-muted-foreground">Review candidate at</label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={candidateScoreReviewThreshold}
                    onChange={(event) => setCandidateScoreReviewThreshold(event.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-semibold text-muted-foreground">Strong candidate at</label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={candidateScoreStrongThreshold}
                    onChange={(event) => setCandidateScoreStrongThreshold(event.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={saveCandidateThresholds}
                  disabled={updateSettingsMutation.isPending}
                >
                  Save thresholds
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium">Include "Order Soon" items in auto-draft</h4>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Default: only Order Now and Stockout. Enable to also draft Order Soon items.</p>
              </div>
              <Switch
                checked={settings?.includeOrderSoon ?? false}
                onCheckedChange={(v) => updateSettingsMutation.mutate({ includeOrderSoon: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium">Skip items already on an open PO</h4>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Recommended on. Prevents duplicate orders when a PO is already sent/acknowledged.</p>
              </div>
              <Switch
                checked={settings?.skipOnOpenPo ?? true}
                onCheckedChange={(v) => updateSettingsMutation.mutate({ skipOnOpenPo: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium">Skip items with no preferred vendor</h4>
                <p className="mt-0.5 text-[11px] text-muted-foreground">When off, unassigned items go to a catch-all "Unassigned" draft PO instead of being skipped.</p>
              </div>
              <Switch
                checked={settings?.skipNoVendor ?? true}
                onCheckedChange={(v) => updateSettingsMutation.mutate({ skipNoVendor: v })}
              />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">RFQ draft automation</CardTitle>
              <CardDescription>
                Scheduled recommendation runs can prepare price-free RFQ drafts for trusted requirements with an
                existing preferred supplier. Drafts are never sent automatically.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-[10px] text-muted-foreground">Draft mode</label>
                  <Select
                    value={settings?.rfqDraftAutomationMode ?? "manual"}
                    onValueChange={(value) => updateSettingsMutation.mutate({ rfqDraftAutomationMode: value as AutoDraftSettings["rfqDraftAutomationMode"] })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual selection only</SelectItem>
                      <SelectItem value="preferred_vendor">Draft for preferred suppliers</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] text-muted-foreground">Minimum demand confidence</label>
                  <Select
                    value={settings?.rfqDraftMinimumConfidence ?? "high"}
                    onValueChange={(value) => updateSettingsMutation.mutate({ rfqDraftMinimumConfidence: value as AutoDraftSettings["rfqDraftMinimumConfidence"] })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="high">High only</SelectItem>
                      <SelectItem value="medium">Medium or high</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] text-muted-foreground">Maximum lines per run</label>
                  <Select
                    value={String(settings?.rfqDraftMaximumLinesPerRun ?? 100)}
                    onValueChange={(value) => updateSettingsMutation.mutate({ rfqDraftMaximumLinesPerRun: Number(value) })}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[25, 50, 100, 250, 500].map((value) => <SelectItem key={value} value={String(value)}>{value} lines</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md border bg-background px-3 py-2">
                  <div>
                    <div className="text-xs font-medium">Require trusted forecast</div>
                    <p className="text-[10px] text-muted-foreground">Hold watch/review demand signals for an operator.</p>
                  </div>
                  <Switch
                    checked={settings?.rfqDraftRequireTrustedForecast ?? true}
                    onCheckedChange={(value) => updateSettingsMutation.mutate({ rfqDraftRequireTrustedForecast: value })}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Stale PO aging thresholds</CardTitle>
              <CardDescription>
                Controls when auto-draft POs appear in stale aging diagnostics. Values are days in the current PO stage.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_74px_74px] gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <span>Stage</span>
                  <span>Warn</span>
                  <span>Critical</span>
                </div>
                {STALE_PO_THRESHOLD_ROWS.map((row) => (
                  <div key={row.label} className="grid grid-cols-[1fr_74px_74px] items-center gap-2">
                    <span className="text-xs font-medium">{row.label}</span>
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      step={1}
                      value={stalePoThresholdInputs[row.warningKey]}
                      onChange={(event) => setStalePoThresholdInputs((current) => ({
                        ...current,
                        [row.warningKey]: event.target.value,
                      }))}
                      className="h-8 text-xs"
                    />
                    <Input
                      type="number"
                      min={0}
                      max={365}
                      step={1}
                      value={stalePoThresholdInputs[row.criticalKey]}
                      onChange={(event) => setStalePoThresholdInputs((current) => ({
                        ...current,
                        [row.criticalKey]: event.target.value,
                      }))}
                      className="h-8 text-xs"
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={saveStalePoThresholds}
                  disabled={updateSettingsMutation.isPending}
                >
                  Save aging thresholds
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ---------------- 3 · Quality gate rollup (from reorder-analysis summary) ---------------- */}
      {analysis?.summary && (
        <Card className="mb-6 shadow-sm dark:bg-zinc-900">
          <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
            <CardTitle className="text-lg">Autopilot Quality Gate</CardTitle>
            <CardDescription>Recommendation confidence and PO draft eligibility</CardDescription>
          </CardHeader>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 overflow-hidden rounded-md border border-zinc-200 divide-y divide-zinc-200 dark:border-zinc-800 dark:divide-zinc-800 md:grid-cols-5 md:divide-y-0 md:divide-x">
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Eligible</div>
                <div className="text-2xl font-bold text-green-700">{analysis.summary.autoDraftEligibleCount}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Needs Review</div>
                <div className="text-2xl font-bold text-amber-700">{analysis.summary.autoDraftReviewRequiredCount}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">High Confidence</div>
                <div className="text-2xl font-bold">{analysis.summary.highConfidenceCount}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Medium</div>
                <div className="text-2xl font-bold">{analysis.summary.mediumConfidenceCount}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Low</div>
                <div className="text-2xl font-bold">{analysis.summary.lowConfidenceCount}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------------- 4 · Approval policy impact (from reorder-analysis) ---------------- */}
      {approvalPolicyImpact && (
        <Card className="mb-6 shadow-sm dark:bg-zinc-900">
          <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
            <CardTitle className="text-lg">Approval Policy Impact</CardTitle>
            <CardDescription>Read-only preview of the active auto-draft approval policy before running auto-draft.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="grid grid-cols-2 overflow-hidden rounded-md border border-zinc-200 divide-y divide-zinc-200 dark:border-zinc-800 dark:divide-zinc-800 md:grid-cols-5 md:divide-y-0 md:divide-x">
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Active Policy</div>
                <div className="mt-1 text-sm font-semibold">{formatApprovalPolicy(approvalPolicyImpact.policy)}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Quality Eligible</div>
                <div className="text-2xl font-bold">{approvalPolicyImpact.qualityGateEligibleCount}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Policy Approved</div>
                <div className="text-2xl font-bold text-green-700">{approvalPolicyImpact.approvalPolicyEligibleCount}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
                <div className="text-xs text-zinc-500">Held By Policy</div>
                <div className="text-2xl font-bold text-amber-700">{approvalPolicyImpact.approvalPolicyBlockedCount}</div>
              </div>
              <div className="bg-white p-3 dark:bg-zinc-900">
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
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 border-amber-300 text-[11px] text-amber-700 hover:bg-amber-100"
                    onClick={() => handleRecommendationHref("/reorder-analysis?reviewQueue=held_by_policy")}
                  >
                    Review Held Items
                  </Button>
                </div>
                {approvalPolicyImpact.heldRecommendations.length > 0 && (
                  <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                    {approvalPolicyImpact.heldRecommendations.slice(0, 4).map((item) => (
                      <div key={item.recommendationId} className="rounded border bg-white/80 p-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono font-semibold text-primary">{item.sku}</span>
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
      {isLoadingAnalysis && !analysis ? (
        <div className="mb-6 rounded-md border border-dashed p-4 text-sm text-zinc-500">
          Loading quality-gate and approval-policy rollups…
        </div>
      ) : null}

      {/* ---------------- 5 · Recommendation review queue (full port) ---------------- */}
      <Card id="recommendation-review-queue" className="mb-6 scroll-mt-24 shadow-sm dark:bg-zinc-900">
        <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
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
                  className="h-7 gap-1 text-[11px]"
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
                  className="h-7 gap-1 border-amber-200 bg-amber-50 text-[11px] text-amber-700"
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
                  className="h-7 gap-1 border-blue-200 bg-blue-50 text-[11px] text-blue-700"
                  onClick={() => setReviewQueueForecastActionFilter("all")}
                >
                  {formatForecastAction(reviewQueueForecastActionFilter)}
                  <span className="rounded bg-white/60 px-1">Clear</span>
                </Button>
              )}
              {candidateBandFilter !== "all" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 border-green-200 bg-green-50 text-[11px] capitalize text-green-700"
                  onClick={() => setCandidateBandFilter("all")}
                >
                  {formatCandidateBand(candidateBandFilter)}
                  <span className="rounded bg-white/60 px-1">Clear</span>
                </Button>
              )}
              {reviewQueueRecommendationId !== "all" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 border-violet-200 bg-violet-50 text-[11px] text-violet-700"
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
            <div className="rounded-md border border-dashed bg-white p-4 text-sm text-zinc-500 dark:bg-zinc-900">
              No recommendations match this review filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {filteredReviewQueue.map((item) => (
                <div
                  key={`${item.recommendationId}-${item.kind}`}
                  id={item.recommendationId === reviewQueueRecommendationId ? "recommendation-review-target" : undefined}
                  className={`rounded-md border bg-white p-3 dark:bg-zinc-900 ${
                    item.recommendationId === reviewQueueRecommendationId
                      ? "border-violet-400 ring-2 ring-violet-200"
                      : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-xs font-semibold text-primary">{item.sku}</span>
                        <Badge variant="outline" className={`text-[10px] ${reviewQueueSeverityClass(item.severity)}`}>
                          {item.reason.label}
                        </Badge>
                        <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-[10px] text-zinc-600">
                          {formatReviewQueueKind(item.kind)}
                        </Badge>
                        {item.candidateScore ? (
                          <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(item.candidateScore.band)}`}>
                            {item.candidateScore.score} - {formatCandidateBand(item.candidateScore.band)}
                          </Badge>
                        ) : null}
                        {item.forecastAction ? (
                          <Badge variant="outline" className="border-blue-200 bg-blue-50 text-[10px] text-blue-700">
                            {item.forecastAction.label}
                          </Badge>
                        ) : null}
                        {item.latestDecision ? (
                          <Badge variant="outline" className={`text-[10px] ${recommendationDecisionClass(item.latestDecision.decision)}`}>
                            {formatRecommendationDecision(item.latestDecision.decision)}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-sm font-medium">{item.productName}</div>
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{item.reason.detail}</p>
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

      {/* ---------------- 6 · Auto-draft runs ---------------- */}
      <Card className="mb-6 shadow-sm dark:bg-zinc-900">
        <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <CardTitle className="text-lg">Auto-Draft Runs</CardTitle>
              <CardDescription>Latest run status and recent history. Manual trigger requires the admin role.</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => runAutoDraftMutation.mutate()}
              disabled={runAutoDraftMutation.isPending || autoDraftRunActive}
            >
              <Zap className="h-3 w-3" />
              {runAutoDraftMutation.isPending || autoDraftRunActive ? "Auto-Draft Running" : "Run Auto-Draft Now"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          {lastRun ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full ${autoDraftRunStatusDotClass(lastRun.status)}`} />
                <span className="text-xs">
                  Last run: {formatRelativeTime(lastRun.runAt)} - {autoDraftRunStatusLabel(lastRun.status)}
                  {lastRun.triggeredBy ? ` · triggered ${lastRun.triggeredBy}` : ""}
                </span>
              </div>
              {lastRun.errorMessage && lastRun.status !== "success" ? (
                <div className={`mb-3 text-xs ${lastRun.status === "interrupted" ? "text-amber-700" : "text-red-600"}`}>
                  {lastRun.errorMessage}
                </div>
              ) : null}
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4">
                {[
                  { label: "Items analyzed", value: lastRun.itemsAnalyzed },
                  { label: "Mode", value: lastRun.mode === "review_only" ? "Recommendation only" : "Create draft POs" },
                  { label: "Approval policy", value: formatApprovalPolicy(lastRun.approvalPolicy) },
                  { label: "POs created/updated", value: `${lastRun.posCreated}/${lastRun.posUpdated}` },
                  { label: "Actionable", value: lastRun.actionableCount },
                  { label: "Eligible to draft", value: lastRun.autoDraftEligibleCount },
                  { label: "Policy approved", value: lastRun.approvalPolicyEligibleCount },
                  { label: "Held by policy", value: lastRun.approvalPolicyBlockedCount, warn: lastRun.approvalPolicyBlockedCount > 0 },
                  { label: "Needs review", value: lastRun.autoDraftReviewRequiredCount },
                  { label: "Skipped (no vendor)", value: lastRun.skippedNoVendor, warn: lastRun.skippedNoVendor > 0 },
                  { label: "Skipped (on order)", value: lastRun.skippedOnOrder },
                  { label: "Excluded SKUs", value: lastRun.skippedExcluded },
                ].map((row) => (
                  <div key={row.label} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{row.label}</span>
                    <span className={`font-semibold ${row.warn ? "text-amber-600" : ""}`}>{row.value}</span>
                  </div>
                ))}
              </div>
              {lastRun.recommendedActions?.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t pt-3">
                  {lastRun.recommendedActions.slice(0, 4).map((action) => (
                    <Button
                      key={action.action}
                      variant="outline"
                      size="sm"
                      className={`h-7 px-2 text-[11px] ${autoDraftActionClass(action.severity)}`}
                      title={action.detail}
                      onClick={() => handleRecommendationHref(action.href)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-xs text-muted-foreground">Never run</div>
          )}

          {recentAutoDraftRuns.length > 0 ? (
            <div className="mt-4 border-t pt-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Recent Runs
              </div>
              <div className="space-y-2">
                {recentAutoDraftRuns.slice(0, 5).map((run) => (
                  <div key={run.id} className="rounded border bg-muted/20 p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${autoDraftRunStatusDotClass(run.status)}`} />
                        <span className="truncate font-medium">{formatRelativeTime(run.runAt)}</span>
                        <span className="text-[11px] text-muted-foreground">{autoDraftRunStatusLabel(run.status)}</span>
                      </div>
                      <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                        {run.mode === "review_only" ? "Recommendation only" : "Draft POs"} - {formatApprovalPolicy(run.approvalPolicy)}
                      </span>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
                      <span>{run.itemsAnalyzed} analyzed</span>
                      <span>{run.autoDraftEligibleCount} eligible</span>
                      <span>{run.approvalPolicyEligibleCount} policy-approved</span>
                      <span className={run.approvalPolicyBlockedCount > 0 ? "text-amber-700" : ""}>
                        {run.approvalPolicyBlockedCount} held
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {run.posCreated + run.posUpdated} PO changes - {run.linesAdded} lines added
                    </div>
                    {(run.status === "error" || run.status === "interrupted") && run.errorMessage ? (
                      <div className={`mt-1 truncate text-[11px] ${run.status === "interrupted" ? "text-amber-700" : "text-red-600"}`}>
                        {run.errorMessage}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- Decision dialog (exact legacy evidence contract) ---------------- */}
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
