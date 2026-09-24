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
  pauseVendor: null,
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
        expect(params).toEqual([5, 10, 1000, 0, occurredAt, null]);
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

    expect(result).toMatchObject({ idempotentReplay: true, vendorPaused: null, ledgerEntry: { status: "failed" } });
    expect(statements).toEqual(["BEGIN", "SELECT id,", "SELECT id,", "COMMIT"]);
  });

  it("pauses the vendor in the same transaction as the void, with the ledger entry in the pause evidence", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) return { rows: [makeLedgerRow()] };
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "0" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_ledger")) {
        return { rows: [makeLedgerRow({ status: "failed", available_balance_after_cents: "1000", pending_balance_after_cents: "0" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_vendors")) {
        expect(sqlText).toContain("SET status = 'paused'");
        expect(sqlText).toContain("AND status = 'active'");
        expect(params).toEqual([10, "funding_returned", occurredAt]);
        return { rows: [makeStandingRow({ status: "paused", standing_reason: "funding_returned", paused_at: occurredAt, standing_revision: 1 })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events") && sqlText.includes("'dropship_vendor'")) {
        expect(params?.slice(0, 3)).toEqual([10, "10", "vendor_paused"]);
        expect(JSON.parse(String(params?.[3]))).toMatchObject({
          reason: "funding_returned",
          evidence: { source: "funding_webhook", providerEventId: "evt_ach_failed_1", ledgerEntryId: 1 },
        });
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).failPendingFunding({
      ...failure,
      pauseVendor: { reason: "funding_returned", evidence: { source: "funding_webhook", providerEventId: "evt_ach_failed_1" } },
    });

    expect(result).toMatchObject({
      idempotentReplay: false,
      ledgerEntry: { status: "failed" },
      vendorPaused: { vendorId: 10, status: "paused", standingReason: "funding_returned", pausedAt: occurredAt, standingRevision: 1 },
    });
    expect(statements).toEqual([
      "BEGIN",
      "SELECT id,",
      "SELECT id,",
      "UPDATE dropship.dropship_wallet_accounts",
      "UPDATE dropship.dropship_wallet_ledger",
      "INSERT INTO",
      "UPDATE dropship.dropship_vendors",
      "INSERT INTO",
      "COMMIT",
    ]);
  });

  it("voids the credit but leaves standing alone when the vendor is not active", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) return { rows: [makeLedgerRow()] };
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "0" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_ledger")) {
        return { rows: [makeLedgerRow({ status: "failed", available_balance_after_cents: "1000", pending_balance_after_cents: "0" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_vendors")) return { rows: [] };
      if (sqlText.includes("FROM dropship.dropship_vendors")) {
        return { rows: [makeStandingRow({ status: "paused", standing_reason: "card_declined", paused_at: occurredAt, standing_revision: 1 })] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).failPendingFunding({
      ...failure,
      pauseVendor: { reason: "funding_returned", evidence: {} },
    });

    expect(result).toMatchObject({ idempotentReplay: false, vendorPaused: null, ledgerEntry: { status: "failed" } });
    expect(statements).toEqual([
      "BEGIN",
      "SELECT id,",
      "SELECT id,",
      "UPDATE dropship.dropship_wallet_accounts",
      "UPDATE dropship.dropship_wallet_ledger",
      "INSERT INTO",
      "UPDATE dropship.dropship_vendors",
      "SELECT id,",
      "COMMIT",
    ]);
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
    rewards_balance_after_cents: null,
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

function makeStandingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    status: "active",
    standing_reason: null,
    paused_at: null,
    standing_revision: 0,
    listing_hold_state: "released",
    listing_hold_reconciled_at: null,
    listing_hold_detail: null,
    ...overrides,
  };
}

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    vendor_id: 10,
    available_balance_cents: "1000",
    rewards_balance_cents: "0",
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

describe("PgDropshipWalletRepository advance and bank balance (funding design phase 3)", () => {
  const occurred = new Date("2026-09-20T12:00:00.000Z");

  function makeVerificationRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 31,
      vendor_id: 10,
      funding_method_id: 100,
      provider: "stripe",
      provider_account_id: "fca_1",
      status: "succeeded",
      source: "link",
      available_cents: "250000",
      currency: "USD",
      balance_as_of: occurred,
      provider_event_id: "evt_setup_1",
      created_at: occurred,
      ...overrides,
    };
  }

  it("reads the advance facts in one transaction: account, policy, override and bank accounts", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("to_regclass($1)")) return { rows: [{ present: String(params?.[0]) }] };
      if (sql.startsWith("INSERT INTO dropship.dropship_wallet_accounts")) return { rows: [] };
      if (sql.includes("FROM dropship.dropship_wallet_accounts")) return { rows: [makeAccountRow({ available_balance_cents: "-300", pending_balance_cents: "50000" })] };
      if (sql.includes("SELECT advance_fee_bps, advance_cap_cents")) return { rows: [{ advance_fee_bps: 100, advance_cap_cents: "50000" }] };
      if (sql.includes("SELECT advance_cap_override_cents")) {
        expect(params).toEqual([10]);
        return { rows: [{ advance_cap_override_cents: null }] };
      }
      if (sql.includes("FROM dropship.dropship_funding_methods m")) {
        expect(params).toEqual([10, 5, "stripe_ach"]);
        return { rows: [{ funding_method_id: 100, metadata: { accountHolderType: "company" }, pending_cents: "50000", prior_pull_settled: true, balance_verified: true }] };
      }
      return { rows: [] };
    });

    const context = await new PgDropshipWalletRepository(makePool(query)).readAdvanceContext({ vendorId: 10, now: occurred });

    expect(context).toEqual({
      policy: { feeBps: 100, capCents: 50_000, capSource: "policy" },
      sources: [{ fundingMethodId: 100, pendingCents: 50_000, accountHolderType: "company", balanceVerified: true, priorPullSettled: true }],
    });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("returns no advance context, without reading bank accounts, while the policy table is absent", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("to_regclass($1)")) return { rows: [{ present: null }] };
      if (sql.includes("FROM dropship.dropship_wallet_accounts")) return { rows: [makeAccountRow()] };
      if (sql.includes("FROM dropship.dropship_funding_methods m")) throw new Error("must not read sources");
      return { rows: [] };
    });

    expect(await new PgDropshipWalletRepository(makePool(query)).readAdvanceContext({ vendorId: 10, now: occurred })).toBeNull();
  });

  it("appends a succeeded balance reading with its audit row, in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("FROM dropship.dropship_funding_methods")) {
        expect(params).toEqual([100, 10]);
        return { rows: [{ id: 100 }] };
      }
      if (sql.startsWith("INSERT INTO dropship.dropship_funding_method_balance_verifications")) {
        expect(sql).toContain("ON CONFLICT (provider, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING");
        expect(params).toEqual([10, 100, "stripe", "fca_1", "succeeded", "link", 250_000, "USD", occurred, "evt_setup_1", "{}", occurred]);
        return { rows: [makeVerificationRow()] };
      }
      if (sql.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(params?.slice(0, 4)).toEqual([10, "dropship_funding_method_balance_verification", "31", "wallet_bank_balance_succeeded"]);
        expect(JSON.parse(String(params?.[4]))).toMatchObject({ fundingMethodId: 100, providerAccountId: "fca_1", availableCents: 250_000, currency: "USD", source: "link" });
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).recordBankBalanceVerification({
      vendorId: 10,
      fundingMethodId: 100,
      provider: "stripe",
      reading: { status: "succeeded", providerAccountId: "fca_1", availableCents: 250_000, currency: "USD", asOf: occurred },
      source: "link",
      providerEventId: "evt_setup_1",
      occurredAt: occurred,
    });

    expect(result).toEqual({
      idempotentReplay: false,
      record: {
        verificationId: 31, vendorId: 10, fundingMethodId: 100, provider: "stripe", providerAccountId: "fca_1", status: "succeeded", source: "link",
        availableCents: 250_000, currency: "USD", balanceAsOf: occurred, providerEventId: "evt_setup_1", createdAt: occurred,
      },
    });
    expect(statements).toEqual(["BEGIN", "SELECT id", "INSERT INTO", "INSERT INTO", "COMMIT"]);
  });

  it("returns the existing reading, without a second audit row, when the provider event was already recorded", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("FROM dropship.dropship_funding_methods")) return { rows: [{ id: 100 }] };
      if (sql.startsWith("INSERT INTO dropship.dropship_funding_method_balance_verifications")) return { rows: [] };
      if (sql.includes("FROM dropship.dropship_funding_method_balance_verifications")) {
        expect(params).toEqual(["stripe", "evt_setup_1"]);
        return { rows: [makeVerificationRow({ status: "failed", available_cents: null, currency: null, balance_as_of: null })] };
      }
      if (sql.includes("dropship_audit_events")) throw new Error("no audit on replay");
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).recordBankBalanceVerification({
      vendorId: 10,
      fundingMethodId: 100,
      provider: "stripe",
      reading: { status: "failed", providerAccountId: "fca_1", reason: "balances_permission_missing" },
      source: "link",
      providerEventId: "evt_setup_1",
      occurredAt: occurred,
    });

    expect(result).toMatchObject({ idempotentReplay: true, record: { verificationId: 31, status: "failed", availableCents: null } });
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("refuses to record a reading for a funding method that is not the vendor's", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM dropship.dropship_funding_methods")) return { rows: [] };
      return { rows: [] };
    });

    await expect(new PgDropshipWalletRepository(makePool(query)).recordBankBalanceVerification({
      vendorId: 10,
      fundingMethodId: 100,
      provider: "stripe",
      reading: { status: "pending", providerAccountId: "fca_1", nextRefreshAvailableAt: null },
      source: "refresh",
      providerEventId: null,
      occurredAt: occurred,
    })).rejects.toMatchObject({ code: "DROPSHIP_FUNDING_METHOD_NOT_FOUND" });
    expect(query.mock.calls.map((call) => String(call[0]).trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "ROLLBACK"]);
  });

  it("finds the bank account linked to a provider account through its metadata", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("WHERE rail = 'stripe_ach'");
      expect(params).toEqual(["stripe", "financialConnectionsAccountId", "fca_1"]);
      return { rows: [{
        id: 100, vendor_id: 10, rail: "stripe_ach", status: "active", provider_customer_id: "cus_1", provider_payment_method_id: "pm_bank",
        usdc_wallet_address: null, display_label: "ACH ending in 6789", is_default: false,
        metadata: { provider: "stripe", financialConnectionsAccountId: "fca_1" }, created_at: occurred, updated_at: occurred,
      }] };
    });

    const method = await new PgDropshipWalletRepository(makePool(query)).findFundingMethodByProviderAccount({ provider: "stripe", providerAccountId: "fca_1" });

    expect(method).toMatchObject({ fundingMethodId: 100, vendorId: 10, rail: "stripe_ach", metadata: { financialConnectionsAccountId: "fca_1" } });
  });
});

