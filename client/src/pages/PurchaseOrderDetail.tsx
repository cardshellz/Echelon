import React from "react";
import {
  dollarsToCents,
  formatMills,
  centsToMills,
} from "@shared/utils/money";
import {
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";
import {
  PO_PHYSICAL_STATUSES,
  PO_FINANCIAL_STATUSES,
} from "@shared/schema/procurement.schema";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  PoLinePricingEditor,
  createEmptyPoLinePricingDraft,
  createVendorCatalogPricingDraft,
  evaluatePoLinePricingDraft,
  formatVendorCatalogQuote,
  isVendorCatalogQuoteReusable,
  vendorCatalogQuoteStatus,
  type PoLinePricingEditorDraft,
} from "@/features/po-edit/PoLinePricingEditor";
import {
  createStoredPoLinePricingDraft,
  vendorCatalogPackSizeForPricing,
} from "@/features/po-edit/stored-po-line-pricing";
import {
  PoLineQuoteMetadataEditor,
  changedPoLineQuoteMetadata,
  createEmptyPoLineQuoteMetadataDraft,
  createPoLineQuoteMetadataDraftFromStored,
  evaluatePoLineQuoteMetadataDraft,
  populatedPoLineQuoteMetadata,
  reusableCatalogQuoteDateMissing,
  type PoLineQuoteMetadataDraft,
} from "@/features/po-edit/PoLineQuoteMetadataEditor";
import { isImmutableRecommendationPurchaseOrder } from "@/features/po-edit/purchase-order-editability";
import {
  ShipmentReceiptPackResolutionDialog,
  type ShipmentReceiptPackResolution,
  type ShipmentReceiptPackResolutionLine,
} from "@/components/purchasing/ShipmentReceiptPackResolutionDialog";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import {
  ArrowLeft,
  FileText,
  Send,
  CheckCircle,
  XCircle,
  Clock,
  Plus,
  Trash2,
  Package,
  ChevronsUpDown,
  Check,
  AlertTriangle,
  RotateCcw,
  Ban,
  Archive,
  Truck,
  Pencil,
  Ship,
  ExternalLink,
  Printer,
  Mail,
  DollarSign,
} from "lucide-react";

// ── Dual-track display helpers ─────────────────────────────────────────────────────

// Physical stages displayed in the timeline (cancelled / short_closed are shown differently)
const PHYSICAL_TRACK_STAGES = PO_PHYSICAL_STATUSES.filter(
  (s) => s !== "cancelled" && s !== "short_closed",
) as readonly string[];

// Stage label abbreviations for the track dots
const PHYSICAL_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  acknowledged: "Ack'd",
  shipped: "Shipped",
  in_transit: "Transit",
  arrived: "Arrived",
  receiving: "Receiving",
  received: "Received",
};

const FINANCIAL_LABELS: Record<string, string> = {
  unbilled: "Unbilled",
  invoiced: "Invoiced",
  partially_paid: "Partial",
  paid: "Paid",
  disputed: "Disputed",
};

function apLedgerOutcomeDescription(result: any): string | undefined {
  const outcome = result?.apLedgerOutcome;
  if (!outcome) return undefined;
  const poIds = Array.isArray(outcome.affectedPurchaseOrderIds) ? outcome.affectedPurchaseOrderIds : [];
  if (poIds.length) return `Updated linked POs: ${poIds.join(", ")}`;
  return outcome.message;
}

// The 4 linear financial stages; 'disputed' shown as warn on partially_paid
const FINANCIAL_TRACK_STAGES = [
  "unbilled",
  "invoiced",
  "partially_paid",
  "paid",
] as const;

type StageState = "done" | "current" | "warn" | "future";

type PoLifecycleActionId =
  | "submit"
  | "return_to_draft"
  | "approve"
  | "send"
  | "send_to_vendor"
  | "acknowledge"
  | "mark_shipped"
  | "mark_in_transit"
  | "mark_arrived"
  | "create_receipt"
  | "cancel"
  | "close"
  | "close_short";

type PoLifecycleSummary = {
  nextActions?: Array<{ id: PoLifecycleActionId }>;
};

type AutoDraftActionPlanActionId =
  | PoLifecycleActionId
  | "open_lines"
  | "open_exceptions"
  | "create_invoice"
  | "record_payment"
  | "done"
  | "cancelled";

type AutoDraftActionPlan = {
  primaryAction: {
    id: AutoDraftActionPlanActionId;
    label: string;
    detail: string;
    severity: "info" | "warning" | "critical" | "success";
    tab?: "lines" | "exceptions" | "receipts" | "invoices" | "payments" | "shipments";
    lifecycleActionId?: PoLifecycleActionId;
  };
  checklist: Array<{
    id: string;
    label: string;
    status: "done" | "current" | "pending" | "blocked";
    detail?: string;
  }>;
  context: {
    lineCount: number | null;
    openExceptionCount: number;
    availableLifecycleActionIds: PoLifecycleActionId[];
  };
};

const AUTO_DRAFT_STEP_STYLES: Record<
  AutoDraftActionPlan["checklist"][number]["status"],
  string
> = {
  done: "border-green-200 bg-green-50 text-green-700",
  current: "border-blue-200 bg-blue-50 text-blue-700",
  pending: "border-muted bg-muted/40 text-muted-foreground",
  blocked: "border-red-200 bg-red-50 text-red-700",
};

const AUTO_DRAFT_SEVERITY_STYLES: Record<
  AutoDraftActionPlan["primaryAction"]["severity"],
  string
> = {
  info: "border-blue-200 bg-blue-50 text-blue-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  critical: "border-red-200 bg-red-50 text-red-700",
  success: "border-green-200 bg-green-50 text-green-700",
};

function stageState(
  stageIndex: number,
  currentIndex: number,
  isWarn: boolean,
): StageState {
  // Convention (set 2026-05-01): the stage the PO is currently IN
  // is rendered as 'done' (the action that put us there is complete).
  // The NEXT stage is rendered as 'current' (the action we're waiting
  // on). Terminal stages (received, paid) leave nothing as current.
  if (currentIndex < 0) return "future"; // unknown status
  if (stageIndex === currentIndex) return isWarn ? "warn" : "done";
  if (stageIndex < currentIndex) return "done";
  if (stageIndex === currentIndex + 1) return "current";
  return "future";
}

/**
 * Per-stage info shown in the tooltip when a user hovers a dot.
 *
 *   ts:    ISO datetime string for when the stage was reached (rendered as
 *          the headline of the tooltip).
 *   extra: optional list of additional context lines (e.g. money amounts,
 *          received-vs-ordered counts). Rendered after the timestamp.
 *
 * Both fields are optional; the tooltip falls back to a state-derived label
 * when nothing is supplied (matches the prior behavior).
 */
export interface StageTooltipInfo {
  ts?: string | null;
  extra?: Array<string | null | undefined>;
}

