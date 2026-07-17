ALTER TABLE inventory.warehouse_settings
  ADD COLUMN IF NOT EXISTS purchasing_forecast_method VARCHAR(30) NOT NULL DEFAULT 'weighted_blend_v1',
  ADD COLUMN IF NOT EXISTS purchasing_forecast_short_window_days INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS purchasing_forecast_long_window_days INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS purchasing_forecast_seasonal_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS purchasing_forecast_seasonal_window_days INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS purchasing_forecast_weight_short INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS purchasing_forecast_weight_standard INTEGER NOT NULL DEFAULT 35,
  ADD COLUMN IF NOT EXISTS purchasing_forecast_weight_long INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS purchasing_forecast_weight_seasonal INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS purchasing_forward_demand_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS purchasing_forward_demand_horizon_days INTEGER NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS purchasing_forward_demand_high_weight INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS purchasing_forward_demand_medium_weight INTEGER NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS purchasing_forward_demand_low_weight INTEGER NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS purchasing_automation_min_order_count INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS purchasing_automation_min_active_days INTEGER NOT NULL DEFAULT 2;

UPDATE inventory.warehouse_settings
SET velocity_lookback_days = LEAST(180, GREATEST(7, COALESCE(velocity_lookback_days, 30)));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_settings_purchasing_forecast_method_chk' AND conrelid = 'inventory.warehouse_settings'::regclass) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_purchasing_forecast_method_chk
      CHECK (purchasing_forecast_method IN ('recent_order_velocity_v1', 'weighted_blend_v1'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_settings_purchasing_forecast_windows_chk' AND conrelid = 'inventory.warehouse_settings'::regclass) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_purchasing_forecast_windows_chk
      CHECK (
        purchasing_forecast_short_window_days BETWEEN 1 AND 60
        AND velocity_lookback_days BETWEEN 7 AND 180
        AND purchasing_forecast_long_window_days BETWEEN 30 AND 730
        AND purchasing_forecast_seasonal_window_days BETWEEN 7 AND 120
        AND purchasing_forecast_short_window_days <= velocity_lookback_days
        AND velocity_lookback_days <= purchasing_forecast_long_window_days
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_settings_purchasing_forecast_weights_chk' AND conrelid = 'inventory.warehouse_settings'::regclass) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_purchasing_forecast_weights_chk
      CHECK (
        purchasing_forecast_weight_short BETWEEN 0 AND 100
        AND purchasing_forecast_weight_standard BETWEEN 0 AND 100
        AND purchasing_forecast_weight_long BETWEEN 0 AND 100
        AND purchasing_forecast_weight_seasonal BETWEEN 0 AND 100
        AND purchasing_forecast_weight_short + purchasing_forecast_weight_standard
          + purchasing_forecast_weight_long + purchasing_forecast_weight_seasonal = 100
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_settings_purchasing_forward_demand_chk' AND conrelid = 'inventory.warehouse_settings'::regclass) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_purchasing_forward_demand_chk
      CHECK (
        purchasing_forward_demand_horizon_days BETWEEN 1 AND 365
        AND purchasing_forward_demand_high_weight BETWEEN 0 AND 100
        AND purchasing_forward_demand_medium_weight BETWEEN 0 AND 100
        AND purchasing_forward_demand_low_weight BETWEEN 0 AND 100
        AND purchasing_forward_demand_high_weight >= purchasing_forward_demand_medium_weight
        AND purchasing_forward_demand_medium_weight >= purchasing_forward_demand_low_weight
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_settings_purchasing_automation_sample_chk' AND conrelid = 'inventory.warehouse_settings'::regclass) THEN
    ALTER TABLE inventory.warehouse_settings
      ADD CONSTRAINT warehouse_settings_purchasing_automation_sample_chk
      CHECK (
        purchasing_automation_min_order_count BETWEEN 1 AND 100
        AND purchasing_automation_min_active_days BETWEEN 1 AND 100
        AND purchasing_automation_min_active_days <= velocity_lookback_days
      );
  END IF;
END $$;

COMMENT ON COLUMN inventory.warehouse_settings.purchasing_forecast_method IS
  'Demand-rate calculation used by purchasing recommendations and RFQ requirements.';
COMMENT ON COLUMN inventory.warehouse_settings.purchasing_forecast_weight_seasonal IS
  'Relative weight of the same-period-last-year demand rate; weights are normalized at calculation time.';
COMMENT ON COLUMN inventory.warehouse_settings.purchasing_forward_demand_horizon_days IS
  'Number of future days whose planned demand events are added to purchasing requirements.';
