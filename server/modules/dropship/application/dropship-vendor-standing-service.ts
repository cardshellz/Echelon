import { z } from "zod";
import type {
  DropshipListingHoldState,
  DropshipVendorStandingReason,
  DropshipVendorStatus,
} from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "../domain/errors";
import {
  fundingShortfallCents,
  isFundingStandingReason,
  listingHoldIdempotencyKeyFor,
  listingHoldStateFor,
  vendorStandingNotificationKeyFor,
  type DropshipVendorFundingStanding,
} from "../domain/vendor-standing";
import { formatNotificationCurrency, sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";

/**
 * Vendor standing: pause on the first funding decline, freeze the vendor's
 * marketplace listings at zero, and resume on their own once the wallet is
 * funded again.
 *
 * The decision was taken with the business owner: a declined card or a
 * returned bank debit pauses the vendor immediately (no grace days), because
 * every order they accept after that is money Card Shellz has already spent.
 * Pausing is not a punishment and needs no human: the moment a settled credit
 * brings the available balance back to the auto-reload minimum, the vendor is
 * active again and their stores are released.
 *
 * Locked rules:
 * - Only an ACTIVE vendor is paused, and only a vendor paused for a funding
 *   reason is resumed here. Operator pauses, lapsed and suspended vendors are
 *   someone else's decision.
 * - Standing and the marketplace freeze are recorded separately. The pause is
 *   the fact; the listing hold is a side effect that may be deferred (a
 *   provider quantity request in flight, an outage) and is reconciled on the
 *   hourly tick until it matches. A vendor is never left "paused but selling"
 *   silently: every deferral is logged and the mismatch is visible in the row.
 * - Every hold and release command carries a deterministic idempotency key
 *   from the standing revision, so a retry replays instead of repeating.
 * - Money is never read from hidden state: the funding reader is injected and
 *   the clock is injected.
 */

const DEFAULT_RECONCILE_LIMIT = 100;
const MAX_RECONCILE_LIMIT = 1000;
const evidenceSchema = z.record(z.string(), z.unknown());

export const pauseDropshipVendorForFundingFailureInputSchema = z.object({
  vendorId: z.number().int().positive(),
  reason: z.enum(["card_declined", "funding_returned"]),
  /** What happened, for the audit row and the vendor notice: codes, ids, amounts. */
  evidence: evidenceSchema.default({}),
}).strict();
export type PauseDropshipVendorForFundingFailureInput = z.infer<typeof pauseDropshipVendorForFundingFailureInputSchema>;

export const announceDropshipVendorPauseInputSchema = z.object({
  vendorId: z.number().int().positive(),
  evidence: evidenceSchema.default({}),
}).strict();
export type AnnounceDropshipVendorPauseInput = z.infer<typeof announceDropshipVendorPauseInputSchema>;

export const restoreDropshipVendorIfFundedInputSchema = z.object({
  vendorId: z.number().int().positive(),
  evidence: evidenceSchema.default({}),
}).strict();
export type RestoreDropshipVendorIfFundedInput = z.infer<typeof restoreDropshipVendorIfFundedInputSchema>;

export const reconcileDropshipVendorStandingInputSchema = z.object({
  workerId: z.string().trim().min(1).max(120),
  limit: z.number().int().positive().max(MAX_RECONCILE_LIMIT).optional(),
}).strict();
export type ReconcileDropshipVendorStandingInput = z.infer<typeof reconcileDropshipVendorStandingInputSchema>;

export interface DropshipVendorStandingRecord {
  vendorId: number;
  status: DropshipVendorStatus;
  standingReason: DropshipVendorStandingReason | null;
  pausedAt: Date | null;
  /** Bumped on every pause and resume; keys the hold and release commands. */
  standingRevision: number;
  /** What inventory planning currently holds, as last confirmed by a command. */
  listingHoldState: DropshipListingHoldState;
  listingHoldReconciledAt: Date | null;
  listingHoldDetail: string | null;
}

export interface DropshipVendorStandingRepository {
  getStanding(vendorId: number): Promise<DropshipVendorStandingRecord | null>;
  /** active → paused, guarded on the current status; the audit row commits with it. */
  pauseVendor(input: {
    vendorId: number;
    reason: DropshipVendorStandingReason;
    evidence: Record<string, unknown>;
    now: Date;
  }): Promise<{ changed: boolean; standing: DropshipVendorStandingRecord | null }>;
  /** paused for a funding reason → active, guarded; the audit row commits with it. */
  resumeVendor(input: {
    vendorId: number;
    evidence: Record<string, unknown>;
    now: Date;
  }): Promise<{ changed: boolean; standing: DropshipVendorStandingRecord | null }>;
  /** Store connections that can carry listings (anything not disconnected). */
  listStoreConnectionIds(vendorId: number): Promise<number[]>;
  /** Vendors paused for a funding reason, oldest pause first. */
  listPausedForFunding(input: { limit: number }): Promise<DropshipVendorStandingRecord[]>;
  /** Vendors whose recorded listing hold does not match their standing. */
  listListingHoldMismatches(input: { limit: number }): Promise<DropshipVendorStandingRecord[]>;
  recordListingHoldState(input: {
    vendorId: number;
    state: DropshipListingHoldState;
    detail: string | null;
    now: Date;
  }): Promise<void>;
}

export interface DropshipVendorFundingStandingReader {
  readFundingStanding(vendorId: number): Promise<DropshipVendorFundingStanding>;
}

export type DropshipListingHoldGateOutcome =
  | { applied: true; targetCount: number; publicationRows: number; blockedProductIds: number[] }
  /** The command was refused for now (busy, concurrent change); retry on the next tick. */
  | { applied: false; code: string; message: string };

export interface DropshipListingHoldGate {
  hold(input: { storeConnectionId: number; reason: string; idempotencyKey: string }): Promise<DropshipListingHoldGateOutcome>;
  release(input: { storeConnectionId: number; reason: string; idempotencyKey: string }): Promise<DropshipListingHoldGateOutcome>;
}

export type DropshipListingHoldReconciliation =
  | { outcome: "in_sync"; state: DropshipListingHoldState }
  | { outcome: "applied"; state: DropshipListingHoldState; storeConnectionIds: number[]; blockedProductIds: number[] }
  | { outcome: "deferred"; wanted: DropshipListingHoldState; storeConnectionId: number; code: string; message: string }
  | { outcome: "unavailable"; wanted: DropshipListingHoldState }
  | { outcome: "failed"; wanted: DropshipListingHoldState; error: string };

export interface DropshipVendorStandingChange {
  outcome: "paused" | "resumed" | "unchanged" | "still_short";
  standing: DropshipVendorStandingRecord | null;
  shortfallCents: number | null;
  listingHold: DropshipListingHoldReconciliation | null;
}

export interface DropshipVendorStandingReconcileResult {
  restore: {
    scannedCount: number;
    resumedCount: number;
    stillShortCount: number;
    failedCount: number;
  };
  listingHolds: {
    scannedCount: number;
    appliedCount: number;
    deferredCount: number;
    failedCount: number;
    unavailableCount: number;
  };
}

export class DropshipVendorStandingService {
  constructor(
    private readonly deps: {
      repository: DropshipVendorStandingRepository;
      funding: DropshipVendorFundingStandingReader;
      /** Absent in environments without canonical publication; standing is still recorded. */
      listingHolds?: DropshipListingHoldGate;
      notificationSender?: DropshipNotificationSender;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  /**
   * Record the pause, then tell the vendor and hold their listings. Used
   * where the decline is observed directly (a card refused at charge time).
   */
  async pauseForFundingFailure(input: unknown): Promise<DropshipVendorStandingChange> {
    const parsed = parseInput(pauseDropshipVendorForFundingFailureInputSchema, input, "DROPSHIP_VENDOR_STANDING_PAUSE_INVALID_INPUT");
    const paused = await this.deps.repository.pauseVendor({
      vendorId: parsed.vendorId,
      reason: parsed.reason,
      evidence: parsed.evidence,
      now: this.deps.clock.now(),
    });
    if (!paused.changed) {
      // Already paused, or not a live vendor: nothing to do, and worth a line
      // because the caller saw a decline it expected to act on.
      this.deps.logger.info({
        code: "DROPSHIP_VENDOR_PAUSE_SKIPPED",
        message: "Dropship vendor was not paused: it is not active.",
        context: { vendorId: parsed.vendorId, reason: parsed.reason, status: paused.standing?.status ?? null },
      });
      return { outcome: "unchanged", standing: paused.standing, shortfallCents: null, listingHold: null };
    }
    return this.announce(requireStanding(paused.standing, parsed.vendorId), parsed.evidence);
  }

  /**
   * Tell the vendor and hold their listings for a pause that was already
   * recorded elsewhere: the wallet commits the pause in the same transaction
   * as the voided funding credit it results from, then calls this.
   */
  async announcePause(input: unknown): Promise<DropshipVendorStandingChange> {
    const parsed = parseInput(announceDropshipVendorPauseInputSchema, input, "DROPSHIP_VENDOR_STANDING_ANNOUNCE_INVALID_INPUT");
    const standing = await this.deps.repository.getStanding(parsed.vendorId);
    if (!standing || standing.status !== "paused" || !isFundingStandingReason(standing.standingReason)) {
      this.deps.logger.info({
        code: "DROPSHIP_VENDOR_PAUSE_ANNOUNCE_SKIPPED",
        message: "Dropship vendor pause was not announced: the vendor is not paused for a funding reason.",
        context: { vendorId: parsed.vendorId, status: standing?.status ?? null, reason: standing?.standingReason ?? null },
      });
      return { outcome: "unchanged", standing, shortfallCents: null, listingHold: null };
    }
    return this.announce(standing, parsed.evidence);
  }

  /**
   * Resume a vendor paused for a funding reason once the wallet is funded
   * again. Called after every settled credit; cheap and silent when there is
   * nothing to do.
   */
  async restoreIfFunded(input: unknown): Promise<DropshipVendorStandingChange> {
    const parsed = parseInput(restoreDropshipVendorIfFundedInputSchema, input, "DROPSHIP_VENDOR_STANDING_RESTORE_INVALID_INPUT");
    const current = await this.deps.repository.getStanding(parsed.vendorId);
    if (!current || current.status !== "paused" || !isFundingStandingReason(current.standingReason)) {
      return { outcome: "unchanged", standing: current, shortfallCents: null, listingHold: null };
    }
    const funding = await this.deps.funding.readFundingStanding(parsed.vendorId);
    const shortfallCents = fundingShortfallCents(funding);
    if (shortfallCents > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_VENDOR_STILL_SHORT",
        message: "Dropship vendor stays paused: the available balance is still below the minimum.",
        context: {
          vendorId: parsed.vendorId,
          availableBalanceCents: funding.availableBalanceCents,
          minimumBalanceCents: funding.minimumBalanceCents,
          shortfallCents,
        },
      });
      return { outcome: "still_short", standing: current, shortfallCents, listingHold: null };
    }
    const resumed = await this.deps.repository.resumeVendor({
      vendorId: parsed.vendorId,
      evidence: { ...parsed.evidence, availableBalanceCents: funding.availableBalanceCents, minimumBalanceCents: funding.minimumBalanceCents },
      now: this.deps.clock.now(),
    });
    if (!resumed.changed) {
      return { outcome: "unchanged", standing: resumed.standing, shortfallCents: null, listingHold: null };
    }
    const standing = requireStanding(resumed.standing, parsed.vendorId);
    this.deps.logger.info({
      code: "DROPSHIP_VENDOR_RESUMED",
      message: "Dropship vendor's funding pause is over: the wallet is funded again; listings are released.",
      context: {
        vendorId: standing.vendorId,
        status: standing.status,
        standingRevision: standing.standingRevision,
        availableBalanceCents: funding.availableBalanceCents,
        minimumBalanceCents: funding.minimumBalanceCents,
      },
    });
    if (standing.status !== "active") {
      // The membership lapsed or was suspended while the vendor was paused:
      // the funding pause is cleared, but "selling has resumed" would be a lie.
      const listingHold = await this.reconcileListingHoldSafely(standing);
      return { outcome: "resumed", standing, shortfallCents: 0, listingHold };
    }
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: standing.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.VENDOR_RESUMED,
      critical: false,
      channels: ["email", "in_app"],
      title: "Selling has resumed",
      message: `Your wallet is funded again (${formatNotificationCurrency(funding.availableBalanceCents, funding.currency)} available). Orders are being accepted and your listings are live again.`,
      payload: {
        vendorId: standing.vendorId,
        standingRevision: standing.standingRevision,
        availableBalanceCents: funding.availableBalanceCents,
        minimumBalanceCents: funding.minimumBalanceCents,
        currency: funding.currency,
      },
      idempotencyKey: vendorStandingNotificationKeyFor({ vendorId: standing.vendorId, standingRevision: standing.standingRevision, event: "resumed" }),
    }, {
      code: "DROPSHIP_VENDOR_RESUMED_NOTIFICATION_FAILED",
      message: "Dropship vendor resume notification failed after the resume was recorded.",
      context: { vendorId: standing.vendorId },
    });
    const listingHold = await this.reconcileListingHoldSafely(standing);
    return { outcome: "resumed", standing, shortfallCents: 0, listingHold };
  }

  /**
   * Hourly safety net. Two passes:
   *  1. every vendor paused for a funding reason is checked against the
   *     wallet, so a resume that failed after a settled credit is not lost;
   *  2. every listing hold or release that did not land when standing
   *     changed is retried.
   */
  async reconcileStanding(input: unknown): Promise<DropshipVendorStandingReconcileResult> {
    const parsed = parseInput(reconcileDropshipVendorStandingInputSchema, input, "DROPSHIP_VENDOR_STANDING_RECONCILE_INVALID_INPUT");
    const limit = parsed.limit ?? DEFAULT_RECONCILE_LIMIT;
    const result: DropshipVendorStandingReconcileResult = {
      restore: { scannedCount: 0, resumedCount: 0, stillShortCount: 0, failedCount: 0 },
      listingHolds: { scannedCount: 0, appliedCount: 0, deferredCount: 0, failedCount: 0, unavailableCount: 0 },
    };

    const paused = await this.deps.repository.listPausedForFunding({ limit });
    result.restore.scannedCount = paused.length;
    for (const standing of paused) {
      try {
        const change = await this.restoreIfFunded({ vendorId: standing.vendorId, evidence: { source: "standing_reconcile", workerId: parsed.workerId } });
        if (change.outcome === "resumed") result.restore.resumedCount += 1;
        else if (change.outcome === "still_short") result.restore.stillShortCount += 1;
      } catch (error) {
        result.restore.failedCount += 1;
        this.deps.logger.error({
          code: "DROPSHIP_VENDOR_RESTORE_CHECK_FAILED",
          message: "Dropship vendor standing reconcile could not check whether a paused vendor is funded again.",
          context: { vendorId: standing.vendorId, workerId: parsed.workerId, error: errorMessage(error) },
        });
      }
    }

    const mismatches = await this.deps.repository.listListingHoldMismatches({ limit });
    result.listingHolds.scannedCount = mismatches.length;
    for (const standing of mismatches) {
      const reconciliation = await this.reconcileListingHoldSafely(standing);
      if (reconciliation.outcome === "applied" || reconciliation.outcome === "in_sync") result.listingHolds.appliedCount += 1;
      else if (reconciliation.outcome === "deferred") result.listingHolds.deferredCount += 1;
      else if (reconciliation.outcome === "unavailable") result.listingHolds.unavailableCount += 1;
      else result.listingHolds.failedCount += 1;
    }

    if (result.restore.scannedCount > 0 || result.listingHolds.scannedCount > 0) {
      this.deps.logger.info({
        code: "DROPSHIP_VENDOR_STANDING_RECONCILE_COMPLETED",
        message: "Dropship vendor standing reconciliation completed.",
        context: { workerId: parsed.workerId, ...result },
      });
    }
    return result;
  }

  private async announce(
    standing: DropshipVendorStandingRecord,
    evidence: Record<string, unknown>,
  ): Promise<DropshipVendorStandingChange> {
    const reason = standing.standingReason ?? "funding_returned";
    this.deps.logger.warn({
      code: "DROPSHIP_VENDOR_PAUSED",
      message: "Dropship vendor paused after a funding failure; order acceptance stops and listings are held at zero.",
      context: { vendorId: standing.vendorId, reason, standingRevision: standing.standingRevision, evidence },
    });
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: standing.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.VENDOR_PAUSED,
      critical: true,
      channels: ["email", "in_app"],
      title: "Selling is paused until your wallet is funded",
      message: pauseMessageFor(reason, evidence),
      payload: {
        vendorId: standing.vendorId,
        reason,
        pausedAt: standing.pausedAt?.toISOString() ?? null,
        standingRevision: standing.standingRevision,
        ...evidence,
      },
      idempotencyKey: vendorStandingNotificationKeyFor({ vendorId: standing.vendorId, standingRevision: standing.standingRevision, event: "paused" }),
    }, {
      code: "DROPSHIP_VENDOR_PAUSED_NOTIFICATION_FAILED",
      message: "Dropship vendor pause notification failed after the pause was recorded.",
      context: { vendorId: standing.vendorId, reason },
    });
    const listingHold = await this.reconcileListingHoldSafely(standing);
    return { outcome: "paused", standing, shortfallCents: null, listingHold };
  }

  /**
   * Bring inventory planning in line with the vendor's standing. A thrown
   * gate error is logged and reported as a failure rather than propagated:
   * the standing change it follows is already committed and must not be
   * undone by a marketplace hiccup; the hourly reconciler retries.
   */
  private async reconcileListingHoldSafely(
    standing: DropshipVendorStandingRecord,
  ): Promise<DropshipListingHoldReconciliation> {
    const wanted = listingHoldStateFor(standing.status);
    try {
      return await this.reconcileListingHold(standing, wanted);
    } catch (error) {
      const message = errorMessage(error);
      this.deps.logger.error({
        code: "DROPSHIP_LISTING_HOLD_RECONCILE_FAILED",
        message: "Dropship listing hold could not be reconciled; the vendor's marketplace stock may not match their standing.",
        context: { vendorId: standing.vendorId, wanted, standingRevision: standing.standingRevision, error: message },
      });
      await this.recordListingHoldStateSafely(standing, standing.listingHoldState, `${wanted} failed: ${message}`);
      return { outcome: "failed", wanted, error: message };
    }
  }

  private async reconcileListingHold(
    standing: DropshipVendorStandingRecord,
    wanted: DropshipListingHoldState,
  ): Promise<DropshipListingHoldReconciliation> {
    if (standing.listingHoldState === wanted) {
      return { outcome: "in_sync", state: wanted };
    }
    if (!this.deps.listingHolds) {
      this.deps.logger.warn({
        code: "DROPSHIP_LISTING_HOLD_GATE_UNAVAILABLE",
        message: "Dropship vendor standing changed but no listing hold gate is configured; marketplace stock is unchanged.",
        context: { vendorId: standing.vendorId, wanted },
      });
      return { outcome: "unavailable", wanted };
    }
    const storeConnectionIds = await this.deps.repository.listStoreConnectionIds(standing.vendorId);
    const reason = wanted === "held"
      ? `Dropship vendor ${standing.vendorId} paused: ${standing.standingReason ?? "standing"}`
      : `Dropship vendor ${standing.vendorId} resumed`;
    const blockedProductIds = new Set<number>();
    for (const storeConnectionId of storeConnectionIds) {
      const command = {
        storeConnectionId,
        reason,
        idempotencyKey: listingHoldIdempotencyKeyFor({
          vendorId: standing.vendorId,
          standingRevision: standing.standingRevision,
          state: wanted,
          storeConnectionId,
        }),
      };
      const outcome = wanted === "held"
        ? await this.deps.listingHolds.hold(command)
        : await this.deps.listingHolds.release(command);
      if (!outcome.applied) {
        this.deps.logger.warn({
          code: "DROPSHIP_LISTING_HOLD_DEFERRED",
          message: "Dropship listing hold command was refused for now; it is retried on the next tick.",
          context: { vendorId: standing.vendorId, storeConnectionId, wanted, code: outcome.code, error: outcome.message },
        });
        await this.deps.repository.recordListingHoldState({
          vendorId: standing.vendorId,
          state: standing.listingHoldState,
          detail: `${wanted} deferred on store ${storeConnectionId}: ${outcome.code}`,
          now: this.deps.clock.now(),
        });
        return { outcome: "deferred", wanted, storeConnectionId, code: outcome.code, message: outcome.message };
      }
      for (const productId of outcome.blockedProductIds) blockedProductIds.add(productId);
    }
    const blocked = [...blockedProductIds].sort((a, b) => a - b);
    await this.deps.repository.recordListingHoldState({
      vendorId: standing.vendorId,
      state: wanted,
      detail: blocked.length > 0 ? `${wanted}; planner blocked products ${blocked.join(",")}` : null,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: wanted === "held" ? "DROPSHIP_LISTINGS_HELD" : "DROPSHIP_LISTINGS_RELEASED",
      message: wanted === "held"
        ? "Dropship vendor's store connections are held at zero quantity."
        : "Dropship vendor's store connections are publishing real quantities again.",
      context: { vendorId: standing.vendorId, storeConnectionIds, blockedProductIds: blocked, standingRevision: standing.standingRevision },
    });
    return { outcome: "applied", state: wanted, storeConnectionIds, blockedProductIds: blocked };
  }

  /** Recording the detail of a failure must not turn one failure into two. */
  private async recordListingHoldStateSafely(
    standing: DropshipVendorStandingRecord,
    state: DropshipListingHoldState,
    detail: string,
  ): Promise<void> {
    try {
      await this.deps.repository.recordListingHoldState({ vendorId: standing.vendorId, state, detail, now: this.deps.clock.now() });
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_LISTING_HOLD_STATE_RECORD_FAILED",
        message: "Dropship listing hold detail could not be recorded after a reconcile failure.",
        context: { vendorId: standing.vendorId, error: errorMessage(error) },
      });
    }
  }
}

