-- Forward-only current-package corrections. Carrier, inventory, original
-- physical items and failed channel attempts remain immutable evidence.
CREATE TABLE oms.package_reconciliation_commands (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_key varchar(200) NOT NULL UNIQUE CHECK (btrim(command_key) <> ''),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL UNIQUE,
  actor varchar(200) NOT NULL CHECK (btrim(actor) <> ''),
  reason varchar(500) NOT NULL CHECK (btrim(reason) <> ''),
  mode varchar(30) NOT NULL CHECK (mode IN ('live', 'adopt_existing')),
  state varchar(20) NOT NULL CHECK (state IN ('applying', 'applied', 'complete')),
  evidence jsonb NOT NULL,
  plan jsonb NOT NULL,
  result jsonb,
  channel_readbacks jsonb,
  resume_attempt_count integer NOT NULL DEFAULT 0 CHECK (resume_attempt_count BETWEEN 0 AND 8),
  next_resume_at timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL,
  applied_at timestamptz,
  completed_at timestamptz,
  CHECK ((state <> 'applying') = (applied_at IS NOT NULL)),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL))
);
CREATE INDEX package_reconciliation_pending_readback
  ON oms.package_reconciliation_commands(id) WHERE state = 'applied' AND mode = 'adopt_existing';

ALTER TABLE wms.ebay_label_replacement_work
  ADD COLUMN package_reconciliation_command_id bigint
    REFERENCES oms.package_reconciliation_commands(id) ON DELETE RESTRICT;
ALTER TABLE wms.physical_shipment_item_quantity_adjustments
  DROP CONSTRAINT physical_shipment_item_quantity_adjustments_kind_chk,
  ADD CONSTRAINT physical_shipment_item_quantity_adjustments_kind_chk CHECK (
    adjustment_kind IN ('historical_provider_package_repartition', 'provider_label_replacement', 'provider_package_reconciliation')
  );

CREATE FUNCTION oms.protect_package_reconciliation_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state = 'complete'
    OR (NEW.command_key, NEW.request_hash, NEW.operation_id, NEW.actor, NEW.reason, NEW.mode, NEW.evidence, NEW.plan, NEW.created_at)
      IS DISTINCT FROM (OLD.command_key, OLD.request_hash, OLD.operation_id, OLD.actor, OLD.reason, OLD.mode, OLD.evidence, OLD.plan, OLD.created_at)
    OR NOT ((OLD.state = 'applying' AND NEW.state = 'applied') OR (OLD.state = 'applied' AND NEW.state IN ('applied','complete')))
    OR (OLD.state = 'applied' AND (NEW.result, NEW.applied_at) IS DISTINCT FROM (OLD.result, OLD.applied_at))
    OR (OLD.state = 'applied' AND NEW.state = 'applied' AND (NEW.channel_readbacks,NEW.completed_at) IS DISTINCT FROM (OLD.channel_readbacks,OLD.completed_at))
    OR NEW.resume_attempt_count < OLD.resume_attempt_count
  THEN RAISE EXCEPTION 'Package reconciliation identity and applied evidence are immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER package_reconciliation_command_immutable BEFORE UPDATE OR DELETE ON oms.package_reconciliation_commands
  FOR EACH ROW EXECUTE FUNCTION oms.protect_package_reconciliation_command();

CREATE FUNCTION wms.protect_package_reconciliation_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'applied' AND NEW.package_reconciliation_command_id IS DISTINCT FROM OLD.package_reconciliation_command_id
  THEN RAISE EXCEPTION 'Applied reconciliation provenance is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER package_reconciliation_work_immutable BEFORE UPDATE ON wms.ebay_label_replacement_work
  FOR EACH ROW EXECUTE FUNCTION wms.protect_package_reconciliation_work();

