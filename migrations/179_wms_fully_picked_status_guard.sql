-- A fully picked shippable line cannot remain pickable. This constraint is
-- NOT VALID so deployment can stop new drift before the audited cleanup repairs
-- the two known historical rows; PostgreSQL still enforces it for new writes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wms_order_items_fully_picked_status_chk'
      AND conrelid = 'wms.order_items'::regclass
  ) THEN
    ALTER TABLE wms.order_items
      ADD CONSTRAINT wms_order_items_fully_picked_status_chk
      CHECK (
        COALESCE(requires_shipping, 0) <> 1
        OR COALESCE(quantity, 0) <= 0
        OR COALESCE(picked_quantity, 0) < COALESCE(quantity, 0)
        OR COALESCE(status, '') NOT IN ('pending', 'in_progress')
      ) NOT VALID;
  END IF;
END
$$;

COMMENT ON CONSTRAINT wms_order_items_fully_picked_status_chk ON wms.order_items IS
  'Prevents fully picked shippable lines from returning to an active picker status.';
