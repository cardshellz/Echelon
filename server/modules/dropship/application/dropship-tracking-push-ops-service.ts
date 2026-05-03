import { DropshipError } from "../domain/errors";
import {
  listDropshipTrackingPushesInputSchema,
  type DropshipTrackingPushStatus,
  type ListDropshipTrackingPushesInput,
} from "./dropship-tracking-push-ops-dtos";
import type { DropshipLogEvent, DropshipLogger } from "./dropship-ports";

export const DROPSHIP_TRACKING_PUSH_OPS_DEFAULT_STATUSES: DropshipTrackingPushStatus[] = [
  "failed",
  "processing",
  "queued",
];

export interface DropshipTrackingPushOpsVendorSummary {
  vendorId: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
  entitlementStatus: string;
}

export interface DropshipTrackingPushOpsStoreSummary {
  storeConnectionId: number;
  platform: string;
  status: string;
  setupStatus: string;
  externalDisplayName: string | null;
  shopDomain: string | null;
}

export interface DropshipTrackingPushOpsRecord {
  pushId: number;
  intakeId: number;
  omsOrderId: number;
  vendor: DropshipTrackingPushOpsVendorSummary;
  storeConnection: DropshipTrackingPushOpsStoreSummary;
  platform: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  sourceOrderId: string | null;
  status: DropshipTrackingPushStatus;
  idempotencyKey: string;
  requestHash: string;
  carrier: string;
  trackingNumber: string;
  shippedAt: Date;
  externalFulfillmentId: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface DropshipTrackingPushOpsStatusSummary {
  status: DropshipTrackingPushStatus;
  count: number;
}

export interface DropshipTrackingPushOpsListResult {
  items: DropshipTrackingPushOpsRecord[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipTrackingPushStatus[];
  summary: DropshipTrackingPushOpsStatusSummary[];
}

export interface DropshipTrackingPushOpsRepository {
  listPushes(input: ListDropshipTrackingPushesInput & {
    statuses: DropshipTrackingPushStatus[];
  }): Promise<DropshipTrackingPushOpsListResult>;
}

export class DropshipTrackingPushOpsService {
  constructor(private readonly deps: {
    repository: DropshipTrackingPushOpsRepository;
    logger: DropshipLogger;
  }) {}

  async listPushes(input: unknown): Promise<DropshipTrackingPushOpsListResult> {
    const parsed = parseListPushesInput(input);
    const result = await this.deps.repository.listPushes({
      ...parsed,
      statuses: parsed.statuses ?? DROPSHIP_TRACKING_PUSH_OPS_DEFAULT_STATUSES,
    });
    this.deps.logger.info({
      code: "DROPSHIP_TRACKING_PUSH_OPS_LISTED",
      message: "Dropship tracking pushes were listed for ops.",
      context: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        statuses: result.statuses,
      },
    });
    return result;
  }
}

export function makeDropshipTrackingPushOpsLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipTrackingPushOpsEvent("info", event),
    warn: (event) => logDropshipTrackingPushOpsEvent("warn", event),
    error: (event) => logDropshipTrackingPushOpsEvent("error", event),
  };
}

function parseListPushesInput(input: unknown): ListDropshipTrackingPushesInput {
  const result = listDropshipTrackingPushesInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_TRACKING_PUSH_OPS_LIST_INVALID_INPUT",
      "Dropship tracking push ops list input failed validation.",
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

function logDropshipTrackingPushOpsEvent(
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
