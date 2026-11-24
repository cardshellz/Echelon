let alertSchedulerStartedAt: Date | null = null;
let alertSchedulerLastRunAt: Date | null = null;
let alertSchedulerLastSuccessAt: Date | null = null;
let alertSchedulerLastError: string | null = null;

export interface OmsOpsAlertSchedulerHeartbeat {
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export function getOmsOpsAlertSchedulerHeartbeat(): OmsOpsAlertSchedulerHeartbeat {
  return {
    startedAt: alertSchedulerStartedAt?.toISOString() ?? null,
    lastRunAt: alertSchedulerLastRunAt?.toISOString() ?? null,
    lastSuccessAt: alertSchedulerLastSuccessAt?.toISOString() ?? null,
    lastError: alertSchedulerLastError,
  };
}

export function markOmsOpsAlertSchedulerStarted(): void {
  alertSchedulerStartedAt = new Date();
}

export function markOmsOpsAlertSchedulerRunStarted(): void {
  alertSchedulerLastRunAt = new Date();
}

export function markOmsOpsAlertSchedulerRunSucceeded(): void {
  alertSchedulerLastSuccessAt = new Date();
  alertSchedulerLastError = null;
}

export function markOmsOpsAlertSchedulerRunFailed(error: unknown): void {
  alertSchedulerLastError = error instanceof Error ? error.message : String(error);
}

export function resetOmsOpsAlertSchedulerHeartbeatForTests(): void {
  alertSchedulerStartedAt = null;
  alertSchedulerLastRunAt = null;
  alertSchedulerLastSuccessAt = null;
  alertSchedulerLastError = null;
}
