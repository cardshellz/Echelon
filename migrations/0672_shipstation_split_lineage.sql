-- Preserve exact source-line identity when one ordered WMS line is shipped in
-- multiple ShipStation packages. This is fulfillment evidence only: the
-- migration does not change inventory, picked quantities, or order quantities.

ALTER TABLE wms.outbound_shipment_items
  ADD COLUMN split_root_shipment_item_id INTEGER;

ALTER TABLE wms.outbound_shipment_items
  ADD CONSTRAINT fk_outbound_shipment_items_split_source
  FOREIGN KEY (split_root_shipment_item_id)
  REFERENCES wms.outbound_shipment_items(id)
  ON DELETE RESTRICT;

CREATE INDEX idx_outbound_shipment_items_split_source
  ON wms.outbound_shipment_items(split_root_shipment_item_id)
  WHERE split_root_shipment_item_id IS NOT NULL;

-- A package-scoped commercial intent may materialize only the allocation entry
-- for that exact package. Legacy source-scoped intents remain valid for plans
-- written before split continuation support.
CREATE OR REPLACE FUNCTION oms.validate_package_allocation_commercial_fulfillment_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent RECORD;
  lineage RECORD;
  already_materialized INTEGER;
  split_continuation_proven BOOLEAN;
BEGIN
  IF NEW.package_allocation_effect_intent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    effect.package_allocation_plan_id,
    effect.package_allocation_group_id,
    effect.package_allocation_source_line_id,
    effect.package_allocation_package_binding_id,
    effect.effect_type,
    effect.quantity,
    effect.executable
  INTO intent
  FROM wms.package_allocation_effect_intents AS effect
  WHERE effect.id = NEW.package_allocation_effect_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Package-allocation commercial intent % does not exist',
      NEW.package_allocation_effect_intent_id
      USING ERRCODE = '23503';
  END IF;

  SELECT
    command.push_status,
    physical.package_allocation_entry_id,
    physical.quantity_shipped AS physical_quantity,
    entry.package_allocation_plan_id,
    entry.package_allocation_group_id,
    entry.package_allocation_source_line_id,
    entry.package_allocation_package_binding_id,
    source.source_wms_shipment_item_id,
    entry.allocation_kind,
    entry.target_kind,
    entry.quantity AS allocation_quantity
  INTO lineage
  FROM oms.channel_fulfillment_pushes AS command
  JOIN wms.physical_shipment_items AS physical
    ON physical.id = NEW.physical_shipment_item_id
   AND physical.physical_shipment_id = command.physical_shipment_id
  JOIN wms.package_allocation_entries AS entry
    ON entry.id = physical.package_allocation_entry_id
  JOIN wms.package_allocation_source_lines AS source
    ON source.id = entry.package_allocation_source_line_id
  WHERE command.id = NEW.channel_fulfillment_push_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Package-allocation commercial command item has incomplete physical lineage'
      USING ERRCODE = '23514';
  END IF;

  IF intent.package_allocation_package_binding_id IS NOT NULL THEN
    split_continuation_proven := FALSE;
    SELECT TRUE
    INTO split_continuation_proven
    FROM wms.package_allocation_package_bindings AS binding
    JOIN wms.shipping_provider_labels AS label
      ON LOWER(BTRIM(label.provider)) = LOWER(BTRIM(binding.provider))
     AND BTRIM(label.provider_label_id) =
       BTRIM(binding.provider_physical_shipment_id)
    JOIN wms.shipping_provider_label_links AS link
      ON link.shipping_provider_label_id = label.id
     AND link.legacy_wms_shipment_id IS NOT NULL
     AND link.source = 'legacy_provider_physical_identity'
    JOIN wms.outbound_shipments AS split_shipment
      ON split_shipment.id = link.legacy_wms_shipment_id
    JOIN wms.outbound_shipment_items AS child
      ON child.shipment_id = split_shipment.id
    JOIN wms.outbound_shipment_items AS source_item
      ON source_item.id = child.split_root_shipment_item_id
    JOIN wms.outbound_shipments AS source_shipment
      ON source_shipment.id = source_item.shipment_id
    WHERE binding.id = intent.package_allocation_package_binding_id
      AND label.provider = 'shipstation'
      AND label.label_direction = 'outbound'
      AND split_shipment.source = 'shipstation_split'
      AND split_shipment.status = 'shipped'
      AND split_shipment.external_fulfillment_id =
        'shipstation_shipment:' || label.provider_label_id
      AND BTRIM(COALESCE(split_shipment.tracking_number, '')) =
        BTRIM(label.tracking_number)
      AND child.provider_membership_state = 'authoritative'
      AND child.tracking_id = label.provider_label_id
      AND (
        child.id <> source_item.id
        OR EXISTS (
          SELECT 1
          FROM wms.outbound_shipment_items AS sibling
          WHERE sibling.split_root_shipment_item_id = source_item.id
            AND sibling.id <> source_item.id
        )
      )
      AND child.qty = lineage.physical_quantity
      AND source_item.id = lineage.source_wms_shipment_item_id
      AND (
        source_item.split_root_shipment_item_id IS NULL
        OR source_item.split_root_shipment_item_id = source_item.id
      )
      AND source_shipment.order_id = split_shipment.order_id
      AND source_item.order_item_id IS NOT DISTINCT FROM child.order_item_id
      AND source_item.replacement_for_order_item_id IS NOT DISTINCT FROM
        child.replacement_for_order_item_id
      AND source_item.correction_for_shipment_item_id IS NOT DISTINCT FROM
        child.correction_for_shipment_item_id
      AND source_item.shipment_item_purpose IS NOT DISTINCT FROM
        child.shipment_item_purpose
      AND source_item.product_variant_id IS NOT DISTINCT FROM
        child.product_variant_id
    ORDER BY child.id
    LIMIT 1
    FOR SHARE OF binding, label, link, split_shipment, child, source_item,
      source_shipment;

    IF split_continuation_proven IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'Package-scoped commercial intent % lacks exact ShipStation split lineage',
        NEW.package_allocation_effect_intent_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF intent.effect_type <> 'commercial_fulfillment'
     OR intent.executable IS DISTINCT FROM FALSE
     OR intent.quantity IS NULL
     OR lineage.push_status <> 'shadow'
     OR lineage.allocation_kind <> 'primary_transfer'
     OR lineage.target_kind <> 'package'
     OR lineage.package_allocation_plan_id IS DISTINCT FROM intent.package_allocation_plan_id
     OR lineage.package_allocation_group_id IS DISTINCT FROM intent.package_allocation_group_id
     OR lineage.package_allocation_source_line_id IS DISTINCT FROM intent.package_allocation_source_line_id
     OR (
       intent.package_allocation_package_binding_id IS NOT NULL
       AND lineage.package_allocation_package_binding_id IS DISTINCT FROM
         intent.package_allocation_package_binding_id
     )
     OR lineage.allocation_quantity IS DISTINCT FROM lineage.physical_quantity
     OR NEW.quantity_pushed IS DISTINCT FROM lineage.physical_quantity THEN
    RAISE EXCEPTION
      'Channel fulfillment item does not match package-allocation commercial intent %',
      NEW.package_allocation_effect_intent_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(item.quantity_pushed), 0)::integer
  INTO already_materialized
  FROM oms.channel_fulfillment_push_items AS item
  WHERE item.package_allocation_effect_intent_id =
    NEW.package_allocation_effect_intent_id;

  IF already_materialized + NEW.quantity_pushed > intent.quantity THEN
    RAISE EXCEPTION
      'Package-allocation commercial intent % exceeds its immutable quantity',
      NEW.package_allocation_effect_intent_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- Two already-proven production splits predate the lineage column. Backfill
