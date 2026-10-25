import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import { installEbayPublicationInventoryFixture } from "./ebay-publication-inventory.fixture";
import { installPublicationSelectionWorkFixture } from "./publication-selection-work.fixture";
import { calculatePublicationVariantMappingDefinitionHash } from "../../domain/inventory-channel-exposure";

/** Synthetic Dropship eBay store over the real inventory migrations used by the
 * channel readiness suites: vendor 10, store 22 (eBay, connected, provider-verified
 * account "dropship-seller" in production), a live/managed listing config, catalog and
 * vendor include rules, and the internal "Dropship OMS" policy channel 40 (provider
 * 'manual', as seeded by migrations/0106_dropship_internal_channel_seed.sql) with a
 * sealed full-exposure channel policy. No stock destination or mapping is created
 * here; tests add exactly the destination they describe. Product 20 / variant 101
 * (catalog SKU "P5") has canonical ATP 17 in the shared composition seed. */
export const DROPSHIP_EBAY_STOCK = Object.freeze({
  vendorId: 10,
  storeConnectionId: 22,
  accountId: "dropship-seller",
  environment: "production" as const,
  policyChannelId: 40,
  productId: 20,
  variantId: 101,
  sku: "P5",
});

// Copied from migrations/0609_marketplace_listing_registration.sql: the reduced
// composition table lacks the stable identity columns and their CHECK.
const STORE_IDENTITY_COLUMNS_SQL = `
  ALTER TABLE dropship.dropship_store_connections
    ADD COLUMN IF NOT EXISTS external_account_identity_scheme text,
    ADD COLUMN IF NOT EXISTS external_account_verified_at timestamptz;
  ALTER TABLE dropship.dropship_store_connections
    ADD CONSTRAINT dropship_store_connections_stable_identity_chk CHECK (
      external_account_identity_scheme IS NULL
      OR (
        external_account_identity_scheme = 'provider_user_id'
        AND (lower(platform) <> 'ebay' OR provider_environment IN ('sandbox', 'production'))
        AND provider_environment IS NOT NULL
        AND provider_environment = btrim(provider_environment)
        AND provider_environment <> ''
        AND external_account_id IS NOT NULL
        AND external_account_id = btrim(external_account_id)
        AND external_account_id <> ''
        AND external_account_verified_at IS NOT NULL
      )
    );`;

export async function installDropshipEbayStockFixture(pool: Pool): Promise<void> {
  await installEbayPublicationInventoryFixture(pool, { includePreflightRecoveryMigrations: true, seedPublicationJob: false });
  // Same migration set as the channel readiness suite, so the selection-work
  // migration finds its channel sync-job prerequisites.
  for (const file of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql",
    "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql"]) {
    await pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
  }
  await installPublicationSelectionWorkFixture(pool);
  await pool.query(STORE_IDENTITY_COLUMNS_SQL);
  await pool.query(`
    INSERT INTO channels.channels(id,name,provider,status,sync_enabled,sync_mode) VALUES(40,'Dropship OMS','manual','active',false,'dry_run');
    INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,version,allocation_semantics,eligible,share_bps,
      holdback_sellable_units,max_publish_mode,min_publish_sellable_units,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES('channel:40',40,'channel',1,'exposure',true,10000,0,'unlimited',0,repeat('e',64),'Full Dropship exposure','dropship-exposure',repeat('e',64),'operator');
    INSERT INTO inventory.channel_exposure_policy_heads(scope_key,channel_id,draft_policy_id,revision,updated_by,update_reason)
      SELECT scope_key,channel_id,id,1,'operator','Reviewed Dropship exposure' FROM inventory.channel_exposure_policy_versions WHERE scope_key='channel:40';
    UPDATE inventory.channel_exposure_policy_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp() WHERE scope_key='channel:40';
    UPDATE inventory.channel_exposure_policy_heads SET active_policy_id=draft_policy_id,draft_policy_id=NULL,revision=revision+1 WHERE scope_key='channel:40';
    INSERT INTO dropship.dropship_vendors(id,business_name) VALUES(10,'Stock link vendor'),(11,'Other vendor');
    INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,status,external_account_id,provider_environment,
      external_account_identity_scheme,external_account_verified_at)
      VALUES(22,10,'ebay','connected','dropship-seller','production','provider_user_id',transaction_timestamp()),
            (23,11,'ebay','connected','other-seller','production','provider_user_id',transaction_timestamp());
    INSERT INTO dropship.dropship_store_listing_configs(id,store_connection_id,platform,listing_mode,inventory_mode,is_active)
      VALUES(1,22,'ebay','live','managed_quantity_sync',true),(2,23,'ebay','live','managed_quantity_sync',true);
    INSERT INTO dropship.dropship_catalog_rules(id,scope_type,action,is_active,priority) VALUES(1,'catalog','include',true,0);
    INSERT INTO dropship.dropship_vendor_selection_rules(id,vendor_id,scope_type,action,auto_connect_new_skus,auto_list_new_skus,is_active,priority)
      VALUES(1,10,'catalog','include',true,true,true,0),(2,11,'catalog','include',true,true,true,0);`);
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** One exact Dropship stock destination. `binding:'draft'` leaves the supply
 * binding unsealed; `state:'disabled'` never activates the destination. */
