import { randomUUID } from "node:crypto";

import type {
  ChannelFulfillmentAuthorityService,
} from "./channel-fulfillment-authority.service";
import {
  FulfillmentAuthorityError,
} from "./channel-fulfillment-authority.repository";
import type {
  ChannelFulfillmentIngressRepository,
  IngressEngineCancellationCandidate,
  IngressInventoryItem,
} from "./channel-fulfillment-ingress.repository";
import {
  ChannelFulfillmentIngressError,
  normalizeChannelFulfillmentIngress,
  type ChannelFulfillmentIngressInput,
  type NormalizedChannelFulfillmentIngress,
} from "./channel-fulfillment-ingress";

const DEFAULT_RECEIPT_LEASE_DURATION_MS = 120_000;

export interface ChannelFulfillmentIngressClock {
  now(): Date;
}

export interface ChannelFulfillmentIngressLogger {
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
  error(event: Readonly<Record<string, unknown>>): void;
}

export interface ChannelFulfillmentInventoryRecorder {
  recordShipment(input: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    shipmentId: string;
    shipmentItemId: number;
    userId: string;
    deductFromOnHandOnly: boolean;
  }): Promise<void>;
}

export interface ChannelFulfillmentIngressResult {
  readonly receiptId: number;
  readonly processingStatus: "processed" | "ignored" | "review";
  readonly physicalShipmentId: number | null;
  readonly sourceEcho: boolean;
  readonly replayed: boolean;
  readonly inventoryFailures: number;
  readonly cancellationFailures: number;
  readonly partialOverlapShipmentIds: readonly number[];
}

export interface ChannelFulfillmentIngressDependencies {
  readonly repository: ChannelFulfillmentIngressRepository;
  readonly authority: Pick<
    ChannelFulfillmentAuthorityService,
    "recordPhysicalPackage" | "projectPhysicalPackage"
  >;
  readonly inventory: ChannelFulfillmentInventoryRecorder;
  readonly cancelEngineShipment: (
    candidate: IngressEngineCancellationCandidate,
    occurredAt: Date,
  ) => Promise<void>;
  readonly clock?: ChannelFulfillmentIngressClock;
  readonly logger?: ChannelFulfillmentIngressLogger;
  readonly createLeaseToken?: () => string;
  readonly leaseDurationMs?: number;
}

export interface ChannelFulfillmentIngressService {
  process(input: ChannelFulfillmentIngressInput): Promise<ChannelFulfillmentIngressResult>;
}

interface ProcessingFailure {
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
}

