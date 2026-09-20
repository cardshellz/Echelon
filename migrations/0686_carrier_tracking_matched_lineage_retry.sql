-- A tracking event can match one outbound label before its shipment links exist.
-- The reconciler already schedules a 30-minute retry for that state. The old
-- constraint rejected the retry, rolling back its audit and leaving the oldest
-- events permanently eligible for the next never-processed batch.
-- Preserve the identity match and immutable evidence; only permit its
-- future retry. No shipment, inventory, fulfillment or notification is changed.
ALTER TABLE wms.carrier_tracking_reconciliation_state
  DROP CONSTRAINT IF EXISTS carrier_tracking_reconciliation_state_retry_shape_chk,
  ADD CONSTRAINT carrier_tracking_reconciliation_state_retry_shape_chk CHECK (
    (last_match_status IN ('unmatched', 'ambiguous', 'review') AND next_reconcile_at IS NOT NULL)
    OR (
      last_match_status = 'matched'
      AND (next_reconcile_at IS NULL OR next_reconcile_at > last_reconciled_at)
    )
    OR (last_match_status = 'voided_label' AND next_reconcile_at IS NULL)
  );

COMMENT ON CONSTRAINT carrier_tracking_reconciliation_state_retry_shape_chk
  ON wms.carrier_tracking_reconciliation_state IS
  'Matched label identities may retry after last reconciliation while shipment lineage is pending; terminal voided labels do not retry.';
