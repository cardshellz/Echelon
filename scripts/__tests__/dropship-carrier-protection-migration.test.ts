import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "migrations/128_dropship_carrier_protection_policies.sql"), "utf8");

describe("carrier-protection policy migration", () => {
  it("creates versioned policy and deterministic assignment tables", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_carrier_protection_policies");
    expect(sql).toContain("CONSTRAINT dropship_carrier_protection_policy_key_version_uq UNIQUE (policy_key, version)");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_carrier_protection_assignments");
    expect(sql).toContain("dropship_carrier_protection_assignment_match_idx");
  });

  it("extends carrier claims with immutable calculation snapshots", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS policy_snapshot jsonb");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS calculated_credit_cents bigint");
    expect(sql).toContain("CREATE TRIGGER dropship_carrier_claim_policy_snapshot_guard");
    expect(sql).toContain("carrier-claim policy snapshot is immutable");
  });

  it("enforces policy terms and financial bounds in the database", () => {
    expect(sql).toContain("merchandise_reimbursement_bps BETWEEN 0 AND 10000");
    expect(sql).toContain("approval_mode IN ('manual','automatic')");
    expect(sql).toContain("CREATE TRIGGER dropship_carrier_protection_policy_terms_guard");
  });
});
