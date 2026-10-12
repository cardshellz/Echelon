import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { installStockSelectionFixture } from "./stock-selection.fixture";

/** Installs missing owner metadata in reduced inventory fixtures, then the real
 * invalidation migration. It does not manufacture selection, mappings or ATP. */
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
    CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_jobs(id integer,vendor_id integer,store_connection_id integer,job_type text,status text);
    CREATE TABLE IF NOT EXISTS dropship.dropship_listing_push_job_items(id integer,job_id integer,listing_id integer,product_variant_id integer,
      action text,status text,result jsonb,created_at timestamptz);`);
  await pool.query(readFileSync(resolve("migrations/0743_publication_selection_work.sql"), "utf8"));
}
