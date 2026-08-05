import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";

/**
 * No-inspection watcher (design spec D3; build spec B2 "No-inspection branch").
 *
 * A return lost in transit back to us is NOT a carrier claim on the outbound
 * leg — it rides the RMA no-inspection branch:
 *   requested | in_transit  →  no_inspection_review  →  credited (pool) | closed
 *
 * The watcher moves RMAs into review when EITHER:
 *   (a) the return carrier tracking reports a lost status, OR
 *   (b) return_expected_delivery_at + no_inspection_timeout_days passes with
 *       no delivery scan (received_at IS NULL). The timeout knob is the
 *       versioned policy knob from the RMA's governing policy version
 *       (migration 188, default 10 days).
 *
 * The watcher only ever QUEUES review. Money moves exclusively through the
 * admin approve action (human-released, D3: "Money out always has a human").
 *
 * Evidence pack: assembled at review-queue time and stored on
 * dropship_rmas.no_inspection_evidence (jsonb) — tracking history snapshot,
 * marketplace case reference, trigger detail. Immutable once written.
 */

const DEFAULT_WATCHER_LIMIT = 100;

/** Carrier tracking statuses that mean "lost" for the D3 trigger. */
export const DROPSHIP_RETURN_LOST_TRACKING_STATUSES = [
  "lost",
  "missing",
  "unrecoverable",
] as const;

