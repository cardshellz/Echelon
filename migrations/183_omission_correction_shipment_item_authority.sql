-- A packing omission is physically corrected by a later package, but the
-- original package already owns inventory and customer-fulfillment authority.
-- Preserve exact source-line lineage while preventing either authority from
-- being posted a second time.

ALTER TABLE wms.outbound_shipment_items
  ADD COLUMN IF NOT EXISTS correction_for_shipment_item_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'wms.outbound_shipment_items'::regclass
      AND conname = 'outbound_shipment_items_correction_source_fk'
  ) THEN
    ALTER TABLE wms.outbound_shipment_items
      ADD CONSTRAINT outbound_shipment_items_correction_source_fk
      FOREIGN KEY (correction_for_shipment_item_id)
      REFERENCES wms.outbound_shipment_items(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_outbound_shipment_items_correction_source
  ON wms.outbound_shipment_items (correction_for_shipment_item_id)
  WHERE correction_for_shipment_item_id IS NOT NULL;

ALTER TABLE wms.outbound_shipment_items
  DROP CONSTRAINT IF EXISTS outbound_shipment_items_purpose_authority_chk;

ALTER TABLE wms.outbound_shipment_items
  ADD CONSTRAINT outbound_shipment_items_purpose_authority_chk
  CHECK (
    (
      shipment_item_purpose = 'customer_fulfillment'
      AND order_item_id IS NOT NULL
      AND replacement_for_order_item_id IS NULL
      AND correction_for_shipment_item_id IS NULL
    )
    OR (
      shipment_item_purpose = 'replacement'
      AND order_item_id IS NULL
      AND replacement_for_order_item_id IS NOT NULL
      AND correction_for_shipment_item_id IS NULL
    )
    OR (
      shipment_item_purpose = 'concession'
      AND order_item_id IS NULL
      AND replacement_for_order_item_id IS NULL
      AND correction_for_shipment_item_id IS NULL
      AND product_variant_id IS NOT NULL
    )
    OR (
      shipment_item_purpose = 'omission_correction'
      AND order_item_id IS NULL
      AND replacement_for_order_item_id IS NULL
      AND correction_for_shipment_item_id IS NOT NULL
      AND product_variant_id IS NOT NULL
    )
    OR (
      shipment_item_purpose = 'unclassified'
      AND order_item_id IS NULL
      AND replacement_for_order_item_id IS NULL
      AND correction_for_shipment_item_id IS NULL
    )
  ) NOT VALID;

ALTER TABLE wms.physical_shipment_items
  ADD COLUMN IF NOT EXISTS correction_for_physical_shipment_item_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'wms.physical_shipment_items'::regclass
      AND conname = 'physical_shipment_items_correction_source_fk'
  ) THEN
    ALTER TABLE wms.physical_shipment_items
      ADD CONSTRAINT physical_shipment_items_correction_source_fk
      FOREIGN KEY (correction_for_physical_shipment_item_id)
      REFERENCES wms.physical_shipment_items(id)
      ON DELETE RESTRICT
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_physical_shipment_items_correction_source
  ON wms.physical_shipment_items (correction_for_physical_shipment_item_id)
  WHERE correction_for_physical_shipment_item_id IS NOT NULL;

ALTER TABLE wms.physical_shipment_items
  DROP CONSTRAINT IF EXISTS physical_shipment_items_purpose_chk,
  DROP CONSTRAINT IF EXISTS physical_shipment_items_lineage_chk;

