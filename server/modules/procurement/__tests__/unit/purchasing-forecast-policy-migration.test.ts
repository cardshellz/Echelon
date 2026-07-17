import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/149_purchasing_forecast_policy.sql"),
  "utf8",
);

describe("purchasing forecast policy migration", () => {
  it("persists every quantity-driving forecast and overlay control", () => {
    for (const column of [
      "purchasing_forecast_method",
      "purchasing_forecast_short_window_days",
      "velocity_lookback_days",
      "purchasing_forecast_long_window_days",
      "purchasing_forecast_seasonal_enabled",
      "purchasing_forecast_seasonal_window_days",
      "purchasing_forecast_weight_short",
      "purchasing_forecast_weight_standard",
      "purchasing_forecast_weight_long",
      "purchasing_forecast_weight_seasonal",
      "purchasing_forward_demand_enabled",
      "purchasing_forward_demand_horizon_days",
      "purchasing_forward_demand_high_weight",
      "purchasing_forward_demand_medium_weight",
      "purchasing_forward_demand_low_weight",
      "purchasing_automation_min_order_count",
      "purchasing_automation_min_active_days",
    ]) {
      expect(migration).toContain(column);
    }
  });

  it("guards methods, windows, weights, overlays, and automation samples in PostgreSQL", () => {
    expect(migration).toContain("warehouse_settings_purchasing_forecast_method_chk");
    expect(migration).toContain("warehouse_settings_purchasing_forecast_windows_chk");
    expect(migration).toContain("warehouse_settings_purchasing_forecast_weights_chk");
    expect(migration).toContain("warehouse_settings_purchasing_forward_demand_chk");
    expect(migration).toContain("warehouse_settings_purchasing_automation_sample_chk");
  });
});
