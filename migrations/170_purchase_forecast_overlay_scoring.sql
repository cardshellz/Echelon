-- Add immutable horizon-attributed overlay metrics without changing the
-- historical-rate and baseline measurements already stored on each evaluation.

ALTER TABLE procurement.purchase_forecast_evaluations
  ADD COLUMN overlay_attribution_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN overlay_evaluable BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN overlay_exclusion_reason VARCHAR(64) DEFAULT 'legacy_evaluation',
  ADD COLUMN overlay_contribution_count INTEGER,
  ADD COLUMN overlay_raw_demand_pieces BIGINT,
  ADD COLUMN overlay_weighted_demand_pieces BIGINT,
  ADD COLUMN overlay_adjusted_forecast_demand_micros BIGINT,
  ADD COLUMN overlay_adjusted_absolute_error_micros BIGINT,
  ADD COLUMN overlay_adjusted_bias_micros BIGINT;

ALTER TABLE procurement.purchase_forecast_evaluations
  ADD CONSTRAINT purchase_forecast_evaluations_overlay_scoring_chk
  CHECK (
    (
      overlay_evaluable = FALSE
      AND overlay_attribution_version = 0
      AND overlay_exclusion_reason IS NOT NULL
      AND overlay_contribution_count IS NULL
      AND overlay_raw_demand_pieces IS NULL
      AND overlay_weighted_demand_pieces IS NULL
      AND overlay_adjusted_forecast_demand_micros IS NULL
      AND overlay_adjusted_absolute_error_micros IS NULL
      AND overlay_adjusted_bias_micros IS NULL
    )
    OR (
      overlay_evaluable = TRUE
      AND overlay_attribution_version > 0
      AND overlay_exclusion_reason IS NULL
      AND overlay_contribution_count >= 0
      AND overlay_raw_demand_pieces >= 0
      AND overlay_weighted_demand_pieces >= 0
      AND overlay_adjusted_forecast_demand_micros >= 0
      AND overlay_adjusted_absolute_error_micros >= 0
      AND overlay_adjusted_bias_micros IS NOT NULL
      AND overlay_adjusted_forecast_demand_micros
        = forecast_demand_micros + overlay_weighted_demand_pieces * 1000000
      AND overlay_adjusted_bias_micros
        = overlay_adjusted_forecast_demand_micros - actual_demand_pieces * 1000000
      AND overlay_adjusted_absolute_error_micros = ABS(overlay_adjusted_bias_micros)
    )
  );

COMMENT ON COLUMN procurement.purchase_forecast_evaluations.overlay_evaluable IS
  'True only when immutable capture metadata completely covers this evaluation horizon.';
COMMENT ON COLUMN procurement.purchase_forecast_evaluations.overlay_exclusion_reason IS
  'Immutable reason an evaluation was excluded from overlay scoring; legacy rows are labeled explicitly.';
COMMENT ON COLUMN procurement.purchase_forecast_evaluations.overlay_weighted_demand_pieces IS
  'Confidence-weighted event demand whose start date falls in the evaluated planning-date horizon.';
COMMENT ON COLUMN procurement.purchase_forecast_evaluations.overlay_adjusted_forecast_demand_micros IS
  'Historical-rate prediction plus horizon-attributed weighted event demand, in micro-pieces.';
