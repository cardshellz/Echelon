-- Capture the complete forecast population for unbiased future backtesting.
-- Purchase recommendation lines remain sourcing requirements; observations are
-- product-level forecast evidence and never create an RFQ or PO.

CREATE TABLE procurement.purchase_forecast_observations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id INTEGER NOT NULL
    REFERENCES procurement.purchase_recommendation_runs(id) ON DELETE RESTRICT,
  observation_key VARCHAR(160) NOT NULL,
  product_id INTEGER NOT NULL
    REFERENCES catalog.products(id) ON DELETE RESTRICT,
  selected_receive_variant_id INTEGER
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  scope VARCHAR(40) NOT NULL DEFAULT 'product_all_warehouses',
  product_sku VARCHAR(100) NOT NULL,
  product_name TEXT NOT NULL,
  forecast_method VARCHAR(40) NOT NULL,
  forecast_version INTEGER NOT NULL,
  forecast_daily_pieces_micros BIGINT NOT NULL,
  baseline_daily_pieces_micros BIGINT NOT NULL,
  forward_demand_pieces INTEGER NOT NULL DEFAULT 0,
  forward_demand_raw_pieces INTEGER NOT NULL DEFAULT 0,
  evidence_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_forecast_observations_run_product_scope_uidx
    UNIQUE (run_id, product_id, scope),
  CONSTRAINT purchase_forecast_observations_scope_chk
    CHECK (scope IN ('product_all_warehouses')),
  CONSTRAINT purchase_forecast_observations_version_chk
    CHECK (forecast_version > 0),
  CONSTRAINT purchase_forecast_observations_forecast_qty_chk
    CHECK (forecast_daily_pieces_micros >= 0),
  CONSTRAINT purchase_forecast_observations_baseline_qty_chk
    CHECK (baseline_daily_pieces_micros >= 0),
  CONSTRAINT purchase_forecast_observations_forward_qty_chk
    CHECK (forward_demand_pieces >= 0 AND forward_demand_raw_pieces >= 0),
  CONSTRAINT purchase_forecast_observations_receive_variant_product_fk
    FOREIGN KEY (selected_receive_variant_id, product_id)
    REFERENCES catalog.product_variants(id, product_id)
    ON DELETE RESTRICT
);

CREATE INDEX purchase_forecast_observations_product_run_idx
  ON procurement.purchase_forecast_observations (product_id, run_id DESC);

CREATE TRIGGER purchase_forecast_observations_update_guard_trg
  BEFORE UPDATE ON procurement.purchase_forecast_observations
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchase_recommendation_update();

CREATE TRIGGER purchase_forecast_observations_delete_guard_trg
  BEFORE DELETE ON procurement.purchase_forecast_observations
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchasing_evidence_delete();

COMMENT ON TABLE procurement.purchase_forecast_observations IS
  'Immutable full-population product forecasts captured with each recommendation run for future accuracy evaluation.';
COMMENT ON COLUMN procurement.purchase_forecast_observations.scope IS
  'Forecast identity. product_all_warehouses reflects the current recommendation engine aggregation boundary.';
COMMENT ON COLUMN procurement.purchase_forecast_observations.selected_receive_variant_id IS
  'Receiving configuration selected for purchasing; not the demand forecast scope.';
COMMENT ON COLUMN procurement.purchase_forecast_observations.forecast_daily_pieces_micros IS
  'Predicted base pieces per day multiplied by 1,000,000 for deterministic comparison.';
COMMENT ON COLUMN procurement.purchase_forecast_observations.baseline_daily_pieces_micros IS
  'Standard-window base pieces per day multiplied by 1,000,000 for model comparison.';
