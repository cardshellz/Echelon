-- Migration 093: Add refund_amount_cents to oms.oms_orders
--
-- Captures the actual dollar amount refunded per order. Previously only
-- refunded_at (timestamp) and financial_status were stored. The Shopify
-- refunds/create webhook provides transaction amounts; eBay polls provide
-- payment status but not amounts (backfill derives from order total).
--
-- Backfill strategy (layered, each pass fills what the prior missed):
--   1. financial_status = 'refunded'            → total_cents (full refund)
--   2. financial_status = 'partially_refunded'  → sum(adjustment qty × line paid price)
--   3. Still 0 after #2                         → pull totalRefundAmount from oms_order_events
--      (covers flat/courtesy refunds with no line adjustments)

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS refund_amount_cents bigint NOT NULL DEFAULT 0;

-- Pass 1: Full refunds = total order value
UPDATE oms.oms_orders
SET refund_amount_cents = total_cents
WHERE financial_status = 'refunded'
  AND refund_amount_cents = 0
  AND total_cents > 0;

-- Pass 2: Partial refunds from line adjustments (qty × paid price)
UPDATE oms.oms_orders o
SET refund_amount_cents = sub.derived_refund
FROM (
  SELECT
    adj.order_id,
    COALESCE(SUM(adj.quantity * COALESCE(ol.paid_price_cents, 0)), 0)::bigint AS derived_refund
  FROM oms.order_line_adjustments adj
  LEFT JOIN oms.oms_order_lines ol
    ON ol.id = adj.order_line_id
  WHERE adj.adjustment_type = 'refund'
  GROUP BY adj.order_id
) sub
WHERE o.id = sub.order_id
  AND o.financial_status = 'partially_refunded'
  AND o.refund_amount_cents = 0
  AND sub.derived_refund > 0;

-- Pass 3: Flat/courtesy refunds — pull from event log totalRefundAmount
-- The refunds/create handler stores this in oms_order_events.details.totalRefundAmount
-- as a dollar float. Convert to cents.
UPDATE oms.oms_orders o
SET refund_amount_cents = sub.event_refund_cents
FROM (
  SELECT
    e.order_id,
    -- Sum all refund events for the order (handles multiple partial refunds)
    ROUND(SUM((e.details->>'totalRefundAmount')::numeric * 100))::bigint AS event_refund_cents
  FROM oms.oms_order_events e
  WHERE e.event_type = 'refunded'
    AND e.details->>'totalRefundAmount' IS NOT NULL
    AND (e.details->>'totalRefundAmount')::numeric > 0
  GROUP BY e.order_id
) sub
WHERE o.id = sub.order_id
  AND o.financial_status IN ('partially_refunded', 'refunded')
  AND o.refund_amount_cents = 0
  AND sub.event_refund_cents > 0;

-- Index for dashboard aggregation queries
CREATE INDEX IF NOT EXISTS idx_oms_orders_refund_amount
  ON oms.oms_orders (refund_amount_cents)
  WHERE refund_amount_cents > 0;
