/**
 * An in-memory stand-in for the rewards lot tables (migration 0705), for the
 * DI-stubbed pg clients of the wallet and acceptance repository tests. It
 * answers exactly the statements `dropship-wallet-rewards-lots.ts` issues,
 * with the guards those statements carry, and returns undefined for anything
 * else so the test's own fake answers the rest. Amounts come back as strings,
 * as pg returns bigint columns.
 */

export interface FakeRewardsLot {
  id: number;
  wallet_account_id: number;
  vendor_id: number;
  source: string;
  origin_ledger_entry_id: number | null;
  earned_cents: number;
  remaining_cents: number;
  earned_at: Date;
  expires_at: Date | null;
  expiry_days: number | null;
}

export interface FakeRewardsLotMovement {
  id: number;
  lot_id: number;
  ledger_entry_id: number | null;
  reason: string;
  amount_cents: number;
  created_at: Date;
}

export interface FakeRewardsLots {
  lots: FakeRewardsLot[];
  movements: FakeRewardsLotMovement[];
  /** Tells the fake a ledger row's kind, for the expiry count's join. */
  recordLedgerEntry(id: number, type: string): void;
  /** The answer to a lots statement, or undefined when the statement is not one. */
  handle(sql: string, params?: unknown[]): { rows: unknown[] } | undefined;
  remainingFor(walletAccountId: number): number;
}

/** Rows already in the tables when a test starts; unnamed fields take the defaults below. */
export interface FakeRewardsLotsSeed {
  lots?: Array<Partial<FakeRewardsLot> & Pick<FakeRewardsLot, "id" | "remaining_cents">>;
  movements?: Array<Partial<FakeRewardsLotMovement> & Pick<FakeRewardsLotMovement, "lot_id" | "amount_cents">>;
  /** The kind of each ledger row the seeded movements point at, for the expiry count's join. */
  ledgerTypes?: Record<number, string>;
}

