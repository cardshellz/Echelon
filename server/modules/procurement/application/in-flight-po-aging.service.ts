import type { AutoDraftPoAgingSeverity, AutoDraftPoAgingThresholds } from "./auto-draft-po-aging.service";
import { DEFAULT_STALE_AUTO_DRAFT_PO_THRESHOLDS } from "./auto-draft-po-aging.service";
import { resolveCurrentPhysicalStatus } from "./purchase-order-lifecycle.service";
import {
  isConfirmedDeliveryDateInvalid,
  resolveEffectiveDeliveryDate,
} from "./purchase-order-delivery-schedule";

export type InFlightPoAgingStage = "supplier_followup_pending" | "receiving_pending";

export type InFlightPoAgingRow = {
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
  orderDate: string | Date | null;
  sentToVendorAt: string | Date | null;
  expectedDeliveryDate: string | Date | null;
  confirmedDeliveryDate: string | Date | null;
  actualDeliveryDate: string | Date | null;
  firstShippedAt?: string | Date | null;
  firstArrivedAt?: string | Date | null;
  latestReceivingActivityAt?: string | Date | null;
  activeReceivingOrderId?: number | null;
  activeReceiptNumber?: string | null;
  activeReceiptStatus?: string | null;
  createdAt: string | Date | null;
  updatedAt: string | Date | null;
  openExceptionCount: number | null;
};

export type InFlightPoAgingItem = {
  id: string;
  poId: number;
  poNumber: string;
  vendorId: number | null;
  vendorName: string | null;
  status: string | null;
  physicalStatus: string | null;
  financialStatus: string | null;
  source: string | null;
  stage: InFlightPoAgingStage;
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
  latestReceivingActivityAt: string | null;
  activeReceivingOrderId: number | null;
  activeReceiptNumber: string | null;
  activeReceiptStatus: string | null;
  hasInvalidConfirmedDeliveryDate: boolean;
};

