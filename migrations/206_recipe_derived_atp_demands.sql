-- Recipe-derived ATP must create executable work before it can hold an order line.
-- These tables preserve the build graph and the order-item claim that owns it.

CREATE TABLE IF NOT EXISTS inventory.build_order_dependencies (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dependent_build_order_id integer NOT NULL
    REFERENCES inventory.build_orders(id) ON DELETE CASCADE,
  prerequisite_build_order_id integer NOT NULL
    REFERENCES inventory.build_orders(id) ON DELETE RESTRICT,
  component_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  required_qty integer NOT NULL CHECK (required_qty > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_order_dependencies_no_self_chk
    CHECK (dependent_build_order_id <> prerequisite_build_order_id),
  CONSTRAINT build_order_dependencies_uidx
    UNIQUE (dependent_build_order_id, prerequisite_build_order_id, component_variant_id)
);

CREATE INDEX IF NOT EXISTS build_order_dependencies_prerequisite_idx
  ON inventory.build_order_dependencies(prerequisite_build_order_id, dependent_build_order_id);

CREATE TABLE IF NOT EXISTS wms.order_build_demands (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE RESTRICT,
  order_item_id integer NOT NULL REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  target_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE RESTRICT,
  root_build_order_id integer REFERENCES inventory.build_orders(id) ON DELETE RESTRICT,
  requested_qty integer NOT NULL CHECK (requested_qty > 0),
  promised_qty integer NOT NULL CHECK (promised_qty > 0),
  status varchar(30) NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'awaiting_build', 'fulfilled', 'cancelled', 'failed')),
  hold_applied boolean NOT NULL DEFAULT false,
  hold_reason varchar(200) NOT NULL,
  failure_code varchar(60),
  failure_message text,
  created_by varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_build_demands_order_item_uidx UNIQUE (order_item_id),
  CONSTRAINT order_build_demands_root_build_order_uidx UNIQUE (root_build_order_id),
  CONSTRAINT order_build_demands_root_required_chk
    CHECK (status = 'planning' OR root_build_order_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS order_build_demands_status_created_idx
  ON wms.order_build_demands(status, created_at);
CREATE INDEX IF NOT EXISTS order_build_demands_order_idx
  ON wms.order_build_demands(order_id, status);
