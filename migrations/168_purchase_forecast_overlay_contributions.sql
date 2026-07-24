-- Preserve the exact forward-demand event lines used by each forecast observation.
-- Existing observations remain explicitly marked as having no complete contribution
-- capture; they must not be treated as zero-overlay evidence.

ALTER TABLE procurement.purchase_forecast_observations
  ADD COLUMN overlay_capture_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN overlay_capture_complete BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE procurement.purchase_forecast_observations
  ADD CONSTRAINT purchase_forecast_observations_overlay_capture_chk
  CHECK (
    (overlay_capture_complete = FALSE AND overlay_capture_version = 0)
    OR (overlay_capture_complete = TRUE AND overlay_capture_version > 0)
  );

CREATE TABLE procurement.purchase_forecast_overlay_contributions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observation_id INTEGER NOT NULL
    REFERENCES procurement.purchase_forecast_observations(id) ON DELETE RESTRICT,
  demand_event_id INTEGER NOT NULL,
  demand_event_line_id INTEGER NOT NULL,
  product_variant_id INTEGER,
  event_name VARCHAR(255) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_status VARCHAR(20) NOT NULL,
  event_start_date DATE NOT NULL,
  event_end_date DATE,
  planning_as_of_date DATE NOT NULL,
  expected_pieces INTEGER NOT NULL,
  confidence VARCHAR(10) NOT NULL,
  confidence_weight_percent INTEGER NOT NULL,
  weighted_pieces BIGINT NOT NULL,
  event_updated_at TIMESTAMPTZ NOT NULL,
  line_updated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_forecast_overlay_contributions_observation_line_uidx
    UNIQUE (observation_id, demand_event_line_id),
  CONSTRAINT purchase_forecast_overlay_contributions_event_dates_chk
    CHECK (
      (event_end_date IS NULL OR event_end_date >= event_start_date)
      AND (event_end_date IS NULL OR event_end_date >= planning_as_of_date)
    ),
  CONSTRAINT purchase_forecast_overlay_contributions_qty_chk
    CHECK (expected_pieces >= 0 AND weighted_pieces >= 0),
  CONSTRAINT purchase_forecast_overlay_contributions_weighted_qty_chk
    CHECK (
      weighted_pieces
      = ((expected_pieces::BIGINT * confidence_weight_percent::BIGINT + 99) / 100)
    ),
  CONSTRAINT purchase_forecast_overlay_contributions_event_type_chk
    CHECK (event_type IN ('drop', 'preorder', 'promotion', 'wholesale', 'seasonal', 'manual_forecast')),
  CONSTRAINT purchase_forecast_overlay_contributions_confidence_chk
    CHECK (confidence IN ('high', 'medium', 'low')),
  CONSTRAINT purchase_forecast_overlay_contributions_weight_chk
    CHECK (confidence_weight_percent BETWEEN 0 AND 100),
  CONSTRAINT purchase_forecast_overlay_contributions_status_chk
    CHECK (event_status IN ('planned', 'active'))
);

CREATE INDEX purchase_forecast_overlay_contributions_observation_date_idx
  ON procurement.purchase_forecast_overlay_contributions
  (observation_id, event_start_date, demand_event_id, demand_event_line_id);

CREATE TRIGGER purchase_forecast_overlay_contributions_update_guard_trg
  BEFORE UPDATE ON procurement.purchase_forecast_overlay_contributions
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchase_recommendation_update();

CREATE TRIGGER purchase_forecast_overlay_contributions_delete_guard_trg
  BEFORE DELETE ON procurement.purchase_forecast_overlay_contributions
  FOR EACH ROW EXECUTE FUNCTION procurement.guard_purchasing_evidence_delete();

COMMENT ON TABLE procurement.purchase_forecast_overlay_contributions IS
  'Immutable event-line evidence for the forward-demand overlay used by a forecast observation.';
COMMENT ON COLUMN procurement.purchase_forecast_overlay_contributions.demand_event_id IS
  'Snapshot source identifier; intentionally has no foreign key so later source-event changes cannot invalidate historical evidence.';
COMMENT ON COLUMN procurement.purchase_forecast_overlay_contributions.demand_event_line_id IS
  'Snapshot source-line identifier; intentionally has no foreign key so later source-line changes cannot invalidate historical evidence.';
COMMENT ON COLUMN procurement.purchase_forecast_overlay_contributions.planning_as_of_date IS
  'Database calendar date used by the recommendation query when selecting eligible future-demand events.';
COMMENT ON COLUMN procurement.purchase_forecast_overlay_contributions.weighted_pieces IS
  'Expected pieces after applying the captured confidence weight with ceiling integer arithmetic.';
