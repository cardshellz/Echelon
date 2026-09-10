-- Inert installation: no opening, balance rewrite, authority switch or publication.
-- Once an approved opening exists, lot/level quantity columns are synchronous,
-- rebuildable projections. Neither table is an independently writable balance.
ALTER TABLE inventory.inventory_lots ADD COLUMN qty_packed integer NOT NULL DEFAULT 0 CHECK (qty_packed >= 0);

CREATE TABLE inventory.quantity_commands (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key varchar(200) NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  kind varchar(30) NOT NULL CHECK (kind IN ('opening','receive','receipt_reversal','reserve','release','pick',
    'unpick','pack','unpack','ship','transfer','transform','return','adjust')),
  actor varchar(100) NOT NULL CHECK (length(btrim(actor)) > 0),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) > 0),
  reference_type varchar(100) NOT NULL CHECK (length(btrim(reference_type)) > 0),
  reference_id varchar(200) NOT NULL CHECK (length(btrim(reference_id)) > 0),
  reverses_command_id bigint REFERENCES inventory.quantity_commands(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  line_count integer NOT NULL CHECK (line_count BETWEEN 0 AND 50000 AND (kind = 'opening' OR line_count > 0)),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE inventory.quantity_entries (
  command_id bigint NOT NULL REFERENCES inventory.quantity_commands(id) ON DELETE RESTRICT,
  inventory_lot_id integer NOT NULL REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  inventory_level_id integer NOT NULL REFERENCES inventory.inventory_levels(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL,
  warehouse_location_id integer NOT NULL,
  warehouse_id integer NOT NULL,
  on_hand_delta integer NOT NULL, reserved_delta integer NOT NULL, picked_delta integer NOT NULL, packed_delta integer NOT NULL,
  on_hand_before integer NOT NULL CHECK (on_hand_before >= 0),
  reserved_before integer NOT NULL CHECK (reserved_before >= 0 AND reserved_before <= on_hand_before),
  picked_before integer NOT NULL CHECK (picked_before >= 0), packed_before integer NOT NULL CHECK (packed_before >= 0),
  on_hand_after integer NOT NULL CHECK (on_hand_after >= 0),
  reserved_after integer NOT NULL CHECK (reserved_after >= 0 AND reserved_after <= on_hand_after),
  picked_after integer NOT NULL CHECK (picked_after >= 0), packed_after integer NOT NULL CHECK (packed_after >= 0),
  PRIMARY KEY (command_id, inventory_lot_id),
  CHECK (on_hand_after::bigint = on_hand_before::bigint + on_hand_delta),
  CHECK (reserved_after::bigint = reserved_before::bigint + reserved_delta),
  CHECK (picked_after::bigint = picked_before::bigint + picked_delta),
  CHECK (packed_after::bigint = packed_before::bigint + packed_delta)
);
CREATE INDEX quantity_entries_lot ON inventory.quantity_entries (inventory_lot_id, command_id);
CREATE INDEX quantity_entries_level ON inventory.quantity_entries (inventory_level_id, command_id);

-- Stable business intent is locked before FIFO selection. Retain the original
-- reply rather than rebuilding it from quantities/costs changed by later work.
CREATE TABLE inventory.quantity_operation_receipts (
  idempotency_key varchar(200) PRIMARY KEY CHECK (length(btrim(idempotency_key)) > 0),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  quantity_command_id bigint UNIQUE REFERENCES inventory.quantity_commands(id) ON DELETE RESTRICT,
  outcome varchar(20) NOT NULL DEFAULT 'posted' CHECK (outcome IN ('posted', 'no_movement')),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  -- Empty catalog transfers still need an immutable business-intent reply:
  -- replay must not acquire newly arrived stock. Do not manufacture stock entries.
  CHECK ((outcome = 'posted' AND quantity_command_id IS NOT NULL)
      OR (outcome = 'no_movement' AND quantity_command_id IS NULL))
);

-- A one-way, immutable receipt, not another independently configurable flag.
-- The cutover owner inserts it in the same transaction as the ATP switch.
CREATE TABLE inventory.quantity_ledger_opening (
  singleton_key boolean PRIMARY KEY DEFAULT true CHECK (singleton_key),
  command_id bigint NOT NULL UNIQUE REFERENCES inventory.quantity_commands(id) ON DELETE RESTRICT,
  verified_opening_id bigint NOT NULL REFERENCES inventory.availability_cutover_opening_snapshots(id) ON DELETE RESTRICT,
  authority_revision bigint NOT NULL CHECK (authority_revision > 0),
  source_evidence_hash varchar(64) NOT NULL CHECK (source_evidence_hash ~ '^[a-f0-9]{64}$')
);

CREATE FUNCTION inventory.reject_quantity_evidence_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LEDGER_APPEND_ONLY';
END;
$$;
CREATE TRIGGER quantity_commands_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inventory.quantity_commands
FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_quantity_evidence_mutation();
CREATE TRIGGER quantity_entries_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inventory.quantity_entries
FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_quantity_evidence_mutation();
CREATE TRIGGER quantity_operation_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inventory.quantity_operation_receipts
FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_quantity_evidence_mutation();
CREATE TRIGGER quantity_opening_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inventory.quantity_ledger_opening
FOR EACH STATEMENT EXECUTE FUNCTION inventory.reject_quantity_evidence_mutation();

-- Mathematical projections used by the sole posting owner and by recovery.
-- Costs, qty_received and qty_consumed are not additional stock buckets.
CREATE VIEW inventory.quantity_lot_balances AS
SELECT inventory_lot_id, inventory_level_id, product_variant_id, warehouse_location_id, warehouse_id,
  sum(on_hand_delta) AS on_hand, sum(reserved_delta) AS reserved,
  sum(picked_delta) AS picked, sum(packed_delta) AS packed
FROM inventory.quantity_entries
GROUP BY inventory_lot_id, inventory_level_id, product_variant_id, warehouse_location_id, warehouse_id;

CREATE VIEW inventory.quantity_level_balances AS
SELECT inventory_level_id, product_variant_id, warehouse_location_id, warehouse_id,
  sum(on_hand_delta) AS on_hand, sum(reserved_delta) AS reserved,
  sum(picked_delta) AS picked, sum(packed_delta) AS packed
FROM inventory.quantity_entries
GROUP BY inventory_level_id, product_variant_id, warehouse_location_id, warehouse_id;

CREATE FUNCTION inventory.guard_quantity_entry_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE prior record; command_kind text; command_payload jsonb; expected jsonb;
BEGIN
  SELECT kind, request_payload INTO STRICT command_kind, command_payload FROM inventory.quantity_commands WHERE id = NEW.command_id;
  IF command_kind = 'opening' THEN
    PERFORM inventory.assert_cutover_admission_fence_owner();
    IF EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening)
       OR EXISTS (SELECT 1 FROM inventory.quantity_entries WHERE inventory_lot_id = NEW.inventory_lot_id) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_OPENING_ALREADY_ESTABLISHED';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LEDGER_NOT_ACTIVE';
  END IF;
  -- Same lock order as the posting owner: levels, then lots. These identity
  -- checks also reject a direct SQL append against the wrong SKU or warehouse.
  PERFORM 1 FROM inventory.inventory_levels level
    JOIN warehouse.warehouse_locations location ON location.id = level.warehouse_location_id
    WHERE level.id = NEW.inventory_level_id AND level.product_variant_id = NEW.product_variant_id
      AND level.warehouse_location_id = NEW.warehouse_location_id AND location.warehouse_id = NEW.warehouse_id FOR UPDATE OF level;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LEVEL_IDENTITY_CHANGED'; END IF;
  PERFORM 1 FROM inventory.inventory_lots lot WHERE lot.id = NEW.inventory_lot_id
    AND lot.product_variant_id = NEW.product_variant_id AND lot.warehouse_location_id = NEW.warehouse_location_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LOT_IDENTITY_CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM inventory.quantity_entries WHERE inventory_lot_id = NEW.inventory_lot_id
    AND (inventory_level_id <> NEW.inventory_level_id OR product_variant_id <> NEW.product_variant_id
      OR warehouse_location_id <> NEW.warehouse_location_id OR warehouse_id <> NEW.warehouse_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LOT_IDENTITY_CHANGED';
  END IF;
  SELECT coalesce(sum(on_hand_delta),0) AS on_hand, coalesce(sum(reserved_delta),0) AS reserved,
    coalesce(sum(picked_delta),0) AS picked, coalesce(sum(packed_delta),0) AS packed
    INTO prior FROM inventory.quantity_entries WHERE inventory_lot_id = NEW.inventory_lot_id;
  IF (NEW.on_hand_before, NEW.reserved_before, NEW.picked_before, NEW.packed_before)
     IS DISTINCT FROM (prior.on_hand, prior.reserved, prior.picked, prior.packed) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LEDGER_PRECONDITION_CHANGED';
  END IF;
  expected := jsonb_build_object('inventoryLotId', NEW.inventory_lot_id, 'inventoryLevelId', NEW.inventory_level_id,
    'productVariantId', NEW.product_variant_id, 'warehouseLocationId', NEW.warehouse_location_id, 'warehouseId', NEW.warehouse_id,
    'delta', jsonb_build_object('onHand', NEW.on_hand_delta, 'reserved', NEW.reserved_delta, 'picked', NEW.picked_delta, 'packed', NEW.packed_delta));
  IF NOT (command_payload->'movements' @> jsonb_build_array(expected)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_ENTRY_COMMAND_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quantity_entry_insert_guard BEFORE INSERT ON inventory.quantity_entries
FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_entry_insert();

CREATE FUNCTION inventory.assert_quantity_projection(lot_id integer, level_id integer) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE actual record; expected record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening) THEN RETURN; END IF;
  IF lot_id IS NOT NULL THEN
    SELECT lot.qty_on_hand AS on_hand, lot.qty_reserved AS reserved, lot.qty_picked AS picked, lot.qty_packed AS packed,
      lot.product_variant_id, lot.warehouse_location_id INTO actual FROM inventory.inventory_lots lot WHERE id = lot_id;
    IF FOUND THEN
      SELECT coalesce(sum(on_hand_delta),0) AS on_hand, coalesce(sum(reserved_delta),0) AS reserved,
        coalesce(sum(picked_delta),0) AS picked, coalesce(sum(packed_delta),0) AS packed
        INTO expected FROM inventory.quantity_entries WHERE inventory_lot_id = lot_id;
      IF (actual.on_hand, actual.reserved, actual.picked, actual.packed)
         IS DISTINCT FROM (expected.on_hand, expected.reserved, expected.picked, expected.packed)
        OR EXISTS (SELECT 1 FROM inventory.quantity_entries WHERE inventory_lot_id = lot_id
          AND (product_variant_id <> actual.product_variant_id OR warehouse_location_id <> actual.warehouse_location_id)) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LOT_PROJECTION_ONLY';
      END IF;
    END IF;
  END IF;
  IF level_id IS NOT NULL THEN
    SELECT variant_qty AS on_hand, reserved_qty AS reserved, picked_qty AS picked, packed_qty AS packed,
      product_variant_id, warehouse_location_id INTO actual FROM inventory.inventory_levels WHERE id = level_id;
    IF FOUND THEN
      SELECT coalesce(sum(on_hand_delta),0) AS on_hand, coalesce(sum(reserved_delta),0) AS reserved,
        coalesce(sum(picked_delta),0) AS picked, coalesce(sum(packed_delta),0) AS packed
        INTO expected FROM inventory.quantity_entries WHERE inventory_level_id = level_id;
      IF (actual.on_hand, actual.reserved, actual.picked, actual.packed)
         IS DISTINCT FROM (expected.on_hand, expected.reserved, expected.picked, expected.packed)
        OR EXISTS (SELECT 1 FROM inventory.quantity_entries WHERE inventory_level_id = level_id
          AND (product_variant_id <> actual.product_variant_id OR warehouse_location_id <> actual.warehouse_location_id)) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LEVEL_PROJECTION_ONLY';
      END IF;
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION inventory.guard_quantity_projection_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME = 'inventory_lots' THEN
    PERFORM inventory.assert_quantity_projection(NEW.id, NULL);
  ELSIF TG_TABLE_NAME = 'inventory_levels' THEN
    PERFORM inventory.assert_quantity_projection(NULL, NEW.id);
  ELSE
    PERFORM inventory.assert_quantity_projection(NEW.inventory_lot_id, NEW.inventory_level_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER quantity_lot_projection_guard AFTER INSERT OR UPDATE ON inventory.inventory_lots
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_projection_commit();
CREATE CONSTRAINT TRIGGER quantity_level_projection_guard AFTER INSERT OR UPDATE ON inventory.inventory_levels
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_projection_commit();
CREATE CONSTRAINT TRIGGER quantity_entry_projection_guard AFTER INSERT ON inventory.quantity_entries
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_projection_commit();

CREATE FUNCTION inventory.guard_quantity_command_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (SELECT count(*) FROM inventory.quantity_entries WHERE command_id = NEW.id) <> NEW.line_count
    OR jsonb_array_length(NEW.request_payload->'movements') IS DISTINCT FROM NEW.line_count
    OR NEW.request_payload->>'idempotencyKey' IS DISTINCT FROM NEW.idempotency_key
    OR NEW.request_payload->>'kind' IS DISTINCT FROM NEW.kind
    OR NEW.request_payload->>'contractVersion' IS DISTINCT FROM 'inventory_quantity_v1'
    OR (NEW.request_payload->>'occurredAt')::timestamptz IS DISTINCT FROM NEW.occurred_at
    OR (NEW.request_payload->>'reversesCommandId')::bigint IS DISTINCT FROM NEW.reverses_command_id
    OR NEW.request_payload->>'actor' IS DISTINCT FROM NEW.actor
    OR NEW.request_payload->>'reason' IS DISTINCT FROM NEW.reason
    OR NEW.request_payload->'reference'->>'type' IS DISTINCT FROM NEW.reference_type
    OR NEW.request_payload->'reference'->>'id' IS DISTINCT FROM NEW.reference_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_COMMAND_INCOMPLETE';
  END IF;
  IF NEW.kind = 'opening' AND NOT EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening WHERE command_id = NEW.id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_OPENING_RECEIPT_REQUIRED';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER quantity_command_complete_guard AFTER INSERT ON inventory.quantity_commands
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_command_commit();

CREATE FUNCTION inventory.guard_quantity_opening_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE command_kind text; verified record;
BEGIN
  PERFORM inventory.assert_cutover_admission_fence_owner();
  SELECT kind INTO STRICT command_kind FROM inventory.quantity_commands WHERE id = NEW.command_id;
  SELECT authority_revision, source_evidence_hash, verification_payload, assessment_payload INTO STRICT verified
    FROM inventory.availability_cutover_opening_snapshots WHERE id = NEW.verified_opening_id;
  IF command_kind <> 'opening' OR verified.authority_revision + 1 <> NEW.authority_revision
    OR verified.source_evidence_hash <> NEW.source_evidence_hash
    OR verified.assessment_payload->'ready' IS DISTINCT FROM 'true'::jsonb
    OR NOT EXISTS (SELECT 1 FROM inventory.availability_runtime_authority
      WHERE singleton_key = true AND authority = 'canonical' AND revision = NEW.authority_revision)
    OR jsonb_array_length(verified.verification_payload->'lots') IS DISTINCT FROM (SELECT count(*) FROM inventory.inventory_lots)
    OR EXISTS (SELECT 1 FROM inventory.inventory_lots lot WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(verified.verification_payload->'lots') observed WHERE (observed->>'id')::integer = lot.id))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(verified.verification_payload->'lots') observed
      LEFT JOIN inventory.quantity_entries entry ON entry.inventory_lot_id = (observed->>'id')::integer AND entry.command_id = NEW.command_id
      WHERE coalesce(entry.on_hand_delta,0) <> (observed->>'onHandQty')::bigint
         OR coalesce(entry.reserved_delta,0) <> (observed->>'reservedQty')::bigint
         OR coalesce(entry.picked_delta,0) <> (observed->>'pickedQty')::bigint
         OR coalesce(entry.packed_delta,0) <> 0)
    OR EXISTS (SELECT 1 FROM inventory.quantity_entries entry
      LEFT JOIN inventory.inventory_lots lot ON lot.id = entry.inventory_lot_id
      WHERE entry.command_id = NEW.command_id AND lot.id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_OPENING_CUTOVER_INCOMPLETE';
  END IF;
  -- Include empty/orphan level rows: they must be zero, never a second opening.
  PERFORM inventory.assert_quantity_projection(id, NULL) FROM inventory.inventory_lots;
  PERFORM inventory.assert_quantity_projection(NULL, id) FROM inventory.inventory_levels;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER quantity_opening_complete_guard AFTER INSERT ON inventory.quantity_ledger_opening
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_opening_commit();

CREATE FUNCTION inventory.guard_quantity_projection_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_PROJECTION_TRUNCATE_FORBIDDEN';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER quantity_lots_truncate_guard BEFORE TRUNCATE ON inventory.inventory_lots
FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_quantity_projection_truncate();
CREATE TRIGGER quantity_levels_truncate_guard BEFORE TRUNCATE ON inventory.inventory_levels
FOR EACH STATEMENT EXECUTE FUNCTION inventory.guard_quantity_projection_truncate();

CREATE FUNCTION inventory.guard_quantity_location_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  -- Location identity cannot be changed into an implicit warehouse transfer.
  -- This applies to empty bins too once the ledger is active, closing the race
  -- between a first receipt and a concurrent metadata reassignment. Create a
  -- new location identity and post a transfer instead. Admission (migration236)
  -- rejects an RR writer whose snapshot predates the opening transaction.
  IF (NEW.id IS DISTINCT FROM OLD.id OR NEW.warehouse_id IS DISTINCT FROM OLD.warehouse_id)
    AND EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_LOCATION_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quantity_location_identity_guard BEFORE UPDATE ON warehouse.warehouse_locations
FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_location_identity();

CREATE FUNCTION inventory.guard_quantity_projection_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_PROJECTION_IDENTITY_DELETE_FORBIDDEN';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER quantity_lots_delete_guard BEFORE DELETE ON inventory.inventory_lots
FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_projection_delete();
CREATE TRIGGER quantity_levels_delete_guard BEFORE DELETE ON inventory.inventory_levels
FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_projection_delete();

-- Zero rows still carry the verified census, receiving and cost provenance.
-- Rekeying them would silently relabel that history even without a stock entry.
-- Physical owners create destination identities instead of moving old IDs.
CREATE FUNCTION inventory.guard_quantity_projection_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening WHERE singleton_key = true)
    AND (NEW.id, NEW.product_variant_id, NEW.warehouse_location_id)
      IS DISTINCT FROM (OLD.id, OLD.product_variant_id, OLD.warehouse_location_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_PROJECTION_IDENTITY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER quantity_lots_identity_immutable BEFORE UPDATE ON inventory.inventory_lots
FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_projection_identity();
CREATE TRIGGER quantity_levels_identity_immutable BEFORE UPDATE ON inventory.inventory_levels
FOR EACH ROW EXECUTE FUNCTION inventory.guard_quantity_projection_identity();

CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT ON inventory.quantity_commands
FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT ON inventory.quantity_entries
FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT ON inventory.quantity_operation_receipts
FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();

CREATE FUNCTION inventory.guard_quantity_authority_cutover() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inventory.quantity_ledger_opening WHERE authority_revision = NEW.revision) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'QUANTITY_OPENING_REQUIRED_FOR_CUTOVER';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER quantity_authority_cutover_guard AFTER UPDATE ON inventory.availability_runtime_authority
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.authority = 'legacy' AND NEW.authority = 'canonical')
EXECUTE FUNCTION inventory.guard_quantity_authority_cutover();
