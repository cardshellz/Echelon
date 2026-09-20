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
