import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/168_purchase_forecast_overlay_contributions.sql"),
  "utf8",
);

describe("purchase forecast overlay contribution migration", () => {
  it("marks legacy observations as incomplete and requires coherent capture state", () => {
    expect(migration).toContain("ADD COLUMN overlay_capture_version INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("ADD COLUMN overlay_capture_complete BOOLEAN NOT NULL DEFAULT FALSE");
    expect(migration).toContain("purchase_forecast_observations_overlay_capture_chk");
  });

  it("creates immutable event-line evidence without mutable source foreign keys", () => {
    expect(migration).toContain("CREATE TABLE procurement.purchase_forecast_overlay_contributions");
    expect(migration).toContain("UNIQUE (observation_id, demand_event_line_id)");
    expect(migration).toContain("demand_event_id INTEGER NOT NULL");
    expect(migration).toContain("demand_event_line_id INTEGER NOT NULL");
    expect(migration).not.toContain("REFERENCES procurement.demand_events");
    expect(migration).not.toContain("REFERENCES procurement.demand_event_lines");
    expect(migration).toContain("guard_purchase_recommendation_update");
    expect(migration).toContain("guard_purchasing_evidence_delete");
  });

  it("persists date attribution, confidence weight, and exact source versions", () => {
    expect(migration).toContain("event_start_date DATE NOT NULL");
    expect(migration).toContain("planning_as_of_date DATE NOT NULL");
    expect(migration).toContain("confidence_weight_percent INTEGER NOT NULL");
    expect(migration).toContain("weighted_pieces BIGINT NOT NULL");
    expect(migration).toContain("purchase_forecast_overlay_contributions_weighted_qty_chk");
    expect(migration).toContain("expected_pieces::BIGINT * confidence_weight_percent::BIGINT + 99");
    expect(migration).toContain("event_updated_at TIMESTAMPTZ NOT NULL");
    expect(migration).toContain("line_updated_at TIMESTAMPTZ NOT NULL");
  });
});
