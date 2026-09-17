import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipWalletRepository } from "../../infrastructure/dropship-wallet.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const occurredAt = new Date("2026-05-04T09:00:00.000Z");

const failure = {
  vendorId: 10,
  referenceType: "stripe_payment_intent",
  referenceId: "pi_ach_1",
  failureCode: "payment_intent_payment_attempt_failed",
  failureMessage: "The bank returned the debit.",
  providerStatus: "requires_payment_method",
  providerEventId: "evt_ach_failed_1",
  occurredAt,
};

describe("PgDropshipWalletRepository.failPendingFunding", () => {
  it("voids the pending credit, lowers the pending balance, and audits it in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        expect(sqlText).toContain("AND type = 'funding'");
        expect(sqlText).toContain("FOR UPDATE");
        expect(params).toEqual([10, "stripe_payment_intent", "pi_ach_1"]);
        return { rows: [makeLedgerRow()] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        expect(sqlText).toContain("FOR UPDATE");
        expect(params).toEqual([5, 10]);
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        expect(params).toEqual([5, 10, 1000, 0, occurredAt]);
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "0" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_ledger")) {
        expect(sqlText).toContain("SET status = 'failed'");
        expect(sqlText).toContain("AND status = 'pending'");
        expect(params?.slice(0, 4)).toEqual([1, 10, 1000, 0]);
        expect(JSON.parse(String(params?.[4]))).toMatchObject({
          rail: "stripe_ach",
          failure: {
            code: "payment_intent_payment_attempt_failed",
            message: "The bank returned the debit.",
            providerStatus: "requires_payment_method",
            providerEventId: "evt_ach_failed_1",
            failedAt: occurredAt.toISOString(),
          },
        });
        return { rows: [makeLedgerRow({ status: "failed", available_balance_after_cents: "1000", pending_balance_after_cents: "0" })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(params?.[0]).toBe(10);
        expect(params?.[1]).toBe("dropship_wallet_ledger");
        expect(params?.[2]).toBe("1");
        expect(params?.[3]).toBe("wallet_funding_failed");
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).failPendingFunding(failure);

    expect(result).toMatchObject({
      idempotentReplay: false,
      account: { walletAccountId: 5, availableBalanceCents: 1000, pendingBalanceCents: 0 },
      ledgerEntry: { ledgerEntryId: 1, status: "failed", amountCents: 4000, pendingBalanceAfterCents: 0 },
    });
    expect(statements).toEqual([
      "BEGIN",
      "SELECT id,",
      "SELECT id,",
      "UPDATE dropship.dropship_wallet_accounts",
      "UPDATE dropship.dropship_wallet_ledger",
      "INSERT INTO",
      "COMMIT",
    ]);
  });

  it("returns the entry unchanged on a replay that finds it already failed", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) return { rows: [makeLedgerRow({ status: "failed" })] };
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        expect(sqlText).not.toContain("FOR UPDATE");
        return { rows: [makeAccountRow({ pending_balance_cents: "0" })] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).failPendingFunding(failure);

    expect(result).toMatchObject({ idempotentReplay: true, ledgerEntry: { status: "failed" } });
    expect(statements).toEqual(["BEGIN", "SELECT id,", "SELECT id,", "COMMIT"]);
  });

  it("returns null when nothing was recorded for the payment", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));

    await expect(new PgDropshipWalletRepository(makePool(query)).failPendingFunding(failure)).resolves.toBeNull();
    expect(query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "COMMIT"]);
  });

  it("fails closed and rolls back when the pending balance cannot absorb the void", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/)[0]);
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) return { rows: [makeLedgerRow()] };
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) return { rows: [makeAccountRow({ pending_balance_cents: "2500" })] };
      return { rows: [] };
    });

    await expect(new PgDropshipWalletRepository(makePool(query)).failPendingFunding(failure))
      .rejects.toMatchObject({ code: "DROPSHIP_WALLET_PENDING_BALANCE_INCONSISTENT" });
    expect(statements).toEqual(["BEGIN", "SELECT", "SELECT", "ROLLBACK"]);
  });
});

function makeLedgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    wallet_account_id: 5,
    vendor_id: 10,
    type: "funding",
    status: "pending",
    amount_cents: "4000",
    currency: "USD",
    available_balance_after_cents: "1000",
    pending_balance_after_cents: "4000",
    reference_type: "stripe_payment_intent",
    reference_id: "pi_ach_1",
    idempotency_key: "stripe-funding:pi_ach_1",
    funding_method_id: 100,
    external_transaction_id: null,
    metadata: { rail: "stripe_ach", provider: "stripe" },
    created_at: occurredAt,
    settled_at: null,
    ...overrides,
  };
}

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    vendor_id: 10,
    available_balance_cents: "1000",
    pending_balance_cents: "4000",
    currency: "USD",
    status: "active",
    created_at: occurredAt,
    updated_at: occurredAt,
    ...overrides,
  };
}

function makePool(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Pool {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query, connect: async () => client } as unknown as Pool;
}
