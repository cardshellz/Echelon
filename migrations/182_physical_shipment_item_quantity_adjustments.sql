-- Historical provider package corrections must preserve the original immutable
-- fulfillment evidence while allowing authoritative readers to consume the
-- corrected package quantity.

CREATE TABLE IF NOT EXISTS wms.physical_shipment_item_quantity_adjustments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  physical_shipment_item_id BIGINT NOT NULL
    REFERENCES wms.physical_shipment_items(id) ON DELETE RESTRICT,
  quantity_delta INTEGER NOT NULL,
  adjustment_kind VARCHAR(60) NOT NULL,
  repair_run_id UUID NOT NULL,
  idempotency_key VARCHAR(500) NOT NULL,
  operator VARCHAR(120) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT physical_shipment_item_quantity_adjustments_delta_chk
    CHECK (quantity_delta < 0),
  CONSTRAINT physical_shipment_item_quantity_adjustments_kind_chk
    CHECK (adjustment_kind = 'historical_provider_package_repartition'),
  CONSTRAINT physical_shipment_item_quantity_adjustments_operator_chk
    CHECK (btrim(operator) <> ''),
  CONSTRAINT physical_shipment_item_quantity_adjustments_reason_chk
    CHECK (btrim(reason) <> ''),
  CONSTRAINT physical_shipment_item_quantity_adjustments_idempotency_chk
    CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT physical_shipment_item_quantity_adjustments_once
    UNIQUE (physical_shipment_item_id)
);

CREATE INDEX IF NOT EXISTS idx_physical_shipment_item_quantity_adjustments_run
  ON wms.physical_shipment_item_quantity_adjustments(repair_run_id);

CREATE OR REPLACE FUNCTION wms.validate_physical_shipment_item_quantity_adjustment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  base_quantity INTEGER;
BEGIN
  SELECT item.quantity_shipped
  INTO base_quantity
  FROM wms.physical_shipment_items AS item
  WHERE item.id = NEW.physical_shipment_item_id
  FOR UPDATE;

  IF base_quantity IS NULL THEN
    RAISE EXCEPTION
      'Physical shipment item % does not exist',
      NEW.physical_shipment_item_id
      USING ERRCODE = '23503';
  END IF;

  IF base_quantity + NEW.quantity_delta < 0 THEN
    RAISE EXCEPTION
      'Physical shipment item % correction would make effective quantity negative',
      NEW.physical_shipment_item_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS physical_shipment_item_quantity_adjustment_validate
  ON wms.physical_shipment_item_quantity_adjustments;
CREATE TRIGGER physical_shipment_item_quantity_adjustment_validate
  BEFORE INSERT ON wms.physical_shipment_item_quantity_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION wms.validate_physical_shipment_item_quantity_adjustment();

CREATE OR REPLACE FUNCTION wms.reject_physical_shipment_item_quantity_adjustment_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'physical_shipment_item_quantity_adjustments is append-only correction evidence; % is not allowed',
    TG_OP
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS physical_shipment_item_quantity_adjustments_immutable
  ON wms.physical_shipment_item_quantity_adjustments;
CREATE TRIGGER physical_shipment_item_quantity_adjustments_immutable
  BEFORE UPDATE OR DELETE ON wms.physical_shipment_item_quantity_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION wms.reject_physical_shipment_item_quantity_adjustment_mutation();

CREATE OR REPLACE VIEW wms.effective_physical_shipment_items AS
SELECT
  item.id,
  item.physical_shipment_id,
  item.shipment_request_item_id,
  item.fulfillment_plan_line_id,
  item.wms_order_item_id,
  item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) AS quantity_shipped,
  item.provider_physical_shipment_line_id,
  item.provider_order_line_id,
  item.created_at,
  item.legacy_wms_shipment_item_id,
  item.shipment_item_purpose,
  item.replacement_for_order_item_id,
  item.product_variant_id,
  item.sku
FROM wms.physical_shipment_items AS item
LEFT JOIN wms.physical_shipment_item_quantity_adjustments AS adjustment
  ON adjustment.physical_shipment_item_id = item.id
WHERE item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) > 0;

COMMENT ON TABLE wms.physical_shipment_item_quantity_adjustments IS
  'Append-only corrections for historically over-attributed immutable physical shipment item quantities.';

COMMENT ON VIEW wms.effective_physical_shipment_items IS
  'Authoritative physical shipment item projection after append-only historical quantity corrections.';
