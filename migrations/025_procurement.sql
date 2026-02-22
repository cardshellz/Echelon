-- Migration 025: Procurement System + Lot Tracking + Financial Reporting
-- Creates: vendor_products, po_approval_tiers, purchase_orders, purchase_order_lines,
--          po_status_history, po_revisions, po_receipts, inventory_lots,
--          order_item_costs, order_item_financials
-- Alters:  vendors, products, product_variants, receiving_orders, receiving_lines

BEGIN;

-- ═══════════════════════════════════════════════════════════════════
-- A. VENDOR ENHANCEMENTS
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS payment_terms_days integer DEFAULT 30,
  ADD COLUMN IF NOT EXISTS payment_terms_type varchar(20) DEFAULT 'net',
  ADD COLUMN IF NOT EXISTS currency varchar(3) DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS tax_id varchar(50),
  ADD COLUMN IF NOT EXISTS account_number varchar(50),
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS default_lead_time_days integer DEFAULT 120,
  ADD COLUMN IF NOT EXISTS minimum_order_cents integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS free_freight_threshold_cents integer,
  ADD COLUMN IF NOT EXISTS vendor_type varchar(20) DEFAULT 'distributor',
  ADD COLUMN IF NOT EXISTS ship_from_address text,
  ADD COLUMN IF NOT EXISTS country varchar(50) DEFAULT 'US',
  ADD COLUMN IF NOT EXISTS rating integer;

-- ═══════════════════════════════════════════════════════════════════
-- B. VENDOR PRODUCTS (product → vendor mapping)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vendor_products (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES vendors(id),
  product_id integer NOT NULL REFERENCES products(id),
  product_variant_id integer REFERENCES product_variants(id),
  vendor_sku varchar(100),
  vendor_product_name text,
  unit_cost_cents integer DEFAULT 0,
  pack_size integer DEFAULT 1,
  moq integer DEFAULT 1,
  lead_time_days integer,
  is_preferred integer DEFAULT 0,
  is_active integer DEFAULT 1,
  last_purchased_at timestamp,
  last_cost_cents integer,
  notes text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  UNIQUE(vendor_id, product_id, product_variant_id)
);

