import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(resolve(process.cwd(), "migrations/0705_dropship_wallet_rewards_expiry.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

/** Every ledger kind after 0705, in constraint order: expired joins, the never-written coupon kind leaves. */
const LEDGER_KINDS = [
  "funding", "order_debit", "refund_credit", "return_credit", "return_fee",
  "insurance_pool_credit", "manual_adjustment", "advance_fee", "funding_reversal", "funding_reinstated",
  "rewards_earned", "rewards_spent", "rewards_reversed", "rewards_reinstated", "rewards_expired",
];

const POLICY_GUARD_COLUMNS = [
  "minimum_floor_cents", "case_tier_minimum_cents", "minimum_single_top_up_limit_cents",
  "manual_top_up_minimum_cents", "manual_top_up_maximum_cents", "default_payment_hold_timeout_minutes",
  "hold_expiry_warning_minutes", "advance_fee_bps", "advance_cap_cents", "tier_change_grace_days",
  "card_funding_fee_bps", "card_funding_minimum_cents",
  "rewards_rate_bank_bps", "rewards_rate_usdc_bps", "rewards_rate_card_bps", "rewards_expiry_days",
];

function section(start: string, end: string): string {
  const from = migrationSql.indexOf(start);
  const to = migrationSql.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return migrationSql.slice(from, to);
}

describe("0705 dropship wallet rewards expiry migration", () => {
  it("adds the expiry setting as a nullable policy column (NULL is never) under a ten-year bound", () => {
    expect(migrationSql).toContain("ALTER TABLE dropship.dropship_wallet_policies\n  ADD COLUMN IF NOT EXISTS rewards_expiry_days integer;");
    expect(migrationSql).toContain("CHECK (rewards_expiry_days IS NULL OR rewards_expiry_days BETWEEN 1 AND 3650)");
    // No default: a policy states its expiry, and every existing version reads as never.
    expect(migrationSql).not.toMatch(/rewards_expiry_days integer (NOT NULL|DEFAULT)/);
  });

  it("teaches the immutability guard every policy column, old and new", () => {
    const guard = section("CREATE OR REPLACE FUNCTION dropship.dropship_wallet_policies_guard()", "$$ LANGUAGE plpgsql;");
    for (const column of POLICY_GUARD_COLUMNS) {
      expect(guard).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(guard).toContain("IF NOT (OLD.is_active AND NOT NEW.is_active)");
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_policies");
  });

  it("swaps the coupon kind for the expiry kind, stopping loudly if a coupon row exists", () => {
    const precheck = section("DO $$", "END\n$$;");
    expect(precheck).toContain("IF EXISTS (SELECT 1 FROM dropship.dropship_wallet_ledger WHERE type = 'rewards_redeemed') THEN");
    expect(precheck).toContain("RAISE EXCEPTION 'migration 0705:");
    expect(migrationSql.indexOf("DO $$")).toBeLessThan(migrationSql.indexOf("DROP CONSTRAINT IF EXISTS dropship_wallet_ledger_type_chk"));
    expect(migrationSql).toContain(`CHECK (type IN (${LEDGER_KINDS.map((kind) => `'${kind}'`).join(",")}))`);
  });

  it("keeps the Drizzle declaration in step with the kinds and the two new tables", () => {
    expect(schema).toContain(`IN (${LEDGER_KINDS.map((kind) => `'${kind}'`).join(",")})`);
    expect(schema).toContain('"rewards_expired",');
    expect(schema).not.toContain('"rewards_redeemed"');
    expect(schema).toContain('export const dropshipWalletRewardsLots = dropshipSchema.table(\n  "dropship_wallet_rewards_lots",');
    expect(schema).toContain('export const dropshipWalletRewardsLotMovements = dropshipSchema.table(\n  "dropship_wallet_rewards_lot_movements",');
    for (const name of [
      "dropship_wallet_rewards_lots_origin_idx", "dropship_wallet_rewards_lots_opening_idx", "dropship_wallet_rewards_lots_account_idx",
      "dropship_wallet_rewards_lots_due_idx", "dropship_wallet_rewards_lots_source_chk", "dropship_wallet_rewards_lots_origin_chk",
      "dropship_wallet_rewards_lots_amount_chk", "dropship_wallet_rewards_lots_expiry_chk",
      "dropship_wallet_rewards_lot_movements_ledger_idx", "dropship_wallet_rewards_lot_movements_lot_idx",
      "dropship_wallet_rewards_lot_movements_reason_chk", "dropship_wallet_rewards_lot_movements_ledger_chk",
      "dropship_wallet_rewards_lot_movements_amount_chk",
    ]) {
      expect(schema, name).toContain(`"${name}"`);
      expect(migrationSql, name).toContain(name);
    }
  });

  it("gives each lot a source, an origin row for earned and restored lots, a bounded remainder, and an expiry only when earned", () => {
    const lots = section("CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_rewards_lots (", "\n);\n");
    expect(lots).toContain("CHECK (source IN ('earned','opening_balance','restored','reconciled'))");
    expect(lots).toContain("CHECK ((source IN ('earned','restored')) = (origin_ledger_entry_id IS NOT NULL))");
    expect(lots).toContain("CHECK (earned_cents > 0 AND remaining_cents >= 0 AND remaining_cents <= earned_cents)");
    expect(lots).toContain("(expires_at IS NULL) = (expiry_days IS NULL)");
    expect(lots).toContain("AND (expires_at IS NULL OR (source = 'earned' AND expires_at > earned_at))");
    // Financial history is never deleted: every reference restricts, none cascades.
    expect(lots.match(/ON DELETE RESTRICT/g)).toHaveLength(3);
    expect(lots).not.toMatch(/CASCADE/);
    expect(migrationSql).toContain("ON dropship.dropship_wallet_rewards_lots(wallet_account_id)\n  WHERE source = 'opening_balance';");
    expect(migrationSql).toContain("ON dropship.dropship_wallet_rewards_lots(expires_at)\n  WHERE remaining_cents > 0 AND expires_at IS NOT NULL;");
  });

  it("records every movement against its ledger row, or as a reconciliation, and refuses edits and deletes", () => {
    const movements = section("CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_rewards_lot_movements (", "\n);\n");
    expect(movements).toContain("CHECK (reason IN ('ledger','reconciliation'))");
    expect(movements).toContain("CHECK ((reason = 'ledger') = (ledger_entry_id IS NOT NULL))");
    expect(movements).toContain("CHECK (amount_cents <> 0)");
    expect(movements.match(/ON DELETE RESTRICT/g)).toHaveLength(2);
    expect(migrationSql).toContain("ON dropship.dropship_wallet_rewards_lot_movements(ledger_entry_id, lot_id)\n  WHERE ledger_entry_id IS NOT NULL;");
    const guard = section("CREATE OR REPLACE FUNCTION dropship.dropship_wallet_rewards_lot_movements_guard()", "$$;");
    expect(guard).toContain("RAISE EXCEPTION 'dropship wallet rewards lot movements are append-only'");
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_rewards_lot_movements");
  });

  it("backfills nothing: the first writer to touch an account opens its lot", () => {
    expect(migrationSql).not.toMatch(/INSERT\s+INTO/i);
    expect(migrationSql).not.toMatch(/UPDATE\s+dropship\./i);
  });

  it("is re-runnable: every statement is guarded", () => {
    const statements = migrationSql
      // A function replacement: in a replacement string "$$" collapses to "$".
      .replace(/\$\$[\s\S]*?\$\$/g, () => "$$body$$")
      .replace(/--[^\n]*/g, "")
      .replace(/'(?:[^']|'')*'/g, "'text'")
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
        || /DROP CONSTRAINT IF EXISTS/.test(statement)
        || (add !== null && dropped.has(add[1]))
        || /^COMMENT ON/.test(statement)
        || /^CREATE OR REPLACE FUNCTION/.test(statement)
        || /^DROP TRIGGER IF EXISTS/.test(statement)
        || /^CREATE TRIGGER/.test(statement)
        || /^CREATE TABLE IF NOT EXISTS/.test(statement)
        || /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(statement)
        || /^DO \$\$body\$\$/.test(statement);
      expect(guarded, statement).toBe(true);
    }
  });
});
