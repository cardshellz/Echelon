import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { installStockSelectionFixture } from "../../../inventory-planning/__tests__/fixtures/stock-selection.fixture";

export const lifecycleMigration =
  "migrations/900000019000018700001_listing_intent_lifecycle_disposition.sql";
export async function installIntentLifecycleFixture(pool: Pool) {
  await installStockSelectionFixture(pool);
  await pool.query(`
    ALTER TABLE catalog.products ADD COLUMN is_active boolean NOT NULL DEFAULT true, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE catalog.product_variants ADD COLUMN is_active boolean NOT NULL DEFAULT true,ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN uom_type text NOT NULL DEFAULT 'pack',ADD COLUMN requires_shipping boolean DEFAULT true,ADD COLUMN track_inventory boolean DEFAULT true,
      ADD COLUMN sales_eligibility text DEFAULT 'sellable';
    ALTER TABLE channels.channel_product_overrides ADD COLUMN is_listed int;
    ALTER TABLE channels.channel_listings ADD COLUMN external_sku text;
    ALTER TABLE channels.channel_feeds ADD COLUMN channel_product_id text;
    ALTER TABLE ebay.ebay_category_mappings ADD COLUMN listing_enabled boolean DEFAULT true;
    ALTER TABLE ebay.ebay_oauth_tokens ADD COLUMN external_account_identity_scheme text DEFAULT 'provider_user_id';
    ALTER TABLE channels.walmart_connections ADD COLUMN market text DEFAULT 'US';
    ALTER TABLE dropship.dropship_store_connections ADD COLUMN shop_domain text;
    CREATE TABLE dropship.dropship_listing_push_job_items(id int PRIMARY KEY,job_id int,listing_id int,product_variant_id int,action text,status text,result jsonb);
    UPDATE channels.channel_listings l SET external_sku=v.sku,sync_status='synced' FROM catalog.product_variants v WHERE v.id=l.product_variant_id;
    INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_variant_id,channel_inventory_item_id,channel_sku)
      SELECT l.channel_id,l.product_variant_id,l.external_variant_id,l.external_sku,l.external_sku FROM channels.channel_listings l;
    DROP TABLE inventory.quantity_publication_attempts;
    -- These are read-port projections of inventory-owned tables. Listing code
    -- never writes them. Real quantity admission migration below supplies its
    -- actual constraints and immutable request-history triggers.
    CREATE TABLE inventory.availability_activation_runs(id bigint PRIMARY KEY);
    CREATE FUNCTION inventory.reject_availability_claim_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'immutable'; END; $$;
    CREATE TABLE inventory.inventory_publication_targets(id int PRIMARY KEY,destination_kind text,channel_connection_id int,
      dropship_store_connection_id int,revision bigint,provider_scope_type text,external_scope_id text);
    CREATE TABLE inventory.publication_variant_mapping_heads(publication_target_id int,product_variant_id int,active_mapping_id int,
      PRIMARY KEY(publication_target_id,product_variant_id));
    CREATE TABLE inventory.publication_variant_mapping_versions(id int PRIMARY KEY,publication_target_id int,product_variant_id int,
      lifecycle_status text,external_inventory_item_id text,external_sku text);
    CREATE TABLE inventory.inventory_publication_outbox(id bigint PRIMARY KEY,publication_target_id int,product_variant_id int,
      destination_kind_snapshot text,channel_connection_id_snapshot int,dropship_store_connection_id_snapshot int,state text,
      desired_quantity bigint,desired_revision bigint,external_inventory_item_id_snapshot text,
      provider_key_snapshot text DEFAULT 'ebay',provider_scope_type_snapshot text DEFAULT 'account',
      external_scope_id_snapshot text DEFAULT 'seller-a',external_sku_snapshot text);
    CREATE UNIQUE INDEX inventory_publication_outbox_target_variant_revision_uq
      ON inventory.inventory_publication_outbox(publication_target_id,product_variant_id,desired_revision);
    CREATE TABLE inventory.inventory_publication_readbacks(id bigint PRIMARY KEY,publication_target_id int,product_variant_id int,outbox_id bigint,
      destination_kind_snapshot text,channel_connection_id_snapshot int,dropship_store_connection_id_snapshot int,
      publication_target_revision_snapshot bigint,provider_scope_type_snapshot text,external_scope_id_snapshot text,
      external_inventory_item_id_snapshot text,observed_quantity bigint,quantity_consistent boolean,matches_desired boolean,observed_at timestamptz);
    CREATE UNIQUE INDEX inventory_publication_readbacks_target_variant_observed_uq
      ON inventory.inventory_publication_readbacks(publication_target_id,product_variant_id,observed_at,id);
  `);
  for (const file of [
    "migrations/0707_channel_listing_publication.sql",
    "migrations/0724_channel_listing_updates.sql",
    "migrations/237_inventory_quantity_publication_admission.sql",
    "migrations/900000038000019440001_quantity_catchup_parking.sql",
    "migrations/900000013000018480001_shared_listing_member_lifecycle.sql",
    "migrations/900000022000018880002_listing_member_recovery.sql",
    "migrations/900000018000018580002_listing_intent_propagation.sql",
    lifecycleMigration,
    "migrations/900000023000018880003_listing_work_settlement.sql",
  ])
    await pool.query(await readFile(file, "utf8"));
}
export async function verifyZero(pool: Pool, now: Date) {
  await pool.query(`INSERT INTO inventory.inventory_publication_targets VALUES(1,'channel_connection',4,NULL,1,'account','seller-a') ON CONFLICT DO NOTHING;
    INSERT INTO inventory.publication_variant_mapping_heads VALUES(1,101,101),(1,102,102) ON CONFLICT DO NOTHING;
    INSERT INTO inventory.publication_variant_mapping_versions(id,publication_target_id,product_variant_id,lifecycle_status,external_inventory_item_id) VALUES(101,1,101,'sealed','SKU-A'),(102,1,102,'sealed','SKU-B') ON CONFLICT DO NOTHING;
    INSERT INTO inventory.inventory_publication_outbox(id,publication_target_id,product_variant_id,destination_kind_snapshot,channel_connection_id_snapshot,dropship_store_connection_id_snapshot,state,desired_quantity,desired_revision,external_inventory_item_id_snapshot) VALUES(101,1,101,'channel_connection',4,NULL,'verified',0,1,'SKU-A'),
      (102,1,102,'channel_connection',4,NULL,'verified',0,1,'SKU-B') ON CONFLICT DO NOTHING;`);
  await pool.query(
    `INSERT INTO inventory.inventory_publication_readbacks
    SELECT id,1,id,id,'channel_connection',4,NULL,1,'account','seller-a',sku,0,true,true,$1 FROM catalog.product_variants WHERE id IN (101,102)
    ON CONFLICT(id) DO UPDATE SET observed_at=$1`,
    [now],
  );
}
