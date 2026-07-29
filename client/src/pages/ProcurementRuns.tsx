// Run report page — design surface 04 (/procurement/runs, mockup
// 04-run-report.html). Read-only report over the auto-draft run ledger:
//   1. run history (auto_draft_runs via GET /api/purchasing/auto-draft/runs),
//   2. a per-run report rendering ONLY what normalizeAutoDraftRun exposes from
//      the persisted summary_json (buildPurchasingRecommendationRunDetail in
//      purchasing-recommendation.run-detail.ts): mode + approval policy,
//      eligibility/held/blocked/needs-review counts, approval-policy band
//      diagnostics, forecast diagnostics + top autopilot blockers, the
//      persisted recommendation samples, and the server-built recommendedActions
//      (hrefs rendered as-is — they target routes that exist today),
//   3. the recommendation decision history (ported from PurchasingView),
//   4. the recommendation-pipeline health banner + the FULL forecast accuracy
//      detail (ForecastAccuracyPanel reused directly).
//
// HONESTY OVER CHROME (deliberate deviations from the mock): the mock's
// "Auto-sent" funnel stages, per-SKU actions table with run-level dollar
// totals, and the email digest DO NOT exist server-side — auto-send is not
// built, summary_json persists no per-run dollar rollup, and there is no
// digest service. Those are dropped, not faked. Every rendered value comes
// from a real endpoint.
//
// READ-ONLY BY DESIGN: this page performs no mutations. Manual run triggers
// and run-affecting settings live on the Automation page (design surface 03).
// The embedded ForecastAccuracyPanel owns its one evaluation mutation; that
// contract is pinned by the reorder-engine page that shipped it.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Activity, AlertTriangle, CheckCircle2, History, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ForecastAccuracyPanel } from "@/components/purchasing/ForecastAccuracyPanel";
import {
  purchaseRecommendationPipelineHealthSchema,
  type PurchaseRecommendationPipelineHealth,
} from "@/features/purchasing/forecastBacktesting";

// ---------------------------------------------------------------------------
// Engine tab strip — same rev-1 single-entry strip as ReorderEngine.tsx /
// ProcurementAutomation.tsx with "Runs" as the current page. All five engine
// surfaces have shipped ("RFQs" → /procurement/rfqs, mockup 05), so the strip
// carries no "Soon" chips anymore.
// ---------------------------------------------------------------------------

const RUN_HISTORY_LIMIT = 20;

// ---------------------------------------------------------------------------
// API types — client-side mirrors of the real server responses.
// ---------------------------------------------------------------------------

type AutoDraftRunStatus = "running" | "success" | "error" | "interrupted";
type AutoDraftApprovalPolicy = "high_confidence_only" | "high_confidence_and_strong_candidate";

