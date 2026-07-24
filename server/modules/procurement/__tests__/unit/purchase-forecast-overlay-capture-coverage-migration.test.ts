import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/169_purchase_forecast_overlay_capture_coverage.sql"),
  "utf8",
);

describe("purchase forecast overlay capture coverage migration", () => {
  it("adds parent planning-date and horizon metadata", () => {
    expect(migration).toContain("ADD COLUMN overlay_planning_as_of_date DATE");
    expect(migration).toContain("ADD COLUMN overlay_horizon_days INTEGER");
  });

  it("keeps legacy version 1 captures valid but requires coverage from version 2", () => {
    expect(migration).toContain("overlay_capture_version = 1");
    expect(migration).toContain("overlay_capture_version >= 2");
    expect(migration).toContain("overlay_horizon_days BETWEEN 1 AND 365");
    expect(migration).toContain("overlay_planning_as_of_date IS NOT NULL");
  });
});
