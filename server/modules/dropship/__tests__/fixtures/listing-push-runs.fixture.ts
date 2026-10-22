import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The publish runs migration (step 1 plan S2-5, PR A, §4.1), found by its
 * name, never by its number: the number is allocated under a stand-in PR
 * and changes when the file is adopted under the real one
 * (docs/migration-allocation.md, "Adopting an unmerged migration"). Exactly
 * one file may carry the name.
 */
export const LISTING_PUSH_RUNS_MIGRATION_SUFFIX = "_dropship_listing_push_runs.sql";

export const LISTING_PUSH_RUNS_MIGRATION_FILE: string = (() => {
  const matches = readdirSync(resolve(process.cwd(), "migrations"))
    .filter((file) => file.endsWith(LISTING_PUSH_RUNS_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one migration ending in ${LISTING_PUSH_RUNS_MIGRATION_SUFFIX}; found ${matches.length}.`);
  }
  return matches[0];
})();

export function listingPushRunsMigrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", LISTING_PUSH_RUNS_MIGRATION_FILE), "utf8");
}

/**
 * The tables the migration and the run, sweep, preview-queue and worker code
 * read and write, before the migration: production shapes for every table
 * the migration references (0086, 0091, 0094, 0657's store owner index), and
 * reduced shapes (only the columns the code names) for the rest. Named
 * schemas in a database of its own (createInventoryCutoverTestDatabase).
 */
export const listingPushRunsBaseFixtureSql = `
  CREATE SCHEMA dropship;
  CREATE SCHEMA catalog;
  CREATE SCHEMA ebay;
  CREATE SCHEMA channels;
  CREATE TABLE public._migrations (filename text PRIMARY KEY, content_hash text NOT NULL);

  CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id varchar(255) NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'active', entitlement_status varchar(30) NOT NULL DEFAULT 'active');
  CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    platform varchar(30) NOT NULL, status varchar(30) NOT NULL DEFAULT 'connected',
    setup_status varchar(30) NOT NULL DEFAULT 'ready', access_token_ref text, refresh_token_ref text,
    external_display_name varchar(255));
  CREATE UNIQUE INDEX dropship_store_conn_owner_identity_idx ON dropship.dropship_store_connections (id, vendor_id);
  CREATE TABLE dropship.dropship_store_listing_configs (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id), platform varchar(30) NOT NULL,
    listing_mode varchar(40) NOT NULL, inventory_mode varchar(40) NOT NULL DEFAULT 'managed_quantity_sync',
    price_mode varchar(40) NOT NULL DEFAULT 'vendor_defined', marketplace_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    required_config_keys jsonb NOT NULL DEFAULT '[]'::jsonb, required_product_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

  -- 0091
  CREATE TABLE dropship.dropship_vendor_selection_rule_set_revisions (
    id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    idempotency_key varchar(200) NOT NULL, request_hash varchar(128) NOT NULL, actor_type varchar(40) NOT NULL,
    actor_id varchar(255), rule_count integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_selection_rule_rev_actor_chk CHECK (actor_type IN ('vendor','admin','system')),
    CONSTRAINT dropship_selection_rule_rev_count_chk CHECK (rule_count >= 0));
  CREATE UNIQUE INDEX dropship_selection_rule_rev_vendor_idem_idx
    ON dropship.dropship_vendor_selection_rule_set_revisions(vendor_id, idempotency_key);
  CREATE TABLE dropship.dropship_vendor_selection_rules (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    revision_id integer REFERENCES dropship.dropship_vendor_selection_rule_set_revisions(id) ON DELETE SET NULL,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id), scope_type varchar(30) NOT NULL,
    action varchar(20) NOT NULL, product_line_id integer, product_id integer, product_variant_id integer,
    category varchar(255), auto_connect_new_skus boolean NOT NULL DEFAULT true, auto_list_new_skus boolean NOT NULL DEFAULT false,
    priority integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE dropship.dropship_catalog_rules (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope_type varchar(30) NOT NULL, action varchar(20) NOT NULL, product_line_id integer, product_id integer,
    product_variant_id integer, category varchar(255), starts_at timestamptz, ends_at timestamptz,
    is_active boolean NOT NULL DEFAULT true, priority integer NOT NULL DEFAULT 0);
  CREATE TABLE dropship.dropship_vendor_variant_overrides (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL, product_variant_id integer NOT NULL, enabled_override boolean, marketplace_quantity_cap integer);

  CREATE TABLE catalog.products (id integer PRIMARY KEY, sku varchar(100), name text NOT NULL, title text,
    description text, category varchar(100), category_id integer, ebay_browse_category_id varchar(50),
    ebay_browse_category_name text, brand text, condition text, item_specifics jsonb,
    is_active boolean NOT NULL DEFAULT true, product_type varchar(100));
  CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products(id),
    sku varchar(100), name text NOT NULL, gtin text, mpn text, weight_grams numeric(10,2),
    is_active boolean NOT NULL DEFAULT true, units_per_variant integer NOT NULL DEFAULT 1,
    uom_type varchar(30) NOT NULL DEFAULT 'pack', price_cents integer, shopify_variant_id varchar(100),
    requires_shipping boolean NOT NULL DEFAULT true, track_inventory boolean DEFAULT true,
    sales_eligibility varchar(30) NOT NULL DEFAULT 'sellable');
  CREATE TABLE catalog.product_line_products (product_id integer NOT NULL, product_line_id integer NOT NULL);
  CREATE TABLE public.shopify_variants (id varchar(100) PRIMARY KEY, sku varchar(100), price numeric(10,2));
  CREATE TABLE channels.channels (id integer PRIMARY KEY, name text, provider text, type text, status text);
  CREATE TABLE ebay.ebay_category_mappings (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, channel_id integer NOT NULL,
    product_type_slug varchar(100) NOT NULL, ebay_browse_category_id varchar(50), ebay_browse_category_name text);

  -- 0086 (with 0094's request hash and per-vendor key index)
  CREATE TABLE dropship.dropship_vendor_listings (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
    product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id), platform varchar(30) NOT NULL,
    external_listing_id varchar(255), external_offer_id varchar(255), status varchar(40) NOT NULL DEFAULT 'not_listed',
    vendor_retail_price_cents bigint, pushed_quantity integer NOT NULL DEFAULT 0, quantity_cap integer,
    last_preview_hash varchar(128), last_pushed_at timestamptz, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_listing_status_chk CHECK (status IN ('not_listed','preview_ready','queued','pushing','active','paused','ended','failed','blocked','drift_detected')));
  CREATE UNIQUE INDEX dropship_vendor_listing_store_variant_idx
    ON dropship.dropship_vendor_listings(store_connection_id, product_variant_id);
  CREATE TABLE dropship.dropship_listing_push_jobs (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
    job_type varchar(40) NOT NULL DEFAULT 'push', status varchar(30) NOT NULL DEFAULT 'queued', requested_scope jsonb,
    requested_by varchar(255), idempotency_key varchar(200), error_message text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
    request_hash varchar(128),
    CONSTRAINT dropship_listing_job_status_chk CHECK (status IN ('queued','processing','completed','failed','cancelled')));
  CREATE UNIQUE INDEX dropship_listing_job_idem_idx ON dropship.dropship_listing_push_jobs(vendor_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE TABLE dropship.dropship_listing_push_job_items (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    job_id integer NOT NULL REFERENCES dropship.dropship_listing_push_jobs(id) ON DELETE CASCADE,
    listing_id integer REFERENCES dropship.dropship_vendor_listings(id) ON DELETE SET NULL,
    product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id), action varchar(40) NOT NULL DEFAULT 'push',
    status varchar(30) NOT NULL DEFAULT 'queued', preview_hash varchar(128), external_listing_id varchar(255),
    error_code varchar(100), error_message text, result jsonb, idempotency_key varchar(200),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_listing_job_item_status_chk CHECK (status IN ('queued','processing','completed','failed','blocked','cancelled')));
  CREATE UNIQUE INDEX dropship_listing_job_item_job_variant_idx ON dropship.dropship_listing_push_job_items(job_id, product_variant_id);
  CREATE UNIQUE INDEX dropship_listing_job_item_idem_idx ON dropship.dropship_listing_push_job_items(idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE TABLE dropship.dropship_listing_sync_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id) ON DELETE CASCADE,
    event_type varchar(80) NOT NULL, source varchar(40) NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE dropship.dropship_audit_events (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE SET NULL,
    store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
    entity_type varchar(80) NOT NULL, entity_id varchar(255), event_type varchar(120) NOT NULL,
    actor_type varchar(40) NOT NULL DEFAULT 'system', actor_id varchar(255), severity varchar(20) NOT NULL DEFAULT 'info',
    payload jsonb, created_at timestamptz NOT NULL DEFAULT now());

  -- Price inputs the run's price review reads (reduced: 0711, 0657, 0659)
  CREATE TABLE dropship.dropship_cost_schedule_entries (id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
    product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id), kind varchar(20) NOT NULL,
    unit_cost_cents bigint NOT NULL, effective_at timestamptz NOT NULL, withdrawn_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE dropship.dropship_listing_price_revisions (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL, store_connection_id integer NOT NULL, product_variant_id integer NOT NULL,
    created_at timestamptz NOT NULL);
  CREATE TABLE dropship.dropship_pricing_profile_revisions (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL, store_connection_id integer NOT NULL, created_at timestamptz NOT NULL);
  -- The product and category price recipes (reduced: 0738, 0739; review MC2).
  CREATE TABLE dropship.dropship_product_listing_setting_revisions (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL, store_connection_id integer NOT NULL, product_id integer NOT NULL, previous_revision_id integer,
    price_basis varchar(20), price_markup_bps integer, price_flat_cents integer, price_rounding varchar(10), text_above text,
    created_at timestamptz NOT NULL);
  CREATE TABLE dropship.dropship_category_listing_setting_revisions (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer NOT NULL, store_connection_id integer NOT NULL, category_id integer NOT NULL, previous_revision_id integer,
    price_basis varchar(20), price_markup_bps integer, price_flat_cents integer, price_rounding varchar(10), text_above text,
    created_at timestamptz NOT NULL);
`;
