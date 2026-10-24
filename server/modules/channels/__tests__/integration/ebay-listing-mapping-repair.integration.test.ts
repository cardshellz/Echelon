import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEbayInclusionSync } from "../../infrastructure/ebay-inclusion-sync";
import { EbaySyncSelectionReader } from "../../infrastructure/ebay-sync-selection.reader";
import { PostgresChannelSyncBatchRepository } from "../../../marketplace-listings/infrastructure/pg-channel-sync-batch.repository";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresEbayListingMappingRepairRepository, type EbayListingMappingSourceSnapshot } from "../../infrastructure/ebay-listing-mapping.repository";
import { PostgresEbayListingSyncRepository } from "../../infrastructure/ebay-listing-sync.repository";
import { PgMarketplaceListingRegistrationRepository } from "../../../marketplace-listings/infrastructure/pg-listing-registration.repository";
import { captureExistingEbayListingIdentity } from "../../ebay-existing-listing-identity";
import { isVariantSellable } from "../../ebay-listing-eligibility";
import { publicationRetryReviewHash, syncStageHash } from "../../ebay-listing-sync.domain";
import { EbayListingMappingService, type EbayListingMappingRepairPlan } from "../../ebay-listing-mapping.service";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../../ebay-listing-workflow-lock";
import { markVariantAvailabilitySynced } from "../../variant-availability-sync.repository";
import { PostgresEbayListingExclusionRepository } from "../../infrastructure/ebay-listing-exclusion.repository";
import { EbayListingWithdrawalExecution } from "../../ebay-listing-withdrawal.service";
import { EbayListingSyncService } from "../../ebay-listing-sync.service";
import { EbayPublicationCompletionExecution, type PreparedEbayPublication } from "../../ebay-publication-completion.service";
import { resolveEbayPublicationTarget } from "../../ebay-publication-completion.domain";
import { syncContentIntentHash } from "../../ebay-listing-sync-content";
import { EbayMarketplaceListingConnector, type EbayListingConnectorDraft, type EbayListingLifecycleClient, type EbayObservedOffer } from "../../listing-connectors/ebay-listing.connector";
import type { EbayInventoryItem, EbayInventoryItemGroup } from "../../adapters/ebay/ebay-types";
import type { EbayListingInspection } from "../../../marketplace-listings/domain/ebay-listing-inspection";
import { PostgresEbayPublicationRejectionReader } from "../../../inventory-planning/infrastructure/ebay-publication-rejection.reader";
import { quantityPublicationScopeLockKey } from "../../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import { ebayListingPublicationScopes } from "../../ebay-listing-request-recovery";
vi.mock("../../../../db", () => ({ pool: {} }));