export const runDropshipNoInspectionWatcherInputSchema = z.object({
  workerId: z.string().trim().min(1).max(255),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

export interface DropshipNoInspectionCandidate {
  rmaId: number;
  vendorId: number;
  storeConnectionId: number | null;
  rmaNumber: string;
  status: "requested" | "in_transit";
  returnTrackingNumber: string | null;
  returnExpectedDeliveryAt: Date | null;
  requestedAt: Date;
  policyVersionId: number | null;
  noInspectionTimeoutDays: number;
  marketplaceCaseRef: string | null;
}

export interface DropshipReturnTrackingSnapshot {
  trackingNumber: string;
  carrierStatus: string;
  deliveredAt: Date | null;
  events: {
    status: string;
    occurredAt: string;
    description: string | null;
  }[];
}

/**
 * Inbound return-tracking provider port. PR 4's channel return-intake
 * adapters (or a future carrier-tracking integration) implement this; the
 * watcher treats it as optional — without a provider only the timeout path
 * (b) runs.
 */
export interface DropshipReturnTrackingProvider {
  fetchReturnTracking(input: {
    vendorId: number;
    storeConnectionId: number | null;
    trackingNumber: string;
  }): Promise<DropshipReturnTrackingSnapshot | null>;
}

export interface DropshipNoInspectionEvidencePack {
  version: 1;
  trigger: "carrier_lost_status" | "delivery_timeout";
  trackingNumber: string | null;
  carrierStatus: string | null;
  trackingHistory: DropshipReturnTrackingSnapshot["events"] | null;
  marketplaceCaseRef: string | null;
  expectedDeliveryAt: string | null;
  noInspectionTimeoutDays: number;
  detectedAt: string;
  workerId: string;
}

export interface DropshipNoInspectionWatcherResult {
  scannedCount: number;
  queuedCount: number;
  skippedCount: number;
  queued: {
    rmaId: number;
    trigger: "carrier_lost_status" | "delivery_timeout";
  }[];
}

export interface DropshipNoInspectionWatcherRepository {
  listCandidates(input: {
    now: Date;
    limit: number;
  }): Promise<DropshipNoInspectionCandidate[]>;

  /**
   * Move a candidate into no_inspection_review with its evidence pack.
   * Idempotent per RMA: the transition is guarded by the state machine
   * (requested/in_transit → no_inspection_review) under row lock, and the
   * status-update idempotency key is deterministic per RMA + trigger.
   * Returns false when the RMA already moved on (concurrent watcher run or
   * admin action) — never an error.
   */
  queueForReview(input: {
    rmaId: number;
    vendorId: number;
    evidence: DropshipNoInspectionEvidencePack;
    policyVersionId: number | null;
    idempotencyKey: string;
    workerId: string;
    now: Date;
  }): Promise<{ queued: boolean }>;
}

export class DropshipNoInspectionWatcherService {
  constructor(
    private readonly deps: {
      repository: DropshipNoInspectionWatcherRepository;
      trackingProvider?: DropshipReturnTrackingProvider;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async runWatcher(input: unknown): Promise<DropshipNoInspectionWatcherResult> {
    const parsed = parseWatcherInput(input);
    const now = this.deps.clock.now();
    const candidates = await this.deps.repository.listCandidates({
      now,
      limit: parsed.limit ?? DEFAULT_WATCHER_LIMIT,
    });

    const result: DropshipNoInspectionWatcherResult = {
      scannedCount: candidates.length,
      queuedCount: 0,
      skippedCount: 0,
      queued: [],
    };

    for (const candidate of candidates) {
      const evaluation = await this.evaluateCandidate(candidate, now, parsed.workerId);
      if (evaluation === null) {
        result.skippedCount += 1;
        continue;
      }
      const queued = await this.deps.repository.queueForReview({
        rmaId: candidate.rmaId,
        vendorId: candidate.vendorId,
        evidence: evaluation.evidence,
        policyVersionId: candidate.policyVersionId,
        idempotencyKey: `dropship-no-inspection:${candidate.rmaId}:${evaluation.trigger}`,
        workerId: parsed.workerId,
        now,
      });
      if (!queued.queued) {
        result.skippedCount += 1;
        continue;
      }
      result.queuedCount += 1;
      result.queued.push({ rmaId: candidate.rmaId, trigger: evaluation.trigger });
      await this.notifyReviewQueued(candidate, evaluation, now);
    }

    if (result.queuedCount > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_NO_INSPECTION_WATCHER_COMPLETED",
        message: "Dropship no-inspection watcher queued RMAs for review.",
        context: {
          workerId: parsed.workerId,
          scannedCount: result.scannedCount,
          queuedCount: result.queuedCount,
          rmaIds: result.queued.map((entry) => entry.rmaId),
        },
      });
    }
    return result;
  }

  private async evaluateCandidate(
    candidate: DropshipNoInspectionCandidate,
    now: Date,
    workerId: string,
  ): Promise<{
    trigger: "carrier_lost_status" | "delivery_timeout";
    evidence: DropshipNoInspectionEvidencePack;
  } | null> {
    // Path (a): carrier lost status. Requires a tracking number + provider.
    if (candidate.returnTrackingNumber && this.deps.trackingProvider) {
      const snapshot = await this.deps.trackingProvider.fetchReturnTracking({
        vendorId: candidate.vendorId,
        storeConnectionId: candidate.storeConnectionId,
        trackingNumber: candidate.returnTrackingNumber,
      });
      if (snapshot && isLostCarrierStatus(snapshot.carrierStatus)) {
        return {
          trigger: "carrier_lost_status",
          evidence: {
            version: 1,
            trigger: "carrier_lost_status",
            trackingNumber: candidate.returnTrackingNumber,
            carrierStatus: snapshot.carrierStatus,
            trackingHistory: snapshot.events,
            marketplaceCaseRef: candidate.marketplaceCaseRef,
            expectedDeliveryAt: candidate.returnExpectedDeliveryAt?.toISOString() ?? null,
            noInspectionTimeoutDays: candidate.noInspectionTimeoutDays,
            detectedAt: now.toISOString(),
            workerId,
          },
        };
      }
    }

    // Path (b): expected delivery + N days, no delivery scan.
    if (candidate.returnExpectedDeliveryAt) {
      const deadline = new Date(
        candidate.returnExpectedDeliveryAt.getTime()
          + candidate.noInspectionTimeoutDays * 86_400_000,
      );
      if (now.getTime() >= deadline.getTime()) {
        return {
          trigger: "delivery_timeout",
          evidence: {
            version: 1,
            trigger: "delivery_timeout",
            trackingNumber: candidate.returnTrackingNumber,
            carrierStatus: null,
            trackingHistory: null,
            marketplaceCaseRef: candidate.marketplaceCaseRef,
            expectedDeliveryAt: candidate.returnExpectedDeliveryAt.toISOString(),
            noInspectionTimeoutDays: candidate.noInspectionTimeoutDays,
            detectedAt: now.toISOString(),
            workerId,
          },
        };
      }
    }

    return null;
  }

  private async notifyReviewQueued(
    candidate: DropshipNoInspectionCandidate,
    evaluation: {
      trigger: "carrier_lost_status" | "delivery_timeout";
      evidence: DropshipNoInspectionEvidencePack;
    },
    now: Date,
  ): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: candidate.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.RMA_NO_INSPECTION_REVIEW,
      critical: false,
      channels: ["in_app"],
      title: "Return under lost-in-transit review",
      message: `Return ${candidate.rmaNumber} is being reviewed as lost in transit. No action is needed from you right now.`,
      payload: {
        rmaId: candidate.rmaId,
        rmaNumber: candidate.rmaNumber,
        trigger: evaluation.trigger,
        trackingNumber: candidate.returnTrackingNumber,
        expectedDeliveryAt: candidate.returnExpectedDeliveryAt?.toISOString() ?? null,
        detectedAt: now.toISOString(),
      },
      idempotencyKey: `dropship-no-inspection-notify:${candidate.rmaId}:${evaluation.trigger}`,
    }, {
      code: "DROPSHIP_NO_INSPECTION_NOTIFICATION_FAILED",
      message: "Dropship no-inspection review notification failed.",
      context: { rmaId: candidate.rmaId, vendorId: candidate.vendorId },
    });
  }
}

export function isLostCarrierStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return (DROPSHIP_RETURN_LOST_TRACKING_STATUSES as readonly string[]).includes(normalized);
}

export function makeDropshipNoInspectionWatcherLogger(): DropshipLogger {
  return {
    info: (event) => logNoInspectionEvent("info", event),
    warn: (event) => logNoInspectionEvent("warn", event),
    error: (event) => logNoInspectionEvent("error", event),
  };
}

export const systemDropshipNoInspectionWatcherClock: DropshipClock = {
  now: () => new Date(),
};

function parseWatcherInput(input: unknown): z.infer<typeof runDropshipNoInspectionWatcherInputSchema> {
  const result = runDropshipNoInspectionWatcherInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_NO_INSPECTION_WATCHER_INVALID_INPUT",
      "Dropship no-inspection watcher input failed validation.",
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

function logNoInspectionEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
