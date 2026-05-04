import { DropshipError } from "../domain/errors";
import type { DropshipOrderIntakeStatus, NormalizedDropshipOrderPayload } from "./dropship-order-intake-service";
import type { DropshipTrackingPushStatus } from "./dropship-tracking-push-ops-dtos";
import {
  getDropshipOrderOpsIntakeDetailInputSchema,
  listDropshipOrderOpsIntakesInputSchema,
  markDropshipOrderOpsExceptionInputSchema,
  processDropshipOrderOpsIntakeInputSchema,
  retryDropshipOrderOpsIntakeInputSchema,
  type GetDropshipOrderOpsIntakeDetailInput,
  type ListDropshipOrderOpsIntakesInput,
  type MarkDropshipOrderOpsExceptionInput,
  type ProcessDropshipOrderOpsIntakeInput,
  type RetryDropshipOrderOpsIntakeInput,
} from "./dropship-order-ops-dtos";
import type { DropshipOrderProcessingResult } from "./dropship-order-processing-service";
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

export interface DropshipOrderOpsIntakeLine {
  lineIndex: number;
  externalLineItemId: string | null;
  externalListingId: string | null;
  externalOfferId: string | null;
  sku: string | null;
  productVariantId: number | null;
  quantity: number;
  unitRetailPriceCents: number | null;
  lineRetailTotalCents: number | null;
  title: string | null;
}

export interface DropshipOrderOpsIntakeTotals {
  retailSubtotalCents: number | null;
  shippingPaidCents: number | null;
  taxCents: number | null;
  discountCents: number | null;
  grandTotalCents: number | null;
  currency: string;
}

export interface DropshipOrderOpsEconomicsSnapshot {
  economicsSnapshotId: number;
  shippingQuoteSnapshotId: number | null;
  warehouseId: number | null;
  currency: string;
  retailSubtotalCents: number;
  wholesaleSubtotalCents: number;
  shippingCents: number;
  insurancePoolCents: number;
  feesCents: number;
  totalDebitCents: number;
  pricingSnapshot: Record<string, unknown>;
  createdAt: Date;
}

export interface DropshipOrderOpsShippingQuoteSnapshot {
  quoteSnapshotId: number;
  warehouseId: number;
  currency: string;
  destinationCountry: string;
  destinationPostalCode: string | null;
  packageCount: number;
  baseRateCents: number;
  markupCents: number;
  insurancePoolCents: number;
  dunnageCents: number;
  totalShippingCents: number;
  quotePayload: Record<string, unknown>;
  createdAt: Date;
}

export interface DropshipOrderOpsWalletLedgerEntry {
  walletLedgerEntryId: number;
  type: string;
  status: string;
  amountCents: number;
  currency: string;
  availableBalanceAfterCents: number | null;
  pendingBalanceAfterCents: number | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface DropshipOrderOpsAuditEventDetail extends DropshipOrderOpsAuditSummary {
  actorType: string;
  actorId: string | null;
}

export interface DropshipOrderOpsTrackingPushSummary {
  pushId: number;
  wmsShipmentId: number | null;
  platform: string;
  status: DropshipTrackingPushStatus;
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

export interface DropshipOrderOpsIntakeDetail extends DropshipOrderOpsIntakeListItem {
  sourceOrderId: string | null;
  orderedAt: string | null;
  marketplaceStatus: string | null;
  totals: DropshipOrderOpsIntakeTotals | null;
  lines: DropshipOrderOpsIntakeLine[];
  economicsSnapshot: DropshipOrderOpsEconomicsSnapshot | null;
  shippingQuoteSnapshot: DropshipOrderOpsShippingQuoteSnapshot | null;
  walletLedgerEntry: DropshipOrderOpsWalletLedgerEntry | null;
  trackingPushes: DropshipOrderOpsTrackingPushSummary[];
  auditEvents: DropshipOrderOpsAuditEventDetail[];
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

  getIntakeDetail(input: GetDropshipOrderOpsIntakeDetailInput): Promise<DropshipOrderOpsIntakeDetail | null>;

  retryIntake(input: RetryDropshipOrderOpsIntakeInput & {
    now: Date;
  }): Promise<DropshipOrderOpsActionResult>;

  markException(input: MarkDropshipOrderOpsExceptionInput & {
    now: Date;
  }): Promise<DropshipOrderOpsActionResult>;
}

export interface DropshipOrderOpsProcessor {
  processIntake(input: {
    intakeId: number;
    workerId: string;
    idempotencyKey: string;
  }): Promise<DropshipOrderProcessingResult>;
}

export class DropshipOrderOpsService {
  constructor(
    private readonly deps: {
      repository: DropshipOrderOpsRepository;
      processor?: DropshipOrderOpsProcessor;
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

  async getIntakeDetail(input: unknown): Promise<DropshipOrderOpsIntakeDetail> {
    const parsed = parseDetailInput(input);
    const detail = await this.deps.repository.getIntakeDetail(parsed);
    if (!detail) {
      throw new DropshipError(
        "DROPSHIP_ORDER_OPS_INTAKE_NOT_FOUND",
        "Dropship order intake was not found.",
        {
          intakeId: parsed.intakeId,
          vendorId: parsed.vendorId,
          storeConnectionId: parsed.storeConnectionId,
        },
      );
    }
    return detail;
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

  async processIntake(input: unknown): Promise<DropshipOrderProcessingResult> {
    const parsed = parseProcessInput(input);
    if (!this.deps.processor) {
      throw new DropshipError(
        "DROPSHIP_ORDER_OPS_PROCESSOR_NOT_CONFIGURED",
        "Dropship order processor is not configured for ops-triggered processing.",
      );
    }

    const result = await this.deps.processor.processIntake({
      intakeId: parsed.intakeId,
      workerId: buildOpsProcessorWorkerId(parsed.actor),
      idempotencyKey: parsed.idempotencyKey,
    });
    this.deps.logger.info({
      code: "DROPSHIP_ORDER_OPS_PROCESS_REQUESTED",
      message: "Dropship order intake processing was requested by ops.",
      context: {
        intakeId: result.intakeId,
        outcome: result.outcome,
        vendorId: result.vendorId,
        storeConnectionId: result.storeConnectionId,
        failureCode: result.failureCode,
        retryable: result.retryable,
        idempotencyKey: parsed.idempotencyKey,
        reason: parsed.reason ?? null,
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

function parseDetailInput(input: unknown): GetDropshipOrderOpsIntakeDetailInput {
  const result = getDropshipOrderOpsIntakeDetailInputSchema.safeParse(input);
  if (!result.success) {
    throw validationError("DROPSHIP_ORDER_OPS_DETAIL_INVALID_INPUT", result.error.issues);
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

function parseProcessInput(input: unknown): ProcessDropshipOrderOpsIntakeInput {
  const result = processDropshipOrderOpsIntakeInputSchema.safeParse(input);
  if (!result.success) {
    throw validationError("DROPSHIP_ORDER_OPS_PROCESS_INVALID_INPUT", result.error.issues);
  }
  return result.data;
}

function buildOpsProcessorWorkerId(actor: DropshipOrderOpsActor): string {
  const suffix = actor.actorId ? `:${actor.actorId}` : "";
  return `dropship-admin-process:${actor.actorType}${suffix}`;
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