export function createFakeRewardsLots(seed: FakeRewardsLotsSeed = {}): FakeRewardsLots {
  const epoch = new Date("2026-01-01T00:00:00.000Z");
  const lots: FakeRewardsLot[] = (seed.lots ?? []).map((lot) => ({
    wallet_account_id: 5,
    vendor_id: 10,
    source: "earned",
    origin_ledger_entry_id: null,
    earned_cents: lot.remaining_cents,
    earned_at: epoch,
    expires_at: null,
    expiry_days: null,
    ...lot,
  }));
  const movements: FakeRewardsLotMovement[] = (seed.movements ?? []).map((movement, index) => ({
    id: index + 1,
    ledger_entry_id: null,
    reason: movement.ledger_entry_id === undefined || movement.ledger_entry_id === null ? "reconciliation" : "ledger",
    created_at: epoch,
    ...movement,
  }));
  const ledgerTypes = new Map<number, string>(Object.entries(seed.ledgerTypes ?? {}).map(([id, type]) => [Number(id), type]));
  let nextLotId = Math.max(100, ...lots.map((lot) => lot.id + 1));
  let nextMovementId = movements.length + 1;

  const toRow = (lot: FakeRewardsLot) => ({
    id: lot.id,
    source: lot.source,
    origin_ledger_entry_id: lot.origin_ledger_entry_id,
    earned_cents: String(lot.earned_cents),
    remaining_cents: String(lot.remaining_cents),
    earned_at: lot.earned_at,
    expires_at: lot.expires_at,
    expiry_days: lot.expiry_days,
  });

  function handle(sql: string, params: unknown[] = []): { rows: unknown[] } | undefined {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT id, source, origin_ledger_entry_id") && text.includes("FROM dropship.dropship_wallet_rewards_lots")) {
      const walletAccountId = Number(params[0]);
      return {
        rows: lots
          .filter((lot) => lot.wallet_account_id === walletAccountId && lot.remaining_cents > 0)
          .sort((left, right) => left.id - right.id)
          .map(toRow),
      };
    }
    if (text.startsWith("SELECT EXISTS") && text.includes("dropship.dropship_wallet_rewards_lots")) {
      return { rows: [{ present: lots.some((lot) => lot.wallet_account_id === Number(params[0])) }] };
    }
    if (text.startsWith("INSERT INTO dropship.dropship_wallet_rewards_lots ")) {
      const lot: FakeRewardsLot = {
        id: nextLotId++,
        wallet_account_id: Number(params[0]),
        vendor_id: Number(params[1]),
        source: String(params[2]),
        origin_ledger_entry_id: params[3] === null ? null : Number(params[3]),
        earned_cents: Number(params[4]),
        remaining_cents: Number(params[4]),
        earned_at: params[5] as Date,
        expires_at: (params[6] as Date | null) ?? null,
        expiry_days: params[7] === null ? null : Number(params[7]),
      };
      lots.push(lot);
      return { rows: [toRow(lot)] };
    }
    if (text.startsWith("UPDATE dropship.dropship_wallet_rewards_lots SET remaining_cents = remaining_cents - $3")) {
      const [lotId, walletAccountId, cents, , expectedRemaining] = params.map(Number);
      const lot = lots.find((candidate) =>
        candidate.id === lotId && candidate.wallet_account_id === walletAccountId && candidate.remaining_cents === expectedRemaining);
      if (!lot) return { rows: [] };
      lot.remaining_cents -= cents;
      return { rows: [{ id: lot.id }] };
    }
    if (text.startsWith("UPDATE dropship.dropship_wallet_rewards_lots SET remaining_cents = remaining_cents + $3")) {
      const [lotId, walletAccountId, cents] = params.map(Number);
      const lot = lots.find((candidate) =>
        candidate.id === lotId && candidate.wallet_account_id === walletAccountId && candidate.remaining_cents + cents <= candidate.earned_cents);
      if (!lot) return { rows: [] };
      lot.remaining_cents += cents;
      return { rows: [{ id: lot.id }] };
    }
    if (text.startsWith("INSERT INTO dropship.dropship_wallet_rewards_lot_movements")) {
      movements.push({
        id: nextMovementId++,
        lot_id: Number(params[0]),
        ledger_entry_id: params[1] === null ? null : Number(params[1]),
        reason: String(params[2]),
        amount_cents: Number(params[3]),
        created_at: params[4] as Date,
      });
      return { rows: [] };
    }
    if (text.startsWith("SELECT m.lot_id, m.amount_cents")) {
      const [ledgerEntryId, walletAccountId] = params.map(Number);
      return {
        rows: movements
          .filter((movement) => movement.ledger_entry_id === ledgerEntryId
            && lots.find((lot) => lot.id === movement.lot_id)?.wallet_account_id === walletAccountId)
          .sort((left, right) => left.lot_id - right.lot_id)
          .map((movement) => ({ lot_id: movement.lot_id, amount_cents: String(movement.amount_cents) })),
      };
    }
    if (text.startsWith("SELECT count(*) AS expiries")) {
      const lotId = Number(params[0]);
      const expiries = movements.filter((movement) =>
        movement.lot_id === lotId && movement.ledger_entry_id !== null && ledgerTypes.get(movement.ledger_entry_id) === "rewards_expired");
      return { rows: [{ expiries: String(expiries.length) }] };
    }
    if (text.startsWith("SELECT expires_at, SUM(remaining_cents) AS cents")) {
      const walletAccountId = Number(params[0]);
      const expiring = lots.filter((lot) => lot.wallet_account_id === walletAccountId && lot.remaining_cents > 0 && lot.expires_at !== null);
      if (expiring.length === 0) return { rows: [] };
      const soonest = Math.min(...expiring.map((lot) => (lot.expires_at as Date).getTime()));
      const cents = expiring
        .filter((lot) => (lot.expires_at as Date).getTime() === soonest)
        .reduce((sum, lot) => sum + lot.remaining_cents, 0);
      return { rows: [{ expires_at: new Date(soonest), cents: String(cents) }] };
    }
    return undefined;
  }

  return {
    lots,
    movements,
    recordLedgerEntry: (id, type) => { ledgerTypes.set(id, type); },
    handle,
    remainingFor: (walletAccountId) => lots
      .filter((lot) => lot.wallet_account_id === walletAccountId)
      .reduce((sum, lot) => sum + lot.remaining_cents, 0),
  };
}
