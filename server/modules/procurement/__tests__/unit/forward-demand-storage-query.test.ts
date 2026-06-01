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

  it("joins demand_event_lines with confidence weighting", () => {
    expect(STORAGE_SRC).toMatch(/procurement\.demand_event_lines del/);
    expect(STORAGE_SRC).toMatch(/procurement\.demand_events de/);
    expect(STORAGE_SRC).toMatch(/CASE del\.confidence/);
    expect(STORAGE_SRC).toMatch(/WHEN 'high'\s+THEN del\.expected_pieces/);
    expect(STORAGE_SRC).toMatch(/WHEN 'medium'\s+THEN CEIL\(del\.expected_pieces \* 0\.7\)/);
    expect(STORAGE_SRC).toMatch(/WHEN 'low'\s+THEN CEIL\(del\.expected_pieces \* 0\.4\)/);
  });

  it("filters to active/planned events within horizon", () => {
    expect(STORAGE_SRC).toMatch(/de\.status IN \('planned', 'active'\)/);
    expect(STORAGE_SRC).toMatch(/de\.end_date IS NULL OR de\.end_date >= CURRENT_DATE/);
  });
});
