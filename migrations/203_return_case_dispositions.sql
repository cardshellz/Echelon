ALTER TABLE returns.return_case_commands
  DROP CONSTRAINT IF EXISTS return_case_commands_type_chk;

ALTER TABLE returns.return_case_commands
  ADD CONSTRAINT return_case_commands_type_chk CHECK (
    command_type IN (
      'record_receipt',
      'start_inspection',
      'complete_inspection',
      'record_disposition'
    )
  );

CREATE TABLE returns.return_case_dispositions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_case_id bigint NOT NULL
    REFERENCES returns.return_cases(id),
  inspection_id bigint
    REFERENCES returns.return_case_inspections(id),
  inspection_resolution varchar(24) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash varchar(64) NOT NULL,
  recorded_by varchar(255) NOT NULL,
  notes text,
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_dispositions_idempotency_uq
    UNIQUE (idempotency_key),
  CONSTRAINT return_case_dispositions_inspection_resolution_chk CHECK (
    inspection_resolution IN ('approved', 'rejected', 'not_required')
  ),
  CONSTRAINT return_case_dispositions_inspection_evidence_chk CHECK (
    (inspection_resolution IN ('approved', 'rejected') AND inspection_id IS NOT NULL)
    OR (inspection_resolution = 'not_required' AND inspection_id IS NULL)
  ),
  CONSTRAINT return_case_dispositions_idempotency_key_chk CHECK (
    btrim(idempotency_key) <> ''
  ),
  CONSTRAINT return_case_dispositions_request_hash_chk CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT return_case_dispositions_actor_chk CHECK (
    btrim(recorded_by) <> ''
  )
);

CREATE INDEX return_case_dispositions_case_idx
  ON returns.return_case_dispositions (return_case_id, recorded_at, id);

CREATE INDEX return_case_dispositions_inspection_idx
  ON returns.return_case_dispositions (inspection_id);

CREATE TABLE returns.return_case_disposition_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  disposition_id bigint NOT NULL
    REFERENCES returns.return_case_dispositions(id),
  return_case_item_id bigint NOT NULL
    REFERENCES returns.return_case_items(id),
  treatment varchar(32) NOT NULL,
  quantity integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT return_case_disposition_items_item_uq
    UNIQUE (disposition_id, return_case_item_id),
  CONSTRAINT return_case_disposition_items_treatment_chk CHECK (
    treatment IN ('restock_sellable', 'hold_non_sellable')
  ),
  CONSTRAINT return_case_disposition_items_quantity_chk CHECK (
    quantity > 0
  )
);

CREATE INDEX return_case_disposition_items_case_item_idx
  ON returns.return_case_disposition_items (return_case_item_id, id);

CREATE OR REPLACE FUNCTION returns.validate_return_case_disposition_header()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  persisted_inspection_status varchar(24);
  persisted_inspection_completed_at timestamptz;
  persisted_receipt_received_at timestamp without time zone;