describe("PgDropshipWalletRepository funding reversals (funding design phase 4)", () => {
  const reversal = {
    provider: "stripe" as const,
    providerPaymentIntentId: "pi_ach_1",
    providerDisputeId: "dp_1",
    providerEventId: "evt_dp_1",
    disputeAmountCents: 4000,
    currency: "USD",
    disputeStatus: "needs_response" as const,
    disputeReason: "fraudulent",
    occurredAt,
    pauseVendor: {
      reason: "funding_returned" as const,
      evidence: { source: "dispute_webhook", disputed: true, providerEventId: "evt_dp_1" },
    },
  };
  const reinstatement = { provider: "stripe" as const, providerDisputeId: "dp_1", providerEventId: "evt_dp_won", occurredAt };

  /** The settled ACH credit the dispute is about: 4000 landed, with the funding method that sent it. */
  const settledCredit = () => makeLedgerRow({
    status: "settled", settled_at: occurredAt, available_balance_after_cents: "5000", pending_balance_after_cents: "0",
  });
  const reversalRow = (overrides: Record<string, unknown> = {}) => makeLedgerRow({
    id: 2, type: "funding_reversal", status: "settled", amount_cents: "-4000",
    available_balance_after_cents: "-3000", pending_balance_after_cents: "4000",
    reference_type: "stripe_dispute", reference_id: "dp_1", idempotency_key: "stripe-dispute:dp_1",
    metadata: { provider: "stripe", fundingLedgerEntryId: 1, rail: "stripe_ach" }, settled_at: occurredAt,
    ...overrides,
  });
  const reinstatementRow = () => makeLedgerRow({
    id: 3, type: "funding_reinstated", status: "settled", amount_cents: "4000",
    available_balance_after_cents: "1000", pending_balance_after_cents: "4000",
    reference_type: "stripe_dispute_reinstated", reference_id: "dp_1", idempotency_key: "stripe-dispute-reinstated:dp_1",
    metadata: { provider: "stripe", reversalLedgerEntryId: 2, fundingLedgerEntryId: 1 }, settled_at: occurredAt,
  });

  it("debits the disputed amount, posts one reversal row, audits it, and pauses the vendor in the same transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        expect(sqlText).toContain("AND type = $3");
        if (params?.[0] === "stripe_payment_intent") {
          expect(sqlText).toContain("FOR UPDATE");
          expect(params).toEqual(["stripe_payment_intent", "pi_ach_1", "funding"]);
          return { rows: [settledCredit()] };
        }
        expect(sqlText).not.toContain("FOR UPDATE");
        // The credit's rewards row is read too (funding design phase 7); this credit earned none.
        if (params?.[0] === "wallet_funding_rewards") {
          expect(params).toEqual(["wallet_funding_rewards", "1", "rewards_earned"]);
          return { rows: [] };
        }
        expect(params).toEqual(["stripe_dispute", "dp_1", "funding_reversal"]);
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        expect(sqlText).toContain("FOR UPDATE");
        expect(params).toEqual([5, 10]);
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        // The balance goes negative: the money left with the bank, and the pending side is untouched.
        // The rewards balance is restated (nothing earned, nothing taken back).
        expect(params).toEqual([5, 10, -3000, 4000, occurredAt, 0]);
        return { rows: [makeAccountRow({ available_balance_cents: "-3000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_ledger")) {
        expect(params?.slice(0, 13)).toEqual([
          5, 10, "funding_reversal", "settled", -4000, "USD", -3000, 4000,
          "stripe_dispute", "dp_1", "stripe-dispute:dp_1", 100, null,
        ]);
        expect(JSON.parse(String(params?.[13]))).toEqual({
          provider: "stripe", providerEventId: "evt_dp_1", providerDisputeId: "dp_1", providerPaymentIntentId: "pi_ach_1",
          fundingLedgerEntryId: 1, creditAmountCents: 4000, disputeAmountCents: 4000,
          disputeStatus: "needs_response", disputeReason: "fraudulent", rail: "stripe_ach",
          rewardsClawback: { rewardsLedgerEntryId: null, earnedCents: 0, clawbackCents: 0, fromRewardsCents: 0, fromCashCents: 0 },
        });
        expect(params?.slice(14)).toEqual([occurredAt, occurredAt, 0]);
        return { rows: [reversalRow()] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events") && sqlText.includes("'dropship_vendor'")) {
        expect(params?.slice(0, 3)).toEqual([10, "10", "vendor_paused"]);
        expect(JSON.parse(String(params?.[3]))).toMatchObject({
          reason: "funding_returned",
          evidence: { source: "dispute_webhook", disputed: true, providerEventId: "evt_dp_1", ledgerEntryId: 2 },
        });
        return { rows: [] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(params?.slice(0, 4)).toEqual([10, "dropship_wallet_ledger", "2", "wallet_funding_reversed"]);
        expect(JSON.parse(String(params?.[4]))).toMatchObject({
          type: "funding_reversal", before: { availableBalanceCents: 1000 }, after: { availableBalanceCents: -3000 },
        });
        return { rows: [] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_vendors")) {
        expect(sqlText).toContain("SET status = 'paused'");
        expect(params).toEqual([10, "funding_returned", occurredAt]);
        return { rows: [makeStandingRow({ status: "paused", standing_reason: "funding_returned", paused_at: occurredAt, standing_revision: 1 })] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).reverseSettledFunding(reversal);

    expect(result).toMatchObject({
      outcome: "reversed",
      vendorId: 10,
      idempotentReplay: false,
      account: { walletAccountId: 5, availableBalanceCents: -3000, pendingBalanceCents: 4000 },
      credit: { ledgerEntryId: 1, status: "settled", amountCents: 4000 },
      reversal: { ledgerEntryId: 2, type: "funding_reversal", amountCents: -4000, referenceType: "stripe_dispute", referenceId: "dp_1" },
      vendorPaused: { vendorId: 10, status: "paused", standingReason: "funding_returned", standingRevision: 1 },
    });
    expect(statements).toEqual([
      "BEGIN",
      "SELECT id,",
      "SELECT id,",
      "SELECT id,",
      "SELECT id,",
      "UPDATE dropship.dropship_wallet_accounts",
      "INSERT INTO",
      "INSERT INTO",
      "UPDATE dropship.dropship_vendors",
      "INSERT INTO",
      "COMMIT",
    ]);
  });

  it("returns the reversal already posted for the dispute on a replay, moving nothing and pausing nobody", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        return { rows: [params?.[0] === "stripe_payment_intent" ? settledCredit() : reversalRow()] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        expect(sqlText).not.toContain("FOR UPDATE");
        return { rows: [makeAccountRow({ available_balance_cents: "-3000", pending_balance_cents: "4000" })] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).reverseSettledFunding(reversal);

    expect(result).toMatchObject({
      outcome: "reversed", idempotentReplay: true, vendorPaused: null,
      reversal: { ledgerEntryId: 2, amountCents: -4000 }, account: { availableBalanceCents: -3000 },
    });
    expect(statements).toEqual(["BEGIN", "SELECT id,", "SELECT id,", "SELECT id,", "COMMIT"]);
  });

  it("returns null for a payment the wallet never recorded, and ignores a credit that is pending or in another currency", async () => {
    const none = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));
    await expect(new PgDropshipWalletRepository(makePool(none)).reverseSettledFunding(reversal)).resolves.toBeNull();
    expect(none.mock.calls.map((call) => String(call[0]).trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "COMMIT"]);

    const cases = [
      { credit: makeLedgerRow(), currency: "USD", reason: "credit_not_settled" },
      { credit: settledCredit(), currency: "EUR", reason: "currency_mismatch" },
    ];
    for (const { credit, currency, reason } of cases) {
      const statements: string[] = [];
      const query = vi.fn(async (sql: string, params?: unknown[]) => {
        const sqlText = String(sql);
        statements.push(sqlText.trim().split(/\s+/)[0]);
        if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
          return { rows: params?.[0] === "stripe_payment_intent" ? [credit] : [] };
        }
        return { rows: [] };
      });

      const result = await new PgDropshipWalletRepository(makePool(query)).reverseSettledFunding({ ...reversal, currency });

      expect(result).toEqual({ outcome: "ignored", vendorId: 10, credit: expect.objectContaining({ ledgerEntryId: 1 }), reason });
      expect(statements).toEqual(["BEGIN", "SELECT", "SELECT", "COMMIT"]);
    }
  });

  it("never takes back more than the credit put in: the card fee above it is not the vendor's loss", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        return { rows: params?.[0] === "stripe_payment_intent" ? [settledCredit()] : [] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "5000", pending_balance_cents: "0" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        expect(params).toEqual([5, 10, 1000, 0, occurredAt, 0]);
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "0" })] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_ledger")) {
        expect(params?.[4]).toBe(-4000);
        expect(JSON.parse(String(params?.[13]))).toMatchObject({ creditAmountCents: 4000, disputeAmountCents: 4120 });
        return { rows: [reversalRow({ available_balance_after_cents: "1000", pending_balance_after_cents: "0" })] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query))
      .reverseSettledFunding({ ...reversal, disputeAmountCents: 4120, pauseVendor: null });

    expect(result).toMatchObject({ outcome: "reversed", reversal: { amountCents: -4000 }, account: { availableBalanceCents: 1000 }, vendorPaused: null });
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("UPDATE dropship.dropship_vendors"))).toBe(false);
  });

  it("reads the winner's row when two deliveries of the same dispute race on the unique reference", async () => {
    let posted = false;
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/)[0]);
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        if (params?.[0] === "stripe_payment_intent") return { rows: [settledCredit()] };
        return { rows: posted ? [reversalRow()] : [] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "-3000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_ledger")) {
        posted = true;
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).reverseSettledFunding(reversal);

    expect(result).toMatchObject({ outcome: "reversed", idempotentReplay: true, vendorPaused: null, reversal: { ledgerEntryId: 2 } });
    // The loser rolls back and reads the winner's row without a second transaction or a second pause attempt.
    expect(statements).toEqual([
      "BEGIN", "SELECT", "SELECT", "SELECT", "SELECT", "UPDATE", "INSERT", "ROLLBACK",
      "SELECT", "SELECT", "SELECT",
    ]);
  });

  it("credits a reversal back when the dispute is won, with its own row and audit, in one transaction", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        if (params?.[0] === "stripe_dispute") {
          expect(sqlText).toContain("FOR UPDATE");
          expect(params).toEqual(["stripe_dispute", "dp_1", "funding_reversal"]);
          return { rows: [reversalRow()] };
        }
        expect(sqlText).not.toContain("FOR UPDATE");
        // The rewards the reversal took back are read too (funding design phase 7); none here.
        if (params?.[0] === "stripe_dispute_rewards") {
          expect(params).toEqual(["stripe_dispute_rewards", "dp_1", "rewards_reversed"]);
          return { rows: [] };
        }
        expect(params).toEqual(["stripe_dispute_reinstated", "dp_1", "funding_reinstated"]);
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        expect(sqlText).toContain("FOR UPDATE");
        expect(params).toEqual([5, 10]);
        return { rows: [makeAccountRow({ available_balance_cents: "-3000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        expect(params).toEqual([5, 10, 1000, 4000, occurredAt, 0]);
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000" })] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_ledger")) {
        expect(params?.slice(0, 13)).toEqual([
          5, 10, "funding_reinstated", "settled", 4000, "USD", 1000, 4000,
          "stripe_dispute_reinstated", "dp_1", "stripe-dispute-reinstated:dp_1", 100, null,
        ]);
        expect(JSON.parse(String(params?.[13]))).toEqual({
          provider: "stripe", providerEventId: "evt_dp_won", providerDisputeId: "dp_1", reversalLedgerEntryId: 2, fundingLedgerEntryId: 1,
        });
        expect(params?.slice(14)).toEqual([occurredAt, occurredAt, 0]);
        return { rows: [reinstatementRow()] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(params?.slice(0, 4)).toEqual([10, "dropship_wallet_ledger", "3", "wallet_funding_reinstated"]);
        expect(JSON.parse(String(params?.[4]))).toMatchObject({
          type: "funding_reinstated", before: { availableBalanceCents: -3000 }, after: { availableBalanceCents: 1000 },
        });
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).reinstateReversedFunding(reinstatement);

    expect(result).toMatchObject({
      vendorId: 10,
      idempotentReplay: false,
      account: { availableBalanceCents: 1000, pendingBalanceCents: 4000 },
      reversal: { ledgerEntryId: 2, amountCents: -4000 },
      reinstatement: { ledgerEntryId: 3, type: "funding_reinstated", amountCents: 4000, referenceType: "stripe_dispute_reinstated" },
    });
    expect(statements).toEqual([
      "BEGIN",
      "SELECT id,",
      "SELECT id,",
      "SELECT id,",
      "SELECT id,",
      "UPDATE dropship.dropship_wallet_accounts",
      "INSERT INTO",
      "INSERT INTO",
      "COMMIT",
    ]);
  });

  it("returns the reinstatement already posted on a replay, and null when no reversal exists for the dispute", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/)[0]);
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        return { rows: [params?.[0] === "stripe_dispute" ? reversalRow() : reinstatementRow()] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        expect(sqlText).not.toContain("FOR UPDATE");
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000" })] };
      }
      return { rows: [] };
    });

    const replay = await new PgDropshipWalletRepository(makePool(query)).reinstateReversedFunding(reinstatement);

    expect(replay).toMatchObject({ idempotentReplay: true, reinstatement: { ledgerEntryId: 3 }, account: { availableBalanceCents: 1000 } });
    expect(statements).toEqual(["BEGIN", "SELECT", "SELECT", "SELECT", "COMMIT"]);

    const none = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] as unknown[] }));
    await expect(new PgDropshipWalletRepository(makePool(none)).reinstateReversedFunding(reinstatement)).resolves.toBeNull();
    expect(none.mock.calls.map((call) => String(call[0]).trim().split(/\s+/)[0])).toEqual(["BEGIN", "SELECT", "COMMIT"]);
  });
});