function defaultLogger(): ChannelFulfillmentIngressLogger {
  return {
    info: (event) => console.log(JSON.stringify(event)),
    warn: (event) => console.warn(JSON.stringify(event)),
    error: (event) => console.error(JSON.stringify(event)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (error instanceof ChannelFulfillmentIngressError) return error.code;
  if (error instanceof FulfillmentAuthorityError) return error.code;
  if (typeof (error as any)?.code === "string") return String((error as any).code);
  return "CHANNEL_FULFILLMENT_INGRESS_FAILED";
}

function errorContext(error: unknown): Readonly<Record<string, unknown>> {
  if (
    error instanceof ChannelFulfillmentIngressError
    || error instanceof FulfillmentAuthorityError
  ) {
    return error.context;
  }
  return Object.freeze({});
}

function shouldRouteToReview(error: unknown): boolean {
  if (error instanceof ChannelFulfillmentIngressError) return error.reviewRequired;
  return error instanceof FulfillmentAuthorityError;
}

function inventoryFailure(
  item: IngressInventoryItem,
  error: unknown,
): ProcessingFailure {
  return Object.freeze({
    code: "INVENTORY_RECORD_FAILED",
    message: errorMessage(error),
    context: Object.freeze({
      legacyWmsShipmentId: item.legacyWmsShipmentId,
      legacyWmsShipmentItemId: item.legacyWmsShipmentItemId,
      wmsOrderId: item.wmsOrderId,
      wmsOrderItemId: item.wmsOrderItemId,
      productVariantId: item.productVariantId,
      warehouseLocationId: item.warehouseLocationId,
      quantity: item.quantity,
    }),
  });
}

function cancellationFailure(
  candidate: IngressEngineCancellationCandidate,
  error: unknown,
): ProcessingFailure {
  return Object.freeze({
    code: "ENGINE_CANCEL_FAILED",
    message: errorMessage(error),
    context: Object.freeze({
      wmsShipmentId: candidate.wmsShipmentId,
      engine: candidate.engine,
      engineOrderRef: candidate.engineOrderRef,
      engineShipmentRef: candidate.engineShipmentRef,
    }),
  });
}

async function recordInventory(
  dependencies: ChannelFulfillmentIngressDependencies,
  items: readonly IngressInventoryItem[],
  beforeEach: () => Promise<void>,
): Promise<readonly ProcessingFailure[]> {
  const failures: ProcessingFailure[] = [];
  for (const item of items) {
    await beforeEach();
    if (!item.productVariantId || !item.warehouseLocationId) {
      failures.push(inventoryFailure(item, new Error(
        "Exact product variant and warehouse location lineage are required to post inventory",
      )));
      continue;
    }
    try {
      await dependencies.inventory.recordShipment({
        productVariantId: item.productVariantId,
        warehouseLocationId: item.warehouseLocationId,
        qty: item.quantity,
        orderId: item.wmsOrderId,
        orderItemId: item.wmsOrderItemId,
        shipmentId: String(item.legacyWmsShipmentId),
        shipmentItemId: item.legacyWmsShipmentItemId,
        userId: "system:channel-fulfillment-ingress",
        deductFromOnHandOnly: item.deductFromOnHandOnly,
      });
    } catch (error) {
      failures.push(inventoryFailure(item, error));
    }
  }
  return Object.freeze(failures);
}

async function cancelSupersededEngineShipments(
  dependencies: ChannelFulfillmentIngressDependencies,
  candidates: readonly IngressEngineCancellationCandidate[],
  occurredAt: Date,
  beforeEach: () => Promise<void>,
): Promise<readonly ProcessingFailure[]> {
  const failures: ProcessingFailure[] = [];
  for (const candidate of candidates) {
    await beforeEach();
    try {
      await dependencies.cancelEngineShipment(candidate, occurredAt);
    } catch (error) {
      failures.push(cancellationFailure(candidate, error));
    }
  }
  return Object.freeze(failures);
}

function firstFailure(
  inventoryFailures: readonly ProcessingFailure[],
  cancellationFailures: readonly ProcessingFailure[],
  partialOverlapShipmentIds: readonly number[],
): ProcessingFailure | null {
  if (inventoryFailures.length > 0) return inventoryFailures[0];
  if (cancellationFailures.length > 0) return cancellationFailures[0];
  if (partialOverlapShipmentIds.length > 0) {
    return Object.freeze({
      code: "ENGINE_SHIPMENT_PARTIAL_OVERLAP",
      message: "An open shipping-engine shipment only partially overlaps the externally fulfilled lines",
      context: Object.freeze({ shipmentIds: [...partialOverlapShipmentIds] }),
    });
  }
  return null;
}

async function recordReview(
  repository: ChannelFulfillmentIngressRepository,
  input: {
    receiptId: number;
    leaseToken: string;
    physicalShipmentId?: number | null;
    failure: ProcessingFailure;
    completedAt: Date;
  },
): Promise<void> {
  await repository.recordReviewException({
    receiptId: input.receiptId,
    rule: input.failure.code.toLowerCase(),
    summary: input.failure.message,
    details: input.failure.context,
  });
  await repository.completeReceipt({
    receiptId: input.receiptId,
    leaseToken: input.leaseToken,
    processingStatus: "review",
    physicalShipmentId: input.physicalShipmentId ?? null,
    errorCode: input.failure.code,
    errorMessage: input.failure.message,
    completedAt: input.completedAt,
    metadata: input.failure.context,
  });
}

function logContext(
  input: NormalizedChannelFulfillmentIngress,
  receiptId: number,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    receiptId,
    receiptKey: input.receiptKey,
    sourceProvider: input.sourceProvider,
    sourceChannelId: input.sourceChannelId,
    sourceOrderId: input.sourceOrderId,
    sourceFulfillmentId: input.sourceFulfillmentId,
    sourceEventId: input.sourceEventId,
  });
}

