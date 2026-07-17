import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/150_purchase_recommendation_run_automation.sql"),
  "utf8",
);

describe("purchase recommendation automation migration", () => {
  it("adds source provenance and source-scoped retry idempotency", () => {
    expect(migration).toContain("ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'manual'");
    expect(migration).toContain("ADD COLUMN source_run_key VARCHAR(160)");
    expect(migration).toContain("purchase_recommendation_runs_source_key_uidx");
    expect(migration).toContain("WHERE source_run_key IS NOT NULL");
    expect(migration).toContain("'auto_draft'");
  });
});