describe("PgDropshipWalletRepository.configureAutoReload (funding design phase 5)", () => {
  const updatedAt = new Date("2026-09-20T12:00:00.000Z");

  function makeAutoReloadRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 7,
      vendor_id: 10,
      funding_method_id: 100,
      enabled: true,
      minimum_balance_cents: "50000",
      max_single_reload_cents: "50000",
      top_up_amount_cents: null,
      payment_hold_timeout_minutes: 1440,
      created_at: updatedAt,
      updated_at: updatedAt,
      ...overrides,
    };
  }

  function makeConfigureInput(overrides: Record<string, unknown> = {}) {
    return {
      vendorId: 10,
      fundingMethodId: 100,
      enabled: true,
      minimumBalanceCents: 50_000,
      maxSingleReloadCents: 50_000,
      topUpAmountCents: null,
      paymentHoldTimeoutMinutes: 1440,
      cardFundingFeeBps: 300,
      acknowledgedCardFeeBps: 300,
      updatedAt,
      ...overrides,
    };
  }

  it("stores the top-up amount in the same upsert as the minimum and the bound, and records it in the audit row", async () => {
    const statements: string[] = [];
    const captured: { upsert?: unknown[]; audit?: unknown[] } = {};
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("FROM dropship.dropship_funding_methods")) {
        expect(params).toEqual([100, 10]);
        return { rows: [{ id: 100, vendor_id: 10, rail: "stripe_ach", status: "active" }] };
      }
      if (sql.includes("INSERT INTO dropship.dropship_auto_reload_settings")) {
        captured.upsert = params;
        expect(sql).toContain("top_up_amount_cents = EXCLUDED.top_up_amount_cents");
        expect(sql).toContain("acknowledged_card_fee_bps = EXCLUDED.acknowledged_card_fee_bps");
        return { rows: [makeAutoReloadRow({ max_single_reload_cents: "150000", top_up_amount_cents: "150000" })] };
      }
      if (sql.includes("INSERT INTO dropship.dropship_audit_events")) {
        captured.audit = params;
        return { rows: [] };
      }
      return { rows: [] };
    });

    const setting = await new PgDropshipWalletRepository(makePool(query)).configureAutoReload(
      makeConfigureInput({ maxSingleReloadCents: 150_000, topUpAmountCents: 150_000 }),
    );

    // Parameter order is the contract with the SQL: $7 is reused for both timestamps, $8 is the top-up amount,
    // $9 and $10 the acknowledged card fee rate and when it was agreed (migration 0701).
    expect(captured.upsert).toEqual([10, 100, true, 50_000, 150_000, 1440, updatedAt, 150_000, 300, updatedAt]);
    expect(setting).toMatchObject({
      autoReloadSettingId: 7,
      minimumBalanceCents: 50_000,
      maxSingleReloadCents: 150_000,
      topUpAmountCents: 150_000,
    });
    expect(captured.audit?.[3]).toBe("wallet_auto_reload_configured");
    expect(JSON.parse(String(captured.audit?.[4]))).toMatchObject({
      minimumBalanceCents: 50_000,
      topUpAmountCents: 150_000,
      maxSingleReloadCents: 150_000,
      cardFundingFeeBps: 300,
      acknowledgedCardFeeBps: 300,
    });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("stores a null top-up amount (pull the minimum) and reads it back as null", async () => {
    const captured: { upsert?: unknown[] } = {};
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM dropship.dropship_funding_methods")) return { rows: [{ id: 100, vendor_id: 10, status: "active" }] };
      if (sql.includes("INSERT INTO dropship.dropship_auto_reload_settings")) {
        captured.upsert = params;
        return { rows: [makeAutoReloadRow()] };
      }
      return { rows: [] };
    });

    const setting = await new PgDropshipWalletRepository(makePool(query)).configureAutoReload(makeConfigureInput());

    expect(captured.upsert?.[7]).toBeNull();
    expect(setting.topUpAmountCents).toBeNull();
    expect(setting.maxSingleReloadCents).toBe(50_000);
  });

  it("rolls back and stores nothing when the funding method is not active", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("FROM dropship.dropship_funding_methods")) return { rows: [{ id: 100, vendor_id: 10, status: "detached" }] };
      if (sql.includes("INSERT INTO dropship.dropship_auto_reload_settings")) throw new Error("must not upsert");
      return { rows: [] };
    });

    await expect(new PgDropshipWalletRepository(makePool(query)).configureAutoReload(makeConfigureInput()))
      .rejects.toMatchObject({ code: "DROPSHIP_FUNDING_METHOD_NOT_ACTIVE" });
    expect(statements).toEqual(["BEGIN", "SELECT id,", "ROLLBACK"]);
  });
});

