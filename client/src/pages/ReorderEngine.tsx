// Reorder Engine cockpit — the redesigned READ-ONLY /reorder-analysis page
// (design spec §4.6/§13, mock 01-reorder-analysis.html). Behind the
// `useNewReorderCockpit` procurement-settings flag; the legacy PurchasingView
// stays reachable at /reorder-analysis/legacy.
//
// Scope (PR 2): no ordering actions — no checkboxes, no Order Builder, no
// decisions. Single-engine invariant: every planning number rendered here
// (reorder points, suggested pieces, days of supply, blend weights, event
// contributions) comes straight from the engine's API output; the client only
// aggregates for display (sums/counts) and formats calendar labels.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ExternalLink,
  Info,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { ExclusionRulesModal } from "@/components/purchasing/ExclusionRulesModal";
import { ForecastAccuracyPanel } from "@/components/purchasing/ForecastAccuracyPanel";
import { reorderAnalysisSearchParams } from "@/features/purchasing/reorderAnalysisDeepLink";
import {
  forecastBacktestReportSchema,
  formatWapeBasisPoints,
  purchaseRecommendationPipelineHealthSchema,
} from "@/features/purchasing/forecastBacktesting";
import {
  ALL_CHIP_KEYS,
  DEFAULT_CHIP_SELECTION,
  STATUS_META,
  allChipsSelected,
  availableValueCents,
  chipMatchesItem,
  computeSuggestedSpend,
  confidenceTooltip,
  daysOfSupplyDisplay,
  filterItemsByChips,
  formatIsoDateShort,
  formatMoneyCents,
  groupReorderItems,
  isOrderQueueSelection,
  isOverstocked,
  leadTimeSourceLabel,
  orderSoonDates,
  parseReorderEngineDeepLink,
  skippedAppendixRows,
  skippedReasonLabel,
  statusSeverityRank,
  suggestedValueCents,
  trendDisplay,
  unitCostCents,
  type ChipKey,
  type ReorderEngineStatus,
  type ReorderGroupBy,
} from "@/features/purchasing/reorderEngine";

// ---------------------------------------------------------------------------
// API types — client-side mirror of the engine item fields this page consumes
// (server/modules/procurement/purchasing-recommendation.engine.ts,
// PurchasingRecommendationItem).
// ---------------------------------------------------------------------------

interface DashboardKPIs {
  criticalRestocks: number;
  upcomingRestocks: number;
  idleCapitalCents: number;
  inboundPipelineValueCents: number;
  totalOpenLines: number;
  lastComputedAt: string;
}

interface CockpitQualityControl {
  area: string;
  severity: "review" | "block";
  code: string;
  label: string;
  detail: string;
}

interface CockpitWindowSnapshot {
  lookbackDays: number;
  periodUsagePieces: number;
  avgDailyUsagePieces: number;
}

interface CockpitForwardDemandContribution {
  demandEventLineId: number;
  eventName: string;
  eventType: string;
  eventStatus: string;
  expectedPieces: number;
  confidence: "high" | "medium" | "low";
  confidenceWeightPercent: number;
  weightedPieces: number;
}

interface CockpitItem {
  recommendationId: string;
  productId: number;
  productVariantId?: number;
  sku: string;
  productName: string;
  category: string | null;
  productLines: string[];
  totalOnHand: number;
  totalReserved: number;
  available: number;
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
  earliestInboundEta: string | null;
  status: string;
  preferredVendorName: string | null;
  estimatedCostMills: number | null;
  estimatedCostCents: number | null;
  supplierBasis: {
    vendorProductId: number | null;
    costSource: string;
    costQuality: string;
    pricingBasis: string;
    purchaseUom: string | null;
    piecesPerPurchaseUom: number | null;
    minimumOrderPieces: number | null;
  };
  currentSupply: {
    onHandPieces: number;
    reservedPieces: number;
    availablePieces: number;
    effectiveSupplyPieces: number;
  };
  openPoSupply: {
    onOrderPieces: number;
    openPoCount: number;
  };
  recommendationCandidateScore?: {
    score: number;
    band: string;
    detail: string;
  };
  demandBasis: {
    lookbackDays: number;
    periodUsagePieces: number;
    priorPeriodUsagePieces: number | null;
    avgDailyUsagePieces: number;
    demandQuality: string;
    demandTrend: string;
    latestDemandAt: string | null;
  };
  forwardDemandBasis: {
    forwardDemandPieces: number;
    forwardDemandRawPieces: number;
    forwardDemandEventCount: number;
    adjustedReorderPoint: number;
    overlayCaptureComplete: boolean;
    overlayHorizonDays: number | null;
    // Present on items (PR #1053); stripped from skippedItems by the API.
    contributions?: CockpitForwardDemandContribution[];
  };
  leadTimeBasis: {
    leadTimeDays: number;
    leadTimeSource: string;
    safetyStockDays: number;
    safetyStockSource: string;
    reorderPointPieces: number;
  };
  forecastProvenance?: {
    forecastMethod: string;
    demandWindowDiagnostics?: {
      standardWindow?: CockpitWindowSnapshot;
      shortWindow?: CockpitWindowSnapshot;
      longWindow?: CockpitWindowSnapshot;
      seasonalWindow?: CockpitWindowSnapshot;
    };
    forecastBlend?: {
      method: string;
      avgDailyUsagePieces: number;
      configuredWeights: Record<string, number>;
      appliedWeights: Record<string, number>;
      seasonalHistoryAvailable: boolean;
    };
  };
  confidence?: "low" | "medium" | "high";
  confidenceFactors?: string[];
  qualityControls?: CockpitQualityControl[];
  qualityGate?: {
    autoDraftEligible: boolean;
    reason: string;
    label: string;
    detail: string;
  };
  actionable?: boolean;
  skippedReason?: string | null;
}

interface ReorderAnalysisResponse {
  items: CockpitItem[];
  skippedItems: CockpitItem[];
  lookbackDays: number;
}

// ---------------------------------------------------------------------------
// Presentation atoms
// ---------------------------------------------------------------------------

const TONE_BADGE_CLASSES: Record<string, string> = {
  red: "bg-red-50 text-red-700 border-red-200",
  orange: "bg-orange-50 text-orange-700 border-orange-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  green: "bg-green-50 text-green-700 border-green-200",
  gray: "bg-zinc-50 text-zinc-600 border-zinc-200",
};

const TONE_BAR_CLASSES: Record<string, string> = {
  red: "bg-red-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
};

function statusMeta(status: string) {
  return STATUS_META[status as ReorderEngineStatus] ?? { label: status.replace(/_/g, " "), tone: "gray" as const };
}

function StatusBadge({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <Badge variant="outline" className={`whitespace-nowrap ${TONE_BADGE_CLASSES[meta.tone]}`}>
      {meta.label}
    </Badge>
  );
}

const CONFIDENCE_META: Record<string, { label: string; tone: string }> = {
  high: { label: "High", tone: "green" },
  medium: { label: "Medium", tone: "amber" },
  low: { label: "Low", tone: "red" },
};

