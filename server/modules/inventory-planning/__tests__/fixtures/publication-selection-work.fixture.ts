import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { PICKS_SELECTION_TRIGGERS_SQL } from "../../../dropship/infrastructure/dropship-selection-conversion.sql";
import { LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL } from "../../../dropship/__tests__/fixtures/listing-end-reduced.fixture";
import { installStockSelectionFixture } from "./stock-selection.fixture";

/** Installs missing owner metadata in reduced inventory fixtures, then the real
 * invalidation migration, then the Dropship vendor picks table (reduced) with the
 * production picks triggers (PLAN-B v4.1 V33: the gate and the per-size
 * invalidation, exactly as the picks migration installs them). It does not
 * manufacture selection, mappings or ATP. */
export async function installPublicationSelectionWorkFixture(pool: Pick<Pool, "query">): Promise<void> {
  await installStockSelectionFixture(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS dropship.dropship_catalog_rules(id integer,scope_type text,action text,product_line_id integer,
      product_id integer,product_variant_id integer,category text,starts_at timestamptz,ends_at timestamptz,is_active boolean,priority integer);
    CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_selection_rules(id integer,vendor_id integer,scope_type text,action text,product_line_id integer,
      product_id integer,product_variant_id integer,category text,auto_connect_new_skus boolean,auto_list_new_skus boolean,is_active boolean,priority integer);
    CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_variant_overrides(vendor_id integer,product_variant_id integer,enabled_override boolean);
    CREATE TABLE IF NOT EXISTS dropship.dropship_store_listing_configs(id integer,store_connection_id integer,platform text,listing_mode text,inventory_mode text,is_active boolean);
    ALTER TABLE dropship.dropship_store_connections ADD COLUMN IF NOT EXISTS provider_environment text;
    CREATE TABLE IF NOT EXISTS dropship.dropship_vendor_listings(id integer,vendor_id integer,store_connection_id integer,product_variant_id integer,
      platform text,status text,external_listing_id text,external_offer_id text,updated_at timestamptz);
    -- The listing owner's quantity limit the Dropship selection reader reads (eBay sync-back migration *_dropship_ebay_sync_back.sql).
    ALTER TABLE dropship.dropship_vendor_listings ADD COLUMN IF NOT EXISTS vendor_quantity_limit integer;
    -- The same migration's end facts, which the shared stock listing SQL returns for the selection effects reader (PLAN-B v4.1 V21).
    ALTER TABLE dropship.dropship_vendor_listings ADD COLUMN IF NOT EXISTS marketplace_ended_at timestamptz,
      ADD COLUMN IF NOT EXISTS marketplace_issue_codes text[] NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_jobs(id integer,vendor_id integer,store_connection_id integer,job_type text,status text);
    CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_job_items(id integer,job_id integer,listing_id integer,product_variant_id integer,
      action text,status text,result jsonb,created_at timestamptz);
    -- PR C's end requests (*_dropship_listing_end_requests.sql), reduced: the shared stock listing SQL reads each listing's open end.
    ${LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL}`);
  await pool.query(readFileSync(resolve("migrations/0743_publication_selection_work.sql"), "utf8"));
  // The vendor's one-time picks (*_dropship_vendor_selected_variants.sql), reduced: key and columns, no foreign keys.
  // Its triggers use 0743's functions, so they follow 0743, as in the picks migration (§6 step 7).
  await pool.query(`CREATE TABLE dropship.dropship_vendor_selected_variants(vendor_id integer NOT NULL,product_variant_id integer NOT NULL,
      revision_id integer,source varchar(30) NOT NULL DEFAULT 'vendor',selected_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(vendor_id,product_variant_id));
    ${PICKS_SELECTION_TRIGGERS_SQL}`);
}

/** The vendor picks these sizes (one-time picks; a reduced fixture's stand-in for a step 1 save). Idempotent. */
export async function seedDropshipVendorPicks(pool: Pick<Pool, "query">, vendorId: number, productVariantIds: readonly number[]): Promise<void> {
  await pool.query(`INSERT INTO dropship.dropship_vendor_selected_variants(vendor_id,product_variant_id)
    SELECT $1, id FROM unnest($2::integer[]) id ON CONFLICT DO NOTHING`, [vendorId, [...productVariantIds]]);
}
