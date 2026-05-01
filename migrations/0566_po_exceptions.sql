-- 0566_po_exceptions.sql
-- Per-PO exception tracking. Layered on top of the dual-track lifecycle.
-- Each row is a single exception event with its own resolution audit trail.
-- Rows are NEVER deleted; resolved exceptions stay forever for audit.
--
-- Exception kinds cover both physical (qty_short, qty_over, damaged_on_arrival,
-- wrong_product_received, slow_ack, slow_ship, customs_hold, lost_shipment)
-- and financial (match_mismatch, invoice_disputed, credit_memo_pending,
-- payment_failed, overpaid, past_due, vendor_reissued_invoice) exception types.
--
-- Idempotency: a payload_hash column (SHA-256 of po_id + kind + sorted payload)
-- prevents duplicate rows for the same underlying issue when detection hooks
-- fire repeatedly.

CREATE TABLE IF NOT EXISTS procurement.po_exceptions (
  id                BIGSERIAL PRIMARY KEY,
  po_id             INTEGER NOT NULL REFERENCES procurement.purchase_orders(id) ON DELETE CASCADE,
  kind              VARCHAR(40) NOT NULL,
  severity          VARCHAR(10) NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'open',
  -- per-kind structured detail (e.g. { line_id, shorted_qty, expected_qty })
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- SHA-256 of (po_id || '|' || kind || '|' || canonical_payload_json)
  -- used for idempotent upsert to prevent duplicate detection rows.
  payload_hash      VARCHAR(64) NOT NULL,
  title             VARCHAR(120) NOT NULL,
  message           TEXT,
  -- audit
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detected_by       VARCHAR(50),
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   VARCHAR(50),
  resolved_at       TIMESTAMPTZ,
  resolved_by       VARCHAR(50),
  resolution_note   TEXT,
  dismissed_at      TIMESTAMPTZ,
  dismissed_by      VARCHAR(50),
  dismiss_note      TEXT,
  -- when an exception of the same (po, kind, payload) recurs we don't dupe;
  -- updated_at tracks the last redetect so the user knows it's still live.
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'po_exceptions_severity_chk') THEN
    ALTER TABLE procurement.po_exceptions
      ADD CONSTRAINT po_exceptions_severity_chk
      CHECK (severity IN ('info','warn','error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'po_exceptions_status_chk') THEN
    ALTER TABLE procurement.po_exceptions
      ADD CONSTRAINT po_exceptions_status_chk
      CHECK (status IN ('open','acknowledged','resolved','dismissed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'po_exceptions_kind_chk') THEN
    ALTER TABLE procurement.po_exceptions
      ADD CONSTRAINT po_exceptions_kind_chk
      CHECK (kind IN (
        'qty_short','qty_over','damaged_on_arrival','wrong_product_received',
        'slow_ack','slow_ship','customs_hold','lost_shipment',
        'match_mismatch','invoice_disputed','credit_memo_pending',
        'payment_failed','overpaid','past_due','vendor_reissued_invoice'
      ));
  END IF;
END $$;

-- Unique constraint on the hash prevents race-condition duplication.
-- The WHERE clause covers only actionable states (not resolved/dismissed),
-- so a resolved exception can be re-raised without violating the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS po_exceptions_hash_open_uidx
  ON procurement.po_exceptions(payload_hash)
  WHERE status IN ('open', 'acknowledged');

-- Fast lookup of open exceptions for a PO (used in list JOIN).
CREATE INDEX IF NOT EXISTS po_exceptions_po_open_idx
  ON procurement.po_exceptions(po_id)
  WHERE status IN ('open', 'acknowledged');

-- Used for admin/reporting queries across all exception statuses.
CREATE INDEX IF NOT EXISTS po_exceptions_status_severity_idx
  ON procurement.po_exceptions(status, severity);
