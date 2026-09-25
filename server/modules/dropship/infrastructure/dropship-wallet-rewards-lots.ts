/**
 * Rewards lots (funding design phase 7, migration 0705): which of a wallet's
 * rewards points expire when.
 *
 * The rewards balance on the wallet account is the money authority. The lots
 * index it by where the points came from and when they expire, and their
 * remaining points add up to the balance. Every writer that moves the rewards
 * balance moves the lots in the same transaction, after locking the wallet
 * account row: that lock is the one mutex for the balance and its lots, so
 * nothing here takes a lock of its own. Each lot update still names the
 * amount it expects to find, so a change made outside that lock fails the
 * transaction instead of being overwritten.
 *
 * Reconcile on touch: before each move the lots are checked against the
 * balance the caller locked. An account's first touch opens its first lot for
 * the points it already holds, never expiring (nothing expired when they were
 * earned). A later difference means something moved the balance without its
 * lots — the previous release while this one deploys, or a defect — and is
 * corrected here with a warning audit row a person reviews: lots short of the
 * balance gain a never-expiring lot (the vendor keeps every point), lots over
 * the balance give up the difference in use order. A difference never
 * refuses a money movement; a lot changed outside the lock, or a stored lot
 * that is malformed, fails the transaction instead (classification `fatal`).
 *
 * Runs on the caller's client only; never opens, commits or rolls back.
 */

import type { PoolClient } from "pg";
import {
  dropshipWalletRewardsLotSourceEnum,
  type DropshipWalletRewardsLotSource,
} from "../../../../shared/schema/dropship.schema";
import type { DropshipRewardsNextExpiryRecord } from "../application/dropship-wallet-service";
import { DropshipError } from "../domain/errors";
import {
  allocateRewardsFromLots,
  rewardsLotExpiresAt,
  type DropshipRewardsLotBalance,
  type DropshipRewardsLotTake,
} from "../domain/wallet-rewards-expiry";

/** A lot as stored. */
export interface DropshipRewardsLotRecord extends DropshipRewardsLotBalance {
  source: DropshipWalletRewardsLotSource;
  /** The ledger row that created the lot: the `rewards_earned` row, or the `rewards_reinstated` row of a restored lot. */
  originLedgerEntryId: number | null;
  earnedCents: number;
  expiryDays: number | null;
}

/** The wallet account a lot change belongs to, with the rewards balance the caller read under its row lock. */
export interface DropshipRewardsLotAccount {
  walletAccountId: number;
  vendorId: number;
  rewardsBalanceCents: number;
}

/** The rewards writer touching the lots, recorded on reconciliation audit rows. */
export type DropshipRewardsLotTouchCause =
  | "rewards_earned"
  | "rewards_spent"
  | "rewards_reversed"
  | "rewards_reinstated"
  | "rewards_expired";

export const DROPSHIP_WALLET_REWARDS_LOTS_INVALID = "DROPSHIP_WALLET_REWARDS_LOTS_INVALID";

const LOT_COLUMNS = `id, source, origin_ledger_entry_id, earned_cents, remaining_cents,
  earned_at, expires_at, expiry_days`;

interface LotRow {
  id: number;
  source: string;
  origin_ledger_entry_id: number | null;
  earned_cents: string | number;
  remaining_cents: string | number;
  earned_at: Date;
  expires_at: Date | null;
  expiry_days: number | null;
}

/**
 * Brings the account's lots level with the balance the caller locked, before
 * the caller moves it, and returns the lots that still hold points. Call it
 * with the balance as it was before this transaction's own move.
 */
