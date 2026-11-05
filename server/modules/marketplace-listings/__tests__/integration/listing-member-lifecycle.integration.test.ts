import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ListingMemberRecoveryService } from "../../application/listing-member-recovery.service";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { readChannelStockSelection } from "../../../channels/channel-stock-selection";
import { PostgresListingMemberLifecycleRepository, readListingMemberRetirements, assertArchivedMemberPublicationAllowed, tryLockListingMemberRemote } from "../../infrastructure/pg-listing-member-lifecycle.repository";
import { PostgresListingLifecycleRepository } from "../../infrastructure/pg-listing-lifecycle.repository";
import { listingAccountKey } from "../../domain/listing-publication";
import { processListingMemberRetirement } from "../../application/process-listing-member-retirement";
import { reconcileArchivedMemberRetirement } from "../../application/reconcile-archived-member-retirement";
import { ListingLifecycleService } from "../../application/listing-lifecycle.service";
import { archivedListingMemberSelection } from "../../domain/listing-member-lifecycle";
import { listingMemberRemoteKey } from "../../domain/listing-member-lifecycle";
import { resolveListingIntentLifecycle } from "../../domain/listing-intent-lifecycle";
import { EbayListingMemberAdapter } from "../../infrastructure/providers/ebay/ebay-listing-member.adapter";
import { ShopifyListingMemberAdapter } from "../../infrastructure/providers/shopify-listing-member.adapter";
import { shopifyListingIdentityAliases } from "../../infrastructure/providers/shopify-listing-member-identity";
import { WalmartListingMemberAdapter } from "../../../channels/adapters/walmart/walmart-listing-member.adapter";
import { installListingMemberLifecycleFixture, listingMemberBaseSql, seedLegacyRetirements } from "../fixtures/listing-member-lifecycle.fixture";
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
    await seedLegacyRetirements(database.pool, date, 25);
    for (const id of await store.due(date, 25)) await store.withMember(id, session => processListingMemberRetirement(session,
      { store, adapter: async () => adapter }, () => date));
  };
  const receipts = () => readListingMemberRetirements(database.pool, { destinationKind: "channel_connection", connectionId: 11, productVariantIds: [302] });
  const selection = () => readChannelStockSelection(database.pool, { channelId: 10, channelConnectionId: 11, productId: 30, productVariantIds: [301,302] });
  const worker = (date = now) => new ListingLifecycleService({
    store: new PostgresListingLifecycleRepository(database.pool),
    provider: {} as ConstructorParameters<typeof ListingLifecycleService>[0]["provider"],
    members: { store, adapter: async () => adapter }, now: () => date, uuid: randomUUID,
  });
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
  it("does not create or send a removal just because a variant is archived", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    expect(await worker().processDue()).toEqual({ processed: 0, failed: 0 });
    expect((await database.pool.query("SELECT count(*)::integer n FROM marketplace.listing_member_retirements")).rows[0].n).toBe(0);
    expect(getOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled();
    expect(remote.has("offer-archived")).toBe(true);
  });
  it.each(["numeric", "gid"] as const)("fences a %s Shopify ID against an old worker and across connection types", async oldForm => {
    const numeric = "123456789";
    const gid = `gid://shopify/ProductVariant/${numeric}`;
    const identity: ListingMemberIdentity = { destinationKind: "channel_connection", connectionId: 11, channelId: 10,
      vendorId: null, provider: "shopify", accountId: "seller.myshopify.com", environment: "production", market: "shop",
      productId: 30, productVariantId: 302, externalSku: "REMOTE-PACK", externalProductId: "900",
      externalVariantId: oldForm === "numeric" ? numeric : gid, externalInventoryItemId: null, identityConflict: false };
    const otherConnection: ListingMemberIdentity = { ...identity, destinationKind: "dropship_store_connection", connectionId: 70,
      channelId: null, vendorId: 7, externalVariantId: oldForm === "numeric" ? gid : numeric };
    const oldWorker = await database.pool.connect();
    const newWorker = await database.pool.connect();
    try {
      await oldWorker.query("BEGIN");
      await newWorker.query("BEGIN");
      // The previously deployed worker locked only its literal representation.
      await oldWorker.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [2591013, listingMemberRemoteKey(identity)]);
      expect(await tryLockListingMemberRemote(newWorker, otherConnection)).toBe(false);
      await newWorker.query("ROLLBACK");
      await oldWorker.query("ROLLBACK");

      await newWorker.query("BEGIN");
      await oldWorker.query("BEGIN");
      expect(await tryLockListingMemberRemote(newWorker, otherConnection)).toBe(true);
      expect(await tryLockListingMemberRemote(oldWorker, identity)).toBe(false);
      await oldWorker.query("ROLLBACK");
      await oldWorker.query("BEGIN");
      expect(await tryLockListingMemberRemote(oldWorker, { ...identity, accountId: "other.myshopify.com" })).toBe(true);
      await oldWorker.query("ROLLBACK");
      await newWorker.query("ROLLBACK");
    } finally { oldWorker.release(); newWorker.release(); }
  });
  it("releases partial Shopify alias locks when a caller continues after a failed acquisition", async () => {
    const numeric = "123456789";
    const gid = `gid://shopify/ProductVariant/${numeric}`;
    const identity: ListingMemberIdentity = { destinationKind: "channel_connection", connectionId: 11, channelId: 10,
      vendorId: null, provider: "shopify", accountId: "seller.myshopify.com", environment: "production", market: "shop",
      productId: 30, productVariantId: 302, externalSku: "REMOTE-PACK", externalProductId: "900",
      externalVariantId: numeric, externalInventoryItemId: null, identityConflict: false };
    const keys = [listingMemberRemoteKey(identity), listingMemberRemoteKey({ ...identity, externalVariantId: gid })].sort();
    const blocker = await database.pool.connect(), contender = await database.pool.connect(), witness = await database.pool.connect();
    try {
      await blocker.query("BEGIN"); await contender.query("BEGIN"); await witness.query("BEGIN");
      // Occupy the second key: the contender must first acquire and then release the first.
      await blocker.query("SELECT pg_advisory_xact_lock($1,hashtext($2))", [2591013, keys[1]]);
      expect(await tryLockListingMemberRemote(contender, identity)).toBe(false);
      const acquired = await witness.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked", [2591013, keys[0]]);
      expect(acquired.rows[0].locked).toBe(true);
      await witness.query("ROLLBACK"); await contender.query("ROLLBACK"); await blocker.query("ROLLBACK");
    } finally { blocker.release(); contender.release(); witness.release(); }
  });
  it.each(["unknown", "legacy"] as const)("keeps a superseded %s dispatch visible and read-only", async dispatch => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [initial] = await receipts();
    await store.withMember(initial.operationId, session => session.save("retiring", null, "Previous request", now,
      dispatch === "unknown" ? { dispatchStatus: "unknown", dispatchKey: initial.operationId } : {}));
    await database.pool.query("UPDATE catalog.product_variants SET updated_at=updated_at+interval '1 second' WHERE id=302");
    await store.withMember(initial.operationId, session => session.save("superseded", "LISTING_MEMBER_SOURCE_CHANGED",
      "The old worker considered this finished.", now));
    const [original] = await receipts();
    expect(original).toMatchObject({ operationId: initial.operationId, state: "superseded", dispatchStatus: "unknown" });

    const selected = await selection();
    const lifecycle = resolveListingIntentLifecycle({
      selection: { ...selected, variants: selected.variants.filter(row => row.productVariantId === 302) },
      accountId: "seller-one", retainedVariantIds: [302], retirements: [original], stock: [], contentWork: [], now,
    });
    expect(lifecycle?.state).toBe("waiting_lifecycle");
    if (!lifecycle || lifecycle.state !== "waiting_lifecycle") throw new Error("Expected unresolved work");
    expect(lifecycle.lifecycle.members[0]).toMatchObject({
      state: "attention", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
      nextActions: [{ owner: "listing_member_retirement", operationId: initial.operationId }],
    });

    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    const recovery = new ListingMemberRecoveryService({ store, adapter: async () => adapter }, () => now);
    const review = await recovery.preview(10, initial.operationId);
    expect(review).toMatchObject({ record: { operationId: initial.operationId, state: "superseded" },
      observation: { retired: false }, canResume: false });
    expect(review.message).toContain("without sending another removal");
    await expect(recovery.resume(10, { operationId: initial.operationId, commandKey: randomUUID(), reviewHash: review.reviewHash }, "user:test"))
      .rejects.toMatchObject({ code: "LISTING_MEMBER_RECOVERY_SCOPE_CHANGED" });
    expect(await worker().processDue()).toEqual({ processed: 0, failed: 0 });
    expect(clearOffer).not.toHaveBeenCalled();
    expect(deleteOffer).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT state,version FROM marketplace.listing_member_retirements WHERE id=$1",
      [initial.operationId])).rows[0]).toEqual({ state: "superseded", version: 3 });
    expect((await database.pool.query("SELECT count(*)::int n FROM marketplace.listing_member_retirement_events WHERE operation_id=$1",
      [initial.operationId])).rows[0].n).toBe(3);
  });
  it("does not assume an incomplete superseded history proves a request was never sent", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [initial] = await receipts();
    await database.pool.query("UPDATE marketplace.listing_member_retirements SET version=version+1 WHERE id=$1", [initial.operationId]);
    await database.pool.query("UPDATE catalog.product_variants SET updated_at=updated_at+interval '1 second' WHERE id=302");
    await store.withMember(initial.operationId, session => session.save("superseded", "LISTING_MEMBER_SOURCE_CHANGED", "Old status", now));
    expect(await receipts()).toEqual([expect.objectContaining({
      operationId: initial.operationId, state: "superseded", dispatchStatus: "unknown",
    })]);
    expect(getOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("supersedes a legacy automatic removal only when its complete audit proves it was not sent", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [before] = await receipts();
    expect(await worker().processDue()).toEqual({ processed: 1, failed: 0 });
    const [after] = await store.listForChannel(10, 30, 25);
    expect(after).toMatchObject({ operationId: before.operationId, state: "superseded", code: "LISTING_MEMBER_ARCHIVE_NO_REMOVAL" });
    expect(getOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::integer n FROM marketplace.listing_member_retirement_events WHERE operation_id=$1", [before.operationId])).rows[0].n).toBe(2);
    expect(await worker(new Date(now.getTime() + 120_000)).processDue()).toEqual({ processed: 0, failed: 0 });
  });
  it("serializes concurrent cancellation of the same unsent archive removal", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [before] = await receipts();
    await Promise.all([worker().processDue(), worker().processDue()]);
    expect((await store.listForChannel(10, 30, 25))[0]).toMatchObject({ operationId: before.operationId, state: "superseded" });
    expect((await database.pool.query("SELECT count(*)::integer n FROM marketplace.listing_member_retirement_events WHERE operation_id=$1", [before.operationId])).rows[0].n).toBe(2);
    expect(await store.due(new Date(now.getTime() + 120_000), 25)).toEqual([]);
    expect(getOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("cancels a deferred archived alias without touching the active owner's offer", async () => {
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='offer-archived' WHERE product_variant_id=301");
    await run();
    const [conflict] = await receipts();
    expect(conflict).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CONFLICT" });
    expect(await worker().processDue()).toEqual({ processed: 1, failed: 0 });
    expect((await store.listForChannel(10, 30, 25))[0]).toMatchObject({ state: "superseded", code: "LISTING_MEMBER_ARCHIVE_NO_REMOVAL" });
    expect(getOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("keeps a legacy send marker for a failed pre-marker-format request and only reads the provider", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, async session => {
      await session.save("retiring", null, "Legacy send marker", now);
      await session.save("failed", "LEGACY_ERROR", "Legacy failure", now);
    });
    await worker(new Date(now.getTime() + 120_000)).processDue();
    expect((await receipts())[0]).toMatchObject({ operationId: id, state: "failed", dispatchStatus: "none",
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", recoveryRequired: true });
    expect(getOffer).toHaveBeenCalledTimes(1); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
    expect(await store.due(new Date(now.getTime() + 180_000), 25)).toEqual([]);
    expect(await store.due(new Date(now.getTime() + 1_020_000), 25)).toEqual([id]);
  });
  it("does not assume an incomplete audit proves an automatic removal was unsent", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await database.pool.query("UPDATE marketplace.listing_member_retirements SET version=version+1 WHERE id=$1", [id]);
    await worker().processDue();
    expect((await receipts())[0]).toMatchObject({ operationId: id, state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", recoveryRequired: true });
    expect(getOffer).toHaveBeenCalledTimes(1); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("does not treat malformed audit entries as proof that nothing was sent", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await database.pool.query("UPDATE marketplace.listing_member_retirements SET version=version+1 WHERE id=$1", [id]);
    await database.pool.query(`INSERT INTO marketplace.listing_member_retirement_events(operation_id,version,actor,before_state,after_state,occurred_at)
      VALUES($1,2,'fixture',NULL,jsonb_build_object('state','pending'),$2)`, [id, now]);
    await worker().processDue();
    expect((await receipts())[0]).toMatchObject({ operationId: id, state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED" });
    expect(getOffer).toHaveBeenCalledTimes(1); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("retains uncertain work and backs off when the publication fence cannot be acquired", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "Unknown dispatch", now,
      { dispatchStatus: "unknown", dispatchKey: id }));
    await store.withMember(id, session => reconcileArchivedMemberRetirement(session, {
      store, adapter: async () => adapter, withPublicationFence: async () => { throw new Error("fence unavailable"); },
    }, () => now));
    expect((await receipts())[0]).toMatchObject({ operationId: id, state: "failed", code: "LISTING_MEMBER_PROVIDER_FAILED", recoveryRequired: true });
    expect(await store.due(new Date(now.getTime() + 60_000), 25)).toEqual([]);
    expect(getOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("retains an explicitly authorized recovery command for a prior removal", async () => {
    const { record, service } = await unresolvedRecovery();
    const review = await service.preview(10, record.operationId);
    await service.resume(10, { operationId: record.operationId, reviewHash: review.reviewHash, commandKey: randomUUID() }, "operator");
    await worker(new Date(now.getTime() + 240_000)).processDue();
    expect((await receipts())[0]).toMatchObject({ operationId: record.operationId, state: "failed",
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", unconfirmedPriorDispatch: true });
    expect(deleteOffer).toHaveBeenCalledTimes(2);
  });
  // Audit acceptance test: a durable marker alone cannot establish that a
  // provider request was dispatched. Restart needs a safe, actionable resolution.
  it("AUDIT: recovers a crash after the retirement marker commits but before dispatch", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await seedLegacyRetirements(database.pool, now, 25);
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
    expect((await receipts())[0]).toMatchObject({state:"failed",operationId:id,
      code:"LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",unconfirmedPriorDispatch:true});
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
    await seedLegacyRetirements(database.pool, now, 25);
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
    expect(completed).toMatchObject({ state: "failed", recoveryRequired: true,
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", unconfirmedPriorDispatch: true });
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
    expect((await receipts())[0]).toMatchObject({ state: "failed", recoveryRequired: true,
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", unconfirmedPriorDispatch: true });
    expect(deleteOffer).toHaveBeenCalledTimes(1);
  });

  it.each(["ebay","shopify","walmart"])("uses the same recovery authority for %s without adapter-owned retry decisions",async provider=>{
    await database.pool.query("UPDATE channels.channels SET provider=$1",[provider]);
    if(provider==="shopify") await database.pool.query("UPDATE channels.channel_connections SET shop_domain='shared-store.myshopify.com'");
    if(provider==="walmart") await database.pool.query("INSERT INTO channels.walmart_connections VALUES(11,'partner','production','us')");
    await seedLegacyRetirements(database.pool, now, 25);
    const [id]=await store.due(now,25);
    await store.withMember(id,session=>session.save("retiring",null,"Unconfirmed dispatch",now,{dispatchStatus:"unknown"}));
    let removed=false;
    const retire=vi.fn(async()=>{removed=true; return { finality: "terminal" as const };});
    const normalized={observe:async(identity:ListingMemberIdentity)=>({identity,retired:removed}),retire};
    const dependencies={store,adapter:async()=>normalized};
    await store.withMember(id,session=>processListingMemberRetirement(session,dependencies,()=>now));
    const recovery=new ListingMemberRecoveryService(dependencies,()=>now);
    const review=await recovery.preview(10,id);
    await recovery.resume(10,{operationId:id,commandKey:randomUUID(),reviewHash:review.reviewHash},"operator");
    await store.withMember(id,session=>processListingMemberRetirement(session,dependencies,()=>now));
    expect((await receipts())[0]).toMatchObject({state:"failed",identity:{provider},recoveryRequired:true,
      code:"LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",unconfirmedPriorDispatch:true});
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
  it.each([
    { archived: "123456789", active: "gid://shopify/ProductVariant/123456789", destination: "direct" },
    { archived: "gid://shopify/ProductVariant/123456789", active: "123456789", destination: "direct" },
    { archived: "123456789", active: "gid://shopify/ProductVariant/123456789", destination: "dropship" },
    { archived: "gid://shopify/ProductVariant/123456789", active: "123456789", destination: "dropship" },
  ])("rejects Shopify ID aliases across $destination ownership before any removal", async ({ archived, active, destination }) => {
    await database.pool.query("UPDATE channels.channels SET provider='shopify'");
    await database.pool.query("UPDATE channels.channel_connections SET shop_domain='shared.myshopify.com'");
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id=$1 WHERE product_variant_id=302", [archived]);
    if (destination === "direct") {
      await database.pool.query("UPDATE channels.channel_listings SET external_variant_id=$1 WHERE product_variant_id=301", [active]);
    } else {
      await database.pool.query(`INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,shop_domain,provider_environment)
        VALUES(21,22,'shopify','shared.myshopify.com','production')`);
      await database.pool.query(`INSERT INTO dropship.dropship_vendor_listings(id,vendor_id,store_connection_id,product_variant_id,external_offer_id)
        VALUES(23,22,21,301,$1)`, [active]);
    }
    const source = (await database.pool.query("SELECT identity FROM marketplace.listing_member_retirement_sources WHERE product_variant_id=302")).rows[0];
    expect(source.identity.identityConflict).toBe(true);
    await run();
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CONFLICT" });
    expect(getOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled();
  });
  it("does not treat the same Shopify ID in another seller account as a conflict", async () => {
    await database.pool.query("UPDATE channels.channels SET provider='shopify'");
    await database.pool.query("UPDATE channels.channel_connections SET shop_domain='first.myshopify.com'");
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='123456789' WHERE product_variant_id=302");
    await database.pool.query(`INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,shop_domain,provider_environment)
      VALUES(21,22,'shopify','second.myshopify.com','production');
      INSERT INTO dropship.dropship_vendor_listings(id,vendor_id,store_connection_id,product_variant_id,external_offer_id)
      VALUES(23,22,21,301,'gid://shopify/ProductVariant/123456789');`);
    const source = (await database.pool.query("SELECT identity FROM marketplace.listing_member_retirement_sources WHERE product_variant_id=302")).rows[0];
    expect(source.identity.identityConflict).toBe(false);
  });
  it("accepts the same Shopify member stored in numeric and GID form on the same local variant", async () => {
    await database.pool.query("UPDATE channels.channels SET provider='shopify'");
    await database.pool.query("UPDATE channels.channel_connections SET shop_domain='shared.myshopify.com'");
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='123456789',external_product_id='456' WHERE product_variant_id=302");
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_variant_id,channel_sku,channel_product_id)
      VALUES(10,302,'gid://shopify/ProductVariant/123456789','OLD-REMOTE-SKU','gid://shopify/Product/456')`);
    const source = (await database.pool.query("SELECT identity FROM marketplace.listing_member_retirement_sources WHERE product_variant_id=302")).rows[0];
    expect(source.identity.identityConflict).toBe(false);
    expect(source.identity.externalVariantId).toBe("123456789");
    expect(source.identity.externalProductId).toBe("456");
  });
  it.each([
    "123", "gid://shopify/ProductVariant/123", "gid://shopify/Product/123", "other-123",
    "123\n", "gid://shopify/ProductVariant/123\n", "0", "00123",
  ])("keeps PostgreSQL and the shared Shopify ID comparison consistent for %j", async value => {
    const result = (await database.pool.query<{ normalized: string }>(
      "SELECT marketplace.normalized_listing_identity('shopify','variant',$1) AS normalized", [value])).rows[0].normalized;
    expect(result).toBe(shopifyListingIdentityAliases("ProductVariant", value)?.[0] ?? value);
  });
  it("does not normalize another provider or another Shopify resource as a variant", async () => {
    const value = "gid://shopify/Product/123";
    const result = (await database.pool.query<{ other_provider: string; wrong_resource: string }>(
      "SELECT marketplace.normalized_listing_identity('ebay','variant',$1) AS other_provider, marketplace.normalized_listing_identity('shopify','variant',$1) AS wrong_resource", [value])).rows[0];
    expect(result).toEqual({ other_provider: value, wrong_resource: value });
  });
  it("preserves an earlier uncertain dispatch and its audit when alias detection changes during migration", async () => {
    const older = await createInventoryCutoverTestDatabase(url, disposable, listingMemberBaseSql);
    try {
      await installListingMemberLifecycleFixture(older.pool, { includeAliasMigration: false });
      await older.pool.query(`INSERT INTO catalog.products(id,is_active,status) VALUES(30,true,'active');
        INSERT INTO catalog.product_variants(id,product_id,sku,is_active,requires_shipping,track_inventory,sales_eligibility)
          VALUES(301,30,'ACTIVE',true,true,true,'sellable'),(302,30,'ARCHIVED',false,true,true,'sellable');
        INSERT INTO channels.channels VALUES(10,'shopify');
        INSERT INTO channels.channel_connections(id,channel_id,shop_domain) VALUES(11,10,'shared.myshopify.com');
        INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id)
          VALUES(10,301,'ACTIVE','gid://shopify/ProductVariant/123'),(10,302,'OLD','123');`);
      const previousSource = (await older.pool.query("SELECT identity FROM marketplace.listing_member_retirement_sources WHERE product_variant_id=302")).rows[0].identity;
      expect(previousSource.identityConflict).toBe(false);
      await seedLegacyRetirements(older.pool, now, 25);
      const oldStore = new PostgresListingMemberLifecycleRepository(older.pool);
      const [operationId] = await oldStore.due(now, 25);
      await oldStore.withMember(operationId, session => session.save("retiring", null, "Earlier request", now,
        { dispatchStatus: "unknown", dispatchKey: operationId }));
      const before = (await older.pool.query("SELECT source_identity,identity,state,dispatch_status FROM marketplace.listing_member_retirements WHERE id=$1", [operationId])).rows[0];
      const eventsBefore = (await older.pool.query("SELECT * FROM marketplace.listing_member_retirement_events WHERE operation_id=$1 ORDER BY version", [operationId])).rows;

      await older.pool.query(readFileSync(resolve("migrations", "900000057000020020002_listing_member_identity_aliases.sql"), "utf8"));
      const currentSource = (await older.pool.query("SELECT identity FROM marketplace.listing_member_retirement_sources WHERE product_variant_id=302")).rows[0].identity;
      expect(currentSource.identityConflict).toBe(true);
      expect((await older.pool.query("SELECT source_identity,identity,state,dispatch_status FROM marketplace.listing_member_retirements WHERE id=$1", [operationId])).rows[0]).toEqual(before);
      expect((await older.pool.query("SELECT * FROM marketplace.listing_member_retirement_events WHERE operation_id=$1 ORDER BY version", [operationId])).rows).toEqual(eventsBefore);
      expect(await readListingMemberRetirements(older.pool, { destinationKind: "channel_connection", connectionId: 11, productVariantIds: [302] }))
        .toEqual([expect.objectContaining({ operationId, state: "retiring", unconfirmedPriorDispatch: true })]);
    } finally { await older.close(); }
  });
  it("defers a conflicting identity without retries, then cancels its proven unsent automatic removal", async () => {
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='offer-archived' WHERE product_variant_id=301");
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    remote.set("offer-active", { offerId: "offer-active", sku: "ACTIVE-PACK", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await run();
    const [conflict] = await receipts();
    expect(conflict).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CONFLICT" });
    expect(await store.listConflictsForChannel(10,0)).toEqual({items:[{productId:30,productVariantId:302,
      sku:"RENAMED-ARCHIVED-PACK",operationId:conflict.operationId}],hasMore:false,offset:0});
    expect(await store.listConflictsForChannel(999,0)).toEqual({items:[],hasMore:false,offset:0});
    const selected = await selection();
    const lifecycle = resolveListingIntentLifecycle({ selection: { ...selected, variants: selected.variants.filter(row=>row.productVariantId===302) },
      accountId:"seller-one", retainedVariantIds:[302], retirements:[conflict], stock:[], contentWork:[], now });
    expect(lifecycle?.state).toBe("waiting_lifecycle");
    if (!lifecycle || lifecycle.state !== "waiting_lifecycle") throw new Error("Expected unresolved listing work");
    expect(lifecycle.lifecycle.members[0]).toMatchObject({state:"attention",nextActions:[{owner:"listing_mapping"}]});
    expect(lifecycle.message).toContain("after the links change");
    const before = (await database.pool.query("SELECT version,next_attempt_at='infinity'::timestamptz AS deferred FROM marketplace.listing_member_retirements WHERE id=$1", [conflict.operationId])).rows[0];
    const eventsBefore = (await database.pool.query("SELECT count(*)::int AS n FROM marketplace.listing_member_retirement_events WHERE operation_id=$1", [conflict.operationId])).rows[0].n;
    expect(before.deferred).toBe(true);
    expect(await store.due(new Date(now.getTime()+3_600_000),25)).toEqual([conflict.operationId]);
    // A worker that selected this ID before another worker parked it must not
    // append a second identical failure after the first transaction commits.
    await store.withMember(conflict.operationId, session => processListingMemberRetirement(session,{store,adapter:async()=>adapter},()=>new Date(now.getTime()+3_600_000)));
    await run(new Date(now.getTime()+3_600_000));
    expect((await database.pool.query("SELECT version FROM marketplace.listing_member_retirements WHERE id=$1",[conflict.operationId])).rows[0].version).toBe(before.version);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM marketplace.listing_member_retirement_events WHERE operation_id=$1",[conflict.operationId])).rows[0].n).toBe(eventsBefore);
    expect(deleteOffer).not.toHaveBeenCalled();
    await worker(new Date(now.getTime()+3_660_000)).processDue();
    expect(await store.listConflictsForChannel(10,0)).toEqual({items:[],hasMore:false,offset:0});
    expect(deleteOffer).not.toHaveBeenCalled();
    expect(remote.has("offer-active")).toBe(true);
    expect((await database.pool.query("SELECT state,code FROM marketplace.listing_member_retirements WHERE id=$1",[conflict.operationId])).rows[0])
      .toEqual({state:"superseded",code:"LISTING_MEMBER_ARCHIVE_NO_REMOVAL"});
  });
  it("paginates current identity conflicts without exposing another channel", async () => {
    await database.pool.query(`UPDATE channels.channel_listings SET external_variant_id='offer-archived' WHERE product_variant_id=301;
      INSERT INTO catalog.product_variants(id,product_id,sku,uom_type,is_active,requires_shipping,track_inventory,sales_eligibility)
        VALUES(303,30,'ANOTHER-ARCHIVED','case',false,true,true,'sellable');
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,sync_status)
        VALUES(10,303,'ANOTHER-OLD-SKU','offer-archived','synced');`);
    await run();
    expect((await store.listConflictsForChannel(10,0)).items.map(item=>item.productVariantId)).toEqual([302,303]);
    expect((await store.listConflictsForChannel(10,1)).items.map(item=>item.productVariantId)).toEqual([303]);
    expect(await store.listConflictsForChannel(999,0)).toEqual({items:[],hasMore:false,offset:0});
    expect(getOffer).not.toHaveBeenCalled();
  });
  it("keeps conflicts beyond the first hundred available to the channel workspace", async () => {
    await database.pool.query(`INSERT INTO catalog.product_variants(id,product_id,sku,uom_type,is_active,requires_shipping,track_inventory,sales_eligibility)
      SELECT n,30,'ARCHIVED-'||n,'case',false,true,true,'sellable' FROM generate_series(400,500) n;
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,sync_status)
      SELECT 10,n,'OLD-'||n,'offer-archived','synced' FROM generate_series(400,500) n`);
    await seedLegacyRetirements(database.pool, now, 250);
    // Populate the read fixture as already reported conflicts; production
    // state changes still go through the worker and its immutable audit.
    await database.pool.query(`UPDATE marketplace.listing_member_retirements SET state='failed',
      code='LISTING_MEMBER_IDENTITY_CONFLICT',next_attempt_at='infinity'::timestamptz`);
    const first = await store.listConflictsForChannel(10,0);
    const second = await store.listConflictsForChannel(10,100);
    expect(first.items).toHaveLength(100); expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(2); expect(second.hasMore).toBe(false);
    expect(new Set([...first.items,...second.items].map(item=>item.operationId)).size).toBe(102);
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
  it("retains a lost deletion response after reading the same offer, without resending deletion", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    deleteOffer.mockImplementationOnce(async id => { remote.delete(id); throw new Error("response lost"); });
    await run(); expect((await receipts())[0].state).toBe("retiring");
    await run(new Date(now.getTime()+120_000)); expect((await receipts())[0]).toMatchObject({ state: "failed",
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", unconfirmedPriorDispatch: true });
    expect(deleteOffer).toHaveBeenCalledTimes(1);
  });
  it("rejects a different provider SKU, marketplace or listing without a write", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "DIFFERENT", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await run(); expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_IDENTITY_CHANGED" });
    expect(deleteOffer).not.toHaveBeenCalled(); expect(clearOffer).not.toHaveBeenCalled();
  });
  it("serializes competing workers and preserves an immutable event history", async () => {
    await seedLegacyRetirements(database.pool, now, 25); const [id] = await store.due(now,25);
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
    await seedLegacyRetirements(database.pool, now, 25);
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='replacement' WHERE product_variant_id=302");
    const [id] = await store.due(now,25);
    await store.withMember(id, session => processListingMemberRetirement(session,{ store, adapter: async () => adapter },()=>now));
    expect(getOffer).not.toHaveBeenCalled(); expect(await receipts()).toEqual([]);
    expect((await database.pool.query("SELECT state FROM marketplace.listing_member_retirements")).rows[0].state).toBe("superseded");
  });
  it("stops an unstarted removal when Catalog reactivates the member", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=now() WHERE id=302");
    const [id] = await store.due(now,25);
    await store.withMember(id, session => processListingMemberRetirement(session,{ store, adapter: async () => adapter },()=>now));
    expect(getOffer).not.toHaveBeenCalled(); expect(await receipts()).toEqual([]);
  });
  it.each(["unknown", "accepted"] as const)("retains a %s removal after its catalog owner changes and only observes the original identity", async dispatchStatus => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "Earlier removal", now,
      { dispatchStatus, dispatchKey: id }));
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=updated_at+interval '1 second' WHERE id=302");

    const retained = await receipts();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ operationId: id, dispatchStatus });
    await store.withMember(id, session => processListingMemberRetirement(session, { store, adapter: async () => adapter }, () => now));
    const [pending] = await receipts();
    expect(pending).toMatchObject({ state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", recoveryRequired: true });
    expect(getOffer).toHaveBeenCalledWith("offer-archived");
    expect(clearOffer).not.toHaveBeenCalled();
    expect(deleteOffer).not.toHaveBeenCalled();

    const recovery = new ListingMemberRecoveryService({ store, adapter: async () => adapter }, () => now);
    const review = await recovery.preview(10, id);
    expect(review).toMatchObject({ canResume: false, observation: { retired: false } });
    await expect(recovery.resume(10, { operationId: id, reviewHash: review.reviewHash, commandKey: randomUUID() }, "operator"))
      .rejects.toMatchObject({ code: "LISTING_MEMBER_RECOVERY_SCOPE_CHANGED" });
    expect(clearOffer).not.toHaveBeenCalled();
    expect(deleteOffer).not.toHaveBeenCalled();

    remote.delete("offer-archived");
    await store.withMember(id, session => processListingMemberRetirement(session, { store, adapter: async () => adapter }, () => now));
    const [completed] = await store.listForChannel(10, 30, 25);
    expect(completed).toMatchObject({ operationId: id, state: "failed", dispatchStatus });
    expect(clearOffer).not.toHaveBeenCalled();
    expect(deleteOffer).not.toHaveBeenCalled();
    expect(await receipts()).toEqual([expect.objectContaining({ state: "failed", unconfirmedPriorDispatch: true,
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED" })]);
    expect(await recovery.preview(10, id)).toMatchObject({ canResume: false, observation: { retired: true } });
    const events = (await database.pool.query("SELECT after_state FROM marketplace.listing_member_retirement_events WHERE operation_id=$1 ORDER BY version", [id])).rows;
    expect(events.map(row => row.after_state.state)).toEqual(["pending", "retiring", "failed", "failed"]);
  });
  it("does not let a successful retry erase an earlier unconfirmed dispatch", async () => {
    const { record, service } = await unresolvedRecovery();
    const review = await service.preview(10, record.operationId);
    const retryKey = randomUUID();
    const command = { operationId: record.operationId, reviewHash: review.reviewHash, commandKey: retryKey };
    await service.resume(10, command, "operator");
    await store.withMember(record.operationId, session => processListingMemberRetirement(session, { store, adapter: async () => adapter }, () => now));

    const [completed] = await receipts();
    expect(completed).toMatchObject({ state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
      dispatchStatus: "accepted", dispatchKey: retryKey, unconfirmedPriorDispatch: true });
    expect(archivedListingMemberSelection({ productVariantId: 302, archived: true, retirement: completed }))
      .not.toHaveProperty("retirementEvidence");
    const selected = await readChannelStockSelection(database.pool, { channelId: 10, channelConnectionId: 11, productId: 30, productVariantIds: [302] });
    const handoff = resolveListingIntentLifecycle({ selection: selected, accountId: "seller-one", retainedVariantIds: [302],
      retirements: [completed], stock: [], contentWork: [], now });
    expect(handoff).toMatchObject({ state: "waiting_lifecycle", lifecycle: { members: [{ state: "attention",
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", nextActions: [{ owner: "listing_member_retirement", operationId: record.operationId }] }] } });
    const saved = await service.preview(10, record.operationId);
    expect(saved).toMatchObject({ canResume: false, observation: { retired: true }, record: { unconfirmedPriorDispatch: true } });
    expect(saved.message).toContain("earlier removal has no confirmed final response");
    const owner = worker();
    const oldHistory = (await owner.memberHistory(10, { productId: 30 })).items.find(item => item.operationId === record.operationId);
    const newHistory = (await owner.memberHistory(10, { productId: 30 }, true)).items.find(item => item.operationId === record.operationId);
    expect(oldHistory).toBeDefined();
    expect(oldHistory).not.toHaveProperty("unconfirmedPriorDispatch");
    expect(newHistory).toHaveProperty("unconfirmedPriorDispatch", true);
    expect((await owner.memberRecoveryPreview(10, { operationId: record.operationId })).record).not.toHaveProperty("unconfirmedPriorDispatch");
    expect((await owner.memberRecoveryPreview(10, { operationId: record.operationId }, true)).record).toHaveProperty("unconfirmedPriorDispatch", true);
    expect(await owner.resumeMemberRecovery(10, command, "operator")).not.toHaveProperty("unconfirmedPriorDispatch");
    expect(deleteOffer).toHaveBeenCalledTimes(2);
  });
  it.each(["ebay", "shopify", "walmart"])("does not settle an unknown %s removal from an unpublished observation", async provider => {
    await database.pool.query("UPDATE channels.channels SET provider=$1 WHERE id=10", [provider]);
    if (provider === "shopify") await database.pool.query("UPDATE channels.channel_connections SET shop_domain='test.myshopify.com' WHERE id=11");
    if (provider === "walmart") await database.pool.query("INSERT INTO channels.walmart_connections VALUES(11,'seller-one','production','us')");
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "Earlier dispatch", now,
      { dispatchStatus: "unknown", dispatchKey: id }));
    const observe = vi.fn(async (identity: ListingMemberIdentity) => ({ identity, retired: true }));
    const retire = vi.fn();
    const dependencies = { store, adapter: async () => ({ observe, retire }) };

    await store.withMember(id, session => reconcileArchivedMemberRetirement(session, dependencies, () => now));
    const [record] = await receipts();
    expect(record).toMatchObject({ state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
      recoveryRequired: true, unconfirmedPriorDispatch: true, verifiedAt: null });
    expect(archivedListingMemberSelection({ productVariantId: 302, archived: true, retirement: record }))
      .not.toHaveProperty("retirementEvidence");
    const review = await new ListingMemberRecoveryService(dependencies, () => now).preview(10, id);
    expect(review).toMatchObject({ canResume: false, observation: { retired: true } });
    expect(review.message).toContain("earlier removal has no confirmed final response");
    expect(retire).not.toHaveBeenCalled();
    expect(await store.due(new Date(now.getTime() + 120_000), 25)).toEqual([]);
    expect(await store.due(new Date(now.getTime() + 16 * 60_000), 25)).toEqual([id]);
  });
  it("accepts a completed dispatch only for its own matching key", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await run();
    const [completed] = await receipts();
    expect(completed).toMatchObject({ state: "retired", dispatchStatus: "accepted" });
    expect(completed.unconfirmedPriorDispatch).toBeUndefined();
    expect(archivedListingMemberSelection({ productVariantId: 302, archived: true, retirement: completed }))
      .toHaveProperty("retirementEvidence.operationId", completed.operationId);
  });
  it("keeps a terminal record visible when its audit stream is incomplete", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await database.pool.query("UPDATE marketplace.listing_member_retirements SET version=version+1 WHERE id=$1", [id]);
    await store.withMember(id, session => session.save("retired", null, "Earlier observation", now));
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=updated_at+interval '1 second' WHERE id=302");
    expect(await receipts()).toEqual([expect.objectContaining({ operationId: id, state: "retired", unconfirmedPriorDispatch: true })]);
  });
  it("reads long audit histories in bounded pages without losing dispatch finality across page boundaries", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    await database.pool.query(`UPDATE marketplace.listing_member_retirements
      SET state='failed',version=1001,dispatch_status='unknown',dispatch_key=$2 WHERE id=$1`, [id, secondKey]);
    await database.pool.query(`INSERT INTO marketplace.listing_member_retirement_events
      (operation_id,version,actor,before_state,after_state,occurred_at)
      SELECT r.id,n,'fixture',NULL,to_jsonb(r) || jsonb_build_object(
        'version',n,
        'state',CASE WHEN n<500 THEN 'pending' WHEN n<502 THEN 'retiring' ELSE 'failed' END,
        'dispatch_status',CASE WHEN n<500 THEN 'none' WHEN n=500 THEN 'unknown' WHEN n=501 THEN 'accepted' ELSE 'unknown' END,
        'dispatch_key',CASE WHEN n<500 THEN NULL WHEN n<502 THEN $2::text ELSE $3::text END
      ),$4 FROM marketplace.listing_member_retirements r CROSS JOIN generate_series(2,1001) n WHERE r.id=$1`,
    [id, firstKey, secondKey, now]);
    const pageSizes: number[] = [];
    const client: StockSelectionQueryClient = { query: async <T>(sql: string, values?: readonly unknown[]) => {
      const result = await database.pool.query(sql, values ? [...values] : []);
      if (sql.includes("FROM marketplace.listing_member_retirement_events e")) pageSizes.push(result.rows.length);
      return { rows: result.rows as T[] };
    } };
    const [result] = await readListingMemberRetirements(client, { destinationKind: "channel_connection", connectionId: 11, productVariantIds: [302] });
    expect(pageSizes).toEqual([500, 500, 1]);
    expect(result).toMatchObject({ operationId: id, state: "failed", unconfirmedPriorDispatch: true });
  });
  it("does not call a history settled when a new dispatch is committed between pages", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await database.pool.query("UPDATE marketplace.listing_member_retirements SET state='failed',version=501 WHERE id=$1", [id]);
    await database.pool.query(`INSERT INTO marketplace.listing_member_retirement_events
      (operation_id,version,actor,before_state,after_state,occurred_at)
      SELECT r.id,n,'fixture',NULL,to_jsonb(r) || jsonb_build_object('version',n,
        'state',CASE WHEN n=501 THEN 'failed' ELSE 'pending' END),$2
      FROM marketplace.listing_member_retirements r CROSS JOIN generate_series(2,501) n WHERE r.id=$1`, [id, now]);
    const dispatchKey = randomUUID();
    let inserted = false;
    const client: StockSelectionQueryClient = { query: async <T>(sql: string, values?: readonly unknown[]) => {
      const result = await database.pool.query(sql, values ? [...values] : []);
      if (!inserted && sql.includes("FROM marketplace.listing_member_retirement_events e")) {
        inserted = true;
        const writer = await database.pool.connect();
        try {
          await writer.query("BEGIN");
          await writer.query(`UPDATE marketplace.listing_member_retirements SET state='retiring',version=502,
            dispatch_status='unknown',dispatch_key=$2 WHERE id=$1`, [id, dispatchKey]);
          await writer.query(`INSERT INTO marketplace.listing_member_retirement_events
            (operation_id,version,actor,before_state,after_state,occurred_at)
            SELECT id,version,'fixture',NULL,to_jsonb(r),$2 FROM marketplace.listing_member_retirements r WHERE id=$1`, [id, now]);
          await writer.query("COMMIT");
        } catch (error) { await writer.query("ROLLBACK"); throw error; }
        finally { writer.release(); }
      }
      return { rows: result.rows as T[] };
    } };
    const [result] = await readListingMemberRetirements(client, { destinationKind: "channel_connection", connectionId: 11, productVariantIds: [302] });
    expect(inserted).toBe(true);
    expect(result).toMatchObject({ operationId: id, unconfirmedPriorDispatch: true });
  });
  it("keeps an uncertain stale removal when provider readback fails", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "Unconfirmed dispatch", now,
      { dispatchStatus: "unknown", dispatchKey: id }));
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='new-owner' WHERE product_variant_id=302");
    getOffer.mockRejectedValueOnce(new Error("provider unavailable"));
    await store.withMember(id, session => processListingMemberRetirement(session, { store, adapter: async () => adapter }, () => now));
    expect((await receipts())[0]).toMatchObject({ operationId: id, state: "retiring", dispatchStatus: "unknown" });
    expect(deleteOffer).not.toHaveBeenCalled();
    expect(clearOffer).not.toHaveBeenCalled();
  });
  it("keeps an older unconfirmed removal actionable when a newer mapping generation exists", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await seedLegacyRetirements(database.pool, now, 25);
    const [oldId] = await store.due(now, 25);
    await store.withMember(oldId, session => session.save("retiring", null, "Unconfirmed dispatch", now,
      { dispatchStatus: "unknown", dispatchKey: oldId }));
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='new-offer' WHERE product_variant_id=302");
    await seedLegacyRetirements(database.pool, now, 25);
    await store.withMember(oldId, session => processListingMemberRetirement(session, { store, adapter: async () => adapter }, () => now));
    const retirements = await receipts();
    expect(retirements).toHaveLength(2);
    const selected = await readChannelStockSelection(database.pool, { channelId: 10, channelConnectionId: 11, productId: 30, productVariantIds: [302] });
    const result = resolveListingIntentLifecycle({ selection: selected, accountId: "seller-one", retainedVariantIds: [302],
      retirements, stock: [], contentWork: [], now });
    if (!result || result.state !== "waiting_lifecycle") throw new Error("Expected unresolved listing lifecycle work");
    expect(result.lifecycle.members[0]).toMatchObject({ state: "attention", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED" });
    expect(result.lifecycle.members[0].nextActions).toContainEqual({ owner: "listing_member_retirement", operationId: oldId });
    expect(deleteOffer).not.toHaveBeenCalled();
  });
  it("does not send an authorized retry if the owner changed after the recovery was saved", async () => {
    const { record, service } = await unresolvedRecovery();
    const review = await service.preview(10, record.operationId);
    await service.resume(10, { operationId: record.operationId, reviewHash: review.reviewHash, commandKey: randomUUID() }, "operator");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=updated_at+interval '1 second' WHERE id=302");
    const originalWrites = deleteOffer.mock.calls.length;
    await store.withMember(record.operationId, session => processListingMemberRetirement(session, { store, adapter: async () => adapter }, () => now));
    expect((await receipts())[0]).toMatchObject({ state: "failed", dispatchStatus: "authorized", recoveryRequired: true,
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED" });
    expect(deleteOffer).toHaveBeenCalledTimes(originalWrites);
  });
  it("serializes concurrent observations of a stale uncertain removal without another provider write", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "Unconfirmed dispatch", now,
      { dispatchStatus: "unknown", dispatchKey: id }));
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=updated_at+interval '1 second' WHERE id=302");
    let entered!: () => void;
    let release!: () => void;
    const observing = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const observe = vi.fn(async (identity: ListingMemberIdentity) => { entered(); await resume; return { identity, retired: false }; });
    const retire = vi.fn();
    const dependencies = { store, adapter: async () => ({ observe, retire }) };
    const first = store.withMember(id, session => processListingMemberRetirement(session, dependencies, () => now));
    await observing;
    expect(await store.withMember(id, session => processListingMemberRetirement(session, dependencies, () => now))).toBeNull();
    release();
    await first;
    expect(observe).toHaveBeenCalledTimes(1);
    expect(retire).not.toHaveBeenCalled();
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED" });
  });
  it.each(["ebay", "shopify", "walmart"])("uses the same stale-dispatch guard for %s", async provider => {
    await database.pool.query("UPDATE channels.channels SET provider=$1 WHERE id=10", [provider]);
    if (provider === "shopify") await database.pool.query("UPDATE channels.channel_connections SET shop_domain='test.myshopify.com' WHERE id=11");
    if (provider === "walmart") await database.pool.query("INSERT INTO channels.walmart_connections VALUES(11,'seller-one','production','us')");
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "Unconfirmed dispatch", now,
      { dispatchStatus: "unknown", dispatchKey: id }));
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true,updated_at=updated_at+interval '1 second' WHERE id=302");
    const observe = vi.fn(async (identity: ListingMemberIdentity) => ({ identity, retired: false }));
    const retire = vi.fn();
    await store.withMember(id, session => processListingMemberRetirement(session,
      { store, adapter: async () => ({ observe, retire }) }, () => now));
    expect((await receipts())[0]).toMatchObject({ identity: { provider }, state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED" });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(retire).not.toHaveBeenCalled();
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
    await seedLegacyRetirements(database.pool, now, 25);
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
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now,25);
    await store.withMember(id, session => processListingMemberRetirement(session,{ store, adapter: async () => walmart },()=>now));
    expect(retire).toHaveBeenCalledExactlyOnceWith(account,"OLD-REMOTE-SKU",id);
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
      unconfirmedPriorDispatch: true, identity: { provider: "walmart", accountId: "walmart-seller" } });
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
      await seedLegacyRetirements(database.pool, date, 25);
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
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
      unconfirmedPriorDispatch: true });
    expect(retire).toHaveBeenCalledTimes(1);
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
    expect((await receipts())[0]).toMatchObject({ state: "failed", recoveryRequired: true,
      code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", unconfirmedPriorDispatch: true });
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
    const retire = vi.fn(async () => ({ finality: "pending" as const }));
    const process = async (time: Date) => {
      await seedLegacyRetirements(database.pool, time, 25);
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
    expect((await receipts())[0]).toMatchObject({ state: "failed", code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED",
      unconfirmedPriorDispatch: true });
    expect(retire).toHaveBeenCalledTimes(1);
  });
  it("retains an old accepted response as unconfirmed after a restart and current retired observation", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "Earlier send", now,
      { dispatchStatus: "unknown", dispatchKey: id }));
    // Old binaries saved acceptance without saying whether the request finished.
    await store.withMember(id, session => session.save("retired", null, "Old completion", now,
      { dispatchStatus: "accepted" }));
    store = new PostgresListingMemberLifecycleRepository(database.pool);
    const [saved] = await receipts();
    expect(saved).toMatchObject({ state: "retired", unconfirmedPriorDispatch: true, dispatchStatus: "accepted" });
    expect(archivedListingMemberSelection({ productVariantId: 302, archived: true, retirement: saved }))
      .not.toHaveProperty("retirementEvidence");
    const review = await new ListingMemberRecoveryService({ store, adapter: async () => adapter }, () => now).preview(10, id);
    expect(review).toMatchObject({ canResume: false, observation: { retired: true } });
    expect(clearOffer).not.toHaveBeenCalled(); expect(deleteOffer).not.toHaveBeenCalled();
  });
  it("clears a terminal receipt when an older worker starts a new dispatch key", async () => {
    await seedLegacyRetirements(database.pool, now, 25);
    const [id] = await store.due(now, 25);
    await store.withMember(id, session => session.save("retiring", null, "First send", now,
      { dispatchStatus: "unknown", dispatchKey: id }));
    await store.withMember(id, session => session.save("retiring", null, "First final receipt", now,
      { dispatchStatus: "accepted", dispatchFinality: "terminal" }));
    expect((await receipts())[0].unconfirmedPriorDispatch).toBeUndefined();
    const nextKey = randomUUID();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      // This models the previous worker, which does not know dispatch_finality.
      const next = (await client.query(`UPDATE marketplace.listing_member_retirements
        SET dispatch_status='unknown',dispatch_key=$2,version=version+1 WHERE id=$1 RETURNING dispatch_finality`, [id, nextKey])).rows[0];
      expect(next.dispatch_finality).toBeNull();
      await client.query(`INSERT INTO marketplace.listing_member_retirement_events(operation_id,version,actor,before_state,after_state,occurred_at)
        SELECT id,version,'old-worker',NULL,to_jsonb(r),$2 FROM marketplace.listing_member_retirements r WHERE id=$1`, [id, now]);
      const accepted = (await client.query(`UPDATE marketplace.listing_member_retirements
        SET dispatch_status='accepted',version=version+1 WHERE id=$1 RETURNING dispatch_finality`, [id])).rows[0];
      expect(accepted.dispatch_finality).toBeNull();
      await client.query(`INSERT INTO marketplace.listing_member_retirement_events(operation_id,version,actor,before_state,after_state,occurred_at)
        SELECT id,version,'old-worker',NULL,to_jsonb(r),$2 FROM marketplace.listing_member_retirements r WHERE id=$1`, [id, now]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    const [saved] = await receipts();
    expect(saved).toMatchObject({ dispatchStatus: "accepted", dispatchKey: nextKey, unconfirmedPriorDispatch: true });
  });
  it("rolls back a failed audit write before any external removal and resumes the same request", async () => {
    remote.set("offer-archived", { offerId: "offer-archived", sku: "OLD-REMOTE-SKU", marketplaceId: "EBAY_US", status: "PUBLISHED" });
    await seedLegacyRetirements(database.pool, now, 25);
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
    await seedLegacyRetirements(database.pool, now, 25);
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
    await seedLegacyRetirements(database.pool, now, 1); // Existing valid work must survive a later malformed source.
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

    await seedLegacyRetirements(database.pool, now, 1);
    await seedLegacyRetirements(database.pool, now, 1);
    await seedLegacyRetirements(database.pool, now, 1);
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
        await seedLegacyRetirements(database.pool, date, 25);
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
      expect((await receipts())[0]).toMatchObject({ operationId: uncertain.operationId, state: "failed", recoveryRequired: true,
        code: "LISTING_MEMBER_PRIOR_REMOVAL_UNCONFIRMED", unconfirmedPriorDispatch: true });
      expect(mutations).toBe(1);
      expect(request).toHaveBeenCalledTimes(5);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
