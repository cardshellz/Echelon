-- Bridge exact package-allocation evidence into canonical physical shipment items.
-- This migration creates no runtime writer and dispatches no external effects.

ALTER TABLE wms.physical_shipment_items
  ADD COLUMN package_allocation_entry_id BIGINT;

ALTER TABLE wms.physical_shipment_items
  ADD CONSTRAINT fk_physical_shipment_items_package_allocation_entry
  FOREIGN KEY (package_allocation_entry_id)
  REFERENCES wms.package_allocation_entries(id)
  ON DELETE RESTRICT,
  ADD CONSTRAINT physical_shipment_items_single_source_provenance_chk
  CHECK (
    NUM_NONNULLS(
      legacy_wms_shipment_item_id,
      package_allocation_entry_id
    ) <= 1
  );

CREATE UNIQUE INDEX uq_physical_shipment_items_package_allocation_entry
  ON wms.physical_shipment_items(package_allocation_entry_id)
  WHERE package_allocation_entry_id IS NOT NULL;

CREATE OR REPLACE FUNCTION wms.validate_physical_shipment_item_allocation_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allocation RECORD;
BEGIN
  IF NEW.package_allocation_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    entry.quantity,
    entry.target_kind,
    plan.outcome AS plan_outcome,
    plan.plan_version,
    allocation_group.current_version AS group_current_version,
    source.shipment_item_purpose,
    source.shipment_request_item_id,
    source.order_item_id,
    source.replacement_for_order_item_id,
    source.product_variant_id,
    source.sku,
    binding.provider,
    binding.provider_physical_shipment_id,
    physical.provider AS physical_provider,
    physical.provider_physical_shipment_id AS physical_provider_shipment_id
  INTO allocation
  FROM wms.package_allocation_entries AS entry
  JOIN wms.package_allocation_source_lines AS source
    ON source.id = entry.package_allocation_source_line_id
  JOIN wms.package_allocation_plans AS plan
    ON plan.id = entry.package_allocation_plan_id
   AND plan.package_allocation_group_id = entry.package_allocation_group_id
  JOIN wms.package_allocation_groups AS allocation_group
    ON allocation_group.id = entry.package_allocation_group_id
  JOIN wms.package_allocation_package_bindings AS binding
    ON binding.id = entry.package_allocation_package_binding_id
  JOIN wms.physical_shipments AS physical
    ON physical.id = NEW.physical_shipment_id
  WHERE entry.id = NEW.package_allocation_entry_id
  FOR SHARE OF allocation_group;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Package allocation entry % does not have complete package provenance',
      NEW.package_allocation_entry_id
      USING ERRCODE = '23503';
  END IF;

  IF allocation.target_kind <> 'package'
     OR allocation.plan_outcome <> 'proposed'
     OR allocation.plan_version <> allocation.group_current_version
     OR allocation.quantity <> NEW.quantity_shipped
     OR allocation.shipment_item_purpose <> NEW.shipment_item_purpose
     OR (
       allocation.shipment_request_item_id IS NOT NULL
       AND allocation.shipment_request_item_id IS DISTINCT FROM NEW.shipment_request_item_id
     )
     OR allocation.order_item_id IS DISTINCT FROM NEW.wms_order_item_id
     OR allocation.replacement_for_order_item_id IS DISTINCT FROM NEW.replacement_for_order_item_id
     OR allocation.product_variant_id IS DISTINCT FROM NEW.product_variant_id
     OR allocation.sku IS DISTINCT FROM NEW.sku
     OR LOWER(BTRIM(allocation.provider)) IS DISTINCT FROM LOWER(BTRIM(allocation.physical_provider))
     OR BTRIM(allocation.provider_physical_shipment_id)
          IS DISTINCT FROM BTRIM(allocation.physical_provider_shipment_id) THEN
    RAISE EXCEPTION
      'Physical shipment item does not match package allocation entry %',
      NEW.package_allocation_entry_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_physical_shipment_items_allocation_provenance
BEFORE INSERT ON wms.physical_shipment_items
FOR EACH ROW
EXECUTE FUNCTION wms.validate_physical_shipment_item_allocation_provenance();

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
  item.sku,
  item.package_allocation_entry_id
FROM wms.physical_shipment_items AS item
LEFT JOIN wms.physical_shipment_item_quantity_adjustments AS adjustment
  ON adjustment.physical_shipment_item_id = item.id
WHERE item.quantity_shipped + COALESCE(adjustment.quantity_delta, 0) > 0;

COMMENT ON COLUMN wms.physical_shipment_items.package_allocation_entry_id IS
  'Immutable exact package-allocation provenance for split-safe physical shipment items; mutually exclusive with the legacy whole-line pointer.';