const enabled = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(enabled ? describe : describe.skip).sequential("local eBay mapping repair atomicity in real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: PostgresEbayListingMappingRepairRepository;
  let canonical: PgMarketplaceListingRegistrationRepository;
  let plan: Extract<EbayListingMappingRepairPlan,{operation?:"sync"}>;
  let sequence = 20;
  const now = new Date("2026-10-10T15:00:00Z");
  beforeAll(async () => {
    // Named-schema fixture; the real sync job and repair constraints/triggers
    // below are installed verbatim. Unrelated inventory migrations are excluded.
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, `
      CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay; CREATE SCHEMA inventory; CREATE SCHEMA marketplace;
      CREATE FUNCTION inventory.reject_availability_claim_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'immutable evidence' USING ERRCODE='23514'; END $$;
      -- Read-model fixture for the inventory-owned evidence reader, including its
      -- immutable outbox/replacement/watch joins. These proof tables stay empty:
      -- Inventory's dedicated recovery suites install and exercise their actual
      -- migrations and constraints; this suite verifies Channels' read composition.
      CREATE TABLE inventory.inventory_publication_outbox(id bigserial PRIMARY KEY,activation_run_id bigint,
        publication_target_id integer,publication_target_revision_snapshot bigint,desired_revision bigint,payload_hash text,
        provider_key_snapshot text,provider_scope_type_snapshot text,destination_kind_snapshot text,
        channel_connection_id_snapshot integer,dropship_store_connection_id_snapshot integer,external_scope_id_snapshot text,
        external_inventory_item_id_snapshot text,product_variant_id integer);
      CREATE TABLE inventory.quantity_publication_attempts(id bigserial PRIMARY KEY,scope jsonb NOT NULL,affected_scope_keys text[] NOT NULL,
        started_at timestamptz NOT NULL DEFAULT '2026-10-10T15:00:00Z',state text NOT NULL DEFAULT 'uncertain',
        owner_kind text NOT NULL DEFAULT 'legacy',affected_scopes jsonb NOT NULL DEFAULT '[]',request_journal_contract jsonb,
        scope_key text,outbox_id bigint REFERENCES inventory.inventory_publication_outbox);
      CREATE TABLE inventory.quantity_provider_requests(id bigserial PRIMARY KEY,attempt_id bigint REFERENCES inventory.quantity_publication_attempts,
        ordinal integer,method text,path text,request_hash text,started_at timestamptz);
      CREATE TABLE inventory.quantity_provider_request_results(request_id bigint PRIMARY KEY REFERENCES inventory.quantity_provider_requests,
        outcome text,http_status integer,response_hash text,error_codes text[],request_terminated boolean,recorded_at timestamptz);
      CREATE TABLE inventory.ebay_publication_reconciliation_watches(id bigserial PRIMARY KEY,connection_id integer,
        external_scope_id text,scope_hash text,scopes jsonb);
      CREATE TABLE inventory.ebay_automatic_publication_recoveries(attempt_id bigint PRIMARY KEY REFERENCES inventory.quantity_publication_attempts,
        watch_id bigint REFERENCES inventory.ebay_publication_reconciliation_watches,scope_hash text,scope_keys text[],
        before_record jsonb,request_evidence jsonb);
      CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text NOT NULL);
      CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer REFERENCES channels.channels,metadata jsonb);
      CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer REFERENCES channels.channels,environment text,external_account_id text,
        external_account_identity_scheme text,external_account_verified_at timestamptz,PRIMARY KEY(channel_id,environment));
      CREATE TABLE catalog.products(id integer PRIMARY KEY,name text,sku text,is_active boolean DEFAULT true,product_type text DEFAULT 'test',ebay_listing_excluded boolean NOT NULL DEFAULT false,ebay_browse_category_id text);
      CREATE TABLE channels.channel_product_overrides(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels,product_id integer REFERENCES catalog.products,is_listed integer,created_at timestamptz,updated_at timestamptz,UNIQUE(channel_id,product_id));
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products,sku text,is_active boolean,sales_eligibility text DEFAULT 'sellable',ebay_listing_excluded boolean DEFAULT false);
      CREATE TABLE channels.channel_variant_overrides(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels,product_variant_id integer REFERENCES catalog.product_variants,is_listed integer);
      CREATE TABLE ebay.ebay_category_mappings(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels,product_type_slug text,listing_enabled boolean);
      CREATE TABLE channels.channel_listings(id integer GENERATED ALWAYS AS IDENTITY,channel_id integer REFERENCES channels.channels,
        product_variant_id integer REFERENCES catalog.product_variants,external_sku text,external_variant_id text,external_product_id text,external_url text,
        last_synced_price bigint,last_synced_qty integer,sync_status text,sync_error text,last_synced_at timestamptz,created_at timestamptz,updated_at timestamptz,
        PRIMARY KEY(channel_id,product_variant_id));
      CREATE TABLE channels.channel_feeds(channel_id integer,product_variant_id integer,channel_variant_id text,channel_inventory_item_id text,channel_sku text,
        is_active integer,last_synced_qty integer,last_synced_at timestamptz,updated_at timestamptz);
      CREATE TABLE channels.channel_variant_availability_sync(channel_id integer,product_variant_id integer,revision bigint,status text,lease_token uuid,
        lease_expires_at timestamptz,next_attempt_at timestamptz,last_synced_quantity integer,last_synced_at timestamptz,completed_at timestamptz,last_error text,updated_at timestamptz,
        PRIMARY KEY(channel_id,product_variant_id));
      CREATE TABLE marketplace.provider_accounts(id integer PRIMARY KEY,owner_kind text,channel_id integer,provider text,account_namespace text,external_account_id text);
      CREATE TABLE marketplace.listing_scopes(id integer PRIMARY KEY,owner_kind text,provider text,marketplace_id text,product_id integer);
      CREATE TABLE marketplace.channel_listing_scopes(scope_id integer,channel_id integer,product_id integer,marketplace_id text);
      CREATE TABLE marketplace.listing_publications(id integer PRIMARY KEY,scope_id integer,status text,external_listing_id text,provider_publication_key text);
      CREATE TABLE marketplace.listing_scope_provider_accounts(scope_id integer,provider_account_id integer);
      CREATE TABLE marketplace.listing_publication_members(id integer PRIMARY KEY,publication_id integer,product_variant_id integer,disposition text,
        sku_snapshot text,external_variant_id text,external_offer_id text,external_inventory_item_id text);
      CREATE TABLE marketplace.provider_identity_claims(provider_account_id integer,scope_id integer,publication_id integer,member_id integer,
        identity_role text,identity_namespace text,external_id text);
      CREATE TABLE marketplace.listing_replacement_operations(scope_id integer,status text);
      CREATE TABLE marketplace.listing_registrations(scope_id integer);
      INSERT INTO channels.channels VALUES(67,'ebay');
      INSERT INTO ebay.ebay_category_mappings(channel_id,product_type_slug,listing_enabled) VALUES(67,'test',true);
      INSERT INTO channels.channel_connections VALUES(7,67,'{"marketplaceId":"EBAY_US"}');
      INSERT INTO ebay.ebay_oauth_tokens VALUES(67,'production','account-67','provider_user_id','2026-10-01T00:00:00Z');
    `);
    const syncMigration = readFileSync(resolve(process.cwd(), "migrations/0729_ebay_listing_sync_recovery.sql"), "utf8");
    const start = syncMigration.indexOf("CREATE TABLE channels.ebay_listing_sync_jobs");
    const end = syncMigration.indexOf("CREATE TRIGGER publication_response_recoveries_no_truncate", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    await database.pool.query(syncMigration.slice(start,end));
    for (const migration of ["0731_ebay_listing_sync_verification_checkpoint.sql","0732_ebay_listing_sync_identity_admission.sql","0736_ebay_listing_mapping_repairs.sql","0737_ebay_publication_completion.sql","0741_ebay_durable_withdrawal.sql", "900000021000018880001_channel_lifecycle_recovery.sql", "900000023000018880003_listing_work_settlement.sql","900000010000018170001_ebay_saved_publication_continuation.sql","900000020000018810001_channel_sync_batches.sql"])
      await database.pool.query(readFileSync(resolve(process.cwd(),"migrations",migration),"utf8"));
    canonical = new PgMarketplaceListingRegistrationRepository(database.pool);
    repository = new PostgresEbayListingMappingRepairRepository(database.pool, { channelId:67,readSourceInsideTransaction:readSource,canonicalRegistration:canonical });
  },60000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query("DELETE FROM marketplace.provider_identity_claims; DELETE FROM marketplace.listing_publication_members; DELETE FROM marketplace.listing_scope_provider_accounts; DELETE FROM marketplace.listing_publications; DELETE FROM marketplace.channel_listing_scopes; DELETE FROM marketplace.listing_scopes; DELETE FROM marketplace.provider_accounts; DELETE FROM marketplace.listing_replacement_operations; DELETE FROM marketplace.listing_registrations");
    await database.pool.query("UPDATE ebay.ebay_oauth_tokens SET external_account_id='account-67'");
    await database.pool.query("UPDATE ebay.ebay_category_mappings SET listing_enabled=true");
    const productId = ++sequence;
    await database.pool.query("INSERT INTO catalog.products(id) VALUES($1)",[productId]);
    await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku,is_active) VALUES($1,$3,$4,true),($2,$3,$5,true)",[productId*10+1,productId*10+2,productId,`NEW-${productId}-P10`,`NEW-${productId}-C500`]);
    await database.pool.query("INSERT INTO channels.channel_product_overrides(channel_id,product_id,is_listed) VALUES(67,$1,1)",[productId]);
    await database.pool.query("INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,is_listed) VALUES(67,$1,1),(67,$2,1)",[productId*10+1,productId*10+2]);
    for (const [variantId,suffix] of [[productId*10+1,"P10"],[productId*10+2,"C500"]] as const)
      await database.pool.query(`INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,
        external_url,last_synced_price,last_synced_qty,sync_status,sync_error,last_synced_at,created_at,updated_at)
        VALUES(67,$1,$2,$3,$4,'https://old.example.test',999,57,'error','old quantity error','2026-10-01','2026-10-01','2026-10-01')`,
      [variantId,`OLD-${productId}-${suffix}`,`stale-${variantId}`,`stale-listing-${productId}`]);
    const client = await database.pool.connect();
    let snapshot: EbayListingMappingSourceSnapshot;
    try { snapshot = await readSource(client,productId); } finally { client.release(); }
    const source = { ...snapshot,candidates:snapshot.candidates.map(candidate => ({...candidate,availableQuantity:123})) };
    const provenIdentity = { ...source.identity,groupKey:`OLD-${productId}`,variants:source.identity.variants.map(member => ({...member,externalSku:member.sku,offerId:`offer-${member.variantId}`,listingId:`listing-${productId}`})) };
    plan = { source,provenIdentity,reviewHash:"1".repeat(64),requestHash:"2".repeat(64),commandKey:randomUUID(),actor:"user:42",now,
      observation:{ providerAccount:{provider:"ebay",accountNamespace:"production",externalAccountId:"account-67",identityScheme:"provider_user_id",externalDisplayNameSnapshot:null,evidenceHash:"3".repeat(64)},
        marketplaceId:"EBAY_US",publicationKeyIdentity:{externalId:`OLD-${productId}`,identityNamespace:"ebay:production:EBAY_US:inventory_item_group"},
        listingIdentity:{externalId:`listing-${productId}`,identityNamespace:"ebay:production:EBAY_US:listing"},externalUrl:`https://www.ebay.com/itm/listing-${productId}`,isPublished:true,
        members:provenIdentity.variants.map(member => ({sku:member.sku,variantIdentity:null,offerIdentity:{externalId:member.offerId!,identityNamespace:"ebay:production:EBAY_US:offer"},
          inventoryItemIdentity:{externalId:member.sku,identityNamespace:"ebay:production:EBAY_US:inventory_item"}})),evidence:{},observedAt:now} };
    plan.requestHash=syncStageHash({productId,channelId:67,actor:plan.actor,reviewHash:plan.reviewHash});
  });
  async function readSource(client: PoolClient, productId: number): Promise<EbayListingMappingSourceSnapshot> {
    const rows = (await client.query(`SELECT pv.product_id,pv.id AS variant_id,pv.sku AS variant_sku,pv.is_active,cl.id IS NOT NULL AS mapping_exists,cl.external_sku,cl.external_variant_id,cl.external_product_id
      FROM catalog.product_variants pv JOIN channels.channel_listings cl ON cl.product_variant_id=pv.id AND cl.channel_id=67 WHERE pv.product_id=$1 ORDER BY pv.id`,[productId])).rows;
    const account=(await client.query("SELECT external_account_id FROM ebay.ebay_oauth_tokens WHERE channel_id=67 AND environment='production'")).rows[0];
    const eligibility=(await client.query(`SELECT pv.id,pv.is_active,cpo.is_listed AS product_is_listed,cvo.is_listed AS variant_is_listed,ecm.listing_enabled
      FROM catalog.product_variants pv JOIN catalog.products p ON p.id=pv.product_id
      LEFT JOIN channels.channel_product_overrides cpo ON cpo.product_id=p.id AND cpo.channel_id=67
      LEFT JOIN channels.channel_variant_overrides cvo ON cvo.product_variant_id=pv.id AND cvo.channel_id=67
      LEFT JOIN ebay.ebay_category_mappings ecm ON ecm.channel_id=67 AND ecm.product_type_slug=p.product_type WHERE p.id=$1`,[productId])).rows;
    const identity=captureExistingEbayListingIdentity(rows.map(row=>{const policy=eligibility.find(member=>member.id===row.variant_id)!;return {...row,
      content_sync_enabled:isVariantSellable({productActive:true,variantActive:policy.is_active,productOverrideIsListed:policy.product_is_listed,
        variantOverrideIsListed:policy.variant_is_listed,typeListingEnabled:policy.listing_enabled})};}),{channelId:67,connectionId:7,accountId:account.external_account_id,marketplaceId:"EBAY_US"});
    return {identity,environment:"production",candidates:identity.variants.map(member => ({productVariantId:member.variantId,sku:member.sku,isActive:rows.find(row=>row.variant_id===member.variantId).is_active}))};
  }
  async function mappings() { return (await database.pool.query("SELECT * FROM channels.channel_listings WHERE product_variant_id=ANY($1::integer[]) ORDER BY product_variant_id",[plan.source.identity.variants.map(member=>member.variantId)])).rows; }
  async function counts() { return (await database.pool.query(`SELECT
    (SELECT count(*)::integer FROM channels.ebay_listing_mapping_repairs WHERE product_id=$1) AS receipts,
    (SELECT count(*)::integer FROM channels.ebay_listing_sync_jobs WHERE product_id=$1) AS jobs`,[plan.source.identity.productId])).rows[0]; }
  function lookup(overrides={}) { return {productId:plan.source.identity.productId,channelId:67,commandKey:plan.commandKey,requestHash:plan.requestHash,actor:plan.actor,...overrides}; }

  it("atomically corrects aliases/offer/listing identifiers, audits before and after, and enqueues real worker follow-up while preserving recorded values", async()=>{
    const before=await mappings(); const result=await repository.apply(plan); const after=await mappings();
    expect(result).toMatchObject({repairStatus:"queued",replayed:false,job:{state:"queued",productId:plan.source.identity.productId},receipt:{commandKey:plan.commandKey,appliedAt:now.toISOString()}});
    for(let index=0;index<after.length;index++){
      expect(after[index]).toMatchObject({external_sku:plan.provenIdentity.variants[index].sku,external_variant_id:plan.provenIdentity.variants[index].offerId,
        external_product_id:plan.provenIdentity.variants[index].listingId,last_synced_price:"999",last_synced_qty:57,sync_status:"error",sync_error:"old quantity error"});
      for(const column of ["last_synced_at","created_at"]) expect(after[index][column]).toEqual(before[index][column]);
    }
    expect(await counts()).toEqual({receipts:1,jobs:1});
    const receipt=(await database.pool.query("SELECT before_identity,after_identity,before_rows,after_rows,observation,actor FROM channels.ebay_listing_mapping_repairs WHERE command_key=$1",[plan.commandKey])).rows[0];
    expect(receipt).toMatchObject({before_identity:plan.source.identity,after_identity:plan.provenIdentity,actor:"user:42"});
    expect(receipt.before_rows[0].external_variant_id).toBe(plan.source.identity.variants[0].offerId);
    expect(receipt.after_rows[0].external_variant_id).toBe(plan.provenIdentity.variants[0].offerId);
    const claim=await new PostgresEbayListingSyncRepository(database.pool).claim(now,randomUUID(),result.job.id);
    expect(claim?.job.identity).toEqual(plan.provenIdentity); await claim?.release();
  });
  it("composes fresh diagnosis through the real repair owner and replays a lost response without more provider reads",async()=>{
    const inspect=vi.fn(async()=>({providerAccount:plan.observation.providerAccount,observedAt:now,
      skus:plan.provenIdentity.variants.map(member=>({sku:member.sku,inventoryItemExists:true,offers:[{sku:member.sku,offerId:member.offerId,
        status:"PUBLISHED",listingId:member.listingId,listingStatus:"ACTIVE"}],issue:null})),publication:plan.observation,publicationIssue:null,
      groupKey:plan.provenIdentity.groupKey,groupSkus:plan.provenIdentity.variants.map(member=>member.sku)}));
    const read=vi.fn(async(productId:number)=>{
      const client=await database.pool.connect();
      try {const source=await readSource(client,productId);return {...source,candidates:source.candidates.map(member=>({...member,availableQuantity:123}))};}
      finally{client.release();}
    });
    const service=new EbayListingMappingService({readSource:read,inspect,store:repository,now:()=>now,reportDiagnosticFailure:()=>{},
      assertCompatible:async(source,observation,identity)=>{
        await canonical.assertCompatiblePublication({owner:{kind:"channel",channelId:67,productId:source.identity.productId,provider:"ebay",marketplaceId:"EBAY_US"},
          observation,memberCandidates:source.candidates});await repository.checkMappingOwnership(identity);
      }});
    const review=await service.diagnose(plan.source.identity.productId,67);expect(review.canApply).toBe(true);
    const command={commandKey:plan.commandKey,reviewHash:review.reviewHash!};
    const result=await service.apply(plan.source.identity.productId,67,plan.actor,command);
    expect(result.receipt.reviewHash).toBe(review.reviewHash);expect(result.job.state).toBe("queued");
    const calls=inspect.mock.calls.length;read.mockRejectedValue(new Error("catalog unavailable"));inspect.mockRejectedValue(new Error("provider unavailable"));
    expect(await service.apply(plan.source.identity.productId,67,plan.actor,command)).toEqual({...result,replayed:true});
    expect(inspect).toHaveBeenCalledTimes(calls);expect(await counts()).toEqual({receipts:1,jobs:1});
  });
  it("concurrent identical commands converge on one receipt and job, and replay ignores later source changes",async()=>{
    const results=await Promise.all([repository.apply(plan),repository.apply(structuredClone(plan))]);
    expect(results.map(result=>result.replayed).sort()).toEqual([false,true]);
    expect(results[0].job.id).toBe(results[1].job.id); expect(await counts()).toEqual({receipts:1,jobs:1});
    await database.pool.query("UPDATE catalog.product_variants SET sku='LATER' WHERE id=$1",[plan.source.identity.variants[0].variantId]);
    expect((await repository.findReplay(lookup()))?.replayed).toBe(true);
    expect((await repository.apply(plan)).replayed).toBe(true);
  });
  it("rejects command reuse by another product, review or actor",async()=>{
    await repository.apply(plan);
    for(const overrides of [{productId:999},{requestHash:"4".repeat(64)},{actor:"user:43"}])
      await expect(repository.findReplay(lookup(overrides))).rejects.toMatchObject({code:"EBAY_MAPPING_COMMAND_CONFLICT"});
  });
  it("does not repurpose an ordinary sync command as a repair receipt",async()=>{
    await new PostgresEbayListingSyncRepository(database.pool).enqueue(plan.provenIdentity,plan.commandKey,plan.actor,now);
    const before=await mappings();
    await expect(repository.apply(plan)).rejects.toMatchObject({code:"EBAY_MAPPING_COMMAND_CONFLICT"});
    expect(await mappings()).toEqual(before);expect(await counts()).toEqual({receipts:0,jobs:1});
  });
  function refusal() { return {productId:plan.source.identity.productId,channelId:67,commandKey:plan.commandKey,reviewHash:plan.reviewHash,
    requestHash:plan.requestHash,actor:plan.actor,code:"EBAY_MAPPING_REVIEW_STALE",message:"The review changed. Check again.",now}; }
  it("does not record ambiguous persistence or provider failures as definite refusals",async()=>{
    for(const code of ["EBAY_MAPPING_PERSISTENCE_FAILED","EBAY_QUANTITY_RESPONSE_UNCERTAIN","PUBLICATION_SCOPE_BUSY","EBAY_MAPPING_COMMAND_CONFLICT"])
      await expect(repository.rejectReviewedCommand({...refusal(),code})).rejects.toMatchObject({code:"EBAY_MAPPING_REJECTION_INVALID"});
    expect(await repository.findReplay(lookup())).toBeNull();
    expect((await repository.apply(plan)).job.state).toBe("queued");
  });
  it("a durable refusal prevents slower same-command confirmation and ordinary sync from committing later",async()=>{
    let release!:()=>void; const gate=new Promise<void>(resolve=>{release=resolve;});
    const slower=gate.then(()=>repository.apply(plan)).catch(error=>error);
    await expect(repository.rejectReviewedCommand(refusal())).rejects.toMatchObject({code:"EBAY_MAPPING_REVIEW_STALE"});
    release();expect(await slower).toMatchObject({code:"EBAY_MAPPING_REVIEW_STALE"});
    expect(await counts()).toEqual({receipts:0,jobs:0});
    await expect(repository.findReplay(lookup())).rejects.toMatchObject({code:"EBAY_MAPPING_REVIEW_STALE"});
    await expect(repository.findReplay(lookup({requestHash:"9".repeat(64)}))).rejects.toMatchObject({code:"EBAY_MAPPING_COMMAND_CONFLICT"});
    await expect(new PostgresEbayListingSyncRepository(database.pool).enqueue(plan.provenIdentity,plan.commandKey,plan.actor,now)).rejects.toMatchObject({code:"23514"});
    expect(await counts()).toEqual({receipts:0,jobs:0});
    await expect(database.pool.query("DELETE FROM channels.ebay_listing_mapping_rejections WHERE command_key=$1",[plan.commandKey])).rejects.toMatchObject({code:"23514"});
  });
  it("a repair that commits while a competing refusal waits returns its receipt to both callers",async()=>{
    let ready!:()=>void, release!:()=>void;
    const entered=new Promise<void>(resolve=>{ready=resolve;}); const paused=new Promise<void>(resolve=>{release=resolve;});
    const blocking=new PostgresEbayListingMappingRepairRepository(database.pool,{channelId:67,canonicalRegistration:canonical,
      readSourceInsideTransaction:async(client,productId)=>{ready();await paused;return readSource(client,productId);}});
    const applying=blocking.apply(plan); await entered;
    const rejection=repository.rejectReviewedCommand(refusal());
    try {
      await vi.waitFor(async()=>{const waiting=await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'");expect(waiting.rowCount).toBe(1);});
      release();const [applied,received]=await Promise.all([applying,rejection]);
      expect(received).toEqual({...applied,replayed:true});expect(await counts()).toEqual({receipts:1,jobs:1});
      expect((await database.pool.query("SELECT count(*)::integer AS count FROM channels.ebay_listing_mapping_rejections WHERE command_key=$1",[plan.commandKey])).rows[0].count).toBe(0);
    } finally {release();}
  });
  it.each(["catalog","account","offer","member"])("rejects a stale %s snapshot without local writes or follow-up",async(kind)=>{
    const first=plan.source.identity.variants[0];
    if(kind==="catalog")await database.pool.query("UPDATE catalog.product_variants SET sku='RENAMED' WHERE id=$1",[first.variantId]);
    if(kind==="account")await database.pool.query("UPDATE ebay.ebay_oauth_tokens SET external_account_id='other-account'");
    if(kind==="offer")await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='newer-offer' WHERE product_variant_id=$1",[first.variantId]);
    if(kind==="member")await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=$1",[first.variantId]);
    const before=await mappings(); await expect(repository.apply(plan)).rejects.toMatchObject({code:expect.stringMatching(/EBAY_(MAPPING_REVIEW_CHANGED|SYNC_IDENTITY_CHANGED)/)});
    expect(await mappings()).toEqual(before);expect(await counts()).toEqual({receipts:0,jobs:0});
  });
  it("blocks while a live sync or push owns the shared workflow",async()=>{
    const client=await database.pool.connect();
    try {await client.query("SELECT pg_advisory_lock($1,hashtext($2))",[EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,ebayListingWorkflowLockKey(67,plan.source.identity.productId)]);
      await expect(repository.apply(plan)).rejects.toMatchObject({code:"PUBLICATION_SCOPE_BUSY"});
      expect(await counts()).toEqual({receipts:0,jobs:0});
    } finally {await client.query("SELECT pg_advisory_unlock_all()");client.release();}
  });
  it("rejects another product's existing or concurrently committed provider mapping",async()=>{
    const client=await database.pool.connect(); const other=++sequence;
    await database.pool.query("INSERT INTO catalog.products(id) VALUES($1)",[other]);
    await database.pool.query("INSERT INTO catalog.product_variants VALUES($1,$2,'OTHER',true)",[other*10,other]);
    await client.query("BEGIN");
    await client.query("INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,external_product_id) VALUES(67,$1,$2,$3,$4)",
      [other*10,plan.provenIdentity.variants[0].sku,plan.provenIdentity.variants[0].offerId,plan.provenIdentity.variants[0].listingId]);
    const outcome=repository.apply(plan).then(()=>null,error=>error);
    try { await vi.waitFor(async()=>{const waiting=await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'LOCK TABLE channels.channel_listings%' OR query LIKE 'SELECT id FROM channels.channels%')");expect(waiting.rowCount).toBe(1);});
      await client.query("COMMIT"); expect(await outcome).toMatchObject({code:"EBAY_MAPPING_OWNERSHIP_CONFLICT"});
      expect(await counts()).toEqual({receipts:0,jobs:0});
      await expect(repository.apply(plan)).rejects.toMatchObject({code:"EBAY_MAPPING_OWNERSHIP_CONFLICT"});
    }finally{await client.query("ROLLBACK");client.release();}
  });
  it("waits for registration account ownership before locking catalog variants or the listing table",async()=>{
    const registration=await database.pool.connect();
    await registration.query("BEGIN");
    await registration.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(["ebay","production","account-67"])]);
    const applying=repository.apply(plan).then(value=>({value}),error=>({error}));
    try {
      await vi.waitFor(async()=>{const waiting=await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%hashtextextended%'");expect(waiting.rowCount).toBe(1);});
      // A registration that already owns the account can finish its later
      // catalog work; a projector can likewise acquire the listing table lock.
      await registration.query("SELECT id FROM catalog.product_variants WHERE product_id=$1 FOR SHARE NOWAIT",[plan.source.identity.productId]);
      await registration.query("LOCK TABLE channels.channel_listings IN ROW EXCLUSIVE MODE NOWAIT");
      await registration.query("COMMIT");expect(await applying).toMatchObject({value:{job:{state:"queued"}}});
    } finally {await registration.query("ROLLBACK");registration.release();}
  });
  it("waits for verification catalog locks before claiming canonical scope or account rows",async()=>{
    await seedCanonical();
    const verification=await database.pool.connect();await verification.query("BEGIN");
    await verification.query("SELECT id FROM catalog.product_variants WHERE product_id=$1 FOR SHARE",[plan.source.identity.productId]);
    const applying=repository.apply(plan).then(value=>({value}),error=>({error}));
    try {
      await vi.waitFor(async()=>{const waiting=await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM catalog.product_variants%FOR UPDATE'");expect(waiting.rowCount).toBe(1);});
      await verification.query("SELECT id FROM marketplace.listing_scopes WHERE id=1 FOR UPDATE NOWAIT");
      await verification.query("SELECT id FROM marketplace.provider_accounts WHERE id=1 FOR UPDATE NOWAIT");
      await verification.query("COMMIT");expect(await applying).toMatchObject({value:{job:{state:"queued"}}});
    } finally {await verification.query("ROLLBACK");verification.release();}
  });
  it.each(["product","variant","type"])("holds existing %s eligibility through the atomic source fence and enqueue",async(kind)=>{
    let ready!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{ready=resolve;});const paused=new Promise<void>(resolve=>{release=resolve;});
    const blocking=new PostgresEbayListingMappingRepairRepository(database.pool,{channelId:67,canonicalRegistration:canonical,
      readSourceInsideTransaction:async(client,productId)=>{const source=await readSource(client,productId);ready();await paused;return source;}});
    const applying=blocking.apply(plan);await entered;
    const writer=await database.pool.connect();const pid=(await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    try {
      const changing=kind==="product"
        ? writer.query("UPDATE channels.channel_product_overrides SET is_listed=0 WHERE channel_id=67 AND product_id=$1",[plan.source.identity.productId])
        : kind==="variant"
          ? writer.query("UPDATE channels.channel_variant_overrides SET is_listed=0 WHERE channel_id=67 AND product_variant_id=$1",[plan.source.identity.variants[0].variantId])
          : writer.query("UPDATE ebay.ebay_category_mappings SET listing_enabled=false WHERE channel_id=67 AND product_type_slug='test'");
      await vi.waitFor(async()=>{const state=(await database.pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0];expect(state.wait_event_type).toBe("Lock");});
      release();const result=await applying;await changing;
      const queued=await new PostgresEbayListingSyncRepository(database.pool).get(result.job.id);
      expect(queued.identity.variants.every(member=>member.contentSyncEnabled===true)).toBe(true);
      const fresh=await readSource(writer,plan.source.identity.productId);
      expect(fresh.identity.variants.some(member=>member.contentSyncEnabled===false)).toBe(true);
      // An independent edit after commit is intentionally visible to the normal
      // worker source fence; it cannot change what this repair transaction saw.
      expect(await counts()).toEqual({receipts:1,jobs:1});
    } finally {release();await applying;writer.release();}
  });
  it("rolls mapping and queued work back if receipt persistence fails after enqueue",async()=>{
    const before=await mappings();
    await database.pool.query(`CREATE FUNCTION channels.test_repair_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected audit failure';END $$;
      CREATE TRIGGER test_repair_failure BEFORE INSERT ON channels.ebay_listing_mapping_repairs FOR EACH ROW EXECUTE FUNCTION channels.test_repair_failure()`);
    try {await expect(repository.apply(plan)).rejects.toMatchObject({code:"EBAY_MAPPING_PERSISTENCE_FAILED"});
      expect(await mappings()).toEqual(before);expect(await counts()).toEqual({receipts:0,jobs:0});
    }finally{await database.pool.query("DROP TRIGGER test_repair_failure ON channels.ebay_listing_mapping_repairs; DROP FUNCTION channels.test_repair_failure()");}
  });
  it("supersedes an idle old-source job while retaining its immutable command/evidence",async()=>{
    const sync=new PostgresEbayListingSyncRepository(database.pool);const old=await sync.enqueue(plan.source.identity,randomUUID(),"user:42",new Date(now.getTime()-1000));
    const repaired=await repository.apply(plan);
    expect(repaired.job.id).not.toBe(old.id);expect((await sync.get(old.id)).code).toBe("EBAY_SYNC_SOURCE_SUPERSEDED");
    expect(await counts()).toEqual({receipts:1,jobs:2});
  });
  async function alreadyCurrentMapping() {
    for(const member of plan.provenIdentity.variants) await database.pool.query("UPDATE channels.channel_listings SET external_variant_id=$2,external_product_id=$3 WHERE product_variant_id=$1",[member.variantId,member.offerId,member.listingId]);
    plan.source.identity={...plan.provenIdentity,groupKey:null};
  }
  it("coalesces a matching queued job with old group hint and missing optional snapshots without rewriting its identity",async()=>{
    await alreadyCurrentMapping();
    const sync=new PostgresEbayListingSyncRepository(database.pool);
    const legacy={...plan.source.identity,groupKey:"old-catalog-hint",variants:[...plan.source.identity.variants].reverse().map(({catalogSku:_catalog,contentSyncEnabled:_enabled,...member})=>member)};
    const old=await sync.enqueue(legacy,randomUUID(),plan.actor,now);
    const result=await repository.apply(plan);
    expect(result.job.id).toBe(old.id);expect((await sync.get(old.id)).identity).toEqual(legacy);
    const receipt=(await database.pool.query("SELECT queued_identity,after_identity FROM channels.ebay_listing_mapping_repairs WHERE command_key=$1",[plan.commandKey])).rows[0];
    expect(receipt.queued_identity).toEqual(legacy);expect(receipt.after_identity).toEqual(plan.provenIdentity);
    expect(await counts()).toEqual({receipts:1,jobs:1});
  });
  it("supersedes an idle job bound to an earlier actual group and preserves its original evidence",async()=>{
    await alreadyCurrentMapping();
    const sync=new PostgresEbayListingSyncRepository(database.pool);
    const old=await sync.enqueue(plan.source.identity,randomUUID(),plan.actor,now);
    const claim=await sync.claim(now,randomUUID(),old.id);expect(claim).not.toBeNull();
    const previous={...plan.provenIdentity,groupKey:"previous-provider-group"};
    await sync.bindProviderIdentity(claim!.job,previous,now);
    await sync.finish(claim!.job,{state:"awaiting_evidence",result:null,code:"EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",message:"Old request remains unknown",nextAttemptAt:now},now);
    await claim!.release();
    const result=await repository.apply(plan);
    expect(result.job.id).not.toBe(old.id);
    expect(await sync.get(old.id)).toMatchObject({state:"needs_attention",code:"EBAY_SYNC_SOURCE_SUPERSEDED",providerIdentity:previous});
    expect((await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND evidence->>'key'='provider_identity'",[old.id])).rows[0].evidence.identity).toEqual(previous);
    expect(await counts()).toEqual({receipts:1,jobs:2});
  });
  it("makes receipts immutable and refuses fabricated after-state evidence at commit",async()=>{
    await repository.apply(plan);
    await expect(database.pool.query("UPDATE channels.ebay_listing_mapping_repairs SET actor='changed' WHERE command_key=$1",[plan.commandKey])).rejects.toMatchObject({code:"23514"});
    await expect(database.pool.query("DELETE FROM channels.ebay_listing_mapping_repairs WHERE command_key=$1",[plan.commandKey])).rejects.toMatchObject({code:"23514"});
    await expect(database.pool.query("TRUNCATE channels.ebay_listing_mapping_repairs")).rejects.toMatchObject({code:"23514"});
    const client=await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))",[EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE,ebayListingWorkflowLockKey(67,plan.source.identity.productId)]);
      const command=randomUUID();
      const job=await new PostgresEbayListingSyncRepository(database.pool).enqueueInsideTransaction(client,plan.provenIdentity,command,plan.actor,now);
      await client.query(`INSERT INTO channels.ebay_listing_mapping_repairs(command_key,channel_id,connection_id,product_id,environment,
        request_hash,review_hash,actor,before_identity,after_identity,queued_identity,before_rows,after_rows,observation,job_id,applied_at)
        SELECT $1,channel_id,connection_id,product_id,environment,request_hash,review_hash,actor,before_identity,after_identity,queued_identity,before_rows,
          jsonb_set(after_rows,'{0,last_synced_qty}','0'::jsonb),observation,$2,applied_at FROM channels.ebay_listing_mapping_repairs WHERE command_key=$3`,
      [command,job.id,plan.commandKey]);
      await expect(client.query("COMMIT")).rejects.toMatchObject({code:"23514"});
    }finally{await client.query("ROLLBACK");client.release();}
  });
  it("refuses conflicting canonical identity claims without modifying either owner",async()=>{
    await database.pool.query("INSERT INTO marketplace.provider_accounts VALUES(1,'channel',67,'ebay','production','account-67')");
    await database.pool.query("INSERT INTO marketplace.provider_identity_claims VALUES(1,999,999,NULL,'listing_id','ebay:production:EBAY_US:listing',$1)",[plan.observation.listingIdentity.externalId]);
    const before=await mappings();await expect(repository.apply(plan)).rejects.toMatchObject({code:"EBAY_MAPPING_CANONICAL_CONFLICT"});
    expect(await mappings()).toEqual(before);expect(await counts()).toEqual({receipts:0,jobs:0});
  });
  async function seedCanonical(){
    const productId=plan.source.identity.productId;
    await database.pool.query("INSERT INTO marketplace.provider_accounts VALUES(1,'channel',67,'ebay','production','account-67')");
    await database.pool.query("INSERT INTO marketplace.listing_scopes VALUES(1,'channel','ebay','EBAY_US',$1)",[productId]);
    await database.pool.query("INSERT INTO marketplace.channel_listing_scopes VALUES(1,67,$1,'EBAY_US')",[productId]);
    await database.pool.query("INSERT INTO marketplace.listing_publications VALUES(1,1,'active',$1,$2)",[plan.observation.listingIdentity.externalId,plan.provenIdentity.groupKey]);
    await database.pool.query("INSERT INTO marketplace.listing_scope_provider_accounts VALUES(1,1)");
    for(const member of plan.provenIdentity.variants) await database.pool.query("INSERT INTO marketplace.listing_publication_members VALUES($1,1,$1,'included',$2,NULL,$3,$2)",[member.variantId,member.sku,member.offerId]);
  }
  it("permits an exact canonical active publication and refuses changed group or unfinished canonical replacement",async()=>{
    await seedCanonical();
    await database.pool.query("UPDATE marketplace.listing_publications SET provider_publication_key='different-group'");
    await expect(repository.apply(plan)).rejects.toMatchObject({code:"EBAY_MAPPING_CANONICAL_CONFLICT"});
    await database.pool.query("UPDATE marketplace.listing_publications SET provider_publication_key=$1",[plan.provenIdentity.groupKey]);
    await database.pool.query("INSERT INTO marketplace.listing_replacement_operations VALUES(1,'running')");
    await expect(repository.apply(plan)).rejects.toMatchObject({code:"EBAY_MAPPING_CANONICAL_CONFLICT"});
    await database.pool.query("DELETE FROM marketplace.listing_replacement_operations");
    expect((await repository.apply(plan)).job.state).toBe("queued");
  });

  async function publicationPlan(): Promise<Extract<EbayListingMappingRepairPlan,{operation:"publish"}>> {
    await database.pool.query("UPDATE channels.channel_listings SET external_sku=NULL,external_product_id=NULL WHERE product_variant_id=ANY($1::integer[])",
      [plan.source.identity.variants.map(member=>member.variantId)]);
    const client=await database.pool.connect();
    let snapshot:EbayListingMappingSourceSnapshot;
    try{snapshot=await readSource(client,plan.source.identity.productId);}finally{client.release();}
    const source={...snapshot,candidates:snapshot.candidates.map(candidate=>({...candidate,availableQuantity:123}))};
    const targetIdentity={...source.identity,groupKey:`actual-provider-group-${source.identity.productId}`};
    return {operation:"publish",source,targetIdentity,commandKey:plan.commandKey,reviewHash:plan.reviewHash,requestHash:plan.requestHash,actor:plan.actor,now,
      inspectionEvidence:{providerAccount:plan.observation.providerAccount,observedAt:now,publication:null,publicationIssue:null,
        groupKey:targetIdentity.groupKey,groupSkus:targetIdentity.variants.map(member=>member.sku),
        unpublishedTarget:{groupKey:targetIdentity.groupKey,skus:targetIdentity.variants.map(member=>member.sku)},
        skus:targetIdentity.variants.map(member=>({sku:member.sku,inventoryItemExists:true,issue:null,
          offers:[{sku:member.sku,offerId:member.offerId!,status:"UNPUBLISHED",listingId:null,listingStatus:null}]}))}};
  }
  async function claimedPublication(withRejectionReader = false) {
    const publish=await publicationPlan();
    const saved=await repository.apply(publish);
    const sync=new PostgresEbayListingSyncRepository(database.pool, withRejectionReader ? new PostgresEbayPublicationRejectionReader(database.pool) : undefined);
    const claim=await sync.claim(now,randomUUID(),saved.job.id);expect(claim).not.toBeNull();
    const target={...publish.targetIdentity,variants:publish.targetIdentity.variants.map(member=>({...member,externalSku:member.sku}))};
    const final={...target,variants:target.variants.map(member=>({...member,listingId:`published-${target.productId}`}))};
    const result={synced:target.variants.length,priceChanges:0,qtyChanges:0,policyChanges:0,errors:0,pending:0,jobs:[],
      details:target.variants.map(member=>({variantId:member.variantId,variantSku:member.sku,success:true,lastSyncedPriceCents:1249}))};
    return {publish,saved,sync,claim:claim!,target,final,result};
  }
  function publicationObservation(identity: typeof plan.provenIdentity) {
    return { ...plan.observation, publicationKeyIdentity: identity.groupKey === null ? null : { identityNamespace: "ebay:production:EBAY_US:inventory_item_group", externalId: identity.groupKey },
      listingIdentity: { identityNamespace: "ebay:production:EBAY_US:listing", externalId: identity.variants[0].listingId! },
      members: identity.variants.map(member => ({ sku: member.sku, variantIdentity: null,
        offerIdentity: { identityNamespace: "ebay:production:EBAY_US:offer", externalId: member.offerId! },
        inventoryItemIdentity: { identityNamespace: "ebay:production:EBAY_US:inventory_item", externalId: member.sku } })) };
  }
  async function verifyPublication(sync:PostgresEbayListingSyncRepository,job:Awaited<ReturnType<PostgresEbayListingSyncRepository["get"]>>) {
    await sync.stage(job,"verification","8".repeat(64),"started",now);
    await sync.stage(job,"verification","8".repeat(64),"completed",now);
  }
  it("queues reviewed unpublished saved offers without changing mappings or claiming publication, and replays its receipt",async()=>{
    const publish=await publicationPlan();const before=await mappings();
    const saved=await repository.apply(publish);
    expect(saved.job).toMatchObject({operation:"publish",state:"queued"});expect(await mappings()).toEqual(before);
    const receipt=(await database.pool.query("SELECT operation,before_identity,after_identity,before_rows,after_rows,observation FROM channels.ebay_listing_mapping_repairs WHERE command_key=$1",[publish.commandKey])).rows[0];
    expect(receipt).toMatchObject({operation:"publish",before_identity:publish.source.identity,after_identity:publish.source.identity,observation:{kind:"unpublished_inspection"}});
    expect(receipt.before_rows).toEqual(receipt.after_rows);
    expect(await repository.findReplay(lookup())).toEqual({...saved,replayed:true});
    expect((await new PostgresEbayListingSyncRepository(database.pool).list(67)).find(job=>job.id===saved.job.id)?.operation).toBe("publish");
  });
  it.each(["inventory_item_group","inventory_item","offer"] as const)("refuses unpublished %s already claimed in the canonical eBay namespace",async role=>{
    const publish=await publicationPlan();
    const externalId=role==="inventory_item_group"?publish.targetIdentity.groupKey!:
      role==="inventory_item"?publish.targetIdentity.variants[0].sku:publish.targetIdentity.variants[0].offerId!;
    await database.pool.query("INSERT INTO marketplace.provider_accounts VALUES(1,'channel',67,'ebay','production','account-67')");
    await database.pool.query("INSERT INTO marketplace.provider_identity_claims VALUES(1,999,999,NULL,$1,$2,$3)",
      [role,`ebay:production:EBAY_US:${role}`,externalId]);
    const before=await mappings();
    await expect(repository.apply(publish)).rejects.toMatchObject({code:"EBAY_MAPPING_CANONICAL_CONFLICT"});
    expect(await mappings()).toEqual(before);expect(await counts()).toEqual({receipts:0,jobs:0});
    expect((await database.pool.query("SELECT identity_namespace,external_id FROM marketplace.provider_identity_claims")).rows)
      .toEqual([{identity_namespace:`ebay:production:EBAY_US:${role}`,external_id:externalId}]);
  });
  it("does not confuse an identity claim from another marketplace with this unpublished listing",async()=>{
    const publish=await publicationPlan();
    await database.pool.query("INSERT INTO marketplace.provider_accounts VALUES(1,'channel',67,'ebay','production','account-67')");
    await database.pool.query("INSERT INTO marketplace.provider_identity_claims VALUES(1,999,999,NULL,'offer','ebay:production:EBAY_GB:offer',$1)",
      [publish.targetIdentity.variants[0].offerId]);
    expect((await repository.apply(publish)).job).toMatchObject({operation:"publish",state:"queued"});
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM marketplace.provider_identity_claims")).rows[0].count).toBe(1);
  });
  it("validates unpublished eBay environment and marketplace before reading or changing compatibility state",async()=>{
    const publish=await publicationPlan();
    const input={owner:{kind:"channel" as const,channelId:67,productId:publish.source.identity.productId,provider:"ebay",marketplaceId:"EBAY_US"},
      providerAccount:{provider:"ebay" as const,accountNamespace:"production" as const,externalAccountId:"account-67"},
      groupKey:publish.targetIdentity.groupKey,members:publish.targetIdentity.variants.map(member=>({productVariantId:member.variantId,sku:member.sku,offerId:member.offerId}))};
    await expect(canonical.assertCompatibleUnpublishedPublication({...input,owner:{...input.owner,marketplaceId:"EBAY_US:offer"}}))
      .rejects.toMatchObject({code:"EBAY_REGISTRATION_MARKETPLACE_INVALID"});
    const invalidEnvironment=JSON.parse(JSON.stringify(input));invalidEnvironment.providerAccount.accountNamespace="other";
    await expect(canonical.assertCompatibleUnpublishedPublication(invalidEnvironment)).rejects.toThrow();
    expect(await counts()).toEqual({receipts:0,jobs:0});
  });
  it("keeps publish commands immutable and refuses reuse for maintenance sync",async()=>{
    const publish=await publicationPlan();const sync=new PostgresEbayListingSyncRepository(database.pool);
    const saved=await sync.enqueue(publish.targetIdentity,publish.commandKey,publish.actor,now,"publish");
    await expect(sync.enqueue(publish.targetIdentity,publish.commandKey,publish.actor,now,"sync")).rejects.toMatchObject({code:"EBAY_SYNC_REPLAY_CONFLICT"});
    await expect(database.pool.query("UPDATE channels.ebay_listing_sync_jobs SET operation='sync' WHERE id=$1",[saved.id])).rejects.toMatchObject({code:"23514"});
  });
  it("pins publication target under exact worker ownership and refuses target replacement or unverified completion",async()=>{
    const fixture=await claimedPublication();const {sync,claim,target,result}=fixture;
    try{
      await expect(sync.bindPublicationTarget({...claim.job,ownerToken:randomUUID()},target,now)).rejects.toMatchObject({code:"EBAY_SYNC_OWNER_LOST"});
      await sync.bindPublicationTarget(claim.job,target,now);
      await sync.bindPublicationTarget(claim.job,target,now);
      await expect(sync.bindPublicationTarget(claim.job,{...target,groupKey:"another-group"},now)).rejects.toMatchObject({code:"EBAY_SYNC_PROVIDER_IDENTITY_CHANGED"});
      await expect(sync.finish(claim.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now)).rejects.toMatchObject({code:"EBAY_SYNC_PUBLICATION_UNVERIFIED"});
      expect((await sync.get(claim.job.id)).state).toBe("running");
    }finally{await claim.release();}
  });
  it("defers projection for a newer requested revision, then completes the latest verified content while preserving quantity",async()=>{
    const {sync,claim,target,final,result,publish}=await claimedPublication();
    try{
      await sync.bindPublicationTarget(claim.job,target,now);await sync.bindProviderIdentity(claim.job,final,now,publicationObservation(final));await verifyPublication(sync,claim.job);
      const joined=await sync.enqueue(publish.targetIdentity,randomUUID(),plan.actor,now,"publish");expect(joined.id).toBe(claim.job.id);
      await sync.finish(claim.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now);
      expect((await sync.get(claim.job.id)).state).toBe("queued");expect((await mappings()).every(row=>row.external_product_id===null)).toBe(true);
      await claim.release();
      const latest=await sync.claim(now,randomUUID(),claim.job.id);expect(latest).not.toBeNull();
      try{
        await expect(sync.finish(latest!.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now)).rejects.toMatchObject({code:"EBAY_SYNC_PUBLICATION_UNVERIFIED"});
        await verifyPublication(sync,latest!.job);await sync.finish(latest!.job,{state:"completed",result:{...result,details:result.details.map(detail=>({...detail,lastSyncedPriceCents:1499}))},code:null,message:null,nextAttemptAt:now},now);}
      finally{await latest!.release();}
      expect((await sync.get(claim.job.id)).state).toBe("completed");
      const rows=await mappings();
      expect(rows.map(row=>row.external_product_id)).toEqual(final.variants.map(member=>member.listingId));
      for(const row of rows) expect(row).toMatchObject({last_synced_qty:57,last_synced_price:"1499",sync_status:"synced",sync_error:null,external_url:"https://old.example.test"});
    }finally{await claim.release();}
  });
  it("rejects changed mappings and rolls back every publication projection while preserving verified provider evidence",async()=>{
    const {sync,claim,target,final,result}=await claimedPublication();
    try{
      await sync.bindPublicationTarget(claim.job,target,now);await sync.bindProviderIdentity(claim.job,final,now,publicationObservation(final));await verifyPublication(sync,claim.job);
      await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='concurrent-other-offer' WHERE product_variant_id=$1",[target.variants[1].variantId]);
      const before=await mappings();
      await expect(sync.finish(claim.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now)).rejects.toMatchObject({code:"EBAY_SYNC_PROJECTION_IDENTITY_CHANGED"});
      expect(await mappings()).toEqual(before);expect(await sync.get(claim.job.id)).toMatchObject({state:"running",providerIdentity:final});
    }finally{await claim.release();}
  });
  it.each(["local", "canonical", "account"] as const)("rechecks %s ownership at final publication commit after provider verification", async kind => {
    const {sync,claim,target,final,result}=await claimedPublication();
    try {
      await sync.bindPublicationTarget(claim.job,target,now);
      await sync.bindProviderIdentity(claim.job,final,now,publicationObservation(final));
      await verifyPublication(sync,claim.job);
      if (kind === "canonical") {
        await database.pool.query("INSERT INTO marketplace.provider_accounts VALUES(1,'channel',67,'ebay','production','account-67')");
        await database.pool.query("INSERT INTO marketplace.provider_identity_claims VALUES(1,999,999,NULL,'offer_id','ebay:production:EBAY_US:offer',$1)",[final.variants[0].offerId]);
      } else if (kind === "local") {
        const otherVariant = target.variants[0].variantId + 900000;
        await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku,is_active) VALUES($1,$2,'unrelated',true)", [otherVariant,target.productId]);
        await database.pool.query("INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_variant_id) VALUES(67,$1,$2)",[otherVariant,final.variants[0].offerId]);
      } else {
        await database.pool.query("UPDATE ebay.ebay_oauth_tokens SET external_account_id='another-account' WHERE channel_id=67");
      }
      const before=await mappings();
      await expect(sync.finish(claim.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now)).rejects.toMatchObject({code:
        kind === "canonical" ? "EBAY_MAPPING_CANONICAL_CONFLICT" : kind === "local" ? "EBAY_MAPPING_OWNERSHIP_CONFLICT" : "EBAY_SYNC_ACCOUNT_CHANGED"});
      expect(await mappings()).toEqual(before);
      expect(await sync.get(claim.job.id)).toMatchObject({state:"running",providerIdentity:final});
    } finally { await claim.release(); }
  });
  it("waits for a concurrent legacy mapping writer and rejects its newly committed conflicting offer before publication projection",async()=>{
    const {sync,claim,target,final,result}=await claimedPublication();const writer=await database.pool.connect();
    try{
      await sync.bindPublicationTarget(claim.job,target,now);
      await sync.bindProviderIdentity(claim.job,final,now,publicationObservation(final));await verifyPublication(sync,claim.job);
      const other=++sequence;await database.pool.query("INSERT INTO catalog.products(id) VALUES($1)",[other]);
      await database.pool.query("INSERT INTO catalog.product_variants VALUES($1,$2,'CONCURRENT-OTHER',true)",[other*10,other]);
      const before=await mappings();
      await writer.query("BEGIN");
      await writer.query("INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_variant_id) VALUES(67,$1,$2)",[other*10,final.variants[0].offerId]);
      const finishing=sync.finish(claim.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now).then(()=>null,error=>error);
      await vi.waitFor(async()=>{
        const waiting=await database.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'LOCK TABLE channels.channel_listings%' OR query LIKE 'SELECT id FROM channels.channels%')");
        expect(waiting.rowCount).toBe(1);
      });
      await writer.query("COMMIT");
      expect(await finishing).toMatchObject({code:"EBAY_MAPPING_OWNERSHIP_CONFLICT"});
      expect(await mappings()).toEqual(before);expect(await sync.get(claim.job.id)).toMatchObject({state:"running",providerIdentity:final});
    }finally{await writer.query("ROLLBACK");writer.release();await claim.release();}
  });
  it("rejects incomplete completion and rolls back local projection on completion audit failure",async()=>{
    const {sync,claim,target,final,result}=await claimedPublication();
    try{
      await sync.bindPublicationTarget(claim.job,target,now);await sync.bindProviderIdentity(claim.job,final,now,publicationObservation(final));await verifyPublication(sync,claim.job);
      await expect(sync.finish(claim.job,{state:"completed",result:{...result,details:result.details.slice(0,1)},code:null,message:null,nextAttemptAt:now},now)).rejects.toMatchObject({code:"EBAY_SYNC_RESULT_SCOPE_INVALID"});
      const before=await mappings();
      await database.pool.query(`CREATE FUNCTION channels.test_publish_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event='completed' THEN RAISE EXCEPTION 'injected completion failure';END IF;RETURN NEW;END $$;
        CREATE TRIGGER test_publish_audit_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_publish_audit_failure()`);
      try{await expect(sync.finish(claim.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now)).rejects.toMatchObject({code:"EBAY_SYNC_PERSISTENCE_FAILED"});
        expect(await mappings()).toEqual(before);expect((await sync.get(claim.job.id)).state).toBe("running");
      }finally{await database.pool.query("DROP TRIGGER test_publish_audit_failure ON channels.ebay_listing_sync_events;DROP FUNCTION channels.test_publish_audit_failure()");}
      await sync.finish(claim.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now);
      expect((await sync.get(claim.job.id)).state).toBe("completed");
    }finally{await claim.release();}
  });
  it("refuses unpublished completion when another canonical scope owns any exact offer or SKU",async()=>{
    const publish=await publicationPlan();
    await database.pool.query("INSERT INTO marketplace.provider_accounts VALUES(1,'channel',67,'ebay','production','account-67')");
    await database.pool.query("INSERT INTO marketplace.provider_identity_claims VALUES(1,999,999,NULL,'offer_id','ebay:production:EBAY_US:offer',$1)",[publish.targetIdentity.variants[0].offerId]);
    await expect(repository.apply(publish)).rejects.toMatchObject({code:"EBAY_MAPPING_CANONICAL_CONFLICT"});expect(await counts()).toEqual({receipts:0,jobs:0});
  });
  it("requires existing canonical publication lifecycle recovery instead of publishing an unpublished replacement",async()=>{
    await seedCanonical();const publish=await publicationPlan();
    await expect(repository.apply(publish)).rejects.toMatchObject({code:"EBAY_MAPPING_CANONICAL_CONFLICT"});expect(await counts()).toEqual({receipts:0,jobs:0});
  });
  it("retains exact accepted response and publish stage evidence across worker restart, refusing changed response identities",async()=>{
    const {sync,claim,target,final}=await claimedPublication();
    try{
      await sync.bindPublicationTarget(claim.job,target,now);
      await sync.stage(claim.job,"publish","7".repeat(64),"started",now);
      expect(await sync.get(claim.job.id)).toMatchObject({publicationWriteStarted:true,publicationWriteCompleted:false,publicationAccepted:null,publicationAcceptedRevision:null});
      await sync.stage(claim.job,"publish","7".repeat(64),"completed",now);
      expect(await sync.get(claim.job.id)).toMatchObject({publicationWriteCompleted:true,publicationAcceptedRevision:"1",publicationAccepted:null});
      const accepted={listingId:final.variants[0].listingId!,offerIds:Object.fromEntries(final.variants.map(member=>[member.variantId,member.offerId!]))};
      await sync.bindPublicationAccepted(claim.job,accepted,now);
      await expect(sync.bindPublicationAccepted(claim.job,{...accepted,listingId:"changed"},now)).rejects.toMatchObject({code:"EBAY_SYNC_PROVIDER_IDENTITY_CHANGED"});
      await expect(sync.bindProviderIdentity(claim.job,{...final,variants:final.variants.map(member=>({...member,listingId:"unrelated"}))},now,publicationObservation(final))).rejects.toMatchObject({code:"EBAY_SYNC_PROVIDER_IDENTITY_CHANGED"});
      await sync.finish(claim.job,{state:"recovering",result:null,code:"EBAY_SYNC_READBACK_PENDING",message:"Readback pending",nextAttemptAt:now},now);
      await claim.release();
      const restarted=new PostgresEbayListingSyncRepository(database.pool);const next=await restarted.claim(now,randomUUID(),claim.job.id);
      try{expect(next?.job).toMatchObject({publicationTarget:target,publicationAccepted:accepted,publicationWriteCompleted:true,publicationAcceptedRevision:"1"});}
      finally{await next?.release();}
    }finally{await claim.release();}
  });
  it.each([false,true])("initial publication protects an absent mapping from a concurrent writer (concurrent=%s)",async concurrent=>{
    const publish=await publicationPlan();const sync=new PostgresEbayListingSyncRepository(database.pool);
    await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=ANY($1::integer[])",[publish.targetIdentity.variants.map(member=>member.variantId)]);
    const source={...publish.targetIdentity,variants:publish.targetIdentity.variants.map(member=>({...member,mappingExists:false,offerId:null}))};
    const saved=await sync.enqueue(source,randomUUID(),plan.actor,now,"publish");const claim=await sync.claim(now,randomUUID(),saved.id);
    const target={...source,variants:source.variants.map(member=>({...member,externalSku:member.sku}))};
    const listingId=`new-listing-${source.productId}`;
    const final={...target,variants:target.variants.map(member=>({...member,offerId:`new-${member.variantId}`,listingId}))};
    try{
      await sync.bindPublicationTarget(claim!.job,target,now);await sync.bindProviderIdentity(claim!.job,final,now,publicationObservation(final));await verifyPublication(sync,claim!.job);
      if(concurrent) await database.pool.query("INSERT INTO channels.channel_listings(channel_id,product_variant_id) VALUES(67,$1)",[source.variants[1].variantId]);
      const result={synced:2,priceChanges:0,qtyChanges:0,policyChanges:0,errors:0,pending:0,jobs:[],details:source.variants.map(member=>({variantId:member.variantId,variantSku:member.sku,success:true}))};
      const action=sync.finish(claim!.job,{state:"completed",result,code:null,message:null,nextAttemptAt:now},now);
      if(concurrent){await expect(action).rejects.toMatchObject({code:"EBAY_SYNC_PROJECTION_IDENTITY_CHANGED"});expect((await mappings()).length).toBe(1);}
      else{await action;expect((await mappings()).map(row=>row.external_product_id)).toEqual([listingId,listingId]);expect((await mappings()).every(row=>row.last_synced_qty===null)).toBe(true);}
    }finally{await claim!.release();}
  });
  it.each([false,true])("inventory ACK preserves publication failure and never creates Listed from an offer-only mapping (existing=%s)",async existing=>{
    const member=plan.source.identity.variants[0];const leaseToken=randomUUID();
    if(!existing) await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=$1",[member.variantId]);
    await database.pool.query("INSERT INTO channels.channel_variant_availability_sync(channel_id,product_variant_id,revision,status,lease_token) VALUES(67,$1,1,'processing',$2)",[member.variantId,leaseToken]);
    const changed=await markVariantAvailabilitySynced(database.pool,{channelId:67,productVariantId:member.variantId,desiredActive:true,revision:1,attemptCount:1,leaseToken},
      {quantity:88,feedActive:true,externalProductId:null,externalVariantId:member.offerId,externalInventoryItemId:member.sku,externalSku:member.sku});
    expect(changed).toBe(true);const row=(await mappings()).find(row=>row.product_variant_id===member.variantId);
    expect(row).toMatchObject({last_synced_qty:88,sync_status:existing?"error":"pending",sync_error:existing?"old quantity error":null});
    if(!existing) expect(row.external_product_id).toBeNull();
  });
  it("persists publication admission failures with their operation through replay and list/read responses",async()=>{
    const sync=new PostgresEbayListingSyncRepository(database.pool);
    const input={channelId:67,productId:plan.source.identity.productId,variantIds:plan.source.identity.variants.map(member=>member.variantId),
      actor:plan.actor,commandKey:randomUUID(),code:"EBAY_LISTING_PHOTO_UNAVAILABLE",message:"A current catalog photo is required.",operation:"publish" as const};
    const saved=await sync.recordAdmissionFailure(input,now);
    expect(saved).toMatchObject({kind:"admission",operation:"publish",state:"needs_attention"});
    expect(await sync.recordAdmissionFailure(input,now)).toEqual(saved);
    expect(await sync.getAdmission(input.commandKey,67)).toEqual(saved);
    expect((await sync.list(67)).find(job=>job.id===saved.id)).toEqual(saved);
    await expect(sync.recordAdmissionFailure({...input,operation:"sync"},now)).rejects.toMatchObject({code:"EBAY_SYNC_REPLAY_CONFLICT"});
  });
  it("preserves excluded retained member content errors while projecting its verified provider identity",async()=>{
    const excluded=plan.source.identity.variants[1].variantId;
    await database.pool.query("UPDATE channels.channel_variant_overrides SET is_listed=0 WHERE product_variant_id=$1",[excluded]);
    const {sync,claim,target,final,result}=await claimedPublication();
    try{
      expect(target.variants.find(member=>member.variantId===excluded)?.contentSyncEnabled).toBe(false);
      await sync.bindPublicationTarget(claim.job,target,now);await sync.bindProviderIdentity(claim.job,final,now,publicationObservation(final));await verifyPublication(sync,claim.job);
      await sync.finish(claim.job,{state:"completed",result:{...result,synced:1,details:result.details.filter(detail=>detail.variantId!==excluded)},code:null,message:null,nextAttemptAt:now},now);
      const rows=await mappings();expect(rows.find(row=>row.product_variant_id===excluded)).toMatchObject({external_product_id:final.variants[0].listingId,
        sync_status:"error",sync_error:"old quantity error",last_synced_price:"999",last_synced_qty:57});
      expect(rows.find(row=>row.product_variant_id!==excluded)).toMatchObject({sync_status:"synced",sync_error:null,last_synced_price:"1249",last_synced_qty:57});
    }finally{await claim.release();}
  });
  async function interruptedPublication() {
    const fixture=await claimedPublication();
    await fixture.sync.bindPublicationTarget(fixture.claim.job,fixture.target,now);
    await fixture.sync.stage(fixture.claim.job,"publish","7".repeat(64),"started",now);
    await fixture.sync.finish(fixture.claim.job,{state:"needs_attention",code:"EBAY_PROVIDER_ACCESS_DENIED",message:"Seller permission requires review.",result:null,nextAttemptAt:now},now);
    await fixture.claim.release();
    const job=await fixture.sync.get(fixture.claim.job.id);
    const authorization={jobId:job.id,channelId:67,expectedRevision:job.revision,reviewHash:publicationRetryReviewHash(job),commandKey:randomUUID(),actor:plan.actor};
    return {...fixture,job,authorization};
  }
  async function recordPublicationResponse(target: typeof plan.provenIdentity, at: Date,
    response: "rejected" | "accepted" | "unknown" = "rejected") {
    const scopes = ebayListingPublicationScopes(target);
    const attempt = (await database.pool.query<{ id: string }>(
      "INSERT INTO inventory.quantity_publication_attempts(scope,affected_scope_keys) VALUES($1::jsonb,$2) RETURNING id::text",
      [JSON.stringify(scopes[0]), scopes.map(quantityPublicationScopeLockKey)])).rows[0];
    const request = (await database.pool.query<{ id: string }>(`INSERT INTO inventory.quantity_provider_requests
      (attempt_id,ordinal,method,path,request_hash,started_at) VALUES($1,1,'POST','/sell/inventory/v1/offer/publish_by_inventory_item_group',$2,$3) RETURNING id::text`,
      [attempt.id, syncStageHash({ inventoryItemGroupKey: target.groupKey, marketplaceId: target.marketplaceId }), at])).rows[0];
    if (response !== "unknown") await database.pool.query(`INSERT INTO inventory.quantity_provider_request_results
      VALUES($1,$2,$3,$4,$5,true,$6)`, [request.id, response === "accepted" ? "completed" : "uncertain",
      response === "accepted" ? 200 : 400, "6".repeat(64), response === "accepted" ? [] : ["25007"], new Date(at.getTime() + 1)]);
    return { attemptId: attempt.id, requestId: request.id };
  }
  it("records a proved rejection atomically, retains old evidence, and cannot clear a later unknown start", async () => {
    const { sync, claim, target } = await claimedPublication(true);
    const next = new Date(now.getTime() + 10);
    try {
      await sync.bindPublicationTarget(claim.job, target, now);
      await sync.stage(claim.job, "publish", "7".repeat(64), "started", now);
      await expect(sync.stage(claim.job, "publication_rejected", "7".repeat(64), "completed", now)).rejects.toThrow("Invalid listing stage evidence");
      const response = await recordPublicationResponse(target, new Date(now.getTime() + 1));
      expect(await sync.recoverTerminalPublicationWrite(claim.job, target, next)).toBe("rejected");
      expect(await sync.get(claim.job.id)).toMatchObject({ publicationWriteStarted: false, publicationIntentHash: null,
        progress: { phase: "publish", phaseState: "completed" } });
      expect(await sync.recoverTerminalPublicationWrite(claim.job, target, next)).toBe(null);
      const receipts = (await database.pool.query(`SELECT evidence FROM channels.ebay_listing_sync_events
        WHERE job_id=$1 AND event='stage_completed' AND evidence->>'key'='publication_rejected'`, [claim.job.id])).rows;
      expect(receipts).toHaveLength(1);
      expect(receipts[0].evidence.responseEvidence).toMatchObject({ attemptIds: [response.attemptId], requests: [{ requestId: response.requestId, httpStatus: 400, errorCodes: ["25007"] }] });
      await expect(database.pool.query("DELETE FROM channels.ebay_listing_sync_events WHERE job_id=$1", [claim.job.id])).rejects.toMatchObject({ code: "23514" });
      await sync.stage(claim.job, "publish", "8".repeat(64), "started", new Date(next.getTime() + 1));
      await recordPublicationResponse(target, new Date(next.getTime() + 2), "unknown");
      expect(await sync.recoverTerminalPublicationWrite(claim.job, target, new Date(next.getTime() + 3))).toBe(null);
      expect(await sync.get(claim.job.id)).toMatchObject({ publicationWriteStarted: true, publicationIntentHash: "8".repeat(64) });
    } finally { await claim.release(); }
  });
  it.each(["accepted", "unknown"] as const)("does not clear a publication with %s provider evidence", async response => {
    const { sync, claim, target } = await claimedPublication(true);
    try {
      await sync.bindPublicationTarget(claim.job, target, now);
      await sync.stage(claim.job, "publish", "7".repeat(64), "started", now);
      await recordPublicationResponse(target, new Date(now.getTime() + 1), response);
      expect(await sync.recoverTerminalPublicationWrite(claim.job, target, new Date(now.getTime() + 2))).toBe(null);
      expect(await sync.get(claim.job.id)).toMatchObject({ publicationWriteStarted: true });
    } finally { await claim.release(); }
  });
  it("rolls back failed rejection receipts and waits for a concurrent exact inventory owner", async () => {
    const { sync, claim, target } = await claimedPublication(true);
    const other = await database.pool.connect();
    try {
      await sync.bindPublicationTarget(claim.job, target, now);
      await sync.stage(claim.job, "publish", "7".repeat(64), "started", now);
      await recordPublicationResponse(target, new Date(now.getTime() + 1));
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock(hashtextextended($1,918420))", [quantityPublicationScopeLockKey(ebayListingPublicationScopes(target)[0])]);
      await expect(sync.recoverTerminalPublicationWrite(claim.job, target, now)).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
      await other.query("ROLLBACK");
      await database.pool.query(`CREATE FUNCTION channels.test_rejection_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.evidence->>'key'='publication_rejected' THEN RAISE EXCEPTION 'injected rejection audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_rejection_audit_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_rejection_audit_failure()`);
      try {
        await expect(sync.recoverTerminalPublicationWrite(claim.job, target, now)).rejects.toMatchObject({ code: "EBAY_SYNC_PERSISTENCE_FAILED" });
        expect(await sync.get(claim.job.id)).toMatchObject({ publicationWriteStarted: true });
      } finally {
        await database.pool.query("DROP TRIGGER test_rejection_audit_failure ON channels.ebay_listing_sync_events; DROP FUNCTION channels.test_rejection_audit_failure()");
      }
      expect(await sync.recoverTerminalPublicationWrite(claim.job, target, now)).toBe("rejected");
    } finally { await other.query("ROLLBACK"); other.release(); await claim.release(); }
  });
  it("keeps post-send business failure recoverable and authorizes one audited retry even with no inventory attempts",async()=>{
    const {sync,job,authorization}=await interruptedPublication();const before=await mappings();
    expect(job).toMatchObject({state:"awaiting_evidence",code:"EBAY_PROVIDER_ACCESS_DENIED",publicationWriteStarted:true,publicationIntentHash:"7".repeat(64)});
    const result=await sync.authorizePublicationRetry(authorization,now);
    expect(result).toMatchObject({replayed:false,job:{id:job.id,state:"queued",revision:"2",publicationWriteStarted:false,publicationIntentHash:null}});
    expect(await mappings()).toEqual(before);
    expect(await sync.authorizePublicationRetry({...authorization,expectedRevision:"2"},now)).toEqual({...result,replayed:true});
    await expect(sync.authorizePublicationRetry({...authorization,actor:"user:99"},now)).rejects.toMatchObject({code:"EBAY_SYNC_REPLAY_CONFLICT"});
    await expect(sync.authorizePublicationRetry({...authorization,reviewHash:"8".repeat(64)},now)).rejects.toMatchObject({code:"EBAY_SYNC_REPLAY_CONFLICT"});
    const events=(await database.pool.query("SELECT event,evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event IN ('stage_started','publication_retry_authorized') ORDER BY id",[job.id])).rows;
    expect(events).toHaveLength(2);expect(events[0].evidence).toMatchObject({key:"publish",preparedIntentHash:"7".repeat(64)});
    expect(events[1].evidence).toMatchObject({actor:plan.actor,commandKey:authorization.commandKey,reviewHash:authorization.reviewHash,beforeRevision:"1",publicationIntentHash:"7".repeat(64)});
    const next=await sync.claim(now,randomUUID(),job.id);expect(next).not.toBeNull();
    try{
      await sync.stage(next!.job,"publish","8".repeat(64),"started",now);
      expect(await sync.get(job.id)).toMatchObject({publicationWriteStarted:true,publicationIntentHash:"8".repeat(64)});
      await sync.finish(next!.job,{state:"awaiting_evidence",code:"EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",message:"Unknown again",result:null,nextAttemptAt:now},now);
    }finally{await next!.release();}
    const second=await sync.get(job.id);
    await expect(sync.authorizePublicationRetry({...authorization,commandKey:randomUUID()},now)).rejects.toMatchObject({code:"EBAY_PUBLICATION_RETRY_REVIEW_CHANGED"});
    const secondAuth={...authorization,commandKey:randomUUID(),expectedRevision:second.revision,reviewHash:publicationRetryReviewHash(second)};
    const concurrent=await Promise.all([sync.authorizePublicationRetry(secondAuth,now),sync.authorizePublicationRetry(secondAuth,now)]);
    expect(concurrent.map(item=>item.replayed).sort()).toEqual([false,true]);
    expect(concurrent.every(item=>item.job.revision==="3")).toBe(true);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='stage_started' AND evidence->>'key'='publish'",[job.id])).rows[0].count).toBe(2);
  });
  it("refuses stale recovery reviews and an active provider owner without inserting a retry command",async()=>{
    const {sync,job,authorization,publish}=await interruptedPublication();
    const changed=await sync.enqueue(publish.targetIdentity,randomUUID(),plan.actor,now,"publish");expect(changed.revision).toBe("2");
    await expect(sync.authorizePublicationRetry(authorization,now)).rejects.toMatchObject({code:"EBAY_PUBLICATION_RETRY_REVIEW_CHANGED"});
    const current=await sync.get(job.id);const fresh={...authorization,expectedRevision:current.revision,reviewHash:publicationRetryReviewHash(current)};
    const live=await sync.claim(new Date(now.getTime()+60_000),randomUUID(),job.id);expect(live).not.toBeNull();
    try{await expect(sync.authorizePublicationRetry(fresh,now)).rejects.toMatchObject({code:"PUBLICATION_SCOPE_BUSY"});}
    finally{await live!.release();}
    expect(await sync.getByCommand(authorization.commandKey,67)).toBeNull();
  });
  it.each(["completed","accepted"] as const)("never authorizes another send after a %s publish response",async receipt=>{
    const {sync,claim,target,final}=await claimedPublication();
    try{
      await sync.bindPublicationTarget(claim.job,target,now);await sync.stage(claim.job,"publish","7".repeat(64),"started",now);
      if(receipt==="completed") await sync.stage(claim.job,"publish","7".repeat(64),"completed",now);
      else await sync.bindPublicationAccepted(claim.job,{listingId:final.variants[0].listingId!,offerIds:Object.fromEntries(final.variants.map(member=>[member.variantId,member.offerId!]))},now);
      await sync.finish(claim.job,{state:"needs_attention",code:"EBAY_PROVIDER_ACCESS_DENIED",message:"Permission issue",result:null,nextAttemptAt:now},now);
    }finally{await claim.release();}
    const job=await sync.get(claim.job.id);expect(job.state).toBe("awaiting_evidence");
    await expect(sync.authorizePublicationRetry({jobId:job.id,channelId:67,expectedRevision:job.revision,reviewHash:publicationRetryReviewHash(job),commandKey:randomUUID(),actor:plan.actor},now))
      .rejects.toMatchObject({code:"EBAY_PUBLICATION_RETRY_NOT_ALLOWED"});
  });
  it("joins an uncertain publication with Sync while refusing a changed source or command replay identity",async()=>{
    const {sync,job,publish}=await interruptedPublication();
    const changed={...publish.targetIdentity,variants:publish.targetIdentity.variants.map(member=>({...member,catalogSku:member.catalogSku+"-renamed"}))};
    await expect(sync.enqueue(changed,randomUUID(),plan.actor,now,"publish")).rejects.toMatchObject({code:"EBAY_PUBLICATION_PRIOR_WORK_REQUIRED"});
    const commandKey = randomUUID();
    const joined = await sync.enqueue(publish.targetIdentity,commandKey,plan.actor,now,"sync");
    expect(joined).toMatchObject({ id: job.id, operation: "publish", state: "queued", revision: "2", publicationWriteStarted: true });
    expect(await sync.enqueue(publish.targetIdentity,commandKey,plan.actor,now,"sync")).toMatchObject({ id: job.id, revision: "2" });
    await expect(sync.enqueue(changed,commandKey,plan.actor,now,"sync")).rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    await expect(sync.enqueue(publish.targetIdentity,commandKey,"another-operator",now,"sync")).rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM channels.ebay_listing_sync_commands WHERE command_key=$1",[commandKey])).rows[0].count).toBe(1);
  });
  it("recovers only the exact Sync continuation command after its acknowledgement is lost", async () => {
    const { sync, job, publish } = await interruptedPublication();
    const commandKey = randomUUID();
    const actor = "system:ebay-recovery-reconciliation";
    const joined = await sync.enqueue(publish.targetIdentity, commandKey, actor, now, "sync");
    expect(await sync.getByCommand(commandKey, 67, { expectedActor: actor, expectedOperation: "sync" }))
      .toMatchObject({ id: job.id, operation: "publish", revision: joined.revision });
    await expect(sync.getByCommand(commandKey, 67, { expectedActor: "another-requester", expectedOperation: "sync" }))
      .rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    await expect(sync.getByCommand(job.id, 67, { expectedActor: plan.actor, expectedOperation: "sync" }))
      .rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    expect(await sync.getByCommand(job.id, 67, { expectedActor: plan.actor, expectedOperation: "publish" }))
      .toMatchObject({ id: job.id, operation: "publish" });
    await expect(sync.getByCommand(commandKey, 67, { expectedActor: actor, expectedOperation: "publish" }))
      .rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    await expect(sync.enqueue(publish.targetIdentity, commandKey, actor, now, "publish"))
      .rejects.toMatchObject({ code: "EBAY_SYNC_REPLAY_CONFLICT" });
    expect(await sync.get(job.id)).toMatchObject({ revision: joined.revision, publicationWriteStarted: true });
  });
  it.each([false, true])("continues the same failed publication through concurrent Sync commands without clearing delivery evidence (proved rejection=%s)", async provedRejection => {
    const { sync, claim, target, publish } = await claimedPublication(true);
    try {
      await sync.bindPublicationTarget(claim.job, target, now);
      await sync.stage(claim.job, "publish", "7".repeat(64), "started", now);
      if (provedRejection) {
        await recordPublicationResponse(target, new Date(now.getTime() + 1));
        expect(await sync.recoverTerminalPublicationWrite(claim.job, target, new Date(now.getTime() + 2))).toBe("rejected");
      }
      await sync.finish(claim.job, { state: "needs_attention", result: null, code: "EBAY_SHIPPING_POLICY_REJECTED",
        message: "Choose a valid shipping policy", nextAttemptAt: now }, now);
    } finally { await claim.release(); }
    if (!provedRejection) {
      // Older deployments could retire an unknown publish as needs_attention.
      const legacy = await database.pool.connect();
      try {
        await legacy.query("BEGIN");
        await legacy.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [918427, claim.job.id]);
        await legacy.query("UPDATE channels.ebay_listing_sync_jobs SET state='needs_attention' WHERE id=$1", [claim.job.id]);
        await legacy.query("COMMIT");
      } finally { legacy.release(); }
    }
    await expect(database.pool.query("UPDATE channels.ebay_listing_sync_jobs SET state='queued',revision=revision+1 WHERE id=$1", [claim.job.id])).rejects.toMatchObject({ code: "23514" });
    const commandKey = randomUUID();
    const joined = await Promise.all([sync.enqueue(publish.targetIdentity, commandKey, "operator", now, "sync"),
      sync.enqueue(publish.targetIdentity, commandKey, "operator", now, "sync")]);
    expect(joined).toEqual([expect.objectContaining({ id: claim.job.id, state: "queued", operation: "publish", revision: "2", publicationWriteStarted: !provedRejection }),
      expect.objectContaining({ id: claim.job.id, revision: "2" })]);
    const requests = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='requested' AND evidence->>'commandKey'=$2", [claim.job.id, commandKey])).rows;
    expect(requests).toHaveLength(1);
    expect(requests[0].evidence).toMatchObject({ requestedOperation: "sync", continuationOnly: true });
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='publication_retry_authorized'", [claim.job.id])).rows[0].count).toBe(0);
  });
  it("rolls back a continuation command and receipt when its requeue fails", async () => {
    const { sync, claim, target, publish } = await claimedPublication(true);
    try {
      await sync.bindPublicationTarget(claim.job, target, now);
      await sync.finish(claim.job, { state: "needs_attention", result: null, code: "EBAY_SHIPPING_POLICY_REJECTED",
        message: "Choose a valid shipping policy", nextAttemptAt: now }, now);
    } finally { await claim.release(); }
    const commandKey = randomUUID();
    await database.pool.query(`CREATE FUNCTION channels.test_continuation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='queued' THEN RAISE EXCEPTION 'injected continuation failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_continuation_failure BEFORE UPDATE ON channels.ebay_listing_sync_jobs FOR EACH ROW EXECUTE FUNCTION channels.test_continuation_failure()`);
    try { await expect(sync.enqueue(publish.targetIdentity, commandKey, "operator", now, "sync")).rejects.toThrow("injected continuation failure"); }
    finally { await database.pool.query("DROP TRIGGER test_continuation_failure ON channels.ebay_listing_sync_jobs; DROP FUNCTION channels.test_continuation_failure()"); }
    expect(await sync.getByCommand(commandKey, 67)).toBeNull();
    expect(await sync.get(claim.job.id)).toMatchObject({ state: "needs_attention", revision: "1" });
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND evidence->>'commandKey'=$2", [claim.job.id, commandKey])).rows[0].count).toBe(0);
  });
  it("joins the active publication instead of reviving an older failed preparation for the same source", async () => {
    const { sync, claim, target, publish } = await claimedPublication();
    try {
      await sync.bindPublicationTarget(claim.job, target, now);
      await sync.finish(claim.job, { state: "needs_attention", result: null, code: "EBAY_LISTING_PHOTO_UNAVAILABLE",
        message: "A catalog photo is required", nextAttemptAt: now }, now);
    } finally { await claim.release(); }
    const active = await sync.enqueue(publish.targetIdentity, randomUUID(), plan.actor, new Date(now.getTime() + 1), "publish");
    expect(active.id).not.toBe(claim.job.id);
    const commandKey = randomUUID();
    const continued = await sync.enqueue(publish.targetIdentity, commandKey, plan.actor, new Date(now.getTime() + 2), "sync");
    expect(continued).toMatchObject({ id: active.id, operation: "publish", state: "queued", revision: "2", publicationTarget: target });
    expect(await sync.enqueue(publish.targetIdentity, commandKey, plan.actor, now, "sync")).toMatchObject({ id: active.id, revision: "2" });
    expect(await sync.get(claim.job.id)).toMatchObject({ state: "needs_attention", revision: "1", publicationWriteStarted: false });
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM channels.ebay_listing_sync_jobs WHERE product_id=$1 AND state IN ('queued','running','recovering','awaiting_evidence')", [target.productId])).rows[0].count).toBe(1);
  });
  it.each(["queued", "needs_attention"] as const)("does not hide a historical terminal publication barrier behind another %s publication", async state => {
    const { sync, job, publish } = await interruptedPublication();
    const otherId = randomUUID();
    const legacy = await database.pool.connect();
    try {
      await legacy.query("BEGIN");
      await legacy.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [918427, job.id]);
      await legacy.query("UPDATE channels.ebay_listing_sync_jobs SET state='needs_attention' WHERE id=$1", [job.id]);
      // Historical deployments could leave a second job beside the retired
      // publication. Neither its presence nor its timestamp erases the first send.
      await legacy.query(`INSERT INTO channels.ebay_listing_sync_jobs
        (id,channel_id,connection_id,product_id,identity,identity_hash,requested_by,created_at,updated_at,next_attempt_at,operation,state)
        SELECT $2,channel_id,connection_id,product_id,identity,identity_hash,requested_by,created_at,updated_at,next_attempt_at,operation,$3
        FROM channels.ebay_listing_sync_jobs WHERE id=$1`, [job.id, otherId, state]);
      if (state === "needs_attention") await legacy.query(`INSERT INTO channels.ebay_listing_sync_events(job_id,revision,event,evidence,created_at)
        VALUES($1,1,'stage_started',$2::jsonb,$3)`, [otherId, JSON.stringify({ key: "publish", preparedIntentHash: "8".repeat(64) }), now]);
      await legacy.query("COMMIT");
    } finally { legacy.release(); }
    const commandKey = randomUUID();
    await expect(sync.enqueue(publish.targetIdentity, commandKey, plan.actor, now, "sync")).rejects.toMatchObject({ code: "EBAY_PUBLICATION_PRIOR_WORK_REQUIRED" });
    expect(await sync.getByCommand(commandKey, 67)).toBeNull();
    expect(await sync.get(job.id)).toMatchObject({ state: "needs_attention", publicationWriteStarted: true, revision: "1" });
    expect(await sync.get(otherId)).toMatchObject({ state, revision: "1" });
  });
  it("blocks a fresh command after a historical terminal interruption and permits only explicit audited recovery",async()=>{
    const {sync,job,publish,authorization}=await interruptedPublication();
    const client=await database.pool.connect();
    try{
      await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2))",[918427,job.id]);
      await client.query("UPDATE channels.ebay_listing_sync_jobs SET state='needs_attention' WHERE id=$1",[job.id]);await client.query("COMMIT");
    }finally{client.release();}
    await expect(sync.enqueue(publish.targetIdentity,randomUUID(),plan.actor,now,"publish")).rejects.toMatchObject({code:"EBAY_PUBLICATION_PRIOR_WORK_REQUIRED"});
    await expect(database.pool.query("UPDATE channels.ebay_listing_sync_jobs SET state='queued',revision=revision+1 WHERE id=$1",[job.id])).rejects.toMatchObject({code:"23514"});
    expect((await sync.authorizePublicationRetry(authorization,now)).job).toMatchObject({id:job.id,state:"queued",revision:"2"});
  });
  it("rolls back retry receipt and command if requeue fails, and rejects unowned authorization evidence",async()=>{
    const {sync,job,authorization}=await interruptedPublication();
    await expect(database.pool.query("INSERT INTO channels.ebay_listing_sync_events(job_id,revision,event,evidence,created_at) VALUES($1,1,'publication_retry_authorized','{}',$2)",[job.id,now]))
      .rejects.toMatchObject({code:"23514"});
    await database.pool.query(`CREATE FUNCTION channels.test_retry_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='queued' THEN RAISE EXCEPTION 'injected requeue failure'; END IF;RETURN NEW;END $$;
      CREATE TRIGGER test_retry_failure BEFORE UPDATE ON channels.ebay_listing_sync_jobs FOR EACH ROW EXECUTE FUNCTION channels.test_retry_failure()`);
    try{await expect(sync.authorizePublicationRetry(authorization,now)).rejects.toMatchObject({code:"EBAY_SYNC_PERSISTENCE_FAILED"});}
    finally{await database.pool.query("DROP TRIGGER test_retry_failure ON channels.ebay_listing_sync_jobs;DROP FUNCTION channels.test_retry_failure()");}
    expect(await sync.getByCommand(authorization.commandKey,67)).toBeNull();
    expect(await sync.get(job.id)).toMatchObject({revision:"1",publicationWriteStarted:true});
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='publication_retry_authorized'",[job.id])).rows[0].count).toBe(0);
  });
  it.each([false, true])("restarts the real publication worker after final audit rollback without republishing (prior rejection=%s)",async priorRejection=>{
    const publish=await publicationPlan();const saved=await repository.apply(publish);const before=await mappings();
    const source=publish.targetIdentity;
    const target={...source,variants:source.variants.map(member=>({...member,externalSku:member.sku}))};
    const final={...target,variants:target.variants.map(member=>({...member,listingId:`worker-published-${source.productId}`}))};
    const photoUrls=["https://example.test/shared-product.jpg","https://example.test/shared-detail.jpg"];
    const draft:EbayListingConnectorDraft={productId:source.productId,marketplaceId:source.marketplaceId,publishMode:"publish",hasExistingExternalIds:false,
      existingOfferIdsByVariantId:Object.fromEntries(source.variants.map(member=>[member.variantId,member.offerId])),
      inventoryItems:source.variants.map(member=>({sku:member.sku,payload:{sku:member.sku,condition:"NEW",
        product:{title:"Canonical catalog title",description:"Canonical catalog description",imageUrls:[...photoUrls]},
        availability:{shipToLocationAvailability:{quantity:123}}}})),
      offers:source.variants.map(member=>({sku:member.sku,variantId:member.variantId,payload:{sku:member.sku,marketplaceId:"EBAY_US",format:"FIXED_PRICE",
        availableQuantity:123,categoryId:"183454",merchantLocationKey:"HQ",listingPolicies:{paymentPolicyId:"payment",returnPolicyId:"return",fulfillmentPolicyId:"fulfillment"},
        pricingSummary:{price:{value:"12.49",currency:"USD"}}}})),
      itemGroup:{groupKey:source.groupKey!,payload:{title:"Canonical catalog title",description:"Canonical catalog description",imageUrls:[...photoUrls],aspects:{},
        variantSKUs:source.variants.map(member=>member.sku),variesBy:{specifications:[{name:"Pack Size",values:["10","500"]}]}}}};
    let published=false;const providerState:{group:EbayInventoryItemGroup|null}={group:null};
    const currentItems=new Map<string,EbayInventoryItem>();
    const currentOffers=new Map<string,EbayObservedOffer>(draft.offers.map(offer=>[offer.sku,{...structuredClone(offer.payload),
      offerId:source.variants.find(member=>member.variantId===offer.variantId)!.offerId!,status:"UNPUBLISHED"}]));
    const client:EbayListingLifecycleClient={
      getInventoryItem:vi.fn(async sku=>structuredClone(currentItems.get(sku)??null)),
      getOffers:vi.fn(async sku=>({offers:[structuredClone(currentOffers.get(sku)!)]})),
      getInventoryItemGroup:vi.fn(async()=>structuredClone(providerState.group)),
      createOrReplaceInventoryItem:vi.fn(async(sku,payload)=>{currentItems.set(sku,structuredClone(payload));}),
      updateOffer:vi.fn(async(offerId,payload)=>{currentOffers.set(payload.sku,{...structuredClone(payload),offerId,status:published?"PUBLISHED":"UNPUBLISHED",
        ...(published?{listingId:final.variants[0].listingId!}:{})});}),
      createOrReplaceInventoryItemGroup:vi.fn(async(_key,payload)=>{providerState.group=structuredClone(payload);}),
      publishOfferByInventoryItemGroup:vi.fn(async()=>{published=true;for(const [sku,offer]of currentOffers)currentOffers.set(sku,{...offer,status:"PUBLISHED",listingId:final.variants[0].listingId!});return{listingId:final.variants[0].listingId!};}),
      createOffer:vi.fn(),publishOffer:vi.fn(),withdrawOfferByInventoryItemGroup:vi.fn(),bulkUpdatePriceQuantity:vi.fn(),deleteInventoryItemGroup:vi.fn(),
    };
    const inspect=async():Promise<EbayListingInspection>=>({...publish.inspectionEvidence,
      publication:published?publicationObservation(final):null,unpublishedTarget:published?null:publish.inspectionEvidence.unpublishedTarget,
      skus:source.variants.map(member=>({sku:member.sku,inventoryItemExists:true,issue:null,offers:[{sku:member.sku,offerId:member.offerId!,
        status:published?"PUBLISHED":"UNPUBLISHED",listingId:published?final.variants[0].listingId:null,listingStatus:published?"ACTIVE":null}]}))});
    const prepare=async():Promise<PreparedEbayPublication>=>{
      const connection=await database.pool.connect();let snapshot:EbayListingMappingSourceSnapshot;
      try{snapshot=await readSource(connection,source.productId);}finally{connection.release();}
      const inspection=await inspect();
      return{sourceIdentity:snapshot.identity,identity:resolveEbayPublicationTarget(source,inspection),client,draft:structuredClone(draft),inspection,inspect,assertInventoryReady:async()=>{},
        resolvePublishedIdentity:async()=>publicationObservation(final),variants:source.variants.map(member=>({variantId:member.variantId,sku:member.sku,
          productName:"Canonical catalog title",priceCents:1249,priceChanged:true}))};
    };
    const recovery={reconcile:vi.fn(async()=>({busy:false,resolved:[],unresolved:[]}))};
    const compatible:ConstructorParameters<typeof EbayPublicationCompletionExecution>[3]=async(_source,inspection,identity)=>{
      if(inspection.publication)await canonical.assertCompatiblePublication({owner:{kind:"channel",channelId:67,productId:source.productId,provider:"ebay",marketplaceId:"EBAY_US"},
        observation:inspection.publication,memberCandidates:publish.source.candidates});
      else await canonical.assertCompatibleUnpublishedPublication({owner:{kind:"channel",channelId:67,productId:source.productId,provider:"ebay",marketplaceId:"EBAY_US"},
        providerAccount:{provider:"ebay",accountNamespace:"production",externalAccountId:inspection.providerAccount!.externalAccountId},
        groupKey:identity.groupKey,members:identity.variants.map(member=>({productVariantId:member.variantId,sku:member.sku,offerId:member.offerId}))});
    };
    if (priorRejection) {
      const beforeWorker = new PostgresEbayListingSyncRepository(database.pool, new PostgresEbayPublicationRejectionReader(database.pool));
      const previous = await beforeWorker.claim(now, randomUUID(), saved.job.id);
      expect(previous).not.toBeNull();
      try {
        await beforeWorker.bindPublicationTarget(previous!.job, target, now);
        await beforeWorker.stage(previous!.job, "publish", "7".repeat(64), "started", now);
        await recordPublicationResponse(target, new Date(now.getTime() + 1));
        await beforeWorker.finish(previous!.job, { state: "awaiting_evidence", result: null,
          code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", message: "Historical publication outcome unknown", nextAttemptAt: now }, now);
      } finally { await previous!.release(); }
    }
    const worker=(clock:Date)=>new EbayListingSyncService(new PostgresEbayListingSyncRepository(database.pool, new PostgresEbayPublicationRejectionReader(database.pool)),
      new EbayPublicationCompletionExecution(prepare,recovery,new EbayMarketplaceListingConnector(),compatible),()=>clock,randomUUID);
    await database.pool.query(`CREATE FUNCTION channels.test_worker_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event='completed' THEN RAISE EXCEPTION 'injected worker completion audit failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER test_worker_completion_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_worker_completion_failure()`);
    try{expect(await worker(now).processDue(1,saved.job.id)).toEqual({processed:0,failed:1});}
    finally{await database.pool.query("DROP TRIGGER test_worker_completion_failure ON channels.ebay_listing_sync_events;DROP FUNCTION channels.test_worker_completion_failure()");}
    const sync=new PostgresEbayListingSyncRepository(database.pool);const interrupted=await sync.get(saved.job.id);
    expect(interrupted).toMatchObject({state:"recovering",publicationTarget:target,providerIdentity:final,publicationWriteStarted:true,publicationWriteCompleted:true,
      publicationAccepted:{listingId:final.variants[0].listingId,offerIds:Object.fromEntries(final.variants.map(member=>[member.variantId,member.offerId]))},
      publicationIntentHash:syncContentIntentHash(draft)});
    expect(await mappings()).toEqual(before);
    const evidence=(await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='stage_completed' AND evidence->>'key'='provider_identity'",[saved.job.id])).rows;
    expect(evidence).toHaveLength(1);expect(evidence[0].evidence.observation).toMatchObject({listingIdentity:publicationObservation(final).listingIdentity,members:publicationObservation(final).members});
    const writesBeforeRestart=vi.mocked(client.createOrReplaceInventoryItem).mock.calls.length;
    expect(await worker(new Date(now.getTime()+10*60_000)).processDue(1,saved.job.id)).toEqual({processed:1,failed:0});
    expect((await sync.get(saved.job.id)).state).toBe("completed");
    expect(client.publishOfferByInventoryItemGroup).toHaveBeenCalledExactlyOnceWith(source.groupKey,"EBAY_US");
    expect(client.publishOffer).not.toHaveBeenCalled();expect(client.createOffer).not.toHaveBeenCalled();
    expect(client.createOrReplaceInventoryItem).toHaveBeenCalledTimes(writesBeforeRestart);
    for(const member of final.variants){expect(currentItems.get(member.sku)?.product?.imageUrls).toEqual(photoUrls);
      expect((await mappings()).find(row=>row.product_variant_id===member.variantId)).toMatchObject({external_sku:member.sku,
        external_variant_id:member.offerId,external_product_id:member.listingId,last_synced_price:"1249",last_synced_qty:57,sync_status:"synced"});}
    expect(providerState.group?.imageUrls).toEqual(photoUrls);
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='stage_started' AND evidence->>'key'='publish'",[saved.job.id])).rows[0].count).toBe(priorRejection ? 2 : 1);
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='stage_completed' AND evidence->>'key'='publication_rejected'",[saved.job.id])).rows[0].count).toBe(priorRejection ? 1 : 0);
  });

  it("including an unmapped product atomically saves one shared sync across concurrent retries and lost acknowledgement", async () => {
    const productId = plan.source.identity.productId;
    await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=ANY($1::int[])", [plan.source.identity.variants.map(v => v.variantId)]);
    const command = { excluded: false, commandKey: randomUUID() };
    const owner = exclusionOwner();
    const receipts = await Promise.all(Array.from({ length: 5 }, () => owner.set(productId, command, "operator")));
    expect(new Set(receipts.map(row => row.syncBatchId))).toEqual(new Set([command.commandKey]));
    const store = new PostgresChannelSyncBatchRepository(database.pool);
    const saved = await store.get(command.commandKey);
    expect(saved).toMatchObject({ actor: "operator", destination: { channelId: 67 }, members: [{ productId }] });
    expect(saved!.members).toHaveLength(1);
    expect(saved!.members[0].commandKey).not.toBe(command.commandKey);
    expect((await owner.get(productId, command.commandKey)).syncBatchId).toBe(command.commandKey);
    expect(await exclusionIntent()).toEqual({ ebay_listing_excluded: false, is_listed: 1 });
    expect((await counts()).jobs).toBe(0); // execution is durable and asynchronous
  });
  it("rolls back both inclusion mirrors and the batch when the inclusion receipt cannot commit", async () => {
    const productId = plan.source.identity.productId;
    await database.pool.query("UPDATE catalog.products SET ebay_listing_excluded=true WHERE id=$1", [productId]);
    await database.pool.query("UPDATE channels.channel_product_overrides SET is_listed=0 WHERE product_id=$1", [productId]);
    const command = { excluded: false, commandKey: randomUUID() };
    await database.pool.query(`CREATE FUNCTION channels.test_include_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'inclusion receipt failure'; END $$;
      CREATE TRIGGER test_include_receipt_failure BEFORE INSERT ON channels.ebay_listing_exclusion_commands
      FOR EACH ROW EXECUTE FUNCTION channels.test_include_receipt_failure()`);
    try { await expect(exclusionOwner().set(productId, command, "operator")).rejects.toThrow("inclusion receipt failure"); }
    finally { await database.pool.query("DROP TRIGGER test_include_receipt_failure ON channels.ebay_listing_exclusion_commands; DROP FUNCTION channels.test_include_receipt_failure()"); }
    expect(await exclusionIntent()).toEqual({ ebay_listing_excluded: true, is_listed: 0 });
    expect(await new PostgresChannelSyncBatchRepository(database.pool).get(command.commandKey)).toBeNull();
    expect((await exclusionOwner().set(productId, command, "operator")).syncBatchId).toBe(command.commandKey);
  });
  it("reads unmapped included products and preserves archived member identities without treating them as sellable", async () => {
    const productId = plan.source.identity.productId;
    const reader = new EbaySyncSelectionReader(database.pool, 67);
    expect((await reader.product(productId)).state).toMatchObject({ included: true, includedVariantCount: 2, hasPublishedIdentity: true });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=$1", [plan.source.identity.variants[1].variantId]);
    expect((await reader.product(productId)).state).toMatchObject({ includedVariantCount: 1, hasPublishedIdentity: true });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=$1", [plan.source.identity.variants[1].variantId]);
    expect((await reader.product(productId)).state.includedVariantCount).toBe(2);
    await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=ANY($1::int[])", [plan.source.identity.variants.map(v => v.variantId)]);
    expect((await reader.product(productId)).state).toMatchObject({ included: true, includedVariantCount: 2, hasPublishedIdentity: false });
    await database.pool.query("UPDATE channels.channel_variant_overrides SET is_listed=0 WHERE product_variant_id=ANY($1::int[])", [plan.source.identity.variants.map(v => v.variantId)]);
    expect((await reader.product(productId)).state.includedVariantCount).toBe(0);
  });

  function inclusionSync() { return createEbayInclusionSync({ pool: database.pool, channelId: 67, uuid: randomUUID,
    destination: async () => ({ channelId: 67, provider: "ebay", connectionId: 7, accountId: "account-67", environment: "production", marketplaceId: "EBAY_US" }) }); }
  function exclusionOwner(clock=now) { return new PostgresEbayListingExclusionRepository(database.pool,67,async(client,productId)=>(await readSource(client,productId)).identity,()=>clock,inclusionSync()); }
  async function enqueueReviewedTarget(source: typeof plan.source.identity, target: typeof plan.source.identity, commandKey = randomUUID()) {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const saved = await new PostgresEbayListingSyncRepository(database.pool).enqueueInsideTransaction(client, source, commandKey, "stock-reviewer", now, undefined, "publish", target);
      await client.query("COMMIT");
      return saved;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async function failedPartialPreparation() {
    const publish = await publicationPlan();
    const source = publish.source.identity;
    const target = { ...publish.targetIdentity, variants: source.variants.map(member => ({ ...member, externalSku: member.sku })) };
    const jobs = new PostgresEbayListingSyncRepository(database.pool);
    const saved = await jobs.enqueue(source, randomUUID(), plan.actor, now, "publish");
    const claim = await jobs.claim(now, randomUUID(), saved.id);
    expect(claim).not.toBeNull();
    try {
      await jobs.bindPublicationTarget(claim!.job, target, now);
      await jobs.stage(claim!.job, "inventory-items", "7".repeat(64), "started", now);
      await jobs.stage(claim!.job, "inventory-items", "7".repeat(64), "completed", now);
      await jobs.stage(claim!.job, "offers", "8".repeat(64), "started", now);
      await jobs.stage(claim!.job, "offers", "8".repeat(64), "completed", now);
      await jobs.finish(claim!.job, { state: "needs_attention", code: "PUBLICATION_LISTING_TARGET_UNMAPPED",
        message: "Exact stock mappings are missing before group preparation.", result: null, nextAttemptAt: now }, now);
    } finally { await claim!.release(); }
    return { jobs, source, target, saved: await jobs.get(saved.id) };
  }
  it("retains the exact saved target after partial preparation for a new Publish command and its concurrent replay", async () => {
    const { jobs, source, target, saved } = await failedPartialPreparation();
    expect(saved).toMatchObject({ state: "needs_attention", publicationTarget: target, publicationWriteStarted: false });
    const commandKey = randomUUID();
    const before = await mappings();
    const results = await Promise.all([jobs.enqueue(source, commandKey, plan.actor, now, "publish"), jobs.enqueue(source, commandKey, plan.actor, now, "publish")]);
    expect(results[0].id).not.toBe(saved.id);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ publicationTarget: target, publicationWriteStarted: false, publicationAccepted: null, providerIdentity: null });
    expect(await mappings()).toEqual(before);
    expect(await jobs.get(saved.id)).toEqual(saved);
    const receipts = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='requested'", [commandKey])).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0].evidence).toMatchObject({ retainedTargetJobId: saved.id, reviewedPublicationTarget: target });
    const retry = await jobs.claim(now, randomUUID(), commandKey);
    try { expect(retry?.job.publicationTarget).toEqual(target); }
    finally { await retry?.release(); }
  });
  it("does not inherit a failed target after the exact source mapping changes", async () => {
    const { jobs, source, saved } = await failedPartialPreparation();
    const changed = { ...source, variants: source.variants.map(member => ({ ...member, offerId: `${member.offerId}-corrected` })) };
    const replacement = await jobs.enqueue(changed, randomUUID(), plan.actor, now, "publish");
    expect(replacement.publicationTarget).toBeNull();
    expect(await jobs.get(saved.id)).toEqual(saved);
  });
  it("refuses a conflicting reviewed group after partial preparation and rolls its new command back", async () => {
    const { jobs, source, target, saved } = await failedPartialPreparation();
    const commandKey = randomUUID();
    await expect(enqueueReviewedTarget(source, { ...target, groupKey: "unrelated-group" }, commandKey)).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(await jobs.getByCommand(commandKey, source.channelId)).toBeNull();
    expect(await jobs.get(saved.id)).toEqual(saved);
  });
  it("retains the reviewed group and known offers at enqueue before any provider group exists", async () => {
    const publish = await publicationPlan();
    const source = publish.source.identity;
    const target = { ...publish.targetIdentity, variants: source.variants.map(member => ({ ...member, externalSku: member.sku })) };
    const key = randomUUID();
    const saved = await enqueueReviewedTarget(source, target, key);
    expect(saved).toMatchObject({ state: "queued", publicationTarget: target, providerIdentity: null, publicationAccepted: null });
    expect((await enqueueReviewedTarget(source, target, key)).id).toBe(saved.id);
    const receipts = (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='requested'", [saved.id])).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0].evidence).toMatchObject({ commandKey: key, actor: "stock-reviewer", reviewedPublicationTarget: target });
    const jobs = new PostgresEbayListingSyncRepository(database.pool);
    const claim = await jobs.claim(now, randomUUID(), saved.id);
    expect(claim?.job.publicationTarget).toEqual(target);
    try { await jobs.bindPublicationTarget(claim!.job, target, now); }
    finally { await claim!.release(); }
    expect((await jobs.get(saved.id)).providerIdentity).toBeNull();
    await expect(enqueueReviewedTarget(source, { ...target, groupKey: "different-reviewed-group" })).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect((await jobs.get(saved.id)).revision).toBe("1");
  });
  it("pins an idle job's previously missing target and rejects unrelated identities without leaking a command", async () => {
    const publish = await publicationPlan();
    const source = publish.source.identity;
    const target = { ...publish.targetIdentity, variants: source.variants.map(member => ({ ...member, externalSku: member.sku })) };
    const jobs = new PostgresEbayListingSyncRepository(database.pool);
    const initial = await jobs.enqueue(source, randomUUID(), "original-requester", now, "publish");
    const saved = await enqueueReviewedTarget(source, target);
    expect(saved).toMatchObject({ id: initial.id, revision: "2", publicationTarget: target });
    const invalidKey = randomUUID();
    await expect(enqueueReviewedTarget(source, { ...target, accountId: "different-account" }, invalidKey)).rejects.toMatchObject({ code: "EBAY_SYNC_PROVIDER_IDENTITY_CHANGED" });
    expect(await jobs.getByCommand(invalidKey, source.channelId)).toBeNull();
  });
  it("rolls back reviewed target admission when its audit receipt fails and refuses an unreceipted target write", async () => {
    const publish = await publicationPlan();
    const source = publish.source.identity;
    const target = { ...publish.targetIdentity, variants: source.variants.map(member => ({ ...member, externalSku: member.sku })) };
    await database.pool.query(`CREATE FUNCTION channels.test_target_review_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event='requested' AND NEW.evidence ? 'reviewedPublicationTarget' THEN RAISE EXCEPTION 'injected reviewed target audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_target_review_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_target_review_failure()`);
    try { await expect(enqueueReviewedTarget(source, target)).rejects.toThrow("injected reviewed target audit failure"); }
    finally { await database.pool.query("DROP TRIGGER test_target_review_failure ON channels.ebay_listing_sync_events; DROP FUNCTION channels.test_target_review_failure()"); }
    expect((await counts()).jobs).toBe(0);
    const saved = await new PostgresEbayListingSyncRepository(database.pool).enqueue(source, randomUUID(), "operator", now, "publish");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(918427,hashtext($1))", [saved.id]);
      await expect(client.query("UPDATE channels.ebay_listing_sync_jobs SET publication_target=$2::jsonb,publication_target_hash=$3 WHERE id=$1", [saved.id, JSON.stringify(target), "a".repeat(64)])).rejects.toMatchObject({ code: "23514" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  async function exclusionIntent() {
    return (await database.pool.query(`SELECT p.ebay_listing_excluded,cpo.is_listed FROM catalog.products p
      LEFT JOIN channels.channel_product_overrides cpo ON cpo.product_id=p.id AND cpo.channel_id=67 WHERE p.id=$1`,[plan.source.identity.productId])).rows[0];
  }
  it("atomically excludes and saves withdrawal with immutable receipt; duplicate commands and changed intent replay exactly",async()=>{
    const owner=exclusionOwner();const command={excluded:true,commandKey:randomUUID()};const before=await mappings();
    const results=await Promise.all([owner.set(plan.source.identity.productId,command,"operator"),owner.set(plan.source.identity.productId,command,"operator")]);
    expect(results.map(row=>row.replayed).sort()).toEqual([false,true]);expect(results[0].job?.id).toBe(results[1].job?.id);
    expect(results[0]).toMatchObject({remoteAction:"queued_withdrawal",job:{operation:"withdraw",state:"queued"}});
    expect(await exclusionIntent()).toEqual({ebay_listing_excluded:true,is_listed:0});expect(await mappings()).toEqual(before);
    const saved=await new PostgresEbayListingSyncRepository(database.pool).get(results[0].job!.id);
    expect(saved.identity.variants.every(member=>member.contentSyncEnabled===false)).toBe(true);expect(saved.requestedBy).toBe("operator");
    await expect(owner.set(plan.source.identity.productId,{...command,excluded:false},"operator")).rejects.toMatchObject({code:"EBAY_SYNC_REPLAY_CONFLICT"});
    await expect(owner.set(plan.source.identity.productId,command,"someone else")).rejects.toMatchObject({code:"EBAY_SYNC_REPLAY_CONFLICT"});
    expect((await owner.get(plan.source.identity.productId,command.commandKey)).job?.id).toBe(saved.id);
    await expect(database.pool.query("DELETE FROM channels.ebay_listing_exclusion_commands WHERE command_key=$1",[command.commandKey])).rejects.toMatchObject({code:"23514"});
  });
  it("rolls back local exclusion and queued work if the immutable intent receipt cannot be committed",async()=>{
    const before=await exclusionIntent();await database.pool.query(`CREATE FUNCTION channels.test_exclusion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected exclusion audit failure';END $$;
      CREATE TRIGGER test_exclusion_failure BEFORE INSERT ON channels.ebay_listing_exclusion_commands FOR EACH ROW EXECUTE FUNCTION channels.test_exclusion_failure()`);
    try{await expect(exclusionOwner().set(plan.source.identity.productId,{excluded:true,commandKey:randomUUID()},"operator")).rejects.toThrow("injected exclusion audit failure");}
    finally{await database.pool.query("DROP TRIGGER test_exclusion_failure ON channels.ebay_listing_exclusion_commands;DROP FUNCTION channels.test_exclusion_failure()");}
    expect(await exclusionIntent()).toEqual(before);expect((await counts()).jobs).toBe(0);
  });
  it("blocks reinclude and positive publication while withdrawal is pending; a new exclusion command joins its one job",async()=>{
    const owner=exclusionOwner();const first=await owner.set(plan.source.identity.productId,{excluded:true,commandKey:randomUUID()},"operator");
    const joined=await owner.set(plan.source.identity.productId,{excluded:true,commandKey:randomUUID()},"operator");expect(joined.job?.id).toBe(first.job?.id);
    await expect(owner.set(plan.source.identity.productId,{excluded:false,commandKey:randomUUID()},"operator")).rejects.toMatchObject({code:"EBAY_WITHDRAWAL_IN_PROGRESS",jobId:first.job!.id});
    await expect(new PostgresEbayListingSyncRepository(database.pool).enqueue(plan.source.identity,randomUUID(),"operator",now,"sync")).rejects.toMatchObject({code:"EBAY_WITHDRAWAL_IN_PROGRESS"});
    expect((await counts()).jobs).toBe(1);expect(await exclusionIntent()).toEqual({ebay_listing_excluded:true,is_listed:0});
  });
  it("records local-only exclusion and inclusion without pretending an unknown remote listing ended",async()=>{
    await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=ANY($1::integer[])",[plan.source.identity.variants.map(member=>member.variantId)]);
    const owner=exclusionOwner();const command={excluded:true,commandKey:randomUUID()};const first=await owner.set(plan.source.identity.productId,command,"operator");
    expect(first).toMatchObject({remoteAction:"local_exclusion",job:null});
    const included=await owner.set(plan.source.identity.productId,{excluded:false,commandKey:randomUUID()},"operator");expect(included).toMatchObject({remoteAction:"included",job:null});
    expect((await owner.set(plan.source.identity.productId,command,"operator")).replayed).toBe(true);expect(await exclusionIntent()).toEqual({ebay_listing_excluded:false,is_listed:1});
    expect((await counts()).jobs).toBe(0);
  });
  it("refuses local-only exclusion while an initial publication still owns an unmapped remote outcome", async () => {
    const publish = await publicationPlan();
    const jobs = new PostgresEbayListingSyncRepository(database.pool);
    const pending = await jobs.enqueue(publish.source.identity, randomUUID(), "publisher", now, "publish");
    await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id=ANY($1::integer[])", [publish.source.identity.variants.map(member => member.variantId)]);
    const before = await exclusionIntent();
    await expect(exclusionOwner().set(publish.source.identity.productId, { excluded: true, commandKey: randomUUID() }, "operator"))
      .rejects.toMatchObject({ code: "EBAY_PUBLICATION_PRIOR_WORK_REQUIRED", jobId: pending.id });
    expect(await exclusionIntent()).toEqual(before);
    expect((await counts()).jobs).toBe(1);
  });
  it("withdrawal worker survives provider success plus projection rollback without repeating withdrawal or overwriting quantity/history",async()=>{
    const owner=exclusionOwner();const saved=await owner.set(plan.source.identity.productId,{excluded:true,commandKey:randomUUID()},"operator");
    const jobs=new PostgresEbayListingSyncRepository(database.pool);const source=(await jobs.get(saved.job!.id)).identity;const before=await mappings();let published=true;
    const groupKey=`OLD-${source.productId}`;
    const inspect=async():Promise<EbayListingInspection>=>({providerAccount:plan.observation.providerAccount,observedAt:now,
      groupKey,groupSkus:source.variants.map(member=>member.sku),publicationIssue:null,unpublishedTarget:published?null:{groupKey,skus:source.variants.map(member=>member.sku)},
      skus:source.variants.map(member=>({sku:member.sku,inventoryItemExists:true,issue:null,offers:[{sku:member.sku,offerId:member.offerId!,status:published?"PUBLISHED":"UNPUBLISHED",listingId:published?member.listingId:null,listingStatus:published?"ACTIVE":null}]})),
      publication:published?{...plan.observation,publicationKeyIdentity:{externalId:groupKey,identityNamespace:"ebay:production:EBAY_US:inventory_item_group"},
        listingIdentity:{externalId:source.variants[0].listingId!,identityNamespace:"ebay:production:EBAY_US:listing"},members:source.variants.map(member=>({sku:member.sku,variantIdentity:null,
          offerIdentity:{externalId:member.offerId!,identityNamespace:"ebay:production:EBAY_US:offer"},inventoryItemIdentity:{externalId:member.sku,identityNamespace:"ebay:production:EBAY_US:inventory_item"}}))}:null});
    const client={withdrawOffer:vi.fn(async()=>{published=false;}),withdrawOfferByInventoryItemGroup:vi.fn(async()=>{published=false;})};
    const recovery={reconcile:vi.fn(async()=>({busy:false,resolved:[],unresolved:[]}))};
    const execute=new EbayListingWithdrawalExecution(async()=>({sourceIdentity:source,inspect,client}),recovery);
    const worker=(clock:Date)=>new EbayListingSyncService(new PostgresEbayListingSyncRepository(database.pool),execute,()=>clock,randomUUID);
    await database.pool.query(`CREATE FUNCTION channels.test_withdraw_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event='completed' THEN RAISE EXCEPTION 'injected withdrawal final audit failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER test_withdraw_completion_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_withdraw_completion_failure()`);
    try{expect(await worker(now).processDue(1,saved.job!.id)).toEqual({processed:0,failed:1});}
    finally{await database.pool.query("DROP TRIGGER test_withdraw_completion_failure ON channels.ebay_listing_sync_events;DROP FUNCTION channels.test_withdraw_completion_failure()");}
    expect(await mappings()).toEqual(before);expect(await jobs.get(saved.job!.id)).toMatchObject({state:"recovering",withdrawalWriteCompleted:true,providerIdentity:{groupKey}});
    expect(await worker(new Date(now.getTime()+10*60_000)).processDue(1,saved.job!.id)).toEqual({processed:1,failed:0});
    expect((await jobs.get(saved.job!.id)).state).toBe("completed");expect(client.withdrawOfferByInventoryItemGroup).toHaveBeenCalledExactlyOnceWith(groupKey,"EBAY_US");
    for(const row of await mappings()){const prior=before.find(value=>value.product_variant_id===row.product_variant_id)!;
      expect(row.sync_status).toBe("ended");for(const column of ["external_sku","external_variant_id","external_product_id","external_url","last_synced_qty","last_synced_price","created_at"])expect(row[column]).toEqual(prior[column]);}
    const included=await exclusionOwner(new Date(now.getTime()+20*60_000)).set(source.productId,{excluded:false,commandKey:randomUUID()},"operator");
    expect(included).toMatchObject({remoteAction:"included",job:null});expect((await mappings()).every(row=>row.sync_status==="ended")).toBe(true);
  });
  it("never repeats accepted withdrawal after stage receipt loss; reviewed retry is concurrent-safe and cannot bypass completed acceptance",async()=>{
    const saved=await exclusionOwner().set(plan.source.identity.productId,{excluded:true,commandKey:randomUUID()},"operator");
    const jobs=new PostgresEbayListingSyncRepository(database.pool);const source=(await jobs.get(saved.job!.id)).identity;
    let published=true;let visible=false;const groupKey=`OLD-${source.productId}`;
    const inspect=async():Promise<EbayListingInspection>=>{
      const active=published||!visible;
      return{providerAccount:plan.observation.providerAccount,observedAt:now,groupKey,groupSkus:source.variants.map(member=>member.sku),publicationIssue:null,
        unpublishedTarget:active?null:{groupKey,skus:source.variants.map(member=>member.sku)},
        skus:source.variants.map(member=>({sku:member.sku,inventoryItemExists:true,issue:null,offers:[{sku:member.sku,offerId:member.offerId!,status:active?"PUBLISHED":"UNPUBLISHED",listingId:active?member.listingId:null,listingStatus:active?"ACTIVE":null}]})),
        publication:active?{...plan.observation,publicationKeyIdentity:{externalId:groupKey,identityNamespace:"ebay:production:EBAY_US:inventory_item_group"},listingIdentity:{externalId:source.variants[0].listingId!,identityNamespace:"ebay:production:EBAY_US:listing"},
          members:source.variants.map(member=>({sku:member.sku,variantIdentity:null,offerIdentity:{externalId:member.offerId!,identityNamespace:"ebay:production:EBAY_US:offer"},inventoryItemIdentity:{externalId:member.sku,identityNamespace:"ebay:production:EBAY_US:inventory_item"}}))}:null};
    };
    const client={withdrawOffer:vi.fn(async()=>{published=false;}),withdrawOfferByInventoryItemGroup:vi.fn(async()=>{published=false;})};
    const execute=new EbayListingWithdrawalExecution(async()=>({sourceIdentity:source,inspect,client}),{reconcile:async()=>({busy:false,resolved:[],unresolved:[]})});
    const worker=(clock:Date)=>new EbayListingSyncService(new PostgresEbayListingSyncRepository(database.pool),execute,()=>clock,randomUUID);
    await database.pool.query(`CREATE FUNCTION channels.test_withdraw_stage_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event='stage_completed' AND NEW.evidence->>'key'='withdraw' THEN RAISE EXCEPTION 'injected post-response audit failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER test_withdraw_stage_failure BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_withdraw_stage_failure()`);
    try{expect(await worker(now).processDue(1,saved.job!.id)).toEqual({processed:0,failed:1});}
    finally{await database.pool.query("DROP TRIGGER test_withdraw_stage_failure ON channels.ebay_listing_sync_events;DROP FUNCTION channels.test_withdraw_stage_failure()");}
    const interrupted=await jobs.get(saved.job!.id);expect(interrupted).toMatchObject({state:"awaiting_evidence",withdrawalWriteStarted:true,withdrawalWriteCompleted:false});
    expect(await worker(new Date(now.getTime()+10*60_000)).processDue(1,saved.job!.id)).toEqual({processed:0,failed:1});
    expect(client.withdrawOfferByInventoryItemGroup).toHaveBeenCalledTimes(1);expect((await jobs.get(saved.job!.id)).code).toBe("EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN");
    const command={jobId:saved.job!.id,channelId:67,expectedRevision:interrupted.revision,reviewHash:publicationRetryReviewHash(interrupted),commandKey:randomUUID(),actor:"inventory-admin"};
    const authorized=await Promise.all([jobs.authorizePublicationRetry(command,new Date(now.getTime()+11*60_000)),jobs.authorizePublicationRetry(command,new Date(now.getTime()+11*60_000))]);
    expect(authorized.map(row=>row.replayed).sort()).toEqual([false,true]);expect(authorized[0].job).toMatchObject({id:saved.job!.id,revision:"2",state:"queued",withdrawalWriteStarted:false});
    expect((await database.pool.query("SELECT count(*)::integer AS n FROM channels.ebay_listing_sync_events WHERE job_id=$1 AND event='withdrawal_retry_authorized'",[saved.job!.id])).rows[0].n).toBe(1);
    // The explicit retry still inspects first. The now-visible response ends it
    // without sending another withdrawal or claiming the old request succeeded.
    visible=true;expect(await worker(new Date(now.getTime()+12*60_000)).processDue(1,saved.job!.id)).toEqual({processed:1,failed:0});
    expect(client.withdrawOfferByInventoryItemGroup).toHaveBeenCalledTimes(1);expect((await jobs.get(saved.job!.id)).state).toBe("completed");
    expect((await jobs.authorizePublicationRetry(command,new Date(now.getTime()+13*60_000))).replayed).toBe(true);
    await expect(jobs.authorizePublicationRetry({...command,commandKey:randomUUID()},new Date(now.getTime()+13*60_000))).rejects.toMatchObject({code:"EBAY_PUBLICATION_RETRY_NOT_ALLOWED"});
  });
});