function ConfidenceBadge({ item }: { item: CockpitItem }) {
  const meta = CONFIDENCE_META[item.confidence ?? ""] ?? { label: "—", tone: "gray" };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`cursor-help ${TONE_BADGE_CLASSES[meta.tone]}`}>
          {meta.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[280px] text-xs">
        {confidenceTooltip(item, Date.now())}
      </TooltipContent>
    </Tooltip>
  );
}

function TrendCell({ item }: { item: CockpitItem }) {
  const trend = trendDisplay(item.demandBasis);
  const icon =
    trend.symbol === "up" ? (
      <ArrowUp className="h-4 w-4 text-green-600" />
    ) : trend.symbol === "down" ? (
      <ArrowDown className="h-4 w-4 text-red-600" />
    ) : trend.symbol === "flat" ? (
      <ArrowRight className="h-4 w-4 text-zinc-400" />
    ) : (
      <span className="text-zinc-300">—</span>
    );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help justify-center">{icon}</span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{trend.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function DaysOfSupplyCell({ item, asOfIsoDate }: { item: CockpitItem; asOfIsoDate: string }) {
  const display = daysOfSupplyDisplay(item);
  const soon =
    item.status === "order_soon" ? orderSoonDates(asOfIsoDate, item) : null;
  return (
    <div className="flex flex-col items-end">
      <div className="flex items-center justify-end gap-2">
        <span className="min-w-[30px] text-right tabular-nums">
          {display.infinite ? "∞" : item.daysOfSupply.toLocaleString()}
        </span>
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-100">
          <span
            className={`block h-full rounded-full ${TONE_BAR_CLASSES[display.tone]}`}
            style={{ width: `${display.percent}%` }}
          />
        </span>
      </div>
      {soon && (
        <div className="mt-0.5 whitespace-nowrap text-[11px] tabular-nums text-amber-600">
          stockout {formatIsoDateShort(soon.stockoutDate)} · order by {formatIsoDateShort(soon.orderByDate)}
        </div>
      )}
    </div>
  );
}

