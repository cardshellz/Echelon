import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipWalletRepository } from "../../infrastructure/dropship-wallet.repository";
import type { ObserveDropshipUsdcDepositRepositoryInput } from "../../application/dropship-wallet-service";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const occurredAt = new Date("2026-09-21T10:00:00.000Z");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const VENDOR_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const SENDER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TX = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"ef".repeat(32)}`;

function makePool(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Pool {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query, connect: async () => client } as unknown as Pool;
}

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return { id: 5, vendor_id: 10, available_balance_cents: "1000", pending_balance_cents: "4000", currency: "USD", status: "active", created_at: occurredAt, updated_at: occurredAt, ...overrides };
}

function makeLedgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, wallet_account_id: 5, vendor_id: 10, type: "funding", status: "pending", amount_cents: "2512", currency: "USD",
    available_balance_after_cents: "1000", pending_balance_after_cents: "6512",
    reference_type: "usdc_base_transaction", reference_id: `8453:${TX}:7`, idempotency_key: `usdc-deposit:8453:${TX}:7`,
    funding_method_id: null, external_transaction_id: TX, metadata: { rail: "usdc_base" }, created_at: occurredAt, settled_at: null,
    ...overrides,
  };
}

function makeUsdcRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 9, vendor_id: 10, wallet_ledger_id: 1, chain_id: 8453, transaction_hash: TX, from_address: SENDER, to_address: VENDOR_ADDRESS,
    amount_atomic_units: "25123456", confirmations: 41, status: "pending", observed_at: occurredAt, settled_at: null,
    log_index: 7, block_number: "35000000", block_hash: BLOCK_HASH, token_address: USDC, deposit_address_id: 3, dust_atomic_units: "3456", voided_at: null,
    ...overrides,
  };
}

function observation(overrides: Partial<ObserveDropshipUsdcDepositRepositoryInput> = {}): ObserveDropshipUsdcDepositRepositoryInput {
  return {
    vendorId: 10,
    depositAddressId: 3,
    transfer: { chainId: 8453, tokenAddress: USDC, transactionHash: TX, logIndex: 7, blockNumber: 35_000_000, blockHash: BLOCK_HASH, fromAddress: SENDER, toAddress: VENDOR_ADDRESS, amountAtomicUnits: "25123456" },
    amountCents: 2512,
    dustAtomicUnits: "3456",
    confirmations: 41,
    status: "pending",
    currency: "USD",
    requestHash: "hash-1",
    occurredAt,
    ...overrides,
  };
}

/** A fake node of a database: answers each statement from the row fixtures and records what was sent. */
function fakeDatabase(options: { usdcRow?: Record<string, unknown> | null; ledgerRow?: Record<string, unknown>; accountRow?: Record<string, unknown>; usdcInsertError?: Error } = {}) {
  const statements: string[] = [];
  const params: Record<string, unknown[]> = {};
  const query = vi.fn(async (sql: string, args?: unknown[]) => {
    statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
    if (sql.includes("INSERT INTO dropship.dropship_wallet_accounts")) return { rows: [] };
    if (sql.includes("FROM dropship.dropship_wallet_accounts")) return { rows: [makeAccountRow(options.accountRow)] };
    if (sql.includes("UPDATE dropship.dropship_wallet_accounts")) {
      params.balances = args ?? [];
      return { rows: [makeAccountRow({ available_balance_cents: String(args?.[2]), pending_balance_cents: String(args?.[3]) })] };
    }
    if (sql.includes("INSERT INTO dropship.dropship_wallet_ledger")) {
      params.ledgerInsert = args ?? [];
      return { rows: [makeLedgerRow({ status: args?.[3], amount_cents: String(args?.[4]), available_balance_after_cents: String(args?.[6]), pending_balance_after_cents: String(args?.[7]), settled_at: args?.[15] ?? null })] };
    }
    if (sql.includes("UPDATE dropship.dropship_wallet_ledger")) {
      params.ledgerUpdate = args ?? [];
      return { rows: [makeLedgerRow({ status: sql.includes("status = 'failed'") ? "failed" : "settled", ...(options.ledgerRow ?? {}), settled_at: sql.includes("status = 'failed'") ? null : occurredAt })] };
    }
    if (sql.includes("FROM dropship.dropship_wallet_ledger")) return { rows: [makeLedgerRow(options.ledgerRow)] };
    if (sql.includes("INSERT INTO dropship.dropship_usdc_ledger_entries")) {
      params.usdcInsert = args ?? [];
      if (options.usdcInsertError) throw options.usdcInsertError;
      return { rows: [makeUsdcRow({ wallet_ledger_id: args?.[1], status: args?.[8], settled_at: args?.[10], log_index: args?.[11], dust_atomic_units: args?.[16] })] };
    }
    if (sql.includes("UPDATE dropship.dropship_usdc_ledger_entries")) {
      params.usdcUpdate = args ?? [];
      return { rows: [makeUsdcRow({ status: args?.[2], confirmations: args?.[3], block_number: String(args?.[4]), block_hash: args?.[5], settled_at: args?.[6], voided_at: args?.[7] })] };
    }
    if (sql.includes("FROM dropship.dropship_usdc_ledger_entries")) {
      params.usdcSelect = args ?? [];
      return { rows: options.usdcRow === undefined ? [] : options.usdcRow === null ? [] : [options.usdcRow] };
    }
    if (sql.includes("INSERT INTO dropship.dropship_audit_events")) {
      (params.audits ??= []).push(args?.[3]);
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { query, statements, params, repository: new PgDropshipWalletRepository(makePool(query)) };
}

describe("PgDropshipWalletRepository watched USDC deposits (funding design phase 6)", () => {
  it("records a pending deposit: the pending balance, the funding ledger row keyed by the log, the chain observation and both audit rows in one transaction", async () => {
    const db = fakeDatabase();

    const result = await db.repository.observeUsdcDeposit(observation());

    expect(result.idempotentReplay).toBe(false);
    expect(result.account).toMatchObject({ availableBalanceCents: 1000, pendingBalanceCents: 6512 });
    expect(result.ledgerEntry).toMatchObject({ status: "pending", amountCents: 2512 });
    expect(result.usdcLedgerEntry).toMatchObject({ status: "pending", logIndex: 7, dustAtomicUnits: "3456", walletLedgerId: 1 });
    // The observation lookup is keyed by (chain, transaction, log).
    expect(db.params.usdcSelect).toEqual([8453, TX, 7]);
    expect(db.params.balances).toEqual([5, 10, 1000, 6512, occurredAt]);
    expect(db.params.ledgerInsert?.slice(2, 13)).toEqual(["funding", "pending", 2512, "USD", 1000, 6512, "usdc_base_transaction", `8453:${TX}:7`, `usdc-deposit:8453:${TX}:7`, null, TX]);
    expect(JSON.parse(String(db.params.ledgerInsert?.[13]))).toMatchObject({ rail: "usdc_base", source: "chain_watcher", logIndex: 7, blockNumber: 35_000_000, dustAtomicUnits: "3456", depositAddressId: 3, requestHash: "hash-1" });
    expect(db.params.ledgerInsert?.[15]).toBeNull();
    expect(db.params.usdcInsert).toEqual([10, 1, 8453, TX, SENDER, VENDOR_ADDRESS, "25123456", 41, "pending", occurredAt, null, 7, 35_000_000, BLOCK_HASH, USDC, 3, "3456"]);
    expect(db.params.audits).toEqual(["wallet_funding_pending", "wallet_usdc_deposit_observed"]);
    expect(db.statements[0]).toBe("BEGIN");
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("records a settled deposit straight into the available balance", async () => {
    const db = fakeDatabase();
    const result = await db.repository.observeUsdcDeposit(observation({ status: "settled" }));
    expect(result.account).toMatchObject({ availableBalanceCents: 3512, pendingBalanceCents: 4000 });
    expect(db.params.ledgerInsert?.[15]).toEqual(occurredAt);
    expect(db.params.usdcInsert?.[8]).toBe("settled");
    expect(db.params.usdcInsert?.[10]).toEqual(occurredAt);
    expect(db.params.audits).toEqual(["wallet_funding_settled", "wallet_usdc_deposit_observed"]);
  });

  it("records dust without moving money or writing a ledger row", async () => {
    const db = fakeDatabase();
    const result = await db.repository.observeUsdcDeposit(observation({ status: "dust", amountCents: 0, dustAtomicUnits: "9999", transfer: { ...observation().transfer, amountAtomicUnits: "9999" } }));
    expect(result.ledgerEntry).toBeNull();
    expect(result.usdcLedgerEntry).toMatchObject({ status: "dust", walletLedgerId: null });
    expect(db.params.balances).toBeUndefined();
    expect(db.params.ledgerInsert).toBeUndefined();
    expect(db.params.usdcInsert?.slice(0, 2)).toEqual([10, null]);
    expect(db.params.audits).toEqual(["wallet_usdc_deposit_dust"]);
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("replays a transfer it already recorded, moving nothing, and refuses one recorded with other details", async () => {
    const db = fakeDatabase({ usdcRow: makeUsdcRow() });
    const replay = await db.repository.observeUsdcDeposit(observation());
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.usdcLedgerEntry.usdcLedgerEntryId).toBe(9);
    expect(replay.ledgerEntry?.ledgerEntryId).toBe(1);
    expect(db.params.balances).toBeUndefined();
    expect(db.statements.at(-1)).toBe("COMMIT");

    const other = fakeDatabase({ usdcRow: makeUsdcRow({ vendor_id: 11 }) });
    await expect(other.repository.observeUsdcDeposit(observation())).rejects.toMatchObject({ code: "DROPSHIP_USDC_TRANSACTION_CONFLICT" });
    expect(other.statements.at(-1)).toBe("ROLLBACK");
  });

  it("resolves a race on the unique log index by reading what the winner wrote, without a second transaction", async () => {
    let inserts = 0;
    const db = fakeDatabase();
    const winner = makeUsdcRow();
    db.query.mockImplementation(async (sql: string, args?: unknown[]) => {
      db.statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("INSERT INTO dropship.dropship_wallet_accounts")) return { rows: [] };
      if (sql.includes("FROM dropship.dropship_wallet_accounts")) return { rows: [makeAccountRow()] };
      if (sql.includes("UPDATE dropship.dropship_wallet_accounts")) return { rows: [makeAccountRow({ pending_balance_cents: "6512" })] };
      if (sql.includes("INSERT INTO dropship.dropship_wallet_ledger")) return { rows: [makeLedgerRow()] };
      if (sql.includes("FROM dropship.dropship_wallet_ledger")) return { rows: [makeLedgerRow()] };
      if (sql.includes("INSERT INTO dropship.dropship_usdc_ledger_entries")) {
        inserts += 1;
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      if (sql.includes("FROM dropship.dropship_usdc_ledger_entries")) {
        // Not there inside the transaction (the winner had not committed), there afterwards.
        return { rows: inserts === 0 ? [] : [winner] };
      }
      return { rows: [] };
    });

    const result = await db.repository.observeUsdcDeposit(observation());

    expect(result.idempotentReplay).toBe(true);
    expect(result.usdcLedgerEntry.usdcLedgerEntryId).toBe(9);
    const rollbackAt = db.statements.indexOf("ROLLBACK");
    expect(rollbackAt).toBeGreaterThan(0);
    expect(db.statements.slice(rollbackAt + 1)).not.toContain("BEGIN");
    expect(db.statements.filter((statement) => statement === "COMMIT")).toHaveLength(0);
  });

  it("settles a pending deposit: pending to available, the ledger row settled, the observation settled, two audit rows", async () => {
    const db = fakeDatabase({ usdcRow: makeUsdcRow(), ledgerRow: makeLedgerRow({ amount_cents: "2512" }) });

    const result = await db.repository.settleUsdcDeposit({ vendorId: 10, usdcLedgerEntryId: 9, confirmations: 61, current: { blockNumber: 35_000_000, blockHash: BLOCK_HASH }, occurredAt });

    expect(result.idempotentReplay).toBe(false);
    expect(db.params.usdcSelect).toEqual([9, 10]);
    expect(db.params.balances).toEqual([5, 10, 3512, 1488, occurredAt]);
    expect(db.params.usdcUpdate).toEqual([9, 10, "settled", 61, 35_000_000, BLOCK_HASH, occurredAt, null]);
    expect(result.usdcLedgerEntry).toMatchObject({ status: "settled", confirmations: 61, settledAt: occurredAt });
    expect(db.params.audits).toEqual(["wallet_funding_settled", "wallet_usdc_deposit_settled"]);
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("reports an already settled or voided deposit as a replay and moves nothing", async () => {
    const db = fakeDatabase({ usdcRow: makeUsdcRow({ status: "settled", settled_at: occurredAt }) });
    const result = await db.repository.settleUsdcDeposit({ vendorId: 10, usdcLedgerEntryId: 9, confirmations: 61, current: { blockNumber: 35_000_000, blockHash: BLOCK_HASH }, occurredAt });
    expect(result.idempotentReplay).toBe(true);
    expect(db.params.balances).toBeUndefined();
    expect(db.params.usdcUpdate).toBeUndefined();

    const missing = fakeDatabase({ usdcRow: null });
    await expect(missing.repository.settleUsdcDeposit({ vendorId: 10, usdcLedgerEntryId: 9, confirmations: 61, current: { blockNumber: 35_000_000, blockHash: BLOCK_HASH }, occurredAt }))
      .rejects.toMatchObject({ code: "DROPSHIP_USDC_LEDGER_ENTRY_NOT_FOUND" });
    expect(missing.statements.at(-1)).toBe("ROLLBACK");
  });

  it("voids a pending deposit: the amount leaves the pending balance, the ledger row fails with the reason, the observation is voided", async () => {
    const db = fakeDatabase({ usdcRow: makeUsdcRow(), ledgerRow: makeLedgerRow({ amount_cents: "2512" }) });

    const result = await db.repository.voidUsdcDeposit({ vendorId: 10, usdcLedgerEntryId: 9, reasonCode: "DROPSHIP_USDC_DEPOSIT_REORGED", reasonMessage: "The receipt disappeared.", occurredAt });

    expect(result.idempotentReplay).toBe(false);
    expect(db.params.balances).toEqual([5, 10, 1000, 1488, occurredAt]);
    expect(JSON.parse(String(db.params.ledgerUpdate?.[4]))).toMatchObject({ failure: { code: "DROPSHIP_USDC_DEPOSIT_REORGED", message: "The receipt disappeared.", providerStatus: "reorged", providerEventId: `usdc-deposit-void:8453:${TX}:7` } });
    expect(db.params.usdcUpdate).toEqual([9, 10, "voided", 0, 35_000_000, BLOCK_HASH, null, occurredAt]);
    expect(db.params.audits).toEqual(["wallet_funding_failed", "wallet_usdc_deposit_voided"]);
    expect(result.usdcLedgerEntry).toMatchObject({ status: "voided", voidedAt: occurredAt });
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("never voids a deposit that has no block on record: a manual credit is reversed by hand", async () => {
    const db = fakeDatabase({ usdcRow: makeUsdcRow({ log_index: null, block_number: null, block_hash: null }) });
    await expect(db.repository.voidUsdcDeposit({ vendorId: 10, usdcLedgerEntryId: 9, reasonCode: "DROPSHIP_USDC_DEPOSIT_REORGED", reasonMessage: "gone", occurredAt }))
      .rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSIT_CHAIN_FACTS_MISSING" });
    expect(db.params.balances).toBeUndefined();
    expect(db.statements.at(-1)).toBe("ROLLBACK");
  });

  it("re-records where a pending deposit sits after it moved, and leaves a settled one alone", async () => {
    const db = fakeDatabase({ usdcRow: makeUsdcRow() });
    const moved = await db.repository.recordUsdcDepositMoved({ vendorId: 10, usdcLedgerEntryId: 9, confirmations: 38, current: { blockNumber: 35_000_003, blockHash: OTHER_BLOCK_HASH }, occurredAt });
    expect(db.params.usdcUpdate).toEqual([9, 10, "pending", 38, 35_000_003, OTHER_BLOCK_HASH, null, null]);
    expect(moved).toMatchObject({ blockNumber: 35_000_003, blockHash: OTHER_BLOCK_HASH, confirmations: 38 });
    expect(db.params.audits).toEqual(["wallet_usdc_deposit_moved"]);

    const settled = fakeDatabase({ usdcRow: makeUsdcRow({ status: "settled" }) });
    await settled.repository.recordUsdcDepositMoved({ vendorId: 10, usdcLedgerEntryId: 9, confirmations: 38, current: { blockNumber: 35_000_003, blockHash: OTHER_BLOCK_HASH }, occurredAt });
    expect(settled.params.usdcUpdate).toBeUndefined();
    expect(settled.statements).toEqual(["BEGIN", "SELECT id,", "COMMIT"]);
  });

  it("lists pending observations with chain facts oldest block first, and finds one by its log", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      seen.push({ sql, params: params ?? [] });
      return { rows: [makeUsdcRow()] };
    });
    const repository = new PgDropshipWalletRepository(makePool(query));

    const pending = await repository.listPendingUsdcDeposits({ chainId: 8453, limit: 50 });
    expect(pending.map((entry) => entry.usdcLedgerEntryId)).toEqual([9]);
    expect(seen[0]?.sql).toContain("status = 'pending'");
    expect(seen[0]?.sql).toContain("log_index IS NOT NULL");
    expect(seen[0]?.sql).toContain("ORDER BY block_number ASC NULLS FIRST, id ASC");
    expect(seen[0]?.params).toEqual([8453, 50]);

    const found = await repository.findUsdcDepositByLog({ chainId: 8453, transactionHash: TX, logIndex: 7 });
    expect(found).toMatchObject({ usdcLedgerEntryId: 9, blockNumber: 35_000_000, tokenAddress: USDC, depositAddressId: 3, dustAtomicUnits: "3456" });
    expect(seen[1]?.params).toEqual([8453, TX, 7]);
  });
});
