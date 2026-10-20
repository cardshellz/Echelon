import { readFile } from "node:fs/promises";
import type pg from "pg";
import { CHANNEL_PRICING_RULES_DDL } from "../../infrastructure/channel-pricing-schema";
import { createInventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

// Pricing tables preserve the production columns and indexes. Unrelated source
// tables are reduced read models required to install the real propagation migration.
const sourceTables = `
CREATE SCHEMA catalog;CREATE SCHEMA channels;CREATE SCHEMA ebay;CREATE SCHEMA dropship;CREATE SCHEMA marketplace;
CREATE TABLE catalog.products(id int PRIMARY KEY,name text,product_type text,category text,category_id int,price_cents bigint,ebay_fulfillment_policy_override text);
CREATE TABLE catalog.product_variants(id int PRIMARY KEY,product_id int,sku text,name text,price_cents bigint,shopify_variant_id text,option1_name text,option1_value text);
CREATE TABLE catalog.product_assets(id int PRIMARY KEY,product_id int,product_variant_id int,url text,position int,file_data bytea);
CREATE TABLE public.shopify_variants(id text PRIMARY KEY,sku text,price numeric);
CREATE TABLE channels.channels(id int PRIMARY KEY,provider text);
CREATE TABLE channels.channel_connections(id int PRIMARY KEY,channel_id int,shop_domain text,metadata jsonb);
CREATE TABLE channels.channel_listings(id int PRIMARY KEY,channel_id int,product_variant_id int,external_product_id text,external_variant_id text);
CREATE TABLE channels.channel_product_overrides(id int PRIMARY KEY,channel_id int,product_id int,title_override text);
CREATE TABLE channels.channel_variant_overrides(id int PRIMARY KEY,channel_id int,product_variant_id int,name_override text);
CREATE TABLE channels.channel_asset_overrides(id int PRIMARY KEY,channel_id int,product_asset_id int,is_included int,position_override int);
CREATE TABLE channels.walmart_connections(channel_id int,connection_id int,partner_id text,environment text,ship_node_id text,warehouse_id int,revision int);
CREATE TABLE ebay.ebay_oauth_tokens(channel_id int,environment text,external_account_id text,external_account_verified_at timestamptz);
CREATE TABLE ebay.ebay_category_mappings(id int PRIMARY KEY,channel_id int,product_type_slug text,fulfillment_policy_override text);
CREATE TABLE ebay.ebay_type_aspect_defaults(id int PRIMARY KEY,product_type_slug text,aspect_name text,aspect_value text);
CREATE TABLE ebay.ebay_product_aspect_overrides(id int PRIMARY KEY,product_id int,aspect_name text,aspect_value text);
CREATE TABLE dropship.dropship_vendors(id int PRIMARY KEY,member_id text);
CREATE TABLE dropship.dropship_store_connections(id int PRIMARY KEY,vendor_id int,platform text,external_account_id text,provider_environment text,external_account_verified_at timestamptz,config jsonb);
CREATE TABLE dropship.dropship_vendor_listings(id int PRIMARY KEY,vendor_id int,store_connection_id int,product_variant_id int,external_listing_id text,external_offer_id text);
CREATE TABLE dropship.dropship_product_listing_settings(store_connection_id int,vendor_id int,product_id int,revision_id int);
CREATE TABLE dropship.dropship_category_listing_settings(store_connection_id int,vendor_id int,category_id int,revision_id int);
CREATE TABLE dropship.dropship_listing_price_settings(store_connection_id int,vendor_id int,product_variant_id int,revision_id int,override_price_cents bigint,pricing_mode text);
CREATE TABLE dropship.dropship_listing_content_settings(store_connection_id int,vendor_id int,product_variant_id int,revision_id int);
CREATE TABLE dropship.dropship_pricing_profiles(store_connection_id int,vendor_id int,revision_id int);
CREATE TABLE dropship.dropship_content_profiles(store_connection_id int,vendor_id int,revision_id int);
CREATE TABLE dropship.dropship_ebay_category_rule_profiles(store_connection_id int,vendor_id int,revision_id int);
CREATE TABLE dropship.dropship_store_listing_configs(id int PRIMARY KEY,store_connection_id int,revision int,listing_mode text,marketplace_config jsonb);
   CREATE TABLE dropship.dropship_listing_push_jobs(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,vendor_id int,store_connection_id int,
    job_type text,status text,requested_scope jsonb,requested_by text,idempotency_key text,request_hash text,error_message text,created_at timestamptz,updated_at timestamptz,
    UNIQUE(vendor_id,idempotency_key));
CREATE TABLE catalog.product_types(id int PRIMARY KEY,slug varchar(50) NOT NULL UNIQUE,name varchar(100) NOT NULL);
CREATE TABLE channels.channel_pricing(
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 channel_id integer NOT NULL REFERENCES channels.channels(id) ON DELETE CASCADE,
 product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE CASCADE,
 price bigint NOT NULL, compare_at_price bigint, cost bigint,
 currency varchar(3) NOT NULL DEFAULT 'USD',
 created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channel_pricing_channel_pv_idx ON channels.channel_pricing(channel_id,product_variant_id);
CREATE TABLE public.audit_events(
 id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL DEFAULT now(),level text NOT NULL DEFAULT 'AUDIT',
 actor text NOT NULL,action text NOT NULL,target text,changes jsonb,context jsonb
);
INSERT INTO catalog.product_types VALUES(7,'sleeves','Sleeves'),(8,'boxes','Boxes');
INSERT INTO catalog.products VALUES(20,'Product A','sleeves','Sleeves',7,1000,NULL),(21,'Product B','boxes','Boxes',8,2000,NULL);
INSERT INTO catalog.product_variants VALUES(101,20,'SKU-A','A',1000,'remote-a',NULL,NULL),(102,20,'SKU-B','B',1200,NULL,NULL,NULL),(201,21,'SKU-C','C',2000,NULL,NULL,NULL);
INSERT INTO channels.channels VALUES(67,'ebay'),(68,'walmart');
`;

export async function createChannelPricingTestDatabase() {
  const database = await createInventoryCutoverTestDatabase(
    process.env.ECHELON_TEST_DATABASE_URL,
    process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true",
    sourceTables + CHANNEL_PRICING_RULES_DDL,
  );
  try {
    await database.pool.query(await readFile("migrations/900000018000018580002_listing_intent_propagation.sql", "utf8"));
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export async function pricingSnapshot(pool: pg.Pool) {
  const [rules, prices, audits, facts] = await Promise.all([
    pool.query("SELECT * FROM channels.channel_pricing_rules ORDER BY id"),
    pool.query("SELECT * FROM channels.channel_pricing ORDER BY id"),
    pool.query("SELECT * FROM public.audit_events ORDER BY id"),
    pool.query("SELECT * FROM marketplace.listing_intent_changes ORDER BY id"),
  ]);
  return { rules: rules.rows, prices: prices.rows, audits: audits.rows, facts: facts.rows };
}
