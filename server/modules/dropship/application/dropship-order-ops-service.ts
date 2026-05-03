import { DropshipError } from "../domain/errors";
import type { DropshipOrderIntakeStatus, NormalizedDropshipOrderPayload } from "./dropship-order-intake-service";
import {
  listDropshipOrderOpsIntakesInputSchema,
  markDropshipOrderOpsExceptionInputSchema,
  retryDropshipOrderOpsIntakeInputSchema,
  type ListDropshipOrderOpsIntakesInput,
  type MarkDropshipOrderOpsExceptionInput,
  type RetryDropshipOrderOpsIntakeInput,
} from "./dropship-order-ops-dtos";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

export const DROPSHIP_OPS_DEFAULT_INTAKE_STATUSES: DropshipOrderIntakeStatus[] = [
  "payment_hold",
  "retrying",
  "failed",
  "cancelled",
  "exception",
  "rejected",
];

export const DROPSHIP_ALL_INTAKE_STATUSES: DropshipOrderIntakeStatus[] = [
  "received",
  "processing",
  "accepted",
  "rejected",
  "retrying",
  "failed",
  "payment_hold",
  "cancelled",
  "exception",
];

export interface DropshipOrderOpsActor {
  actorType: "admin" | "system";
  actorId?: string;
}

export interface DropshipOrderOpsStoreSummary {
  storeConnectionId: number;
  platform: string;
  status: string;
  setupStatus: string;
  externalDisplayName: string | null;
  shopDomain: string | null;
}

export interface DropshipOrderOpsVendorSummary {
  vendorId: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
  entitlementStatus: string;
}

export interface DropshipOrderOpsAuditSummary {
  eventType: string;
  severity: string;
  createdAt: Date;
  payload: Record<string, unknown>;
}

export interface DropshipOrderOpsIntakeListItem {
  intakeId: number;
  vendor: DropshipOrderOpsVendorSummary;
  storeConnection: DropshipOrderOpsStoreSummary;
  platform: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: DropshipOrderIntakeStatus;
  paymentHoldExpiresAt: Date | null;
  rejectionReason: string | null;
  cancellationStatus: string | null;
  omsOrderId: number | null;
  receivedAt: Date;
  acceptedAt: Date | null;
  updatedAt: Date;
  lineCount: number;
  totalQuantity: number;
  shipTo: NormalizedDropshipOrderPayload["shipTo"] | null;
  latestAuditEvent: DropshipOrderOpsAuditSummary | null;
}

export interface DropshipOrderOpsStatusSummary {
  status: DropshipOrderIntakeStatus;
  count: number;
}

export interface DropshipOrderOpsIntakeListResult {
  items: DropshipOrderOpsIntakeListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipOrderIntakeStatus[];
  summary: DropshipOrderOpsStatusSummary[];
}

export interface DropshipOrderOpsActionResult {
  intakeId: number;
  previousStatus: DropshipOrderIntakeStatus;
  status: DropshipOrderIntakeStatus;
  idempotentReplay: boolean;
  updatedAt: Date;
}

export interface DropshipOrderOpsRepository {
  listIntakes(input: ListDropshipOrderOpsIntakesInput & {
    statuses: DropshipOrderIntakeStatus[];
  }): Promise<DropshipOrderOpsIntakeListResult>;

  retryIntake(input: RetryDropshipOrderOpsIntakeInput & {
    now: Date;
  }): Promise<DropshipOrderOpsActionResult>;

  markException(input: MarkDropshipOrderOpsExceptionInput & {
    now: Date;
  }): Promise<DropshipOrderOpsActionResult>;
}

export class DropshipOrderOpsService {
  constructor(
    private readonly deps: {
      repository: DropshipOrderOpsRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async listIntakes(input: unknown): Promise<DropshipOrderOpsIntakeListResult> {
    const parsed = parseListInput(input);
    return this.deps.repository.listIntakes({
      ...parsed,
      statuses: parsed.statuses ?? DROPSHIP_OPS_DEFAULT_INTAKE_STATUSES,
    });
  }

  async retryIntake(input: unknown): Promise<DropshipOrderOpsActionResult> {
    const parsed = parseRetryInput(input);
    const result = await this.deps.repository.retryIntake({
      ...parsed,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_ORDER_OPS_RETRY_REQUESTED",
      message: "Dropship order intake retry was requested by ops.",
      context: {
        intakeId: result.intakeId,
        previousStatus: result.previousStatus,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
        idempotencyKey: parsed.idempotencyKey,
      },
    });
    return result;
  }

  async markException(input: unknown): Promise<DropshipOrderOpsActionResult> {
    const parsed = parseMarkExceptionInput(input);
    const result = await this.deps.repository.markException({
      ...parsed,
      now: this.deps.clock.now(),
    });
    this.deps.logger.warn({
      code: "DROPSHIP_ORDER_OPS_EXCEPTION_MARKED",
      message: "Dropship order intake was marked as an ops exception.",
      context: {
        intakeId: result.intakeId,
        previousStatus: result.previousStatus,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
        idempotencyKey: parsed.idempotencyKey,
      },
    });
    return result;
  }
}

export function makeDropshipOrderOpsLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOrderOpsEvent("info", event),
    warn: (event) => logDropshipOrderOpsEvent("warn", event),
    error: (event) => logDropshipOrderOpsEvent("error", event),
  };
}

export const systemDropshipOrderOpsClock: DropshipClock = {
  now: () => new Date(),
};

function parseListInput(input: unknown): ListDropshipOrderOpsIntakesInput {
  const result = listDropshipOrderOpsIntakesInputSchema.safeParse(input);
  if (!result.success) {
    throw validationError("DROPSHIP_ORDER_OPS_LIST_INVALID_INPUT", result.error.issues);
  }
  return result.data;
}

function parseRetryInput(input: unknown): RetryDropshipOrderOpsIntakeInput {
  const result = retryDropshipOrderOpsIntakeInputSchema.safeParse(input);
  if (!result.success) {
    throw validationError("DROPSHIP_ORDER_OPS_RETRY_INVALID_INPUT", result.error.issues);
  }
  return result.data;
}

function parseMarkExceptionInput(input: unknown): MarkDropshipOrderOpsExceptionInput {
  const result = markDropshipOrderOpsExceptionInputSchema.safeParse(input);
  if (!result.success) {
    throw validationError("DROPSHIP_ORDER_OPS_EXCEPTION_INVALID_INPUT", result.error.issues);
  }
  return result.data;
}

function validationError(code: string, issues: Array<{
  path: Array<string | number>;
  code: string;
  message: string;
}>): DropshipError {
  return new DropshipError(code, "Dropship order ops input failed validation.", {
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function logDropshipOrderOpsEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
