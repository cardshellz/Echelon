-- Persist immutable, horizon-specific forecast backtests without creating a
-- second recommendation, RFQ, or purchase-order writer.

CREATE TABLE procurement.purchase_forecast_evaluations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id INTEGER NOT NULL
    REFERENCES procurement.purchase_forecast_observations(id) ON DELETE RESTRICT,
  horizon_days INTEGER NOT NULL,
  evaluation_version INTEGER NOT NULL,
  demand_query_version VARCHAR(80) NOT NULL,
  observed_from TIMESTAMPTZ NOT NULL,
  observed_through_exclusive TIMESTAMPTZ NOT NULL,
  actual_demand_pieces BIGINT NOT NULL,
  actual_order_count INTEGER NOT NULL,
  actual_active_days INTEGER NOT NULL,
  latest_actual_demand_at TIMESTAMPTZ,
  forecast_demand_micros BIGINT NOT NULL,
  baseline_demand_micros BIGINT NOT NULL,
  forecast_absolute_error_micros BIGINT NOT NULL,
  baseline_absolute_error_micros BIGINT NOT NULL,
  forecast_bias_micros BIGINT NOT NULL,
  baseline_bias_micros BIGINT NOT NULL,
  evidence_snapshot JSONB NOT NULL,
  evaluated_by VARCHAR(255),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_forecast_evaluations_observation_horizon_version_uidx
    UNIQUE (observation_id, horizon_days, evaluation_version),
  CONSTRAINT purchase_forecast_evaluations_horizon_chk
    CHECK (horizon_days IN (7, 30, 90)),
  CONSTRAINT purchase_forecast_evaluations_version_chk
    CHECK (evaluation_version > 0),
  CONSTRAINT purchase_forecast_evaluations_window_chk
    CHECK (observed_through_exclusive > observed_from),
  CONSTRAINT purchase_forecast_evaluations_actual_chk
    CHECK (actual_demand_pieces >= 0 AND actual_order_count >= 0 AND actual_active_days >= 0),
  CONSTRAINT purchase_forecast_evaluations_prediction_chk
    CHECK (forecast_demand_micros >= 0 AND baseline_demand_micros >= 0),
  CONSTRAINT purchase_forecast_evaluations_error_chk
    CHECK (forecast_absolute_error_micros >= 0 AND baseline_absolute_error_micros >= 0)
);

CREATE INDEX purchase_forecast_evaluations_horizon_evaluated_idx
  ON procurement.purchase_forecast_evaluations (horizon_days, evaluated_at DESC, id DESC);

CREATE TRIGGER purchase_forecast_evaluations_update_guard_trg
  BEFORE UPDATE ON procurement.purchase_forecast_evaluations
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchase_recommendation_update();

CREATE TRIGGER purchase_forecast_evaluations_delete_guard_trg
  BEFORE DELETE ON procurement.purchase_forecast_evaluations
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchasing_evidence_delete();

COMMENT ON TABLE procurement.purchase_forecast_evaluations IS
  'Immutable actual-demand measurements for mature purchase forecast observations.';
COMMENT ON COLUMN procurement.purchase_forecast_evaluations.observed_through_exclusive IS
  'Exclusive end of the actual-demand interval; the interval is [observed_from, observed_through_exclusive).';
COMMENT ON COLUMN procurement.purchase_forecast_evaluations.forecast_demand_micros IS
  'Historical-rate model prediction for the horizon in micro-pieces; forward-demand overlays are reported separately.';
COMMENT ON COLUMN procurement.purchase_forecast_evaluations.demand_query_version IS
  'Versioned contract for converting eligible WMS order lines to actual product demand.';
