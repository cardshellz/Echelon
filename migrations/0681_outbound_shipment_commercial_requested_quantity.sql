-- Keep immutable provider/source-line identity after a refund removes current
-- commercial demand. NULL preserves the pre-migration meaning of qty.
ALTER TABLE wms.outbound_shipment_items
  ADD COLUMN commercial_requested_qty integer;

ALTER TABLE wms.outbound_shipment_items
  ADD CONSTRAINT outbound_shipment_items_commercial_requested_qty_chk
  CHECK (
    commercial_requested_qty IS NULL
    OR commercial_requested_qty BETWEEN 0 AND qty
  );

-- An allocation entry and its canonical physical item continue to record the
-- whole provider package. Only the shadow channel command may use a smaller
-- quantity after a cancellation/refund. Retain every lineage and package-
-- portion check from 0674; relax only command-to-physical equality to a bound.
CREATE OR REPLACE FUNCTION oms.validate_package_allocation_commercial_fulfillment_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent RECORD;
  lineage RECORD;
  already_materialized BIGINT;
  package_portion_proven BOOLEAN;
BEGIN
  IF NEW.package_allocation_effect_intent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT effect.package_allocation_plan_id, effect.package_allocation_group_id,
    effect.package_allocation_source_line_id, effect.package_allocation_package_binding_id,
    effect.effect_type, effect.quantity, effect.executable
  INTO intent
  FROM wms.package_allocation_effect_intents AS effect
  WHERE effect.id = NEW.package_allocation_effect_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Package-allocation commercial intent % does not exist',
      NEW.package_allocation_effect_intent_id USING ERRCODE = '23503';
  END IF;

  SELECT command.push_status, physical.package_allocation_entry_id,
    physical.quantity_shipped AS physical_quantity,
    entry.package_allocation_plan_id, entry.package_allocation_group_id,
    entry.package_allocation_source_line_id, entry.package_allocation_package_binding_id,
    source.source_wms_shipment_item_id, source.source_quantity,
    entry.allocation_kind, entry.target_kind, entry.quantity AS allocation_quantity
  INTO lineage
  FROM oms.channel_fulfillment_pushes AS command
  JOIN wms.physical_shipment_items AS physical
    ON physical.id = NEW.physical_shipment_item_id
   AND physical.physical_shipment_id = command.physical_shipment_id
  JOIN wms.package_allocation_entries AS entry ON entry.id = physical.package_allocation_entry_id
  JOIN wms.package_allocation_source_lines AS source ON source.id = entry.package_allocation_source_line_id
  WHERE command.id = NEW.channel_fulfillment_push_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Package-allocation commercial command item has incomplete physical lineage'
      USING ERRCODE = '23514';
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
     OR (intent.package_allocation_package_binding_id IS NOT NULL
       AND lineage.package_allocation_package_binding_id IS DISTINCT FROM intent.package_allocation_package_binding_id)
     OR lineage.allocation_quantity IS DISTINCT FROM lineage.physical_quantity
     OR NEW.quantity_pushed <= 0
     OR NEW.quantity_pushed > lineage.physical_quantity THEN
    RAISE EXCEPTION 'Channel fulfillment item does not match package-allocation commercial intent %',
      NEW.package_allocation_effect_intent_id USING ERRCODE = '23514';
  END IF;

  IF intent.package_allocation_package_binding_id IS NOT NULL THEN
    SELECT TRUE INTO package_portion_proven
    FROM wms.package_allocation_package_bindings AS binding
    JOIN wms.package_allocation_plans AS plan ON plan.id = intent.package_allocation_plan_id
    JOIN wms.shipping_provider_labels AS label
      ON label.provider = binding.provider
     AND label.provider_label_id = binding.provider_physical_shipment_id
    WHERE binding.id = intent.package_allocation_package_binding_id
      AND binding.package_allocation_group_id = intent.package_allocation_group_id
      AND label.provider = 'shipstation'
      AND label.label_direction = 'outbound'
      AND label.label_status = 'active'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(plan.state_snapshot->'packageSnapshots') AS snapshot
        WHERE snapshot->>'packageKey' = binding.package_key
          AND snapshot->>'membershipStatus' = 'proven'
          AND snapshot->>'splitContinuationEvidenceKey' LIKE 'shipstation-label-portion:v1:%'
      )
      AND EXISTS (
        SELECT 1 FROM wms.shipping_provider_label_events AS event
        WHERE event.shipping_provider_label_id = label.id
          AND event.sanitized_payload->'declaredContentsEvidence'->>'status' = 'authoritative'
          AND event.sanitized_payload->'declaredContentsEvidence'->'lines' @>
            jsonb_build_array(jsonb_build_object(
              'lineItemKey', 'wms-item-' || lineage.source_wms_shipment_item_id,
              'quantity', lineage.physical_quantity
            ))
      )
      AND (
        SELECT COALESCE(SUM(entry.quantity::bigint), 0)
        FROM wms.package_allocation_entries AS entry
        WHERE entry.package_allocation_plan_id = intent.package_allocation_plan_id
          AND entry.package_allocation_source_line_id = intent.package_allocation_source_line_id
          AND entry.allocation_kind = 'primary_transfer'
      ) <= lineage.source_quantity
    FOR SHARE OF binding, label, plan;

    IF package_portion_proven IS DISTINCT FROM TRUE THEN
      SELECT TRUE INTO package_portion_proven
      FROM wms.package_allocation_package_bindings AS binding
      JOIN wms.shipping_provider_labels AS label
        ON LOWER(BTRIM(label.provider)) = LOWER(BTRIM(binding.provider))
       AND BTRIM(label.provider_label_id) = BTRIM(binding.provider_physical_shipment_id)
      JOIN wms.shipping_provider_label_links AS link
        ON link.shipping_provider_label_id = label.id
       AND link.legacy_wms_shipment_id IS NOT NULL
       AND link.source = 'legacy_provider_physical_identity'
      JOIN wms.outbound_shipments AS split_shipment ON split_shipment.id = link.legacy_wms_shipment_id
      JOIN wms.outbound_shipment_items AS child ON child.shipment_id = split_shipment.id
      JOIN wms.outbound_shipment_items AS source_item ON source_item.id = child.split_root_shipment_item_id
      JOIN wms.outbound_shipments AS source_shipment ON source_shipment.id = source_item.shipment_id
      WHERE binding.id = intent.package_allocation_package_binding_id
        AND label.provider = 'shipstation'
        AND label.label_direction = 'outbound'
        AND split_shipment.source = 'shipstation_split'
        AND split_shipment.status = 'shipped'
        AND split_shipment.external_fulfillment_id = 'shipstation_shipment:' || label.provider_label_id
        AND BTRIM(COALESCE(split_shipment.tracking_number, '')) = BTRIM(label.tracking_number)
        AND child.provider_membership_state = 'authoritative'
        AND child.tracking_id = label.provider_label_id
        AND (child.id <> source_item.id OR EXISTS (
          SELECT 1 FROM wms.outbound_shipment_items AS sibling
          WHERE sibling.split_root_shipment_item_id = source_item.id AND sibling.id <> source_item.id
        ))
        AND child.qty = lineage.physical_quantity
        AND source_item.id = lineage.source_wms_shipment_item_id
        AND (source_item.split_root_shipment_item_id IS NULL OR source_item.split_root_shipment_item_id = source_item.id)
        AND source_shipment.order_id = split_shipment.order_id
        AND source_item.order_item_id IS NOT DISTINCT FROM child.order_item_id
        AND source_item.replacement_for_order_item_id IS NOT DISTINCT FROM child.replacement_for_order_item_id
        AND source_item.correction_for_shipment_item_id IS NOT DISTINCT FROM child.correction_for_shipment_item_id
        AND source_item.shipment_item_purpose IS NOT DISTINCT FROM child.shipment_item_purpose
        AND source_item.product_variant_id IS NOT DISTINCT FROM child.product_variant_id
      ORDER BY child.id LIMIT 1
      FOR SHARE OF binding, label, link, split_shipment, child, source_item, source_shipment;
    END IF;
    IF package_portion_proven IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Package-scoped commercial intent % lacks exact package portion evidence',
        NEW.package_allocation_effect_intent_id USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COALESCE(SUM(item.quantity_pushed::bigint), 0) INTO already_materialized
  FROM oms.channel_fulfillment_push_items AS item
  WHERE item.package_allocation_effect_intent_id = NEW.package_allocation_effect_intent_id;
  IF already_materialized + NEW.quantity_pushed > intent.quantity THEN
    RAISE EXCEPTION 'Package-allocation commercial intent % exceeds its immutable quantity',
      NEW.package_allocation_effect_intent_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