export function createChannelFulfillmentIngressService(
  dependencies: ChannelFulfillmentIngressDependencies,
): ChannelFulfillmentIngressService {
  const clock = dependencies.clock ?? { now: () => new Date() };
  const logger = dependencies.logger ?? defaultLogger();
  const createLeaseToken = dependencies.createLeaseToken ?? randomUUID;
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_RECEIPT_LEASE_DURATION_MS;

  async function process(rawInput: ChannelFulfillmentIngressInput): Promise<ChannelFulfillmentIngressResult> {
    const input = normalizeChannelFulfillmentIngress(rawInput);
    const occurredAt = input.shippedAt ?? clock.now();
    const staged = await dependencies.repository.stageReceipt(input);
    const context = logContext(input, staged.receiptId);
    const requestedLeaseToken = createLeaseToken();
    let activeLeaseToken: string | null = null;
    let activePhysicalShipmentId: number | null = staged.physicalShipmentId;

    const renewLease = async (): Promise<void> => {
      if (!activeLeaseToken) {
        throw new ChannelFulfillmentIngressError(
          "RECEIPT_LEASE_OWNERSHIP_LOST",
          `Receipt ${staged.receiptId} has no active processing lease`,
          { receiptId: staged.receiptId },
          { reviewRequired: false },
        );
      }
      await dependencies.repository.renewReceiptLease({
        receiptId: staged.receiptId,
        leaseToken: activeLeaseToken,
        now: clock.now(),
        leaseDurationMs,
      });
    };

    try {
      const claimed = await dependencies.repository.claimReceipt({
        receiptId: staged.receiptId,
        input,
        now: clock.now(),
        leaseToken: requestedLeaseToken,
        leaseDurationMs,
      });
      if (claimed.terminalReplay) {
        logger.info({ code: "CHANNEL_FULFILLMENT_RECEIPT_REPLAYED", ...context });
        return Object.freeze({
          receiptId: staged.receiptId,
          processingStatus: claimed.sourceEcho ? "ignored" : "processed",
          physicalShipmentId: claimed.physicalShipmentId,
          sourceEcho: claimed.sourceEcho,
          replayed: true,
          inventoryFailures: 0,
          cancellationFailures: 0,
          partialOverlapShipmentIds: Object.freeze([]),
        });
      }
      activeLeaseToken = claimed.leaseToken;
      if (!activeLeaseToken) {
        throw new ChannelFulfillmentIngressError(
          "RECEIPT_LEASE_OWNERSHIP_LOST",
          `Receipt ${staged.receiptId} was claimed without a lease token`,
          { receiptId: staged.receiptId },
          { reviewRequired: false },
        );
      }

      const prepared = await dependencies.repository.prepareReceipt(
        staged.receiptId,
        input,
        activeLeaseToken,
        clock.now(),
      );

      let physicalShipmentId = prepared.physicalShipmentId;
      activePhysicalShipmentId = physicalShipmentId;
      if (!physicalShipmentId) {
        await renewLease();
        const materialized = await dependencies.authority.recordPhysicalPackage({
          legacyWmsShipmentIds: [...prepared.legacyWmsShipmentIds],
          shippingProvider: input.sourceProvider,
          providerPhysicalShipmentId: input.sourceFulfillmentId,
          providerOrderId: input.sourceOrderId,
          providerOrderKey: input.sourceOrderId,
          trackingNumber: input.trackingNumber,
          carrier: input.carrier,
          trackingUrl: input.trackingUrl,
          serviceCode: null,
          shippedAt: input.shippedAt,
          source: input.source,
          correlationId: input.correlationId,
          causationId: input.causationId,
          suppressChannelProviders: [input.sourceProvider],
        }, { executeImmediately: false });
        physicalShipmentId = materialized.materialized.physicalShipmentId;
        activePhysicalShipmentId = physicalShipmentId;
      }

      await renewLease();
      await dependencies.repository.attachPhysicalShipment(
        staged.receiptId,
        physicalShipmentId,
        activeLeaseToken,
        clock.now(),
      );
      if (input.trackingNumber || input.carrier || input.trackingUrl) {
        await dependencies.repository.recordTrackingAmendment(
          staged.receiptId,
          physicalShipmentId,
          activeLeaseToken,
          input,
          occurredAt,
          clock.now(),
        );
      }
      await dependencies.authority.projectPhysicalPackage(physicalShipmentId);

      if (prepared.sourceEcho) {
        await renewLease();
        await dependencies.repository.completeReceipt({
          receiptId: staged.receiptId,
          leaseToken: activeLeaseToken,
          processingStatus: "ignored",
          physicalShipmentId,
          completedAt: clock.now(),
          metadata: Object.freeze({ sourceEcho: true }),
        });
        logger.info({
          code: "CHANNEL_FULFILLMENT_SOURCE_ECHO_IGNORED",
          ...context,
          physicalShipmentId,
        });
        return Object.freeze({
          receiptId: staged.receiptId,
          processingStatus: "ignored",
          physicalShipmentId,
          sourceEcho: true,
          replayed: false,
          inventoryFailures: 0,
          cancellationFailures: 0,
          partialOverlapShipmentIds: Object.freeze([]),
        });
      }

      const inventoryFailures = await recordInventory(
        dependencies,
        prepared.inventoryItems,
        renewLease,
      );
      const cancellationFailures = await cancelSupersededEngineShipments(
        dependencies,
        prepared.cancellationCandidates,
        occurredAt,
        renewLease,
      );
      const failure = firstFailure(
        inventoryFailures,
        cancellationFailures,
        prepared.partialOverlapShipmentIds,
      );
      if (failure) {
        await recordReview(dependencies.repository, {
          receiptId: staged.receiptId,
          leaseToken: activeLeaseToken,
          physicalShipmentId,
          failure,
          completedAt: clock.now(),
        });
        logger.warn({
          code: "CHANNEL_FULFILLMENT_RECEIPT_REVIEW_REQUIRED",
          ...context,
          physicalShipmentId,
          errorCode: failure.code,
          errorMessage: failure.message,
          inventoryFailures: inventoryFailures.length,
          cancellationFailures: cancellationFailures.length,
          partialOverlapShipmentIds: prepared.partialOverlapShipmentIds,
        });
        return Object.freeze({
          receiptId: staged.receiptId,
          processingStatus: "review",
          physicalShipmentId,
          sourceEcho: false,
          replayed: false,
          inventoryFailures: inventoryFailures.length,
          cancellationFailures: cancellationFailures.length,
          partialOverlapShipmentIds: Object.freeze([...prepared.partialOverlapShipmentIds]),
        });
      }

      await renewLease();
      await dependencies.repository.completeReceipt({
        receiptId: staged.receiptId,
        leaseToken: activeLeaseToken,
        processingStatus: "processed",
        physicalShipmentId,
        completedAt: clock.now(),
        metadata: Object.freeze({
          inventoryItemCount: prepared.inventoryItems.length,
          cancellationCandidateCount: prepared.cancellationCandidates.length,
        }),
      });
      logger.info({
        code: "CHANNEL_FULFILLMENT_RECEIPT_PROCESSED",
        ...context,
        physicalShipmentId,
      });
      return Object.freeze({
        receiptId: staged.receiptId,
        processingStatus: "processed",
        physicalShipmentId,
        sourceEcho: false,
        replayed: false,
        inventoryFailures: 0,
        cancellationFailures: 0,
        partialOverlapShipmentIds: Object.freeze([]),
      });
    } catch (error) {
      if (!shouldRouteToReview(error)) {
        logger.error({
          code: "CHANNEL_FULFILLMENT_RECEIPT_TRANSIENT_FAILURE",
          ...context,
          errorCode: errorCode(error),
          errorMessage: errorMessage(error),
        });
        throw error;
      }

      const failure = Object.freeze({
        code: errorCode(error),
        message: errorMessage(error),
        context: errorContext(error),
      });
      if (!activeLeaseToken) throw error;
      await recordReview(dependencies.repository, {
        receiptId: staged.receiptId,
        leaseToken: activeLeaseToken,
        physicalShipmentId: activePhysicalShipmentId,
        failure,
        completedAt: clock.now(),
      });
      logger.warn({
        code: "CHANNEL_FULFILLMENT_RECEIPT_REVIEW_REQUIRED",
        ...context,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      return Object.freeze({
        receiptId: staged.receiptId,
        processingStatus: "review",
        physicalShipmentId: activePhysicalShipmentId,
        sourceEcho: false,
        replayed: false,
        inventoryFailures: failure.code === "INVENTORY_RECORD_FAILED" ? 1 : 0,
        cancellationFailures: failure.code === "ENGINE_CANCEL_FAILED" ? 1 : 0,
        partialOverlapShipmentIds: Object.freeze([]),
      });
    }
  }

  return Object.freeze({ process });
}
