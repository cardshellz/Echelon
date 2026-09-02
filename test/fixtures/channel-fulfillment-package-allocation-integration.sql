-- Minimal canonical OMS/WMS fulfillment contract required by the disposable
-- package-allocation integration suite. Production uses the full migration
-- history; this fixture only expands the deliberately small named-schema base.

CREATE TABLE oms.oms_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_order_id VARCHAR(200) NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels.channels(id) ON DELETE RESTRICT,
  status VARCHAR(30),
  financial_status VARCHAR(30)
);

CREATE TABLE oms.oms_order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  external_line_item_id VARCHAR(200) NOT NULL,
  fulfillment_provider VARCHAR(40),
  paid_quantity INTEGER NOT NULL,
  authority_fulfillable_quantity INTEGER NOT NULL
);

CREATE TABLE oms.oms_order_line_authority_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_line_id BIGINT NOT NULL REFERENCES oms.oms_order_lines(id) ON DELETE CASCADE,
  paid_quantity INTEGER NOT NULL
);

ALTER TABLE wms.orders
  ADD COLUMN warehouse_id INTEGER,
  ADD COLUMN sort_rank VARCHAR(64),
  ADD COLUMN oms_fulfillment_order_id VARCHAR(200),
  ADD COLUMN shipping_name VARCHAR(200),
  ADD COLUMN shipping_company VARCHAR(200),
  ADD COLUMN shipping_address VARCHAR(300),
  ADD COLUMN shipping_address2 VARCHAR(300),
  ADD COLUMN shipping_city VARCHAR(100),
  ADD COLUMN shipping_state VARCHAR(100),
  ADD COLUMN shipping_postal_code VARCHAR(30),
  ADD COLUMN shipping_country VARCHAR(100);

ALTER TABLE wms.order_items
  ADD COLUMN oms_order_line_id BIGINT REFERENCES oms.oms_order_lines(id) ON DELETE RESTRICT;

ALTER TABLE wms.outbound_shipments
  ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'pending',
  ADD COLUMN shipment_purpose VARCHAR(30) NOT NULL DEFAULT 'customer_fulfillment',
  ADD COLUMN shipping_engine VARCHAR(40),
  ADD COLUMN shipstation_order_id INTEGER,
  ADD COLUMN engine_order_ref VARCHAR(200),
  ADD COLUMN shipstation_order_key VARCHAR(200),
  ADD COLUMN external_fulfillment_id VARCHAR(300),
  ADD COLUMN tracking_number VARCHAR(200),
  ADD COLUMN carrier VARCHAR(100),
  ADD COLUMN tracking_url TEXT,
  ADD COLUMN service_code VARCHAR(100),
  ADD COLUMN shipped_at TIMESTAMPTZ,
  ADD COLUMN requires_review BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN review_reason TEXT,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE wms.fulfillment_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oms_order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  wms_order_id INTEGER NOT NULL REFERENCES wms.orders(id) ON DELETE CASCADE,
  plan_status VARCHAR(30) NOT NULL DEFAULT 'active',
  planner_version VARCHAR(80) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_fulfillment_plans_active_wms_order
  ON wms.fulfillment_plans(wms_order_id)
  WHERE plan_status = 'active';

CREATE TABLE wms.fulfillment_plan_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fulfillment_plan_id BIGINT NOT NULL REFERENCES wms.fulfillment_plans(id) ON DELETE CASCADE,
  oms_order_line_id BIGINT NOT NULL REFERENCES oms.oms_order_lines(id) ON DELETE RESTRICT,
  wms_order_item_id INTEGER NOT NULL REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  product_variant_id INTEGER REFERENCES catalog.product_variants(id) ON DELETE SET NULL,
  sku VARCHAR(100) NOT NULL,
  quantity_planned INTEGER NOT NULL,
  quantity_cancelled INTEGER NOT NULL DEFAULT 0,
  quantity_shipped INTEGER NOT NULL DEFAULT 0,
  line_status VARCHAR(30) NOT NULL DEFAULT 'planned',
  authority_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fulfillment_plan_id, oms_order_line_id)
);

ALTER TABLE wms.shipment_requests
  ADD COLUMN fulfillment_plan_id BIGINT REFERENCES wms.fulfillment_plans(id) ON DELETE CASCADE,
  ADD COLUMN warehouse_id INTEGER,
  ADD COLUMN request_status VARCHAR(30) NOT NULL DEFAULT 'planned',
  ADD COLUMN priority_rank VARCHAR(64),
  ADD COLUMN ship_to_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN planner_reason VARCHAR(120),
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE wms.shipment_request_items
  ADD COLUMN fulfillment_plan_line_id BIGINT REFERENCES wms.fulfillment_plan_lines(id) ON DELETE RESTRICT,
  ADD COLUMN wms_order_item_id INTEGER REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  ADD COLUMN quantity_requested INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN quantity_cancelled INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX shipment_request_items_unique_plan_line
  ON wms.shipment_request_items(shipment_request_id, fulfillment_plan_line_id)
  WHERE fulfillment_plan_line_id IS NOT NULL;

