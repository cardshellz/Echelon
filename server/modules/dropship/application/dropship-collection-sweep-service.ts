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
 * Collection sweep (design spec D5; build spec B2 "Collection sweep").
 *
 * Negative wallet balances are allowed (D5); the wallet ledger IS the
 * receivable. This service is the recovery mechanism: on a configurable
 * cadence it finds vendors whose available balance has been negative past the
 * grace window and charges their saved funding method via the Stripe funding
 * provider.
 *
 * Locked rules:
 * - Idempotent per (vendor, period): one dropship_collection_attempts row per
 *   (vendor_id, period_start); a rerun inside the same period replays.
 * - Failure increments consecutive_failures; after max_consecutive_failures
 *   the vendor is escalated to a human account-review notification event.
 * - NEVER automatic suspension. Money out (the charge) is attempted by the
 *   worker, but account consequences are always a human decision.
 * - All knobs live in the versioned dropship_collection_config row that was
 *   active for the period; the attempt row records config_version_id.
 */

const DEFAULT_SWEEP_LIMIT = 100;

export const runDropshipCollectionSweepInputSchema = z.object({
  workerId: z.string().trim().min(1).max(255),
  limit: z.number().int().positive().max(500).optional(),
}).strict();

export type RunDropshipCollectionSweepInput = z.infer<typeof runDropshipCollectionSweepInputSchema>;