/** A dot-and-connector timeline for one track */
function TrackTimeline({
  stages,
  currentStatus,
  isWarn,
  timestamps,
}: {
  stages: readonly string[];
  currentStatus: string;
  isWarn?: boolean;
  // Map of stage name -> rich tooltip info. Stages absent from the map use
  // the default state-derived label.
  timestamps?: Record<string, StageTooltipInfo | undefined>;
}) {
  const effectiveStatus =
    currentStatus === "disputed" ? "partially_paid" : currentStatus;
  const currentIdx = stages.indexOf(effectiveStatus);

  return (
    <div className="flex items-center gap-0">
      {stages.map((stage, i) => {
        const state = stageState(i, currentIdx, !!(isWarn && i === currentIdx));
        const dotClass =
          state === "done"
            ? "bg-green-600 border-green-600"
            : state === "current"
            ? "bg-blue-600 border-blue-600"
            : state === "warn"
            ? "bg-amber-500 border-amber-500"
            : "bg-background border-border";
        // Connector lights up green up to AND INCLUDING the in-stage
        // (since that stage is now considered done under the new
        // convention). Connectors past the in-stage stay gray.
        const connectorClass =
          i <= currentIdx ? "bg-green-600" : "bg-border";
        const info = timestamps?.[stage];
        const ts = info?.ts ?? null;
        const extras = (info?.extra ?? []).filter(
          (s): s is string => typeof s === "string" && s.length > 0,
        );
        const stageLabel =
          PHYSICAL_LABELS[stage] ?? FINANCIAL_LABELS[stage] ?? stage;

        // Tooltip headline: state-aware. Body lines append timestamp + extras.
        const headline =
          state === "done"
            ? `${stageLabel} — completed`
            : state === "current"
            ? `${stageLabel} — in progress (next action)`
            : state === "warn"
            ? `${stageLabel} — needs attention`
            : `${stageLabel} — not yet reached`;
        const lines: string[] = [headline];
        if (ts) lines.push(new Date(ts).toLocaleString());
        for (const e of extras) lines.push(e);

        // aria-label collapses to a single string; tooltip renders multi-line.
        const ariaLabel = lines.join(". ");
        return (
          <div key={stage} className="flex items-center">
            <div className="relative flex flex-col items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={ariaLabel}
                    className={`w-3 h-3 rounded-full border-2 ${dotClass} cursor-help block`}
                  />
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} className="text-xs max-w-xs">
                  {/*
                    Tooltip surface is dark (primary bg + primary-foreground).
                    The default `text-muted-foreground` was rendering as dim
                    grey-on-blue and effectively unreadable. Use a translucent
                    primary-foreground for the secondary lines so they stay
                    distinguishable from the headline without losing contrast.
                  */}
                  <div className="font-medium">{lines[0]}</div>
                  {lines.slice(1).map((line, idx) => (
                    <div
                      key={idx}
                      className="text-primary-foreground/85"
                    >
                      {line}
                    </div>
                  ))}
                </TooltipContent>
              </Tooltip>
              <span className="text-[9px] text-muted-foreground mt-0.5 whitespace-nowrap">
                {stageLabel}
              </span>
            </div>
            {i < stages.length - 1 && (
              <div className={`w-6 h-0.5 ${connectorClass} -mt-3`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Pick the earliest po_status_history row whose toStatus matches one of
 * the candidate names. Returns the changedAt timestamp or null. Used to
 * fill in stage timestamps that don't have dedicated columns on
 * purchase_orders (e.g. in_transit, receiving, received).
 */
function firstHistoryAt(
  history: Array<{ toStatus?: string; changedAt?: string | null }>,
  candidates: string[],
): string | null {
  // history is conventionally newest-first from the API; iterate to find
  // the earliest matching entry by changedAt.
  let earliest: string | null = null;
  for (const h of history) {
    if (!h?.toStatus || !h.changedAt) continue;
    if (!candidates.includes(h.toStatus)) continue;
    if (earliest === null || new Date(h.changedAt) < new Date(earliest)) {
      earliest = h.changedAt;
    }
  }
  return earliest;
}

/** The two-row dual-track header card */
function DualTrackHeader({
  po,
  history = [],
}: {
  po: any;
  history?: Array<{ toStatus?: string; changedAt?: string | null }>;
}) {
  const isCancelled = po.physicalStatus === "cancelled" || po.physicalStatus === "short_closed";

  // physical summary text
  const totalOrderQty: number = (po.lines ?? []).reduce(
    (s: number, l: any) => s + (Number(l.orderQty) || 0),
    0,
  );
  const totalReceivedQty: number = (po.lines ?? []).reduce(
    (s: number, l: any) => s + (Number(l.receivedQty) || 0),
    0,
  );
  let physicalSummary: React.ReactNode;
  if (isCancelled) {
    physicalSummary = <span className="text-red-600 font-medium">Cancelled</span>;
  } else if (po.physicalStatus === "received") {
    physicalSummary = <span className="text-green-600 font-medium">All received</span>;
  } else {
    physicalSummary = (
      <>
        <strong>{totalReceivedQty.toLocaleString()}</strong> of{" "}
        <strong>{totalOrderQty.toLocaleString()}</strong> pcs received
      </>
    );
  }

  // financial summary text (integer math only — Rule #3)
  const paidCents = Number(po.paidTotalCents ?? 0);
  const invoicedCents = Number(po.invoicedTotalCents ?? 0);
  const outstandingCents = Number(po.outstandingCents ?? 0);
  let financialSummary: React.ReactNode;
  if (po.financialStatus === "unbilled") {
    financialSummary = <span className="text-muted-foreground">Unbilled</span>;
  } else if (po.financialStatus === "paid") {
    financialSummary = <span className="text-green-600 font-medium">Paid in full</span>;
  } else if (outstandingCents > 0 && po.firstInvoicedAt) {
    const daysSinceInvoice = Math.floor(
      (Date.now() - new Date(po.firstInvoicedAt).getTime()) / (1000 * 60 * 60 * 24),
    );
    const isPastDue = daysSinceInvoice > 30;
    financialSummary = (
      <>
        <strong>{formatCents(paidCents)}</strong> paid of{" "}
        <strong>{formatCents(invoicedCents)}</strong>
        {isPastDue && (
          <span className="ml-1 text-red-600 font-medium">· {formatCents(outstandingCents)} past due</span>
        )}
      </>
    );
  } else {
    financialSummary = (
      <>
        <strong>{formatCents(paidCents)}</strong> paid of{" "}
        <strong>{formatCents(invoicedCents)}</strong>
      </>
    );
  }

  // ── Per-stage tooltip data ─────────────────────────────────────────────
  //
  // Each stage gets a timestamp (when applicable) plus context lines that
  // make the tooltip actually useful. Stages without dedicated timestamp
  // columns derive theirs from po_status_history.
  //
  // Physical track stage → source mapping:
  //   draft         createdAt
  //   sent          sentToVendorAt
  //   acknowledged  vendorAckDate
  //   shipped       firstShippedAt
  //   in_transit    history fallback (toStatus = 'in_transit')
  //   arrived       firstArrivedAt
  //   receiving     history fallback (toStatus IN ('receiving', 'partially_received'))
  //   received      history fallback (toStatus = 'received')
  //
  // Financial track stage → source mapping:
  //   unbilled      createdAt + 'no invoice yet' note when current
  //   invoiced      firstInvoicedAt + 'invoiced \$X' line
  //   partially_paid firstPaidAt + 'paid \$Y of \$Z' line
  //   paid          fullyPaidAt + 'paid in full' line

  const inTransitAt = firstHistoryAt(history, ["in_transit"]);
  const receivingAt = firstHistoryAt(history, ["receiving", "partially_received"]);
  const receivedAt = firstHistoryAt(history, ["received"]);

  // ── Cancellation audit ───────────────────────────────────────────────
  //
  // When a PO is cancelled mid-lifecycle, every track dot needs to make
  // clear that the lifecycle stopped — otherwise the user can't tell
  // whether stages past the cancellation point were ever reached.
  // We compute, per stage, whether it was reached BEFORE the cancellation
  // by checking the corresponding stage timestamp.
  // The History tab is the canonical audit trail; this is the at-a-glance
  // augment.
  const cancelledAt: string | null = po.cancelledAt ?? null;
  const cancelReason: string | null = po.cancelReason ?? null;
  const relatedUsers: Record<string, { username: string; displayName: string | null }> | undefined = (po as any).relatedUsers;
  const cancelledByFormatted = formatActor((po as any).cancelledBy, relatedUsers);
  const cancelExtras = (stageReachedAt: string | null | undefined): string[] => {
    if (!isCancelled || !cancelledAt) return [];
    const reached = !!stageReachedAt && new Date(stageReachedAt) <= new Date(cancelledAt);
    const cancelledByPart = (po as any).cancelledBy ? ` by ${cancelledByFormatted}` : "";
    if (reached) {
      return [
        `✅ Reached before cancellation (cancelled ${new Date(cancelledAt).toLocaleString()}${cancelledByPart})`,
        cancelReason ? `Reason: ${cancelReason}` : "",
      ];
    }
    return [
      `⛔ Not reached — PO cancelled ${new Date(cancelledAt).toLocaleString()}${cancelledByPart}`,
      cancelReason ? `Reason: ${cancelReason}` : "",
    ];
  };

  const physTimestamps: Record<string, StageTooltipInfo | undefined> = {
    draft: {
      ts: po.createdAt,
      extra: [
        po.createdBy ? `Created by ${formatActor(po.createdBy, relatedUsers)}` : null,
        ...cancelExtras(po.createdAt),
      ],
    },
    sent: {
      ts: po.sentToVendorAt,
      extra: [
        po.vendor?.name ? `Sent to ${po.vendor.name}` : null,
        ...cancelExtras(po.sentToVendorAt),
      ],
    },
    acknowledged: {
      ts: po.vendorAckDate,
      extra: [
        "Vendor confirmed receipt of PO",
        ...cancelExtras(po.vendorAckDate),
      ],
    },
    shipped: {
      ts: po.firstShippedAt,
      extra: ["Goods left vendor", ...cancelExtras(po.firstShippedAt)],
    },
    in_transit: {
      ts: inTransitAt,
      extra: ["Goods en route", ...cancelExtras(inTransitAt)],
    },
    arrived: {
      ts: po.firstArrivedAt,
      extra: ["Goods at our dock", ...cancelExtras(po.firstArrivedAt)],
    },
    receiving: {
      ts: receivingAt,
      extra: [
        totalOrderQty > 0
          ? `${totalReceivedQty.toLocaleString()} of ${totalOrderQty.toLocaleString()} pcs received so far`
          : null,
        ...cancelExtras(receivingAt),
      ],
    },
    received: {
      ts: receivedAt,
      extra: [
        totalOrderQty > 0
          ? `${totalReceivedQty.toLocaleString()} of ${totalOrderQty.toLocaleString()} pcs received`
          : null,
        ...cancelExtras(receivedAt),
      ],
    },
  };

  const finTimestamps: Record<string, StageTooltipInfo | undefined> = {
    unbilled: {
      // No timestamp — 'unbilled' is the starting state, not an event.
      extra: ["No invoice received yet"],
    },
    invoiced: {
      ts: po.firstInvoicedAt,
      extra: [
        invoicedCents > 0 ? `Invoiced: ${formatCents(invoicedCents)}` : null,
        ...cancelExtras(po.firstInvoicedAt),
      ],
    },
    partially_paid: {
      ts: po.firstPaidAt,
      extra: [
        invoicedCents > 0
          ? `${formatCents(paidCents)} paid of ${formatCents(invoicedCents)}`
          : null,
        outstandingCents > 0
          ? `${formatCents(outstandingCents)} outstanding`
          : null,
        ...cancelExtras(po.firstPaidAt),
      ],
    },
    paid: {
      ts: po.fullyPaidAt,
      extra: [
        invoicedCents > 0
          ? `${formatCents(paidCents)} paid in full`
          : null,
        ...cancelExtras(po.fullyPaidAt),
      ],
    },
  };

  const finWarn = po.financialStatus === "disputed" ||
    (outstandingCents > 0 &&
      po.firstInvoicedAt != null &&
      Date.now() - new Date(po.firstInvoicedAt).getTime() > 30 * 24 * 60 * 60 * 1000);

  return (
    // TooltipProvider needs to wrap the tooltip triggers below. delayDuration
    // tightened from default 700ms so hover feedback is responsive.
    <TooltipProvider delayDuration={150} skipDelayDuration={50}>
      <div className="rounded-lg border bg-card p-4 space-y-3">
        {/* Physical track */}
        <div className="flex items-start gap-4">
          <span className="w-20 shrink-0 text-xs font-semibold text-muted-foreground uppercase tracking-wide mt-1">
            Physical
          </span>
          <div className="flex-1 overflow-x-auto">
            <TrackTimeline
              stages={PHYSICAL_TRACK_STAGES}
              currentStatus={po.physicalStatus ?? "draft"}
              timestamps={physTimestamps}
            />
          </div>
          <div className="text-xs text-right shrink-0 ml-4 mt-0.5">{physicalSummary}</div>
        </div>

        {/* Financial track */}
        <div className="flex items-start gap-4">
          <span className="w-20 shrink-0 text-xs font-semibold text-muted-foreground uppercase tracking-wide mt-1">
            Financial
          </span>
          <div className="flex-1 overflow-x-auto">
            <TrackTimeline
              stages={FINANCIAL_TRACK_STAGES}
              currentStatus={po.financialStatus ?? "unbilled"}
              isWarn={finWarn}
              timestamps={finTimestamps}
            />
          </div>
          <div className="text-xs text-right shrink-0 ml-4 mt-0.5">{financialSummary}</div>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── Incoterms ─────────────────────────────────────────────────────

// Incoterms → which vendor-side charges are applicable
const INCOTERMS_LIST = ["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;
const INCOTERMS_CHARGES: Record<string, { shipping: boolean; tax: boolean }> = {
  EXW: { shipping: false, tax: false },
  FCA: { shipping: false, tax: false },
  FOB: { shipping: false, tax: false },
  CFR: { shipping: true,  tax: false },
  CIF: { shipping: true,  tax: false },
  CPT: { shipping: true,  tax: false },
  CIP: { shipping: true,  tax: false },
  DAP: { shipping: true,  tax: false },
  DPU: { shipping: true,  tax: false },
  DDP: { shipping: true,  tax: true  },
};

const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }> = {
  draft: { variant: "secondary", label: "Draft" },
  pending_approval: { variant: "outline", label: "Pending Approval", color: "text-amber-600 border-amber-300" },
  approved: { variant: "default", label: "Approved" },
  sent: { variant: "default", label: "Sent", color: "bg-blue-500" },
  acknowledged: { variant: "default", label: "Acknowledged", color: "bg-indigo-500" },
  partially_received: { variant: "outline", label: "Partial Receipt", color: "text-orange-600 border-orange-300" },
  received: { variant: "default", label: "Received", color: "bg-green-600" },
  closed: { variant: "secondary", label: "Closed" },
  cancelled: { variant: "destructive", label: "Cancelled" },
};

// ── ExceptionCard ────────────────────────────────────────────────────
// One open or acknowledged exception. Severity drives the left border
// color; status drives which actions render. Resolve and dismiss prompt
// for a free-text note via window.prompt for now (small enough surface
// that a full dialog isn't worth the weight).
function ExceptionCard({
  ex,
  onAcknowledge,
  onResolve,
  onDismiss,
  busy,
  relatedUsers,
}: {
  ex: any;
  onAcknowledge: () => void;
  onResolve: (note: string) => void;
  onDismiss: (note: string) => void;
  busy: boolean;
  relatedUsers?: Record<string, { username: string; displayName: string | null }>;
}) {
  const severity = (ex.severity ?? "warn") as "info" | "warn" | "error";
  const borderClass =
    severity === "error"
      ? "border-l-4 border-l-red-600"
      : severity === "info"
      ? "border-l-4 border-l-blue-600"
      : "border-l-4 border-l-amber-500";
  const iconColor =
    severity === "error"
      ? "text-red-600"
      : severity === "info"
      ? "text-blue-600"
      : "text-amber-600";
  const detectedLabel = (() => {
    if (!ex.detectedAt) return null;
    const dt = new Date(ex.detectedAt);
    return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  })();
  const handleResolve = () => {
    const note = window.prompt(
      "Resolution note (required) — what fixed this exception?",
      "",
    );
    if (note === null) return; // user cancelled
    if (!note.trim()) {
      window.alert("A resolution note is required.");
      return;
    }
    onResolve(note.trim());
  };
  const handleDismiss = () => {
    const note = window.prompt(
      "Optional reason for dismissing (e.g. 'false alarm', 'duplicate'):",
      "",
    );
    if (note === null) return; // user cancelled
    onDismiss(note.trim());
  };
  return (
    <Card className={borderClass}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <span className={`text-xl leading-none ${iconColor}`} aria-hidden>
            ⚠
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">{ex.title}</h3>
              <Badge
                variant="outline"
                className="text-[10px] uppercase"
              >
                {ex.status === "acknowledged" ? "acknowledged" : "open"}
              </Badge>
            </div>
            {detectedLabel && (
              <div className="text-xs text-muted-foreground mt-0.5">
                Detected {detectedLabel}
                {ex.detectedBy ? ` by ${formatActor(ex.detectedBy, relatedUsers)}` : ""}
              </div>
            )}
            {ex.message && (
              <p className="text-sm mt-2">{ex.message}</p>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              {ex.status === "open" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onAcknowledge}
                  disabled={busy}
                >
                  Acknowledge
                </Button>
              )}
              <Button
                size="sm"
                onClick={handleResolve}
                disabled={busy}
                data-testid={`resolve-exception-${ex.id}`}
              >
                Mark resolved
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDismiss}
                disabled={busy}
                className="text-muted-foreground"
              >
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Convert a dollar string to cents without floating-point artifacts */

/**
 * Resolve an actor ID (user UUID, 'system', 'cron:*', 'agent:*') to a
 * human-readable name using the relatedUsers map returned by the PO detail
 * endpoint.
 *
 * Resolution order:
 *   1. displayName when present
 *   2. username
 *   3. 'user:<first-7-chars-of-UUID>' as fallback for unknown IDs
 *   4. Prefixed strings ('system', 'cron:*', 'agent:*') pass through unchanged
 *   5. empty / undefined → '—'
 */
function formatActor(
  actorId: string | null | undefined,
  relatedUsers: Record<string, { username: string; displayName: string | null }> | undefined,
): string {
  if (!actorId) return "—";
  // Prefixed non-UUID actor strings pass through unchanged
  if (/^(system|cron:|agent:)/.test(actorId)) return actorId;
  const user = relatedUsers?.[actorId];
  if (user) {
    return user.displayName || user.username;
  }
  // Unknown UUID: show short form for readability
  return `user:${actorId.slice(0, 7)}`;
}

function formatCents(cents: number | null | undefined, opts?: { unitCost?: boolean }): string {
  if (!cents && cents !== 0) return "$0.00";
  const n = Number(cents) / 100;
  if (opts?.unitCost && n > 0 && n !== parseFloat(n.toFixed(2))) {
    // Sub-cent precision: show up to 4 decimal places
    return `$${n.toFixed(4).replace(/0+$/, "")}`;
  }
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Format per-unit cost at 4 decimals. Prefers unit_cost_mills when the line
// carries it; falls back to centsToMills for legacy NULL-mills rows so the
// display always shows exactly 4 decimals per spec.
function formatLineUnitCost(line: {
  unitCostMills?: number | null;
  unitCostCents?: number | null;
}): string {
  const mills =
    line.unitCostMills != null
      ? Number(line.unitCostMills)
      : centsToMills(Number(line.unitCostCents ?? 0));
  return formatMills(mills);
}

function formatStoredLineQuote(line: {
  pricingBasis?: string | null;
  purchaseUom?: string | null;
  quotedUnitCostMills?: number | null;
  quotedTotalCents?: number | null;
}): string {
  if (
    line.pricingBasis === "per_piece" &&
    line.quotedUnitCostMills != null
  ) {
    return `${formatMills(Number(line.quotedUnitCostMills))} per piece`;
  }
  if (
    line.pricingBasis === "per_purchase_uom" &&
    line.quotedUnitCostMills != null
  ) {
    return `${formatMills(Number(line.quotedUnitCostMills))} per ${line.purchaseUom || "purchase UOM"}`;
  }
  if (
    line.pricingBasis === "extended_total" &&
    line.quotedTotalCents != null
  ) {
    return `${formatCents(Number(line.quotedTotalCents))} quoted total`;
  }
  if (
    line.pricingBasis === "per_piece" ||
    line.pricingBasis === "per_purchase_uom" ||
    line.pricingBasis === "extended_total"
  ) {
    return "Stored quote is incomplete";
  }
  return "Legacy price; quote basis unverified";
}

function createEmptyNewLine() {
  return {
    productId: 0,
    productVariantId: 0,
    expectedReceiveVariantId: 0,
    expectedReceiveUnitsPerVariant: 1,
    orderQty: 1,
    unitCostCents: 0,
    unitsPerUom: 1,
    vendorSku: "",
    description: "",
  };
}

function genPoLineIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return `po-line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function dateInputValue(value: unknown): string {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function displayScheduleDate(value: unknown): string {
  const input = dateInputValue(value);
  if (!input) return "Not set";
  const [year, month, day] = input.split("-").map(Number);
  return format(new Date(year, month - 1, day), "MMM d, yyyy");
}

export default function PurchaseOrderDetail() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const searchStr = useSearch();
  const [, params] = useRoute("/purchase-orders/:id");
  const poId = params?.id ? Number(params.id) : null;

  const [activeTab, setActiveTab] = useState("lines");
  const [showAddLineDialog, setShowAddLineDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showAckDialog, setShowAckDialog] = useState(false);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [showDocDialog, setShowDocDialog] = useState(false);
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  const [showCreateInvoiceDialog, setShowCreateInvoiceDialog] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState({ invoiceNumber: "", amountDollars: "", invoiceDate: "", dueDate: "", notes: "" });
  const [docHtml, setDocHtml] = useState<string | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [emailForm, setEmailForm] = useState({ toEmail: "", ccEmail: "", message: "" });
  const [emailSending, setEmailSending] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [ackData, setAckData] = useState({ vendorRefNumber: "", confirmedDeliveryDate: "" });
  const [scheduleData, setScheduleData] = useState({
    expectedDeliveryDate: "",
    confirmedDeliveryDate: "",
    notes: "",
  });
  const [showCreateShipmentDialog, setShowCreateShipmentDialog] = useState(false);
  const [showReceivePicker, setShowReceivePicker] = useState(false);
  const [shipmentReceiptPackResolution, setShipmentReceiptPackResolution] = useState<ShipmentReceiptPackResolution | null>(null);
  const [pendingShipmentReceipt, setPendingShipmentReceipt] = useState<{ shipmentId: number; purchaseOrderId: number } | null>(null);
  const [checkingShipmentReceiptPacks, setCheckingShipmentReceiptPacks] = useState(false);
  const resumeShipmentReceiptHandled = React.useRef<string | null>(null);
  const [newShipmentForm, setNewShipmentForm] = useState({
    mode: "sea_fcl",
    shipmentNumber: "",
    shipperName: "",
    forwarderName: "",
    carrierName: "",
  });
  const [shipperOpen, setShipperOpen] = useState(false);
  const [shipperSearch, setShipperSearch] = useState("");

  // Shippable lines state for Create Shipment dialog
  // Map of poLineId → { checked, qty }. qty = 0 means unchecked.
  const [lineSelections, setLineSelections] = useState<Record<number, { checked: boolean; qty: number }>>({});
  const [lineQtyErrors, setLineQtyErrors] = useState<Record<number, string>>({});

  const { data: shippableLinesData } = useQuery<{ lines: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/shippable-lines`],
    enabled: !!poId && showCreateShipmentDialog,
  });

  // Initialize line selections when shippable lines load
  useEffect(() => {
    if (shippableLinesData?.lines && showCreateShipmentDialog) {
      const selections: Record<number, { checked: boolean; qty: number }> = {};
      for (const line of shippableLinesData.lines) {
        if (!(line.id in lineSelections)) {
          selections[line.id] = { checked: true, qty: line.remainingQty };
        }
      }
      if (Object.keys(selections).length > 0) {
        setLineSelections(prev => ({ ...prev, ...selections }));
      }
    }
  }, [shippableLinesData, showCreateShipmentDialog]);

  // Fetch vendors for shipper dropdown
  type Vendor = { id: number; name: string; code: string };
  const { data: vendors = [], isLoading: vendorsLoading, isError: vendorsError, refetch: refetchVendors } = useQuery<Vendor[]>({
    queryKey: ["/api/vendors"],
  });

  // Inline charge editing state
  const [editingIncoterms, setEditingIncoterms] = useState(false);
  const [incotermsEdit, setIncotermsEdit] = useState("");
  const [editingDiscount, setEditingDiscount] = useState(false);
  const [discountDollars, setDiscountDollars] = useState("");
  const [editingShipping, setEditingShipping] = useState(false);
  const [shippingDollars, setShippingDollars] = useState("");
  const [editingTax, setEditingTax] = useState(false);
  const [taxDollars, setTaxDollars] = useState("");
  const [editingTolerance, setEditingTolerance] = useState(false);
  const [toleranceVal, setToleranceVal] = useState("");

  // Inline line editing state
  const [editingLineId, setEditingLineId] = useState<number | null>(null);
  const [editingLineField, setEditingLineField] = useState<"sku" | null>(null);
  const [skuVariants, setSkuVariants] = useState<Array<{ id: number; sku: string; name: string; unitsPerVariant: number }>>([]);
  const [editingPricingLine, setEditingPricingLine] = useState<any | null>(null);
  const [editLinePricing, setEditLinePricing] = useState<PoLinePricingEditorDraft>(
    createEmptyPoLinePricingDraft,
  );
  const [editLineQuoteMetadata, setEditLineQuoteMetadata] = useState<PoLineQuoteMetadataDraft>(
    createEmptyPoLineQuoteMetadataDraft,
  );
  const [originalEditLineQuoteMetadata, setOriginalEditLineQuoteMetadata] = useState<PoLineQuoteMetadataDraft>(
    createEmptyPoLineQuoteMetadataDraft,
  );
  const [editRequiresLegacyConfirmation, setEditRequiresLegacyConfirmation] = useState(false);
  const [legacyPricingConfirmed, setLegacyPricingConfirmed] = useState(false);

  // Add line form
  const [productSearch, setProductSearch] = useState("");
  const [productOpen, setProductOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const [selectedProductForLine, setSelectedProductForLine] = useState<any>(null);
  const [linePricing, setLinePricing] = useState<PoLinePricingEditorDraft>(
    createEmptyPoLinePricingDraft,
  );
  const [lineQuoteMetadata, setLineQuoteMetadata] = useState<PoLineQuoteMetadataDraft>(
    createEmptyPoLineQuoteMetadataDraft,
  );
  const [saveToVendorCatalog, setSaveToVendorCatalog] = useState(true);
  const [setAsPreferred, setSetAsPreferred] = useState(false);
  const [addLineMode, setAddLineMode] = useState<"catalog" | "search">("catalog");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [selectedCatalogEntry, setSelectedCatalogEntry] = useState<any>(null);
  const [catalogPricingUntouched, setCatalogPricingUntouched] = useState(false);

  // Inline Record Payment dialog (replaces navigate-to-/ap-payments flow)
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [payment, setPayment] = useState({
    paymentDate: format(new Date(), "yyyy-MM-dd"),
    paymentMethod: "ach",
    referenceNumber: "",
    checkNumber: "",
    bankAccountLabel: "",
    amountDollars: "",   // pre-filled when dialog opens from first unpaid invoice
    notes: "",
    invoiceId: null as number | null,  // which invoice this payment allocates to
  });

  const [newLine, setNewLine] = useState(createEmptyNewLine);

  // Queries
  const { data: po, isLoading } = useQuery<any>({
    queryKey: [`/api/purchase-orders/${poId}`],
    enabled: !!poId,
  });
  const immutableRecommendationPo = isImmutableRecommendationPurchaseOrder(po);
  const lifecycle = (po as any)?.lifecycle as PoLifecycleSummary | undefined;
  const autoDraftActionPlan = (po as any)?.autoDraftActionPlan as AutoDraftActionPlan | null | undefined;
  const lifecycleActionIds = new Set(
    (lifecycle?.nextActions ?? []).map((action) => action.id),
  );
  const canLifecycleAction = (id: PoLifecycleActionId, fallback: boolean) =>
    lifecycle ? lifecycleActionIds.has(id) : fallback;

  // PO detail endpoint resolves all referenced actor UUIDs (createdBy,
  // cancelledBy, history.changedBy, exception.detectedBy/...) into a single
  // map with displayName + username. Used by formatActor() everywhere actor
  // strings appear in this component (cancellation banner, history rows,
  // exception cards, etc.) so users see human names instead of raw UUIDs.
  const relatedUsers: Record<string, { username: string; displayName: string | null }> | undefined =
    (po as any)?.relatedUsers;
  const cancelledByFormatted = formatActor((po as any)?.cancelledBy, relatedUsers);

  // Feature-flag redirect: when the new PO editor is enabled, land-on-draft
  // via direct URL should hop over to the new inline editor. Keeps this
  // page as the home for non-draft POs (receipts/invoices/shipments/history
  // tabs still live here).
  const { data: procurementSettings } = useQuery<{ useNewPoEditor?: boolean }>({
    queryKey: ["/api/settings/procurement"],
    staleTime: 60_000,
  });
  useEffect(() => {
    if (
      procurementSettings?.useNewPoEditor === true &&
      po?.id &&
      po?.status === "draft" &&
      !immutableRecommendationPo
    ) {
      navigate(`/purchase-orders/${po.id}/edit`, { replace: true });
    }
  }, [procurementSettings?.useNewPoEditor, po?.id, po?.status, immutableRecommendationPo, navigate]);

  const { data: historyData } = useQuery<{ history: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/history`],
    enabled: !!poId && activeTab === "history",
  });

  const { data: receiptsData } = useQuery<{ receipts: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/receipts`],
    enabled: !!poId && activeTab === "receipts",
  });

  const { data: products = [] } = useQuery<any[]>({
    queryKey: ["/api/products"],
    enabled: showAddLineDialog,
  });

  const { data: vendorCatalog = [], isLoading: catalogLoading } = useQuery<any[]>({
    queryKey: [`/api/vendor-products`, po?.vendorId],
    queryFn: async () => {
      if (!po?.vendorId) return [];
      const res = await fetch(`/api/vendor-products?vendorId=${po.vendorId}&isActive=1`);
      const data = await res.json();
      return Array.isArray(data) ? data : (data.vendorProducts ?? []);
    },
    enabled: showAddLineDialog && !!po?.vendorId,
  });

  const { data: linkedShipmentsRaw = [] } = useQuery<any[]>({
    queryKey: [`/api/purchase-orders/${poId}/shipments`],
    enabled: !!poId && activeTab === "shipments",
  });
  const linkedShipments = linkedShipmentsRaw.filter((s: any) => s.status !== "cancelled");

  const { data: receiveOptions, isLoading: receiveOptionsLoading } = useQuery<any>({
    queryKey: [`/api/purchase-orders/${poId}/receive-options`],
    enabled: !!poId && showReceivePicker,
  });

  // Eagerly fetched (not tab-gated) so the side-rail Record Payment button
  // can pre-populate the invoice dropdown without requiring the invoices tab
  // to have been visited first.
  const { data: invoicesData } = useQuery<{ invoices: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/invoices`],
    enabled: !!poId,
  });

  // Phase 2: payments tab
  const { data: paymentsData } = useQuery<{ payments: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/payments`],
    enabled: !!poId && activeTab === "payments",
  });

  // Exceptions — fetched on detail-page load (lightweight; the count drives
  // the header pill + tab counter regardless of which tab is active).
  // includeResolved param flips when user expands the resolved section so
  // we don't pull every closed exception on initial load.
  const [showResolvedExceptions, setShowResolvedExceptions] = useState(false);
  const { data: exceptionsData, refetch: refetchExceptions } = useQuery<{ exceptions: any[] }>({
    queryKey: [`/api/purchase-orders/${poId}/exceptions`, showResolvedExceptions],
    queryFn: async () => {
      const url = showResolvedExceptions
        ? `/api/purchase-orders/${poId}/exceptions?includeResolved=true`
        : `/api/purchase-orders/${poId}/exceptions`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load exceptions");
      return res.json();
    },
    enabled: !!poId,
  });
  const allExceptions = exceptionsData?.exceptions ?? [];
  const openExceptions = allExceptions.filter((e: any) =>
    ["open", "acknowledged"].includes(e.status),
  );
  const closedExceptions = allExceptions.filter((e: any) =>
    ["resolved", "dismissed"].includes(e.status),
  );
  const openExceptionCount = openExceptions.length;
  const maxOpenSeverity = openExceptions.reduce<
    "info" | "warn" | "error" | null
  >((acc, e) => {
    const order: Record<string, number> = { info: 1, warn: 2, error: 3 };
    if (!acc) return e.severity;
    return order[e.severity] > order[acc] ? e.severity : acc;
  }, null);

  const lines = po?.lines ?? [];
  const history = historyData?.history ?? [];
  const receipts = receiptsData?.receipts ?? [];
  const isDraft = po?.status === "draft";
  // Economics and receiving identity are mutable only while the PO is a draft.
  // Post-draft corrections belong in the audited amendment workflow.
  const canEditLines = Boolean(isDraft && !immutableRecommendationPo);
  const canEditLine = (line: any) => canEditLines &&
    (line.lineType ?? "product") === "product" &&
    (line.status ?? "open") === "open" &&
    [line.receivedQty, line.damagedQty, line.returnedQty, line.cancelledQty]
      .every((quantity) => Number(quantity ?? 0) === 0);
  const isNotCancelled = po && !["cancelled"].includes(po.status);
  const canEditHeader = Boolean(isNotCancelled && !immutableRecommendationPo);
  const canSubmitPo = canLifecycleAction("submit", po?.status === "draft");
  const canReturnPoToDraft = canLifecycleAction("return_to_draft", po?.status === "pending_approval");
  const canApprovePo = canLifecycleAction("approve", po?.status === "pending_approval");
  const canSendPo = canLifecycleAction("send", po?.status === "approved");
  const canSendPoToVendor = canLifecycleAction(
    "send_to_vendor",
    po?.status === "draft" || po?.status === "approved",
  );
  const canAcknowledgePo = canLifecycleAction("acknowledge", po?.physicalStatus === "sent");
  const canMarkPoShipped = canLifecycleAction("mark_shipped", po?.physicalStatus === "acknowledged");
  const canMarkPoInTransit = canLifecycleAction("mark_in_transit", po?.physicalStatus === "shipped");
  const canMarkPoArrived = canLifecycleAction(
    "mark_arrived",
    po?.physicalStatus === "in_transit" || po?.physicalStatus === "shipped",
  );
  const canCreateReceiptForPo = canLifecycleAction(
    "create_receipt",
    ["sent", "acknowledged", "partially_received"].includes(po?.status),
  );
  const canCancelPo = canLifecycleAction(
    "cancel",
    po ? !["closed", "cancelled"].includes(po.status) : false,
  );
  const canClosePo = canLifecycleAction("close", po?.status === "received");
  const scheduleStatus = po?.physicalStatus ?? po?.status;
  const canEditSchedule = Boolean(
    po && !["received", "closed", "cancelled", "short_closed"].includes(scheduleStatus),
  );
  const canSetConfirmedDelivery = Boolean(
    po && !["draft", "pending_approval", "approved"].includes(scheduleStatus),
  );
  const scheduleMinimumDate = dateInputValue(po?.sentToVendorAt ?? po?.orderDate ?? po?.createdAt);

  const openScheduleEditor = () => {
    setScheduleData({
      expectedDeliveryDate: dateInputValue(po?.expectedDeliveryDate),
      confirmedDeliveryDate: dateInputValue(po?.confirmedDeliveryDate),
      notes: "",
    });
    setShowScheduleDialog(true);
  };

  // Incoterms-driven charge applicability: if no terms set, all are editable
  const poIncoterms = po?.incoterms as string | null | undefined;
  const chargeRules = poIncoterms ? INCOTERMS_CHARGES[poIncoterms] : null;
  const shippingApplicable = !chargeRules || chargeRules.shipping;
  const taxApplicable = !chargeRules || chargeRules.tax;

  // Filtered products for typeahead
  const filteredProducts = products
    .filter((p: any) =>
      !productSearch ||
      p.name?.toLowerCase().includes(productSearch.toLowerCase()) ||
      p.sku?.toLowerCase().includes(productSearch.toLowerCase())
    )
    .slice(0, 50);

  // Selected receive configuration for the piece-to-config helper.
  const selectedReceiveVariantId = newLine.expectedReceiveVariantId || newLine.productVariantId;
  const selectedVariant = selectedProductForLine?.variants?.find(
    (v: any) => v.id === selectedReceiveVariantId
  );
  const receiveUnitsPerVariant =
    newLine.expectedReceiveUnitsPerVariant || newLine.unitsPerUom || 1;
  const linePricingEvaluation = evaluatePoLinePricingDraft(linePricing);
  const editLinePricingEvaluation = evaluatePoLinePricingDraft(editLinePricing);
  const lineQuoteMetadataEvaluation = evaluatePoLineQuoteMetadataDraft(lineQuoteMetadata);
  const editLineQuoteMetadataEvaluation = evaluatePoLineQuoteMetadataDraft(editLineQuoteMetadata);
  const catalogQuoteDateMissing = reusableCatalogQuoteDateMissing(
    saveToVendorCatalog,
    linePricing.basis,
    lineQuoteMetadataEvaluation.metadata,
  );

  // Mutations
  function createTransitionMutation(endpoint: string, method = "POST") {
    return useMutation<any, Error, void>({
      mutationFn: async () => {
        const res = await fetch(`/api/purchase-orders/${poId}/${endpoint}`, {
          method,
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `Failed to ${endpoint}`);
        }
        return res.json();
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
        queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
        toast({ title: "Success", description: `PO ${endpoint.replace(/-/g, " ")} completed` });
      },
      onError: (err: Error) => {
        toast({ title: "Error", description: err.message, variant: "destructive" });
      },
    });
  }

  const submitMutation = createTransitionMutation("submit");
  const returnToDraftMutation = createTransitionMutation("return-to-draft");
  const approveMutation = createTransitionMutation("approve");
  const sendMutation = createTransitionMutation("send");
  const closeMutation = createTransitionMutation("close");

  // Check if solo mode (no approval tiers) for combined "Send to Vendor" button
  const { data: approvalTiersData } = useQuery<{ tiers: any[] }>({
    queryKey: ["/api/purchasing/approval-tiers"],
  });
  const isSoloMode = (approvalTiersData?.tiers?.length ?? 0) === 0;

  // Check setting for vendor acknowledgment requirement
  const { data: settingsData } = useQuery<Record<string, string | null>>({
    queryKey: ["/api/settings"],
    select: (data: any) => data,
  });
  const requireAcknowledgment = settingsData?.requireVendorAcknowledgment === "true";

  // ── Exception lifecycle mutations ──────────────────────────────
  const ackExceptionMutation = useMutation({
    mutationFn: async (exceptionId: number) => {
      const res = await fetch(`/api/po-exceptions/${exceptionId}/acknowledge`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Acknowledge failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      refetchExceptions();
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "Exception acknowledged" });
    },
    onError: (e: Error) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const resolveExceptionMutation = useMutation({
    mutationFn: async ({ id, resolutionNote }: { id: number; resolutionNote: string }) => {
      const res = await fetch(`/api/po-exceptions/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolutionNote }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Resolve failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      refetchExceptions();
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "Exception resolved" });
    },
    onError: (e: Error) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const dismissExceptionMutation = useMutation({
    mutationFn: async ({ id, note }: { id: number; note?: string }) => {
      const res = await fetch(`/api/po-exceptions/${id}/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note || "" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Dismiss failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      refetchExceptions();
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "Exception dismissed" });
    },
    onError: (e: Error) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const sendToVendorMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/send-to-vendor`, { method: "POST" });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to send to vendor"); }
      return res.json();
    },
    onSuccess: (updatedPo) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      toast({ title: "PO sent to vendor", description: `${updatedPo.poNumber} is now marked as sent` });
      // Open email dialog with vendor email pre-filled
      setEmailForm(f => ({ ...f, toEmail: updatedPo.vendor?.email || po?.vendor?.email || po?.vendorContactEmail || "" }));
      // Fetch doc HTML for the email
      fetch(`/api/purchase-orders/${poId}/document`).then(r => r.json()).then(data => {
        setDocHtml(data.html);
      }).catch(() => {});
      setShowEmailDialog(true);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createReceiptMutation = useMutation({
    mutationFn: async () => {
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `po-receipt-${poId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch(`/api/purchase-orders/${poId}/create-receipt`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create receipt"); }
      return res.json();
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receipts`] });
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created` });
      // Navigate to the receiving page with this receipt
      navigate(`/receiving?open=${receipt.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Receive AGAINST a shipment: links the receipt to the shipment so its freight
  // attaches to exactly these lots (vs createReceiptMutation, which is PO-direct).
  const createReceiptFromShipmentMutation = useMutation({
    mutationFn: async ({ shipmentId, purchaseOrderId }: { shipmentId: number; purchaseOrderId: number }) => {
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `shp-receipt-${shipmentId}-${purchaseOrderId}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch(`/api/inbound-shipments/${shipmentId}/create-receipt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ purchaseOrderId }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create receipt"); }
      return res.json();
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receipts`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receive-options`] });
      queryClient.invalidateQueries({ queryKey: ["/api/receiving"] });
      setShowReceivePicker(false);
      setShipmentReceiptPackResolution(null);
      setPendingShipmentReceipt(null);
      toast({ title: "Receipt created", description: `Receipt ${receipt.receiptNumber} created from shipment` });
      navigate(`/receiving?open=${receipt.id}`);
    },
    onError: async (err: Error, variables) => {
      const openedBlocker = await openShipmentReceiptPackBlocker(variables);
      if (openedBlocker) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const cleanupEmptyShipmentReceiptMutation = useMutation({
    mutationFn: async ({
      receiptId,
    }: {
      receiptId: number;
      shipmentId: number;
      purchaseOrderId: number;
    }) => {
      const res = await fetch(`/api/receiving-orders/${receiptId}/discard`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Failed to clean up empty receipt");
      return body;
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receipts`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receive-options`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/receiving"] }),
      ]);
      toast({
        title: "Empty receipt cleaned up",
        description: "Rechecking this shipment before creating a new receipt.",
      });
      checkAndReceiveShipment({
        shipmentId: variables.shipmentId,
        purchaseOrderId: variables.purchaseOrderId,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const voidZeroPostShipmentReceiptMutation = useMutation({
    mutationFn: async ({
      receiptId,
    }: {
      receiptId: number;
      shipmentId: number;
      purchaseOrderId: number;
    }) => {
      const res = await fetch(`/api/receiving-orders/${receiptId}/void-zero-post`, {
        method: "POST",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || "Failed to void zero-post receipt");
      return body;
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receipts`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/receive-options`] }),
        queryClient.invalidateQueries({ queryKey: ["/api/receiving"] }),
      ]);
      toast({
        title: "Zero-post receipt voided",
        description: "Rechecking this shipment before creating a new receipt.",
      });
      checkAndReceiveShipment({
        shipmentId: variables.shipmentId,
        purchaseOrderId: variables.purchaseOrderId,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  async function fetchShipmentReceiptPackResolution(params: { shipmentId: number; purchaseOrderId: number }) {
    const query = new URLSearchParams({ purchaseOrderId: String(params.purchaseOrderId) });
    const res = await fetch(`/api/inbound-shipments/${params.shipmentId}/receipt-pack-resolution?${query.toString()}`);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || "Failed to check shipment receipt packs");
    return body as ShipmentReceiptPackResolution;
  }

  async function openShipmentReceiptPackBlocker(params: { shipmentId: number; purchaseOrderId: number } | undefined | null): Promise<boolean> {
    if (!params) return false;
    setCheckingShipmentReceiptPacks(true);
    setPendingShipmentReceipt(params);
    try {
      const resolution = await fetchShipmentReceiptPackResolution(params);
      if (!resolution.canCreateReceipt) {
        setShipmentReceiptPackResolution(resolution);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setCheckingShipmentReceiptPacks(false);
    }
  }

  async function checkAndReceiveShipment(params: { shipmentId: number; purchaseOrderId: number }) {
    setCheckingShipmentReceiptPacks(true);
    setPendingShipmentReceipt(params);
    try {
      const resolution = await fetchShipmentReceiptPackResolution(params);
      if (!resolution.canCreateReceipt) {
        setShipmentReceiptPackResolution(resolution);
        return;
      }
      setShipmentReceiptPackResolution(null);
      createReceiptFromShipmentMutation.mutate(params);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setCheckingShipmentReceiptPacks(false);
    }
  }

  async function refreshShipmentReceiptPackResolution() {
    if (!pendingShipmentReceipt) return;
    setCheckingShipmentReceiptPacks(true);
    try {
      const resolution = await fetchShipmentReceiptPackResolution(pendingShipmentReceipt);
      setShipmentReceiptPackResolution(resolution);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setCheckingShipmentReceiptPacks(false);
    }
  }

  function createPendingShipmentReceipt() {
    if (!pendingShipmentReceipt) return;
    createReceiptFromShipmentMutation.mutate(pendingShipmentReceipt);
  }

  function openReceiptVariantSetup(line?: ShipmentReceiptPackResolutionLine) {
    const context = pendingShipmentReceipt ?? (shipmentReceiptPackResolution
      ? {
          shipmentId: shipmentReceiptPackResolution.shipmentId,
          purchaseOrderId: shipmentReceiptPackResolution.purchaseOrderId,
        }
      : null);
    const returnTo = context && poId
      ? `/purchase-orders/${poId}?resumeShipmentReceipt=1&shipmentId=${context.shipmentId}&purchaseOrderId=${context.purchaseOrderId}`
      : `/purchase-orders/${poId ?? ""}`;
    const setupParams = new URLSearchParams({
      receiptSetup: "1",
      returnTo,
    });
    if (line?.unitsPerCarton && Number(line.unitsPerCarton) > 0) {
      setupParams.set("unitsPerVariant", String(line.unitsPerCarton));
      setupParams.set("hierarchyLevel", "3");
    }
    if (line?.sku) setupParams.set("shipmentSku", line.sku);

    if (line?.productId) {
      navigate(`/products/${line.productId}?${setupParams.toString()}`);
      return;
    }

    navigate(`/catalog/variants?${setupParams.toString()}`);
  }

  useEffect(() => {
    if (!poId) return;
    const searchParams = new URLSearchParams(searchStr);
    if (searchParams.get("resumeShipmentReceipt") !== "1") return;

    const shipmentId = parsePositiveInt(searchParams.get("shipmentId"));
    const purchaseOrderId = parsePositiveInt(searchParams.get("purchaseOrderId")) ?? poId;
    if (!shipmentId || purchaseOrderId !== poId) {
      toast({
        title: "Cannot resume receipt",
        description: "The return link is missing the shipment or PO context.",
        variant: "destructive",
      });
      navigate(`/purchase-orders/${poId}`, { replace: true });
      return;
    }

    const resumeKey = `${shipmentId}:${purchaseOrderId}`;
    if (resumeShipmentReceiptHandled.current === resumeKey) return;
    resumeShipmentReceiptHandled.current = resumeKey;
    navigate(`/purchase-orders/${poId}`, { replace: true });
    void checkAndReceiveShipment({ shipmentId, purchaseOrderId });
  }, [poId, searchStr]);

  const createInvoiceMutation = useMutation({
    mutationFn: async () => {
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `po-invoice-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch("/api/vendor-invoices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          vendorId: po.vendorId,
          invoiceNumber: invoiceForm.invoiceNumber,
          currency: po.currency || "USD",
          paymentTermsDays: po.paymentTermsDays,
          paymentTermsType: po.paymentTermsType,
          invoiceDate: invoiceForm.invoiceDate || undefined,
          dueDate: invoiceForm.dueDate || undefined,
          notes: invoiceForm.notes || undefined,
          internalNotes: `Auto-created from ${po.poNumber}`,
          poIds: [po.id],
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create invoice"); }
      return res.json();
    },
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setShowCreateInvoiceDialog(false);
      toast({ title: "Invoice created", description: `Invoice ${invoice.invoiceNumber} created and linked to this PO.` });
      navigate(`/ap-invoices/${invoice.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const acknowledgeMutation = useMutation({
    mutationFn: async (data: typeof ackData) => {
      const res = await fetch(`/api/purchase-orders/${poId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorRefNumber: data.vendorRefNumber || undefined,
          confirmedDeliveryDate: data.confirmedDeliveryDate || undefined,
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setShowAckDialog(false);
      toast({ title: "Acknowledged", description: "Vendor acknowledgment recorded" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateScheduleMutation = useMutation({
    mutationFn: async (data: typeof scheduleData) => {
      const res = await fetch(`/api/purchase-orders/${poId}/delivery-schedule`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedDeliveryDate: data.expectedDeliveryDate || null,
          confirmedDeliveryDate: data.confirmedDeliveryDate || null,
          notes: data.notes.trim() || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to update delivery schedule");
      return body;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/procurement/health"] });
      setShowScheduleDialog(false);
      toast({ title: "Schedule updated", description: "Delivery dates and audit history were updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Schedule update failed", description: err.message, variant: "destructive" });
    },
  });

  // Phase 3 physical-status transition mutations — mirror
  // acknowledgeMutation's pattern exactly.
  const markShippedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/mark-shipped`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Marked as shipped" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const markInTransitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/mark-in-transit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Marked as in transit" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const markArrivedMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/purchase-orders/${poId}/mark-arrived`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Marked as arrived" });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  // Inline payment mutation — posts directly to /api/ap-payments so
  // the user never has to navigate away from PO detail (Rule #6: fresh
  // Idempotency-Key per attempt prevents double-posts on retry).
  const paymentMutation = useMutation({
    mutationFn: async () => {
      if (!payment.invoiceId) throw new Error("No invoice selected");
      const idempotencyKey = (
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? (crypto as any).randomUUID()
          : `po-pay-${Date.now()}-${Math.random().toString(36).slice(2)}`
      ) as string;
      const res = await fetch("/api/ap-payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          vendorId: po?.vendorId,
          paymentDate: payment.paymentDate,
          paymentMethod: payment.paymentMethod,
          referenceNumber: payment.referenceNumber || undefined,
          checkNumber: payment.checkNumber || undefined,
          bankAccountLabel: payment.bankAccountLabel || undefined,
          totalAmountCents: dollarsToCents(payment.amountDollars || "0"),
          notes: payment.notes || undefined,
          allocations: [{
            vendorInvoiceId: payment.invoiceId,
            appliedAmountCents: dollarsToCents(payment.amountDollars || "0"),
          }],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Payment failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/payments`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/invoices`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ap-payments"] });
      setShowPaymentDialog(false);
      setPayment(p => ({
        ...p,
        amountDollars: "",
        invoiceId: null,
        referenceNumber: "",
        checkNumber: "",
        bankAccountLabel: "",
        notes: "",
      }));
      toast({ title: "Payment recorded", description: apLedgerOutcomeDescription(result) });
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (reason: string) => {
      const endpoint = ["sent", "acknowledged"].includes(po?.status) ? "void" : "cancel";
      const res = await fetch(`/api/purchase-orders/${poId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      setShowCancelDialog(false);
      setCancelReason("");
      toast({ title: "Cancelled", description: "Purchase order cancelled" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const catalogUpsertMutation = useMutation({
    mutationFn: async (data: {
      vendorId: number; productId: number; productVariantId: number;
      vendorSku: string; pricing: PoLinePricingInput;
      packSize: number; isPreferred: boolean;
      quoteReference?: string;
      quotedAt?: string;
      quoteValidUntil?: string;
    }) => {
      const res = await fetch("/api/vendor-products/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/vendor-products"] });
      toast({
        title: result.created ? "Added to catalog" : "Catalog updated",
        description: result.created
          ? "Vendor catalog entry created for this product."
          : "Vendor catalog entry updated with latest cost.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Catalog save failed", description: err.message, variant: "destructive" });
    },
  });

  const addLineMutation = useMutation({
    mutationFn: async (data: {
      productId: number;
      expectedReceiveVariantId: number;
      expectedReceiveUnitsPerVariant: number;
      vendorProductId?: number;
      vendorSku?: string;
      description?: string;
      pricingSource: "manual" | "vendor_catalog";
      pricing: PoLinePricingInput;
      expectedPoUpdatedAt: string;
      quoteReference?: string;
      quotedAt?: string;
      quoteValidUntil?: string;
    }) => {
      const res = await fetch(`/api/purchase-orders/${poId}/lines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": genPoLineIdempotencyKey(),
        },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to add line");
      }
      return res.json();
    },
    onSuccess: (_result, command) => {
      const catalogData = saveToVendorCatalog && command.pricing.basis !== "extended_total" && po?.vendorId && command.expectedReceiveVariantId ? {
        vendorId: po.vendorId,
        productId: command.productId,
        productVariantId: command.expectedReceiveVariantId,
        vendorSku: command.vendorSku || "",
        pricing: command.pricing,
        ...populatedPoLineQuoteMetadata({
          quoteReference: command.quoteReference ?? null,
          quotedAt: command.quotedAt ?? null,
          quoteValidUntil: command.quoteValidUntil ?? null,
        }),
        // Catalog pack size describes the supplier's purchase UOM. Receiving
        // configuration is intentionally independent.
        packSize: vendorCatalogPackSizeForPricing(command.pricing),
        isPreferred: setAsPreferred,
      } : null;

      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setShowAddLineDialog(false);
      setNewLine(createEmptyNewLine());
      setProductSearch("");
      setSelectedProductForLine(null);
      setLinePricing(createEmptyPoLinePricingDraft());
      setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
      setSaveToVendorCatalog(true);
      setSetAsPreferred(false);
      setCatalogSearch("");
      setSelectedCatalogEntry(null);
      setCatalogPricingUntouched(false);
      toast({ title: "Line added" });

      if (catalogData) catalogUpsertMutation.mutate(catalogData);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (line: any) => {
      if (!po?.updatedAt || !line?.updatedAt) {
        throw new Error("The PO or line version is unavailable. Reload before removing this line.");
      }
      const res = await fetch(`/api/purchase-orders/lines/${line.id}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": genPoLineIdempotencyKey(),
        },
        body: JSON.stringify({
          expectedPoUpdatedAt: po.updatedAt,
          expectedLineUpdatedAt: line.updatedAt,
          reason: "Removed from draft purchase order",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to remove line");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      toast({ title: "Line removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateLineMutation = useMutation({
    mutationFn: async ({ line, updates }: { line: any; updates: Record<string, any> }) => {
      if (!po?.updatedAt || !line?.updatedAt) {
        throw new Error("The PO or line version is unavailable. Reload before editing this line.");
      }
      const res = await fetch(`/api/purchase-orders/lines/${line.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": genPoLineIdempotencyKey(),
        },
        body: JSON.stringify({
          ...updates,
          expectedPoUpdatedAt: po.updatedAt,
          expectedLineUpdatedAt: line.updatedAt,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update line");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setEditingLineId(null);
      setEditingLineField(null);
      setSkuVariants([]);
      setEditingPricingLine(null);
      setEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
      setOriginalEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
      setEditRequiresLegacyConfirmation(false);
      setLegacyPricingConfirmed(false);
      toast({ title: "Line updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function startPricingEdit(line: any) {
    if (!canEditLine(line)) return;
    const stored = createStoredPoLinePricingDraft(line);
    setEditingPricingLine(line);
    setEditLinePricing(stored.draft);
    const storedMetadata = createPoLineQuoteMetadataDraftFromStored(line);
    setEditLineQuoteMetadata(storedMetadata);
    setOriginalEditLineQuoteMetadata(storedMetadata);
    setEditRequiresLegacyConfirmation(stored.requiresLegacyConfirmation);
    setLegacyPricingConfirmed(false);
  }

  async function startSkuEdit(line: any) {
    if (!canEditLine(line)) return;
    setEditingLineId(line.id);
    setEditingLineField("sku");
    try {
      const res = await fetch(`/api/products/${line.productId}`);
      if (res.ok) {
        const data = await res.json();
        setSkuVariants(data.variants || []);
      }
    } catch { /* ignore */ }
  }

  function saveSkuEdit(line: any, variant: { id: number; sku: string; unitsPerVariant: number }) {
    if (!canEditLine(line)) return;
    updateLineMutation.mutate({
      line,
      updates: {
        expectedReceiveVariantId: variant.id,
        expectedReceiveUnitsPerVariant: variant.unitsPerVariant || 1,
      },
    });
  }

  function savePricingEdit() {
    if (!editingPricingLine || !canEditLine(editingPricingLine)) return;
    const evaluation = evaluatePoLinePricingDraft(editLinePricing);
    const metadataEvaluation = evaluatePoLineQuoteMetadataDraft(editLineQuoteMetadata);
    if (!evaluation.pricing) {
      toast({
        title: "Invalid vendor quote",
        description: evaluation.error ?? "Enter a complete vendor quote.",
        variant: "destructive",
      });
      return;
    }
    if (!metadataEvaluation.metadata) {
      toast({
        title: "Invalid quote details",
        description: metadataEvaluation.error ?? "Enter valid quote details.",
        variant: "destructive",
      });
      return;
    }
    if (editRequiresLegacyConfirmation && !legacyPricingConfirmed) {
      toast({
        title: "Confirm the quote basis",
        description: "This legacy line has no stored vendor quote basis. Confirm the quote before saving.",
        variant: "destructive",
      });
      return;
    }
    updateLineMutation.mutate({
      line: editingPricingLine,
      // A human changed or confirmed this line. Keep its quote metadata, but
      // mark the pricing source as manual rather than claiming an untouched
      // catalog or recommendation value.
      updates: {
        pricing: evaluation.pricing,
        pricingSource: "manual",
        // Omit untouched metadata so editing economics never truncates an
        // existing quote timestamp to its date-only input representation.
        ...changedPoLineQuoteMetadata(
          originalEditLineQuoteMetadata,
          editLineQuoteMetadata,
          metadataEvaluation.metadata,
        ),
      },
    });
  }

  function cancelLineEdit() {
    setEditingLineId(null);
    setEditingLineField(null);
    setSkuVariants([]);
  }

  function closePricingEdit() {
    setEditingPricingLine(null);
    setEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
    setOriginalEditLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
    setEditRequiresLegacyConfirmation(false);
    setLegacyPricingConfirmed(false);
  }

  const updateChargesMutation = useMutation({
    mutationFn: async (data: { incoterms?: string; discountCents?: number; taxCents?: number; shippingCostCents?: number }) => {
      const res = await fetch(`/api/purchase-orders/${poId}/incoterms-charges`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
      setEditingIncoterms(false);
      setEditingDiscount(false);
      setEditingShipping(false);
      setEditingTax(false);
      setEditingTolerance(false);
      toast({ title: "Updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const createShipmentMutation = useMutation({
    mutationFn: async (form: typeof newShipmentForm) => {
      const res = await fetch("/api/inbound-shipments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: form.mode || undefined,
          shipmentNumber: form.shipmentNumber || undefined,
          shipperName: form.shipperName || undefined,
          forwarderName: form.forwarderName || undefined,
          carrierName: form.carrierName || undefined,
        }),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error || "Failed to create shipment"); }
      const shipment = await res.json();

      // Chain: add selected lines from PO
      const selectedLines = (shippableLinesData?.lines ?? [])
        .filter((line: any) => lineSelections[line.id]?.checked && lineSelections[line.id]?.qty > 0)
        .map((line: any) => ({ poLineId: line.id, qty: lineSelections[line.id].qty }));

      if (selectedLines.length > 0) {
        try {
          const linesRes = await fetch(`/api/inbound-shipments/${shipment.id}/lines/from-po`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ purchaseOrderId: poId, lineSelections: selectedLines }),
          });
          if (!linesRes.ok) {
            const err = await linesRes.json();
            return { shipment, lineError: err.error || "Failed to add lines", lineCount: 0 };
          }
          return { shipment, lineError: null, lineCount: selectedLines.length };
        } catch (e: any) {
          return { shipment, lineError: e.message, lineCount: 0 };
        }
      }
      return { shipment, lineError: null, lineCount: 0 };
    },
    onSuccess: ({ shipment, lineError, lineCount }) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/shipments`] });
      setShowCreateShipmentDialog(false);
      setLineSelections({});
      if (lineError) {
        toast({
          title: "Shipment created",
          description: `${shipment.shipmentNumber} created but failed to add lines: ${lineError}. You can add lines manually on the shipment page.`,
          variant: "destructive",
        });
      } else if (lineCount > 0) {
        toast({ title: "Shipment created", description: `${shipment.shipmentNumber} created with ${lineCount} line${lineCount === 1 ? "" : "s"}` });
      } else {
        toast({ title: "Shipment created", description: `${shipment.shipmentNumber} created` });
      }
      navigate(`/shipments/${shipment.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const openCreateInvoiceDialogFromPo = async () => {
    let invoiceNumber = "";
    try {
      const res = await fetch("/api/vendor-invoices/next-number");
      if (res.ok) {
        const data = await res.json();
        invoiceNumber = data.invoiceNumber;
      }
    } catch {}
    setInvoiceForm({
      invoiceNumber,
      amountDollars: ((Number(po?.totalCents) || 0) / 100).toString(),
      invoiceDate: new Date().toISOString().slice(0, 10),
      dueDate: "",
      notes: "",
    });
    setShowCreateInvoiceDialog(true);
  };

  const openPaymentDialogFromPo = () => {
    const unpaidInvoices = invoicesData?.invoices?.filter((i: any) => i.balanceCents > 0) ?? [];
    if (unpaidInvoices.length === 0) {
      setShowPaymentDialog(true);
      return;
    }
    const first = unpaidInvoices[0];
    setPayment(p => ({
      ...p,
      invoiceId: first.id,
      amountDollars: (first.balanceCents / 100).toFixed(2),
    }));
    setShowPaymentDialog(true);
  };

  const runAutoDraftPrimaryAction = async () => {
    const action = autoDraftActionPlan?.primaryAction;
    if (!action) return;
    if (action.tab) setActiveTab(action.tab);

    switch (action.id) {
      case "open_lines":
      case "open_exceptions":
      case "done":
      case "cancelled":
        return;
      case "create_invoice":
        await openCreateInvoiceDialogFromPo();
        return;
      case "record_payment":
        openPaymentDialogFromPo();
        return;
      case "submit":
        submitMutation.mutate();
        return;
      case "approve":
        approveMutation.mutate();
        return;
      case "send":
        sendMutation.mutate();
        return;
      case "send_to_vendor":
        if (po?.status === "approved") {
          sendMutation.mutate();
        } else if (isSoloMode) {
          sendToVendorMutation.mutate();
        } else {
          submitMutation.mutate();
        }
        return;
      case "acknowledge":
        setShowAckDialog(true);
        return;
      case "mark_shipped":
        markShippedMutation.mutate();
        return;
      case "mark_in_transit":
        markInTransitMutation.mutate();
        return;
      case "mark_arrived":
        markArrivedMutation.mutate();
        return;
      case "create_receipt":
        createReceiptMutation.mutate();
        return;
      case "close":
        closeMutation.mutate();
        return;
      case "return_to_draft":
        returnToDraftMutation.mutate();
        return;
      case "cancel":
        setShowCancelDialog(true);
        return;
      case "close_short":
        return;
    }
  };

  const autoDraftPrimaryActionPending = (() => {
    switch (autoDraftActionPlan?.primaryAction.id) {
      case "submit":
        return submitMutation.isPending;
      case "approve":
        return approveMutation.isPending;
      case "send":
        return sendMutation.isPending;
      case "send_to_vendor":
        return po?.status === "approved" ? sendMutation.isPending : sendToVendorMutation.isPending || submitMutation.isPending;
      case "mark_shipped":
        return markShippedMutation.isPending;
      case "mark_in_transit":
        return markInTransitMutation.isPending;
      case "mark_arrived":
        return markArrivedMutation.isPending;
      case "create_receipt":
        return createReceiptMutation.isPending;
      case "create_invoice":
        return createInvoiceMutation.isPending;
      case "close":
        return closeMutation.isPending;
      case "return_to_draft":
        return returnToDraftMutation.isPending;
      default:
        return false;
    }
  })();

  const autoDraftPrimaryButtonLabel = (() => {
    switch (autoDraftActionPlan?.primaryAction.id) {
      case "open_lines":
        return "Open lines";
      case "open_exceptions":
        return "Open exceptions";
      case "create_invoice":
        return "Create invoice";
      case "record_payment":
        return "Record payment";
      case "done":
        return "No action";
      case "cancelled":
        return "Review history";
      default:
        return autoDraftActionPlan?.primaryAction.label ?? "Open";
    }
  })();

  const autoDraftPrimaryButtonDisabled =
    !autoDraftActionPlan ||
    autoDraftPrimaryActionPending ||
    ["done", "cancelled"].includes(autoDraftActionPlan.primaryAction.id);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!po) {
    return (
      <div className="p-6 text-center">
        <p className="text-muted-foreground">Purchase order not found.</p>
        <Button variant="link" onClick={() => navigate("/purchase-orders")}>Back to list</Button>
      </div>
    );
  }

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start gap-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/purchase-orders")} className="min-h-[44px]">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl md:text-2xl font-bold font-mono">{po.poNumber}</h1>
            <Badge
              variant={STATUS_BADGES[po.status]?.variant || "secondary"}
              className={`text-sm ${STATUS_BADGES[po.status]?.color || ""}`}
            >
              {STATUS_BADGES[po.status]?.label || po.status}
            </Badge>
            {po.priority === "rush" && <Badge variant="destructive">Rush</Badge>}
            {po.priority === "high" && <Badge variant="outline" className="text-orange-600 border-orange-300">High</Badge>}
            {Number(po.overReceiptTolerancePct) > 0 && <Badge variant="outline" className="border-blue-300 text-blue-700 bg-blue-50">Tol: {Number(po.overReceiptTolerancePct)}%</Badge>}
          </div>
          <div className="text-sm text-muted-foreground mt-1 flex items-center gap-x-2 flex-wrap">
            <span>{po.vendor?.name || `Vendor #${po.vendorId}`}</span>
            {po.poType !== "standard" && <span>• {po.poType}</span>}
            <span>•</span>
            {!editingIncoterms ? (
              <span className="flex items-center gap-1">
                {poIncoterms
                  ? <span className="font-medium text-foreground">{poIncoterms}</span>
                  : <span className="italic text-amber-600">No incoterms set</span>}
                {canEditHeader && (
                  <Button
                    variant="ghost" size="icon" className="h-5 w-5 ml-0.5"
                    onClick={() => { setIncotermsEdit(poIncoterms || ""); setEditingIncoterms(true); }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                )}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <Select value={incotermsEdit} onValueChange={setIncotermsEdit}>
                  <SelectTrigger className="h-7 w-36 text-xs">
                    <SelectValue placeholder="Select..." />
                  </SelectTrigger>
                  <SelectContent>
                    {INCOTERMS_LIST.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button
                  size="sm" className="h-7 px-2"
                  disabled={!incotermsEdit || updateChargesMutation.isPending}
                  onClick={() => updateChargesMutation.mutate({ incoterms: incotermsEdit })}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditingIncoterms(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </span>
            )}
            <span>•</span>
            <span>Requested: {displayScheduleDate(po.expectedDeliveryDate)}</span>
            <span>•</span>
            <span>Vendor confirmed: {displayScheduleDate(po.confirmedDeliveryDate)}</span>
            {canEditSchedule && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={openScheduleEditor}
                      aria-label="Edit delivery schedule"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit delivery schedule</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        {/* Context-sensitive action buttons */}
        <div className="flex gap-2 flex-wrap w-full sm:w-auto">
          {/* Solo mode: combined "Send to Vendor" button (draft → approved → sent in one click) */}
          {canSendPoToVendor && po.status === "draft" && isSoloMode && (
            <Button onClick={() => sendToVendorMutation.mutate()} disabled={sendToVendorMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              {sendToVendorMutation.isPending ? "Submitting..." : "Submit & Send"}
            </Button>
          )}
          {/* Multi-person mode: individual Submit button */}
          {canSubmitPo && po.status === "draft" && !isSoloMode && (
            <Button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              Submit
            </Button>
          )}
          {(canApprovePo || canReturnPoToDraft) && po.status === "pending_approval" && (
            <>
              {canApprovePo && (
                <Button onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Approve
                </Button>
              )}
              {canReturnPoToDraft && (
                <Button variant="outline" onClick={() => returnToDraftMutation.mutate()} disabled={returnToDraftMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Return to Draft
                </Button>
              )}
            </>
          )}
          {canSendPo && po.status === "approved" && (
            <Button onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              Mark as Sent
            </Button>
          )}
          {/* Acknowledge button: only shown when acknowledgment is required (multi-person mode) */}
          {canAcknowledgePo && requireAcknowledgment && (
            <Button onClick={() => setShowAckDialog(true)} className="flex-1 sm:flex-none min-h-[44px]">
              <CheckCircle className="h-4 w-4 mr-2" />
              Acknowledge
            </Button>
          )}
          {canCreateReceiptForPo && (
            <Button variant="outline" onClick={() => setShowReceivePicker(true)} className="flex-1 sm:flex-none min-h-[44px]">
              <Truck className="h-4 w-4 mr-2" />
              Receive
            </Button>
          )}
          {canClosePo && (
            <Button onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Archive className="h-4 w-4 mr-2" />
              Close PO
            </Button>
          )}
          {canCancelPo && (
            <Button variant="outline" onClick={() => setShowCancelDialog(true)} className="flex-1 sm:flex-none min-h-[44px] text-red-600 hover:text-red-700">
              <Ban className="h-4 w-4 mr-2" />
              {["sent", "acknowledged"].includes(po.status) ? "Void" : "Cancel"}
            </Button>
          )}
          {["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(po.status) && (
            <Button variant="outline" onClick={async () => {
              setDocLoading(true);
              setShowDocDialog(true);
              try {
                const res = await fetch(`/api/purchase-orders/${poId}/document`);
                const data = await res.json();
                setDocHtml(data.html);
              } catch {
                setDocHtml("<p>Failed to load document.</p>");
              } finally {
                setDocLoading(false);
              }
            }} className="flex-1 sm:flex-none min-h-[44px]">
              <Printer className="h-4 w-4 mr-2" />
              View / Print
            </Button>
          )}
          {["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(po.status) && (
            <Button variant="outline" onClick={async () => {
              let invoiceNumber = "";
              try {
                const res = await fetch("/api/vendor-invoices/next-number");
                if (res.ok) {
                  const data = await res.json();
                  invoiceNumber = data.invoiceNumber;
                }
              } catch {}
              setInvoiceForm({
                invoiceNumber,
                amountDollars: ((Number(po.totalCents) || 0) / 100).toString(),
                invoiceDate: new Date().toISOString().slice(0, 10),
                dueDate: "",
                notes: "",
              });
              setShowCreateInvoiceDialog(true);
            }} className="flex-1 sm:flex-none min-h-[44px]">
              <FileText className="h-4 w-4 mr-2" />
              Create Invoice
            </Button>
          )}
        </div>
      </div>

      {/* Exception pill (Phase 1) — only when there are open exceptions.
          Click jumps to the Exceptions tab below. Severity drives color. */}
      {openExceptionCount > 0 && (
        <button
          type="button"
          onClick={() => setActiveTab("exceptions")}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-sm font-medium transition-colors ${
            maxOpenSeverity === "error"
              ? "bg-red-50 text-red-700 border-red-300 hover:bg-red-100"
              : "bg-amber-50 text-amber-700 border-amber-300 hover:bg-amber-100"
          }`}
          data-testid="po-exception-pill"
        >
          <span aria-hidden>⚠</span>
          {openExceptionCount} exception{openExceptionCount > 1 ? "s" : ""}
        </button>
      )}

      {/*
        Cancellation audit banner.
        When physical_status='cancelled', surface the reason + when + who
        and warn about pre-cancel artifacts (invoices/receipts/payments
        that exist on this PO and may need follow-up).
        The History tab is the canonical chronological audit trail; this
        banner is the at-a-glance summary so the user doesn't have to
        hunt for it.
      */}
      {po.physicalStatus === "cancelled" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <span aria-hidden>⛔</span>
              <span>
                Cancelled
                {po.cancelledAt
                  ? ` ${new Date(po.cancelledAt).toLocaleString()}`
                  : ""}
                {po.cancelledBy ? ` by ${cancelledByFormatted}` : ""}
              </span>
            </div>
            {po.cancelReason && (
              <span className="text-xs text-muted-foreground">
                Reason: <span className="text-foreground">{po.cancelReason}</span>
              </span>
            )}
          </div>
          {(() => {
            // Pre-cancel artifacts that might need follow-up. We surface
            // counts (and click-to-tab) but don't try to make value
            // judgments about whether they're 'OK' — user knows context.
            const issuedInvoices = invoicesData?.invoices?.length ?? 0;
            const recordedPayments = paymentsData?.payments?.length ?? 0;
            const physReceipts = receipts.length;
            const items: Array<{ label: string; tab: string }> = [];
            if (issuedInvoices > 0) items.push({ label: `${issuedInvoices} invoice${issuedInvoices > 1 ? "s" : ""} issued before cancellation`, tab: "invoices" });
            if (recordedPayments > 0) items.push({ label: `${recordedPayments} payment${recordedPayments > 1 ? "s" : ""} recorded`, tab: "payments" });
            if (physReceipts > 0) items.push({ label: `${physReceipts} receipt${physReceipts > 1 ? "s" : ""} on file`, tab: "receipts" });
            if (items.length === 0) return null;
            return (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Pre-cancel artifacts:</span>{" "}
                {items.map((it, i) => (
                  <span key={it.tab}>
                    {i > 0 && " · "}
                    <button
                      type="button"
                      onClick={() => setActiveTab(it.tab)}
                      className="underline hover:text-foreground"
                    >
                      {it.label}
                    </button>
                  </span>
                ))}
                {". Review for follow-up."}
              </div>
            );
          })()}
          <div className="text-[11px] text-muted-foreground">
            Full audit trail in the{" "}
            <button
              type="button"
              onClick={() => setActiveTab("history")}
              className="underline hover:text-foreground"
            >
              History tab
            </button>
            .
          </div>
        </div>
      )}

      {/* Phase 2: Dual-track header. We pass the history rows so the
          tooltip can derive timestamps for stages that don't have
          dedicated columns (in_transit, receiving, received). */}
      <DualTrackHeader po={po} history={history} />

      {/* Charge summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 md:gap-4">

        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground" title="Over-Receipt Tolerance %">Tolerance</div>
              {canEditHeader && !editingTolerance && (
                <Button variant="ghost" size="icon" className="h-5 w-5"
                  onClick={() => { setToleranceVal(String(Number(po.overReceiptTolerancePct) || 0)); setEditingTolerance(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {editingTolerance ? (
              <div className="flex gap-1 mt-1">
                <Input type="number" min="0" max="100" step="1" value={toleranceVal}
                  onChange={e => setToleranceVal(e.target.value)}
                  className="h-7 text-sm font-mono w-16 px-1" autoFocus
                  onKeyDown={e => { if (e.key === "Enter") updateChargesMutation.mutate({ overReceiptTolerancePct: parseFloat(toleranceVal || "0") } as any); if (e.key === "Escape") setEditingTolerance(false); }}
                />
                <Button size="sm" className="h-7 px-1" disabled={updateChargesMutation.isPending}
                  onClick={() => updateChargesMutation.mutate({ overReceiptTolerancePct: parseFloat(toleranceVal || "0") } as any)}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-1" onClick={() => setEditingTolerance(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{Number(po.overReceiptTolerancePct) || 0}%</div>
            )}
          </CardContent>
        </Card>

        {/* Subtotal — always read-only */}
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Subtotal</div>
            <div className="font-mono font-medium">{formatCents(po.subtotalCents)}</div>
          </CardContent>
        </Card>

        {/* Discount — editable in draft */}
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Discount</div>
              {canEditLines && !editingDiscount && (
                <Button variant="ghost" size="icon" className="h-5 w-5"
                  onClick={() => { setDiscountDollars(((Number(po.discountCents) || 0) / 100).toFixed(2)); setEditingDiscount(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {editingDiscount ? (
              <div className="flex gap-1 mt-1">
                <Input type="number" min="0" step="0.01" value={discountDollars}
                  onChange={e => setDiscountDollars(e.target.value)}
                  className="h-7 text-sm font-mono" autoFocus
                  onKeyDown={e => { if (e.key === "Enter") updateChargesMutation.mutate({ discountCents: dollarsToCents(discountDollars || "0") }); if (e.key === "Escape") setEditingDiscount(false); }}
                />
                <Button size="sm" className="h-7 px-2" disabled={updateChargesMutation.isPending}
                  onClick={() => updateChargesMutation.mutate({ discountCents: dollarsToCents(discountDollars || "0") })}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditingDiscount(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{formatCents(po.discountCents)}</div>
            )}
          </CardContent>
        </Card>

        {/* Tax — editable when DDP (or no incoterms); grayed out otherwise */}
        <Card className={!taxApplicable ? "opacity-40" : ""}>
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Tax / Duties</div>
              {taxApplicable && canEditHeader && !editingTax && (
                <Button variant="ghost" size="icon" className="h-5 w-5"
                  onClick={() => { setTaxDollars(((Number(po.taxCents) || 0) / 100).toFixed(2)); setEditingTax(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {editingTax ? (
              <div className="flex gap-1 mt-1">
                <Input type="number" min="0" step="0.01" value={taxDollars}
                  onChange={e => setTaxDollars(e.target.value)}
                  className="h-7 text-sm font-mono" autoFocus
                  onKeyDown={e => { if (e.key === "Enter") updateChargesMutation.mutate({ taxCents: dollarsToCents(taxDollars || "0") }); if (e.key === "Escape") setEditingTax(false); }}
                />
                <Button size="sm" className="h-7 px-2" disabled={updateChargesMutation.isPending}
                  onClick={() => updateChargesMutation.mutate({ taxCents: dollarsToCents(taxDollars || "0") })}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditingTax(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{formatCents(po.taxCents)}</div>
            )}
            {!taxApplicable && poIncoterms && (
              <div className="text-xs text-muted-foreground mt-0.5">N/A — {poIncoterms}</div>
            )}
          </CardContent>
        </Card>

        {/* Shipping — editable when CFR/CIF/CPT/CIP/DAP/DPU/DDP (or no incoterms); grayed otherwise */}
        <Card className={!shippingApplicable ? "opacity-40" : ""}>
          <CardContent className="p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Freight</div>
              {shippingApplicable && canEditHeader && !editingShipping && (
                <Button variant="ghost" size="icon" className="h-5 w-5"
                  onClick={() => { setShippingDollars(((Number(po.shippingCostCents) || 0) / 100).toFixed(2)); setEditingShipping(true); }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </div>
            {editingShipping ? (
              <div className="flex gap-1 mt-1">
                <Input type="number" min="0" step="0.01" value={shippingDollars}
                  onChange={e => setShippingDollars(e.target.value)}
                  className="h-7 text-sm font-mono" autoFocus
                  onKeyDown={e => { if (e.key === "Enter") updateChargesMutation.mutate({ shippingCostCents: dollarsToCents(shippingDollars || "0") }); if (e.key === "Escape") setEditingShipping(false); }}
                />
                <Button size="sm" className="h-7 px-2" disabled={updateChargesMutation.isPending}
                  onClick={() => updateChargesMutation.mutate({ shippingCostCents: dollarsToCents(shippingDollars || "0") })}
                >
                  <Check className="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditingShipping(false)}>
                  <XCircle className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="font-mono font-medium">{formatCents(po.shippingCostCents)}</div>
            )}
            {!shippingApplicable && poIncoterms && (
              <div className="text-xs text-muted-foreground mt-0.5">
                N/A — {poIncoterms}
                <button
                  className="ml-1 text-primary underline"
                  onClick={() => setActiveTab("shipments")}
                >
                  Log on shipment
                </button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Total — always read-only */}
        <Card>
          <CardContent className="p-3">
            <div className="text-xs text-muted-foreground">Total</div>
            <div className="font-mono font-bold text-lg">{formatCents(po.totalCents)}</div>
          </CardContent>
        </Card>

      </div>

      {/* Auto-Draft Banner */}
      {immutableRecommendationPo && (
        <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 flex items-center gap-4 text-sm">
          <span className="text-lg flex-shrink-0">🤖</span>
          <div className="flex-1">
            <strong className="text-amber-700">
              {po.source === "auto_draft" ? "Auto-Draft" : "Recommendation Purchase Order"}
            </strong>
            <p className="text-muted-foreground text-xs mt-0.5">
              The accepted recommendation and vendor quote are preserved as an immutable economic snapshot. Review the lines, then use the lifecycle actions here to submit or send it without replacing the PO.
            </p>
          </div>
        </div>
      )}

      {autoDraftActionPlan && (
        <Card className="border-amber-200">
          <CardContent className="p-4 space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-start gap-4">
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    className={`text-xs ${AUTO_DRAFT_SEVERITY_STYLES[autoDraftActionPlan.primaryAction.severity]}`}
                  >
                    Auto-draft next action
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {autoDraftActionPlan.context.lineCount ?? lines.length} line{(autoDraftActionPlan.context.lineCount ?? lines.length) === 1 ? "" : "s"}
                    {autoDraftActionPlan.context.openExceptionCount > 0
                      ? `, ${autoDraftActionPlan.context.openExceptionCount} open exception${autoDraftActionPlan.context.openExceptionCount === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </div>
                <div>
                  <h3 className="font-semibold text-base">{autoDraftActionPlan.primaryAction.label}</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    {autoDraftActionPlan.primaryAction.detail}
                  </p>
                </div>
              </div>
              <Button
                variant={autoDraftActionPlan.primaryAction.severity === "critical" ? "destructive" : "default"}
                onClick={() => void runAutoDraftPrimaryAction()}
                disabled={autoDraftPrimaryButtonDisabled}
                className="w-full lg:w-auto"
              >
                {autoDraftPrimaryActionPending ? "Working..." : autoDraftPrimaryButtonLabel}
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
              {autoDraftActionPlan.checklist.map((step) => (
                <div
                  key={step.id}
                  className={`rounded-md border px-3 py-2 text-sm ${AUTO_DRAFT_STEP_STYLES[step.status]}`}
                >
                  <div className="flex items-center gap-2 font-medium">
                    {step.status === "done" ? (
                      <CheckCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    ) : step.status === "blocked" ? (
                      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    ) : (
                      <Clock className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                    <span className="truncate">{step.label}</span>
                  </div>
                  {step.detail && (
                    <p className="text-xs opacity-80 mt-1 line-clamp-2">
                      {step.detail}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Phase 2: Tabs + Quick Actions side rail */}
      <div className="flex flex-col md:flex-row gap-4 items-start">
      <div className="flex-1 min-w-0">
      {/* Tabs: Lines, Receipts, History */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="lines">Lines ({lines.length})</TabsTrigger>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="shipments">Shipments {linkedShipments.length > 0 ? `(${linkedShipments.length})` : ""}</TabsTrigger>
          <TabsTrigger value="exceptions" data-testid="tab-exceptions">
            Exceptions{openExceptionCount > 0 ? ` (${openExceptionCount})` : ""}
          </TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        {/* ── Lines Tab ── */}
        <TabsContent value="lines" className="space-y-4">
          {canEditLines && (
            <Button variant="outline" onClick={() => setShowAddLineDialog(true)} className="min-h-[44px]">
              <Plus className="h-4 w-4 mr-2" />
              Add Line
            </Button>
          )}

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {lines.length === 0 ? (
              <Card>
                <CardContent className="p-4 text-center text-muted-foreground">
                  No lines. {canEditLines ? "Add items to this PO." : ""}
                </CardContent>
              </Card>
            ) : (
              lines.map((line: any) => {
                const canEditThisLine = canEditLine(line);
                const isEditingSkuMobile = canEditThisLine && editingLineId === line.id && editingLineField === "sku";
                return (
                <Card key={line.id}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        {isEditingSkuMobile ? (
                          <div className="space-y-1 mb-2">
                            {skuVariants.length === 0 ? (
                              <span className="text-xs text-muted-foreground">Loading...</span>
                            ) : (
                              skuVariants.map((v) => (
                                <div
                                  key={v.id}
                                  className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-muted ${v.id === (line.expectedReceiveVariantId ?? line.productVariantId) ? "bg-muted font-bold" : ""}`}
                                  onClick={() => {
                                    if (v.id !== (line.expectedReceiveVariantId ?? line.productVariantId)) {
                                      saveSkuEdit(line, v);
                                    } else {
                                      cancelLineEdit();
                                    }
                                  }}
                                >
                                  {v.sku} — {v.name} ({v.unitsPerVariant}pc)
                                </div>
                              ))
                            )}
                            <Button variant="ghost" size="sm" className="h-6 text-xs w-full" onClick={cancelLineEdit}>Cancel</Button>
                          </div>
                        ) : (
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-mono text-sm ${canEditThisLine ? "cursor-pointer underline decoration-dotted" : ""}`}
                            onClick={() => canEditThisLine && startSkuEdit(line)}
                          >
                            {line.sku || "—"}
                          </span>
                          <Badge variant="outline" className="text-xs">{line.status}</Badge>
                        </div>
                        )}
                        <div className="text-sm mt-1 truncate">{line.productName || "—"}</div>
                        <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                          <span
                            className={canEditThisLine ? "cursor-pointer underline decoration-dotted" : ""}
                            onClick={() => canEditThisLine && startPricingEdit(line)}
                            title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                          >
                            {(line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1) > 1
                              ? `${(line.orderQty || 0).toLocaleString()} pcs (${Math.ceil((line.orderQty || 0) / (line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1))} expected)`
                              : `Qty: ${line.receivedQty || 0}/${line.orderQty}`}
                          </span>
                          <span
                            className={canEditThisLine ? "cursor-pointer underline decoration-dotted" : ""}
                            onClick={() => canEditThisLine && startPricingEdit(line)}
                            title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                          >
                            @ {formatLineUnitCost(line)}/pc
                          </span>
                          <span className="font-medium">{formatCents(line.lineTotalCents)}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Vendor quote: {formatStoredLineQuote(line)}
                        </div>
                      </div>
                      {canEditThisLine && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] min-w-[44px] p-0"
                          onClick={() => { if (confirm("Remove this line?")) deleteLineMutation.mutate(line); }}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
                );
              })
            )}
          </div>

          {/* Desktop table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Vendor SKU</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Unit Cost</TableHead>
                  <TableHead className="text-right">Line Total</TableHead>
                  <TableHead>Status</TableHead>
                  {canEditLines && <TableHead className="w-12"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={canEditLines ? 10 : 9} className="text-center text-muted-foreground py-8">
                      No lines. {canEditLines ? "Click \"Add Line\" to add items." : ""}
                    </TableCell>
                  </TableRow>
                ) : (
                  lines.map((line: any) => {
                    const canEditThisLine = canEditLine(line);
                    const isEditingSku = canEditThisLine && editingLineId === line.id && editingLineField === "sku";
                    return (
                    <TableRow key={line.id}>
                      <TableCell className="text-muted-foreground">{line.lineNumber}</TableCell>
                      <TableCell className="font-mono">
                        {isEditingSku ? (
                          <div className="space-y-1">
                            {skuVariants.length === 0 ? (
                              <span className="text-xs text-muted-foreground">Loading...</span>
                            ) : (
                              skuVariants.map((v) => (
                                <div
                                  key={v.id}
                                  className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-muted ${v.id === (line.expectedReceiveVariantId ?? line.productVariantId) ? "bg-muted font-bold" : ""}`}
                                  onClick={() => {
                                    if (v.id !== (line.expectedReceiveVariantId ?? line.productVariantId)) {
                                      saveSkuEdit(line, v);
                                    } else {
                                      cancelLineEdit();
                                    }
                                  }}
                                >
                                  {v.sku} — {v.name} ({v.unitsPerVariant}pc)
                                </div>
                              ))
                            )}
                            <Button variant="ghost" size="sm" className="h-6 text-xs w-full" onClick={cancelLineEdit}>Cancel</Button>
                          </div>
                        ) : (
                          <span
                            className={canEditThisLine ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                            onClick={() => canEditThisLine && startSkuEdit(line)}
                          >
                            {line.sku || "—"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate">{line.productName || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{line.vendorSku || "—"}</TableCell>
                      <TableCell className="text-right">
                        <span
                          className={canEditThisLine ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                          onClick={() => canEditThisLine && startPricingEdit(line)}
                          title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                        >
                          {(line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1) > 1
                            ? <>{(line.orderQty || 0).toLocaleString()} pcs<br /><span className="text-xs text-muted-foreground">({Math.ceil((line.orderQty || 0) / (line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1))} expected)</span></>
                            : line.orderQty}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {(line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1) > 1
                          ? <span>{(line.receivedQty || 0).toLocaleString()} pcs<br /><span className="text-xs text-muted-foreground">({Math.ceil((line.receivedQty || 0) / (line.expectedReceiveUnitsPerVariant || line.unitsPerUom || 1))} expected)</span></span>
                          : line.receivedQty || 0}
                        {(line.damagedQty || 0) > 0 && (
                          <span className="text-red-500 ml-1">({line.damagedQty} dmg)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        <span
                          className={canEditThisLine ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                          onClick={() => canEditThisLine && startPricingEdit(line)}
                          title={canEditThisLine ? "Edit vendor quote and quantity" : undefined}
                        >
                          {formatLineUnitCost(line)}
                        </span>
                        <div className="text-[11px] font-sans text-muted-foreground">
                          {formatStoredLineQuote(line)}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium">{formatCents(line.lineTotalCents)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{line.status}</Badge>
                      </TableCell>
                      {canEditThisLine && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { if (confirm("Remove this line?")) deleteLineMutation.mutate(line); }}
                            disabled={deleteLineMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ── Receipts Tab ── */}
        <TabsContent value="receipts" className="space-y-4">
          {receipts.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-center text-muted-foreground">
                No receipts linked to this PO yet.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>PO Line</TableHead>
                    <TableHead>Receiving Order</TableHead>
                    <TableHead className="text-right">Qty Received</TableHead>
                    <TableHead className="text-right">PO Cost</TableHead>
                    <TableHead className="text-right">Actual Cost</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell>Line #{r.purchaseOrderLineId}</TableCell>
                      <TableCell>RO #{r.receivingOrderId}</TableCell>
                      <TableCell className="text-right">{r.qtyReceived}</TableCell>
                      <TableCell className="text-right font-mono">
                        {r.poUnitCostMills != null
                          ? formatMills(Number(r.poUnitCostMills))
                          : r.poUnitCostCents != null
                            ? formatMills(centsToMills(Number(r.poUnitCostCents)))
                            : "$0.0000"}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {r.actualUnitCostMills != null
                          ? formatMills(Number(r.actualUnitCostMills))
                          : r.actualUnitCostCents != null
                            ? formatMills(centsToMills(Number(r.actualUnitCostCents)))
                            : "$0.0000"}
                      </TableCell>
                      <TableCell className={`text-right font-mono ${(r.varianceCents || 0) > 0 ? "text-red-500" : (r.varianceCents || 0) < 0 ? "text-green-500" : ""}`}>
                        {formatCents(r.varianceCents)}
                      </TableCell>
                      <TableCell className="text-sm">
                        {r.createdAt ? format(new Date(r.createdAt), "MMM d, yyyy") : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ── Shipments Tab ── */}
        <TabsContent value="shipments" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Inbound shipments carrying goods from this PO.
              {!shippingApplicable && poIncoterms && (
                <span className="ml-2 text-amber-600 font-medium">
                  {poIncoterms} — log freight, duty &amp; insurance costs on each shipment.
                </span>
              )}
            </p>
            {lines.length > 0 && !["closed", "cancelled"].includes(po.status) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNewShipmentForm({
                    mode: "sea_fcl",
                    shipmentNumber: "",
                    shipperName: po?.vendor?.name || "",
                    forwarderName: "",
                    carrierName: "",
                  });
                  setShowCreateShipmentDialog(true);
                }}
              >
                <Plus className="h-4 w-4 mr-1" />
                Create Shipment
              </Button>
            )}
          </div>

          {linkedShipments.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-center text-muted-foreground">
                <Ship className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>No shipments linked to this PO yet.</p>
                {lines.length > 0 && !["closed", "cancelled"].includes(po.status) && (
                  <p className="text-xs mt-1">Use "Create Shipment" above to start a new inbound shipment.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shipment #</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Carrier</TableHead>
                    <TableHead>ETA</TableHead>
                    <TableHead className="text-right">Est. Cost</TableHead>
                    <TableHead className="text-right">Actual Cost</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {linkedShipments.map((s: any) => {
                    const shipBadge: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }> = {
                      draft: { variant: "secondary", label: "Draft" },
                      booked: { variant: "outline", label: "Booked", color: "text-blue-600 border-blue-300" },
                      in_transit: { variant: "default", label: "In Transit", color: "bg-blue-500" },
                      at_port: { variant: "default", label: "At Port", color: "bg-indigo-500" },
                      customs_clearance: { variant: "outline", label: "Customs", color: "text-amber-600 border-amber-300" },
                      delivered: { variant: "default", label: "Delivered", color: "bg-green-600" },
                      costing: { variant: "outline", label: "Costing", color: "text-purple-600 border-purple-300" },
                      closed: { variant: "secondary", label: "Closed" },
                      cancelled: { variant: "destructive", label: "Cancelled" },
                    };
                    const badge = shipBadge[s.status] || { variant: "secondary" as const, label: s.status };
                    return (
                      <TableRow key={s.id} className="cursor-pointer" onClick={() => navigate(`/shipments/${s.id}`)}>
                        <TableCell className="font-mono font-medium">{s.shipmentNumber}</TableCell>
                        <TableCell>
                          <Badge variant={badge.variant} className={badge.color || ""}>{badge.label}</Badge>
                        </TableCell>
                        <TableCell className="capitalize">{s.mode?.replace(/_/g, " ") || "—"}</TableCell>
                        <TableCell>{s.carrierName || s.forwarderName || "—"}</TableCell>
                        <TableCell className="text-sm">
                          {s.eta ? format(new Date(s.eta), "MMM d, yyyy") : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatCents(s.estimatedTotalCostCents)}</TableCell>
                        <TableCell className="text-right font-mono">{formatCents(s.actualTotalCostCents)}</TableCell>
                        <TableCell>
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ── History Tab ── */}
        {/* ── Invoices Tab ── */}
        <TabsContent value="invoices" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Vendor invoices linked to this purchase order.
            </p>
            <a href="/ap-invoices" className="text-sm text-blue-600 hover:underline">
              Manage all invoices →
            </a>
          </div>
          {!invoicesData?.invoices?.length ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <p className="text-sm">No invoices linked to this PO yet.</p>
                <p className="text-xs mt-1">Create an invoice in the AP Invoices section and link this PO.</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Invoice Date</TableHead>
                      <TableHead>Due Date</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoicesData.invoices.map((inv: any) => (
                      <TableRow key={inv.id} className={inv.status === "voided" ? "opacity-40" : ""}>
                        <TableCell className={`font-mono font-medium ${inv.status === "voided" ? "line-through" : ""}`}>{inv.invoiceNumber}</TableCell>
                        <TableCell className="text-sm">{inv.invoiceDate ? format(new Date(inv.invoiceDate), "MMM d, yyyy") : "—"}</TableCell>
                        <TableCell className={`text-sm ${inv.dueDate && new Date(inv.dueDate) < new Date() && !["paid","voided"].includes(inv.status) ? "text-red-600 font-medium" : ""}`}>
                          {inv.dueDate ? format(new Date(inv.dueDate), "MMM d, yyyy") : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatCents(inv.invoicedAmountCents)}</TableCell>
                        <TableCell className="text-right font-mono font-medium">
                          {inv.balanceCents > 0 ? formatCents(inv.balanceCents) : <span className="text-green-600 text-sm">Paid</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">{inv.status?.replace("_", " ")}</Badge>
                        </TableCell>
                        <TableCell>
                          <a href={`/ap-invoices/${inv.id}`} className="text-xs text-blue-600 hover:underline">View →</a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Payments Tab (Phase 2) ── */}
        <TabsContent value="payments" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            AP payments applied to invoices linked to this purchase order.
          </p>
          {!paymentsData?.payments?.length ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No payments recorded against this PO yet.</p>
                <p className="text-xs mt-1">
                  Payments appear here once invoices are linked and payment is applied in the AP ledger.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Payment Date</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead className="text-right">Amount Applied</TableHead>
                      <TableHead>Invoice #</TableHead>
                      <TableHead>Reference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paymentsData.payments.map((p: any) => (
                      <TableRow key={p.allocationId}>
                        <TableCell className="text-sm">
                          {p.paymentDate
                            ? format(new Date(p.paymentDate), "MMM d, yyyy")
                            : "—"}
                        </TableCell>
                        <TableCell className="capitalize">
                          {(p.paymentMethod ?? "").replace(/_/g, " ") || "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono font-medium">
                          {formatCents(p.appliedAmountCents)}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {p.invoiceNumber ?? "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {p.referenceNumber || p.paymentNumber || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Exceptions tab (Phase 1) — surfaces open + acknowledged events,
            with a collapsible 'resolved/dismissed' section at the bottom. */}
        <TabsContent value="exceptions" className="space-y-3">
          {openExceptions.length === 0 && closedExceptions.length === 0 && (
            <Card>
              <CardContent className="p-6 text-center text-muted-foreground">
                No exceptions on this PO.
              </CardContent>
            </Card>
          )}

          {openExceptions.length > 0 && (
            <div className="space-y-2">
              {openExceptions.map((ex: any) => (
                <ExceptionCard
                  key={ex.id}
                  ex={ex}
                  onAcknowledge={() => ackExceptionMutation.mutate(ex.id)}
                  onResolve={(note) =>
                    resolveExceptionMutation.mutate({ id: ex.id, resolutionNote: note })
                  }
                  onDismiss={(note) =>
                    dismissExceptionMutation.mutate({ id: ex.id, note })
                  }
                  busy={
                    ackExceptionMutation.isPending ||
                    resolveExceptionMutation.isPending ||
                    dismissExceptionMutation.isPending
                  }
                  relatedUsers={relatedUsers}
                />
              ))}
            </div>
          )}

          {(closedExceptions.length > 0 || showResolvedExceptions) && (
            <div className="pt-2">
              {!showResolvedExceptions ? (
                <button
                  type="button"
                  onClick={() => setShowResolvedExceptions(true)}
                  className="w-full text-center text-xs text-muted-foreground py-2 rounded-md hover:bg-muted"
                  data-testid="show-resolved-exceptions"
                >
                  ▸ Show resolved / dismissed exceptions
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                    <span>Resolved / dismissed</span>
                    <button
                      type="button"
                      onClick={() => setShowResolvedExceptions(false)}
                      className="underline hover:text-foreground"
                    >
                      Hide
                    </button>
                  </div>
                  {closedExceptions.length === 0 ? (
                    <div className="text-xs text-muted-foreground text-center py-3">
                      None.
                    </div>
                  ) : (
                    closedExceptions.map((ex: any) => (
                      <div
                        key={ex.id}
                        className="text-xs border rounded-md p-2 bg-muted/30"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium">
                            {ex.status === "resolved" ? "✓" : "✕"} {ex.title}
                          </span>
                          <span className="text-muted-foreground">
                            {ex.status === "resolved" ? "resolved" : "dismissed"}{" "}
                            {ex.resolvedAt ? new Date(ex.resolvedAt).toLocaleDateString() : ""}
                            {ex.resolvedBy ? ` by ${formatActor(ex.resolvedBy, relatedUsers)}` : ""}
                          </span>
                        </div>
                        {ex.resolutionNote && (
                          <div className="mt-1 text-muted-foreground italic">
                            “{ex.resolutionNote}”
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          {history.length === 0 ? (
            <Card>
              <CardContent className="p-4 text-center text-muted-foreground">
                No status history.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {history.map((h: any, i: number) => (
                <Card key={h.id || i}>
                  <CardContent className="p-3 flex items-start gap-3">
                    <div className="mt-1">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {h.fromStatus && (
                          <>
                            <Badge variant="outline" className="text-xs">{h.fromStatus}</Badge>
                            <span className="text-xs text-muted-foreground">→</span>
                          </>
                        )}
                        <Badge variant={STATUS_BADGES[h.toStatus]?.variant || "secondary"} className={`text-xs ${STATUS_BADGES[h.toStatus]?.color || ""}`}>
                          {STATUS_BADGES[h.toStatus]?.label || h.toStatus}
                        </Badge>
                      </div>
                      {h.notes && <p className="text-sm mt-1">{h.notes}</p>}
                      <p className="text-xs text-muted-foreground mt-1">
                        {h.changedAt ? format(new Date(h.changedAt), "MMM d, yyyy h:mm a") : ""}
                        {h.changedBy && ` • ${formatActor(h.changedBy, relatedUsers)}`}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
      </div>{/* end main column */}

      {/* ── Quick Actions Side Rail (Phase 2) ── */}
      <div className="w-full md:w-64 shrink-0 space-y-3">
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-sm">Quick actions</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-2">
            {/* Physical actions */}

            {/* Send to vendor (draft or approved only — matches server state machine) */}
            {canSendPoToVendor && isSoloMode && (
              <Button
                className="w-full justify-start"
                size="sm"
                onClick={() => sendToVendorMutation.mutate()}
                disabled={sendToVendorMutation.isPending}
              >
                <Send className="h-3.5 w-3.5 mr-2" />
                Send to vendor
              </Button>
            )}

            {/* Mark acknowledged (sent) */}
            {canAcknowledgePo && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => setShowAckDialog(true)}
              >
                <CheckCircle className="h-3.5 w-3.5 mr-2" />
                Mark acknowledged
              </Button>
            )}

            {/* Mark shipped */}
            {canMarkPoShipped && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => markShippedMutation.mutate()}
                disabled={markShippedMutation.isPending}
              >
                <Truck className="h-3.5 w-3.5 mr-2" />
                {markShippedMutation.isPending ? "Marking..." : "Mark shipped"}
              </Button>
            )}

            {/* Mark in transit */}
            {canMarkPoInTransit && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => markInTransitMutation.mutate()}
                disabled={markInTransitMutation.isPending}
              >
                <Ship className="h-3.5 w-3.5 mr-2" />
                {markInTransitMutation.isPending ? "Marking..." : "Mark in transit"}
              </Button>
            )}

            {/* Mark arrived */}
            {canMarkPoArrived && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => markArrivedMutation.mutate()}
                disabled={markArrivedMutation.isPending}
              >
                <Package className="h-3.5 w-3.5 mr-2" />
                {markArrivedMutation.isPending ? "Marking..." : "Mark arrived"}
              </Button>
            )}

            {/* Create shipment.
                Visible whenever the PO has been sent and is not terminal.
                Pre-sent POs (draft / pending_approval / approved) don't
                need shipments yet — the shipment represents in-flight goods.
                Cancelled / closed POs are terminal. */}
            {["sent", "acknowledged", "shipped", "in_transit", "arrived", "receiving"].includes(po.physicalStatus ?? "") &&
              !["cancelled", "closed"].includes(po.physicalStatus ?? "") && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => setShowCreateShipmentDialog(true)}
              >
                <Package className="h-3.5 w-3.5 mr-2" />
                Create shipment
              </Button>
            )}

            {/* Create receipt */}
            {canCreateReceiptForPo && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => setShowReceivePicker(true)}
              >
                <Truck className="h-3.5 w-3.5 mr-2" />
                Receive
              </Button>
            )}

            {/* Cancel PO */}
            {canCancelPo &&
              po.financialStatus === "unbilled" &&
              !["closed", "cancelled"].includes(po.status) && (
              <Button
                className="w-full justify-start text-red-600 hover:text-red-700"
                variant="ghost"
                size="sm"
                onClick={() => setShowCancelDialog(true)}
              >
                <Ban className="h-3.5 w-3.5 mr-2" />
                Cancel PO
              </Button>
            )}

            {/* Financial: Add invoice */}
            {["unbilled", "invoiced"].includes(po.financialStatus ?? "") &&
              ["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(po.status) && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={async () => {
                  let invoiceNumber = "";
                  try {
                    const r = await fetch("/api/vendor-invoices/next-number");
                    if (r.ok) invoiceNumber = (await r.json()).invoiceNumber;
                  } catch {}
                  setInvoiceForm({
                    invoiceNumber,
                    amountDollars: ((Number(po.totalCents) || 0) / 100).toString(),
                    invoiceDate: new Date().toISOString().slice(0, 10),
                    dueDate: "",
                    notes: "",
                  });
                  setShowCreateInvoiceDialog(true);
                }}
              >
                <FileText className="h-3.5 w-3.5 mr-2" />
                Add invoice
              </Button>
            )}

            {/* Financial: Record payment */}
            {["invoiced", "partially_paid"].includes(po.financialStatus ?? "") && (
              <>
                <Button
                  className="w-full justify-start"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // Pre-fill from the first unpaid invoice; guard if none exist
                    const unpaidInvoices = invoicesData?.invoices?.filter((i: any) => i.balanceCents > 0) ?? [];
                    if (unpaidInvoices.length === 0) {
                      // invoicesData might not be loaded yet (tab not visited) — open the
                      // dialog anyway and let the user select; it will validate on submit.
                      setShowPaymentDialog(true);
                      return;
                    }
                    const first = unpaidInvoices[0];
                    setPayment(p => ({
                      ...p,
                      invoiceId: first.id,
                      amountDollars: (first.balanceCents / 100).toFixed(2),
                    }));
                    setShowPaymentDialog(true);
                  }}
                >
                  <DollarSign className="h-3.5 w-3.5 mr-2" />
                  Record payment
                </Button>
                {/* Fallback link for users who want the full AP payments list */}
                <button
                  className="w-full text-left text-xs text-muted-foreground underline-offset-2 hover:underline px-1"
                  onClick={() => navigate("/ap-payments")}
                >
                  View all payments →
                </button>
              </>
            )}

            {/* Fallback: no actions available */}
            {po.physicalStatus === "received" &&
              po.financialStatus === "paid" && (
              <p className="text-xs text-muted-foreground text-center py-2">
                All done — PO fully received and paid.
              </p>
            )}
          </CardContent>
        </Card>
      </div>{/* end side rail */}
      </div>{/* end grid wrapper */}

      {/* Quote-aware line pricing editor. Quantity and price are edited
          together because their relationship depends on the vendor's basis. */}
      <Dialog
        open={editingPricingLine != null}
        onOpenChange={(open) => {
          if (!open && !updateLineMutation.isPending) closePricingEdit();
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Vendor Quote</DialogTitle>
            <DialogDescription>
              Update the quantity in the same basis the supplier quoted. Echelon will derive the normalized per-piece cost and exact line total.
            </DialogDescription>
          </DialogHeader>

          {editingPricingLine && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <div className="font-medium">
                  {editingPricingLine.sku || `Line ${editingPricingLine.lineNumber}`}
                  {editingPricingLine.productName ? ` — ${editingPricingLine.productName}` : ""}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Stored vendor quote: {formatStoredLineQuote(editingPricingLine)}
                </div>
              </div>

              <PoLinePricingEditor
                value={editLinePricing}
                onChange={(next) => {
                  setEditLinePricing(next);
                  if (editRequiresLegacyConfirmation) {
                    setLegacyPricingConfirmed(false);
                  }
                }}
                receiveConfiguration={{
                  label: editingPricingLine.sku || "Selected receiving configuration",
                  unitsPerVariant:
                    editingPricingLine.expectedReceiveUnitsPerVariant ||
                    editingPricingLine.unitsPerUom ||
                    1,
                }}
              />
              <PoLineQuoteMetadataEditor
                value={editLineQuoteMetadata}
                onChange={setEditLineQuoteMetadata}
              />

              {editRequiresLegacyConfirmation && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-3 text-sm text-amber-950">
                  <p>
                    This legacy line stores only a normalized unit cost; it does not record how the vendor quoted it. Verify the original quote, choose the correct basis above, and confirm before saving.
                  </p>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="confirmLegacyLinePricing"
                      checked={legacyPricingConfirmed}
                      onCheckedChange={(checked) => setLegacyPricingConfirmed(checked === true)}
                    />
                    <label htmlFor="confirmLegacyLinePricing" className="cursor-pointer leading-5">
                      I verified the vendor quote and confirm the basis, quantity, and amount entered above.
                    </label>
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Saving records this as an operator-confirmed manual quote. Existing quote reference and validity metadata remain attached to the line.
              </p>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={closePricingEdit}
                  disabled={updateLineMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={savePricingEdit}
                  disabled={
                    !editLinePricingEvaluation.pricing ||
                    !editLineQuoteMetadataEvaluation.metadata ||
                    (editRequiresLegacyConfirmation && !legacyPricingConfirmed) ||
                    updateLineMutation.isPending
                  }
                >
                  {updateLineMutation.isPending ? "Saving..." : "Save Quote & Quantity"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Add Line Dialog ── */}
      <Dialog open={showAddLineDialog} onOpenChange={(open) => {
        setShowAddLineDialog(open);
        if (!open) {
          setProductSearch("");
          setSelectedProductForLine(null);
          setLinePricing(createEmptyPoLinePricingDraft());
          setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
          setSaveToVendorCatalog(true);
          setSetAsPreferred(false);
          setNewLine(createEmptyNewLine());
          setCatalogSearch("");
          setSelectedCatalogEntry(null);
          setCatalogPricingUntouched(false);
          setAddLineMode("catalog");
        }
      }}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
          <style>{`.add-line-scroll [data-radix-popper-content-wrapper] { z-index: 9999 !important; }`}</style>
          <DialogHeader>
            <DialogTitle>Add Line Item</DialogTitle>
            <DialogDescription>
              {addLineMode === "catalog"
                ? "Select from this supplier's catalog, or search all products."
                : "Search all products. You can save new items to the supplier's catalog."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto flex-1 pr-1 add-line-scroll">

            {/* Mode toggle — only when PO has a vendor */}
            {po.vendorId && (
              <div className="flex rounded-lg border p-0.5 gap-0.5 bg-muted/30">
                <Button
                  variant={addLineMode === "catalog" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={() => {
                    setAddLineMode("catalog");
                    setSelectedProductForLine(null);
                    setSelectedCatalogEntry(null);
                    setCatalogPricingUntouched(false);
                    setNewLine(createEmptyNewLine());
                    setLinePricing(createEmptyPoLinePricingDraft());
                    setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                  }}
                >
                  Supplier Catalog{vendorCatalog.length > 0 ? ` (${vendorCatalog.length})` : ""}
                </Button>
                <Button
                  variant={addLineMode === "search" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={() => {
                    setAddLineMode("search");
                    setSelectedCatalogEntry(null);
                    setCatalogPricingUntouched(false);
                    setNewLine(createEmptyNewLine());
                    setLinePricing(createEmptyPoLinePricingDraft());
                    setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                    setSelectedProductForLine(null);
                  }}
                >
                  All Products
                </Button>
              </div>
            )}

            {/* ── CATALOG MODE ── */}
            {addLineMode === "catalog" && po.vendorId && (
              <>
                {selectedCatalogEntry ? (
                  /* Selected catalog entry chip */
                  <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted border">
                    <div className="flex-1 min-w-0">
                      {(() => {
                        const product = products.find((p: any) => p.id === selectedCatalogEntry.productId);
                        const variant = product?.variants?.find((v: any) => v.id === selectedCatalogEntry.productVariantId);
                        return (
                          <>
                            <div className="font-medium text-sm truncate">
                              {product?.name || selectedCatalogEntry.vendorProductName || `Product #${selectedCatalogEntry.productId}`}
                            </div>
                            {variant && (
                              <div className="text-xs text-muted-foreground font-mono">{variant.sku} — {variant.name}</div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => {
                        setSelectedCatalogEntry(null);
                        setCatalogPricingUntouched(false);
                        setSelectedProductForLine(null);
                        setNewLine(createEmptyNewLine());
                        setLinePricing(createEmptyPoLinePricingDraft());
                        setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                      }}
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  /* Catalog picker list */
                  <>
                    <div className="space-y-2">
                      <Input
                        placeholder="Filter supplier catalog..."
                        value={catalogSearch}
                        onChange={e => setCatalogSearch(e.target.value)}
                        className="h-9"
                      />
                    </div>
                    {catalogLoading ? (
                      <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
                        Loading catalog...
                      </div>
                    ) : vendorCatalog.length === 0 ? (
                      <div className="rounded-md border p-4 text-center text-sm text-muted-foreground space-y-2">
                        <Package className="h-6 w-6 mx-auto opacity-30" />
                        <p>No catalog entries for this supplier yet.</p>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => setAddLineMode("search")}
                        >
                          Search all products →
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-md border divide-y max-h-52 overflow-y-auto">
                        {vendorCatalog
                          .filter((entry: any) => {
                            if (!catalogSearch) return true;
                            const s = catalogSearch.toLowerCase();
                            const product = products.find((p: any) => p.id === entry.productId);
                            const variant = product?.variants?.find((v: any) => v.id === entry.productVariantId);
                            return (
                              product?.name?.toLowerCase().includes(s) ||
                              entry.vendorSku?.toLowerCase().includes(s) ||
                              entry.vendorProductName?.toLowerCase().includes(s) ||
                              variant?.sku?.toLowerCase().includes(s) ||
                              product?.sku?.toLowerCase().includes(s)
                            );
                          })
                          .map((entry: any) => {
                            const product = products.find((p: any) => p.id === entry.productId);
                            const variant = product?.variants?.find((v: any) => v.id === entry.productVariantId);
                            const quoteStatus = vendorCatalogQuoteStatus(entry);
                            return (
                              <button
                                key={entry.id}
                                type="button"
                                className="w-full text-left p-2.5 hover:bg-muted/50 transition-colors"
                                onClick={() => {
                                  setSelectedCatalogEntry(entry);
                                  setCatalogPricingUntouched(
                                    isVendorCatalogQuoteReusable(entry),
                                  );
                                  setSelectedProductForLine(product || null);
                                  setNewLine(prev => ({
                                    ...prev,
                                    productId: entry.productId,
                                    productVariantId: entry.productVariantId || 0,
                                    expectedReceiveVariantId: entry.productVariantId || 0,
                                    expectedReceiveUnitsPerVariant: variant?.unitsPerVariant || 1,
                                    vendorSku: entry.vendorSku || "",
                                    unitsPerUom: variant?.unitsPerVariant || 1,
                                  }));
                                  setLinePricing(createVendorCatalogPricingDraft(entry));
                                  setLineQuoteMetadata(createPoLineQuoteMetadataDraftFromStored(entry));
                                  setSaveToVendorCatalog(false);
                                }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="font-medium text-sm truncate">
                                      {product?.name || entry.vendorProductName || `Product #${entry.productId}`}
                                    </div>
                                    <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5 flex-wrap">
                                      {variant && <span className="font-mono">{variant.sku}</span>}
                                      {entry.vendorSku && <span>· {entry.vendorSku}</span>}
                                      {entry.pricingBasis === "per_purchase_uom" && (
                                        <span>
                                          · {entry.piecesPerPurchaseUom || entry.packSize || 1} pcs/{entry.purchaseUom || "purchase UOM"}
                                        </span>
                                      )}
                                      {(variant?.unitsPerVariant || 1) > 1 && (
                                        <span>· Receive as {variant.unitsPerVariant} pcs/config</span>
                                      )}
                                      {entry.moq > 1 && <span>· MOQ {entry.moq}</span>}
                                      {(!entry.pricingBasis || entry.pricingBasis === "legacy_unknown") && (
                                        <span className="text-amber-700">· Verify legacy price</span>
                                      )}
                                      {quoteStatus !== "usable" && quoteStatus !== "legacy" && (
                                        <span className="text-amber-700">· Quote review required</span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="text-sm font-mono font-medium">
                                      {formatVendorCatalogQuote(entry)}
                                    </div>
                                    {entry.isPreferred ? (
                                      <div className="text-xs text-green-600">Preferred</div>
                                    ) : null}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </>
                )}

                {/* If catalog entry has no variant set, show variant picker */}
                {selectedCatalogEntry && !selectedCatalogEntry.productVariantId && selectedProductForLine && (
                  <div className="space-y-2">
                    <Label>Receive As *</Label>
                    <Popover open={variantOpen} onOpenChange={setVariantOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                          <span className="truncate">{selectedVariant
                            ? `${selectedVariant.sku} — ${selectedVariant.name}`
                            : "Select variant..."}</span>
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                        <Command>
                          <CommandList>
                            <CommandEmpty>No variants available.</CommandEmpty>
                            <CommandGroup>
                              {(selectedProductForLine.variants || []).map((v: any) => (
                                <CommandItem
                                  key={v.id}
                                  value={String(v.id)}
                                  onSelect={() => {
                                    setNewLine(prev => ({
                                      ...prev,
                                      productVariantId: v.id,
                                      expectedReceiveVariantId: v.id,
                                      expectedReceiveUnitsPerVariant: v.unitsPerVariant || 1,
                                      unitsPerUom: v.unitsPerVariant || 1,
                                    }));
                                    setVariantOpen(false);
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${selectedReceiveVariantId === v.id ? "opacity-100" : "opacity-0"}`} />
                                  <span className="font-mono text-xs mr-2">{v.sku}</span>
                                  <span className="truncate">{v.name}</span>
                                  {(v.unitsPerVariant || 1) > 1 && (
                                    <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs/config</span>
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
              </>
            )}

            {/* ── SEARCH MODE ── */}
            {(addLineMode === "search" || !po.vendorId) && (
              <>
                <div className="space-y-2">
                  <Label>Product *</Label>
                  <Popover open={productOpen} onOpenChange={setProductOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                        <span className="truncate">{selectedProductForLine ? selectedProductForLine.name : "Search product..."}</span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                      <Command shouldFilter={false}>
                        <CommandInput placeholder="Search name or SKU..." value={productSearch} onValueChange={setProductSearch} />
                        <CommandList>
                          <CommandEmpty>No products found.</CommandEmpty>
                          <CommandGroup>
                            {filteredProducts.map((p: any) => (
                              <CommandItem
                                key={p.id}
                                value={String(p.id)}
                                onSelect={() => {
                                  setSelectedProductForLine(p);
                                  setLinePricing(createEmptyPoLinePricingDraft());
                                  setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                                  setNewLine(prev => ({
                                    ...prev,
                                    productId: p.id,
                                    productVariantId: 0,
                                    expectedReceiveVariantId: 0,
                                    expectedReceiveUnitsPerVariant: 1,
                                    unitsPerUom: 1,
                                    vendorSku: "",
                                  }));
                                  setProductOpen(false);
                                  setProductSearch("");
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${selectedProductForLine?.id === p.id ? "opacity-100" : "opacity-0"}`} />
                                <span className="font-mono text-xs mr-2 text-muted-foreground">{p.sku}</span>
                                <span className="truncate">{p.name}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                {selectedProductForLine && (
                  <div className="space-y-2">
                    <Label>Receive As *</Label>
                    <Popover open={variantOpen} onOpenChange={setVariantOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                          <span className="truncate">{selectedVariant
                            ? `${selectedVariant.sku} — ${selectedVariant.name}`
                            : "Select variant..."}</span>
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                        <Command>
                          <CommandList>
                            <CommandEmpty>No variants available.</CommandEmpty>
                            <CommandGroup>
                              {(selectedProductForLine.variants || []).map((v: any) => (
                                <CommandItem
                                  key={v.id}
                                  value={String(v.id)}
                                  onSelect={() => {
                                    setNewLine(prev => ({
                                      ...prev,
                                      productVariantId: v.id,
                                      expectedReceiveVariantId: v.id,
                                      expectedReceiveUnitsPerVariant: v.unitsPerVariant || 1,
                                      unitsPerUom: v.unitsPerVariant || 1,
                                    }));
                                    setVariantOpen(false);
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${selectedReceiveVariantId === v.id ? "opacity-100" : "opacity-0"}`} />
                                  <span className="font-mono text-xs mr-2">{v.sku}</span>
                                  <span className="truncate">{v.name}</span>
                                  {(v.unitsPerVariant || 1) > 1 && (
                                    <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs/config</span>
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
              </>
            )}

            {/* ── COMMON FIELDS — shown once a variant is selected ── */}
            {selectedReceiveVariantId > 0 && (
              <>
                <Separator />
                <PoLinePricingEditor
                  value={linePricing}
                  onChange={(next) => {
                    setLinePricing(next);
                    setCatalogPricingUntouched(false);
                  }}
                  receiveConfiguration={{
                    label: selectedVariant
                      ? `${selectedVariant.sku} — ${selectedVariant.name}`
                      : "Selected product configuration",
                    unitsPerVariant: receiveUnitsPerVariant,
                  }}
                />
                <PoLineQuoteMetadataEditor
                  value={lineQuoteMetadata}
                  onChange={(next) => {
                    setLineQuoteMetadata(next);
                    setCatalogPricingUntouched(false);
                  }}
                />
                {selectedCatalogEntry && (!selectedCatalogEntry.pricingBasis || selectedCatalogEntry.pricingBasis === "legacy_unknown") && (
                  <p className="text-xs text-amber-700">
                    This legacy catalog price has no verified quote basis. Confirm it before adding; the line will be recorded as manual pricing.
                  </p>
                )}

                <div className="space-y-2">
                  <Label>Vendor SKU</Label>
                  <Input
                    value={newLine.vendorSku}
                    onChange={e => setNewLine(prev => ({ ...prev, vendorSku: e.target.value }))}
                    placeholder="Vendor's catalog number"
                    className="h-10"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="saveToVendorCatalog"
                      checked={saveToVendorCatalog && linePricing.basis !== "extended_total"}
                      onCheckedChange={(v) => setSaveToVendorCatalog(!!v)}
                      disabled={linePricing.basis === "extended_total"}
                    />
                    <label htmlFor="saveToVendorCatalog" className="text-sm cursor-pointer select-none">
                      {selectedCatalogEntry ? "Update vendor catalog with new cost" : "Save to vendor catalog"}
                    </label>
                  </div>
                  {saveToVendorCatalog && linePricing.basis !== "extended_total" && (
                    <>
                      {catalogQuoteDateMissing && (
                        <p className="text-xs text-amber-700 ml-6" role="alert">
                          Enter a quote date to save this reusable catalog price, or uncheck
                          {" "}“{selectedCatalogEntry ? "Update vendor catalog with new cost" : "Save to vendor catalog"}”
                          {" "}to add the line to this PO only.
                        </p>
                      )}
                      <div className="flex items-center gap-2 ml-6">
                        <Checkbox
                          id="setAsPreferred"
                          checked={setAsPreferred}
                          onCheckedChange={(v) => setSetAsPreferred(!!v)}
                        />
                        <label htmlFor="setAsPreferred" className="text-sm cursor-pointer select-none text-muted-foreground">
                          Set as preferred vendor for this product
                        </label>
                      </div>
                    </>
                  )}
                  {linePricing.basis === "extended_total" && (
                    <p className="text-xs text-muted-foreground ml-6">
                      A quoted total is specific to this quantity and will remain on this PO rather than becoming a reusable catalog price.
                    </p>
                  )}
                </div>
              </>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAddLineDialog(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  const pricing = linePricingEvaluation.pricing;
                  const quoteMetadata = lineQuoteMetadataEvaluation.metadata;
                  if (!pricing || !quoteMetadata || !po.updatedAt || catalogQuoteDateMissing) return;
                  addLineMutation.mutate({
                    productId: newLine.productId,
                    expectedReceiveVariantId: selectedReceiveVariantId,
                    expectedReceiveUnitsPerVariant: receiveUnitsPerVariant,
                    vendorProductId: selectedCatalogEntry?.id,
                    vendorSku: newLine.vendorSku || undefined,
                    description: newLine.description || undefined,
                    pricingSource: selectedCatalogEntry && catalogPricingUntouched
                      ? "vendor_catalog"
                      : "manual",
                    pricing,
                    ...populatedPoLineQuoteMetadata(quoteMetadata),
                    expectedPoUpdatedAt: po.updatedAt,
                  });
                }}
                disabled={!selectedReceiveVariantId || !linePricingEvaluation.pricing || !lineQuoteMetadataEvaluation.metadata || catalogQuoteDateMissing || !po.updatedAt || addLineMutation.isPending || catalogUpsertMutation.isPending}
              >
                {addLineMutation.isPending ? "Adding..." : "Add Line"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Cancel Dialog ── */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-red-500" />
              {["sent", "acknowledged"].includes(po.status) ? "Void" : "Cancel"} Purchase Order
            </DialogTitle>
            <DialogDescription>This action cannot be undone. Please provide a reason.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="Why is this PO being cancelled?"
                rows={3}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCancelDialog(false)}>Back</Button>
              <Button
                variant="destructive"
                onClick={() => cancelMutation.mutate(cancelReason)}
                disabled={!cancelReason.trim() || cancelMutation.isPending}
              >
                {cancelMutation.isPending ? "Cancelling..." : "Confirm Cancel"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delivery Schedule Dialog ── */}
      <Dialog open={showScheduleDialog} onOpenChange={setShowScheduleDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delivery Schedule</DialogTitle>
            <DialogDescription>Update requested and vendor-confirmed delivery dates.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Requested Delivery Date</Label>
              <Input
                type="date"
                min={scheduleMinimumDate || undefined}
                value={scheduleData.expectedDeliveryDate}
                onChange={event => setScheduleData(previous => ({
                  ...previous,
                  expectedDeliveryDate: event.target.value,
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Vendor Confirmed Delivery Date</Label>
              <Input
                type="date"
                min={scheduleMinimumDate || undefined}
                value={scheduleData.confirmedDeliveryDate}
                disabled={!canSetConfirmedDelivery}
                onChange={event => setScheduleData(previous => ({
                  ...previous,
                  confirmedDeliveryDate: event.target.value,
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Change Note</Label>
              <Textarea
                value={scheduleData.notes}
                onChange={event => setScheduleData(previous => ({ ...previous, notes: event.target.value }))}
                placeholder="Reason for the schedule correction"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowScheduleDialog(false)}>Cancel</Button>
              <Button
                onClick={() => updateScheduleMutation.mutate(scheduleData)}
                disabled={updateScheduleMutation.isPending}
              >
                {updateScheduleMutation.isPending ? "Saving..." : "Save Schedule"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Acknowledge Dialog ── */}
      <Dialog open={showAckDialog} onOpenChange={setShowAckDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Vendor Acknowledgment</DialogTitle>
            <DialogDescription>Record the vendor's acknowledgment of this PO.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor Reference #</Label>
              <Input
                value={ackData.vendorRefNumber}
                onChange={e => setAckData(prev => ({ ...prev, vendorRefNumber: e.target.value }))}
                placeholder="Vendor's order confirmation number"
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label>Confirmed Delivery Date</Label>
              <Input
                type="date"
                min={scheduleMinimumDate || undefined}
                value={ackData.confirmedDeliveryDate}
                onChange={e => setAckData(prev => ({ ...prev, confirmedDeliveryDate: e.target.value }))}
                className="h-10"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAckDialog(false)}>Cancel</Button>
              <Button
                onClick={() => acknowledgeMutation.mutate(ackData)}
                disabled={acknowledgeMutation.isPending}
              >
                {acknowledgeMutation.isPending ? "Saving..." : "Record Acknowledgment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── PO Document Dialog ── */}
      <Dialog open={showDocDialog} onOpenChange={(open) => { setShowDocDialog(open); if (!open) setDocHtml(null); }}>
        <DialogContent className="max-w-4xl w-[95vw] h-[90vh] flex flex-col p-0">
          <DialogHeader className="px-6 py-4 border-b flex-row items-center justify-between space-y-0">
            <DialogTitle className="text-base font-semibold">
              Purchase Order — {po?.poNumber}
            </DialogTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                setEmailForm(f => ({ ...f, toEmail: po?.vendor?.email || po?.vendorContactEmail || "" }));
                setShowEmailDialog(true);
              }}>
                <Mail className="h-4 w-4 mr-2" />
                Email to Vendor
              </Button>
              <Button size="sm" onClick={() => {
                const iframe = document.getElementById("po-doc-iframe") as HTMLIFrameElement | null;
                iframe?.contentWindow?.print();
              }}>
                <Printer className="h-4 w-4 mr-2" />
                Print
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            {docLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
              </div>
            ) : docHtml ? (
              <iframe
                id="po-doc-iframe"
                srcDoc={docHtml}
                className="w-full h-full border-0"
                title="PO Document"
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Email to Vendor Dialog ── */}
      <Dialog open={showEmailDialog} onOpenChange={setShowEmailDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Email PO to Vendor</DialogTitle>
            <DialogDescription>
              Send <span className="font-mono font-medium">{po?.poNumber}</span> to the vendor. The full PO document will be included in the email body.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>To *</Label>
              <Input
                type="email"
                placeholder="vendor@example.com"
                value={emailForm.toEmail}
                onChange={(e) => setEmailForm(f => ({ ...f, toEmail: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>CC <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                type="email"
                placeholder="cc@example.com"
                value={emailForm.ccEmail}
                onChange={(e) => setEmailForm(f => ({ ...f, ccEmail: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Message <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Textarea
                placeholder="Add a personal note to the vendor..."
                rows={3}
                value={emailForm.message}
                onChange={(e) => setEmailForm(f => ({ ...f, message: e.target.value }))}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowEmailDialog(false)}>Cancel</Button>
              <Button
                disabled={!emailForm.toEmail || emailSending}
                onClick={async () => {
                  setEmailSending(true);
                  try {
                    const res = await fetch(`/api/purchase-orders/${poId}/send-email`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        toEmail: emailForm.toEmail,
                        ccEmail: emailForm.ccEmail || undefined,
                        message: emailForm.message || undefined,
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error);
                    toast({ title: "Email sent", description: `PO sent to ${emailForm.toEmail}` });
                    setShowEmailDialog(false);
                    queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/history`] });
                  } catch (err: any) {
                    toast({ title: "Failed to send", description: err.message, variant: "destructive" });
                  } finally {
                    setEmailSending(false);
                  }
                }}
              >
                {emailSending ? "Sending..." : "Send Email"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Create Invoice from PO Dialog ── */}
      <Dialog open={showCreateInvoiceDialog} onOpenChange={setShowCreateInvoiceDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Invoice from PO</DialogTitle>
            <DialogDescription>
              Pre-filled from {po?.poNumber}. Edit any field before creating.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Vendor</Label>
              <div className="text-sm font-medium p-2 bg-muted rounded-md">{po?.vendor?.name || `Vendor #${po?.vendorId}`}</div>
            </div>
            <div className="space-y-2">
              <Label>Invoice Number *</Label>
              <Input
                value={invoiceForm.invoiceNumber}
                onChange={(e) => setInvoiceForm(f => ({ ...f, invoiceNumber: e.target.value }))}
                placeholder="INV-..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Invoice Date</Label>
                <Input
                  type="date"
                  value={invoiceForm.invoiceDate}
                  onChange={(e) => setInvoiceForm(f => ({ ...f, invoiceDate: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Due Date</Label>
                <Input
                  type="date"
                  value={invoiceForm.dueDate}
                  onChange={(e) => setInvoiceForm(f => ({ ...f, dueDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Input
                value={invoiceForm.notes}
                onChange={(e) => setInvoiceForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes"
              />
            </div>
            <div className="p-2 bg-muted/50 rounded text-xs text-muted-foreground">
              This invoice will be linked to {po?.poNumber} and PO line items will be auto-imported.
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreateInvoiceDialog(false)}>Cancel</Button>
              <Button
                onClick={() => createInvoiceMutation.mutate()}
                disabled={createInvoiceMutation.isPending || !invoiceForm.invoiceNumber.trim()}
              >
                {createInvoiceMutation.isPending ? "Creating..." : "Create Invoice"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* ═══════ Receive — choose a source ═══════ */}
      <Dialog open={showReceivePicker} onOpenChange={setShowReceivePicker}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Truck className="h-5 w-5" /> Receive {po.poNumber}</DialogTitle>
            <DialogDescription>
              Choose where these goods are coming from. Receiving against a shipment carries its freight onto the received lots.
            </DialogDescription>
          </DialogHeader>
          {(() => {
            if (receiveOptionsLoading) {
              return <div className="py-6 text-center text-sm text-muted-foreground">Checking receive options...</div>;
            }
            const shipmentOptions = receiveOptions?.shipmentOptions ?? [];
            const receivableShipments = shipmentOptions.filter((s: any) => s.receivable);
            const blockedShipments = shipmentOptions.filter((s: any) => !s.receivable);
            const poDirect = receiveOptions?.poDirect ?? { allowed: true, warning: "No receive options loaded." };
            const busy =
              createReceiptMutation.isPending ||
              createReceiptFromShipmentMutation.isPending ||
              cleanupEmptyShipmentReceiptMutation.isPending ||
              voidZeroPostShipmentReceiptMutation.isPending ||
              checkingShipmentReceiptPacks;
            const renderBlockedShipment = (s: any) => {
              const cleaningThisReceipt =
                cleanupEmptyShipmentReceiptMutation.isPending &&
                cleanupEmptyShipmentReceiptMutation.variables?.receiptId === s.existingReceiptId;
              const voidingThisReceipt =
                voidZeroPostShipmentReceiptMutation.isPending &&
                voidZeroPostShipmentReceiptMutation.variables?.receiptId === s.existingReceiptId;
              return (
                <div key={s.shipmentId} className="rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="font-mono text-sm font-medium flex items-center gap-1.5">
                        <Ship className="h-4 w-4 text-amber-700" /> {s.shipmentNumber || `Shipment #${s.shipmentId}`}
                      </div>
                      <div className="mt-1 text-xs text-amber-800">
                        {s.reason || "This shipment is blocked from receiving."}
                      </div>
                    </div>
                    {s.action === "repair_empty_receipt" && s.existingReceiptId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => cleanupEmptyShipmentReceiptMutation.mutate({
                          receiptId: s.existingReceiptId,
                          shipmentId: s.shipmentId,
                          purchaseOrderId: s.purchaseOrderId,
                        })}
                      >
                        {cleaningThisReceipt ? "Cleaning..." : "Clean up and continue"}
                      </Button>
                    ) : s.action === "void_zero_post_receipt" && s.existingReceiptId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => voidZeroPostShipmentReceiptMutation.mutate({
                          receiptId: s.existingReceiptId,
                          shipmentId: s.shipmentId,
                          purchaseOrderId: s.purchaseOrderId,
                        })}
                      >
                        {voidingThisReceipt ? "Voiding..." : "Void and continue"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            };
            return (
              <div className="space-y-3">
                {receivableShipments.length > 0 ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      This PO has {receivableShipments.length} shipment{receivableShipments.length > 1 ? "s" : ""} ready to receive:
                    </p>
                    {receivableShipments.map((s: any) => (
                      <div key={s.shipmentId} className="flex items-center justify-between gap-3 rounded-lg border-2 border-blue-200 bg-blue-50/50 p-3">
                        <div className="min-w-0">
                          <div className="font-mono text-sm font-medium flex items-center gap-1.5">
                            <Ship className="h-4 w-4 text-blue-600" /> {s.shipmentNumber || `Shipment #${s.shipmentId}`}
                          </div>
                          <div className="text-xs text-muted-foreground capitalize">
                            {(s.status || "").replace(/_/g, " ")}
                            {s.actualTotalCostCents ? ` - freight $${(s.actualTotalCostCents / 100).toFixed(2)}` : ""}
                            {s.lineCount ? ` - ${s.lineCount} line${s.lineCount === 1 ? "" : "s"}` : ""}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            if (s.action === "open_existing_receipt" && s.existingReceiptId) {
                              setShowReceivePicker(false);
                              navigate(`/receiving?open=${s.existingReceiptId}`);
                              return;
                            }
                            checkAndReceiveShipment({
                              shipmentId: s.shipmentId,
                              purchaseOrderId: s.purchaseOrderId,
                            });
                          }}
                        >
                          {checkingShipmentReceiptPacks && pendingShipmentReceipt?.shipmentId === s.shipmentId
                            ? "Checking..."
                            : s.action === "open_existing_receipt" ? "Open receipt" : "Receive this shipment"}
                        </Button>
                      </div>
                    ))}
                    {blockedShipments.map(renderBlockedShipment)}
                    <div className="rounded-lg border p-3">
                      <div className="font-medium text-sm flex items-center gap-1.5">
                        <FileText className="h-4 w-4 text-muted-foreground" /> Receive against the PO directly
                      </div>
                      <div className="mt-1 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {poDirect.warning}
                      </div>
                      <Button size="sm" variant="outline" className="mt-2" disabled={busy || !poDirect.allowed} onClick={() => createReceiptMutation.mutate()}>
                        Receive against PO anyway
                      </Button>
                      {!poDirect.allowed && poDirect.reason && (
                        <div className="mt-1 text-xs text-muted-foreground">{poDirect.reason}</div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {blockedShipments.map(renderBlockedShipment)}
                    <div className="rounded-lg border p-3">
                      <div className="font-medium text-sm">Receive against the PO directly</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {blockedShipments.length > 0
                          ? blockedShipments[0].reason
                          : poDirect.warning}
                      </div>
                      <Button size="sm" className="mt-2" disabled={busy || !poDirect.allowed} onClick={() => createReceiptMutation.mutate()}>
                        Receive against PO
                      </Button>
                      {!poDirect.allowed && poDirect.reason && (
                        <div className="mt-1 text-xs text-muted-foreground">{poDirect.reason}</div>
                      )}
                    </div>
                    <div className="text-center">
                      <Button size="sm" variant="ghost" onClick={() => { setShowReceivePicker(false); setShowCreateShipmentDialog(true); }}>
                        <Package className="h-3.5 w-3.5 mr-1.5" /> Create a shipment instead
                      </Button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
      {/* ═══════ Create Shipment Dialog ═══════ */}
      <Dialog open={showCreateShipmentDialog} onOpenChange={(open) => {
        setShowCreateShipmentDialog(open);
        if (!open) { setLineSelections({}); setLineQtyErrors({}); }
      }}>
        <DialogContent className="max-w-2xl relative">
          <DialogHeader>
            <DialogTitle>Create Inbound Shipment</DialogTitle>
            <DialogDescription>Set up shipment details and select PO lines to include in this shipment.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Shipment # (optional — auto-generated if blank)</Label>
              <Input
                value={newShipmentForm.shipmentNumber}
                onChange={(e) => setNewShipmentForm(prev => ({ ...prev, shipmentNumber: e.target.value }))}
                placeholder="e.g. SHP-2026-042"
                className="h-10"
              />
            </div>

            <div className="space-y-2">
              <Label>Mode *</Label>
              <Select value={newShipmentForm.mode} onValueChange={(v) => setNewShipmentForm(prev => ({ ...prev, mode: v }))}>
                <SelectTrigger className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sea_fcl">Sea — FCL</SelectItem>
                  <SelectItem value="sea_lcl">Sea — LCL</SelectItem>
                  <SelectItem value="air">Air</SelectItem>
                  <SelectItem value="ground">Ground</SelectItem>
                  <SelectItem value="ltl">LTL</SelectItem>
                  <SelectItem value="ftl">FTL</SelectItem>
                  <SelectItem value="courier">Courier</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Shipper (Origin Supplier) *</Label>
              {vendorsLoading ? (
                <Button variant="outline" disabled className="w-full justify-between h-10 font-normal">
                  Loading vendors...
                </Button>
              ) : vendorsError ? (
                <div className="space-y-1">
                  <Button variant="outline" disabled className="w-full justify-between h-10 font-normal text-destructive">
                    Error loading vendors
                  </Button>
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => refetchVendors()}>Retry</Button>
                </div>
              ) : vendors.length === 0 ? (
                <div className="space-y-1">
                  <Button variant="outline" disabled className="w-full justify-between h-10 font-normal">
                    No vendors found
                  </Button>
                  <a href="/vendors" className="text-xs text-primary hover:underline">Add a vendor first.</a>
                </div>
              ) : (
                <Popover open={shipperOpen} onOpenChange={setShipperOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      role="combobox"
                      className="w-full justify-between h-10 font-normal"
                    >
                      <span className="truncate">
                        {newShipmentForm.shipperName
                          ? vendors.find(v => v.name === newShipmentForm.shipperName)?.name || newShipmentForm.shipperName
                          : "Select shipper..."}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command shouldFilter={false}>
                      <CommandInput
                        placeholder="Search vendors..."
                        value={shipperSearch}
                        onValueChange={setShipperSearch}
                      />
                      <CommandList>
                        <CommandEmpty>No vendors found.</CommandEmpty>
                        <CommandGroup>
                          {vendors
                            .filter(v => v.name.toLowerCase().includes(shipperSearch.toLowerCase()))
                            .map(v => (
                              <CommandItem
                                key={v.id}
                                value={v.name}
                                onSelect={() => {
                                  setNewShipmentForm(prev => ({ ...prev, shipperName: v.name }));
                                  setShipperOpen(false);
                                  setShipperSearch("");
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${newShipmentForm.shipperName === v.name ? "opacity-100" : "opacity-0"}`} />
                                {v.name}
                              </CommandItem>
                            ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
              <p className="text-xs text-muted-foreground">
                Don't see your supplier? <a href="/vendors" className="text-primary hover:underline">Add a vendor.</a>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Forwarder</Label>
                <Input
                  value={newShipmentForm.forwarderName}
                  onChange={(e) => setNewShipmentForm(prev => ({ ...prev, forwarderName: e.target.value }))}
                  placeholder="e.g. Freightos"
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label>Carrier</Label>
                <Input
                  value={newShipmentForm.carrierName}
                  onChange={(e) => setNewShipmentForm(prev => ({ ...prev, carrierName: e.target.value }))}
                  placeholder="e.g. Maersk"
                  className="h-10"
                />
              </div>
            </div>

            {/* PO Lines Section */}
            <div className="space-y-2 pt-2 border-t">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-base">Lines from this PO</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Selected lines will be added to the new shipment. Adjust quantities or uncheck lines for partial shipments.
                  </p>
                </div>
                {shippableLinesData?.lines && shippableLinesData.lines.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => {
                      const allChecked = shippableLinesData.lines.every((l: any) => lineSelections[l.id]?.checked);
                      const next: Record<number, { checked: boolean; qty: number }> = {};
                      for (const line of shippableLinesData.lines) {
                        const prev = lineSelections[line.id];
                        next[line.id] = {
                          checked: !allChecked,
                          qty: prev?.qty ?? line.remainingQty,
                        };
                      }
                      setLineSelections(next);
                    }}
                  >
                    {shippableLinesData.lines.every((l: any) => lineSelections[l.id]?.checked) ? "Deselect all" : "Select all"}
                  </Button>
                )}
              </div>

              {shippableLinesData?.lines && shippableLinesData.lines.length > 0 ? (
                <div className="max-h-[300px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]"></TableHead>
                        <TableHead>SKU</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="text-right">Ordered</TableHead>
                        <TableHead className="text-right">Shipped</TableHead>
                        <TableHead className="text-right">Remaining</TableHead>
                        <TableHead className="text-right w-[100px]">Qty to ship</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shippableLinesData.lines.map((line: any) => {
                        const sel = lineSelections[line.id] ?? { checked: true, qty: line.remainingQty };
                        const error = lineQtyErrors[line.id];
                        return (
                          <TableRow key={line.id}>
                            <TableCell>
                              <Checkbox
                                checked={sel.checked}
                                onCheckedChange={(checked) => {
                                  setLineSelections(prev => ({
                                    ...prev,
                                    [line.id]: { ...prev[line.id], checked: !!checked },
                                  }));
                                }}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs">{line.sku || "—"}</TableCell>
                            <TableCell className="text-xs text-muted-foreground truncate max-w-[150px]">
                              {line.productName || line.description || "—"}
                            </TableCell>
                            <TableCell className="text-right text-xs">{line.orderQty}</TableCell>
                            <TableCell className="text-right text-xs">{line.alreadyShippedQty}</TableCell>
                            <TableCell className="text-right text-xs">{line.remainingQty}</TableCell>
                            <TableCell>
                              <Input
                                type="number"
                                min={1}
                                max={line.remainingQty}
                                value={sel.qty}
                                disabled={!sel.checked}
                                className={`h-8 text-xs text-right ${error ? "border-destructive" : ""}`}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value, 10) || 0;
                                  setLineSelections(prev => ({
                                    ...prev,
                                    [line.id]: { ...prev[line.id], qty: val },
                                  }));
                                  if (val <= 0) {
                                    setLineQtyErrors(prev => ({ ...prev, [line.id]: "Must be > 0" }));
                                  } else if (val > line.remainingQty) {
                                    setLineQtyErrors(prev => ({ ...prev, [line.id]: `Max ${line.remainingQty}` }));
                                  } else {
                                    setLineQtyErrors(prev => { const next = { ...prev }; delete next[line.id]; return next; });
                                  }
                                }}
                              />
                              {error && <p className="text-[10px] text-destructive mt-0.5">{error}</p>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : showCreateShipmentDialog && shippableLinesData ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  All lines on this PO have been shipped. View shipments below.
                </p>
              ) : null}
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => { setShowCreateShipmentDialog(false); setLineSelections({}); setLineQtyErrors({}); }}>Cancel</Button>
              <Button
                onClick={() => createShipmentMutation.mutate(newShipmentForm)}
                disabled={
                  createShipmentMutation.isPending ||
                  !newShipmentForm.shipperName.trim() ||
                  (shippableLinesData !== undefined && shippableLinesData.lines.length === 0) ||
                  Object.keys(lineQtyErrors).length > 0
                }
              >
                {createShipmentMutation.isPending ? "Creating..." : "Create Shipment"}
              </Button>
              {shippableLinesData !== undefined && shippableLinesData.lines.length === 0 && (
                <p className="text-xs text-muted-foreground absolute -bottom-5 right-0">All lines already shipped — nothing to add.</p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ═══════ Inline Record Payment Dialog ═══════ */}
      {/* Mirrors APInvoiceDetail.tsx paymentMutation/dialog structure. Adds an
          invoice dropdown at the top because the user is acting from PO context
          rather than a specific invoice. */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              {po?.poNumber} — choose an invoice and enter payment details
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Invoice selector — PO context-specific, not present in invoice-level dialog */}
            <div className="space-y-2">
              <Label>Invoice *</Label>
              {(() => {
                const unpaidInvoices = invoicesData?.invoices?.filter((i: any) => i.balanceCents > 0) ?? [];
                if (unpaidInvoices.length === 0) {
                  return (
                    <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm">
                      No unpaid invoices on this PO. Add an invoice first.
                    </div>
                  );
                }
                return (
                  <select
                    className="w-full border rounded-md h-10 px-3 text-sm bg-background"
                    value={payment.invoiceId ?? ""}
                    onChange={(e) => {
                      const inv = unpaidInvoices.find((i: any) => i.id === Number(e.target.value));
                      setPayment(p => ({
                        ...p,
                        invoiceId: inv ? inv.id : null,
                        amountDollars: inv ? (inv.balanceCents / 100).toFixed(2) : p.amountDollars,
                      }));
                    }}
                  >
                    <option value="" disabled>Select invoice…</option>
                    {unpaidInvoices.map((inv: any) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.invoiceNumber} — {formatCents(inv.balanceCents)} due
                      </option>
                    ))}
                  </select>
                );
              })()}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Date *</Label>
                <Input type="date" value={payment.paymentDate} onChange={(e) => setPayment(p => ({ ...p, paymentDate: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Method *</Label>
                <select className="w-full border rounded-md h-10 px-3 text-sm bg-background" value={payment.paymentMethod} onChange={(e) => setPayment(p => ({ ...p, paymentMethod: e.target.value }))}>
                  <option value="ach">ACH</option>
                  <option value="check">Check</option>
                  <option value="wire">Wire</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Amount ($) *</Label>
              <Input type="number" step="0.01" min="0" value={payment.amountDollars} onChange={(e) => setPayment(p => ({ ...p, amountDollars: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Reference # <span className="text-muted-foreground text-xs">(ACH/wire)</span></Label>
                <Input placeholder="Trace / wire ref" value={payment.referenceNumber} onChange={(e) => setPayment(p => ({ ...p, referenceNumber: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Check #</Label>
                <Input placeholder="If paying by check" value={payment.checkNumber} onChange={(e) => setPayment(p => ({ ...p, checkNumber: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Bank Account</Label>
              <Input placeholder="e.g. Chase Operating" value={payment.bankAccountLabel} onChange={(e) => setPayment(p => ({ ...p, bankAccountLabel: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Input placeholder="Optional" value={payment.notes} onChange={(e) => setPayment(p => ({ ...p, notes: e.target.value }))} />
            </div>

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowPaymentDialog(false)}>Cancel</Button>
              <Button
                onClick={() => paymentMutation.mutate()}
                disabled={!payment.amountDollars || !payment.invoiceId || paymentMutation.isPending}
              >
                {paymentMutation.isPending ? "Recording..." : "Record Payment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ShipmentReceiptPackResolutionDialog
        open={!!shipmentReceiptPackResolution}
        onOpenChange={(open) => {
          if (!open) setShipmentReceiptPackResolution(null);
        }}
        resolution={shipmentReceiptPackResolution}
        creating={createReceiptFromShipmentMutation.isPending}
        refreshing={checkingShipmentReceiptPacks}
        onCreateReceipt={createPendingShipmentReceipt}
        onRefresh={refreshShipmentReceiptPackResolution}
        onOpenCatalog={openReceiptVariantSetup}
      />
    </div>
  );
}
