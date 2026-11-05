import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { availabilityClaimPublicationGuard, claimVariantAvailabilitySyncs, enqueueVariantAvailabilitySync, markVariantAvailabilityNotApplicable, markVariantAvailabilityFailed,
  markVariantAvailabilitySynced as completeSavedAvailability, retainVariantAvailabilityAcknowledgement, supersedeAvailabilityClaim,
  type ClaimedVariantAvailabilitySync, type SqlPool, type VariantAvailabilityContext } from "../../variant-availability-sync.repository";

const base = `CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA dropship;
  CREATE SCHEMA marketplace; CREATE SCHEMA inventory; CREATE SCHEMA wms; CREATE SCHEMA oms;
  CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text,ebay_listing_excluded boolean DEFAULT false);
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products(id),is_active boolean,
    sales_eligibility text NOT NULL DEFAULT 'sellable',sku text,shopify_variant_id text,shopify_inventory_item_id text,dropship_eligible boolean DEFAULT false,
    requires_shipping boolean NOT NULL DEFAULT true,track_inventory boolean DEFAULT true,ebay_listing_excluded boolean DEFAULT false);
  CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text,status text DEFAULT 'active',sync_enabled boolean DEFAULT true,sync_mode text DEFAULT 'live');
  CREATE TABLE channels.channel_feeds(
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels(id),product_variant_id integer REFERENCES catalog.product_variants(id),
    channel_variant_id text,channel_product_id text,channel_inventory_item_id text,channel_sku text,is_active integer,
    last_synced_qty integer,last_synced_at timestamptz,updated_at timestamptz,
    UNIQUE(channel_id,product_variant_id));
  CREATE TABLE channels.channel_listings(
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer REFERENCES channels.channels(id),product_variant_id integer REFERENCES catalog.product_variants(id),
    external_product_id text,external_variant_id text,external_sku text,last_synced_qty integer,
    last_synced_at timestamptz,sync_status text,sync_error text,created_at timestamptz,updated_at timestamptz,
    UNIQUE(channel_id,product_variant_id));
  CREATE TABLE channels.channel_reservations(product_variant_id integer);
  CREATE TABLE channels.channel_product_overrides(channel_id integer REFERENCES channels.channels(id),product_id integer REFERENCES catalog.products(id),is_listed integer);
  CREATE TABLE channels.channel_variant_overrides(channel_id integer REFERENCES channels.channels(id),product_variant_id integer REFERENCES catalog.product_variants(id),is_listed integer);
  CREATE TABLE channels.channel_allocation_rules(product_variant_id integer);
  CREATE TABLE dropship.dropship_vendor_listings(product_variant_id integer);
  CREATE TABLE dropship.dropship_vendor_variant_overrides(product_variant_id integer);
  CREATE TABLE marketplace.listing_publications(id integer,status text);
  CREATE TABLE marketplace.listing_publication_members(publication_id integer,product_variant_id integer,disposition text);
  CREATE TABLE inventory.inventory_publication_outbox(product_variant_id integer,state text);
  CREATE TABLE inventory.quantity_publication_attempts(id bigint PRIMARY KEY,state text NOT NULL,resolution_basis text,outcome_hash text,request_journal_contract jsonb,
    scope jsonb NOT NULL DEFAULT '{"destinationKind":"channel_connection","connectionId":1,"providerKey":"ebay","providerScopeType":"account","externalScopeId":"seller","externalInventoryItemId":"EXAMPLE","productId":1,"productVariantId":1}'::jsonb);
  CREATE TABLE inventory.quantity_publication_response_recoveries(attempt_id bigint PRIMARY KEY REFERENCES inventory.quantity_publication_attempts(id),evidence_hash text NOT NULL);
  CREATE TABLE wms.orders(id integer,warehouse_status text);
  CREATE TABLE wms.order_items(order_id integer,sku text,status text,fulfilled_quantity integer,quantity integer);
  CREATE TABLE oms.oms_orders(id integer,status text);
  CREATE TABLE oms.oms_order_lines(order_id integer,product_variant_id integer);`;
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const lease = "123e4567-e89b-42d3-a456-426614174000";
const claim: ClaimedVariantAvailabilitySync = {
  channelId: 1,productVariantId: 1,desiredActive: true,revision: 1,attemptCount: 1,leaseToken: lease,
  requestKind: "catalog_activation",
};
const context: VariantAvailabilityContext = {
  channelId: 1, channelName: "Test channel", channelProvider: "ebay", channelStatus: "active", channelSyncEnabled: true,
  channelSyncMode: "live", productId: 1, productVariantId: 1, catalogSku: null, catalogVariantActive: true,
  catalogRequiresShipping: true, catalogTrackInventory: true, catalogSalesEligibility: "sellable", variantExcluded: false,
  catalogProductActive: true, catalogProductStatus: "active", productExcluded: false, productOverrideIsListed: null,
  variantOverrideIsListed: null, feedId: 1, listingId: null, externalProductId: null, externalVariantId: null,
  externalInventoryItemId: null, externalSku: "EXAMPLE", previousQuantity: null,
  mappingSnapshot: { productId: 1, catalogSku: null,
    feed: { id: 1, productId: null, variantId: null, inventoryItemId: null, sku: "EXAMPLE" }, listing: null },
};