-- ═══════════════════════════════════════════════════════════════════
-- C. PO APPROVAL TIERS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS po_approval_tiers (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  tier_name text NOT NULL,
  threshold_cents integer NOT NULL,
  approver_role varchar(30) NOT NULL,
  sort_order integer DEFAULT 0,
  active integer DEFAULT 1,
  created_at timestamp DEFAULT now() NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════
-- D. PURCHASE ORDERS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS purchase_orders (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  po_number varchar(30) UNIQUE NOT NULL,
  vendor_id integer NOT NULL REFERENCES vendors(id),
  warehouse_id integer REFERENCES warehouses(id),
  ship_to_address text,
  ship_from_address text,
  status varchar(20) NOT NULL DEFAULT 'draft',
  po_type varchar(20) DEFAULT 'standard',
  priority varchar(10) DEFAULT 'normal',
  -- Dates
  order_date timestamp,
  expected_delivery_date timestamp,
  confirmed_delivery_date timestamp,
  cancel_date timestamp,
  actual_delivery_date timestamp,
  -- Financials
  currency varchar(3) DEFAULT 'USD',
  subtotal_cents bigint DEFAULT 0,
  discount_cents bigint DEFAULT 0,
  tax_cents bigint DEFAULT 0,
  shipping_cost_cents bigint DEFAULT 0,
  total_cents bigint DEFAULT 0,
  payment_terms_days integer,
  payment_terms_type varchar(20),
  -- Shipping
  shipping_method varchar(50),
  shipping_account_number varchar(50),
  incoterms varchar(10),
  freight_terms varchar(30),
  -- Vendor
  reference_number varchar(100),
  vendor_contact_name varchar(100),
  vendor_contact_email varchar(255),
  vendor_ack_date timestamp,
  vendor_ref_number varchar(100),
  -- Counts
  line_count integer DEFAULT 0,
  received_line_count integer DEFAULT 0,
  revision_number integer DEFAULT 0,
  -- Notes
  vendor_notes text,
  internal_notes text,
  -- Approval
  approval_tier_id integer REFERENCES po_approval_tiers(id),
  approved_by varchar(100),
  approved_at timestamp,
  approval_notes text,
  -- Lifecycle
  sent_to_vendor_at timestamp,
  cancelled_at timestamp,
  cancelled_by varchar(100),
  cancel_reason text,
  closed_at timestamp,
  closed_by varchar(100),
  created_by varchar(100),
  updated_by varchar(100),
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  metadata jsonb
);

-- ═══════════════════════════════════════════════════════════════════
-- E. PURCHASE ORDER LINES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_number integer NOT NULL,
  -- Product
  product_id integer NOT NULL REFERENCES products(id),
  product_variant_id integer NOT NULL REFERENCES product_variants(id),
  vendor_product_id integer REFERENCES vendor_products(id),
  sku varchar(100),
  product_name text,
  description text,
  vendor_sku varchar(100),
  -- Quantities
  unit_of_measure varchar(20),
  units_per_uom integer DEFAULT 1,
  order_qty integer NOT NULL,
  received_qty integer DEFAULT 0,
  damaged_qty integer DEFAULT 0,
  returned_qty integer DEFAULT 0,
  cancelled_qty integer DEFAULT 0,
  -- Cost
  unit_cost_cents integer NOT NULL DEFAULT 0,
  discount_percent numeric(5,2) DEFAULT 0,
  discount_cents integer DEFAULT 0,
  tax_rate_percent numeric(5,2) DEFAULT 0,
  tax_cents integer DEFAULT 0,
  line_total_cents bigint,
  -- Dates
  expected_delivery_date timestamp,
  promised_date timestamp,
  received_date timestamp,
  fully_received_date timestamp,
  last_received_at timestamp,
  -- Status
  status varchar(20) DEFAULT 'open',
  close_short_reason text,
  -- Meta
  weight_grams integer,
  notes text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════
-- F. PO STATUS HISTORY
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS po_status_history (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  from_status varchar(20),
  to_status varchar(20) NOT NULL,
  changed_by varchar(100),
  changed_at timestamp DEFAULT now() NOT NULL,
  notes text,
  revision_number integer
);

-- ═══════════════════════════════════════════════════════════════════
-- G. PO REVISIONS
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS po_revisions (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  revision_number integer,
  changed_by varchar(100),
  change_type varchar(20),
  field_changed varchar(50),
  old_value text,
  new_value text,
  line_id integer REFERENCES purchase_order_lines(id),
  notes text,
  created_at timestamp DEFAULT now() NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════
-- H. PO RECEIPTS (PO line → Receiving line link)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS po_receipts (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  purchase_order_id integer NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  purchase_order_line_id integer NOT NULL REFERENCES purchase_order_lines(id) ON DELETE CASCADE,
  receiving_order_id integer NOT NULL REFERENCES receiving_orders(id) ON DELETE CASCADE,
  receiving_line_id integer NOT NULL REFERENCES receiving_lines(id) ON DELETE CASCADE,
  qty_received integer NOT NULL DEFAULT 0,
  po_unit_cost_cents integer,
  actual_unit_cost_cents integer,
  variance_cents integer,
  created_at timestamp DEFAULT now() NOT NULL,
  UNIQUE(purchase_order_line_id, receiving_line_id)
);

-- ═══════════════════════════════════════════════════════════════════
-- I. INVENTORY LOTS (FIFO cost layers)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inventory_lots (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  lot_number varchar(50) NOT NULL,
  product_variant_id integer NOT NULL REFERENCES product_variants(id),
  warehouse_location_id integer NOT NULL REFERENCES warehouse_locations(id),
  receiving_order_id integer REFERENCES receiving_orders(id) ON DELETE SET NULL,
  purchase_order_id integer REFERENCES purchase_orders(id) ON DELETE SET NULL,
  unit_cost_cents integer NOT NULL DEFAULT 0,
  qty_on_hand integer NOT NULL DEFAULT 0,
  qty_reserved integer NOT NULL DEFAULT 0,
  qty_picked integer NOT NULL DEFAULT 0,
  received_at timestamp NOT NULL,
  expiry_date timestamp,
  status varchar(20) DEFAULT 'active',
  notes text,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_fifo
  ON inventory_lots (product_variant_id, warehouse_location_id, received_at)
  WHERE status = 'active';

-- ═══════════════════════════════════════════════════════════════════
-- J. ORDER ITEM COSTS (COGS per shipment)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_item_costs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id integer NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  inventory_lot_id integer NOT NULL REFERENCES inventory_lots(id),
  product_variant_id integer NOT NULL REFERENCES product_variants(id),
  qty integer NOT NULL,
  unit_cost_cents integer NOT NULL,
  total_cost_cents integer NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════
-- K. ORDER ITEM FINANCIALS (contribution profit)
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_item_financials (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id integer NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  product_id integer REFERENCES products(id) ON DELETE SET NULL,
  product_variant_id integer REFERENCES product_variants(id) ON DELETE SET NULL,
  sku varchar(100),
  product_name text,
  qty_shipped integer NOT NULL,
  revenue_cents bigint NOT NULL,
  cogs_cents bigint NOT NULL,
  gross_profit_cents bigint NOT NULL,
  margin_percent numeric(5,2),
  avg_selling_price_cents integer,
  avg_unit_cost_cents integer,
  vendor_id integer REFERENCES vendors(id) ON DELETE SET NULL,
  channel_id integer REFERENCES channels(id) ON DELETE SET NULL,
  shipped_at timestamp NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════
-- L. EXISTING TABLE ALTERATIONS
-- ═══════════════════════════════════════════════════════════════════

-- products: inventory_type
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS inventory_type varchar(20) NOT NULL DEFAULT 'inventory';

-- product_variants: cost fields
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS standard_cost_cents integer,
  ADD COLUMN IF NOT EXISTS last_cost_cents integer,
  ADD COLUMN IF NOT EXISTS avg_cost_cents integer;

-- receiving_orders: PO linkage
ALTER TABLE receiving_orders
  ADD COLUMN IF NOT EXISTS purchase_order_id integer REFERENCES purchase_orders(id) ON DELETE SET NULL;

-- receiving_lines: PO line linkage
ALTER TABLE receiving_lines
  ADD COLUMN IF NOT EXISTS purchase_order_line_id integer REFERENCES purchase_order_lines(id) ON DELETE SET NULL;

-- inventory_transactions: cost & lot tracking (IF NOT EXISTS check for idempotency)
ALTER TABLE inventory_transactions
  ADD COLUMN IF NOT EXISTS unit_cost_cents integer,
  ADD COLUMN IF NOT EXISTS inventory_lot_id integer;

-- order_items: pricing (may already exist from schema definition)
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS price_cents integer,
  ADD COLUMN IF NOT EXISTS discount_cents integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_price_cents integer;

COMMIT;
