import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { DROPSHIP_FUNDING_DECLINED_ERROR_CODE } from "../domain/vendor-standing";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
} from "./dropship-ports";
import type {
  DropshipVendorStandingChange,
  DropshipVendorStandingService,
} from "./dropship-vendor-standing-service";
import type { DropshipAutoReloadResult } from "./dropship-wallet-service";

/**
 * Daily wallet maintenance.
 *
 * Every live vendor keeps auto-reload on and a card on file (both enforced at
 * launch and while active), but until this job existed auto-reload only ran
 * while an order was being processed. A return fee, or simply a quiet week,
 * could leave a wallet below its minimum — or negative — with nothing topping
 * it up until the next order arrived. This job closes that gap: once per
 * vendor per UTC day it runs the routine minimum-balance reload through the
 * wallet service, so the same code path, fee policy, idempotency and ledger
 * rules apply whether the trigger was an order or the calendar.
 *
 * It replaces the weekly collection sweep, which charged only the negative
 * amount after a week of grace. Here a negative balance is simply a larger
 * top-up; debt collection has no separate path.
 *
 * Locked rules:
 * - Idempotent per (vendor, run date): one dropship_wallet_maintenance_runs
 *   row. A repeated or crashed tick replays the row; a run that reached a
 *   terminal status is never charged again. The wallet-service idempotency
 *   key is derived from the same pair, so even a retry after a lost Stripe
 *   response cannot double-charge.
 * - Transient provider failures (outage, rate limit, network) retry on the
 *   next hourly tick, capped per day. The vendor is not told: they did
 *   nothing, and the money will be collected within hours, not days.
 * - A decline (the bank said no) or a vendor-side gap (no usable method,
 *   single-reload cap too low, auto-reload off) is terminal for the day,
 *   recorded, and the vendor is told once.
 * - Our own misconfiguration (no funding provider, rejected credentials) is
 *   terminal for the day, logged at ERROR, and never blamed on the vendor.
 */

export const DROPSHIP_WALLET_MAINTENANCE_RUN_STATUSES = [
  /** Claimed for the day; no attempt recorded yet. */
  "pending",
  /** The provider hiccupped; the next hourly tick tries again. */
  "retry_pending",
  /** The wallet was credited (settled for a card, pending for ACH). */
  "reloaded",
  /** The balance, counting credits still settling, already met the minimum. */
  "not_needed",
  /** The vendor has to act: no usable method, cap too low, auto-reload off. */
  "attention",
  /** The bank refused the charge. */
  "declined",
  /** Our side, or retries exhausted; a human needs to look. */
  "failed",
] as const;
export type DropshipWalletMaintenanceRunStatus = (typeof DROPSHIP_WALLET_MAINTENANCE_RUN_STATUSES)[number];

const TERMINAL_RUN_STATUSES: ReadonlySet<DropshipWalletMaintenanceRunStatus> = new Set([
  "reloaded",
  "not_needed",
  "attention",
  "declined",
  "failed",
]);

/**
 * Hourly ticks give a provider outage this many tries before the day is given
 * up on. Six covers an afternoon-long incident without hammering a provider
 * that is clearly down; the next UTC day starts fresh.
 */
export const DEFAULT_WALLET_MAINTENANCE_MAX_ATTEMPTS_PER_DAY = 6;
const DEFAULT_MAINTENANCE_LIMIT = 200;
const MAX_MAINTENANCE_LIMIT = 1000;

/** The balance already covers the minimum: the policy working as configured. */
const NOT_NEEDED_SKIP_REASONS: ReadonlySet<string> = new Set(["balance_already_sufficient"]);
/** Skips that are our configuration, never the vendor's. */
const OUR_SIDE_SKIP_REASONS: ReadonlySet<string> = new Set(["funding_provider_not_configured"]);
/**
 * The one permanent provider failure that is the vendor's to fix: the bank
 * refused the charge. Other permanent failures (a rejected request, an
 * idempotency conflict) are ours, and telling the vendor their card was
 * declined would be both wrong and alarming.
 */
