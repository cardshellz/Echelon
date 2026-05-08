import { DropshipError } from "../domain/errors";
import {
  listDropshipNotificationEventsInputSchema,
  retryDropshipNotificationEventInputSchema,
  type DropshipNotificationOpsChannel,
  type DropshipNotificationOpsStatus,
  type ListDropshipNotificationEventsInput,
  type RetryDropshipNotificationEventInput,
} from "./dropship-notification-ops-dtos";
import type { DropshipNotificationEmailSender } from "./dropship-notification-service";
import type { DropshipLogEvent, DropshipLogger } from "./dropship-ports";

export const DROPSHIP_NOTIFICATION_OPS_DEFAULT_STATUSES: DropshipNotificationOpsStatus[] = [
  "failed",
  "pending",
];

export interface DropshipNotificationOpsVendorSummary {
  vendorId: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
  entitlementStatus: string;
}

export interface DropshipNotificationOpsEventRecord {
  notificationEventId: number;
  vendor: DropshipNotificationOpsVendorSummary;
  eventType: string;
  channel: DropshipNotificationOpsChannel;
  critical: boolean;
  title: string;
  message: string | null;
  payload: Record<string, unknown>;
  status: DropshipNotificationOpsStatus;
  deliveredAt: Date | null;
  readAt: Date | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
}

export interface DropshipNotificationOpsStatusSummary {
  status: DropshipNotificationOpsStatus;
  count: number;
}

export interface DropshipNotificationOpsChannelSummary {
  channel: DropshipNotificationOpsChannel;
  count: number;
}

export interface DropshipNotificationOpsListResult {
  items: DropshipNotificationOpsEventRecord[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipNotificationOpsStatus[];
  channels: DropshipNotificationOpsChannel[] | null;
  summary: DropshipNotificationOpsStatusSummary[];
  channelSummary: DropshipNotificationOpsChannelSummary[];
}

export interface DropshipNotificationOpsActor {
  actorType: "admin" | "system";
  actorId?: string;
}

export interface DropshipNotificationOpsPreparedRetry {
  event: DropshipNotificationOpsEventRecord;
  previousStatus: DropshipNotificationOpsStatus;
}

export interface DropshipNotificationOpsActionResult {
  notificationEventId: number;
  previousStatus: DropshipNotificationOpsStatus;
  status: DropshipNotificationOpsStatus;
  deliveredAt: Date | null;
  idempotentReplay: boolean;
  failureCode: string | null;
  failureMessage: string | null;
  updatedEvent: DropshipNotificationOpsEventRecord;
}

export interface DropshipNotificationOpsRepository {
  listEvents(input: ListDropshipNotificationEventsInput & {
    statuses: DropshipNotificationOpsStatus[];
  }): Promise<DropshipNotificationOpsListResult>;

  prepareEmailRetry(input: RetryDropshipNotificationEventInput & {
    now: Date;
  }): Promise<DropshipNotificationOpsPreparedRetry>;