export async function reconcileRewardsLotsWithClient(
  client: PoolClient,
  input: { account: DropshipRewardsLotAccount; cause: DropshipRewardsLotTouchCause; now: Date },
): Promise<DropshipRewardsLotRecord[]> {
  const { account } = input;
  assertCents(account.rewardsBalanceCents, "rewardsBalanceCents", account);
  const open = await loadOpenRewardsLotsWithClient(client, account.walletAccountId);
  const lotsCents = sumRemaining(open);
  if (lotsCents === account.rewardsBalanceCents) {
    return open;
  }

  if (lotsCents < account.rewardsBalanceCents) {
    const addedCents = account.rewardsBalanceCents - lotsCents;
    const opening = open.length === 0 && !(await accountHasRewardsLotWithClient(client, account.walletAccountId));
    const lot = await insertRewardsLotWithClient(client, {
      account,
      source: opening ? "opening_balance" : "reconciled",
      originLedgerEntryId: null,
      cents: addedCents,
      earnedAt: input.now,
      expiryDays: null,
      now: input.now,
    });
    await recordRewardsLotsAuditWithClient(client, {
      account,
      eventType: opening ? "wallet_rewards_lots_opened" : "wallet_rewards_lots_reconciled",
      // Opening is the expected first touch; anything later is an anomaly
      // corrected here that a person should explain.
      severity: opening ? "info" : "warning",
      payload: {
        cause: input.cause,
        lotId: lot.lotId,
        source: lot.source,
        rewardsBalanceCents: account.rewardsBalanceCents,
        lotsCentsBefore: lotsCents,
        addedCents,
      },
      createdAt: input.now,
    });
    return [...open, lot];
  }

  const removedCents = lotsCents - account.rewardsBalanceCents;
  const takes = allocateRewardsFromLots({ lots: open, amountCents: removedCents });
  await applyRewardsLotTakesWithClient(client, {
    walletAccountId: account.walletAccountId,
    lots: open,
    takes,
    ledgerEntryId: null,
    now: input.now,
  });
  await recordRewardsLotsAuditWithClient(client, {
    account,
    eventType: "wallet_rewards_lots_reconciled",
    severity: "warning",
    payload: {
      cause: input.cause,
      rewardsBalanceCents: account.rewardsBalanceCents,
      lotsCentsBefore: lotsCents,
      removedCents,
      takes,
    },
    createdAt: input.now,
  });
  return withTakesApplied(open, takes);
}

/**
 * The lot for points just earned, dated from the policy in force at the
 * earning: it expires `expiryDays` after `earnedAt`, or never.
 */
export async function addEarnedRewardsLotWithClient(
  client: PoolClient,
  input: {
    account: Pick<DropshipRewardsLotAccount, "walletAccountId" | "vendorId">;
    ledgerEntryId: number;
    cents: number;
    earnedAt: Date;
    expiryDays: number | null;
    now: Date;
  },
): Promise<DropshipRewardsLotRecord> {
  return insertRewardsLotWithClient(client, {
    account: input.account,
    source: "earned",
    originLedgerEntryId: input.ledgerEntryId,
    cents: input.cents,
    earnedAt: input.earnedAt,
    expiryDays: input.expiryDays,
    now: input.now,
  });
}

/**
 * Takes `amountCents` points out of the lots for the ledger row that moved
 * them out of the balance, in use order (a preferred lot first, for a
 * clawback of the credit that earned it), one movement per lot.
 */
export async function takeRewardsFromLotsWithClient(
  client: PoolClient,
  input: {
    walletAccountId: number;
    lots: readonly DropshipRewardsLotRecord[];
    amountCents: number;
    ledgerEntryId: number;
    preferredLotId?: number | null;
    now: Date;
  },
): Promise<DropshipRewardsLotTake[]> {
  const takes = allocateRewardsFromLots({
    lots: input.lots,
    amountCents: input.amountCents,
    preferredLotId: input.preferredLotId ?? null,
  });
  await applyRewardsLotTakesWithClient(client, {
    walletAccountId: input.walletAccountId,
    lots: input.lots,
    takes,
    ledgerEntryId: input.ledgerEntryId,
    now: input.now,
  });
  return takes;
}

/**
 * Puts points a clawback took back where they came from, for a won dispute:
 * each lot the `takenByLedgerEntryId` row drew on gets its points back,
 * keeping its own expiry date (a lot whose date has passed meanwhile expires
 * at the next wallet run). Points the clawback took before lots existed have
 * no movements to follow and come back as one never-expiring lot, created
 * with the ledger row that returns them.
 */
