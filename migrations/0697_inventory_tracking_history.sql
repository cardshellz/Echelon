-- Explicit end of managed inventory, not a count adjustment or physical disposal.
-- The application copies exact database JSON (including bigint cost precision)
-- before clearing managed projections in the same policy transaction.
CREATE TABLE IF NOT EXISTS inventory.tracking_stop_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog.products(id),
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  stopped_at timestamp NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  levels jsonb NOT NULL CHECK (jsonb_typeof(levels) = 'array'),
  lots jsonb NOT NULL CHECK (jsonb_typeof(lots) = 'array'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object')
);
CREATE INDEX IF NOT EXISTS tracking_stop_history_product_idx
  ON inventory.tracking_stop_history(product_id, id DESC);
CREATE INDEX IF NOT EXISTS tracking_stop_history_variant_idx
  ON inventory.tracking_stop_history(product_variant_id);

CREATE OR REPLACE FUNCTION inventory.reject_tracking_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'INVENTORY_TRACKING_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS tracking_stop_history_immutable ON inventory.tracking_stop_history;
CREATE TRIGGER tracking_stop_history_immutable BEFORE UPDATE OR DELETE ON inventory.tracking_stop_history
FOR EACH ROW EXECUTE FUNCTION inventory.reject_tracking_history_mutation();
DROP TRIGGER IF EXISTS tracking_stop_history_no_truncate ON inventory.tracking_stop_history;
CREATE TRIGGER tracking_stop_history_no_truncate BEFORE TRUNCATE ON inventory.tracking_stop_history
FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_tracking_history_mutation();

COMMENT ON TABLE inventory.tracking_stop_history IS
  'Last recorded balances when inventory tracking stopped. Historical evidence, not live stock, a physical count, disposal or COGS.';

-- Serialize new inventory-managed order lines with a reviewed stop. A request
-- resolved before the policy lock must retry resolution rather than creating a
-- new tracked obligation after its balances have become historical.
CREATE OR REPLACE FUNCTION catalog.guard_tracking_stop_order_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE variant_key integer; variant_row record;
BEGIN
  IF NEW.inventory_tracking IS FALSE THEN RETURN NEW; END IF;
  variant_key := (to_jsonb(NEW)->>TG_ARGV[0])::integer;
  FOR variant_row IN SELECT v.id,v.track_inventory FROM catalog.product_variants v
    WHERE v.id=variant_key OR (variant_key IS NULL AND v.sku=NEW.sku)
    ORDER BY v.id FOR SHARE
  LOOP
    IF variant_row.track_inventory IS FALSE AND EXISTS (
      SELECT 1 FROM inventory.tracking_stop_history WHERE product_variant_id=variant_row.id
    ) THEN
      RAISE EXCEPTION 'INVENTORY_TRACKING_STOPPED: resolve current order policy for variant %', variant_row.id USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_lines_tracking_stop_guard ON oms.oms_order_lines;
CREATE TRIGGER order_lines_tracking_stop_guard BEFORE INSERT ON oms.oms_order_lines
FOR EACH ROW EXECUTE FUNCTION catalog.guard_tracking_stop_order_policy('product_variant_id');
DROP TRIGGER IF EXISTS order_items_tracking_stop_guard ON wms.order_items;
CREATE TRIGGER order_items_tracking_stop_guard BEFORE INSERT ON wms.order_items
FOR EACH ROW EXECUTE FUNCTION catalog.guard_tracking_stop_order_policy('product_id');
