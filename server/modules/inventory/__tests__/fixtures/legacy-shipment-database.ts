/** Reduced named schemas for actual shipment owner/Drizzle transaction tests. */
export const legacyShipmentFixtureSql = `
  CREATE SCHEMA inventory;
  CREATE SCHEMA warehouse;
  CREATE TABLE inventory.availability_runtime_authority (
    singleton_key boolean PRIMARY KEY, authority text, revision bigint, activation_run_id bigint
  );
  CREATE TABLE warehouse.warehouse_locations (
    id integer PRIMARY KEY, warehouse_id integer, is_active integer, is_pickable integer,
    cycle_count_freeze_id integer, location_type text, pick_sequence integer
  );
  CREATE TABLE inventory.inventory_levels (
    id integer PRIMARY KEY, warehouse_location_id integer NOT NULL, product_variant_id integer NOT NULL,
    variant_qty integer NOT NULL, reserved_qty integer NOT NULL, picked_qty integer NOT NULL,
    packed_qty integer NOT NULL DEFAULT 0, backorder_qty integer NOT NULL DEFAULT 0,
    updated_at timestamp NOT NULL DEFAULT now(), CHECK (reserved_qty <= variant_qty)
  );
  CREATE TABLE inventory.inventory_transactions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_variant_id integer, from_location_id integer, to_location_id integer,
    transaction_type varchar(30) NOT NULL, reason_id integer,
    variant_qty_delta integer NOT NULL DEFAULT 0, variant_qty_before integer, variant_qty_after integer,
    reserved_qty_delta integer, batch_id varchar(50), source_state varchar(20), target_state varchar(20),
    unit_cost_cents bigint, unit_cost_mills bigint, total_cost_mills bigint, inventory_lot_id integer,
    order_id integer, order_item_id integer, receiving_order_id integer, receiving_line_id integer,
    cycle_count_id integer, cycle_count_item_id integer, shipment_id integer, shipment_item_id integer,
    build_order_id integer, build_order_component_id integer, reference_type varchar(30), reference_id varchar(100),
    notes text, is_implicit integer NOT NULL DEFAULT 0, user_id varchar(100),
    created_at timestamp NOT NULL DEFAULT now(), build_run_id integer, build_reversal_id integer, voided_at timestamp
  );
  CREATE UNIQUE INDEX ship_item_dedup ON inventory.inventory_transactions (reference_id, shipment_item_id)
    WHERE transaction_type = 'ship';
`;

export const shipmentLotFixtureSql = `
  CREATE TABLE inventory.inventory_lots (
    id integer PRIMARY KEY, product_variant_id integer NOT NULL, warehouse_location_id integer NOT NULL,
    qty_on_hand integer NOT NULL CHECK (qty_on_hand >= 0),
    qty_reserved integer NOT NULL CHECK (qty_reserved >= 0 AND qty_reserved <= qty_on_hand),
    qty_picked integer NOT NULL CHECK (qty_picked >= 0), received_at timestamp NOT NULL, status text NOT NULL
  );
`;
