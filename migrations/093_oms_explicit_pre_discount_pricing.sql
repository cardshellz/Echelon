-- Explicit pre-discount pricing on OMS orders + lines (#58276).
--
-- subtotal_cents / paid_price_cents / total_price_cents are POST-discount
-- (what the customer paid). The PRE-discount value was only derivable
-- (subtotal + discount, or line net + discount), which is easy to get wrong —
-- a now-removed ShipStation reconciliation check did exactly that and stranded
-- free / 100%-discount orders. Store the pre-discount value explicitly:
--
--   oms.oms_orders.gross_subtotal_cents     pre-discount merchandise subtotal
--   oms.oms_order_lines.retail_price_cents  pre-discount UNIT price (= Shopify
--                                           line_items[].price)
--
-- Both default 0 (fast, metadata-only add on PG11+), then backfilled
-- losslessly from existing columns. Idempotent: backfill only touches rows
-- still at the default 0.

ALTER TABLE oms.oms_order_lines
  ADD COLUMN IF NOT EXISTS retail_price_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE oms.oms_orders
  ADD COLUMN IF NOT EXISTS gross_subtotal_cents bigint NOT NULL DEFAULT 0;

-- Backfill line retail (gross) UNIT price = (net line total + line discount) / qty.
-- For a free item: total_price_cents=0, total_discount_cents=1999, qty=1 → 1999.
UPDATE oms.oms_order_lines
   SET retail_price_cents = CASE
         WHEN quantity > 0
           THEN ROUND((total_price_cents + total_discount_cents)::numeric / quantity)::bigint
         ELSE total_price_cents + total_discount_cents
       END
 WHERE retail_price_cents = 0
   AND (total_price_cents + total_discount_cents) <> 0;

-- Backfill order pre-discount subtotal = sum of line gross (retail × qty).
UPDATE oms.oms_orders o
   SET gross_subtotal_cents = COALESCE((
         SELECT SUM(l.retail_price_cents * l.quantity)
           FROM oms.oms_order_lines l
          WHERE l.order_id = o.id
       ), 0)
 WHERE gross_subtotal_cents = 0;
