-- Migration 027: Inbound Shipment Tracking + Landed Cost Allocation
-- Creates tables for tracking inbound shipments from vendors,
-- itemizing costs, and allocating landed costs to PO lines/lots.

BEGIN;

-- ============================================================
-- 1. inbound_shipments (header)
-- ============================================================
CREATE TABLE IF NOT EXISTS inbound_shipments (
  id              integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  shipment_number varchar(30) NOT NULL UNIQUE,          -- SHP-YYYYMMDD-###
  status          varchar(20) NOT NULL DEFAULT 'draft',  -- draft, booked, in_transit, at_port, customs_clearance, delivered, costing, closed, cancelled
  mode            varchar(20),                           -- sea_fcl, sea_lcl, air, ground, ltl, ftl, parcel, courier
  carrier_name    varchar(100),
  forwarder_name  varchar(100),
  booking_reference varchar(100),
  origin_port     varchar(100),
  destination_port varchar(100),
  origin_country  varchar(50),
  destination_country varchar(50),
  container_number varchar(30),
  seal_number     varchar(30),
  container_size  varchar(10),                           -- 20, 40, 40HC
  container_capacity_cbm numeric(8,2),                   -- Rated capacity for utilization %
  bol_number      varchar(100),                          -- Bill of lading
  house_bol       varchar(100),                          -- House BOL (forwarder)
  tracking_number varchar(200),
  ship_date       timestamp,                             -- Actual departure
  etd             timestamp,                             -- Estimated departure
  eta             timestamp,                             -- Estimated arrival
  actual_arrival  timestamp,                             -- Actual arrival at port
  customs_cleared_date timestamp,
  delivered_date  timestamp,                             -- Delivered to warehouse
  warehouse_id    integer REFERENCES warehouses(id) ON DELETE SET NULL,
  total_weight_kg   numeric(12,3),
  total_volume_cbm  numeric(12,6),                       -- Aggregate net volume
  total_gross_volume_cbm numeric(12,6),                  -- Aggregate gross volume (pallet footprint)
  total_pieces    integer,
  total_cartons   integer,
  estimated_total_cost_cents bigint,
  actual_total_cost_cents    bigint,
  allocation_method_default varchar(30),                  -- by_volume, by_chargeable_weight, by_weight
  notes           text,
  internal_notes  text,
  created_by      varchar(100) REFERENCES users(id) ON DELETE SET NULL,
  closed_by       varchar(100) REFERENCES users(id) ON DELETE SET NULL,
  closed_at       timestamp,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. inbound_shipment_lines (many-to-many: shipment <-> PO lines)
-- ============================================================
CREATE TABLE IF NOT EXISTS inbound_shipment_lines (
  id                    integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  inbound_shipment_id   integer NOT NULL REFERENCES inbound_shipments(id) ON DELETE CASCADE,
  purchase_order_id     integer REFERENCES purchase_orders(id) ON DELETE SET NULL,
  purchase_order_line_id integer REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  product_variant_id    integer REFERENCES product_variants(id) ON DELETE SET NULL,
  sku                   varchar(100),                    -- Cached
  qty_shipped           integer NOT NULL,
  -- Per-unit dimensions
  weight_kg             numeric(10,3),
  length_cm             numeric(8,2),
  width_cm              numeric(8,2),
  height_cm             numeric(8,2),
  -- Computed totals
  total_weight_kg       numeric(12,3),                   -- qty * unit weight
  total_volume_cbm      numeric(12,6),                   -- qty * L*W*H / 1,000,000 (net)
  chargeable_weight_kg  numeric(12,3),                   -- max(actual, volumetric) for air
  -- Gross volume
  gross_volume_cbm      numeric(12,6),                   -- Actual space consumed (pallet footprint)
  carton_count          integer,
  pallet_count          integer,
  -- Allocation results
  allocated_cost_cents  bigint,
  landed_unit_cost_cents integer,                        -- PO cost + allocated / qty
  notes                 text,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_inbound_shipment_lines_shipment ON inbound_shipment_lines(inbound_shipment_id);
CREATE INDEX idx_inbound_shipment_lines_po ON inbound_shipment_lines(purchase_order_id);
CREATE INDEX idx_inbound_shipment_lines_po_line ON inbound_shipment_lines(purchase_order_line_id);

-- ============================================================
-- 3. shipment_costs (itemized charges)
-- ============================================================
CREATE TABLE IF NOT EXISTS shipment_costs (
  id                    integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  inbound_shipment_id   integer NOT NULL REFERENCES inbound_shipments(id) ON DELETE CASCADE,
  cost_type             varchar(30) NOT NULL,             -- freight, duty, insurance, brokerage, port_handling, drayage, warehousing, inspection, other
  description           text,
  estimated_cents       bigint,
  actual_cents          bigint,
  currency              varchar(3) DEFAULT 'USD',
  exchange_rate         numeric(10,4) DEFAULT 1,
  allocation_method     varchar(30),                      -- Per-cost override: by_volume, by_chargeable_weight, by_weight, by_value, by_line_count
  cost_status           varchar(20) DEFAULT 'estimated',  -- estimated, invoiced, approved, paid
  invoice_number        varchar(100),
  invoice_date          timestamp,
  due_date              timestamp,
  paid_date             timestamp,
  vendor_name           text,                             -- Who we're paying (freight co, customs broker, etc.)
  notes                 text,
  created_at            timestamp NOT NULL DEFAULT now(),
  updated_at            timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_shipment_costs_shipment ON shipment_costs(inbound_shipment_id);

-- ============================================================
-- 4. shipment_cost_allocations (computed results per line per cost)
-- ============================================================
CREATE TABLE IF NOT EXISTS shipment_cost_allocations (
  id                        integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  shipment_cost_id          integer NOT NULL REFERENCES shipment_costs(id) ON DELETE CASCADE,
  inbound_shipment_line_id  integer NOT NULL REFERENCES inbound_shipment_lines(id) ON DELETE CASCADE,
  allocation_basis_value    numeric(14,6),                -- Line's share numerator
  allocation_basis_total    numeric(14,6),                -- Shipment's total denominator
  share_percent             numeric(8,4),
  allocated_cents           bigint,
  created_at                timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_shipment_cost_alloc_cost ON shipment_cost_allocations(shipment_cost_id);
CREATE INDEX idx_shipment_cost_alloc_line ON shipment_cost_allocations(inbound_shipment_line_id);

-- ============================================================
-- 5. landed_cost_snapshots (finalized per-line summary)
-- ============================================================
CREATE TABLE IF NOT EXISTS landed_cost_snapshots (
  id                        integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  inbound_shipment_line_id  integer REFERENCES inbound_shipment_lines(id) ON DELETE CASCADE,
  purchase_order_line_id    integer REFERENCES purchase_order_lines(id) ON DELETE SET NULL,
  product_variant_id        integer REFERENCES product_variants(id) ON DELETE SET NULL,
  po_unit_cost_cents        integer,
  freight_allocated_cents   bigint,
  duty_allocated_cents      bigint,
  insurance_allocated_cents bigint,
  other_allocated_cents     bigint,
  total_landed_cost_cents   bigint,
  landed_unit_cost_cents    integer,                      -- total / qty
  qty                       integer,
  finalized_at              timestamp,
  created_at                timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_landed_cost_snapshots_line ON landed_cost_snapshots(inbound_shipment_line_id);
CREATE INDEX idx_landed_cost_snapshots_variant ON landed_cost_snapshots(product_variant_id);

-- ============================================================
-- 6. inbound_shipment_status_history
-- ============================================================
CREATE TABLE IF NOT EXISTS inbound_shipment_status_history (
  id                    integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  inbound_shipment_id   integer NOT NULL REFERENCES inbound_shipments(id) ON DELETE CASCADE,
  from_status           varchar(20),
  to_status             varchar(20) NOT NULL,
  changed_by            varchar(100) REFERENCES users(id) ON DELETE SET NULL,
  changed_at            timestamp NOT NULL DEFAULT now(),
  notes                 text
);

CREATE INDEX idx_inbound_shipment_history ON inbound_shipment_status_history(inbound_shipment_id);

-- ============================================================
-- 7. Alter existing tables
-- ============================================================

-- vendor_products: add packaging dimensions
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS weight_kg numeric(10,3);
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS length_cm numeric(8,2);
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS width_cm numeric(8,2);
ALTER TABLE vendor_products ADD COLUMN IF NOT EXISTS height_cm numeric(8,2);

-- receiving_orders: link to inbound shipment
ALTER TABLE receiving_orders ADD COLUMN IF NOT EXISTS inbound_shipment_id integer REFERENCES inbound_shipments(id) ON DELETE SET NULL;

-- inventory_lots: link to inbound shipment + provisional flag
ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS inbound_shipment_id integer REFERENCES inbound_shipments(id) ON DELETE SET NULL;
ALTER TABLE inventory_lots ADD COLUMN IF NOT EXISTS cost_provisional integer NOT NULL DEFAULT 0;

COMMIT;
