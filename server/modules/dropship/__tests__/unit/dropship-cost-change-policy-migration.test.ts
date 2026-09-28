import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASIS_POINTS_PER_WHOLE,
  DEFAULT_DROPSHIP_COST_CHANGE_POLICY,
  MAX_DETECTION_INTERVAL_MINUTES,
  MAX_INCREASE_NOTICE_DAYS,
  MAX_NOTICE_MINIMUM_CHANGE_CENTS,
  MIN_DETECTION_INTERVAL_MINUTES,
  belowCostListingActionValues,
  costDecreaseTimingValues,
  dropshipCostChangePolicySettingsSchema,
  rulePricedListingActionValues,
  type DropshipCostChangePolicySettings,
} from "../../../../../shared/dropship/cost-change-policy";

const MIGRATION_FILE = "0710_dropship_cost_change_policy.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");

/** The column behind each setting. The repository reads and writes the same names. */
const SETTING_COLUMNS: Record<keyof DropshipCostChangePolicySettings, string> = {
  increaseNoticeDays: "increase_notice_days",
  decreaseTiming: "decrease_timing",
  priceProtection: "price_protection",
  retailChangesGetNotice: "retail_changes_get_notice",
  notifyByEmail: "notify_by_email",
  notifyInPortal: "notify_in_portal",
  notifyOnDecrease: "notify_on_decrease",
  noticeMinimumChangeCents: "notice_minimum_change_cents",
  noticeMinimumChangeBps: "notice_minimum_change_bps",
  rulePricedListings: "rule_priced_listings",
  belowCostFixedListings: "below_cost_fixed_listings",
  detectionIntervalMinutes: "detection_interval_minutes",
};

/** Columns that change when a version is retired; every other column is frozen. */
const LIFECYCLE_COLUMNS = new Set(["is_active", "deactivated_at"]);

