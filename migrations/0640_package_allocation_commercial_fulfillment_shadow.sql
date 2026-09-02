-- Exact package-allocation commercial fulfillment materialization.
--
-- Canonical channel commands produced from package-allocation evidence remain
-- non-dispatching until a separately reviewed activation gate promotes them.

ALTER TABLE oms.channel_fulfillment_pushes
  DROP CONSTRAINT IF EXISTS channel_fulfillment_pushes_status_chk;

ALTER TABLE oms.channel_fulfillment_pushes
  ADD CONSTRAINT channel_fulfillment_pushes_status_chk CHECK (
    push_status IN (
      'shadow',
      'pending',
      'processing',
      'retry',
      'success',
      'failed',
      'ignored',
      'review',
      'dead'
    )
  );

ALTER TABLE oms.channel_fulfillment_push_items
  ADD COLUMN package_allocation_effect_intent_id BIGINT;

ALTER TABLE oms.channel_fulfillment_push_items
  ADD CONSTRAINT fk_channel_fulfillment_push_items_package_effect_intent
  FOREIGN KEY (package_allocation_effect_intent_id)
  REFERENCES wms.package_allocation_effect_intents(id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_channel_fulfillment_push_items_package_effect_physical
  ON oms.channel_fulfillment_push_items(
    package_allocation_effect_intent_id,
    physical_shipment_item_id
  )
  WHERE package_allocation_effect_intent_id IS NOT NULL;

CREATE UNIQUE INDEX uq_channel_fulfillment_push_items_package_effect_item
  ON oms.channel_fulfillment_push_items(physical_shipment_item_id)
  WHERE package_allocation_effect_intent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION oms.validate_package_allocation_commercial_fulfillment_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  intent RECORD;
  lineage RECORD;
  already_materialized INTEGER;
BEGIN
  IF NEW.package_allocation_effect_intent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT
    effect.package_allocation_plan_id,
    effect.package_allocation_group_id,
    effect.package_allocation_source_line_id,
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
  WHERE command.id = NEW.channel_fulfillment_push_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Package-allocation commercial command item has incomplete physical lineage'
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
  WHERE item.package_allocation_effect_intent_id = NEW.package_allocation_effect_intent_id;

  IF already_materialized + NEW.quantity_pushed > intent.quantity THEN
    RAISE EXCEPTION
      'Package-allocation commercial intent % exceeds its immutable quantity',
      NEW.package_allocation_effect_intent_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_fulfillment_push_item_package_effect_guard
BEFORE INSERT ON oms.channel_fulfillment_push_items
FOR EACH ROW
EXECUTE FUNCTION oms.validate_package_allocation_commercial_fulfillment_item();

CREATE OR REPLACE FUNCTION oms.channel_fulfillment_push_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.oms_order_id IS DISTINCT FROM OLD.oms_order_id
     OR NEW.physical_shipment_id IS DISTINCT FROM OLD.physical_shipment_id
     OR NEW.channel_provider IS DISTINCT FROM OLD.channel_provider
     OR NEW.channel_fulfillment_scope_key IS DISTINCT FROM OLD.channel_fulfillment_scope_key
     OR NEW.command_key IS DISTINCT FROM OLD.command_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
     OR NEW.carrier IS DISTINCT FROM OLD.carrier
     OR NEW.tracking_url IS DISTINCT FROM OLD.tracking_url
     OR NEW.shipped_at IS DISTINCT FROM OLD.shipped_at
     OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Channel fulfillment command identity and request snapshot are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.command_key LIKE 'fulfillment:v1:%'
     AND NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    RAISE EXCEPTION 'Canonical channel fulfillment command metadata is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'Channel fulfillment attempt count cannot decrease'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.push_status IN ('success', 'ignored', 'dead')
     AND NEW.push_status IS DISTINCT FROM OLD.push_status THEN
    RAISE EXCEPTION 'Terminal channel fulfillment commands are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (OLD.push_status = 'shadow' AND NEW.push_status NOT IN ('shadow', 'pending', 'review', 'dead'))
     OR (OLD.push_status = 'pending' AND NEW.push_status NOT IN ('pending', 'processing', 'review', 'dead'))
     OR (OLD.push_status = 'processing' AND NEW.push_status NOT IN ('processing', 'retry', 'success', 'ignored', 'review', 'dead'))
     OR (OLD.push_status = 'retry' AND NEW.push_status NOT IN ('retry', 'processing', 'review', 'dead'))
     OR (OLD.push_status = 'failed' AND NEW.push_status NOT IN ('failed', 'retry', 'processing', 'review', 'dead'))
     OR (OLD.push_status = 'review' AND NEW.push_status NOT IN ('review', 'pending', 'retry', 'dead')) THEN
    RAISE EXCEPTION 'Invalid channel fulfillment command status transition: % -> %', OLD.push_status, NEW.push_status
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_fulfillment_push_update_guard
  ON oms.channel_fulfillment_pushes;
CREATE TRIGGER channel_fulfillment_push_update_guard
  BEFORE UPDATE ON oms.channel_fulfillment_pushes
  FOR EACH ROW EXECUTE FUNCTION oms.channel_fulfillment_push_update_guard();

COMMENT ON COLUMN oms.channel_fulfillment_push_items.package_allocation_effect_intent_id IS
  'Immutable commercial-effect provenance for a shadow command item; exact physical allocation lineage is enforced by trigger.';

COMMENT ON CONSTRAINT channel_fulfillment_pushes_status_chk
  ON oms.channel_fulfillment_pushes IS
  'shadow is non-dispatching; only pending and retry commands are claimable by the channel worker.';