  updateEmailRetryDelivery(input: {
    vendorId: number;
    notificationEventId: number;
    status: "delivered" | "failed";
    deliveredAt: Date | null;
    failureCode: string | null;
    failureMessage: string | null;
    actor: DropshipNotificationOpsActor;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipNotificationOpsEventRecord>;
}

export class DropshipNotificationOpsService {
  constructor(private readonly deps: {
    repository: DropshipNotificationOpsRepository;
    emailSender: DropshipNotificationEmailSender;
    logger: DropshipLogger;
    clock: { now(): Date };
  }) {}

  async listEvents(input: unknown): Promise<DropshipNotificationOpsListResult> {
    const parsed = parseListEventsInput(input);
    const result = await this.deps.repository.listEvents({
      ...parsed,
      statuses: parsed.statuses ?? DROPSHIP_NOTIFICATION_OPS_DEFAULT_STATUSES,
    });
    this.deps.logger.info({
      code: "DROPSHIP_NOTIFICATION_OPS_LISTED",
      message: "Dropship notification events were listed for ops.",
      context: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        statuses: result.statuses,
        channels: result.channels,
      },
    });
    return result;
  }

  async retryEvent(input: unknown): Promise<DropshipNotificationOpsActionResult> {
    const parsed = parseRetryEventInput(input);
    const retry = await this.deps.repository.prepareEmailRetry({
      ...parsed,
      now: this.deps.clock.now(),
    });
    const event = retry.event;
    if (!event.vendor.email) {
      const failedAt = this.deps.clock.now();
      const updatedEvent = await this.deps.repository.updateEmailRetryDelivery({
        vendorId: event.vendor.vendorId,
        notificationEventId: event.notificationEventId,
        status: "failed",
        deliveredAt: null,
        failureCode: "DROPSHIP_NOTIFICATION_EMAIL_MISSING",
        failureMessage: "Vendor email is missing.",
        actor: parsed.actor,
        idempotencyKey: parsed.idempotencyKey,
        now: failedAt,
      });
      this.deps.logger.warn({
        code: "DROPSHIP_NOTIFICATION_OPS_EMAIL_RETRY_SKIPPED",
        message: "Dropship notification email retry could not be sent because the vendor email is missing.",
        context: {
          notificationEventId: event.notificationEventId,
          vendorId: event.vendor.vendorId,
          eventType: event.eventType,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
      return makeRetryActionResult(retry.previousStatus, updatedEvent, {
        failureCode: "DROPSHIP_NOTIFICATION_EMAIL_MISSING",
        failureMessage: "Vendor email is missing.",
      });
    }

    try {
      await this.deps.emailSender.send({
        toEmail: event.vendor.email,
        eventType: event.eventType,
        title: event.title,
        message: event.message,
        payload: event.payload,
      });
      const deliveredAt = this.deps.clock.now();
      const updatedEvent = await this.deps.repository.updateEmailRetryDelivery({
        vendorId: event.vendor.vendorId,
        notificationEventId: event.notificationEventId,
        status: "delivered",
        deliveredAt,
        failureCode: null,
        failureMessage: null,
        actor: parsed.actor,
        idempotencyKey: parsed.idempotencyKey,
        now: deliveredAt,
      });
      this.deps.logger.info({
        code: "DROPSHIP_NOTIFICATION_OPS_EMAIL_RETRY_DELIVERED",
        message: "Dropship notification email retry was delivered.",
        context: {
          notificationEventId: event.notificationEventId,
          vendorId: event.vendor.vendorId,
          eventType: event.eventType,
          previousStatus: retry.previousStatus,
          idempotencyKey: parsed.idempotencyKey,
        },
      });
      return makeRetryActionResult(retry.previousStatus, updatedEvent);
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failedAt = this.deps.clock.now();
      const updatedEvent = await this.deps.repository.updateEmailRetryDelivery({
        vendorId: event.vendor.vendorId,
        notificationEventId: event.notificationEventId,
        status: "failed",
        deliveredAt: null,
        failureCode: "DROPSHIP_NOTIFICATION_EMAIL_SEND_FAILED",
        failureMessage,
        actor: parsed.actor,
        idempotencyKey: parsed.idempotencyKey,
        now: failedAt,
      });
      this.deps.logger.error({
        code: "DROPSHIP_NOTIFICATION_OPS_EMAIL_RETRY_FAILED",
        message: "Dropship notification email retry failed.",
        context: {
          notificationEventId: event.notificationEventId,
          vendorId: event.vendor.vendorId,
          eventType: event.eventType,
          previousStatus: retry.previousStatus,
          idempotencyKey: parsed.idempotencyKey,
          error: failureMessage,
        },
      });
      return makeRetryActionResult(retry.previousStatus, updatedEvent, {
        failureCode: "DROPSHIP_NOTIFICATION_EMAIL_SEND_FAILED",
        failureMessage,
      });
    }
  }
}

export function makeDropshipNotificationOpsLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipNotificationOpsEvent("info", event),
    warn: (event) => logDropshipNotificationOpsEvent("warn", event),
    error: (event) => logDropshipNotificationOpsEvent("error", event),
  };
}

export const systemDropshipNotificationOpsClock = {
  now: () => new Date(),
};

function parseListEventsInput(input: unknown): ListDropshipNotificationEventsInput {
  const result = listDropshipNotificationEventsInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_NOTIFICATION_OPS_LIST_INVALID_INPUT",
      "Dropship notification ops list input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function parseRetryEventInput(input: unknown): RetryDropshipNotificationEventInput {
  const result = retryDropshipNotificationEventInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_NOTIFICATION_OPS_RETRY_INVALID_INPUT",
      "Dropship notification ops retry input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function makeRetryActionResult(
  previousStatus: DropshipNotificationOpsStatus,
  updatedEvent: DropshipNotificationOpsEventRecord,
  failure: { failureCode: string; failureMessage: string } | null = null,
): DropshipNotificationOpsActionResult {
  return {
    notificationEventId: updatedEvent.notificationEventId,
    previousStatus,
    status: updatedEvent.status,
    deliveredAt: updatedEvent.deliveredAt,
    idempotentReplay: false,
    failureCode: failure?.failureCode ?? null,
    failureMessage: failure?.failureMessage ?? null,
    updatedEvent,
  };
}

function logDropshipNotificationOpsEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