function pauseMessageFor(reason: DropshipVendorStandingReason, evidence: Record<string, unknown>): string {
  const amount = typeof evidence.amountCents === "number" && typeof evidence.currency === "string"
    ? formatNotificationCurrency(evidence.amountCents, evidence.currency)
    : null;
  const declineDetail = typeof evidence.stripeDeclineCode === "string"
    ? ` (${evidence.stripeDeclineCode.replace(/_/g, " ")})`
    : "";
  const how = reason === "funding_returned"
    ? evidence.disputed === true
      // A settled credit taken back (funding design phase 4): the bank
      // reversed a payment that had already landed, whichever rail it used.
      ? `A payment${amount ? ` of ${amount}` : ""} you added to your wallet was disputed and taken back by your bank.`
      : `A bank transfer${amount ? ` of ${amount}` : ""} to your wallet was returned by your bank.`
    : `Your saved card was declined${declineDetail} when we tried to top up your wallet${amount ? ` by ${amount}` : ""}.`;
  return `${how} Orders are not being accepted and your listings show no stock until your wallet is funded again. Add funds by ACH or update your card in Wallet; selling resumes on its own once your balance is back to your reserve.`;
}

function requireStanding(standing: DropshipVendorStandingRecord | null, vendorId: number): DropshipVendorStandingRecord {
  if (!standing) {
    throw new DropshipError(
      "DROPSHIP_VENDOR_STANDING_MISSING",
      "Dropship vendor standing changed but the repository returned no record.",
      { vendorId },
    );
  }
  return standing;
}

function parseInput<TSchema extends z.ZodTypeAny>(schema: TSchema, input: unknown, code: string): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(code, "Dropship vendor standing input failed validation.", { issues: result.error.issues });
  }
  return result.data as z.infer<TSchema>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function makeDropshipVendorStandingLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipVendorStandingEvent("info", event),
    warn: (event) => logDropshipVendorStandingEvent("warn", event),
    error: (event) => logDropshipVendorStandingEvent("error", event),
  };
}

export const systemDropshipVendorStandingClock: DropshipClock = {
  now: () => new Date(),
};

function logDropshipVendorStandingEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({ code: event.code, message: event.message, context: event.context ?? {} });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.info(payload);
}