// summary_json.approvalPolicyDiagnostics (buildApprovalPolicyDiagnostics in
// purchasing-recommendation.run-detail.ts); null for runs that failed before
// the detail was built or predate the field.
interface RunApprovalPolicyDiagnostics {
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

// summary_json.forecastDiagnostics (buildForecastDiagnostics) — only the slices
// this page renders; every field optional so older persisted runs degrade to
// the fallback copy instead of crashing.
interface RunForecastDiagnostics {
  recommendationCount?: number;
  avgRecommendationCandidateScore?: number;
  strongRecommendationCandidateCount?: number;
  recommendationCandidateBandCounts?: Record<string, number>;
  forecastTrustWatchCount?: number;
  forecastTrustReviewCount?: number;
  demandSuppressionReviewCount?: number;
  autopilotBlockerItemCount?: number;
  autopilotBlockerCounts?: Record<string, number>;
  supplierCycleOpenPoPastDueCount?: number;
  forecastMethodCounts?: Record<string, number>;
  latestDemandAt?: string | null;
}

// Entries of summary_json.actionableRecommendations /
// approvalPolicyBlockedRecommendations / skippedRecommendations
// (summarizeRecommendation) — normalizeAutoDraftRun serves the first 5 of each
// as recommendationSamples. NOTE: summarizeRecommendation does not persist
// orderUomUnits, so quantity formatting here works from qty/pieces/label only.
interface RunRecommendationSample {
  recommendationId: string;
  sku: string;
  productName: string;
  status: string;
  skippedReason: string | null;
  preferredVendorName: string | null;
  suggestedOrderQty: number;
  suggestedOrderPieces: number;
  orderUomLabel: string;
  estimatedCostCents: number | null;
  confidence: string;
  recommendationCandidateScore?: { score: number; band: string } | null;
  explanation?: string;
}

interface RunRecommendedAction {
  action: string;
  label: string;
  detail: string;
  href: string;
  severity: "critical" | "warning" | "info";
  count: number;
}

// GET /api/purchasing/auto-draft/runs — normalizeAutoDraftRun in
// purchasing-recommendation.routes.ts. Diagnostics objects are null when the
// stored summary_json is missing them (older runs, early failures); the count
// fields always exist because the server falls back to run-row columns.
interface AutoDraftRunReport {
  id: number;
  runAt: string;
  triggeredBy: string | null;
  triggeredByUser: string | null;
  status: AutoDraftRunStatus;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  itemsAnalyzed: number;
  posCreated: number;
  posUpdated: number;
  linesAdded: number;
  skippedNoVendor: number;
  skippedOnOrder: number;
  skippedExcluded: number;
  errorMessage: string | null;
  mode: "draft_po" | "review_only";
  approvalPolicy: AutoDraftApprovalPolicy;
  actionableCount: number;
  autoDraftEligibleCount: number;
  autoDraftReviewRequiredCount: number;
  approvalPolicyEligibleCount: number;
  approvalPolicyBlockedCount: number;
  draftMutationEligibleCount: number;
  approvalPolicyDiagnostics: RunApprovalPolicyDiagnostics | null;
  forecastDiagnostics: RunForecastDiagnostics | null;
  poMutationCount: number;
  recommendationSamples: {
    actionable: RunRecommendationSample[];
    approvalPolicyBlocked: RunRecommendationSample[];
    skipped: RunRecommendationSample[];
  };
  recommendationSampleCounts: {
    actionable: number;
    approvalPolicyBlocked: number;
    skipped: number;
  };
  recommendedActions: RunRecommendedAction[];
}

interface AutoDraftRunHistoryResponse {
  limit: number;
  runs: AutoDraftRunReport[];
}

// GET /api/purchasing/recommendation-decisions — same contract the legacy
// PurchasingView decision-history card consumes.
type RecommendationDecisionValue =
  | "reviewed"
  | "accepted_for_po"
  | "deferred"
  | "dismissed"
  | "po_handoff_created";

interface RecommendationDecision {
  id: number;
  recommendationId: string;
  kind: string;
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

// ---------------------------------------------------------------------------
// Pure helpers (same conventions as ProcurementAutomation / PurchasingView so
// badges and labels match across the engine surfaces).
// ---------------------------------------------------------------------------

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

function autoDraftRunStatusBadgeClass(status: AutoDraftRunStatus): string {
  switch (status) {
    case "success": return "bg-green-50 text-green-700 border-green-200";
    case "running": return "bg-blue-50 text-blue-700 border-blue-200";
    case "interrupted": return "bg-amber-50 text-amber-700 border-amber-200";
    case "error": return "bg-red-50 text-red-700 border-red-200";
  }
}

function formatRunTrigger(run: Pick<AutoDraftRunReport, "triggeredBy" | "triggeredByUser">): string {
  const trigger = run.triggeredBy === "scheduler"
    ? "Scheduled"
    : run.triggeredBy === "manual"
      ? "Manual"
      : run.triggeredBy ?? "Unknown trigger";
  return run.triggeredByUser ? `${trigger} · ${run.triggeredByUser}` : trigger;
}

function formatApprovalPolicy(policy?: AutoDraftApprovalPolicy | null): string {
  return policy === "high_confidence_and_strong_candidate"
    ? "High confidence + strong candidate"
    : "High confidence only";
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

// Presentation-only duration between run start and finish; null when either
// timestamp is missing/invalid (e.g. a run that is still running).
function formatRunDuration(runAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const startMs = Date.parse(runAt);
  const endMs = Date.parse(finishedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const totalSeconds = Math.round((endMs - startMs) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
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

function formatReviewQueueKind(kind: string): string {
  if (kind === "held_by_policy") return "Policy hold";
  if (kind === "quality_review_required") return "Quality review";
  return "Skipped";
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

function autoDraftActionClass(severity: string): string {
  if (severity === "critical") return "border-red-200 bg-red-50 text-red-700 hover:bg-red-100";
  if (severity === "warning") return "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100";
  return "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50";
}

// summarizeRecommendation persists qty, pieces, and label but NOT
// orderUomUnits, so the shared qty formatter cannot be reused verbatim here.
function formatSampleQuantity(sample: RunRecommendationSample): string {
  const orderUom = `${sample.suggestedOrderQty.toLocaleString()} ${sample.orderUomLabel}`;
  if (sample.suggestedOrderPieces === sample.suggestedOrderQty) return orderUom;
  return `${orderUom} (${sample.suggestedOrderPieces.toLocaleString()} pieces)`;
}

// Display-only conversion of integer cents; money math stays server-side.
function formatCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function humanizeCode(code: string): string {
  return code.replace(/_/g, " ");
}

// Top-N entries of a diagnostics count map, largest first, stable by key.
function topCounts(counts: Record<string, number> | undefined, limit: number): Array<[string, number]> {
  return Object.entries(counts ?? {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Pipeline-health banner — same endpoint + status colors as the banner inside
// ForecastAccuracyPanel; React Query dedupes the shared query key.
// ---------------------------------------------------------------------------

function PipelineHealthBanner() {
  const pipelineQuery = useQuery({
    queryKey: ["/api/procurement/health/recommendation-pipeline"],
    queryFn: async () => {
      const response = await fetch("/api/procurement/health/recommendation-pipeline");
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to load recommendation pipeline health");
      }
      return purchaseRecommendationPipelineHealthSchema.parse(await response.json());
    },
    refetchInterval: 5 * 60 * 1000,
  });

  const pipeline: PurchaseRecommendationPipelineHealth | undefined = pipelineQuery.data;

  return (
    <div className={`mb-4 rounded-md border px-3 py-2 text-xs ${
      pipelineQuery.isError
        ? "border-red-200 bg-red-50 text-red-900"
        : !pipeline
          ? "border-zinc-200 bg-zinc-50 text-zinc-700"
          : pipeline.status === "critical"
            ? "border-red-200 bg-red-50 text-red-900"
            : pipeline.status === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-emerald-200 bg-emerald-50/60 text-emerald-900"
    }`}>
      {pipelineQuery.isLoading ? (
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 animate-pulse" />
          Checking recommendation pipeline...
        </div>
      ) : pipelineQuery.isError || !pipeline ? (
        <div className="flex items-center gap-2 text-red-700">
          <AlertTriangle className="h-4 w-4" />
          {pipelineQuery.error instanceof Error
            ? pipelineQuery.error.message
            : "Recommendation pipeline health is unavailable"}
        </div>
      ) : (
        <div className="flex items-start gap-2">
          {pipeline.status === "healthy" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-emerald-600" />
          ) : (
            <AlertTriangle className={`mt-0.5 h-4 w-4 flex-none ${
              pipeline.status === "critical" ? "text-red-600" : "text-amber-600"
            }`} />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Recommendation evidence pipeline</span>
              <Badge
                variant={pipeline.status === "critical" ? "destructive" : "outline"}
                className="text-[10px] uppercase"
              >
                {pipeline.status}
              </Badge>
            </div>
            <div className="mt-0.5 leading-5">{pipeline.detail}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run detail sub-sections
// ---------------------------------------------------------------------------

function RunCountsGrid({ run }: { run: AutoDraftRunReport }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4">
      {[
        { label: "Items analyzed", value: run.itemsAnalyzed },
        { label: "Actionable", value: run.actionableCount },
        { label: "Eligible to draft", value: run.autoDraftEligibleCount },
        { label: "Needs review", value: run.autoDraftReviewRequiredCount },
        { label: "Policy approved", value: run.approvalPolicyEligibleCount },
        { label: "Held by policy", value: run.approvalPolicyBlockedCount, warn: run.approvalPolicyBlockedCount > 0 },
        { label: "Draft eligible", value: run.draftMutationEligibleCount },
        { label: "POs created/updated", value: `${run.posCreated}/${run.posUpdated}` },
        { label: "Lines added", value: run.linesAdded },
        { label: "Skipped (no vendor)", value: run.skippedNoVendor, warn: run.skippedNoVendor > 0 },
        { label: "Skipped (on order)", value: run.skippedOnOrder },
        { label: "Excluded SKUs", value: run.skippedExcluded },
      ].map((row) => (
        <div key={row.label} className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{row.label}</span>
          <span className={`font-semibold ${row.warn ? "text-amber-600" : ""}`}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

// counts may be absent on summary_json written by older builder versions.
function BandCountBadges({ counts }: { counts: Record<string, number> | undefined }) {
  const entries = topCounts(counts, 6);
  if (entries.length === 0) return <span className="text-xs text-zinc-500">none</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([band, count]) => (
        <Badge key={band} variant="outline" className={`text-[10px] capitalize ${candidateBandClass(band)}`}>
          {formatCandidateBand(band)} · {count}
        </Badge>
      ))}
    </div>
  );
}

function RunForecastDiagnosticsSection({ diagnostics }: { diagnostics: RunForecastDiagnostics | null }) {
  if (!diagnostics) {
    return (
      <div className="rounded-md border border-dashed p-3 text-xs text-zinc-500">
        Forecast diagnostics were not persisted for this run (older run, or the run failed before
        analysis completed).
      </div>
    );
  }
  const topBlockers = topCounts(diagnostics.autopilotBlockerCounts, 6);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
        {[
          { label: "Recommendations", value: diagnostics.recommendationCount ?? 0 },
          { label: "Avg candidate score", value: diagnostics.avgRecommendationCandidateScore ?? 0 },
          { label: "Strong candidates", value: diagnostics.strongRecommendationCandidateCount ?? 0 },
          {
            label: "Forecast trust watch/review",
            value: `${diagnostics.forecastTrustWatchCount ?? 0}/${diagnostics.forecastTrustReviewCount ?? 0}`,
            warn: (diagnostics.forecastTrustReviewCount ?? 0) > 0,
          },
          {
            label: "Demand suppression reviews",
            value: diagnostics.demandSuppressionReviewCount ?? 0,
            warn: (diagnostics.demandSuppressionReviewCount ?? 0) > 0,
          },
          {
            label: "Items with blockers",
            value: diagnostics.autopilotBlockerItemCount ?? 0,
            warn: (diagnostics.autopilotBlockerItemCount ?? 0) > 0,
          },
        ].map((row) => (
          <div key={row.label} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{row.label}</span>
            <span className={`font-semibold ${row.warn ? "text-amber-600" : ""}`}>{row.value}</span>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Top autopilot blockers
        </div>
        {topBlockers.length === 0 ? (
          <span className="text-xs text-zinc-500">No autopilot blockers were recorded on this run.</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {topBlockers.map(([code, count]) => (
              <Badge key={code} variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
                {humanizeCode(code)} · {count}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {diagnostics.latestDemandAt ? (
        <div className="text-[11px] text-zinc-500">
          Latest demand signal {new Date(diagnostics.latestDemandAt).toLocaleString()}
        </div>
      ) : null}
    </div>
  );
}

function RunSampleColumn({
  title,
  totalLabel,
  samples,
  persistedCount,
}: {
  title: string;
  totalLabel: string;
  samples: RunRecommendationSample[];
  persistedCount: number;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>{title}</span>
        <span>{totalLabel}</span>
      </div>
      {samples.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs text-zinc-500">None recorded on this run.</div>
      ) : (
        <div className="space-y-2">
          {samples.map((sample) => (
            <div key={sample.recommendationId} className="rounded-md border bg-white p-2 text-xs dark:bg-zinc-900">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono font-semibold text-primary">{sample.sku}</span>
                {sample.recommendationCandidateScore ? (
                  <Badge
                    variant="outline"
                    className={`text-[10px] capitalize ${candidateBandClass(sample.recommendationCandidateScore.band)}`}
                  >
                    {sample.recommendationCandidateScore.score} - {formatCandidateBand(sample.recommendationCandidateScore.band)}
                  </Badge>
                ) : null}
                {sample.skippedReason ? (
                  <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-[10px] text-zinc-600">
                    {humanizeCode(sample.skippedReason)}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 truncate font-medium">{sample.productName}</div>
              <div className="mt-1 text-zinc-500">
                {formatSampleQuantity(sample)}
                {sample.estimatedCostCents != null ? ` · ${formatCents(sample.estimatedCostCents)}` : ""}
                {sample.preferredVendorName ? ` · ${sample.preferredVendorName}` : ""}
              </div>
            </div>
          ))}
          {persistedCount > samples.length ? (
            <div className="text-[11px] text-zinc-500">
              Showing {samples.length} of {persistedCount} persisted samples.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function RunDetailCard({ run }: { run: AutoDraftRunReport }) {
  const duration = formatRunDuration(run.runAt, run.finishedAt);
  const diagnostics = run.approvalPolicyDiagnostics;
  return (
    <Card className="mb-6 shadow-sm dark:bg-zinc-900">
      <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
              Run #{run.id}
              <Badge variant="outline" className={`gap-1.5 text-[10px] ${autoDraftRunStatusBadgeClass(run.status)}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${autoDraftRunStatusDotClass(run.status)}`} />
                {autoDraftRunStatusLabel(run.status)}
              </Badge>
              <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-[10px] text-zinc-600">
                {formatRunTrigger(run)}
              </Badge>
            </CardTitle>
            <CardDescription>
              Started {new Date(run.runAt).toLocaleString()} ({formatRelativeTime(run.runAt)})
              {run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleString()}` : ""}
              {duration ? ` · ${duration}` : ""}
              {run.status === "running" && run.heartbeatAt
                ? ` · heartbeat ${formatRelativeTime(run.heartbeatAt)}`
                : ""}
            </CardDescription>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>
              Mode:{" "}
              <span className="font-semibold text-foreground">
                {run.mode === "review_only" ? "Recommendation only" : "Create draft POs"}
              </span>
            </div>
            <div>
              Approval policy:{" "}
              <span className="font-semibold text-foreground">{formatApprovalPolicy(run.approvalPolicy)}</span>
            </div>
            {diagnostics?.candidateScoreGateActive ? (
              <div className="mt-0.5">Candidate-score gate active</div>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {run.errorMessage && run.status !== "success" ? (
          <div className={`rounded-md border p-3 text-xs ${
            run.status === "interrupted"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}>
            {run.errorMessage}
          </div>
        ) : null}

        <RunCountsGrid run={run} />

        {diagnostics ? (
          <div className="grid grid-cols-1 gap-3 rounded-md border bg-muted/30 p-3 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Policy-approved candidate bands ({diagnostics.approvalPolicyEligibleCount})
              </div>
              <BandCountBadges counts={diagnostics.approvedCandidateBandCounts} />
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Held candidate bands ({diagnostics.approvalPolicyBlockedCount})
              </div>
              <BandCountBadges counts={diagnostics.blockedCandidateBandCounts} />
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-3 text-xs text-zinc-500">
            Approval-policy diagnostics were not persisted for this run; the counts above come from the
            run row itself.
          </div>
        )}

        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Forecast diagnostics
          </div>
          <RunForecastDiagnosticsSection diagnostics={run.forecastDiagnostics} />
        </div>

        <div className="grid grid-cols-1 gap-4 border-t pt-4 lg:grid-cols-3">
          <RunSampleColumn
            title="Actionable"
            totalLabel={`${run.actionableCount} in run`}
            samples={run.recommendationSamples.actionable}
            persistedCount={run.recommendationSampleCounts.actionable}
          />
          <RunSampleColumn
            title="Held by policy"
            totalLabel={`${run.approvalPolicyBlockedCount} in run`}
            samples={run.recommendationSamples.approvalPolicyBlocked}
            persistedCount={run.recommendationSampleCounts.approvalPolicyBlocked}
          />
          <RunSampleColumn
            title="Skipped"
            totalLabel={`${run.skippedNoVendor + run.skippedOnOrder + run.skippedExcluded} in run`}
            samples={run.recommendationSamples.skipped}
            persistedCount={run.recommendationSampleCounts.skipped}
          />
        </div>

        {run.recommendedActions.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 border-t pt-3">
            {/* Server-built follow-ups; hrefs rendered as-is (frozen link contract). */}
            {run.recommendedActions.map((action) => (
              <Link
                key={action.action}
                href={action.href}
                title={action.detail}
                className={`inline-flex h-7 items-center rounded-md border px-2 text-[11px] font-medium transition-colors ${autoDraftActionClass(action.severity)}`}
              >
                {action.label}
                <span className="ml-1.5 rounded bg-black/5 px-1">{action.count}</span>
              </Link>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProcurementRuns() {
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  // ---------------- queries (read-only; this page performs no mutations) ----------------

  const { data: runHistory, isLoading: isLoadingRuns } = useQuery<AutoDraftRunHistoryResponse>({
    queryKey: [`/api/purchasing/auto-draft/runs?limit=${RUN_HISTORY_LIMIT}`],
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: recommendationDecisionHistory } = useQuery<RecommendationDecisionHistoryResponse>({
    queryKey: ["/api/purchasing/recommendation-decisions"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/recommendation-decisions?limit=12");
      if (!res.ok) throw new Error("Failed to fetch recommendation decision history");
      return res.json();
    },
  });

  const runs = runHistory?.runs ?? [];
  // Default = latest run (server returns newest-first).
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const recentRecommendationDecisions = (recommendationDecisionHistory?.decisions ?? []).slice(0, 8);

  return (
    <div className="p-4 md:p-6">
      {/* ---------------- Topbar ---------------- */}
      <div className="mb-2 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold md:text-2xl">Runs</h1>
          <div className="mt-0.5 text-xs text-zinc-500">
            Auto-draft run reports — what each engine run analyzed, drafted, held, and skipped
          </div>
        </div>
        <div className="flex-1" />
        {/* Read-only page: manual triggers live on the Automation page. */}
        <Link
          href="/procurement/automation"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <Zap className="h-3 w-3" />
          Trigger runs from Automation
        </Link>
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
          <Link
            href="/procurement/automation"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Automation
          </Link>
          <span aria-current="page" className="-mb-px border-b-2 border-primary px-3 py-1.5 text-sm font-semibold text-primary">
            Runs
          </span>
          <Link
            href="/procurement/rfqs"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            RFQs
          </Link>
        </nav>
      </div>

      {/* ---------------- Pipeline health banner ---------------- */}
      <PipelineHealthBanner />

      {/* ---------------- Selected run report ---------------- */}
      {isLoadingRuns ? (
        <div className="mb-6 rounded-md border border-dashed p-4 text-sm text-zinc-500">
          Loading auto-draft runs…
        </div>
      ) : selectedRun ? (
        <RunDetailCard run={selectedRun} />
      ) : (
        <Card className="mb-6">
          <CardContent className="p-6 text-sm text-zinc-500">
            No auto-draft runs have been recorded yet. Scheduled runs appear here automatically; manual
            runs start from the{" "}
            <Link href="/procurement/automation" className="font-medium text-primary underline">
              Automation page
            </Link>
            .
          </CardContent>
        </Card>
      )}

      {/* ---------------- Run history ---------------- */}
      {runs.length > 0 ? (
        <Card className="mb-6 shadow-sm dark:bg-zinc-900">
          <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
            <CardTitle className="text-lg">Run History</CardTitle>
            <CardDescription>
              Last {runs.length} auto-draft runs (newest first). Select a row to open its report.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Run</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Trigger</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Analyzed</TableHead>
                    <TableHead className="text-right">POs</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">Held</TableHead>
                    <TableHead className="text-right">Skipped</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => {
                    const isSelected = run.id === selectedRun?.id;
                    return (
                      <TableRow
                        key={run.id}
                        aria-selected={isSelected}
                        onClick={() => setSelectedRunId(run.id)}
                        className={`cursor-pointer ${isSelected ? "bg-primary/5" : ""}`}
                      >
                        <TableCell className="font-mono text-xs font-semibold text-primary">#{run.id}</TableCell>
                        <TableCell className="text-xs">
                          <div>{new Date(run.runAt).toLocaleString()}</div>
                          <div className="text-zinc-500">{formatRelativeTime(run.runAt)}</div>
                        </TableCell>
                        <TableCell className="text-xs">{formatRunTrigger(run)}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className={`h-2 w-2 rounded-full ${autoDraftRunStatusDotClass(run.status)}`} />
                            {autoDraftRunStatusLabel(run.status)}
                          </span>
                          {(run.status === "error" || run.status === "interrupted") && run.errorMessage ? (
                            <div
                              className={`mt-0.5 max-w-[260px] truncate text-[11px] ${
                                run.status === "interrupted" ? "text-amber-700" : "text-red-600"
                              }`}
                              title={run.errorMessage}
                            >
                              {run.errorMessage}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{run.itemsAnalyzed.toLocaleString()}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{run.posCreated + run.posUpdated}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{run.linesAdded.toLocaleString()}</TableCell>
                        <TableCell className={`text-right font-mono text-xs ${run.approvalPolicyBlockedCount > 0 ? "text-amber-700" : ""}`}>
                          {run.approvalPolicyBlockedCount.toLocaleString()}
                        </TableCell>
                        <TableCell
                          className="text-right font-mono text-xs"
                          title={`${run.skippedNoVendor} no vendor · ${run.skippedOnOrder} on order · ${run.skippedExcluded} excluded`}
                        >
                          {(run.skippedNoVendor + run.skippedOnOrder + run.skippedExcluded).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* ---------------- Decision history (ported from PurchasingView) ---------------- */}
      {(recommendationDecisionHistory?.summary.total ?? 0) > 0 && (
        <Card className="mb-6 border-zinc-200 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
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
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {recentRecommendationDecisions.map((decision) => (
                <div key={decision.id} className="rounded-md border bg-white p-3 dark:bg-zinc-900">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-xs font-semibold text-primary">{decision.sku ?? decision.recommendationId}</span>
                        <Badge variant="outline" className={`text-[10px] ${recommendationDecisionClass(decision.decision)}`}>
                          {formatRecommendationDecision(decision.decision)}
                        </Badge>
                        <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-[10px] text-zinc-600">
                          {formatReviewQueueKind(decision.kind)}
                        </Badge>
                        {decision.candidateScore != null ? (
                          <Badge variant="outline" className={`text-[10px] capitalize ${candidateBandClass(decision.candidateBand)}`}>
                            {decision.candidateScore} - {formatCandidateBand(decision.candidateBand)}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-sm font-medium">{decision.productName ?? "Recommendation snapshot"}</div>
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

      {/* ---------------- Forecast accuracy (full detail, reused directly) ---------------- */}
      <ForecastAccuracyPanel />
    </div>
  );
}
