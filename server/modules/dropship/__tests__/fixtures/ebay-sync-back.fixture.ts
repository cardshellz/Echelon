import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";

/**
 * The eBay sync-back migration (plan v4 §8), found by its name, never by its
 * number: the number is allocated under the stand-in PR 99999 and changes
 * when the file is adopted under the real one. Exactly one file may carry
 * the name.
 */
export const EBAY_SYNC_BACK_MIGRATION_SUFFIX = "_dropship_ebay_sync_back.sql";

export const EBAY_SYNC_BACK_MIGRATION_FILE: string = (() => {
  const matches = readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.endsWith(EBAY_SYNC_BACK_MIGRATION_SUFFIX));
  if (matches.length !== 1) throw new Error(`Expected exactly one migration ending in ${EBAY_SYNC_BACK_MIGRATION_SUFFIX}; found ${matches.length}.`);
  return matches[0]!;
})();

export function ebaySyncBackMigrationSql(): string {
  return readFileSync(resolve(process.cwd(), "migrations", EBAY_SYNC_BACK_MIGRATION_FILE), "utf8");
}

/** The real migration this one builds on: the selection trigger it recreates (0743). */
export function ebaySyncBackPrerequisiteSql(): string[] {
  return ["0743_publication_selection_work.sql"]
    .map((file) => readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
}

/**
 * The tables before the migration, in a database of its own
 * (createInventoryCutoverTestDatabase): production shapes for the tables the
 * migration alters or references (0086 listings and intake, the store owner
 * index 0657 adds), and reduced shapes (only the columns 0743's manifest
 * names) for the selection sources 0743 needs to exist.
 */
export const ebaySyncBackBaseFixtureSql = `
  CREATE SCHEMA dropship; CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay; CREATE SCHEMA inventory;
  CREATE TABLE public._migrations (filename text PRIMARY KEY, content_hash text NOT NULL);

  CREATE TABLE catalog.products (id integer PRIMARY KEY, sku varchar(100), name text NOT NULL DEFAULT 'Product',
    is_active boolean NOT NULL DEFAULT true, status text DEFAULT 'active', product_type text, category text, ebay_listing_excluded boolean DEFAULT false);
  CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products(id),
    sku varchar(100), name text NOT NULL DEFAULT 'Size', is_active boolean NOT NULL DEFAULT true, requires_shipping boolean NOT NULL DEFAULT true,
    track_inventory boolean DEFAULT true, sales_eligibility varchar(30) NOT NULL DEFAULT 'sellable', ebay_listing_excluded boolean DEFAULT false,
    uom_type varchar(30) NOT NULL DEFAULT 'pack');
  CREATE TABLE catalog.product_line_products (product_id integer NOT NULL, product_line_id integer NOT NULL);
  CREATE TABLE channels.channel_product_overrides (channel_id integer, product_id integer, is_listed integer);
  CREATE TABLE channels.channel_variant_overrides (channel_id integer, product_variant_id integer, is_listed integer);
  CREATE TABLE channels.channel_feeds (channel_id integer, product_variant_id integer, is_active integer DEFAULT 1, quarantined_at timestamptz,
    channel_variant_id text, channel_inventory_item_id text, channel_sku text);
  CREATE TABLE channels.channel_listings (channel_id integer, product_variant_id integer, external_product_id text, external_variant_id text,
    external_sku text);
  CREATE TABLE channels.ebay_listing_sync_jobs (product_id integer, operation text, identity jsonb, provider_identity jsonb, state text);
  CREATE TABLE ebay.ebay_category_mappings (channel_id integer, product_type_slug text, listing_enabled boolean);
  CREATE TABLE inventory.publication_variant_mapping_heads (publication_target_id integer, product_variant_id integer, active_mapping_id bigint);

  CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id varchar(255) NOT NULL,
    status varchar(30) NOT NULL DEFAULT 'active', entitlement_status varchar(30) NOT NULL DEFAULT 'active');
  CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    platform varchar(30) NOT NULL, status varchar(30) NOT NULL DEFAULT 'connected', setup_status varchar(30) NOT NULL DEFAULT 'ready',
    last_order_sync_at timestamptz, external_display_name varchar(255), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX dropship_store_conn_owner_identity_idx ON dropship.dropship_store_connections (id, vendor_id);
  CREATE TABLE dropship.dropship_store_listing_configs (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id), platform varchar(30) NOT NULL DEFAULT 'ebay',
    listing_mode varchar(40) NOT NULL DEFAULT 'live', inventory_mode varchar(40) NOT NULL DEFAULT 'managed_quantity_sync',
    is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE dropship.dropship_catalog_rules (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, scope_type text, action text,
    product_line_id integer, product_id integer, product_variant_id integer, category text, starts_at timestamptz, ends_at timestamptz,
    is_active boolean, priority integer);
  CREATE TABLE dropship.dropship_vendor_selection_rules (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, vendor_id integer, scope_type text,
    action text, product_line_id integer, product_id integer, product_variant_id integer, category text, auto_connect_new_skus boolean,
    auto_list_new_skus boolean, is_active boolean, priority integer);
  CREATE TABLE dropship.dropship_vendor_variant_overrides (vendor_id integer, product_variant_id integer, enabled_override boolean);

  -- 0086
  CREATE TABLE dropship.dropship_vendor_listings (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
    product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id), platform varchar(30) NOT NULL,
    external_listing_id varchar(255), external_offer_id varchar(255), status varchar(40) NOT NULL DEFAULT 'not_listed',
    vendor_retail_price_cents bigint, observed_marketplace_price_cents bigint, pushed_quantity integer NOT NULL DEFAULT 0,
    quantity_cap integer, last_preview_hash varchar(128), drift_detected_at timestamptz, last_pushed_at timestamptz,
    last_marketplace_sync_at timestamptz, paused_reason text, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_listing_platform_chk CHECK (platform IN ('ebay','shopify','tiktok','instagram','bigcommerce')),
    CONSTRAINT dropship_listing_status_chk CHECK (status IN ('not_listed','preview_ready','queued','pushing','active','paused','ended','failed','blocked','drift_detected')),
    CONSTRAINT dropship_listing_price_chk CHECK (vendor_retail_price_cents IS NULL OR vendor_retail_price_cents >= 0),
    CONSTRAINT dropship_listing_qty_chk CHECK (pushed_quantity >= 0 AND (quantity_cap IS NULL OR quantity_cap >= 0)));
  CREATE UNIQUE INDEX dropship_vendor_listing_store_variant_idx ON dropship.dropship_vendor_listings(store_connection_id, product_variant_id);
  CREATE TABLE dropship.dropship_listing_push_jobs (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
    status varchar(30) NOT NULL DEFAULT 'queued');
  CREATE TABLE dropship.dropship_listing_push_job_items (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    job_id integer NOT NULL REFERENCES dropship.dropship_listing_push_jobs(id) ON DELETE CASCADE,
    listing_id integer REFERENCES dropship.dropship_vendor_listings(id) ON DELETE SET NULL,
    product_variant_id integer NOT NULL REFERENCES catalog.product_variants(id), action varchar(40) NOT NULL DEFAULT 'push',
    status varchar(30) NOT NULL DEFAULT 'queued', result jsonb);
  CREATE TABLE dropship.dropship_listing_sync_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id integer NOT NULL REFERENCES dropship.dropship_vendor_listings(id) ON DELETE CASCADE,
    event_type varchar(80) NOT NULL, source varchar(40) NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE dropship.dropship_audit_events (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE SET NULL,
    store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
    entity_type varchar(80) NOT NULL, entity_id varchar(255), event_type varchar(120) NOT NULL,
    actor_type varchar(40) NOT NULL DEFAULT 'system', actor_id varchar(255), severity varchar(20) NOT NULL DEFAULT 'info',
    payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE dropship.dropship_order_intake (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
    platform varchar(30) NOT NULL DEFAULT 'ebay', external_order_id varchar(255) NOT NULL, status varchar(40) NOT NULL DEFAULT 'received',
    cancellation_status varchar(40), received_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_order_intake_status_chk CHECK (status IN ('received','processing','accepted','rejected','retrying','failed','payment_hold','cancelled','exception')));
  CREATE UNIQUE INDEX dropship_order_intake_store_external_idx ON dropship.dropship_order_intake(store_connection_id, external_order_id);
`;

/**
 * After the base fixture: the real prerequisite migration, and (unless
 * told otherwise) this migration, each in its own transaction as the release
 * runner applies them (this one starts with LOCK TABLE, which needs one).
 */
export async function installEbaySyncBackSchema(pool: Pool, options: { applyMigration?: boolean } = {}): Promise<void> {
  const files = [...ebaySyncBackPrerequisiteSql(), ...(options.applyMigration === false ? [] : [ebaySyncBackMigrationSql()])];
  const client = await pool.connect();
  try {
    for (const sql of files) {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * For a reduced fixture that builds its own listings table (no full migration
 * chain): the sync-back migration's own listing columns and (unless told
 * otherwise) its previous item numbers table, cut from the migration file, so
 * a suite of the push path runs against the columns production has. A column
 * the reduced fixture already added is kept (ADD COLUMN IF NOT EXISTS); the
 * constraints are added as the migration adds them. The previous ids table
 * needs the store owner index (id, vendor_id) and the listings' primary key,
 * as production has (0657, 0086).
 */
export function ebaySyncBackListingColumnsSql(options: { previousIds?: boolean } = {}): string {
  // Git may check out migration text with CRLF on Windows. Normalize only the
  // fixture's in-memory text so statement extraction uses the same SQL on every host.
  const sql = ebaySyncBackMigrationSql().replaceAll("\r\n", "\n");
  const cut = (start: string, end: string): string => {
    const from = sql.indexOf(start);
    const to = from < 0 ? -1 : sql.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error(`The sync-back migration no longer has the statement starting "${start}".`);
    return sql.slice(from, to + end.length);
  };
  return [
    // The 0086 listing columns sync-back reuses (0086_dropship_v2_foundation.sql:272-278), when a reduced fixture left them out.
    `ALTER TABLE dropship.dropship_vendor_listings ADD COLUMN IF NOT EXISTS observed_marketplace_price_cents bigint,
      ADD COLUMN IF NOT EXISTS drift_detected_at timestamptz, ADD COLUMN IF NOT EXISTS last_marketplace_sync_at timestamptz;`,
    cut("ALTER TABLE dropship.dropship_vendor_listings\n", ";\n").replaceAll("ADD COLUMN ", "ADD COLUMN IF NOT EXISTS "),
    ...(options.previousIds === false ? [] : [cut("CREATE TABLE dropship.dropship_listing_previous_marketplace_ids (", ";\n")]),
  ].join("\n");
}
