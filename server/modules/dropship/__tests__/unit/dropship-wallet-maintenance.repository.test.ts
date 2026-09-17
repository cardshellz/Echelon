import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipWalletMaintenanceRepository } from "../../infrastructure/dropship-wallet-maintenance.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-01T20:00:00.000Z");

describe("PgDropshipWalletMaintenanceRepository", () => {
  it("lists active vendors whose run for the day is missing or still open", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      expect(sqlText).toContain("FROM dropship.dropship_vendors v");
      expect(sqlText).toContain("wa.status = 'active'");
      expect(sqlText).toContain("r.run_date = $1::date");
      expect(sqlText).toContain("v.status = 'active'");
      expect(sqlText).toContain("(r.id IS NULL OR r.status IN ('pending', 'retry_pending'))");
      expect(params).toEqual(["2026-05-01", 50]);
      return { rows: [{ vendor_id: 10 }, { vendor_id: 11 }] };
    });
    const repository = new PgDropshipWalletMaintenanceRepository(makePool(query));

    await expect(repository.listVendorsDue({ runDate: "2026-05-01", limit: 50 })).resolves.toEqual([
      { vendorId: 10 },
      { vendorId: 11 },
    ]);
  });

  it("claims the day's run once and returns the existing row on a replay", async () => {
    let inserts = 0;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText.includes("INSERT INTO dropship.dropship_wallet_maintenance_runs")) {
        inserts += 1;
        expect(sqlText).toContain("ON CONFLICT (vendor_id, run_date) DO NOTHING");
        expect(sqlText).toContain("run_date::text AS run_date");
        expect(params).toEqual([10, "2026-05-01", "wallet-maintenance:10:2026-05-01", now]);
        return { rows: inserts === 1 ? [makeRunRow()] : [] };
      }
      if (sqlText.includes("SELECT") && sqlText.includes("FROM dropship.dropship_wallet_maintenance_runs")) {
        expect(params).toEqual([10, "2026-05-01"]);
        return { rows: [makeRunRow({ status: "reloaded", attempt_count: 1, amount_cents: "4000" })] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipWalletMaintenanceRepository(makePool(query));
    const claim = { vendorId: 10, runDate: "2026-05-01", idempotencyKey: "wallet-maintenance:10:2026-05-01", now };

    const first = await repository.claimRun(claim);
    expect(first.created).toBe(true);
    expect(first.run).toMatchObject({ runId: 7, vendorId: 10, runDate: "2026-05-01", status: "pending", attemptCount: 0, amountCents: null });

    const replay = await repository.claimRun(claim);
    expect(replay.created).toBe(false);
    expect(replay.run).toMatchObject({ status: "reloaded", attemptCount: 1, amountCents: 4000 });
  });

  it("fails closed when a claim returns no row at all", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = new PgDropshipWalletMaintenanceRepository(makePool(query));

    await expect(repository.claimRun({ vendorId: 10, runDate: "2026-05-01", idempotencyKey: "k", now }))
      .rejects.toMatchObject({ code: "DROPSHIP_WALLET_MAINTENANCE_CLAIM_FAILED" });
  });

  it("bumps the attempt counter before a charge", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(String(sql)).toContain("SET attempt_count = attempt_count + 1");
      expect(params).toEqual([7, 10, now]);
      return { rows: [makeRunRow({ attempt_count: 1, last_attempt_at: now })] };
    });
    const repository = new PgDropshipWalletMaintenanceRepository(makePool(query));

    await expect(repository.markAttemptStarted({ runId: 7, vendorId: 10, now })).resolves.toMatchObject({
      attemptCount: 1,
      lastAttemptAt: now,
    });
  });

  it("records a reload outcome and its audit row in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_maintenance_runs")) {
        expect(params).toEqual([7, 10, "reloaded", 4000, 120, 4120, "USD", 99, "settled", 501, "pi_1", null, null, now]);
        return { rows: [makeRunRow({
          status: "reloaded", attempt_count: 1, amount_cents: "4000", card_fee_cents: "120", charged_cents: "4120",
          funding_method_id: 99, funding_status: "settled", wallet_ledger_entry_id: 501, provider_payment_intent_id: "pi_1",
        })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(sqlText).toContain("'dropship_wallet_maintenance_run'");
        expect(sqlText).toContain("'dropship-wallet-maintenance'");
        expect(params?.[0]).toBe(10);
        expect(params?.[1]).toBe("7");
        expect(params?.[2]).toBe("wallet_maintenance_reloaded");
        expect(JSON.parse(String(params?.[3]))).toMatchObject({ runId: 7, status: "reloaded", amountCents: 4000, chargedCents: 4120 });
        return { rows: [] };
      }
      return { rows: [] };
    });
    const repository = new PgDropshipWalletMaintenanceRepository(makePool(query));

    const run = await repository.recordOutcome({
      runId: 7, vendorId: 10, status: "reloaded",
      amountCents: 4000, cardFeeCents: 120, chargedCents: 4120, currency: "USD",
      fundingMethodId: 99, fundingStatus: "settled", walletLedgerEntryId: 501, providerPaymentIntentId: "pi_1",
      outcomeCode: null, outcomeMessage: null, now,
    });

    expect(run).toMatchObject({ status: "reloaded", amountCents: 4000, cardFeeCents: 120, chargedCents: 4120, fundingStatus: "settled" });
    expect(statements).toEqual(["BEGIN", "UPDATE dropship.dropship_wallet_maintenance_runs", "INSERT INTO", "COMMIT"]);
  });

  it("does not audit a not-needed outcome, and rolls back when the run row is gone", async () => {
    const quiet: string[] = [];
    const quietQuery = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      quiet.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.startsWith("UPDATE")) return { rows: [makeRunRow({ status: "not_needed", attempt_count: 1, outcome_code: "balance_already_sufficient" })] };
      return { rows: [] };
    });
    await new PgDropshipWalletMaintenanceRepository(makePool(quietQuery)).recordOutcome({
      ...emptyOutcome(), status: "not_needed", outcomeCode: "balance_already_sufficient",
    });
    expect(quiet).toEqual(["BEGIN", "UPDATE dropship.dropship_wallet_maintenance_runs", "COMMIT"]);

    const gone: string[] = [];
    const goneQuery = vi.fn(async (sql: string) => {
      gone.push(String(sql).trim().split(/\s+/).slice(0, 2).join(" "));
      return { rows: [] };
    });
    await expect(new PgDropshipWalletMaintenanceRepository(makePool(goneQuery)).recordOutcome({
      ...emptyOutcome(), status: "failed", outcomeCode: "retry_exhausted",
    })).rejects.toMatchObject({ code: "DROPSHIP_WALLET_MAINTENANCE_RUN_NOT_FOUND" });
    expect(gone).toEqual(["BEGIN", "UPDATE dropship.dropship_wallet_maintenance_runs", "ROLLBACK"]);
  });

  it("rejects rows carrying an unknown status or a non-integer amount", async () => {
    const badStatus = vi.fn(async () => ({ rows: [makeRunRow({ status: "mystery" })] }));
    await expect(new PgDropshipWalletMaintenanceRepository(makePool(badStatus)).markAttemptStarted({ runId: 7, vendorId: 10, now }))
      .rejects.toMatchObject({ code: "DROPSHIP_WALLET_MAINTENANCE_RUN_STATUS_INVALID" });

    const badAmount = vi.fn(async () => ({ rows: [makeRunRow({ amount_cents: "12.5" })] }));
    await expect(new PgDropshipWalletMaintenanceRepository(makePool(badAmount)).markAttemptStarted({ runId: 7, vendorId: 10, now }))
      .rejects.toMatchObject({ code: "DROPSHIP_WALLET_MAINTENANCE_AMOUNT_INVALID" });
  });
});

function emptyOutcome() {
  return {
    runId: 7, vendorId: 10,
    amountCents: null, cardFeeCents: null, chargedCents: null, currency: null,
    fundingMethodId: null, fundingStatus: null, walletLedgerEntryId: null, providerPaymentIntentId: null,
    outcomeMessage: null, now,
  } as const;
}

function makeRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    vendor_id: 10,
    run_date: "2026-05-01",
    status: "pending",
    attempt_count: 0,
    amount_cents: null,
    card_fee_cents: null,
    charged_cents: null,
    currency: "USD",
    funding_method_id: null,
    funding_status: null,
    wallet_ledger_entry_id: null,
    provider_payment_intent_id: null,
    outcome_code: null,
    outcome_message: null,
    last_attempt_at: null,
    idempotency_key: "wallet-maintenance:10:2026-05-01",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makePool(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Pool {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query, connect: async () => client } as unknown as Pool;
}
