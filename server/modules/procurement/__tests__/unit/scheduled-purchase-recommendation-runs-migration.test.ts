import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/174_scheduled_purchase_recommendation_runs.sql"),
  "utf8",
);

describe("scheduled purchase recommendation runs migration", () => {
  it("adds the scheduled source without weakening the existing source allowlist", () => {
    expect(migration).toContain("DROP CONSTRAINT purchase_recommendation_runs_source_chk");
    expect(migration).toContain("CHECK (source IN ('manual', 'auto_draft', 'api', 'scheduled'))");
  });
});
