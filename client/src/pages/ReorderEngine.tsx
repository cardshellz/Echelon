// Reorder Engine cockpit — the redesigned /reorder-analysis page
// (design spec §4.6/§13–§14, mock 01-reorder-analysis.html). Behind the
// `useNewReorderCockpit` procurement-settings flag; the legacy PurchasingView
// stays reachable at /reorder-analysis/legacy.
//
// PR 2 shipped the read-only cockpit; PR 3 adds the Order Builder (row
// selection → vendor-grouped edit stage → risk-proportional confirm →
// draft-PO handoff / RFQ batch). Single-engine invariant: every planning
// number rendered here (reorder points, suggested pieces, days of supply,
// blend weights, event contributions) comes straight from the engine's API
// output; the client only aggregates for display (sums/counts), formats
// calendar labels, and enforces display-side input rules the server
// re-validates (case rounding, override evidence).
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ExternalLink,
  Info,
  RefreshCw,
  ShoppingCart,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
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
  AUTO_DECISION_NOTE,
  DECISION_NOTE_MIN_LENGTH,
  DEFAULT_CHIP_SELECTION,
  MAX_PO_HANDOFF_LINES,
  STATUS_META,
  allChipsSelected,
  availableValueCents,
  buildAcceptedForPoDecisionBody,
  buildCreatePoItemBody,
  buildRfqLineBody,
  chipMatchesItem,
  computeSuggestedSpend,
  confidenceTooltip,
  confirmPrimaryLabel,
  controlAckKey,
  daysOfSupplyDisplay,
  decisionNoteForSubmit,
  exceedReasonValid,
  exceedsSuggestion,
  filterItemsByChips,
  firstUnmetConfirmRequirement,
  formatIsoDateShort,
  formatMoneyCents,
  groupReorderItems,
  isOrderQueueSelection,
  isOverstocked,
  leadTimeSourceLabel,
  orderBarSummary,
  orderBuilderGroups,
  orderIncrementPieces,
  orderLineValueCents,
  orderSoonDates,
  parseReorderEngineDeepLink,
  poLineFlagged,
  removeOrderLine,
  rfqBaselinePieces,
  rfqLineNeedsApproval,
  rfqLineNeedsReason,
  setOrderLineExceedReason,
  setOrderLinePieces,
  skippedAppendixRows,
  skippedReasonLabel,
  snapPiecesUpToCase,
  statusSeverityRank,
  suggestedValueCents,
  toggleOrderLine,
  trendDisplay,
  unitCostCents,
  type ChipKey,
  type ConfirmPoLineInput,
  type ConfirmRfqLineInput,
  type OrderBuilderGroup,
  type OrderLineState,
  type OrderSelection,
  type ReorderEngineStatus,
  type ReorderGroupBy,
  type ReviewQueueKind,
  type ReviewQueueLineEntry,
  type VendorOrderMode,
} from "@/features/purchasing/reorderEngine";

// ---------------------------------------------------------------------------
// Engine tab strip (design spec §10 rev 1: ONE Procurement nav entry, the
// engine surfaces switch on an in-page strip). "Analysis" is this page;
// "Demand Planner" links to the live forward-demand surface (/demand-planner,
// honestly labeled — it is not the parked forecast-inputs design, spec §12.3). The
// surfaces that have not shipped render as inert muted chips with a "Soon"
// pill — no dead links (spec §11 nav decision, mockups 03/04/05).
// ---------------------------------------------------------------------------

const ENGINE_TABS_COMING_SOON = ["Automation", "Runs", "RFQs"] as const;

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
  preferredVendorId: number | null;
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
    /** Vendor pack size — the case-rounding fallback for per-piece quotes (PR 3 engine change). */
    packSize?: number | null;
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
// Order Builder wire types + the single mutation seam
// ---------------------------------------------------------------------------

/** Subset of GET /api/purchasing/rfq-queue items the builder consumes. */
interface RfqQueueItem {
  recommendationLineId: number;
  recommendationId: string;
  sku: string;
  recommendedPieces: number;
  /** recommendedPieces minus active RFQ allocations — the RFQ override baseline. */
  remainingPieces: number;
}

interface RfqQueueResponse {
  items: RfqQueueItem[];
}

/** Subset of GET /api/purchasing/recommendation-review-queue items the builder consumes. */
interface ReviewQueueApiItem {
  recommendationId: string;
  kind: ReviewQueueKind;
  qualityControls?: Array<{ code: string }>;
}

interface OrderLineFailure {
  sku: string;
  step: "decision" | "po-handoff" | "rfq";
  message: string;
}

interface OrderSubmissionResult {
  posCreated: Array<{ poNumber: string; vendorName: string }>;
  handedOffCount: number;
  /** create-po `skipped` rows, reasons verbatim from the server. */
  poSkipped: Array<{ sku: string; reason: string }>;
  rfqCreatedCount: number;
  rfqLineCount: number;
  rfqReused: boolean;
  failures: OrderLineFailure[];
}

interface CommandResult {
  ok: boolean;
  status: number;
  body: any;
  error: string;
}

/**
 * The ONLY mutation seam on this page (pinned by
 * reorder-engine-ui-contract.test.ts): every POST goes through here with a
 * literal endpoint string at the call site, so the contract test can prove no
 * other mutations exist. Never swallows errors — callers branch on `ok` and
 * surface `error` verbatim.
 */
async function postPurchasingCommand(url: string, payload?: unknown): Promise<CommandResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      ...(payload === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    });
    const body = await response.json().catch(() => null);
    return {
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok ? "" : body?.error ?? `Request failed (HTTP ${response.status})`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : "Network request failed",
    };
  }
}

