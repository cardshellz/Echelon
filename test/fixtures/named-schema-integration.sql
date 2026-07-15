DROP SCHEMA IF EXISTS channels CASCADE;
DROP SCHEMA IF EXISTS inventory CASCADE;
DROP SCHEMA IF EXISTS warehouse CASCADE;
DROP SCHEMA IF EXISTS catalog CASCADE;
DROP SCHEMA IF EXISTS wms CASCADE;

CREATE SCHEMA catalog;
CREATE SCHEMA warehouse;
CREATE SCHEMA inventory;
CREATE SCHEMA channels;
CREATE SCHEMA wms;

CREATE TABLE catalog.products (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku varchar(100),
  name text NOT NULL,
  title varchar(500),
  description text,
  bullet_points jsonb,
  category_id integer,
  category varchar(100),
  shipping_group_id integer,
  subcategory varchar(200),
  brand varchar(100),
  manufacturer varchar(200),
  base_unit varchar(20) NOT NULL DEFAULT 'piece',
  tags jsonb,
  seo_title varchar(200),
  seo_description text,
  shopify_product_id varchar(100),
  lead_time_days integer NOT NULL DEFAULT 120,
  safety_stock_days integer NOT NULL DEFAULT 7,
  status varchar(20) DEFAULT 'active',
  inventory_type varchar(20) NOT NULL DEFAULT 'inventory',
  is_active boolean NOT NULL DEFAULT true,
  condition varchar(30) DEFAULT 'new',
  country_of_origin varchar(2),
  harmonized_code varchar(20),
  item_specifics jsonb,
  product_type varchar(50),
  ebay_browse_category_id varchar(20),
  ebay_browse_category_name varchar(200),
  ebay_fulfillment_policy_override varchar(100),
  ebay_return_policy_override varchar(100),
  ebay_payment_policy_override varchar(100),
  ebay_listing_excluded boolean NOT NULL DEFAULT false,
  reorder_excluded boolean NOT NULL DEFAULT false,
  last_pushed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE catalog.product_variants (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id integer NOT NULL REFERENCES catalog.products(id),
  sku varchar(100),
  name text NOT NULL,
  units_per_variant integer NOT NULL DEFAULT 1,
  hierarchy_level integer NOT NULL DEFAULT 1,
  parent_variant_id integer,
  is_base_unit boolean NOT NULL DEFAULT false,
  barcode varchar(100),
  weight_grams integer,
  length_mm integer,
  width_mm integer,
  height_mm integer,
  price_cents bigint,
  compare_at_price_cents bigint,
  standard_cost_cents bigint,
  last_cost_cents bigint,
  avg_cost_cents bigint,
  track_inventory boolean DEFAULT true,
  inventory_policy varchar(20) DEFAULT 'deny',
  shopify_variant_id varchar(100),
  shopify_inventory_item_id varchar(100),
  is_active boolean NOT NULL DEFAULT true,
  position integer DEFAULT 0,
  option1_name varchar(100),
  option1_value varchar(100),
  option2_name varchar(100),
  option2_value varchar(100),
  option3_name varchar(100),
  option3_value varchar(100),
  gtin varchar(14),
  mpn varchar(100),
  condition_note text,
  ebay_listing_excluded boolean NOT NULL DEFAULT false,
  ebay_fulfillment_policy_override varchar(100),
  ebay_return_policy_override varchar(100),
  ebay_payment_policy_override varchar(100),
  dropship_eligible boolean DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE catalog.product_lines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(50) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE catalog.product_line_products (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_line_id integer NOT NULL REFERENCES catalog.product_lines(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (product_line_id, product_id)
);

CREATE TABLE warehouse.warehouses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(20) NOT NULL UNIQUE,
  name varchar(200) NOT NULL,
  warehouse_type varchar(30) NOT NULL DEFAULT 'operations',
  hub_warehouse_id integer,
  address text,
  city varchar(100),
  state varchar(50),
  postal_code varchar(20),
  country varchar(50) DEFAULT 'US',
  timezone varchar(50) DEFAULT 'America/New_York',
  order_cutoff_local varchar(5),
  is_active integer NOT NULL DEFAULT 1,
  is_default integer NOT NULL DEFAULT 0,
  shopify_location_id varchar(50),
  inventory_source_type varchar(20) NOT NULL DEFAULT 'internal',
  inventory_source_config jsonb,
  last_inventory_sync_at timestamp,
  inventory_sync_status varchar(20) DEFAULT 'never',
  feed_enabled boolean DEFAULT true,
  shipping_config jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE warehouse.warehouse_locations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id integer REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  code varchar(50) NOT NULL,
  name text,
  zone varchar(10),
  aisle varchar(5),
  bay varchar(5),
  level varchar(5),
  bin varchar(5),
  location_type varchar(30) NOT NULL DEFAULT 'pick',
  bin_type varchar(30) NOT NULL DEFAULT 'bin',
  is_pickable integer NOT NULL DEFAULT 1,
  cycle_count_freeze_id integer,
  parent_location_id integer,
  replen_source_type varchar(30),
  movement_policy varchar(20) NOT NULL DEFAULT 'implicit',
  capacity_cubic_mm bigint,
  max_weight_g integer,
  width_mm integer,
  height_mm integer,
  depth_mm integer,
  pick_zone_id integer,
  created_at timestamp NOT NULL DEFAULT now(),
  is_active integer NOT NULL DEFAULT 1,
  pick_sequence integer,
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (warehouse_id, code)
);

CREATE TABLE inventory.inventory_levels (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_location_id integer NOT NULL REFERENCES warehouse.warehouse_locations(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  variant_qty integer NOT NULL DEFAULT 0,
  reserved_qty integer NOT NULL DEFAULT 0,
  picked_qty integer NOT NULL DEFAULT 0,
  packed_qty integer NOT NULL DEFAULT 0,
  backorder_qty integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT check_reserved_lte_on_hand CHECK (reserved_qty <= variant_qty),
  UNIQUE (warehouse_location_id, product_variant_id)
);

CREATE TABLE wms.orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_status varchar(30) NOT NULL DEFAULT 'pending',
  cancelled_at timestamp,
  order_placed_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE wms.order_items (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id integer NOT NULL REFERENCES wms.orders(id) ON DELETE CASCADE,
  sku varchar(100),
  quantity integer NOT NULL DEFAULT 0,
  status varchar(30) NOT NULL DEFAULT 'pending'
);

CREATE TABLE inventory.inventory_transactions (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_variant_id integer REFERENCES catalog.product_variants(id),
  from_location_id integer REFERENCES warehouse.warehouse_locations(id) ON DELETE SET NULL,
  to_location_id integer REFERENCES warehouse.warehouse_locations(id) ON DELETE SET NULL,
  transaction_type varchar(30) NOT NULL,
  reason_id integer,
  variant_qty_delta integer NOT NULL DEFAULT 0,
  variant_qty_before integer,
  variant_qty_after integer,
  reserved_qty_delta integer,
  batch_id varchar(50),
  source_state varchar(20),
  target_state varchar(20),
  unit_cost_cents bigint,
  inventory_lot_id integer,
  order_id integer REFERENCES wms.orders(id),
  order_item_id integer REFERENCES wms.order_items(id),
  receiving_order_id integer,
  cycle_count_id integer,
  shipment_id integer,
  shipment_item_id integer,
  reference_type varchar(30),
  reference_id varchar(100),
  notes text,
  is_implicit integer NOT NULL DEFAULT 0,
  user_id varchar(100),
  created_at timestamp NOT NULL DEFAULT now(),
  voided_at timestamp
);

CREATE TABLE channels.channels (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(100) NOT NULL,
  type varchar(20) NOT NULL DEFAULT 'internal',
  provider varchar(30) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending_setup',
  is_default integer NOT NULL DEFAULT 0,
  priority integer NOT NULL DEFAULT 0,
  allocation_pct integer,
  allocation_fixed_qty integer,
  sync_enabled boolean DEFAULT false,
  sync_mode varchar(10) DEFAULT 'dry_run',
  sweep_interval_minutes integer DEFAULT 15,
  sla_days integer,
  shipping_config jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE channels.channel_reservations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  reserve_base_qty integer NOT NULL DEFAULT 0,
  min_stock_base integer DEFAULT 0,
  max_stock_base integer,
  override_qty integer,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, product_variant_id)
);

CREATE TABLE channels.channel_product_allocation (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  min_atp_base integer,
  max_atp_base integer,
  is_listed integer NOT NULL DEFAULT 1,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, product_id)
);

CREATE TABLE channels.channel_product_lines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_line_id integer NOT NULL REFERENCES catalog.product_lines(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, product_line_id)
);

