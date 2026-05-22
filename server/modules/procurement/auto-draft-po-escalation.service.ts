import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { notify as defaultNotify } from "../notifications/notifications.service";
import {
  buildStaleAutoDraftPoDiagnostics,
  type AutoDraftPoAgingThresholds,
  type StaleAutoDraftPoDiagnostics,
  type StaleAutoDraftPoItem,
} from "./auto-draft-po-aging.service";
import { fetchAutoDraftPoAgingRows } from "./auto-draft-po-aging.repository";

export const CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY = "auto_draft_po_critical_stale";
export const DEFAULT_STALE_AUTO_DRAFT_PO_ESCALATION_DEDUPE_HOURS = 20;

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows: unknown[] }>;
};

type NotifyFn = (
  typeKey: string,
  payload: { title: string; message?: string; data?: Record<string, unknown> },
) => Promise<void>;

export type StaleAutoDraftPoEscalationResult = {
  sent: boolean;
  suppressed: boolean;
  reason: "no_critical" | "cooldown" | "sent";
  criticalCount: number;
  signature: string | null;
  notificationTypeKey: typeof CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY;
};

function stageCounts(items: StaleAutoDraftPoItem[]): Record<string, number> {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.stage] = (counts[item.stage] ?? 0) + 1;
    return counts;
  }, {});
}

function formatPoLine(item: StaleAutoDraftPoItem): string {
  const vendor = item.vendorName ? ` (${item.vendorName})` : "";
  return `${item.poNumber}${vendor}: ${item.stageLabel.toLowerCase()} for ${item.ageDays} day${item.ageDays === 1 ? "" : "s"}`;
}

export function buildCriticalStaleAutoDraftPoNotification(
  diagnostics: StaleAutoDraftPoDiagnostics,
  options: { maxItems?: number } = {},
): { title: string; message: string; data: Record<string, unknown> } | null {
  const maxItems = Math.max(1, Math.min(10, Number(options.maxItems ?? 5) || 5));
  const criticalItems = diagnostics.items.filter((item) => item.severity === "critical");
  const criticalCount = diagnostics.counts.critical;
  if (criticalCount <= 0 || criticalItems.length === 0) return null;

  const shownItems = criticalItems.slice(0, maxItems);
  const omittedCount = Math.max(0, criticalCount - shownItems.length);
  const signature = criticalItems
    .map((item) => `${item.poId}:${item.stage}`)
    .sort()
    .join("|");

  const title = criticalCount === 1
    ? `Auto-draft PO ${criticalItems[0].poNumber} is critically stale`
    : `${criticalCount} auto-draft POs are critically stale`;
  const message = [
    ...shownItems.map(formatPoLine),
    omittedCount > 0 ? `${omittedCount} more critical PO${omittedCount === 1 ? "" : "s"} need review.` : null,
  ].filter(Boolean).join("\n");

  return {
    title,
    message,
    data: {
      generatedAt: diagnostics.generatedAt,
      criticalCount,
      warningCount: diagnostics.counts.warning,
      totalStale: diagnostics.totalStale,
      stageCounts: stageCounts(criticalItems),
      signature,
      url: "/purchasing",
      items: shownItems.map((item) => ({
        poId: item.poId,
        poNumber: item.poNumber,
        vendorId: item.vendorId,
        vendorName: item.vendorName,
        stage: item.stage,
        stageLabel: item.stageLabel,
        ageDays: item.ageDays,
        detail: item.detail,
        action: item.action,
      })),
    },
  };
}

async function hasRecentMatchingNotification(
  db: DbWithExecute,
  signature: string,
  dedupeHours: number,
): Promise<boolean> {
  const recent = await db.execute(sql`
    SELECT 1
    FROM notifications n
    JOIN notification_types nt ON nt.id = n.notification_type_id
    WHERE nt.key = ${CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY}
      AND n.created_at > NOW() - make_interval(hours => ${dedupeHours})
      AND n.data->>'signature' = ${signature}
    LIMIT 1
  `);
  return recent.rows.length > 0;
}

export async function sendCriticalStaleAutoDraftPoEscalation(
  diagnostics: StaleAutoDraftPoDiagnostics,
  options: {
    db?: DbWithExecute;
    notify?: NotifyFn;
    dedupeHours?: number;
    force?: boolean;
  } = {},
): Promise<StaleAutoDraftPoEscalationResult> {
  const notification = buildCriticalStaleAutoDraftPoNotification(diagnostics);
  const signature = typeof notification?.data.signature === "string" ? notification.data.signature : null;
  if (!notification || !signature) {
    return {
      sent: false,
      suppressed: false,
      reason: "no_critical",
      criticalCount: diagnostics.counts.critical,
      signature: null,
      notificationTypeKey: CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY,
    };
  }

  const db = options.db ?? defaultDb;
  const dedupeHours = Math.max(1, Math.min(168, Number(options.dedupeHours ?? DEFAULT_STALE_AUTO_DRAFT_PO_ESCALATION_DEDUPE_HOURS) || DEFAULT_STALE_AUTO_DRAFT_PO_ESCALATION_DEDUPE_HOURS));
  if (!options.force && await hasRecentMatchingNotification(db, signature, dedupeHours)) {
    return {
      sent: false,
      suppressed: true,
      reason: "cooldown",
      criticalCount: diagnostics.counts.critical,
      signature,
      notificationTypeKey: CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY,
    };
  }

  await (options.notify ?? defaultNotify)(CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY, notification);
  return {
    sent: true,
    suppressed: false,
    reason: "sent",
    criticalCount: diagnostics.counts.critical,
    signature,
    notificationTypeKey: CRITICAL_STALE_AUTO_DRAFT_PO_NOTIFICATION_KEY,
  };
}

export async function runStaleAutoDraftPoEscalationCheck(
  options: {
    db?: DbWithExecute;
    notify?: NotifyFn;
    thresholds?: Partial<AutoDraftPoAgingThresholds>;
    dedupeHours?: number;
    force?: boolean;
    now?: Date;
  } = {},
): Promise<StaleAutoDraftPoEscalationResult> {
  const db = options.db ?? defaultDb;
  const rows = await fetchAutoDraftPoAgingRows(db, { scanLimit: 500 });
  const diagnostics = buildStaleAutoDraftPoDiagnostics(rows, {
    limit: 100,
    thresholds: options.thresholds,
    now: options.now,
  });
  return sendCriticalStaleAutoDraftPoEscalation(diagnostics, {
    db,
    notify: options.notify,
    dedupeHours: options.dedupeHours,
    force: options.force,
  });
}
