import { useState } from "react";
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
  DollarSign,
  PackageSearch,
  ShoppingCart,
  TrendingDown
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
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
  area: "demand" | "lead_time" | "supplier_cost" | "vendor";
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
    leadTimeSource: "vendor_product" | "product" | "default";
    safetyStockSource: "product" | "default";
    orderUomSource: "variant" | "default_each";
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
    reason: "high_confidence" | "medium_confidence_review" | "low_confidence_review" | "not_actionable";
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
  productId: number;
  productVariantId: number | null;
  sku: string;
  productName: string;
  status: string;
  actionable: boolean;
  skippedReason: string | null;
  preferredVendorId: number | null;
  preferredVendorName: string | null;
  suggestedOrderQty: number;
  orderUomLabel: string;
  candidateScore?: ReorderItem["recommendationCandidateScore"];
  qualityGate?: ReorderItem["qualityGate"];
  qualityControls?: RecommendationQualityControl[];
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
  candidateBandCounts: Record<string, number>;
  filteredCount: number;
  items: RecommendationReviewQueueItem[];
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

export default function PurchasingView() {
  const [sortField, setSortField] = useState("status");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [location, navigate] = useLocation();
  const [candidateBandFilter, setCandidateBandFilter] = useState<CandidateBandFilter>(() => {
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    const requested = params.get("candidateBand");
    return isCandidateBandFilter(requested) ? requested : "all";
  });
  const [reviewQueueFilter, setReviewQueueFilter] = useState<ReviewQueueKind>(() => {
    const params = new URLSearchParams(location.split("?")[1] ?? "");
    const requested = params.get("reviewQueue");
    return isReviewQueueKind(requested) ? requested : "all";
  });
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
    queryKey: ["/api/purchasing/recommendation-review-queue"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/recommendation-review-queue?limit=100");
      if (!res.ok) throw new Error("Failed to fetch recommendation review queue");
      return res.json();
    },
  });

  const autoDraftMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/purchasing/auto-draft-run", {
         method: "POST", 
         headers: { "Content-Type": "application/json" } 
      });
      if (!res.ok) throw new Error("Network response was not ok");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-review-queue"] });
      toast({
        title: "Autonomous Procurement Synced",
        description: `Successfully analyzed burn rates and updated ${data.count} Vendor POs for ${data.itemsDrafted} critical items.`,
      });
    },
    onError: () => {
      toast({
        title: "System Error",
        description: "The AI agent was unable to execute the PO drafting protocol.",
        variant: "destructive"
      });
    }
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
    .slice(0, 12);
  const approvalPolicyImpact = analysis?.approvalPolicyImpact;

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
    const costLabel =
      item.supplierBasis?.costQuality === "current"
        ? "cost current"
        : item.supplierBasis?.costQuality === "stale"
          ? "cost stale"
          : item.supplierBasis?.costQuality === "unverified"
            ? "cost unverified"
            : "cost missing";
    return `${methodLabel} - ${demandLabel} - ${sampleLabel} - ${usageLabel}${shortWindowLabel}${trendLabel ? ` - ${trendLabel}` : ""}${accelerationLabel}${baselineLabel}${seasonalLabel}${cycleLabel}${scoreLabel} - ${leadLabel} - ${costLabel}`;
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

  const handleReviewQueueAction = (item: RecommendationReviewQueueItem) => {
    if (item.action.href.startsWith("/reorder-analysis")) {
      const params = new URLSearchParams(item.action.href.split("?")[1] ?? "");
      const requestedBand = params.get("candidateBand");
      if (isCandidateBandFilter(requestedBand)) setCandidateBandFilter(requestedBand);
      const requestedQueue = params.get("reviewQueue");
      if (isReviewQueueKind(requestedQueue)) setReviewQueueFilter(requestedQueue);
      return;
    }
    navigate(item.action.href);
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
              Autonomous Inventory Health & Procurement Engine
            </p>
          </div>

          <Button 
            size="lg" 
            className="gap-2 shadow-lg hover:shadow-xl transition-all"
            onClick={() => autoDraftMutation.mutate()}
            disabled={autoDraftMutation.isPending}
          >
            {autoDraftMutation.isPending ? (
              <TrendingDown className="h-4 w-4 animate-bounce" />
            ) : (
              <ShoppingCart className="h-4 w-4" />
            )}
            Run Draft Protocol
          </Button>
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
                            {item.suggestedOrderQty} {item.orderUomLabel}
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
                      onClick={() => setReviewQueueFilter(option.value)}
                    >
                      {option.label}
                      <span className="rounded bg-white/20 px-1">
                        {reviewQueueFilterCount(recommendationReviewQueue?.summary, option.value)}
                      </span>
                    </Button>
                  ))}
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
                    <div key={`${item.recommendationId}-${item.kind}`} className="rounded-md border bg-white dark:bg-zinc-900 p-3">
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
                          </div>
                          <div className="mt-1 text-sm font-medium truncate">{item.productName}</div>
                          <p className="mt-1 text-xs text-zinc-500 line-clamp-2">{item.reason.detail}</p>
                          <div className="mt-2 text-[11px] text-zinc-500">
                            {item.suggestedOrderQty} {item.orderUomLabel}
                            {item.preferredVendorName ? ` - ${item.preferredVendorName}` : ""}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" className="h-7 text-[11px] flex-shrink-0" onClick={() => handleReviewQueueAction(item)}>
                          {item.action.label}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
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
    </div>
  );
}
