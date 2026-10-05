-- New commands only: no historical picks, quantities, costs or recoveries are replayed.
CREATE TABLE IF NOT EXISTS wms.picking_commands (
  command_key text PRIMARY KEY,
  order_id integer NOT NULL REFERENCES wms.orders(id),
  order_item_id integer NOT NULL REFERENCES wms.order_items(id),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload)='object'),
  before_item jsonb NOT NULL CHECK (jsonb_typeof(before_item)='object'),
  canonical_request jsonb,
  physical_receipt jsonb,
  followup_result jsonb,
  last_error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL,
  committed_at timestamptz,
  completed_at timestamptz,
  CHECK ((physical_receipt IS NULL) = (committed_at IS NULL)),
  CHECK (completed_at IS NULL OR physical_receipt IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS picking_commands_pending_idx ON wms.picking_commands (committed_at, command_key)
  WHERE physical_receipt IS NOT NULL AND completed_at IS NULL;
CREATE OR REPLACE FUNCTION wms.guard_picking_command_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.command_key,NEW.order_id,NEW.order_item_id,NEW.request_hash,NEW.request_payload,NEW.before_item,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.command_key,OLD.order_id,OLD.order_item_id,OLD.request_hash,OLD.request_payload,OLD.before_item,OLD.created_at) THEN
    RAISE EXCEPTION 'Picking command intent is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.physical_receipt IS NOT NULL AND ROW(NEW.physical_receipt,NEW.canonical_request,NEW.committed_at)
    IS DISTINCT FROM ROW(OLD.physical_receipt,OLD.canonical_request,OLD.committed_at) THEN
    RAISE EXCEPTION 'Committed picking evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.completed_at IS NOT NULL AND ROW(NEW.followup_result,NEW.completed_at)
    IS DISTINCT FROM ROW(OLD.followup_result,OLD.completed_at) THEN
    RAISE EXCEPTION 'Completed picking result is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN RAISE EXCEPTION 'Picking attempts cannot decrease' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS picking_command_evidence_guard ON wms.picking_commands;
CREATE TRIGGER picking_command_evidence_guard BEFORE UPDATE ON wms.picking_commands
  FOR EACH ROW EXECUTE FUNCTION wms.guard_picking_command_evidence();
CREATE UNIQUE INDEX IF NOT EXISTS allocation_exceptions_picking_command_key_uq
  ON wms.allocation_exceptions ((metadata->>'pickingCommandKey')) WHERE metadata->>'pickingCommandKey' IS NOT NULL;
ALTER TABLE wms.picking_logs ADD COLUMN IF NOT EXISTS operation_key text;
CREATE UNIQUE INDEX IF NOT EXISTS picking_logs_operation_key_uq ON wms.picking_logs(operation_key) WHERE operation_key IS NOT NULL;
ALTER TABLE inventory.replen_tasks ADD COLUMN IF NOT EXISTS operation_key text;
ALTER TABLE inventory.replen_tasks ADD COLUMN IF NOT EXISTS operation_request_hash varchar(64);
ALTER TABLE inventory.replen_tasks ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE OR REPLACE FUNCTION inventory.advance_replen_task_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS replen_task_revision ON inventory.replen_tasks;
CREATE TRIGGER replen_task_revision BEFORE UPDATE ON inventory.replen_tasks
  FOR EACH ROW EXECUTE FUNCTION inventory.advance_replen_task_revision();
ALTER TABLE inventory.inventory_transactions ADD COLUMN IF NOT EXISTS units_per_variant_snapshot integer CHECK (units_per_variant_snapshot > 0);
ALTER TABLE inventory.replen_tasks ADD COLUMN IF NOT EXISTS execution_moved_base_units integer CHECK (execution_moved_base_units >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS replen_tasks_operation_key_uq ON inventory.replen_tasks(operation_key) WHERE operation_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS inventory.replen_trigger_receipts (
  operation_key text PRIMARY KEY CHECK (length(operation_key) BETWEEN 1 AND 500),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  task_id integer REFERENCES inventory.replen_tasks(id),
  created_at timestamptz NOT NULL
);
CREATE OR REPLACE FUNCTION inventory.guard_replen_trigger_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Replenishment trigger decisions are immutable' USING ERRCODE='23514';
END;
$$;
DROP TRIGGER IF EXISTS replen_trigger_receipt_guard ON inventory.replen_trigger_receipts;
CREATE TRIGGER replen_trigger_receipt_guard BEFORE UPDATE OR DELETE ON inventory.replen_trigger_receipts
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_replen_trigger_receipt();
CREATE TABLE IF NOT EXISTS inventory.replen_followups (
  task_id integer PRIMARY KEY REFERENCES inventory.replen_tasks(id),
  actor text NOT NULL CHECK (btrim(actor) <> ''),
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory.replen_transfer_credits (
  transfer_id integer NOT NULL REFERENCES inventory.inventory_transactions(id),
  task_id integer NOT NULL REFERENCES inventory.replen_tasks(id),
  base_quantity integer NOT NULL CHECK (base_quantity > 0),
  variant_quantity integer NOT NULL CHECK (variant_quantity > 0),
  actor text NOT NULL CHECK (btrim(actor) <> ''),
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY(transfer_id, task_id)
);
CREATE TABLE IF NOT EXISTS inventory.transfer_followups (
  transfer_id integer PRIMARY KEY REFERENCES inventory.inventory_transactions(id),
  actor text NOT NULL CHECK (btrim(actor) <> ''),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_error text
);
