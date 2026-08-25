import { z } from "zod";
import type {
  DropshipOrderIntakeHealthPolicy,
  DropshipOrderIntakeHealthTransition,
  DropshipOrderIntakeMode,
} from "../domain/dropship-order-intake-health";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import type {
  DropshipClock,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";

const positiveIdSchema = z.number().int().positive();
const platformSchema = z.string().trim().min(1).max(30);
const failureCodeSchema = z.string().trim().min(1).max(100);
const failureMessageSchema = z.string().trim().min(1).max(2000);

export interface DropshipOrderIntakeHealthConnectionIdentity {
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  externalDisplayName: string | null;
  shopDomain: string | null;
}

export interface DropshipOrderIntakeHealthRepositoryResult {
  transition: DropshipOrderIntakeHealthTransition;
  connection: DropshipOrderIntakeHealthConnectionIdentity;
}

export interface DropshipOrderIntakeHealthRepository {
  recordPollSucceeded(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    mode: DropshipOrderIntakeMode;
    syncedThrough: Date;
    now: Date;
    policy: DropshipOrderIntakeHealthPolicy;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult>;
  recordPollFailed(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    mode: DropshipOrderIntakeMode;
    failureCode: string;
    failureMessage: string;
    now: Date;
    policy: DropshipOrderIntakeHealthPolicy;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult>;
  recordStalePolls(input: {
    platform: string;
    mode: DropshipOrderIntakeMode;
    limit: number;
    now: Date;
    policy: DropshipOrderIntakeHealthPolicy;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult[]>;
}

export interface DropshipOrderIntakeHealthServiceDependencies {
  repository: DropshipOrderIntakeHealthRepository;
  notificationSender?: DropshipNotificationSender;
  clock: DropshipClock;
  logger: DropshipLogger;
  policy: DropshipOrderIntakeHealthPolicy;
}

export class DropshipOrderIntakeHealthService {
  constructor(private readonly deps: DropshipOrderIntakeHealthServiceDependencies) {}

  async recordPollSucceeded(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    syncedThrough: Date;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult> {
    const parsed = z.object({
      vendorId: positiveIdSchema,
      storeConnectionId: positiveIdSchema,
      platform: platformSchema,
      syncedThrough: z.date(),
    }).strict().parse(input);
    const result = await this.deps.repository.recordPollSucceeded({
      ...parsed,
      mode: "poll",
      now: this.deps.clock.now(),
      policy: this.deps.policy,
    });
    await this.notifyTransition(result);
    return result;
  }

  async recordPollFailed(input: {
    vendorId: number;
    storeConnectionId: number;
    platform: string;
    failureCode: string;
    failureMessage: string;
  }): Promise<DropshipOrderIntakeHealthRepositoryResult> {
    const parsed = z.object({
      vendorId: positiveIdSchema,
      storeConnectionId: positiveIdSchema,
      platform: platformSchema,
      failureCode: failureCodeSchema,
      failureMessage: failureMessageSchema,
    }).strict().parse(input);
    const result = await this.deps.repository.recordPollFailed({
      ...parsed,
      mode: "poll",
      now: this.deps.clock.now(),
      policy: this.deps.policy,
    });
    await this.notifyTransition(result);
    return result;
  }

  async monitorStalePolls(input: { platform: string; limit: number }): Promise<{
    storesEvaluated: number;
    storesTransitioned: number;
  }> {
    const parsed = z.object({
      platform: platformSchema,
      limit: z.number().int().positive().max(1000),
    }).strict().parse(input);
    const results = await this.deps.repository.recordStalePolls({
      ...parsed,
      mode: "poll",
      now: this.deps.clock.now(),
      policy: this.deps.policy,
    });
    for (const result of results) {
      await this.notifyTransition(result);
    }
    return {
      storesEvaluated: results.length,
      storesTransitioned: results.filter((result) => result.transition.transitioned).length,
    };
  }

  private async notifyTransition(result: DropshipOrderIntakeHealthRepositoryResult): Promise<void> {
    if (!result.transition.transitioned) return;
    const currentStatus = result.transition.current.status;
    const previousStatus = result.transition.previousStatus;
    if (currentStatus === "warning") return;
    if (currentStatus === "healthy" && previousStatus !== "degraded" && previousStatus !== "stopped") return;

    const notification = transitionNotification(result);
    await sendDropshipNotificationSafely(this.deps, notification, {
      code: "DROPSHIP_ORDER_INTAKE_HEALTH_NOTIFICATION_FAILED",
      message: "Dropship order-intake health changed, but the vendor notification could not be delivered.",
      context: {
        vendorId: result.connection.vendorId,
        storeConnectionId: result.connection.storeConnectionId,
        platform: result.connection.platform,
        previousStatus,
        status: currentStatus,
      },
    });
  }
}

function transitionNotification(
  result: DropshipOrderIntakeHealthRepositoryResult,
): Parameters<DropshipNotificationSender["send"]>[0] {
  const { connection, transition } = result;
  const status = transition.current.status;
  const storeLabel = connection.externalDisplayName ?? connection.shopDomain ?? `${connection.platform} store`;
  const commonPayload = {
    vendorId: connection.vendorId,
    storeConnectionId: connection.storeConnectionId,
    platform: connection.platform,
    storeLabel,
    previousStatus: transition.previousStatus,
    status,
    consecutiveFailures: transition.current.consecutiveFailures,
    lastAttemptAt: transition.current.lastAttemptAt?.toISOString() ?? null,
    lastSuccessAt: transition.current.lastSuccessAt?.toISOString() ?? null,
    failureCode: transition.current.lastFailureCode,
    failureMessage: transition.current.lastFailureMessage,
  };
  const idempotencyKey = [
    "order-intake-health",
    connection.storeConnectionId,
    status,
    transition.current.statusChangedAt.toISOString(),
  ].join(":");

  if (status === "healthy") {
    return {
      vendorId: connection.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_INTAKE_RECOVERED,
      critical: false,
      channels: ["email", "in_app"],
      title: "Dropship order intake recovered",
      message: `Order intake for ${storeLabel} is healthy again. Echelon resumed from the preserved marketplace sync cursor and will continue processing newly observed orders.`,
      payload: commonPayload,
      idempotencyKey,
    };
  }
  if (status === "degraded") {
    return {
      vendorId: connection.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_INTAKE_DEGRADED,
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship order intake is degraded",
      message: `Echelon has detected repeated order-intake failures for ${storeLabel}. Automatic retries are continuing, but marketplace orders may be delayed.`,
      payload: commonPayload,
      idempotencyKey,
    };
  }
  return {
    vendorId: connection.vendorId,
    eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_INTAKE_STOPPED,
    critical: true,
    channels: ["email", "in_app"],
    title: "Dropship order intake has stopped",
    message: `Echelon has not recorded a successful order-intake heartbeat for ${storeLabel}. Orders may not reach fulfillment until the connection or worker recovers.`,
    payload: commonPayload,
    idempotencyKey,
  };
}

export const systemDropshipOrderIntakeHealthClock: DropshipClock = {
  now: () => new Date(),
};

export function makeDropshipOrderIntakeHealthLogger(): DropshipLogger {
  return {
    info: (event) => console.info(JSON.stringify(event)),
    warn: (event) => console.warn(JSON.stringify(event)),
    error: (event) => console.error(JSON.stringify(event)),
  };
}
