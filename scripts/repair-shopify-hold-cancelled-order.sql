-- ===========================================================================
-- One-time repair for ONE order reported as repair_case 'B' by
-- scripts/diagnose-shopify-hold-cancelled-orders.sql: a paid, open OMS order
-- whose WMS order was cancelled after a Shopify fulfillment hold (Global-e)
-- cancelled its only line (e.g. #63861 -> WMS order 209282; take both ids
-- from the diagnostic's output row).
--
-- Run ONLY after fix/globale-hold-authority-v2 is deployed: the reopened order
-- is then completed by code, not by hand. The queued WMS sync restores the
-- cancelled line (restoreCancelledLineForRecoveredAuthority), re-claims its
-- inventory through reconcileOrderDemand, and creates or attaches shipment
-- coverage if the original shipment no longer covers it.
--
-- This deliberately bypasses order-status-core, where 'cancelled' is
-- terminal: it is an audited, one-order data repair of a defect, not a
-- lifecycle transition. Every guard below must hold or nothing is written.
--
-- ONE statement, so it commits or rolls back on its own. Never wrap it in a
-- transaction left open in an SQL client (see the 2026-10-01 lock outage).
-- Set the two ids, run, and expect reopened = audited = 1 and queued <= 1.
-- reopened = 0 means a guard failed: re-run the diagnostic and review.
-- ===========================================================================
WITH params AS (
  SELECT 0::int AS wms_order_id, 0::bigint AS oms_order_id  -- SET BOTH (0 = no-op)
),
target AS (
  SELECT wo.id AS wms_order_id, oo.id AS oms_order_id
  FROM params p
  JOIN wms.orders wo ON wo.id = p.wms_order_id
  JOIN oms.oms_orders oo ON oo.id = p.oms_order_id
  WHERE wo.warehouse_status = 'cancelled'
    AND wo.order_edit_operation_id IS NULL
    AND ((wo.source = 'oms' AND wo.oms_fulfillment_order_id = oo.id::text)
      OR (wo.source = 'shopify' AND wo.source_table_id = oo.id::text))
    -- The OMS order is still paid and open.
    AND oo.financial_status IN ('paid', 'partially_paid')
    AND oo.status NOT IN ('cancelled', 'refunded', 'shipped')
    AND oo.cancelled_at IS NULL
    AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
    -- Nothing was ever picked, fulfilled, or shipped from this WMS order.
    AND NOT EXISTS (
      SELECT 1 FROM wms.order_items i
      WHERE i.order_id = wo.id
        AND (COALESCE(i.picked_quantity, 0) > 0 OR COALESCE(i.fulfilled_quantity, 0) > 0)
    )
    AND NOT EXISTS (
      SELECT 1 FROM wms.outbound_shipments s
      WHERE s.order_id = wo.id
        AND (s.status IN ('shipped', 'delivered') OR s.shipped_at IS NOT NULL)
    )
    -- The hold is released: some shippable line's authority exceeds what live
    -- WMS lines carry. Without this the boot zombie repair would cancel the
    -- reopened order again before the sync restores its line.
    AND EXISTS (
      SELECT 1 FROM oms.oms_order_lines ol
      WHERE ol.order_id = oo.id
        AND ol.requires_shipping IS DISTINCT FROM false
        AND COALESCE(ol.fulfillment_status, '') <> 'fulfilled'
        AND ol.authority_fulfillable_quantity > COALESCE((
          SELECT SUM(wi.quantity) FROM wms.order_items wi
          WHERE wi.oms_order_line_id = ol.id AND wi.status <> 'cancelled'
        ), 0)
    )
),
reopened AS (
  UPDATE wms.orders wo
     SET warehouse_status = 'ready',
         cancelled_at = NULL,
         assigned_picker_id = NULL,
         updated_at = NOW()
    FROM target t
   WHERE wo.id = t.wms_order_id
     AND wo.warehouse_status = 'cancelled'
  RETURNING wo.id AS wms_order_id, t.oms_order_id
),
audited AS (
  INSERT INTO oms.oms_order_events (order_id, event_type, details)
  SELECT r.oms_order_id,
         'wms_order_reopened_after_hold_defect',
         jsonb_build_object(
           'wmsOrderId', r.wms_order_id,
           'before', 'cancelled',
           'after', 'ready',
           'reason', 'Shopify fulfillment hold cancelled a paid WMS order (#63861 class)',
           'repair', 'scripts/repair-shopify-hold-cancelled-order.sql'
         )
  FROM reopened r
  RETURNING order_id
),
queued AS (
  INSERT INTO oms.webhook_retry_queue (provider, topic, payload, attempts, status, last_error, next_retry_at)
  SELECT 'internal', 'oms_wms_sync', jsonb_build_object('omsOrderId', r.oms_order_id), 0, 'pending',
         'reopened after Shopify hold defect; restore cancelled lines', NOW()
  FROM reopened r
  WHERE NOT EXISTS (
    SELECT 1 FROM oms.webhook_retry_queue q
    WHERE q.provider = 'internal'
      AND q.topic = 'oms_wms_sync'
      AND q.status = 'pending'
      AND q.payload->>'omsOrderId' = r.oms_order_id::text
  )
  RETURNING id
)
SELECT
  (SELECT COUNT(*) FROM reopened) AS reopened,
  (SELECT COUNT(*) FROM audited)  AS audited,
  (SELECT COUNT(*) FROM queued)   AS queued;
