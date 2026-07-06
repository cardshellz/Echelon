-- Phase 2: canonical fulfillment/shipping shadow tables.
--
-- This migration is intentionally additive. Existing OMS/WMS/ShipStation flows
-- continue to use the legacy tables until a later cutover migrates writes.
-- The new tables separate:
--   1. fulfillment planning authority,
--   2. shipment requests sent to a shipping engine,
--   3. physical shipment events returned by the shipping engine, and
--   4. channel fulfillment pushes sent back to marketplaces.

CREATE TABLE IF NOT EXISTS wms.fulfillment_plans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oms_order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  wms_order_id INTEGER NOT NULL REFERENCES wms.orders(id) ON DELETE CASCADE,
  plan_status VARCHAR(30) NOT NULL DEFAULT 'active',
  planner_version VARCHAR(80) NOT NULL DEFAULT 'canonical-v1-shadow',
  superseded_by_plan_id BIGINT REFERENCES wms.fulfillment_plans(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_plans_status_chk CHECK (plan_status IN ('active', 'superseded', 'cancelled')),
  CONSTRAINT fulfillment_plans_superseded_chk CHECK (
    (plan_status = 'superseded' AND superseded_by_plan_id IS NOT NULL)
    OR (plan_status <> 'superseded' AND superseded_by_plan_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fulfillment_plans_active_wms_order
  ON wms.fulfillment_plans(wms_order_id)
  WHERE plan_status = 'active';

CREATE INDEX IF NOT EXISTS idx_fulfillment_plans_oms_order
  ON wms.fulfillment_plans(oms_order_id);

CREATE TABLE IF NOT EXISTS wms.fulfillment_plan_lines (
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
  CONSTRAINT fulfillment_plan_lines_quantity_chk CHECK (
    quantity_planned > 0
    AND quantity_cancelled >= 0
    AND quantity_shipped >= 0
    AND quantity_cancelled + quantity_shipped <= quantity_planned
  ),
  CONSTRAINT fulfillment_plan_lines_status_chk CHECK (
    line_status IN ('planned', 'partially_shipped', 'shipped', 'cancelled', 'shorted')
  ),
  CONSTRAINT fulfillment_plan_lines_unique_oms_line UNIQUE (fulfillment_plan_id, oms_order_line_id)
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_plan_lines_wms_item
  ON wms.fulfillment_plan_lines(wms_order_item_id);

CREATE TABLE IF NOT EXISTS wms.shipment_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fulfillment_plan_id BIGINT NOT NULL REFERENCES wms.fulfillment_plans(id) ON DELETE CASCADE,
  wms_order_id INTEGER NOT NULL REFERENCES wms.orders(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouse.warehouses(id) ON DELETE SET NULL,
  legacy_wms_shipment_id INTEGER REFERENCES wms.outbound_shipments(id) ON DELETE SET NULL,
  request_status VARCHAR(30) NOT NULL DEFAULT 'planned',
  hold_reason VARCHAR(200),
  priority_rank VARCHAR(64),
  ship_to_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  planner_reason VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipment_requests_status_chk CHECK (
    request_status IN ('planned', 'queued', 'accepted', 'cancelled', 'shipped', 'review')
  ),
  CONSTRAINT shipment_requests_legacy_unique UNIQUE (legacy_wms_shipment_id)
);

CREATE INDEX IF NOT EXISTS idx_shipment_requests_plan
  ON wms.shipment_requests(fulfillment_plan_id);

CREATE INDEX IF NOT EXISTS idx_shipment_requests_wms_order
  ON wms.shipment_requests(wms_order_id);

CREATE TABLE IF NOT EXISTS wms.shipment_request_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_request_id BIGINT NOT NULL REFERENCES wms.shipment_requests(id) ON DELETE CASCADE,
  fulfillment_plan_line_id BIGINT NOT NULL REFERENCES wms.fulfillment_plan_lines(id) ON DELETE RESTRICT,
  wms_order_item_id INTEGER NOT NULL REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  legacy_wms_shipment_item_id INTEGER REFERENCES wms.outbound_shipment_items(id) ON DELETE SET NULL,
  quantity_requested INTEGER NOT NULL,
  quantity_cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipment_request_items_quantity_chk CHECK (
    quantity_requested > 0
    AND quantity_cancelled >= 0
    AND quantity_cancelled <= quantity_requested
  ),
  CONSTRAINT shipment_request_items_unique_plan_line UNIQUE (shipment_request_id, fulfillment_plan_line_id),
  CONSTRAINT shipment_request_items_legacy_unique UNIQUE (legacy_wms_shipment_item_id)
);

CREATE INDEX IF NOT EXISTS idx_shipment_request_items_plan_line
  ON wms.shipment_request_items(fulfillment_plan_line_id);

CREATE TABLE IF NOT EXISTS wms.shipping_engine_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipment_request_id BIGINT NOT NULL REFERENCES wms.shipment_requests(id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL,
  provider_order_id VARCHAR(200),
  provider_order_key VARCHAR(200),
  provider_status VARCHAR(80),
  request_payload_hash VARCHAR(128),
  last_sync_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shipping_engine_orders_provider_chk CHECK (btrim(provider) <> ''),
  CONSTRAINT shipping_engine_orders_provider_ref_chk CHECK (
    provider_order_id IS NOT NULL OR provider_order_key IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_engine_orders_provider_order_id
  ON wms.shipping_engine_orders(provider, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_shipping_engine_orders_provider_order_key
  ON wms.shipping_engine_orders(provider, provider_order_key)
  WHERE provider_order_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipping_engine_orders_request
  ON wms.shipping_engine_orders(shipment_request_id);

CREATE TABLE IF NOT EXISTS wms.physical_shipments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shipping_engine_order_id BIGINT REFERENCES wms.shipping_engine_orders(id) ON DELETE SET NULL,
  shipment_request_id BIGINT NOT NULL REFERENCES wms.shipment_requests(id) ON DELETE CASCADE,
  provider VARCHAR(40) NOT NULL,
  provider_physical_shipment_id VARCHAR(200) NOT NULL,
  tracking_number VARCHAR(200),
  carrier VARCHAR(100),
  service_code VARCHAR(100),
  ship_date TIMESTAMPTZ,
  status VARCHAR(30) NOT NULL DEFAULT 'shipped',
  raw_event_hash VARCHAR(128),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT physical_shipments_provider_chk CHECK (btrim(provider) <> ''),
  CONSTRAINT physical_shipments_status_chk CHECK (
    status IN ('shipped', 'voided', 'returned', 'review')
  ),
  CONSTRAINT physical_shipments_provider_unique UNIQUE (provider, provider_physical_shipment_id)
);

CREATE INDEX IF NOT EXISTS idx_physical_shipments_request
  ON wms.physical_shipments(shipment_request_id);

CREATE INDEX IF NOT EXISTS idx_physical_shipments_tracking
  ON wms.physical_shipments(tracking_number)
  WHERE tracking_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS wms.physical_shipment_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  physical_shipment_id BIGINT NOT NULL REFERENCES wms.physical_shipments(id) ON DELETE CASCADE,
  shipment_request_item_id BIGINT NOT NULL REFERENCES wms.shipment_request_items(id) ON DELETE RESTRICT,
  fulfillment_plan_line_id BIGINT NOT NULL REFERENCES wms.fulfillment_plan_lines(id) ON DELETE RESTRICT,
  wms_order_item_id INTEGER NOT NULL REFERENCES wms.order_items(id) ON DELETE RESTRICT,
  quantity_shipped INTEGER NOT NULL,
  provider_physical_shipment_line_id VARCHAR(200),
  provider_order_line_id VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT physical_shipment_items_quantity_chk CHECK (quantity_shipped > 0),
  CONSTRAINT physical_shipment_items_request_item_unique UNIQUE (physical_shipment_id, shipment_request_item_id)
);

CREATE INDEX IF NOT EXISTS idx_physical_shipment_items_plan_line
  ON wms.physical_shipment_items(fulfillment_plan_line_id);

CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_pushes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  oms_order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  physical_shipment_id BIGINT NOT NULL REFERENCES wms.physical_shipments(id) ON DELETE CASCADE,
  channel_provider VARCHAR(40) NOT NULL,
  channel_fulfillment_id VARCHAR(200),
  push_status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_fulfillment_pushes_provider_chk CHECK (btrim(channel_provider) <> ''),
  CONSTRAINT channel_fulfillment_pushes_status_chk CHECK (
    push_status IN ('pending', 'success', 'failed', 'ignored', 'review')
  ),
  CONSTRAINT channel_fulfillment_pushes_attempt_chk CHECK (attempt_count >= 0),
  CONSTRAINT channel_fulfillment_pushes_unique_physical UNIQUE (channel_provider, physical_shipment_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_pushes_oms_order
  ON oms.channel_fulfillment_pushes(oms_order_id);

CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_push_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_fulfillment_push_id BIGINT NOT NULL REFERENCES oms.channel_fulfillment_pushes(id) ON DELETE CASCADE,
  oms_order_line_id BIGINT NOT NULL REFERENCES oms.oms_order_lines(id) ON DELETE RESTRICT,
  channel_order_line_id VARCHAR(200),
  quantity_pushed INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_fulfillment_push_items_quantity_chk CHECK (quantity_pushed > 0),
  CONSTRAINT channel_fulfillment_push_items_unique_line UNIQUE (channel_fulfillment_push_id, oms_order_line_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_push_items_oms_line
  ON oms.channel_fulfillment_push_items(oms_order_line_id);
