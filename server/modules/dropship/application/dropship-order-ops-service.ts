import { DropshipError } from "../domain/errors";
import type { DropshipOrderIntakeStatus, NormalizedDropshipOrderPayload } from "./dropship-order-intake-service";
import type { DropshipTrackingPushStatus } from "./dropship-tracking-push-ops-dtos";
import {
  getDropshipOrderOpsIntakeDetailInputSchema,
  listDropshipOrderOpsIntakesInputSchema,
  markDropshipOrderOpsExceptionInputSchema,
  processDropshipOrderOpsIntakeInputSchema,
  retryDropshipOrderOpsWmsSyncInputSchema,
  retryDropshipOrderOpsCancellationInputSchema,
  retryDropshipOrderOpsIntakeInputSchema,
  type GetDropshipOrderOpsIntakeDetailInput,
  type ListDropshipOrderOpsIntakesInput,
  type MarkDropshipOrderOpsExceptionInput,
  type DropshipOrderOpsCancellationStatus,
  type ProcessDropshipOrderOpsIntakeInput,
  type RetryDropshipOrderOpsCancellationInput,
  type RetryDropshipOrderOpsIntakeInput,
  type RetryDropshipOrderOpsWmsSyncInput,
} from "./dropship-order-ops-dtos";
import type { DropshipOrderProcessingResult } from "./dropship-order-processing-service";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipOmsFulfillmentSync,
  DropshipOmsFulfillmentSyncRetryQueue,
} from "./dropship-ports";

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
  launchReady: boolean;
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

export interface DropshipOrderOpsTrackingLineItemSummary {
  externalLineItemId: string | null;
  sku: string | null;
  title: string | null;
  productVariantId: number | null;
  quantity: number;
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
  lineItems: DropshipOrderOpsTrackingLineItemSummary[];
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

export interface DropshipOrderOpsCancellationStatusSummary {
  cancellationStatus: DropshipOrderOpsCancellationStatus | string;
  count: number;
}

export interface DropshipOrderOpsIntakeListResult {
  items: DropshipOrderOpsIntakeListItem[];
  total: number;
  page: number;
  limit: number;
  statuses: DropshipOrderIntakeStatus[];
  summary: DropshipOrderOpsStatusSummary[];
  cancellationSummary: DropshipOrderOpsCancellationStatusSummary[];
}

export interface DropshipOrderOpsActionResult {
  intakeId: number;
  previousStatus: DropshipOrderIntakeStatus;
  status: DropshipOrderIntakeStatus;
  idempotentReplay: boolean;
  updatedAt: Date;
}

export interface DropshipOrderOpsCancellationActionResult extends DropshipOrderOpsActionResult {
  previousCancellationStatus: string | null;
  cancellationStatus: string | null;
}

export interface DropshipOrderOpsWmsSyncActionTarget {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  externalOrderId: string;
  status: DropshipOrderIntakeStatus;
  omsOrderId: number | null;
  updatedAt: Date;
}

export interface DropshipOrderOpsWmsSyncActionResult {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  omsOrderId: number;
  outcome: "synced" | "queued";
  wmsOrderId: number | null;
  retryQueued: boolean;
  failureMessage: string | null;
  updatedAt: Date;
}

export interface DropshipOrderOpsRepository {
  listIntakes(input: ListDropshipOrderOpsIntakesInput & {
    statuses: DropshipOrderIntakeStatus[];
  }): Promise<DropshipOrderOpsIntakeListResult>;

  getIntakeDetail(input: GetDropshipOrderOpsIntakeDetailInput): Promise<DropshipOrderOpsIntakeDetail | null>;

  getWmsSyncActionTarget(input: {
    intakeId: number;
  }): Promise<DropshipOrderOpsWmsSyncActionTarget | null>;

  retryIntake(input: RetryDropshipOrderOpsIntakeInput & {
    now: Date;
  }): Promise<DropshipOrderOpsActionResult>;

  retryMarketplaceCancellation(input: RetryDropshipOrderOpsCancellationInput & {
    now: Date;
  }): Promise<DropshipOrderOpsCancellationActionResult>;

  markException(input: MarkDropshipOrderOpsExceptionInput & {
    now: Date;
  }): Promise<DropshipOrderOpsActionResult>;

  recordWmsSyncAction(input: RetryDropshipOrderOpsWmsSyncInput & {
    target: DropshipOrderOpsWmsSyncActionTarget & { omsOrderId: number };
    now: Date;
    outcome: DropshipOrderOpsWmsSyncActionResult["outcome"];
    wmsOrderId: number | null;
    retryQueued: boolean;
    failureMessage: string | null;
  }): Promise<void>;
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
      fulfillmentSync?: DropshipOmsFulfillmentSync;
      fulfillmentSyncRetryQueue?: DropshipOmsFulfillmentSyncRetryQueue;
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