BEGIN
  SELECT wms_return.received_at
  INTO persisted_receipt_received_at
  FROM returns.return_cases return_case
  JOIN wms.returns wms_return
    ON wms_return.id = return_case.wms_return_id
  WHERE return_case.id = NEW.return_case_id
  FOR KEY SHARE OF return_case, wms_return;

  IF NOT FOUND OR persisted_receipt_received_at IS NULL THEN
    RAISE EXCEPTION 'Disposition requires persisted return receipt evidence'
      USING ERRCODE = '23514';
  END IF;

  -- Legacy WMS receipt timestamps are stored as UTC wall-clock values without
  -- timezone metadata. Interpret them explicitly instead of using session TZ.
  IF NEW.recorded_at
       < (persisted_receipt_received_at AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'Disposition evidence cannot predate its return receipt evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.inspection_resolution = 'not_required' THEN
    SELECT return_case.inspection_status
    INTO persisted_inspection_status
    FROM returns.return_cases return_case
    WHERE return_case.id = NEW.return_case_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Return Case % does not exist', NEW.return_case_id
        USING ERRCODE = '23503';
    END IF;

    IF persisted_inspection_status <> 'not_required' THEN
      RAISE EXCEPTION
        'Disposition without inspection evidence requires a persisted not_required inspection state'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT inspection.status, inspection.completed_at
    INTO persisted_inspection_status, persisted_inspection_completed_at
    FROM returns.return_case_inspections inspection
    WHERE inspection.id = NEW.inspection_id
      AND inspection.return_case_id = NEW.return_case_id
      AND inspection.completed_at IS NOT NULL
      AND inspection.completed_by IS NOT NULL
      AND btrim(inspection.completed_by) <> ''
    FOR KEY SHARE;

    IF NOT FOUND OR persisted_inspection_status <> NEW.inspection_resolution THEN
      RAISE EXCEPTION
        'Disposition requires matching terminal inspection evidence for the same Return Case'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.recorded_at < persisted_inspection_completed_at THEN
      RAISE EXCEPTION
        'Disposition evidence cannot predate its terminal inspection evidence'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_dispositions_inspection_guard
  BEFORE INSERT ON returns.return_case_dispositions
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_disposition_header();

CREATE OR REPLACE FUNCTION returns.validate_return_case_disposition_item()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  received_quantity integer;
  already_recorded_quantity bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM returns.return_case_dispositions disposition
    JOIN returns.return_case_commands command
      ON command.return_case_id = disposition.return_case_id
     AND command.command_type = 'record_disposition'
     AND command.idempotency_key = disposition.idempotency_key
     AND command.request_hash = disposition.request_hash
     AND command.actor = disposition.recorded_by
    WHERE disposition.id = NEW.disposition_id
  ) THEN
    RAISE EXCEPTION
      'Disposition items cannot be appended after immutable command evidence is finalized'
      USING ERRCODE = '23514';
  END IF;

  SELECT wms_item.received_qty
  INTO received_quantity
  FROM returns.return_case_dispositions disposition
  JOIN returns.return_case_items case_item
    ON case_item.id = NEW.return_case_item_id
   AND case_item.return_case_id = disposition.return_case_id
  JOIN wms.return_items wms_item
    ON wms_item.id = case_item.wms_return_item_id
  WHERE disposition.id = NEW.disposition_id
  FOR UPDATE OF wms_item;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Disposition item must belong to the same Return Case as its disposition header'
      USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(sum(item.quantity), 0)
  INTO already_recorded_quantity
  FROM returns.return_case_disposition_items item
  WHERE item.return_case_item_id = NEW.return_case_item_id;

  IF already_recorded_quantity + NEW.quantity > received_quantity THEN
    RAISE EXCEPTION
      'Cumulative disposition quantity exceeds the received quantity for Return Case item %',
      NEW.return_case_item_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER return_case_disposition_items_quantity_guard
  BEFORE INSERT ON returns.return_case_disposition_items
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_disposition_item();

CREATE OR REPLACE FUNCTION returns.validate_return_case_disposition_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM returns.return_case_disposition_items item
    WHERE item.disposition_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'A disposition record requires at least one item quantity'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM returns.return_case_commands command
    WHERE command.return_case_id = NEW.return_case_id
      AND command.command_type = 'record_disposition'
      AND command.idempotency_key = NEW.idempotency_key
      AND command.request_hash = NEW.request_hash
      AND command.actor = NEW.recorded_by
  ) THEN
    RAISE EXCEPTION 'Disposition evidence requires a matching idempotent command record'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_dispositions_evidence_guard
  AFTER INSERT ON returns.return_case_dispositions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_disposition_evidence();

CREATE OR REPLACE FUNCTION returns.validate_return_case_disposition_command()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.command_type = 'record_disposition'
     AND NOT EXISTS (
       SELECT 1
       FROM returns.return_case_dispositions disposition
       WHERE disposition.return_case_id = NEW.return_case_id
         AND disposition.idempotency_key = NEW.idempotency_key
         AND disposition.request_hash = NEW.request_hash
         AND disposition.recorded_by = NEW.actor
     ) THEN
    RAISE EXCEPTION 'Disposition command requires matching immutable disposition evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER return_case_disposition_commands_evidence_guard
  AFTER INSERT ON returns.return_case_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION returns.validate_return_case_disposition_command();

CREATE TRIGGER return_case_dispositions_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_dispositions
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

CREATE TRIGGER return_case_disposition_items_immutable
  BEFORE UPDATE OR DELETE ON returns.return_case_disposition_items
  FOR EACH ROW EXECUTE FUNCTION returns.reject_return_case_evidence_mutation();

COMMENT ON TABLE returns.return_case_dispositions IS
  'Immutable physical-treatment intent. Recording does not apply inventory, refund, settlement, or closure side effects.';

COMMENT ON TABLE returns.return_case_disposition_items IS
  'Immutable per-item disposition quantities. Corrections require a future compensating command, never UPDATE or DELETE.';
