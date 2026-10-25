import { randomUUID } from "node:crypto";
import { ListingMemberRecoveryService } from "../../application/listing-member-recovery.service";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { readChannelStockSelection } from "../../../channels/channel-stock-selection";
import { PostgresListingMemberLifecycleRepository, readListingMemberRetirements, assertArchivedMemberPublicationAllowed } from "../../infrastructure/pg-listing-member-lifecycle.repository";
import { PostgresListingLifecycleRepository } from "../../infrastructure/pg-listing-lifecycle.repository";
import { listingAccountKey } from "../../domain/listing-publication";
import { processListingMemberRetirement } from "../../application/process-listing-member-retirement";
import { archivedListingMemberSelection } from "../../domain/listing-member-lifecycle";
import { EbayListingMemberAdapter } from "../../infrastructure/providers/ebay/ebay-listing-member.adapter";
import { ShopifyListingMemberAdapter } from "../../infrastructure/providers/shopify-listing-member.adapter";
import { WalmartListingMemberAdapter } from "../../../channels/adapters/walmart/walmart-listing-member.adapter";
import { installListingMemberLifecycleFixture, listingMemberBaseSql } from "../fixtures/listing-member-lifecycle.fixture";
import { createListingMemberLifecycle } from "../../../../listing-member-lifecycle.composition";

