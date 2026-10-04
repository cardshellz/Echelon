import { DropshipError } from "../domain/errors";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import type {
  DropshipMarketplaceTrackingLineItem,
  DropshipMarketplaceTrackingProvider,
  DropshipMarketplaceTrackingRequest,
  DropshipMarketplaceTrackingResult,
} from "./dropship-marketplace-tracking-provider";

/** Longest marketplace line item id accepted: oms.oms_order_lines.external_line_item_id is varchar(100). */
const MAX_EXTERNAL_LINE_ITEM_ID_LENGTH = 100;

/** A shipped line named by the caller, e.g. the channel fulfillment rails' exact command lines. */
export interface DropshipTrackingShippedLine {
  externalLineItemId: string;
  quantity: number;
}

/**
 * Pushes made by the channel fulfillment rails (oms.channel_fulfillment_pushes)
 * carry this key prefix plus the command id. One command maps to one push row,
 * so each command attempt replays the same row instead of pushing again.
 */
const CHANNEL_FULFILLMENT_TRACKING_KEY_PREFIX = "channel-fulfillment-command:";

export function buildChannelFulfillmentTrackingIdempotencyKey(commandId: number): string {
  if (!Number.isSafeInteger(commandId) || commandId <= 0) {
    throw new DropshipError(
      "DROPSHIP_TRACKING_COMMAND_ID_INVALID",
      "Channel fulfillment command id must be a positive integer.",
      { commandId, retryable: false },
    );
  }
  return `${CHANNEL_FULFILLMENT_TRACKING_KEY_PREFIX}${commandId}`;
}

/** The owning channel fulfillment command, or null for a push made outside the rails. */
export function channelFulfillmentCommandIdFromTrackingKey(idempotencyKey: string): number | null {
  if (!idempotencyKey.startsWith(CHANNEL_FULFILLMENT_TRACKING_KEY_PREFIX)) return null;
  const digits = idempotencyKey.slice(CHANNEL_FULFILLMENT_TRACKING_KEY_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(digits)) return null;
  const commandId = Number(digits);
  return Number.isSafeInteger(commandId) ? commandId : null;
}

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
  | { status: "already_processing"; push: DropshipMarketplaceTrackingPushRecord }
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
    /** When given, exactly these lines are pushed instead of lines read from the WMS shipment. */
    lineItems?: readonly DropshipTrackingShippedLine[];
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
  notificationSender?: DropshipNotificationSender;
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
  /**
   * The exact shipped lines and quantities. The channel fulfillment rails pass
   * their command lines here; without it, lines are read from the WMS shipment.
   */
  lineItems?: readonly DropshipTrackingShippedLine[];
}

