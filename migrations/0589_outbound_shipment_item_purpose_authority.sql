-- Align OMS/WMS shipment-item authority guardrails with replacement and
-- concession shipment lines introduced after the original guardrail.

ALTER TABLE wms.outbound_shipment_items
  DROP CONSTRAINT IF EXISTS wms_outbound_shipment_items_order_item_required_chk,
  DROP CONSTRAINT IF EXISTS outbound_shipment_items_authority_link_chk;

ALTER TABLE wms.outbound_shipment_items
  ADD CONSTRAINT outbound_shipment_items_purpose_authority_chk
  CHECK (
    (
      shipment_item_purpose = 'customer_fulfillment'
      AND order_item_id IS NOT NULL
      AND replacement_for_order_item_id IS NULL
    )
    OR (
      shipment_item_purpose = 'replacement'
      AND order_item_id IS NULL
      AND replacement_for_order_item_id IS NOT NULL
    )
    OR (
      shipment_item_purpose = 'concession'
      AND order_item_id IS NULL
      AND replacement_for_order_item_id IS NULL
      AND product_variant_id IS NOT NULL
    )
    OR (
      shipment_item_purpose = 'unclassified'
      AND order_item_id IS NULL
      AND replacement_for_order_item_id IS NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION wms.enforce_outbound_shipment_item_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  shipment_order_id INTEGER;
  authority_order_item_id INTEGER;
  item_order_id INTEGER;
BEGIN
  authority_order_item_id := CASE NEW.shipment_item_purpose
    WHEN 'customer_fulfillment' THEN NEW.order_item_id
    WHEN 'replacement' THEN NEW.replacement_for_order_item_id
    ELSE NULL
  END;

  IF NEW.shipment_item_purpose = 'customer_fulfillment'
     AND (
       NEW.order_item_id IS NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Customer fulfillment shipment item % must reference order_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'replacement'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Replacement shipment item % must reference replacement_for_order_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'concession'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.product_variant_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Concession shipment item % must reference product_variant_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'unclassified'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Unclassified shipment item % cannot claim order-line authority', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  END IF;

  IF COALESCE(NEW.qty, 0) <= 0 THEN
    RAISE EXCEPTION 'Outbound shipment item % qty must be positive', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'wms_outbound_shipment_items_qty_positive_chk';
  END IF;

  SELECT shipment.order_id
  INTO shipment_order_id
  FROM wms.outbound_shipments shipment
  WHERE shipment.id = NEW.shipment_id;

  IF authority_order_item_id IS NOT NULL THEN
    SELECT order_item.order_id
    INTO item_order_id
    FROM wms.order_items order_item
    WHERE order_item.id = authority_order_item_id;
  END IF;

  IF shipment_order_id IS NOT NULL
     AND item_order_id IS NOT NULL
     AND shipment_order_id <> item_order_id THEN
    RAISE EXCEPTION 'Shipment item % references order item % from WMS order %, expected %',
      NEW.id,
      authority_order_item_id,
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
AFTER INSERT OR UPDATE OF
  shipment_id,
  order_item_id,
  replacement_for_order_item_id,
  shipment_item_purpose,
  product_variant_id,
  qty
ON wms.outbound_shipment_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION wms.enforce_outbound_shipment_item_lineage();