export type InFlightPoAgingDiagnostics = {
  generatedAt: string;
  thresholds: AutoDraftPoAgingThresholds;
  scannedPos: number;
  totalAging: number;
  counts: {
    critical: number;
    warning: number;
    info: number;
    supplierFollowupPending: number;
    receivingPending: number;
    missingEta: number;
    overdueEta: number;
    arrivedNotReceiving: number;
    invalidConfirmedDeliveryDate: number;
  };
  items: InFlightPoAgingItem[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

const STAGE_LABELS: Record<InFlightPoAgingStage, string> = {
  supplier_followup_pending: "Supplier follow-up pending",
  receiving_pending: "Receiving pending",
};

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

function latestDate(...values: Array<string | Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const date = coerceDate(value);
    if (date && (!latest || date.getTime() > latest.getTime())) latest = date;
  }
  return latest;
}

function classifyStage(row: InFlightPoAgingRow): InFlightPoAgingStage | null {
  const physicalStatus = resolveCurrentPhysicalStatus(row);
  const legacyStatus = row.status ?? "draft";
  if (["cancelled", "received", "closed"].includes(legacyStatus)) return null;
  if (["cancelled", "received", "short_closed"].includes(physicalStatus)) return null;
  if (["arrived", "receiving"].includes(physicalStatus) || legacyStatus === "partially_received") {
    return "receiving_pending";
  }
  if (["sent", "acknowledged", "shipped", "in_transit"].includes(physicalStatus)) {
    return "supplier_followup_pending";
  }
  return null;
}

function stageStartedAt(row: InFlightPoAgingRow, stage: InFlightPoAgingStage, now: Date): Date | null {
  if (stage === "receiving_pending") {
    const latestReceivingProgress = latestDate(
      row.latestReceivingActivityAt,
      row.actualDeliveryDate,
      row.firstArrivedAt,
    );
    if (latestReceivingProgress) return latestReceivingProgress;
    return firstDate(resolveEffectiveDeliveryDate(row), row.sentToVendorAt, row.orderDate, row.createdAt);
  }

  const physicalStatus = resolveCurrentPhysicalStatus(row);
  const submissionDate = firstDate(row.sentToVendorAt, row.orderDate, row.createdAt);
  const eta = resolveEffectiveDeliveryDate(row);
  if (physicalStatus === "sent") return submissionDate;
  if (isConfirmedDeliveryDateInvalid(row)) {
    return eta && eta.getTime() <= now.getTime() ? eta : submissionDate;
  }
  return eta ?? submissionDate;
}

function severityForAge(
  ageDays: number,
  stage: InFlightPoAgingStage,
  thresholds: AutoDraftPoAgingThresholds,
): AutoDraftPoAgingSeverity | null {
  const warning = stage === "receiving_pending" ? thresholds.receivingWarningDays : thresholds.supplierFollowupWarningDays;
  const critical = stage === "receiving_pending" ? thresholds.receivingCriticalDays : thresholds.supplierFollowupCriticalDays;
  if (ageDays >= critical) return "critical";
  if (ageDays >= warning) return "warning";
  return null;
}

function hasMissingEta(row: InFlightPoAgingRow): boolean {
  return resolveEffectiveDeliveryDate(row) === null;
}

function hasOverdueEta(row: InFlightPoAgingRow, now: Date): boolean {
  const eta = resolveEffectiveDeliveryDate(row);
  return Boolean(eta && eta.getTime() < now.getTime());
}

function isArrivedNotReceiving(row: InFlightPoAgingRow): boolean {
  return resolveCurrentPhysicalStatus(row) === "arrived";
}

function buildDetail(row: InFlightPoAgingRow, stage: InFlightPoAgingStage, ageDays: number): string {
  if (stage === "receiving_pending") {
    if (row.activeReceivingOrderId) {
      const receipt = row.activeReceiptNumber ? `Receipt ${row.activeReceiptNumber}` : "The active receipt";
      return `${receipt} has had no activity for ${ageDays} day${ageDays === 1 ? "" : "s"}; continue or finish receiving.`;
    }
    if (row.latestReceivingActivityAt) {
      return `PO has had no receiving progress for ${ageDays} day${ageDays === 1 ? "" : "s"} since the latest receipt activity.`;
    }
    if (isArrivedNotReceiving(row)) {
      return `PO has been marked arrived for ${ageDays} day${ageDays === 1 ? "" : "s"}; create or finish the receipt.`;
    }
    return `PO has been waiting on receiving for ${ageDays} day${ageDays === 1 ? "" : "s"} after the current receive-by baseline.`;
  }

  if (isConfirmedDeliveryDateInvalid(row)) {
    return "Vendor confirmed delivery date predates the PO submission date; correct the delivery schedule before relying on the ETA.";
  }

  const physicalStatus = resolveCurrentPhysicalStatus(row);
  if (physicalStatus === "sent") {
    const missingEtaDetail = hasMissingEta(row) ? " or an expected delivery date" : "";
    return `PO has been sent for ${ageDays} day${ageDays === 1 ? "" : "s"} without vendor acknowledgement${missingEtaDetail}.`;
  }

  if (hasMissingEta(row)) {
    return `PO has been with the supplier for ${ageDays} day${ageDays === 1 ? "" : "s"} without an expected or confirmed delivery date.`;
  }
  const scheduleLabel = row.confirmedDeliveryDate ? "vendor-confirmed delivery date" : "expected delivery date";
  return `PO is ${ageDays} day${ageDays === 1 ? "" : "s"} past its ${scheduleLabel}.`;
}

export function buildInFlightPoAgingDiagnostics(
  rows: InFlightPoAgingRow[],
  options: {
    now?: Date;
    limit?: number;
    includeInfo?: boolean;
    thresholds?: Partial<AutoDraftPoAgingThresholds>;
  } = {},
): InFlightPoAgingDiagnostics {
  const now = options.now ?? new Date();
  const thresholds = {
    ...DEFAULT_STALE_AUTO_DRAFT_PO_THRESHOLDS,
    ...(options.thresholds ?? {}),
  };
  const limit = Math.max(1, Math.min(100, Number(options.limit ?? 25) || 25));
  const includeInfo = options.includeInfo === true;
  const items: InFlightPoAgingItem[] = [];

  for (const row of rows) {
    const stage = classifyStage(row);
    if (!stage) continue;

    const startedAt = stageStartedAt(row, stage, now);
    if (!startedAt) continue;

    const ageDays = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS));
    const severity = severityForAge(ageDays, stage, thresholds) ?? (includeInfo ? "info" : null);
    if (!severity) continue;

    const poId = Number(row.id);
    if (!Number.isFinite(poId)) continue;
    const physicalStatus = resolveCurrentPhysicalStatus(row);
    const hasInvalidConfirmedDeliveryDate = isConfirmedDeliveryDateInvalid(row);
    const activeReceivingOrderId = nullableNumber(row.activeReceivingOrderId);
    const action = stage === "supplier_followup_pending" && hasInvalidConfirmedDeliveryDate
      ? { action: "correct_delivery_schedule", label: "Correct schedule", href: `/purchase-orders/${poId}` }
      : stage === "receiving_pending"
      ? activeReceivingOrderId !== null
        ? { action: "continue_receipt", label: "Continue receipt", href: `/receiving?open=${activeReceivingOrderId}` }
        : { action: "create_receipt", label: "Create receipt", href: `/purchase-orders/${poId}` }
      : { action: "follow_up_supplier", label: "Follow up", href: `/purchase-orders/${poId}` };

    items.push({
      id: `in-flight-po-aging-${poId}`,
      poId,
      poNumber: row.poNumber,
      vendorId: nullableNumber(row.vendorId),
      vendorName: row.vendorName,
      status: row.status,
      physicalStatus,
      financialStatus: row.financialStatus,
      source: row.source,
      stage,
      stageLabel: STAGE_LABELS[stage],
      stageStartedAt: startedAt.toISOString(),
      ageDays,
      severity,
      detail: severity === "info" ? `${STAGE_LABELS[stage]} is not stale yet.` : buildDetail(row, stage, ageDays),
      action,
      lineCount: nullableNumber(row.lineCount),
      totalCents: nullableNumber(row.totalCents),
      expectedDeliveryDate: isoOrNull(resolveEffectiveDeliveryDate(row)),
      openExceptionCount: Math.max(0, Number(row.openExceptionCount ?? 0) || 0),
      latestReceivingActivityAt: isoOrNull(row.latestReceivingActivityAt),
      activeReceivingOrderId,
      activeReceiptNumber: row.activeReceiptNumber ?? null,
      activeReceiptStatus: row.activeReceiptStatus ?? null,
      hasInvalidConfirmedDeliveryDate,
    });
  }

  items.sort((a, b) => {
    const severityRank: Record<AutoDraftPoAgingSeverity, number> = { critical: 0, warning: 1, info: 2 };
    const severityDelta = severityRank[a.severity] - severityRank[b.severity];
    if (severityDelta !== 0) return severityDelta;
    return b.ageDays - a.ageDays;
  });

  const counts: InFlightPoAgingDiagnostics["counts"] = {
    critical: 0,
    warning: 0,
    info: 0,
    supplierFollowupPending: 0,
    receivingPending: 0,
    missingEta: 0,
    overdueEta: 0,
    arrivedNotReceiving: 0,
    invalidConfirmedDeliveryDate: 0,
  };

  for (const item of items) {
    counts[item.severity] += 1;
    if (item.stage === "supplier_followup_pending") counts.supplierFollowupPending += 1;
    if (item.stage === "receiving_pending") counts.receivingPending += 1;
  }

  for (const row of rows) {
    if (hasMissingEta(row)) counts.missingEta += 1;
    if (hasOverdueEta(row, now)) counts.overdueEta += 1;
    if (isArrivedNotReceiving(row)) counts.arrivedNotReceiving += 1;
    if (isConfirmedDeliveryDateInvalid(row)) counts.invalidConfirmedDeliveryDate += 1;
  }

  return {
    generatedAt: now.toISOString(),
    thresholds,
    scannedPos: rows.length,
    totalAging: items.filter((item) => item.severity !== "info").length,
    counts,
    items: items.slice(0, limit),
  };
}