function ChipButton({
  active,
  onClick,
  className = "",
  children,
  tooltip,
}: {
  active: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
  tooltip?: ReactNode;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-zinc-900 bg-zinc-900 text-zinc-50"
          : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-100"
      } ${className}`}
    >
      {children}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent className="max-w-[300px] text-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Math drawer — the 8-step walkthrough (design spec §6). Every number is
// engine output; the drawer renders, it never recomputes.
// ---------------------------------------------------------------------------

function DrawerStep({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <div className="group relative flex gap-3 pb-5 last:pb-0">
      <div className="absolute bottom-0 left-[13px] top-8 w-px bg-zinc-200 group-last:hidden" aria-hidden />
      <div className="z-10 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-zinc-900 text-xs font-bold text-zinc-50">
        {index}
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-sm font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
}

function CalcLine({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 overflow-x-auto whitespace-nowrap rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 font-mono text-xs">
      {children}
    </div>
  );
}

const WINDOW_ROWS: Array<{ key: "shortWindow" | "standardWindow" | "longWindow" | "seasonalWindow"; label: (days: number) => string }> = [
  { key: "shortWindow", label: (days) => `Last ${days} days` },
  { key: "standardWindow", label: (days) => `Last ${days} days` },
  { key: "longWindow", label: (days) => `Last ${days} days` },
  { key: "seasonalWindow", label: (days) => `Same ${days} days last year` },
];

function MathDrawerBody({ item, asOfIsoDate }: { item: CockpitItem; asOfIsoDate: string }) {
  const diagnostics = item.forecastProvenance?.demandWindowDiagnostics;
  const blend = item.forecastProvenance?.forecastBlend;
  const basis = item.demandBasis;
  const lead = item.leadTimeBasis;
  const forward = item.forwardDemandBasis;
  const supplier = item.supplierBasis;
  const contributions = forward.contributions ?? [];
  const adjustedReorderPoint = forward.adjustedReorderPoint;
  const effectiveSupply = item.currentSupply.effectiveSupplyPieces;
  // Display-only difference of two engine numbers (the engine's order math
  // starts from this same shortfall; we never re-derive pieces from it).
  const shortfall = Math.max(0, adjustedReorderPoint - effectiveSupply);
  const lineValue = suggestedValueCents(item);
  const unitCents = unitCostCents(item);

  // Step 2 blend formula parts, from applied weights + per-window rates.
  const blendParts: string[] = [];
  if (blend && diagnostics) {
    const windowByLabel: Record<string, CockpitWindowSnapshot | undefined> = {
      short: diagnostics.shortWindow,
      standard: diagnostics.standardWindow,
      long: diagnostics.longWindow,
      seasonal: diagnostics.seasonalWindow,
    };
    for (const label of ["short", "standard", "long", "seasonal"]) {
      const weight = blend.appliedWeights?.[label] ?? 0;
      const snapshot = windowByLabel[label];
      if (weight > 0 && snapshot) {
        blendParts.push(`${snapshot.avgDailyUsagePieces.toFixed(2)}×${weight}%`);
      }
    }
  }
  const seasonalConfigured = (blend?.configuredWeights?.seasonal ?? 0) > 0;
  const seasonalApplied = (blend?.appliedWeights?.seasonal ?? 0) > 0;

  const soon = item.status === "order_soon" ? orderSoonDates(asOfIsoDate, item) : null;
  const qualityControls = item.qualityControls ?? [];
  const candidate = item.recommendationCandidateScore;
  const confidenceMeta = CONFIDENCE_META[item.confidence ?? ""] ?? { label: "Unscored", tone: "gray" };

  return (
    <div className="space-y-0">
      <DrawerStep index={1} title="Demand windows">
        {diagnostics ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-[10px] uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-2 font-semibold">Window</th>
                <th className="py-1 pr-2 text-right font-semibold">Pieces sold</th>
                <th className="py-1 text-right font-semibold">Per-day rate</th>
              </tr>
            </thead>
            <tbody>
              {WINDOW_ROWS.map(({ key, label }) => {
                const snapshot = diagnostics[key];
                if (!snapshot) return null;
                return (
                  <tr key={key} className="border-b last:border-b-0">
                    <td className="py-1 pr-2">{label(snapshot.lookbackDays)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">
                      {snapshot.periodUsagePieces.toLocaleString()}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {snapshot.avgDailyUsagePieces.toFixed(2)}/day
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-xs text-zinc-500">
            Window diagnostics unavailable — engine reported {basis.periodUsagePieces.toLocaleString()} pieces over{" "}
            {basis.lookbackDays} days ({basis.avgDailyUsagePieces.toFixed(2)}/day).
          </div>
        )}
        <div className="mt-1.5 text-xs text-zinc-500">
          Recent, medium, and long-run sales, plus the same window last year for seasonality.
        </div>
      </DrawerStep>

      <DrawerStep index={2} title="Blend into base velocity">
        {blend && blendParts.length > 0 ? (
          <>
            <CalcLine>
              {blend.avgDailyUsagePieces.toFixed(2)} = {blendParts.join(" + ")}
            </CalcLine>
            {seasonalConfigured && !seasonalApplied && (
              <div className="mt-1.5 text-xs text-zinc-500">
                Seasonal weight is 0 — no sales in the last-year window, so its configured{" "}
                {blend.configuredWeights.seasonal}% was redistributed across the other windows.
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-zinc-500">
            Method {item.forecastProvenance?.forecastMethod?.replace(/_/g, " ") ?? "recent order velocity"} — velocity{" "}
            {basis.avgDailyUsagePieces.toFixed(2)} pieces/day from the {basis.lookbackDays}-day window.
          </div>
        )}
        <div className="mt-1.5 text-xs">
          <span className="font-semibold">Base velocity {basis.avgDailyUsagePieces.toFixed(2)} pieces/day</span>
        </div>
      </DrawerStep>

      <DrawerStep index={3} title="Growth adjustments">
        <div className="text-xs text-zinc-500">
          None configured — coming soon. Base velocity {basis.avgDailyUsagePieces.toFixed(2)}/day carries forward
          unchanged.
        </div>
      </DrawerStep>

      <DrawerStep index={4} title="Coverage target">
        <CalcLine>
          ({lead.leadTimeDays}d lead + {lead.safetyStockDays}d safety) × {basis.avgDailyUsagePieces.toFixed(2)}/day →{" "}
          <span className="font-bold">Reorder point {lead.reorderPointPieces.toLocaleString()}</span>
        </CalcLine>
        <div className="mt-1.5 text-xs text-zinc-500">
          Lead-time source — {leadTimeSourceLabel(lead.leadTimeSource)}
          {item.preferredVendorName && lead.leadTimeSource === "vendor_product" ? `: ${item.preferredVendorName}` : ""}.
          Safety-stock source — {lead.safetyStockSource === "product" ? "product override" : "system default"}.
        </div>
      </DrawerStep>

      <DrawerStep index={5} title="Demand events">
        {contributions.length > 0 ? (
          <>
            {contributions.map((contribution) => (
              <div
                key={contribution.demandEventLineId}
                className="flex items-baseline justify-between gap-3 border-b border-dashed py-1.5 text-xs last:border-b-0"
              >
                <span className="min-w-0">
                  {contribution.eventName}{" "}
                  <span className="text-zinc-500">· {contribution.eventType.replace(/_/g, " ")}</span>
                </span>
                <span className="whitespace-nowrap tabular-nums">
                  {contribution.expectedPieces.toLocaleString()} pc · {contribution.confidence} ×
                  {contribution.confidenceWeightPercent}% →{" "}
                  <b>+{contribution.weightedPieces.toLocaleString()}</b>
                </span>
              </div>
            ))}
            <CalcLine>
              RP {lead.reorderPointPieces.toLocaleString()} + {forward.forwardDemandPieces.toLocaleString()} event
              pieces → <span className="font-bold">Adjusted RP {adjustedReorderPoint.toLocaleString()}</span>
            </CalcLine>
          </>
        ) : (
          <div className="text-xs text-zinc-500">
            No events inside the {forward.overlayHorizonDays ?? 90}-day horizon. Adjusted reorder point stays at{" "}
            {adjustedReorderPoint.toLocaleString()}.
          </div>
        )}
      </DrawerStep>

      <DrawerStep index={6} title="Supply on hand & inbound">
        <dl className="grid max-w-[300px] grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-xs">
          <dt className="text-zinc-500">On hand</dt>
          <dd className="text-right font-medium tabular-nums">{item.currentSupply.onHandPieces.toLocaleString()}</dd>
          <dt className="text-zinc-500">Reserved</dt>
          <dd className="text-right font-medium tabular-nums">− {item.currentSupply.reservedPieces.toLocaleString()}</dd>
          <dt className="text-zinc-500">Available</dt>
          <dd className="text-right font-medium tabular-nums">{item.currentSupply.availablePieces.toLocaleString()}</dd>
          <dt className="text-zinc-500">On order</dt>
          <dd className="text-right font-medium tabular-nums">
            + {item.openPoSupply.onOrderPieces.toLocaleString()}
            {item.earliestInboundEta ? (
              <span className="text-zinc-500"> (ETA {formatIsoDateShort(item.earliestInboundEta)})</span>
            ) : null}
          </dd>
          <dt className="text-zinc-500">Effective supply</dt>
          <dd className="text-right font-bold tabular-nums">{effectiveSupply.toLocaleString()}</dd>
        </dl>
        <CalcLine>
          {shortfall > 0 ? (
            <>
              {adjustedReorderPoint.toLocaleString()} − {effectiveSupply.toLocaleString()} ={" "}
              <span className="font-bold text-red-600">{shortfall.toLocaleString()} short</span>
            </>
          ) : (
            <span className="text-green-700">
              Effective supply {effectiveSupply.toLocaleString()} covers adjusted RP{" "}
              {adjustedReorderPoint.toLocaleString()} — no order needed
            </span>
          )}
        </CalcLine>
      </DrawerStep>

      <DrawerStep index={7} title="Order sizing">
        {item.skippedReason === "excluded" ? (
          <div className="text-xs text-zinc-500">
            Excluded from reorder analysis — no orders are ever suggested for this SKU.
          </div>
        ) : item.suggestedOrderPieces > 0 ? (
          <>
            <CalcLine>
              max({shortfall.toLocaleString()}, MOQ {(supplier.minimumOrderPieces ?? 0).toLocaleString()}) → round up
              to {item.orderUomLabel} of {item.orderUomUnits.toLocaleString()} →{" "}
              <span className="font-bold">
                {item.suggestedOrderPieces.toLocaleString()} pieces
                {lineValue !== null ? ` = ${formatMoneyCents(lineValue)}` : ""}
              </span>
              {unitCents !== null ? ` @ ${formatMoneyCents(unitCents)}` : ""}
            </CalcLine>
            {supplier.costQuality !== "current" && (
              <div className="mt-1.5 text-xs text-amber-600">
                Supplier cost is {supplier.costQuality.replace(/_/g, " ")} — dollar figures are estimates.
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-zinc-500">No order suggested — effective supply covers the target.</div>
        )}
      </DrawerStep>

      <DrawerStep index={8} title="Outcome & automation gate">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={item.status} />
          <Badge variant="outline" className={TONE_BADGE_CLASSES[confidenceMeta.tone]}>
            {confidenceMeta.label} confidence
          </Badge>
          {candidate && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className={`cursor-help capitalize ${
                    candidate.band === "strong_candidate"
                      ? TONE_BADGE_CLASSES.green
                      : candidate.band === "review_candidate"
                        ? TONE_BADGE_CLASSES.amber
                        : TONE_BADGE_CLASSES.gray
                  }`}
                >
                  {candidate.band.replace(/_/g, " ")} {candidate.score}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-[300px] text-xs">
                Candidate score — how strongly this line qualifies for automated drafting. {candidate.detail}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {(item.confidenceFactors?.length ?? 0) > 0 && (
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-zinc-600">
            {item.confidenceFactors!.map((factor) => (
              <li key={factor}>{factor}</li>
            ))}
          </ul>
        )}
        {item.qualityGate && (
          <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs">
            <b>{item.qualityGate.label}</b> — {item.qualityGate.detail}
            {soon
              ? ` Stockout ${formatIsoDateShort(soon.stockoutDate)} · order by ${formatIsoDateShort(soon.orderByDate)} to keep the ${item.safetyStockDays}-day safety buffer.`
              : ""}
          </div>
        )}
        {qualityControls.length > 0 && (
          <div className="mt-2 space-y-1">
            {qualityControls.map((control) => (
              <div key={control.code} className="flex items-start gap-2 text-xs">
                <Badge
                  variant="outline"
                  className={`flex-none ${control.severity === "block" ? TONE_BADGE_CLASSES.red : TONE_BADGE_CLASSES.amber}`}
                >
                  {control.severity === "block" ? "Auto-block" : "Auto-warn"}
                </Badge>
                <span className="leading-5">{control.label}</span>
              </div>
            ))}
            <div className="text-[11px] text-zinc-500">
              Why the autopilot holds this SKU — acknowledged when creating a PO; never blocks a manual order.
            </div>
          </div>
        )}
      </DrawerStep>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forecast accuracy strip — slim variant of ForecastAccuracyPanel reading the
// same endpoints (30-day horizon pinned per design spec §13), with the full
// panel one click away in a collapsible.
// ---------------------------------------------------------------------------

const ACCURACY_HORIZON_DAYS = 30;
const ACCURACY_RECENT_LIMIT = 25;

function AccuracyStrip() {
  const [detailOpen, setDetailOpen] = useState(false);
  const reportQuery = useQuery({
    queryKey: ["/api/purchasing/forecast-backtests", ACCURACY_HORIZON_DAYS, "strip"],
    queryFn: async () => {
      const params = new URLSearchParams({
        horizonDays: String(ACCURACY_HORIZON_DAYS),
        limit: String(ACCURACY_RECENT_LIMIT),
      });
      const response = await fetch(`/api/purchasing/forecast-backtests?${params.toString()}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to load forecast accuracy");
      }
      return forecastBacktestReportSchema.parse(await response.json());
    },
  });
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

  const report = reportQuery.data;
  const summary = report?.summaries.find((entry) => entry.horizonDays === ACCURACY_HORIZON_DAYS);
  const cohort = report?.selectedPolicyCohort ?? null;
  const pipeline = pipelineQuery.data;
  const winPct =
    summary && summary.evaluationCount > 0
      ? Math.round((summary.forecastWinCount / summary.evaluationCount) * 100)
      : null;
  const overlayWinDenominator = summary
    ? summary.overlayWinCount + summary.historicalForecastWinCount + summary.overlayTieCount
    : 0;
  const overlayWinPct =
    summary && overlayWinDenominator > 0
      ? Math.round((summary.overlayWinCount / overlayWinDenominator) * 100)
      : null;
  const coveragePct =
    summary && summary.evaluationCount > 0
      ? ((summary.overlayEvaluationCount / summary.evaluationCount) * 100).toFixed(1)
      : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-sm font-semibold">
            Forecast accuracy — {ACCURACY_HORIZON_DAYS}-day horizon
          </CardTitle>
          {cohort && (
            <span className="font-mono text-xs text-zinc-500">
              cohort {cohort.fingerprint.slice(0, 8)} · forecast v{cohort.forecastVersion}
            </span>
          )}
          <div className="flex-1" />
          {pipelineQuery.isError ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-red-600">
              <AlertTriangle className="h-3.5 w-3.5" /> Pipeline health unavailable
            </span>
          ) : pipeline ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600">
              <span
                className={`h-2 w-2 rounded-full ${
                  pipeline.status === "healthy"
                    ? "bg-green-500"
                    : pipeline.status === "warning"
                      ? "bg-amber-500"
                      : "bg-red-500"
                }`}
              />
              Evidence pipeline {pipeline.status}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
              <Activity className="h-3.5 w-3.5 animate-pulse" /> Checking pipeline…
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {reportQuery.isLoading ? (
          <div className="py-3 text-sm text-zinc-500">Loading forecast accuracy…</div>
        ) : reportQuery.isError ? (
          <div className="flex items-center gap-2 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" />
            {reportQuery.error instanceof Error ? reportQuery.error.message : "Forecast accuracy is unavailable"}
          </div>
        ) : !summary ? (
          <div className="py-3 text-sm text-zinc-500">
            No mature {ACCURACY_HORIZON_DAYS}-day evaluations yet — the strip fills in after forecasts mature.
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div>
                <div className="text-lg font-bold tabular-nums">
                  {formatWapeBasisPoints(summary.forecastWapeBasisPoints)}
                </div>
                <div className="text-[11px] text-zinc-500">Forecast WAPE</div>
              </div>
              <div className="h-8 w-px bg-zinc-200" />
              <div>
                <div className="text-lg font-bold tabular-nums">
                  {formatWapeBasisPoints(summary.baselineWapeBasisPoints)}
                </div>
                <div className="text-[11px] text-zinc-500">Baseline WAPE · naive velocity</div>
              </div>
              <div className="h-8 w-px bg-zinc-200" />
              <div>
                <div className="text-lg font-bold tabular-nums">
                  {formatWapeBasisPoints(summary.overlayAdjustedWapeBasisPoints)}
                </div>
                <div className="text-[11px] text-zinc-500">With demand events</div>
              </div>
              <div className="h-8 w-px bg-zinc-200" />
              <div>
                <div className="text-lg font-bold tabular-nums">{coveragePct !== null ? `${coveragePct}%` : "N/A"}</div>
                <div className="text-[11px] text-zinc-500">Event coverage</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
              <span>
                {winPct !== null
                  ? `Forecast beats naive baseline in ${winPct}% of ${summary.evaluationCount.toLocaleString()} scored forecasts`
                  : "No scored forecasts yet"}
                {overlayWinPct !== null ? ` · Events improve it in ${overlayWinPct}%` : ""}
              </span>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setDetailOpen((open) => !open)}>
                {detailOpen ? "Hide full detail" : "Full detail"}
              </Button>
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">
              Accuracy trust not yet assessed — evaluation thresholds not configured ·{" "}
              {report?.accuracyTrustAssessment.excludedLegacyEvaluationCount.toLocaleString()} legacy and{" "}
              {report?.accuracyTrustAssessment.excludedOtherPolicyCohortEvaluationCount.toLocaleString()} other-cohort
              evaluations excluded
            </div>
          </>
        )}
        <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
          <CollapsibleContent className="pt-4">{detailOpen && <ForecastAccuracyPanel />}</CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function rowDomId(recommendationId: string): string {
  return `reorder-row-${recommendationId}`;
}