describe("PgDropshipWalletRepository funding method removal", () => {
  const archivedAt = new Date("2026-09-22T01:00:00.000Z");
  const removal = { vendorId: 10, fundingMethodId: 30, actorMemberId: "member-1", archivedAt };

  function makeFundingMethodRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 30,
      vendor_id: 10,
      rail: "stripe_ach",
      status: "active",
      provider_customer_id: "cus_1",
      provider_payment_method_id: "pm_bank",
      usdc_wallet_address: null,
      display_label: "Chase ending in 5990",
      is_default: true,
      metadata: { accountHolderType: "company" },
      created_at: archivedAt,
      updated_at: archivedAt,
      ...overrides,
    };
  }

  /** The facts the archive reads under the lock, answered by table. */
  function removalQuery(input: {
    method?: Record<string, unknown> | null;
    autoReload?: Record<string, unknown> | null;
    pendingFunding?: number;
    otherCards?: number;
    vendorStatus?: string | null;
    statements: string[];
    params: unknown[][];
  }) {
    return vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      input.statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (params) input.params.push(params);
      if (sqlText.includes("FROM dropship.dropship_funding_methods") && sqlText.includes("FOR UPDATE")) {
        expect(params).toEqual([30, 10]);
        return { rows: input.method === null ? [] : [input.method ?? makeFundingMethodRow()] };
      }
      if (sqlText.includes("FROM dropship.dropship_auto_reload_settings")) {
        return { rows: input.autoReload ? [input.autoReload] : [] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        expect(sqlText).toContain("AND status = 'pending'");
        expect(params).toEqual([10, 30]);
        return { rows: [{ count: input.pendingFunding ?? 0 }] };
      }
      if (sqlText.includes("COUNT(*)") && sqlText.includes("FROM dropship.dropship_funding_methods")) {
        expect(sqlText).toContain("AND id <> $2");
        expect(sqlText).toContain("AND rail = 'stripe_card'");
        expect(params).toEqual([10, 30]);
        return { rows: [{ count: input.otherCards ?? 0 }] };
      }
      if (sqlText.includes("FROM dropship.dropship_vendors")) {
        return { rows: input.vendorStatus === null ? [] : [{ status: input.vendorStatus ?? "active" }] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_funding_methods")) {
        return { rows: [makeFundingMethodRow({ status: "archived", is_default: false, metadata: { accountHolderType: "company", archivedAt: archivedAt.toISOString(), archivedByMemberId: "member-1" } })] };
      }
      return { rows: [] };
    });
  }

  it("archives the method, drops its default flag, and audits the member in one transaction", async () => {
    const statements: string[] = [];
    const params: unknown[][] = [];
    const query = removalQuery({ statements, params, autoReload: { id: 1, vendor_id: 10, funding_method_id: 99, enabled: true, minimum_balance_cents: "25000", max_single_reload_cents: null, top_up_amount_cents: null, payment_hold_timeout_minutes: 1440, created_at: archivedAt, updated_at: archivedAt } });

    const result = await new PgDropshipWalletRepository(makePool(query)).archiveFundingMethod(removal);

    expect(result.idempotentReplay).toBe(false);
    expect(result.fundingMethod).toMatchObject({ fundingMethodId: 30, status: "archived", isDefault: false, metadata: { archivedByMemberId: "member-1" } });
    expect(statements).toEqual(["BEGIN", "SELECT id,", "SELECT id,", "SELECT COUNT(*)::int", "SELECT COUNT(*)::int", "SELECT status", "UPDATE dropship.dropship_funding_methods", "INSERT INTO", "COMMIT"]);
    const update = params.find((entry) => entry.length === 4 && entry[0] === 30 && entry[1] === 10 && typeof entry[2] === "string");
    expect(update).toBeDefined();
    expect(JSON.parse(String(update?.[2]))).toEqual({ archivedAt: archivedAt.toISOString(), archivedByMemberId: "member-1" });
    expect(update?.[3]).toBe(archivedAt);
    const updateSql = String(query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE dropship.dropship_funding_methods"))?.[0]);
    expect(updateSql).toContain("SET status = 'archived'");
    expect(updateSql).toContain("is_default = false");
    expect(updateSql).toContain("AND status <> 'archived'");
    const audit = params.find((entry) => entry[1] === "dropship_funding_methods");
    expect(audit?.slice(0, 4)).toEqual([10, "dropship_funding_methods", "30", "funding_method_archived"]);
    expect(JSON.parse(String(audit?.[4]))).toEqual({ rail: "stripe_ach", previousStatus: "active", wasDefault: true, providerPaymentMethodId: "pm_bank" });
    expect(audit?.slice(6)).toEqual(["member", "member-1"]);
  });

  it("refuses the enabled autopay source and rolls back without touching the row", async () => {
    const statements: string[] = [];
    const query = removalQuery({ statements, params: [], autoReload: { id: 1, vendor_id: 10, funding_method_id: 30, enabled: true, minimum_balance_cents: "25000", max_single_reload_cents: null, top_up_amount_cents: null, payment_hold_timeout_minutes: 1440, created_at: archivedAt, updated_at: archivedAt } });

    await expect(new PgDropshipWalletRepository(makePool(query)).archiveFundingMethod(removal)).rejects.toMatchObject({
      code: "DROPSHIP_FUNDING_METHOD_IS_AUTO_RELOAD_SOURCE",
      context: { vendorId: 10, fundingMethodId: 30, classification: "permanent" },
    });
    expect(statements).not.toContain("UPDATE dropship.dropship_funding_methods");
    expect(statements).not.toContain("INSERT INTO");
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("refuses while a top-up from the method is pending, and the only card of a live vendor", async () => {
    const pending = removalQuery({ statements: [], params: [], pendingFunding: 1 });
    await expect(new PgDropshipWalletRepository(makePool(pending)).archiveFundingMethod(removal)).rejects.toMatchObject({
      code: "DROPSHIP_FUNDING_METHOD_HAS_PENDING_FUNDING",
      context: { pendingFundingCount: 1 },
    });

    const lastCard = removalQuery({ statements: [], params: [], method: makeFundingMethodRow({ rail: "stripe_card", provider_payment_method_id: "pm_card" }), otherCards: 0, vendorStatus: "active" });
    await expect(new PgDropshipWalletRepository(makePool(lastCard)).archiveFundingMethod(removal)).rejects.toMatchObject({
      code: "DROPSHIP_FUNDING_METHOD_IS_BACKUP_CARD",
      context: { vendorStatus: "active" },
    });
  });

  it("replays an archived method without writing, and reports a missing one as not found", async () => {
    const statements: string[] = [];
    const replay = removalQuery({ statements, params: [], method: makeFundingMethodRow({ status: "archived", is_default: false }) });
    const result = await new PgDropshipWalletRepository(makePool(replay)).archiveFundingMethod(removal);
    expect(result).toMatchObject({ idempotentReplay: true, fundingMethod: { fundingMethodId: 30, status: "archived" } });
    expect(statements).not.toContain("UPDATE dropship.dropship_funding_methods");
    expect(statements.at(-1)).toBe("COMMIT");

    const missing = removalQuery({ statements: [], params: [], method: null });
    await expect(new PgDropshipWalletRepository(makePool(missing)).archiveFundingMethod(removal)).rejects.toMatchObject({
      code: "DROPSHIP_FUNDING_METHOD_NOT_FOUND",
    });
  });

  it("records the provider detach outcome on the archived method with its audit row", async () => {
    const statements: string[] = [];
    const recordedAt = new Date("2026-09-22T01:00:05.000Z");
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.startsWith("UPDATE dropship.dropship_funding_methods")) {
        expect(sqlText).toContain("AND status = 'archived'");
        expect(params?.slice(0, 2)).toEqual([30, 10]);
        expect(JSON.parse(String(params?.[2]))).toEqual({ providerDetach: { outcome: "pending", errorCode: "DROPSHIP_STRIPE_UNREACHABLE", recordedAt: recordedAt.toISOString() } });
        expect(params?.[3]).toBe(recordedAt);
        return { rows: [makeFundingMethodRow({ status: "archived", metadata: { providerDetach: { outcome: "pending", errorCode: "DROPSHIP_STRIPE_UNREACHABLE", recordedAt: recordedAt.toISOString() } } })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        expect(params?.slice(0, 4)).toEqual([10, "dropship_funding_methods", "30", "funding_method_provider_detach_recorded"]);
        expect(JSON.parse(String(params?.[4]))).toEqual({ outcome: "pending", errorCode: "DROPSHIP_STRIPE_UNREACHABLE" });
        expect(params?.slice(6)).toEqual(["system", null]);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const method = await new PgDropshipWalletRepository(makePool(query)).recordFundingMethodDetachOutcome({
      vendorId: 10, fundingMethodId: 30, outcome: "pending", errorCode: "DROPSHIP_STRIPE_UNREACHABLE", recordedAt,
    });

    expect(method).toMatchObject({ fundingMethodId: 30, status: "archived", metadata: { providerDetach: { outcome: "pending" } } });
    expect(statements).toEqual(["BEGIN", "UPDATE dropship.dropship_funding_methods", "INSERT INTO", "COMMIT"]);
  });

  it("refuses to record a detach outcome on a method that is not archived", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(new PgDropshipWalletRepository(makePool(query)).recordFundingMethodDetachOutcome({
      vendorId: 10, fundingMethodId: 30, outcome: "detached", errorCode: null, recordedAt: archivedAt,
    })).rejects.toMatchObject({ code: "DROPSHIP_FUNDING_METHOD_NOT_ARCHIVED" });
  });
});

describe("PgDropshipWalletRepository rewards (funding design phase 7)", () => {
  const credit = (overrides: Record<string, unknown> = {}) => ({
    vendorId: 10,
    walletAccountId: null,
    rail: "stripe_ach" as const,
    status: "settled" as const,
    amountCents: 4000,
    currency: "USD",
    referenceType: "stripe_payment_intent",
    referenceId: "pi_1",
    idempotencyKey: "stripe-funding:pi_1",
    requestHash: "hash-1",
    occurredAt,
    ...overrides,
  });

  /** A database with a wallet holding $10 cash and $0.50 of rewards, a bank rate of 1.5%, and no rows for this credit yet. */
  function rewardsDatabase(options: { rates?: Record<string, number> | null; earned?: Record<string, unknown> | null; policyTable?: boolean } = {}) {
    const statements: string[] = [];
    const updates: unknown[][] = [];
    const inserts: unknown[][] = [];
    const audits: string[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("to_regclass")) return { rows: [{ present: options.policyTable === false ? null : "dropship.dropship_wallet_policies" }] };
      if (sqlText.includes("FROM dropship.dropship_wallet_policies")) {
        return { rows: options.rates === null ? [] : [options.rates ?? { rewards_rate_bank_bps: 150, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0 }] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_accounts")) return { rows: [] };
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "0", rewards_balance_cents: "50" })] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        // The replay lookup is keyed by vendor; the accrual's lookup by the rewards reference.
        if (params?.[0] === "wallet_funding_rewards") return { rows: options.earned ? [makeLedgerRow(options.earned)] : [] };
        return { rows: [] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        updates.push(params ?? []);
        return { rows: [makeAccountRow({
          available_balance_cents: String(params?.[2]), pending_balance_cents: String(params?.[3]),
          rewards_balance_cents: params?.[5] === null || params?.[5] === undefined ? "50" : String(params?.[5]),
        })] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_ledger")) {
        inserts.push(params ?? []);
        return { rows: [makeLedgerRow({
          id: params?.[2] === "rewards_earned" ? 9 : 1, type: params?.[2], status: params?.[3], amount_cents: String(params?.[4]),
          rewards_balance_after_cents: params?.[16] ?? null, settled_at: params?.[15] ?? null,
        })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        audits.push(String(params?.[3]));
        return { rows: [] };
      }
      return { rows: [] };
    });
    return { statements, updates, inserts, audits, repository: new PgDropshipWalletRepository(makePool(query)) };
  }

  it("a settled bank credit earns rewards at the rate in force, rounded down, in the same transaction", async () => {
    const db = rewardsDatabase();

    const result = await db.repository.creditFunding(credit());

    expect(result.idempotentReplay).toBe(false);
    expect(result.ledgerEntry).toMatchObject({ type: "funding", status: "settled", amountCents: 4000 });
    // The account handed back carries the rewards the credit just earned: $0.50 + 1.5% of $40.
    expect(result.account.rewardsBalanceCents).toBe(110);
    expect(db.updates).toEqual([
      [5, 10, 5000, 0, occurredAt, null],
      [5, 10, 5000, 0, occurredAt, 110],
    ]);
    expect(db.inserts).toHaveLength(2);
    expect(db.inserts[1].slice(2, 11)).toEqual([
      "rewards_earned", "settled", 60, "USD", 5000, 0, "wallet_funding_rewards", "1", "rewards-earned:1",
    ]);
    expect(JSON.parse(String(db.inserts[1][13]))).toEqual({ fundingLedgerEntryId: 1, creditAmountCents: 4000, rateBps: 150, rail: "stripe_ach" });
    expect(db.inserts[1].slice(14)).toEqual([occurredAt, occurredAt, 110]);
    expect(db.audits).toEqual(["wallet_funding_settled", "wallet_rewards_earned"]);
    expect(db.statements.at(-1)).toBe("COMMIT");
  });

  it("a card credit earns nothing at the launch rate, and a pending credit nothing until it settles", async () => {
    const card = rewardsDatabase();
    await card.repository.creditFunding(credit({ rail: "stripe_card", referenceId: "pi_card", idempotencyKey: "stripe-funding:pi_card" }));
    expect(card.updates).toHaveLength(1);
    expect(card.inserts).toHaveLength(1);
    expect(card.audits).toEqual(["wallet_funding_settled"]);

    const pending = rewardsDatabase();
    await pending.repository.creditFunding(credit({ status: "pending" }));
    expect(pending.statements.some((statement) => statement.startsWith("SELECT to_regclass"))).toBe(false);
    expect(pending.audits).toEqual(["wallet_funding_pending"]);
  });

  it("uses the launch rates when no policy row exists, and posts no second accrual for a credit that already earned", async () => {
    const launch = rewardsDatabase({ rates: null });
    const result = await launch.repository.creditFunding(credit());
    expect(result.account.rewardsBalanceCents).toBe(90); // 1% of $40 on top of $0.50
    expect(launch.inserts[1][4]).toBe(40);

    const replay = rewardsDatabase({ earned: { id: 9, type: "rewards_earned", status: "settled", amount_cents: "60" } });
    await replay.repository.creditFunding(credit());
    expect(replay.updates).toHaveLength(1);
    expect(replay.inserts).toHaveLength(1);
    expect(replay.audits).toEqual(["wallet_funding_settled"]);
  });

  it("refuses a stored rate outside the ceiling instead of paying it out", async () => {
    const corrupt = rewardsDatabase({ rates: { rewards_rate_bank_bps: 5000, rewards_rate_usdc_bps: 100, rewards_rate_card_bps: 0 } });
    await expect(corrupt.repository.creditFunding(credit())).rejects.toMatchObject({ code: "DROPSHIP_WALLET_REWARDS_RATE_UNREADABLE" });
    expect(corrupt.statements.at(-1)).toBe("ROLLBACK");
  });

  it("a reversal takes back the rewards the credit earned: what is still in the balance leaves it, the rest comes out of cash", async () => {
    const statements: string[] = [];
    const inserts: unknown[][] = [];
    const audits: string[] = [];
    let update: unknown[] | null = null;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/)[0]);
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        if (params?.[0] === "stripe_payment_intent") {
          return { rows: [makeLedgerRow({ status: "settled", settled_at: occurredAt, available_balance_after_cents: "5000", pending_balance_after_cents: "0" })] };
        }
        if (params?.[0] === "wallet_funding_rewards") {
          return { rows: [makeLedgerRow({ id: 9, type: "rewards_earned", status: "settled", amount_cents: "40", reference_type: "wallet_funding_rewards", reference_id: "1", idempotency_key: "rewards-earned:1" })] };
        }
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "1000", pending_balance_cents: "4000", rewards_balance_cents: "15" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        update = params ?? [];
        return { rows: [makeAccountRow({ available_balance_cents: String(params?.[2]), pending_balance_cents: String(params?.[3]), rewards_balance_cents: String(params?.[5]) })] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_ledger")) {
        inserts.push(params ?? []);
        return { rows: [makeLedgerRow({ id: params?.[2] === "funding_reversal" ? 2 : 4, type: params?.[2], status: "settled", amount_cents: String(params?.[4]), rewards_balance_after_cents: params?.[16] ?? null })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        audits.push(String(params?.[3]));
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).reverseSettledFunding({
      provider: "stripe", providerPaymentIntentId: "pi_ach_1", providerDisputeId: "dp_1", providerEventId: "evt_dp_1",
      disputeAmountCents: 4000, currency: "USD", disputeStatus: "needs_response", disputeReason: "fraudulent", occurredAt, pauseVendor: null,
    });

    // $40 earned on the credit: $0.15 is still in the rewards balance, $0.25 was spent and comes out of cash with the $40.
    expect(update).toEqual([5, 10, -3025, 4000, occurredAt, 0]);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].slice(2, 5)).toEqual(["funding_reversal", "settled", -4025]);
    expect(JSON.parse(String(inserts[0][13])).rewardsClawback).toEqual({
      rewardsLedgerEntryId: 9, earnedCents: 40, clawbackCents: 40, fromRewardsCents: 15, fromCashCents: 25,
    });
    expect(inserts[0][16]).toBe(0);
    expect(inserts[1].slice(2, 11)).toEqual([
      "rewards_reversed", "settled", -15, "USD", -3025, 4000, "stripe_dispute_rewards", "dp_1", "stripe-dispute-rewards:dp_1",
    ]);
    expect(JSON.parse(String(inserts[1][13]))).toMatchObject({ reversalLedgerEntryId: 2, fundingLedgerEntryId: 1, rewardsLedgerEntryId: 9, clawbackCents: 40, fromCashCents: 25 });
    expect(audits).toEqual(["wallet_funding_reversed", "wallet_rewards_reversed"]);
    expect(result).toMatchObject({ outcome: "reversed", reversal: { ledgerEntryId: 2, amountCents: -4025 }, account: { availableBalanceCents: -3025, rewardsBalanceCents: 0 } });
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("a won dispute gives the rewards back with the cash, each on its own row", async () => {
    const inserts: unknown[][] = [];
    const audits: string[] = [];
    let update: unknown[] | null = null;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      if (sqlText.includes("FROM dropship.dropship_wallet_ledger")) {
        if (params?.[0] === "stripe_dispute") {
          return { rows: [makeLedgerRow({ id: 2, type: "funding_reversal", status: "settled", amount_cents: "-4025", reference_type: "stripe_dispute", reference_id: "dp_1", metadata: { fundingLedgerEntryId: 1 } })] };
        }
        if (params?.[0] === "stripe_dispute_rewards") {
          return { rows: [makeLedgerRow({ id: 4, type: "rewards_reversed", status: "settled", amount_cents: "-15", reference_type: "stripe_dispute_rewards", reference_id: "dp_1" })] };
        }
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) {
        return { rows: [makeAccountRow({ available_balance_cents: "-3025", pending_balance_cents: "4000", rewards_balance_cents: "0" })] };
      }
      if (sqlText.startsWith("UPDATE dropship.dropship_wallet_accounts")) {
        update = params ?? [];
        return { rows: [makeAccountRow({ available_balance_cents: String(params?.[2]), pending_balance_cents: String(params?.[3]), rewards_balance_cents: String(params?.[5]) })] };
      }
      if (sqlText.startsWith("INSERT INTO dropship.dropship_wallet_ledger")) {
        inserts.push(params ?? []);
        return { rows: [makeLedgerRow({ id: params?.[2] === "funding_reinstated" ? 3 : 5, type: params?.[2], status: "settled", amount_cents: String(params?.[4]) })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        audits.push(String(params?.[3]));
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipWalletRepository(makePool(query)).reinstateReversedFunding({
      provider: "stripe", providerDisputeId: "dp_1", providerEventId: "evt_dp_won", occurredAt,
    });

    expect(update).toEqual([5, 10, 1000, 4000, occurredAt, 15]);
    expect(inserts[0].slice(2, 5)).toEqual(["funding_reinstated", "settled", 4025]);
    expect(inserts[0][16]).toBe(15);
    expect(inserts[1].slice(2, 11)).toEqual([
      "rewards_reinstated", "settled", 15, "USD", 1000, 4000, "stripe_dispute_rewards_reinstated", "dp_1", "stripe-dispute-rewards-reinstated:dp_1",
    ]);
    expect(JSON.parse(String(inserts[1][13]))).toMatchObject({ rewardsReversalLedgerEntryId: 4, reinstatementLedgerEntryId: 3 });
    expect(audits).toEqual(["wallet_funding_reinstated", "wallet_rewards_reinstated"]);
    expect(result).toMatchObject({ reinstatement: { ledgerEntryId: 3, amountCents: 4025 }, account: { availableBalanceCents: 1000, rewardsBalanceCents: 15 } });
  });

  it("saves the vendor's rewards spend preference on their settings row with its audit row, scaffolding the row first", async () => {
    const updatedAt = new Date("2026-09-24T12:00:00.000Z");
    const statements: string[] = [];
    const captured: { update: unknown[] | null; audit: unknown[] | null } = { update: null, audit: null };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const sqlText = String(sql);
      statements.push(sqlText.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sqlText.includes("FROM dropship.dropship_wallet_accounts")) return { rows: [makeAccountRow()] };
      if (sqlText.startsWith("UPDATE dropship.dropship_auto_reload_settings")) {
        captured.update = params ?? [];
        expect(sqlText).toContain("SET spend_rewards_first = $2");
        return { rows: [{
          id: 7, vendor_id: 10, funding_method_id: null, enabled: true, minimum_balance_cents: "5000", max_single_reload_cents: null,
          top_up_amount_cents: null, payment_hold_timeout_minutes: 2880, acknowledged_card_fee_bps: null, acknowledged_at: null,
          spend_rewards_first: params?.[1], created_at: updatedAt, updated_at: updatedAt,
        }] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        captured.audit = params ?? [];
        return { rows: [] };
      }
      return { rows: [] };
    });

    const setting = await new PgDropshipWalletRepository(makePool(query)).setRewardsSpendPreference({
      vendorId: 10, spendRewardsFirst: false, actorMemberId: "member-1", updatedAt,
    });

    expect(setting).toMatchObject({ autoReloadSettingId: 7, vendorId: 10, spendRewardsFirst: false });
    expect(captured.update).toEqual([10, false, updatedAt]);
    expect(captured.audit?.slice(0, 4)).toEqual([10, "dropship_auto_reload_settings", "7", "wallet_rewards_preference_saved"]);
    expect(JSON.parse(String(captured.audit?.[4]))).toEqual({ spendRewardsFirst: false });
    expect(captured.audit?.slice(6, 8)).toEqual(["member", "member-1"]);
    expect(statements).toEqual([
      "BEGIN",
      "INSERT INTO",
      "SELECT id,",
      "INSERT INTO",
      "UPDATE dropship.dropship_auto_reload_settings",
      "INSERT INTO",
      "COMMIT",
    ]);
  });
});
