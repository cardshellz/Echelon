export const DROPSHIP_ORDER_INTAKE_HEALTH_STATUSES = [
  "healthy",
  "warning",
  "degraded",
  "stopped",
] as const;

export type DropshipOrderIntakeHealthStatus =
  typeof DROPSHIP_ORDER_INTAKE_HEALTH_STATUSES[number];

export const DROPSHIP_ORDER_INTAKE_MODES = ["poll", "webhook"] as const;
export type DropshipOrderIntakeMode = typeof DROPSHIP_ORDER_INTAKE_MODES[number];

export interface DropshipOrderIntakeHealthRecord {
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  mode: DropshipOrderIntakeMode;
  status: DropshipOrderIntakeHealthStatus;
  consecutiveFailures: number;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
  lastFailureMessage: string | null;
  statusChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DropshipOrderIntakeHealthPolicy {
  degradedAfterFailures: number;
  stoppedAfterFailures: number;
  degradedAfterMs: number;
  stoppedAfterMs: number;
}

export interface DropshipOrderIntakeHealthTransition {
  previousStatus: DropshipOrderIntakeHealthStatus | null;
  current: DropshipOrderIntakeHealthRecord;
  transitioned: boolean;
  reason: "poll_succeeded" | "poll_failed" | "poll_stale";
}

export function deriveDropshipOrderIntakePollSucceeded(input: {
  current: DropshipOrderIntakeHealthRecord | null;
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  mode: DropshipOrderIntakeMode;
  now: Date;
}): DropshipOrderIntakeHealthTransition {
  const previousStatus = input.current?.status ?? null;
  const createdAt = input.current?.createdAt ?? input.now;
  const current: DropshipOrderIntakeHealthRecord = {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    platform: input.platform,
    mode: input.mode,
    status: "healthy",
    consecutiveFailures: 0,
    lastAttemptAt: input.now,
    lastSuccessAt: input.now,
    lastFailureAt: null,
    lastFailureCode: null,
    lastFailureMessage: null,
    statusChangedAt: previousStatus === "healthy"
      ? input.current!.statusChangedAt
      : input.now,
    createdAt,
    updatedAt: input.now,
  };
  return {
    previousStatus,
    current,
    transitioned: previousStatus !== "healthy",
    reason: "poll_succeeded",
  };
}

export function deriveDropshipOrderIntakePollFailed(input: {
  current: DropshipOrderIntakeHealthRecord | null;
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  mode: DropshipOrderIntakeMode;
  failureCode: string;
  failureMessage: string;
  now: Date;
  policy: DropshipOrderIntakeHealthPolicy;
}): DropshipOrderIntakeHealthTransition {
  assertPolicy(input.policy);
  const previousStatus = input.current?.status ?? null;
  const consecutiveFailures = (input.current?.consecutiveFailures ?? 0) + 1;
  const status = retainMoreSevereStatus(
    failureStatus(consecutiveFailures, input.policy),
    previousStatus,
  );
  const current: DropshipOrderIntakeHealthRecord = {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    platform: input.platform,
    mode: input.mode,
    status,
    consecutiveFailures,
    lastAttemptAt: input.now,
    lastSuccessAt: input.current?.lastSuccessAt ?? null,
    lastFailureAt: input.now,
    lastFailureCode: input.failureCode,
    lastFailureMessage: input.failureMessage,
    statusChangedAt: previousStatus === status
      ? input.current!.statusChangedAt
      : input.now,
    createdAt: input.current?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  return {
    previousStatus,
    current,
    transitioned: previousStatus !== status,
    reason: "poll_failed",
  };
}

export function deriveDropshipOrderIntakePollStale(input: {
  current: DropshipOrderIntakeHealthRecord | null;
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  mode: DropshipOrderIntakeMode;
  observedSince: Date;
  now: Date;
  policy: DropshipOrderIntakeHealthPolicy;
}): DropshipOrderIntakeHealthTransition | null {
  assertPolicy(input.policy);
  const heartbeatAt = input.current?.lastAttemptAt ?? input.observedSince;
  const elapsedMs = Math.max(0, input.now.getTime() - heartbeatAt.getTime());
  const thresholdStatus = elapsedMs >= input.policy.stoppedAfterMs
    ? "stopped"
    : elapsedMs >= input.policy.degradedAfterMs
      ? "degraded"
      : null;
  if (!thresholdStatus) return null;
  const status = retainMoreSevereStatus(thresholdStatus, input.current?.status ?? null);
  if (input.current?.status === status) return null;

  const failureCode = "DROPSHIP_ORDER_INTAKE_STALE";
  const failureMessage = `No order-intake heartbeat has been recorded for ${Math.floor(elapsedMs / 60_000)} minutes.`;
  return {
    previousStatus: input.current?.status ?? null,
    transitioned: true,
    reason: "poll_stale",
    current: {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      mode: input.mode,
      status,
      consecutiveFailures: input.current?.consecutiveFailures ?? 0,
      lastAttemptAt: input.current?.lastAttemptAt ?? null,
      lastSuccessAt: input.current?.lastSuccessAt ?? null,
      lastFailureAt: input.now,
      lastFailureCode: failureCode,
      lastFailureMessage: failureMessage,
      statusChangedAt: input.now,
      createdAt: input.current?.createdAt ?? input.now,
      updatedAt: input.now,
    },
  };
}

function failureStatus(
  consecutiveFailures: number,
  policy: DropshipOrderIntakeHealthPolicy,
): DropshipOrderIntakeHealthStatus {
  if (consecutiveFailures >= policy.stoppedAfterFailures) return "stopped";
  if (consecutiveFailures >= policy.degradedAfterFailures) return "degraded";
  return "warning";
}

function retainMoreSevereStatus(
  candidate: DropshipOrderIntakeHealthStatus,
  current: DropshipOrderIntakeHealthStatus | null,
): DropshipOrderIntakeHealthStatus {
  if (!current) return candidate;
  const rank: Record<DropshipOrderIntakeHealthStatus, number> = {
    healthy: 0,
    warning: 1,
    degraded: 2,
    stopped: 3,
  };
  return rank[current] > rank[candidate] ? current : candidate;
}

function assertPolicy(policy: DropshipOrderIntakeHealthPolicy): void {
  if (
    !Number.isInteger(policy.degradedAfterFailures)
    || policy.degradedAfterFailures <= 0
    || !Number.isInteger(policy.stoppedAfterFailures)
    || policy.stoppedAfterFailures <= policy.degradedAfterFailures
    || !Number.isInteger(policy.degradedAfterMs)
    || policy.degradedAfterMs <= 0
    || !Number.isInteger(policy.stoppedAfterMs)
    || policy.stoppedAfterMs <= policy.degradedAfterMs
  ) {
    throw new Error("Invalid dropship order-intake health policy.");
  }
}
