import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";

const DEFAULT_PAYMENT_HOLD_EXPIRATION_LIMIT = 100;
export const DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES = 120;

const expireDropshipPaymentHoldsInputSchema = z.object({
  workerId: z.string().trim().min(1).max(255),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

const notifyExpiringDropshipPaymentHoldsInputSchema = z.object({
  workerId: z.string().trim().min(1).max(255),
  limit: z.number().int().positive().max(500).optional(),
  warningWindowMinutes: z.number().int().positive().max(60 * 24 * 7).optional(),
}).strict();

export interface DropshipExpiringPaymentHoldRecord {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  externalOrderId: string;
  paymentHoldExpiresAt: Date;
}

export interface DropshipExpiredPaymentHoldRecord {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  externalOrderId: string;
  paymentHoldExpiresAt: Date;
  cancellationStatus: "payment_hold_expired";
}

export interface DropshipPaymentHoldExpirationResult {
  expiredCount: number;
  expired: DropshipExpiredPaymentHoldRecord[];
}

export interface DropshipPaymentHoldExpiringNotificationResult {
  notifiedCount: number;
  notified: DropshipExpiringPaymentHoldRecord[];
}

export interface DropshipPaymentHoldExpirationRepository {
  listExpiringPaymentHolds(input: {
    now: Date;
    warningWindowMinutes: number;
    limit: number;
  }): Promise<DropshipExpiringPaymentHoldRecord[]>;

  expirePaymentHolds(input: {
    now: Date;
    limit: number;
    workerId: string;
  }): Promise<DropshipExpiredPaymentHoldRecord[]>;
}

export class DropshipPaymentHoldExpirationService {
  constructor(
    private readonly deps: {
      repository: DropshipPaymentHoldExpirationRepository;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async expireExpiredPaymentHolds(input: unknown): Promise<DropshipPaymentHoldExpirationResult> {
    const parsed = parseExpirePaymentHoldsInput(input);
    const now = this.deps.clock.now();
    const expired = await this.deps.repository.expirePaymentHolds({
      now,
      limit: parsed.limit ?? DEFAULT_PAYMENT_HOLD_EXPIRATION_LIMIT,
      workerId: parsed.workerId,
    });

    if (expired.length > 0) {
      this.deps.logger.warn({
        code: "DROPSHIP_PAYMENT_HOLDS_EXPIRED",
        message: "Expired dropship payment holds were cancelled.",
        context: {
          expiredCount: expired.length,
          workerId: parsed.workerId,
          intakeIds: expired.map((hold) => hold.intakeId),
        },
      });
    }

    for (const hold of expired) {
      await sendDropshipNotificationSafely(this.deps, {
        vendorId: hold.vendorId,
        eventType: "dropship_order_payment_hold_expired",
        critical: true,
        channels: ["email", "in_app"],
        title: "Dropship order payment hold expired",
        message: `Order ${hold.externalOrderId} payment hold expired and marketplace cancellation is being processed.`,
        payload: {
          intakeId: hold.intakeId,
          vendorId: hold.vendorId,
          storeConnectionId: hold.storeConnectionId,
          externalOrderId: hold.externalOrderId,
          paymentHoldExpiresAt: hold.paymentHoldExpiresAt.toISOString(),
          cancellationStatus: hold.cancellationStatus,
        },
        idempotencyKey: `payment-hold-expiration:${hold.intakeId}:expired`,
      }, {
        code: "DROPSHIP_PAYMENT_HOLD_EXPIRATION_NOTIFICATION_FAILED",
        message: "Dropship payment hold expiration notification failed after the hold was cancelled.",
        context: {
          intakeId: hold.intakeId,
          vendorId: hold.vendorId,
          storeConnectionId: hold.storeConnectionId,
          externalOrderId: hold.externalOrderId,
        },
      });
    }

    return {
      expiredCount: expired.length,
      expired,
    };
  }

  async notifyExpiringPaymentHolds(input: unknown): Promise<DropshipPaymentHoldExpiringNotificationResult> {
    const parsed = parseNotifyExpiringPaymentHoldsInput(input);
    const now = this.deps.clock.now();
    const warningWindowMinutes = parsed.warningWindowMinutes ?? DEFAULT_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES;
    const expiring = await this.deps.repository.listExpiringPaymentHolds({
      now,
      warningWindowMinutes,
      limit: parsed.limit ?? DEFAULT_PAYMENT_HOLD_EXPIRATION_LIMIT,
    });

    for (const hold of expiring) {
      const minutesUntilExpiration = Math.max(
        0,
        Math.ceil((hold.paymentHoldExpiresAt.getTime() - now.getTime()) / 60_000),
      );
      await sendDropshipNotificationSafely(this.deps, {
        vendorId: hold.vendorId,
        eventType: "dropship_order_payment_hold_expiring",
        critical: true,
        channels: ["email", "in_app"],
        title: "Dropship order payment hold expiring",
        message: `Order ${hold.externalOrderId} payment hold expires in ${minutesUntilExpiration} minute${minutesUntilExpiration === 1 ? "" : "s"}.`,
        payload: {
          intakeId: hold.intakeId,
          vendorId: hold.vendorId,
          storeConnectionId: hold.storeConnectionId,
          externalOrderId: hold.externalOrderId,
          paymentHoldExpiresAt: hold.paymentHoldExpiresAt.toISOString(),
          minutesUntilExpiration,
          warningWindowMinutes,
        },
        idempotencyKey: `payment-hold-expiring:${hold.intakeId}:${hold.paymentHoldExpiresAt.toISOString()}`,
      }, {
        code: "DROPSHIP_PAYMENT_HOLD_EXPIRING_NOTIFICATION_FAILED",
        message: "Dropship payment hold expiring notification failed.",
        context: {
          intakeId: hold.intakeId,
          vendorId: hold.vendorId,
          storeConnectionId: hold.storeConnectionId,
          externalOrderId: hold.externalOrderId,
        },
      });
    }

    if (expiring.length > 0) {
      this.deps.logger.warn({
        code: "DROPSHIP_PAYMENT_HOLDS_EXPIRING",
        message: "Dropship payment holds are approaching expiration.",
        context: {
          notifiedCount: expiring.length,
          warningWindowMinutes,
          workerId: parsed.workerId,
          intakeIds: expiring.map((hold) => hold.intakeId),
        },
      });
    }

    return {
      notifiedCount: expiring.length,
      notified: expiring,
    };
  }
}

export function makeDropshipPaymentHoldExpirationLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipPaymentHoldExpirationEvent("info", event),
    warn: (event) => logDropshipPaymentHoldExpirationEvent("warn", event),
    error: (event) => logDropshipPaymentHoldExpirationEvent("error", event),
  };
}

export const systemDropshipPaymentHoldExpirationClock: DropshipClock = {
  now: () => new Date(),
};

function parseExpirePaymentHoldsInput(input: unknown): z.infer<typeof expireDropshipPaymentHoldsInputSchema> {
  const result = expireDropshipPaymentHoldsInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_PAYMENT_HOLD_EXPIRATION_INVALID_INPUT",
      "Dropship payment hold expiration input failed validation.",
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

function parseNotifyExpiringPaymentHoldsInput(input: unknown): z.infer<typeof notifyExpiringDropshipPaymentHoldsInputSchema> {
  const result = notifyExpiringDropshipPaymentHoldsInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_PAYMENT_HOLD_EXPIRING_NOTIFICATION_INVALID_INPUT",
      "Dropship payment hold expiring notification input failed validation.",
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

function logDropshipPaymentHoldExpirationEvent(
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