CREATE TABLE channels.channel_product_overrides (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  title_override varchar(500),
  description_override text,
  bullet_points_override jsonb,
  category_override varchar(200),
  tags_override jsonb,
  item_specifics jsonb,
  marketplace_category_id varchar(100),
  listing_format varchar(30),
  condition_id integer,
  is_listed integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, product_id)
);

CREATE TABLE channels.channel_variant_overrides (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  name_override varchar(500),
  sku_override varchar(100),
  barcode_override varchar(100),
  weight_override integer,
  is_listed integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, product_variant_id)
);

CREATE TABLE channels.channel_warehouse_assignments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, warehouse_id)
);

CREATE TABLE channels.channel_allocation_rules (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer REFERENCES channels.channels(id) ON DELETE CASCADE,
  product_id integer REFERENCES catalog.products(id) ON DELETE CASCADE,
  product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  mode varchar(10) NOT NULL DEFAULT 'mirror',
  share_pct integer,
  fixed_qty integer,
  floor_atp integer DEFAULT 0,
  floor_type varchar(10) DEFAULT 'units',
  ceiling_qty integer,
  eligible boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX channel_allocation_rules_scope_uq
  ON channels.channel_allocation_rules (
    COALESCE(channel_id, 0),
    COALESCE(product_id, 0),
    COALESCE(product_variant_id, 0)
  );

CREATE TABLE channels.allocation_audit_log (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id integer REFERENCES catalog.products(id),
  product_variant_id integer REFERENCES catalog.product_variants(id),
  channel_id integer REFERENCES channels.channels(id),
  total_atp_base integer NOT NULL,
  allocated_qty integer NOT NULL,
  previous_qty integer,
  allocation_method varchar(30) NOT NULL,
  details jsonb,
  triggered_by varchar(30),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE channels.source_lock_config (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
  field_type varchar(30) NOT NULL,
  is_locked integer NOT NULL DEFAULT 1,
  locked_by varchar(100),
  locked_at timestamp DEFAULT now(),
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  UNIQUE (channel_id, field_type)
);
