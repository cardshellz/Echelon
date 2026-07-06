-- Shipping engine foundation (quote plane): box suite, variant packing
-- attributes, zones, rate tables, service levels, transit matrix, pack plans,
-- quote snapshots. Design: docs/SHIPPING-ENGINE-DESIGN.md.
--
-- Additive only. The fulfillment plane (wms.fulfillment_plans →
-- shipment_requests → physical_shipments, migration 115) is unchanged; pack
-- plans reference wms.shipment_requests so the quoted box choice and the
-- physical pack execute from one record. Dropship keeps its vendor-scoped
-- stack until it converges on these tables.

CREATE SCHEMA IF NOT EXISTS shipping;

-- ---------------------------------------------------------------------------
-- Box suite
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shipping.box_catalog (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(200) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'box',
  length_mm INTEGER NOT NULL,
  width_mm INTEGER NOT NULL,
  height_mm INTEGER NOT NULL,
  tare_weight_grams INTEGER NOT NULL DEFAULT 0,
  max_weight_grams INTEGER,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  fill_factor_bps INTEGER NOT NULL DEFAULT 8500,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_box_kind_chk CHECK (kind IN ('box', 'mailer', 'envelope')),
  CONSTRAINT shipping_box_dims_chk CHECK (length_mm > 0 AND width_mm > 0 AND height_mm > 0 AND tare_weight_grams >= 0),
  CONSTRAINT shipping_box_cost_chk CHECK (cost_cents >= 0),
  CONSTRAINT shipping_box_fill_chk CHECK (fill_factor_bps > 0 AND fill_factor_bps <= 10000)
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_box_code_idx ON shipping.box_catalog(code);

CREATE TABLE IF NOT EXISTS shipping.box_warehouse_stock (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_id INTEGER NOT NULL REFERENCES shipping.box_catalog(id) ON DELETE CASCADE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  is_stocked BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_box_warehouse_idx
  ON shipping.box_warehouse_stock(box_id, warehouse_id);

-- ---------------------------------------------------------------------------
-- Variant packing attributes (dims/weight stay on catalog.product_variants)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shipping.variant_shipping_attrs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_variant_id INTEGER NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  ships_in_own_container BOOLEAN NOT NULL DEFAULT FALSE,
  sioc_suggested BOOLEAN NOT NULL DEFAULT FALSE,
  rider_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  rider_void_cm3 INTEGER,
  rider_void_max_weight_grams INTEGER,
  rider_void_max_items INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_variant_attrs_void_chk CHECK (
    (rider_void_cm3 IS NULL OR rider_void_cm3 > 0)
    AND (rider_void_max_weight_grams IS NULL OR rider_void_max_weight_grams > 0)
    AND (rider_void_max_items IS NULL OR rider_void_max_items > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_variant_attrs_variant_idx
  ON shipping.variant_shipping_attrs(product_variant_id);

-- ---------------------------------------------------------------------------
-- Zones and rate tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shipping.zone_rules (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origin_warehouse_id INTEGER NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  destination_country VARCHAR(2) NOT NULL DEFAULT 'US',
  destination_region VARCHAR(100),
  postal_prefix VARCHAR(20),
  zone VARCHAR(40) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipping_zone_rules_lookup_idx
  ON shipping.zone_rules(origin_warehouse_id, destination_country, postal_prefix, is_active);

CREATE TABLE IF NOT EXISTS shipping.rate_tables (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier VARCHAR(50) NOT NULL,
  service_code VARCHAR(80) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  effective_from TIMESTAMPTZ NOT NULL,
  effective_to TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shipping_rate_table_carrier_service_idx
  ON shipping.rate_tables(carrier, service_code, status);

CREATE TABLE IF NOT EXISTS shipping.rate_table_rows (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_table_id INTEGER NOT NULL REFERENCES shipping.rate_tables(id) ON DELETE CASCADE,
  origin_warehouse_id INTEGER REFERENCES warehouse.warehouses(id) ON DELETE SET NULL,
  destination_zone VARCHAR(40) NOT NULL,
  min_weight_grams INTEGER NOT NULL DEFAULT 0,
  max_weight_grams INTEGER NOT NULL,
  rate_cents BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_rate_row_weight_chk CHECK (min_weight_grams >= 0 AND max_weight_grams >= min_weight_grams),
  CONSTRAINT shipping_rate_row_rate_chk CHECK (rate_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_rate_row_band_idx
  ON shipping.rate_table_rows(rate_table_id, origin_warehouse_id, destination_zone, min_weight_grams, max_weight_grams);

-- ---------------------------------------------------------------------------
-- Service levels + transit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shipping.service_levels (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code VARCHAR(40) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  description VARCHAR(400),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_service_level_code_idx
  ON shipping.service_levels(code);

CREATE TABLE IF NOT EXISTS shipping.service_level_methods (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service_level_id INTEGER NOT NULL REFERENCES shipping.service_levels(id) ON DELETE CASCADE,
  carrier VARCHAR(50) NOT NULL,
  service_code VARCHAR(80) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_level_method_idx
  ON shipping.service_level_methods(service_level_id, carrier, service_code);

CREATE TABLE IF NOT EXISTS shipping.transit_matrix (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carrier VARCHAR(50) NOT NULL,
  service_code VARCHAR(80) NOT NULL,
  origin_warehouse_id INTEGER NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  destination_zone VARCHAR(40) NOT NULL,
  min_business_days INTEGER NOT NULL,
  max_business_days INTEGER NOT NULL,
  source VARCHAR(40) NOT NULL DEFAULT 'carrier_standard',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_transit_days_chk CHECK (min_business_days >= 0 AND max_business_days >= min_business_days)
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_transit_idx
  ON shipping.transit_matrix(carrier, service_code, origin_warehouse_id, destination_zone);

-- ---------------------------------------------------------------------------
-- Pack plans (one record: quoted box choice == pack-station instruction)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shipping.pack_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wms_order_id INTEGER REFERENCES wms.orders(id) ON DELETE CASCADE,
  shipment_request_id BIGINT REFERENCES wms.shipment_requests(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  engine_version VARCHAR(80) NOT NULL,
  input_hash VARCHAR(128),
  warnings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_pack_plans_status_chk CHECK (status IN ('active', 'superseded', 'packed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS shipping_pack_plans_order_idx ON shipping.pack_plans(wms_order_id);
CREATE INDEX IF NOT EXISTS shipping_pack_plans_request_idx ON shipping.pack_plans(shipment_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS shipping_pack_plans_active_request_idx
  ON shipping.pack_plans(shipment_request_id)
  WHERE status = 'active' AND shipment_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS shipping.pack_plan_parcels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pack_plan_id BIGINT NOT NULL REFERENCES shipping.pack_plans(id) ON DELETE CASCADE,
  parcel_sequence INTEGER NOT NULL,
  box_id INTEGER REFERENCES shipping.box_catalog(id) ON DELETE RESTRICT,
  sioc_product_variant_id INTEGER REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  est_weight_grams INTEGER NOT NULL,
  billable_weight_grams INTEGER NOT NULL,
  length_mm INTEGER NOT NULL,
  width_mm INTEGER NOT NULL,
  height_mm INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_parcel_container_chk CHECK (
    (box_id IS NOT NULL AND sioc_product_variant_id IS NULL)
    OR (box_id IS NULL AND sioc_product_variant_id IS NOT NULL)
  ),
  CONSTRAINT shipping_parcel_weights_chk CHECK (est_weight_grams > 0 AND billable_weight_grams > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_parcel_seq_idx
  ON shipping.pack_plan_parcels(pack_plan_id, parcel_sequence);

CREATE TABLE IF NOT EXISTS shipping.pack_plan_parcel_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parcel_id BIGINT NOT NULL REFERENCES shipping.pack_plan_parcels(id) ON DELETE CASCADE,
  product_variant_id INTEGER NOT NULL REFERENCES catalog.product_variants(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL,
  is_rider BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_parcel_item_qty_chk CHECK (quantity > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_parcel_item_idx
  ON shipping.pack_plan_parcel_items(parcel_id, product_variant_id);

-- ---------------------------------------------------------------------------
-- Quote snapshots (shadow mode + checkout observability = calibration dataset)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS shipping.quote_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source VARCHAR(30) NOT NULL,
  destination_country VARCHAR(2) NOT NULL DEFAULT 'US',
  destination_postal_code VARCHAR(20),
  resolved_zone VARCHAR(40),
  request_hash VARCHAR(128),
  request_payload JSONB NOT NULL,
  packing JSONB,
  rates JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_quote_snapshots_source_chk CHECK (source IN ('shadow', 'checkout', 'preview', 'manual'))
);

CREATE INDEX IF NOT EXISTS shipping_quote_snapshots_created_idx ON shipping.quote_snapshots(created_at);
CREATE INDEX IF NOT EXISTS shipping_quote_snapshots_hash_idx ON shipping.quote_snapshots(request_hash);

-- ---------------------------------------------------------------------------
-- Seed: the three service levels checkout will sell. Inactive until rates and
-- transit data exist; activation is a deliberate admin step, not a deploy.
-- ---------------------------------------------------------------------------

INSERT INTO shipping.service_levels (code, display_name, description, sort_order, is_active)
VALUES
  ('standard', 'Standard Shipping', 'Default ground service', 10, FALSE),
  ('expedited', 'Expedited Shipping', 'Faster ground/2-3 day service', 20, FALSE),
  ('express', 'Express Shipping', '1-2 day air service', 30, FALSE)
ON CONFLICT DO NOTHING;