-- Verify both sides and the entire surviving source allocation. A relabel may
-- transfer one unit while another parcel consumes one still-unused paid unit;
-- equating every new parcel to the retired quantity incorrectly rejects this.
CREATE FUNCTION oms.validate_package_reconciliation(command_id bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE command_row RECORD; source_row RECORD; target_row RECORD; actual_quantity bigint; expected_quantity bigint;
  source_capacity bigint; actual_ids bigint[]; expected_ids bigint[];
BEGIN
  SELECT * INTO command_row FROM oms.package_reconciliation_commands WHERE id = command_id;
  IF command_row.id IS NULL OR command_row.state NOT IN ('applied', 'complete') OR command_row.result IS NULL
    OR command_row.plan->>'outcome' NOT IN ('ready', 'unchanged') THEN
    RAISE EXCEPTION 'Package reconciliation must commit an applied planner receipt' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(array_agg(value::bigint ORDER BY value::bigint), '{}'::bigint[]) INTO expected_ids
    FROM jsonb_array_elements_text(command_row.plan->'physicalItemIdsToRetire');
  SELECT COALESCE(array_agg(adjustment.physical_shipment_item_id ORDER BY adjustment.physical_shipment_item_id), '{}'::bigint[]) INTO actual_ids
    FROM wms.physical_shipment_item_quantity_adjustments adjustment
    WHERE adjustment.adjustment_kind = 'provider_package_reconciliation' AND adjustment.repair_run_id = command_row.operation_id;
  IF actual_ids IS DISTINCT FROM expected_ids THEN
    RAISE EXCEPTION 'Package reconciliation retirement set differs from its planner receipt' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM wms.physical_shipment_item_quantity_adjustments adjustment
    JOIN wms.physical_shipment_items item ON item.id = adjustment.physical_shipment_item_id
    WHERE adjustment.adjustment_kind = 'provider_package_reconciliation' AND adjustment.repair_run_id = command_row.operation_id
      AND (adjustment.quantity_delta <> -item.quantity_shipped OR (adjustment.metadata->>'reconciliationCommandId')::bigint IS DISTINCT FROM command_id))
  THEN RAISE EXCEPTION 'Package reconciliation must retire exact immutable quantities' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM wms.physical_shipment_item_quantity_adjustments adjustment
    JOIN wms.physical_shipment_items item ON item.id=adjustment.physical_shipment_item_id
    JOIN wms.physical_shipments package ON package.id=item.physical_shipment_id
    JOIN wms.shipping_provider_labels label ON label.provider=package.provider AND label.provider_label_id=package.provider_physical_shipment_id
    WHERE adjustment.adjustment_kind='provider_package_reconciliation' AND adjustment.repair_run_id=command_row.operation_id
      AND (label.label_status <> 'voided' OR EXISTS(SELECT 1 FROM wms.carrier_tracking_event_matches match
        JOIN wms.carrier_tracking_events event ON event.id=match.carrier_tracking_event_id
        WHERE match.shipping_provider_label_id=label.id AND match.match_status IN ('matched','voided_label') AND event.dispatch_evidence='confirmed'))
      AND NOT COALESCE((command_row.evidence->'correction'->>'kind'='confirmed_package_contents_correction'
        AND command_row.evidence->'correction'->>'actorId'=command_row.actor
        AND command_row.plan->'correctedPreviousLabelIds' @> to_jsonb(ARRAY[label.id])
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(command_row.evidence->'relationships') AS relation(document)
          WHERE relation.document->'mergedProviderOrderIds' @> to_jsonb(ARRAY[label.provider_order_id])
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(command_row.evidence->'labels') AS target(document)
              WHERE target.document->>'providerOrderId'=relation.document->>'providerOrderId'
                AND command_row.plan->'labelIdsToMaterialize' @> jsonb_build_array((target.document->>'labelId')::bigint)))),false)
  ) THEN RAISE EXCEPTION 'Carrier-owned or active contents require explicit authenticated merge correction evidence' USING ERRCODE='23514'; END IF;

  SELECT COALESCE(array_agg(value::bigint ORDER BY value::bigint), '{}'::bigint[]) INTO expected_ids
    FROM jsonb_array_elements_text(command_row.plan->'labelIdsToMaterialize');
  SELECT COALESCE(array_agg(work.shipping_provider_label_id ORDER BY work.shipping_provider_label_id), '{}'::bigint[]) INTO actual_ids
    FROM wms.ebay_label_replacement_work work WHERE work.package_reconciliation_command_id = command_id AND work.state = 'applied';
  IF actual_ids IS DISTINCT FROM expected_ids THEN
    RAISE EXCEPTION 'Package reconciliation target set differs from its planner receipt' USING ERRCODE = '23514';
  END IF;
  FOR source_row IN SELECT * FROM jsonb_to_recordset(command_row.plan->'sourceQuantities') AS s(
    "sourceItemId" integer, "sourceQuantity" integer, "preservedQuantity" integer, "retiredQuantity" integer,
    "materializedQuantity" integer, "additionalQuantity" integer, "finalQuantity" integer)
  LOOP
    SELECT COALESCE((SELECT MAX(source_quantity) FROM wms.package_allocation_source_lines WHERE source_wms_shipment_item_id = source_row."sourceItemId"),
      (SELECT SUM(qty) FROM wms.outbound_shipment_items WHERE id = source_row."sourceItemId" OR split_root_shipment_item_id = source_row."sourceItemId")) INTO source_capacity;
    SELECT COALESCE(SUM(item.quantity_shipped), 0) INTO actual_quantity
      FROM wms.effective_physical_shipment_items item
      LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
      LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
      WHERE COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id) = source_row."sourceItemId";
    IF source_capacity IS NULL OR source_row."sourceQuantity" IS DISTINCT FROM source_capacity
      OR actual_quantity IS DISTINCT FROM source_row."finalQuantity" OR actual_quantity > source_capacity
      OR source_row."additionalQuantity" < 0
      OR source_row."retiredQuantity" + source_row."additionalQuantity" <> source_row."materializedQuantity"
      OR source_row."preservedQuantity" + source_row."materializedQuantity" <> source_row."finalQuantity"
    THEN RAISE EXCEPTION 'Package reconciliation violates source % conservation', source_row."sourceItemId" USING ERRCODE = '23514'; END IF;
  END LOOP;
  FOR target_row IN SELECT work.physical_shipment_id, label.id AS label_id, label.provider_label_id, label.tracking_number,
      package.provider_physical_shipment_id, package.tracking_number AS package_tracking, label.label_status, label.label_direction
    FROM wms.ebay_label_replacement_work work JOIN wms.shipping_provider_labels label ON label.id = work.shipping_provider_label_id
    JOIN wms.physical_shipments package ON package.id = work.physical_shipment_id WHERE work.package_reconciliation_command_id = command_id
  LOOP
    IF target_row.label_status <> 'active' OR target_row.label_direction <> 'outbound'
      OR target_row.provider_label_id IS DISTINCT FROM target_row.provider_physical_shipment_id
      OR target_row.tracking_number IS DISTINCT FROM target_row.package_tracking THEN
      RAISE EXCEPTION 'Package reconciliation target identity is not current' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      (SELECT (manifest_line.document->>'sourceItemId')::integer, (manifest_line.document->>'quantity')::bigint
        FROM jsonb_array_elements(command_row.evidence->'labels') AS pkg(document),
          jsonb_array_elements(pkg.document->'contents') AS manifest_line(document) WHERE (pkg.document->>'labelId')::bigint = target_row.label_id
       EXCEPT SELECT item.label_replacement_source_item_id, SUM(item.quantity_shipped)
         FROM wms.physical_shipment_items item WHERE item.physical_shipment_id = target_row.physical_shipment_id GROUP BY item.label_replacement_source_item_id)
      UNION ALL
      (SELECT item.label_replacement_source_item_id, SUM(item.quantity_shipped)
         FROM wms.physical_shipment_items item WHERE item.physical_shipment_id = target_row.physical_shipment_id GROUP BY item.label_replacement_source_item_id
       EXCEPT SELECT (manifest_line.document->>'sourceItemId')::integer, (manifest_line.document->>'quantity')::bigint
         FROM jsonb_array_elements(command_row.evidence->'labels') AS pkg(document),
           jsonb_array_elements(pkg.document->'contents') AS manifest_line(document) WHERE (pkg.document->>'labelId')::bigint = target_row.label_id)
    ) THEN RAISE EXCEPTION 'Package reconciliation target contents differ from verified evidence' USING ERRCODE = '23514'; END IF;
  END LOOP;