export async function createDropshipEbayTarget(pool: Pool, options: {
  channelId?: number; storeConnectionId?: number; accountId?: string; fulfillmentNodeId?: number;
  state?: "disabled" | "preview" | "live"; binding?: "sealed" | "draft"; label?: string;
} = {}): Promise<number> {
  const channelId = options.channelId ?? DROPSHIP_EBAY_STOCK.policyChannelId;
  const storeConnectionId = options.storeConnectionId ?? DROPSHIP_EBAY_STOCK.storeConnectionId;
  const accountId = options.accountId ?? DROPSHIP_EBAY_STOCK.accountId;
  const nodeId = options.fulfillmentNodeId ?? 1;
  const label = options.label ?? `dropship-${storeConnectionId}-${nodeId}-${channelId}`;
  return inTransaction(pool, async client => {
    const targetId = (await client.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets
      (destination_kind,channel_id,dropship_store_connection_id,fulfillment_node_id,provider_scope_type,external_scope_id,
        publication_authority,state,change_reason,created_by)
      VALUES('dropship_store_connection',$1,$2,$3,'account',$4,'echelon','disabled','Dropship stock fixture','fixture')
      RETURNING id`, [channelId, storeConnectionId, nodeId, accountId])).rows[0]!.id;
    const binding = (await client.query<{ id: string }>(`INSERT INTO inventory.publication_source_binding_versions
      (publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES($1,1,repeat('b',64),'Dropship warehouse',$2,repeat('b',64),'fixture') RETURNING id::text`,
    [targetId, `${label}-binding`])).rows[0]!;
    await client.query(`INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
      VALUES($1,$2,1,'fixture','Dropship store source')`, [targetId, binding.id]);
    await client.query(`INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority)
      VALUES($1,$2,$3,1)`, [binding.id, targetId, nodeId]);
    if ((options.binding ?? "sealed") === "sealed") {
      await client.query("UPDATE inventory.publication_source_binding_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp() WHERE id=$1", [binding.id]);
      await client.query(`UPDATE inventory.publication_source_binding_heads SET active_binding_id=draft_binding_id,draft_binding_id=NULL,revision=revision+1
        WHERE publication_target_id=$1`, [targetId]);
    }
    const state = options.state ?? "live";
    if (state !== "disabled") await client.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,
      activated_by='fixture',activated_at=transaction_timestamp() WHERE id=$1`, [targetId]);
    if (state === "live") await client.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [targetId]);
    return targetId;
  });
}

/** A second active fulfillment node, so a store can hold two distinct destinations. */
export async function addSecondFulfillmentNode(pool: Pool): Promise<number> {
  await pool.query(`INSERT INTO warehouse.warehouses(id,code) VALUES(2,'SECOND');
    INSERT INTO warehouse.fulfillment_nodes(code,name,node_type,warehouse_id,inventory_authority,fulfillment_authority,created_by)
      VALUES('SECOND','Second source','internal_warehouse',2,'echelon','echelon','fixture');
    UPDATE warehouse.fulfillment_nodes SET lifecycle_status='active',activated_by='fixture',activated_at=transaction_timestamp() WHERE code='SECOND'`);
  return (await pool.query<{ id: number }>("SELECT id FROM warehouse.fulfillment_nodes WHERE code='SECOND'")).rows[0]!.id;
}

/** An already sealed exact SKU mapping (the state a completed stock link leaves). */
export async function sealDropshipMapping(pool: Pool, targetId: number, productVariantId: number, sku: string): Promise<string> {
  return inTransaction(pool, async client => {
    const hash = calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: targetId, productVariantId,
      externalInventoryItemId: sku, externalSku: sku });
    const mapping = (await client.query<{ id: string }>(`INSERT INTO inventory.publication_variant_mapping_versions
      (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES($1,$2,1,$3,$3,$4,'Fixture exact item',$5,$4,'fixture') RETURNING id::text`,
    [targetId, productVariantId, sku, hash, `fixture-mapping-${targetId}-${productVariantId}`])).rows[0]!;
    await client.query(`INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
      VALUES($1,$2,$3,1,'fixture','Fixture exact item')`, [targetId, productVariantId, mapping.id]);
    await client.query("UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp() WHERE id=$1", [mapping.id]);
    await client.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=draft_mapping_id,draft_mapping_id=NULL,revision=revision+1
      WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, productVariantId]);
    return mapping.id;
  });
}

/** A vendor listing with a saved live/managed push intent. With identity it is a
 * retained provider listing; without, it is a new SKU whose push has not finished. */
