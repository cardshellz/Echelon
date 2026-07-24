import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/172_purchase_forecast_policy_cohorts.sql"),
  "utf8",
);

describe("purchase forecast policy cohort migration", () => {
  it("adds explicit policy capture evidence without relabeling legacy observations", () => {
    expect(migration).toContain("forecast_policy_capture_version INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("forecast_policy_fingerprint VARCHAR(64)");
    expect(migration).toContain("forecast_policy_snapshot JSONB");
    expect(migration).toContain("forecast_policy_capture_version = 0");
    expect(migration).toContain("forecast_policy_fingerprint IS NULL");
    expect(migration).toContain("forecast_policy_snapshot IS NULL");
  });

  it("requires canonical-looking evidence for version one captures and indexes cohorts", () => {
    expect(migration).toContain("forecast_policy_capture_version = 1");
    expect(migration).toContain("forecast_policy_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("jsonb_typeof(forecast_policy_snapshot) = 'object'");
    expect(migration).toContain("purchase_forecast_observations_policy_cohort_idx");
  });
});