ALTER TABLE wms.physical_shipment_items
  ADD CONSTRAINT physical_shipment_items_purpose_chk CHECK (
    shipment_item_purpose IN (
      'customer_fulfillment',
      'replacement',
      'concession',
      'omission_correction'
    )
  ) NOT VALID,
  ADD CONSTRAINT physical_shipment_items_lineage_chk CHECK (
    (
      shipment_item_purpose = 'customer_fulfillment'
      AND shipment_request_item_id IS NOT NULL
      AND fulfillment_plan_line_id IS NOT NULL
      AND wms_order_item_id IS NOT NULL
      AND replacement_for_order_item_id IS NULL
      AND correction_for_physical_shipment_item_id IS NULL
    )
    OR (
      shipment_item_purpose = 'replacement'
      AND shipment_request_item_id IS NULL
      AND fulfillment_plan_line_id IS NULL
      AND wms_order_item_id IS NULL
      AND replacement_for_order_item_id IS NOT NULL
      AND correction_for_physical_shipment_item_id IS NULL
    )
    OR (
      shipment_item_purpose = 'concession'
      AND shipment_request_item_id IS NULL
      AND fulfillment_plan_line_id IS NULL
      AND wms_order_item_id IS NULL
      AND replacement_for_order_item_id IS NULL
      AND correction_for_physical_shipment_item_id IS NULL
    )
    OR (
      shipment_item_purpose = 'omission_correction'
      AND shipment_request_item_id IS NULL
      AND fulfillment_plan_line_id IS NULL
      AND wms_order_item_id IS NULL
      AND replacement_for_order_item_id IS NULL
      AND correction_for_physical_shipment_item_id IS NOT NULL
      AND legacy_wms_shipment_item_id IS NOT NULL
      AND product_variant_id IS NOT NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION wms.enforce_physical_shipment_item_correction_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_source_shipment_item_id INTEGER;
  source_item RECORD;
  correction_quantity INTEGER;
BEGIN
  IF NEW.shipment_item_purpose <> 'omission_correction' THEN
    RETURN NEW;
  END IF;

  IF NEW.correction_for_physical_shipment_item_id = NEW.id THEN
    RAISE EXCEPTION 'Physical omission correction item % cannot correct itself', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'physical_shipment_items_correction_lineage_chk';
  END IF;

  SELECT legacy_item.correction_for_shipment_item_id
  INTO legacy_source_shipment_item_id
  FROM wms.outbound_shipment_items legacy_item
  WHERE legacy_item.id = NEW.legacy_wms_shipment_item_id
    AND legacy_item.shipment_item_purpose = 'omission_correction';

  IF legacy_source_shipment_item_id IS NULL THEN
    RAISE EXCEPTION 'Physical omission correction item % lacks matching WMS correction authority', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'physical_shipment_items_correction_lineage_chk';
  END IF;

  SELECT source.id,
         source.physical_shipment_id,
         source.legacy_wms_shipment_item_id,
         source.shipment_item_purpose,
         source.product_variant_id,
         source.sku,
         source.quantity_shipped
  INTO source_item
  FROM wms.physical_shipment_items source
  WHERE source.id = NEW.correction_for_physical_shipment_item_id
  FOR UPDATE;

  IF NOT FOUND
     OR source_item.shipment_item_purpose <> 'customer_fulfillment'
     OR source_item.legacy_wms_shipment_item_id <> legacy_source_shipment_item_id
     OR source_item.physical_shipment_id = NEW.physical_shipment_id
     OR source_item.product_variant_id IS DISTINCT FROM NEW.product_variant_id
     OR UPPER(BTRIM(source_item.sku)) <> UPPER(BTRIM(NEW.sku)) THEN
    RAISE EXCEPTION 'Physical omission correction item % does not match its exact original package line', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'physical_shipment_items_correction_lineage_chk';
  END IF;

  SELECT COALESCE(SUM(correction.quantity_shipped), 0)::int
  INTO correction_quantity
  FROM wms.physical_shipment_items correction
  WHERE correction.shipment_item_purpose = 'omission_correction'
    AND correction.correction_for_physical_shipment_item_id = NEW.correction_for_physical_shipment_item_id;

  IF correction_quantity > source_item.quantity_shipped THEN
    RAISE EXCEPTION 'Physical omission correction quantity % exceeds original package line % quantity %',
      correction_quantity,
      NEW.correction_for_physical_shipment_item_id,
      source_item.quantity_shipped
      USING ERRCODE = '23514',
            CONSTRAINT = 'physical_shipment_items_correction_quantity_chk';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_physical_shipment_item_correction_lineage
  ON wms.physical_shipment_items;

CREATE CONSTRAINT TRIGGER trg_enforce_physical_shipment_item_correction_lineage
AFTER INSERT OR UPDATE OF
  physical_shipment_id,
  legacy_wms_shipment_item_id,
  shipment_item_purpose,
  correction_for_physical_shipment_item_id,
  product_variant_id,
  sku,
  quantity_shipped
ON wms.physical_shipment_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION wms.enforce_physical_shipment_item_correction_lineage();

CREATE OR REPLACE FUNCTION wms.enforce_outbound_shipment_item_lineage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  shipment_order_id INTEGER;
  authority_order_item_id INTEGER;
  item_order_id INTEGER;
  source_shipment_item RECORD;
  source_candidate_count INTEGER;
  source_inventory_shipped_quantity INTEGER;
  source_item_correction_quantity INTEGER;
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
       OR NEW.correction_for_shipment_item_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Customer fulfillment shipment item % must reference order_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'replacement'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NULL
       OR NEW.correction_for_shipment_item_id IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'Replacement shipment item % must reference replacement_for_order_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'concession'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.correction_for_shipment_item_id IS NOT NULL
       OR NEW.product_variant_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Concession shipment item % must reference product_variant_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'omission_correction'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.correction_for_shipment_item_id IS NULL
       OR NEW.product_variant_id IS NULL
     ) THEN
    RAISE EXCEPTION 'Omission correction shipment item % must reference correction_for_shipment_item_id only', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
  ELSIF NEW.shipment_item_purpose = 'unclassified'
     AND (
       NEW.order_item_id IS NOT NULL
       OR NEW.replacement_for_order_item_id IS NOT NULL
       OR NEW.correction_for_shipment_item_id IS NOT NULL
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

  IF NEW.shipment_item_purpose = 'omission_correction' THEN
    IF NEW.correction_for_shipment_item_id = NEW.id THEN
      RAISE EXCEPTION 'Omission correction shipment item % cannot correct itself', NEW.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
    END IF;

    SELECT
      source_item.order_item_id,
      source_item.shipment_id,
      source_item.product_variant_id,
      source_item.qty,
      source_item.shipment_item_purpose,
      source_shipment.order_id,
      source_shipment.status
    INTO source_shipment_item
    FROM wms.outbound_shipment_items source_item
    JOIN wms.outbound_shipments source_shipment
      ON source_shipment.id = source_item.shipment_id
    WHERE source_item.id = NEW.correction_for_shipment_item_id
    FOR UPDATE OF source_item;

    IF source_shipment_item.order_item_id IS NULL
       OR source_shipment_item.shipment_item_purpose <> 'customer_fulfillment'
       OR source_shipment_item.product_variant_id IS DISTINCT FROM NEW.product_variant_id
       OR source_shipment_item.order_id IS DISTINCT FROM shipment_order_id
       OR source_shipment_item.status NOT IN ('shipped', 'returned', 'lost') THEN
      RAISE EXCEPTION 'Omission correction shipment item % lacks a terminal customer-fulfillment source line on the same order', NEW.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
    END IF;

    SELECT COUNT(*)::int
    INTO source_candidate_count
    FROM wms.outbound_shipment_items source_candidate
    WHERE source_candidate.shipment_id = source_shipment_item.shipment_id
      AND source_candidate.order_item_id = source_shipment_item.order_item_id
      AND source_candidate.shipment_item_purpose = 'customer_fulfillment'
      AND source_candidate.qty > 0;

    IF source_candidate_count <> 1 THEN
      RAISE EXCEPTION 'Omission correction source shipment item % is ambiguous across % customer-fulfillment lines',
        NEW.correction_for_shipment_item_id,
        source_candidate_count
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_omission_source_ambiguity_chk';
    END IF;

    authority_order_item_id := source_shipment_item.order_item_id;

    SELECT COALESCE(SUM(correction_item.qty), 0)::int
    INTO source_item_correction_quantity
    FROM wms.outbound_shipment_items correction_item
    JOIN wms.outbound_shipments correction_shipment
      ON correction_shipment.id = correction_item.shipment_id
    WHERE correction_item.shipment_item_purpose = 'omission_correction'
      AND correction_item.correction_for_shipment_item_id = NEW.correction_for_shipment_item_id
      AND correction_shipment.status NOT IN ('cancelled', 'voided');

    IF source_item_correction_quantity > source_shipment_item.qty THEN
      RAISE EXCEPTION 'Omission correction quantity % exceeds source shipment item % quantity %',
        source_item_correction_quantity,
        NEW.correction_for_shipment_item_id,
        source_shipment_item.qty
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_purpose_authority_chk';
    END IF;

    SELECT COALESCE(SUM(ABS(inventory_tx.variant_qty_delta)), 0)::int
    INTO source_inventory_shipped_quantity
    FROM inventory.inventory_transactions inventory_tx
    WHERE inventory_tx.transaction_type = 'ship'
      AND inventory_tx.shipment_id = source_shipment_item.shipment_id
      AND inventory_tx.order_item_id = source_shipment_item.order_item_id
      AND inventory_tx.product_variant_id = source_shipment_item.product_variant_id
      AND inventory_tx.voided_at IS NULL;

    IF source_inventory_shipped_quantity < source_shipment_item.qty THEN
      RAISE EXCEPTION 'Omission correction source shipment item % has only % of % units posted to inventory',
        NEW.correction_for_shipment_item_id,
        source_inventory_shipped_quantity,
        source_shipment_item.qty
        USING ERRCODE = '23514',
              CONSTRAINT = 'outbound_shipment_items_omission_inventory_proof_chk';
    END IF;
  END IF;

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
  correction_for_shipment_item_id,
  shipment_item_purpose,
  product_variant_id,
  qty
ON wms.outbound_shipment_items
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION wms.enforce_outbound_shipment_item_lineage();
