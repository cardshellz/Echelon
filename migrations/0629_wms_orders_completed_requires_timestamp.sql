-- An order may only be 'completed' if we can say when it completed.
--
-- Orders #62269 (AU) and #62226 (CA) reached the warehouse with every line
-- quantity at zero, and the status rollup in wms-sync.service.ts read "no units
-- left to pick" as "this order is finished" - falling out of its ELSE branch to
-- 'completed' without a legal-transition check and without a timestamp.
-- 'completed' is terminal, so the orders could never be repaired: the upstream
-- glitch that zeroed them corrected itself in ~90 seconds, but both stayed
-- invisible to pickers for three days.
--
-- The guarded transition in order-status-core.ts always stamps completed_at, so
-- this constraint costs the legitimate path nothing and makes the bypass
-- impossible. A writer that cannot say when an order completed cannot claim it.
--
-- 11 rows violate it today. They are two distinct populations, repaired below.

-- 1. Seven orders whose parcels actually shipped - five domestic plus the two
--    international ones. They are not 'completed' pending shipment; they have
--    shipped. Take both the status and the timestamp from the shipment, which
--    is the physical fact. Restricted to orders whose every customer shipment
--    is 'shipped', so a partially shipped order is never closed out here.
UPDATE wms.orders w
   SET warehouse_status = 'shipped',
       completed_at = evidence.last_ship_date,
       updated_at = NOW()
  FROM (
    SELECT item.order_id,
           MAX(shipment.ship_date) AS last_ship_date
      FROM wms.effective_physical_shipment_items shipment_item
      JOIN wms.order_items item
        ON item.id = shipment_item.wms_order_item_id
      JOIN wms.physical_shipments shipment
        ON shipment.id = shipment_item.physical_shipment_id
     WHERE shipment_item.shipment_item_purpose = 'customer_fulfillment'
     GROUP BY item.order_id
    HAVING COUNT(*) FILTER (WHERE shipment.status <> 'shipped') = 0
       AND MAX(shipment.ship_date) IS NOT NULL
  ) evidence
 WHERE w.id = evidence.order_id
   AND w.warehouse_status = 'completed'
   AND w.completed_at IS NULL;

-- 2. Four April rows with no shipment evidence and an oms_fulfillment_order_id
--    pointing at OMS orders that no longer exist. All four were last written at
--    exactly 2026-04-22 13:34:25.314+00 - a bulk close-out. We cannot know when
--    they completed; updated_at is the honest record of when they were closed.
UPDATE wms.orders
   SET completed_at = updated_at
 WHERE warehouse_status = 'completed'
   AND completed_at IS NULL;

-- 3. The invariant.
ALTER TABLE wms.orders
  ADD CONSTRAINT wms_orders_completed_requires_timestamp
  CHECK (warehouse_status <> 'completed' OR completed_at IS NOT NULL);

COMMENT ON CONSTRAINT wms_orders_completed_requires_timestamp ON wms.orders IS
  'Completion must be evidenced. Set completed_at in the same write that sets warehouse_status to completed; see order-status-core.ts.';