  async retryMarketplaceCancellation(input: unknown): Promise<DropshipOrderOpsCancellationActionResult> {
    const parsed = parseRetryCancellationInput(input);
    const result = await this.deps.repository.retryMarketplaceCancellation({
      ...parsed,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: "DROPSHIP_ORDER_OPS_CANCELLATION_RETRY_REQUESTED",
      message: "Dropship marketplace cancellation retry was requested by ops.",
      context: {
        intakeId: result.intakeId,
        previousStatus: result.previousStatus,
        status: result.status,
        previousCancellationStatus: result.previousCancellationStatus,
        cancellationStatus: result.cancellationStatus,
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

  async retryWmsSync(input: unknown): Promise<DropshipOrderOpsWmsSyncActionResult> {
    const parsed = parseRetryWmsSyncInput(input);
    const target = await this.deps.repository.getWmsSyncActionTarget({ intakeId: parsed.intakeId });
    if (!target) {
      throw new DropshipError(
        "DROPSHIP_ORDER_OPS_INTAKE_NOT_FOUND",
        "Dropship order intake was not found.",
        { intakeId: parsed.intakeId },
      );
    }
    if (target.status !== "accepted") {
      throw new DropshipError(
        "DROPSHIP_ORDER_OPS_STATUS_NOT_ACTIONABLE",
        "Dropship order intake is not accepted and cannot be synced to WMS.",
        { intakeId: target.intakeId, status: target.status },
      );
    }
    if (target.omsOrderId === null) {
      throw new DropshipError(
        "DROPSHIP_ORDER_OPS_STATUS_NOT_ACTIONABLE",
        "Accepted dropship order intake has no OMS order id to sync to WMS.",
        { intakeId: target.intakeId, status: target.status },
      );
    }

    const now = this.deps.clock.now();
    const result = await this.runWmsSyncRepair({
      target: { ...target, omsOrderId: target.omsOrderId },
    });
    await this.deps.repository.recordWmsSyncAction({
      ...parsed,
      target: { ...target, omsOrderId: target.omsOrderId },
      now,
      outcome: result.outcome,
      wmsOrderId: result.wmsOrderId,
      retryQueued: result.retryQueued,
      failureMessage: result.failureMessage,
    });

    this.deps.logger[result.outcome === "synced" ? "info" : "warn"]({
      code: "DROPSHIP_ORDER_OPS_WMS_SYNC_RETRY_REQUESTED",
      message: "Dropship order WMS sync repair was requested by ops.",
      context: {
        intakeId: target.intakeId,
        vendorId: target.vendorId,
        storeConnectionId: target.storeConnectionId,
        omsOrderId: target.omsOrderId,
        outcome: result.outcome,
        wmsOrderId: result.wmsOrderId,
        retryQueued: result.retryQueued,
        failureMessage: result.failureMessage,
        idempotencyKey: parsed.idempotencyKey,
        reason: parsed.reason ?? null,
      },
    });

    return {
      ...result,
      updatedAt: now,
    };
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

  private async runWmsSyncRepair(input: {
    target: DropshipOrderOpsWmsSyncActionTarget & { omsOrderId: number };
  }): Promise<Omit<DropshipOrderOpsWmsSyncActionResult, "updatedAt">> {
    if (this.deps.fulfillmentSync) {
      try {
        const wmsOrderId = await this.deps.fulfillmentSync.syncOmsOrderToWms(input.target.omsOrderId);
        if (wmsOrderId !== null) {
          return {
            intakeId: input.target.intakeId,
            vendorId: input.target.vendorId,
            storeConnectionId: input.target.storeConnectionId,
            omsOrderId: input.target.omsOrderId,
            outcome: "synced",
            wmsOrderId,
            retryQueued: false,
            failureMessage: null,
          };
        }
        return this.queueWmsSyncRepair(input.target, "WMS sync did not return a WMS order id");
      } catch (error) {
        return this.queueWmsSyncRepair(input.target, errorMessage(error));
      }
    }

    return this.queueWmsSyncRepair(input.target, "WMS sync service unavailable");
  }

  private async queueWmsSyncRepair(
    target: DropshipOrderOpsWmsSyncActionTarget & { omsOrderId: number },
    cause: string,
  ): Promise<Omit<DropshipOrderOpsWmsSyncActionResult, "updatedAt">> {
    if (!this.deps.fulfillmentSyncRetryQueue) {
      throw new DropshipError(
        "DROPSHIP_ORDER_OPS_WMS_SYNC_NOT_CONFIGURED",
        "Dropship WMS sync repair could not run because no sync service or retry queue is configured.",
        {
          intakeId: target.intakeId,
          omsOrderId: target.omsOrderId,
          cause,
        },
      );
    }

    try {
      await this.deps.fulfillmentSyncRetryQueue.enqueueOmsWmsSyncRetry({
        omsOrderId: target.omsOrderId,
        cause,
      });
    } catch (error) {
      throw new DropshipError(
        "DROPSHIP_ORDER_OPS_WMS_SYNC_RETRY_ENQUEUE_FAILED",
        "Dropship WMS sync repair failed to enqueue a retry.",
        {
          intakeId: target.intakeId,
          omsOrderId: target.omsOrderId,
          cause,
          error: errorMessage(error),
        },
      );
    }

    return {
      intakeId: target.intakeId,
      vendorId: target.vendorId,
      storeConnectionId: target.storeConnectionId,
      omsOrderId: target.omsOrderId,
      outcome: "queued",
      wmsOrderId: null,
      retryQueued: true,
      failureMessage: cause,
    };
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

function parseRetryCancellationInput(input: unknown): RetryDropshipOrderOpsCancellationInput {
  const result = retryDropshipOrderOpsCancellationInputSchema.safeParse(input);
  if (!result.success) {
    throw validationError("DROPSHIP_ORDER_OPS_CANCELLATION_RETRY_INVALID_INPUT", result.error.issues);
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

function parseRetryWmsSyncInput(input: unknown): RetryDropshipOrderOpsWmsSyncInput {
  const result = retryDropshipOrderOpsWmsSyncInputSchema.safeParse(input);
  if (!result.success) {
    throw validationError("DROPSHIP_ORDER_OPS_WMS_SYNC_INVALID_INPUT", result.error.issues);
  }
  return result.data;
}

function buildOpsProcessorWorkerId(actor: DropshipOrderOpsActor): string {
  const suffix = actor.actorId ? `:${actor.actorId}` : "";
  return `dropship-admin-process:${actor.actorType}${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
