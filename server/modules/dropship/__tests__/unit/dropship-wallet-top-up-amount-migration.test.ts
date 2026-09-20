import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(resolve(process.cwd(), "migrations/0690_dropship_wallet_top_up_amount.sql"), "utf8");
const schema = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");

describe("0690 dropship wallet top-up amount migration", () => {
  it("adds a nullable integer top-up amount, positive when set, and keeps every existing row valid", () => {
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS top_up_amount_cents bigint");
    expect(migrationSql).not.toMatch(/top_up_amount_cents\s+bigint\s+NOT NULL/i);
    expect(migrationSql).not.toMatch(/top_up_amount_cents\s+(numeric|decimal|real|double)/i);
    expect(migrationSql).toContain("DROP CONSTRAINT IF EXISTS dropship_auto_reload_top_up_chk");
    expect(migrationSql).toContain("CHECK (top_up_amount_cents IS NULL OR top_up_amount_cents > 0)");
  });

  it("keeps the Drizzle declaration in step with the column and its check", () => {
    expect(schema).toContain('bigint("top_up_amount_cents", { mode: "number" })');
    expect(schema).toContain('"dropship_auto_reload_top_up_chk"');
  });

  it("rewrites nothing: no balance, bound or minimum is touched", () => {
    expect(migrationSql).not.toMatch(/UPDATE\s+dropship\./i);
    expect(migrationSql).not.toMatch(/ALTER COLUMN\s+(max_single_reload_cents|minimum_balance_cents)/i);
    expect(migrationSql).not.toMatch(/DROP COLUMN/i);
  });
});
