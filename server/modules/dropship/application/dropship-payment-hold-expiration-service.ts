import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

const DEFAULT_PAYMENT_HOLD_EXPIRATION_LIMIT = 100;

const expireDropshipPaymentHoldsInputSchema = z.object({
  workerId: z.string().trim().min(1).max(255),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

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

export interface DropshipPaymentHoldExpirationRepository {
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

    return {
      expiredCount: expired.length,
      expired,
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