const CARD_DECLINED_ERROR_CODE = DROPSHIP_FUNDING_DECLINED_ERROR_CODE;

export const runDropshipWalletMaintenanceInputSchema = z.object({
  workerId: z.string().trim().min(1).max(120),
  limit: z.number().int().positive().max(MAX_MAINTENANCE_LIMIT).optional(),
}).strict();
export type RunDropshipWalletMaintenanceInput = z.infer<typeof runDropshipWalletMaintenanceInputSchema>;

export interface DropshipWalletMaintenanceRunRecord {
  runId: number;
  vendorId: number;
  /** UTC calendar day, `YYYY-MM-DD`. */
  runDate: string;
  status: DropshipWalletMaintenanceRunStatus;
  attemptCount: number;
  /** What the wallet was credited, net of any card fee. */
  amountCents: number | null;
  cardFeeCents: number | null;
  /** What the funding method was charged: credit plus fee. */
  chargedCents: number | null;
  currency: string;
  fundingMethodId: number | null;
  fundingStatus: "pending" | "settled" | null;
  walletLedgerEntryId: number | null;
  providerPaymentIntentId: string | null;
  outcomeCode: string | null;
  outcomeMessage: string | null;
  lastAttemptAt: Date | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecordDropshipWalletMaintenanceOutcomeInput {
  runId: number;
  vendorId: number;
  status: Exclude<DropshipWalletMaintenanceRunStatus, "pending">;
  amountCents: number | null;
  cardFeeCents: number | null;
  chargedCents: number | null;
  currency: string | null;
  fundingMethodId: number | null;
  fundingStatus: "pending" | "settled" | null;
  walletLedgerEntryId: number | null;
  providerPaymentIntentId: string | null;
  outcomeCode: string | null;
  outcomeMessage: string | null;
  now: Date;
}

export interface DropshipWalletMaintenanceRepository {
  /**
   * Active vendors with an active wallet whose run for `runDate` does not
   * exist yet or is still open (`pending` / `retry_pending`).
   */
  listVendorsDue(input: { runDate: string; limit: number }): Promise<Array<{ vendorId: number }>>;
  /** Insert the day's run row, or return the existing one. */
  claimRun(input: {
    vendorId: number;
    runDate: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<{ run: DropshipWalletMaintenanceRunRecord; created: boolean }>;
  /** Bump the attempt counter before the charge, so a crash mid-charge leaves a trace. */
  markAttemptStarted(input: { runId: number; vendorId: number; now: Date }): Promise<DropshipWalletMaintenanceRunRecord>;
  /** Record the attempt's outcome; terminal outcomes that need a human are audited with it. */
  recordOutcome(input: RecordDropshipWalletMaintenanceOutcomeInput): Promise<DropshipWalletMaintenanceRunRecord>;
}

/** The slice of the wallet service this job drives: the routine top-up. */
export interface DropshipWalletMaintenanceReloader {
  handleAutoReload(input: {
    vendorId: number;
    reason: "minimum_balance";
    idempotencyKey: string;
  }): Promise<DropshipAutoReloadResult>;
}

export type DropshipWalletMaintenanceOutcome =
  | Exclude<DropshipWalletMaintenanceRunStatus, "pending">
  /** The day's run was already terminal when this tick found it. */
  | "replayed";

export interface DropshipWalletMaintenanceRunOutcome {
  vendorId: number;
  runId: number;
  outcome: DropshipWalletMaintenanceOutcome;
  status: DropshipWalletMaintenanceRunStatus;
  attemptCount: number;
  amountCents: number | null;
  chargedCents: number | null;
  outcomeCode: string | null;
}

export interface DropshipWalletMaintenanceResult {
  runDate: string;
  scannedCount: number;
  reloadedCount: number;
  notNeededCount: number;
  retryPendingCount: number;
  attentionCount: number;
  declinedCount: number;
  failedCount: number;
  replayedCount: number;
  runs: DropshipWalletMaintenanceRunOutcome[];
}

/** The UTC calendar day a run belongs to. Deterministic for a given clock reading. */
export function walletMaintenanceRunDateFor(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function walletMaintenanceIdempotencyKeyFor(vendorId: number, runDate: string): string {
  return `wallet-maintenance:${vendorId}:${runDate}`;
}

type ReloadFailureClass =
  | "transient"
  | "permanent"
  | "fatal"
  /** A DropshipError the provider layer did not classify, e.g. an amount mismatch. */
  | "unclassified"
  /** Not a DropshipError at all: infrastructure, a bug. */
  | "unknown";

export class DropshipWalletMaintenanceService {
  private readonly maxAttemptsPerDay: number;

  constructor(
    private readonly deps: {
      repository: DropshipWalletMaintenanceRepository;
      reloader: DropshipWalletMaintenanceReloader;
      notificationSender?: DropshipNotificationSender;
      /** Pauses the vendor on a decline: no orders, listings held at zero, until funded. */
      vendorStanding?: Pick<DropshipVendorStandingService, "pauseForFundingFailure">;
      clock: DropshipClock;
      logger: DropshipLogger;
      maxAttemptsPerDay?: number;
    },
  ) {
    const configured = deps.maxAttemptsPerDay ?? DEFAULT_WALLET_MAINTENANCE_MAX_ATTEMPTS_PER_DAY;
    if (!Number.isInteger(configured) || configured < 1) {
      throw new DropshipError(
        "DROPSHIP_WALLET_MAINTENANCE_MISCONFIGURED",
        "Wallet maintenance requires a positive whole number of attempts per day.",
        { maxAttemptsPerDay: configured },
      );
    }
    this.maxAttemptsPerDay = configured;
  }

  async runMaintenance(input: unknown): Promise<DropshipWalletMaintenanceResult> {
    const parsed = parseMaintenanceInput(input);
    const now = this.deps.clock.now();
    const runDate = walletMaintenanceRunDateFor(now);
    const vendors = await this.deps.repository.listVendorsDue({
      runDate,
      limit: parsed.limit ?? DEFAULT_MAINTENANCE_LIMIT,
    });

    const result: DropshipWalletMaintenanceResult = {
      runDate,
      scannedCount: vendors.length,
      reloadedCount: 0,
      notNeededCount: 0,
      retryPendingCount: 0,
      attentionCount: 0,
      declinedCount: 0,
      failedCount: 0,
      replayedCount: 0,
      runs: [],
    };

    for (const vendor of vendors) {
      const outcome = await this.maintainOneVendor({ vendorId: vendor.vendorId, runDate, now, workerId: parsed.workerId });
      result.runs.push(outcome);
      tallyOutcome(result, outcome.outcome);
    }

    if (result.scannedCount > 0 && result.scannedCount !== result.notNeededCount + result.replayedCount) {
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_MAINTENANCE_COMPLETED",
        message: "Dropship wallet maintenance run completed.",
        context: {
          workerId: parsed.workerId,
          runDate,
          scannedCount: result.scannedCount,
          reloadedCount: result.reloadedCount,
          notNeededCount: result.notNeededCount,
          retryPendingCount: result.retryPendingCount,
          attentionCount: result.attentionCount,
          declinedCount: result.declinedCount,
          failedCount: result.failedCount,
          replayedCount: result.replayedCount,
        },
      });
    }
    return result;
  }

  private async maintainOneVendor(input: {
    vendorId: number;
    runDate: string;
    now: Date;
    workerId: string;
  }): Promise<DropshipWalletMaintenanceRunOutcome> {
    const idempotencyKey = walletMaintenanceIdempotencyKeyFor(input.vendorId, input.runDate);
    const { run } = await this.deps.repository.claimRun({
      vendorId: input.vendorId,
      runDate: input.runDate,
      idempotencyKey,
      now: input.now,
    });

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return toRunOutcome(run, "replayed");
    }

    if (run.attemptCount >= this.maxAttemptsPerDay) {
      const exhausted = await this.deps.repository.recordOutcome({
        ...emptyOutcomeFields(run),
        status: "failed",
        outcomeCode: "retry_exhausted",
        outcomeMessage: `Wallet maintenance gave up for the day after ${run.attemptCount} attempts.`,
        now: input.now,
      });
      this.deps.logger.error({
        code: "DROPSHIP_WALLET_MAINTENANCE_RETRY_EXHAUSTED",
        message: "Dropship wallet maintenance exhausted its retries for the day; the wallet was not topped up.",
        context: {
          vendorId: input.vendorId,
          runId: run.runId,
          runDate: input.runDate,
          attemptCount: run.attemptCount,
          maxAttemptsPerDay: this.maxAttemptsPerDay,
          workerId: input.workerId,
        },
      });
      return toRunOutcome(exhausted, "failed");
    }

    const attempt = await this.deps.repository.markAttemptStarted({
      runId: run.runId,
      vendorId: input.vendorId,
      now: input.now,
    });

    try {
      const reload = await this.deps.reloader.handleAutoReload({
        vendorId: input.vendorId,
        reason: "minimum_balance",
        idempotencyKey,
      });
      return await this.recordReloadResult({ run: attempt, reload, now: input.now, workerId: input.workerId });
    } catch (error) {
      return await this.recordReloadError({ run: attempt, error, now: input.now, workerId: input.workerId });
    }
  }