-- only those exact package rows, and abort if an anchored row no longer has the
-- reviewed order, package, quantity, and item parity. Fresh databases have no
-- matching anchors and therefore perform no data update.
DO $$
DECLARE
  repair RECORD;
BEGIN
  FOR repair IN
    SELECT *
    FROM (VALUES
      (22442, 22122, 17312, '458438895', '9434650206217286018017'),
      (22461, 22101, 17329, '458655645', '877076049400')
    ) AS reviewed(
      child_item_id,
      source_item_id,
      split_shipment_id,
      provider_label_id,
      tracking_number
    )
  LOOP
    IF EXISTS (
      SELECT 1
      FROM wms.outbound_shipment_items AS child
      WHERE child.id = repair.child_item_id
    ) THEN
      IF NOT EXISTS (
        SELECT 1
        FROM wms.outbound_shipment_items AS child
        JOIN wms.outbound_shipments AS split_shipment
          ON split_shipment.id = child.shipment_id
        JOIN wms.outbound_shipment_items AS source_item
          ON source_item.id = repair.source_item_id
        JOIN wms.outbound_shipments AS source_shipment
          ON source_shipment.id = source_item.shipment_id
        JOIN wms.shipping_provider_labels AS label
          ON label.provider = 'shipstation'
         AND label.provider_label_id = repair.provider_label_id
         AND label.label_direction = 'outbound'
         AND BTRIM(label.tracking_number) = repair.tracking_number
        JOIN wms.shipping_provider_label_links AS link
          ON link.shipping_provider_label_id = label.id
         AND link.legacy_wms_shipment_id = split_shipment.id
         AND link.source = 'legacy_provider_physical_identity'
        WHERE child.id = repair.child_item_id
          AND split_shipment.id = repair.split_shipment_id
          AND split_shipment.order_id = source_shipment.order_id
          AND split_shipment.source = 'shipstation_split'
          AND split_shipment.status = 'shipped'
          AND split_shipment.external_fulfillment_id =
            'shipstation_shipment:' || repair.provider_label_id
          AND BTRIM(split_shipment.tracking_number) = repair.tracking_number
          AND child.tracking_id = repair.provider_label_id
          AND child.provider_membership_state = 'authoritative'
          AND child.qty = 1
          AND source_item.qty >= 1
          AND source_item.split_root_shipment_item_id IS NULL
          AND child.order_item_id IS NOT DISTINCT FROM source_item.order_item_id
          AND child.replacement_for_order_item_id IS NOT DISTINCT FROM
            source_item.replacement_for_order_item_id
          AND child.correction_for_shipment_item_id IS NOT DISTINCT FROM
            source_item.correction_for_shipment_item_id
          AND child.shipment_item_purpose IS NOT DISTINCT FROM
            source_item.shipment_item_purpose
          AND child.product_variant_id IS NOT DISTINCT FROM
            source_item.product_variant_id
          AND (
            child.split_root_shipment_item_id IS NULL
            OR child.split_root_shipment_item_id = repair.source_item_id
          )
      ) THEN
        RAISE EXCEPTION
          'Reviewed ShipStation split lineage no longer matches child %, source %, shipment %',
          repair.child_item_id,
          repair.source_item_id,
          repair.split_shipment_id;
      END IF;

      UPDATE wms.outbound_shipment_items
      SET split_root_shipment_item_id = repair.source_item_id
      WHERE id = repair.child_item_id
        AND split_root_shipment_item_id IS NULL;
    END IF;
  END LOOP;
END;
$$;
