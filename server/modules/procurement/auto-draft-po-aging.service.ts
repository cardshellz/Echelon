import { buildPoAutoDraftActionPlan } from "./purchase-order-lifecycle.service";

export type AutoDraftPoAgingSeverity = "critical" | "warning" | "info";

export type AutoDraftPoAgingStage =
  | "review_pending"
  | "supplier_send_pending"
  | "supplier_followup_pending"
  | "receiving_pending"
  | "ap_closeout_pending"
  | "exception_blocked"
  | "closeout_pending";

export type AutoDraftPoAgingThresholds = {
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
};

export type AutoDraftPoAgingRow = {
  id: number;
  poNumber: string;
  vendorId: number | null;
  vendorName: string | null;
  status: string | null;
  physicalStatus: string | null;
  financialStatus: string | null;
  lineCount: number | null;
  totalCents: number | null;
  source: string | null;
  autoDraftDate: string | Date | null;
  orderDate: string | Date | null;
  approvedAt?: string | Date | null;
  sentToVendorAt: string | Date | null;
  expectedDeliveryDate: string | Date | null;
  confirmedDeliveryDate: string | Date | null;
  actualDeliveryDate: string | Date | null;
  firstShippedAt?: string | Date | null;
  firstArrivedAt?: string | Date | null;
  firstInvoicedAt: string | Date | null;
  firstPaidAt?: string | Date | null;
  fullyPaidAt?: string | Date | null;
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
  openExceptionCount: number | null;
};

export type StaleAutoDraftPoItem = {
  id: string;
  poId: number;
  poNumber: string;
  vendorId: number | null;
  vendorName: string | null;
  status: string | null;
  physicalStatus: string | null;
  financialStatus: string | null;
  stage: AutoDraftPoAgingStage;
  stageLabel: string;
  stageStartedAt: string | null;
  ageDays: number;
  severity: AutoDraftPoAgingSeverity;
  detail: string;
  action: {
    action: string;
    label: string;
    href: string;
  };
  lineCount: number | null;
  totalCents: number | null;
  expectedDeliveryDate: string | null;
  openExceptionCount: number;
};

export type StaleAutoDraftPoDiagnostics = {
  generatedAt: string;
  thresholds: AutoDraftPoAgingThresholds;
  scannedAutoDraftPos: number;
  totalStale: number;
  counts: {
    critical: number;
    warning: number;
    info: number;
    reviewPending: number;
    supplierSendPending: number;
    supplierFollowupPending: number;
    receivingPending: number;
    apCloseoutPending: number;
    exceptionBlocked: number;
    closeoutPending: number;
  };
  items: StaleAutoDraftPoItem[];
};

