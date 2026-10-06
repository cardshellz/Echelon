-- ===========================================================================
-- Diagnostic: paid orders whose warehouse line or order was cancelled by a
-- Shopify fulfillment hold (Global-e, #63275 / #63861).
--
-- READ-ONLY. Makes NO changes.
--
-- Until fix/globale-hold-authority-v2, an orders/updated carrying
-- fulfillable_quantity = 0 (a fulfillment hold) set OMS line authority to 0,
-- the WMS sync cancelled the never-picked WMS line, and the boot zombie repair
-- then cancelled the empty WMS order. The OMS order stayed paid and open.
--
-- owed_quantity = paid - cancelled - refunded, capped by Shopify
-- current_quantity from the latest stored orders/updated payload (so real
-- order-edit removals are not reported). A row is reported when the units the
-- OMS still owes exceed what live (non-cancelled) WMS lines carry, and this
-- WMS order or its line for the OMS line is cancelled.
--
-- repair_case:
--   A  WMS order active, line cancelled, authority owed: restored by the next
--      WMS sync (next orders/updated, or the 15-minute Shopify readiness sweep).
--   A2 WMS order active, authority still 0: restored once Shopify releases
--      the hold and authority is raised again.
--   B  WMS order cancelled: needs the one-time reopen
--      (scripts/repair-shopify-hold-cancelled-order.sql), then a WMS sync.
--   C  The line has picked or fulfilled units: manual review only.
-- ===========================================================================
WITH owed AS (
  SELECT
    oo.id                                    AS oms_order_id,
    oo.external_order_number                 AS order_number,
    COALESCE(oo.tags, '') ILIKE '%globale%'  AS globale,
    oo.status                                AS oms_status,
    oo.financial_status,
    oo.ordered_at,
    ol.id                                    AS oms_line_id,
    ol.sku,
    ol.paid_quantity,
    ol.authority_fulfillable_quantity        AS authority,
    cq.current_quantity,
    LEAST(
      ol.paid_quantity - ol.cancelled_quantity - ol.refunded_quantity,
      COALESCE(cq.current_quantity, ol.paid_quantity)
    )                                        AS owed_quantity
  FROM oms.oms_orders oo
  JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
  LEFT JOIN LATERAL (
    SELECT (li->>'current_quantity')::int AS current_quantity
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(oo.raw_payload->'line_items') = 'array'
           THEN oo.raw_payload->'line_items' ELSE '[]'::jsonb END
    ) li
    WHERE li->>'id' = ol.external_line_item_id
      AND li->>'current_quantity' ~ '^[0-9]+$'
    LIMIT 1
  ) cq ON TRUE
  -- ordered_at is a naive UTC timestamp.
  WHERE oo.ordered_at >= (now() AT TIME ZONE 'UTC') - INTERVAL '30 days'
    AND oo.financial_status IN ('paid', 'partially_paid')
    AND oo.status NOT IN ('cancelled', 'refunded', 'shipped')
    AND oo.cancelled_at IS NULL
    AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
    AND ol.requires_shipping IS DISTINCT FROM false
    AND COALESCE(ol.fulfillment_status, '') <> 'fulfilled'
    AND ol.authorization_status IN ('seen', 'authorized')
),
carried AS (
  SELECT wi.oms_order_line_id, SUM(wi.quantity)::int AS live_quantity
  FROM wms.order_items wi
  JOIN wms.orders live_order ON live_order.id = wi.order_id
  WHERE wi.status <> 'cancelled'
    AND live_order.warehouse_status <> 'cancelled'
    AND wi.oms_order_line_id IN (SELECT oms_line_id FROM owed)
  GROUP BY wi.oms_order_line_id
)
SELECT
  o.order_number, o.globale, o.oms_order_id, o.oms_status, o.financial_status, o.ordered_at,
  o.oms_line_id, o.sku, o.paid_quantity, o.authority, o.current_quantity, o.owed_quantity,
  COALESCE(c.live_quantity, 0)  AS live_wms_quantity,
  wo.id                         AS wms_order_id,
  wo.warehouse_status,
  wo.cancelled_at               AS wms_cancelled_at,
  wi.id                         AS wms_item_id,
  wi.status                     AS wms_item_status,
  wi.quantity                   AS wms_item_quantity,
  wi.picked_quantity,
  wi.fulfilled_quantity,
  CASE
    WHEN COALESCE(wi.picked_quantity, 0) > 0 OR COALESCE(wi.fulfilled_quantity, 0) > 0 THEN 'C'
    WHEN wo.warehouse_status = 'cancelled' THEN 'B'
    WHEN o.authority > COALESCE(c.live_quantity, 0) THEN 'A'
    ELSE 'A2'
  END                           AS repair_case
FROM owed o
JOIN wms.orders wo
  ON (wo.source = 'oms' AND wo.oms_fulfillment_order_id = o.oms_order_id::text)
  OR (wo.source = 'shopify' AND wo.source_table_id = o.oms_order_id::text)
LEFT JOIN wms.order_items wi
  ON wi.order_id = wo.id AND wi.oms_order_line_id = o.oms_line_id
LEFT JOIN carried c ON c.oms_order_line_id = o.oms_line_id
WHERE o.owed_quantity > COALESCE(c.live_quantity, 0)
  AND (wo.warehouse_status = 'cancelled' OR wi.status = 'cancelled')
ORDER BY o.ordered_at DESC, o.oms_order_id, o.oms_line_id;