describe("0710 dropship cost change policy migration", () => {
  it("is the only migration with its number", () => {
    const sameNumber = readdirSync(resolve(process.cwd(), "migrations"))
      .filter((file) => file.startsWith("0710_"));
    expect(sameNumber).toEqual([MIGRATION_FILE]);
  });

  it("has a NOT NULL column for every setting in the shared schema, and no other setting", () => {
    expect(Object.keys(SETTING_COLUMNS).sort())
      .toEqual(Object.keys(dropshipCostChangePolicySettingsSchema.shape).sort());
    for (const column of Object.values(SETTING_COLUMNS)) {
      expect(migrationSql).toMatch(new RegExp(`\\n  ${column} (integer|boolean|varchar\\(\\d+\\)) NOT NULL,`));
    }
    // Money is whole cents: nothing here may be numeric/float.
    expect(migrationSql).not.toMatch(/_cents\s+(numeric|decimal|real|double)/i);
  });

  it("mirrors every range and choice in the shared schema as a CHECK constraint", () => {
    for (const check of [
      "CHECK (version > 0)",
      `CHECK (increase_notice_days BETWEEN 0 AND ${MAX_INCREASE_NOTICE_DAYS})`,
      `CHECK (notice_minimum_change_cents BETWEEN 0 AND ${MAX_NOTICE_MINIMUM_CHANGE_CENTS})`,
      `CHECK (notice_minimum_change_bps BETWEEN 0 AND ${BASIS_POINTS_PER_WHOLE})`,
      `CHECK (detection_interval_minutes BETWEEN ${MIN_DETECTION_INTERVAL_MINUTES} AND ${MAX_DETECTION_INTERVAL_MINUTES})`,
      `CHECK (decrease_timing IN (${sqlList(costDecreaseTimingValues)}))`,
      `CHECK (rule_priced_listings IN (${sqlList(rulePricedListingActionValues)}))`,
      `CHECK (below_cost_fixed_listings IN (${sqlList(belowCostListingActionValues)}))`,
      "CHECK (length(btrim(change_note)) BETWEEN 1 AND 1000)",
      "CHECK (created_by_actor_type IN ('admin', 'system'))",
      "CHECK ((is_active AND deactivated_at IS NULL) OR (NOT is_active AND deactivated_at IS NOT NULL))",
    ]) {
      expect(migrationSql).toContain(check);
    }
    // A change always says why.
    expect(migrationSql).toContain("change_note text NOT NULL,");
  });

  it("allows exactly one active row and unique versions", () => {
    expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_policies_one_active_idx");
    expect(migrationSql).toContain("ON dropship.dropship_cost_change_policies((true))");
    expect(migrationSql).toContain("WHERE is_active;");
    expect(migrationSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_policies_version_idx");
  });

  it("freezes every column of a published version except the retirement pair, and forbids delete", () => {
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE ON dropship.dropship_cost_change_policies");
    expect(migrationSql).toContain("dropship_cost_change_policies is append-only: rows cannot be deleted");
    expect(migrationSql).toContain("IF NOT (OLD.is_active AND NOT NEW.is_active) THEN");
    const frozen = tableColumns().filter((column) => !LIFECYCLE_COLUMNS.has(column));
    expect(frozen.length).toBeGreaterThan(Object.keys(SETTING_COLUMNS).length);
    for (const column of frozen) {
      expect(migrationSql, column).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
  });

  it("seeds version 1 with exactly the shared defaults, only into an empty table", () => {
    const seed = seededValues();
    expect(seed.version).toBe("1");
    expect(seed.is_active).toBe("true");
    expect(seed.created_by_actor_type).toBe("'system'");
    expect(seed.created_by_actor_id).toBe("'migration:0710'");
    for (const [setting, column] of Object.entries(SETTING_COLUMNS)) {
      const expected = DEFAULT_DROPSHIP_COST_CHANGE_POLICY[setting as keyof DropshipCostChangePolicySettings];
      expect(seed[column], column).toBe(typeof expected === "string" ? `'${expected}'` : String(expected));
    }
    expect(migrationSql).toContain("WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_cost_change_policies);");
  });

  it("is re-runnable: every statement is guarded", () => {
    for (const statement of statements()) {
      const guarded =
        /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE UNIQUE INDEX IF NOT EXISTS/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION/i.test(statement)
        || /^DROP TRIGGER IF EXISTS/i.test(statement)
        // The trigger is dropped immediately above, so CREATE TRIGGER is safe.
        || /^CREATE TRIGGER dropship_cost_change_policies_guard_trg/i.test(statement)
        // The seed is conditional on an empty table.
        || (/^INSERT INTO/i.test(statement) && /WHERE NOT EXISTS/i.test(statement));
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/** The migration's statements, with the dollar-quoted trigger body collapsed and comments removed. */
function statements(): string[] {
  return migrationSql
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
    .filter((statement) => statement.length > 0);
}

/** Column names declared in the CREATE TABLE, in order. */
function tableColumns(): string[] {
  const body = /CREATE TABLE IF NOT EXISTS dropship\.dropship_cost_change_policies \(([\s\S]*?)\n\);/.exec(migrationSql)?.[1];
  if (!body) throw new Error("CREATE TABLE body not found");
  return body
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("CONSTRAINT") && !line.startsWith("CHECK"))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((name) => /^[a-z_]+$/.test(name));
}

/** The seed INSERT as column -> SQL literal, pairing its column list with its SELECT list. */
function seededValues(): Record<string, string> {
  const seed = statements().find((statement) => statement.startsWith("INSERT INTO dropship.dropship_cost_change_policies"));
  if (!seed) throw new Error("seed INSERT not found");
  const match = /\(([\s\S]*?)\)\s*SELECT([\s\S]*?)WHERE NOT EXISTS/.exec(seed);
  if (!match) throw new Error("seed INSERT shape not recognized");
  const columns = match[1]!.split(",").map((column) => column.trim());
  const values = match[2]!.split(/,\s*\n/).map((value) => value.trim());
  expect(values).toHaveLength(columns.length);
  return Object.fromEntries(columns.map((column, index) => [column, values[index]!]));
}