// The composition must use its injected disposable pool. Unrelated imported
// runtime defaults cannot reach an application database in this suite.
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const now = new Date("2026-10-19T12:00:00.000Z");
(url && disposable ? describe : describe.skip).sequential("shared archived listing lifecycle with PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let store: PostgresListingMemberLifecycleRepository;
  const remote = new Map<string, unknown>();
  const getOffer = vi.fn(async (id: string) => remote.get(id) ?? null);
  const clearOffer = vi.fn(async (_id: string, _sku: string) => {});
  const deleteOffer = vi.fn(async (id: string) => { remote.delete(id); });
  const adapter = new EbayListingMemberAdapter(async () => ({ getOffer, clearOffer, deleteOffer }));
  const run = async (date = now) => {
    await store.discover(date, 25);
    for (const id of await store.due(date, 25)) await store.withMember(id, session => processListingMemberRetirement(session,
      { store, adapter: async () => adapter }, () => date));
  };
  const receipts = () => readListingMemberRetirements(database.pool, { destinationKind: "channel_connection", connectionId: 11, productVariantIds: [302] });
  const selection = () => readChannelStockSelection(database.pool, { channelId: 10, channelConnectionId: 11, productId: 30, productVariantIds: [301,302] });
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, listingMemberBaseSql);
    await installListingMemberLifecycleFixture(database.pool);
    store = new PostgresListingMemberLifecycleRepository(database.pool);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE marketplace.listing_member_recovery_commands,marketplace.listing_member_retirement_events,marketplace.listing_member_retirements;
      TRUNCATE catalog.products,channels.channels CASCADE;
      TRUNCATE channels.channel_connections,channels.walmart_connections,channels.channel_feeds,channels.channel_listings,ebay.ebay_oauth_tokens,
        channels.ebay_listing_sync_jobs,dropship.dropship_vendor_listings,dropship.dropship_store_connections,
        dropship.dropship_listing_push_jobs,dropship.dropship_listing_push_job_items;
      INSERT INTO catalog.products(id,is_active,status) VALUES(30,true,'active');
      INSERT INTO catalog.product_variants(id,product_id,sku,uom_type,is_active,requires_shipping,track_inventory,sales_eligibility)
        VALUES(301,30,'ACTIVE-PACK','pack',true,true,true,'sellable'),(302,30,'RENAMED-ARCHIVED-PACK','case',false,true,true,'sellable');
      INSERT INTO channels.channels VALUES(10,'ebay'); INSERT INTO channels.channel_connections(id,channel_id) VALUES(11,10);
      INSERT INTO ebay.ebay_oauth_tokens VALUES(10,'production','seller-one','provider_user_id',now());
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
        VALUES(10,301,'ACTIVE-PACK','offer-active','listing','synced'),(10,302,'OLD-REMOTE-SKU','offer-archived',NULL,'synced');`);
    vi.clearAllMocks(); remote.clear();
    getOffer.mockImplementation(async id => remote.get(id) ?? null);
    deleteOffer.mockImplementation(async id => { remote.delete(id); });
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "UNPUBLISHED" });
  });
  // Audit acceptance test: a durable marker alone cannot establish that a
  // provider request was dispatched. Restart needs a safe, actionable resolution.
  it("AUDIT: recovers a crash after the retirement marker commits but before dispatch", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await store.discover(now, 25);
    const [id] = await store.due(now, 25);
    await expect(store.withMember(id, session => processListingMemberRetirement({
      ...session,
      save: async (...args) => {
        const saved = await session.save(...args);
        if (args[0] === "retiring") throw new Error("AUDIT simulated process exit before provider dispatch");
        return saved;
      },
    }, { store, adapter: async () => adapter }, () => now))).rejects.toThrow("AUDIT simulated process exit");
    expect(deleteOffer).not.toHaveBeenCalled();
    expect(clearOffer).not.toHaveBeenCalled();
    expect((await receipts())[0]).toMatchObject({ operationId: id, state: "retiring" });
    store = new PostgresListingMemberLifecycleRepository(database.pool);
    for (let attempt = 1; attempt <= 6; attempt++) await run(new Date(now.getTime() + attempt * 120_000));
    // Safe recovery may reconcile a proven no-send or expose a deliberate
    // recovery decision. Permanent observation-only "retiring" is a dead end.
    expect((await receipts())[0]).toMatchObject({state:"failed",recoveryRequired:true,dispatchStatus:"unknown"});
    const recovery = new ListingMemberRecoveryService({store,adapter:async()=>adapter},()=>now);
    const review = await recovery.preview(10,id);
    expect(review).toMatchObject({canResume:true,observation:{retired:false}});
    const command = {operationId:id,commandKey:randomUUID(),reviewHash:review.reviewHash};
    await recovery.resume(10,command,"operator");
    await recovery.resume(10,command,"operator");
    await run(new Date(now.getTime()+900_000));
    expect((await receipts())[0]).toMatchObject({state:"retired",operationId:id});
    expect(deleteOffer).toHaveBeenCalledTimes(1);
    expect((await database.pool.query("SELECT actor,before_record,observation FROM marketplace.listing_member_recovery_commands")).rows)
      .toMatchObject([{actor:"operator",before_record:{state:"failed",dispatch_status:"unknown"},observation:{retired:false}}]);
    expect((await database.pool.query("SELECT count(*)::int n FROM marketplace.listing_member_retirement_events WHERE after_state->>'dispatch_status'='unknown'")).rows[0].n).toBeGreaterThan(0);
  });

  async function unresolvedRecovery() {
    remote.set("offer-archived", {offerId:"offer-archived",sku:"OLD-REMOTE-SKU",marketplaceId:"EBAY_US",status:"PUBLISHED"});
    deleteOffer.mockImplementationOnce(async () => { throw new Error("lost response"); });
    await run(); await run(new Date(now.getTime()+120_000));
    const [record] = await receipts();
    const service = new ListingMemberRecoveryService({store,adapter:async()=>adapter},()=>new Date(now.getTime()+240_000));
    return {record,service};
  }

  it("rejects malformed normalized observations without completing or authorizing a removal", async () => {
    const { record } = await unresolvedRecovery();
    const retire = vi.fn();
    const malformed = {
      observe: async (identity: ListingMemberIdentity) => ({ identity, retired: "false" as unknown as boolean }),
      retire,
    };
    const dependencies = { store, adapter: async () => malformed };
    const service = new ListingMemberRecoveryService(dependencies, () => now);
    await expect(service.preview(10, record.operationId)).rejects.toMatchObject({ code: "LISTING_MEMBER_OBSERVATION_INVALID" });
    await store.withMember(record.operationId, session => processListingMemberRetirement(session, dependencies, () => now));
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_OBSERVATION_INVALID", recoveryRequired: true });
    expect(retire).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::integer n FROM marketplace.listing_member_recovery_commands")).rows[0].n).toBe(0);
  });

  it("enforces recovery authorization at the database boundary", async () => {
    const { record } = await unresolvedRecovery();
    await expect(database.pool.query(
      "UPDATE marketplace.listing_member_retirements SET recovery_required=false WHERE id=$1",
      [record.operationId],
    )).rejects.toThrow(/immutable authorization/);
    await expect(database.pool.query(
      "UPDATE marketplace.listing_member_retirements SET state='pending',dispatch_status='authorized',dispatch_key=$2 WHERE id=$1",
      [record.operationId, randomUUID()],
    )).rejects.toThrow(/immutable authorization/);
    expect((await receipts())[0]).toMatchObject({ state: "failed", recoveryRequired: true });
  });

  it("recovers a Dropship member through the same owner and fences the vendor and store", async () => {
    await database.pool.query(
      "INSERT INTO dropship.dropship_store_connections VALUES(70,7,'ebay',NULL,'dropship-seller','production','connected');" +
      "INSERT INTO dropship.dropship_vendor_listings VALUES(80,7,70,302,NULL,'dropship-offer');" +
      "INSERT INTO dropship.dropship_listing_push_jobs VALUES(90,7,70);" +
      "INSERT INTO dropship.dropship_listing_push_job_items VALUES(91,90,80,302,'push','completed','{\"listingIntent\":{\"sku\":\"DROPSHIP-OLD-SKU\",\"marketplaceConfig\":{\"marketplaceId\":\"EBAY_US\"}}}');",
    );
    remote.set("dropship-offer", { offerId: "dropship-offer", sku: "DROPSHIP-OLD-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await store.discover(now, 25);
    const [record] = await readListingMemberRetirements(database.pool, { destinationKind: "dropship_store_connection", connectionId: 70, productVariantIds: [302] });
    await store.withMember(record.operationId, session => session.save("retiring", null, "Unconfirmed dispatch", now, { dispatchStatus: "unknown" }));
    const dependencies = { store, adapter: async () => adapter };
    await store.withMember(record.operationId, session => processListingMemberRetirement(session, dependencies, () => now));
    const service = new ListingMemberRecoveryService(dependencies, () => now);
    const scope = { connectionId: 70, vendorId: 7 };
    await expect(service.preview({ ...scope, vendorId: 8 }, record.operationId)).rejects.toMatchObject({ code: "LISTING_MEMBER_RECOVERY_SCOPE_CHANGED" });
    await expect(service.preview({ ...scope, connectionId: 71 }, record.operationId)).rejects.toMatchObject({ code: "LISTING_MEMBER_RECOVERY_SCOPE_CHANGED" });
    const review = await service.preview(scope, record.operationId);
    const command = { operationId: record.operationId, commandKey: randomUUID(), reviewHash: review.reviewHash };
    await service.resume(scope, command, "dropship-member:14");
    await service.resume(scope, command, "dropship-member:14");
    await store.withMember(record.operationId, session => processListingMemberRetirement(session, dependencies, () => now));
    expect(deleteOffer).toHaveBeenCalledTimes(1);
    const [completed] = await readListingMemberRetirements(database.pool, { destinationKind: "dropship_store_connection", connectionId: 70, productVariantIds: [302] });
    expect(completed).toMatchObject({ state: "retired", recoveryRequired: false });
  });

  it("fences reactivation and stale identity changes before a reviewed recovery can authorize dispatch", async () => {
    const {record,service} = await unresolvedRecovery();
    const review = await service.preview(10,record.operationId);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=updated_at+interval '1 second' WHERE id=302");
    await expect(service.resume(10,{operationId:record.operationId,commandKey:randomUUID(),reviewHash:review.reviewHash},"operator"))
      .rejects.toMatchObject({code:"LISTING_MEMBER_RECOVERY_SCOPE_CHANGED"});
    expect(deleteOffer).toHaveBeenCalledTimes(1);
    expect((await database.pool.query("SELECT count(*)::int n FROM marketplace.listing_member_recovery_commands")).rows[0].n).toBe(0);
  });
  it("serializes concurrent confirmations and retains receipt-first replay after removal", async () => {
    const {record,service} = await unresolvedRecovery();
    const review = await service.preview(10,record.operationId);
    const command = {operationId:record.operationId,commandKey:randomUUID(),reviewHash:review.reviewHash};
    const results = await Promise.allSettled([service.resume(10,command,"operator"),service.resume(10,command,"operator")]);
    expect(results.some(result=>result.status==="fulfilled")).toBe(true);
    await service.resume(10,command,"operator");
    await run(new Date(now.getTime()+360_000));
    await service.resume(10,command,"operator");
    expect(deleteOffer).toHaveBeenCalledTimes(2);
    expect((await database.pool.query("SELECT count(*)::int n FROM marketplace.listing_member_recovery_commands")).rows[0].n).toBe(1);
    await expect(service.resume(10,command,"different-operator")).rejects.toMatchObject({code:"LISTING_MEMBER_RECOVERY_REPLAY_CONFLICT"});
    await expect(service.resume(11,command,"operator")).rejects.toMatchObject({code:"LISTING_MEMBER_RECOVERY_SCOPE_CHANGED"});
    await expect(database.pool.query("DELETE FROM marketplace.listing_member_recovery_commands")).rejects.toThrow(/immutable/);
  });
  it("rolls back a failed recovery audit and rejects a stale observation without sending", async () => {
    const {record,service} = await unresolvedRecovery();
    const review = await service.preview(10,record.operationId);
    const command = {operationId:record.operationId,commandKey:randomUUID(),reviewHash:review.reviewHash};
    await database.pool.query(`CREATE FUNCTION marketplace.reject_recovery_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'recovery audit unavailable'; END $$;
      CREATE TRIGGER reject_recovery_test BEFORE INSERT ON marketplace.listing_member_recovery_commands
      FOR EACH ROW EXECUTE FUNCTION marketplace.reject_recovery_test();`);
    try { await expect(service.resume(10,command,"operator")).rejects.toThrow("recovery audit unavailable"); }
    finally { await database.pool.query("DROP TRIGGER reject_recovery_test ON marketplace.listing_member_recovery_commands; DROP FUNCTION marketplace.reject_recovery_test()"); }
    expect((await receipts())[0]).toMatchObject({state:"failed",recoveryRequired:true});
    remote.delete("offer-archived");
    await expect(service.resume(10,command,"operator")).rejects.toMatchObject({code:"LISTING_MEMBER_RECOVERY_REVIEW_STALE"});
    await run(new Date(now.getTime()+360_000));
    expect((await receipts())[0].state).toBe("retired");
    expect(deleteOffer).toHaveBeenCalledTimes(1);
  });

  it.each(["ebay","shopify","walmart"])("uses the same recovery authority for %s without adapter-owned retry decisions",async provider=>{
    await database.pool.query("UPDATE channels.channels SET provider=$1",[provider]);
    if(provider==="shopify") await database.pool.query("UPDATE channels.channel_connections SET shop_domain='shared-store.myshopify.com'");
    if(provider==="walmart") await database.pool.query("INSERT INTO channels.walmart_connections VALUES(11,'partner','production','us')");
    await store.discover(now,25);
    const [id]=await store.due(now,25);
    await store.withMember(id,session=>session.save("retiring",null,"Unconfirmed dispatch",now,{dispatchStatus:"unknown"}));
    let removed=false;
    const retire=vi.fn(async()=>{removed=true;});
    const normalized={observe:async(identity:ListingMemberIdentity)=>({identity,retired:removed}),retire};
    const dependencies={store,adapter:async()=>normalized};
    await store.withMember(id,session=>processListingMemberRetirement(session,dependencies,()=>now));
    const recovery=new ListingMemberRecoveryService(dependencies,()=>now);
    const review=await recovery.preview(10,id);
    await recovery.resume(10,{operationId:id,commandKey:randomUUID(),reviewHash:review.reviewHash},"operator");
    await store.withMember(id,session=>processListingMemberRetirement(session,dependencies,()=>now));
    expect((await receipts())[0]).toMatchObject({state:"retired",identity:{provider},recoveryRequired:false});
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("excludes archived members immediately and verifies an unpublished offer without any inventory mapping or live listing ID", async () => {
    expect((await selection()).variants.map(row => row.action)).toEqual(["publish","none"]);
    await run();
    const [receipt] = await receipts();
    expect(receipt).toMatchObject({ state: "retired", identity: { externalSku: "OLD-REMOTE-SKU", externalProductId: null } });
    expect(archivedListingMemberSelection({ productVariantId: 302, archived: true, retirement: receipt })?.retirementEvidence)
      .toMatchObject({ externalOfferId: "offer-archived", externalListingId: null });
    expect(getOffer).toHaveBeenCalledWith("offer-archived"); expect(deleteOffer).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT to_regclass('inventory.publication_variant_mapping_heads') AS mapping")).rows[0].mapping).toBeNull();
  });
  it.each(["SKU", "offer", "cross-destination SKU"])("rejects an active provider %s alias before archived-member removal", async alias => {
    if (alias === "cross-destination SKU") {
      await database.pool.query(`INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,external_account_id,provider_environment)
          VALUES(21,22,'ebay','seller-one','production');
        INSERT INTO dropship.dropship_vendor_listings(id,vendor_id,store_connection_id,product_variant_id,external_offer_id)
          VALUES(23,22,21,301,'different-offer');
        INSERT INTO dropship.dropship_listing_push_jobs VALUES(24,22,21);
        INSERT INTO dropship.dropship_listing_push_job_items VALUES(25,24,23,301,'push','completed',
          '{"listingIntent":{"sku":"OLD-REMOTE-SKU","marketplaceConfig":{"marketplaceId":"EBAY_US"}}}');`);
    } else if (alias === "SKU") {
      await database.pool.query("UPDATE channels.channel_listings SET external_sku='OLD-REMOTE-SKU' WHERE product_variant_id=301");
    } else {
      await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='offer-archived' WHERE product_variant_id=301");
    }
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await run();
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CONFLICT", identity: { identityConflict: true } });
    expect(getOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled();
  });
  it("retains completion across new active sync jobs, process restarts and repeated discovery", async () => {
    await run(); const first = await receipts();
    await database.pool.query(`INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,state,identity)
      VALUES('00000000-0000-4000-8000-000000000004',10,11,30,'sync','completed',
        '{"channelId":10,"connectionId":11,"productId":30,"variants":[{"variantId":301,"sku":"ACTIVE-PACK","offerId":"offer-active","listingId":"listing"}]}')`);
    store = new PostgresListingMemberLifecycleRepository(database.pool);
    await run(new Date(now.getTime()+120_000));
    expect(await receipts()).toEqual(first); expect(getOffer).toHaveBeenCalledTimes(1);
    expect((await selection()).variants.map(row => row.action)).toEqual(["publish","none"]);
  });
  it("keeps provider failures local to the archived member and retries after restart", async () => {
    getOffer.mockRejectedValueOnce(new Error("HTTP 503"));
    await run(); expect((await receipts())[0].state).toBe("failed");
    expect((await selection()).variants.map(row => row.action)).toEqual(["publish","none"]);
    await run(new Date(now.getTime()+120_000)); expect((await receipts())[0].state).toBe("retired");
  });
  it("clears and removes only the exact published offer, then verifies independently", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    remote.set("offer-active", { sku: "ACTIVE-PACK", status: "PUBLISHED" });
    await run();
    expect(clearOffer).toHaveBeenCalledWith("offer-archived","OLD-REMOTE-SKU");
    expect(deleteOffer).toHaveBeenCalledExactlyOnceWith("offer-archived");
    expect(remote.get("offer-active")).toEqual({ sku: "ACTIVE-PACK", status: "PUBLISHED" });
    expect((await receipts())[0].state).toBe("retired");
  });
  it("recovers a lost deletion response by reading the same offer, without resending deletion", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    deleteOffer.mockImplementationOnce(async id => { remote.delete(id); throw new Error("response lost"); });
    await run(); expect((await receipts())[0].state).toBe("retiring");
    await run(new Date(now.getTime()+120_000)); expect((await receipts())[0].state).toBe("retired");
    expect(deleteOffer).toHaveBeenCalledTimes(1);
  });
  it("rejects a different provider SKU, marketplace or listing without a write", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "DIFFERENT", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await run(); expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CHANGED" });
    expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("serializes competing workers and preserves an immutable event history", async () => {
    await store.discover(now,25); const [id] = await store.due(now,25);
    await store.withMember(id, async session => {
      expect(await store.withMember(id, async () => "duplicate")).toBeNull();
      await processListingMemberRetirement(session,{ store, adapter: async () => adapter },()=>now);
    });
    expect(getOffer).toHaveBeenCalledTimes(1);
    await expect(database.pool.query("DELETE FROM marketplace.listing_member_retirement_events")).rejects.toThrow(/immutable/);
    await expect(database.pool.query("UPDATE marketplace.listing_member_retirements SET state='pending'")).rejects.toThrow(/immutable/);
    const events = (await database.pool.query("SELECT actor,before_state,after_state FROM marketplace.listing_member_retirement_events ORDER BY id")).rows;
    expect(events).toHaveLength(2); expect(events[1].after_state.state).toBe("retired");
  });
  it("supersedes an old request after a saved identity changes and never applies its receipt to the replacement", async () => {
    await store.discover(now,25);
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='replacement' WHERE product_variant_id=302");
    const [id] = await store.due(now,25);
    await store.withMember(id, session => processListingMemberRetirement(session,{ store, adapter: async () => adapter },()=>now));
    expect(getOffer).not.toHaveBeenCalled(); expect(await receipts()).toEqual([]);
    expect((await database.pool.query("SELECT state FROM marketplace.listing_member_retirements")).rows[0].state).toBe("superseded");
  });
  it("stops an unstarted removal when Catalog reactivates the member", async () => {
    await store.discover(now,25);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=now() WHERE id=302");
    const [id] = await store.due(now,25);
    await store.withMember(id, session => processListingMemberRetirement(session,{ store, adapter: async () => adapter },()=>now));
    expect(getOffer).not.toHaveBeenCalled(); expect(await receipts()).toEqual([]);
  });
  it("runs the same persisted lifecycle for Shopify and never deletes an active sibling", async () => {
    await database.pool.query(`UPDATE channels.channels SET provider='shopify'; UPDATE channels.channel_connections SET shop_domain='test.myshopify.com';
      UPDATE channels.channel_listings SET external_product_id='900',external_variant_id='902' WHERE product_variant_id=302`);
    let present = true;
    const graphql = vi.fn(async (query: string, variables: Record<string, unknown>) => {
      if (query.startsWith("query")) return { data: { productVariant: present ? { id: "gid://shopify/ProductVariant/902", sku: "OLD-REMOTE-SKU", product: { id: "gid://shopify/Product/900" } } : null } };
      expect(variables).toEqual({ productId: "gid://shopify/Product/900", variantsIds: ["gid://shopify/ProductVariant/902"] });
      present = false; return { data: { productVariantsBulkDelete: { userErrors: [] } } };
    });
    const shopify = new ShopifyListingMemberAdapter(async () => ({ graphql }));
    await store.discover(now,25);
    for (const id of await store.due(now,25)) await store.withMember(id, session => processListingMemberRetirement(session,{ store, adapter: async () => shopify },()=>now));
    expect((await receipts())[0]).toMatchObject({ state: "retired", identity: { provider: "shopify" } });
    expect(graphql.mock.calls.filter(call => call[0].startsWith("mutation"))).toHaveLength(1);
  });
  it("uses the same PostgreSQL lifecycle with the thin Walmart adapter and existing retirement port", async () => {
    await database.pool.query(`UPDATE channels.channels SET provider='walmart';
      INSERT INTO channels.walmart_connections VALUES(11,'walmart-seller','production','us')`);
    const account = { channelId: 10, connectionId: 11, provider: "walmart", accountId: "walmart-seller",
      market: "us", environment: "production" as const, scopeId: "ship-node", revision: 1 };
    let retired = false;
    const retire = vi.fn(async () => { retired = true; });
    const walmart = new WalmartListingMemberAdapter({ account: async () => account,
      observe: async (_account, sku) => ({ sku, title: "Archived member", retired }), retire });
    await store.discover(now,25);
    const [id] = await store.due(now,25);
    await store.withMember(id, session => processListingMemberRetirement(session,{ store, adapter: async () => walmart },()=>now));
    expect(retire).toHaveBeenCalledExactlyOnceWith(account,"OLD-REMOTE-SKU",id);
    expect((await receipts())[0]).toMatchObject({ state: "retired", identity: { provider: "walmart", accountId: "walmart-seller" } });
    expect((await selection()).variants.map(row => row.action)).toEqual(["read_only","none"]);
  });
  it("reuses Walmart publication admission and waits for earlier feeds before retirement", async () => {
    await database.pool.query(`UPDATE channels.channels SET provider='walmart';
      INSERT INTO channels.walmart_connections VALUES(11,'walmart-seller','production','us')`);
    const account = { channelId: 10, connectionId: 11, provider: "walmart", accountId: "walmart-seller",
      market: "us", environment: "production" as const, scopeId: "ship-node", revision: 1 };
    const publication = new PostgresListingLifecycleRepository(database.pool, assertArchivedMemberPublicationAllowed);
    const write = vi.fn(async () => "published");
    // Catalog exclusion takes effect before the worker discovers any operation.
    await expect(publication.withAllowed(account,["OLD-REMOTE-SKU"],write)).rejects.toMatchObject({ code: "LISTING_MEMBER_ARCHIVED" });
    expect(write).not.toHaveBeenCalled();
    await database.pool.query(`INSERT INTO marketplace.channel_listing_updates
      (id,channel_id,account_key,sku,review_hash,intent,state,command_key,submission_id,next_attempt_at,created_by,created_at,updated_at,expires_at)
      VALUES('00000000-0000-4000-8000-000000000051',10,$1,'OLD-REMOTE-SKU',repeat('a',64),'{}','processing',
        '00000000-0000-4000-8000-000000000052','earlier-feed',$2,'test',$2,$2,$2::timestamptz+interval '1 hour')`,
    [listingAccountKey(account),now]);
    let retired = false;
    const observe = vi.fn(async (_account: typeof account, sku: string) => ({ sku, title: "Archived member", retired }));
    const retire = vi.fn(async () => {
      await expect(publication.withAllowed(account,["OLD-REMOTE-SKU"],write)).rejects.toMatchObject({ code: "LISTING_LIFECYCLE_BUSY" });
      await expect(publication.withAllowed(account,["ACTIVE-PACK"],write)).resolves.toBe("published");
      retired = true;
    });
    const walmart = new WalmartListingMemberAdapter({ account: async () => account, observe, retire });
    const process = async (date: Date) => {
      await store.discover(date,25);
      for (const id of await store.due(date,25)) await store.withMember(id, session => processListingMemberRetirement(session, {
        store, adapter: async () => walmart,
        withPublicationFence: (identity, work) => publication.withListing(account,identity.externalSku!,
          async prior => work(await prior.hasPendingFeed(identity.externalSku!))),
      },()=>date));
    };
    await process(now);
    expect((await receipts())[0]).toMatchObject({ state: "pending", code: "LISTING_MEMBER_EARLIER_PUBLICATION_PENDING" });
    expect(observe).not.toHaveBeenCalled(); expect(retire).not.toHaveBeenCalled();
    await database.pool.query("UPDATE marketplace.channel_listing_updates SET state='accepted'");
    await process(new Date(now.getTime()+120_000));
    expect((await receipts())[0].state).toBe("retired"); expect(retire).toHaveBeenCalledTimes(1);
    await expect(publication.withAllowed(account,["OLD-REMOTE-SKU"],write)).rejects.toMatchObject({ code: "LISTING_MEMBER_ARCHIVED" });
  });
  it("keeps an unknown removal in readback recovery while the provider still shows stale live state", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    deleteOffer.mockImplementationOnce(async () => { throw new Error("response lost after dispatch"); });
    await run();
    expect((await receipts())[0]).toMatchObject({ state: "retiring", code: "LISTING_MEMBER_REMOVAL_UNCERTAIN" });
    await run(new Date(now.getTime()+120_000));
    expect(deleteOffer).toHaveBeenCalledTimes(1);
    remote.delete("offer-archived");
    await run(new Date(now.getTime()+240_000));
    expect((await receipts())[0].state).toBe("retired");
  });
  it("preserves dispatched intent when saving completion fails, then verifies without resending", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await database.pool.query(`CREATE FUNCTION marketplace.reject_completion_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.after_state->>'state'='retired' THEN RAISE EXCEPTION 'completion write failed'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_completion_test BEFORE INSERT ON marketplace.listing_member_retirement_events
        FOR EACH ROW EXECUTE FUNCTION marketplace.reject_completion_test();`);
    try {
      await expect(run()).rejects.toThrow("completion write failed");
      expect((await receipts())[0].state).toBe("retiring");
      expect(deleteOffer).toHaveBeenCalledTimes(1);
    } finally {
      await database.pool.query("DROP TRIGGER reject_completion_test ON marketplace.listing_member_retirement_events; DROP FUNCTION marketplace.reject_completion_test()");
    }
    await run(new Date(now.getTime()+120_000));
    expect((await receipts())[0].state).toBe("retired"); expect(deleteOffer).toHaveBeenCalledTimes(1);
  });
  it("discovers Dropship from its saved push identity using the same owner and keeps tenant connections isolated", async () => {
    await database.pool.query(`INSERT INTO dropship.dropship_store_connections VALUES(70,7,'ebay',NULL,'dropship-seller','production','connected');
      INSERT INTO dropship.dropship_vendor_listings VALUES(80,7,70,302,NULL,'dropship-offer');
      INSERT INTO dropship.dropship_listing_push_jobs VALUES(90,7,70);
      INSERT INTO dropship.dropship_listing_push_job_items VALUES(91,90,80,302,'push','completed','{"listingIntent":{"sku":"DROPSHIP-OLD-SKU","marketplaceConfig":{"marketplaceId":"EBAY_US"}}}');`);
    remote.set("dropship-offer", { offerId:"dropship-offer",sku:"DROPSHIP-OLD-SKU",marketplaceId:"EBAY_US",status:"UNPUBLISHED" });
    await run();
    const rows = await readListingMemberRetirements(database.pool,{ destinationKind:"dropship_store_connection",connectionId:70,productVariantIds:[302] });
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ state:"retired",identity:{ vendorId:7,accountId:"dropship-seller" } });
    expect(await readListingMemberRetirements(database.pool,{ destinationKind:"dropship_store_connection",connectionId:71,productVariantIds:[302] })).toEqual([]);
  });
  it("keeps an accepted asynchronous retirement in readback recovery through failures and restarts", async () => {
    const observe = vi.fn(async (identity: ListingMemberIdentity) => ({ identity, retired: false }));
    const retire = vi.fn(async () => {});
    const process = async (time: Date) => {
      await store.discover(time,25);
      for (const id of await store.due(time,25)) await store.withMember(id, session => processListingMemberRetirement(session,
        { store, adapter: async () => ({ observe, retire }) }, () => time));
    };
    await process(now);
    expect((await receipts())[0].state).toBe("retiring");
    observe.mockRejectedValueOnce(new Error("temporary read failure"));
    await process(new Date(now.getTime()+120_000));
    expect((await receipts())[0].state).toBe("retiring");
    store = new PostgresListingMemberLifecycleRepository(database.pool);
    observe.mockImplementation(async identity => ({ identity, retired: true }));
    await process(new Date(now.getTime()+240_000));
    expect((await receipts())[0].state).toBe("retired");
    expect(retire).toHaveBeenCalledTimes(1);
  });
  it("rolls back a failed audit write before any external removal and resumes the same request", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await store.discover(now,25);
    const [before] = await receipts();
    await database.pool.query(`CREATE FUNCTION marketplace.reject_member_event_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected member audit failure'; END; $$;
      CREATE TRIGGER reject_member_event_test BEFORE INSERT ON marketplace.listing_member_retirement_events
        FOR EACH ROW EXECUTE FUNCTION marketplace.reject_member_event_test();`);
    try {
      await expect(run()).rejects.toThrow("injected member audit failure");
      expect(await receipts()).toEqual([before]);
      expect(deleteOffer).not.toHaveBeenCalled();
      expect(clearOffer).not.toHaveBeenCalled();
    } finally {
      await database.pool.query("DROP TRIGGER reject_member_event_test ON marketplace.listing_member_retirement_events; DROP FUNCTION marketplace.reject_member_event_test()");
    }
    await run();
    expect((await receipts())[0]).toMatchObject({ operationId: before.operationId, state: "retired" });
  });
  it("fences reactivation and saved identity reassignment while the provider request is in flight", async () => {
    await store.discover(now,25);
    const [id] = await store.due(now,25);
    const competing = await database.pool.connect();
    try {
      await competing.query("SET lock_timeout='100ms'");
      await store.withMember(id, async session => {
        await expect(competing.query("UPDATE catalog.product_variants SET is_active=true WHERE id=302")).rejects.toMatchObject({ code: "55P03" });
        await expect(competing.query("UPDATE channels.channel_listings SET external_variant_id='replacement' WHERE product_variant_id=302")).rejects.toMatchObject({ code: "55P03" });
        return processListingMemberRetirement(session,{ store, adapter: async () => adapter },()=>now);
      });
      await competing.query("UPDATE catalog.product_variants SET is_active=true,updated_at=now() WHERE id=302");
      expect(await receipts()).toEqual([]);
      expect((await selection()).variants.map(row => row.action)).toEqual(["publish","publish"]);
    } finally { competing.release(); }
  });
  it("blocks ambiguous channel connections instead of choosing an account for shared legacy mappings", async () => {
    await database.pool.query("INSERT INTO channels.channel_connections(id,channel_id) VALUES(12,10)");
    await run();
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CONFLICT" });
    expect(getOffer).not.toHaveBeenCalled();
    expect(deleteOffer).not.toHaveBeenCalled();
  });
  it("rejects conflicting feed and listing identities without touching either remote resource", async () => {
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_variant_id)
      VALUES(10,302,'OLD-REMOTE-SKU','different-offer')`);
    await run();
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CONFLICT" });
    expect(deleteOffer).not.toHaveBeenCalled();
  });
  it("records a malformed first identity once without starving a bounded discovery batch or already queued work", async () => {
    await store.discover(now, 1); // Existing valid work must survive a later malformed source.
    const [queued] = await receipts();
    expect(queued.state).toBe("pending");
    await expect(database.pool.query(`UPDATE marketplace.listing_member_retirements
      SET source_identity=jsonb_set(source_identity,'{externalSku}','"forged"'::jsonb) WHERE id=$1`,
    [queued.operationId])).rejects.toThrow(/immutable/);
    await database.pool.query(`UPDATE catalog.product_variants SET is_active=false WHERE id=301;
      UPDATE channels.channel_listings SET external_sku='' WHERE product_variant_id=301;
      INSERT INTO catalog.product_variants(id,product_id,sku,uom_type,is_active,requires_shipping,track_inventory,sales_eligibility)
        VALUES(303,30,'LATER-ARCHIVED-PACK','pack',false,true,true,'sellable');
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,sync_status)
        VALUES(10,303,'LATER-REMOTE-SKU','offer-later','synced')`);
    remote.set("offer-later", { offerId: "offer-later", sku: "LATER-REMOTE-SKU", marketplaceId: "EBAY_US", status: "UNPUBLISHED" });

    await store.discover(now, 1);
    await store.discover(now, 1);
    await store.discover(now, 1);
    const all = await readListingMemberRetirements(database.pool, {
      destinationKind: "channel_connection", connectionId: 11, productVariantIds: [301, 302, 303],
    });
    expect(all).toHaveLength(3);
    const invalid = all.find(row => row.identity.productVariantId === 301)!;
    expect(invalid).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_INVALID",
      identity: { externalSku: null, externalVariantId: "offer-active", identityConflict: true }, verifiedAt: null });
    expect(invalid.message).toContain("externalSku");
    const saved = (await database.pool.query(`SELECT identity_key,source_identity,next_attempt_at FROM marketplace.listing_member_retirements WHERE id=$1`,
      [invalid.operationId])).rows[0];
    expect(saved).toMatchObject({ source_identity: { externalSku: "", identityConflict: false }, next_attempt_at: null });
    expect(saved.identity_key).toMatch(/^[a-f0-9]{64}$/);
    const firstAudit = (await database.pool.query(`SELECT before_state,after_state FROM marketplace.listing_member_retirement_events WHERE operation_id=$1`,
      [invalid.operationId])).rows;
    expect(firstAudit).toHaveLength(1);
    expect(firstAudit[0]).toMatchObject({ before_state: null, after_state: { source_identity: saved.source_identity,
      code: "LISTING_MEMBER_IDENTITY_INVALID", state: "failed", next_attempt_at: null } });

    const due = await store.due(now, 25);
    expect(due).toHaveLength(2);
    expect(due).not.toContain(invalid.operationId);
    for (const id of due) await store.withMember(id, session => processListingMemberRetirement(session,
      { store, adapter: async () => adapter }, () => now));
    expect((await receipts())[0].state).toBe("retired");
    expect(getOffer.mock.calls.map(([id]) => id).sort()).toEqual(["offer-archived", "offer-later"]);
    expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
    expect(await store.due(new Date(now.getTime() + 120_000), 25)).toEqual([]);

    // Even an explicit operation-ID invocation cannot dispatch a diagnostic.
    const resolveAdapter = vi.fn(async () => adapter);
    expect(await store.withMember(invalid.operationId, session => processListingMemberRetirement(session,
      { store, adapter: resolveAdapter }, () => now))).toEqual(invalid);
    expect(resolveAdapter).not.toHaveBeenCalled();
    await expect(database.pool.query(`UPDATE marketplace.listing_member_retirements
      SET source_identity=jsonb_set(source_identity,'{externalSku}','"forged"'::jsonb) WHERE id=$1`,
    [invalid.operationId])).rejects.toThrow(/immutable/);
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM marketplace.listing_member_retirement_events WHERE operation_id=$1",
      [invalid.operationId])).rows[0].count).toBe(1);
  });
  it("discovers a corrected identity as new work while preserving the exact failed source and audit", async () => {
    await database.pool.query("UPDATE channels.channel_listings SET external_sku='' WHERE product_variant_id=302");
    await run();
    const [invalid] = await receipts();
    expect(invalid).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_INVALID" });
    const before = (await database.pool.query("SELECT * FROM marketplace.listing_member_retirements WHERE id=$1", [invalid.operationId])).rows[0];
    expect(getOffer).not.toHaveBeenCalled();

    // A supported mapping correction changes the retained identity, without
    // relying on a Catalog timestamp change to bypass discovery de-duplication.
    await database.pool.query("UPDATE channels.channel_listings SET external_sku='OLD-REMOTE-SKU' WHERE product_variant_id=302");
    await run();
    const current = await receipts();
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ state: "retired", sourceRevision: invalid.sourceRevision,
      identity: { externalSku: "OLD-REMOTE-SKU", identityConflict: false } });
    expect(current[0].operationId).not.toBe(invalid.operationId);
    const after = (await database.pool.query("SELECT * FROM marketplace.listing_member_retirements WHERE id=$1", [invalid.operationId])).rows[0];
    expect(after).toEqual(before);
    expect((await store.listForChannel(10, 30, 25)).map(row => row.operationId).sort())
      .toEqual([invalid.operationId, current[0].operationId].sort());
    expect(getOffer).toHaveBeenCalledExactlyOnceWith("offer-archived");
    expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it.each([
    { field: "environment", sql: "UPDATE ebay.ebay_oauth_tokens SET environment=$1", value: "staging", safe: "production" },
    { field: "market", sql: "UPDATE channels.channel_connections SET metadata=jsonb_build_object('marketplaceId',$1::text)", value: "x".repeat(256), safe: "invalid" },
  ])("preserves invalid $field scope evidence without dispatching or retrying its sanitized DTO", async ({ field, sql, value, safe }) => {
    await database.pool.query(sql, [value]);
    await run();
    const [invalid] = await receipts();
    expect(invalid).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_INVALID",
      identity: { [field]: safe, identityConflict: true } });
    expect(invalid.message).toContain(field);
    expect(invalid.message!.length).toBeLessThan(512);
    const saved = (await database.pool.query("SELECT source_identity,next_attempt_at FROM marketplace.listing_member_retirements WHERE id=$1",
      [invalid.operationId])).rows[0];
    expect(saved.source_identity[field]).toBe(value);
    expect(saved.next_attempt_at).toBeNull();
    await run(new Date(now.getTime() + 120_000));
    expect(await receipts()).toEqual([invalid]);
    expect(getOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("keeps an ambiguous Shopify mutation envelope in durable readback recovery through the production composition", async () => {
    await database.pool.query(`UPDATE channels.channels SET provider='shopify';
      UPDATE channels.channel_connections SET shop_domain='test.myshopify.com',access_token='synthetic-shopify-token',api_version='2026-04';
      UPDATE channels.channel_listings SET external_product_id='900',external_variant_id='902' WHERE product_variant_id=302`);
    let present = true;
    let mutations = 0;
    const request = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(input)).toBe("https://test.myshopify.com/admin/api/2026-04/graphql.json");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "X-Shopify-Access-Token": "synthetic-shopify-token" });
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.startsWith("mutation")) {
        mutations++;
        expect(body.variables).toEqual({ productId: "gid://shopify/Product/900", variantsIds: ["gid://shopify/ProductVariant/902"] });
        // Execution data plus errors cannot prove the mutation was rejected.
        // Keep subsequent reads present until the test advances observation.
        return new Response(JSON.stringify({ data: { productVariantsBulkDelete: { userErrors: [] } },
          errors: [{ message: "A mutation response field could not be resolved" }] }), { status: 200 });
      }
      expect(body.query).toContain("query ArchivedMember");
      expect(body.variables).toEqual({ id: "gid://shopify/ProductVariant/902" });
      return new Response(JSON.stringify({ data: { productVariant: present
        ? { id: "gid://shopify/ProductVariant/902", sku: "OLD-REMOTE-SKU", product: { id: "gid://shopify/Product/900" } }
        : null } }), { status: 200 });
    });
    const unused = () => { throw new Error("The Shopify composition must not invoke an unrelated credential/provider owner"); };
    const unusedWalmart = new Proxy({} as Parameters<typeof createListingMemberLifecycle>[1], { get: unused });
    const authDatabase = { select: unused, insert: unused, update: unused, delete: unused };
    vi.stubGlobal("fetch", request);
    vi.stubEnv("DRY_RUN", "false");
    try {
      const members = createListingMemberLifecycle(database.pool, unusedWalmart, authDatabase,
        new PostgresListingLifecycleRepository(database.pool, assertArchivedMemberPublicationAllowed));
      const process = async (date: Date) => {
        await members.store.discover(date, 25);
        for (const id of await members.store.due(date, 25)) await members.store.withMember(id,
          session => processListingMemberRetirement(session, members, () => date));
      };
      await process(now);
      const [uncertain] = await receipts();
      expect(uncertain.state).toBe("retiring");
      expect(mutations).toBe(1);
      await process(new Date(now.getTime() + 120_000));
      expect((await receipts())[0]).toMatchObject({ operationId: uncertain.operationId, state: "failed", recoveryRequired:true });
      expect(mutations).toBe(1);
      present = false;
      await process(new Date(now.getTime() + 240_000));
      expect((await receipts())[0]).toMatchObject({ operationId: uncertain.operationId, state: "retired" });
      expect(mutations).toBe(1);
      expect(request).toHaveBeenCalledTimes(5);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
