import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionLegacyChannelSeedSql, cutoverCompositionSeedSql,
  installCutoverCompositionMigrations } from "../fixtures/inventory-cutover-composition-database.fixture";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";
import { EbayAdapter } from "../../../channels/adapters/ebay.adapter";
import { PostgresQuantityProviderResponseRecovery } from "../../infrastructure/quantity-provider-response-recovery.repository";
import { QuantityPublicationAdmissionError, type PublicationTransactionGuard } from "../../publication-transaction-guard";
import { availabilityClaimPublicationGuard, claimVariantAvailabilitySyncs, markVariantAvailabilityFailed, markVariantAvailabilitySynced, supersedeAvailabilityClaim,
  type SqlPool, type VariantAvailabilityContext } from "../../../channels/variant-availability-sync.repository";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const daily = { errors: [{ errorId: 25001, category: "APPLICATION",
  message: "You have exceeded your maximum call limit of 250 for item per day. Try back after 1 day." }] };

dbDescribe.sequential("durable eBay terminal evidence with actual migration0663", () => {
  let database: InventoryCutoverTestDatabase; let sequence = 0;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl,disposable,cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    for (const migration of ["0709_walmart_quantity_admission.sql", "0716_inventory_publication_reconciliation.sql",
      "0729_ebay_listing_sync_recovery.sql", "0733_ebay_provider_response_finality.sql", "0734_ebay_operator_republication_recovery.sql",
      "0749_quantity_outbox_preflight_completion.sql", "900000008000018120001_ebay_automatic_sync_recovery.sql",
      "900000011000018230001_ebay_publication_preflight_recovery.sql"]) {
      await database.pool.query(readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"));
    }
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionLegacyChannelSeedSql);
  });
  afterAll(async () => { await database?.close(); });
  function setup(request: typeof fetch, pool: Pick<Pool,"connect"> = database.pool) {
    let timestamp = Date.parse("2026-09-08T20:00:00.000Z");
    const clock = () => new Date(timestamp);
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection", connectionId: 1,
      providerKey: "ebay", providerScopeType: "account", externalScopeId: `account-${++sequence}`, externalInventoryItemId: `EVIDENCE-${sequence}`,
      productId: 20, productVariantId: 101 };
    const admission = new PostgresQuantityPublicationAdmission(pool,clock);
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async () => ({ item: (_sku,work) => work(null),
        group: (_key,_members,work) => work(null),reducing: (_identity,work) => work() }),
    });
    const publish = (quantity = 4, guard?: PublicationTransactionGuard) => {
      const item = { product: { title: "Test",imageUrls: [] },condition: "NEW" as const,
        availability: { shipToLocationAvailability: { quantity } } };
      if (!guard) return admission.run(scope,() => api.createOrReplaceInventoryItem(scope.externalInventoryItemId,item),undefined,"sandbox");
      const guarded = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
        request,now: clock,quantityAdmission: async owner => ({
          item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,owner,"sandbox"),
          group: () => { throw new Error("unexpected group request"); },
          reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],owner,"sandbox"),
        }),
      }).withPublicationGuard(guard);
      return guarded.createOrReplaceInventoryItem(scope.externalInventoryItemId,item);
    };
    const attempts = async () => (await database.pool.query(`SELECT id::text,state,resolution_basis,completed_at FROM inventory.quantity_publication_attempts
      WHERE scope->>'externalInventoryItemId'=$1 ORDER BY id`,[scope.externalInventoryItemId])).rows;
    return { scope,clock,admission,api,publish,attempts,advance: (ms: number) => { timestamp += ms; } };
  }

  it("runs the calling work owner's guard inside admission before any attempt or provider request", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const test = setup(request);
    const guard = vi.fn(async (client: { query: (sql: string) => Promise<unknown> }) => {
      await client.query("SELECT 1");
      throw new QuantityPublicationAdmissionError("TEST_CLAIM_CHANGED", "The work claim changed");
    });
    await expect(test.publish(4,guard)).rejects.toMatchObject({ code: "TEST_CLAIM_CHANGED" });
    expect(guard).toHaveBeenCalledOnce();
    expect(await test.attempts()).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    // A rejected scoped guard must not leak into the next independent call.
    await test.publish();
    expect(request).toHaveBeenCalledOnce();
    expect((await test.attempts())[0].state).toBe("succeeded");
  });

  it("does not allow a nested request to add a work owner after its provider admission", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const test = setup(request);
    const nested = vi.fn(async () => undefined);
    await expect(test.admission.run(test.scope, () => test.admission.run(test.scope, nested,async () => undefined),
      async () => undefined))
      .rejects.toMatchObject({ code: "PUBLICATION_NESTED_OWNER_MISMATCH" });
    expect(nested).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    // The outer callback did not provide a no-send journal contract, so its
    // durable admission remains conservatively unresolved.
    expect((await test.attempts())[0]).toMatchObject({ state: "uncertain" });
  });

  it("recovers a final partial bulk response without pretending its quantity was delivered", async () => {
    const request=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({responses:[
      {sku:test.scope.externalInventoryItemId,statusCode:200},
      {sku:test.scope.externalInventoryItemId,offerId:"offer-1",statusCode:400,
        errors:[{errorId:25004,category:"REQUEST",message:"Invalid quantity"}]},
    ]}),{status:207}));
    const test=setup(request);
    await expect(test.admission.run(test.scope,()=>test.api.bulkUpdatePriceQuantity({requests:[{
      sku:test.scope.externalInventoryItemId,shipToLocationAvailability:{quantity:4},offers:[{offerId:"offer-1",availableQuantity:4}],
    }]}))).rejects.toMatchObject({code:"EBAY_QUANTITY_RESPONSE_UNCERTAIN"});
    const original=(await test.attempts())[0];
    expect(original.state).toBe("uncertain");
    const recorded=(await database.pool.query("SELECT r.* FROM inventory.quantity_provider_request_results r JOIN inventory.quantity_provider_requests q ON q.id=r.request_id WHERE q.attempt_id=$1",[original.id])).rows[0];
    expect(recorded).toMatchObject({outcome:"uncertain",http_status:207,request_terminated:true,error_codes:["25004"]});
    expect(await new PostgresQuantityProviderResponseRecovery(database.pool,test.clock).reconcile([test.scope]))
      .toEqual({resolved:[original.id],unresolved:[],busy:false});
    expect((await test.attempts())[0]).toMatchObject({state:"resolved",resolution_basis:"provider_response_terminal"});
    expect((await database.pool.query("SELECT r.* FROM inventory.quantity_provider_request_results r JOIN inventory.quantity_provider_requests q ON q.id=r.request_id WHERE q.attempt_id=$1",[original.id])).rows[0]).toEqual(recorded);
    request.mockImplementation(async()=>new Response(null,{status:204}));
    await test.publish(23);
    expect(JSON.parse(String(request.mock.calls.at(-1)![1]!.body)).availability.shipToLocationAvailability.quantity).toBe(23);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("records a terminal rejection and durable cooldown; restart and new events cannot bypass it", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(daily),{ status: 400,headers: { "x-ebay-c-request-id": "receipt-1" } }));
    const test = setup(request);
    await expect(test.publish()).rejects.toMatchObject({ code: "EBAY_QUANTITY_DAILY_LIMIT" });
    const attempt = (await test.attempts())[0];
    expect(attempt).toMatchObject({ state: "rejected",resolution_basis: "provider_rejection",completed_at: test.clock() });
    const evidence = (await database.pool.query(`SELECT q.method,q.path,q.request_hash,r.* FROM inventory.quantity_provider_requests q
      JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id WHERE q.attempt_id=$1`,[attempt.id])).rows;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ method: "PUT",outcome: "rejected",http_status: 400,provider_request_id: "receipt-1",
      retry_not_before: new Date("2026-09-09T20:00:00.000Z") });
    const restarted = new PostgresQuantityPublicationAdmission(database.pool,test.clock);
    const forbidden = vi.fn();
    await expect(restarted.run(test.scope,forbidden)).rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    // This is the SAME physical provider item through another destination/connection.
    await expect(restarted.run({ ...test.scope,connectionId: 2,destinationKind: "dropship_store_connection" },forbidden))
      .rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    expect(forbidden).not.toHaveBeenCalled();
    expect((await restarted.listDue(100)).filter(row => row.scope.externalInventoryItemId===test.scope.externalInventoryItemId)).toEqual([]);
    expect(await test.attempts()).toHaveLength(1);
    expect(request).toHaveBeenCalledOnce();

    test.advance(24*60*60*1000);
    const due = (await restarted.listDue(100)).find(row => row.scope.externalInventoryItemId===test.scope.externalInventoryItemId && row.scope.connectionId===1)!;
    expect(due).toBeDefined();
    expect(await restarted.complete(due)).toBe(false); // Rejection is not delivery.
    request.mockImplementation(async () => new Response(null,{ status: 204 }));
    await test.publish(17);
    expect(JSON.parse(String(request.mock.calls.at(-1)![1]!.body)).availability.shipToLocationAvailability.quantity).toBe(17);
    expect(await restarted.complete(due)).toBe(true);
    expect((await test.attempts()).map(row => row.state)).toEqual(["rejected","succeeded"]);
  });

  it("records 429 retry-after beyond the worker interval without another HTTP call", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("{}",{ status: 429,headers: { "Retry-After": "172800" } }));
    const test = setup(request);
    await expect(test.publish()).rejects.toMatchObject({ code: "EBAY_PROVIDER_RATE_LIMITED" });
    const forbidden = vi.fn();
    await expect(test.admission.run({ ...test.scope,externalInventoryItemId: "OTHER-SKU" },forbidden))
      .rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    expect(forbidden).not.toHaveBeenCalled();
    test.advance(24*60*60*1000);
    await expect(test.publish()).rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([408,500,503])("preserves uncertainty for HTTP %s, with no automatic resend", async status => {
    const request = vi.fn<typeof fetch>(async () => new Response("{}",{ status })); const test = setup(request);
    await expect(test.publish()).rejects.toMatchObject({ code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN" });
    expect((await test.attempts())[0]).toMatchObject({ state: "uncertain",completed_at: null });
    test.advance(3*24*60*60*1000);
    await expect(test.publish()).rejects.toMatchObject({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("leaves missing terminal persistence unresolved, and records no false rejection", async () => {
    let injected = false;
    const pool = { connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client,{ get(target,property) {
        if (property==="query") return async (sql: string,args?: unknown[]) => {
          if (!injected && sql.includes("INSERT INTO inventory.quantity_provider_request_results")) {
            injected=true; throw new Error("simulated lost response persistence");
          }
          return client.query(sql,args);
        };
        const value=Reflect.get(target,property); return typeof value==="function" ? value.bind(target) : value;
      } });
    } };
    const test=setup(async () => new Response(JSON.stringify(daily),{ status: 400 }),pool);
    await expect(test.publish()).rejects.toThrow("simulated lost response persistence");
    const attempt=(await test.attempts())[0]; expect(attempt.state).toBe("uncertain");
    const rows=(await database.pool.query(`SELECT r.request_id FROM inventory.quantity_provider_requests q
      LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id WHERE q.attempt_id=$1`,[attempt.id])).rows;
    expect(rows).toEqual([{ request_id: null }]);
  });

  it("keeps a lost owner acknowledgement running even when the rejected response and cooldown were saved", async () => {
    let injected=false;
    const pool={ connect: async () => {
      const client=await database.pool.connect();
      return new Proxy(client,{ get(target,property) {
        if (property==="query") return async (sql: string,args?: unknown[]) => {
          if (!injected && sql.includes("SET state=$4") && args?.[3]==="rejected") { injected=true; throw new Error("lost owner acknowledgement"); }
          return client.query(sql,args);
        };
        const value=Reflect.get(target,property); return typeof value==="function" ? value.bind(target) : value;
      } });
    } };
    const test=setup(async () => new Response(JSON.stringify(daily),{ status: 400 }),pool);
    await expect(test.publish()).rejects.toThrow("lost owner acknowledgement");
    expect((await test.attempts())[0].state).toBe("running");
    const rows=(await database.pool.query(`SELECT retry_not_before FROM inventory.quantity_publication_cooldowns
      WHERE external_inventory_item_id=$1`,[test.scope.externalInventoryItemId])).rows;
    expect(rows).toEqual([{ retry_not_before: new Date("2026-09-09T20:00:00.000Z") }]);
  });

  it("keeps exact-scope locks during HTTP without an open database transaction", async () => {
    let entered!: () => void; let release!: () => void;
    const gate=new Promise<void>(resolve => { release=resolve; });
    const started=new Promise<void>(resolve => { entered=resolve; });
    const test=setup(async () => { entered(); await gate; return new Response(JSON.stringify(daily),{ status: 400 }); });
    const first=expect(test.publish()).rejects.toMatchObject({ code: "EBAY_QUANTITY_DAILY_LIMIT" });
    await started;
    try {
      const transactions=(await database.pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction'`)).rows[0].count;
      expect(transactions).toBe(0);
      await expect(new PostgresQuantityPublicationAdmission(database.pool,test.clock).run(test.scope,vi.fn()))
        .rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
    } finally { release(); await first; }
  });

  it("enforces immutable evidence and prevents rejection without a complete request history", async () => {
    const test=setup(async () => new Response(JSON.stringify(daily),{ status: 400 }));
    await expect(test.publish()).rejects.toThrow();
    const attempt=(await test.attempts())[0];
    await expect(database.pool.query("DELETE FROM inventory.quantity_provider_requests WHERE attempt_id=$1",[attempt.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(`UPDATE inventory.quantity_provider_request_results SET outcome='completed'
      WHERE request_id IN (SELECT id FROM inventory.quantity_provider_requests WHERE attempt_id=$1)`,[attempt.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("UPDATE inventory.quantity_publication_attempts SET state='uncertain',completed_at=NULL WHERE id=$1",[attempt.id]))
      .rejects.toMatchObject({ code: "23514" });
    const uncertain=setup(async () => { throw new Error("unknown transport result"); });
    await expect(uncertain.publish()).rejects.toThrow();
    await expect(database.pool.query(`UPDATE inventory.quantity_publication_attempts SET state='rejected',completed_at=$2,
      resolution_basis='provider_rejection' WHERE id=$1`,[(await uncertain.attempts())[0].id,uncertain.clock()]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("binds the real availability claim to provider admission before HTTP and preserves the exact attempt", async () => {
    let releaseRequest!: () => void; let requestEntered!: () => void;
    const requestGate = new Promise<void>(resolve => { releaseRequest = resolve; });
    const requestStarted = new Promise<void>(resolve => { requestEntered = resolve; });
    const request = vi.fn<typeof fetch>(async () => { requestEntered(); await requestGate; return new Response(null, { status: 204 }); });
    const test = setup(request);
    // These are the same migration and actual queue indexes used by the owner;
    // unrelated channel tables are deliberately minimal in this fixture.
    await database.pool.query(`ALTER TABLE catalog.products ADD COLUMN status text DEFAULT 'active',ADD COLUMN ebay_listing_excluded boolean DEFAULT false;
      ALTER TABLE catalog.product_variants ADD COLUMN ebay_listing_excluded boolean DEFAULT false;
      CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer,is_listed integer);
      CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer,is_listed integer);
      CREATE TABLE channels.channel_feeds(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id integer,product_variant_id integer,channel_product_id text,channel_variant_id text,
        channel_inventory_item_id text,channel_sku text,is_active integer);
      CREATE TABLE channels.channel_listings(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id integer,product_variant_id integer,external_product_id text,external_variant_id text,external_sku text);`);
    await database.pool.query("INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,is_active) VALUES(1,101,$1,1)",
      [test.scope.externalInventoryItemId]);
    const base = readFileSync(resolve("migrations/0606_channel_variant_availability_sync.sql"), "utf8");
    const start = base.indexOf("CREATE TABLE IF NOT EXISTS channels.channel_variant_availability_sync");
    const end = base.indexOf("CREATE OR REPLACE FUNCTION channels.enqueue_variant_availability_sync()");
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    await database.pool.query(base.slice(start,end));
    const eligibility = readFileSync(resolve("migrations/0626_catalog_variant_sales_eligibility.sql"), "utf8");
    const first = eligibility.indexOf("CREATE OR REPLACE FUNCTION catalog.assert_customer_sellable_variant()");
    const last = eligibility.indexOf("CREATE OR REPLACE FUNCTION catalog.guard_internal_only_variant_transition()");
    expect(first).toBeGreaterThan(0); expect(last).toBeGreaterThan(first);
    await database.pool.query(eligibility.slice(first,last));
    await database.pool.query(readFileSync(resolve("migrations/900000056000020020001_channel_availability_archive_separation.sql"), "utf8"));
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [claim] = await claimVariantAvailabilitySyncs(database.pool as unknown as SqlPool, { batchSize: 1,leaseSeconds: 120 });
    expect(claim).toBeDefined();
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Legacy eBay",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: null,externalInventoryItemId: null,externalSku: test.scope.externalInventoryItemId,
      previousQuantity: null,mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,
        variantId: null,inventoryItemId: null,sku: test.scope.externalInventoryItemId },listing: null } };
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE channel_id=1 AND product_variant_id=101");
    const [current] = await claimVariantAvailabilitySyncs(database.pool as unknown as SqlPool,{ batchSize: 1,leaseSeconds: 120 });
    expect(current).toBeDefined();
    const replacement = current!.leaseToken;
    await expect(test.publish(4,availabilityClaimPublicationGuard(claim!,context)))
      .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CLAIM_CHANGED" });
    expect(await test.attempts()).toEqual([]);
    expect(request).not.toHaveBeenCalled();

    // Capacity rejection also creates durable catch-up. A stale claimant must
    // not be allowed to create that work before the normal admission guard.
    const bounded = new PostgresQuantityPublicationAdmission(database.pool,test.clock,randomUUID,1);
    let releaseOwner!: () => void; let ownerEntered!: () => void;
    const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
    const ownerStarted = new Promise<void>(resolve => { ownerEntered = resolve; });
    const firstOwner = bounded.run({ ...test.scope,externalInventoryItemId: "CAPACITY-OWNER" },async () => { ownerEntered(); await ownerGate; });
    await ownerStarted;
    try {
      await expect(bounded.run(test.scope,async () => undefined,availabilityClaimPublicationGuard(claim!,context)))
        .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CLAIM_CHANGED" });
      expect((await database.pool.query("SELECT 1 FROM inventory.quantity_publication_catchup WHERE scope->>'externalInventoryItemId'=$1",
        [test.scope.externalInventoryItemId])).rowCount).toBe(0);
    } finally { releaseOwner(); await firstOwner; }

    // A failed attempt-to-claim receipt rolls back admission before HTTP.
    await database.pool.query(`CREATE FUNCTION channels.reject_availability_attempt_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated receipt failure'; END $$;
      CREATE TRIGGER reject_availability_attempt_test BEFORE INSERT ON channels.channel_variant_availability_attempts
      FOR EACH ROW EXECUTE FUNCTION channels.reject_availability_attempt_test()`);
    try {
      await expect(test.publish(4,availabilityClaimPublicationGuard(current,context)))
        .rejects.toMatchObject({ code: "PUBLICATION_OWNER_EVIDENCE_FAILED",cause: { message: "simulated receipt failure" } });
      expect(await test.attempts()).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await database.pool.query("DROP TRIGGER reject_availability_attempt_test ON channels.channel_variant_availability_attempts; DROP FUNCTION channels.reject_availability_attempt_test()");
    }

    // Once HTTP has started, a changed mapping must not be overwritten by its
    // later acknowledgement. The exact original attempt stays available to recovery.
    const publishing = test.publish(4,availabilityClaimPublicationGuard(current,context));
    await requestStarted;
    try {
      await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='new-offer' WHERE channel_id=1 AND product_variant_id=101");
    } finally { releaseRequest(); }
    await publishing;
    const completion = await markVariantAvailabilitySynced(database.pool as unknown as SqlPool,current,
      { quantity: 4,feedActive: true,externalProductId: null,externalVariantId: "old-offer",
        externalInventoryItemId: null,externalSku: test.scope.externalInventoryItemId },context.mappingSnapshot);
    expect(completion).toBe("needs_review");
    expect((await database.pool.query("SELECT channel_variant_id FROM channels.channel_feeds WHERE channel_id=1 AND product_variant_id=101")).rows[0])
      .toEqual({ channel_variant_id: "new-offer" });
    const attempt = (await test.attempts())[0];
    expect(attempt.state).toBe("succeeded");
    expect(request).toHaveBeenCalledOnce();
    expect((await database.pool.query(`SELECT channel_id,product_variant_id,revision::text,lease_token::text,
      desired_active,request_kind,source_mapping,provider_environment FROM channels.channel_variant_availability_attempts WHERE attempt_id=$1`, [attempt.id])).rows)
      .toEqual([{ channel_id: 1,product_variant_id: 101,revision: String(current.revision),lease_token: replacement,
        desired_active: true,request_kind: "catalog_activation",source_mapping: context.mappingSnapshot,provider_environment: "sandbox" }]);
    await expect(database.pool.query("DELETE FROM channels.channel_variant_availability_attempts WHERE attempt_id=$1", [attempt.id]))
      .rejects.toMatchObject({ code: "55000" });
  });
});

dbDescribe.sequential("availability recovery with production provider-attempt evidence", () => {
  let database: InventoryCutoverTestDatabase;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl,disposable,cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    for (const migration of ["0709_walmart_quantity_admission.sql", "0716_inventory_publication_reconciliation.sql",
      "0729_ebay_listing_sync_recovery.sql", "0733_ebay_provider_response_finality.sql", "0734_ebay_operator_republication_recovery.sql",
      "0749_quantity_outbox_preflight_completion.sql", "900000008000018120001_ebay_automatic_sync_recovery.sql",
      "900000011000018230001_ebay_publication_preflight_recovery.sql"]) {
      await database.pool.query(readFileSync(resolve("migrations",migration),"utf8"));
    }
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionLegacyChannelSeedSql);
    await database.pool.query(`ALTER TABLE catalog.products ADD COLUMN status text DEFAULT 'active',ADD COLUMN ebay_listing_excluded boolean DEFAULT false;
      ALTER TABLE catalog.product_variants ADD COLUMN ebay_listing_excluded boolean DEFAULT false;
      CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer,is_listed integer);
      CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer,is_listed integer);
      CREATE TABLE channels.channel_feeds(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id integer,product_variant_id integer,channel_product_id text,channel_variant_id text,
        channel_inventory_item_id text,channel_sku text,is_active integer,last_synced_qty integer,last_synced_at timestamptz,updated_at timestamptz);
      CREATE TABLE channels.channel_listings(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        channel_id integer,product_variant_id integer,external_product_id text,external_variant_id text,external_sku text,
        last_synced_qty integer,last_synced_at timestamptz,updated_at timestamptz);
      INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,is_active) VALUES(1,101,'P5',1);`);
    const base = readFileSync(resolve("migrations/0606_channel_variant_availability_sync.sql"),"utf8");
    const start = base.indexOf("CREATE TABLE IF NOT EXISTS channels.channel_variant_availability_sync");
    const end = base.indexOf("CREATE OR REPLACE FUNCTION channels.enqueue_variant_availability_sync()");
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    await database.pool.query(base.slice(start,end));
    const eligibility = readFileSync(resolve("migrations/0626_catalog_variant_sales_eligibility.sql"),"utf8");
    const first = eligibility.indexOf("CREATE OR REPLACE FUNCTION catalog.assert_customer_sellable_variant()");
    const last = eligibility.indexOf("CREATE OR REPLACE FUNCTION catalog.guard_internal_only_variant_transition()");
    expect(first).toBeGreaterThan(0); expect(last).toBeGreaterThan(first);
    await database.pool.query(eligibility.slice(first,last));
    await database.pool.query(readFileSync(resolve("migrations/900000056000020020001_channel_availability_archive_separation.sql"),"utf8"));
  });
  afterEach(async () => { await database?.close(); });

  it("records the actual account scope and environment through the adapter and provider admission", async () => {
    const dbPool = database.pool as unknown as SqlPool;
    await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='offer-1' WHERE channel_id=1 AND product_variant_id=101");
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [claim] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Test",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: "offer-1",externalInventoryItemId: null,externalSku: "P5",previousQuantity: null,
      mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,variantId: "offer-1",inventoryItemId: null,sku: "P5" },listing: null } };
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection",connectionId: 1,providerKey: "ebay",
      providerScopeType: "account",externalScopeId: "verified-seller",externalInventoryItemId: "P5",productId: 20,productVariantId: 101 };
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ responses: [
      { sku: "P5",statusCode: 200 },{ sku: "P5",offerId: "offer-1",statusCode: 200 },
    ] }),{ status: 200 }));
    const clock = () => new Date("2026-09-08T20:00:00.000Z");
    const admission = new PostgresQuantityPublicationAdmission(database.pool,clock);
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async guard => ({
        item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,guard,"sandbox"),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],guard,"sandbox"),
      }),
    });
    const adapter = new EbayAdapter({} as never,{ resolve: vi.fn(async () => ({ byVariantId: new Map(),groupImageUrls: [] })) });
    vi.spyOn(adapter as any,"getApiClient").mockResolvedValue(api);
    vi.spyOn(adapter as any,"delay").mockResolvedValue(undefined);
    const result = await adapter.pushInventory(1,[{ variantId: 101,sku: "P5",externalVariantId: "offer-1",
      externalInventoryItemId: null,allocatedQty: 4 }],undefined,availabilityClaimPublicationGuard(claim!,context));
    expect(result).toEqual([{ variantId: 101,pushedQty: 4,status: "success" }]);
    expect((await database.pool.query(`SELECT p.state,p.scope,a.provider_environment FROM inventory.quantity_publication_attempts p
      JOIN channels.channel_variant_availability_attempts a ON a.attempt_id=p.id`)).rows)
      .toEqual([{ state: "succeeded",scope,provider_environment: "sandbox" }]);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["item", "connection"] as const)("refuses a different provider %s before retaining an attempt or sending", async mismatch => {
    const dbPool = database.pool as unknown as SqlPool;
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [claim] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    expect(claim).toBeDefined();
    if (mismatch === "connection") await database.pool.query(`INSERT INTO channels.channels(id,name,provider,status,sync_enabled,sync_mode)
      VALUES(2,'Other','ebay','active',true,'live'); INSERT INTO channels.channel_connections(id,channel_id) VALUES(2,2)`);
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Test",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: null,externalInventoryItemId: null,externalSku: "P5",previousQuantity: null,
      mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,variantId: null,inventoryItemId: null,sku: "P5" },listing: null } };
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection",connectionId: mismatch === "connection" ? 2 : 1,
      providerKey: "ebay",providerScopeType: "account",externalScopeId: "verified-seller",
      externalInventoryItemId: mismatch === "item" ? "OTHER" : "P5",productId: 20,productVariantId: 101 };
    const request = vi.fn<typeof fetch>(async () => new Response(null,{ status: 204 }));
    const clock = () => new Date("2026-09-08T20:00:00.000Z");
    const admission = new PostgresQuantityPublicationAdmission(database.pool,clock);
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async guard => ({
        item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,guard,"sandbox"),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],guard,"sandbox"),
      }),
    });
    const adapter = new EbayAdapter({} as never,{ resolve: vi.fn(async () => ({ byVariantId: new Map(),groupImageUrls: [] })) });
    vi.spyOn(adapter as any,"getApiClient").mockResolvedValue(api);
    await expect(adapter.pushInventory(1,[{ variantId: 101,sku: scope.externalInventoryItemId,externalVariantId: "offer-1",
      externalInventoryItemId: null,allocatedQty: 4 }],undefined,availabilityClaimPublicationGuard(claim!,context)))
      .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_SCOPE_CHANGED" });
    expect(request).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_publication_attempts")).rows[0].count).toBe(0);
  });

  it("does not admit a queue-owned callback without a complete mutation-journal contract", async () => {
    const dbPool = database.pool as unknown as SqlPool;
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [claim] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    expect(claim).toBeDefined();
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Test",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: null,externalInventoryItemId: null,externalSku: "P5",previousQuantity: null,
      mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,variantId: null,inventoryItemId: null,sku: "P5" },listing: null } };
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection",connectionId: 1,providerKey: "ebay",
      providerScopeType: "account",externalScopeId: "verified-seller",externalInventoryItemId: "P5",productId: 20,productVariantId: 101 };
    const callback = vi.fn(async () => undefined);
    const admission = new PostgresQuantityPublicationAdmission(database.pool,() => new Date("2026-09-08T20:00:00.000Z"));
    await expect(admission.run(scope,callback,availabilityClaimPublicationGuard(claim!,context),"sandbox"))
      .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_SCOPE_UNVERIFIED" });
    expect(callback).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_publication_attempts")).rows[0].count).toBe(0);
  });

  it("keeps a confirmed first item and an uncertain second item distinct in a legacy batch", async () => {
    await database.pool.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(102,20,'P25')");
    const failure = Object.assign(new Error("Provider connection ended after dispatch"),{ code: "PROVIDER_OUTCOME_UNCERTAIN" });
    const request = vi.fn<typeof fetch>(async (_url,init) => {
      const body = JSON.parse(String(init?.body));
      const sku = body.requests[0].sku as string;
      if (sku === "P25") throw failure;
      return new Response(JSON.stringify({ responses: [
        { sku,statusCode: 200 },{ sku,offerId: "offer-1",statusCode: 200 },
      ] }),{ status: 200 });
    });
    const clock = () => new Date("2026-09-08T20:00:00.000Z");
    const admission = new PostgresQuantityPublicationAdmission(database.pool,clock);
    const scope = (sku: string): QuantityPublicationScope => ({ destinationKind: "channel_connection",connectionId: 1,
      providerKey: "ebay",providerScopeType: "account",externalScopeId: "verified-seller",externalInventoryItemId: sku,
      productId: 20,productVariantId: sku === "P5" ? 101 : 102 });
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async guard => ({
        item: (sku,work) => admission.runListing(scope(sku),async () => { throw new Error("unexpected canonical plan"); },work,guard,"sandbox"),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (sku,work) => admission.runQuantityReducingLifecycle(scope(sku),work,[],guard,"sandbox"),
      }),
    });
    const adapter = new EbayAdapter({} as never,{ resolve: vi.fn(async () => ({ byVariantId: new Map(),groupImageUrls: [] })) });
    vi.spyOn(adapter as any,"getApiClient").mockResolvedValue(api);
    vi.spyOn(adapter as any,"delay").mockResolvedValue(undefined);
    expect(await adapter.pushInventory(1,[
      { variantId: 101,sku: "P5",externalVariantId: "offer-1",externalInventoryItemId: null,allocatedQty: 4 },
      { variantId: 102,sku: "P25",externalVariantId: "offer-2",externalInventoryItemId: null,allocatedQty: 8 },
    ])).toEqual([{ variantId: 101,pushedQty: 4,status: "success" },
      { variantId: 102,pushedQty: 0,status: "error",error: failure.message,errorCode: failure.code }]);
    expect((await database.pool.query(`SELECT p.scope->>'externalInventoryItemId' AS sku,p.state,r.outcome
      FROM inventory.quantity_publication_attempts p JOIN inventory.quantity_provider_requests q ON q.attempt_id=p.id
      JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id ORDER BY p.id`)).rows)
      .toEqual([{ sku: "P5",state: "succeeded",outcome: "completed" },{ sku: "P25",state: "uncertain",outcome: "uncertain" }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retains a transport failure and parks the original work without a guessed offer retry", async () => {
    const dbPool = database.pool as unknown as SqlPool;
    await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='offer-1' WHERE channel_id=1 AND product_variant_id=101");
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [claim] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    expect(claim).toBeDefined();
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Test",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: "offer-1",externalInventoryItemId: null,externalSku: "P5",previousQuantity: null,
      mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,variantId: "offer-1",inventoryItemId: null,sku: "P5" },listing: null } };
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection",connectionId: 1,providerKey: "ebay",
      providerScopeType: "account",externalScopeId: "verified-seller",externalInventoryItemId: "P5",productId: 20,productVariantId: 101 };
    const failure = new Error("Provider connection failed after the request started");
    const request = vi.fn<typeof fetch>(async () => { throw failure; });
    const clock = () => new Date("2026-09-08T20:00:00.000Z");
    const admission = new PostgresQuantityPublicationAdmission(database.pool,clock);
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async guard => ({
        item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,guard,"sandbox"),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],guard,"sandbox"),
      }),
    });
    const adapter = new EbayAdapter({} as never,{ resolve: vi.fn(async () => ({ byVariantId: new Map(),groupImageUrls: [] })) });
    vi.spyOn(adapter as any,"getApiClient").mockResolvedValue(api);
    await expect(adapter.pushInventory(1,[{ variantId: 101,sku: "P5",externalVariantId: "offer-1",
      externalInventoryItemId: null,allocatedQty: 4 }],undefined,availabilityClaimPublicationGuard(claim!,context)))
      .rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
    expect((await database.pool.query(`SELECT p.state,r.outcome FROM inventory.quantity_publication_attempts p
      JOIN channels.channel_variant_availability_attempts a ON a.attempt_id=p.id
      JOIN inventory.quantity_provider_requests q ON q.attempt_id=p.id
      JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id`)).rows)
      .toEqual([{ state: "uncertain",outcome: "uncertain" }]);
    expect(await markVariantAvailabilityFailed(dbPool,claim!,failure)).toBe("retryable");
    await database.pool.query("UPDATE channels.channel_variant_availability_sync SET next_attempt_at=clock_timestamp() WHERE channel_id=1 AND product_variant_id=101");
    expect(await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    const saved = (await database.pool.query("SELECT status,last_error FROM channels.channel_variant_availability_sync WHERE channel_id=1 AND product_variant_id=101")).rows[0];
    expect(saved.status).toBe("needs_review");
    expect(saved.last_error).toContain(failure.message);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { parked: false,lateBeforeReclaim: false,archiveBeforeCurrent: false },
    { parked: true,lateBeforeReclaim: false,archiveBeforeCurrent: false },
    { parked: true,lateBeforeReclaim: true,archiveBeforeCurrent: false },
    { parked: true,lateBeforeReclaim: true,archiveBeforeCurrent: true },
  ])("replans a confirmed journaled write after lease expiry ($parked, $lateBeforeReclaim, $archiveBeforeCurrent)", async ({ parked,lateBeforeReclaim,archiveBeforeCurrent }) => {
    const dbPool = database.pool as unknown as SqlPool;
    await database.pool.query("UPDATE channels.channel_feeds SET channel_variant_id='offer-1' WHERE channel_id=1 AND product_variant_id=101");
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [first] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    expect(first).toBeDefined();
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Test",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: "offer-1",externalInventoryItemId: null,externalSku: "P5",previousQuantity: null,
      mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,variantId: "offer-1",inventoryItemId: null,sku: "P5" },listing: null } };
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection",connectionId: 1,providerKey: "ebay",
      providerScopeType: "account",externalScopeId: "verified-seller",externalInventoryItemId: "P5",productId: 20,productVariantId: 101 };
    let releaseRequest!: () => void; let requestStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseRequest = resolve; });
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    const request = vi.fn<typeof fetch>(async () => {
      requestStarted(); await gate;
      return new Response(JSON.stringify({ responses: [
        { sku: "P5",statusCode: 200 },{ sku: "P5",offerId: "offer-1",statusCode: 200 },
      ] }),{ status: 200 });
    });
    const clock = () => new Date("2026-09-08T20:00:00.000Z");
    const admission = new PostgresQuantityPublicationAdmission(database.pool,clock);
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async guard => ({
        item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,guard,"sandbox"),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],guard,"sandbox"),
      }),
    });
    const adapter = new EbayAdapter({} as never,{ resolve: vi.fn(async () => ({ byVariantId: new Map(),groupImageUrls: [] })) });
    vi.spyOn(adapter as any,"getApiClient").mockResolvedValue(api);
    vi.spyOn(adapter as any,"delay").mockResolvedValue(undefined);
    const publish = (claim: typeof first, quantity: number) => adapter.pushInventory(1,[{ variantId: 101,sku: "P5",
      externalVariantId: "offer-1",externalInventoryItemId: null,allocatedQty: quantity }],undefined,
    availabilityClaimPublicationGuard(claim!,context));
    const firstPublication = publish(first,4);
    await started;
    try {
      await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,false,'stock_repair')");
      if (parked) {
        await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE channel_id=1 AND product_variant_id=101");
        expect(await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 })).toEqual([]);
      }
    } finally { releaseRequest(); }
    expect(await firstPublication).toEqual([{ variantId: 101,pushedQty: 4,status: "success" }]);
    if (!parked) await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE channel_id=1 AND product_variant_id=101");
    const oldAcknowledgement = { quantity: 4,feedActive: true,externalProductId: null,externalVariantId: "offer-1",
      externalInventoryItemId: null,externalSku: "P5" };
    if (lateBeforeReclaim) {
      expect(await markVariantAvailabilitySynced(dbPool,first!,oldAcknowledgement,context.mappingSnapshot)).toBe("claim_changed");
    }
    const [second] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    expect(second).toMatchObject({ revision: first!.revision,attemptCount: 2 });
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    if (!lateBeforeReclaim) {
      expect(await markVariantAvailabilitySynced(dbPool,first!,oldAcknowledgement,context.mappingSnapshot)).toBe("claim_changed");
    }
    if (archiveBeforeCurrent) {
      await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=101");
      expect(await supersedeAvailabilityClaim(dbPool,second!,false)).toBe("superseded");
      expect((await database.pool.query("SELECT status,revision,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE channel_id=1 AND product_variant_id=101")).rows[0])
        .toEqual({ status: "pending",revision: "2",desired_active: false,request_kind: "stock_repair" });
      expect(request).toHaveBeenCalledOnce();
      return;
    }
    expect(await publish(second,7)).toEqual([{ variantId: 101,pushedQty: 7,status: "success" }]);
    expect(await markVariantAvailabilitySynced(dbPool,second!,{ ...oldAcknowledgement,quantity: 7 },context.mappingSnapshot)).toBe("synced");
    expect((await database.pool.query("SELECT status,revision,desired_active,request_kind FROM channels.channel_variant_availability_sync WHERE channel_id=1 AND product_variant_id=101")).rows[0])
      .toEqual({ status: "pending",revision: "2",desired_active: false,request_kind: "stock_repair" });
    expect((await database.pool.query("SELECT state,resolution_basis FROM inventory.quantity_publication_attempts ORDER BY id")).rows)
      .toEqual([{ state: "succeeded",resolution_basis: "owner_completion" },{ state: "succeeded",resolution_basis: "owner_completion" }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("recovers once after an in-flight request becomes a recorded terminal rejection", async () => {
    const dbPool = database.pool as unknown as SqlPool;
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [claim] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    expect(claim).toBeDefined();
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Test",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: null,externalInventoryItemId: null,externalSku: "P5",previousQuantity: null,
      mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,variantId: null,inventoryItemId: null,sku: "P5" },listing: null } };
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection",connectionId: 1,providerKey: "ebay",
      providerScopeType: "account",externalScopeId: "finality-account",externalInventoryItemId: "P5",productId: 20,productVariantId: 101 };
    const clock = () => new Date("2026-09-08T20:00:00.000Z");
    const admission = new PostgresQuantityPublicationAdmission(database.pool,clock);
    // Exercise the actual channel adapter and API transport: a stale explicit
    // guard must reach admission and must not trigger its legacy fallback.
    const refusedRequest = vi.fn<typeof fetch>(async () => new Response(null,{ status: 204 }));
    const guardedApi = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request: refusedRequest,now: clock,quantityAdmission: async guard => ({
        item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,guard),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],guard),
      }),
    });
    const adapter = new EbayAdapter({} as never,{ resolve: vi.fn(async () => ({ byVariantId: new Map(),groupImageUrls: [] })) });
    vi.spyOn(adapter as any,"getApiClient").mockResolvedValue(guardedApi);
    const stale = { ...claim!,leaseToken: "123e4567-e89b-42d3-a456-426614174001" };
    await expect(adapter.pushInventory(1,[{ variantId: 101,sku: "P5",externalVariantId: "offer-1",
      externalInventoryItemId: null,allocatedQty: 4 }],undefined,availabilityClaimPublicationGuard(stale,context)))
      .rejects.toMatchObject({ code: "VARIANT_AVAILABILITY_CLAIM_CHANGED" });
    expect(refusedRequest).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.channel_variant_availability_attempts")).rows[0].count).toBe(0);
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const request = vi.fn<typeof fetch>(async () => { started(); await gate; return new Response(JSON.stringify(daily),{ status: 400 }); });
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async guard => ({
        item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,guard,"sandbox"),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],guard,"sandbox"),
      }),
    });
    const publishing = api.withPublicationGuard(availabilityClaimPublicationGuard(claim!,context)).createOrReplaceInventoryItem("P5",
      { product: { title: "Test",imageUrls: [] },condition: "NEW",availability: { shipToLocationAvailability: { quantity: 4 } } }).catch(error => error);
    await entered;
    try {
      await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,false,'stock_repair')");
      await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE channel_id=1 AND product_variant_id=101");
      expect(await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    } finally { release(); }
    expect(await publishing).toMatchObject({ code: "EBAY_QUANTITY_DAILY_LIMIT" });
    expect((await database.pool.query(`SELECT p.state,r.request_terminated FROM channels.channel_variant_availability_attempts a
      JOIN inventory.quantity_publication_attempts p ON p.id=a.attempt_id
      JOIN inventory.quantity_provider_requests q ON q.attempt_id=p.id
      JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id`)).rows)
      .toEqual([{ state: "rejected",request_terminated: true }]);
    const claims = (await Promise.all([
      claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 60 }),
      claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 60 }),
    ])).flat();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ revision: claim!.revision,desiredActive: true,attemptCount: 2 });
    expect((await database.pool.query("SELECT disposition FROM channels.channel_variant_availability_decisions ORDER BY id")).rows)
      .toEqual([{ disposition: "provider_attempt_unsettled" },{ disposition: "provider_attempt_final" }]);
    expect((await database.pool.query("SELECT desired_active,request_kind FROM channels.channel_variant_availability_followups")).rows)
      .toEqual([{ desired_active: false,request_kind: "stock_repair" }]);
    expect(request).toHaveBeenCalledOnce();
  });

  it("reuses Inventory's immutable terminal-response recovery without claiming the earlier quantity succeeded", async () => {
    const dbPool = database.pool as unknown as SqlPool;
    await database.pool.query("SELECT channels.request_variant_availability_refresh(1,101,true,'catalog_activation')");
    const [claim] = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 120 });
    const context: VariantAvailabilityContext = { channelId: 1,channelName: "Test",channelProvider: "ebay",
      channelStatus: "active",channelSyncEnabled: true,channelSyncMode: "live",productId: 20,productVariantId: 101,
      catalogSku: "P5",catalogVariantActive: true,catalogRequiresShipping: true,catalogTrackInventory: true,
      catalogSalesEligibility: "sellable",variantExcluded: false,catalogProductActive: true,catalogProductStatus: "active",
      productExcluded: false,productOverrideIsListed: null,variantOverrideIsListed: null,feedId: 1,listingId: null,
      externalProductId: null,externalVariantId: null,externalInventoryItemId: null,externalSku: "P5",previousQuantity: null,
      mappingSnapshot: { productId: 20,catalogSku: "P5",feed: { id: 1,productId: null,variantId: null,inventoryItemId: null,sku: "P5" },listing: null } };
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection",connectionId: 1,providerKey: "ebay",
      providerScopeType: "account",externalScopeId: "finality-account",externalInventoryItemId: "P5",productId: 20,productVariantId: 101 };
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const request = vi.fn<typeof fetch>(async () => { started(); await gate; return new Response(JSON.stringify({ responses: [
      { sku: "P5",statusCode: 200 },{ sku: "P5",offerId: "offer-1",statusCode: 400,errors: [{ errorId: 25004,category: "REQUEST",message: "Invalid quantity" }] },
    ] }),{ status: 207 }); });
    const clock = () => new Date("2026-09-08T20:00:00.000Z");
    const admission = new PostgresQuantityPublicationAdmission(database.pool,clock);
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async guard => ({
        item: (_sku,work) => admission.runListing(scope,async () => { throw new Error("unexpected canonical plan"); },work,guard,"sandbox"),
        group: () => { throw new Error("unexpected group request"); },
        reducing: (_identity,work) => admission.runQuantityReducingLifecycle(scope,work,[],guard,"sandbox"),
      }),
    });
    const publishing = api.withPublicationGuard(availabilityClaimPublicationGuard(claim!,context)).bulkUpdatePriceQuantity({ requests: [{ sku: "P5",
      shipToLocationAvailability: { quantity: 4 },offers: [{ offerId: "offer-1",availableQuantity: 4 }] }] }).catch(error => error);
    await entered;
    try {
      await database.pool.query("UPDATE channels.channel_variant_availability_sync SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE channel_id=1 AND product_variant_id=101");
      expect(await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 60 })).toEqual([]);
    } finally { release(); }
    expect(await publishing).toMatchObject({ code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN" });
    const attempt = (await database.pool.query<{ id: string; state: string }>(`SELECT p.id::text,p.state FROM inventory.quantity_publication_attempts p
      JOIN channels.channel_variant_availability_attempts a ON a.attempt_id=p.id`)).rows[0];
    expect(attempt.state).toBe("uncertain");
    expect(await new PostgresQuantityProviderResponseRecovery(database.pool,clock).reconcile([scope]))
      .toEqual({ resolved: [attempt.id],unresolved: [],busy: false });
    expect((await database.pool.query("SELECT state,resolution_basis FROM inventory.quantity_publication_attempts WHERE id=$1",[attempt.id])).rows[0])
      .toEqual({ state: "resolved",resolution_basis: "provider_response_terminal" });
    const claims = await claimVariantAvailabilitySyncs(dbPool,{ batchSize: 1,leaseSeconds: 60 });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ revision: claim!.revision,desiredActive: true,attemptCount: 2 });
    expect((await database.pool.query("SELECT last_synced_quantity FROM channels.channel_variant_availability_sync WHERE channel_id=1 AND product_variant_id=101")).rows[0])
      .toEqual({ last_synced_quantity: null });
    expect(request).toHaveBeenCalledOnce();
  });
});
