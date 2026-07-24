-- Make forward-demand capture coverage explicit even when no event lines qualify.
-- Version 1 observations remain valid historical evidence, but their missing parent
-- coverage metadata means they cannot support horizon-specific overlay scoring.

ALTER TABLE procurement.purchase_forecast_observations
  ADD COLUMN overlay_planning_as_of_date DATE,
  ADD COLUMN overlay_horizon_days INTEGER;

ALTER TABLE procurement.purchase_forecast_observations
  DROP CONSTRAINT purchase_forecast_observations_overlay_capture_chk;

ALTER TABLE procurement.purchase_forecast_observations
  ADD CONSTRAINT purchase_forecast_observations_overlay_capture_chk
  CHECK (
    (
      overlay_capture_complete = FALSE
      AND overlay_capture_version = 0
      AND overlay_planning_as_of_date IS NULL
      AND overlay_horizon_days IS NULL
    )
    OR (
      overlay_capture_complete = TRUE
      AND overlay_capture_version = 1
      AND overlay_planning_as_of_date IS NULL
      AND overlay_horizon_days IS NULL
    )
    OR (
      overlay_capture_complete = TRUE
      AND overlay_capture_version >= 2
      AND overlay_planning_as_of_date IS NOT NULL
      AND overlay_horizon_days BETWEEN 1 AND 365
    )
  );

COMMENT ON COLUMN procurement.purchase_forecast_observations.overlay_planning_as_of_date IS
  'Database calendar date used to select the complete forward-demand contribution set.';
COMMENT ON COLUMN procurement.purchase_forecast_observations.overlay_horizon_days IS
  'Inclusive source-query horizon captured for forward-demand attribution; required from capture version 2.';
