import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "migrations/150_automatic_rfq_draft_policy.sql"), "utf8");

describe("automatic RFQ draft policy migration", () => {
  it("defaults to manual draft-only automation with bounded policy values", () => {
    expect(migration).toContain("rfq_draft_automation_mode VARCHAR(30) NOT NULL DEFAULT 'manual'");
    expect(migration).toContain("rfq_draft_minimum_confidence VARCHAR(10) NOT NULL DEFAULT 'high'");
    expect(migration).toContain("rfq_draft_require_trusted_forecast BOOLEAN NOT NULL DEFAULT TRUE");
    expect(migration).toContain("rfq_draft_maximum_lines_per_run BETWEEN 1 AND 500");
    expect(migration).toContain("Automatic sending is intentionally unsupported");
  });
});
