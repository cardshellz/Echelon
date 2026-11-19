import {
  formatMills,
  centsToMills,
} from "@shared/utils/money";
import {
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";
import {
  PO_PHYSICAL_STATUSES,
} from "@shared/schema/procurement.schema";

// ── Dual-track display helpers ─────────────────────────────────────────────────────

// Physical stages displayed in the timeline (cancelled / short_closed are shown differently)
export const PHYSICAL_TRACK_STAGES = PO_PHYSICAL_STATUSES.filter(
  (s) => s !== "cancelled" && s !== "short_closed",
) as readonly string[];

// Stage label abbreviations for the track dots
export const PHYSICAL_LABELS: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  acknowledged: "Ack'd",
  shipped: "Shipped",
  in_transit: "Transit",
  arrived: "Arrived",
  receiving: "Receiving",
  received: "Received",
};

export const FINANCIAL_LABELS: Record<string, string> = {
  unbilled: "Unbilled",
  invoiced: "Invoiced",
  partially_paid: "Partial",
  paid: "Settled",
  disputed: "Disputed",
};

export function apLedgerOutcomeDescription(result: any): string | undefined {
  const outcome = result?.apLedgerOutcome;
  if (!outcome) return undefined;
  const poIds = Array.isArray(outcome.affectedPurchaseOrderIds) ? outcome.affectedPurchaseOrderIds : [];
  if (poIds.length) return `Updated linked POs: ${poIds.join(", ")}`;
  return outcome.message;
}

// The 4 linear financial stages; 'disputed' shown as warn on partially_paid
export const FINANCIAL_TRACK_STAGES = [
  "unbilled",
  "invoiced",
  "partially_paid",
  "paid",
] as const;

export type StageState = "done" | "current" | "warn" | "future";

export type PoLifecycleActionId =
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

export type PoLifecycleSummary = {
  nextActions?: Array<{
    id: PoLifecycleActionId;
    label?: string;
    endpoint?: string;
    requiredPermission?: { resource: string; action: string };
  }>;
};

export type AutoDraftActionPlanActionId =
  | PoLifecycleActionId
  | "open_lines"
  | "open_exceptions"
  | "create_invoice"
  | "record_payment"
  | "review_financial_evidence"
  | "review_invoice_approval"
  | "done"
  | "cancelled";

export type AutoDraftActionPlan = {
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

export const AUTO_DRAFT_STEP_STYLES: Record<
  AutoDraftActionPlan["checklist"][number]["status"],
  string
> = {
  done: "border-green-200 bg-green-50 text-green-700",
  current: "border-blue-200 bg-blue-50 text-blue-700",
  pending: "border-muted bg-muted/40 text-muted-foreground",
  blocked: "border-red-200 bg-red-50 text-red-700",
};

export const AUTO_DRAFT_SEVERITY_STYLES: Record<
  AutoDraftActionPlan["primaryAction"]["severity"],
  string
> = {
  info: "border-blue-200 bg-blue-50 text-blue-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  critical: "border-red-200 bg-red-50 text-red-700",
  success: "border-green-200 bg-green-50 text-green-700",
};

export function stageState(
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

/**
 * Pick the earliest po_status_history row whose toStatus matches one of
 * the candidate names. Returns the changedAt timestamp or null. Used to
 * fill in stage timestamps that don't have dedicated columns on
 * purchase_orders (e.g. in_transit, receiving, received).
 */
export function firstHistoryAt(
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

// ── Incoterms ─────────────────────────────────────────────────────

// Incoterms → which vendor-side charges are applicable
export const INCOTERMS_LIST = ["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"] as const;
export const INCOTERMS_CHARGES: Record<string, { shipping: boolean; tax: boolean }> = {
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

export const STATUS_BADGES: Record<string, { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }> = {
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

export type RelatedUsersMap = Record<string, { username: string; displayName: string | null }>;

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
export function formatActor(
  actorId: string | null | undefined,
  relatedUsers: RelatedUsersMap | undefined,
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

export function formatCents(cents: number | null | undefined, opts?: { unitCost?: boolean }): string {
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
export function formatLineUnitCost(line: {
  unitCostMills?: number | null;
  unitCostCents?: number | null;
}): string {
  const mills =
    line.unitCostMills != null
      ? Number(line.unitCostMills)
      : centsToMills(Number(line.unitCostCents ?? 0));
  return formatMills(mills);
}

export function formatStoredLineQuote(line: {
  pricingBasis?: string | null;
  purchaseUom?: string | null;
  quotedUnitCostMills?: number | null;
  quotedTotalCents?: number | null;
}): string | null {
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
  return null;
}

export function createEmptyNewLine() {
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

export type NewPoLineDraft = ReturnType<typeof createEmptyNewLine>;

export function genPoLineIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return `po-line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function genPoEmailIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return (crypto as any).randomUUID();
  }
  return `po-email-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type PoEmailDelivery = {
  id: number;
  documentHoldReason: string | null;
  documentHeldAt: string | null;
  status: "queued" | "processing" | "sent" | "partially_sent" | "dead_letter";
  toEmail: string;
  ccEmail: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  sentAt: string | null;
  lastErrorMessage: string | null;
  replayOfId: number | null;
  createdAt: string;
};

export type PoLineHttpCommand<TBody> = {
  idempotencyKey: string;
  requestUrl: string;
  body: TBody;
};

export type AddPoLineRequestBody = {
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
  catalogWrite?: {
    mode: "upsert";
    setPreferred?: boolean;
  };
};

export type CancelPoLineRequestBody = {
  expectedPoUpdatedAt: string;
  expectedLineUpdatedAt: string;
  reason: string;
};

export type UpdatePoLineRequestBody = Record<string, unknown> & {
  expectedPoUpdatedAt: string;
  expectedLineUpdatedAt: string;
};

export type NavigationSnapshot = {
  poId: number | null;
  childHref: (destination: string) => string;
  isCurrent: () => boolean;
};

export type ExternalSendReview = NavigationSnapshot & {
  poId: number;
  poNumber: string;
  expectedUpdatedAt: string;
};

export type VendorOption = {
  id: number;
  name: string;
  code: string;
};

export function parsePositiveInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
