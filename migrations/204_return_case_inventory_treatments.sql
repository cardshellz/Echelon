ALTER TABLE returns.return_case_commands
  DROP CONSTRAINT IF EXISTS return_case_commands_type_chk;

ALTER TABLE returns.return_case_commands
  ADD CONSTRAINT return_case_commands_type_chk CHECK (
    command_type IN (
      'record_receipt',
      'start_inspection',
      'complete_inspection',
      'record_disposition',
      'apply_inventory_treatment'
    )
  );

CREATE TABLE returns.return_case_inventory_treatments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL REFERENCES returns.return_cases(id),
  idempotency_key varchar(160) NOT NULL,
  request_hash varchar(64) NOT NULL,
  applied_by varchar(255) NOT NULL,
  notes text,
  applied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_inventory_treatments_idempotency_uq UNIQUE (idempotency_key),
  CONSTRAINT return_case_inventory_treatments_idempotency_key_chk CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT return_case_inventory_treatments_request_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT return_case_inventory_treatments_actor_chk CHECK (btrim(applied_by) <> '')
);

CREATE INDEX return_case_inventory_treatments_case_idx
  ON returns.return_case_inventory_treatments (return_case_id, applied_at, id);

CREATE TABLE returns.return_case_inventory_treatment_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_treatment_id bigint NOT NULL REFERENCES returns.return_case_inventory_treatments(id),
  disposition_item_id bigint NOT NULL REFERENCES returns.return_case_disposition_items(id),
  return_case_item_id bigint NOT NULL REFERENCES returns.return_case_items(id),
  treatment varchar(32) NOT NULL,
  quantity integer NOT NULL,
  warehouse_location_id integer REFERENCES warehouse.warehouse_locations(id),
  inventory_transaction_id integer REFERENCES inventory.inventory_transactions(id),
  inventory_lot_id integer REFERENCES inventory.inventory_lots(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_inventory_treatment_items_source_uq UNIQUE (disposition_item_id),
  CONSTRAINT return_case_inventory_treatment_items_treatment_chk CHECK (
    treatment IN ('restock_sellable', 'hold_non_sellable')
  ),
  CONSTRAINT return_case_inventory_treatment_items_quantity_chk CHECK (quantity > 0),
  CONSTRAINT return_case_inventory_treatment_items_effect_chk CHECK (
    (treatment = 'restock_sellable'
      AND warehouse_location_id IS NOT NULL
      AND inventory_transaction_id IS NOT NULL
      AND inventory_lot_id IS NOT NULL)
    OR (treatment = 'hold_non_sellable'
      AND warehouse_location_id IS NULL
      AND inventory_transaction_id IS NULL
      AND inventory_lot_id IS NULL)
  )
);

CREATE INDEX return_case_inventory_treatment_items_case_item_idx
  ON returns.return_case_inventory_treatment_items (return_case_item_id, id);

CREATE UNIQUE INDEX return_inventory_treatment_transaction_uq
  ON inventory.inventory_transactions (reference_id)
  WHERE transaction_type = 'return'
    AND reference_type = 'return_inventory_treatment'
    AND voided_at IS NULL;

CREATE OR REPLACE FUNCTION returns.validate_return_case_inventory_treatment_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_case_id bigint;
  source_return_case_item_id bigint;
  source_treatment varchar(32);
  source_quantity integer;
  source_recorded_at timestamptz;
  treatment_applied_at timestamptz;
  ledger_variant_delta integer;
  ledger_location_id integer;
  ledger_reference_type varchar(30);
  ledger_reference_id varchar(100);
  ledger_inventory_lot_id integer;
  ledger_source_state varchar(20);
  ledger_target_state varchar(20);
  lot_variant_id integer;
  lot_location_id integer;
  lot_qty_on_hand integer;
  lot_qty_received integer;
  lot_qty_consumed integer;
  lot_status varchar(20);
  source_variant_id integer;