/** GET helper for the builder's mapping lookups; throws with the server's error text. */
async function getJson(url: string): Promise<any> {
  const response = await fetch(url);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (HTTP ${response.status})`);
  return body;
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
      const result = await postPurchasingCommand("/api/purchasing/recommendation-runs");
      if (!result.ok) throw new Error(result.error || "Failed to generate recommendations");
      return result.body;
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

  // ---------------- Order Builder state (PR 3) ----------------
  //
  // DELIBERATE DEVIATION from the approved mock: the mock pre-checks every
  // SKU the engine suggests ordering; the real page pre-checks NOTHING —
  // ordering real money should start from an explicit operator action, not a
  // pre-filled cart.

  const [orderSelection, setOrderSelection] = useState<OrderSelection>(new Map());
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderStage, setBuilderStage] = useState<"edit" | "confirm" | "result">("edit");
  const [vendorMode, setVendorMode] = useState<Record<string, VendorOrderMode>>({});
  const [ackedControls, setAckedControls] = useState<ReadonlySet<string>>(new Set());
  const [approvedExceptions, setApprovedExceptions] = useState<ReadonlySet<string>>(new Set());
  const [decisionNote, setDecisionNote] = useState("");
  // RFQ idempotency key minted at builder open (and re-minted after a
  // successful batch) so a retry of the SAME confirm can never create a
  // duplicate batch, while a genuinely new order is a new financial command.
  const [rfqIdempotencyKey, setRfqIdempotencyKey] = useState("");
  const [pieceDrafts, setPieceDrafts] = useState<Record<string, string>>({});
  const [roundedHints, setRoundedHints] = useState<Record<string, string>>({});
  const [submitResult, setSubmitResult] = useState<OrderSubmissionResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Synchronous re-entry guard: `isSubmitting` state only disables the button
  // after a re-render, so a fast double-click could start two overlapping
  // submissions — each recording its own accepted_for_po decisions. The ref
  // flips before the first await and closes that window.
  const submitInFlightRef = useRef(false);

  // Everything addable to an order: active items plus non-excluded skipped
  // rows (dual-listed rows prefer the active entry). Excluded rows are never
  // orderable — planning policy owns them.
  const orderableItems = useMemo(() => {
    const seen = new Set<string>();
    const list: CockpitItem[] = [];
    for (const item of [...items, ...skippedItems]) {
      if (seen.has(item.recommendationId)) continue;
      seen.add(item.recommendationId);
      if (item.skippedReason === "excluded") continue;
      list.push(item);
    }
    return list;
  }, [items, skippedItems]);

  const orderableById = useMemo(
    () => new Map(orderableItems.map((item) => [item.recommendationId, item])),
    [orderableItems],
  );

  const barSummary = useMemo(
    () => orderBarSummary(orderableItems, orderSelection),
    [orderableItems, orderSelection],
  );

  const builderGroups = useMemo(
    () => orderBuilderGroups(orderableItems, orderSelection),
    [orderableItems, orderSelection],
  );

  // RFQ mapping (live analysis line → saved recommendation-run line). Loaded
  // while the builder is open so RFQ-mode lines validate against the SAVED
  // run's remaining pieces — the baseline the RFQ service actually enforces.
  const rfqQueueQuery = useQuery<RfqQueueResponse>({
    queryKey: ["/api/purchasing/rfq-queue"],
    queryFn: () => getJson("/api/purchasing/rfq-queue"),
    enabled: builderOpen,
  });
  const rfqLineMap = useMemo(() => {
    const map = new Map<string, RfqQueueItem>();
    for (const line of rfqQueueQuery.data?.items ?? []) map.set(line.recommendationId, line);
    return map;
  }, [rfqQueueQuery.data]);

  // Confirm-stage views: vendor groups split by mode, lines with pieces > 0
  // only (0 = "skip this line", straight from the mock).
  const confirmView = useMemo(() => {
    const poGroups: Array<{ group: OrderBuilderGroup<CockpitItem>; lines: Array<{ item: CockpitItem; state: OrderLineState }> }> = [];
    const rfqGroups: typeof poGroups = [];
    for (const group of builderGroups.vendorGroups) {
      const lines = group.lines
        .map((item) => ({ item, state: orderSelection.get(item.recommendationId)! }))
        .filter((line) => line.state.pieces > 0);
      if (lines.length === 0) continue;
      ((vendorMode[group.key] ?? "po") === "rfq" ? rfqGroups : poGroups).push({ group, lines });
    }
    return { poGroups, rfqGroups };
  }, [builderGroups, orderSelection, vendorMode]);

  const confirmPoLines = useMemo<ConfirmPoLineInput[]>(
    () =>
      confirmView.poGroups.flatMap(({ lines }) =>
        lines.map(({ item, state }) => ({
          recommendationId: item.recommendationId,
          sku: item.sku,
          pieces: state.pieces,
          suggestedOrderPieces: item.suggestedOrderPieces,
          exceedReason: state.exceedReason,
          controls: (item.qualityControls ?? []).map((control) => ({ code: control.code, label: control.label })),
        })),
      ),
    [confirmView],
  );

  const confirmRfqLines = useMemo<ConfirmRfqLineInput[]>(
    () =>
      confirmView.rfqGroups.flatMap(({ lines }) =>
        lines.map(({ item, state }) => ({
          recommendationId: item.recommendationId,
          sku: item.sku,
          pieces: state.pieces,
          baselinePieces: rfqBaselinePieces(
            rfqLineMap.get(item.recommendationId)?.remainingPieces,
            item.suggestedOrderPieces,
          ),
          exceedReason: state.exceedReason,
        })),
      ),
    [confirmView, rfqLineMap],
  );

  const confirmMissing = firstUnmetConfirmRequirement({
    poLines: confirmPoLines,
    rfqLines: confirmRfqLines,
    acknowledgedControlKeys: ackedControls,
    approvedExceptionIds: approvedExceptions,
    note: decisionNote,
  });
  const anyFlaggedPo = confirmPoLines.some((line) =>
    poLineFlagged(line.controls.length, line.pieces, line.suggestedOrderPieces),
  );

  const openBuilder = () => {
    setBuilderStage("edit");
    setAckedControls(new Set());
    setApprovedExceptions(new Set());
    setDecisionNote("");
    setSubmitResult(null);
    setPieceDrafts({});
    setRoundedHints({});
    setRfqIdempotencyKey(crypto.randomUUID());
    setBuilderOpen(true);
  };

  const toggleOrder = (item: CockpitItem) => {
    setOrderSelection((current) => toggleOrderLine(current, item.recommendationId, item.suggestedOrderPieces));
  };

  const removeOrderRow = (recommendationId: string) => {
    setOrderSelection((current) => removeOrderLine(current, recommendationId));
    setPieceDrafts(({ [recommendationId]: _dropped, ...rest }) => rest);
    setRoundedHints(({ [recommendationId]: _dropped, ...rest }) => rest);
  };

  // Totals track the raw value while typing; blur snaps UP to a full case
  // with a hint that stays until the next edit (case rounding is a rule, not
  // a hint — spec §12.1). 0 stays allowed and means "skip this line".
  const handlePiecesChange = (recommendationId: string, raw: string) => {
    setPieceDrafts((current) => ({ ...current, [recommendationId]: raw }));
    const parsed = Number.parseInt(raw, 10);
    setOrderSelection((current) =>
      setOrderLinePieces(current, recommendationId, Number.isNaN(parsed) ? 0 : parsed),
    );
    setRoundedHints(({ [recommendationId]: _dropped, ...rest }) => rest);
  };

  const handlePiecesBlur = (item: CockpitItem) => {
    const recommendationId = item.recommendationId;
    const state = orderSelection.get(recommendationId);
    if (!state) return;
    const increment = orderIncrementPieces(item.supplierBasis);
    const snapped = snapPiecesUpToCase(state.pieces, increment);
    if (snapped !== state.pieces) {
      setRoundedHints((current) => ({
        ...current,
        [recommendationId]: `rounded up to ${snapped.toLocaleString()} (case of ${increment.toLocaleString()})`,
      }));
    }
    setOrderSelection((current) => setOrderLinePieces(current, recommendationId, snapped));
    setPieceDrafts(({ [recommendationId]: _dropped, ...rest }) => rest);
  };

  const handleExceedReasonChange = (recommendationId: string, reason: string) => {
    setOrderSelection((current) => setOrderLineExceedReason(current, recommendationId, reason));
  };

  const invalidateAfterOrderMutations = () => {
    // Same set as Refresh analysis…
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/kpis"] });
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/rfq-queue"] });
    // …plus the decision/accepted-queue family the submission wrote to.
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-review-queue"] });
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-accepted-queue"] });
    queryClient.invalidateQueries({ queryKey: ["/api/purchasing/recommendation-decisions"] });
  };

  /**
   * Two-path submission (design spec §11 rev 2/4/5), sequenced honestly:
   *
   * PO path, per vendor group — (1) record an `accepted_for_po` decision per
   * line against the review queue's authoritative kind + current control
   * codes, then (2) one create-po call per vendor group with the operator's
   * requestedPieces and (only when exceeding) the override evidence pair.
   * Per-line decision failures are collected and surfaced; the create-po
   * response's created/skipped arrays render verbatim in the result stage.
   *
   * RFQ path — RFQ batches allocate from SAVED recommendation-run lines, so
   * live lines are mapped SKU→recommendationLineId via GET rfq-queue; when a
   * selected line has no saved counterpart we POST recommendation-runs first
   * (persisting a fresh snapshot of exactly the analysis on screen) and remap.
   * Evidence is then re-validated against the mapped line's remaining pieces —
   * a line whose collected evidence no longer satisfies the server baseline
   * fails closed per SKU instead of inventing evidence. One idempotent batch
   * POST covers every RFQ vendor (the service splits per vendor internally).
   */
  const submitOrder = async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    const failures: OrderLineFailure[] = [];
    const posCreated: Array<{ poNumber: string; vendorName: string }> = [];
    const poSkipped: Array<{ sku: string; reason: string }> = [];
    const submittedIds = new Set<string>();
    let handedOffCount = 0;
    let rfqCreatedCount = 0;
    let rfqLineCount = 0;
    let rfqReused = false;

    try {
      // ---------------- PO path ----------------
      if (confirmView.poGroups.length > 0) {
        // Authoritative review-queue mapping: the entry's kind (skipped /
        // held_by_policy / quality_review_required) and its CURRENT control
        // codes, which the decision endpoint requires acknowledged in full.
        const queueByRecommendationId = new Map<string, ReviewQueueLineEntry>();
        const recordEntries = (rows: ReviewQueueApiItem[] | undefined) => {
          for (const row of rows ?? []) {
            queueByRecommendationId.set(row.recommendationId, {
              kind: row.kind,
              controlCodes: (row.qualityControls ?? []).map((control) => control.code),
            });
          }
        };
        let queueMappingLoaded = true;
        try {
          const bulk = await getJson("/api/purchasing/recommendation-review-queue?limit=100");
          recordEntries(bulk?.items);
          // The bulk page caps at 100 entries — resolve stragglers one by one.
          for (const { lines } of confirmView.poGroups) {
            for (const { item } of lines) {
              if (queueByRecommendationId.has(item.recommendationId)) continue;
              const targeted = await getJson(
                `/api/purchasing/recommendation-review-queue?recommendationId=${encodeURIComponent(item.recommendationId)}&limit=100`,
              );
              recordEntries(targeted?.items);
            }
          }
        } catch (error) {
          queueMappingLoaded = false; // nothing decidable without the mapping
          for (const { lines } of confirmView.poGroups) {
            for (const { item } of lines) {
              failures.push({
                sku: item.sku,
                step: "decision",
                message: `Could not load the review queue to record the decision: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
        }

        const note = decisionNoteForSubmit(decisionNote, anyFlaggedPo);
        for (const { group, lines } of queueMappingLoaded ? confirmView.poGroups : []) {
          if (!note.ok) {
            // Defensive: the confirm gate already blocks this.
            for (const { item } of lines) failures.push({ sku: item.sku, step: "decision", message: note.error });
            continue;
          }
          if (lines.length > MAX_PO_HANDOFF_LINES) {
            // Fail the whole group BEFORE any decision is recorded: the
            // create-po command accepts at most 25 lines, and recording
            // acceptances that are guaranteed to 400 at handoff would strand
            // decided-but-unordered lines.
            for (const { item } of lines) {
              failures.push({
                sku: item.sku,
                step: "po-handoff",
                message: `${group.vendorName} has ${lines.length} lines — a single PO handoff accepts at most ${MAX_PO_HANDOFF_LINES}. Remove lines from this vendor and retry.`,
              });
            }
            continue;
          }
          const decided: Array<{ item: CockpitItem; state: OrderLineState; entry: ReviewQueueLineEntry }> = [];
          for (const { item, state } of lines) {
            const entry = queueByRecommendationId.get(item.recommendationId);
            if (!entry) {
              failures.push({
                sku: item.sku,
                step: "decision",
                message:
                  "Not in the operator review queue (the automation pipeline owns this line) — a manual accepted_for_po decision cannot be recorded.",
              });
              continue;
            }
            const decision = await postPurchasingCommand(
              "/api/purchasing/recommendation-decisions",
              buildAcceptedForPoDecisionBody(item.recommendationId, entry, note.note),
            );
            if (!decision.ok) {
              failures.push({ sku: item.sku, step: "decision", message: decision.error });
              continue;
            }
            decided.push({ item, state, entry });
          }
          if (decided.length === 0) continue;

          const handoff = await postPurchasingCommand("/api/purchasing/recommendation-accepted-queue/create-po", {
            items: decided.map(({ item, state, entry }) =>
              buildCreatePoItemBody({
                recommendationId: item.recommendationId,
                kind: entry.kind,
                pieces: state.pieces,
                suggestedOrderPieces: item.suggestedOrderPieces,
                exceedReason: state.exceedReason,
              }),
            ),
          });
          const skuById = new Map(decided.map(({ item }) => [item.recommendationId, item.sku]));
          const collectSkipped = (rows: any[]) => {
            for (const row of rows) {
              poSkipped.push({
                sku: row?.sku ?? skuById.get(row?.recommendationId) ?? row?.recommendationId ?? "unknown",
                reason: String(row?.reason ?? "skipped"),
              });
            }
          };
          if (!handoff.ok) {
            // A 409 still carries per-item skip reasons — keep the story per-line.
            if (Array.isArray(handoff.body?.skipped) && handoff.body.skipped.length > 0) {
              collectSkipped(handoff.body.skipped);
            } else {
              for (const { item } of decided) {
                failures.push({ sku: item.sku, step: "po-handoff", message: handoff.error });
              }
            }
            continue;
          }
          for (const po of handoff.body?.pos ?? []) {
            posCreated.push({ poNumber: String(po?.poNumber ?? po?.id ?? "?"), vendorName: group.vendorName });
          }
          for (const row of handoff.body?.handedOff ?? []) {
            handedOffCount += 1;
            if (typeof row?.recommendationId === "string") submittedIds.add(row.recommendationId);
          }
          if (Array.isArray(handoff.body?.skipped)) collectSkipped(handoff.body.skipped);
        }
      }

      // ---------------- RFQ path ----------------
      if (confirmView.rfqGroups.length > 0) {
        const buildRfqMap = (response: RfqQueueResponse | null | undefined) => {
          const map = new Map<string, RfqQueueItem>();
          for (const line of response?.items ?? []) map.set(line.recommendationId, line);
          return map;
        };
        // Re-read the queue at submit time so a stale/unloaded cache can never
        // trigger a needless snapshot run below.
        let lineMap = rfqLineMap;
        try {
          lineMap = buildRfqMap((await getJson("/api/purchasing/rfq-queue")) as RfqQueueResponse);
        } catch {
          // Deliberate: fall back to the query-cache map; truly unmapped lines
          // still fail per-SKU below instead of being silently dropped.
        }
        const allRfqLines = confirmView.rfqGroups.flatMap(({ group, lines }) =>
          lines.map((line) => ({ ...line, group })),
        );
        if (allRfqLines.some(({ item }) => !lineMap.has(item.recommendationId))) {
          // Persist a fresh snapshot so every live line exists as a saved run
          // line, then remap. (This is the same command as Refresh analysis.)
          const run = await postPurchasingCommand("/api/purchasing/recommendation-runs");
          if (!run.ok) {
            for (const { item } of allRfqLines) {
              if (lineMap.has(item.recommendationId)) continue;
              failures.push({
                sku: item.sku,
                step: "rfq",
                message: `Could not save an analysis snapshot to source the RFQ from: ${run.error}`,
              });
            }
          } else {
            try {
              lineMap = buildRfqMap((await getJson("/api/purchasing/rfq-queue")) as RfqQueueResponse);
            } catch {
              // Deliberate: keep the pre-run map; still-unmapped lines fail
              // per-SKU below with an honest message.
            }
          }
        }
        const rfqLineBodies: Array<Parameters<typeof postPurchasingCommand>[1]> = [];
        const rfqLineIds: string[] = [];
        for (const { item, state, group } of allRfqLines) {
          const mapped = lineMap.get(item.recommendationId);
          if (!mapped) {
            failures.push({
              sku: item.sku,
              step: "rfq",
              message: "No saved recommendation-run line exists for this SKU even after refreshing the snapshot.",
            });
            continue;
          }
          const built = buildRfqLineBody({
            recommendationLineId: mapped.recommendationLineId,
            vendorId: group.vendorId,
            pieces: state.pieces,
            remainingPieces: mapped.remainingPieces,
            exceedReason: state.exceedReason,
            exceptionApproved: approvedExceptions.has(item.recommendationId),
          });
          if (!built.ok) {
            failures.push({ sku: item.sku, step: "rfq", message: built.error });
            continue;
          }
          rfqLineBodies.push(built.line);
          rfqLineIds.push(item.recommendationId);
        }
        if (rfqLineBodies.length > 0) {
          const batch = await postPurchasingCommand("/api/purchasing/rfq-queue", {
            idempotencyKey: rfqIdempotencyKey,
            requestNote: null,
            responseDueDate: null,
            lines: rfqLineBodies,
          });
          if (!batch.ok) {
            for (const id of rfqLineIds) {
              failures.push({
                sku: orderableById.get(id)?.sku ?? id,
                step: "rfq",
                message: batch.error,
              });
            }
          } else {
            rfqCreatedCount = Array.isArray(batch.body?.rfqs) ? batch.body.rfqs.length : 0;
            rfqLineCount = Array.isArray(batch.body?.lines) ? batch.body.lines.length : rfqLineBodies.length;
            rfqReused = batch.body?.reused === true;
            for (const id of rfqLineIds) submittedIds.add(id);
            // The key is spent — mint a new one for any follow-up order.
            setRfqIdempotencyKey(crypto.randomUUID());
          }
        }
      }
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }

    // Successfully submitted lines leave the order; failed lines stay
    // selected (with their edits) so the operator can retry after fixing.
    setOrderSelection((current) => {
      const next = new Map(current);
      for (const id of submittedIds) next.delete(id);
      return next;
    });
    invalidateAfterOrderMutations();
    setSubmitResult({
      posCreated,
      handedOffCount,
      poSkipped,
      rfqCreatedCount,
      rfqLineCount,
      rfqReused,
      failures,
    });
    setBuilderStage("result");
    if (failures.length > 0) {
      const preview = failures
        .slice(0, 3)
        .map((failure) => `${failure.sku}: ${failure.message}`)
        .join(" · ");
      toast({
        title: `${failures.length} line${failures.length === 1 ? "" : "s"} not submitted`,
        description: preview + (failures.length > 3 ? ` (+${failures.length - 3} more)` : ""),
        variant: "destructive",
      });
    } else {
      toast({
        title: "Order submitted",
        description: [
          posCreated.length > 0 ? `${posCreated.length} draft PO${posCreated.length === 1 ? "" : "s"}` : "",
          rfqCreatedCount > 0 ? `${rfqCreatedCount} RFQ${rfqCreatedCount === 1 ? "" : "s"}` : "",
          poSkipped.length > 0 ? `${poSkipped.length} skipped` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "Nothing was created.",
      });
    }
  };

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

  // Stage-1 rollup: vendor counts by mode, submittable totals, and the first
  // missing exceed/change reason (the only stage-1 gate — approvals and the
  // decision note belong to stage 2, per the approved mock).
  const stage1 = useMemo(() => {
    let missingReason: string | null = null;
    let poVendorCount = 0;
    let rfqVendorCount = 0;
    let itemCount = 0;
    let grandCents = 0;
    let missingCostCount = 0;
    for (const group of builderGroups.vendorGroups) {
      const mode = vendorMode[group.key] ?? "po";
      let vendorHasPieces = false;
      for (const item of group.lines) {
        const state = orderSelection.get(item.recommendationId);
        if (!state || state.pieces <= 0) continue;
        vendorHasPieces = true;
        itemCount += 1;
        const cents = orderLineValueCents(item, state.pieces);
        if (cents === null) missingCostCount += 1;
        else grandCents += cents;
        const needsReason =
          mode === "rfq"
            ? rfqLineNeedsReason(
                state.pieces,
                rfqBaselinePieces(rfqLineMap.get(item.recommendationId)?.remainingPieces, item.suggestedOrderPieces),
              )
            : exceedsSuggestion(state.pieces, item.suggestedOrderPieces);
        if (needsReason && !exceedReasonValid(state.exceedReason) && !missingReason) {
          missingReason =
            mode === "rfq"
              ? `Enter a reason (at least 3 characters) for changing the run baseline on ${item.sku}`
              : `Enter a reason (at least 3 characters) for exceeding the recommendation on ${item.sku}`;
        }
      }
      if (vendorHasPieces) {
        if (mode === "rfq") rfqVendorCount += 1;
        else poVendorCount += 1;
      }
    }
    return { missingReason, poVendorCount, rfqVendorCount, itemCount, grandCents, missingCostCount };
  }, [builderGroups, vendorMode, orderSelection, rfqLineMap]);

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
      <div className="mb-2 flex flex-wrap items-start gap-3">
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

      {/* ---------------- Engine tab strip (see ENGINE_TABS_COMING_SOON) ---------------- */}
      {/* Outer div owns horizontal scrolling so narrow viewports scroll the
          strip instead of squashing/wrapping tab labels; the nav keeps
          overflow visible so the active tab's -mb-px border overlay is not
          clipped. w-max + min-w-full: border-b spans max(tabs, container). */}
      <div className="mb-4 overflow-x-auto">
        <nav aria-label="Reorder Engine sections" className="flex w-max min-w-full items-center gap-1 whitespace-nowrap border-b">
          <span aria-current="page" className="-mb-px border-b-2 border-primary px-3 py-1.5 text-sm font-semibold text-primary">
            Analysis
          </span>
          <Link
            href="/demand-planner"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Demand Planner
          </Link>
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
                <Table className="min-w-[1020px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-[36px]" aria-label="Add to order" />
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
                      <TableHead className="w-[200px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={12} className="py-10 text-center text-sm text-zinc-500">
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
                          orderSelection={orderSelection}
                          onToggleOrder={toggleOrder}
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

      {/* ---------------- Sticky order bar ---------------- */}
      {barSummary.lineCount > 0 && !builderOpen && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-50 shadow-lg">
            <ShoppingCart className="h-4 w-4" />
            <span>
              Review order —{" "}
              <b>
                {barSummary.lineCount} item{barSummary.lineCount === 1 ? "" : "s"} ·{" "}
                {formatMoneyCents(barSummary.totalCents)}
              </b>
              {barSummary.missingCostCount > 0 && (
                <span className="text-zinc-400"> · {barSummary.missingCostCount} missing cost</span>
              )}
            </span>
            <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={openBuilder}>
              Open order builder
            </Button>
          </div>
        </div>
      )}

      {/* ---------------- Order Builder drawer ---------------- */}
      <Sheet open={builderOpen} onOpenChange={(open) => !open && setBuilderOpen(false)}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-2xl">
          <SheetHeader className="border-b px-5 py-4 text-left">
            <SheetTitle className="flex items-center gap-2 text-base">
              {builderStage === "confirm" && (
                <Button variant="ghost" size="sm" className="-ml-2 h-7 px-2 text-xs" onClick={() => setBuilderStage("edit")}>
                  ← Back
                </Button>
              )}
              {builderStage === "edit"
                ? "Order builder"
                : builderStage === "confirm"
                  ? "Confirm order"
                  : "Order result"}
            </SheetTitle>
            <SheetDescription>
              {builderStage === "edit"
                ? stage1.itemCount > 0
                  ? "Lines grouped by vendor · edit pieces to resize the order"
                  : "Nothing selected"
                : builderStage === "confirm"
                  ? "Step 2 of 2 · decision evidence before anything is drafted"
                  : "What was created, what was skipped, and what failed"}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-4 px-5 py-4">
            {/* ---------------- Stage 1: edit ---------------- */}
            {builderStage === "edit" && (
              <>
                {builderGroups.vendorGroups.length === 0 && builderGroups.needsSupplier.length === 0 && (
                  <div className="py-10 text-center text-sm text-zinc-500">No items — add SKUs from the table</div>
                )}
                {builderGroups.vendorGroups.map((group) => {
                  const mode = vendorMode[group.key] ?? "po";
                  let vendorCents = 0;
                  return (
                    <div key={group.key} className="overflow-hidden rounded-md border">
                      <div className="flex items-center justify-between border-b bg-zinc-50 px-3 py-2">
                        <span className="text-sm font-semibold">{group.vendorName}</span>
                        <span className="text-xs text-zinc-500">lead {group.lines[0]?.leadTimeDays ?? "?"}d</span>
                      </div>
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b text-left text-[10px] uppercase tracking-wide text-zinc-500">
                            <th className="px-3 py-1.5 font-semibold">SKU</th>
                            <th className="py-1.5 font-semibold">Product</th>
                            <th className="py-1.5 font-semibold">Need by</th>
                            <th className="py-1.5 text-right font-semibold">Pieces</th>
                            <th className="py-1.5 text-right font-semibold">Unit cost</th>
                            <th className="py-1.5 pr-1 text-right font-semibold">Line total</th>
                            <th className="w-[34px]" />
                          </tr>
                        </thead>
                        <tbody>
                          {group.lines.map((item) => {
                            const state = orderSelection.get(item.recommendationId)!;
                            const lineCents = orderLineValueCents(item, state.pieces);
                            if (lineCents !== null) vendorCents += lineCents;
                            const increment = orderIncrementPieces(item.supplierBasis);
                            const unitCents = unitCostCents(item);
                            const baseline =
                              mode === "rfq"
                                ? rfqBaselinePieces(
                                    rfqLineMap.get(item.recommendationId)?.remainingPieces,
                                    item.suggestedOrderPieces,
                                  )
                                : item.suggestedOrderPieces;
                            const needsReason =
                              mode === "rfq"
                                ? rfqLineNeedsReason(state.pieces, baseline)
                                : exceedsSuggestion(state.pieces, item.suggestedOrderPieces);
                            const soon = item.status === "order_soon" ? orderSoonDates(asOfIsoDate, item) : null;
                            return (
                              <Fragment key={item.recommendationId}>
                                <tr className="border-b last:border-b-0">
                                  <td className="px-3 py-2 font-mono">{item.sku}</td>
                                  <td className="max-w-[150px] py-2">
                                    <div className="truncate font-medium" title={item.productName}>
                                      {item.productName}
                                    </div>
                                    {item.supplierBasis.costQuality !== "current" && (
                                      <div className="text-[11px] text-amber-600">
                                        vendor cost {item.supplierBasis.costQuality.replace(/_/g, " ")} — consider
                                        requesting a quote
                                      </div>
                                    )}
                                  </td>
                                  <td className="whitespace-nowrap py-2">
                                    {item.status === "stockout" || item.status === "order_now" ? (
                                      <span className="font-semibold text-red-600">today</span>
                                    ) : soon ? (
                                      <>by {formatIsoDateShort(soon.orderByDate)}</>
                                    ) : (
                                      <span className="text-zinc-400">—</span>
                                    )}
                                  </td>
                                  <td className="py-2 text-right">
                                    <Input
                                      type="number"
                                      min={0}
                                      step={increment}
                                      className="ml-auto h-7 w-[84px] text-right text-xs"
                                      value={pieceDrafts[item.recommendationId] ?? String(state.pieces)}
                                      onChange={(event) => handlePiecesChange(item.recommendationId, event.target.value)}
                                      onBlur={() => handlePiecesBlur(item)}
                                      aria-label={`Pieces for ${item.sku}`}
                                    />
                                    {roundedHints[item.recommendationId] && (
                                      <div className="mt-0.5 text-[11px] text-zinc-500">
                                        {roundedHints[item.recommendationId]}
                                      </div>
                                    )}
                                  </td>
                                  <td className="py-2 text-right tabular-nums">
                                    {unitCents !== null ? formatMoneyCents(unitCents) : <span className="text-zinc-400">—</span>}
                                  </td>
                                  <td className="py-2 pr-1 text-right font-semibold tabular-nums">
                                    {lineCents !== null ? formatMoneyCents(lineCents) : <span className="font-normal text-zinc-400">cost missing</span>}
                                  </td>
                                  <td className="py-2 text-center">
                                    <button
                                      type="button"
                                      className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                                      title="Remove from order"
                                      aria-label={`Remove ${item.sku} from order`}
                                      onClick={() => removeOrderRow(item.recommendationId)}
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </button>
                                  </td>
                                </tr>
                                {needsReason && (
                                  <tr className="border-b last:border-b-0">
                                    <td colSpan={7} className="px-3 pb-2">
                                      <div className="text-[11px] font-semibold text-amber-600">
                                        {mode === "rfq"
                                          ? `Differs from the saved run baseline — ${baseline.toLocaleString()} pieces remaining`
                                          : `Exceeds the recommendation — suggested ${item.suggestedOrderPieces.toLocaleString()}`}
                                      </div>
                                      <Input
                                        className="mt-1 h-7 text-xs"
                                        placeholder={
                                          mode === "rfq"
                                            ? "Reason for changing the requested quantity"
                                            : "Reason for exceeding the recommendation"
                                        }
                                        value={state.exceedReason}
                                        onChange={(event) =>
                                          handleExceedReasonChange(item.recommendationId, event.target.value)
                                        }
                                        aria-label={`Override reason for ${item.sku}`}
                                      />
                                      {!exceedReasonValid(state.exceedReason) && (
                                        <div className="mt-0.5 text-[11px] text-red-600">
                                          Required — at least 3 characters
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-zinc-50/60 px-3 py-2 text-xs">
                        <span>
                          Vendor total <b className="tabular-nums">{formatMoneyCents(vendorCents)}</b>
                        </span>
                        <span className="flex items-center gap-3">
                          <label className="flex cursor-pointer items-center gap-1.5">
                            <input
                              type="radio"
                              name={`order-mode-${group.key}`}
                              value="po"
                              checked={mode === "po"}
                              onChange={() => setVendorMode((current) => ({ ...current, [group.key]: "po" }))}
                            />
                            Send as PO
                          </label>
                          <label className="flex cursor-pointer items-center gap-1.5">
                            <input
                              type="radio"
                              name={`order-mode-${group.key}`}
                              value="rfq"
                              checked={mode === "rfq"}
                              onChange={() => setVendorMode((current) => ({ ...current, [group.key]: "rfq" }))}
                            />
                            Request quote
                          </label>
                        </span>
                      </div>
                    </div>
                  );
                })}

                {/* Needs supplier — selected lines that can never submit */}
                {builderGroups.needsSupplier.length > 0 && (
                  <div className="overflow-hidden rounded-md border border-amber-200">
                    <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                      Needs supplier — cannot be submitted
                    </div>
                    {builderGroups.needsSupplier.map((item) => (
                      <div
                        key={item.recommendationId}
                        className="flex items-center justify-between border-b px-3 py-2 text-xs last:border-b-0"
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-mono font-semibold">{item.sku}</span>{" "}
                          <span className="text-zinc-600">{item.productName}</span>
                        </span>
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          <span className="tabular-nums text-zinc-500">
                            {(orderSelection.get(item.recommendationId)?.pieces ?? 0).toLocaleString()} pc
                          </span>
                          <button
                            type="button"
                            className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
                            title="Remove from order"
                            aria-label={`Remove ${item.sku} from order`}
                            onClick={() => removeOrderRow(item.recommendationId)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </div>
                    ))}
                    <div className="px-3 py-2 text-xs text-amber-700">
                      These SKUs have no preferred supplier, so neither a PO nor a quote request can be created.{" "}
                      <button
                        type="button"
                        className="font-semibold underline"
                        onClick={() => navigate("/suppliers")}
                      >
                        Assign a supplier →
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ---------------- Stage 2: confirm ---------------- */}
            {builderStage === "confirm" && (
              <>
                {confirmView.poGroups.length > 0 && (() => {
                  // Risk-proportional confirm (rev 5): clean lines are compact
                  // rows; flagged lines (controls or sourcing exception) carry
                  // the evidence checkboxes.
                  const ready: Array<{ item: CockpitItem; state: OrderLineState; vendorName: string }> = [];
                  const flaggedVendors: Array<{
                    vendorName: string;
                    lines: Array<{ item: CockpitItem; state: OrderLineState }>;
                  }> = [];
                  for (const { group, lines } of confirmView.poGroups) {
                    const flagged = lines.filter(({ item, state }) =>
                      poLineFlagged(item.qualityControls?.length ?? 0, state.pieces, item.suggestedOrderPieces),
                    );
                    for (const line of lines) {
                      if (!flagged.includes(line)) ready.push({ ...line, vendorName: group.vendorName });
                    }
                    if (flagged.length > 0) flaggedVendors.push({ vendorName: group.vendorName, lines: flagged });
                  }
                  return (
                    <>
                      {ready.length > 0 && (
                        <div>
                          <div className="text-sm font-semibold">Ready — no active warnings</div>
                          <div className="mb-2 text-xs text-zinc-500">
                            Nothing flagged — the autopilot would order these itself once auto-send is unlocked.
                          </div>
                          <div className="divide-y rounded-md border">
                            {ready.map(({ item, state, vendorName }) => (
                              <div
                                key={item.recommendationId}
                                className="flex items-baseline justify-between gap-3 px-3 py-2 text-xs"
                              >
                                <span className="min-w-0 truncate">
                                  <span className="font-mono font-semibold">{item.sku}</span>{" "}
                                  <span>{item.productName}</span>{" "}
                                  <span className="text-zinc-500">· {vendorName}</span>
                                </span>
                                <span className="whitespace-nowrap tabular-nums">
                                  {state.pieces.toLocaleString()} pc
                                  {orderLineValueCents(item, state.pieces) !== null
                                    ? ` · ${formatMoneyCents(orderLineValueCents(item, state.pieces)!)}`
                                    : ""}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {flaggedVendors.length > 0 && (
                        <div>
                          <div className="text-sm font-semibold">Flagged — acknowledge each warning</div>
                          <div className="mb-2 text-xs text-zinc-500">
                            These are the reasons the autopilot won&rsquo;t order these SKUs by itself. They never
                            block your manual order — each tick records that you saw the warning.
                          </div>
                          <div className="space-y-3">
                            {flaggedVendors.map(({ vendorName, lines }) => (
                              <div key={vendorName} className="rounded-md border">
                                <div className="border-b bg-zinc-50 px-3 py-1.5 text-xs font-semibold">{vendorName}</div>
                                {lines.map(({ item, state }) => (
                                  <div key={item.recommendationId} className="space-y-1.5 border-b px-3 py-2 last:border-b-0">
                                    <div className="flex items-baseline justify-between gap-3 text-xs">
                                      <span className="min-w-0 truncate">
                                        <span className="font-mono font-semibold">{item.sku}</span>{" "}
                                        <span>{item.productName}</span>
                                      </span>
                                      <span className="whitespace-nowrap tabular-nums">
                                        {state.pieces.toLocaleString()} pc
                                        {orderLineValueCents(item, state.pieces) !== null
                                          ? ` · ${formatMoneyCents(orderLineValueCents(item, state.pieces)!)}`
                                          : ""}
                                      </span>
                                    </div>
                                    {(item.qualityControls ?? []).map((control) => {
                                      const key = controlAckKey(item.recommendationId, control.code);
                                      return (
                                        <label key={key} className="flex cursor-pointer items-start gap-2 text-xs">
                                          <Checkbox
                                            className="mt-0.5"
                                            checked={ackedControls.has(key)}
                                            onCheckedChange={(checked) =>
                                              setAckedControls((current) => {
                                                const next = new Set(current);
                                                if (checked === true) next.add(key);
                                                else next.delete(key);
                                                return next;
                                              })
                                            }
                                          />
                                          <Badge
                                            variant="outline"
                                            className={`flex-none cursor-help ${
                                              control.severity === "block" ? TONE_BADGE_CLASSES.red : TONE_BADGE_CLASSES.amber
                                            }`}
                                            title={
                                              control.severity === "block"
                                                ? "The autopilot refuses to order this itself until the cause is fixed. It does not block your manual order."
                                                : "The autopilot flags this but could proceed. Informational for your manual order."
                                            }
                                          >
                                            {control.severity === "block" ? "Auto-block" : "Auto-warn"}
                                          </Badge>
                                          <span className="leading-5">{control.label}</span>
                                        </label>
                                      );
                                    })}
                                    {exceedsSuggestion(state.pieces, item.suggestedOrderPieces) && (
                                      <label className="flex cursor-pointer items-start gap-2 text-xs">
                                        <Checkbox
                                          className="mt-0.5"
                                          checked={approvedExceptions.has(item.recommendationId)}
                                          onCheckedChange={(checked) =>
                                            setApprovedExceptions((current) => {
                                              const next = new Set(current);
                                              if (checked === true) next.add(item.recommendationId);
                                              else next.delete(item.recommendationId);
                                              return next;
                                            })
                                          }
                                        />
                                        <Badge variant="outline" className={`flex-none ${TONE_BADGE_CLASSES.amber}`}>
                                          Exception
                                        </Badge>
                                        <span className="leading-5">
                                          Approve this sourcing exception — {state.pieces.toLocaleString()} pc vs
                                          suggested {item.suggestedOrderPieces.toLocaleString()}. Reason: &ldquo;
                                          {state.exceedReason.trim()}&rdquo;
                                        </span>
                                      </label>
                                    )}
                                    <div className="text-[11px] text-zinc-500">
                                      Why the autopilot holds this SKU — it never blocks a manual order.
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div>
                        <div className="text-sm font-semibold">
                          Decision note <span className="font-normal text-zinc-500">· shared across these POs</span>
                        </div>
                        <Textarea
                          rows={3}
                          maxLength={2000}
                          className="mt-1 text-xs"
                          placeholder={
                            anyFlaggedPo
                              ? `Why this order? (min ${DECISION_NOTE_MIN_LENGTH} characters)`
                              : "Optional note (recorded in the audit trail)"
                          }
                          value={decisionNote}
                          onChange={(event) => setDecisionNote(event.target.value)}
                        />
                        {anyFlaggedPo ? (
                          <div
                            className={`mt-0.5 text-[11px] ${
                              decisionNote.trim().length < DECISION_NOTE_MIN_LENGTH ? "text-red-600" : "text-zinc-500"
                            }`}
                          >
                            {decisionNote.length} / 2000
                          </div>
                        ) : (
                          <div className="mt-0.5 text-[11px] text-zinc-500">
                            Left blank, &ldquo;{AUTO_DECISION_NOTE}&rdquo; is recorded.
                          </div>
                        )}
                      </div>
                      {anyFlaggedPo && (
                        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          Approving flagged items does not change automation eligibility — blocks clear when the
                          cause is fixed (verify the cost, let history build).
                        </div>
                      )}
                      <div className="text-[11px] text-zinc-500">
                        POs are always created as <b>drafts</b> — nothing goes to a vendor until you send it (or
                        auto-send is unlocked for that vendor on the Automation ladder).
                      </div>
                    </>
                  );
                })()}

                {confirmView.rfqGroups.length > 0 && (
                  <div>
                    <div className="text-sm font-semibold">RFQ drafts</div>
                    <div className="mt-2 space-y-3">
                      {confirmView.rfqGroups.map(({ group, lines }) => (
                        <div key={group.key} className="rounded-md border">
                          <div className="flex items-center justify-between border-b bg-zinc-50 px-3 py-1.5 text-xs">
                            <b>{group.vendorName}</b>
                            <span className="text-zinc-500">
                              quote request · {lines.length} line{lines.length === 1 ? "" : "s"}
                            </span>
                          </div>
                          {lines.map(({ item, state }) => {
                            const baseline = rfqBaselinePieces(
                              rfqLineMap.get(item.recommendationId)?.remainingPieces,
                              item.suggestedOrderPieces,
                            );
                            return (
                              <div key={item.recommendationId} className="space-y-1 border-b px-3 py-2 text-xs last:border-b-0">
                                <div className="flex items-baseline justify-between gap-3">
                                  <span className="min-w-0 truncate">
                                    <span className="font-mono">{item.sku}</span> {item.productName}
                                  </span>
                                  <span className="whitespace-nowrap tabular-nums">{state.pieces.toLocaleString()} pc</span>
                                </div>
                                {rfqLineNeedsApproval(state.pieces, baseline) && (
                                  <label className="flex cursor-pointer items-start gap-2">
                                    <Checkbox
                                      className="mt-0.5"
                                      checked={approvedExceptions.has(item.recommendationId)}
                                      onCheckedChange={(checked) =>
                                        setApprovedExceptions((current) => {
                                          const next = new Set(current);
                                          if (checked === true) next.add(item.recommendationId);
                                          else next.delete(item.recommendationId);
                                          return next;
                                        })
                                      }
                                    />
                                    <Badge variant="outline" className={`flex-none ${TONE_BADGE_CLASSES.amber}`}>
                                      Exception
                                    </Badge>
                                    <span className="leading-5">
                                      Approve requesting {state.pieces.toLocaleString()} pc vs{" "}
                                      {baseline.toLocaleString()} remaining in the saved run. Reason: &ldquo;
                                      {state.exceedReason.trim()}&rdquo;
                                    </span>
                                  </label>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px] text-zinc-500">
                      No decision evidence needed — quote requests are drafts. Track them in the RFQs tab.
                      {confirmView.rfqGroups.some(({ lines }) =>
                        lines.some(({ item }) => !rfqLineMap.has(item.recommendationId)),
                      )
                        ? " Some lines have no saved run line yet — submitting first saves a fresh analysis snapshot (same as Refresh analysis)."
                        : ""}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ---------------- Stage 3: result ---------------- */}
            {builderStage === "result" && submitResult && (
              <div className="space-y-4 text-sm">
                {submitResult.posCreated.length > 0 && (
                  <div>
                    <div className="font-semibold">Draft POs created</div>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                      {submitResult.posCreated.map((po, index) => (
                        <li key={`${po.poNumber}-${index}`}>
                          <span className="font-mono">{po.poNumber}</span> — {po.vendorName}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1 text-xs text-zinc-500">
                      {submitResult.handedOffCount} line{submitResult.handedOffCount === 1 ? "" : "s"} handed off.
                      Drafts are open for review — nothing was sent to a vendor.
                    </div>
                  </div>
                )}
                {submitResult.rfqLineCount > 0 && (
                  <div>
                    <div className="font-semibold">RFQ drafts</div>
                    <div className="mt-1 text-xs text-zinc-600">
                      {submitResult.rfqReused
                        ? "An identical batch already existed for this idempotency key — the existing drafts were reused."
                        : `${submitResult.rfqCreatedCount} RFQ draft${submitResult.rfqCreatedCount === 1 ? "" : "s"} created from ${submitResult.rfqLineCount} line${submitResult.rfqLineCount === 1 ? "" : "s"}.`}{" "}
                      Track them in the RFQs tab.
                    </div>
                  </div>
                )}
                {submitResult.poSkipped.length > 0 && (
                  <div>
                    <div className="font-semibold text-amber-700">Skipped by the PO handoff</div>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                      {submitResult.poSkipped.map((row, index) => (
                        <li key={`${row.sku}-${index}`}>
                          <span className="font-mono">{row.sku}</span> — <span className="text-zinc-600">{row.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {submitResult.failures.length > 0 && (
                  <div>
                    <div className="font-semibold text-red-700">Not submitted</div>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                      {submitResult.failures.map((failure, index) => (
                        <li key={`${failure.sku}-${index}`}>
                          <span className="font-mono">{failure.sku}</span>{" "}
                          <Badge variant="outline" className="mx-1 align-middle text-[10px]">
                            {failure.step}
                          </Badge>
                          <span className="text-zinc-600">{failure.message}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1 text-xs text-zinc-500">
                      Failed lines stay in the order with their edits — fix the cause and retry.
                    </div>
                  </div>
                )}
                {submitResult.posCreated.length === 0 &&
                  submitResult.rfqLineCount === 0 &&
                  submitResult.poSkipped.length === 0 &&
                  submitResult.failures.length === 0 && (
                    <div className="text-zinc-500">Nothing was created.</div>
                  )}
              </div>
            )}
          </div>

          {/* ---------------- Footer ---------------- */}
          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-white px-5 py-3">
            {builderStage === "result" ? (
              <>
                <div className="text-xs text-zinc-500">
                  {submitResult && submitResult.failures.length > 0
                    ? `${submitResult.failures.length} line${submitResult.failures.length === 1 ? "" : "s"} still need attention`
                    : "All done"}
                </div>
                <div className="flex gap-2">
                  {submitResult && submitResult.failures.length > 0 && (
                    <Button variant="outline" size="sm" onClick={() => setBuilderStage("edit")}>
                      Back to builder
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setBuilderOpen(false)}>
                    Close
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm">
                  Order total <b className="tabular-nums">{formatMoneyCents(stage1.grandCents)}</b>
                  <div className="text-[11px] text-zinc-500">
                    {stage1.itemCount} item{stage1.itemCount === 1 ? "" : "s"} ·{" "}
                    {stage1.poVendorCount + stage1.rfqVendorCount} vendor
                    {stage1.poVendorCount + stage1.rfqVendorCount === 1 ? "" : "s"}
                    {stage1.missingCostCount > 0 ? ` · ${stage1.missingCostCount} missing cost` : ""}
                  </div>
                </div>
                {builderStage === "edit" ? (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setBuilderOpen(false)}>
                      Keep editing
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        stage1.poVendorCount + stage1.rfqVendorCount === 0 || stage1.missingReason !== null
                      }
                      title={
                        stage1.poVendorCount + stage1.rfqVendorCount === 0
                          ? "Nothing to order — set pieces above zero first"
                          : stage1.missingReason ?? ""
                      }
                      onClick={() => setBuilderStage("confirm")}
                    >
                      {stage1.poVendorCount + stage1.rfqVendorCount === 0
                        ? "Nothing to order"
                        : `Continue → confirm ${[
                            stage1.poVendorCount > 0 ? `${stage1.poVendorCount} PO${stage1.poVendorCount === 1 ? "" : "s"}` : "",
                            stage1.rfqVendorCount > 0 ? `${stage1.rfqVendorCount} RFQ${stage1.rfqVendorCount === 1 ? "" : "s"}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}`}
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setBuilderStage("edit")}>
                      ← Back
                    </Button>
                    <Button
                      size="sm"
                      disabled={confirmMissing !== null || isSubmitting}
                      title={confirmMissing ?? ""}
                      onClick={submitOrder}
                    >
                      {isSubmitting
                        ? "Submitting…"
                        : confirmPrimaryLabel(confirmView.poGroups.length, confirmView.rfqGroups.length)}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
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
  orderSelection,
  onToggleOrder,
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
  orderSelection: OrderSelection;
  onToggleOrder: (item: CockpitItem) => void;
}) {
  return (
    <>
      {grouped && (
        <TableRow className="cursor-pointer bg-zinc-50 hover:bg-zinc-100" onClick={onToggleCollapsed}>
          <TableCell colSpan={12} className="py-2">
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
            inOrder={orderSelection.has(item.recommendationId)}
            onToggleOrder={() => onToggleOrder(item)}
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
  inOrder,
  onToggleOrder,
}: {
  item: CockpitItem;
  highlighted: boolean;
  asOfIsoDate: string;
  onExplain: () => void;
  inOrder: boolean;
  onToggleOrder: () => void;
}) {
  const skipped = item.skippedReason !== null && item.skippedReason !== undefined;
  // Any non-excluded row can join the order (rev 2: healthy rows exist for
  // MOQ/freight top-offs); analysis membership is managed on Planning Policy.
  const orderable = item.skippedReason !== "excluded";
  const lineValue = suggestedValueCents(item);
  const baseReorderPoint = item.leadTimeBasis.reorderPointPieces;
  const adjustedReorderPoint = item.forwardDemandBasis.adjustedReorderPoint;
  const eventAdjusted = adjustedReorderPoint !== baseReorderPoint;
  return (
    <TableRow
      id={rowDomId(item.recommendationId)}
      className={`${skipped ? "bg-zinc-50/60 text-zinc-400" : ""} ${
        highlighted ? "bg-blue-50 ring-1 ring-inset ring-blue-300" : ""
      } ${inOrder ? "bg-emerald-50/50" : ""}`}
    >
      <TableCell className="pr-0">
        {orderable && (
          <Checkbox
            checked={inOrder}
            onCheckedChange={onToggleOrder}
            aria-label={inOrder ? `Remove ${item.sku} from order` : `Add ${item.sku} to order`}
          />
        )}
      </TableCell>
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
        <div className="flex items-center justify-end gap-1.5">
          {orderable && (
            <Button
              variant={inOrder ? "secondary" : "outline"}
              size="sm"
              className={`h-7 whitespace-nowrap px-2 text-xs ${inOrder ? "text-emerald-700" : ""}`}
              onClick={onToggleOrder}
            >
              {inOrder ? "✓ Added · Remove" : "Add to order"}
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onExplain}>
            Explain
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
