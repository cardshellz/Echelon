import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0683_dropship_wallet_funding_tiers.sql"),
  "utf8",
);

describe("0683 dropship wallet funding tiers migration", () => {
  it("adds the four new policy columns as integer money, bps and days, then drops their defaults", () => {
    for (const column of [
      "ADD COLUMN IF NOT EXISTS case_tier_minimum_cents bigint NOT NULL DEFAULT 50000",
      "ADD COLUMN IF NOT EXISTS advance_fee_bps integer NOT NULL DEFAULT 100",
      "ADD COLUMN IF NOT EXISTS advance_cap_cents bigint NOT NULL DEFAULT 50000",
      "ADD COLUMN IF NOT EXISTS tier_change_grace_days integer NOT NULL DEFAULT 14",
      "ALTER COLUMN case_tier_minimum_cents DROP DEFAULT",
      "ALTER COLUMN advance_fee_bps DROP DEFAULT",
      "ALTER COLUMN advance_cap_cents DROP DEFAULT",
      "ALTER COLUMN tier_change_grace_days DROP DEFAULT",
    ]) {
      expect(migrationSql).toContain(column);
    }
    expect(migrationSql).not.toMatch(/_cents\s+(numeric|decimal|real|double)/i);
  });

  it("expresses every invariant SQL can express as a CHECK constraint", () => {
    expect(migrationSql).toContain("CHECK (case_tier_minimum_cents >= minimum_floor_cents)");
    expect(migrationSql).toContain("CHECK (advance_fee_bps BETWEEN 0 AND 10000)");
    expect(migrationSql).toContain("CHECK (advance_cap_cents >= 0)");
    expect(migrationSql).toContain("CHECK (tier_change_grace_days BETWEEN 0 AND 365)");
    expect(migrationSql).toContain(
      "CHECK (advance_cap_override_cents IS NULL OR advance_cap_override_cents >= 0)",
    );
    expect(migrationSql).toContain("CHECK (updated_by_actor_type IN ('admin', 'system'))");
  });

  it("backfills a case tier below a published pack floor before adding the invariant, with the guard off only for that statement", () => {
    const disable = migrationSql.indexOf("DISABLE TRIGGER dropship_wallet_policies_guard_trg");
    const backfill = migrationSql.indexOf("SET case_tier_minimum_cents = minimum_floor_cents\nWHERE case_tier_minimum_cents < minimum_floor_cents");
    const enable = migrationSql.indexOf("ENABLE TRIGGER dropship_wallet_policies_guard_trg");
    const constraint = migrationSql.indexOf("ADD CONSTRAINT dropship_wallet_policies_case_tier_chk");
    expect(disable).toBeGreaterThan(0);
    expect(backfill).toBeGreaterThan(disable);
    expect(enable).toBeGreaterThan(backfill);
    expect(constraint).toBeGreaterThan(enable);
    // The only UPDATE that touches a policy row's limits is that backfill.
    const updates = migrationSql.match(/UPDATE dropship\.dropship_wallet_policies[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(2);
    expect(updates.filter((statement) => statement.includes("case_tier_minimum_cents"))).toHaveLength(1);
  });

  it("teaches the immutability guard every new column", () => {
    expect(migrationSql).toContain(
      "CREATE OR REPLACE FUNCTION dropship.dropship_wallet_policies_guard()",
    );
    for (const column of [
      "NEW.case_tier_minimum_cents IS DISTINCT FROM OLD.case_tier_minimum_cents",
      "NEW.advance_fee_bps IS DISTINCT FROM OLD.advance_fee_bps",
      "NEW.advance_cap_cents IS DISTINCT FROM OLD.advance_cap_cents",
      "NEW.tier_change_grace_days IS DISTINCT FROM OLD.tier_change_grace_days",
      // The original columns stay guarded too.
      "NEW.minimum_floor_cents IS DISTINCT FROM OLD.minimum_floor_cents",
      "NEW.hold_expiry_warning_minutes IS DISTINCT FROM OLD.hold_expiry_warning_minutes",
    ]) {
      expect(migrationSql).toContain(column);
    }
    expect(migrationSql).toContain("IF NOT (OLD.is_active AND NOT NEW.is_active) THEN");
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_policies");
  });

  it("publishes the launch values as version 2 only over the system-seeded version 1", () => {
    // Retire v1 only while it is the active row and nothing later exists.
    expect(migrationSql).toContain("SET is_active = false, deactivated_at = now()");
    expect(migrationSql).toContain("AND version = 1");
    expect(migrationSql).toContain("AND created_by_actor_type = 'system'");
    expect(migrationSql).toContain("SELECT 1 FROM dropship.dropship_wallet_policies WHERE version >= 2");
    // pack $100, case $500, top-up limit $100, manual $10-$5000, 24h hold,
    // 2h warning, 1% advance fee, $500 advance cap, 14-day grace.
    expect(migrationSql).toContain(
      "SELECT 2, 10000, 50000, 10000, 1000, 500000, 1440, 120, 100, 50000, 14, true,",
    );
    // Never a second active row, never over a staff-published version.
    expect(migrationSql).toContain("SELECT 1 FROM dropship.dropship_wallet_policies WHERE is_active = true");
    expect(migrationSql).toContain("WHERE version = 1 AND created_by_actor_type = 'system' AND NOT is_active");
  });

  it("moves the vendor auto-reload hold default to 24 hours without rewriting vendor rows", () => {
    expect(migrationSql).toContain(
      "ALTER COLUMN payment_hold_timeout_minutes SET DEFAULT 1440",
    );
    expect(migrationSql).not.toMatch(/UPDATE dropship\.dropship_auto_reload_settings/);
  });

  it("creates the per-vendor credit profile stub with one row per vendor", () => {
    expect(migrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_credit_profiles",
    );
    expect(migrationSql).toContain(
      "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE",
    );
    expect(migrationSql).toContain("advance_cap_override_cents bigint,");
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS dropship_vendor_credit_profiles_vendor_idx",
    );
  });

  it("is re-runnable: every statement is guarded", () => {
    const statements = migrationSql
      .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
      .split(/;\s*$/m)
      .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
      .filter((statement) => statement.length > 0);
    const addedConstraints = new Set<string>();
    for (const statement of statements) {
      const droppedConstraint = /DROP CONSTRAINT IF EXISTS (\w+)/i.exec(statement)?.[1];
      if (droppedConstraint) addedConstraints.add(droppedConstraint);
      const addedConstraint = /ADD CONSTRAINT (\w+)/i.exec(statement)?.[1];
      const guarded =
        /^ALTER TABLE [\w.]+\s+ADD COLUMN IF NOT EXISTS/i.test(statement)
        || /^ALTER TABLE [\w.]+\s+ALTER COLUMN \w+ (DROP|SET) DEFAULT/i.test(statement)
        || /^ALTER TABLE [\w.]+\s+DROP CONSTRAINT IF EXISTS/i.test(statement)
        // Guard off and on around the one backfill, which matches no row on a re-run.
        || /^ALTER TABLE [\w.]+\s+(DISABLE|ENABLE) TRIGGER dropship_wallet_policies_guard_trg/i.test(statement)
        || (/^UPDATE dropship\.dropship_wallet_policies/i.test(statement) && /WHERE case_tier_minimum_cents < minimum_floor_cents/i.test(statement))
        // An ADD CONSTRAINT is safe only because the same constraint was
        // dropped IF EXISTS immediately before it.
        || (addedConstraint !== undefined && addedConstraints.has(addedConstraint))
        || /^CREATE OR REPLACE FUNCTION/i.test(statement)
        || /^DROP TRIGGER IF EXISTS/i.test(statement)
        || /^CREATE TRIGGER dropship_wallet_policies_guard_trg/i.test(statement)
        || (/^UPDATE dropship\.dropship_wallet_policies/i.test(statement) && /NOT EXISTS/i.test(statement))
        || (/^INSERT INTO/i.test(statement) && /WHERE NOT EXISTS/i.test(statement))
        || /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE UNIQUE INDEX IF NOT EXISTS/i.test(statement)
        || /^COMMENT ON/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});
