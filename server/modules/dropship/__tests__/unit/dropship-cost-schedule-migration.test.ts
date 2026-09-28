import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BASIS_POINTS_PER_WHOLE } from "../../../../../shared/dropship/cost-change-policy";
import { costScheduleEventTypes } from "../../domain/cost-schedule";

const MIGRATION_FILE = "0711_dropship_cost_schedule.sql";
// Git may check SQL out as CRLF on Windows; SQL assertions are platform-neutral.
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8").replace(/\r\n/g, "\n");

const ENTRIES = "dropship.dropship_cost_schedule_entries";
const LOG = "dropship.dropship_cost_change_log";
const STATE = "dropship.dropship_cost_detection_state";

/** Entry columns the detection worker may change after insert; every other column is frozen by the guard. */
const ENTRY_MUTABLE_COLUMNS = new Set(["unit_cost_cents", "withdrawn_at"]);

describe("0711 dropship cost schedule migration", () => {
  it("is the only migration with its number", () => {
    const sameNumber = readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0711_"));
    expect(sameNumber).toEqual([MIGRATION_FILE]);
  });

  it("keeps money in whole cents on every table", () => {
    expect(migrationSql).not.toMatch(/_cents\s+(numeric|decimal|real|double|integer)\b/i);
    for (const column of ["from_cents bigint", "unit_cost_cents bigint NOT NULL", "retail_price_cents bigint", "to_cents bigint"]) {
      expect(migrationSql).toContain(column);
    }
  });

  it("ties every entry and log row to its vendor, variant and policy version", () => {
    for (const table of [ENTRIES, LOG]) {
      const body = tableBody(table);
      expect(body).toContain("vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)");
      expect(body).toContain("product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id)");
      expect(body).toContain("policy_id integer REFERENCES dropship.dropship_cost_change_policies(id)");
      // Financial history never disappears with a vendor row.
      expect(body).not.toContain("ON DELETE CASCADE");
    }
    expect(tableBody(LOG)).toContain(`entry_id bigint NOT NULL REFERENCES ${ENTRIES}(id)`);
  });

  it("mirrors the domain's invariants as CHECK constraints on entries", () => {
    for (const check of [
      "CHECK (kind IN ('baseline', 'increase', 'decrease'))",
      "CHECK (unit_cost_cents > 0)",
      "(kind = 'baseline' AND from_cents IS NULL)",
      "OR (kind = 'increase' AND from_cents IS NOT NULL AND from_cents > 0 AND unit_cost_cents > from_cents)",
      "OR (kind = 'decrease' AND from_cents IS NOT NULL AND from_cents > 0 AND unit_cost_cents < from_cents)",
      "CHECK (effective_at >= observed_at)",
      "CHECK (cost_source IN ('variant_fixed_price', 'variant_percent', 'plan_percent', 'retail'))",
      "CHECK ((retail_price_cents IS NULL) = (discount_bps IS NULL))",
      `CHECK (discount_bps IS NULL OR discount_bps BETWEEN 0 AND ${BASIS_POINTS_PER_WHOLE})`,
      "CHECK (withdrawn_at IS NULL OR withdrawn_at >= observed_at)",
      "CHECK (recorded_by IN ('detection', 'acceptance'))",
    ]) {
      expect(tableBody(ENTRIES)).toContain(check);
    }
    expect(tableBody(LOG)).toContain("CHECK (recorded_by IN ('detection', 'acceptance'))");
    expect(tableBody(LOG)).toContain("recorded_by varchar(20) NOT NULL");
  });

  it("indexes the live schedule per vendor and variant, and everything due by a date", () => {
    expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS dropship_cost_schedule_entries_active_idx
  ON ${ENTRIES}(vendor_id, product_variant_id, effective_at)
  WHERE withdrawn_at IS NULL;`);
    expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS dropship_cost_schedule_entries_effective_idx
  ON ${ENTRIES}(effective_at)
  WHERE withdrawn_at IS NULL;`);
  });

  it("lets an entry only be withdrawn once or lowered while it is an announced increase, and never deleted", () => {
    expect(migrationSql).toContain(`BEFORE UPDATE OR DELETE ON ${ENTRIES}`);
    expect(migrationSql).toContain("dropship_cost_schedule_entries is append-only: rows cannot be deleted");
    const frozen = tableColumns(ENTRIES).filter((column) => !ENTRY_MUTABLE_COLUMNS.has(column));
    expect(frozen).toContain("from_cents");
    expect(frozen).toContain("effective_at");
    for (const column of frozen) {
      expect(migrationSql, column).toContain(`NEW.${column} IS DISTINCT FROM OLD.${column}`);
    }
    expect(migrationSql).toContain("IF OLD.withdrawn_at IS NOT NULL THEN");
    expect(migrationSql).toContain("IF NEW.unit_cost_cents IS DISTINCT FROM OLD.unit_cost_cents THEN");
    expect(migrationSql).toContain("IF OLD.kind <> 'increase' OR NEW.unit_cost_cents >= OLD.unit_cost_cents THEN");
  });

  it("records every event type the domain names, with amounts that match the event, and never edits the log", () => {
    const eventList = costScheduleEventTypes.map((event) => `'${event}'`).join(", ");
    expect(tableBody(LOG)).toContain(`CHECK (event_type IN (${eventList}))`);
    expect(tableBody(LOG)).toContain("(event_type = 'baseline' AND from_cents IS NULL AND to_cents IS NOT NULL AND to_cents > 0)");
    expect(tableBody(LOG)).toContain("OR (event_type = 'change_withdrawn' AND from_cents IS NOT NULL AND from_cents > 0 AND to_cents IS NULL)");
    expect(tableBody(LOG)).toContain(
      "OR (event_type NOT IN ('baseline', 'change_withdrawn') AND from_cents IS NOT NULL AND to_cents IS NOT NULL",
    );
    expect(tableBody(LOG)).toContain("AND from_cents > 0 AND to_cents > 0 AND to_cents <> from_cents)");
    expect(tableBody(LOG)).toContain("retail_driven boolean NOT NULL");
    expect(migrationSql).toContain(`BEFORE UPDATE OR DELETE ON ${LOG}`);
    expect(migrationSql).toContain("dropship_cost_change_log is append-only: rows cannot be updated or deleted");
  });

  it("keeps one detection state row with non-negative counters, seeded only into an empty table", () => {
    expect(tableBody(STATE)).toContain("CHECK (id = 1)");
    expect(tableBody(STATE)).toContain(
      "CHECK (pass_vendors_processed >= 0 AND pass_variants_read >= 0 AND pass_unavailable_readings >= 0 AND pass_changes_recorded >= 0)",
    );
    expect(tableBody(STATE)).toContain("CHECK (pass_number >= 0 AND (pass_completed_at IS NULL OR pass_started_at IS NOT NULL))");
    expect(migrationSql).toContain(`INSERT INTO ${STATE} (id)
SELECT 1
WHERE NOT EXISTS (SELECT 1 FROM ${STATE});`);
  });

  it("is re-runnable: every statement is guarded", () => {
    for (const statement of statements()) {
      const guarded =
        /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE INDEX IF NOT EXISTS/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION/i.test(statement)
        || /^DROP TRIGGER IF EXISTS/i.test(statement)
        // Each trigger is dropped immediately above, so CREATE TRIGGER is safe.
        || /^CREATE TRIGGER dropship_cost_(schedule_entries|change_log)_guard_trg/i.test(statement)
        || (/^INSERT INTO/i.test(statement) && /WHERE NOT EXISTS/i.test(statement));
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

/** The migration's statements, with the dollar-quoted trigger bodies collapsed and comments removed. */
function statements(): string[] {
  return migrationSql
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
    .filter((statement) => statement.length > 0);
}

function tableBody(table: string): string {
  const escaped = table.replace(/\./g, "\\.");
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${escaped} \\(([\\s\\S]*?)\\n\\);`).exec(migrationSql)?.[1];
  if (!body) throw new Error(`CREATE TABLE body not found for ${table}`);
  return body;
}

/** Column names declared in the CREATE TABLE, in order. */
function tableColumns(table: string): string[] {
  return tableBody(table)
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("CONSTRAINT") && !line.startsWith("CHECK") && !line.startsWith("OR ") && !line.startsWith("("))
    .map((line) => line.split(/\s+/)[0] ?? "")
    .filter((name) => /^[a-z_]+$/.test(name) && name !== "or");
}