ALTER TABLE wms.shipping_engine_orders
  ADD COLUMN command_key VARCHAR(300),
  ADD COLUMN provider_status VARCHAR(80),
  ADD COLUMN last_sync_at TIMESTAMPTZ,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX uq_shipping_engine_orders_provider_order_id
  ON wms.shipping_engine_orders(provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX uq_shipping_engine_orders_provider_order_key
  ON wms.shipping_engine_orders(provider, provider_order_key)
  WHERE provider_order_key IS NOT NULL;
CREATE UNIQUE INDEX uq_shipping_engine_orders_command_key
  ON wms.shipping_engine_orders(provider, command_key)
  WHERE command_key IS NOT NULL;

ALTER TABLE wms.shipping_engine_order_provider_refs
  ADD COLUMN source VARCHAR(50),
  ADD COLUMN first_observed_at TIMESTAMPTZ,
  ADD COLUMN last_observed_at TIMESTAMPTZ,
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX uq_shipping_engine_order_provider_refs_identity
  ON wms.shipping_engine_order_provider_refs(provider, provider_order_id);

ALTER TABLE wms.shipping_engine_order_requests
  ADD COLUMN relationship_type VARCHAR(30) NOT NULL DEFAULT 'primary',
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX shipping_engine_order_requests_unique
  ON wms.shipping_engine_order_requests(shipping_engine_order_id, shipment_request_id);

ALTER TABLE wms.physical_shipments
  ADD COLUMN tracking_number VARCHAR(200),
  ADD COLUMN carrier VARCHAR(100),
  ADD COLUMN service_code VARCHAR(100),
  ADD COLUMN ship_date TIMESTAMPTZ,
  ADD COLUMN status VARCHAR(30) NOT NULL DEFAULT 'shipped',
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX physical_shipments_provider_unique
  ON wms.physical_shipments(provider, provider_physical_shipment_id);
CREATE UNIQUE INDEX physical_shipment_items_request_item_unique
  ON wms.physical_shipment_items(physical_shipment_id, shipment_request_item_id)
  WHERE shipment_request_item_id IS NOT NULL;

ALTER TABLE wms.shipping_provider_labels
  ADD COLUMN normalized_tracking_number VARCHAR(200),
  ADD COLUMN carrier VARCHAR(100),
  ADD COLUMN service_code VARCHAR(100),
  ADD COLUMN label_created_at TIMESTAMPTZ,
  ADD COLUMN voided_at TIMESTAMPTZ,
  ADD COLUMN source VARCHAR(50) NOT NULL DEFAULT 'integration',
  ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX uq_shipping_provider_labels_provider_label
  ON wms.shipping_provider_labels(provider, provider_label_id);

CREATE TABLE oms.channel_fulfillment_pushes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oms_order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE RESTRICT,
  physical_shipment_id BIGINT NOT NULL REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
  channel_provider VARCHAR(40) NOT NULL,
  channel_fulfillment_scope_key VARCHAR(200) NOT NULL,
  command_key VARCHAR(400) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  tracking_number VARCHAR(200) NOT NULL,
  carrier VARCHAR(100) NOT NULL,
  tracking_url TEXT,
  shipped_at TIMESTAMPTZ,
  channel_fulfillment_id VARCHAR(200),
  push_status VARCHAR(30) NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 12,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token VARCHAR(100),
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  correlation_id VARCHAR(100),
  causation_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (command_key)
);

CREATE UNIQUE INDEX uq_channel_fulfillment_pushes_command
  ON oms.channel_fulfillment_pushes(
    channel_provider,
    oms_order_id,
    physical_shipment_id,
    channel_fulfillment_scope_key
  );

CREATE INDEX idx_channel_fulfillment_pushes_due
  ON oms.channel_fulfillment_pushes(next_attempt_at, id)
  WHERE push_status IN ('pending', 'retry');

CREATE TABLE oms.channel_fulfillment_push_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_fulfillment_push_id BIGINT NOT NULL
    REFERENCES oms.channel_fulfillment_pushes(id) ON DELETE RESTRICT,
  physical_shipment_item_id BIGINT
    REFERENCES wms.physical_shipment_items(id) ON DELETE RESTRICT,
  oms_order_line_id BIGINT NOT NULL REFERENCES oms.oms_order_lines(id) ON DELETE RESTRICT,
  channel_order_line_id VARCHAR(200),
  quantity_pushed INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_channel_fulfillment_push_items_physical_item
  ON oms.channel_fulfillment_push_items(
    channel_fulfillment_push_id,
    physical_shipment_item_id
  )
  WHERE physical_shipment_item_id IS NOT NULL;
