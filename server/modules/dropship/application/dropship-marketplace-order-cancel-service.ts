import { DropshipError } from "../domain/errors";
import {
  decideAcceptedCancelOutcome,
  type AcceptedCancelOutcome,
  type MarketplaceCancelRefundPlan,
  type MarketplaceCancelStopKind,
} from "../domain/marketplace-order-cancel";
import { decideOrderProcessingFailure, type OrderProcessingFailureDecision } from "../domain/order-processing-retry";
import type { DropshipClock, DropshipMarketplaceCancelStop } from "./dropship-ports";

/**
 * Accepted dropship orders eBay cancelled (plan v4 §7.2): ask OMS to stop
 * each one, then record what OMS answered. A stopped order is refunded to the
 * wallet (cash with the advance fee, points to their lots) in the same
 * transaction as its new status, audit row and vendor notice; one OMS could
 * not stop, or that had shipped, goes to a person with no credit. A failed
 * ask waits the order-retry delays (§7.1) and goes to a person after 64.
 * Runs in the order-processing sweep, next to the outbound cancellations.
 */

/** An accepted order eBay cancelled, waiting for OMS to stop it. */
export interface MarketplaceCancelStopCandidate {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  omsOrderId: number | null;
  externalOrderId: string;
  externalOrderNumber: string | null;
  /** Failed stop attempts so far. */
  attemptCount: number;
}

export interface MarketplaceCancelStopRecord {
  candidate: MarketplaceCancelStopCandidate;
  kind: MarketplaceCancelStopKind;
  outcome: AcceptedCancelOutcome;
  shipments: ReadonlyArray<object>;
  at: Date;
  workerId: string;
}

export type MarketplaceCancelStopRecorded =
  | { applied: true; refund: (MarketplaceCancelRefundPlan & { replayed: boolean }) | null }
  /** The intake left the stop (another worker recorded it, or a person changed it): nothing written. */
  | { applied: false };

export interface MarketplaceOrderCancelRepository {
  listDueStops(input: { now: Date; limit: number }): Promise<MarketplaceCancelStopCandidate[]>;
  recordStopOutcome(input: MarketplaceCancelStopRecord): Promise<MarketplaceCancelStopRecorded>;
  recordStopFailure(input: {
    candidate: MarketplaceCancelStopCandidate; decision: OrderProcessingFailureDecision; errorCode: string; errorMessage: string; at: Date;
    workerId: string;
    /** What OMS answered before the failure; null when the ask itself failed. OMS's `stopped` means the order did not ship. */
    omsAnswer: MarketplaceCancelStopKind | null;
  }): Promise<boolean>;
}

type LogFields = Record<string, unknown>;
export interface MarketplaceOrderCancelLogger {
  debug(action: string, fields: LogFields): void;
  info(action: string, fields: LogFields): void;
  warn(action: string, fields: LogFields): void;
  error(action: string, fields: LogFields): void;
}

export interface MarketplaceOrderCancelStopSummary {
  stopped: number;
  review: number;
  retrying: number;
  /** Due stops left for later because OMS's stop is not wired in this process. */
  notWired: number;
}

const UNEXPECTED_STOP_FAILURE_CODE = "DROPSHIP_EBAY_ORDER_CANCEL_STOP_FAILED";

export class DropshipMarketplaceOrderCancelService {
  constructor(private readonly deps: {
    repository: MarketplaceOrderCancelRepository;
    /** Null when OMS's stop was not registered (a process that did not boot the server): stops wait. */
    stopper: DropshipMarketplaceCancelStop | null;
    clock: DropshipClock;
    logger: MarketplaceOrderCancelLogger;
  }) {}

  async processDueStops(input: { limit: number; workerId: string }): Promise<MarketplaceOrderCancelStopSummary> {
    const summary: MarketplaceOrderCancelStopSummary = { stopped: 0, review: 0, retrying: 0, notWired: 0 };
    const due = await this.deps.repository.listDueStops({ now: this.deps.clock.now(), limit: input.limit });
    if (due.length === 0) return summary;
    if (!this.deps.stopper) {
      summary.notWired = due.length;
      this.deps.logger.error("dropship.order.marketplace_cancel_stop_unavailable", {
        outcome: "deferred", error_code: "DROPSHIP_EBAY_ORDER_CANCEL_STOP_NOT_WIRED", due_count: due.length,
      });
      return summary;
    }
    for (const candidate of due) {
      const result = await this.stopOne(candidate, input.workerId);
      summary[result] += 1;
    }
    return summary;
  }

