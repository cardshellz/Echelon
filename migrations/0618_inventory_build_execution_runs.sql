-- Inventory build execution runs, exact reservations, and compensating reversal evidence.
--
-- A released build order owns exact FIFO lot reservations. Each posting is an
-- independently idempotent run so an order can be completed in operationally
-- useful batches. Posted evidence is immutable; corrections use one full,
-- compensating reversal against an untouched run.

CREATE TABLE IF NOT EXISTS inventory.build_runs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  build_order_id integer NOT NULL
    REFERENCES inventory.build_orders(id) ON DELETE RESTRICT,
  run_number integer NOT NULL,
  idempotency_key varchar(100) NOT NULL UNIQUE,
  builds_completed integer NOT NULL,
  output_qty integer NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'posting',
  total_component_cost_mills bigint NOT NULL DEFAULT 0,
  posted_by varchar(100),
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_runs_order_number_uidx UNIQUE (build_order_id, run_number),
  CONSTRAINT build_runs_number_chk CHECK (run_number > 0),
  CONSTRAINT build_runs_builds_completed_chk CHECK (builds_completed > 0),
  CONSTRAINT build_runs_output_qty_chk CHECK (output_qty > 0),
  CONSTRAINT build_runs_status_chk CHECK (status IN ('posting', 'posted', 'reversed')),
  CONSTRAINT build_runs_cost_chk CHECK (total_component_cost_mills >= 0)
);

CREATE INDEX IF NOT EXISTS build_runs_order_created_idx
  ON inventory.build_runs(build_order_id, created_at);

CREATE TABLE IF NOT EXISTS inventory.build_run_reversals (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  build_run_id integer NOT NULL UNIQUE
    REFERENCES inventory.build_runs(id) ON DELETE RESTRICT,
  idempotency_key varchar(100) NOT NULL UNIQUE,
  reason text NOT NULL,
  resulting_completed_builds integer NOT NULL,
  resulting_order_status varchar(20) NOT NULL,
  created_by varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_run_reversals_reason_chk
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT build_run_reversals_progress_chk
    CHECK (resulting_completed_builds >= 0),
  CONSTRAINT build_run_reversals_order_status_chk
    CHECK (resulting_order_status IN ('released', 'in_progress'))
);

ALTER TABLE inventory.build_orders
  ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by varchar(100),
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_reservation_qty integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_orders_failure_count_chk'
      AND conrelid = 'inventory.build_orders'::regclass
  ) THEN
    ALTER TABLE inventory.build_orders
      ADD CONSTRAINT build_orders_failure_count_chk CHECK (failure_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_orders_cancellation_reason_chk'
      AND conrelid = 'inventory.build_orders'::regclass
  ) THEN
    ALTER TABLE inventory.build_orders
      ADD CONSTRAINT build_orders_cancellation_reason_chk
      CHECK (cancellation_reason IS NULL OR char_length(btrim(cancellation_reason)) BETWEEN 1 AND 2000);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'build_orders_cancelled_reservation_qty_chk'
      AND conrelid = 'inventory.build_orders'::regclass
  ) THEN
    ALTER TABLE inventory.build_orders
      ADD CONSTRAINT build_orders_cancelled_reservation_qty_chk
      CHECK (cancelled_reservation_qty IS NULL OR cancelled_reservation_qty >= 0);
  END IF;
END
$$;

ALTER TABLE inventory.inventory_transactions
  ADD COLUMN IF NOT EXISTS build_run_id integer
    REFERENCES inventory.build_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS build_reversal_id integer
    REFERENCES inventory.build_run_reversals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inventory_transactions_build_run_idx
  ON inventory.inventory_transactions(build_run_id, created_at);

CREATE INDEX IF NOT EXISTS inventory_transactions_build_reversal_idx
  ON inventory.inventory_transactions(build_reversal_id, created_at);

ALTER TABLE inventory.inventory_lots
  ADD COLUMN IF NOT EXISTS build_run_id integer
    REFERENCES inventory.build_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inventory_lots_build_run_idx
  ON inventory.inventory_lots(build_run_id);

CREATE TABLE IF NOT EXISTS inventory.build_component_reservations (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  build_order_component_id integer NOT NULL
    REFERENCES inventory.build_order_components(id) ON DELETE RESTRICT,
  inventory_lot_id integer NOT NULL
    REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  reserved_qty integer NOT NULL,
  consumed_qty integer NOT NULL DEFAULT 0,
  released_qty integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_component_reservations_component_lot_uidx
    UNIQUE (build_order_component_id, inventory_lot_id),
  CONSTRAINT build_component_reservations_reserved_chk CHECK (reserved_qty > 0),
  CONSTRAINT build_component_reservations_consumed_chk CHECK (consumed_qty >= 0),
  CONSTRAINT build_component_reservations_released_chk CHECK (released_qty >= 0),
  CONSTRAINT build_component_reservations_balance_chk
    CHECK (consumed_qty + released_qty <= reserved_qty)
);

CREATE INDEX IF NOT EXISTS build_component_reservations_component_idx
  ON inventory.build_component_reservations(build_order_component_id, inventory_lot_id);

CREATE TABLE IF NOT EXISTS inventory.build_run_consumptions (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  build_run_id integer NOT NULL
    REFERENCES inventory.build_runs(id) ON DELETE RESTRICT,
  build_order_component_id integer NOT NULL
    REFERENCES inventory.build_order_components(id) ON DELETE RESTRICT,
  inventory_lot_id integer NOT NULL
    REFERENCES inventory.inventory_lots(id) ON DELETE RESTRICT,
  qty integer NOT NULL,
  po_unit_cost_mills bigint NOT NULL,
  packaging_unit_cost_mills bigint NOT NULL,
  landed_unit_cost_mills bigint NOT NULL,
  total_unit_cost_mills bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_run_consumptions_run_component_lot_uidx
    UNIQUE (build_run_id, build_order_component_id, inventory_lot_id),
  CONSTRAINT build_run_consumptions_qty_chk CHECK (qty > 0),
  CONSTRAINT build_run_consumptions_costs_chk CHECK (
    po_unit_cost_mills >= 0
    AND packaging_unit_cost_mills >= 0
    AND landed_unit_cost_mills >= 0
    AND total_unit_cost_mills = po_unit_cost_mills
      + packaging_unit_cost_mills
      + landed_unit_cost_mills
  )
);

CREATE INDEX IF NOT EXISTS build_run_consumptions_run_idx
  ON inventory.build_run_consumptions(build_run_id, id);
