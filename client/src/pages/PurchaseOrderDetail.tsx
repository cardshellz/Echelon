import React from "react";
import {
  dollarsToCents,
  formatMills,
  centsToMills,
} from "@shared/utils/money";
import {
  PO_PHYSICAL_STATUSES,
  PO_FINANCIAL_STATUSES,
} from "@shared/schema/procurement.schema";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
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

// The 4 linear financial stages; 'disputed' shown as warn on partially_paid
const FINANCIAL_TRACK_STAGES = [
  "unbilled",
  "invoiced",
  "partially_paid",
  "paid",
] as const;

type StageState = "done" | "current" | "warn" | "future";

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

export default function PurchaseOrderDetail() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [, params] = useRoute("/purchase-orders/:id");
  const poId = params?.id ? Number(params.id) : null;

  const [activeTab, setActiveTab] = useState("lines");
  const [showAddLineDialog, setShowAddLineDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showAckDialog, setShowAckDialog] = useState(false);
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
  const [showCreateShipmentDialog, setShowCreateShipmentDialog] = useState(false);
  const [newShipmentForm, setNewShipmentForm] = useState({
    mode: "sea_fcl",
    shipmentNumber: "",
    shipperName: "",
    forwarderName: "",
    carrierName: "",
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
  const [editingLineField, setEditingLineField] = useState<"unitCost" | "qty" | "sku" | null>(null);
  const [editLineValue, setEditLineValue] = useState("");
  const [skuVariants, setSkuVariants] = useState<Array<{ id: number; sku: string; name: string; unitsPerVariant: number }>>([]);

  // Add line form
  const [productSearch, setProductSearch] = useState("");
  const [productOpen, setProductOpen] = useState(false);
  const [variantOpen, setVariantOpen] = useState(false);
  const [selectedProductForLine, setSelectedProductForLine] = useState<any>(null);
  const [totalCostDollars, setTotalCostDollars] = useState("");
  const [saveToVendorCatalog, setSaveToVendorCatalog] = useState(true);
  const [setAsPreferred, setSetAsPreferred] = useState(false);
  const [addLineMode, setAddLineMode] = useState<"catalog" | "search">("catalog");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [selectedCatalogEntry, setSelectedCatalogEntry] = useState<any>(null);

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
    forceOverride: false,
  });

  const [newLine, setNewLine] = useState({
    productId: 0,
    productVariantId: 0,
    orderQty: 1,
    unitCostCents: 0,
    unitsPerUom: 1,
    vendorSku: "",
    description: "",
  });

  // Queries
  const { data: po, isLoading } = useQuery<any>({
    queryKey: [`/api/purchase-orders/${poId}`],
    enabled: !!poId,
  });

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
      po?.status === "draft"
    ) {
      navigate(`/purchase-orders/${po.id}/edit`, { replace: true });
    }
  }, [procurementSettings?.useNewPoEditor, po?.id, po?.status, navigate]);

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
  const canEditLines = po && ["draft", "pending_approval", "approved", "sent", "acknowledged", "partially_received"].includes(po.status);
  const isNotCancelled = po && !["cancelled"].includes(po.status);

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

  // Selected variant info for case helper
  const selectedVariant = selectedProductForLine?.variants?.find(
    (v: any) => v.id === newLine.productVariantId
  );
  const casesEquiv = newLine.unitsPerUom > 1 && newLine.orderQty > 0
    ? Math.ceil(newLine.orderQty / newLine.unitsPerUom)
    : null;

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
      const res = await fetch(`/api/purchase-orders/${poId}/create-receipt`, { method: "POST" });
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

  const createInvoiceMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/vendor-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
          forceOverride: payment.forceOverride || undefined,
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
    onSuccess: () => {
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
        forceOverride: false,
      }));
      toast({ title: "Payment recorded" });
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
      vendorSku: string; unitCostCents: number; packSize: number; isPreferred: boolean;
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
    mutationFn: async (data: typeof newLine & { unitCostCents: number }) => {
      const res = await fetch(`/api/purchase-orders/${poId}/lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      // Capture before state reset
      const totalCents = dollarsToCents(totalCostDollars || "0");
      const derivedUnitCostCents = newLine.orderQty > 0 ? totalCents / newLine.orderQty : 0;
      const catalogData = saveToVendorCatalog && po?.vendorId && newLine.productVariantId ? {
        vendorId: po.vendorId,
        productId: newLine.productId,
        productVariantId: newLine.productVariantId,
        vendorSku: newLine.vendorSku,
        unitCostCents: derivedUnitCostCents,
        packSize: newLine.unitsPerUom,
        isPreferred: setAsPreferred,
      } : null;

      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setShowAddLineDialog(false);
      setNewLine({ productId: 0, productVariantId: 0, orderQty: 1, unitCostCents: 0, unitsPerUom: 1, vendorSku: "", description: "" });
      setProductSearch("");
      setSelectedProductForLine(null);
      setTotalCostDollars("");
      setSaveToVendorCatalog(true);
      setSetAsPreferred(false);
      setCatalogSearch("");
      setSelectedCatalogEntry(null);
      toast({ title: "Line added" });

      if (catalogData) catalogUpsertMutation.mutate(catalogData);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (lineId: number) => {
      const res = await fetch(`/api/purchase-orders/lines/${lineId}`, { method: "DELETE" });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
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
    mutationFn: async ({ lineId, updates }: { lineId: number; updates: Record<string, any> }) => {
      const res = await fetch(`/api/purchase-orders/lines/${lineId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}`] });
      setEditingLineId(null);
      setEditingLineField(null);
      setSkuVariants([]);
      toast({ title: "Line updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function startLineEdit(lineId: number, field: "unitCost" | "qty", currentValue: number) {
    setEditingLineId(lineId);
    setEditingLineField(field);
    setEditLineValue(field === "unitCost" ? String(Number(currentValue) / 100) : String(currentValue));
  }

  async function startSkuEdit(line: any) {
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

  function saveSkuEdit(lineId: number, variant: { id: number; sku: string; unitsPerVariant: number }) {
    updateLineMutation.mutate({
      lineId,
      updates: {
        productVariantId: variant.id,
        sku: variant.sku,
        unitsPerUom: variant.unitsPerVariant,
      },
    });
  }

  function saveLineEdit(lineId: number) {
    if (!editingLineField) return;
    const val = parseFloat(editLineValue);
    if (isNaN(val) || val < 0) {
      toast({ title: "Invalid value", variant: "destructive" });
      return;
    }
    const updates = editingLineField === "unitCost"
      ? { unitCostCents: dollarsToCents(editLineValue) }
      : { orderQty: Math.round(val) };
    updateLineMutation.mutate({ lineId, updates });
  }

  function cancelLineEdit() {
    setEditingLineId(null);
    setEditingLineField(null);
    setEditLineValue("");
    setSkuVariants([]);
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
      return res.json();
    },
    onSuccess: (shipment) => {
      queryClient.invalidateQueries({ queryKey: [`/api/purchase-orders/${poId}/shipments`] });
      setShowCreateShipmentDialog(false);
      toast({ title: "Shipment created", description: `${shipment.shipmentNumber} created — add line items on the shipment page` });
      navigate(`/shipments/${shipment.id}`);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

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
                {isNotCancelled && (
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
          </div>
        </div>

        {/* Context-sensitive action buttons */}
        <div className="flex gap-2 flex-wrap w-full sm:w-auto">
          {/* Solo mode: combined "Send to Vendor" button (draft → approved → sent in one click) */}
          {po.status === "draft" && isSoloMode && (
            <Button onClick={() => sendToVendorMutation.mutate()} disabled={sendToVendorMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              {sendToVendorMutation.isPending ? "Submitting..." : "Submit & Send"}
            </Button>
          )}
          {/* Multi-person mode: individual Submit button */}
          {po.status === "draft" && !isSoloMode && (
            <Button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              Submit
            </Button>
          )}
          {po.status === "pending_approval" && (
            <>
              <Button onClick={() => approveMutation.mutate()} disabled={approveMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                <CheckCircle className="h-4 w-4 mr-2" />
                Approve
              </Button>
              <Button variant="outline" onClick={() => returnToDraftMutation.mutate()} disabled={returnToDraftMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
                <RotateCcw className="h-4 w-4 mr-2" />
                Return to Draft
              </Button>
            </>
          )}
          {po.status === "approved" && (
            <Button onClick={() => sendMutation.mutate()} disabled={sendMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Send className="h-4 w-4 mr-2" />
              Mark as Sent
            </Button>
          )}
          {/* Acknowledge button: only shown when acknowledgment is required (multi-person mode) */}
          {po.status === "sent" && requireAcknowledgment && (
            <Button onClick={() => setShowAckDialog(true)} className="flex-1 sm:flex-none min-h-[44px]">
              <CheckCircle className="h-4 w-4 mr-2" />
              Acknowledge
            </Button>
          )}
          {["sent", "acknowledged", "partially_received"].includes(po.status) && (
            <Button variant="outline" onClick={() => createReceiptMutation.mutate()} disabled={createReceiptMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Truck className="h-4 w-4 mr-2" />
              Create Receipt
            </Button>
          )}
          {po.status === "received" && (
            <Button onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending} className="flex-1 sm:flex-none min-h-[44px]">
              <Archive className="h-4 w-4 mr-2" />
              Close PO
            </Button>
          )}
          {!["closed", "cancelled"].includes(po.status) && (
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
              {isNotCancelled && !editingTolerance && (
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
              {isDraft && !editingDiscount && (
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
              {taxApplicable && isNotCancelled && !editingTax && (
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
              {shippingApplicable && isNotCancelled && !editingShipping && (
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
      {po.source === "auto_draft" && (
        <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 flex items-center gap-4 text-sm">
          <span className="text-lg flex-shrink-0">🤖</span>
          <div className="flex-1">
            <strong className="text-amber-700">Auto-Draft</strong>
            <p className="text-muted-foreground text-xs mt-0.5">
              Created by the nightly auto-draft job{po.autoDraftDate ? ` on ${new Date(po.autoDraftDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}. Review quantities and send to vendor when ready.
            </p>
          </div>
        </div>
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
          {isDraft && (
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
                  No lines. {isDraft ? "Add items to this PO." : ""}
                </CardContent>
              </Card>
            ) : (
              lines.map((line: any) => {
                const isEditingCostMobile = editingLineId === line.id && editingLineField === "unitCost";
                const isEditingSkuMobile = editingLineId === line.id && editingLineField === "sku";
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
                                  className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-muted ${v.id === line.productVariantId ? "bg-muted font-bold" : ""}`}
                                  onClick={() => {
                                    if (v.id !== line.productVariantId) {
                                      saveSkuEdit(line.id, v);
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
                            className={`font-mono text-sm ${canEditLines ? "cursor-pointer underline decoration-dotted" : ""}`}
                            onClick={() => canEditLines && startSkuEdit(line)}
                          >
                            {line.sku || "—"}
                          </span>
                          <Badge variant="outline" className="text-xs">{line.status}</Badge>
                        </div>
                        )}
                        <div className="text-sm mt-1 truncate">{line.productName || "—"}</div>
                        <div className="flex gap-4 mt-1 text-xs text-muted-foreground">
                          <span>
                            {(line.unitsPerUom || 1) > 1
                              ? `${(line.orderQty || 0).toLocaleString()} pcs (${Math.ceil((line.orderQty || 0) / (line.unitsPerUom || 1))} cases)`
                              : `Qty: ${line.receivedQty || 0}/${line.orderQty}`}
                          </span>
                          {isEditingCostMobile ? (
                            <span className="flex items-center gap-1">
                              $<Input
                                type="number" min="0" step="0.000001" value={editLineValue}
                                onChange={e => setEditLineValue(e.target.value)}
                                className="h-6 w-20 text-xs font-mono" autoFocus
                                onKeyDown={e => { if (e.key === "Enter") saveLineEdit(line.id); if (e.key === "Escape") cancelLineEdit(); }}
                              />
                              <Button size="sm" className="h-6 px-1" onClick={() => saveLineEdit(line.id)}><Check className="h-3 w-3" /></Button>
                              <Button variant="ghost" size="sm" className="h-6 px-1" onClick={cancelLineEdit}><XCircle className="h-3 w-3" /></Button>
                            </span>
                          ) : (
                            <span
                              className={canEditLines ? "cursor-pointer underline decoration-dotted" : ""}
                              onClick={() => canEditLines && startLineEdit(line.id, "unitCost", line.unitCostCents)}
                            >
                              @ {formatLineUnitCost(line)}/pc
                            </span>
                          )}
                          <span className="font-medium">{formatCents(line.lineTotalCents)}</span>
                        </div>
                      </div>
                      {isDraft && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[44px] min-w-[44px] p-0"
                          onClick={() => { if (confirm("Remove this line?")) deleteLineMutation.mutate(line.id); }}
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
                  {isDraft && <TableHead className="w-12"></TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={isDraft ? 10 : 9} className="text-center text-muted-foreground py-8">
                      No lines. {isDraft ? "Click \"Add Line\" to add items." : ""}
                    </TableCell>
                  </TableRow>
                ) : (
                  lines.map((line: any) => {
                    const isEditingCost = editingLineId === line.id && editingLineField === "unitCost";
                    const isEditingQty = editingLineId === line.id && editingLineField === "qty";
                    const isEditingSku = editingLineId === line.id && editingLineField === "sku";
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
                                  className={`text-xs px-2 py-1 rounded cursor-pointer hover:bg-muted ${v.id === line.productVariantId ? "bg-muted font-bold" : ""}`}
                                  onClick={() => {
                                    if (v.id !== line.productVariantId) {
                                      saveSkuEdit(line.id, v);
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
                            className={canEditLines ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                            onClick={() => canEditLines && startSkuEdit(line)}
                          >
                            {line.sku || "—"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate">{line.productName || "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{line.vendorSku || "—"}</TableCell>
                      <TableCell className="text-right">
                        {isEditingQty ? (
                          <div className="flex items-center gap-1 justify-end">
                            <Input
                              type="number"
                              min="1"
                              step="1"
                              value={editLineValue}
                              onChange={e => setEditLineValue(e.target.value)}
                              className="h-7 w-24 text-right text-sm font-mono"
                              autoFocus
                              onKeyDown={e => {
                                if (e.key === "Enter") saveLineEdit(line.id);
                                if (e.key === "Escape") cancelLineEdit();
                              }}
                            />
                            <Button size="sm" className="h-7 px-1.5" onClick={() => saveLineEdit(line.id)} disabled={updateLineMutation.isPending}>
                              <Check className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={cancelLineEdit}>
                              <XCircle className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <span
                            className={canEditLines ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                            onClick={() => canEditLines && startLineEdit(line.id, "qty", line.orderQty)}
                          >
                            {(line.unitsPerUom || 1) > 1
                              ? <>{(line.orderQty || 0).toLocaleString()} pcs<br /><span className="text-xs text-muted-foreground">({Math.ceil((line.orderQty || 0) / (line.unitsPerUom || 1))} cases)</span></>
                              : line.orderQty}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {(line.unitsPerUom || 1) > 1
                          ? <span>{(line.receivedQty || 0).toLocaleString()} pcs<br /><span className="text-xs text-muted-foreground">({Math.ceil((line.receivedQty || 0) / (line.unitsPerUom || 1))} cases)</span></span>
                          : line.receivedQty || 0}
                        {(line.damagedQty || 0) > 0 && (
                          <span className="text-red-500 ml-1">({line.damagedQty} dmg)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {isEditingCost ? (
                          <div className="flex items-center gap-1 justify-end">
                            <span className="text-sm">$</span>
                            <Input
                              type="number"
                              min="0"
                              step="0.000001"
                              value={editLineValue}
                              onChange={e => setEditLineValue(e.target.value)}
                              className="h-7 w-28 text-right text-sm font-mono"
                              autoFocus
                              onKeyDown={e => {
                                if (e.key === "Enter") saveLineEdit(line.id);
                                if (e.key === "Escape") cancelLineEdit();
                              }}
                            />
                            <Button size="sm" className="h-7 px-1.5" onClick={() => saveLineEdit(line.id)} disabled={updateLineMutation.isPending}>
                              <Check className="h-3 w-3" />
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 px-1.5" onClick={cancelLineEdit}>
                              <XCircle className="h-3 w-3" />
                            </Button>
                          </div>
                        ) : (
                          <span
                            className={canEditLines ? "cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1" : ""}
                            onClick={() => canEditLines && startLineEdit(line.id, "unitCost", line.unitCostCents)}
                          >
                            {formatLineUnitCost(line)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium">{formatCents(line.lineTotalCents)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{line.status}</Badge>
                      </TableCell>
                      {isDraft && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { if (confirm("Remove this line?")) deleteLineMutation.mutate(line.id); }}
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

            {/* Send to vendor (draft only) */}
            {po.physicalStatus === "draft" && isSoloMode && (
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
            {po.physicalStatus === "sent" && (
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
            {po.physicalStatus === "acknowledged" && (
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
            {po.physicalStatus === "shipped" && (
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
            {(po.physicalStatus === "in_transit" || po.physicalStatus === "shipped") && (
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
            {(["arrived", "receiving", "acknowledged", "shipped", "in_transit", "sent", "partially_received"].includes(po.physicalStatus ?? "") ||
              ["sent", "acknowledged", "partially_received"].includes(po.status)) && (
              <Button
                className="w-full justify-start"
                variant="outline"
                size="sm"
                onClick={() => createReceiptMutation.mutate()}
                disabled={createReceiptMutation.isPending}
              >
                <Truck className="h-3.5 w-3.5 mr-2" />
                {createReceiptMutation.isPending ? "Creating..." : "Create receipt"}
              </Button>
            )}

            {/* Cancel PO */}
            {["draft", "sent", "acknowledged"].includes(po.physicalStatus ?? "") &&
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

      {/* ── Add Line Dialog ── */}
      <Dialog open={showAddLineDialog} onOpenChange={(open) => {
        setShowAddLineDialog(open);
        if (!open) {
          setProductSearch("");
          setSelectedProductForLine(null);
          setTotalCostDollars("");
          setSaveToVendorCatalog(true);
          setSetAsPreferred(false);
          setNewLine({ productId: 0, productVariantId: 0, orderQty: 1, unitCostCents: 0, unitsPerUom: 1, vendorSku: "", description: "" });
          setCatalogSearch("");
          setSelectedCatalogEntry(null);
          setAddLineMode("catalog");
        }
      }}>
        <DialogContent className="max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
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
                    setNewLine({ productId: 0, productVariantId: 0, orderQty: 1, unitCostCents: 0, unitsPerUom: 1, vendorSku: "", description: "" });
                    setTotalCostDollars("");
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
                    setNewLine({ productId: 0, productVariantId: 0, orderQty: 1, unitCostCents: 0, unitsPerUom: 1, vendorSku: "", description: "" });
                    setTotalCostDollars("");
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
                        setSelectedProductForLine(null);
                        setNewLine({ productId: 0, productVariantId: 0, orderQty: 1, unitCostCents: 0, unitsPerUom: 1, vendorSku: "", description: "" });
                        setTotalCostDollars("");
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
                            return (
                              <button
                                key={entry.id}
                                type="button"
                                className="w-full text-left p-2.5 hover:bg-muted/50 transition-colors"
                                onClick={() => {
                                  setSelectedCatalogEntry(entry);
                                  setSelectedProductForLine(product || null);
                                  setNewLine(prev => ({
                                    ...prev,
                                    productId: entry.productId,
                                    productVariantId: entry.productVariantId || 0,
                                    vendorSku: entry.vendorSku || "",
                                    unitsPerUom: entry.packSize || 1,
                                  }));
                                  setTotalCostDollars("");
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
                                      {(entry.packSize || 1) > 1 && <span>· {entry.packSize} pcs/case</span>}
                                      {entry.moq > 1 && <span>· MOQ {entry.moq}</span>}
                                    </div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="text-sm font-mono font-medium">{formatCents(entry.unitCostCents, { unitCost: true })}</div>
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
                    <Label>Variant / Case Size *</Label>
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
                                      unitsPerUom: v.unitsPerVariant || 1,
                                    }));
                                    setVariantOpen(false);
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${newLine.productVariantId === v.id ? "opacity-100" : "opacity-0"}`} />
                                  <span className="font-mono text-xs mr-2">{v.sku}</span>
                                  <span className="truncate">{v.name}</span>
                                  {(v.unitsPerVariant || 1) > 1 && (
                                    <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs/case</span>
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
                                  setNewLine(prev => ({ ...prev, productId: p.id, productVariantId: 0, unitsPerUom: 1 }));
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
                    <Label>Variant / Case Size *</Label>
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
                                      unitsPerUom: v.unitsPerVariant || 1,
                                    }));
                                    setVariantOpen(false);
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${newLine.productVariantId === v.id ? "opacity-100" : "opacity-0"}`} />
                                  <span className="font-mono text-xs mr-2">{v.sku}</span>
                                  <span className="truncate">{v.name}</span>
                                  {(v.unitsPerVariant || 1) > 1 && (
                                    <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs/case</span>
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
            {newLine.productVariantId > 0 && (
              <>
                <Separator />
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Qty (pieces) *</Label>
                    <Input
                      type="number"
                      min="1"
                      value={newLine.orderQty || ""}
                      onChange={e => setNewLine(prev => ({ ...prev, orderQty: parseInt(e.target.value) || 0 }))}
                      className="h-10"
                    />
                    {casesEquiv !== null && (
                      <p className="text-xs text-muted-foreground">= {casesEquiv} cases @ {newLine.unitsPerUom} pcs/case</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label>Total Cost ($) *</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="26320.00"
                      value={totalCostDollars}
                      onChange={e => setTotalCostDollars(e.target.value)}
                      className="h-10"
                    />
                    {totalCostDollars && newLine.orderQty > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Unit Cost: {formatCents(dollarsToCents(totalCostDollars || "0") / newLine.orderQty, { unitCost: true })}/pc
                      </p>
                    )}
                  </div>
                </div>

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
                      checked={saveToVendorCatalog}
                      onCheckedChange={(v) => setSaveToVendorCatalog(!!v)}
                    />
                    <label htmlFor="saveToVendorCatalog" className="text-sm cursor-pointer select-none">
                      {selectedCatalogEntry ? "Update vendor catalog with new cost" : "Save to vendor catalog"}
                    </label>
                  </div>
                  {saveToVendorCatalog && (
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
                  )}
                </div>
              </>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowAddLineDialog(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  const totalCents = dollarsToCents(totalCostDollars || "0");
                  const unitCostCents = newLine.orderQty > 0 ? totalCents / newLine.orderQty : 0;
                  addLineMutation.mutate({ ...newLine, unitCostCents });
                }}
                disabled={!newLine.productVariantId || newLine.orderQty < 1 || !totalCostDollars || addLineMutation.isPending || catalogUpsertMutation.isPending}
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
      {/* ═══════ Create Shipment Dialog ═══════ */}
      <Dialog open={showCreateShipmentDialog} onOpenChange={setShowCreateShipmentDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Inbound Shipment</DialogTitle>
            <DialogDescription>Set up shipment details. Add line items after creation.</DialogDescription>
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
              <Label>Shipper (Origin Supplier)</Label>
              <Input
                value={newShipmentForm.shipperName}
                onChange={(e) => setNewShipmentForm(prev => ({ ...prev, shipperName: e.target.value }))}
                className="h-10"
              />
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

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setShowCreateShipmentDialog(false)}>Cancel</Button>
              <Button
                onClick={() => createShipmentMutation.mutate(newShipmentForm)}
                disabled={createShipmentMutation.isPending}
              >
                {createShipmentMutation.isPending ? "Creating..." : "Create Shipment"}
              </Button>
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
            {/* 3-way match banner (mirrors APInvoiceDetail.tsx logic) */}
            {(() => {
              const amountCents = dollarsToCents(payment.amountDollars || "0");
              const selectedInvoice = invoicesData?.invoices?.find((i: any) => i.id === payment.invoiceId);
              const balance = selectedInvoice?.balanceCents ?? 0;
              const isFinalPayment = amountCents > 0 && amountCents >= balance;
              const isPartial = amountCents > 0 && amountCents < balance;

              if (isPartial) {
                return (
                  <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/30 p-3 text-sm">
                    <div className="font-medium">Partial payment</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Remaining balance after this payment: {formatCents(balance - amountCents)}.
                      The 3-way match runs when the final payment settles the invoice.
                    </div>
                  </div>
                );
              }

              if (isFinalPayment) {
                return (
                  <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={payment.forceOverride}
                        onChange={(e) => setPayment(p => ({ ...p, forceOverride: e.target.checked }))}
                      />
                      <div className="text-sm">
                        <div className="font-medium">Override 3-way match check</div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          This payment will fully settle the invoice. Server will require the
                          invoice lines to be matched against PO lines and receipts. Check this
                          only if the match is intentionally pending.
                        </div>
                      </div>
                    </label>
                  </div>
                );
              }
              return null;
            })()}
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
    </div>
  );
}
