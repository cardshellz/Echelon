-- Migration 063: Dropship Phase 1 Data Model

-- We retain the dropship.dropship_vendors table and add the new fields.
-- In case it doesn't exist, we just create it as it should be.
DO $$ 
BEGIN 
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'dropship' AND table_name = 'dropship_vendors') THEN
    -- Add new wallet balances columns
    ALTER TABLE dropship.dropship_vendors ADD COLUMN IF NOT EXISTS available_balance_cents bigint NOT NULL DEFAULT 0;
    ALTER TABLE dropship.dropship_vendors ADD COLUMN IF NOT EXISTS pending_balance_cents bigint NOT NULL DEFAULT 0;
    
    -- Drop old wallet_balance_cents column
    ALTER TABLE dropship.dropship_vendors DROP COLUMN IF EXISTS wallet_balance_cents;
  ELSE
    CREATE TABLE dropship.dropship_vendors (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      name varchar(200) NOT NULL,
      email varchar(200) NOT NULL UNIQUE,
      company_name varchar(200),
      phone varchar(50),
      shellz_club_member_id varchar(255),
      status varchar(20) NOT NULL DEFAULT 'pending',
      tier varchar(20) DEFAULT 'standard',
      stripe_customer_id varchar(100),
      available_balance_cents bigint NOT NULL DEFAULT 0,
      pending_balance_cents bigint NOT NULL DEFAULT 0,
      auto_reload_enabled boolean DEFAULT false,
      auto_reload_threshold_cents bigint DEFAULT 5000,
      auto_reload_amount_cents bigint DEFAULT 20000,
      usdc_wallet_address varchar(100),
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_dv_status ON dropship.dropship_vendors(status);
  END IF;
END $$;

-- Drop old dropship_vendor_channels if it exists (recreated below as dropship_store_connections)
DROP TABLE IF EXISTS dropship.dropship_vendor_channels CASCADE;
-- Drop old dropship_vendor_products if it exists (recreated below as dropship_vendor_product_selections)
DROP TABLE IF EXISTS dropship.dropship_vendor_products CASCADE;
-- Dropship dropship_wallet_ledger is recreated to match new constraints
DROP TABLE IF EXISTS dropship.dropship_wallet_ledger CASCADE;

-- 1. Store Connections
CREATE TABLE IF NOT EXISTS dropship.dropship_store_connections (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  source_platform varchar(50) NOT NULL,
  source_account_id varchar(255),
  access_token text,
  refresh_token text,
  token_expires_at timestamp,
  status varchar(50) NOT NULL DEFAULT 'connected',
  config text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- 2. Product Selections
CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_product_selections (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dvps_vendor_product ON dropship.dropship_vendor_product_selections(vendor_id, product_id);

-- 3. Variant Overrides
CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_variant_overrides (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  enabled_override boolean,
  price_override_type varchar(50),
  price_override_value integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dvvo_vendor_variant ON dropship.dropship_vendor_variant_overrides(vendor_id, product_variant_id);

-- 4. Pricing Rules
CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_pricing_rules (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  scope varchar(50) NOT NULL,
  scope_id integer,
  rule_type varchar(50) NOT NULL,
  value integer NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT chk_dvpr_fixed_only_variant CHECK (
    rule_type != 'fixed' OR scope = 'variant'
  )
);

-- 5. Vendor Listings
CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_listings (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  external_listing_id text,
  external_offer_id text,
  pushed_price_cents integer,
  pushed_qty integer,
  status varchar(50) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dvl_connection_variant ON dropship.dropship_vendor_listings(vendor_store_connection_id, product_variant_id);

-- 6. Listing Push Jobs
CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_jobs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  vendor_store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  status varchar(50) NOT NULL DEFAULT 'pending',
  requested_scope text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- 7. Listing Push Job Items
CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_job_items (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  job_id integer NOT NULL REFERENCES dropship.dropship_listing_push_jobs(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  status varchar(50) NOT NULL DEFAULT 'pending',
  result text,
  idempotency_key varchar(255) NOT NULL UNIQUE,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- 8. Wallet Ledger
CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_ledger (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  type varchar(30) NOT NULL,
  amount_cents bigint NOT NULL,
  balance_after_cents bigint NOT NULL,
  status varchar(50) NOT NULL DEFAULT 'pending',
  reference_type varchar(50),
  reference_id varchar(200),
  payment_method varchar(30),
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dwl_vendor_id ON dropship.dropship_wallet_ledger(vendor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dwl_ref_type_id ON dropship.dropship_wallet_ledger(reference_type, reference_id) WHERE reference_id IS NOT NULL;

-- 9. Order Intake
CREATE TABLE IF NOT EXISTS dropship.dropship_order_intake (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  external_order_id varchar(255) NOT NULL,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  source_platform varchar(50) NOT NULL,
  source_account_id varchar(255),
  source_order_id varchar(255),
  status varchar(50) NOT NULL DEFAULT 'received',
  reason_code text,
  oms_order_id integer REFERENCES wms.orders(id) ON DELETE SET NULL,
  payload_hash text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_doi_channel_external ON dropship.dropship_order_intake(channel_id, external_order_id);

-- 10. Store Setup Checks
CREATE TABLE IF NOT EXISTS dropship.dropship_store_setup_checks (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  check_key varchar(100) NOT NULL,
  status varchar(50) NOT NULL,
  message text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dssc_connection_key ON dropship.dropship_store_setup_checks(vendor_store_connection_id, check_key);

-- 11. Audit Events
CREATE TABLE IF NOT EXISTS dropship.dropship_audit_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE SET NULL,
  vendor_store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
  event_type varchar(100) NOT NULL,
  details text,
  created_at timestamp NOT NULL DEFAULT now()
);