BEGIN
  SELECT
    disposition.return_case_id,
    source_item.return_case_item_id,
    source_item.treatment,
    source_item.quantity,
    disposition.recorded_at
  INTO
    source_case_id,
    source_return_case_item_id,
    source_treatment,
    source_quantity,
    source_recorded_at
  FROM returns.return_case_disposition_items source_item
  JOIN returns.return_case_dispositions disposition
    ON disposition.id = source_item.disposition_id
  JOIN returns.return_case_items case_item
    ON case_item.id = source_item.return_case_item_id
  WHERE source_item.id = NEW.disposition_item_id
  FOR KEY SHARE OF source_item, disposition, case_item;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory treatment requires an existing disposition item'
      USING ERRCODE = '23503';
  END IF;

  SELECT treatment_header.applied_at
  INTO treatment_applied_at
  FROM returns.return_case_inventory_treatments treatment_header
  WHERE treatment_header.id = NEW.inventory_treatment_id
    AND treatment_header.return_case_id = source_case_id
  FOR KEY SHARE;

  IF NOT FOUND
     OR NEW.return_case_item_id <> source_return_case_item_id
     OR NEW.treatment <> source_treatment
     OR NEW.quantity <> source_quantity THEN
    RAISE EXCEPTION 'Inventory treatment must exactly match its immutable disposition source'
      USING ERRCODE = '23514';
  END IF;

  IF treatment_applied_at < source_recorded_at THEN
    RAISE EXCEPTION 'Inventory treatment cannot predate its immutable disposition source'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.treatment = 'restock_sellable' THEN
    SELECT oms_line.product_variant_id
    INTO source_variant_id
    FROM returns.return_case_items case_item
    JOIN oms.oms_order_lines oms_line
      ON oms_line.id = case_item.oms_order_line_id
    WHERE case_item.id = source_return_case_item_id
    FOR KEY SHARE OF case_item, oms_line;

    IF source_variant_id IS NULL THEN
      RAISE EXCEPTION 'Sellable restock requires a canonical product variant'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      transaction.variant_qty_delta,
      transaction.to_location_id,
      transaction.reference_type,
      transaction.reference_id,
      transaction.inventory_lot_id,
      transaction.source_state,
      transaction.target_state
    INTO
      ledger_variant_delta,
      ledger_location_id,
      ledger_reference_type,
      ledger_reference_id,
      ledger_inventory_lot_id,
      ledger_source_state,
      ledger_target_state
    FROM inventory.inventory_transactions transaction
    WHERE transaction.id = NEW.inventory_transaction_id
      AND transaction.product_variant_id = source_variant_id
      AND transaction.transaction_type = 'return'
      AND transaction.voided_at IS NULL
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sellable inventory transaction evidence is missing'
        USING ERRCODE = '23514';
    END IF;

    SELECT
      lot.product_variant_id,
      lot.warehouse_location_id,
      lot.qty_on_hand,
      lot.qty_received,
      lot.qty_consumed,
      lot.status
    INTO
      lot_variant_id,
      lot_location_id,
      lot_qty_on_hand,
      lot_qty_received,
      lot_qty_consumed,
      lot_status
    FROM inventory.inventory_lots lot
    WHERE lot.id = NEW.inventory_lot_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sellable inventory lot evidence is missing'
        USING ERRCODE = '23514';
    END IF;

    IF ledger_variant_delta IS DISTINCT FROM NEW.quantity
       OR ledger_location_id IS DISTINCT FROM NEW.warehouse_location_id
       OR ledger_reference_type IS DISTINCT FROM 'return_inventory_treatment'
       OR ledger_reference_id IS DISTINCT FROM NEW.disposition_item_id::text
       OR ledger_inventory_lot_id IS DISTINCT FROM NEW.inventory_lot_id
       OR ledger_source_state IS DISTINCT FROM 'customer_return'
       OR ledger_target_state IS DISTINCT FROM 'on_hand'
       OR lot_variant_id IS DISTINCT FROM source_variant_id
       OR lot_location_id IS DISTINCT FROM NEW.warehouse_location_id
       OR lot_qty_on_hand IS DISTINCT FROM NEW.quantity
       OR lot_qty_received IS DISTINCT FROM NEW.quantity
       OR lot_qty_consumed IS DISTINCT FROM 0
       OR lot_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Sellable inventory evidence does not match its disposition source'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_inventory_treatment_items_guard
  BEFORE INSERT ON returns.return_case_inventory_treatment_items
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_inventory_treatment_item();

CREATE OR REPLACE FUNCTION returns.validate_return_case_inventory_treatment_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM returns.return_case_inventory_treatment_items item
    WHERE item.inventory_treatment_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'An inventory treatment requires at least one item'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM returns.return_case_commands command
    WHERE command.return_case_id = NEW.return_case_id
      AND command.command_type = 'apply_inventory_treatment'
      AND command.idempotency_key = NEW.idempotency_key
      AND command.request_hash = NEW.request_hash
      AND command.actor = NEW.applied_by
  ) THEN
    RAISE EXCEPTION 'Inventory treatment evidence requires its idempotent command'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_inventory_treatments_evidence_guard
  AFTER INSERT ON returns.return_case_inventory_treatments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_inventory_treatment_evidence();

CREATE OR REPLACE FUNCTION returns.validate_return_case_inventory_treatment_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.command_type = 'apply_inventory_treatment'
     AND NOT EXISTS (
       SELECT 1
       FROM returns.return_case_inventory_treatments treatment
       WHERE treatment.return_case_id = NEW.return_case_id
         AND treatment.idempotency_key = NEW.idempotency_key
         AND treatment.request_hash = NEW.request_hash
         AND treatment.applied_by = NEW.actor
     ) THEN
    RAISE EXCEPTION 'Inventory treatment command requires matching immutable evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_inventory_treatment_commands_evidence_guard
  AFTER INSERT ON returns.return_case_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_inventory_treatment_command();

CREATE OR REPLACE FUNCTION returns.reject_late_return_case_inventory_treatment_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM returns.return_case_inventory_treatments treatment
    JOIN returns.return_case_commands command
      ON command.return_case_id = treatment.return_case_id
     AND command.command_type = 'apply_inventory_treatment'
     AND command.idempotency_key = treatment.idempotency_key
     AND command.request_hash = treatment.request_hash
     AND command.actor = treatment.applied_by
    WHERE treatment.id = NEW.inventory_treatment_id
  ) THEN
    RAISE EXCEPTION 'Inventory treatment items cannot be appended after command finalization'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_inventory_treatment_items_late_insert_guard
  BEFORE INSERT ON returns.return_case_inventory_treatment_items
  FOR EACH ROW EXECUTE FUNCTION returns.reject_late_return_case_inventory_treatment_item();

CREATE TRIGGER return_case_inventory_treatments_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_inventory_treatments
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

CREATE TRIGGER return_case_inventory_treatment_items_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_inventory_treatment_items
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

COMMENT ON TABLE returns.return_case_inventory_treatments IS
  'Immutable application of recorded return disposition. Sellable lines create inventory; held lines remain outside ATP.';

COMMENT ON TABLE returns.return_case_inventory_treatment_items IS
  'Exactly-once evidence for each immutable disposition item and any inventory ledger and lot records it created.';