function matchesSearch(item: CockpitItem, query: string): boolean {
  if (!query) return true;
  const haystack = [item.sku, item.productName, item.preferredVendorName ?? "", item.category ?? "", ...item.productLines]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export default function ReorderEngine() {
  const [location, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tableRef = useRef<HTMLDivElement | null>(null);

  const deepLink = useMemo(
    () => parseReorderEngineDeepLink(reorderAnalysisSearchParams(location)),
    [location],
  );

  const [search, setSearch] = useState("");
  const [selectedChips, setSelectedChips] = useState<Set<ChipKey>>(
    () => new Set<ChipKey>(deepLink.chipSelection ?? DEFAULT_CHIP_SELECTION),
  );
  const [groupBy, setGroupBy] = useState<ReorderGroupBy>("none");
  const [showSkipped, setShowSkipped] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [planningPolicyOpen, setPlanningPolicyOpen] = useState(false);
  const [drawerItem, setDrawerItem] = useState<CockpitItem | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [pendingHighlightId, setPendingHighlightId] = useState<string | null>(deepLink.recommendationId);
  const appliedDeepLinkRef = useRef<string | null>(null);

  // Presentation-only "as of" date for order-by / projected-stockout labels.
  // The analysis endpoint computes live, so today (UTC) is the as-of date.
  const asOfIsoDate = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Re-apply deep-link state when the location changes while mounted (the
  // in-page equivalent of PurchasingView's handleRecommendationHref intercept:
  // navigating to another /reorder-analysis?… href updates filters in place).
  useEffect(() => {
    const key = `${deepLink.recommendationId ?? ""}|${(deepLink.chipSelection ?? []).join(",")}`;
    if (appliedDeepLinkRef.current === key) return;
    const isFirstRun = appliedDeepLinkRef.current === null;
    appliedDeepLinkRef.current = key;
    if (isFirstRun) return; // initial state already came from useState initializers
    if (deepLink.chipSelection) setSelectedChips(new Set(deepLink.chipSelection));
    if (deepLink.recommendationId) setPendingHighlightId(deepLink.recommendationId);
  }, [deepLink]);

  const { data: kpis, isLoading: isLoadingKpis, isError: isKpisError } = useQuery<DashboardKPIs>({
    queryKey: ["/api/purchasing/kpis"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/kpis");
      if (!res.ok) throw new Error("Failed to fetch KPIs");
      return res.json();
    },
    refetchInterval: 30000, // 30s poll, as the legacy page does
  });

  const {
    data: analysis,
    isLoading: isLoadingAnalysis,
    isError: isAnalysisError,
    error: analysisError,
    refetch: refetchAnalysis,
  } = useQuery<ReorderAnalysisResponse>({
    queryKey: ["/api/purchasing/reorder-analysis"],
    queryFn: async () => {
      const res = await fetch("/api/purchasing/reorder-analysis");
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to fetch reorder analysis");
      }
      return res.json();
    },
  });

  const refreshAnalysisMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/purchasing/recommendation-runs", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? "Failed to generate recommendations");
      return body;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/kpis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
      toast({
        title: "Analysis refreshed",
        description: `${data.lineCount ?? 0} current requirements were saved as a new calculation run.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Analysis not refreshed", description: error.message, variant: "destructive" });
    },
  });

  const items = analysis?.items ?? [];
  const skippedItems = analysis?.skippedItems ?? [];

  // recommendationId deep link: once the analysis is loaded, reveal the row
  // (widening filters if needed), highlight it, and open its math drawer.
  useEffect(() => {
    if (!pendingHighlightId || !analysis) return;
    const activeMatch = items.find((item) => item.recommendationId === pendingHighlightId);
    const skippedMatch = skippedItems.find((item) => item.recommendationId === pendingHighlightId);
    const target = activeMatch ?? skippedMatch;
    setPendingHighlightId(null);
    if (!target) {
      toast({
        title: "Recommendation not in the current analysis",
        description: "The linked recommendation is not part of the latest run. Refresh the analysis or open the legacy page.",
        variant: "destructive",
      });
      return;
    }
    // Only reveal the skipped appendix when the row is NOT in the active list
    // (the engine dual-lists non-excluded skipped rows in both arrays).
    if (!activeMatch && skippedMatch) setShowSkipped(true);
    if (
      activeMatch &&
      !ALL_CHIP_KEYS.some((chip) => selectedChips.has(chip) && chipMatchesItem(chip, activeMatch))
    ) {
      setSelectedChips(new Set(ALL_CHIP_KEYS));
    }
    setHighlightedId(target.recommendationId);
    setDrawerItem(target);
    window.setTimeout(() => {
      document.getElementById(rowDomId(target.recommendationId))?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  }, [pendingHighlightId, analysis, items, skippedItems, selectedChips, toast]);

  // ---------------- derived view data (display aggregation only) ----------------

  const searchedItems = useMemo(() => items.filter((item) => matchesSearch(item, search)), [items, search]);

  const chipCounts = useMemo(() => {
    let stockout = 0;
    let orderNow = 0;
    let orderSoonCount = 0;
    let onOrder = 0;
    let ok = 0;
    let stagnant = 0;
    let overstock = 0;
    let earliestEta: string | null = null;
    let stagnantCents = 0;
    let overstockCents = 0;
    const orderSoonSkus: CockpitItem[] = [];
    for (const item of searchedItems) {
      if (item.status === "stockout") stockout += 1;
      else if (item.status === "order_now") orderNow += 1;
      else if (item.status === "order_soon") {
        orderSoonCount += 1;
        orderSoonSkus.push(item);
      } else if (item.status === "on_order") {
        onOrder += 1;
        if (item.earliestInboundEta && (!earliestEta || item.earliestInboundEta < earliestEta)) {
          earliestEta = item.earliestInboundEta;
        }
      } else if (item.status === "ok") ok += 1;
      if (item.status === "no_movement") {
        stagnant += 1;
        stagnantCents += availableValueCents(item);
      }
      if (isOverstocked(item)) {
        overstock += 1;
        overstockCents += availableValueCents(item);
      }
    }
    return {
      stockout,
      orderNow,
      orderSoon: orderSoonCount,
      orderSoonSkus,
      onOrder,
      ok,
      stagnant,
      overstock,
      earliestEta,
      stagnantCents,
      overstockCents,
      total: searchedItems.length,
    };
  }, [searchedItems]);

  const suggestedSpend = useMemo(() => computeSuggestedSpend(items), [items]);
  const idleSkuCount = useMemo(
    () => items.filter((item) => item.daysOfSupply > 180 && item.totalOnHand > 0).length,
    [items],
  );

  const visibleRows = useMemo(() => {
    const filtered = filterItemsByChips(searchedItems, selectedChips);
    const sorted = [...filtered].sort(
      (a, b) =>
        statusSeverityRank(a.status) - statusSeverityRank(b.status) ||
        (suggestedValueCents(b) ?? 0) - (suggestedValueCents(a) ?? 0),
    );
    if (!showSkipped) return sorted;
    // Skipped rows render greyed at the end (or inside their groups); they are
    // search-filtered but not chip-filtered — the chips describe the active
    // analysis, the toggle reveals what the engine set aside and why. The
    // engine dual-lists non-excluded skipped rows in items AND skippedItems,
    // so the appendix drops any row the main list already shows.
    const visibleIds = new Set(sorted.map((item) => item.recommendationId));
    const skippedSorted = skippedAppendixRows(
      skippedItems.filter((item) => matchesSearch(item, search)),
      visibleIds,
    );
    return [...sorted, ...skippedSorted];
  }, [searchedItems, selectedChips, showSkipped, skippedItems, search]);

  const groups = useMemo(() => groupReorderItems(visibleRows, groupBy), [visibleRows, groupBy]);

  const isQueueView = isOrderQueueSelection(selectedChips) && !showSkipped;
  const activeCount = items.length;

  // ---------------- interactions ----------------

  const toggleChip = (chip: ChipKey) => {
    setSelectedChips((current) => {
      const next = new Set(current);
      if (next.has(chip)) next.delete(chip);
      else next.add(chip);
      return next;
    });
  };

  const selectAllChips = () => setSelectedChips(new Set(ALL_CHIP_KEYS));

  const focusIdleCapital = () => {
    setSelectedChips(new Set<ChipKey>(["stagnant", "overstock"]));
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      const compound = `${groupBy}:${key}`;
      if (next.has(compound)) next.delete(compound);
      else next.add(compound);
      return next;
    });
  };

  // ---------------- render ----------------

  const orderSoonTooltip = (
    <span>
      The ordering window is closing: days of supply are inside lead + safety time.
      {chipCounts.orderSoonSkus.slice(0, 3).map((item) => {
        const dates = orderSoonDates(asOfIsoDate, item);
        return (
          <span key={item.recommendationId}>
            {" "}
            {item.sku}: stockout {formatIsoDateShort(dates.stockoutDate)} · order by{" "}
            {formatIsoDateShort(dates.orderByDate)} to keep the {item.safetyStockDays}-day safety buffer.
          </span>
        );
      })}
      {chipCounts.orderSoonSkus.length > 3 ? ` +${chipCounts.orderSoonSkus.length - 3} more.` : ""}
    </span>
  );

  return (
    <div className="p-4 md:p-6">
      {/* ---------------- Topbar ---------------- */}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold md:text-2xl">Reorder Analysis</h1>
          <div className="mt-0.5 text-xs text-zinc-500">
            {kpis
              ? `As of ${new Date(kpis.lastComputedAt).toLocaleString()} · `
              : ""}
            {analysis ? `${analysis.lookbackDays}-day demand lookback · ${activeCount} SKUs analyzed` : "Loading analysis…"}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={refreshAnalysisMutation.isPending}
            onClick={() => refreshAnalysisMutation.mutate()}
          >
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshAnalysisMutation.isPending ? "animate-spin" : ""}`} />
            {refreshAnalysisMutation.isPending ? "Calculating…" : "Refresh analysis"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPlanningPolicyOpen(true)}>
            <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
            Planning Policy
          </Button>
          <Button variant="ghost" size="sm" className="text-zinc-500" onClick={() => navigate("/reorder-analysis/legacy")}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Legacy view
          </Button>
        </div>
      </div>

      {/* ---------------- Legacy review-queue deep-link banner ---------------- */}
      {deepLink.hasLegacyReviewParams && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <Info className="h-4 w-4 flex-none" />
          <span>
            This link references the review queue — it lives on the legacy page until the Automation page ships.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-blue-300 bg-white text-xs text-blue-800"
            onClick={() => navigate(deepLink.legacyUrl)}
          >
            Open on the legacy page
          </Button>
        </div>
      )}

      {/* ---------------- KPI row ---------------- */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {isLoadingKpis && !kpis ? (
          Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-[92px] rounded-lg" />)
        ) : isKpisError && !kpis ? (
          <div className="col-span-full flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" /> Purchasing KPIs are unavailable.
          </div>
        ) : kpis ? (
          <>
            <Card className={kpis.criticalRestocks > 0 ? "border-red-200 bg-gradient-to-b from-red-50 to-white" : ""}>
              <CardContent className="p-4">
                <div className="text-2xl font-bold tabular-nums">{kpis.criticalRestocks.toLocaleString()}</div>
                <div className="text-xs text-zinc-500">Needs order</div>
                <div className="mt-1 text-[11px] text-red-600">
                  {chipCounts.stockout} stockouts · {chipCounts.orderNow} below reorder point
                </div>
              </CardContent>
            </Card>
            <Card className={kpis.upcomingRestocks > 0 ? "border-amber-200 bg-gradient-to-b from-amber-50 to-white" : ""}>
              <CardContent className="p-4">
                <div className="text-2xl font-bold tabular-nums">{kpis.upcomingRestocks.toLocaleString()}</div>
                <div className="text-xs text-zinc-500">Order soon</div>
                <div className="mt-1 text-[11px] text-amber-600">
                  {chipCounts.orderSoon === 1 && chipCounts.orderSoonSkus[0]
                    ? `${chipCounts.orderSoonSkus[0].sku} · ${chipCounts.orderSoonSkus[0].daysOfSupply}d supply vs ${chipCounts.orderSoonSkus[0].leadTimeDays}d lead`
                    : `${chipCounts.orderSoon} SKUs burning fast`}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-2xl font-bold tabular-nums">{formatMoneyCents(kpis.inboundPipelineValueCents)}</div>
                <div className="text-xs text-zinc-500">Inbound pipeline</div>
                <div className="mt-1 text-[11px] text-zinc-500">{kpis.totalOpenLines.toLocaleString()} open PO lines</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-2xl font-bold tabular-nums">{formatMoneyCents(suggestedSpend.totalCents)}</div>
                <div className="text-xs text-zinc-500">Suggested spend</div>
                <div className="mt-1 text-[11px] text-zinc-500">
                  {suggestedSpend.skuCount} SKUs need ordering
                  {suggestedSpend.missingCostCount > 0 ? ` · ${suggestedSpend.missingCostCount} missing cost` : ""}
                </div>
              </CardContent>
            </Card>
            <Card
              role="button"
              tabIndex={0}
              title="Filter the table to stagnant and overstocked SKUs"
              className="cursor-pointer transition-shadow hover:shadow-md"
              onClick={focusIdleCapital}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") focusIdleCapital();
              }}
            >
              <CardContent className="p-4">
                <div className="text-2xl font-bold tabular-nums">{formatMoneyCents(kpis.idleCapitalCents)}</div>
                <div className="text-xs text-zinc-500">Idle capital</div>
                <div className="mt-1 text-[11px] text-zinc-500">&gt;180 days of supply · {idleSkuCount} SKUs</div>
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>

      {/* ---------------- Toolbar: search + chips + group-by + excluded ---------------- */}
      <div className="mb-4 flex flex-wrap items-start gap-x-4 gap-y-3">
        <Input
          className="h-9 w-full max-w-[250px]"
          placeholder="Search SKU, product, vendor…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex flex-wrap items-stretch gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Order queue</div>
            <div className="flex flex-wrap items-center gap-2">
              <ChipButton
                active={selectedChips.has("needs_order")}
                onClick={() => toggleChip("needs_order")}
                className={selectedChips.has("needs_order") ? "!border-red-600 !bg-red-50 !text-red-700 ring-1 ring-red-600" : "!text-red-700"}
                tooltip={`Below reorder point — order today. ${chipCounts.stockout} out of stock · ${chipCounts.orderNow} below reorder point.`}
              >
                Needs order <span className="opacity-70">{chipCounts.stockout + chipCounts.orderNow}</span>
              </ChipButton>
              <ChipButton
                active={selectedChips.has("order_soon")}
                onClick={() => toggleChip("order_soon")}
                className={selectedChips.has("order_soon") ? "!border-amber-600 !bg-amber-50 !text-amber-700 ring-1 ring-amber-600" : "!text-amber-700"}
                tooltip={orderSoonTooltip}
              >
                Order soon <span className="opacity-70">{chipCounts.orderSoon}</span>
              </ChipButton>
            </div>
          </div>
          <div className="flex flex-col gap-1.5 border-l pl-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Watching</div>
            <div className="flex flex-wrap items-center gap-2">
              <ChipButton active={allChipsSelected(selectedChips)} onClick={selectAllChips}>
                All <span className="opacity-70">{chipCounts.total}</span>
              </ChipButton>
              <ChipButton
                active={selectedChips.has("on_order")}
                onClick={() => toggleChip("on_order")}
                tooltip={`Below reorder point but open POs cover the gap.${
                  chipCounts.earliestEta ? ` Earliest ETA ${formatIsoDateShort(chipCounts.earliestEta)}.` : ""
                }`}
              >
                Inbound covers <span className="opacity-70">{chipCounts.onOrder}</span>
                {chipCounts.earliestEta && (
                  <span className="text-[10px] opacity-70">· ETA {formatIsoDateShort(chipCounts.earliestEta)}</span>
                )}
              </ChipButton>
              <ChipButton
                active={selectedChips.has("ok")}
                onClick={() => toggleChip("ok")}
                tooltip="Above reorder point with normal movement."
              >
                Healthy <span className="opacity-70">{chipCounts.ok}</span>
              </ChipButton>
              <ChipButton
                active={selectedChips.has("stagnant")}
                onClick={() => toggleChip("stagnant")}
                tooltip={`No sales in 90 days — review or liquidate. ${formatMoneyCents(chipCounts.stagnantCents)} idle.`}
              >
                Stagnant <span className="opacity-70">{chipCounts.stagnant}</span>
              </ChipButton>
              <ChipButton
                active={selectedChips.has("overstock")}
                onClick={() => toggleChip("overstock")}
                tooltip={`>180 days of supply — stop ordering, consider markdown. ${formatMoneyCents(chipCounts.overstockCents)} idle.`}
              >
                Overstocked <span className="opacity-70">{chipCounts.overstock}</span>
              </ChipButton>
            </div>
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Group by</span>
          <div className="inline-flex overflow-hidden rounded-md border">
            {(
              [
                { value: "category", label: "Category" },
                { value: "productLine", label: "Product line" },
                { value: "none", label: "None" },
              ] as Array<{ value: ReorderGroupBy; label: string }>
            ).map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={groupBy === option.value ? "default" : "ghost"}
                size="sm"
                className="h-8 rounded-none border-0 px-3 text-xs"
                onClick={() => setGroupBy(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
            <Switch checked={showSkipped} onCheckedChange={setShowSkipped} />
            Show excluded
          </label>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setPlanningPolicyOpen(true)}>
            Manage exclusions →
          </Button>
        </div>
      </div>

      {/* ---------------- Table ---------------- */}
      <div ref={tableRef}>
        <Card className="overflow-hidden">
          {isQueueView && analysis && (
            <div className="border-b px-4 py-2.5 text-xs text-zinc-500">
              Showing order queue ·{" "}
              <b className="text-zinc-700">
                {visibleRows.length} of {activeCount} SKUs
              </b>{" "}
              ·{" "}
              <button type="button" className="font-semibold text-blue-600 hover:underline" onClick={selectAllChips}>
                View all
              </button>
            </div>
          )}
          <CardContent className="p-0">
            {isLoadingAnalysis ? (
              <div className="flex items-center justify-center py-16">
                <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            ) : isAnalysisError ? (
              <div className="px-4 py-10 text-center">
                <AlertTriangle className="mx-auto h-6 w-6 text-red-500" />
                <div className="mt-2 text-sm font-medium text-red-700">
                  {analysisError instanceof Error ? analysisError.message : "Failed to fetch reorder analysis"}
                </div>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => refetchAnalysis()}>
                  Retry
                </Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table className="min-w-[960px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[110px]">SKU</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="w-[110px]">Status</TableHead>
                      <TableHead className="w-[48px] text-center">Trend</TableHead>
                      <TableHead className="w-[80px] text-right">Available</TableHead>
                      <TableHead className="w-[90px] text-right">Inbound</TableHead>
                      <TableHead className="w-[130px] text-right">Days of supply</TableHead>
                      <TableHead className="w-[110px] text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help border-b border-dotted border-zinc-400">Reorder point</span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-[280px] text-xs">
                            The stock level at which you must order so delivery arrives before you dip into safety
                            stock — (lead + safety days) × daily velocity, plus in-horizon demand-event pieces.
                          </TooltipContent>
                        </Tooltip>
                      </TableHead>
                      <TableHead className="w-[100px] text-right">Suggested</TableHead>
                      <TableHead className="w-[90px]">Confidence</TableHead>
                      <TableHead className="w-[90px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={11} className="py-10 text-center text-sm text-zinc-500">
                          No SKUs match the current filters.
                        </TableCell>
                      </TableRow>
                    )}
                    {groups.map((group) => {
                      const compoundKey = `${groupBy}:${group.key}`;
                      const collapsed = collapsedGroups.has(compoundKey);
                      return (
                        <GroupRows
                          key={compoundKey || "all"}
                          groupKey={group.key}
                          grouped={groupBy !== "none"}
                          collapsed={collapsed}
                          onToggleCollapsed={() => toggleGroupCollapsed(group.key)}
                          rollup={group.rollup}
                          items={group.items}
                          highlightedId={highlightedId}
                          asOfIsoDate={asOfIsoDate}
                          onExplain={(item) => setDrawerItem(item)}
                        />
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------------- Forecast accuracy strip ---------------- */}
      <div className="mt-4">
        <AccuracyStrip />
      </div>

      {/* ---------------- Planning policy (exclusions) modal ---------------- */}
      <ExclusionRulesModal open={planningPolicyOpen} onOpenChange={setPlanningPolicyOpen} />

      {/* ---------------- Math drawer ---------------- */}
      <Sheet open={drawerItem !== null} onOpenChange={(open) => !open && setDrawerItem(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {drawerItem && (
            <>
              <SheetHeader className="text-left">
                <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
                  <span className="font-mono">{drawerItem.sku}</span>
                  <StatusBadge status={drawerItem.status} />
                  {drawerItem.skippedReason && (
                    <Badge variant="outline" className={TONE_BADGE_CLASSES.gray}>
                      {skippedReasonLabel(drawerItem.skippedReason)}
                    </Badge>
                  )}
                </SheetTitle>
                <SheetDescription className="truncate">
                  {drawerItem.productName} · {drawerItem.preferredVendorName ?? "No vendor"} · lead{" "}
                  {drawerItem.leadTimeDays}d
                </SheetDescription>
              </SheetHeader>
              <div className="mb-3 mt-1 text-xs text-zinc-500">
                How this recommendation was computed — {analysis?.lookbackDays ?? drawerItem.demandBasis.lookbackDays}-day
                lookback, live analysis.
              </div>
              <MathDrawerBody item={drawerItem} asOfIsoDate={asOfIsoDate} />
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table row rendering
// ---------------------------------------------------------------------------

function GroupRows({
  groupKey,
  grouped,
  collapsed,
  onToggleCollapsed,
  rollup,
  items,
  highlightedId,
  asOfIsoDate,
  onExplain,
}: {
  groupKey: string;
  grouped: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  rollup: { skuCount: number; belowReorderPointCount: number; suggestedCents: number; onHandCents: number };
  items: CockpitItem[];
  highlightedId: string | null;
  asOfIsoDate: string;
  onExplain: (item: CockpitItem) => void;
}) {
  return (
    <>
      {grouped && (
        <TableRow className="cursor-pointer bg-zinc-50 hover:bg-zinc-100" onClick={onToggleCollapsed}>
          <TableCell colSpan={11} className="py-2">
            <span className="inline-flex flex-wrap items-center gap-2 text-xs font-semibold">
              <span className={`inline-block text-[10px] text-zinc-500 transition-transform ${collapsed ? "" : "rotate-90"}`}>
                ▶
              </span>
              {groupKey}
              <Badge variant="outline" className="font-medium tabular-nums">
                {rollup.skuCount} SKU{rollup.skuCount === 1 ? "" : "s"}
              </Badge>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className={`cursor-help font-medium tabular-nums ${
                      rollup.belowReorderPointCount > 0 ? TONE_BADGE_CLASSES.red : ""
                    }`}
                  >
                    {rollup.belowReorderPointCount} below RP
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs">
                  Below reorder point — SKUs whose effective supply is under the stock level at which you must order so
                  delivery arrives before you dip into safety stock (incl. demand events).
                </TooltipContent>
              </Tooltip>
              <Badge variant="outline" className="font-medium tabular-nums">
                suggested {formatMoneyCents(rollup.suggestedCents)}
              </Badge>
              <Badge variant="outline" className="font-medium tabular-nums">
                on hand {formatMoneyCents(rollup.onHandCents)}
              </Badge>
            </span>
          </TableCell>
        </TableRow>
      )}
      {(!grouped || !collapsed) &&
        items.map((item) => (
          <ItemRow
            key={`${groupKey}:${item.recommendationId}`}
            item={item}
            highlighted={highlightedId === item.recommendationId}
            asOfIsoDate={asOfIsoDate}
            onExplain={() => onExplain(item)}
          />
        ))}
    </>
  );
}

function ItemRow({
  item,
  highlighted,
  asOfIsoDate,
  onExplain,
}: {
  item: CockpitItem;
  highlighted: boolean;
  asOfIsoDate: string;
  onExplain: () => void;
}) {
  const skipped = item.skippedReason !== null && item.skippedReason !== undefined;
  const lineValue = suggestedValueCents(item);
  const baseReorderPoint = item.leadTimeBasis.reorderPointPieces;
  const adjustedReorderPoint = item.forwardDemandBasis.adjustedReorderPoint;
  const eventAdjusted = adjustedReorderPoint !== baseReorderPoint;
  return (
    <TableRow
      id={rowDomId(item.recommendationId)}
      className={`${skipped ? "bg-zinc-50/60 text-zinc-400" : ""} ${
        highlighted ? "bg-blue-50 ring-1 ring-inset ring-blue-300" : ""
      }`}
    >
      <TableCell className="font-mono text-xs">{item.sku}</TableCell>
      <TableCell>
        <div className="max-w-[220px] truncate text-sm font-medium" title={item.productName}>
          {item.productName}
        </div>
        <div className="max-w-[220px] truncate text-[11px] text-zinc-500">
          {item.preferredVendorName ?? "No vendor"}
          {item.productLines.length > 0 ? ` · ${item.productLines.join(", ")}` : ""}
        </div>
      </TableCell>
      <TableCell>
        {skipped ? (
          <>
            <Badge variant="outline" className={TONE_BADGE_CLASSES.gray}>
              {item.skippedReason === "excluded" ? "Excluded" : "Skipped"}
            </Badge>
            <div className="mt-0.5 text-[11px]">{skippedReasonLabel(item.skippedReason)}</div>
          </>
        ) : (
          <StatusBadge status={item.status} />
        )}
      </TableCell>
      <TableCell className="text-center">
        <TrendCell item={item} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.available === 0 && !skipped ? <span className="font-semibold text-red-600">0</span> : item.available.toLocaleString()}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.onOrderPieces > 0 ? (
          <>
            <div>+{item.onOrderPieces.toLocaleString()}</div>
            <div className="text-[11px] text-zinc-500">
              {item.earliestInboundEta ? `ETA ${formatIsoDateShort(item.earliestInboundEta)}` : `${item.openPoCount} PO${item.openPoCount === 1 ? "" : "s"}`}
            </div>
          </>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <DaysOfSupplyCell item={item} asOfIsoDate={asOfIsoDate} />
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {eventAdjusted ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help border-b border-dotted border-zinc-400">
                {adjustedReorderPoint.toLocaleString()}
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-xs">
              RP {baseReorderPoint.toLocaleString()} + {item.forwardDemandBasis.forwardDemandPieces.toLocaleString()}{" "}
              event pieces
            </TooltipContent>
          </Tooltip>
        ) : (
          adjustedReorderPoint.toLocaleString()
        )}
        {eventAdjusted && (
          <div className="text-[11px] text-violet-600">
            +{item.forwardDemandBasis.forwardDemandPieces.toLocaleString()} event pieces
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {item.suggestedOrderPieces > 0 && !skipped ? (
          <>
            <div className="font-semibold">{item.suggestedOrderPieces.toLocaleString()}</div>
            <div className="text-[11px] text-zinc-500">{lineValue !== null ? formatMoneyCents(lineValue) : "cost missing"}</div>
          </>
        ) : (
          <span className="text-zinc-400">—</span>
        )}
      </TableCell>
      <TableCell>{skipped ? <span className="text-zinc-400">—</span> : <ConfidenceBadge item={item} />}</TableCell>
      <TableCell className="text-right">
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onExplain}>
          Explain
        </Button>
      </TableCell>
    </TableRow>
  );
}
