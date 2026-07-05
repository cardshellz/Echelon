-- 120: close the SHIP_NOTIFY legacy duplicate hole (P0.4).
--
-- The legacy SHIP_NOTIFY path inserted status='shipped' rows with
-- external_fulfillment_id NULL under an UNTARGETED "ON CONFLICT DO NOTHING":
-- no unique index covers that row shape (the active-per-order and
-- external-fulfillment-id uniques are partial and exclude it), so replayed
-- webhooks piled up duplicate shipped rows per (order, tracking) and
-- inflated fulfillment sums (audit F-SHIP). The code path is now
-- resolve-or-flag (never creates); this migration repairs history and adds
-- the constraint the old code pretended existed.

-- 1. Void duplicate shipped rows: same order + same tracking number, keep the
--    EARLIEST row (it is the one downstream fulfillment pushes referenced).
--    Voiding (not deleting) preserves the audit trail.
UPDATE wms.outbound_shipments os
SET status = 'voided',
    requires_review = true,
    review_reason = 'dup_ship_notify_legacy_voided_119',
    updated_at = NOW()
WHERE os.status = 'shipped'
  AND os.tracking_number IS NOT NULL
  AND os.id <> (
    SELECT MIN(os2.id)
    FROM wms.outbound_shipments os2
    WHERE os2.order_id = os.order_id
      AND os2.tracking_number = os.tracking_number
      AND os2.status = 'shipped'
  );

-- 2. The constraint: one shipped row per (order, tracking number).
--    Multi-package orders keep multiple shipped rows (distinct tracking);
--    combined shipments share tracking across DIFFERENT orders (allowed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipments_shipped_order_tracking
  ON wms.outbound_shipments (order_id, tracking_number)
  WHERE status = 'shipped' AND tracking_number IS NOT NULL;
