import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { syncStageHash } from "../../ebay-listing-sync.domain";
import { EbayListingMappingService, type EbayListingMappingRepairPlan } from "../../ebay-listing-mapping.service";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../../ebay-listing-workflow-lock";
vi.mock("../../../../db", () => ({ pool: {} }));

const enabled = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(enabled ? describe : describe.skip).sequential("local eBay mapping repair atomicity in real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: PostgresEbayListingMappingRepairRepository;
  let canonical: PgMarketplaceListingRegistrationRepository;
  let plan: EbayListingMappingRepairPlan;
  let sequence = 20;
  const now = new Date("2026-10-10T15:00:00Z");
  beforeAll(async () => {
    // Named-schema fixture; the real sync job and repair constraints/triggers
    // below are installed verbatim. Unrelated inventory migrations are excluded.
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, `
      CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay; CREATE SCHEMA inventory; CREATE SCHEMA marketplace;
      CREATE FUNCTION inventory.reject_availability_claim_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'immutable evidence' USING ERRCODE='23514'; END $$;
      CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text NOT NULL);
      CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer REFERENCES channels.channels,metadata jsonb);
      CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer REFERENCES channels.channels,environment text,external_account_id text,
        external_account_identity_scheme text,external_account_verified_at timestamptz,PRIMARY KEY(channel_id,environment));
      CREATE TABLE catalog.products(id integer PRIMARY KEY,product_type text DEFAULT 'test');
      CREATE TABLE channels.channel_product_overrides(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels,product_id integer REFERENCES catalog.products,is_listed integer);
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products,sku text,is_active boolean);
      CREATE TABLE channels.channel_variant_overrides(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels,product_variant_id integer REFERENCES catalog.product_variants,is_listed integer);
      CREATE TABLE ebay.ebay_category_mappings(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels,product_type_slug text,listing_enabled boolean);
      CREATE TABLE channels.channel_listings(id integer GENERATED ALWAYS AS IDENTITY,channel_id integer REFERENCES channels.channels,
        product_variant_id integer REFERENCES catalog.product_variants,external_sku text,external_variant_id text,external_product_id text,external_url text,
        last_synced_price bigint,last_synced_qty integer,sync_status text,sync_error text,last_synced_at timestamptz,created_at timestamptz,updated_at timestamptz,
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
    for (const migration of ["0731_ebay_listing_sync_verification_checkpoint.sql","0732_ebay_listing_sync_identity_admission.sql","0736_ebay_listing_mapping_repairs.sql"])
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
    await database.pool.query("INSERT INTO catalog.product_variants VALUES($1,$3,$4,true),($2,$3,$5,true)",[productId*10+1,productId*10+2,productId,`NEW-${productId}-P10`,`NEW-${productId}-C500`]);
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
        marketplaceId:"EBAY_US",publicationKeyIdentity:{externalId:`OLD-${productId}`,identityNamespace:"ebay.inventory_item_group"},
        listingIdentity:{externalId:`listing-${productId}`,identityNamespace:"ebay.listing"},externalUrl:`https://www.ebay.com/itm/listing-${productId}`,isPublished:true,
        members:provenIdentity.variants.map(member => ({sku:member.sku,variantIdentity:null,offerIdentity:{externalId:member.offerId!,identityNamespace:"ebay.offer"},
          inventoryItemIdentity:{externalId:member.sku,identityNamespace:"ebay.inventory_item"}})),evidence:{},observedAt:now} };
    plan.requestHash=syncStageHash({productId,channelId:67,actor:plan.actor,reviewHash:plan.reviewHash});
  });
  async function readSource(client: PoolClient, productId: number): Promise<EbayListingMappingSourceSnapshot> {
    const rows = (await client.query(`SELECT pv.product_id,pv.id AS variant_id,pv.sku AS variant_sku,pv.is_active,cl.external_sku,cl.external_variant_id,cl.external_product_id
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
    await database.pool.query("INSERT INTO marketplace.provider_identity_claims VALUES(1,999,999,NULL,'listing_id','ebay.listing',$1)",[plan.observation.listingIdentity.externalId]);
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
});
