import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { installStockSelectionFixture } from "../../../inventory-planning/__tests__/fixtures/stock-selection.fixture";

export const listingMemberBaseSql = `CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA dropship;
  CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text);
  CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer,shop_domain text,metadata jsonb,access_token text,api_version text);
  CREATE TABLE channels.walmart_connections(connection_id integer,partner_id text,environment text,market text);
  CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text,updated_at timestamptz DEFAULT now());
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products(id),sku text,uom_type text,
    is_active boolean,requires_shipping boolean,track_inventory boolean,sales_eligibility text,updated_at timestamptz DEFAULT now());
  CREATE TABLE dropship.dropship_store_connections(id integer PRIMARY KEY,vendor_id integer,platform text,shop_domain text,
    external_account_id text,provider_environment text,status text);
  CREATE TABLE dropship.dropship_vendor_listings(id integer PRIMARY KEY,vendor_id integer,store_connection_id integer,product_variant_id integer,
    external_listing_id text,external_offer_id text);
  CREATE TABLE dropship.dropship_listing_push_jobs(id integer PRIMARY KEY,vendor_id integer,store_connection_id integer);
  CREATE TABLE dropship.dropship_listing_push_job_items(id integer PRIMARY KEY,job_id integer,listing_id integer,product_variant_id integer,
    action text,status text,result jsonb);`;

export async function installListingMemberLifecycleFixture(pool: Pool) {
  await installStockSelectionFixture(pool);
  await pool.query(`ALTER TABLE channels.channel_feeds ADD COLUMN channel_product_id text;
    CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer,environment text,external_account_id text,
      external_account_identity_scheme text,external_account_verified_at timestamptz);`);
  for (const file of ["0707_channel_listing_publication.sql", "0724_channel_listing_updates.sql",
    "259_channel_listing_lifecycle.sql", "0748_walmart_listing_presence.sql",
    "900000013000018480001_shared_listing_member_lifecycle.sql"])
    await pool.query(readFileSync(resolve("migrations", file), "utf8"));
}