export async function restoreRewardsToLotsWithClient(
  client: PoolClient,
  input: {
    account: Pick<DropshipRewardsLotAccount, "walletAccountId" | "vendorId">;
    takenByLedgerEntryId: number;
    ledgerEntryId: number;
    amountCents: number;
    now: Date;
  },
): Promise<{ restores: DropshipRewardsLotTake[]; restoredLot: DropshipRewardsLotRecord | null }> {
  assertCents(input.amountCents, "amountCents", input.account);
  const taken = await client.query<{ lot_id: number; amount_cents: string | number }>(
    `SELECT m.lot_id, m.amount_cents
     FROM dropship.dropship_wallet_rewards_lot_movements m
     JOIN dropship.dropship_wallet_rewards_lots l ON l.id = m.lot_id
     WHERE m.ledger_entry_id = $1
       AND l.wallet_account_id = $2
     ORDER BY m.lot_id ASC`,
    [input.takenByLedgerEntryId, input.account.walletAccountId],
  );
  const restores = taken.rows.map((row) => {
    const movedCents = toSafeInteger(row.amount_cents, "amount_cents");
    if (movedCents >= 0) {
      throw lotsInvalid("A clawback's lot movement put points in instead of taking them out.", {
        walletAccountId: input.account.walletAccountId,
        takenByLedgerEntryId: input.takenByLedgerEntryId,
        lotId: row.lot_id,
        amountCents: movedCents,
      });
    }
    return { lotId: row.lot_id, cents: -movedCents };
  });
  const restoredCents = restores.reduce((sum, restore) => sum + restore.cents, 0);
  if (restoredCents > input.amountCents) {
    throw lotsInvalid("A clawback's lot movements hold more points than the amount being returned.", {
      walletAccountId: input.account.walletAccountId,
      takenByLedgerEntryId: input.takenByLedgerEntryId,
      amountCents: input.amountCents,
      movementCents: restoredCents,
    });
  }
  for (const restore of restores) {
    const updated = await client.query<{ id: number }>(
      `UPDATE dropship.dropship_wallet_rewards_lots
       SET remaining_cents = remaining_cents + $3,
           updated_at = $4
       WHERE id = $1
         AND wallet_account_id = $2
         AND remaining_cents + $3 <= earned_cents
       RETURNING id`,
      [restore.lotId, input.account.walletAccountId, restore.cents, input.now],
    );
    if (!updated.rows[0]) {
      throw lotsInvalid("A lot cannot take back the points a clawback took from it.", {
        walletAccountId: input.account.walletAccountId,
        lotId: restore.lotId,
        cents: restore.cents,
      });
    }
    await insertLotMovementWithClient(client, {
      lotId: restore.lotId,
      ledgerEntryId: input.ledgerEntryId,
      amountCents: restore.cents,
      now: input.now,
    });
  }
  const unmatchedCents = input.amountCents - restoredCents;
  const restoredLot = unmatchedCents > 0
    ? await insertRewardsLotWithClient(client, {
        account: input.account,
        source: "restored",
        originLedgerEntryId: input.ledgerEntryId,
        cents: unmatchedCents,
        earnedAt: input.now,
        expiryDays: null,
        now: input.now,
      })
    : null;
  return { restores, restoredLot };
}

/**
 * The soonest instant points leave the balance unless used, and how many
 * leave then. Read-only: a lot not yet reconciled only lacks never-expiring
 * points, so the answer holds without touching the lots.
 */