export interface DropshipCollectionConfigRecord {
  configId: number;
  version: number;
  graceDays: number;
  sweepCadenceDays: number;
  maxConsecutiveFailures: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export type DropshipCollectionAttemptStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "escalated"
  | "skipped";

export type DropshipCollectionSkipReason =
  | "within_grace"
  | "no_funding_method"
  | "funding_method_not_chargeable"
  | "funding_provider_not_configured"
  | "balance_recovered"
  | "already_attempted";

export interface DropshipCollectionAttemptRecord {
  attemptId: number;
  vendorId: number;
  periodStart: Date;
  periodEnd: Date;
  amountCents: number;
  currency: string;
  fundingMethodId: number | null;
  configVersionId: number | null;
  status: DropshipCollectionAttemptStatus;
  consecutiveFailures: number;
  lastAttemptAt: Date | null;
  lastFailureCode: string | null;
  lastFailureMessage: string | null;
  providerPaymentIntentId: string | null;
  walletLedgerEntryId: number | null;
  escalatedAt: Date | null;
}

export interface DropshipCollectionSweepResult {
  scannedCount: number;
  chargedCount: number;
  failedCount: number;
  escalatedCount: number;
  skippedCount: number;
  attempts: {
    vendorId: number;
    attemptId: number;
    outcome: "charged" | "failed" | "escalated" | "skipped";
    amountCents: number;
    skipReason: DropshipCollectionSkipReason | null;
    consecutiveFailures: number;
  }[];
}

export interface DropshipCollectionFundingCharge {
  providerPaymentIntentId: string;
  status: "pending" | "settled";
  amountCents: number;
  currency: string;
  externalTransactionId: string | null;
}

export interface DropshipCollectionFundingProvider {
  createStripeCollectionCharge(input: {
    vendorId: number;
    fundingMethodId: number;
    rail: "stripe_card" | "stripe_ach";
    amountCents: number;
    currency: string;
    providerCustomerId: string;
    providerPaymentMethodId: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<DropshipCollectionFundingCharge>;
}

export interface DropshipCollectionSweepRepository {
  getActiveConfig(at: Date): Promise<DropshipCollectionConfigRecord | null>;

  /**
   * Vendors whose available balance is negative and whose wallet went
   * negative at or before (now - graceDays). "Went negative at" is derived
   * from the wallet account's updated_at: the balance only moves via ledger
   * writes, which touch updated_at. A vendor whose balance recovered since
   * the last sweep simply never appears here.
   */
  listCollectibleVendors(input: {
    now: Date;
    graceDays: number;
    limit: number;
  }): Promise<{
    vendorId: number;
    walletAccountId: number;
    availableBalanceCents: number;
    currency: string;
    balanceUpdatedAt: Date;
  }[]>;

  /**
   * Claim the (vendor, period) attempt row. Idempotent: unique
   * (vendor_id, period_start). Returns the existing row when the period was
   * already attempted; `created` distinguishes a fresh claim from a replay.
   * A replayed row in a terminal state (succeeded/escalated/skipped) must
   * not be charged again.
   */
  claimAttempt(input: {
    vendorId: number;
    periodStart: Date;
    periodEnd: Date;
    amountCents: number;
    currency: string;
    fundingMethodId: number | null;
    configVersionId: number;
    idempotencyKey: string;
    now: Date;
  }): Promise<{ attempt: DropshipCollectionAttemptRecord; created: boolean }>;

  getDefaultChargeableFundingMethod(input: {
    vendorId: number;
  }): Promise<{
    fundingMethodId: number;
    rail: string;
    status: string;
    providerCustomerId: string | null;
    providerPaymentMethodId: string | null;
  } | null>;

  recordChargeSuccess(input: {
    attemptId: number;
    vendorId: number;
    amountCents: number;
    currency: string;
    fundingMethodId: number;
    providerPaymentIntentId: string;
    externalTransactionId: string | null;
    fundingStatus: "pending" | "settled";
    idempotencyKey: string;
    now: Date;
  }): Promise<{ walletLedgerEntryId: number }>;

  recordChargeFailure(input: {
    attemptId: number;
    vendorId: number;
    failureCode: string;
    failureMessage: string;
    escalate: boolean;
    now: Date;
  }): Promise<{ consecutiveFailures: number; escalated: boolean }>;

  /**
   * Carry an existing escalation into a new period's attempt row without
   * incrementing the failure count and without a new audit event: the
   * vendor is already escalated; collection stays paused until a human
   * resolves the account review.
   */
  carryForwardEscalation(input: {
    attemptId: number;
    now: Date;
  }): Promise<{ consecutiveFailures: number }>;
}

export class DropshipCollectionSweepService {
  constructor(
    private readonly deps: {
      repository: DropshipCollectionSweepRepository;
      fundingProvider?: DropshipCollectionFundingProvider;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async runSweep(input: unknown): Promise<DropshipCollectionSweepResult> {
    const parsed = parseSweepInput(input);
    const now = this.deps.clock.now();
    const config = await this.deps.repository.getActiveConfig(now);
    if (!config) {
      this.deps.logger.warn({
        code: "DROPSHIP_COLLECTION_CONFIG_MISSING",
        message: "Dropship collection sweep found no active collection config; nothing to do.",
        context: { workerId: parsed.workerId },
      });
      return { scannedCount: 0, chargedCount: 0, failedCount: 0, escalatedCount: 0, skippedCount: 0, attempts: [] };
    }

    const vendors = await this.deps.repository.listCollectibleVendors({
      now,
      graceDays: config.graceDays,
      limit: parsed.limit ?? DEFAULT_SWEEP_LIMIT,
    });

    const result: DropshipCollectionSweepResult = {
      scannedCount: vendors.length,
      chargedCount: 0,
      failedCount: 0,
      escalatedCount: 0,
      skippedCount: 0,
      attempts: [],
    };

    // Period identity: the cadence bucket containing `now`. All vendors swept
    // in the same bucket share period_start, which is what makes a crashed +
    // rerun sweep idempotent per vendor.
    const periodStart = periodStartFor(now, config.sweepCadenceDays);
    const periodEnd = new Date(periodStart.getTime() + config.sweepCadenceDays * 86_400_000);

    for (const vendor of vendors) {
      const outcome = await this.sweepOneVendor({
        vendor,
        config,
        periodStart,
        periodEnd,
        now,
        workerId: parsed.workerId,
      });
      result.attempts.push(outcome);
      if (outcome.outcome === "charged") result.chargedCount += 1;
      else if (outcome.outcome === "failed") result.failedCount += 1;
      else if (outcome.outcome === "escalated") result.escalatedCount += 1;
      else result.skippedCount += 1;
    }

    if (result.chargedCount > 0 || result.failedCount > 0 || result.escalatedCount > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_COLLECTION_SWEEP_COMPLETED",
        message: "Dropship collection sweep completed.",
        context: {
          workerId: parsed.workerId,
          configVersionId: config.configId,
          scannedCount: result.scannedCount,
          chargedCount: result.chargedCount,
          failedCount: result.failedCount,
          escalatedCount: result.escalatedCount,
          skippedCount: result.skippedCount,
        },
      });
    }
    return result;
  }

  private async sweepOneVendor(input: {
    vendor: {
      vendorId: number;
      walletAccountId: number;
      availableBalanceCents: number;
      currency: string;
      balanceUpdatedAt: Date;
    };
    config: DropshipCollectionConfigRecord;
    periodStart: Date;
    periodEnd: Date;
    now: Date;
    workerId: string;
  }): Promise<DropshipCollectionSweepResult["attempts"][number]> {
    const { vendor, config } = input;
    const amountCents = -vendor.availableBalanceCents;
    const fundingMethod = await this.deps.repository.getDefaultChargeableFundingMethod({
      vendorId: vendor.vendorId,
    });

    const claim = await this.deps.repository.claimAttempt({
      vendorId: vendor.vendorId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      amountCents,
      currency: vendor.currency,
      fundingMethodId: fundingMethod?.fundingMethodId ?? null,
      configVersionId: config.configId,
      idempotencyKey: `dropship-collection:${vendor.vendorId}:${input.periodStart.toISOString()}`,
      now: input.now,
    });

    if (!claim.created) {
      // Replay inside the same period. Terminal states are never re-charged
      // and report as skipped (a replay is not a new charge).
      const terminal = claim.attempt.status === "succeeded"
        || claim.attempt.status === "escalated"
        || claim.attempt.status === "skipped";
      if (terminal) {
        return {
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          outcome: "skipped",
          amountCents: claim.attempt.amountCents,
          skipReason: "already_attempted",
          consecutiveFailures: claim.attempt.consecutiveFailures,
        };
      }
      // Non-terminal replay (pending/failed): fall through and retry the
      // charge. consecutive_failures already counts prior failures; the
      // escalation check below uses the post-increment value.
    }

    // Carry-forward guard: a vendor whose consecutive failure count already
    // reached the escalation threshold in a prior period is NOT charged
    // again — the account waits for human review (D5: suspension and account
    // consequences are always a human decision). The new period's row is
    // marked escalated without re-sending the review notification (the
    // notification fires only on the transition into escalation).
    if (claim.created && claim.attempt.consecutiveFailures >= config.maxConsecutiveFailures) {
      const carried = await this.deps.repository.carryForwardEscalation({
        attemptId: claim.attempt.attemptId,
        now: input.now,
      });
      return {
        vendorId: vendor.vendorId,
        attemptId: claim.attempt.attemptId,
        outcome: "escalated",
        amountCents,
        skipReason: null,
        consecutiveFailures: carried.consecutiveFailures,
      };
    }

    if (!fundingMethod) {
      const failure = await this.deps.repository.recordChargeFailure({
        attemptId: claim.attempt.attemptId,
        vendorId: vendor.vendorId,
        failureCode: "no_funding_method",
        failureMessage: "Vendor has no default chargeable funding method on file.",
        escalate: claim.attempt.consecutiveFailures + 1 >= config.maxConsecutiveFailures,
        now: input.now,
      });
      if (failure.escalated) {
        await this.notifyAccountReview({
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          amountCents,
          currency: vendor.currency,
          consecutiveFailures: failure.consecutiveFailures,
          lastFailureCode: "no_funding_method",
          now: input.now,
        });
        return {
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          outcome: "escalated",
          amountCents,
          skipReason: null,
          consecutiveFailures: failure.consecutiveFailures,
        };
      }
      return {
        vendorId: vendor.vendorId,
        attemptId: claim.attempt.attemptId,
        outcome: "skipped",
        amountCents,
        skipReason: "no_funding_method",
        consecutiveFailures: failure.consecutiveFailures,
      };
    }

    const chargeable = (fundingMethod.rail === "stripe_card" || fundingMethod.rail === "stripe_ach")
      && fundingMethod.status === "active"
      && fundingMethod.providerCustomerId !== null
      && fundingMethod.providerPaymentMethodId !== null;

    if (!chargeable || !this.deps.fundingProvider) {
      const skipReason: DropshipCollectionSkipReason = !this.deps.fundingProvider
        ? "funding_provider_not_configured"
        : "funding_method_not_chargeable";
      const failure = await this.deps.repository.recordChargeFailure({
        attemptId: claim.attempt.attemptId,
        vendorId: vendor.vendorId,
        failureCode: skipReason,
        failureMessage: !this.deps.fundingProvider
          ? "Collection funding provider is not configured."
          : `Default funding method is not chargeable (rail=${fundingMethod.rail}, status=${fundingMethod.status}).`,
        escalate: claim.attempt.consecutiveFailures + 1 >= config.maxConsecutiveFailures,
        now: input.now,
      });
      if (failure.escalated) {
        await this.notifyAccountReview({
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          amountCents,
          currency: vendor.currency,
          consecutiveFailures: failure.consecutiveFailures,
          lastFailureCode: skipReason,
          now: input.now,
        });
        return {
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          outcome: "escalated",
          amountCents,
          skipReason: null,
          consecutiveFailures: failure.consecutiveFailures,
        };
      }
      return {
        vendorId: vendor.vendorId,
        attemptId: claim.attempt.attemptId,
        outcome: "skipped",
        amountCents,
        skipReason,
        consecutiveFailures: failure.consecutiveFailures,
      };
    }

    try {
      const charge = await this.deps.fundingProvider.createStripeCollectionCharge({
        vendorId: vendor.vendorId,
        fundingMethodId: fundingMethod.fundingMethodId,
        rail: fundingMethod.rail as "stripe_card" | "stripe_ach",
        amountCents,
        currency: vendor.currency,
        providerCustomerId: fundingMethod.providerCustomerId!,
        providerPaymentMethodId: fundingMethod.providerPaymentMethodId!,
        idempotencyKey: `dropship-collection-charge:${claim.attempt.attemptId}`,
        now: input.now,
      });
      const success = await this.deps.repository.recordChargeSuccess({
        attemptId: claim.attempt.attemptId,
        vendorId: vendor.vendorId,
        amountCents: charge.amountCents,
        currency: charge.currency,
        fundingMethodId: fundingMethod.fundingMethodId,
        providerPaymentIntentId: charge.providerPaymentIntentId,
        externalTransactionId: charge.externalTransactionId,
        fundingStatus: charge.status,
        idempotencyKey: `dropship-collection-funding:${charge.providerPaymentIntentId}`,
        now: input.now,
      });
      this.deps.logger.info({
        code: "DROPSHIP_COLLECTION_CHARGE_SUCCEEDED",
        message: "Dropship collection sweep charged a vendor funding method.",
        context: {
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          amountCents: charge.amountCents,
          providerPaymentIntentId: charge.providerPaymentIntentId,
          walletLedgerEntryId: success.walletLedgerEntryId,
        },
      });
      return {
        vendorId: vendor.vendorId,
        attemptId: claim.attempt.attemptId,
        outcome: "charged",
        amountCents: charge.amountCents,
        skipReason: null,
        consecutiveFailures: 0,
      };
    } catch (error) {
      const failureCode = error instanceof DropshipError ? error.code : "DROPSHIP_COLLECTION_CHARGE_ERROR";
      const failureMessage = error instanceof Error ? error.message : String(error);
      const failure = await this.deps.repository.recordChargeFailure({
        attemptId: claim.attempt.attemptId,
        vendorId: vendor.vendorId,
        failureCode,
        failureMessage,
        escalate: claim.attempt.consecutiveFailures + 1 >= config.maxConsecutiveFailures,
        now: input.now,
      });
      this.deps.logger.warn({
        code: "DROPSHIP_COLLECTION_CHARGE_FAILED",
        message: "Dropship collection sweep charge failed.",
        context: {
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          amountCents,
          consecutiveFailures: failure.consecutiveFailures,
          escalated: failure.escalated,
          failureCode,
        },
      });
      if (failure.escalated) {
        await this.notifyAccountReview({
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          amountCents,
          currency: vendor.currency,
          consecutiveFailures: failure.consecutiveFailures,
          lastFailureCode: failureCode,
          now: input.now,
        });
        return {
          vendorId: vendor.vendorId,
          attemptId: claim.attempt.attemptId,
          outcome: "escalated",
          amountCents,
          skipReason: null,
          consecutiveFailures: failure.consecutiveFailures,
        };
      }
      return {
        vendorId: vendor.vendorId,
        attemptId: claim.attempt.attemptId,
        outcome: "failed",
        amountCents,
        skipReason: null,
        consecutiveFailures: failure.consecutiveFailures,
      };
    }
  }

  /**
   * Human account-review escalation (D5): after N consecutive failures the
   * vendor is surfaced for a human decision. NEVER automatic suspension.
   * The notification is addressed to the vendor (their funding method is
   * failing) and the audit trail carries the ops-review signal.
   */
  private async notifyAccountReview(input: {
    vendorId: number;
    attemptId: number;
    amountCents: number;
    currency: string;
    consecutiveFailures: number;
    lastFailureCode: string;
    now: Date;
  }): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: input.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.COLLECTION_ACCOUNT_REVIEW,
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship account collection needs attention",
      message: `We were unable to collect your outstanding dropship balance after ${input.consecutiveFailures} attempts. Please update your funding method or contact support.`,
      payload: {
        vendorId: input.vendorId,
        attemptId: input.attemptId,
        amountCents: input.amountCents,
        currency: input.currency,
        consecutiveFailures: input.consecutiveFailures,
        lastFailureCode: input.lastFailureCode,
        reviewRequired: true,
      },
      idempotencyKey: `dropship-collection-review:${input.attemptId}`,
    }, {
      code: "DROPSHIP_COLLECTION_REVIEW_NOTIFICATION_FAILED",
      message: "Dropship collection account-review notification failed.",
      context: {
        vendorId: input.vendorId,
        attemptId: input.attemptId,
      },
    });
  }
}

/**
 * Cadence bucket start: midnight UTC of the day `floor(daysSinceEpoch /
 * cadenceDays) * cadenceDays`. Deterministic — the same `now` always maps to
 * the same period, which is what makes the sweep idempotent per period.
 */
export function periodStartFor(now: Date, cadenceDays: number): Date {
  const dayMs = 86_400_000;
  const daysSinceEpoch = Math.floor(now.getTime() / dayMs);
  const bucket = Math.floor(daysSinceEpoch / cadenceDays);
  return new Date(bucket * cadenceDays * dayMs);
}

export function makeDropshipCollectionSweepLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipCollectionSweepEvent("info", event),
    warn: (event) => logDropshipCollectionSweepEvent("warn", event),
    error: (event) => logDropshipCollectionSweepEvent("error", event),
  };
}

export const systemDropshipCollectionSweepClock: DropshipClock = {
  now: () => new Date(),
};

function parseSweepInput(input: unknown): RunDropshipCollectionSweepInput {
  const result = runDropshipCollectionSweepInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_COLLECTION_SWEEP_INVALID_INPUT",
      "Dropship collection sweep input failed validation.",
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

function logDropshipCollectionSweepEvent(
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
