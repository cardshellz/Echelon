import { sql } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { notify as defaultNotify } from "../notifications/notifications.service";
import type { ProcurementHealthSource, ProcurementHealthSummary } from "./procurement-health.service";

export const PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY = "procurement_health_critical";
export const DEFAULT_PROCUREMENT_HEALTH_ESCALATION_DEDUPE_HOURS = 20;

type DbWithExecute = {
  execute: (query: any) => Promise<{ rows: unknown[] }>;
};

type NotifyFn = (
  typeKey: string,
  payload: { title: string; message?: string; data?: Record<string, unknown> },
) => Promise<void>;

export type ProcurementHealthEscalationResult = {
  sent: boolean;
  suppressed: boolean;
  reason: "no_critical" | "cooldown" | "sent";
  criticalCount: number;
  signature: string | null;
  notificationTypeKey: typeof PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY;
};

function criticalSources(summary: ProcurementHealthSummary): ProcurementHealthSource[] {
  return summary.sources.filter((source) => source.critical > 0);
}

function buildSignature(sources: ProcurementHealthSource[]): string {
  return sources
    .map((source) => `${source.key}:${source.critical}:${source.warning}:${source.total}`)
    .sort()
    .join("|");
}

function formatSourceLine(source: ProcurementHealthSource): string {
  const warningText = source.warning > 0 ? `, ${source.warning} warning` : "";
  return `${source.label}: ${source.critical} critical${warningText}. ${source.actionLabel}.`;
}

export function buildProcurementHealthCriticalNotification(
  summary: ProcurementHealthSummary,
  options: { maxSources?: number } = {},
): { title: string; message: string; data: Record<string, unknown> } | null {
  const maxSources = Math.max(1, Math.min(10, Number(options.maxSources ?? 5) || 5));
  const sources = criticalSources(summary);
  if (summary.critical <= 0 || sources.length === 0) return null;

  const shownSources = sources.slice(0, maxSources);
  const omittedCount = Math.max(0, sources.length - shownSources.length);
  const signature = buildSignature(sources);
  const title = summary.critical === 1
    ? "Procurement health has 1 critical signal"
    : `Procurement health has ${summary.critical} critical signals`;
  const message = [
    ...shownSources.map(formatSourceLine),
    omittedCount > 0 ? `${omittedCount} more critical source${omittedCount === 1 ? "" : "s"} need review.` : null,
  ].filter(Boolean).join("\n");

  return {
    title,
    message,
    data: {
      generatedAt: summary.generatedAt,
      criticalCount: summary.critical,
      warningCount: summary.warning,
      nonHealthySourceCount: summary.total,
      signature,
      url: "/purchasing",
      sources: shownSources.map((source) => ({
        key: source.key,
        label: source.label,
        critical: source.critical,
        warning: source.warning,
        total: source.total,
        href: source.href,
        actionLabel: source.actionLabel,
        detail: source.detail,
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
    WHERE nt.key = ${PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY}
      AND n.created_at > NOW() - make_interval(hours => ${dedupeHours})
      AND n.data->>'signature' = ${signature}
    LIMIT 1
  `);
  return recent.rows.length > 0;
}

export async function sendProcurementHealthCriticalEscalation(
  summary: ProcurementHealthSummary,
  options: {
    db?: DbWithExecute;
    notify?: NotifyFn;
    dedupeHours?: number;
    force?: boolean;
  } = {},
): Promise<ProcurementHealthEscalationResult> {
  const notification = buildProcurementHealthCriticalNotification(summary);
  const signature = typeof notification?.data.signature === "string" ? notification.data.signature : null;
  if (!notification || !signature) {
    return {
      sent: false,
      suppressed: false,
      reason: "no_critical",
      criticalCount: summary.critical,
      signature: null,
      notificationTypeKey: PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY,
    };
  }

  const db = options.db ?? defaultDb;
  const dedupeHours = Math.max(
    1,
    Math.min(
      168,
      Number(options.dedupeHours ?? DEFAULT_PROCUREMENT_HEALTH_ESCALATION_DEDUPE_HOURS)
        || DEFAULT_PROCUREMENT_HEALTH_ESCALATION_DEDUPE_HOURS,
    ),
  );
  if (!options.force && await hasRecentMatchingNotification(db, signature, dedupeHours)) {
    return {
      sent: false,
      suppressed: true,
      reason: "cooldown",
      criticalCount: summary.critical,
      signature,
      notificationTypeKey: PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY,
    };
  }

  await (options.notify ?? defaultNotify)(PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY, notification);
  return {
    sent: true,
    suppressed: false,
    reason: "sent",
    criticalCount: summary.critical,
    signature,
    notificationTypeKey: PROCUREMENT_HEALTH_CRITICAL_NOTIFICATION_KEY,
  };
}
