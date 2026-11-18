-- Durable inter-warehouse custody: source -> isolated transit node -> destination.
-- Baseline restores intentionally omit singleton data. Restore the cutover
-- admission row under the narrowly scoped migration bypass before touching a
-- table protected by the admission trigger. Existing databases are unchanged.
ALTER TABLE inventory.cutover_admission_fence
  DISABLE TRIGGER cutover_admission_owner_write_guard;
INSERT INTO inventory.cutover_admission_fence(singleton_key, epoch)
VALUES (true, 1)
ON CONFLICT (singleton_key) DO NOTHING;
ALTER TABLE inventory.cutover_admission_fence
  ENABLE TRIGGER cutover_admission_owner_write_guard;

INSERT INTO warehouse.warehouses (
  code, name, warehouse_type, is_active, is_default, inventory_source_type, feed_enabled
) VALUES (
  'SYSTEM-TRANSIT', 'Inventory in transit', 'system_transit', 1, 0, 'internal', false
) ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS inventory.interwarehouse_transfers (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  create_command_key text NOT NULL UNIQUE CHECK (length(create_command_key) BETWEEN 8 AND 120),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  source_warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  destination_warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  source_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  destination_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  transit_location_id integer UNIQUE REFERENCES warehouse.warehouse_locations(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN (
    'ready','in_transit','partially_received','exception','completed','closed_with_variance','cancelled'
  )),
  notes text,
  exception_notes text,
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  dispatched_by text,
  completed_by text,
  cancelled_by text,
  created_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK (source_warehouse_id <> destination_warehouse_id),
  CHECK (source_location_id <> destination_location_id)
);

CREATE TABLE IF NOT EXISTS inventory.interwarehouse_transfer_lines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id integer NOT NULL REFERENCES inventory.interwarehouse_transfers(id) ON DELETE RESTRICT,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  requested_qty integer NOT NULL CHECK (requested_qty > 0),
  dispatched_qty integer NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
  received_qty integer NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  damaged_qty integer NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  lost_qty integer NOT NULL DEFAULT 0 CHECK (lost_qty >= 0),
  cancelled_qty integer NOT NULL DEFAULT 0 CHECK (cancelled_qty >= 0),
  -- The v1 command and UI intentionally own one SKU per transfer. Keeping this
  -- invariant explicit prevents list/receipt ambiguity until a future version
  -- introduces line-addressed commands end to end.
  UNIQUE (transfer_id),
  CHECK (dispatched_qty + cancelled_qty <= requested_qty),
  CHECK (received_qty + damaged_qty + lost_qty <= dispatched_qty)
);

CREATE TABLE IF NOT EXISTS inventory.interwarehouse_transfer_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id integer NOT NULL REFERENCES inventory.interwarehouse_transfers(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('dispatched','received','reconciled','cancelled')),
  command_key text NOT NULL UNIQUE CHECK (length(command_key) BETWEEN 8 AND 120),
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  damaged_quantity integer NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  inventory_transaction_id integer REFERENCES inventory.inventory_transactions(id) ON DELETE RESTRICT,
  adjustment_transaction_id integer REFERENCES inventory.inventory_transactions(id) ON DELETE RESTRICT,
  actor text NOT NULL CHECK (btrim(actor) <> ''),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  occurred_at timestamptz NOT NULL,
  effects_claim_token uuid,
  effects_claimed_at timestamptz,
  effects_completed_at timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS interwarehouse_transfers_status_updated_idx
  ON inventory.interwarehouse_transfers(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS interwarehouse_transfer_events_pending_idx
  ON inventory.interwarehouse_transfer_events(effects_claimed_at, occurred_at, id)
  WHERE effects_completed_at IS NULL;

CREATE OR REPLACE FUNCTION inventory.guard_interwarehouse_transfer_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.transfer_id,NEW.event_type,NEW.command_key,NEW.request_hash,NEW.quantity,
         NEW.damaged_quantity,NEW.inventory_transaction_id,NEW.adjustment_transaction_id,NEW.actor,NEW.detail,NEW.occurred_at)
     IS DISTINCT FROM
     ROW(OLD.transfer_id,OLD.event_type,OLD.command_key,OLD.request_hash,OLD.quantity,
         OLD.damaged_quantity,OLD.inventory_transaction_id,OLD.adjustment_transaction_id,OLD.actor,OLD.detail,OLD.occurred_at) THEN
    RAISE EXCEPTION 'Inter-warehouse transfer event evidence is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.effects_completed_at IS NOT NULL AND NEW.effects_completed_at IS DISTINCT FROM OLD.effects_completed_at THEN
    RAISE EXCEPTION 'Completed inter-warehouse transfer effects are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS interwarehouse_transfer_event_guard ON inventory.interwarehouse_transfer_events;
CREATE TRIGGER interwarehouse_transfer_event_guard BEFORE UPDATE ON inventory.interwarehouse_transfer_events
  FOR EACH ROW EXECUTE FUNCTION inventory.guard_interwarehouse_transfer_event();
