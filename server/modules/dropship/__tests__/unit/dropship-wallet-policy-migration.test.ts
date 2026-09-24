import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0682_dropship_wallet_policy.sql"),
  "utf8",
);

describe("0681 dropship wallet policy migration", () => {
  it("creates the versioned policy table with integer-cents money columns", () => {
    expect(migrationSql).toContain(
      "CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_policies",
    );
    for (const column of [
      "version integer NOT NULL",
      "minimum_floor_cents bigint NOT NULL",
      "minimum_single_top_up_limit_cents bigint NOT NULL",
      "manual_top_up_minimum_cents bigint NOT NULL",
      "manual_top_up_maximum_cents bigint NOT NULL",
      "default_payment_hold_timeout_minutes integer NOT NULL",
      "hold_expiry_warning_minutes integer NOT NULL",
      "is_active boolean NOT NULL DEFAULT true",
      "change_note text",
      "created_at timestamptz NOT NULL DEFAULT now()",
      "created_by_actor_type varchar(40) NOT NULL",
      "created_by_actor_id varchar(255)",
    ]) {
      expect(migrationSql).toContain(column);
    }
    // Money is whole cents: nothing here may be numeric/float.
    expect(migrationSql).not.toMatch(/_cents\s+(numeric|decimal|real|double)/i);
  });

  it("expresses every invariant that SQL can express as a CHECK constraint", () => {
    expect(migrationSql).toContain("CHECK (version > 0)");
    expect(migrationSql).toContain("CHECK (minimum_floor_cents > 0)");
    expect(migrationSql).toContain("CHECK (minimum_single_top_up_limit_cents > 0)");
    expect(migrationSql).toContain("CHECK (manual_top_up_minimum_cents > 0)");
    expect(migrationSql).toContain("CHECK (manual_top_up_maximum_cents > 0)");
    expect(migrationSql).toContain(
      "CHECK (manual_top_up_minimum_cents <= manual_top_up_maximum_cents)",
    );
    expect(migrationSql).toContain(
      "CHECK (minimum_single_top_up_limit_cents >= minimum_floor_cents)",
    );
    expect(migrationSql).toContain(
      "CHECK (default_payment_hold_timeout_minutes BETWEEN 1 AND 43200)",
    );
    expect(migrationSql).toContain("hold_expiry_warning_minutes >= 1");
    expect(migrationSql).toContain(
      "AND hold_expiry_warning_minutes < default_payment_hold_timeout_minutes",
    );
    expect(migrationSql).toContain("CHECK (created_by_actor_type IN ('admin', 'system'))");
  });

  it("allows exactly one active row", () => {
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_policies_one_active_idx",
    );
    expect(migrationSql).toContain("ON dropship.dropship_wallet_policies((true))");
    expect(migrationSql).toContain("WHERE is_active;");
    expect(migrationSql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_policies_version_idx",
    );
  });

  it("keeps published versions immutable, allowing only retirement", () => {
    expect(migrationSql).toContain(
      "CREATE OR REPLACE FUNCTION dropship.dropship_wallet_policies_guard()",
    );
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_wallet_policies");
    expect(migrationSql).toContain(
      "dropship_wallet_policies is append-only: rows cannot be deleted",
    );
    expect(migrationSql).toContain(
      "dropship_wallet_policies is immutable: publish a new version instead of editing one",
    );
    expect(migrationSql).toContain("IF NOT (OLD.is_active AND NOT NEW.is_active) THEN");
    for (const column of [
      "NEW.version IS DISTINCT FROM OLD.version",
      "NEW.minimum_floor_cents IS DISTINCT FROM OLD.minimum_floor_cents",
      "NEW.minimum_single_top_up_limit_cents IS DISTINCT FROM OLD.minimum_single_top_up_limit_cents",
      "NEW.manual_top_up_minimum_cents IS DISTINCT FROM OLD.manual_top_up_minimum_cents",
      "NEW.manual_top_up_maximum_cents IS DISTINCT FROM OLD.manual_top_up_maximum_cents",
      "NEW.default_payment_hold_timeout_minutes IS DISTINCT FROM OLD.default_payment_hold_timeout_minutes",
      "NEW.hold_expiry_warning_minutes IS DISTINCT FROM OLD.hold_expiry_warning_minutes",
      "NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id",
    ]) {
      expect(migrationSql).toContain(column);
    }
  });

  it("seeds today's environment defaults as version 1 so deploy changes no behavior", () => {
    expect(migrationSql).toContain("SELECT 1, 5000, 10000, 1000, 500000, 2880, 120, true,");
    expect(migrationSql).toContain("WHERE NOT EXISTS (");
    expect(migrationSql).toContain("SELECT 1 FROM dropship.dropship_wallet_policies");
  });

  it("is re-runnable: every statement is guarded", () => {
    // The trigger function body is dollar-quoted and full of semicolons, so it
    // is collapsed before the statements are split apart.
    const statements = migrationSql
      .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
      .split(/;\s*$/m)
      .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      const guarded =
        /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE UNIQUE INDEX IF NOT EXISTS/i.test(statement)
        || /^CREATE INDEX IF NOT EXISTS/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION/i.test(statement)
        || /^DROP TRIGGER IF EXISTS/i.test(statement)
        // The trigger is dropped immediately above, so CREATE TRIGGER is safe.
        || /^CREATE TRIGGER dropship_wallet_policies_guard_trg/i.test(statement)
        // The seed is conditional on an empty table.
        || (/^INSERT INTO/i.test(statement) && /WHERE NOT EXISTS/i.test(statement))
        || /^COMMENT ON/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

const cardFeeMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0700_dropship_wallet_card_fee_policy.sql"),
  "utf8",
);

describe("0700 dropship wallet card fee policy migration", () => {
  it("adds the card fee (held at zero) and the card minimum deposit as policy columns, then drops their defaults", () => {
    for (const statement of [
      "ADD COLUMN IF NOT EXISTS card_funding_fee_bps integer NOT NULL DEFAULT 0",
      "ADD COLUMN IF NOT EXISTS card_funding_minimum_cents bigint NOT NULL DEFAULT 10000",
      "ALTER COLUMN card_funding_fee_bps DROP DEFAULT",
      "ALTER COLUMN card_funding_minimum_cents DROP DEFAULT",
    ]) {
      expect(cardFeeMigrationSql).toContain(statement);
    }
    expect(cardFeeMigrationSql).not.toMatch(/_cents\s+(numeric|decimal|real|double)/i);
  });

  it("expresses the invariants as CHECK constraints, mirroring the shared fee guard and the domain rule", () => {
    expect(cardFeeMigrationSql).toContain("CHECK (card_funding_fee_bps BETWEEN 0 AND 1000)");
    expect(cardFeeMigrationSql).toContain("CHECK (card_funding_minimum_cents > 0)");
    expect(cardFeeMigrationSql).toContain("CHECK (card_funding_minimum_cents <= manual_top_up_maximum_cents)");
    // The backfill runs before the range constraint, with the guard off for exactly that statement.
    expect(cardFeeMigrationSql.indexOf("SET card_funding_minimum_cents = manual_top_up_maximum_cents"))
      .toBeLessThan(cardFeeMigrationSql.indexOf("dropship_wallet_policies_card_minimum_range_chk"));
    expect(cardFeeMigrationSql).toContain("DISABLE TRIGGER dropship_wallet_policies_guard_trg");
    expect(cardFeeMigrationSql).toContain("ENABLE TRIGGER dropship_wallet_policies_guard_trg");
  });

  it("teaches the immutability guard the new columns", () => {
    expect(cardFeeMigrationSql).toContain("CREATE OR REPLACE FUNCTION dropship.dropship_wallet_policies_guard()");
    for (const column of [
      "NEW.card_funding_fee_bps IS DISTINCT FROM OLD.card_funding_fee_bps",
      "NEW.card_funding_minimum_cents IS DISTINCT FROM OLD.card_funding_minimum_cents",
      // Every earlier column stays guarded.
      "NEW.advance_fee_bps IS DISTINCT FROM OLD.advance_fee_bps",
      "NEW.tier_change_grace_days IS DISTINCT FROM OLD.tier_change_grace_days",
      "NEW.minimum_floor_cents IS DISTINCT FROM OLD.minimum_floor_cents",
    ]) {
      expect(cardFeeMigrationSql).toContain(column);
    }
  });

  it("stores the vendor's acknowledged rate on the settings row, both columns together, and backfills it from the audit trail", () => {
    expect(cardFeeMigrationSql).toContain("ADD COLUMN IF NOT EXISTS acknowledged_card_fee_bps integer");
    expect(cardFeeMigrationSql).toContain("ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz");
    expect(cardFeeMigrationSql).toContain("CHECK (acknowledged_card_fee_bps IS NULL OR acknowledged_card_fee_bps BETWEEN 0 AND 1000)");
    expect(cardFeeMigrationSql).toContain("CHECK ((acknowledged_card_fee_bps IS NULL) = (acknowledged_at IS NULL))");
    // The backfill takes the latest configure event per row, prefers the explicit acknowledgement, and never overwrites a stored one.
    expect(cardFeeMigrationSql).toContain("e.event_type = 'wallet_auto_reload_configured'");
    expect(cardFeeMigrationSql).toContain("NULLIF(e.payload->>'acknowledgedCardFeeBps', 'null')::integer");
    expect(cardFeeMigrationSql).toContain("NULLIF(e.payload->>'cardFundingFeeBps', 'null')::integer");
    expect(cardFeeMigrationSql).toContain("ORDER BY e.entity_id, e.created_at DESC, e.id DESC");
    expect(cardFeeMigrationSql).toContain("AND s.acknowledged_card_fee_bps IS NULL");
  });

  it("is re-runnable: every statement is guarded", () => {
    const statements = cardFeeMigrationSql
      .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
      .split(/;\s*$/m)
      .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
      .filter((statement) => statement.length > 0);
    const droppedConstraints = new Set<string>();
    for (const statement of statements) {
      const dropped = /DROP CONSTRAINT IF EXISTS (\w+)/i.exec(statement)?.[1];
      if (dropped) droppedConstraints.add(dropped);
      const added = /ADD CONSTRAINT (\w+)/i.exec(statement)?.[1];
      const guarded =
        /^ALTER TABLE [\w.]+\s+ADD COLUMN IF NOT EXISTS/i.test(statement)
        || /^ALTER TABLE [\w.]+\s+ALTER COLUMN \w+ DROP DEFAULT/i.test(statement)
        || /^ALTER TABLE [\w.]+\s+DROP CONSTRAINT IF EXISTS/i.test(statement)
        || /^ALTER TABLE [\w.]+\s+(DISABLE|ENABLE) TRIGGER dropship_wallet_policies_guard_trg/i.test(statement)
        // The backfills match no row on a re-run: the first only rows above the maximum, the second only rows still NULL.
        || (/^UPDATE dropship\.dropship_wallet_policies/i.test(statement) && /WHERE card_funding_minimum_cents > manual_top_up_maximum_cents/i.test(statement))
        || (/^UPDATE dropship\.dropship_auto_reload_settings/i.test(statement) && /acknowledged_card_fee_bps IS NULL/i.test(statement))
        // An ADD CONSTRAINT is safe only because the same constraint was dropped IF EXISTS before it.
        || (added !== undefined && droppedConstraints.has(added))
        || /^CREATE OR REPLACE FUNCTION/i.test(statement)
        || /^DROP TRIGGER IF EXISTS/i.test(statement)
        || /^CREATE TRIGGER dropship_wallet_policies_guard_trg/i.test(statement)
        || /^COMMENT ON/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});
