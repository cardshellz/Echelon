import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import type {
  DropshipMarketplaceTrackingProvider,
  DropshipMarketplaceTrackingRequest,
  DropshipMarketplaceTrackingResult,
} from "./dropship-marketplace-tracking-provider";

export interface DropshipMarketplaceTrackingPushRecord {
  pushId: number;
  intakeId: number;
  omsOrderId: number;
  wmsShipmentId: number | null;
  vendorId: number;
  storeConnectionId: number;
  platform: DropshipMarketplaceTrackingRequest["platform"];
  status: string;
  externalOrderId: string;
  trackingNumber: string;
  carrier: string;
  attemptCount: number;
  externalFulfillmentId: string | null;
}

export type DropshipMarketplaceTrackingClaim =
  | { status: "not_dropship" }
  | { status: "already_succeeded"; push: DropshipMarketplaceTrackingPushRecord }
  | {
      status: "claimed";
      push: DropshipMarketplaceTrackingPushRecord;
      request: DropshipMarketplaceTrackingRequest;
    };

export interface DropshipMarketplaceTrackingRepository {
  claimForOmsOrder(input: {
    omsOrderId: number;
    wmsShipmentId?: number | null;
    carrier: string;
    trackingNumber: string;
    shippedAt: Date;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipMarketplaceTrackingClaim>;
  completePush(input: {
    pushId: number;
    result: DropshipMarketplaceTrackingResult;
    now: Date;
  }): Promise<DropshipMarketplaceTrackingPushRecord>;
  failPush(input: {
    pushId: number;
    code: string;
    message: string;
    retryable: boolean;
    now: Date;
  }): Promise<DropshipMarketplaceTrackingPushRecord>;
}

export interface DropshipMarketplaceTrackingServiceDependencies {
  repository: DropshipMarketplaceTrackingRepository;
  provider: DropshipMarketplaceTrackingProvider;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export interface PushDropshipTrackingForOmsOrderInput {
  omsOrderId: number;
  wmsShipmentId?: number | null;
  carrier: string;
  trackingNumber: string;
  shippedAt: Date;
  idempotencyKey?: string;
}

export type PushDropshipTrackingForOmsOrderResult =
  | { status: "not_dropship" }
  | { status: "already_succeeded"; push: DropshipMarketplaceTrackingPushRecord }
  | { status: "succeeded"; push: DropshipMarketplaceTrackingPushRecord };

export class DropshipMarketplaceTrackingService {
  constructor(private readonly deps: DropshipMarketplaceTrackingServiceDependencies) {}

  async pushForOmsOrder(
    input: PushDropshipTrackingForOmsOrderInput,
  ): Promise<PushDropshipTrackingForOmsOrderResult> {
    validatePushInput(input);
    const now = this.deps.clock.now();
    const idempotencyKey = input.idempotencyKey
      ?? buildTrackingIdempotencyKey(
        input.omsOrderId,
        input.carrier,
        input.trackingNumber,
        input.wmsShipmentId,
      );

    const claim = await this.deps.repository.claimForOmsOrder({
      omsOrderId: input.omsOrderId,
      wmsShipmentId: input.wmsShipmentId ?? null,
      carrier: input.carrier.trim(),
      trackingNumber: input.trackingNumber.trim(),
      shippedAt: input.shippedAt,
      idempotencyKey,
      now,
    });
    if (claim.status === "not_dropship") {
      return { status: "not_dropship" };
    }
    if (claim.status === "already_succeeded") {
      return { status: "already_succeeded", push: claim.push };
    }

    try {
      const result = await this.deps.provider.pushTracking(claim.request);
      const push = await this.deps.repository.completePush({
        pushId: claim.push.pushId,
        result,
        now: this.deps.clock.now(),
      });
      this.deps.logger.info({
        code: "DROPSHIP_MARKETPLACE_TRACKING_PUSHED",
        message: "Dropship marketplace tracking was pushed.",
        context: {
          pushId: push.pushId,
          intakeId: push.intakeId,
          omsOrderId: push.omsOrderId,
          wmsShipmentId: push.wmsShipmentId,
          storeConnectionId: push.storeConnectionId,
          platform: push.platform,
          externalFulfillmentId: push.externalFulfillmentId,
        },
      });
      return { status: "succeeded", push };
    } catch (error: any) {
      const code = error instanceof DropshipError
        ? error.code
        : "DROPSHIP_MARKETPLACE_TRACKING_PUSH_FAILED";
      const retryable = error instanceof DropshipError
        ? error.context?.retryable !== false
        : true;
      await this.deps.repository.failPush({
        pushId: claim.push.pushId,
        code,
        message: error?.message ?? String(error),
        retryable,
        now: this.deps.clock.now(),
      });
      throw error;
    }
  }
}

export const systemDropshipMarketplaceTrackingClock: DropshipClock = {
  now: () => new Date(),
};

export function makeDropshipMarketplaceTrackingLogger(): DropshipLogger {
  return {
    info(event) {
      console.log(`[DropshipMarketplaceTracking] ${event.code}: ${event.message}`, event.context ?? {});
    },
    warn(event) {
      console.warn(`[DropshipMarketplaceTracking] ${event.code}: ${event.message}`, event.context ?? {});
    },
    error(event) {
      console.error(`[DropshipMarketplaceTracking] ${event.code}: ${event.message}`, event.context ?? {});
    },
  };
}

function validatePushInput(input: PushDropshipTrackingForOmsOrderInput): void {
  if (!Number.isInteger(input.omsOrderId) || input.omsOrderId <= 0) {
    throw new DropshipError("DROPSHIP_TRACKING_OMS_ORDER_ID_INVALID", "OMS order id must be a positive integer.", {
      omsOrderId: input.omsOrderId,
      retryable: false,
    });
  }
  if (
    input.wmsShipmentId !== undefined &&
    input.wmsShipmentId !== null &&
    (!Number.isInteger(input.wmsShipmentId) || input.wmsShipmentId <= 0)
  ) {
    throw new DropshipError("DROPSHIP_TRACKING_WMS_SHIPMENT_ID_INVALID", "WMS shipment id must be a positive integer.", {
      omsOrderId: input.omsOrderId,
      wmsShipmentId: input.wmsShipmentId,
      retryable: false,
    });
  }
  if (!input.carrier?.trim()) {
    throw new DropshipError("DROPSHIP_TRACKING_CARRIER_REQUIRED", "Carrier is required for tracking push.", {
      omsOrderId: input.omsOrderId,
      retryable: false,
    });
  }
  if (!input.trackingNumber?.trim()) {
    throw new DropshipError("DROPSHIP_TRACKING_NUMBER_REQUIRED", "Tracking number is required for tracking push.", {
      omsOrderId: input.omsOrderId,
      retryable: false,
    });
  }
  if (!(input.shippedAt instanceof Date) || Number.isNaN(input.shippedAt.getTime())) {
    throw new DropshipError("DROPSHIP_TRACKING_SHIPPED_AT_INVALID", "A valid shippedAt timestamp is required.", {
      omsOrderId: input.omsOrderId,
      retryable: false,
    });
  }
}

function buildTrackingIdempotencyKey(
  omsOrderId: number,
  carrier: string,
  trackingNumber: string,
  wmsShipmentId?: number | null,
): string {
  if (wmsShipmentId !== undefined && wmsShipmentId !== null) {
    return `dropship:tracking:${omsOrderId}:shipment:${wmsShipmentId}:${carrier.trim().toLowerCase()}:${trackingNumber.trim()}`;
  }
  return `dropship:tracking:${omsOrderId}:${carrier.trim().toLowerCase()}:${trackingNumber.trim()}`;
}
