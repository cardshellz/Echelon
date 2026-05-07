import { DropshipError } from "../domain/errors";
import {
  listDropshipListingPushJobsInputSchema,
  retryDropshipListingPushJobInputSchema,
  type DropshipListingPushJobStatus,
  type ListDropshipListingPushJobsInput,
  type RetryDropshipListingPushJobInput,
} from "./dropship-listing-push-ops-dtos";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

export const DROPSHIP_LISTING_PUSH_OPS_DEFAULT_STATUSES: DropshipListingPushJobStatus[] = [
  "failed",
  "processing",
  "queued",
];

export interface DropshipListingPushOpsVendorSummary {
  vendorId: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
  entitlementStatus: string;
}

export interface DropshipListingPushOpsStoreSummary {
  storeConnectionId: number;
  platform: string;
  status: string;
  setupStatus: string;
  externalDisplayName: string | null;
  shopDomain: string | null;
}

export interface DropshipListingPushOpsLatestItemError {
  itemId: number;
  productVariantId: number;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: Date;
}

export interface DropshipListingPushOpsJobListItem {
  jobId: number;
  vendor: DropshipListingPushOpsVendorSummary;
  storeConnection: DropshipListingPushOpsStoreSummary;
  platform: string;
  status: DropshipListingPushJobStatus;
  jobType: string;
  requestedBy: string | null;
  requestedScope: Record<string, unknown> | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  itemSummary: {
    total: number;
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    blocked: number;
    cancelled: number;
  };
  latestItemError: DropshipListingPushOpsLatestItemError | null;
}

export interface DropshipListingPushOpsStatusSummary {
  status: DropshipListingPushJobStatus;
  count: number;
}

export interface DropshipListingPushOpsJobListResult {
  items: DropshipListingPushOpsJobListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipListingPushJobStatus[];
  summary: DropshipListingPushOpsStatusSummary[];
}

export interface DropshipListingPushOpsActor {
  actorType: "admin" | "system";
  actorId?: string;
}

export interface DropshipListingPushOpsActionResult {
  jobId: number;
  previousStatus: DropshipListingPushJobStatus;
  status: DropshipListingPushJobStatus;
  requeuedItemCount: number;
  idempotentReplay: boolean;
  updatedAt: Date;
}

export interface DropshipListingPushOpsRepository {
  listJobs(input: ListDropshipListingPushJobsInput & {
    statuses: DropshipListingPushJobStatus[];
  }): Promise<DropshipListingPushOpsJobListResult>;

  retryJob(input: RetryDropshipListingPushJobInput & {
    now: Date;
  }): Promise<DropshipListingPushOpsActionResult>;
}

export class DropshipListingPushOpsService {
  constructor(private readonly deps: {
    repository: DropshipListingPushOpsRepository;
    logger: DropshipLogger;
    clock: DropshipClock;
  }) {}

  async listJobs(input: unknown): Promise<DropshipListingPushOpsJobListResult> {
    const parsed = parseListJobsInput(input);
    const result = await this.deps.repository.listJobs({
      ...parsed,
      statuses: parsed.statuses ?? DROPSHIP_LISTING_PUSH_OPS_DEFAULT_STATUSES,
    });
    this.deps.logger.info({
      code: "DROPSHIP_LISTING_PUSH_OPS_LISTED",
      message: "Dropship listing push jobs were listed for ops.",
      context: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        statuses: result.statuses,
      },
    });
    return result;
  }

  async retryJob(input: unknown): Promise<DropshipListingPushOpsActionResult> {
    const parsed = parseRetryJobInput(input);
    const result = await this.deps.repository.retryJob({
      ...parsed,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_LISTING_PUSH_OPS_RETRY_REQUESTED",
      message: "Dropship listing push job retry was requested by ops.",
      context: {
        jobId: result.jobId,
        previousStatus: result.previousStatus,
        status: result.status,
        requeuedItemCount: result.requeuedItemCount,
        idempotentReplay: result.idempotentReplay,
        idempotencyKey: parsed.idempotencyKey,
      },
    });
    return result;
  }
}

export function makeDropshipListingPushOpsLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipListingPushOpsEvent("info", event),
    warn: (event) => logDropshipListingPushOpsEvent("warn", event),
    error: (event) => logDropshipListingPushOpsEvent("error", event),
  };
}

function parseListJobsInput(input: unknown): ListDropshipListingPushJobsInput {
  const result = listDropshipListingPushJobsInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_LISTING_PUSH_OPS_LIST_INVALID_INPUT",
      "Dropship listing push ops list input failed validation.",
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

function parseRetryJobInput(input: unknown): RetryDropshipListingPushJobInput {
  const result = retryDropshipListingPushJobInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_LISTING_PUSH_OPS_RETRY_INVALID_INPUT",
      "Dropship listing push ops retry input failed validation.",
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

export const systemDropshipListingPushOpsClock: DropshipClock = {
  now: () => new Date(),
};

function logDropshipListingPushOpsEvent(
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
