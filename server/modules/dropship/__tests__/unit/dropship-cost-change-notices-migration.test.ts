import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { costChangeEventTypeValues } from "../../../../../shared/dropship/cost-change-policy";
import { costChangeNoticeDecisions, costChangeNoticeKinds } from "../../domain/cost-change-notice";

const MIGRATION_FILE = "0712_dropship_cost_change_notices.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
const TABLE = "dropship.dropship_cost_change_notices";

describe("0712 dropship cost change notices migration", () => {
  it("is the only migration with its number", () => {
    expect(readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0712_"))).toEqual([MIGRATION_FILE]);
  });

  it("ties each decision to its log row, vendor, variant, entry and policy, once per log row", () => {
    const body = tableBody();
    expect(body).toContain("log_id bigint NOT NULL REFERENCES dropship.dropship_cost_change_log(id)");
    expect(body).toContain("vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)");
    expect(body).toContain("product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id)");
    expect(body).toContain("entry_id bigint NOT NULL REFERENCES dropship.dropship_cost_schedule_entries(id)");
    expect(body).toContain("policy_id integer REFERENCES dropship.dropship_cost_change_policies(id)");
    expect(body).not.toContain("ON DELETE CASCADE");
    expect(migrationSql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS dropship_cost_change_notices_log_idx\n  ON ${TABLE}(log_id);`);
  });

  it("mirrors the domain's decisions, kinds and event names as CHECK constraints", () => {
    const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
    expect(tableBody()).toContain(`CHECK (event_type IN (${list(costChangeEventTypeValues)}))`);
    expect(tableBody()).toContain(`CHECK (decision IN (${list(costChangeNoticeDecisions)}))`);
    expect(tableBody()).toContain(`CHECK (notice_kind IS NULL OR notice_kind IN (${list(costChangeNoticeKinds)}))`);
    expect(tableBody()).toContain("(decision = 'sent' AND notice_kind IS NOT NULL AND notice_event_type IS NOT NULL AND idempotency_key IS NOT NULL)");
    expect(tableBody()).toContain("OR (decision <> 'sent' AND notice_kind IS NULL AND notice_event_type IS NULL AND idempotency_key IS NULL)");
  });

  it("indexes sent notices per entry, so a lowered or withdrawn change knows whether its announcement went out", () => {
    expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS dropship_cost_change_notices_entry_idx\n  ON ${TABLE}(entry_id)\n  WHERE decision = 'sent';`);
  });

  it("never edits or deletes a decision, and is re-runnable", () => {
    expect(migrationSql).toContain(`BEFORE UPDATE OR DELETE ON ${TABLE}`);
    expect(migrationSql).toContain("dropship_cost_change_notices is append-only: rows cannot be updated or deleted");
    for (const statement of statements()) {
      const guarded = /^CREATE TABLE IF NOT EXISTS/i.test(statement)
        || /^CREATE (UNIQUE )?INDEX IF NOT EXISTS/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION/i.test(statement)
        || /^DROP TRIGGER IF EXISTS/i.test(statement)
        || /^CREATE TRIGGER dropship_cost_change_notices_guard_trg/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

function statements(): string[] {
  return migrationSql
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => statement.replace(/--[^\n]*/g, "").trim())
    .filter((statement) => statement.length > 0);
}

function tableBody(): string {
  const body = /CREATE TABLE IF NOT EXISTS dropship\.dropship_cost_change_notices \(([\s\S]*?)\n\);/.exec(migrationSql)?.[1];
  if (!body) throw new Error("CREATE TABLE body not found");
  return body;
}