(url && disposable ? describe : describe.skip).sequential("availability archive cutover with PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  const pool = () => database.pool as unknown as SqlPool;
  async function markVariantAvailabilitySynced(dbPool: SqlPool, work: ClaimedVariantAvailabilitySync,
    result: Parameters<typeof completeSavedAvailability>[2]): Promise<boolean> {
    const row = (await database.pool.query(`SELECT v.product_id,v.sku,to_jsonb(f) AS feed,to_jsonb(l) AS listing
      FROM catalog.product_variants v
      LEFT JOIN channels.channel_feeds f ON f.product_variant_id=v.id AND f.channel_id=$2
      LEFT JOIN channels.channel_listings l ON l.product_variant_id=v.id AND l.channel_id=$2
      WHERE v.id=$1`, [work.productVariantId,work.channelId])).rows[0];
    return (await completeSavedAvailability(dbPool,work,result, { productId: row.product_id,catalogSku: row.sku,
      feed: row.feed && { id: row.feed.id,productId: row.feed.channel_product_id,variantId: row.feed.channel_variant_id,
        inventoryItemId: row.feed.channel_inventory_item_id,sku: row.feed.channel_sku },
      listing: row.listing && { id: row.listing.id,productId: row.listing.external_product_id,
        variantId: row.listing.external_variant_id,sku: row.listing.external_sku } })) === "synced";
  }
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, base);
    // Use the production request tables and their indexes, alongside the
    // compact provider-attempt fixture used by this queue-focused suite.
    const requests = readFileSync(resolve("migrations/0663_quantity_provider_request_evidence.sql"), "utf8");
    const requestStart = requests.indexOf("CREATE TABLE inventory.quantity_provider_requests");
    const requestEnd = requests.indexOf("CREATE TRIGGER quantity_provider_requests_immutable");
    expect(requestStart).toBeGreaterThanOrEqual(0); expect(requestEnd).toBeGreaterThan(requestStart);
    await database.pool.query(requests.slice(requestStart,requestEnd));
    const finality = readFileSync(resolve("migrations/0733_ebay_provider_response_finality.sql"), "utf8");
    await database.pool.query(finality.slice(0,finality.indexOf("COMMENT ON COLUMN")));
    await database.pool.query(readFileSync(resolve("migrations/0606_channel_variant_availability_sync.sql"), "utf8"));
    const eligibilityMigration = readFileSync(resolve("migrations/0626_catalog_variant_sales_eligibility.sql"), "utf8");
    const sellabilityStart = eligibilityMigration.indexOf("CREATE OR REPLACE FUNCTION catalog.assert_customer_sellable_variant()");
    const sellabilityEnd = eligibilityMigration.indexOf("CREATE OR REPLACE FUNCTION catalog.guard_internal_only_variant_transition()");
    expect(sellabilityStart).toBeGreaterThan(0); expect(sellabilityEnd).toBeGreaterThan(sellabilityStart);
    await database.pool.query(eligibilityMigration.slice(sellabilityStart,sellabilityEnd));
    await database.pool.query(readFileSync(resolve("migrations/900000056000020020001_channel_availability_archive_separation.sql"), "utf8"));
    await database.pool.query(`CREATE TRIGGER product_variants_guard_internal_only_transition
      BEFORE UPDATE OF sales_eligibility,shopify_variant_id,shopify_inventory_item_id,dropship_eligible
      ON catalog.product_variants FOR EACH ROW EXECUTE FUNCTION catalog.guard_internal_only_variant_transition()`);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    // Tests deliberately reuse one lease token. Clear only this disposable
    // database's immutable receipts between cases, then restore the real guard.
    await database.pool.query(`ALTER TABLE channels.channel_variant_availability_decisions DISABLE TRIGGER channel_variant_availability_decisions_immutable;
      TRUNCATE channels.channel_variant_availability_decisions RESTART IDENTITY;
      ALTER TABLE channels.channel_variant_availability_decisions ENABLE TRIGGER channel_variant_availability_decisions_immutable;
      ALTER TABLE channels.channel_variant_availability_attempts DISABLE TRIGGER channel_variant_availability_attempts_immutable;
      ALTER TABLE channels.channel_variant_availability_claims DISABLE TRIGGER channel_variant_availability_claims_immutable;
      TRUNCATE channels.channel_variant_availability_claims,channels.channel_variant_availability_attempts,inventory.quantity_publication_response_recoveries,inventory.quantity_provider_request_results,
        inventory.quantity_provider_requests,inventory.quantity_publication_attempts RESTART IDENTITY;
      ALTER TABLE channels.channel_variant_availability_attempts ENABLE TRIGGER channel_variant_availability_attempts_immutable;
      ALTER TABLE channels.channel_variant_availability_claims ENABLE TRIGGER channel_variant_availability_claims_immutable;`);
    await database.pool.query(`TRUNCATE channels.channel_variant_availability_followups,
      channels.channel_variant_availability_sync,channels.channel_feeds,channels.channel_listings,
      catalog.product_variants,catalog.products,channels.channels RESTART IDENTITY CASCADE;
      INSERT INTO catalog.products VALUES (1,true,'active');
      INSERT INTO channels.channels(id,provider) VALUES (1,'ebay');
      INSERT INTO catalog.product_variants VALUES (1,1,true),(2,1,false);
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,is_active) VALUES(1,1,'EXAMPLE',1);
      UPDATE channels.channel_variant_availability_sync
        SET status='processing',attempt_count=1,lease_token='${lease}',lease_expires_at=transaction_timestamp()+interval '5 minutes'
        WHERE product_variant_id=1;
      INSERT INTO channels.channel_variant_availability_claims(channel_id,product_variant_id,revision,lease_token,attempt_count)
        VALUES(1,1,1,'${lease}',1);`);
  });
  it("rejects a replaced or expired claim before the publication owner can write", async () => {
    const client = await database.pool.connect();
    try {
      await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_token='123e4567-e89b-42d3-a456-426614174001' WHERE product_variant_id=1");
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(client)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CLAIM_CHANGED" });
      await client.query("ROLLBACK");
      await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_token=$1,lease_expires_at=transaction_timestamp()-interval '1 second' WHERE product_variant_id=1", [lease]);
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(client)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CLAIM_CHANGED" });
      await client.query("ROLLBACK");
    } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
  });
  it("rejects archive and mapping changes made after the worker read its context", async () => {
    const client = await database.pool.connect();
    try {
      await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='different-offer' WHERE product_variant_id=1");
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(client)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_MAPPING_CHANGED" });
      await client.query("ROLLBACK");
      await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id=NULL WHERE product_variant_id=1");
      await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(client)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CATALOG_CHANGED" });
      await client.query("ROLLBACK");
    } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
  });
  it("rejects a changed secondary mapping even when the coalesced provider identity is unchanged", async () => {
    const listing = (await database.pool.query<{ id: number }>(`INSERT INTO channels.channel_listings
      (channel_id,product_variant_id,external_variant_id,external_sku) VALUES(1,1,'offer-old','EXAMPLE') RETURNING id`)).rows[0];
    await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='offer-old' WHERE product_variant_id=1");
    const readContext: VariantAvailabilityContext = { ...context, listingId: listing.id, externalVariantId: "offer-old",
      mappingSnapshot: { ...context.mappingSnapshot,
        feed: { ...context.mappingSnapshot.feed!, variantId: "offer-old" },
        listing: { id: listing.id, productId: null, variantId: "offer-old", sku: "EXAMPLE" } } };
    await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='offer-new' WHERE product_variant_id=1");
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, readContext)(client))
        .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_MAPPING_CHANGED" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("rejects stale catalog and channel inclusion decisions before admission", async () => {
    const client = await database.pool.connect();
    try {
      await database.pool.query("UPDATE catalog.products SET status='draft' WHERE id=1");
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(client)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CATALOG_CHANGED" });
      await client.query("ROLLBACK");
      await database.pool.query("UPDATE catalog.products SET status='active',ebay_listing_excluded=true WHERE id=1");
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(client)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CATALOG_CHANGED" });
      await client.query("ROLLBACK");
      await database.pool.query("UPDATE catalog.products SET ebay_listing_excluded=false WHERE id=1");
      await database.pool.query("INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,is_listed) VALUES(1,1,0)");
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(client)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_SELECTION_CHANGED" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it.each(["provider='shopify'", "status='disabled'", "sync_enabled=false", "sync_mode='dry_run'"])
  ("rejects a channel configuration change made before admission: %s", async change => {
    await database.pool.query(`UPDATE channels.channels SET ${change} WHERE id=1`);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim,context)(client))
        .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CHANNEL_CHANGED" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("pins an absent channel inclusion override through admission", async () => {
    const owner = await database.pool.connect();
    const editor = await database.pool.connect();
    try {
      await owner.query("BEGIN");
      await availabilityClaimPublicationGuard(claim, context)(owner);
      await editor.query("BEGIN");
      await editor.query("SET LOCAL lock_timeout='100ms'");
      await expect(editor.query("INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,is_listed) VALUES(1,1,0)"))
        .rejects.toMatchObject({ code: "55P03" });
      await editor.query("ROLLBACK");
      await owner.query("COMMIT");
      await editor.query("INSERT INTO channels.channel_variant_overrides(channel_id,product_variant_id,is_listed) VALUES(1,1,0)");
    } finally { await owner.query("ROLLBACK").catch(() => undefined); await editor.query("ROLLBACK").catch(() => undefined); owner.release(); editor.release(); }
  });
  it("pins channel sync settings through the publication admission transaction", async () => {
    const owner = await database.pool.connect();
    const editor = await database.pool.connect();
    try {
      await owner.query("BEGIN");
      await availabilityClaimPublicationGuard(claim,context)(owner);
      await editor.query("BEGIN");
      await editor.query("SET LOCAL lock_timeout='100ms'");
      await expect(editor.query("UPDATE channels.channels SET sync_enabled=false WHERE id=1"))
        .rejects.toMatchObject({ code: "55P03" });
      await editor.query("ROLLBACK");
      await owner.query("COMMIT");
      await editor.query("UPDATE channels.channels SET sync_enabled=false WHERE id=1");
    } finally { await owner.query("ROLLBACK").catch(() => undefined); await editor.query("ROLLBACK").catch(() => undefined); owner.release(); editor.release(); }
  });
  it("classifies an unavailable mapping lock as an admission failure", async () => {
    const editor = await database.pool.connect();
    const owner = await database.pool.connect();
    try {
      await editor.query("BEGIN");
      await editor.query("UPDATE channels.channel_feeds SET channel_variant_id='locked-offer' WHERE product_variant_id=1");
      await owner.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(owner)).rejects.toMatchObject({
        code: "VARIANT_AVAILABILITY_GUARD_FAILED",context: { sqlState: "55P03" },
      });
    } finally { await owner.query("ROLLBACK"); await editor.query("ROLLBACK"); owner.release(); editor.release(); }
  });
  it("does not project a late provider acknowledgement over a changed link or lose ordered follow-up work", async () => {
    const response = { quantity: 17,feedActive: true,externalProductId: "listing-old",externalVariantId: "offer-old",
      externalInventoryItemId: null,externalSku: "EXAMPLE" };
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='offer-new' WHERE product_variant_id=1");
    expect(await completeSavedAvailability(pool(),claim,response,context.mappingSnapshot)).toBe("needs_review");
    expect((await database.pool.query("SELECT channel_variant_id,last_synced_qty FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0])
      .toEqual({ channel_variant_id: "offer-new",last_synced_qty: null });
    expect((await database.pool.query("SELECT status,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review",lease_token: null });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" }]);
    const decision = (await database.pool.query("SELECT disposition,before_state FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0];
    expect(decision).toMatchObject({ disposition: "provider_acknowledged_mapping_changed",
      before_state: { sourceMapping: context.mappingSnapshot,acknowledgedResult: response } });
    expect(await completeSavedAvailability(pool(),claim,response,context.mappingSnapshot)).toBe("needs_review");
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1 AND disposition='provider_acknowledged_mapping_changed'")).rows[0].count).toBe(1);
  });
  it("keeps a late acknowledgement for a replaced claim without changing the new claim, with idempotent replay", async () => {
    const response = { quantity: 17,feedActive: true,externalProductId: "listing-old",externalVariantId: "offer-old",
      externalInventoryItemId: null,externalSku: "EXAMPLE" };
    const replacement = "123e4567-e89b-42d3-a456-426614174001";
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_token=$1 WHERE product_variant_id=1", [replacement]);
    expect(await completeSavedAvailability(pool(),claim,response,context.mappingSnapshot)).toBe("claim_changed");
    expect(await completeSavedAvailability(pool(),claim,response,context.mappingSnapshot)).toBe("claim_changed");
    await expect(completeSavedAvailability(pool(),claim,{ ...response,quantity: 18 },context.mappingSnapshot))
      .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_ACKNOWLEDGEMENT_CONFLICT" });
    expect((await database.pool.query("SELECT status,lease_token,last_synced_quantity FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "processing",lease_token: replacement,last_synced_quantity: null });
    const receipts = (await database.pool.query(`SELECT disposition,before_state FROM channels.channel_variant_availability_decisions
      WHERE product_variant_id=1 AND disposition='provider_acknowledged_claim_changed'`)).rows;
    expect(receipts).toEqual([expect.objectContaining({ before_state: expect.objectContaining({
      sourceMapping: context.mappingSnapshot,acknowledgedResult: response,
    }) })]);
    await expect(database.pool.query("DELETE FROM channels.channel_variant_availability_decisions WHERE disposition='provider_acknowledged_claim_changed'"))
      .rejects.toMatchObject({ code: "55000" });
  });
  it.each(["running","uncertain","succeeded"])("parks an expired claim with a %s provider attempt instead of resending", async state => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state) VALUES(1,$1)", [state]);
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb)`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status,lease_token,last_error FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toMatchObject({ status: "needs_review",lease_token: null,last_error: expect.stringContaining("previous channel request") });
    expect((await database.pool.query("SELECT disposition,before_state,after_state FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1")).rows)
      .toMatchObject([{ disposition: "provider_attempt_unsettled",before_state: { status: "processing" },after_state: { status: "needs_review" } }]);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.channel_variant_availability_decisions WHERE disposition='provider_attempt_unsettled'")).rows[0].count).toBe(1);
  });
  it("allows a new claim after a conclusively rejected provider attempt", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state,resolution_basis,request_journal_contract) VALUES(1,'rejected','provider_rejection','{}'::jsonb)");
    await database.pool.query(`INSERT INTO inventory.quantity_provider_requests(id,attempt_id,ordinal,method,path,request_hash,started_at)
      VALUES(1,1,1,'PUT','/sell/inventory/v1/inventory_item/EXAMPLE',repeat('a',64),transaction_timestamp());
      INSERT INTO inventory.quantity_provider_request_results(request_id,outcome,http_status,response_hash,error_codes,recorded_at,request_terminated)
      VALUES(1,'rejected',400,repeat('b',64),'{}',transaction_timestamp(),true)`);
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb)`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    const claims = await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ revision: 1,attemptCount: 2,desiredActive: true });
    expect(claims[0].leaseToken).not.toBe(lease);
  });
  it.each(["not_sent","rejected"])("automatically resumes a parked claim when its %s attempt has conclusive finality", async state => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state) VALUES(1,'running')");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb)`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 })).toEqual([]);
    if (state === "rejected") await database.pool.query(`INSERT INTO inventory.quantity_provider_requests
      (id,attempt_id,ordinal,method,path,request_hash,started_at) VALUES(1,1,1,'PUT','/sell/inventory/v1/inventory_item/EXAMPLE',repeat('a',64),transaction_timestamp());
      INSERT INTO inventory.quantity_provider_request_results(request_id,outcome,http_status,response_hash,error_codes,recorded_at,request_terminated)
      VALUES(1,'rejected',400,repeat('b',64),'{}',transaction_timestamp(),true)`);
    await database.pool.query("UPDATE inventory.quantity_publication_attempts SET state=$1,resolution_basis=$2,request_journal_contract='{}'::jsonb WHERE id=1",
      [state,state === "not_sent" ? "owner_preflight_no_request" : "provider_rejection"]);
    const results = await Promise.all([
      claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 }),
      claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 }),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(results.flat()[0]).toMatchObject({ revision: 1,attemptCount: 2,desiredActive: true });
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions ORDER BY id")).rows)
      .toEqual([{ disposition: "provider_attempt_unsettled" },{ disposition: "provider_attempt_final" }]);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 })).toEqual([]);
  });
  it.each([null,false])("does not retry a rejected request without proven provider finality (%s)", async finality => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state,resolution_basis,request_journal_contract) VALUES(1,'rejected','provider_rejection','{}'::jsonb)");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb)`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query(`INSERT INTO inventory.quantity_provider_requests
      (id,attempt_id,ordinal,method,path,request_hash,started_at) VALUES(1,1,1,'PUT','/sell/inventory/v1/inventory_item/EXAMPLE',repeat('a',64),transaction_timestamp())`);
    await database.pool.query(`INSERT INTO inventory.quantity_provider_request_results
      (request_id,outcome,http_status,response_hash,error_codes,recorded_at,request_terminated)
      VALUES(1,'rejected',400,repeat('b',64),'{}',transaction_timestamp(),$1)`, [finality]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 })).toEqual([]);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review" });
  });
  it("bounds unresolved rechecks and resumes when the recorded attempt later becomes final", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state) VALUES(1,'running')");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb)`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT next_attempt_at>clock_timestamp() AS deferred FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ deferred: true });
    await database.pool.query("UPDATE inventory.quantity_publication_attempts SET state='not_sent',resolution_basis='owner_preflight_no_request' WHERE id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toHaveLength(1);
  });
  it("does not resume while any linked attempt lacks finality", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state,resolution_basis) VALUES(1,'not_sent','owner_preflight_no_request'),(2,'uncertain',NULL)");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb),(2,1,1,1,$1,true,'catalog_activation',$2::jsonb)`,
    [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions ORDER BY id")).rows)
      .toEqual([{ disposition: "provider_attempt_unsettled" }]);
  });
  it("does not retry a final recorded attempt when an older claimant lacks a receipt", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state,resolution_basis) VALUES(1,'not_sent','owner_preflight_no_request')");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping,provider_environment)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb,'production')`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET attempt_count=2,
      lease_token='123e4567-e89b-42d3-a456-426614174001',lease_expires_at=clock_timestamp()-interval '1 second'
      WHERE product_variant_id=1`);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status,last_error FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toMatchObject({ status: "needs_review",last_error: expect.stringContaining("no complete claim history") });
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions ORDER BY id")).rows)
      .toEqual([{ disposition: "legacy_attempt_history_unverified" }]);
  });
  it("does not infer an operation when its saved request kind is absent", async () => {
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET request_kind=NULL,
      lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1`);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review" });
  });
  it("rejects provider evidence that is not associated with any recorded claim", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state,resolution_basis) VALUES(1,'not_sent','owner_preflight_no_request')");
    await expect(database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping,provider_environment)
      VALUES(1,1,1,1,'123e4567-e89b-42d3-a456-426614174001',true,'catalog_activation',$1::jsonb,'production')`,
    [JSON.stringify(context.mappingSnapshot)])).rejects.toMatchObject({ code: "23503" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_attempts WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("rolls back a queue claim when its immutable receipt cannot be saved", async () => {
    await database.pool.query(`ALTER TABLE channels.channel_variant_availability_claims DISABLE TRIGGER channel_variant_availability_claims_immutable;
      DELETE FROM channels.channel_variant_availability_claims WHERE channel_id=1 AND product_variant_id=1;
      ALTER TABLE channels.channel_variant_availability_claims ENABLE TRIGGER channel_variant_availability_claims_immutable;
      UPDATE channels.channel_variant_availability_sync SET status='pending',attempt_count=0,lease_token=NULL,lease_expires_at=NULL,
        next_attempt_at=transaction_timestamp() WHERE product_variant_id=1;
      CREATE FUNCTION channels.reject_claim_receipt_test() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'claim receipt unavailable'; END $$;
      CREATE TRIGGER reject_claim_receipt_test BEFORE INSERT ON channels.channel_variant_availability_claims
        FOR EACH ROW EXECUTE FUNCTION channels.reject_claim_receipt_test();`);
    try {
      await expect(claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).rejects.toThrow("claim receipt unavailable");
      expect((await database.pool.query("SELECT status,attempt_count,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "pending",attempt_count: 0,lease_token: null });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_claims WHERE product_variant_id=1")).rowCount).toBe(0);
    } finally {
      await database.pool.query("DROP TRIGGER reject_claim_receipt_test ON channels.channel_variant_availability_claims; DROP FUNCTION channels.reject_claim_receipt_test()");
    }
  });
  it("retains malformed provider scope evidence without repeatedly failing the worker", async () => {
    await database.pool.query(`INSERT INTO inventory.quantity_publication_attempts(id,state,resolution_basis,scope)
      VALUES(1,'not_sent','owner_preflight_no_request','{"invalid":true}'::jsonb)`);
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping,provider_environment)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb,'production')`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review" });
  });
  it("does not replay an old request against a changed channel link, even after provider finality", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state) VALUES(1,'running')");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb)`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await enqueueVariantAvailabilitySync(pool(),{ channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    await database.pool.query("UPDATE channels.channel_feeds SET channel_sku='NEW-OWNER' WHERE product_variant_id=1");
    await database.pool.query("UPDATE inventory.quantity_publication_attempts SET state='not_sent',resolution_basis='owner_preflight_no_request' WHERE id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status,last_error FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toMatchObject({ status: "needs_review",last_error: expect.stringContaining("link changed") });
    expect((await database.pool.query("SELECT request_kind FROM channels.channel_variant_availability_followups")).rows)
      .toEqual([{ request_kind: "stock_repair" }]);
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions ORDER BY id")).rows)
      .toEqual([{ disposition: "provider_attempt_unsettled" }]);
    await database.pool.query("UPDATE channels.channel_feeds SET channel_sku='EXAMPLE' WHERE product_variant_id=1");
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toHaveLength(1);
  });
  it("requires the original account, connection, item and environment before retrying retained work", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state,resolution_basis) VALUES(1,'not_sent','owner_preflight_no_request')");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping,provider_environment)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb,'production')`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await enqueueVariantAvailabilitySync(pool(),{ channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    const [retry] = await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 });
    const guard = availabilityClaimPublicationGuard(retry,context);
    const original = { destinationKind: "channel_connection" as const,connectionId: 1,providerKey: "ebay" as const,
      providerScopeType: "account" as const,externalScopeId: "seller",externalInventoryItemId: "EXAMPLE",productId: 1,productVariantId: 1 };
    const client = await database.pool.connect();
    try {
      for (const [scope,environment] of [
        [{ ...original,externalScopeId: "different-seller" },"production" as const],
        [{ ...original,connectionId: 2 },"production" as const],
        [{ ...original,externalInventoryItemId: "other-sku" },"production" as const],
        [original,"sandbox" as const],
      ] as const) {
        await client.query("BEGIN");
        await expect(guard(client,{ scopes: [scope],environment })).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_SCOPE_CHANGED" });
        await client.query("ROLLBACK");
      }
      await client.query("BEGIN");
      await expect(guard(client,{ scopes: [original],environment: "production" })).resolves.toBeUndefined();
      await client.query("ROLLBACK");
    } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
    const error = new (await import("../../../inventory-planning/publication-transaction-guard")).QuantityPublicationAdmissionError(
      "VARIANT_AVAILABILITY_SCOPE_CHANGED","The channel account changed.");
    expect(await markVariantAvailabilityFailed(pool(),retry,error)).toBe("needs_review");
    expect(await markVariantAvailabilityFailed(pool(),retry,error)).toBe("superseded");
    expect((await database.pool.query("SELECT status,last_error FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review",last_error: "The channel account changed." });
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions ORDER BY id")).rows)
      .toEqual([{ disposition: "provider_scope_changed" }]);
    expect((await database.pool.query("SELECT request_kind FROM channels.channel_variant_availability_followups")).rows)
      .toEqual([{ request_kind: "stock_repair" }]);
  });
  it("rolls back automatic recovery if its immutable decision cannot be saved", async () => {
    await database.pool.query("INSERT INTO inventory.quantity_publication_attempts(id,state) VALUES(1,'running')");
    await database.pool.query(`INSERT INTO channels.channel_variant_availability_attempts
      (attempt_id,channel_id,product_variant_id,revision,lease_token,desired_active,request_kind,source_mapping)
      VALUES(1,1,1,1,$1,true,'catalog_activation',$2::jsonb)`, [lease,JSON.stringify(context.mappingSnapshot)]);
    await enqueueVariantAvailabilitySync(pool(),{ channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    await database.pool.query("UPDATE inventory.quantity_publication_attempts SET state='not_sent',resolution_basis='owner_preflight_no_request' WHERE id=1");
    await database.pool.query(`CREATE FUNCTION channels.reject_final_decision_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.disposition='provider_attempt_final' THEN RAISE EXCEPTION 'simulated decision failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_final_decision_test BEFORE INSERT ON channels.channel_variant_availability_decisions
      FOR EACH ROW EXECUTE FUNCTION channels.reject_final_decision_test()`);
    try {
      await expect(claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).rejects.toThrow("simulated decision failure");
      expect((await database.pool.query("SELECT status,revision,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "needs_review",revision: "1",lease_token: null });
      expect((await database.pool.query("SELECT request_kind FROM channels.channel_variant_availability_followups")).rows)
        .toEqual([{ request_kind: "stock_repair" }]);
    } finally {
      await database.pool.query("DROP TRIGGER reject_final_decision_test ON channels.channel_variant_availability_decisions; DROP FUNCTION channels.reject_final_decision_test()");
    }
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toHaveLength(1);
  });
  it("retains a confirmed response when local projection fails and does not retry the provider", async () => {
    const response = { quantity: 17,feedActive: true,externalProductId: "listing-old",externalVariantId: "offer-old",
      externalInventoryItemId: null,externalSku: "EXAMPLE" };
    const editor = await database.pool.connect();
    try {
      await editor.query("BEGIN");
      await editor.query("UPDATE catalog.product_variants SET sku='being-edited' WHERE id=1");
      await expect(completeSavedAvailability(pool(),claim,response,context.mappingSnapshot)).rejects.toMatchObject({ code: "55P03" });
      expect(await retainVariantAvailabilityAcknowledgement(pool(),claim,response,context.mappingSnapshot)).toBe("needs_review");
      expect((await database.pool.query("SELECT status,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "needs_review",lease_token: null });
      expect((await database.pool.query("SELECT disposition,before_state FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1")).rows)
        .toMatchObject([{ disposition: "provider_acknowledged_projection_failed",before_state: { acknowledgedResult: response } }]);
      expect(await retainVariantAvailabilityAcknowledgement(pool(),claim,response,context.mappingSnapshot)).toBe("needs_review");
      expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 10,leaseSeconds: 60 })).toEqual([]);
    } finally { await editor.query("ROLLBACK"); editor.release(); }
  });
  it("rechecks inventory eligibility before completing a no-publication decision", async () => {
    // The worker saw an unmanaged variant, but it became managed before completion.
    await database.pool.query("UPDATE catalog.product_variants SET requires_shipping=false WHERE id=1");
    await database.pool.query("UPDATE catalog.product_variants SET requires_shipping=true WHERE id=1");
    await expect(markVariantAvailabilityNotApplicable(pool(), claim)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CATALOG_CHANGED" });
    expect((await database.pool.query("SELECT status,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "processing",lease_token: lease });
    expect((await database.pool.query("SELECT is_active,last_synced_qty FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0])
      .toEqual({ is_active: 1,last_synced_qty: null });
    await database.pool.query("UPDATE catalog.product_variants SET requires_shipping=false WHERE id=1");
    expect(await markVariantAvailabilityNotApplicable(pool(), claim)).toBe(true);
    expect((await database.pool.query("SELECT is_active,last_synced_qty FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0])
      .toEqual({ is_active: 0,last_synced_qty: null });
    expect(await markVariantAvailabilityNotApplicable(pool(), claim)).toBe(false);
  });
  it("does not complete no-publication work after its lease expired", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET requires_shipping=false WHERE id=1");
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE product_variant_id=1");
    await expect(markVariantAvailabilityNotApplicable(pool(), claim)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CLAIM_CHANGED" });
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0]).toEqual({ status: "processing" });
    expect((await database.pool.query("SELECT is_active FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0]).toEqual({ is_active: 1 });
  });
  it("holds the exact claim and catalog state until the owning publication transaction commits", async () => {
    const owner = await database.pool.connect();
    const contender = await database.pool.connect();
    try {
      await owner.query("BEGIN");
      await availabilityClaimPublicationGuard(claim, context)(owner);
      await contender.query("BEGIN");
      await contender.query("SET LOCAL lock_timeout='100ms'");
      await expect(contender.query("UPDATE channels.channel_variant_availability_sync SET lease_token='123e4567-e89b-42d3-a456-426614174001' WHERE product_variant_id=1"))
        .rejects.toMatchObject({ code: "55P03" });
      await contender.query("ROLLBACK");
      await owner.query("COMMIT");
      await contender.query("UPDATE channels.channel_variant_availability_sync SET lease_token='123e4567-e89b-42d3-a456-426614174001' WHERE product_variant_id=1");
      await owner.query("BEGIN");
      await expect(availabilityClaimPublicationGuard(claim, context)(owner)).rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CLAIM_CHANGED" });
      await owner.query("ROLLBACK");
    } finally {
      await owner.query("ROLLBACK").catch(() => undefined);
      await contender.query("ROLLBACK").catch(() => undefined);
      owner.release(); contender.release();
    }
  });
  it("preserves an in-flight request through archive and reactivation, then promotes the newer request exactly once", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await database.pool.query("INSERT INTO channels.channel_listings(channel_id,product_variant_id) VALUES(1,2)");
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_sync WHERE product_variant_id=2")).rowCount).toBe(0);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=1");
    expect((await database.pool.query("SELECT status,revision,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "processing",revision: "1",lease_token: lease });
    expect((await database.pool.query("SELECT desired_active FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ desired_active: true }]);

    const result = { quantity: 17,feedActive: true,externalProductId: "listing-a",externalVariantId: "offer-a",
      externalInventoryItemId: null,externalSku: "EXAMPLE" };
    expect(await markVariantAvailabilitySynced(pool(),claim,result)).toBe(true);
    expect((await database.pool.query("SELECT status,revision,desired_active,last_synced_quantity,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2",desired_active: true,last_synced_quantity: 17,lease_token: null });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups")).rowCount).toBe(0);
    expect(await completeSavedAvailability(pool(),claim,result,context.mappingSnapshot)).toBe("synced");
  });
  it("rolls back the mapping projection when completing the claim fails", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query(`CREATE FUNCTION channels.reject_completion_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='pending' THEN RAISE EXCEPTION 'completion failed'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_completion_test BEFORE UPDATE ON channels.channel_variant_availability_sync
      FOR EACH ROW EXECUTE FUNCTION channels.reject_completion_test();`);
    try {
      await expect(markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
        externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).rejects.toThrow("completion failed");
      expect((await database.pool.query("SELECT status,revision,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "processing",revision: "1",lease_token: lease });
      expect((await database.pool.query("SELECT channel_variant_id,last_synced_qty FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0])
        .toEqual({ channel_variant_id: null,last_synced_qty: null });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_listings WHERE product_variant_id=1")).rowCount).toBe(0);
      expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(1);
    } finally {
      await database.pool.query("DROP TRIGGER reject_completion_test ON channels.channel_variant_availability_sync; DROP FUNCTION channels.reject_completion_test()");
    }
  });
  it("does not reactivate a local feed when an older provider acknowledgement arrives after archive", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT is_active,last_synced_qty,channel_variant_id,channel_inventory_item_id,channel_sku FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0])
      .toEqual({ is_active: 0,last_synced_qty: 17,channel_variant_id: null,channel_inventory_item_id: null,channel_sku: "EXAMPLE" });
    expect((await database.pool.query("SELECT external_variant_id FROM channels.channel_listings WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("does not run a queued reactivation after the variant is archived again", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "synced",desired_active: true });
    expect((await database.pool.query("SELECT is_active FROM channels.channel_feeds WHERE product_variant_id=1")).rows[0]).toEqual({ is_active: 0 });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("retains an independently requested zero repair after archive and preserves immutable follow-up history", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,revision: "2" });
    const events = (await database.pool.query(`SELECT operation,reason,before_state,after_state
      FROM channels.channel_variant_availability_followup_events WHERE product_variant_id=1 ORDER BY id DESC LIMIT 2`)).rows;
    expect(events).toMatchObject([
      { operation: "DELETE",reason: "promoted",before_state: { desired_active: false },after_state: null },
      { operation: "INSERT",reason: "requested",before_state: null,after_state: { desired_active: false } },
    ]);
    await expect(database.pool.query("DELETE FROM channels.channel_variant_availability_followup_events")).rejects.toMatchObject({ code: "55000" });
    await expect(database.pool.query("TRUNCATE channels.channel_variant_availability_followup_events")).rejects.toMatchObject({ code: "55000" });
  });
  it("retains stock repair ahead of a later reactivation instead of replacing it", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 ORDER BY id")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" },{ desired_active: true,request_kind: "catalog_activation" }]);
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,request_kind: "stock_repair" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 ORDER BY id")).rows)
      .toEqual([{ desired_active: true,request_kind: "catalog_activation" }]);
    const [repairClaim]=await claimVariantAvailabilitySyncs(pool(), { batchSize: 1,leaseSeconds: 60 });
    expect(repairClaim).toMatchObject({ desiredActive: false,requestKind: "stock_repair",revision: 2 });
    expect(await markVariantAvailabilitySynced(pool(),repairClaim,{ quantity: 0,feedActive: false,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,revision,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "3",desired_active: true,request_kind: "catalog_activation" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("keeps an older worker's saved repair ahead of a newer request after completion", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET status='synced',lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1");
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 ORDER BY id")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" },{ desired_active: true,request_kind: "catalog_activation" }]);
    await database.pool.query("SELECT channels.promote_completed_availability_followups(1,transaction_timestamp())");
    expect((await database.pool.query("SELECT status,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,request_kind: "stock_repair" });
  });
  it("retains a new request behind an older completed row whose claim history is unverified", async () => {
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET status='synced',enqueued_revision=NULL,
      lease_token=NULL,lease_expires_at=NULL,completed_at=transaction_timestamp() WHERE product_variant_id=1`);
    await enqueueVariantAvailabilitySync(pool(),{ channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    expect(await claimVariantAvailabilitySyncs(pool(),{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review",revision: "1" });
    expect((await database.pool.query("SELECT request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ request_kind: "stock_repair" }]);
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1")).rows)
      .toEqual([{ disposition: "legacy_attempt_history_unverified" }]);
  });
  it("discards an archived activation without discarding a later stock repair", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,request_kind: "stock_repair" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups ORDER BY id")).rows)
      .toEqual([{ desired_active: true,request_kind: "catalog_activation" }]);
    expect((await database.pool.query("SELECT reason,before_state->>'request_kind' AS kind FROM channels.channel_variant_availability_followup_events WHERE operation='DELETE' ORDER BY id DESC LIMIT 2")).rows)
      .toEqual([{ reason: "promoted",kind: "stock_repair" },{ reason: "archived_before_dispatch",kind: "catalog_activation" }]);
  });
  it("bounds a large archived backlog and still promotes the later repair", async () => {
    await database.pool.query(`UPDATE catalog.product_variants SET is_active=false WHERE id=1;
      INSERT INTO channels.channel_variant_availability_followups(channel_id,product_variant_id,desired_active,request_kind)
        SELECT 1,1,true,'catalog_activation' FROM generate_series(1,1001);
      INSERT INTO channels.channel_variant_availability_followups(channel_id,product_variant_id,desired_active,request_kind)
        VALUES(1,1,false,'stock_repair');`);
    expect(await markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
      externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).toBe(true);
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "synced" });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows[0].n).toBe(2);
    expect((await database.pool.query<{n:number}>("SELECT channels.promote_completed_availability_followups(1,transaction_timestamp()) AS n")).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT status,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",request_kind: "stock_repair" });
  });
  it("coalesces only adjacent identical follow-ups", async () => {
    for (const desiredActive of [false,false,true,true,false]) {
      await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive,
        requestKind: desiredActive ? "catalog_activation" : "stock_repair" });
    }
    expect((await database.pool.query("SELECT request_kind FROM channels.channel_variant_availability_followups ORDER BY id")).rows)
      .toEqual([{ request_kind: "stock_repair" },{ request_kind: "catalog_activation" },{ request_kind: "stock_repair" }]);
  });
  it("can use the actual variant indexes for Catalog exposure checks", async () => {
    const client=await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan=off");
      const queuePlan=await client.query<{"QUERY PLAN":string}>("EXPLAIN (COSTS OFF) SELECT 1 FROM channels.channel_variant_availability_sync WHERE product_variant_id=1");
      const followupPlan=await client.query<{"QUERY PLAN":string}>("EXPLAIN (COSTS OFF) SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1 AND desired_active");
      const reviewPlan=await client.query<{"QUERY PLAN":string}>("EXPLAIN (COSTS OFF) SELECT 1 FROM channels.channel_variant_availability_sync WHERE status='needs_review' ORDER BY next_attempt_at,updated_at,channel_id,product_variant_id LIMIT 1");
      const decisionPlan=await client.query<{"QUERY PLAN":string}>("EXPLAIN (COSTS OFF) SELECT 1 FROM channels.channel_variant_availability_decisions WHERE channel_id=1 AND product_variant_id=1 AND revision=1 ORDER BY id DESC LIMIT 1");
      expect(queuePlan.rows.map(row => row["QUERY PLAN"]).join("\n")).toContain("channel_variant_availability_sync_variant_idx");
      expect(followupPlan.rows.map(row => row["QUERY PLAN"]).join("\n")).toContain("channel_variant_availability_followups_active_variant_idx");
      expect(reviewPlan.rows.map(row => row["QUERY PLAN"]).join("\n")).toContain("channel_variant_availability_review_idx");
      expect(decisionPlan.rows.map(row => row["QUERY PLAN"]).join("\n")).toContain("channel_variant_availability_decisions_claim_idx");
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });
  it("blocks an internal-only transition while a queued activation remains", async () => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET desired_active=false,request_kind='stock_repair' WHERE product_variant_id=1");
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await expect(database.pool.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1"))
      .rejects.toMatchObject({ code: "23514",constraint: "internal_only_variant_has_customer_exposure" });
    expect((await database.pool.query("SELECT sales_eligibility FROM catalog.product_variants WHERE id=1")).rows[0])
      .toEqual({ sales_eligibility: "sellable" });
  });
  it.each(["processing", "needs_review"])("blocks an internal-only transition for unconfirmed %s legacy work even when the latest value is zero", async status => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET desired_active=false,request_kind=NULL,
      enqueued_revision=NULL,status=$1::varchar,lease_token=CASE WHEN $1::varchar='processing' THEN $2::uuid ELSE NULL END,
      lease_expires_at=CASE WHEN $1::varchar='processing' THEN transaction_timestamp()+interval '1 minute' ELSE NULL END WHERE product_variant_id=1`, [status,lease]);
    await expect(database.pool.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1"))
      .rejects.toMatchObject({ code: "23514",constraint: "internal_only_variant_has_customer_exposure" });
  });
  it("does not treat a proven-unsent cancellation as active exposure", async () => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET status='cancelled',
      lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1`);
    await database.pool.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1");
    expect((await database.pool.query("SELECT sales_eligibility FROM catalog.product_variants WHERE id=1")).rows[0])
      .toEqual({ sales_eligibility: "internal_only" });
  });
  it("serializes a queued activation against a concurrent internal-only transition", async () => {
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE product_variant_id=1");
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET desired_active=false,request_kind='stock_repair' WHERE product_variant_id=1");
    const editor=await database.pool.connect(), requester=await database.pool.connect();
    try {
      const requesterPid=(await requester.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await editor.query("BEGIN");
      await editor.query("UPDATE catalog.product_variants SET sales_eligibility='internal_only' WHERE id=1");
      const requested=requester.query("SELECT channels.request_variant_availability_refresh(1,1,true,'catalog_activation')")
        .then(() => null, error => error);
      let blocked=false;
      for (let i=0;i<100;i++) {
        if ((await editor.query<{blocked:boolean}>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",[requesterPid])).rows[0].blocked) {
          blocked=true; break;
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay,10));
      }
      expect(blocked).toBe(true);
      await editor.query("COMMIT");
      expect(await requested).toMatchObject({ code: "23514",constraint: "customer_sellable_variant_required" });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
    } finally { await editor.query("ROLLBACK").catch(() => undefined); editor.release(); requester.release(); }
  });
  it("serializes simultaneous completion and a new request without losing either intent", async () => {
    const blocker = await database.pool.connect(), completing = await database.pool.connect(), requesting = await database.pool.connect();
    try {
      const completionPid = (await completing.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const requestPid = (await requesting.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM channels.channel_variant_availability_sync WHERE channel_id=1 AND product_variant_id=1 FOR UPDATE");
      const completion = completing.query<{ completed: boolean }>(
        "SELECT channels.complete_variant_availability_claim(1,1,1,$1,true,17,transaction_timestamp()) AS completed", [lease]);
      const request = requesting.query("SELECT channels.request_variant_availability_refresh(1,1,true,'catalog_activation')");
      let bothBlocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = (await blocker.query<{ first: boolean; second: boolean }>(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS first,cardinality(pg_blocking_pids($2))>0 AS second",
          [completionPid,requestPid])).rows[0];
        if (waiting.first && waiting.second) { bothBlocked = true; break; }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
      expect(bothBlocked).toBe(true);
      await blocker.query("COMMIT");
      expect((await completion).rows[0].completed).toBe(true);
      await request;
      expect((await database.pool.query("SELECT status,revision,desired_active,last_synced_quantity FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "pending",revision: "2",desired_active: true,last_synced_quantity: 17 });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups")).rowCount).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release(); completing.release(); requesting.release();
    }
  });
  it("does not wait or project a stale acknowledgement while the catalog variant is changing", async () => {
    const editor = await database.pool.connect();
    try {
      await editor.query("BEGIN");
      await editor.query("SELECT id FROM catalog.product_variants WHERE id=1 FOR UPDATE");
      await expect(markVariantAvailabilitySynced(pool(),claim,{ quantity: 17,feedActive: true,externalProductId: "listing-a",
        externalVariantId: "offer-a",externalInventoryItemId: null,externalSku: "EXAMPLE" })).rejects.toMatchObject({ code: "55P03" });
      expect((await database.pool.query("SELECT status,revision,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
        .toEqual({ status: "processing",revision: "1",lease_token: lease });
      expect((await database.pool.query("SELECT 1 FROM channels.channel_listings WHERE product_variant_id=1")).rowCount).toBe(0);
    } finally {
      await editor.query("ROLLBACK"); editor.release();
    }
  });
  it("allows exactly one concurrent completion of the same lease", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    const results = await Promise.all([1,2].map(() => database.pool.query<{ completed: boolean }>(
      "SELECT channels.complete_variant_availability_claim(1,1,1,$1,false,NULL,transaction_timestamp()) AS completed", [lease])));
    expect(results.map(result => result.rows[0].completed).sort()).toEqual([false,true]);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups")).rowCount).toBe(0);
  });
  it("preserves a newer queued decision when an older worker replans", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await supersedeAvailabilityClaim(pool(),claim,true);
    expect((await database.pool.query("SELECT status,revision,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2",desired_active: false });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups ORDER BY id")).rows)
      .toEqual([{ desired_active: true,request_kind: "catalog_activation" }]);
    await expect(supersedeAvailabilityClaim(pool(),claim,true)).rejects.toThrow("lost its lease or revision");
  });
  it("retains a legacy request for review rather than creating a new zero when archived", async () => {
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET enqueued_revision=NULL,request_kind=NULL WHERE product_variant_id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,desired_active,lease_token,last_error FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toMatchObject({ status: "needs_review",desired_active: true,lease_token: null });
    expect((await database.pool.query("SELECT disposition,before_state,after_state FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0])
      .toMatchObject({ disposition: "prior_work_unconfirmed",before_state: { status: "processing" },after_state: { status: "needs_review" } });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=1");
    expect((await database.pool.query("SELECT status,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review",desired_active: true });
    expect((await database.pool.query("SELECT desired_active FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ desired_active: true }]);
    await expect(database.pool.query("DELETE FROM channels.channel_variant_availability_decisions")).rejects.toMatchObject({ code: "55000" });
  });
  it("keeps a newer stock repair behind an unconfirmed legacy request", async () => {
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET enqueued_revision=NULL,request_kind=NULL WHERE product_variant_id=1");
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review",revision: "1" });
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" }]);
  });
  it("rejects a replan if catalog state changed after the worker's read", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await expect(supersedeAvailabilityClaim(pool(),claim,true)).rejects.toMatchObject({ code: "40001" });
    expect((await database.pool.query("SELECT status,lease_token FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "processing",lease_token: lease });
  });
  it("does not attribute an older writer's replacement to a recorded request kind", async () => {
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync
      SET desired_active=false,request_kind='stock_repair',enqueued_revision=1,revision=2,status='pending',
        attempt_count=0,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=transaction_timestamp() WHERE product_variant_id=1`);
    expect(await claimVariantAvailabilitySyncs(pool(), { batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review" });
    expect((await database.pool.query("SELECT disposition,lease_token FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0])
      .toEqual({ disposition: "legacy_attempt_history_unverified",lease_token: null });
  });
  it("cancels only a proven first unsent claim when archive supersedes it", async () => {
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET attempt_count=1,enqueued_revision=revision WHERE product_variant_id=1");
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "cancelled",desired_active: true });
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0])
      .toEqual({ disposition: "cancelled_before_dispatch" });
  });
  it("does not cancel an older worker's first claim when its claim receipt is missing", async () => {
    await database.pool.query(`ALTER TABLE channels.channel_variant_availability_claims DISABLE TRIGGER channel_variant_availability_claims_immutable;
      DELETE FROM channels.channel_variant_availability_claims WHERE channel_id=1 AND product_variant_id=1;
      ALTER TABLE channels.channel_variant_availability_claims ENABLE TRIGGER channel_variant_availability_claims_immutable`);
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    expect(await supersedeAvailabilityClaim(pool(),claim,false)).toBe("needs_review");
    expect((await database.pool.query("SELECT status FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "needs_review" });
  });
  it("retains an earlier requested zero repair when the catalog is archived during a claim", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: false,requestKind: "stock_repair" });
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=1");
    await supersedeAvailabilityClaim(pool(),claim,false);
    expect((await database.pool.query("SELECT status,desired_active,revision,request_kind FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",desired_active: false,revision: "2",request_kind: "stock_repair" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=1")).rowCount).toBe(0);
  });
  it("coalesces feed and listing inserts in one transaction without a duplicate follow-up", async () => {
    await database.pool.query(`INSERT INTO catalog.product_variants VALUES(3,1,true);
      BEGIN;
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id) VALUES(1,3);
      INSERT INTO channels.channel_listings(channel_id,product_variant_id) VALUES(1,3);
      COMMIT;`);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=3")).rows[0])
      .toEqual({ status: "pending",revision: "1" });
    expect((await database.pool.query("SELECT 1 FROM channels.channel_variant_availability_followups WHERE product_variant_id=3")).rowCount).toBe(0);
  });
  it("does not create a legacy eBay queue entry for another provider or an archived parent", async () => {
    await database.pool.query(`INSERT INTO channels.channels(id,provider) VALUES(2,'shopify');
      INSERT INTO catalog.products VALUES(2,false,'archived');
      INSERT INTO catalog.product_variants VALUES(3,1,true),(4,2,true);
      INSERT INTO channels.channel_listings(channel_id,product_variant_id) VALUES(2,3),(1,4);`);
    expect((await database.pool.query("SELECT channel_id,product_variant_id FROM channels.channel_variant_availability_sync ORDER BY product_variant_id")).rows)
      .toEqual([{ channel_id: 1,product_variant_id: 1 }]);
  });
  it("recovers a follow-up after an older worker completes without promoting it", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query(`UPDATE channels.channel_variant_availability_sync SET status='synced',
      lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1`);
    const first = (await database.pool.query<{ n: number }>("SELECT channels.promote_completed_availability_followups(25,transaction_timestamp()) AS n")).rows[0].n;
    const second = (await database.pool.query<{ n: number }>("SELECT channels.promote_completed_availability_followups(25,transaction_timestamp()) AS n")).rows[0].n;
    expect([first,second]).toEqual([1,0]);
    expect((await database.pool.query("SELECT status,revision,desired_active FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "pending",revision: "2",desired_active: true });
  });
  it("does not promote an old-worker reactivation follow-up after a later archive", async () => {
    await enqueueVariantAvailabilitySync(pool(), { channelId: 1,productVariantId: 1,desiredActive: true,requestKind: "catalog_activation" });
    await database.pool.query(`UPDATE catalog.product_variants SET is_active=false WHERE id=1;
      UPDATE channels.channel_variant_availability_sync SET status='synced',lease_token=NULL,lease_expires_at=NULL WHERE product_variant_id=1`);
    expect((await database.pool.query<{ n: number }>("SELECT channels.promote_completed_availability_followups(25,transaction_timestamp()) AS n")).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT status,revision FROM channels.channel_variant_availability_sync WHERE product_variant_id=1")).rows[0])
      .toEqual({ status: "synced",revision: "1" });
    expect((await database.pool.query("SELECT operation,reason,before_state FROM channels.channel_variant_availability_followup_events WHERE product_variant_id=1 ORDER BY id DESC LIMIT 1")).rows[0])
      .toMatchObject({ operation: "DELETE",reason: "archived_before_dispatch",before_state: { desired_active: true } });
  });
});
