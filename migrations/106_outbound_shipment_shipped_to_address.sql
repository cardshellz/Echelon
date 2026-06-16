-- Capture the actual ship-to ShipStation used for a shipment (from SHIP_NOTIFY),
-- distinct from the order's REQUESTED address (wms.orders.shipping_*). When an
-- operator edits the address in ShipStation after the order was pushed, the label
-- ships to the new address — but on the way back Echelon only recorded tracking and
-- dropped the address. Storing ShipStation's shipTo on the shipment preserves "where
-- it actually went" and lets us compare it to the requested address (a real
-- discrepancy signal) instead of flagging a review. Additive + idempotent.

ALTER TABLE wms.outbound_shipments ADD COLUMN IF NOT EXISTS shipped_to_address jsonb;
