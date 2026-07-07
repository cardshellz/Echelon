-- 123: Line-item hold — exclude held shipments from the "one active shipment per order" invariant.
--
-- LINE-ITEM-HOLD-DESIGN.md §2 flagged `uq_outbound_shipments_active_per_order` as "the core lift":
-- holding a line (P2a, holdLineItemWithSplit) creates a SECOND active shipment for the same order —
-- `status='planned'`, `source='line_item_hold'`, `held=true` — to hold that line out of shipping while
-- the rest ships. But the partial unique index below counted that held shipment, so its INSERT collided
-- with the order's existing active (planned/queued) main shipment → the hold endpoint 500'd on the first
-- real use. (Every ready order already has an active shipment before picking, so this fires every time.)
--
-- Fix: exclude `source='line_item_hold'` from the index, exactly as combined/split CHILD shipments are
-- already excluded. A held shipment can now coexist with the main. The invariant stays intact for normal
-- shipments — still at most one active, non-child, non-held-source shipment per order.
--
-- Non-concurrent DROP+CREATE (the release-phase runner wraps each migration in a transaction, so
-- CREATE INDEX CONCURRENTLY is not usable here). Brief lock on wms.outbound_shipments during recreate.

DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_per_order;

CREATE UNIQUE INDEX uq_outbound_shipments_active_per_order
  ON wms.outbound_shipments USING btree (order_id)
  WHERE (
    status = ANY (ARRAY[
      'planned'::wms.shipment_status,
      'queued'::wms.shipment_status,
      'labeled'::wms.shipment_status,
      'on_hold'::wms.shipment_status
    ])
    AND (COALESCE(source, ''::character varying))::text <> ALL ((ARRAY[
      'echelon_combined_child',
      'shipstation_combined_child',
      'shipstation_split',
      'line_item_hold'
    ])::text[])
  );