  private async stopOne(candidate: MarketplaceCancelStopCandidate, workerId: string): Promise<"stopped" | "review" | "retrying"> {
    const fields = correlation(candidate);
    let answer: Awaited<ReturnType<DropshipMarketplaceCancelStop["stopOrderForMarketplaceCancel"]>>;
    try {
      // An accepted intake always names its OMS order; one that does not is OMS's not_found (permanent review).
      answer = candidate.omsOrderId === null
        ? { kind: "not_found", shipments: [] }
        : await this.deps.stopper!.stopOrderForMarketplaceCancel({ omsOrderId: candidate.omsOrderId, intakeId: candidate.intakeId });
    } catch (error) {
      // A throw from OMS is passing (plan v2 §7.2), except one no retry fixes: a caller defect OMS marks fatal, or an
      // integrity or SQL error (review MS5: classified as the recording path below classifies it, never retried).
      return this.recordFailure(candidate, workerId, error, !isNeverRetried(error), null);
    }
    const outcome = decideAcceptedCancelOutcome(answer.kind);
    const at = this.deps.clock.now();
    let recorded: MarketplaceCancelStopRecorded;
    try {
      recorded = await this.deps.repository.recordStopOutcome({ candidate, kind: answer.kind, outcome, shipments: answer.shipments, at, workerId });
    } catch (error) {
      // OMS already stopped it; only recording failed. A permanent refusal (a ledger the refund cannot follow) goes to a
      // person, never retried; anything else is retried, and OMS's idempotent stop gives the same answer next time.
      return this.recordFailure(candidate, workerId, error, !isNeverRetried(error), answer.kind);
    }
    if (!recorded.applied) {
      this.deps.logger.debug("dropship.order.marketplace_cancel_stop_recorded", { ...fields, outcome: "already_recorded", verdict: answer.kind });
      return outcome.requiresReview ? "review" : "stopped";
    }
    const logFields = {
      ...fields, outcome: outcome.requiresReview ? "requires_review" : "stopped", verdict: answer.kind,
      before: { cancellationStatus: "marketplace_cancel_stop_pending" }, after: { cancellationStatus: outcome.cancellationStatus },
      refund_cash_cents: recorded.refund?.cashCents ?? 0, refund_rewards_cents: recorded.refund?.rewardsCents ?? 0,
      refund_replayed: recorded.refund?.replayed ?? false,
    };
    if (outcome.requiresReview) {
      this.deps.logger.error("dropship.order.marketplace_cancel_stop_recorded", { ...logFields, error_code: `DROPSHIP_EBAY_ORDER_CANCEL_${answer.kind.toUpperCase()}` });
      return "review";
    }
    this.deps.logger.info("dropship.order.marketplace_cancel_stop_recorded", logFields);
    return "stopped";
  }

  /** `omsAnswer` is what OMS answered before a recording failed; null when the ask itself failed (review ARCH-7). */
  private async recordFailure(candidate: MarketplaceCancelStopCandidate, workerId: string, error: unknown,
    retryable: boolean, omsAnswer: MarketplaceCancelStopKind | null): Promise<"review" | "retrying"> {
    const at = this.deps.clock.now();
    const decision = decideOrderProcessingFailure({ attemptsBefore: candidate.attemptCount, retryable, now: at });
    const code = errorCodeOf(error);
    const message = error instanceof Error ? error.message : String(error);
    await this.deps.repository.recordStopFailure({ candidate, decision, errorCode: code, errorMessage: message, at, workerId, omsAnswer });
    const fields = { ...correlation(candidate), error_code: code, error_class: retryable ? "transient" : "permanent",
      attempt_count: decision.attemptCount, next_attempt_at: decision.nextAttemptAt?.toISOString() ?? null };
    if (decision.status === "failed") {
      this.deps.logger.error("dropship.order.marketplace_cancel_stop_failed", { ...fields, outcome: "requires_review", exhausted: decision.exhausted });
      return "review";
    }
    // A first failure is WARN, its repeats DEBUG (an expected wait, CLAUDE.md §10).
    (decision.attemptCount > 1 ? this.deps.logger.debug : this.deps.logger.warn).call(this.deps.logger,
      "dropship.order.marketplace_cancel_stop_failed", { ...fields, outcome: "retry_scheduled" });
    return "retrying";
  }
}

function correlation(candidate: MarketplaceCancelStopCandidate): LogFields {
  return { intake_id: candidate.intakeId, vendor_id: candidate.vendorId, store_connection_id: candidate.storeConnectionId,
    oms_order_id: candidate.omsOrderId, external_order_id: candidate.externalOrderId };
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  return UNEXPECTED_STOP_FAILURE_CODE;
}

/** A failure no retry fixes (CLAUDE.md §6): fatal (OMS's own classification or a DropshipError's), permanent, or SQLSTATE class 23/42. */
function isNeverRetried(error: unknown): boolean {
  return isFatal(error) || isPermanentOrFatal(error);
}

function isFatal(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { classification?: unknown }).classification === "fatal");
}

function isPermanentOrFatal(error: unknown): boolean {
  if (error instanceof DropshipError) {
    const classification = error.context?.classification;
    return classification === "permanent" || classification === "fatal";
  }
  const sqlState = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  // Integrity (23) and syntax/access (42) SQLSTATEs fail the same way every time (dropship-order-processing-service.ts permanentDatabaseErrorCode).
  return typeof sqlState === "string" && /^(23|42)[0-9A-Z]{3}$/.test(sqlState);
}
