-- Generic inventory build workflow.
--
-- A build converts one or more component variants into an output variant.
-- Recipe rows are versioned master data. Build orders snapshot the recipe so
-- later recipe edits cannot rewrite operational history. Inventory movements
-- remain authoritative in inventory.inventory_transactions and are linked to
-- the exact build order/component that caused them.

CREATE TABLE IF NOT EXISTS inventory.build_recipes (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code varchar(50) NOT NULL,
  name varchar(150) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status varchar(20) NOT NULL DEFAULT 'draft',
  output_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id),
  output_qty integer NOT NULL DEFAULT 1,
  notes text,
  created_by varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_recipes_code_version_uidx UNIQUE (code, version),
  CONSTRAINT build_recipes_version_chk CHECK (version > 0),
  CONSTRAINT build_recipes_output_qty_chk CHECK (output_qty > 0),
  CONSTRAINT build_recipes_status_chk CHECK (status IN ('draft', 'active', 'retired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS build_recipes_one_active_version_uidx
  ON inventory.build_recipes(code)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS inventory.build_recipe_components (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  recipe_id integer NOT NULL
    REFERENCES inventory.build_recipes(id) ON DELETE CASCADE,
  component_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id),
  qty integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_recipe_components_recipe_variant_uidx
    UNIQUE (recipe_id, component_variant_id),
  CONSTRAINT build_recipe_components_qty_chk CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS inventory.build_orders (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  system_number varchar(40) NOT NULL UNIQUE,
  recipe_id integer NOT NULL
    REFERENCES inventory.build_recipes(id),
  recipe_code varchar(50) NOT NULL,
  recipe_version integer NOT NULL,
  output_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id),
  output_qty_per_build integer NOT NULL,
  planned_builds integer NOT NULL,
  completed_builds integer NOT NULL DEFAULT 0,
  warehouse_id integer NOT NULL
    REFERENCES warehouse.warehouses(id),
  output_location_id integer NOT NULL
    REFERENCES warehouse.warehouse_locations(id),
  status varchar(20) NOT NULL DEFAULT 'draft',
  idempotency_key varchar(100) NOT NULL UNIQUE,
  total_component_cost_mills bigint,
  failure_code varchar(50),
  failure_message text,
  created_by varchar(100),
  released_by varchar(100),
  completed_by varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_orders_recipe_version_chk CHECK (recipe_version > 0),
  CONSTRAINT build_orders_output_qty_chk CHECK (output_qty_per_build > 0),
  CONSTRAINT build_orders_planned_builds_chk CHECK (planned_builds > 0),
  CONSTRAINT build_orders_completed_builds_chk
    CHECK (completed_builds >= 0 AND completed_builds <= planned_builds),
  CONSTRAINT build_orders_status_chk CHECK (
    status IN ('draft', 'released', 'in_progress', 'completed', 'cancelled', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS build_orders_status_created_idx
  ON inventory.build_orders(status, created_at DESC);

CREATE INDEX IF NOT EXISTS build_orders_warehouse_status_idx
  ON inventory.build_orders(warehouse_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS inventory.build_order_components (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  build_order_id integer NOT NULL
    REFERENCES inventory.build_orders(id) ON DELETE CASCADE,
  recipe_component_id integer NOT NULL
    REFERENCES inventory.build_recipe_components(id),
  component_variant_id integer NOT NULL
    REFERENCES catalog.product_variants(id),
  qty_per_build integer NOT NULL,
  planned_qty integer NOT NULL,
  consumed_qty integer NOT NULL DEFAULT 0,
  source_location_id integer
    REFERENCES warehouse.warehouse_locations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT build_order_components_order_variant_uidx
    UNIQUE (build_order_id, component_variant_id),
  CONSTRAINT build_order_components_qty_per_build_chk CHECK (qty_per_build > 0),
  CONSTRAINT build_order_components_planned_qty_chk CHECK (planned_qty > 0),
  CONSTRAINT build_order_components_consumed_qty_chk
    CHECK (consumed_qty >= 0 AND consumed_qty <= planned_qty)
);

ALTER TABLE inventory.inventory_transactions
  ADD COLUMN IF NOT EXISTS build_order_id integer
    REFERENCES inventory.build_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS build_order_component_id integer
    REFERENCES inventory.build_order_components(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inventory_transactions_build_order_idx
  ON inventory.inventory_transactions(build_order_id, created_at);

ALTER TABLE inventory.inventory_lots
  ADD COLUMN IF NOT EXISTS build_order_id integer
    REFERENCES inventory.build_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS inventory_lots_build_order_idx
  ON inventory.inventory_lots(build_order_id);
