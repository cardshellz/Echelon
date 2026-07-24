-- Migration 172: immutable forecast-policy cohort identity for backtesting.
ALTER TABLE procurement.purchase_forecast_observations
  ADD COLUMN IF NOT EXISTS forecast_policy_capture_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forecast_policy_fingerprint VARCHAR(64),
  ADD COLUMN IF NOT EXISTS forecast_policy_snapshot JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'purchase_forecast_observations_policy_capture_chk'
      AND conrelid = 'procurement.purchase_forecast_observations'::regclass
  ) THEN
    ALTER TABLE procurement.purchase_forecast_observations
      ADD CONSTRAINT purchase_forecast_observations_policy_capture_chk
      CHECK (
        (
          forecast_policy_capture_version = 0
          AND forecast_policy_fingerprint IS NULL
          AND forecast_policy_snapshot IS NULL
        )
        OR (
          forecast_policy_capture_version = 1
          AND forecast_policy_fingerprint ~ '^[0-9a-f]{64}$'
          AND jsonb_typeof(forecast_policy_snapshot) = 'object'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS purchase_forecast_observations_policy_cohort_idx
  ON procurement.purchase_forecast_observations (
    forecast_policy_fingerprint,
    forecast_method,
    forecast_version,
    product_id,
    created_at
  );

COMMENT ON COLUMN procurement.purchase_forecast_observations.forecast_policy_capture_version IS
  'Zero identifies legacy observations without explicit policy evidence; version one stores a canonical normalized policy snapshot.';
COMMENT ON COLUMN procurement.purchase_forecast_observations.forecast_policy_fingerprint IS
  'Lowercase SHA-256 of the canonical forecast quantity and forward-demand policy snapshot.';
COMMENT ON COLUMN procurement.purchase_forecast_observations.forecast_policy_snapshot IS
  'Immutable normalized forecast policy used to calculate this observation; automation approval thresholds are intentionally excluded.';