export async function addDropshipLivePush(pool: Pool, input: {
  listingId: number; productVariantId: number; sku: string; jobId: number; jobItemId: number;
  storeConnectionId?: number; vendorId?: number; status?: "queued" | "processing" | "failed" | "completed";
  externalListingId?: string | null; externalOfferId?: string | null; listingStatus?: string;
}): Promise<void> {
  const storeConnectionId = input.storeConnectionId ?? DROPSHIP_EBAY_STOCK.storeConnectionId;
  const vendorId = input.vendorId ?? DROPSHIP_EBAY_STOCK.vendorId;
  const intent = { listingMode: "live", inventoryMode: "managed_quantity_sync", productVariantId: input.productVariantId,
    platform: "ebay", sku: input.sku, quantity: 999 };
  await pool.query(`INSERT INTO dropship.dropship_vendor_listings(id,vendor_id,store_connection_id,product_variant_id,platform,status,
      external_listing_id,external_offer_id,updated_at)
    VALUES($1,$2,$3,$4,'ebay',$5,$6,$7,transaction_timestamp())`,
  [input.listingId, vendorId, storeConnectionId, input.productVariantId, input.listingStatus ?? "queued",
    input.externalListingId ?? null, input.externalOfferId ?? null]);
  // The reduced job table has no key; insert each job once.
  await pool.query(`INSERT INTO dropship.dropship_listing_push_jobs(id,vendor_id,store_connection_id,job_type,status)
    SELECT $1,$2,$3,'push',$4 WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_jobs WHERE id=$1)`,
  [input.jobId, vendorId, storeConnectionId, input.status ?? "processing"]);
  await pool.query(`INSERT INTO dropship.dropship_listing_push_job_items(id,job_id,listing_id,product_variant_id,action,status,result,created_at)
    VALUES($1,$2,$3,$4,'push',$5,$6::jsonb,transaction_timestamp())`,
  [input.jobItemId, input.jobId, input.listingId, input.productVariantId, input.status ?? "processing",
    JSON.stringify({ listingIntent: intent })]);
}

export async function countDropshipStockRows(pool: Pick<Pool, "query">, targetId: number | null) {
  return (await pool.query<{ mappings: number; drafts: number; outbox: number; preparations: number; audits: number }>(`SELECT
    (SELECT count(*)::int FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1 AND lifecycle_status='sealed') AS mappings,
    (SELECT count(*)::int FROM inventory.publication_variant_mapping_versions WHERE publication_target_id=$1 AND lifecycle_status='draft') AS drafts,
    (SELECT count(*)::int FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1) AS outbox,
    (SELECT count(*)::int FROM inventory.publication_mapping_preparations WHERE publication_target_id=$1) AS preparations,
    (SELECT count(*)::int FROM public.audit_events WHERE target='inventory.inventory_publication_target:'||$1::text) AS audits`,
  [targetId ?? 0])).rows[0]!;
}

/** An unsealed draft mapping (a saved but unreviewed setup decision). */
export async function draftDropshipMapping(pool: Pool, targetId: number, productVariantId: number, sku: string): Promise<string> {
  return inTransaction(pool, async client => {
    const hash = calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: targetId, productVariantId,
      externalInventoryItemId: sku, externalSku: sku });
    const mapping = (await client.query<{ id: string }>(`INSERT INTO inventory.publication_variant_mapping_versions
      (publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES($1,$2,1,$3,$3,$4,'Fixture saved draft',$5,$4,'operator') RETURNING id::text`,
    [targetId, productVariantId, sku, hash, `fixture-draft-${targetId}-${productVariantId}`])).rows[0]!;
    await client.query(`INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
      VALUES($1,$2,$3,1,'operator','Fixture saved draft')`, [targetId, productVariantId, mapping.id]);
    return mapping.id;
  });
}

/** Retires the active mapping (no product writer does this yet; it simulates a
 * later identity retirement so the head has no active mapping). */
export async function retireDropshipMapping(pool: Pool, targetId: number, productVariantId: number): Promise<void> {
  await inTransaction(pool, async client => {
    const head = (await client.query<{ active_mapping_id: string }>(`SELECT active_mapping_id::text FROM inventory.publication_variant_mapping_heads
      WHERE publication_target_id=$1 AND product_variant_id=$2 FOR UPDATE`, [targetId, productVariantId])).rows[0]!;
    await client.query(`UPDATE inventory.publication_variant_mapping_heads SET active_mapping_id=NULL,revision=revision+1,
      updated_by='operator',update_reason='Fixture identity retirement' WHERE publication_target_id=$1 AND product_variant_id=$2`, [targetId, productVariantId]);
    await client.query(`UPDATE inventory.publication_variant_mapping_versions SET lifecycle_status='retired',retired_by='operator',
      retired_at=transaction_timestamp() WHERE id=$1`, [head.active_mapping_id]);
  });
}
