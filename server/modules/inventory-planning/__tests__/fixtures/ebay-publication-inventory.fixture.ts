import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture } from "./walmart-publication-inventory.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "./inventory-cutover-admission.fixture";

/** Real inventory migrations and an active exact eBay account with no mapping
 * or membership. Catalog, channel credentials and provider records are synthetic. */
export async function installEbayPublicationInventoryFixture(pool: Pool): Promise<void> {
    await installWalmartPublicationInventoryFixture(pool, { includeWalmartMapping: false, targetState: "preview" });
    await activateWalmartPublicationInventoryFixture(pool);
    await installCutoverAdmissionFixturePrerequisites(pool);
    for (const name of ["236_inventory_cutover_admission.sql", "0721_inventory_publication_direct_enable.sql", "0733_ebay_provider_response_finality.sql", "0742_ebay_publication_stock_readiness.sql"])
      await pool.query(readFileSync(resolve("migrations", name), "utf8"));
    await pool.query(`
      CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer,environment text,external_account_id text,external_account_identity_scheme text,external_account_verified_at timestamptz);
      INSERT INTO ebay.ebay_oauth_tokens VALUES(67,'production','seller-36','provider_user_id',transaction_timestamp());
      INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,sync_status) VALUES(1,67,101,NULL,'offer-P5','synced');

      INSERT INTO channels.channels(id,name,provider,status,sync_enabled,sync_mode) VALUES(67,'Test eBay','ebay','active',true,'live');
      INSERT INTO channels.channel_connections(id,channel_id) VALUES(9,67);
      INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,state,identity)
        VALUES('00000000-0000-4000-8000-000000000001',67,9,20,'publish','queued',
          '{"channelId":67,"connectionId":9,"productId":20,"variants":[{"variantId":101,"sku":"P5","offerId":"offer-P5","listingId":null}]}');
      INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
        external_scope_id,publication_authority,state,membership_mode,change_reason,created_by)
        VALUES(67,9,1,'account','seller-36','echelon','disabled','explicit','Exact seller stock','operator');
      INSERT INTO inventory.publication_source_binding_versions(publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES(3,1,repeat('f',64),'Main source','ebay-binding',repeat('f',64),'operator');
      INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
        VALUES(3,3,1,'operator','Reviewed source');
      INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority) VALUES(3,3,1,1);
      UPDATE inventory.publication_source_binding_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp() WHERE id=3;
      UPDATE inventory.publication_source_binding_heads SET active_binding_id=draft_binding_id,draft_binding_id=NULL,revision=revision+1 WHERE publication_target_id=3;
      UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE id=3;
      UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=3;
      INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,version,allocation_semantics,eligible,share_bps,holdback_sellable_units,max_publish_mode,min_publish_sellable_units,definition_hash,change_reason,idempotency_key,request_hash,created_by) VALUES('channel:67',67,'channel',1,'exposure',true,10000,0,'unlimited',0,repeat('e',64),'Full exposure','ebay-exposure',repeat('e',64),'operator');
      INSERT INTO inventory.channel_exposure_policy_heads(scope_key,channel_id,draft_policy_id,revision,updated_by,update_reason) SELECT scope_key,channel_id,id,1,'operator','Reviewed exposure' FROM inventory.channel_exposure_policy_versions WHERE scope_key='channel:67';
      UPDATE inventory.channel_exposure_policy_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp() WHERE scope_key='channel:67';
      UPDATE inventory.channel_exposure_policy_heads SET active_policy_id=draft_policy_id,draft_policy_id=NULL,revision=revision+1 WHERE scope_key='channel:67';`);
}
