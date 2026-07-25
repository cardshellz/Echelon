import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, BarChart3, CheckCircle2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  forecastBacktestEvaluationResultSchema,
  forecastBacktestReportSchema,
  forecastEvaluationHorizons,
  formatEvaluationDate,
  formatMicrosAsPieces,
  formatOverlayExclusionReason,
  formatWapeBasisPoints,
  formatWapeImprovement,
  purchaseRecommendationPipelineHealthSchema,
  type ForecastBacktestItem,
  type ForecastEvaluationHorizon,
  type PurchaseRecommendationPipelineHealth,
} from "@/features/purchasing/forecastBacktesting";

const FORECAST_EVALUATION_BATCH_LIMIT = 5_000;
const RECENT_EVALUATION_LIMIT = 25;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

function resultBadge(item: ForecastBacktestItem) {
  if (item.outcome === "forecast_wins") {
    return <Badge variant="outline" className="border-green-300 text-green-700">Historical wins</Badge>;
  }
  if (item.outcome === "baseline_wins") {
    return <Badge variant="outline" className="border-amber-300 text-amber-700">Baseline wins</Badge>;
  }
  return <Badge variant="outline">Tie</Badge>;
}

function overlayBadge(item: ForecastBacktestItem) {
  if (!item.overlayEvaluable) {
    return (
      <Badge variant="outline" className="border-zinc-300 text-zinc-600">
        {formatOverlayExclusionReason(item.overlayExclusionReason)}
      </Badge>
    );
  }
  if (item.overlayOutcome === "overlay_wins") {
    return <Badge variant="outline" className="border-green-300 text-green-700">Overlay wins</Badge>;
  }
  if (item.overlayOutcome === "historical_forecast_wins") {
    return <Badge variant="outline" className="border-amber-300 text-amber-700">Historical wins</Badge>;
  }
  return <Badge variant="outline">Overlay tie</Badge>;
}

function jobRunSummary(
  label: string,
  run: PurchaseRecommendationPipelineHealth["jobs"]["recommendationSnapshot"],
): string {
  if (!run) return `${label}: no execution`;
  const timestamp = run.finishedAt ?? run.heartbeatAt;
  return `${label}: ${run.status} ${new Date(timestamp).toLocaleString()}`;
}

