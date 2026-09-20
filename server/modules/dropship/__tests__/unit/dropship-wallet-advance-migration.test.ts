import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(resolve(process.cwd(), "migrations/0686_dropship_wallet_advance.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

describe("0686 dropship wallet advance migration", () => {
  it("adds the advance fee ledger kind without dropping any existing kind", () => {
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk");
    for (const kind of [
      "'funding'", "'order_debit'", "'refund_credit'", "'return_credit'",
      "'return_fee'", "'insurance_pool_credit'", "'manual_adjustment'", "'advance_fee'",
    ]) {
      expect(migrationSql).toContain(kind);
    }
    expect(schema).toContain('"advance_fee"');
    expect(schema).toContain("'manual_adjustment','advance_fee'");
  });

  it("records bank balance reads append-only, in integer minor units, one row per provider event", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_funding_method_balance_verifications");
    expect(migrationSql).toContain("available_cents bigint");
    expect(migrationSql).not.toMatch(/available_cents\s+(numeric|decimal|real|double)/i);
    expect(migrationSql).toContain("CHECK (status IN ('succeeded', 'pending', 'failed'))");
    expect(migrationSql).toContain("CHECK (source IN ('link', 'refresh', 'webhook'))");
    expect(migrationSql).toContain("OR (available_cents IS NOT NULL AND currency IS NOT NULL AND balance_as_of IS NOT NULL)");
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_funding_method_balance_verifications");
    expect(migrationSql).toContain("ON dropship.dropship_funding_method_balance_verifications (provider, provider_event_id)");
    expect(migrationSql).toContain("WHERE provider_event_id IS NOT NULL");
    expect(schema).toContain('"dropship_funding_method_balance_verifications"');
    expect(schema).toContain("dropshipFundingMethodBalanceVerifications");
  });

  it("never touches the balance lower bound: negative balances stay allowed since migration 191", () => {
    expect(migrationSql).not.toMatch(/available_balance_cents\s*>=\s*0/);
    expect(migrationSql).not.toMatch(/UPDATE\s+dropship\.dropship_wallet_accounts/i);
    expect(schema).not.toContain("dropship_wallet_available_chk");
    expect(schema).not.toContain("dropship_wallet_ledger_balance_chk");
  });
});
