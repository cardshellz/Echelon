-- Forward Demand Events — Phase 7A
--
-- Enables users to register known future demand (drops, preorders, promotions,
-- wholesale commitments, seasonal forecasts) so the purchasing recommendation
-- engine can fold them into reorder math alongside historical velocity.
--
-- The engine integration: getReorderAnalysisData() joins demand_event_lines
-- WHERE event start_date falls within (now, now + leadTime + safetyStock) and
-- adds the sum to the reorder point calculation.

CREATE TABLE IF NOT EXISTS procurement.demand_events (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  event_type      VARCHAR(50)  NOT NULL DEFAULT 'manual_forecast'
                  CHECK (event_type IN (
                    'drop', 'preorder', 'promotion', 'wholesale',
                    'seasonal', 'manual_forecast'
                  )),
  start_date      DATE NOT NULL,
  end_date        DATE,
  status          VARCHAR(20) NOT NULL DEFAULT 'planned'
                  CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  notes           TEXT,
  created_by      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS procurement.demand_event_lines (
  id                  SERIAL PRIMARY KEY,
  demand_event_id     INTEGER NOT NULL REFERENCES procurement.demand_events(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL,
  product_variant_id  INTEGER,
  expected_pieces     INTEGER NOT NULL CHECK (expected_pieces > 0),
  confidence          VARCHAR(10) NOT NULL DEFAULT 'medium'
                      CHECK (confidence IN ('high', 'medium', 'low')),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demand_events_status_date
  ON procurement.demand_events (status, start_date);

CREATE INDEX IF NOT EXISTS idx_demand_event_lines_product
  ON procurement.demand_event_lines (product_id);

CREATE INDEX IF NOT EXISTS idx_demand_event_lines_event
  ON procurement.demand_event_lines (demand_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_demand_event_lines_event_product_variant
  ON procurement.demand_event_lines (demand_event_id, product_id, COALESCE(product_variant_id, 0));
