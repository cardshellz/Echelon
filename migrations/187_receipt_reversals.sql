-- Receipt reversals (Spec D, 2026-08-07).
--
-- Posted (closed) receipts are immutable. Corrections happen via a reversal:
-- a compensating transaction linked to the original receiving order/line.
-- This migration adds:
--   1. procurement.receiving_lines.reversed_qty — running tally of how much
--      of a closed line has been reversed (in the line's variant units).
--      Invariant: 0 <= reversed_qty <= received_qty.
--   2. procurement.receipt_reversals — one row per reversal event (line or
--      whole order). Immutable audit record; idempotency_key is unique so a
--      retried reversal cannot double-apply.
--
-- Additive only. No existing rows are mutated.

-- 1. reversed_qty on receiving_lines ----------------------------------------

ALTER TABLE procurement.receiving_lines
  ADD COLUMN IF NOT EXISTS reversed_qty integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receiving_lines_reversed_qty_chk'
      AND conrelid = 'procurement.receiving_lines'::regclass
  ) THEN
    ALTER TABLE procurement.receiving_lines
      ADD CONSTRAINT receiving_lines_reversed_qty_chk
      CHECK (reversed_qty >= 0 AND reversed_qty <= received_qty);
  END IF;
END $$;

-- 2. receipt_reversals table -------------------------------------------------

CREATE TABLE IF NOT EXISTS procurement.receipt_reversals (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  receiving_order_id integer NOT NULL
    REFERENCES procurement.receiving_orders(id) ON DELETE CASCADE,
  receiving_line_id integer NOT NULL
    REFERENCES procurement.receiving_lines(id) ON DELETE CASCADE,
  -- Quantity reversed, in the receiving line's variant units (same unit as
  -- receiving_lines.received_qty). Always positive.
  qty integer NOT NULL,
  reason text NOT NULL,
  -- 'line' = single-line reversal; 'order' = part of a whole-order reversal.
  reversal_scope varchar(10) NOT NULL DEFAULT 'line',
  -- Group id linking all rows created by one whole-order reversal call.
  -- Null for single-line reversals.
  order_reversal_id integer,
  -- Inventory side effects, snapshotted at reversal time for audit:
  -- base units decremented = qty * units_per_variant (variant looked up live).
  base_units_reversed integer,
  -- Lot cost at reversal time (mills, per variant unit) — exact round-trip
  -- from the original lot; never re-costed.
  lot_unit_cost_mills bigint,
  -- Negative-inventory override audit: set when allowNegative was used.
  allow_negative integer NOT NULL DEFAULT 0,
  -- AP reconciliation re-open flag: 1 when the PO line had invoice-matched
  -- rows that were reset to pending by this reversal.
  ap_reconciliation_reopened integer NOT NULL DEFAULT 0,
  idempotency_key varchar(100) NOT NULL,
  created_by varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_reversals_qty_chk CHECK (qty > 0),
  CONSTRAINT receipt_reversals_scope_chk CHECK (reversal_scope IN ('line', 'order'))
);

-- Idempotency: a retried reversal with the same key must not double-apply.
CREATE UNIQUE INDEX IF NOT EXISTS receipt_reversals_idempotency_key_idx
  ON procurement.receipt_reversals(idempotency_key);

-- Lookup by line (reversal history display) and by order.
CREATE INDEX IF NOT EXISTS receipt_reversals_line_idx
  ON procurement.receipt_reversals(receiving_line_id, created_at);

CREATE INDEX IF NOT EXISTS receipt_reversals_order_idx
  ON procurement.receipt_reversals(receiving_order_id, created_at);

-- Self-FK for the order-reversal group (added after table creation so the
-- table exists for the reference).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'receipt_reversals_order_reversal_id_fk'
      AND conrelid = 'procurement.receipt_reversals'::regclass
  ) THEN
    ALTER TABLE procurement.receipt_reversals
      ADD CONSTRAINT receipt_reversals_order_reversal_id_fk
      FOREIGN KEY (order_reversal_id)
      REFERENCES procurement.receipt_reversals(id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Receive-time validation warning exception kinds (Spec D, Part 2) -------
-- Extend the po_exceptions kind CHECK so the receive close path can persist
-- validation warnings through the existing exceptions pattern.

ALTER TABLE procurement.po_exceptions
  DROP CONSTRAINT IF EXISTS po_exceptions_kind_chk;

ALTER TABLE procurement.po_exceptions
  ADD CONSTRAINT po_exceptions_kind_chk
  CHECK (kind IN (
    'qty_short','qty_over','damaged_on_arrival','wrong_product_received',
    'slow_ack','slow_ship','customs_hold','lost_shipment',
    'match_mismatch','invoice_disputed','credit_memo_pending',
    'payment_failed','overpaid','past_due','vendor_reissued_invoice',
    'receipt_reconciliation_failed',
    'receive_uom_disagreement','receive_base_unit_pack_conflict',
    'receive_cost_variance_soft','receive_cost_variance_hard',
    'receive_variant_base_unit_misconfig','receive_variant_missing_parent'
  ));
