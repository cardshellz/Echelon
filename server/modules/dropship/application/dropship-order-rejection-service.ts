import { DropshipError } from "../domain/errors";
import type { DropshipOrderIntakeStatus } from "./dropship-order-intake-service";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
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

    return result;
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