  private async recordReloadResult(input: {
    run: DropshipWalletMaintenanceRunRecord;
    reload: DropshipAutoReloadResult;
    now: Date;
    workerId: string;
  }): Promise<DropshipWalletMaintenanceRunOutcome> {
    const { run, reload } = input;
    const baseContext = {
      vendorId: run.vendorId,
      runId: run.runId,
      runDate: run.runDate,
      attemptCount: run.attemptCount,
      workerId: input.workerId,
    };

    if (reload.outcome === "funding_created") {
      const reloaded = await this.deps.repository.recordOutcome({
        runId: run.runId,
        vendorId: run.vendorId,
        status: "reloaded",
        amountCents: reload.amountCents,
        cardFeeCents: reload.cardFeeCents,
        chargedCents: reload.chargedCents,
        currency: reload.currency,
        fundingMethodId: reload.fundingMethodId,
        fundingStatus: reload.fundingStatus,
        walletLedgerEntryId: reload.fundingLedgerEntryId,
        providerPaymentIntentId: reload.providerPaymentIntentId,
        outcomeCode: null,
        outcomeMessage: null,
        now: input.now,
      });
      this.deps.logger.info({
        code: "DROPSHIP_WALLET_MAINTENANCE_RELOADED",
        message: "Dropship wallet maintenance topped a wallet up to its minimum.",
        context: {
          ...baseContext,
          amountCents: reload.amountCents,
          cardFeeCents: reload.cardFeeCents,
          chargedCents: reload.chargedCents,
          currency: reload.currency,
          fundingMethodId: reload.fundingMethodId,
          fundingStatus: reload.fundingStatus,
          providerPaymentIntentId: reload.providerPaymentIntentId,
          walletLedgerEntryId: reload.fundingLedgerEntryId,
          idempotentReplay: reload.idempotentReplay,
        },
      });
      return toRunOutcome(reloaded, "reloaded");
    }

    const skipReason = reload.skipReason ?? "unknown";
    if (NOT_NEEDED_SKIP_REASONS.has(skipReason)) {
      // The routine case for a healthy wallet; the wallet service already
      // logged the no-op, so nothing more is written here.
      const notNeeded = await this.deps.repository.recordOutcome({
        ...emptyOutcomeFields(run),
        status: "not_needed",
        currency: reload.currency,
        outcomeCode: skipReason,
        outcomeMessage: null,
        now: input.now,
      });
      return toRunOutcome(notNeeded, "not_needed");
    }

    if (OUR_SIDE_SKIP_REASONS.has(skipReason)) {
      const failed = await this.deps.repository.recordOutcome({
        ...emptyOutcomeFields(run),
        status: "failed",
        currency: reload.currency,
        outcomeCode: skipReason,
        outcomeMessage: "Wallet maintenance cannot charge: the funding provider is not configured.",
        now: input.now,
      });
      this.deps.logger.error({
        code: "DROPSHIP_WALLET_MAINTENANCE_PROVIDER_UNAVAILABLE",
        message: "Dropship wallet maintenance could not run because the funding provider is not configured.",
        context: { ...baseContext, skipReason },
      });
      return toRunOutcome(failed, "failed");
    }

    const attention = await this.deps.repository.recordOutcome({
      ...emptyOutcomeFields(run),
      status: "attention",
      currency: reload.currency,
      fundingMethodId: reload.fundingMethodId,
      outcomeCode: skipReason,
      outcomeMessage: attentionMessageFor(skipReason),
      now: input.now,
    });
    this.deps.logger.warn({
      code: "DROPSHIP_WALLET_MAINTENANCE_NEEDS_VENDOR_ATTENTION",
      message: "Dropship wallet maintenance could not top up a wallet; the vendor has to act.",
      context: { ...baseContext, skipReason, fundingMethodId: reload.fundingMethodId },
    });
    await this.notifyVendor({
      run: attention,
      title: "Dropship wallet top-up needs your attention",
      message: attentionMessageFor(skipReason),
      payload: { skipReason, fundingMethodId: reload.fundingMethodId },
    });
    return toRunOutcome(attention, "attention");
  }

