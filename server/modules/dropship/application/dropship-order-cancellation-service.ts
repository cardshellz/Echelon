import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type {
  DropshipMarketplaceOrderCancellationProvider,
  DropshipMarketplaceOrderCancellationReason,
  DropshipMarketplaceOrderCancellationRequest,
  DropshipMarketplaceOrderCancellationResult,
} from "./dropship-marketplace-order-cancellation-provider";

const DEFAULT_CANCELLATION_BATCH_LIMIT = 100;
const PAYMENT_HOLD_EXPIRED_REASON = "Payment hold expired before wallet funds were available.";
const MARKETPLACE_CANCELLATION_FAILED_REASON_PREFIX = "Marketplace cancellation failed:";

const processDropshipOrderCancellationsInputSchema = z.object({
  workerId: z.string().trim().min(1).max(255),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

export interface DropshipOrderCancellationCandidate {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: "ebay" | "shopify";
  externalOrderId: string;
  externalOrderNumber: string | null;
  sourceOrderId: string | null;
  orderedAt: string | null;
  rejectionReason: string | null;
  cancellationStatus:
    | "payment_hold_expired"
    | "order_intake_rejected"
    | "marketplace_cancellation_retrying"
    | "marketplace_cancellation_processing";
}

export interface DropshipOrderCancellationRepository {
  claimPendingCancellations(input: {
    now: Date;
    limit: number;
    workerId: string;
  }): Promise<DropshipOrderCancellationCandidate[]>;

  recordMarketplaceCancellationSuccess(input: {
    candidate: DropshipOrderCancellationCandidate;
    workerId: string;
    now: Date;
    result: DropshipMarketplaceOrderCancellationResult;
  }): Promise<void>;

  recordMarketplaceCancellationFailure(input: {
    candidate: DropshipOrderCancellationCandidate;
    workerId: string;
    now: Date;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
  }): Promise<void>;
}

export interface DropshipOrderCancellationSweepResult {
  claimed: number;
  attempted: number;
  succeeded: number;
  retrying: number;
  failed: number;
}

export class DropshipOrderCancellationService {
  constructor(
    private readonly deps: {
      repository: DropshipOrderCancellationRepository;
      marketplaceCancellation: DropshipMarketplaceOrderCancellationProvider;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async processPendingCancellations(input: unknown): Promise<DropshipOrderCancellationSweepResult> {
    const parsed = parseProcessCancellationsInput(input);
    const now = this.deps.clock.now();
    const candidates = await this.deps.repository.claimPendingCancellations({
      now,
      limit: parsed.limit ?? DEFAULT_CANCELLATION_BATCH_LIMIT,
      workerId: parsed.workerId,
    });
    const result: DropshipOrderCancellationSweepResult = {
      claimed: candidates.length,
      attempted: 0,
      succeeded: 0,
      retrying: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      result.attempted += 1;
      try {
        const cancellation = await this.deps.marketplaceCancellation.cancelOrder(
          buildCancellationRequest(candidate),
        );
        await this.deps.repository.recordMarketplaceCancellationSuccess({
          candidate,
          workerId: parsed.workerId,
          now: this.deps.clock.now(),
          result: cancellation,
        });
        result.succeeded += 1;
        this.deps.logger.info({
          code: "DROPSHIP_MARKETPLACE_ORDER_CANCELLATION_SUCCEEDED",
          message: "Dropship marketplace order cancellation succeeded.",
          context: {
            intakeId: candidate.intakeId,
            vendorId: candidate.vendorId,
            storeConnectionId: candidate.storeConnectionId,
            platform: candidate.platform,
            externalOrderId: candidate.externalOrderId,
            externalCancellationId: cancellation.externalCancellationId,
            status: cancellation.status,
            workerId: parsed.workerId,
          },
        });
      } catch (error) {
        const classified = classifyCancellationError(error);
        await this.deps.repository.recordMarketplaceCancellationFailure({
          candidate,
          workerId: parsed.workerId,
          now: this.deps.clock.now(),
          errorCode: classified.code,
          errorMessage: classified.message,
          retryable: classified.retryable,
        });
        if (classified.retryable) {
          result.retrying += 1;
        } else {
          result.failed += 1;
        }
        this.deps.logger.warn({
          code: "DROPSHIP_MARKETPLACE_ORDER_CANCELLATION_FAILED",
          message: "Dropship marketplace order cancellation failed.",
          context: {
            intakeId: candidate.intakeId,
            vendorId: candidate.vendorId,
            storeConnectionId: candidate.storeConnectionId,
            platform: candidate.platform,
            externalOrderId: candidate.externalOrderId,
            errorCode: classified.code,
            retryable: classified.retryable,
            workerId: parsed.workerId,
          },
        });
      }
    }

    return result;
  }
}

export function buildCancellationRequest(
  candidate: DropshipOrderCancellationCandidate,
): DropshipMarketplaceOrderCancellationRequest {
  return {
    intakeId: candidate.intakeId,
    vendorId: candidate.vendorId,
    storeConnectionId: candidate.storeConnectionId,
    platform: candidate.platform,
    externalOrderId: candidate.externalOrderId,
    externalOrderNumber: candidate.externalOrderNumber,
    sourceOrderId: candidate.sourceOrderId,
    orderedAt: candidate.orderedAt,
    reason: cancellationReasonFromCandidate(candidate),
    idempotencyKey: deriveOrderCancellationIdempotencyKey(candidate),
  };
}

export function deriveOrderCancellationIdempotencyKey(
  candidate: Pick<DropshipOrderCancellationCandidate, "intakeId" | "externalOrderId" | "cancellationStatus">,
): string {
  const digest = createHash("sha256")
    .update(`${candidate.externalOrderId}:${candidate.cancellationStatus}`)
    .digest("hex")
    .slice(0, 32);
  return `order:${candidate.intakeId}:cancel:${digest}`;
}

export function makeDropshipOrderCancellationLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOrderCancellationEvent("info", event),
    warn: (event) => logDropshipOrderCancellationEvent("warn", event),
    error: (event) => logDropshipOrderCancellationEvent("error", event),
  };
}

export const systemDropshipOrderCancellationClock: DropshipClock = {
  now: () => new Date(),
};

function cancellationReasonFromCandidate(
  candidate: DropshipOrderCancellationCandidate,
): DropshipMarketplaceOrderCancellationReason {
  if (candidate.cancellationStatus === "payment_hold_expired") {
    return "payment_hold_expired";
  }
  if (candidate.cancellationStatus === "order_intake_rejected") {
    return "order_intake_rejected";
  }
  if (candidate.rejectionReason?.startsWith(PAYMENT_HOLD_EXPIRED_REASON)) {
    return "payment_hold_expired";
  }
  if (candidate.rejectionReason?.startsWith(MARKETPLACE_CANCELLATION_FAILED_REASON_PREFIX)) {
    return "payment_hold_expired";
  }
  if (candidate.rejectionReason) {
    return "order_intake_rejected";
  }
  return "payment_hold_expired";
}

function parseProcessCancellationsInput(
  input: unknown,
): z.infer<typeof processDropshipOrderCancellationsInputSchema> {
  const result = processDropshipOrderCancellationsInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_CANCELLATION_INVALID_INPUT",
      "Dropship order cancellation input failed validation.",
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

function classifyCancellationError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof DropshipError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.context?.retryable === true,
    };
  }
  return {
    code: "DROPSHIP_MARKETPLACE_ORDER_CANCELLATION_UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function logDropshipOrderCancellationEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
