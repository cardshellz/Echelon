-- Explicit canonical-build handoffs only. No backfill, activation or stock writes.
CREATE TABLE warehouse.work_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  claim_id bigint NOT NULL,
  claim_operation_id bigint NOT NULL UNIQUE,
  station_id uuid NOT NULL,
  configuration_revision integer NOT NULL,
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object'),
  state varchar(30) NOT NULL CHECK (state IN ('queued','in_progress','blocked','completed','cancelled')),
  version integer NOT NULL CHECK (version > 0 AND version <= 2147483646),
  assigned_to varchar REFERENCES identity.users(id) ON DELETE RESTRICT,
  started_at timestamptz,
  completed_at timestamptz,
  blocked_reason varchar(1000),
  received_by varchar REFERENCES identity.users(id) ON DELETE RESTRICT,
  received_at timestamptz,
  FOREIGN KEY (claim_operation_id, claim_id) REFERENCES inventory.availability_claim_operations(id, claim_id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_id, station_id) REFERENCES warehouse.work_stations(warehouse_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (warehouse_id, configuration_revision) REFERENCES warehouse.work_configuration_revisions(warehouse_id, revision) ON DELETE RESTRICT,
  CHECK ((assigned_to IS NULL) = (started_at IS NULL)),
  CHECK ((received_by IS NULL) = (received_at IS NULL)),
  CHECK (received_by IS NOT DISTINCT FROM assigned_to),
  CHECK ((state IN ('queued','cancelled') AND assigned_to IS NULL AND received_at IS NULL)
      OR (state IN ('in_progress','blocked','completed') AND assigned_to IS NOT NULL AND received_at IS NOT NULL)),
  CHECK ((state = 'blocked') = (blocked_reason IS NOT NULL)),
  CHECK (blocked_reason IS NULL OR length(btrim(blocked_reason)) > 0),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX work_items_queue_idx ON warehouse.work_items(warehouse_id, station_id, id DESC)
  WHERE state NOT IN ('completed','cancelled');
CREATE INDEX work_items_warehouse_history_idx ON warehouse.work_items(warehouse_id, id DESC);
CREATE INDEX work_items_claim_idx ON warehouse.work_items(claim_id, id);
CREATE INDEX work_items_employee_idx ON warehouse.work_items(assigned_to, id DESC)
  WHERE state IN ('in_progress','blocked');

CREATE TABLE warehouse.work_item_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_item_id bigint NOT NULL REFERENCES warehouse.work_items(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  event_type varchar(30) NOT NULL CHECK (event_type IN ('queued','start','block','resume','completed','cancelled')),
  command_key varchar(512) NOT NULL UNIQUE,
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- Claim lifecycle events may be authored by authenticated system principals.
  actor_id varchar(255) NOT NULL CHECK (length(btrim(actor_id)) > 0),
  reason varchar(1000) NOT NULL CHECK (length(btrim(reason)) > 0),
  before_state jsonb,
  after_state jsonb NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  occurred_at timestamptz NOT NULL,
  UNIQUE (work_item_id, version)
);
CREATE TRIGGER work_item_events_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON warehouse.work_item_events
  FOR EACH STATEMENT EXECUTE FUNCTION warehouse.reject_work_revision_mutation();

CREATE FUNCTION warehouse.guard_work_item_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Warehouse work cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.warehouse_id <> OLD.warehouse_id OR NEW.claim_id <> OLD.claim_id
     OR NEW.claim_operation_id <> OLD.claim_operation_id OR NEW.station_id <> OLD.station_id
     OR NEW.configuration_revision <> OLD.configuration_revision OR NEW.context <> OLD.context THEN
    RAISE EXCEPTION 'Warehouse work routing and owner evidence are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'Warehouse work requires the next version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_items_identity_guard BEFORE UPDATE OR DELETE ON warehouse.work_items
  FOR EACH ROW EXECUTE FUNCTION warehouse.guard_work_item_identity();
CREATE TRIGGER work_items_truncate_guard BEFORE TRUNCATE ON warehouse.work_items
  FOR EACH STATEMENT EXECUTE FUNCTION warehouse.reject_work_revision_mutation();

-- A physical work-area identity cannot move after it has operational history.
-- New bindings/profile revisions may route NEW jobs; existing snapshots remain.
CREATE FUNCTION warehouse.guard_used_work_station_location() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.location_id <> OLD.location_id AND EXISTS (
    SELECT 1 FROM warehouse.work_items WHERE station_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'A station with work history cannot change its physical identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER work_station_used_location_guard BEFORE UPDATE OF location_id ON warehouse.work_stations
  FOR EACH ROW EXECUTE FUNCTION warehouse.guard_used_work_station_location();
