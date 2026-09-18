-- Forward label lifecycle only. No historical records are selected or changed.
ALTER TABLE wms.physical_shipment_items
  ADD COLUMN label_replacement_source_item_id integer REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT,
  DROP CONSTRAINT physical_shipment_items_single_source_provenance_chk,
  ADD CONSTRAINT physical_shipment_items_single_source_provenance_chk CHECK (
    num_nonnulls(legacy_wms_shipment_item_id, package_allocation_entry_id, label_replacement_source_item_id) <= 1
  );
CREATE UNIQUE INDEX physical_label_replacement_source_once
  ON wms.physical_shipment_items(physical_shipment_id, label_replacement_source_item_id)
  WHERE label_replacement_source_item_id IS NOT NULL;

CREATE TABLE wms.ebay_label_replacement_work (
  shipping_provider_label_id bigint PRIMARY KEY REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
  state varchar(20) NOT NULL CHECK (state IN ('waiting', 'review', 'applied')),
  reason varchar(100),
  physical_shipment_id bigint UNIQUE REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
  source_item_ids integer[] NOT NULL CHECK (cardinality(source_item_ids) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  projected_at timestamptz,
  CHECK ((state = 'applied') = (physical_shipment_id IS NOT NULL))
);
CREATE INDEX ebay_label_replacement_waiting ON wms.ebay_label_replacement_work(updated_at, shipping_provider_label_id)
  WHERE state = 'waiting' OR (state = 'applied' AND projected_at IS NULL);

ALTER TABLE wms.physical_shipment_item_quantity_adjustments
  DROP CONSTRAINT physical_shipment_item_quantity_adjustments_kind_chk,
  ADD CONSTRAINT physical_shipment_item_quantity_adjustments_kind_chk CHECK (
    adjustment_kind IN ('historical_provider_package_repartition', 'provider_label_replacement')
  );

CREATE OR REPLACE VIEW wms.effective_physical_shipment_items AS
SELECT item.id, item.physical_shipment_id, item.shipment_request_item_id,
  item.fulfillment_plan_line_id, item.wms_order_item_id,
  item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) AS quantity_shipped,
  item.provider_physical_shipment_line_id, item.provider_order_line_id, item.created_at,
  item.legacy_wms_shipment_item_id, item.shipment_item_purpose, item.replacement_for_order_item_id,
  item.product_variant_id, item.sku, item.package_allocation_entry_id, item.label_replacement_source_item_id
FROM wms.physical_shipment_items item
LEFT JOIN wms.physical_shipment_item_quantity_adjustments adjustment ON adjustment.physical_shipment_item_id = item.id
WHERE item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) > 0;

-- A negative transfer cannot commit without the corresponding new allocation.
CREATE FUNCTION wms.validate_label_replacement_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_item RECORD; target_item RECORD;
BEGIN
  IF NEW.adjustment_kind <> 'provider_label_replacement' THEN RETURN NEW; END IF;
  SELECT item.*, COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id,
    source.source_wms_shipment_item_id) AS source_id INTO source_item
  FROM wms.physical_shipment_items item
  LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
  LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
  WHERE item.id = NEW.physical_shipment_item_id;
  SELECT item.* INTO target_item FROM wms.physical_shipment_items item
  JOIN wms.ebay_label_replacement_work work ON work.physical_shipment_id = item.physical_shipment_id
  WHERE work.shipping_provider_label_id = (NEW.metadata->>'replacementLabelId')::bigint
    AND work.state = 'applied' AND item.label_replacement_source_item_id = source_item.source_id;
  IF target_item.id IS NULL OR NEW.quantity_delta <> -source_item.quantity_shipped
    OR target_item.quantity_shipped <> source_item.quantity_shipped
    OR target_item.fulfillment_plan_line_id IS DISTINCT FROM source_item.fulfillment_plan_line_id
    OR target_item.wms_order_item_id IS DISTINCT FROM source_item.wms_order_item_id
    OR target_item.shipment_request_item_id IS DISTINCT FROM source_item.shipment_request_item_id THEN
    RAISE EXCEPTION 'Label replacement must conserve exact source allocation %', NEW.physical_shipment_item_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER label_replacement_conservation
AFTER INSERT ON wms.physical_shipment_item_quantity_adjustments
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms.validate_label_replacement_conservation();

CREATE FUNCTION wms.validate_label_replacement_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.label_replacement_source_item_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wms.ebay_label_replacement_work work
    JOIN wms.shipping_provider_labels label ON label.id = work.shipping_provider_label_id
    JOIN wms.physical_shipments package ON package.id = work.physical_shipment_id
    JOIN wms.outbound_shipment_items source ON source.id = NEW.label_replacement_source_item_id
    JOIN wms.order_items order_item ON order_item.id = source.order_item_id
    JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id
    JOIN oms.oms_orders orders ON orders.id = line.order_id
    JOIN channels.channels channel ON channel.id = orders.channel_id
    WHERE work.state = 'applied' AND work.physical_shipment_id = NEW.physical_shipment_id
      AND source.id = ANY(work.source_item_ids) AND source.qty = NEW.quantity_shipped
      AND source.order_item_id = NEW.wms_order_item_id
      AND source.shipment_item_purpose = 'customer_fulfillment' AND channel.provider = 'ebay'
      AND package.provider = label.provider AND package.provider_physical_shipment_id = label.provider_label_id
      AND package.tracking_number = label.tracking_number AND label.label_status = 'active'
      AND label.label_direction = 'outbound'
  ) THEN
    RAISE EXCEPTION 'Physical item requires exact applied eBay label replacement provenance' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER label_replacement_source_provenance
AFTER INSERT ON wms.physical_shipment_items
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms.validate_label_replacement_source();

CREATE FUNCTION wms.protect_applied_label_replacement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'applied' AND (TG_OP = 'DELETE' OR
    (to_jsonb(NEW) - 'projected_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'projected_at' - 'updated_at')) THEN
    RAISE EXCEPTION 'Applied label replacement identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER applied_label_replacement_immutable BEFORE UPDATE OR DELETE ON wms.ebay_label_replacement_work
FOR EACH ROW EXECUTE FUNCTION wms.protect_applied_label_replacement();
