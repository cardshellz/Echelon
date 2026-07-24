import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STORAGE_SRC = readFileSync(
  resolve(__dirname, "../../procurement.storage.ts"),
  "utf8",
);

describe("forward demand columns in reorder analysis query", () => {
  it("selects confidence-weighted forward demand pieces", () => {
    expect(STORAGE_SRC).toMatch(/forward_demand_pieces/);
    expect(STORAGE_SRC).toMatch(/fwd\.weighted_pieces/);
  });

  it("selects raw forward demand pieces", () => {
    expect(STORAGE_SRC).toMatch(/forward_demand_raw_pieces/);
    expect(STORAGE_SRC).toMatch(/fwd\.raw_pieces/);
  });

  it("selects forward demand event count", () => {
    expect(STORAGE_SRC).toMatch(/forward_demand_event_count/);
    expect(STORAGE_SRC).toMatch(/fwd\.event_count/);
  });

  it("returns the exact event-line inputs used by the aggregate", () => {
    expect(STORAGE_SRC).toMatch(/forward_demand_contributions/);
    expect(STORAGE_SRC).toMatch(/JSONB_AGG/);
    expect(STORAGE_SRC).toMatch(/'demandEventLineId', contribution\.demand_event_line_id/);
    expect(STORAGE_SRC).toMatch(/'planningAsOfDate', contribution\.planning_as_of_date/);
    expect(STORAGE_SRC).toMatch(/'confidenceWeightPercent', contribution\.confidence_weight_percent/);
    expect(STORAGE_SRC).toMatch(/'weightedPieces', contribution\.weighted_pieces/);
    expect(STORAGE_SRC).toMatch(/de\.updated_at AS event_updated_at/);
    expect(STORAGE_SRC).toMatch(/del\.updated_at AS line_updated_at/);
  });

  it("returns parent coverage metadata even when no event lines qualify", () => {
    expect(STORAGE_SRC).toMatch(/CURRENT_DATE AS forward_demand_planning_as_of_date/);
    expect(STORAGE_SRC).toMatch(/forward_demand_horizon_days/);
    expect(STORAGE_SRC).toMatch(/forecastPolicy\.forwardDemandHorizonDays/);
  });

  it("joins demand_event_lines with confidence weighting", () => {
    expect(STORAGE_SRC).toMatch(/procurement\.demand_event_lines del/);
    expect(STORAGE_SRC).toMatch(/procurement\.demand_events de/);
    expect(STORAGE_SRC).toMatch(/CASE del\.confidence/);
    expect(STORAGE_SRC).toMatch(/forecastPolicy\.forwardDemandConfidenceWeights\.high/);
    expect(STORAGE_SRC).toMatch(/forecastPolicy\.forwardDemandConfidenceWeights\.medium/);
    expect(STORAGE_SRC).toMatch(/forecastPolicy\.forwardDemandConfidenceWeights\.low/);
    expect(STORAGE_SRC).toMatch(/del\.expected_pieces::bigint/);
    expect(STORAGE_SRC).toMatch(/\+ 99/);
    expect(STORAGE_SRC).toMatch(/\) \/ 100 AS weighted_pieces/);
  });

  it("filters to active/planned events within horizon", () => {
    expect(STORAGE_SRC).toMatch(/de\.status IN \('planned', 'active'\)/);
    expect(STORAGE_SRC).toMatch(/forecastPolicy\.forwardDemandHorizonDays/);
    expect(STORAGE_SRC).toMatch(/de\.end_date IS NULL OR de\.end_date >= CURRENT_DATE/);
  });
});
