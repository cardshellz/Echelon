import { DropshipError } from "../domain/errors";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import type { DropshipOrderIntakeStatus } from "./dropship-order-intake-service";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import {
  rejectDropshipOrderInputSchema,
  type RejectDropshipOrderInput,
} from "./dropship-use-case-dtos";

export interface DropshipOrderRejectionResult {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  externalOrderId: string;
  externalOrderNumber: string | null;
  previousStatus: DropshipOrderIntakeStatus;
  status: DropshipOrderIntakeStatus;
  cancellationStatus: string | null;
  rejectionReason: string;
  idempotentReplay: boolean;
  rejectedAt: Date;
}

export interface DropshipOrderRejectionRepository {
  rejectOrder(input: RejectDropshipOrderInput & {
    rejectedAt: Date;
  }): Promise<DropshipOrderRejectionResult>;
}

export class DropshipOrderRejectionService {
  constructor(
    private readonly deps: {
      repository: DropshipOrderRejectionRepository;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async rejectOrder(input: unknown): Promise<DropshipOrderRejectionResult> {
    const parsed = parseOrderRejectionInput(input);
    const result = await this.deps.repository.rejectOrder({
      ...parsed,
      rejectedAt: this.deps.clock.now(),
    });

    this.deps.logger.warn({
      code: "DROPSHIP_ORDER_REJECTED_BY_VENDOR",
      message: "Dropship order intake was rejected by the vendor.",
      context: {
        intakeId: result.intakeId,
        vendorId: result.vendorId,
        storeConnectionId: result.storeConnectionId,
        externalOrderId: result.externalOrderId,
        previousStatus: result.previousStatus,
        status: result.status,
        cancellationStatus: result.cancellationStatus,
        idempotentReplay: result.idempotentReplay,
        idempotencyKey: parsed.idempotencyKey,
      },
    });

    if (!result.idempotentReplay) {
      await this.notifyOrderRejected(result, parsed);
    }

    return result;
  }

  private async notifyOrderRejected(
    result: DropshipOrderRejectionResult,
    input: RejectDropshipOrderInput,
  ): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: result.vendorId,
      eventType: "dropship_order_rejected",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship order rejected",
      message: `Order ${result.externalOrderNumber || result.externalOrderId} was rejected and marketplace cancellation is being processed.`,
      payload: {
        intakeId: result.intakeId,
        vendorId: result.vendorId,
        storeConnectionId: result.storeConnectionId,
        externalOrderId: result.externalOrderId,
        externalOrderNumber: result.externalOrderNumber,
        previousStatus: result.previousStatus,
        status: result.status,
        cancellationStatus: result.cancellationStatus,
        rejectionReason: result.rejectionReason,
        rejectedAt: result.rejectedAt.toISOString(),
        actorType: input.actor.actorType,
        actorId: input.actor.actorId ?? null,
      },
      idempotencyKey: `order-rejected:${result.intakeId}:${input.idempotencyKey}`,
    }, {
      code: "DROPSHIP_ORDER_REJECTION_NOTIFICATION_FAILED",
      message: "Dropship order rejection notification failed after vendor rejection.",
      context: {
        intakeId: result.intakeId,
        vendorId: result.vendorId,
        storeConnectionId: result.storeConnectionId,
        externalOrderId: result.externalOrderId,
      },
    });
  }
}

export function makeDropshipOrderRejectionLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOrderRejectionEvent("info", event),
    warn: (event) => logDropshipOrderRejectionEvent("warn", event),
    error: (event) => logDropshipOrderRejectionEvent("error", event),
  };
}

export const systemDropshipOrderRejectionClock: DropshipClock = {
  now: () => new Date(),
};

function parseOrderRejectionInput(input: unknown): RejectDropshipOrderInput {
  const result = rejectDropshipOrderInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_REJECTION_INVALID_INPUT",
      "Dropship order rejection input failed validation.",
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

function logDropshipOrderRejectionEvent(
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
