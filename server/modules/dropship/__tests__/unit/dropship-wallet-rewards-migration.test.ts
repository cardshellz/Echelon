import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(resolve(process.cwd(), "migrations/0702_dropship_wallet_rewards.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

/** Every ledger kind after 0702, in constraint order: the rewards kinds are appended, nothing is dropped. */
const LEDGER_KINDS = [
  "funding", "order_debit", "refund_credit", "return_credit", "return_fee",
  "insurance_pool_credit", "manual_adjustment", "advance_fee", "funding_reversal", "funding_reinstated",
  "rewards_earned", "rewards_spent", "rewards_reversed", "rewards_reinstated", "rewards_redeemed",
];

const POLICY_GUARD_COLUMNS = [
  "minimum_floor_cents", "case_tier_minimum_cents", "minimum_single_top_up_limit_cents",
  "manual_top_up_minimum_cents", "manual_top_up_maximum_cents", "default_payment_hold_timeout_minutes",
  "hold_expiry_warning_minutes", "advance_fee_bps", "advance_cap_cents", "tier_change_grace_days",
  "card_funding_fee_bps", "card_funding_minimum_cents",
  "rewards_rate_bank_bps", "rewards_rate_usdc_bps", "rewards_rate_card_bps",
];

describe("0702 dropship wallet rewards migration", () => {
  it("adds the spend-only rewards balance with its lower bound", () => {
    expect(migrationSql).toContain(
      "ALTER TABLE dropship.dropship_wallet_accounts\n  ADD COLUMN IF NOT EXISTS rewards_balance_cents bigint NOT NULL DEFAULT 0;",
    );
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS dropship_wallet_rewards_chk");
    expect(migrationSql).toContain("CHECK (rewards_balance_cents >= 0)");
  });

  it("snapshots the rewards balance on ledger lines and appends the rewards kinds without dropping any", () => {
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS rewards_balance_after_cents bigint;");
    expect(migrationSql).toContain("CHECK (rewards_balance_after_cents IS NULL OR rewards_balance_after_cents >= 0)");
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk");
    expect(migrationSql).toContain(`CHECK (type IN (${LEDGER_KINDS.map((kind) => `'${kind}'`).join(",")}))`);
  });

  it("keeps the Drizzle declaration in step with the columns it added", () => {
    // The kinds' current list is 0705's to pin (it retired the coupon kind); the four 0702 kinds that stayed are still declared.
    for (const kind of ["rewards_earned", "rewards_spent", "rewards_reversed", "rewards_reinstated"]) {
      expect(schema).toContain(`"${kind}"`);
    }
    expect(schema).toContain('rewardsBalanceCents: bigint("rewards_balance_cents"');
    expect(schema).toContain('rewardsBalanceAfterCents: bigint("rewards_balance_after_cents"');
    // 0704 made the choice nullable with no default (auto-apply must be chosen); the column itself is still declared.
    expect(schema).toContain('spendRewardsFirst: boolean("spend_rewards_first")');
  });

  it("adds the three per-rail rates as policy columns under the 10% ceiling, then drops their defaults", () => {
    for (const [column, launch] of [
      ["rewards_rate_bank_bps", 100],
      ["rewards_rate_usdc_bps", 100],
      ["rewards_rate_card_bps", 0],
    ] as const) {
      expect(migrationSql).toContain(`ADD COLUMN IF NOT EXISTS ${column} integer NOT NULL DEFAULT ${launch};`);
      expect(migrationSql).toContain(`ALTER COLUMN ${column} DROP DEFAULT;`);
      expect(migrationSql).toContain(`CHECK (${column} BETWEEN 0 AND 1000)`);
    }
  });

  it("teaches the immutability guard every policy column, old and new", () => {
    const guard = migrationSql.slice(
      migrationSql.indexOf("CREATE OR REPLACE FUNCTION dropship.dropship_wallet_policies_guard()"),
      migrationSql.indexOf("$$ LANGUAGE plpgsql;"),
    );
    for (const column of POLICY_GUARD_COLUMNS) {
      expect(guard).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(guard).toContain("IF NOT (OLD.is_active AND NOT NEW.is_active)");
    expect(migrationSql).toContain("DROP TRIGGER IF EXISTS dropship_wallet_policies_guard_trg");
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_policies");
  });

  it("stores the vendor's spend preference with spend-first as the default", () => {
    expect(migrationSql).toContain(
      "ALTER TABLE dropship.dropship_auto_reload_settings\n  ADD COLUMN IF NOT EXISTS spend_rewards_first boolean NOT NULL DEFAULT true;",
    );
  });

  it("is re-runnable: every statement is guarded and no published number moves", () => {
    const withoutFunctionBody = migrationSql.replace(/\$\$[\s\S]*?\$\$/g, "$$body$$");
    // Comments and string literals go first: a semicolon inside either is
    // prose, not a statement boundary.
    const statements = withoutFunctionBody
      .replace(/--[^\n]*/g, "")
      .replace(/'[^']*'/g, "'text'")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    const dropped = new Set<string>();
    for (const statement of statements) {
      const drop = statement.match(/DROP CONSTRAINT IF EXISTS (\w+)/);
      if (drop) dropped.add(drop[1]);
    }
    for (const statement of statements) {
      const add = statement.match(/ADD CONSTRAINT (\w+)/);
      const guarded =
        /ADD COLUMN IF NOT EXISTS/.test(statement)
        || /DROP DEFAULT/.test(statement)
        || /DROP CONSTRAINT IF EXISTS/.test(statement)
        || (add !== null && dropped.has(add[1]))
        || /^COMMENT ON/.test(statement)
        || /^CREATE OR REPLACE FUNCTION/.test(statement)
        || /^DROP TRIGGER IF EXISTS/.test(statement)
        || /^CREATE TRIGGER/.test(statement);
      expect(guarded, statement).toBe(true);
    }
    expect(migrationSql).not.toMatch(/UPDATE\s+dropship\./i);
    expect(migrationSql).not.toMatch(/CREATE TABLE/i);
  });
});