END; $$;

CREATE FUNCTION oms.validate_package_reconciliation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Validate allocation at its commit boundary. Later retry metadata records
  -- history; it must not reinterpret an earlier receipt as a current label.
  IF TG_OP='INSERT' OR OLD.state='applying' THEN PERFORM oms.validate_package_reconciliation(NEW.id); END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER package_reconciliation_receipt_conservation AFTER INSERT OR UPDATE ON oms.package_reconciliation_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION oms.validate_package_reconciliation_receipt();

CREATE FUNCTION wms.validate_package_reconciliation_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.adjustment_kind = 'provider_package_reconciliation' THEN
    PERFORM oms.validate_package_reconciliation((NEW.metadata->>'reconciliationCommandId')::bigint);
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER package_reconciliation_adjustment_conservation AFTER INSERT ON wms.physical_shipment_item_quantity_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wms.validate_package_reconciliation_adjustment();

-- Keep the v2 rolling-deploy contract unchanged for all older work.
CREATE OR REPLACE FUNCTION wms.validate_label_replacement_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_id uuid; old_total bigint; new_total bigint; reconciliation_command_id bigint;
BEGIN
  IF NEW.label_replacement_source_item_id IS NULL THEN RETURN NEW; END IF;
  SELECT package_reconciliation_command_id INTO reconciliation_command_id
    FROM wms.ebay_label_replacement_work WHERE physical_shipment_id = NEW.physical_shipment_id;
  IF reconciliation_command_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM wms.ebay_label_replacement_work work
      JOIN wms.shipping_provider_labels label ON label.id = work.shipping_provider_label_id
      JOIN wms.physical_shipments package ON package.id = work.physical_shipment_id
      JOIN wms.outbound_shipment_items source ON source.id = NEW.label_replacement_source_item_id
      JOIN wms.shipment_request_items request ON request.id = NEW.shipment_request_item_id
      JOIN wms.fulfillment_plan_lines plan_line ON plan_line.id = NEW.fulfillment_plan_line_id
      WHERE work.package_reconciliation_command_id = reconciliation_command_id AND work.state = 'applied'
        AND work.physical_shipment_id = NEW.physical_shipment_id AND source.id = ANY(work.source_item_ids)
        AND source.order_item_id = NEW.wms_order_item_id AND source.shipment_item_purpose = 'customer_fulfillment'
        AND request.fulfillment_plan_line_id = plan_line.id AND request.wms_order_item_id = NEW.wms_order_item_id
        AND request.legacy_wms_shipment_item_id = source.id AND plan_line.wms_order_item_id = NEW.wms_order_item_id
        AND NEW.product_variant_id IS NOT DISTINCT FROM source.product_variant_id
        AND package.provider = label.provider AND package.provider_physical_shipment_id = label.provider_label_id
        AND package.tracking_number = label.tracking_number AND label.label_status = 'active' AND label.label_direction = 'outbound'
    ) THEN RAISE EXCEPTION 'Reconciled physical item requires exact source, request and current label provenance' USING ERRCODE = '23514'; END IF;
    PERFORM oms.validate_package_reconciliation(reconciliation_command_id);
    RETURN NEW;
  END IF;
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
      AND source.id = ANY(work.source_item_ids) AND source.qty >= NEW.quantity_shipped
      AND source.order_item_id = NEW.wms_order_item_id
      AND source.shipment_item_purpose = 'customer_fulfillment' AND channel.provider IN ('ebay', 'shopify')
      AND package.provider = label.provider AND package.provider_physical_shipment_id = label.provider_label_id
      AND package.tracking_number = label.tracking_number AND label.label_status = 'active' AND label.label_direction = 'outbound'
  ) THEN
    RAISE EXCEPTION 'Physical item requires exact applied label replacement provenance' USING ERRCODE = '23514';
  END IF;
  SELECT replacement_batch_id INTO batch_id FROM wms.ebay_label_replacement_work WHERE physical_shipment_id = NEW.physical_shipment_id;
  IF batch_id IS NOT NULL THEN
    -- Check the positive side too: an extra target must not commit simply
    -- because no negative-side trigger was fired for its request identity.
    SELECT SUM(-adjustment.quantity_delta) INTO old_total
    FROM wms.physical_shipment_item_quantity_adjustments adjustment
    JOIN wms.physical_shipment_items item ON item.id = adjustment.physical_shipment_item_id
    LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
    LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
    WHERE adjustment.repair_run_id = batch_id AND adjustment.adjustment_kind = 'provider_label_replacement'
      AND COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id) = NEW.label_replacement_source_item_id;
    IF old_total IS NOT NULL THEN
      SELECT SUM(item.quantity_shipped) INTO new_total FROM wms.physical_shipment_items item
      JOIN wms.ebay_label_replacement_work work ON work.physical_shipment_id = item.physical_shipment_id
      WHERE work.replacement_batch_id = batch_id AND work.state = 'applied'
        AND item.label_replacement_source_item_id = NEW.label_replacement_source_item_id;
      IF new_total IS DISTINCT FROM old_total THEN
        RAISE EXCEPTION 'Replacement batch creates additional source quantity' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
