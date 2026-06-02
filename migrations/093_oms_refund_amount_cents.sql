-- Migration 093: Add refund_amount_cents to oms.oms_orders
--
-- Captures the actual dollar amount refunded per order. Previously only
-- refunded_at (timestamp) and financial_status were stored. The Shopify
-- refunds/create webhook provides transaction amounts; eBay polls provide
-- payment status but not amounts (backfill derives from order total).
--
-- Backfill strategy:
--   financial_status = 'refunded'            → refund_amount_cents = total_cents
--   financial_status = 'partially_refunded'  → derived from line adjustments × paid price
--                                               (falls back to 0 if no adjustments exist)

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS refund_amount_cents bigint NOT NULL DEFAULT 0;

-- Backfill full refunds: refund = total order value
UPDATE oms.oms_orders
SET refund_amount_cents = total_cents
WHERE financial_status = 'refunded'
  AND refund_amount_cents = 0
  AND total_cents > 0;

-- Backfill partial refunds: sum(adjustment qty × line paid price)
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

-- Index for dashboard aggregation queries
CREATE INDEX IF NOT EXISTS idx_oms_orders_refund_amount
  ON oms.oms_orders (refund_amount_cents)
  WHERE refund_amount_cents > 0;
