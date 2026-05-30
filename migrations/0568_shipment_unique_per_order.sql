-- C3 Phase 1: Partial unique index on outbound_shipments(order_id)
-- for open (non-terminal) statuses. Prevents duplicate active shipments
-- per order at the DB level. Combined/split orders that legitimately
-- need multiple shipments use terminal states (cancel the old one before
-- creating a new one) or a distinct source marker.
--
-- This is a PARTIAL unique index: it only constrains rows where status
-- is in the open set (planned, queued, labeled, on_hold). Terminal rows
-- (shipped, cancelled, voided, returned, lost) are excluded — an order
-- can have many historical shipments.
--
-- The index uses COALESCE to handle the source column: combined-child
-- shipments (source = 'echelon_combined_child') are exempt because they
-- share a parent's SS order and are expected to coexist with the parent's
-- shipment.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_outbound_shipments_active_per_order
  ON wms.outbound_shipments (order_id)
  WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
    AND COALESCE(source, '') <> 'echelon_combined_child';
