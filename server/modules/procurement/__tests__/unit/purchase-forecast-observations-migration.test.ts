import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/162_purchase_forecast_observations.sql"),
  "utf8",
);

describe("purchase forecast observations migration", () => {
  it("separates immutable full-population forecasts from sourcing requirements", () => {
    expect(migration).toContain("CREATE TABLE procurement.purchase_forecast_observations");
    expect(migration).toContain("UNIQUE (run_id, product_id, scope)");
    expect(migration).toContain("scope IN ('product_all_warehouses')");
    expect(migration).toContain("selected_receive_variant_id, product_id");
    expect(migration).toContain("REFERENCES catalog.product_variants(id, product_id)");
    expect(migration).toContain("forecast_daily_pieces_micros BIGINT NOT NULL");
    expect(migration).toContain("baseline_daily_pieces_micros BIGINT NOT NULL");
    expect(migration).toContain("guard_purchase_recommendation_update");
    expect(migration).toContain("guard_purchasing_evidence_delete");
    expect(migration).not.toContain("request_for_quotes");
    expect(migration).not.toContain("purchase_orders");
  });
});
