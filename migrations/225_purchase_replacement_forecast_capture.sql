-- Version 3 captures exact replacement ranges in the canonical policy JSON.
-- Existing observations and their policy/evaluation identity remain unchanged.
ALTER TABLE procurement.purchase_forecast_observations
  DROP CONSTRAINT IF EXISTS purchase_forecast_observations_policy_capture_chk;
ALTER TABLE procurement.purchase_forecast_observations
  ADD CONSTRAINT purchase_forecast_observations_policy_capture_chk CHECK (
    (forecast_policy_capture_version = 0 AND forecast_policy_fingerprint IS NULL AND forecast_policy_snapshot IS NULL)
    OR (forecast_policy_capture_version IN (1, 2, 3)
      AND forecast_policy_fingerprint ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof(forecast_policy_snapshot) = 'object')
  );
