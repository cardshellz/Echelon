import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";

/**
 * Rewards points expiry (funding design phase 7, migration 0705). On each
 * maintenance tick, what is left of every rewards lot past its expiry date
 * leaves the rewards balance as a `rewards_expired` ledger row the vendor sees
 * in their activity, one row per lot, posted with the balance change in one
 * transaction per wallet under the wallet account row lock.
 *
 * Idempotent: an expired lot holds nothing, so a replayed tick finds nothing
 * due, and each row's reference (the lot and how many times it has expired)
 * is unique. A wallet that fails is retried on the next tick, its lots still
 * due. Nothing here calls a provider, so a retry repeats only this
 * transaction; a data fault (classification `fatal`) fails again on every
 * tick and its error log is the alert until a person fixes the data.
 */

export const DEFAULT_REWARDS_EXPIRY_BATCH_LIMIT = 100;
const MAX_REWARDS_EXPIRY_BATCH_LIMIT = 1_000;

export const runDropshipRewardsExpiryInputSchema = z.object({
  workerId: z.string().trim().min(1).max(200),
  limit: z.number().int().positive().max(MAX_REWARDS_EXPIRY_BATCH_LIMIT).optional(),
}).strict();

export type RunDropshipRewardsExpiryInput = z.infer<typeof runDropshipRewardsExpiryInputSchema>;

/** A wallet holding points past their expiry date. */
export interface DropshipRewardsExpiryAccountRef {
  walletAccountId: number;
  vendorId: number;
}

/** One lot's points leaving the balance. */
export interface DropshipExpiredRewardsLot {
  lotId: number;
  cents: number;
  ledgerEntryId: number;
  expiresAt: Date;
}

export interface DropshipRewardsExpiryAccountOutcome extends DropshipRewardsExpiryAccountRef {
  expiredLots: DropshipExpiredRewardsLot[];
  rewardsBalanceBeforeCents: number;
  rewardsBalanceAfterCents: number;
}

export interface DropshipRewardsExpiryRepository {
  /** Wallets holding points past their date at `now`, the longest overdue first. */
  listWalletAccountsWithDueRewards(input: { now: Date; limit: number }): Promise<DropshipRewardsExpiryAccountRef[]>;
  /** Expires every lot of the wallet due at `now`, in one transaction under the wallet account lock. */
  expireDueRewardsForAccount(input: DropshipRewardsExpiryAccountRef & { now: Date }): Promise<DropshipRewardsExpiryAccountOutcome>;
}

export interface DropshipRewardsExpiryResult {
  scannedCount: number;
  expiredAccountCount: number;
  expiredLotCount: number;
  expiredCents: number;
  failedCount: number;
}

export class DropshipRewardsExpiryService {
  constructor(
    private readonly deps: {
      repository: DropshipRewardsExpiryRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async runExpiry(input: unknown): Promise<DropshipRewardsExpiryResult> {
    const parsed = parseRunInput(input);
    const now = this.deps.clock.now();
    const accounts = await this.deps.repository.listWalletAccountsWithDueRewards({
      now,
      limit: parsed.limit ?? DEFAULT_REWARDS_EXPIRY_BATCH_LIMIT,
    });
    const result: DropshipRewardsExpiryResult = {
      scannedCount: accounts.length,
      expiredAccountCount: 0,
      expiredLotCount: 0,
      expiredCents: 0,
      failedCount: 0,
    };

    for (const account of accounts) {
      try {
        const outcome = await this.deps.repository.expireDueRewardsForAccount({ ...account, now });
        if (outcome.expiredLots.length === 0) {
          // Another writer used or expired the points between the listing and the lock.
          continue;
        }
        const expiredCents = outcome.expiredLots.reduce((sum, lot) => sum + lot.cents, 0);
        result.expiredAccountCount += 1;
        result.expiredLotCount += outcome.expiredLots.length;
        result.expiredCents += expiredCents;
        this.deps.logger.info({
          code: "DROPSHIP_WALLET_REWARDS_EXPIRED",
          message: "Dropship wallet rewards points past their expiry date left the rewards balance.",
          context: {
            workerId: parsed.workerId,
            vendorId: outcome.vendorId,
            walletAccountId: outcome.walletAccountId,
            expiredCents,
            before: { rewardsBalanceCents: outcome.rewardsBalanceBeforeCents },
            after: { rewardsBalanceCents: outcome.rewardsBalanceAfterCents },
            lots: outcome.expiredLots.map((lot) => ({
              lotId: lot.lotId,
              cents: lot.cents,
              ledgerEntryId: lot.ledgerEntryId,
              expiresAt: lot.expiresAt.toISOString(),
            })),
          },
        });
      } catch (error) {
        result.failedCount += 1;
        this.deps.logger.error({
          code: "DROPSHIP_WALLET_REWARDS_EXPIRY_FAILED",
          message: "Dropship wallet rewards expiry could not expire a wallet's points; the next tick retries it.",
          context: {
            workerId: parsed.workerId,
            vendorId: account.vendorId,
            walletAccountId: account.walletAccountId,
            ...describeError(error),
          },
        });
      }
    }
    return result;
  }
}

export function makeDropshipRewardsExpiryLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipRewardsExpiryEvent("info", event),
    warn: (event) => logDropshipRewardsExpiryEvent("warn", event),
    error: (event) => logDropshipRewardsExpiryEvent("error", event),
  };
}

export const systemDropshipRewardsExpiryClock: DropshipClock = {
  now: () => new Date(),
};

function parseRunInput(input: unknown): RunDropshipRewardsExpiryInput {
  const parsed = runDropshipRewardsExpiryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DropshipError(
      "DROPSHIP_WALLET_REWARDS_EXPIRY_INVALID_INPUT",
      "Dropship wallet rewards expiry input failed validation.",
      {
        classification: "permanent",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      },
    );
  }
  return parsed.data;
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof DropshipError) {
    return {
      errorCode: error.code,
      errorMessage: error.message,
      classification: typeof error.context?.classification === "string" ? error.context.classification : null,
    };
  }
  return {
    errorCode: null,
    errorMessage: error instanceof Error ? error.message : String(error),
    classification: null,
  };
}

function logDropshipRewardsExpiryEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
