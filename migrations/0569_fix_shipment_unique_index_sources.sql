-- Fix the C3 partial unique index: the original excluded 'echelon_combined_child'
-- but the actual source constant is 'shipstation_combined_child'. Also exclude
-- 'shipstation_split' — split shipments legitimately create multiple active
-- shipments for the same order.
--
-- DROP + re-CREATE because ALTER INDEX cannot change a WHERE predicate.

DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_per_order;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipments_active_per_order
  ON wms.outbound_shipments (order_id)
  WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
    AND COALESCE(source, '') NOT IN ('shipstation_combined_child', 'shipstation_split');
