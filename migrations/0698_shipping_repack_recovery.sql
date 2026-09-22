-- Forward-only package/repack receipts. Existing allocations and history are
-- unchanged; nullable batch identity preserves rolling-deploy compatibility.
ALTER TABLE wms.ebay_label_replacement_work ADD COLUMN replacement_batch_id uuid;
CREATE INDEX label_replacement_batch ON wms.ebay_label_replacement_work(replacement_batch_id)
  WHERE replacement_batch_id IS NOT NULL;

CREATE OR REPLACE FUNCTION wms.validate_label_replacement_conservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_item RECORD; target_item RECORD; old_total bigint; new_total bigint;
BEGIN
  IF NEW.adjustment_kind <> 'provider_label_replacement' THEN RETURN NEW; END IF;
  SELECT item.*, COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id,
    source.source_wms_shipment_item_id) AS source_id INTO source_item
  FROM wms.physical_shipment_items item
  LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
  LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
  WHERE item.id = NEW.physical_shipment_item_id;
  IF NEW.metadata ? 'replacementBatchId' THEN
    IF (NEW.metadata->>'replacementBatchId')::uuid IS DISTINCT FROM NEW.repair_run_id
      OR NEW.quantity_delta <> -source_item.quantity_shipped THEN
      RAISE EXCEPTION 'Repack must consume the exact immutable predecessor quantity' USING ERRCODE = '23514';
    END IF;
    SELECT SUM(-adjustment.quantity_delta) INTO old_total
    FROM wms.physical_shipment_item_quantity_adjustments adjustment
    JOIN wms.physical_shipment_items item ON item.id = adjustment.physical_shipment_item_id
    LEFT JOIN wms.package_allocation_entries entry ON entry.id = item.package_allocation_entry_id
    LEFT JOIN wms.package_allocation_source_lines source ON source.id = entry.package_allocation_source_line_id
    WHERE adjustment.repair_run_id = NEW.repair_run_id AND adjustment.adjustment_kind = 'provider_label_replacement'
      AND COALESCE(item.legacy_wms_shipment_item_id, item.label_replacement_source_item_id, source.source_wms_shipment_item_id) = source_item.source_id
      AND item.fulfillment_plan_line_id = source_item.fulfillment_plan_line_id
      AND item.shipment_request_item_id = source_item.shipment_request_item_id
      AND item.wms_order_item_id = source_item.wms_order_item_id;
    SELECT SUM(item.quantity_shipped) INTO new_total
    FROM wms.physical_shipment_items item
    JOIN wms.ebay_label_replacement_work work ON work.physical_shipment_id = item.physical_shipment_id
    WHERE work.replacement_batch_id = NEW.repair_run_id AND work.state = 'applied'
      AND item.label_replacement_source_item_id = source_item.source_id
      AND item.fulfillment_plan_line_id = source_item.fulfillment_plan_line_id
      AND item.shipment_request_item_id = source_item.shipment_request_item_id
      AND item.wms_order_item_id = source_item.wms_order_item_id;
    IF old_total IS NULL OR new_total IS DISTINCT FROM old_total THEN
      RAISE EXCEPTION 'Repack does not conserve source %, request %', source_item.source_id, source_item.shipment_request_item_id USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Old application releases retain their exact one-to-one transfer contract.
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

-- Only provider identities are retained, never addresses or raw API payloads.
-- Discovery hands off to this queue in the same transaction as its watermark.
CREATE TABLE oms.shipstation_label_recovery_work (
  provider_label_id bigint PRIMARY KEY CHECK (provider_label_id > 0),
  provider_order_id bigint CHECK (provider_order_id > 0),
  tracking_number varchar(200) NOT NULL CHECK (tracking_number = BTRIM(tracking_number) AND tracking_number <> ''),
  state varchar(20) NOT NULL CHECK (state IN ('pending', 'complete', 'review')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  last_error_code varchar(100),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((state = 'pending') = (next_attempt_at IS NOT NULL)),
  CHECK (state = 'pending' OR lease_until IS NULL),
  CHECK (state <> 'pending' OR attempt_count < 8)
);
CREATE INDEX shipstation_label_recovery_due ON oms.shipstation_label_recovery_work(next_attempt_at, provider_label_id) WHERE state = 'pending';
CREATE TABLE oms.shipstation_label_recovery_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_label_id bigint NOT NULL REFERENCES oms.shipstation_label_recovery_work(provider_label_id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 8),
  outcome varchar(20) NOT NULL CHECK (outcome IN ('pending', 'complete', 'review')),
  error_code varchar(100),
  completed_at timestamptz NOT NULL,
  actor varchar(100) NOT NULL,
  UNIQUE (provider_label_id, attempt_number)
);
CREATE FUNCTION oms.protect_label_recovery_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'pending'
    OR ROW(NEW.provider_label_id, NEW.provider_order_id, NEW.tracking_number, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.provider_label_id, OLD.provider_order_id, OLD.tracking_number, OLD.created_at) THEN
    RAISE EXCEPTION 'Label recovery identity and terminal evidence are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER label_recovery_work_immutable BEFORE UPDATE OR DELETE ON oms.shipstation_label_recovery_work
  FOR EACH ROW EXECUTE FUNCTION oms.protect_label_recovery_work();
CREATE FUNCTION oms.protect_label_recovery_attempts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Label recovery attempts are immutable' USING ERRCODE = '55000';
END; $$;
CREATE TRIGGER label_recovery_attempts_immutable BEFORE UPDATE OR DELETE ON oms.shipstation_label_recovery_attempts
  FOR EACH ROW EXECUTE FUNCTION oms.protect_label_recovery_attempts();

CREATE OR REPLACE FUNCTION wms.validate_label_replacement_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_id uuid; old_total bigint; new_total bigint;
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