export const DEFAULT_STALE_AUTO_DRAFT_PO_THRESHOLDS: AutoDraftPoAgingThresholds = {
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

const DAY_MS = 24 * 60 * 60 * 1000;

const STAGE_LABELS: Record<AutoDraftPoAgingStage, string> = {
  review_pending: "Review pending",
  supplier_send_pending: "Supplier send pending",
  supplier_followup_pending: "Supplier follow-up pending",
  receiving_pending: "Receiving pending",
  ap_closeout_pending: "AP closeout pending",
  exception_blocked: "Exception blocked",
  closeout_pending: "Closeout pending",
};

const STAGE_COUNT_KEY: Record<AutoDraftPoAgingStage, keyof StaleAutoDraftPoDiagnostics["counts"]> = {
  review_pending: "reviewPending",
  supplier_send_pending: "supplierSendPending",
  supplier_followup_pending: "supplierFollowupPending",
  receiving_pending: "receivingPending",
  ap_closeout_pending: "apCloseoutPending",
  exception_blocked: "exceptionBlocked",
  closeout_pending: "closeoutPending",
};

type StageThreshold = {
  warning: number;
  critical: number;
};

function thresholdsForStage(
  stage: AutoDraftPoAgingStage,
  thresholds: AutoDraftPoAgingThresholds,
): StageThreshold {
  switch (stage) {
    case "review_pending":
      return { warning: thresholds.reviewPendingWarningDays, critical: thresholds.reviewPendingCriticalDays };
    case "supplier_send_pending":
      return { warning: thresholds.supplierSendWarningDays, critical: thresholds.supplierSendCriticalDays };
    case "supplier_followup_pending":
      return { warning: thresholds.supplierFollowupWarningDays, critical: thresholds.supplierFollowupCriticalDays };
    case "receiving_pending":
      return { warning: thresholds.receivingWarningDays, critical: thresholds.receivingCriticalDays };
    case "ap_closeout_pending":
      return { warning: thresholds.apCloseoutWarningDays, critical: thresholds.apCloseoutCriticalDays };
    case "exception_blocked":
      return { warning: thresholds.exceptionBlockedWarningDays, critical: thresholds.exceptionBlockedCriticalDays };
    case "closeout_pending":
      return { warning: thresholds.closeoutWarningDays, critical: thresholds.closeoutCriticalDays };
  }
}

function coerceDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  return coerceDate(value)?.toISOString() ?? null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDate(...values: Array<string | Date | null | undefined>): Date | null {
  for (const value of values) {
    const date = coerceDate(value);
    if (date) return date;
  }
  return null;
}

function classifyStage(actionId: string): AutoDraftPoAgingStage | null {
  if (actionId === "open_exceptions") return "exception_blocked";
  if (["open_lines", "approve", "submit"].includes(actionId)) return "review_pending";
  if (["send", "send_to_vendor"].includes(actionId)) return "supplier_send_pending";
  if (["acknowledge", "mark_shipped", "mark_in_transit", "mark_arrived"].includes(actionId)) return "supplier_followup_pending";
  if (actionId === "create_receipt") return "receiving_pending";
  if (["create_invoice", "record_payment"].includes(actionId)) return "ap_closeout_pending";
  if (actionId === "close") return "closeout_pending";
  return null;
}

function stageStartedAt(row: AutoDraftPoAgingRow, stage: AutoDraftPoAgingStage): Date | null {
  switch (stage) {
    case "review_pending":
      return firstDate(row.autoDraftDate, row.createdAt);
    case "supplier_send_pending":
      return firstDate(row.approvedAt, row.updatedAt, row.createdAt);
    case "supplier_followup_pending":
      return firstDate(row.sentToVendorAt, row.orderDate, row.createdAt);
    case "receiving_pending":
      return firstDate(row.confirmedDeliveryDate, row.expectedDeliveryDate, row.firstArrivedAt, row.sentToVendorAt, row.orderDate, row.createdAt);
    case "ap_closeout_pending":
      return firstDate(row.actualDeliveryDate, row.firstInvoicedAt, row.updatedAt, row.createdAt);
    case "exception_blocked":
      return firstDate(row.updatedAt, row.createdAt);
    case "closeout_pending":
      return firstDate(row.fullyPaidAt, row.firstPaidAt, row.updatedAt, row.createdAt);
  }
}

function severityForAge(
  ageDays: number,
  threshold: StageThreshold,
): AutoDraftPoAgingSeverity | null {
  if (ageDays >= threshold.critical) return "critical";
  if (ageDays >= threshold.warning) return "warning";
  return null;
}

function buildDetail(stage: AutoDraftPoAgingStage, ageDays: number, threshold: StageThreshold): string {
  const base = `${STAGE_LABELS[stage]} for ${ageDays} day${ageDays === 1 ? "" : "s"}`;
  if (stage === "receiving_pending") {
    return `${base} after the current receive-by baseline; verify shipment/receiving status.`;
  }
  if (stage === "supplier_followup_pending") {
    return `${base}; confirm supplier acknowledgement, shipment, or expected delivery.`;
  }
  if (stage === "ap_closeout_pending") {
    return `${base}; create invoice or record payment so landed cost and financial reporting close out.`;
  }
  if (stage === "exception_blocked") {
    return `${base}; resolve PO exceptions before advancing the supplier or receiving flow.`;
  }
  if (ageDays >= threshold.critical) {
    return `${base}; this has passed the critical aging threshold.`;
  }
  return `${base}; this has passed the warning aging threshold.`;
}

export function buildStaleAutoDraftPoDiagnostics(
  rows: AutoDraftPoAgingRow[],
  options: {
    now?: Date;
    limit?: number;
    includeInfo?: boolean;
    thresholds?: Partial<AutoDraftPoAgingThresholds>;
  } = {},
): StaleAutoDraftPoDiagnostics {
  const now = options.now ?? new Date();
  const thresholds = {
    ...DEFAULT_STALE_AUTO_DRAFT_PO_THRESHOLDS,
    ...(options.thresholds ?? {}),
  };
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 25) || 25));
  const includeInfo = options.includeInfo === true;
  const items: StaleAutoDraftPoItem[] = [];

  for (const row of rows) {
    const openExceptionCount = Math.max(0, Number(row.openExceptionCount ?? 0) || 0);
    const actionPlan = buildPoAutoDraftActionPlan(row, { lineCount: row.lineCount, openExceptionCount });
    if (!actionPlan) continue;

    const poId = Number(row.id);
    const stage = classifyStage(actionPlan.primaryAction.id);
    if (!stage || !Number.isFinite(poId)) continue;

    const startedAt = stageStartedAt(row, stage);
    if (!startedAt) continue;

    const ageDays = Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS);
    const stageThreshold = thresholdsForStage(stage, thresholds);
    const severity = severityForAge(ageDays, stageThreshold) ?? (includeInfo ? "info" : null);
    if (!severity) continue;

    items.push({
      id: `stale-auto-draft-po-${poId}`,
      poId,
      poNumber: row.poNumber,
      vendorId: nullableNumber(row.vendorId),
      vendorName: row.vendorName,
      status: row.status,
      physicalStatus: row.physicalStatus,
      financialStatus: row.financialStatus,
      stage,
      stageLabel: STAGE_LABELS[stage],
      stageStartedAt: startedAt.toISOString(),
      ageDays: Math.max(0, ageDays),
      severity,
      detail: severity === "info"
        ? `${STAGE_LABELS[stage]} is not stale yet.`
        : buildDetail(stage, Math.max(0, ageDays), stageThreshold),
      action: {
        action: actionPlan.primaryAction.id,
        label: actionPlan.primaryAction.label,
        href: `/purchase-orders/${poId}`,
      },
      lineCount: nullableNumber(row.lineCount),
      totalCents: nullableNumber(row.totalCents),
      expectedDeliveryDate: isoOrNull(row.confirmedDeliveryDate) ?? isoOrNull(row.expectedDeliveryDate),
      openExceptionCount,
    });
  }

  items.sort((a, b) => {
    const severityRank: Record<AutoDraftPoAgingSeverity, number> = { critical: 0, warning: 1, info: 2 };
    const severityDelta = severityRank[a.severity] - severityRank[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return b.ageDays - a.ageDays;
  });

  const limitedItems = items.slice(0, limit);
  const counts: StaleAutoDraftPoDiagnostics["counts"] = {
    critical: 0,
    warning: 0,
    info: 0,
    reviewPending: 0,
    supplierSendPending: 0,
    supplierFollowupPending: 0,
    receivingPending: 0,
    apCloseoutPending: 0,
    exceptionBlocked: 0,
    closeoutPending: 0,
  };

  for (const item of items) {
    counts[item.severity] += 1;
    counts[STAGE_COUNT_KEY[item.stage]] += 1;
  }

  return {
    generatedAt: now.toISOString(),
    thresholds,
    scannedAutoDraftPos: rows.length,
    totalStale: items.filter((item) => item.severity !== "info").length,
    counts,
    items: limitedItems,
  };
}
