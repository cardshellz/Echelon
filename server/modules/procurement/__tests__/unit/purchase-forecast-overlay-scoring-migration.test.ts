import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/170_purchase_forecast_overlay_scoring.sql"),
  "utf8",
);

describe("purchase forecast overlay scoring migration", () => {
  it("adds nullable overlay-adjusted metrics with explicit eligibility", () => {
    expect(migration).toContain("ADD COLUMN overlay_attribution_version INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("ADD COLUMN overlay_evaluable BOOLEAN NOT NULL DEFAULT FALSE");
    expect(migration).toContain("ADD COLUMN overlay_exclusion_reason VARCHAR(64) DEFAULT 'legacy_evaluation'");
    expect(migration).toContain("ADD COLUMN overlay_weighted_demand_pieces BIGINT");
    expect(migration).toContain("ADD COLUMN overlay_adjusted_forecast_demand_micros BIGINT");
    expect(migration).toContain("ADD COLUMN overlay_adjusted_absolute_error_micros BIGINT");
  });

  it("enforces coherent evaluable and excluded states", () => {
    expect(migration).toContain("purchase_forecast_evaluations_overlay_scoring_chk");
    expect(migration).toContain("overlay_evaluable = FALSE");
    expect(migration).toContain("overlay_contribution_count IS NULL");
    expect(migration).toContain("overlay_evaluable = TRUE");
    expect(migration).toContain("overlay_attribution_version > 0");
    expect(migration).toContain("overlay_exclusion_reason IS NULL");
  });

  it("constrains the persisted adjusted prediction, bias, and absolute error arithmetic", () => {
    expect(migration).toContain("forecast_demand_micros + overlay_weighted_demand_pieces * 1000000");
    expect(migration).toContain(
      "overlay_adjusted_forecast_demand_micros - actual_demand_pieces * 1000000",
    );
    expect(migration).toContain(
      "overlay_adjusted_absolute_error_micros = ABS(overlay_adjusted_bias_micros)",
    );
  });
});
