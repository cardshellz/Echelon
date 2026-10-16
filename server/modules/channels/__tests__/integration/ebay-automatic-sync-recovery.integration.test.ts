import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../../../inventory-planning/__tests__/fixtures/ebay-publication-inventory.fixture";
import { ensureEbayPublicationReady } from "../../../inventory-planning/infrastructure/ebay-publication-readiness.repository";
import { PostgresQuantityPublicationAdmission } from "../../../inventory-planning/infrastructure/quantity-publication-admission.repository";
import { PostgresQuantityProviderResponseRecovery } from "../../../inventory-planning/infrastructure/quantity-provider-response-recovery.repository";
import { planCurrentCanonicalListingQuantity } from "../../../inventory-planning/infrastructure/quantity-publication-runtime";
import { observeEbayQuantityRequest } from "../../../inventory-planning/application/quantity-provider-request-evidence";
import { EbayAutomaticPublicationRecoveryService } from "../../../inventory-planning/application/ebay-automatic-publication-recovery.service";
import { PostgresEbayAutomaticPublicationRecoveryRepository } from "../../../inventory-planning/infrastructure/ebay-automatic-publication-recovery.repository";
import { EbayPublicationReconciliationService } from "../../../inventory-planning/application/ebay-publication-reconciliation.service";
import { PostgresEbayPublicationReconciliationRepository } from "../../../inventory-planning/infrastructure/ebay-publication-reconciliation.repository";
import { InventoryPublicationOutboxService } from "../../../inventory-planning/application/inventory-publication-outbox.service";
import { InventoryPublicationTransportRegistry, type InventoryPublicationTransportAdapter } from "../../../inventory-planning/application/inventory-publication-transport";
import { PostgresInventoryPublicationOutboxRepository } from "../../../inventory-planning/infrastructure/inventory-publication-outbox.repository";
import type { QuantityPublicationScope } from "../../../inventory-planning/domain/quantity-publication-admission";
import { PostgresEbayListingSyncRepository } from "../../infrastructure/ebay-listing-sync.repository";
import { createEbayRouteListingLifecycleClient } from "../../infrastructure/ebay-listing-client";
import { EbayExistingListingSyncExecution, EbayListingSyncService, type PreparedEbayListingSync } from "../../ebay-listing-sync.service";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import type { EbayQuantityHttpRequest, EbayQuantityRequestAdmission } from "../../quantity-publication-request";
import { ebayInventoryOffersPath, publishEbayInventoryQuantity, readEbayInventoryQuantity,
  type EbayInventoryQuantityClient } from "../../adapters/ebay/ebay-inventory-quantity";
import { AutomaticSyncEbayProvider, automaticSyncOldPhotos, automaticSyncPhotos } from "../fixtures/ebay-automatic-sync-provider.fixture";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null, api: vi.fn() }));
vi.mock("../../../../db", () => ({
  pool: new Proxy({} as Pool, { get(_target, key) {
    if (!runtime.pool) throw new Error("Disposable test pool is not initialized.");
    const value = Reflect.get(runtime.pool, key);
    return typeof value === "function" ? value.bind(runtime.pool) : value;
  } }), db: {},
}));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({
  EBAY_CHANNEL_ID: 67,
  ebayApiRequest: (...args: unknown[]) => runtime.api(...args),
  ebayApiRequestWithRateNotify: (...args: unknown[]) => runtime.api(...args),
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller-36" }) }),
}));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const ITEM_PATH = "/sell/inventory/v1/inventory_item/P5";
const OFFER_PATH = "/sell/inventory/v1/offer/offer-P5";
const QUANTITY_PATH = "/sell/inventory/v1/bulk_update_price_quantity";
const identity: EbayListingSyncIdentity = {
  channelId: 67, connectionId: 9, productId: 20, accountId: "seller-36", marketplaceId: "EBAY_US", groupKey: "PACK",
  variants: [{ variantId: 101, sku: "P5", externalSku: "P5", offerId: "offer-P5", listingId: "listing-20" }],
};

