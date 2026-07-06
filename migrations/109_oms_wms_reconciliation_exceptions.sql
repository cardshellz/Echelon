-- Phase 5 OMS/WMS reconciliation proof model.
--
-- Reconciliation paths classify drift before mutating fulfillment state. This
-- table is the durable review surface for callbacks and repair paths that lack
-- enough proof to safely update WMS work.

CREATE TABLE IF NOT EXISTS wms.reconciliation_exceptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source VARCHAR(50) NOT NULL,
  classification VARCHAR(30) NOT NULL,
  rule VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  severity VARCHAR(20) NOT NULL DEFAULT 'review',
  wms_order_id INTEGER REFERENCES wms.orders(id) ON DELETE SET NULL,
  wms_shipment_id INTEGER REFERENCES wms.outbound_shipments(id) ON DELETE SET NULL,
  external_system VARCHAR(40),
  external_order_ref VARCHAR(200),
  external_shipment_ref VARCHAR(200),
  external_order_key VARCHAR(200),
  idempotency_key VARCHAR(500) NOT NULL,
  summary TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  resolved_at TIMESTAMPTZ,
  resolved_by VARCHAR(120),
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wms_reconciliation_exceptions_classification_chk
    CHECK (classification IN (
      'safe_auto_repair',
      'manual_review',
      'hard_block',
      'historical_ignore'
    )),
  CONSTRAINT wms_reconciliation_exceptions_status_chk
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'ignored')),
  CONSTRAINT wms_reconciliation_exceptions_severity_chk
    CHECK (severity IN ('info', 'warning', 'review', 'blocker')),
  CONSTRAINT wms_reconciliation_exceptions_occurrence_count_chk
    CHECK (occurrence_count > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_reconciliation_exceptions_open_idem
  ON wms.reconciliation_exceptions (idempotency_key)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_wms_reconciliation_exceptions_status
  ON wms.reconciliation_exceptions (status, classification, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_wms_reconciliation_exceptions_shipment
  ON wms.reconciliation_exceptions (wms_shipment_id)
  WHERE wms_shipment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wms_reconciliation_exceptions_external
  ON wms.reconciliation_exceptions (
    external_system,
    external_order_ref,
    external_shipment_ref
  );
