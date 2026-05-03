import { DropshipError } from "../domain/errors";
import {
  listDropshipTrackingPushesInputSchema,
  retryDropshipTrackingPushInputSchema,
  type DropshipTrackingPushStatus,
  type ListDropshipTrackingPushesInput,
  type RetryDropshipTrackingPushInput,
} from "./dropship-tracking-push-ops-dtos";
import type {
  DropshipMarketplaceTrackingPushRecord,
  DropshipMarketplaceTrackingService,
  PushDropshipTrackingForOmsOrderResult,
} from "./dropship-marketplace-tracking-service";
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
  retryable: boolean;
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

export interface DropshipTrackingPushRetryRequest {
  pushId: number;
  omsOrderId: number;
  carrier: string;
  trackingNumber: string;
  shippedAt: Date;
  idempotencyKey: string;
  previousAttemptCount: number;
}

export interface DropshipTrackingPushRetryResult {
  pushId: number;
  previousStatus: DropshipTrackingPushStatus;
  status: PushDropshipTrackingForOmsOrderResult["status"];
  idempotentReplay: boolean;
  updatedPush: DropshipMarketplaceTrackingPushRecord | null;
}

export interface DropshipTrackingPushOpsRepository {
  listPushes(input: ListDropshipTrackingPushesInput & {
    statuses: DropshipTrackingPushStatus[];
  }): Promise<DropshipTrackingPushOpsListResult>;

  prepareRetry(input: RetryDropshipTrackingPushInput & {
    now: Date;
  }): Promise<DropshipTrackingPushRetryRequest>;

  markPreparedRetryFailed(input: {
    pushId: number;
    code: string;
    message: string;
    retryable: boolean;
    now: Date;
  }): Promise<void>;
}

export class DropshipTrackingPushOpsService {
  constructor(private readonly deps: {
    repository: DropshipTrackingPushOpsRepository;
    marketplaceTracking: Pick<DropshipMarketplaceTrackingService, "pushForOmsOrder">;
    logger: DropshipLogger;
    clock: { now(): Date };
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

  async retryPush(input: unknown): Promise<DropshipTrackingPushRetryResult> {
    const parsed = parseRetryPushInput(input);
    const retryRequest = await this.deps.repository.prepareRetry({
      ...parsed,
      now: this.deps.clock.now(),
    });
    let result: PushDropshipTrackingForOmsOrderResult;
    try {
      result = await this.deps.marketplaceTracking.pushForOmsOrder({
        omsOrderId: retryRequest.omsOrderId,
        carrier: retryRequest.carrier,
        trackingNumber: retryRequest.trackingNumber,
        shippedAt: retryRequest.shippedAt,
        idempotencyKey: retryRequest.idempotencyKey,
      });
    } catch (error: any) {
      await this.deps.repository.markPreparedRetryFailed({
        pushId: retryRequest.pushId,
        code: error instanceof DropshipError ? error.code : "DROPSHIP_TRACKING_PUSH_OPS_RETRY_FAILED",
        message: error?.message ?? String(error),
        retryable: error instanceof DropshipError ? error.context?.retryable !== false : true,
        now: this.deps.clock.now(),
      });
      throw error;
    }
    const updatedPush = "push" in result ? result.push : null;
    this.deps.logger.info({
      code: "DROPSHIP_TRACKING_PUSH_OPS_RETRY_REQUESTED",
      message: "Dropship tracking push retry was requested by ops.",
      context: {
        pushId: retryRequest.pushId,
        omsOrderId: retryRequest.omsOrderId,
        resultStatus: result.status,
        idempotencyKey: parsed.idempotencyKey,
        trackingPushIdempotencyKey: retryRequest.idempotencyKey,
      },
    });
    return {
      pushId: updatedPush?.pushId ?? retryRequest.pushId,
      previousStatus: "failed",
      status: result.status,
      idempotentReplay: result.status === "already_succeeded",
      updatedPush,
    };
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

function parseRetryPushInput(input: unknown): RetryDropshipTrackingPushInput {
  const result = retryDropshipTrackingPushInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_TRACKING_PUSH_OPS_RETRY_INVALID_INPUT",
      "Dropship tracking push retry input failed validation.",
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
