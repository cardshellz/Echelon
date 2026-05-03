import { DropshipError } from "../domain/errors";
import {
  listDropshipNotificationEventsInputSchema,
  type DropshipNotificationOpsChannel,
  type DropshipNotificationOpsStatus,
  type ListDropshipNotificationEventsInput,
} from "./dropship-notification-ops-dtos";
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

export interface DropshipNotificationOpsRepository {
  listEvents(input: ListDropshipNotificationEventsInput & {
    statuses: DropshipNotificationOpsStatus[];
  }): Promise<DropshipNotificationOpsListResult>;
}

export class DropshipNotificationOpsService {
  constructor(private readonly deps: {
    repository: DropshipNotificationOpsRepository;
    logger: DropshipLogger;
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
}

export function makeDropshipNotificationOpsLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipNotificationOpsEvent("info", event),
    warn: (event) => logDropshipNotificationOpsEvent("warn", event),
    error: (event) => logDropshipNotificationOpsEvent("error", event),
  };
}

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