export async function loadRewardsNextExpiryWithClient(
  client: PoolClient,
  walletAccountId: number,
): Promise<DropshipRewardsNextExpiryRecord | null> {
  const result = await client.query<{ expires_at: Date; cents: string | number }>(
    `SELECT expires_at, SUM(remaining_cents) AS cents
     FROM dropship.dropship_wallet_rewards_lots
     WHERE wallet_account_id = $1
       AND remaining_cents > 0
       AND expires_at IS NOT NULL
     GROUP BY expires_at
     ORDER BY expires_at ASC
     LIMIT 1`,
    [walletAccountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    expiresAt: requireDate(row.expires_at, "expires_at", walletAccountId),
    cents: toSafeInteger(row.cents, "cents"),
  };
}

/** How many times a lot has expired before: a lot restored after it expired can expire again. */
export async function countRewardsLotExpiriesWithClient(client: PoolClient, lotId: number): Promise<number> {
  const result = await client.query<{ expiries: string | number }>(
    `SELECT count(*) AS expiries
     FROM dropship.dropship_wallet_rewards_lot_movements m
     JOIN dropship.dropship_wallet_ledger l ON l.id = m.ledger_entry_id
     WHERE m.lot_id = $1
       AND l.type = 'rewards_expired'`,
    [lotId],
  );
  return toSafeInteger(result.rows[0]?.expiries ?? 0, "expiries");
}

async function loadOpenRewardsLotsWithClient(client: PoolClient, walletAccountId: number): Promise<DropshipRewardsLotRecord[]> {
  const result = await client.query<LotRow>(
    `SELECT ${LOT_COLUMNS}
     FROM dropship.dropship_wallet_rewards_lots
     WHERE wallet_account_id = $1
       AND remaining_cents > 0
     ORDER BY id ASC`,
    [walletAccountId],
  );
  return result.rows.map((row) => mapLotRow(row, walletAccountId));
}

async function accountHasRewardsLotWithClient(client: PoolClient, walletAccountId: number): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM dropship.dropship_wallet_rewards_lots WHERE wallet_account_id = $1
     ) AS present`,
    [walletAccountId],
  );
  return result.rows[0]?.present === true;
}

async function insertRewardsLotWithClient(
  client: PoolClient,
  input: {
    account: Pick<DropshipRewardsLotAccount, "walletAccountId" | "vendorId">;
    source: DropshipWalletRewardsLotSource;
    originLedgerEntryId: number | null;
    cents: number;
    earnedAt: Date;
    expiryDays: number | null;
    now: Date;
  },
): Promise<DropshipRewardsLotRecord> {
  assertCents(input.cents, "cents", input.account);
  if (input.cents === 0) {
    throw lotsInvalid("A rewards lot must hold at least one point.", { walletAccountId: input.account.walletAccountId });
  }
  const expiresAt = rewardsLotExpiresAt({ earnedAt: input.earnedAt, expiryDays: input.expiryDays });
  const result = await client.query<LotRow>(
    `INSERT INTO dropship.dropship_wallet_rewards_lots
      (wallet_account_id, vendor_id, source, origin_ledger_entry_id, earned_cents, remaining_cents,
       earned_at, expires_at, expiry_days, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9, $9)
     RETURNING ${LOT_COLUMNS}`,
    [
      input.account.walletAccountId,
      input.account.vendorId,
      input.source,
      input.originLedgerEntryId,
      input.cents,
      input.earnedAt,
      expiresAt,
      input.expiryDays,
      input.now,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw lotsInvalid("Dropship wallet rewards lot insert did not return a row.", { walletAccountId: input.account.walletAccountId });
  }
  return mapLotRow(row, input.account.walletAccountId);
}

/** Moves each take out of its lot, naming the amount the lot is expected to hold so a stale read fails. */
async function applyRewardsLotTakesWithClient(
  client: PoolClient,
  input: {
    walletAccountId: number;
    lots: readonly DropshipRewardsLotRecord[];
    takes: readonly DropshipRewardsLotTake[];
    ledgerEntryId: number | null;
    now: Date;
  },
): Promise<void> {
  for (const take of input.takes) {
    const lot = input.lots.find((candidate) => candidate.lotId === take.lotId);
    if (!lot) {
      throw lotsInvalid("A take names a lot the account does not hold.", { walletAccountId: input.walletAccountId, lotId: take.lotId });
    }
    const updated = await client.query<{ id: number }>(
      `UPDATE dropship.dropship_wallet_rewards_lots
       SET remaining_cents = remaining_cents - $3,
           updated_at = $4
       WHERE id = $1
         AND wallet_account_id = $2
         AND remaining_cents = $5
       RETURNING id`,
      [take.lotId, input.walletAccountId, take.cents, input.now, lot.remainingCents],
    );
    if (!updated.rows[0]) {
      throw lotsInvalid("A rewards lot changed outside the wallet account lock.", {
        walletAccountId: input.walletAccountId,
        lotId: take.lotId,
        expectedRemainingCents: lot.remainingCents,
      });
    }
    await insertLotMovementWithClient(client, {
      lotId: take.lotId,
      ledgerEntryId: input.ledgerEntryId,
      amountCents: -take.cents,
      now: input.now,
    });
  }
}

async function insertLotMovementWithClient(
  client: PoolClient,
  input: { lotId: number; ledgerEntryId: number | null; amountCents: number; now: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_wallet_rewards_lot_movements
      (lot_id, ledger_entry_id, reason, amount_cents, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.lotId, input.ledgerEntryId, input.ledgerEntryId === null ? "reconciliation" : "ledger", input.amountCents, input.now],
  );
}

/**
 * The lots' own audit rows, beside the ledger rows' audit. Written here
 * rather than through the wallet repository's helper because reconciliation
 * carries its own severity.
 */
async function recordRewardsLotsAuditWithClient(
  client: PoolClient,
  input: {
    account: Pick<DropshipRewardsLotAccount, "walletAccountId" | "vendorId">;
    eventType: string;
    severity: "info" | "warning";
    payload: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  // Same parameter layout as the wallet repository's audit helper, severity last.
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (vendor_id, entity_type, entity_id, event_type,
       actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, $3, $4,
             'system', NULL, $7, $5::jsonb, $6)`,
    [
      input.account.vendorId,
      "dropship_wallet_account",
      String(input.account.walletAccountId),
      input.eventType,
      JSON.stringify({ walletAccountId: input.account.walletAccountId, ...input.payload }),
      input.createdAt,
      input.severity,
    ],
  );
}

