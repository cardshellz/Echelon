-- Dropship V2 foundation.
-- Canonical design: DROPSHIP-V2-CONSOLIDATED-DESIGN.md
-- Build 1 covers data model, constraints, idempotency, and audit-ready storage only.

CREATE SCHEMA IF NOT EXISTS dropship;

DO $$
BEGIN
  IF to_regclass('dropship.dropship_vendors') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'dropship'
         AND table_name = 'dropship_vendors'
         AND column_name = 'member_id'
     ) THEN
    IF to_regclass('dropship.dropship_vendors_phase0_legacy') IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot create Dropship V2 vendors table because dropship.dropship_vendors_phase0_legacy already exists.';
    END IF;

    ALTER TABLE dropship.dropship_vendors
      RENAME TO dropship_vendors_phase0_legacy;
  END IF;

  IF to_regclass('dropship.dropship_wallet_ledger') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'dropship'
         AND table_name = 'dropship_wallet_ledger'
         AND column_name = 'wallet_account_id'
     ) THEN
    IF to_regclass('dropship.dropship_wallet_ledger_phase0_legacy') IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot create Dropship V2 wallet ledger table because dropship.dropship_wallet_ledger_phase0_legacy already exists.';
    END IF;

    ALTER TABLE dropship.dropship_wallet_ledger
      RENAME TO dropship_wallet_ledger_phase0_legacy;
  END IF;

  IF to_regclass('dropship.dropship_vendor_products') IS NOT NULL THEN
    IF to_regclass('dropship.dropship_vendor_products_phase0_legacy') IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot archive Phase 0 vendor products because dropship.dropship_vendor_products_phase0_legacy already exists.';
    END IF;

    ALTER TABLE dropship.dropship_vendor_products
      RENAME TO dropship_vendor_products_phase0_legacy;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dropship.dropship_vendors (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  member_id varchar(255) NOT NULL REFERENCES membership.members(id),
  current_subscription_id varchar(255) REFERENCES membership.member_subscriptions(id),
  current_plan_id varchar(255) REFERENCES membership.plans(id),
  business_name varchar(200),
  contact_name varchar(200),
  email varchar(255),
  phone varchar(50),
  status varchar(30) NOT NULL DEFAULT 'onboarding',
  entitlement_status varchar(30) NOT NULL DEFAULT 'unknown',
  entitlement_checked_at timestamptz,
  membership_grace_ends_at timestamptz,
  included_store_connections integer NOT NULL DEFAULT 1,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_vendors_status_chk CHECK (status IN ('onboarding','active','paused','lapsed','suspended','closed')),
  CONSTRAINT dropship_vendors_store_count_chk CHECK (included_store_connections >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_vendors_member_idx
  ON dropship.dropship_vendors(member_id);
CREATE INDEX IF NOT EXISTS dropship_vendors_status_idx
  ON dropship.dropship_vendors(status);

CREATE TABLE IF NOT EXISTS dropship.dropship_store_connections (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  platform varchar(30) NOT NULL,
  external_account_id varchar(255),
  external_display_name varchar(255),
  shop_domain varchar(255),
  access_token_ref text,
  refresh_token_ref text,
  token_expires_at timestamptz,
  status varchar(30) NOT NULL DEFAULT 'disconnected',
  setup_status varchar(30) NOT NULL DEFAULT 'pending',
  disconnect_reason text,
  disconnected_at timestamptz,
  grace_ends_at timestamptz,
  last_sync_at timestamptz,
  last_order_sync_at timestamptz,
  last_inventory_sync_at timestamptz,
  config jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_store_conn_platform_chk CHECK (platform IN ('ebay','shopify','tiktok','instagram','bigcommerce')),
  CONSTRAINT dropship_store_conn_status_chk CHECK (status IN ('connected','needs_reauth','refresh_failed','grace_period','paused','disconnected'))
);

CREATE INDEX IF NOT EXISTS dropship_store_conn_vendor_idx
  ON dropship.dropship_store_connections(vendor_id);
CREATE INDEX IF NOT EXISTS dropship_store_conn_platform_idx
  ON dropship.dropship_store_connections(platform);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_store_conn_active_vendor_idx
  ON dropship.dropship_store_connections(vendor_id)
  WHERE status IN ('connected','needs_reauth','refresh_failed','grace_period','paused');

CREATE TABLE IF NOT EXISTS dropship.dropship_store_setup_checks (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  check_key varchar(100) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  severity varchar(20) NOT NULL DEFAULT 'blocker',
  message text,
  details jsonb,
  last_checked_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_setup_check_store_key_idx
  ON dropship.dropship_store_setup_checks(store_connection_id, check_key)
  WHERE store_connection_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dropship_setup_check_vendor_key_idx
  ON dropship.dropship_store_setup_checks(vendor_id, check_key)
  WHERE store_connection_id IS NULL;
CREATE INDEX IF NOT EXISTS dropship_setup_check_status_idx
  ON dropship.dropship_store_setup_checks(status);

CREATE TABLE IF NOT EXISTS dropship.dropship_setup_blockers (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  entity_type varchar(80) NOT NULL,
  entity_id varchar(255),
  blocker_key varchar(120) NOT NULL,
  severity varchar(20) NOT NULL DEFAULT 'blocker',
  status varchar(30) NOT NULL DEFAULT 'open',
  message text NOT NULL,
  details jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_setup_blocker_status_chk CHECK (status IN ('open','acknowledged','resolved'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_setup_blocker_entity_key_idx
  ON dropship.dropship_setup_blockers(vendor_id, entity_type, entity_id, blocker_key)
  WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS dropship_setup_blocker_status_idx
  ON dropship.dropship_setup_blockers(status);

CREATE TABLE IF NOT EXISTS dropship.dropship_catalog_rules (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  scope_type varchar(30) NOT NULL,
  action varchar(20) NOT NULL DEFAULT 'include',
  product_line_id integer REFERENCES catalog.product_lines(id),
  product_id integer REFERENCES catalog.products(id),
  product_variant_id integer REFERENCES catalog.product_variants(id),
  category varchar(200),
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  notes text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_catalog_rules_scope_chk CHECK (scope_type IN ('catalog','product_line','category','product','variant')),
  CONSTRAINT dropship_catalog_rules_action_chk CHECK (action IN ('include','exclude')),
  CONSTRAINT dropship_catalog_rules_target_chk CHECK (
    (scope_type = 'catalog' AND product_line_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'product_line' AND product_line_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'category' AND category IS NOT NULL AND product_line_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL)
    OR (scope_type = 'product' AND product_id IS NOT NULL AND product_line_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'variant' AND product_variant_id IS NOT NULL AND product_line_id IS NULL AND product_id IS NULL AND category IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dropship_catalog_rules_scope_idx
  ON dropship.dropship_catalog_rules(scope_type, is_active);

CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_selection_rules (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  scope_type varchar(30) NOT NULL,
  action varchar(20) NOT NULL DEFAULT 'include',
  product_line_id integer REFERENCES catalog.product_lines(id),
  product_id integer REFERENCES catalog.products(id),
  product_variant_id integer REFERENCES catalog.product_variants(id),
  category varchar(200),
  auto_connect_new_skus boolean NOT NULL DEFAULT true,
  auto_list_new_skus boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_selection_rules_scope_chk CHECK (scope_type IN ('catalog','product_line','category','product','variant')),
  CONSTRAINT dropship_selection_rules_action_chk CHECK (action IN ('include','exclude')),
  CONSTRAINT dropship_selection_rules_target_chk CHECK (
    (scope_type = 'catalog' AND product_line_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'product_line' AND product_line_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'category' AND category IS NOT NULL AND product_line_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL)
    OR (scope_type = 'product' AND product_id IS NOT NULL AND product_line_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'variant' AND product_variant_id IS NOT NULL AND product_line_id IS NULL AND product_id IS NULL AND category IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dropship_selection_rules_vendor_idx
  ON dropship.dropship_vendor_selection_rules(vendor_id, is_active);

CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_variant_overrides (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  enabled_override boolean,
  marketplace_quantity_cap integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_variant_override_cap_chk CHECK (marketplace_quantity_cap IS NULL OR marketplace_quantity_cap >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_variant_override_vendor_variant_idx
  ON dropship.dropship_vendor_variant_overrides(vendor_id, product_variant_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_pricing_policies (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  scope_type varchar(30) NOT NULL DEFAULT 'catalog',
  product_line_id integer REFERENCES catalog.product_lines(id),
  product_id integer REFERENCES catalog.products(id),
  product_variant_id integer REFERENCES catalog.product_variants(id),
  category varchar(200),
  mode varchar(40) NOT NULL DEFAULT 'warn_only',
  floor_price_cents bigint,
  ceiling_price_cents bigint,
  warning_margin_bps integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_pricing_policies_scope_chk CHECK (scope_type IN ('catalog','product_line','category','product','variant')),
  CONSTRAINT dropship_pricing_policies_mode_chk CHECK (mode IN ('off','warn_only','block_listing_push','block_order_acceptance')),
  CONSTRAINT dropship_pricing_policies_floor_chk CHECK (floor_price_cents IS NULL OR floor_price_cents >= 0),
  CONSTRAINT dropship_pricing_policies_ceiling_chk CHECK (ceiling_price_cents IS NULL OR ceiling_price_cents >= 0),
  CONSTRAINT dropship_pricing_policies_target_chk CHECK (
    (scope_type = 'catalog' AND product_line_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'product_line' AND product_line_id IS NOT NULL AND product_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'category' AND category IS NOT NULL AND product_line_id IS NULL AND product_id IS NULL AND product_variant_id IS NULL)
    OR (scope_type = 'product' AND product_id IS NOT NULL AND product_line_id IS NULL AND product_variant_id IS NULL AND category IS NULL)
    OR (scope_type = 'variant' AND product_variant_id IS NOT NULL AND product_line_id IS NULL AND product_id IS NULL AND category IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dropship_pricing_policies_scope_idx
  ON dropship.dropship_pricing_policies(scope_type, is_active);

CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_listings (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  platform varchar(30) NOT NULL,
  external_listing_id varchar(255),
  external_offer_id varchar(255),
  status varchar(40) NOT NULL DEFAULT 'not_listed',
  vendor_retail_price_cents bigint,
  observed_marketplace_price_cents bigint,
  pushed_quantity integer NOT NULL DEFAULT 0,
  quantity_cap integer,
  last_preview_hash varchar(128),
  drift_detected_at timestamptz,
  last_pushed_at timestamptz,
  last_marketplace_sync_at timestamptz,
  paused_reason text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_listing_platform_chk CHECK (platform IN ('ebay','shopify','tiktok','instagram','bigcommerce')),
  CONSTRAINT dropship_listing_status_chk CHECK (status IN ('not_listed','preview_ready','queued','pushing','active','paused','ended','failed','blocked','drift_detected')),
  CONSTRAINT dropship_listing_price_chk CHECK (vendor_retail_price_cents IS NULL OR vendor_retail_price_cents >= 0),
  CONSTRAINT dropship_listing_qty_chk CHECK (pushed_quantity >= 0 AND (quantity_cap IS NULL OR quantity_cap >= 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_store_variant_idx
  ON dropship.dropship_vendor_listings(store_connection_id, product_variant_id);
CREATE INDEX IF NOT EXISTS dropship_listing_vendor_status_idx
  ON dropship.dropship_vendor_listings(vendor_id, status);

CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_jobs (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  job_type varchar(40) NOT NULL DEFAULT 'push',
  status varchar(30) NOT NULL DEFAULT 'queued',
  requested_scope jsonb,
  requested_by varchar(255),
  idempotency_key varchar(200),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT dropship_listing_job_status_chk CHECK (status IN ('queued','processing','completed','failed','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_job_idem_idx
  ON dropship.dropship_listing_push_jobs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS dropship_listing_job_status_idx
  ON dropship.dropship_listing_push_jobs(status);

CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_job_items (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  job_id integer NOT NULL REFERENCES dropship.dropship_listing_push_jobs(id) ON DELETE CASCADE,
  listing_id integer REFERENCES dropship.dropship_vendor_listings(id) ON DELETE SET NULL,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id),
  action varchar(40) NOT NULL DEFAULT 'push',
  status varchar(30) NOT NULL DEFAULT 'queued',
  preview_hash varchar(128),
  external_listing_id varchar(255),
  error_code varchar(100),
  error_message text,
  result jsonb,
  idempotency_key varchar(200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_listing_job_item_status_chk CHECK (status IN ('queued','processing','completed','failed','blocked','cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_job_item_job_variant_idx
  ON dropship.dropship_listing_push_job_items(job_id, product_variant_id);
CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_job_item_idem_idx
  ON dropship.dropship_listing_push_job_items(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS dropship_listing_job_item_status_idx
  ON dropship.dropship_listing_push_job_items(status);

CREATE TABLE IF NOT EXISTS dropship.dropship_listing_sync_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id) ON DELETE CASCADE,
  event_type varchar(80) NOT NULL,
  source varchar(40) NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dropship_listing_sync_listing_idx
  ON dropship.dropship_listing_sync_events(listing_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_accounts (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  available_balance_cents bigint NOT NULL DEFAULT 0,
  pending_balance_cents bigint NOT NULL DEFAULT 0,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  status varchar(30) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_wallet_available_chk CHECK (available_balance_cents >= 0),
  CONSTRAINT dropship_wallet_pending_chk CHECK (pending_balance_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_vendor_idx
  ON dropship.dropship_wallet_accounts(vendor_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_funding_methods (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  rail varchar(40) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'active',
  provider_customer_id varchar(255),
  provider_payment_method_id varchar(255),
  usdc_wallet_address varchar(128),
  display_label varchar(200),
  is_default boolean NOT NULL DEFAULT false,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_funding_rail_chk CHECK (rail IN ('stripe_ach','stripe_card','usdc_base','manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_funding_default_vendor_idx
  ON dropship.dropship_funding_methods(vendor_id)
  WHERE is_default = true AND status = 'active';
CREATE INDEX IF NOT EXISTS dropship_funding_vendor_idx
  ON dropship.dropship_funding_methods(vendor_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_auto_reload_settings (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  funding_method_id integer REFERENCES dropship.dropship_funding_methods(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  minimum_balance_cents bigint NOT NULL DEFAULT 5000,
  max_single_reload_cents bigint,
  payment_hold_timeout_minutes integer NOT NULL DEFAULT 2880,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_auto_reload_min_chk CHECK (minimum_balance_cents >= 0),
  CONSTRAINT dropship_auto_reload_max_chk CHECK (max_single_reload_cents IS NULL OR max_single_reload_cents >= 0),
  CONSTRAINT dropship_auto_reload_timeout_chk CHECK (payment_hold_timeout_minutes > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_auto_reload_vendor_idx
  ON dropship.dropship_auto_reload_settings(vendor_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_wallet_ledger (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  wallet_account_id integer REFERENCES dropship.dropship_wallet_accounts(id) ON DELETE CASCADE,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  type varchar(40) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  amount_cents bigint NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  available_balance_after_cents bigint,
  pending_balance_after_cents bigint,
  reference_type varchar(80),
  reference_id varchar(255),
  idempotency_key varchar(200),
  funding_method_id integer REFERENCES dropship.dropship_funding_methods(id) ON DELETE SET NULL,
  external_transaction_id varchar(255),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT dropship_wallet_ledger_type_chk CHECK (type IN ('funding','order_debit','refund_credit','return_credit','return_fee','insurance_pool_credit','manual_adjustment')),
  CONSTRAINT dropship_wallet_ledger_status_chk CHECK (status IN ('pending','settled','failed','voided')),
  CONSTRAINT dropship_wallet_ledger_amount_chk CHECK (amount_cents <> 0),
  CONSTRAINT dropship_wallet_ledger_reference_chk CHECK (
    (reference_type IS NULL AND reference_id IS NULL)
    OR (reference_type IS NOT NULL AND reference_id IS NOT NULL)
  ),
  CONSTRAINT dropship_wallet_ledger_balance_chk CHECK (
    (available_balance_after_cents IS NULL OR available_balance_after_cents >= 0)
    AND (pending_balance_after_cents IS NULL OR pending_balance_after_cents >= 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_ref_idx
  ON dropship.dropship_wallet_ledger(reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dropship_wallet_idem_idx
  ON dropship.dropship_wallet_ledger(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS dropship_wallet_ledger_vendor_idx
  ON dropship.dropship_wallet_ledger(vendor_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_box_catalog (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code varchar(80) NOT NULL,
  name varchar(200) NOT NULL,
  length_mm integer NOT NULL,
  width_mm integer NOT NULL,
  height_mm integer NOT NULL,
  tare_weight_grams integer NOT NULL DEFAULT 0,
  max_weight_grams integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_box_dims_chk CHECK (length_mm > 0 AND width_mm > 0 AND height_mm > 0 AND tare_weight_grams >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_box_code_idx
  ON dropship.dropship_box_catalog(code);

CREATE TABLE IF NOT EXISTS dropship.dropship_package_profiles (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
  weight_grams integer NOT NULL,
  length_mm integer NOT NULL,
  width_mm integer NOT NULL,
  height_mm integer NOT NULL,
  ship_alone boolean NOT NULL DEFAULT false,
  default_carrier varchar(50),
  default_service varchar(80),
  default_box_id integer REFERENCES dropship.dropship_box_catalog(id) ON DELETE SET NULL,
  max_units_per_package integer,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_package_profile_dims_chk CHECK (weight_grams > 0 AND length_mm > 0 AND width_mm > 0 AND height_mm > 0),
  CONSTRAINT dropship_package_profile_units_chk CHECK (max_units_per_package IS NULL OR max_units_per_package > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_package_profile_variant_idx
  ON dropship.dropship_package_profiles(product_variant_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_rate_tables (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  carrier varchar(50) NOT NULL,
  service varchar(80) NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'USD',
  status varchar(30) NOT NULL DEFAULT 'active',
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dropship_rate_table_carrier_service_idx
  ON dropship.dropship_rate_tables(carrier, service, status);

CREATE TABLE IF NOT EXISTS dropship.dropship_rate_table_rows (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  rate_table_id integer NOT NULL REFERENCES dropship.dropship_rate_tables(id) ON DELETE CASCADE,
  warehouse_id integer REFERENCES warehouse.warehouses(id) ON DELETE SET NULL,
  destination_zone varchar(40) NOT NULL,
  min_weight_grams integer NOT NULL DEFAULT 0,
  max_weight_grams integer NOT NULL,
  rate_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_rate_row_weight_chk CHECK (min_weight_grams >= 0 AND max_weight_grams >= min_weight_grams),
  CONSTRAINT dropship_rate_row_rate_chk CHECK (rate_cents >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rate_row_band_idx
  ON dropship.dropship_rate_table_rows(rate_table_id, warehouse_id, destination_zone, min_weight_grams, max_weight_grams);

CREATE TABLE IF NOT EXISTS dropship.dropship_zone_rules (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  origin_warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id) ON DELETE CASCADE,
  destination_country varchar(2) NOT NULL DEFAULT 'US',
  destination_region varchar(100),
  postal_prefix varchar(20),
  zone varchar(40) NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dropship_zone_rules_lookup_idx
  ON dropship.dropship_zone_rules(origin_warehouse_id, destination_country, postal_prefix, is_active);

CREATE TABLE IF NOT EXISTS dropship.dropship_insurance_pool_config (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name varchar(120) NOT NULL,
  fee_bps integer NOT NULL DEFAULT 200,
  min_fee_cents bigint,
  max_fee_cents bigint,
  is_active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_insurance_bps_chk CHECK (fee_bps >= 0 AND fee_bps <= 10000),
  CONSTRAINT dropship_insurance_fee_bounds_chk CHECK (
    (min_fee_cents IS NULL OR min_fee_cents >= 0)
    AND (max_fee_cents IS NULL OR max_fee_cents >= 0)
    AND (min_fee_cents IS NULL OR max_fee_cents IS NULL OR max_fee_cents >= min_fee_cents)
  )
);

CREATE TABLE IF NOT EXISTS dropship.dropship_shipping_quote_snapshots (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
  warehouse_id integer NOT NULL REFERENCES warehouse.warehouses(id),
  rate_table_id integer REFERENCES dropship.dropship_rate_tables(id),
  destination_country varchar(2) NOT NULL DEFAULT 'US',
  destination_postal_code varchar(20),
  package_count integer NOT NULL,
  base_rate_cents bigint NOT NULL,
  markup_cents bigint NOT NULL DEFAULT 0,
  insurance_pool_cents bigint NOT NULL DEFAULT 0,
  dunnage_cents bigint NOT NULL DEFAULT 0,
  total_shipping_cents bigint NOT NULL,
  quote_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_shipping_quote_total_chk CHECK (
    package_count > 0
    AND base_rate_cents >= 0
    AND markup_cents >= 0
    AND insurance_pool_cents >= 0
    AND dunnage_cents >= 0
    AND total_shipping_cents >= 0
  )
);

CREATE INDEX IF NOT EXISTS dropship_shipping_quote_vendor_idx
  ON dropship.dropship_shipping_quote_snapshots(vendor_id, created_at);

CREATE TABLE IF NOT EXISTS dropship.dropship_order_intake (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  channel_id integer NOT NULL REFERENCES channels.channels(id),
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  platform varchar(30) NOT NULL,
  external_order_id varchar(255) NOT NULL,
  external_order_number varchar(100),
  source_order_id varchar(255),
  status varchar(40) NOT NULL DEFAULT 'received',
  payment_hold_expires_at timestamptz,
  rejection_reason text,
  cancellation_status varchar(40),
  raw_payload jsonb,
  normalized_payload jsonb,
  payload_hash varchar(128),
  oms_order_id bigint REFERENCES oms.oms_orders(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_order_intake_platform_chk CHECK (platform IN ('ebay','shopify','tiktok','instagram','bigcommerce')),
  CONSTRAINT dropship_order_intake_status_chk CHECK (status IN ('received','processing','accepted','rejected','retrying','failed','payment_hold','cancelled','exception'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_order_intake_store_external_idx
  ON dropship.dropship_order_intake(store_connection_id, external_order_id);
CREATE INDEX IF NOT EXISTS dropship_order_intake_status_idx
  ON dropship.dropship_order_intake(status);
CREATE INDEX IF NOT EXISTS dropship_order_intake_vendor_idx
  ON dropship.dropship_order_intake(vendor_id, received_at);

CREATE TABLE IF NOT EXISTS dropship.dropship_order_economics_snapshots (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  intake_id integer NOT NULL REFERENCES dropship.dropship_order_intake(id) ON DELETE CASCADE,
  oms_order_id bigint REFERENCES oms.oms_orders(id) ON DELETE SET NULL,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  member_id varchar(255) NOT NULL,
  membership_plan_id varchar(255),
  shipping_quote_snapshot_id integer REFERENCES dropship.dropship_shipping_quote_snapshots(id) ON DELETE SET NULL,
  warehouse_id integer REFERENCES warehouse.warehouses(id),
  currency varchar(3) NOT NULL DEFAULT 'USD',
  retail_subtotal_cents bigint NOT NULL,
  wholesale_subtotal_cents bigint NOT NULL,
  shipping_cents bigint NOT NULL,
  insurance_pool_cents bigint NOT NULL DEFAULT 0,
  fees_cents bigint NOT NULL DEFAULT 0,
  total_debit_cents bigint NOT NULL,
  pricing_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_order_econ_nonnegative_chk CHECK (
    retail_subtotal_cents >= 0
    AND wholesale_subtotal_cents >= 0
    AND shipping_cents >= 0
    AND total_debit_cents >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_order_econ_intake_idx
  ON dropship.dropship_order_economics_snapshots(intake_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_rmas (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  rma_number varchar(80) NOT NULL,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
  intake_id integer REFERENCES dropship.dropship_order_intake(id) ON DELETE SET NULL,
  oms_order_id bigint REFERENCES oms.oms_orders(id) ON DELETE SET NULL,
  status varchar(40) NOT NULL DEFAULT 'requested',
  reason_code varchar(80),
  fault_category varchar(40),
  return_window_days integer NOT NULL DEFAULT 30,
  label_source varchar(40),
  return_tracking_number varchar(120),
  vendor_notes text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz,
  inspected_at timestamptz,
  credited_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_rma_status_chk CHECK (status IN ('requested','in_transit','received','inspecting','approved','rejected','credited','closed')),
  CONSTRAINT dropship_rma_window_chk CHECK (return_window_days > 0),
  CONSTRAINT dropship_rma_fault_chk CHECK (fault_category IS NULL OR fault_category IN ('card_shellz','vendor','customer','marketplace','carrier'))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rma_number_idx
  ON dropship.dropship_rmas(rma_number);
CREATE INDEX IF NOT EXISTS dropship_rma_vendor_status_idx
  ON dropship.dropship_rmas(vendor_id, status);

CREATE TABLE IF NOT EXISTS dropship.dropship_rma_items (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  rma_id integer NOT NULL REFERENCES dropship.dropship_rmas(id) ON DELETE CASCADE,
  product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE SET NULL,
  quantity integer NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'requested',
  requested_credit_cents bigint,
  final_credit_cents bigint,
  fee_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_rma_item_qty_chk CHECK (quantity > 0),
  CONSTRAINT dropship_rma_item_money_chk CHECK (
    (requested_credit_cents IS NULL OR requested_credit_cents >= 0)
    AND (final_credit_cents IS NULL OR final_credit_cents >= 0)
    AND (fee_cents IS NULL OR fee_cents >= 0)
  )
);

CREATE TABLE IF NOT EXISTS dropship.dropship_rma_inspections (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  rma_id integer NOT NULL REFERENCES dropship.dropship_rmas(id) ON DELETE CASCADE,
  outcome varchar(40) NOT NULL,
  fault_category varchar(40),
  notes text,
  photos jsonb,
  credit_cents bigint NOT NULL DEFAULT 0,
  fee_cents bigint NOT NULL DEFAULT 0,
  inspected_by varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_rma_inspection_fault_chk CHECK (fault_category IS NULL OR fault_category IN ('card_shellz','vendor','customer','marketplace','carrier')),
  CONSTRAINT dropship_rma_inspection_money_chk CHECK (credit_cents >= 0 AND fee_cents >= 0)
);

CREATE INDEX IF NOT EXISTS dropship_rma_inspection_rma_idx
  ON dropship.dropship_rma_inspections(rma_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_carrier_claims (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  rma_id integer REFERENCES dropship.dropship_rmas(id) ON DELETE SET NULL,
  intake_id integer REFERENCES dropship.dropship_order_intake(id) ON DELETE SET NULL,
  carrier varchar(80),
  tracking_number varchar(120),
  status varchar(40) NOT NULL DEFAULT 'pending',
  external_claim_id varchar(255),
  claim_amount_cents bigint,
  insurance_pool_credit_cents bigint,
  filed_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_carrier_claim_money_chk CHECK (
    (claim_amount_cents IS NULL OR claim_amount_cents >= 0)
    AND (insurance_pool_credit_cents IS NULL OR insurance_pool_credit_cents >= 0)
  )
);

CREATE INDEX IF NOT EXISTS dropship_carrier_claim_status_idx
  ON dropship.dropship_carrier_claims(status);

CREATE TABLE IF NOT EXISTS dropship.dropship_notification_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  event_type varchar(100) NOT NULL,
  channel varchar(30) NOT NULL,
  critical boolean NOT NULL DEFAULT false,
  title varchar(300) NOT NULL,
  message text,
  payload jsonb,
  status varchar(30) NOT NULL DEFAULT 'pending',
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_notification_channel_chk CHECK (channel IN ('email','in_app','sms','webhook'))
);

CREATE INDEX IF NOT EXISTS dropship_notification_vendor_idx
  ON dropship.dropship_notification_events(vendor_id, created_at);

CREATE TABLE IF NOT EXISTS dropship.dropship_notification_preferences (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  event_type varchar(100) NOT NULL,
  critical boolean NOT NULL DEFAULT false,
  email_enabled boolean NOT NULL DEFAULT true,
  in_app_enabled boolean NOT NULL DEFAULT true,
  sms_enabled boolean NOT NULL DEFAULT false,
  webhook_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_notification_pref_critical_chk CHECK (critical = false OR (email_enabled = true AND in_app_enabled = true))
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_notification_pref_vendor_event_idx
  ON dropship.dropship_notification_preferences(vendor_id, event_type);

CREATE TABLE IF NOT EXISTS dropship.dropship_audit_events (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE SET NULL,
  store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
  entity_type varchar(80) NOT NULL,
  entity_id varchar(255),
  event_type varchar(120) NOT NULL,
  actor_type varchar(40) NOT NULL DEFAULT 'system',
  actor_id varchar(255),
  severity varchar(20) NOT NULL DEFAULT 'info',
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dropship_audit_vendor_created_idx
  ON dropship.dropship_audit_events(vendor_id, created_at);
CREATE INDEX IF NOT EXISTS dropship_audit_entity_idx
  ON dropship.dropship_audit_events(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS dropship.dropship_usdc_ledger_entries (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  wallet_ledger_id integer REFERENCES dropship.dropship_wallet_ledger(id) ON DELETE SET NULL,
  chain_id integer NOT NULL DEFAULT 8453,
  transaction_hash varchar(100) NOT NULL,
  from_address varchar(128),
  to_address varchar(128),
  amount_atomic_units numeric(78,0) NOT NULL,
  confirmations integer NOT NULL DEFAULT 0,
  status varchar(30) NOT NULL DEFAULT 'pending',
  observed_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT dropship_usdc_amount_chk CHECK (amount_atomic_units > 0),
  CONSTRAINT dropship_usdc_confirmations_chk CHECK (confirmations >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS dropship_usdc_tx_idx
  ON dropship.dropship_usdc_ledger_entries(chain_id, transaction_hash);