  private async recordReloadError(input: {
    run: DropshipWalletMaintenanceRunRecord;
    error: unknown;
    now: Date;
    workerId: string;
  }): Promise<DropshipWalletMaintenanceRunOutcome> {
    const { run, error } = input;
    const failureClass = classifyReloadError(error);
    const errorCode = error instanceof DropshipError ? error.code : "DROPSHIP_WALLET_MAINTENANCE_UNEXPECTED_ERROR";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorContext = error instanceof DropshipError ? error.context ?? {} : {};
    const baseContext = {
      vendorId: run.vendorId,
      runId: run.runId,
      runDate: run.runDate,
      attemptCount: run.attemptCount,
      workerId: input.workerId,
      errorCode,
      failureClass,
      error: errorMessage,
    };

    if (failureClass === "transient" || failureClass === "unknown") {
      const retry = await this.deps.repository.recordOutcome({
        ...emptyOutcomeFields(run),
        status: "retry_pending",
        outcomeCode: errorCode,
        outcomeMessage: errorMessage,
        now: input.now,
      });
      this.deps.logger.warn({
        code: "DROPSHIP_WALLET_MAINTENANCE_RETRY_SCHEDULED",
        message: "Dropship wallet maintenance hit a provider or infrastructure error; it retries on the next tick.",
        context: { ...baseContext, maxAttemptsPerDay: this.maxAttemptsPerDay },
      });
      return toRunOutcome(retry, "retry_pending");
    }

    if (failureClass === "permanent" && errorCode === CARD_DECLINED_ERROR_CODE) {
      const declined = await this.deps.repository.recordOutcome({
        ...emptyOutcomeFields(run),
        status: "declined",
        outcomeCode: errorCode,
        outcomeMessage: errorMessage,
        now: input.now,
      });
      this.deps.logger.warn({
        code: "DROPSHIP_WALLET_MAINTENANCE_DECLINED",
        message: "Dropship wallet maintenance charge was declined by the vendor's bank.",
        context: {
          ...baseContext,
          stripeCode: errorContext.stripeCode ?? null,
          stripeDeclineCode: errorContext.stripeDeclineCode ?? null,
        },
      });
      // The first decline pauses the vendor; the pause notice says what was
      // declined and what to do, so the daily decline notice is only sent
      // when no pause went out (already paused, or standing not wired).
      const pause = await this.pauseVendorSafely(declined, errorCode, errorContext);
      if (pause?.outcome !== "paused") {
        await this.notifyVendor({
          run: declined,
          title: "Dropship wallet top-up declined",
          message: declineMessageFor(errorContext),
          payload: {
            failureCode: errorCode,
            stripeCode: errorContext.stripeCode ?? null,
            stripeDeclineCode: errorContext.stripeDeclineCode ?? null,
          },
        });
      }
      return toRunOutcome(declined, "declined");
    }

    // Permanent but not a decline (rejected request, idempotency conflict),
    // fatal (credentials, permissions), or unclassified (an amount mismatch, a
    // payment that never reached a fundable state): terminal for the day and
    // a human's problem, not the vendor's.
    const failed = await this.deps.repository.recordOutcome({
      ...emptyOutcomeFields(run),
      status: "failed",
      outcomeCode: errorCode,
      outcomeMessage: errorMessage,
      now: input.now,
    });
    this.deps.logger.error({
      code: "DROPSHIP_WALLET_MAINTENANCE_FAILED",
      message: "Dropship wallet maintenance failed on our side; the wallet was not topped up.",
      context: baseContext,
    });
    return toRunOutcome(failed, "failed");
  }

