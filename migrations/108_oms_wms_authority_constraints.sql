-- Phase 4 OMS/WMS authority guardrails.
--
-- The readiness audit/cleanup scripts classify and repair historical drift.
-- These constraints and trigger guards stop new writes from bypassing OMS line
-- authority, while NOT VALID constraints allow legacy rows to be quarantined
-- before validation.

ALTER TABLE wms.order_items
  ALTER COLUMN oms_order_line_id TYPE BIGINT USING oms_order_line_id::bigint;

DO $$
BEGIN
  IF to_regclass('wms.return_items') IS NOT NULL THEN
    ALTER TABLE wms.return_items
      ALTER COLUMN oms_order_line_id TYPE BIGINT USING oms_order_line_id::bigint;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_order_items_oms_order_line_id_fkey'
  ) THEN
    ALTER TABLE wms.order_items
      ADD CONSTRAINT wms_order_items_oms_order_line_id_fkey
      FOREIGN KEY (oms_order_line_id)
      REFERENCES oms.oms_order_lines(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_order_items_quantities_nonnegative_chk'
  ) THEN
    ALTER TABLE wms.order_items
      ADD CONSTRAINT wms_order_items_quantities_nonnegative_chk
      CHECK (
        quantity >= 0
        AND picked_quantity >= 0
        AND fulfilled_quantity >= 0
      )
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_outbound_shipment_items_order_item_required_chk'
  ) THEN
    ALTER TABLE wms.outbound_shipment_items
      ADD CONSTRAINT wms_outbound_shipment_items_order_item_required_chk
      CHECK (order_item_id IS NOT NULL)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_outbound_shipment_items_qty_positive_chk'
  ) THEN
    ALTER TABLE wms.outbound_shipment_items
      ADD CONSTRAINT wms_outbound_shipment_items_qty_positive_chk
      CHECK (qty > 0)
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wms_outbound_shipment_items_order_item_id_fkey'
  ) THEN
    ALTER TABLE wms.outbound_shipment_items
      ADD CONSTRAINT wms_outbound_shipment_items_order_item_id_fkey
      FOREIGN KEY (order_item_id)
      REFERENCES wms.order_items(id)
      NOT VALID;
  END IF;
END $$;

