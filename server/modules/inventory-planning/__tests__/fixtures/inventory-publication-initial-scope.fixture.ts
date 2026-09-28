import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { installCutoverAdmissionFixturePrerequisites } from "./inventory-cutover-admission.fixture";
import { installWalmartPublicationInventoryFixture, activateWalmartPublicationInventoryFixture } from "./walmart-publication-inventory.fixture";

/** Real inventory/membership/fence/initialization migrations. Other owners below
 * are reduced named-schema read fixtures, not proof of their write workflows. */
export async function installInitialScopeFixture(pool: Pool, canonical = false): Promise<void> {
  await installWalmartPublicationInventoryFixture(pool);
  await pool.query(`UPDATE channels.channel_feeds SET channel_inventory_item_id='test-item';
    UPDATE channels.channels SET provider='shopify' WHERE id=36;
    CREATE TABLE dropship.dropship_vendor_listings(id bigint PRIMARY KEY,store_connection_id integer,product_variant_id integer,
      status text,external_listing_id text,external_offer_id text);
    CREATE SCHEMA marketplace;
    CREATE TABLE marketplace.listing_scopes(id bigint PRIMARY KEY,owner_kind text,provider text);
    CREATE TABLE marketplace.channel_listing_scopes(scope_id bigint,channel_id integer);
    CREATE TABLE marketplace.dropship_listing_scopes(scope_id bigint,store_connection_id integer);
    CREATE TABLE marketplace.listing_publications(id bigint PRIMARY KEY,scope_id bigint,status text,external_listing_id text);
    CREATE TABLE marketplace.listing_registrations(id bigint PRIMARY KEY,scope_id bigint,provider_account_id bigint,publication_id bigint);
    CREATE TABLE marketplace.listing_scope_provider_accounts(scope_id bigint,provider_account_id bigint);
    CREATE TABLE marketplace.provider_accounts(id bigint PRIMARY KEY,owner_kind text,channel_id integer,store_connection_id integer,
      provider text,external_account_id text,identity_scheme text);
    CREATE TABLE marketplace.listing_publication_members(publication_id bigint,product_variant_id integer,sku_snapshot text,
      disposition text,external_inventory_item_id text,external_offer_id text);
    CREATE TABLE marketplace.listing_verification_snapshots(id bigint PRIMARY KEY,scope_id bigint,source_publication_id bigint,
      external_listing_id text,verified_at timestamptz);
    CREATE TABLE marketplace.listing_verification_members(verification_id bigint,product_variant_id integer,sku_snapshot text,
      disposition text,external_inventory_item_id text,external_offer_id text);`);
  if (canonical) await activateWalmartPublicationInventoryFixture(pool);
  await installCutoverAdmissionFixturePrerequisites(pool);
  await pool.query(readFileSync(resolve("migrations/236_inventory_cutover_admission.sql"), "utf8"));
  await pool.query(readFileSync(resolve("migrations/0714_inventory_initial_publication_scope.sql"), "utf8"));
}

export async function seedInitialScopeDropship(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO dropship.dropship_vendors(id,business_name) VALUES(1,'Test vendor');
    INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,status,external_account_id) VALUES(1,1,'ebay','active','account-one');
    INSERT INTO inventory.inventory_publication_targets(destination_kind,channel_id,dropship_store_connection_id,fulfillment_node_id,
      provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
      VALUES('dropship_store_connection',36,1,1,'account','account-one','echelon','disabled','Fixture Dropship','operator');
    UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE id=3;
    INSERT INTO marketplace.listing_scopes VALUES(10,'dropship','ebay');
    INSERT INTO marketplace.dropship_listing_scopes VALUES(10,1);
    INSERT INTO marketplace.listing_publications VALUES(11,10,'active','listing-one');
    INSERT INTO marketplace.provider_accounts VALUES(12,'dropship',NULL,1,'ebay','account-one','provider_user_id');
    INSERT INTO marketplace.listing_scope_provider_accounts VALUES(10,12);
    INSERT INTO marketplace.listing_registrations VALUES(13,10,12,11);
    INSERT INTO marketplace.listing_publication_members VALUES(11,101,'P5','included',NULL,'offer-one');
    INSERT INTO marketplace.listing_verification_snapshots VALUES(14,10,11,'listing-one','2026-09-28T15:00:00Z');
    INSERT INTO marketplace.listing_verification_members VALUES(14,101,'P5','excluded',NULL,'offer-one'),(14,102,'NEW','included',NULL,'offer-two');
    INSERT INTO inventory.publication_variant_mapping_versions(publication_target_id,product_variant_id,version,external_inventory_item_id,
      external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES(3,102,1,'NEW','NEW',repeat('a',64),'Fixture verified SKU','dropship-scope-map',repeat('b',64),'operator');
    INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
      SELECT 3,102,id,1,'operator','Fixture verified SKU' FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=3;`);
}