  /**
   * Standing has its own retry (tomorrow's run declines again and pauses
   * then), so a failure here is logged for a human and never fails the run
   * that was already recorded.
   */
  private async pauseVendorSafely(
    run: DropshipWalletMaintenanceRunRecord,
    errorCode: string,
    errorContext: Record<string, unknown>,
  ): Promise<DropshipVendorStandingChange | null> {
    if (!this.deps.vendorStanding) {
      return null;
    }
    try {
      return await this.deps.vendorStanding.pauseForFundingFailure({
        vendorId: run.vendorId,
        reason: "card_declined",
        evidence: {
          source: "wallet_maintenance",
          runId: run.runId,
          runDate: run.runDate,
          failureCode: errorCode,
          stripeCode: errorContext.stripeCode ?? null,
          stripeDeclineCode: errorContext.stripeDeclineCode ?? null,
        },
      });
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_WALLET_MAINTENANCE_VENDOR_PAUSE_FAILED",
        message: "Dropship vendor could not be paused after a declined top-up; tomorrow's run retries the decline.",
        context: {
          vendorId: run.vendorId,
          runId: run.runId,
          runDate: run.runDate,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  }

  private async notifyVendor(input: {
    run: DropshipWalletMaintenanceRunRecord;
    title: string;
    message: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: input.run.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.AUTO_RELOAD_FAILED,
      critical: true,
      channels: ["email", "in_app"],
      title: input.title,
      message: input.message,
      payload: {
        vendorId: input.run.vendorId,
        runId: input.run.runId,
        runDate: input.run.runDate,
        status: input.run.status,
        attemptCount: input.run.attemptCount,
        source: "wallet_maintenance",
        ...input.payload,
      },
      // One notice per vendor per day per outcome; a same-day replay stays quiet.
      idempotencyKey: `${input.run.idempotencyKey}:${input.run.status}`,
    }, {
      code: "DROPSHIP_WALLET_MAINTENANCE_NOTIFICATION_FAILED",
      message: "Dropship wallet maintenance vendor notification failed after the run was recorded.",
      context: {
        vendorId: input.run.vendorId,
        runId: input.run.runId,
        runDate: input.run.runDate,
        status: input.run.status,
      },
    });
  }
}

function tallyOutcome(result: DropshipWalletMaintenanceResult, outcome: DropshipWalletMaintenanceOutcome): void {
  switch (outcome) {
    case "reloaded": result.reloadedCount += 1; break;
    case "not_needed": result.notNeededCount += 1; break;
    case "retry_pending": result.retryPendingCount += 1; break;
    case "attention": result.attentionCount += 1; break;
    case "declined": result.declinedCount += 1; break;
    case "failed": result.failedCount += 1; break;
    case "replayed": result.replayedCount += 1; break;
  }
}

function toRunOutcome(
  run: DropshipWalletMaintenanceRunRecord,
  outcome: DropshipWalletMaintenanceOutcome,
): DropshipWalletMaintenanceRunOutcome {
  return {
    vendorId: run.vendorId,
    runId: run.runId,
    outcome,
    status: run.status,
    attemptCount: run.attemptCount,
    amountCents: run.amountCents,
    chargedCents: run.chargedCents,
    outcomeCode: run.outcomeCode,
  };
}

/** The money fields of an outcome that charged nothing. */
function emptyOutcomeFields(run: DropshipWalletMaintenanceRunRecord): Pick<
  RecordDropshipWalletMaintenanceOutcomeInput,
  | "runId" | "vendorId" | "amountCents" | "cardFeeCents" | "chargedCents" | "currency"
  | "fundingMethodId" | "fundingStatus" | "walletLedgerEntryId" | "providerPaymentIntentId"
> {
  return {
    runId: run.runId,
    vendorId: run.vendorId,
    amountCents: null,
    cardFeeCents: null,
    chargedCents: null,
    currency: null,
    fundingMethodId: null,
    fundingStatus: null,
    walletLedgerEntryId: null,
    providerPaymentIntentId: null,
  };
}

/**
 * The provider layer stamps every Stripe failure with a classification
 * (`dropship-stripe-error.ts`). Anything else is either one of our own
 * structured errors, which is terminal because retrying blindly could charge
 * twice for a state we do not understand, or plain infrastructure trouble,
 * which is retried under the stable idempotency key.
 */
function classifyReloadError(error: unknown): ReloadFailureClass {
  if (!(error instanceof DropshipError)) return "unknown";
  const classification = error.context?.classification;
  if (classification === "transient" || classification === "permanent" || classification === "fatal") {
    return classification;
  }
  return "unclassified";
}

function attentionMessageFor(skipReason: string): string {
  switch (skipReason) {
    case "amount_exceeds_max_single_reload":
      return "Your wallet is below its minimum, and the top-up needed is more than your single-reload limit. Raise the limit in Wallet or add funds.";
    case "auto_reload_disabled":
      return "Auto-reload is off, so your wallet is not being topped up. Turn it on in Wallet so orders never wait for a payment.";
    case "funding_method_required":
    case "funding_method_missing":
      return "Auto-reload has no funding method to charge. Choose one in Wallet.";
    case "funding_method_not_active":
    case "funding_method_provider_identity_required":
    case "funding_method_rail_unsupported":
      return "Auto-reload cannot charge your saved funding method. Update it in Wallet.";
    default:
      return `Auto-reload could not top up your wallet (${skipReason}). Check your funding method in Wallet.`;
  }
}

function declineMessageFor(errorContext: Record<string, unknown>): string {
  const declineCode = typeof errorContext.stripeDeclineCode === "string" ? errorContext.stripeDeclineCode : null;
  const detail = declineCode ? ` (${declineCode.replace(/_/g, " ")})` : "";
  return `We tried to top up your wallet to its minimum and your saved funding method was declined${detail}. Update it in Wallet or add funds by ACH. Orders that arrive before the balance is restored will wait for payment.`;
}

function parseMaintenanceInput(input: unknown): RunDropshipWalletMaintenanceInput {
  const result = runDropshipWalletMaintenanceInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_WALLET_MAINTENANCE_INVALID_INPUT",
      "Dropship wallet maintenance input failed validation.",
      { issues: result.error.issues },
    );
  }
  return result.data;
}

export function makeDropshipWalletMaintenanceLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipWalletMaintenanceEvent("info", event),
    warn: (event) => logDropshipWalletMaintenanceEvent("warn", event),
    error: (event) => logDropshipWalletMaintenanceEvent("error", event),
  };
}

export const systemDropshipWalletMaintenanceClock: DropshipClock = {
  now: () => new Date(),
};

function logDropshipWalletMaintenanceEvent(
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
