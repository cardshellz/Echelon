import type { PoolClient } from "pg";
import { boundedIntegrityError, formatIntegrityAlertWebhook } from "./integrity-monitor.domain";
import {
  claimNextIntegrityAlert,
  markIntegrityAlertFailed,
  markIntegrityAlertSent,
} from "./integrity-monitor.repository";

type QueryClient = Pick<PoolClient, "query">;

export interface IntegrityAlertDeliverySummary {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
}

async function postAlert(input: {
  webhookUrl: string;
  payload: ReturnType<typeof formatIntegrityAlertWebhook>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImpl(input.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `WMS integrity alert webhook returned ${response.status}: ${responseText.slice(0, 500)}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverPendingIntegrityAlerts(input: {
  client: QueryClient;
  webhookUrl: string;
  workerId: string;
  clock: () => Date;
  fetchImpl?: typeof fetch;
  maxAlerts?: number;
  maxAttempts?: number;
  leaseMs?: number;
  requestTimeoutMs?: number;
}): Promise<IntegrityAlertDeliverySummary> {
  const maxAlerts = input.maxAlerts ?? 25;
  const maxAttempts = input.maxAttempts ?? 8;
  const leaseMs = input.leaseMs ?? 60_000;
  const requestTimeoutMs = input.requestTimeoutMs ?? 15_000;
  if (!Number.isInteger(maxAlerts) || maxAlerts < 1 || maxAlerts > 100) {
    throw new Error("Integrity alert delivery maxAlerts must be between 1 and 100");
  }
  const summary: IntegrityAlertDeliverySummary = { claimed: 0, sent: 0, failed: 0, dead: 0 };

  for (let index = 0; index < maxAlerts; index += 1) {
    const alert = await claimNextIntegrityAlert(input.client, {
      workerId: input.workerId,
      now: input.clock(),
      leaseMs,
      maxAttempts,
    });
    if (!alert) break;
    summary.claimed += 1;
    try {
      await postAlert({
        webhookUrl: input.webhookUrl,
        payload: formatIntegrityAlertWebhook(alert.payload),
        fetchImpl: input.fetchImpl ?? fetch,
        timeoutMs: requestTimeoutMs,
      });
      await markIntegrityAlertSent(input.client, {
        alertId: alert.id,
        workerId: alert.leaseOwner,
        sentAt: input.clock(),
      });
      summary.sent += 1;
    } catch (error) {
      const status = await markIntegrityAlertFailed(input.client, {
        alert,
        error,
        failedAt: input.clock(),
        maxAttempts,
      });
      summary.failed += 1;
      if (status === "dead") summary.dead += 1;
      console.error(
        `[WMS inventory integrity alert] delivery failed alertId=${alert.id} `
          + `attempt=${alert.attemptCount}/${maxAttempts}: ${boundedIntegrityError(error)}`,
      );
      break;
    }
  }
  return summary;
}