export function ForecastAccuracyPanel() {
  const [horizon, setHorizon] = useState<ForecastEvaluationHorizon>(30);
  const [policySelection, setPolicySelection] = useState("latest");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reportQueryKey = [
    "/api/purchasing/forecast-backtests",
    horizon,
    policySelection,
    RECENT_EVALUATION_LIMIT,
  ] as const;

  const reportQuery = useQuery({
    queryKey: reportQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        horizonDays: String(horizon),
        limit: String(RECENT_EVALUATION_LIMIT),
      });
      if (policySelection !== "latest") {
        const [fingerprint, forecastVersion] = policySelection.split(":");
        params.set("forecastPolicyFingerprint", fingerprint);
        params.set("forecastVersion", forecastVersion);
      }
      const response = await fetch(`/api/purchasing/forecast-backtests?${params.toString()}`);
      if (!response.ok) {
        throw new Error(await errorMessage(response, "Failed to load forecast accuracy"));
      }
      return forecastBacktestReportSchema.parse(await response.json());
    },
  });
  const pipelineHealthQuery = useQuery({
    queryKey: ["/api/procurement/health/recommendation-pipeline"],
    queryFn: async () => {
      const response = await fetch("/api/procurement/health/recommendation-pipeline");
      if (!response.ok) {
        throw new Error(await errorMessage(response, "Failed to load recommendation pipeline health"));
      }
      return purchaseRecommendationPipelineHealthSchema.parse(await response.json());
    },
    refetchInterval: 5 * 60 * 1_000,
  });

  const evaluateMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/purchasing/forecast-backtests/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: FORECAST_EVALUATION_BATCH_LIMIT }),
      });
      if (!response.ok) {
        throw new Error(await errorMessage(response, "Failed to evaluate matured forecasts"));
      }
      return forecastBacktestEvaluationResultSchema.parse(await response.json());
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/forecast-backtests"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procurement/health/recommendation-pipeline"] });
      toast({
        title: "Forecast evaluation complete",
        description: result.batchLimitReached
          ? `${result.insertedCount.toLocaleString()} evaluations saved. More matured forecasts remain.`
          : `${result.insertedCount.toLocaleString()} evaluations saved; ${result.concurrentReplayCount.toLocaleString()} concurrent replays ignored.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Forecast evaluation failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const report = reportQuery.data;
  const pipelineHealth = pipelineHealthQuery.data;
  const summary = report?.summaries.find((item) => item.horizonDays === horizon);
  const selectedPolicyCohort = report?.selectedPolicyCohort ?? null;
  const overlayCoverage = summary && summary.evaluationCount > 0
    ? (summary.overlayEvaluationCount / summary.evaluationCount) * 100
    : null;

  return (
    <Card className="mb-6 border-zinc-200 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <BarChart3 className="h-4 w-4" />
              Forecast Accuracy
            </CardTitle>
            <CardDescription>
              Matured product forecasts compared within one immutable policy cohort.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={policySelection} onValueChange={setPolicySelection}>
              <SelectTrigger className="h-8 w-[210px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="latest">Latest observed policy</SelectItem>
                {(report?.policyCohorts ?? []).map((cohort) => (
                  <SelectItem
                    key={`${cohort.fingerprint}:${cohort.forecastVersion}`}
                    value={`${cohort.fingerprint}:${cohort.forecastVersion}`}
                  >
                    {cohort.snapshot.method === "weighted_blend_v1" ? "Weighted blend" : "Standard velocity"}
                    {" v"}
                    {cohort.forecastVersion}
                    {" "}
                    {cohort.fingerprint.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex overflow-hidden rounded-md border" aria-label="Forecast evaluation horizon">
              {forecastEvaluationHorizons.map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={horizon === value ? "default" : "ghost"}
                  size="sm"
                  className="h-8 rounded-none border-0 px-3"
                  onClick={() => setHorizon(value)}
                >
                  {value} days
                </Button>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              disabled={evaluateMutation.isPending}
              onClick={() => evaluateMutation.mutate()}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${evaluateMutation.isPending ? "animate-spin" : ""}`} />
              {evaluateMutation.isPending ? "Evaluating" : "Evaluate matured"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className={`border-b px-4 py-3 text-xs dark:border-zinc-800 ${
          pipelineHealthQuery.isError
            ? "bg-red-50 text-red-900 dark:bg-red-950/30 dark:text-red-100"
            : !pipelineHealth
              ? "bg-zinc-50 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
              : pipelineHealth.status === "critical"
                ? "bg-red-50 text-red-900 dark:bg-red-950/30 dark:text-red-100"
                : pipelineHealth.status === "warning"
                  ? "bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
                  : "bg-emerald-50/60 text-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-100"
        }`}>
          {pipelineHealthQuery.isLoading ? (
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 animate-pulse" />
              Checking recommendation pipeline...
            </div>
          ) : pipelineHealthQuery.isError || !pipelineHealth ? (
            <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
              <AlertTriangle className="h-4 w-4" />
              {pipelineHealthQuery.error instanceof Error
                ? pipelineHealthQuery.error.message
                : "Recommendation pipeline health is unavailable"}
            </div>
          ) : (
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 items-start gap-2">
                {pipelineHealth.status === "healthy" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-emerald-600" />
                ) : (
                  <AlertTriangle className={`mt-0.5 h-4 w-4 flex-none ${
                    pipelineHealth.status === "critical" ? "text-red-600" : "text-amber-600"
                  }`} />
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Recommendation evidence pipeline</span>
                    <Badge
                      variant={pipelineHealth.status === "critical" ? "destructive" : "outline"}
                      className="text-[10px] uppercase"
                    >
                      {pipelineHealth.status}
                    </Badge>
                  </div>
                  <div className="mt-0.5 leading-5">{pipelineHealth.detail}</div>
                </div>
              </div>
              <div className="flex-none space-y-0.5 text-zinc-600 dark:text-zinc-300 lg:text-right">
                <div>{jobRunSummary("Snapshot", pipelineHealth.jobs.recommendationSnapshot)}</div>
                <div>{jobRunSummary("Evaluation", pipelineHealth.jobs.forecastEvaluation)}</div>
                <div>
                  {pipelineHealth.latestEvaluationAt
                    ? `Latest scored forecast ${new Date(pipelineHealth.latestEvaluationAt).toLocaleString()}`
                    : "No forecast outcome has matured yet"}
                </div>
              </div>
            </div>
          )}
        </div>
        {reportQuery.isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-zinc-500">Loading forecast accuracy...</div>
        ) : reportQuery.isError ? (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" />
            {reportQuery.error instanceof Error ? reportQuery.error.message : "Forecast accuracy is unavailable"}
          </div>
        ) : !summary ? (
          <div className="px-4 py-8 text-center">
            <div className="font-medium">
              {selectedPolicyCohort
                ? `No mature ${horizon}-day evaluations for policy ${selectedPolicyCohort.fingerprint.slice(0, 10)}`
                : "No captured forecast-policy cohort"}
            </div>
            <div className="mt-1 text-sm text-zinc-500">
              {selectedPolicyCohort
                ? "The next evaluation run will add forecasts from this policy after their demand windows close."
                : `${report?.cohortCoverage.legacyEvaluationCount.toLocaleString() ?? "0"} legacy evaluations are excluded from accuracy metrics.`}
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2 border-b px-4 py-3 text-xs md:flex-row md:items-center md:justify-between dark:border-zinc-800">
              <div>
                <span className="font-semibold">Policy cohort</span>{" "}
                <span className="font-mono">{selectedPolicyCohort?.fingerprint.slice(0, 12)}</span>
                <span className="text-zinc-500">
                  {" "}(forecast v{selectedPolicyCohort?.forecastVersion},{" "}
                  {selectedPolicyCohort?.snapshot.method.replace(/_/g, " ")})
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="border-amber-300 text-amber-700">
                  Accuracy trust not assessed
                </Badge>
                <span className="text-zinc-500">
                  {report?.accuracyTrustAssessment.excludedLegacyEvaluationCount.toLocaleString()} legacy and{" "}
                  {report?.accuracyTrustAssessment.excludedOtherPolicyCohortEvaluationCount.toLocaleString()} other-cohort evaluations excluded
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 divide-x divide-y border-b md:grid-cols-4 md:divide-y-0 dark:divide-zinc-800 dark:border-zinc-800">
              <div className="p-4">
                <div className="text-xs text-zinc-500">Historical WAPE</div>
                <div className="mt-1 text-2xl font-bold">{formatWapeBasisPoints(summary.forecastWapeBasisPoints)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {formatWapeImprovement(summary.forecastWapeImprovementBasisPoints)} vs baseline
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs text-zinc-500">Baseline WAPE</div>
                <div className="mt-1 text-2xl font-bold">{formatWapeBasisPoints(summary.baselineWapeBasisPoints)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {summary.forecastWinCount.toLocaleString()} historical wins
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs text-zinc-500">Overlay-adjusted WAPE</div>
                <div className="mt-1 text-2xl font-bold">{formatWapeBasisPoints(summary.overlayAdjustedWapeBasisPoints)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {formatWapeImprovement(summary.overlayWapeImprovementBasisPoints)} overlay lift
                </div>
              </div>
              <div className="p-4">
                <div className="text-xs text-zinc-500">Overlay coverage</div>
                <div className="mt-1 text-2xl font-bold">
                  {overlayCoverage === null ? "N/A" : `${overlayCoverage.toFixed(1)}%`}
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {summary.overlayEvaluationCount.toLocaleString()} of {summary.evaluationCount.toLocaleString()} evaluations
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-px border-b bg-zinc-200 md:grid-cols-2 dark:border-zinc-800 dark:bg-zinc-800">
              <div className="bg-white px-4 py-3 text-xs dark:bg-zinc-900">
                <span className="font-semibold">Historical vs baseline:</span>{" "}
                {summary.forecastWinCount.toLocaleString()} wins,{" "}
                {summary.baselineWinCount.toLocaleString()} losses,{" "}
                {summary.tieCount.toLocaleString()} ties
              </div>
              <div className="bg-white px-4 py-3 text-xs dark:bg-zinc-900">
                <span className="font-semibold">Overlay vs historical:</span>{" "}
                {summary.overlayWinCount.toLocaleString()} wins,{" "}
                {summary.historicalForecastWinCount.toLocaleString()} losses,{" "}
                {summary.overlayTieCount.toLocaleString()} ties;{" "}
                {summary.observationsWithAttributedOverlay.toLocaleString()} with attributed demand
              </div>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>SKU</TableHead>
                    <TableHead>Demand window</TableHead>
                    <TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Historical</TableHead>
                    <TableHead className="text-right">Baseline</TableHead>
                    <TableHead className="text-right">Overlay adjusted</TableHead>
                    <TableHead>Evidence result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(report?.items ?? []).map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="min-w-[190px]">
                        <div className="font-mono text-xs font-semibold text-primary">{item.productSku}</div>
                        <div className="mt-0.5 max-w-[240px] truncate text-xs text-zinc-500" title={item.productName}>
                          {item.productName}
                        </div>
                      </TableCell>
                      <TableCell className="min-w-[145px] text-xs">
                        <div>{formatEvaluationDate(item.observedFrom)}</div>
                        <div className="text-zinc-500">
                          until {formatEvaluationDate(item.observedThroughExclusive)} (exclusive)
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {item.actualDemandPieces.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMicrosAsPieces(item.forecastDemandMicros)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMicrosAsPieces(item.baselineDemandMicros)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatMicrosAsPieces(item.overlayAdjustedForecastDemandMicros)}
                      </TableCell>
                      <TableCell className="min-w-[170px]">
                        <div className="flex flex-wrap gap-1">
                          {resultBadge(item)}
                          {overlayBadge(item)}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {(report?.items.length ?? 0) === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-zinc-500">
                  No recent {horizon}-day evaluations.
                </div>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