DROP INDEX IF EXISTS wms.uq_outbound_shipments_active_per_order;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipments_active_per_order
  ON wms.outbound_shipments (order_id)
  WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
    AND COALESCE(source, '') NOT IN (
      'echelon_combined_child',
      'shipstation_combined_child',
      'shipstation_split'
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_order_items_active_order_oms_line
  ON wms.order_items (order_id, oms_order_line_id)
  WHERE oms_order_line_id IS NOT NULL
    AND COALESCE(status, '') NOT IN ('cancelled', 'completed', 'short');

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_order_items_active_oms_line
  ON wms.order_items (oms_order_line_id)
  WHERE oms_order_line_id IS NOT NULL
    AND COALESCE(status, '') NOT IN ('cancelled', 'completed', 'short');

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipments_active_shipstation_order_id
  ON wms.outbound_shipments (shipstation_order_id)
  WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
    AND COALESCE(source, '') NOT IN (
      'echelon_combined_child',
      'shipstation_combined_child'
    )
    AND shipstation_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipments_active_shipstation_order_key
  ON wms.outbound_shipments (shipstation_order_key)
  WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
    AND COALESCE(source, '') NOT IN (
      'echelon_combined_child',
      'shipstation_combined_child'
    )
    AND NULLIF(BTRIM(shipstation_order_key), '') IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_outbound_shipments_active_engine_order_ref
  ON wms.outbound_shipments (shipping_engine, engine_order_ref)
  WHERE status IN ('planned', 'queued', 'labeled', 'on_hold')
    AND COALESCE(source, '') NOT IN (
      'echelon_combined_child',
      'shipstation_combined_child'
    )
    AND NULLIF(BTRIM(shipping_engine), '') IS NOT NULL
    AND NULLIF(BTRIM(engine_order_ref), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION wms.enforce_oms_wms_authority_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  wms_order RECORD;
  oms_line RECORD;
  expected_oms_order_ref TEXT;
  expected_oms_order_id BIGINT;
  active_materialized_quantity INTEGER;
BEGIN
  SELECT
    o.id,
    o.source,
    o.source_table_id,
    o.oms_fulfillment_order_id,
    o.warehouse_status,
    o.cancelled_at,
    o.completed_at
  INTO wms_order
  FROM wms.orders o
  WHERE o.id = NEW.order_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF COALESCE(wms_order.source, '') NOT IN ('oms', 'shopify', 'ebay')
     OR wms_order.warehouse_status NOT IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
     OR wms_order.cancelled_at IS NOT NULL
     OR wms_order.completed_at IS NOT NULL
     OR COALESCE(NEW.status, '') IN ('cancelled', 'completed', 'short') THEN
    RETURN NEW;
  END IF;

  IF NEW.oms_order_line_id IS NULL THEN
    RAISE EXCEPTION 'OMS-origin active WMS item % must reference oms_order_line_id', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_order_items_oms_line_required_authority_chk';
  END IF;

  SELECT
    ol.id,
    ol.order_id,
    ol.authority_fulfillable_quantity
  INTO oms_line
  FROM oms.oms_order_lines ol
  WHERE ol.id = NEW.oms_order_line_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WMS item % references missing OMS order line %', NEW.id, NEW.oms_order_line_id
      USING ERRCODE = '23503',
            CONSTRAINT = 'wms_order_items_oms_order_line_id_fkey';
  END IF;

  expected_oms_order_ref := NULLIF(TRIM(
    CASE
      WHEN wms_order.source = 'shopify' THEN COALESCE(wms_order.source_table_id::text, '')
      ELSE COALESCE(wms_order.oms_fulfillment_order_id::text, '')
    END
  ), '');

  IF expected_oms_order_ref IS NULL OR expected_oms_order_ref !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'OMS-origin WMS order % has no parseable OMS order reference', NEW.order_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_orders_oms_ref_required_authority_chk';
  END IF;

  expected_oms_order_id := expected_oms_order_ref::BIGINT;

  IF oms_line.order_id <> expected_oms_order_id THEN
    RAISE EXCEPTION 'WMS item % references OMS line % from order %, expected OMS order %',
      NEW.id,
      NEW.oms_order_line_id,
      oms_line.order_id,
      expected_oms_order_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_order_items_oms_line_order_match_chk';
  END IF;

  SELECT COALESCE(SUM(oi.quantity), 0)::int
  INTO active_materialized_quantity
  FROM wms.order_items oi
  JOIN wms.orders o ON o.id = oi.order_id
  WHERE oi.oms_order_line_id = NEW.oms_order_line_id
    AND o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
    AND o.cancelled_at IS NULL
    AND o.completed_at IS NULL
    AND COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short');

  IF active_materialized_quantity > COALESCE(oms_line.authority_fulfillable_quantity, 0) THEN
    RAISE EXCEPTION 'OMS line % over-materialized: active WMS quantity % exceeds authority %',
      NEW.oms_order_line_id,
      active_materialized_quantity,
      oms_line.authority_fulfillable_quantity
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_order_items_oms_line_authority_qty_chk';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_oms_wms_authority_item
  ON wms.order_items;

CREATE CONSTRAINT TRIGGER trg_enforce_oms_wms_authority_item
AFTER INSERT OR UPDATE OF order_id, oms_order_line_id, quantity, status
ON wms.order_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION wms.enforce_oms_wms_authority_item();

CREATE OR REPLACE FUNCTION wms.enforce_outbound_shipment_item_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  shipment_order_id INTEGER;
  item_order_id INTEGER;
BEGIN
  IF NEW.order_item_id IS NULL THEN
    RAISE EXCEPTION 'Outbound shipment item % must reference wms.order_items', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_outbound_shipment_items_order_item_required_chk';
  END IF;

  IF COALESCE(NEW.qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Outbound shipment item % qty must be positive', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_outbound_shipment_items_qty_positive_chk';
  END IF;

  SELECT s.order_id
  INTO shipment_order_id
  FROM wms.outbound_shipments s
  WHERE s.id = NEW.shipment_id;

  SELECT oi.order_id
  INTO item_order_id
  FROM wms.order_items oi
  WHERE oi.id = NEW.order_item_id;

  IF shipment_order_id IS NOT NULL
     AND item_order_id IS NOT NULL
     AND shipment_order_id <> item_order_id THEN
    RAISE EXCEPTION 'Shipment item % references order item % from WMS order %, expected %',
      NEW.id,
      NEW.order_item_id,
      item_order_id,
      shipment_order_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_outbound_shipment_items_order_match_chk';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_outbound_shipment_item_lineage
  ON wms.outbound_shipment_items;

CREATE CONSTRAINT TRIGGER trg_enforce_outbound_shipment_item_lineage
AFTER INSERT OR UPDATE OF shipment_id, order_item_id, qty
ON wms.outbound_shipment_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION wms.enforce_outbound_shipment_item_lineage();