function withTakesApplied(
  lots: readonly DropshipRewardsLotRecord[],
  takes: readonly DropshipRewardsLotTake[],
): DropshipRewardsLotRecord[] {
  return lots
    .map((lot) => {
      const takenCents = takes
        .filter((take) => take.lotId === lot.lotId)
        .reduce((sum, take) => sum + take.cents, 0);
      return takenCents === 0 ? lot : { ...lot, remainingCents: lot.remainingCents - takenCents };
    })
    .filter((lot) => lot.remainingCents > 0);
}

function sumRemaining(lots: readonly DropshipRewardsLotRecord[]): number {
  return lots.reduce((sum, lot) => sum + lot.remainingCents, 0);
}

function mapLotRow(row: LotRow, walletAccountId: number): DropshipRewardsLotRecord {
  const source = row.source as DropshipWalletRewardsLotSource;
  if (!dropshipWalletRewardsLotSourceEnum.includes(source)) {
    throw lotsInvalid("Dropship wallet rewards lot has an unknown source.", { walletAccountId, lotId: row.id, source: row.source });
  }
  const earnedCents = toSafeInteger(row.earned_cents, "earned_cents");
  const remainingCents = toSafeInteger(row.remaining_cents, "remaining_cents");
  if (earnedCents <= 0 || remainingCents < 0 || remainingCents > earnedCents) {
    throw lotsInvalid("Dropship wallet rewards lot amounts are out of range.", { walletAccountId, lotId: row.id, earnedCents, remainingCents });
  }
  return {
    lotId: row.id,
    source,
    originLedgerEntryId: row.origin_ledger_entry_id,
    earnedCents,
    remainingCents,
    earnedAt: requireDate(row.earned_at, "earned_at", walletAccountId),
    expiresAt: row.expires_at === null ? null : requireDate(row.expires_at, "expires_at", walletAccountId),
    expiryDays: row.expiry_days,
  };
}

function requireDate(value: unknown, field: string, walletAccountId: number): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw lotsInvalid("Dropship wallet rewards lot date is not a valid instant.", { walletAccountId, field, value: String(value) });
  }
  return date;
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw lotsInvalid("Dropship wallet rewards lot integer is outside the safe runtime range.", { field, value: String(value) });
  }
  return parsed;
}

function assertCents(value: number, field: string, account: Pick<DropshipRewardsLotAccount, "walletAccountId">): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw lotsInvalid(`${field} must be a non-negative whole number of cents.`, { walletAccountId: account.walletAccountId, field, value });
  }
}

function lotsInvalid(message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(DROPSHIP_WALLET_REWARDS_LOTS_INVALID, message, { ...context, classification: "fatal" });
}