export type PushDropshipTrackingForOmsOrderResult =
  | { status: "not_dropship" }
  | { status: "already_succeeded"; push: DropshipMarketplaceTrackingPushRecord }
  | { status: "already_processing"; push: DropshipMarketplaceTrackingPushRecord }
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
      ...(input.lineItems ? { lineItems: input.lineItems } : {}),
      now,
    });
    if (claim.status === "not_dropship") {
      return { status: "not_dropship" };
    }
    if (claim.status === "already_succeeded") {
      return { status: "already_succeeded", push: claim.push };
    }
    if (claim.status === "already_processing") {
      this.deps.logger.warn({
        code: "DROPSHIP_MARKETPLACE_TRACKING_PUSH_ALREADY_PROCESSING",
        message: "Dropship marketplace tracking push is already processing.",
        context: {
          pushId: claim.push.pushId,
          intakeId: claim.push.intakeId,
          omsOrderId: claim.push.omsOrderId,
          wmsShipmentId: claim.push.wmsShipmentId,
          storeConnectionId: claim.push.storeConnectionId,
          platform: claim.push.platform,
          attemptCount: claim.push.attemptCount,
        },
      });
      return { status: "already_processing", push: claim.push };
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
      await this.notifyTrackingPushed(push);
      return { status: "succeeded", push };
    } catch (error: any) {
      const code = error instanceof DropshipError
        ? error.code
        : "DROPSHIP_MARKETPLACE_TRACKING_PUSH_FAILED";
      const retryable = error instanceof DropshipError
        ? error.context?.retryable !== false
        : true;
      const failedPush = await this.deps.repository.failPush({
        pushId: claim.push.pushId,
        code,
        message: error?.message ?? String(error),
        retryable,
        now: this.deps.clock.now(),
      });
      await this.notifyTrackingFailed(failedPush, {
        code,
        message: error?.message ?? String(error),
        retryable,
      });
      throw error;
    }
  }

  private async notifyTrackingPushed(
    push: DropshipMarketplaceTrackingPushRecord,
  ): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: push.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.TRACKING_PUSHED,
      critical: false,
      channels: ["email", "in_app"],
      title: "Dropship tracking pushed",
      message: `Tracking ${push.trackingNumber} was pushed to ${push.platform} for order ${push.externalOrderId}.`,
      payload: buildTrackingNotificationPayload(push),
      idempotencyKey: `tracking-pushed:${push.pushId}`,
    }, {
      code: "DROPSHIP_TRACKING_PUSH_NOTIFICATION_FAILED",
      message: "Dropship tracking success notification failed after marketplace push.",
      context: {
        pushId: push.pushId,
        intakeId: push.intakeId,
        omsOrderId: push.omsOrderId,
        vendorId: push.vendorId,
        storeConnectionId: push.storeConnectionId,
      },
    });
  }

  private async notifyTrackingFailed(
    push: DropshipMarketplaceTrackingPushRecord,
    failure: {
      code: string;
      message: string;
      retryable: boolean;
    },
  ): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: push.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.TRACKING_PUSH_FAILED,
      critical: !failure.retryable,
      channels: ["email", "in_app"],
      title: failure.retryable ? "Dropship tracking push retrying" : "Dropship tracking push failed",
      message: `Tracking ${push.trackingNumber} could not be pushed to ${push.platform} for order ${push.externalOrderId}: ${failure.message}`,
      payload: {
        ...buildTrackingNotificationPayload(push),
        failureCode: failure.code,
        failureMessage: failure.message,
        retryable: failure.retryable,
      },
      idempotencyKey: `tracking-push-failed:${push.pushId}:${push.attemptCount}:${failure.code}`,
    }, {
      code: "DROPSHIP_TRACKING_PUSH_FAILURE_NOTIFICATION_FAILED",
      message: "Dropship tracking failure notification failed after marketplace push failure.",
      context: {
        pushId: push.pushId,
        intakeId: push.intakeId,
        omsOrderId: push.omsOrderId,
        vendorId: push.vendorId,
        storeConnectionId: push.storeConnectionId,
        failureCode: failure.code,
      },
    });
  }
}

function buildTrackingNotificationPayload(
  push: DropshipMarketplaceTrackingPushRecord,
): Record<string, unknown> {
  return {
    pushId: push.pushId,
    intakeId: push.intakeId,
    omsOrderId: push.omsOrderId,
    wmsShipmentId: push.wmsShipmentId,
    vendorId: push.vendorId,
    storeConnectionId: push.storeConnectionId,
    platform: push.platform,
    status: push.status,
    externalOrderId: push.externalOrderId,
    trackingNumber: push.trackingNumber,
    carrier: push.carrier,
    attemptCount: push.attemptCount,
    externalFulfillmentId: push.externalFulfillmentId,
  };
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
  if (input.lineItems !== undefined) {
    validateShippedLines(input.omsOrderId, input.lineItems);
  }
}

function validateShippedLines(
  omsOrderId: number,
  lineItems: readonly DropshipMarketplaceTrackingLineItem[],
): void {
  const invalid = (reason: string): DropshipError => new DropshipError(
    "DROPSHIP_TRACKING_LINE_ITEMS_INVALID",
    "Tracking push line items must be distinct marketplace lines with positive whole quantities.",
    { omsOrderId, reason, retryable: false },
  );
  if (!Array.isArray(lineItems) || lineItems.length === 0) throw invalid("empty");
  const seen = new Set<string>();
  for (const item of lineItems) {
    const id = item.externalLineItemId;
    if (
      typeof id !== "string"
      || id.length === 0
      || id.length > MAX_EXTERNAL_LINE_ITEM_ID_LENGTH
      || id.trim() !== id
    ) {
      throw invalid("line_id");
    }
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw invalid("quantity");
    if (seen.has(id)) throw invalid("duplicate_line");
    seen.add(id);
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