dbDescribe.sequential("automatic existing eBay Sync recovery through PostgreSQL and provider HTTP", () => {
  let database: InventoryCutoverTestDatabase;
  let timestamp: Date;
  const clock = () => new Date(timestamp);
  const advance = () => { timestamp = new Date(timestamp.getTime() + 60 * 60_000); };
  const scope = (sku: string): QuantityPublicationScope => ({
    destinationKind: "channel_connection", connectionId: 9, providerKey: "ebay", providerScopeType: "account",
    externalScopeId: "seller-36", externalInventoryItemId: sku, productId: 20,
    productVariantId: sku.startsWith("group:") ? null : 101,
  });

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live HTTP is prohibited in the disposable recovery suite."); }));
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    runtime.api.mockReset();
    timestamp = (await database.pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now")).rows[0].now;
    await installEbayPublicationInventoryFixture(database.pool, { includeQuantityRecoveryMigrations: true, seedPublicationJob: false });
    for (const file of [
      "0731_ebay_listing_sync_verification_checkpoint.sql",
      "0732_ebay_listing_sync_identity_admission.sql",
      "0736_ebay_listing_mapping_repairs.sql",
      "0737_ebay_publication_completion.sql",
      "0741_ebay_durable_withdrawal.sql",
      "900000008000018120001_ebay_automatic_sync_recovery.sql",
    ]) await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    await database.pool.query(`ALTER TABLE channels.channel_listings
      ADD COLUMN last_synced_price integer, ADD COLUMN last_synced_qty integer,
      ADD COLUMN sync_error text, ADD COLUMN last_synced_at timestamptz, ADD COLUMN updated_at timestamptz;
      UPDATE channels.channel_listings SET external_sku='P5',external_product_id='listing-20',sync_status='synced';`);
    await ensureEbayPublicationReady(database.pool, {
      channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production", productId: 20,
      purpose: "sync", variants: [{ productVariantId: 101, sku: "P5" }],
    }, { commandKey: randomUUID(), actor: "test-operator", now: clock() });
    timestamp = new Date((await database.pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now")).rows[0].now.getTime() + 1_000);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; vi.unstubAllGlobals(); });

  function fixture() {
    const provider = new AutomaticSyncEbayProvider(clock);
    runtime.api.mockImplementation((method: string, path: string, _token: string, body: unknown) => provider.request({ method, path, body }));
    const admission = new PostgresQuantityPublicationAdmission(database.pool, clock);
    const quantityAdmission: EbayQuantityRequestAdmission = {
      item: (sku, work) => admission.runListing(scope(sku), () => planCurrentCanonicalListingQuantity(scope(sku)), work),
      group: (key, skus, work) => admission.runListingGroup(scope(`group:${key}`), skus.map(scope), planCurrentCanonicalListingQuantity, work),
      reducing: (sku, work, members) => admission.runQuantityReducingLifecycle(scope(sku), work, members?.map(scope)),
    };
    const client = createEbayRouteListingLifecycleClient({
      accessToken: "synthetic-test-token", expectedAccountId: identity.accountId, expectedConnectionId: identity.connectionId,
      quantityAdmission: async () => quantityAdmission,
    });
    const original = provider.snapshot();
    const prepare = async (): Promise<PreparedEbayListingSync> => ({
      identity: structuredClone(identity), client,
      // The fixture deliberately supplies a stale draft quantity. Only the
      // real canonical planner/admission may decide the value sent to eBay.
      draft: {
        productId: 20, marketplaceId: "EBAY_US",
        inventoryItems: [{ sku: "P5", payload: { ...structuredClone(original.item), product: {
          ...original.item.product, title: "Current catalog title", imageUrls: [...automaticSyncPhotos],
        } } }],
        offers: [{ sku: "P5", variantId: 101, payload: { ...structuredClone(original.offer),
          pricingSummary: { price: { value: "11.49", currency: "USD" } } } }],
        itemGroup: { groupKey: "PACK", payload: { ...structuredClone(original.group), title: "Current catalog title", imageUrls: [...automaticSyncPhotos] } },
      },
      variants: [{ variantId: 101, sku: "P5", productName: "Pack", priceCents: 1149, priceChanged: true }],
    });
    const store = new PostgresEbayListingSyncRepository(database.pool);
    const automaticRecovery = new EbayAutomaticPublicationRecoveryService(new PostgresEbayAutomaticPublicationRecoveryRepository(database.pool), clock);
    const execution = new EbayExistingListingSyncExecution(prepare,
      new PostgresQuantityProviderResponseRecovery(database.pool, clock),
      new EbayMarketplaceListingConnector({ delay: async () => {}, inventoryDelayMs: 0, offerDelayMs: 0 }), automaticRecovery);
    const service = new EbayListingSyncService(store, execution, clock, randomUUID);
    const registry = new InventoryPublicationTransportRegistry();
    const quantityClient: EbayInventoryQuantityClient = {
      getInventoryItem: sku => provider.request({ method: "GET", path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}` }),
      getInventoryOffersPage: (sku, marketplaceId, offset, limit) => provider.request({ method: "GET",
        path: ebayInventoryOffersPath(sku, marketplaceId, offset, limit) }),
      bulkUpdatePriceQuantity: body => {
        const mutation: EbayQuantityHttpRequest = { method: "POST", path: QUANTITY_PATH, body };
        return observeEbayQuantityRequest(mutation, () => provider.request(mutation));
      },
    };
    const transport: InventoryPublicationTransportAdapter = {
      destinationKind: "channel_connection", providerKey: "ebay", supportedScopeTypes: ["account"],
      publishAbsolute: async request => {
        expect(request.destination).toEqual({ kind: "channel_connection", channelConnectionId: 9, dropshipStoreConnectionId: null });
        expect(request.externalInventoryItemId).toBe("P5");
        const providerResponse = await publishEbayInventoryQuantity(quantityClient, request.externalInventoryItemId, "EBAY_US", request.desiredQuantity);
        return { publishedQuantity: providerResponse.quantity, providerResponse };
      },
      readAbsolute: async request => {
        expect(request.externalInventoryItemId).toBe("P5");
        const observation = await readEbayInventoryQuantity(quantityClient, request.externalInventoryItemId, "EBAY_US");
        return { observedQuantity: observation.observedQuantity,
          quantityConsistent: observation.inventoryItemQuantity === observation.offerQuantity, providerResponse: observation };
      },
    };
    registry.register(transport);
    const outbox = new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(database.pool),
      registry, { now: clock }, randomUUID, admission);
    const refreshContent = vi.fn(async (input: { productId: number; connectionId: number; accountId: string; commandKey: string }) => {
      expect(input).toMatchObject({ productId: 20, connectionId: 9, accountId: "seller-36" });
      const job = await service.enqueue(identity, "system:ebay-publication-reconciliation", input.commandKey);
      return { jobId: job.id };
    });
    const reconciliation = new EbayPublicationReconciliationService(
      new PostgresEbayPublicationReconciliationRepository(database.pool), registry, refreshContent, clock);
    return { provider, admission, client, quantityClient, store, service, automaticRecovery, outbox, reconciliation, refreshContent, prepare };
  }

  async function uncertainAttempt() {
    const rows = (await database.pool.query<{ id: string; record: Record<string, unknown> }>(
      `SELECT id::text,to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a
       WHERE scope->>'externalScopeId'='seller-36' AND state='uncertain' ORDER BY id`,
    )).rows;
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function expectUnknownOutcomeRetained(before: Awaited<ReturnType<typeof uncertainAttempt>>) {
    const record = (await database.pool.query<{ record: Record<string, unknown> }>(
      "SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1", [before.id],
    )).rows[0].record;
    expect(record).toEqual({ ...before.record, state: "superseded_unknown" });
    await expect(database.pool.query("DELETE FROM inventory.quantity_publication_attempts WHERE id=$1", [before.id]))
      .rejects.toMatchObject({ code: "23514" });
  }

  async function changePhysicalFixtureStock() {
    // A new synthetic warehouse observation changes the real canonical plan
    // from 17 packs to 7. No stock formula is substituted in this test.
    await database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=10 WHERE product_variant_id=101;
      UPDATE inventory.inventory_lots SET qty_on_hand=10 WHERE product_variant_id=101`);
  }

  function expectCurrentListing(f: ReturnType<typeof fixture>, quantity: number) {
    expect(f.provider.snapshot()).toMatchObject({
      item: { product: { title: "Current catalog title", imageUrls: [...automaticSyncPhotos] }, availability: { shipToLocationAvailability: { quantity } } },
      offer: { listingId: "listing-20", offerId: "offer-P5", status: "PUBLISHED", availableQuantity: quantity,
        pricingSummary: { price: { value: "11.49", currency: "USD" } } },
      group: { title: "Current catalog title", imageUrls: [...automaticSyncPhotos], variantSKUs: ["P5"] },
    });
    expect(f.provider.writes.every(write => write.method === "PUT" || write.path === QUANTITY_PATH)).toBe(true);
  }

  it("recovers a request whose accepted response was lost during a process crash and finishes the saved Sync", async () => {
    const f = fixture();
    await database.pool.query(`CREATE FUNCTION inventory.test_lost_response_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected process loss before response persistence'; END $$;
      CREATE TRIGGER test_lost_response_commit BEFORE INSERT ON inventory.quantity_provider_request_results
      FOR EACH ROW EXECUTE FUNCTION inventory.test_lost_response_commit()`);
    try {
      await expect(f.client.createOrReplaceInventoryItem("P5", f.provider.snapshot().item)).rejects.toThrow();
    } finally {
      await database.pool.query("DROP TRIGGER test_lost_response_commit ON inventory.quantity_provider_request_results");
    }
    const before = await uncertainAttempt();
    expect((await database.pool.query(`SELECT r.request_id FROM inventory.quantity_provider_requests q
      LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id WHERE q.attempt_id=$1`, [before.id])).rows)
      .toEqual([{ request_id: null }]);
    const job = await f.service.enqueue(identity, "operator");
    await f.service.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "completed", code: null, message: null });
    expectCurrentListing(f, 17);
    await expectUnknownOutcomeRetained(before);
  });

  it("resumes an existing awaiting-evidence Sync through the scheduled worker without a new operator command", async () => {
    const f = fixture();
    f.provider.loseNextResponse(ITEM_PATH);
    await expect(f.client.createOrReplaceInventoryItem("P5", f.provider.snapshot().item)).rejects.toThrow();
    const before = await uncertainAttempt();
    const job = await f.service.enqueue(identity, "operator");
    // Produce the historical state through the real executor without its new
    // automatic owner, then restart with today's production composition.
    const previousService = new EbayListingSyncService(f.store, new EbayExistingListingSyncExecution(f.prepare,
      new PostgresQuantityProviderResponseRecovery(database.pool, clock),
      new EbayMarketplaceListingConnector({ delay: async () => {}, inventoryDelayMs: 0, offerDelayMs: 0 })), clock, randomUUID);
    await previousService.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "awaiting_evidence", code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED" });

    advance();
    await f.service.processDue(1);
    expect(await f.store.get(job.id)).toMatchObject({ state: "completed", code: null });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.ebay_listing_sync_commands WHERE job_id=$1", [job.id])).rows[0].count).toBe(1);
    expectCurrentListing(f, 17);
    await expectUnknownOutcomeRetained(before);
  });

  it("rolls recovery and its recurring obligation back together when the audit receipt cannot commit", async () => {
    const f = fixture();
    f.provider.loseNextResponse(ITEM_PATH);
    await expect(f.client.createOrReplaceInventoryItem("P5", f.provider.snapshot().item)).rejects.toThrow();
    const before = await uncertainAttempt();
    const job = await f.service.enqueue(identity, "operator");
    const writesBeforeRecovery = f.provider.writes.length;
    await database.pool.query(`CREATE FUNCTION inventory.test_automatic_recovery_audit_loss() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected recovery receipt failure'; END $$;
      CREATE TRIGGER test_automatic_recovery_audit_loss BEFORE INSERT ON inventory.ebay_automatic_publication_recoveries
      FOR EACH ROW EXECUTE FUNCTION inventory.test_automatic_recovery_audit_loss()`);
    try {
      await f.service.processDue(1, job.id);
      expect(await f.store.get(job.id)).toMatchObject({ state: "recovering" });
      expect((await database.pool.query("SELECT to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE id=$1", [before.id])).rows[0].record)
        .toEqual(before.record);
      expect((await database.pool.query(`SELECT
        (SELECT count(*)::int FROM inventory.ebay_automatic_publication_recoveries) AS receipts,
        (SELECT count(*)::int FROM inventory.ebay_publication_reconciliation_watches) AS watches`)).rows[0])
        .toEqual({ receipts: 0, watches: 0 });
      expect(f.provider.writes).toHaveLength(writesBeforeRecovery);
    } finally {
      await database.pool.query("DROP TRIGGER test_automatic_recovery_audit_loss ON inventory.ebay_automatic_publication_recoveries");
    }
    advance();
    await f.service.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "completed" });
    expectCurrentListing(f, 17);
    await expectUnknownOutcomeRetained(before);
  });

  it("repairs a delayed old stock write arriving after Sync has completed using the recurring canonical publisher", async () => {
    const f = fixture();
    f.provider.loseNextResponse(QUANTITY_PATH);
    expect((await f.outbox.processDue()).failed).toBe(1);
    const before = await uncertainAttempt();
    await changePhysicalFixtureStock();
    const job = await f.service.enqueue(identity, "operator");
    await f.service.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "completed" });
    expectCurrentListing(f, 7);

    f.provider.deliverLateWrites();
    expect(f.provider.snapshot()).toMatchObject({ item: { availability: { shipToLocationAvailability: { quantity: 17 } } }, offer: { availableQuantity: 17 } });
    advance();
    await f.reconciliation.processDue();
    expect((await f.outbox.processDue()).verified).toBeGreaterThan(0);
    await f.service.processDue();
    expectCurrentListing(f, 7);
    expect(f.refreshContent).toHaveBeenCalledTimes(1);
    const repairedWrites = f.provider.writes.length;
    advance();
    await f.reconciliation.processDue();
    await f.service.processDue();
    expect(f.refreshContent).toHaveBeenCalledTimes(2);
    expect(f.provider.writes).toHaveLength(repairedWrites);
    await expectUnknownOutcomeRetained(before);
  });

  it("repairs old pictures and stock arriving after success through the same saved Sync flow", async () => {
    const f = fixture();
    f.provider.loseNextResponse(ITEM_PATH);
    await expect(f.client.createOrReplaceInventoryItem("P5", f.provider.snapshot().item)).rejects.toThrow("Injected response loss");
    const before = await uncertainAttempt();
    await changePhysicalFixtureStock();
    const job = await f.service.enqueue(identity, "operator");
    await f.service.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "completed" });
    expectCurrentListing(f, 7);

    f.provider.deliverLateWrites();
    expect(f.provider.snapshot().item).toMatchObject({ product: { imageUrls: automaticSyncOldPhotos },
      availability: { shipToLocationAvailability: { quantity: 17 } } });
    advance();
    await f.reconciliation.processDue();
    await f.outbox.processDue();
    // Correct stock alone is not photo completion.
    expect(f.provider.snapshot().item).toMatchObject({ product: { imageUrls: automaticSyncOldPhotos },
      availability: { shipToLocationAvailability: { quantity: 7 } } });
    await f.service.processDue();
    expectCurrentListing(f, 7);
    await expectUnknownOutcomeRetained(before);
  });

  it.each(["item", "offer"] as const)("repairs a late high %s quantity even when eBay's lower available quantity already matches ATP", async target => {
    const f = fixture();
    f.provider.loseNextResponse(target === "item" ? ITEM_PATH : OFFER_PATH);
    if (target === "item") await expect(f.client.createOrReplaceInventoryItem("P5", f.provider.snapshot().item)).rejects.toThrow();
    else await expect(f.client.updateOffer("offer-P5", f.provider.snapshot().offer)).rejects.toThrow();
    const before = await uncertainAttempt();
    await changePhysicalFixtureStock();
    const job = await f.service.enqueue(identity, "operator");
    await f.service.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "completed" });
    expectCurrentListing(f, 7);

    f.provider.deliverLateWrites();
    expect(await readEbayInventoryQuantity(f.quantityClient, "P5", "EBAY_US")).toMatchObject({
      observedQuantity: 7, inventoryItemQuantity: target === "item" ? 17 : 7,
      offerQuantity: target === "offer" ? 17 : 7,
    });
    advance();
    expect((await f.reconciliation.processDue()).repaired).toBe(1);
    expect((await f.outbox.processDue()).verified).toBeGreaterThan(0);
    await f.service.processDue();
    expectCurrentListing(f, 7);
    await expectUnknownOutcomeRetained(before);
  });

  it("escapes a retained verification checkpoint when a late old item replacement changes the pictures", async () => {
    const f = fixture();
    f.provider.loseNextResponse(ITEM_PATH);
    await expect(f.client.createOrReplaceInventoryItem("P5", f.provider.snapshot().item)).rejects.toThrow();
    const job = await f.service.enqueue(identity, "operator");
    await database.pool.query(`CREATE FUNCTION channels.test_completion_commit_loss() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event='completed' THEN RAISE EXCEPTION 'injected final completion commit loss'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_completion_commit_loss BEFORE INSERT ON channels.ebay_listing_sync_events
      FOR EACH ROW EXECUTE FUNCTION channels.test_completion_commit_loss()`);
    try {
      await f.service.processDue(1, job.id);
    } finally {
      await database.pool.query("DROP TRIGGER test_completion_commit_loss ON channels.ebay_listing_sync_events");
    }
    const interrupted = await f.store.get(job.id);
    expect(interrupted).toMatchObject({ state: "recovering", revision: "1", verificationRevision: "1" });
    expect(interrupted.verificationIntentHash).toMatch(/^[a-f0-9]{64}$/);
    expectCurrentListing(f, 17);

    f.provider.deliverLateWrites();
    const writeCount = f.provider.writes.length;
    advance();
    await f.service.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "recovering", verificationRevision: "1" });
    expect(f.provider.writes).toHaveLength(writeCount);
    expect(f.provider.snapshot().item.product.imageUrls).toEqual(automaticSyncOldPhotos);

    // The durable follow-up adds a new content revision rather than repeatedly
    // treating the accepted-but-now-stale verification checkpoint as final.
    await f.reconciliation.processDue();
    expect(await f.store.get(job.id)).toMatchObject({ state: "queued", revision: "2" });
    await f.service.processDue(1, job.id);
    expect(await f.store.get(job.id)).toMatchObject({ state: "completed", revision: "2", code: null });
    expect(f.provider.writes.length).toBeGreaterThan(writeCount);
    expectCurrentListing(f, 17);
  });

  it("replays the durable content command after a crash between enqueue and the watch checkpoint", async () => {
    const f = fixture();
    f.provider.loseNextResponse(ITEM_PATH);
    await expect(f.client.createOrReplaceInventoryItem("P5", f.provider.snapshot().item)).rejects.toThrow();
    const original = await f.service.enqueue(identity, "operator");
    await f.service.processDue(1, original.id);
    expect(await f.store.get(original.id)).toMatchObject({ state: "completed" });
    f.provider.deliverLateWrites();
    f.refreshContent.mockImplementationOnce(async input => {
      await f.service.enqueue(identity, "system:ebay-publication-reconciliation", input.commandKey);
      throw new Error("Injected process loss after the content command committed.");
    });
    advance();
    expect((await f.reconciliation.processDue()).blocked).toBe(1);
    const firstCommand = f.refreshContent.mock.calls[0][0].commandKey;
    const saved = (await database.pool.query<{ job_id: string }>(
      "SELECT job_id::text FROM channels.ebay_listing_sync_commands WHERE command_key=$1", [firstCommand],
    )).rows;
    expect(saved).toHaveLength(1);
    expect(await f.store.get(saved[0].job_id)).toMatchObject({ state: "queued" });

    advance();
    expect((await f.reconciliation.processDue()).checked).toBe(1);
    expect(f.refreshContent.mock.calls[1][0].commandKey).toBe(firstCommand);
    expect((await database.pool.query("SELECT job_id::text FROM channels.ebay_listing_sync_commands WHERE command_key=$1", [firstCommand])).rows)
      .toEqual(saved);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.ebay_listing_sync_jobs")).rows[0].count).toBe(2);
    await f.service.processDue(1, saved[0].job_id);
    expect(await f.store.get(saved[0].job_id)).toMatchObject({ state: "completed" });
    expectCurrentListing(f, 17);
  });

  it("waits for a live stock sender while repeated Sync clicks join one saved update", async () => {
    const f = fixture();
    const held = f.provider.holdNextWrite(QUANTITY_PATH);
    const stock = f.outbox.processDue();
    let jobId: string;
    try {
      await Promise.race([held.entered, stock.then(() => { throw new Error("Stock worker finished before reaching the held provider request."); })]);
      const jobs = await Promise.all([randomUUID(), randomUUID()].map(command => f.service.enqueue(identity, "operator", command)));
      expect(jobs[0].id).toBe(jobs[1].id);
      jobId = jobs[0].id;
      await changePhysicalFixtureStock();
      await f.service.processDue(1, jobId);
      expect(await f.store.get(jobId)).toMatchObject({ state: "recovering", code: "PUBLICATION_SCOPE_BUSY" });
      expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE scope->>'externalScopeId'='seller-36'")).rows)
        .toEqual([{ state: "running" }]);
      expect(f.provider.writes).toHaveLength(1);
    } finally {
      held.release();
      await stock;
    }
    advance();
    await f.service.processDue(1, jobId!);
    expect(await f.store.get(jobId!)).toMatchObject({ state: "completed", code: null });
    expectCurrentListing(f, 7);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.ebay_listing_sync_jobs")).rows[0].count).toBe(1);
  });
});
