import { createHash } from "node:crypto";

export interface IntegrityAlertTriggerCounts {
  newBlockers: number;
  worsened: number;
  recurred: number;
  blockerCountGrowth: number;
}

export interface IntegrityAlertSample {
  checkId: string;
  severity: "blocker" | "warning";
  observationKind: "new" | "worsened" | "recurred";
  entityFingerprint: string;
  entityKey: Record<string, unknown>;
  metricValue: string;
}

export interface IntegrityAlertPayload {
  runId: string;
  snapshotAt: string;
  sourceVersion: string | null;
  blockerCount: number;
  warningCount: number;
  previousBlockerCount: number;
  triggerCounts: IntegrityAlertTriggerCounts;
  samples: IntegrityAlertSample[];
}

export function hasActionableIntegrityAlert(counts: IntegrityAlertTriggerCounts): boolean {
  return counts.newBlockers > 0
    || counts.worsened > 0
    || counts.recurred > 0
    || counts.blockerCountGrowth > 0;
}

export function integrityAlertSignature(runId: string): string {
  return createHash("sha256").update(`wms-inventory-integrity:${runId}`).digest("hex");
}

export function integrityAlertRetryAt(now: Date, attemptCount: number): Date {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new Error("Integrity alert attempt count must be a positive integer");
  }
  const delayMinutes = Math.min(60, 2 ** Math.min(attemptCount - 1, 6));
  return new Date(now.getTime() + delayMinutes * 60_000);
}

export function formatIntegrityAlertWebhook(payload: IntegrityAlertPayload): { content: string } {
  const counts = payload.triggerCounts;
  const sampleLines = payload.samples.slice(0, 10).map((sample) => (
    `- ${sample.severity}/${sample.observationKind} ${sample.checkId} `
      + `entity=${sample.entityFingerprint.slice(0, 12)} metric=${sample.metricValue}`
  ));
  const content = [
    "**WMS inventory integrity regression detected**",
    `Run: ${payload.runId}`,
    `Snapshot: ${payload.snapshotAt}`,
    `Blockers: ${payload.blockerCount} (previous ${payload.previousBlockerCount})`,
    `Warnings: ${payload.warningCount}`,
    `Triggers: new blockers=${counts.newBlockers}, worsened=${counts.worsened}, `
      + `recurred=${counts.recurred}, blocker growth=${counts.blockerCountGrowth}`,
    ...sampleLines,
  ].join("\n");
  return { content: content.slice(0, 1_900) };
}

export function boundedIntegrityError(error: unknown, maxLength = 4_000): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, maxLength);
}
