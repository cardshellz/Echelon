import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/163_purchase_forecast_evaluations.sql"),
  "utf8",
);

describe("purchase forecast evaluations migration", () => {
  it("creates immutable, versioned horizon evaluations", () => {
    expect(migration).toContain("CREATE TABLE procurement.purchase_forecast_evaluations");
    expect(migration).toContain("UNIQUE (observation_id, horizon_days, evaluation_version)");
    expect(migration).toContain("CHECK (horizon_days IN (7, 30, 90))");
    expect(migration).toContain("observed_through_exclusive > observed_from");
    expect(migration).toContain("purchase_forecast_evaluations_update_guard_trg");
    expect(migration).toContain("purchase_forecast_evaluations_delete_guard_trg");
  });

  it("stores actuals and errors as integer pieces or micro-pieces", () => {
    expect(migration).toContain("actual_demand_pieces BIGINT NOT NULL");
    expect(migration).toContain("forecast_demand_micros BIGINT NOT NULL");
    expect(migration).toContain("baseline_demand_micros BIGINT NOT NULL");
    expect(migration).toContain("forecast_absolute_error_micros BIGINT NOT NULL");
    expect(migration).toContain("baseline_absolute_error_micros BIGINT NOT NULL");
  });
});
