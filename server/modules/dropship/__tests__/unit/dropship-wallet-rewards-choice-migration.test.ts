import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(resolve(process.cwd(), "migrations/0704_dropship_wallet_rewards_choice.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

/**
 * 0704: auto-apply is never a default. The choice column loses its NOT NULL
 * and its default of true; NULL means "not chosen yet" and reads as saved.
 */
describe("0704 dropship wallet rewards choice migration", () => {
  it("makes the choice nullable with no default, so auto-apply must be chosen", () => {
    expect(migrationSql).toContain("ALTER TABLE dropship.dropship_auto_reload_settings\n  ALTER COLUMN spend_rewards_first DROP NOT NULL;");
    expect(migrationSql).toContain("ALTER TABLE dropship.dropship_auto_reload_settings\n  ALTER COLUMN spend_rewards_first DROP DEFAULT;");
    expect(migrationSql).not.toMatch(/SET DEFAULT/i);
    expect(migrationSql).not.toMatch(/SET NOT NULL/i);
  });

  it("resets only the rows that carried the old default without a recorded choice", () => {
    const reset = migrationSql.slice(migrationSql.indexOf("UPDATE dropship.dropship_auto_reload_settings"), migrationSql.indexOf("COMMENT ON COLUMN"));
    expect(reset).toContain("SET spend_rewards_first = NULL");
    expect(reset).toContain("WHERE settings.spend_rewards_first IS NOT NULL");
    expect(reset).toContain("AND NOT EXISTS (");
    expect(reset).toContain("events.entity_type = 'dropship_auto_reload_settings'");
    expect(reset).toContain("events.event_type = 'wallet_rewards_preference_saved'");
    expect(reset).toContain("events.vendor_id = settings.vendor_id");
    // A recorded choice is never touched, whichever way it went.
    expect(reset).not.toMatch(/spend_rewards_first = (true|false)/);
  });

  it("keeps the Drizzle declaration in step: nullable, no default", () => {
    expect(schema).toContain('spendRewardsFirst: boolean("spend_rewards_first"),');
    expect(schema).not.toContain('boolean("spend_rewards_first").notNull()');
    expect(schema).not.toContain('boolean("spend_rewards_first").default(');
  });

  it("is re-runnable: the reset finds nothing the second time and every other statement is idempotent", () => {
    const statements = migrationSql
      .replace(/--[^\n]*/g, "")
      .replace(/'(?:[^']|'')*'/g, "'text'")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^ALTER TABLE[\s\S]*DROP NOT NULL$/);
    expect(statements[1]).toMatch(/^ALTER TABLE[\s\S]*DROP DEFAULT$/);
    expect(statements[2]).toMatch(/^UPDATE dropship\.dropship_auto_reload_settings/);
    expect(statements[2]).toContain("IS NOT NULL");
    expect(statements[3]).toMatch(/^COMMENT ON COLUMN/);
    expect(migrationSql).not.toMatch(/CREATE TABLE|DROP TABLE|DELETE FROM/i);
  });
});
