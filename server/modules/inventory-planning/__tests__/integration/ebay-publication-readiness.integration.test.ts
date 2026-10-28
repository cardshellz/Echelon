import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { WALMART_INVENTORY_NOW } from "../fixtures/walmart-publication-inventory.fixture";
import { installEbayPublicationInventoryFixture } from "../fixtures/ebay-publication-inventory.fixture";
import { installPublicationSelectionWorkFixture } from "../fixtures/publication-selection-work.fixture";
import { calculatePublicationVariantMappingDefinitionHash } from "../../domain/inventory-channel-exposure";
import { reviewEbayPublicationReadiness, assertEbayPublicationReady, ensureEbayPublicationReady, withEbayPublicationReadinessApplied, findEbayPublicationReadinessReceipt, rejectEbayPublicationReadinessCommand } from "../../infrastructure/ebay-publication-readiness.repository";
import { createEbayRouteListingLifecycleClient } from "../../../channels/infrastructure/ebay-listing-client";
import { recordQuantityProviderResponse } from "../../application/quantity-provider-request-evidence";
import { PostgresQuantityPublicationAdmission, quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresInventoryAvailabilityRuntimePublicationExecutor } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PUBLICATION_TARGET_SCOPE_LOCK_SEED } from "../../infrastructure/inventory-publication-target-stop.repository";
import { EbayExistingListingSyncExecution, type EbayListingExecutionContext, type PreparedEbayListingSync } from "../../../channels/ebay-listing-sync.service";
import { EbayMarketplaceListingConnector, type EbayObservedOffer } from "../../../channels/listing-connectors/ebay-listing.connector";
import { ensureEbayListingInventoryReady } from "../../../channels/infrastructure/ebay-listing-inventory-readiness";
import { readEbayStockLinkGaps } from "../../infrastructure/ebay-publication-readiness.repository";
import { linkChannelEbayStock } from "../../infrastructure/channel-ebay-stock-link";
import { createChannelEbayStockLinkSource } from "../../../channels/infrastructure/ebay-stock-link-source";
import type { EbayInventoryItem, EbayInventoryItemGroup, EbayBulkPriceQuantityRequest, EbayOffer } from "../../../channels/adapters/ebay/ebay-types";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null, api: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  const value = Reflect.get(runtime.pool!, key); return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {} }));
vi.mock("../../../channels/infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  ebayApiRequest: (...args: unknown[]) => runtime.api(...args), ebayApiRequestWithRateNotify: (...args: unknown[]) => runtime.api(...args),
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller-36" }), getEnvironment: () => "production" }),
}));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
dbDescribe.sequential("reviewed eBay publication stock enrollment, real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  const source = () => ({ channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production" as const,
    productId: 20, variants: [{ productVariantId: 101, sku: "P5" }] });
  const input = async (commandKey = randomUUID()) => ({ source: source(), commandKey,
    contextHash: "a".repeat(64), expectedReviewHash: (await reviewEbayPublicationReadiness(database.pool, source())).reviewHash });
  const followUp = async (client: Parameters<Parameters<typeof withEbayPublicationReadinessApplied>[4]>[0], receipt: { commandKey: string }) => {
    await client.query("INSERT INTO saved_publication_work(command_key) VALUES($1::uuid) ON CONFLICT DO NOTHING", [receipt.commandKey]);
    return receipt.commandKey;
  };
  const counts = async () => (await database.pool.query(`SELECT
    (SELECT count(*)::int FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=3) AS mappings,
    (SELECT count(*)::int FROM inventory.publication_membership_heads WHERE publication_target_id=3) AS members,
    (SELECT count(*)::int FROM inventory.inventory_publication_outbox WHERE publication_target_id=3) AS updates,
    (SELECT count(*)::int FROM inventory.ebay_publication_readiness_applications) AS receipts,
    (SELECT count(*)::int FROM saved_publication_work) AS jobs`)).rows[0];
  const draft = async (sku = "P5") => {
    const client = await database.pool.connect();
    try {
    await client.query("BEGIN");
    const hash = calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: 3, productVariantId: 101, externalInventoryItemId: sku, externalSku: sku });
    const row = (await client.query(`INSERT INTO inventory.publication_variant_mapping_versions(publication_target_id,product_variant_id,version,
      external_inventory_item_id,external_sku,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES(3,101,1,$1,$1,$2,'Reviewed old draft','old-ebay-draft',$2,'operator') RETURNING id`, [sku, hash])).rows[0];
    await client.query(`INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
      VALUES(3,101,$1,1,'operator','Reviewed old draft')`, [row.id]);
    await client.query("COMMIT");
    return row.id as number;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  };
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool; runtime.api.mockReset();
    await installEbayPublicationInventoryFixture(database.pool, { includePreflightRecoveryMigrations: true, seedPublicationJob: false });
    for (const file of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql",
      "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql"]) {
      await database.pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    }
    await installPublicationSelectionWorkFixture(database.pool);
    // Group admission uses the shared lifecycle read model, including when no
    // member is archived. Install its real migration over the reduced owner schema.
    await database.pool.query(`ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      ALTER TABLE catalog.product_variants ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      ALTER TABLE channels.channel_connections ADD COLUMN IF NOT EXISTS shop_domain text;
      ALTER TABLE channels.channel_connections ADD COLUMN IF NOT EXISTS metadata jsonb;
      ALTER TABLE channels.walmart_connections ADD COLUMN IF NOT EXISTS market text;
      UPDATE channels.channel_connections SET metadata='{"marketplaceId":"EBAY_US"}' WHERE id=9;`);
    for (const file of ["0707_channel_listing_publication.sql", "900000013000018480001_shared_listing_member_lifecycle.sql"])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    await database.pool.query('CREATE TABLE saved_publication_work(command_key uuid PRIMARY KEY)');
  }, 30_000);
  afterEach(async () => { await database?.close(); });

  const retainedSource = async () => {
    // Channel-only exclusion still owns a retained zero. Catalog archival has a
    // separate removal lifecycle and must not be used to manufacture this case.
    await database.pool.query(`UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE id=102;
      UPDATE channels.channel_listings SET external_product_id='listing-20' WHERE id=1;
      INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
        VALUES(2,67,102,'NEW','offer-NEW','listing-20','synced')`);
    return { ...source(), purpose: "sync" as const, variants: [...source().variants, { productVariantId: 102, sku: "NEW" }] };
  };

  const unrelatedRetainedMappingGap = async () => {
    await database.pool.query(`BEGIN;
      INSERT INTO catalog.products(id,sku) VALUES(21,'OTHER');
      INSERT INTO catalog.product_variants(id,product_id,sku,is_active) VALUES(201,21,'OTHER-PACK',true),(202,21,'OTHER-CASE',true);
      UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE id=202;
      INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty)
        VALUES(11,100,201,7,0,0,0);
      INSERT INTO inventory.transformation_model_versions(product_id,version,build_to_promise_enabled,definition_hash,validation_state,validation_errors,change_reason,idempotency_key,request_hash,created_by)
        VALUES(21,1,false,repeat('c',64),'valid','[]','Other product model','other-product-model',repeat('c',64),'operator');
      INSERT INTO inventory.transformation_model_heads(product_id,draft_model_id,revision,updated_by,update_reason)
        SELECT 21,id,0,'operator','Other product model' FROM inventory.transformation_model_versions WHERE product_id=21;
      UPDATE inventory.transformation_model_versions SET lifecycle_status='sealed',sealed_by='operator',sealed_at=transaction_timestamp() WHERE product_id=21;
      UPDATE inventory.transformation_model_heads SET active_model_id=draft_model_id,draft_model_id=NULL,revision=revision+1 WHERE product_id=21;
      INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
        VALUES(3,67,201,'OTHER-PACK','offer-OTHER-PACK','listing-21','synced');
      COMMIT;`);
    await ensureEbayPublicationReady(database.pool, { ...source(), productId: 21,
      variants: [{ productVariantId: 201, sku: "OTHER-PACK" }] },
      { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW });
    // The unrelated product has a valid active mapping and a channel-excluded
    // retained offer without a listing ID, so its zero still needs an exact mapping.
    await database.pool.query(`INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
      VALUES(4,67,202,'OTHER-CASE','offer-OTHER-CASE',NULL,'synced')`);
  };

  it("prepares one product without invalidating another product's stock work or requiring its missing retained mapping", async () => {
    await ensureEbayPublicationReady(database.pool, source(),
      { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW });
    await unrelatedRetainedMappingGap();
    const selected = await retainedSource(), commandKey = randomUUID();
    const targetBefore = (await database.pool.query("SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=3")).rows[0];
    const unrelatedBefore = (await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND product_variant_id=201 ORDER BY id")).rows;
    expect(unrelatedBefore).toHaveLength(1);
    await Promise.all([1, 2].map(() => ensureEbayPublicationReady(database.pool, selected,
      { commandKey, actor: "operator", now: WALMART_INVENTORY_NOW })));
    expect((await database.pool.query("SELECT revision::text FROM inventory.inventory_publication_targets WHERE id=3")).rows[0]).toEqual(targetBefore);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND product_variant_id=201 ORDER BY id")).rows).toEqual(unrelatedBefore);
    expect((await database.pool.query("SELECT product_variant_id FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=3 ORDER BY product_variant_id")).rows)
      .toEqual([{ product_variant_id: 101 }, { product_variant_id: 102 }, { product_variant_id: 201 }]);
    expect((await database.pool.query("SELECT desired_quantity::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND product_variant_id=102")).rows)
      .toEqual([{ desired_quantity: "0" }]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [commandKey])).rows[0].n).toBe(1);
    const preparations = (await database.pool.query("SELECT receipt FROM inventory.publication_mapping_preparations WHERE idempotency_key=$1", [`ebay-stock:${commandKey}`])).rows;
    expect(preparations).toEqual([{ receipt: expect.objectContaining({ publicationTargetId: 3, revision: targetBefore.revision,
      changedProductVariantIds: [102], publicationRows: 1, appliedBy: "operator" }) }]);
    await expect(database.pool.query("UPDATE inventory.publication_mapping_preparations SET receipt='{}' WHERE idempotency_key=$1", [`ebay-stock:${commandKey}`]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await database.pool.query("SELECT receipt FROM inventory.publication_mapping_preparations WHERE idempotency_key=$1", [`ebay-stock:${commandKey}`])).rows).toEqual(preparations);
    expect(runtime.api).not.toHaveBeenCalled();
  });

  it("does not wait on another product's provider scope while preparing exact mappings", async () => {
    await unrelatedRetainedMappingGap();
    const selected = await retainedSource(), other = await database.pool.connect();
    const key = quantityPublicationScopeLockKey({ destinationKind: "channel_connection", connectionId: 9, providerKey: "ebay",
      providerScopeType: "account", externalScopeId: "seller-36", externalInventoryItemId: "OTHER-PACK", productId: null, productVariantId: null });
    try {
      await other.query("SELECT pg_advisory_lock(hashtextextended($1,$2))", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
      await ensureEbayPublicationReady(database.pool, selected,
        { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW });
      expect((await database.pool.query("SELECT product_variant_id FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND state='queued' ORDER BY product_variant_id")).rows)
        .toEqual([{ product_variant_id: 101 }, { product_variant_id: 102 }, { product_variant_id: 201 }]);
    } finally { await other.query("SELECT pg_advisory_unlock(hashtextextended($1,$2))", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED]); other.release(); }
  });

  it("still rolls back the complete requested product when another retained member of that product is unmapped", async () => {
    const selected = await retainedSource();
    const commandKey = randomUUID();
    await database.pool.query(`UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE id=103;
      INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,external_product_id,sync_status)
        VALUES(3,67,103,'UNCERTAIN','offer-UNCERTAIN',NULL,'synced')`);
    // These two requested mappings are eligible to be prepared. Whole-product
    // publication must still reject the separate retained zero for member 103.
    expect(await reviewEbayPublicationReadiness(database.pool, selected)).toMatchObject({ ready: true, variants: [
      { productVariantId: 101, desiredQuantity: "17" }, { productVariantId: 102, desiredQuantity: "0" },
    ] });
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(database.pool, { info: () => {}, warn: () => {} });
    const plan = await executor.execute(context => context.planProduct(20, 67, "publication"));
    expect(plan.targets.find(target => target.publicationTargetId === 3)?.rows.find(row => row.productVariantId === 103))
      .toMatchObject({ publishedUnits: "0", mapping: null, blockers: [{ code: "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING" }] });
    await expect(ensureEbayPublicationReady(database.pool, selected,
      { commandKey, actor: "operator", now: WALMART_INVENTORY_NOW }))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
        context: { productId: 20, publicationTargetId: 3, blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"] } });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    expect(runtime.api).not.toHaveBeenCalled();
    // Remove only the deliberately incomplete retained destination. The same
    // request must now commit, proving that member 103 caused the rollback and
    // that a failed preparation did not consume its command key.
    await database.pool.query("DELETE FROM channels.channel_listings WHERE channel_id=67 AND product_variant_id=103");
    await ensureEbayPublicationReady(database.pool, selected,
      { commandKey, actor: "operator", now: WALMART_INVENTORY_NOW });
    expect(await counts()).toEqual({ mappings: 2, members: 0, updates: 2, receipts: 1, jobs: 0 });
    expect((await database.pool.query(`SELECT product_variant_id,desired_quantity::text
      FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 ORDER BY product_variant_id`)).rows)
      .toEqual([{ product_variant_id: 101, desired_quantity: "17" }, { product_variant_id: 102, desired_quantity: "0" }]);
    expect(runtime.api).not.toHaveBeenCalled();
  });

  it("rolls back mapping preparation while the canonical target and variant pair is owned by a worker", async () => {
    const selected = await retainedSource(), commandKey = randomUUID(), other = await database.pool.connect();
    try {
      await other.query("SELECT pg_advisory_lock($1,$2)", [3, 102]);
      await expect(ensureEbayPublicationReady(database.pool, selected,
        { commandKey, actor: "operator", now: WALMART_INVENTORY_NOW }))
        .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_BUSY" });
      expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    } finally { await other.query("SELECT pg_advisory_unlock($1,$2)", [3, 102]); other.release(); }
    await ensureEbayPublicationReady(database.pool, selected,
      { commandKey, actor: "operator", now: WALMART_INVENTORY_NOW });
    expect(await counts()).toEqual({ mappings: 2, members: 0, updates: 2, receipts: 1, jobs: 0 });
  });

  it("rejects a stale leased quantity for the same variant without changing the destination revision", async () => {
    await ensureEbayPublicationReady(database.pool, source(),
      { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW });
    const now = (await database.pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now")).rows[0].now;
    const outbox = new PostgresInventoryPublicationOutboxRepository(database.pool);
    const [claim] = await outbox.claimDue({ batchSize: 1, leaseSeconds: 120, leaseToken: "before-mapping-preparation", now });
    expect(claim).toMatchObject({ productVariantId: 101, desiredQuantity: "17" });
    await database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=variant_qty+2 WHERE product_variant_id=101;
      UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand+2 WHERE product_variant_id=101`);
    await ensureEbayPublicationReady(database.pool, await retainedSource(),
      { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW });
    const rows = (await database.pool.query(`SELECT state,desired_quantity::text,desired_revision::text,publication_target_revision_snapshot::text
      FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND product_variant_id=101 ORDER BY desired_revision`)).rows;
    expect(rows).toEqual([
      { state: "superseded", desired_quantity: "17", desired_revision: "1", publication_target_revision_snapshot: claim.publicationTargetRevision },
      { state: "queued", desired_quantity: "19", desired_revision: "2", publication_target_revision_snapshot: claim.publicationTargetRevision },
    ]);
    const send = vi.fn();
    expect(await outbox.runIfCurrent(claim, send)).toEqual({ status: "superseded" });
    await expect(new PostgresQuantityPublicationAdmission(database.pool, () => now).runOutbox(claim, send))
      .rejects.toMatchObject({ code: "PUBLICATION_OUTBOX_AUTHORIZATION_INVALID" });
    expect(send).not.toHaveBeenCalled();
  });

  async function retainedListingSyncFixture(options: { currentPhotos?: boolean; recurringWatch?: boolean } = {}) {
    // The active pack already has a sealed connection; only the channel-excluded
    // case retained in the existing group is missing its zero-quantity mapping.
    await ensureEbayPublicationReady(database.pool, source(),
      { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW });
    const selected = await retainedSource();
    const photos = ["https://example.test/current-front.jpg", "https://example.test/current-back.jpg"];
    const item = (sku: string): EbayInventoryItem => ({ sku, condition: "NEW", product: {
      title: "Pack", description: "Description", imageUrls: options.currentPhotos && sku === "P5" ? [...photos] : [], aspects: { Style: [sku] },
    }, availability: { shipToLocationAvailability: { quantity: 999 } } });
    const items = new Map(selected.variants.map(member => [member.sku, item(member.sku)]));
    const offers = new Map<string, EbayObservedOffer>(selected.variants.map(member => [member.sku, {
      sku: member.sku, offerId: `offer-${member.sku}`, listingId: "listing-20", status: "PUBLISHED",
      marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 999, categoryId: "183454",
      merchantLocationKey: "main", listingPolicies: { fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r" },
      pricingSummary: { price: { value: "10.00", currency: "USD" } },
    }]));
    let group: EbayInventoryItemGroup = { title: "Pack", description: "Description", aspects: {},
      imageUrls: options.currentPhotos ? [...photos] : ["https://example.test/deleted.png"], variantSKUs: ["NEW", "P5"],
      variesBy: { specifications: [{ name: "Style", values: ["P5", "NEW"] }] } };
    runtime.api.mockImplementation(async (method: string, path: string, _token: string, body: unknown) => {
      const url = new URL(path, "https://example.test");
      if (method === "GET") {
        if (path.includes("/inventory_item/")) return structuredClone(items.get(decodeURIComponent(url.pathname.split("/").at(-1)!)));
        if (path.includes("/inventory_item_group/")) return structuredClone(group);
        if (path.includes("/offer?")) return { total: 1, offers: [structuredClone(offers.get(url.searchParams.get("sku")!)!)] };
        throw new Error(`Unexpected provider read ${path}`);
      }
      recordQuantityProviderResponse({ outcome: "completed", httpStatus: method === "POST" ? 200 : 204,
        requestTerminated: true, providerRequestId: null, responseHash: "a".repeat(64), errorCodes: [], retryNotBefore: null, cooldownScope: null });
      if (path.includes("bulk_update_price_quantity")) return { responses: (body as EbayBulkPriceQuantityRequest).requests.map(row => {
        const current = items.get(row.sku)!;
        const quantity = row.shipToLocationAvailability?.quantity;
        if (quantity === undefined) throw new Error("Expected the admitted canonical inventory quantity");
        items.set(row.sku, { ...current, availability: { shipToLocationAvailability: { quantity } } });
        return { sku: row.sku, statusCode: 200, offers: (row.offers ?? []).map(update => {
          if (update.availableQuantity === undefined) throw new Error("Expected the admitted canonical offer quantity");
          offers.set(row.sku, { ...offers.get(row.sku)!, availableQuantity: update.availableQuantity });
          return { offerId: update.offerId, statusCode: 200 };
        }) };
      }) };
      if (method === "PUT" && path.includes("/inventory_item/")) { items.set(decodeURIComponent(url.pathname.split("/").at(-1)!), structuredClone(body as EbayInventoryItem)); return {}; }
      if (method === "PUT" && path.includes("/inventory_item_group/")) { group = structuredClone(body as EbayInventoryItemGroup); return {}; }
      if (method === "PUT" && path.includes("/offer/")) {
        const update = body as EbayOffer; offers.set(update.sku, { ...offers.get(update.sku)!, ...structuredClone(update) }); return {};
      }
      throw new Error(`Unexpected provider mutation ${method} ${path}`);
    });
    const client = createEbayRouteListingLifecycleClient({ accessToken: "synthetic-test-token", expectedAccountId: "seller-36", expectedConnectionId: 9 });
    // Reproduce the next failure hidden by the old mapping-review UI.
    await expect(client.createOrReplaceInventoryItemGroup("PACK", group)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(runtime.api).not.toHaveBeenCalled();
    const assertInventoryReady = vi.fn((context?: { commandKey: string; actor: string }) =>
      ensureEbayListingInventoryReady(selected, context, WALMART_INVENTORY_NOW));
    const prepared: PreparedEbayListingSync = {
      identity: { channelId: 67, connectionId: 9, accountId: "seller-36", productId: 20, marketplaceId: "EBAY_US", groupKey: "PACK",
        variants: selected.variants.map(member => ({ variantId: member.productVariantId, sku: member.sku,
          externalSku: member.sku, offerId: `offer-${member.sku}`, listingId: "listing-20", contentSyncEnabled: member.productVariantId === 101 })) },
      client, assertInventoryReady,
      draft: { productId: 20, marketplaceId: "EBAY_US",
        inventoryItems: [{ sku: "P5", payload: { ...item("P5"), product: { ...item("P5").product, imageUrls: photos } } }],
        offers: [{ variantId: 101, sku: "P5", payload: offers.get("P5")! }],
        itemGroup: { groupKey: "PACK", payload: { ...group, imageUrls: photos } } },
      variants: [{ variantId: 101, sku: "P5", productName: "Pack", priceCents: 1000, priceChanged: false }],
    };
    const recovery = { reconcile: vi.fn(async () => ({ busy: false, unresolved: [] as string[], resolved: [] as string[] })) };
    const watchId = options.recurringWatch ? randomUUID() : null;
    // The automatic-recovery receipt/crash behavior is tested with its real
    // repository in the channel full-flow suite. This fixture isolates the
    // composition seam while retaining the real stock preparation owner/DB.
    const automaticRecovery = { recover: vi.fn(async () => ({
      busy: false, superseded: [] as string[], unresolved: [] as string[], watchId,
    })) };
    const execution = new EbayExistingListingSyncExecution(async () => prepared, recovery,
      new EbayMarketplaceListingConnector({ delay: async () => {}, inventoryDelayMs: 0, offerDelayMs: 0 }),
      options.recurringWatch ? automaticRecovery : undefined);
    const jobId = randomUUID();
    const context: EbayListingExecutionContext = { jobId, requestedBy: "operator", operation: "sync",
      publicationTarget: null, bindPublicationTarget: async () => {}, publicationAccepted: null,
      publicationWriteCompleted: false, publicationWriteStarted: false, publicationAcceptedRevision: null,
      publicationIntentHash: null, claimedRevision: "1", bindPublicationAccepted: async () => {} };
    const stages: string[] = [];
    const run = () => execution.execute(prepared.identity, async (key, _hash, work) => { stages.push(key); await work(); }, null, async () => {}, context);
    return { run, stages, photos, items, offers, group: () => group, jobId, assertInventoryReady, recovery, automaticRecovery, watchId };
  }

  it("updates and verifies existing group pictures after automatically preparing a channel-excluded member's missing zero mapping", async () => {
    const { run, stages, photos, items, offers, group, jobId } = await retainedListingSyncFixture();
    expect(await run()).toMatchObject({ synced: 1, errors: 0 });
    expect(stages).toContain("verification");
    expect(group()).toMatchObject({ variantSKUs: ["NEW", "P5"], imageUrls: photos });
    expect(items.get("P5")).toMatchObject({ product: { imageUrls: photos }, availability: { shipToLocationAvailability: { quantity: 17 } } });
    expect(items.get("NEW")).toMatchObject({ product: { imageUrls: [], aspects: { Style: ["NEW"] } }, availability: { shipToLocationAvailability: { quantity: 0 } } });
    expect(offers.get("NEW")).toMatchObject({ offerId: "offer-NEW", listingId: "listing-20", availableQuantity: 0 });
    const groupAttempts = (await database.pool.query<{ affected_scopes: Array<{ externalInventoryItemId: string }> }>(
      "SELECT affected_scopes FROM inventory.quantity_publication_attempts WHERE scope->>'externalInventoryItemId'='group:PACK'")).rows;
    expect(groupAttempts.length).toBeGreaterThan(0);
    for (const attempt of groupAttempts) expect(attempt.affected_scopes.map(scope => scope.externalInventoryItemId).sort())
      .toEqual(["NEW", "P5", "group:PACK"]);
    const writes = runtime.api.mock.calls.filter(call => call[0] !== "GET").length;
    // After committed mapping work and a lost local completion, retry verifies
    // current pictures. Neither mapping receipts nor provider writes duplicate.
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false");
    expect(await run()).toMatchObject({ synced: 1, errors: 0 });
    expect(runtime.api.mock.calls.filter(call => call[0] !== "GET")).toHaveLength(writes);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [jobId])).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT is_active,ebay_listing_excluded FROM catalog.product_variants WHERE id=102")).rows[0])
      .toEqual({ is_active: true, ebay_listing_excluded: true });
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE state IN ('running','uncertain')")).rows).toEqual([]);
  });

  it.each([false, true])("prepares missing retained stock even when pictures already match (crash before preparation: %s)", async crashBeforePreparation => {
    const f = await retainedListingSyncFixture({ currentPhotos: true, recurringWatch: true });
    f.recovery.reconcile.mockResolvedValueOnce({ busy: false, unresolved: ["17032"], resolved: [] });
    f.automaticRecovery.recover.mockResolvedValueOnce({ busy: false, superseded: ["17032"], unresolved: [], watchId: f.watchId });
    expect((await counts()).mappings).toBe(1);
    if (crashBeforePreparation) {
      f.assertInventoryReady.mockRejectedValueOnce(new Error("injected crash after automatic recovery committed"));
      await expect(f.run()).rejects.toThrow("injected crash after automatic recovery committed");
      expect((await counts()).mappings).toBe(1);
      expect(runtime.api.mock.calls.filter(call => call[0] !== "GET")).toEqual([]);
    }

    expect(await f.run()).toMatchObject({ synced: 1, errors: 0 });
    expect(f.stages).toContain("prepare_inventory");
    expect(f.stages).toContain("inspection");
    expect(f.assertInventoryReady).toHaveBeenLastCalledWith({ commandKey: f.jobId, actor: "operator" });
    expect(f.automaticRecovery.recover).toHaveBeenCalledTimes(crashBeforePreparation ? 2 : 1);
    // On retry terminal reconciliation no longer sees the old unknown attempt.
    // The persisted watch still requires stock preparation before completion.
    if (crashBeforePreparation) await expect(f.recovery.reconcile.mock.results[1].value).resolves.toEqual({ busy: false, unresolved: [], resolved: [] });
    expect((await database.pool.query(`SELECT product_variant_id FROM inventory.publication_variant_mapping_heads
      WHERE publication_target_id=3 AND active_mapping_id IS NOT NULL ORDER BY product_variant_id`)).rows)
      .toEqual([{ product_variant_id: 101 }, { product_variant_id: 102 }]);
    expect((await database.pool.query(`SELECT desired_quantity::text,state FROM inventory.inventory_publication_outbox
      WHERE publication_target_id=3 AND product_variant_id=102`)).rows)
      .toEqual([{ desired_quantity: "0", state: "queued" }]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [f.jobId])).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT is_active,ebay_listing_excluded FROM catalog.product_variants WHERE id=102")).rows[0])
      .toEqual({ is_active: true, ebay_listing_excluded: true });
    expect(runtime.api.mock.calls.filter(call => call[0] !== "GET")).toEqual([]);
    expect(f.group()).toMatchObject({ variantSKUs: ["NEW", "P5"], imageUrls: f.photos });
  });

  it("rolls back retained-zero preparation and then resumes the same saved command concurrently", async () => {
    const selected = await retainedSource(), commandKey = randomUUID();
    const review = await reviewEbayPublicationReadiness(database.pool, selected);
    expect(review).toMatchObject({ ready: true, variants: [
      { productVariantId: 101, desiredQuantity: "17" }, { productVariantId: 102, desiredQuantity: "0" },
    ] });
    await expect(withEbayPublicationReadinessApplied(database.pool, { source: selected, commandKey,
      contextHash: "a".repeat(64), expectedReviewHash: review.reviewHash }, "operator", WALMART_INVENTORY_NOW,
      async () => { throw new Error("follow-up failed"); })).rejects.toThrow("follow-up failed");
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    await Promise.all([1, 2].map(() => ensureEbayPublicationReady(database.pool, selected,
      { commandKey, actor: "operator", now: WALMART_INVENTORY_NOW })));
    expect(await counts()).toEqual({ mappings: 2, members: 0, updates: 2, receipts: 1, jobs: 0 });
    expect((await database.pool.query("SELECT product_variant_id,desired_quantity::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 ORDER BY product_variant_id")).rows)
      .toEqual([{ product_variant_id: 101, desired_quantity: "17" }, { product_variant_id: 102, desired_quantity: "0" }]);
    expect(runtime.api).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not enroll a Catalog-archived member in stock maintenance (retained listing: %s)", async retained => {
    if (retained) await retainedSource();
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=102");
    const selected = { ...source(), purpose: "sync" as const,
      variants: [...source().variants, { productVariantId: 102, sku: "NEW" }] };
    const review = await reviewEbayPublicationReadiness(database.pool, selected);
    expect(review.ready).toBe(false);
    expect(review.blockers).toContainEqual(expect.objectContaining({ code: "STOCK_LISTING_NOT_SELECTED", productVariantId: 102 }));
    await expect(ensureEbayPublicationReady(database.pool, selected,
      { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW }))
      .rejects.toMatchObject({ code: "STOCK_LISTING_NOT_SELECTED" });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    expect(runtime.api).not.toHaveBeenCalled();
  });

  it("does not create a retained zero for a channel-excluded member without a saved provider destination", async () => {
    await database.pool.query("UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE id=102");
    const review = await reviewEbayPublicationReadiness(database.pool, { ...source(), purpose: "sync",
      variants: [...source().variants, { productVariantId: 102, sku: "NEW" }] });
    expect(review.ready).toBe(false);
    expect(review.blockers).toContainEqual(expect.objectContaining({ code: "STOCK_LISTING_NOT_SELECTED", productVariantId: 102 }));
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    expect(runtime.api).not.toHaveBeenCalled();
  });

  it("prepares the active member without creating archive mappings or zero work for its retained sibling", async () => {
    await retainedSource();
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=102");
    const listingBefore = (await database.pool.query("SELECT * FROM channels.channel_listings WHERE product_variant_id=102")).rows;
    expect(listingBefore).toHaveLength(1);
    await ensureEbayPublicationReady(database.pool, { ...source(), purpose: "sync" },
      { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW });
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 1, receipts: 1, jobs: 0 });
    expect((await database.pool.query("SELECT product_variant_id,desired_quantity::text FROM inventory.inventory_publication_outbox WHERE publication_target_id=3")).rows)
      .toEqual([{ product_variant_id: 101, desired_quantity: "17" }]);
    expect((await database.pool.query("SELECT * FROM inventory.publication_variant_mapping_versions WHERE product_variant_id=102")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM channels.channel_listings WHERE product_variant_id=102")).rows).toEqual(listingBefore);
    expect(runtime.api).not.toHaveBeenCalled();
  });

  it("reviews the missing exact mapping without inventing IDs, then atomically creates, seals, enrolls and saves follow-up work", async () => {
    const original = source();
    const review = await reviewEbayPublicationReadiness(database.pool, original);
    expect(review).toMatchObject({ ready: true, currentlyReady: false, variants: [{ mappingAction: "create", desiredQuantity: "17" }] });
    expect(original).toEqual(source());
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    await expect(assertEbayPublicationReady(database.pool, source())).rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED" });
    const applied = await withEbayPublicationReadinessApplied(database.pool, await input(), "operator", WALMART_INVENTORY_NOW, followUp);
    expect(applied.receipt.mappingPreparation).toMatchObject({ publicationTargetId: 3, publicationRows: 1 });
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 1, receipts: 1, jobs: 1 });
    expect((await database.pool.query("SELECT desired_quantity::text,external_inventory_item_id_snapshot FROM inventory.inventory_publication_outbox WHERE publication_target_id=3")).rows)
      .toEqual([{ desired_quantity: "17", external_inventory_item_id_snapshot: "P5" }]);
    await expect(assertEbayPublicationReady(database.pool, source())).resolves.toBeUndefined();
  });
  // Channels PR4: the no-fence fast path, the update/rebuild hooks' gap read and the Card Shellz eBay link writer.
  it("ensure: only an opted-in caller takes the fast path; a publication command always gets its receipt", async () => {
    expect(await ensureEbayPublicationReady(database.pool, source(), { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW }))
      .toEqual({ alreadyReady: false });
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 1, receipts: 1, jobs: 0 });
    // Already linked exactly, fast path opted in: no fence, no new receipt.
    expect(await ensureEbayPublicationReady(database.pool, source(), { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW,
      fastPath: true })).toEqual({ alreadyReady: true });
    expect((await counts()).receipts).toBe(1);
    // A publication command (no opt-in) keeps its immutable receipt even when nothing needs linking.
    expect(await ensureEbayPublicationReady(database.pool, source(), { commandKey: randomUUID(), actor: "operator", now: WALMART_INVENTORY_NOW }))
      .toEqual({ alreadyReady: false });
    expect((await counts()).receipts).toBe(2);
  });
  it("hook gaps: an unlinked size is a gap; a linked or held size is not; another account has no destination", async () => {
    const gaps = () => readEbayStockLinkGaps(database.pool, { channelId: 67, connectionId: 9, accountId: "seller-36", variants: source().variants });
    expect(await gaps()).toEqual({ publicationTargetId: 3, productVariantIds: [101] });
    await database.pool.query(`INSERT INTO inventory.inventory_publication_target_variant_holds(publication_target_id,product_variant_id,hold_reason,held_at,held_by)
      VALUES(3,101,'Price update with a held size',now(),'operator')`);
    expect(await gaps()).toEqual({ publicationTargetId: 3, productVariantIds: [] });
    await database.pool.query("DELETE FROM inventory.inventory_publication_target_variant_holds");
    await linkChannelEbayStock(database.pool, { publicationTargetId: 3, channelId: 67, connectionId: 9, accountId: "seller-36",
      environment: "production", productId: 20, purpose: "publish", variants: source().variants,
      origin: { kind: "listing_update", key: "review-1" }, actor: "system:ebay-listing-change" }, { now: WALMART_INVENTORY_NOW, monotonicNow: () => 0 });
    expect(await gaps()).toEqual({ publicationTargetId: 3, productVariantIds: [] });
    expect(await readEbayStockLinkGaps(database.pool, { channelId: 67, connectionId: 9, accountId: "other", variants: source().variants }))
      .toEqual({ publicationTargetId: null, productVariantIds: [] });
  });
  it("link writer: links once by evidence key, replays as already linked, and returns a classified refusal as blocked", async () => {
    const request = { publicationTargetId: 3, channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production" as const,
      productId: 20, purpose: "sync" as const, variants: source().variants, origin: { kind: "background" as const, key: "101:evidence" },
      actor: "system:stock-link" };
    const first = await linkChannelEbayStock(database.pool, request, { now: WALMART_INVENTORY_NOW, monotonicNow: () => 0 });
    expect(first).toMatchObject({ status: "ready", alreadyLinked: false, commandKey: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await linkChannelEbayStock(database.pool, request, { now: WALMART_INVENTORY_NOW, monotonicNow: () => 0 }))
      .toMatchObject({ status: "ready", alreadyLinked: true, commandKey: first.commandKey });
    await database.pool.query("UPDATE channels.sync_settings SET global_enabled=false");
    expect(await linkChannelEbayStock(database.pool, { ...request, origin: { kind: "background", key: "101:other" },
      variants: [{ productVariantId: 101, sku: "OTHER" }] }, { now: WALMART_INVENTORY_NOW, monotonicNow: () => 0 }))
      .toMatchObject({ status: "blocked" });
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 1, receipts: 1, jobs: 0 });
  });
  it("Card Shellz eBay source SQL: live listings of the verified account, their eBay SKU, and outstanding listing work as a wait", async () => {
    const source = createChannelEbayStockLinkSource();
    const destination = { publicationTargetId: 3, destinationKind: "channel_connection" as const, providerKey: "ebay", channelId: 67,
      channelConnectionId: 9, dropshipStoreConnectionId: null, providerScopeType: "account" as const, externalScopeId: "seller-36", targetRevision: "1" };
    await database.pool.query(readFileSync(resolve("migrations/900000023000018880003_listing_work_settlement.sql"), "utf8"));
    expect(await source.listCandidates(database.pool, destination, 0, 500)).toEqual({ candidates: [], nextAfterVariantId: null });
    await database.pool.query("UPDATE channels.channel_listings SET external_product_id='listing-20' WHERE id=1");
    expect(await source.listCandidates(database.pool, destination, 0, 500)).toEqual({ candidates: [{ productVariantId: 101, productId: 20 }], nextAfterVariantId: null });
    expect(await source.listCarriedSkus(database.pool, destination)).toEqual([{ productVariantId: 101, sku: "P5" }]);
    expect(await source.readListings(database.pool, destination, [101, 102])).toEqual([{ productVariantId: 101, productId: 20, listingId: 1,
      vendorId: null, cardShellzSku: "P5", recordedOfferId: null, environment: "production", managed: true, skipReason: null, requireRecordedOffer: false }]);
    expect(await source.listCandidates(database.pool, { ...destination, externalScopeId: "other-seller" }, 0, 500))
      .toEqual({ candidates: [], nextAfterVariantId: null });
    // A queued Sync job of the product is listing work still owed: the size waits (never linked meanwhile).
    await database.pool.query(`INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,identity,identity_hash,
        state,requested_by,next_attempt_at,created_at,updated_at)
      VALUES('00000000-0000-4000-8000-000000000123',67,9,20,'sync','{}',repeat('a',64),'queued','operator',now(),now(),now())`);
    expect(await source.readListings(database.pool, destination, [101])).toEqual([expect.objectContaining({ productVariantId: 101, skipReason: "push_open" })]);
  });
  it("promotes the existing exact draft unchanged and replays one receipt/job under concurrent retries", async () => {
    const mappingId = await draft();
    const command = await input();
    expect(await reviewEbayPublicationReadiness(database.pool, source())).toMatchObject({ ready: true, variants: [{ mappingAction: "promote_draft" }] });
    const results = await Promise.all([1, 2].map(() => withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW, followUp)));
    expect(results.map(row => row.receipt.alreadyApplied).sort()).toEqual([false, true]);
    expect((await database.pool.query("SELECT active_mapping_id,draft_mapping_id FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=3")).rows)
      .toEqual([{ active_mapping_id: mappingId, draft_mapping_id: null }]);
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 1, receipts: 1, jobs: 1 });
    expect(await findEbayPublicationReadinessReceipt(database.pool, { channelId: 67, productId: 20, commandKey: command.commandKey, actor: "operator" })).toMatchObject({ alreadyApplied: true });
    await expect(withEbayPublicationReadinessApplied(database.pool, { ...command, contextHash: "b".repeat(64) }, "operator", WALMART_INVENTORY_NOW, followUp))
      .rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT" });
  });
  it("rolls back mapping promotion, membership, outbox and receipt when saving the publication job fails", async () => {
    const mappingId = await draft();
    await expect(withEbayPublicationReadinessApplied(database.pool, await input(), "operator", WALMART_INVENTORY_NOW,
      async () => { throw new Error("job write failed"); })).rejects.toThrow("job write failed");
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 0, receipts: 0, jobs: 0 });
    expect((await database.pool.query("SELECT active_mapping_id,draft_mapping_id FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=3")).rows)
      .toEqual([{ active_mapping_id: null, draft_mapping_id: mappingId }]);
  });
  it("rejects stock changes after review and preserves the proposed mapping", async () => {
    await draft(); const command = await input();
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=variant_qty+1 WHERE product_variant_id=101");
    await expect(withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW, followUp))
      .rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_REVIEW_STALE" });
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 0, receipts: 0, jobs: 0 });
  });
  it.each([
    ["wrong account", "UPDATE ebay.ebay_oauth_tokens SET external_account_id='other'", "STOCK_LISTING_ACCOUNT_CHANGED"],
    ["global hold", "UPDATE channels.sync_settings SET global_enabled=false", "STOCK_LISTING_GLOBAL_STOP"],
    ["ineligible variant", "UPDATE catalog.product_variants SET requires_shipping=false WHERE id=101", "STOCK_LISTING_SOURCE_CHANGED"],
    ["missing source", "UPDATE warehouse.fulfillment_nodes SET lifecycle_status='retired',retired_by='operator',retired_at=transaction_timestamp() WHERE id=1", "PUBLICATION_SOURCE_NOT_READY"],
  ])("blocks %s without changing stock enrollment", async (_label, sql, code) => {
    await database.pool.query(sql);
    const review = await reviewEbayPublicationReadiness(database.pool, source());
    expect(review.ready).toBe(false); expect(review.blockers.map(row => row.code)).toContain(code);
    if (code === "STOCK_LISTING_ACCOUNT_CHANGED")
      expect(review.blockers).toContainEqual(expect.objectContaining({ code, action: "reconnect" }));
    if (code === "STOCK_LISTING_SOURCE_CHANGED")
      expect(review.blockers).toContainEqual(expect.objectContaining({ code, action: "review_variant" }));
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
  });
  it("preserves a conflicting draft and explicit stock exclusion", async () => {
    await draft("OTHER");
    expect((await reviewEbayPublicationReadiness(database.pool, source())).blockers.map(row => row.code)).toContain("STOCK_LISTING_MAPPING_REVIEW_REQUIRED");
    await database.pool.query(`INSERT INTO inventory.publication_membership_versions(publication_target_id,product_variant_id,version,included,definition_hash,review_hash,created_by,created_at)
      VALUES(3,101,1,false,repeat('a',64),repeat('a',64),'operator',transaction_timestamp());
      INSERT INTO inventory.publication_membership_heads(publication_target_id,product_variant_id,active_version_id)
      SELECT 3,101,id FROM inventory.publication_membership_versions WHERE publication_target_id=3;`);
    expect((await reviewEbayPublicationReadiness(database.pool, source())).blockers.map(row => row.code)).not.not.toContain("STOCK_LISTING_EXCLUDED");
  });
  it("durably refuses a stale command so a late Apply cannot commit after its UUID was discarded", async () => {
    const command = await input();
    await expect(rejectEbayPublicationReadinessCommand(database.pool, { channelId: 67, productId: 20, commandKey: command.commandKey,
      actor: "operator", contextHash: command.contextHash, code: "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", message: "The source changed." }, WALMART_INVENTORY_NOW))
      .rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", definitiveRejected: true });
    await expect(withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW, followUp))
      .rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", definitiveRejected: true });
    expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    await expect(database.pool.query("DELETE FROM inventory.ebay_publication_readiness_rejections")).rejects.toThrow("append-only");
  });
  it("returns the committed receipt when Apply wins before a stale rejection", async () => {
    const command = await input();
    await withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW, followUp);
    expect(await rejectEbayPublicationReadinessCommand(database.pool, { channelId: 67, productId: 20, commandKey: command.commandKey,
      actor: "operator", contextHash: command.contextHash, code: "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", message: "The source changed." }, WALMART_INVENTORY_NOW))
      .toMatchObject({ commandKey: command.commandKey, alreadyApplied: true });
    expect((await database.pool.query("SELECT * FROM inventory.ebay_publication_readiness_rejections")).rows).toEqual([]);
  });
  it("uses the real route client, inventory admission, planner and request journal after enrollment", async () => {
    await database.pool.query(`INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,state,
      identity,identity_hash,requested_by,next_attempt_at,created_at,updated_at)
      VALUES('00000000-0000-4000-8000-000000000001',67,9,20,'publish','queued',
        '{"channelId":67,"connectionId":9,"productId":20,"variants":[{"variantId":101,"sku":"P5","offerId":"offer-P5","listingId":null},{"variantId":102,"sku":"NEW","offerId":null,"listingId":null}]}',
        repeat('a',64),'fixture',transaction_timestamp(),transaction_timestamp(),transaction_timestamp())`);
    await database.pool.query("INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty) VALUES(12,100,102,8,0,0,0)");
    const selected = { ...source(), variants: [...source().variants, { productVariantId: 102, sku: "NEW" }] };
    const item = { availability: { shipToLocationAvailability: { quantity: 999 } }, condition: "NEW" as const,
      product: { title: "Blue", description: "Blue sleeves", imageUrls: ["https://example.test/blue.jpg"], aspects: {} } };
    const group = { title: "Blue", description: "Blue sleeves", imageUrls: ["https://example.test/blue.jpg"], aspects: {},
      variantSKUs: ["P5", "NEW"], variesBy: { specifications: [{ name: "Pack", values: ["5", "New"] }] } };
    runtime.api.mockImplementation(async (method: string, path: string, _token: string, body: unknown) => {
      if (method === "GET") {
        if (path.includes("/inventory_item/")) return item;
        if (path.includes("/offer?")) { const sku = new URL(`https://example.test${path}`).searchParams.get("sku")!;
          return { total: 1, offers: [{ offerId: `offer-${sku}`, sku, status: "UNPUBLISHED" }] }; }
        throw new Error(`Unexpected read ${path}`);
      }
      recordQuantityProviderResponse({ outcome: "completed", httpStatus: method === "POST" ? 200 : 204, requestTerminated: true,
        providerRequestId: null, responseHash: "a".repeat(64), errorCodes: [], retryNotBefore: null, cooldownScope: null });
      if (path.includes("bulk_update_price_quantity")) return { responses: (body as { requests: { sku: string; offers: { offerId: string }[] }[] }).requests.map(row =>
        ({ sku: row.sku, statusCode: 200, offers: row.offers.map(offer => ({ offerId: offer.offerId, statusCode: 200 })) })) };
      if (path === "/sell/inventory/v1/offer") return { offerId: "offer-blue" };
      return {};
    });
    const client = createEbayRouteListingLifecycleClient({ accessToken: "synthetic-test-token", expectedAccountId: "seller-36", expectedConnectionId: 9 });
    await expect(assertEbayPublicationReady(database.pool, selected)).rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED" });
    expect(runtime.api).not.toHaveBeenCalled();
    await expect(client.createOrReplaceInventoryItemGroup("BLUE", group)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_TARGET_UNMAPPED" });
    expect(runtime.api).not.toHaveBeenCalled();
    await withEbayPublicationReadinessApplied(database.pool, { source: selected, commandKey: randomUUID(), contextHash: "a".repeat(64),
      expectedReviewHash: (await reviewEbayPublicationReadiness(database.pool, selected)).reviewHash }, "operator", WALMART_INVENTORY_NOW, followUp);
    await assertEbayPublicationReady(database.pool, selected);
    for (const sku of ["P5", "NEW"]) {
    await client.createOrReplaceInventoryItem(sku, item);
    await client.createOffer({ sku, marketplaceId: "EBAY_US", format: "FIXED_PRICE", availableQuantity: 999,
      categoryId: "183454", listingPolicies: { fulfillmentPolicyId: "f", paymentPolicyId: "p", returnPolicyId: "r" },
      pricingSummary: { price: { value: "10.00", currency: "USD" } }, merchantLocationKey: "main" });
    }
    await client.createOrReplaceInventoryItemGroup("BLUE", group);
    const writes = runtime.api.mock.calls.filter(call => call[0] !== "GET");
    expect(writes.some(call => call[1] === "/sell/inventory/v1/inventory_item_group/BLUE")).toBe(true);
    const inventoryWrites = writes.filter(call => call[1] === "/sell/inventory/v1/inventory_item/P5");
    expect(inventoryWrites.length).toBeGreaterThan(0);
    expect(inventoryWrites.every(call => call[3].availability.shipToLocationAvailability.quantity === 17)).toBe(true);
    expect(writes.filter(call => call[1] === "/sell/inventory/v1/inventory_item/NEW").every(call => call[3].availability.shipToLocationAvailability.quantity === 8)).toBe(true);
    expect(writes.find(call => call[1] === "/sell/inventory/v1/offer")?.[3].availableQuantity).toBe(17);
    expect(item.availability.shipToLocationAvailability.quantity).toBe(999);
    expect((await database.pool.query("SELECT state FROM inventory.quantity_publication_attempts WHERE state IN ('running','uncertain')")).rows).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_provider_request_results WHERE outcome='completed' AND request_terminated=true")).rows[0].n).toBeGreaterThanOrEqual(4);
  });
  it("takes the composed account-lock prefix before row capture and skips it on replay", async () => {
    const command = await input(); const order: string[] = [];
    const before = async (client: Parameters<typeof followUp>[0]) => {
      const locks = (await client.query(`SELECT relation::regclass::text AS relation FROM pg_locks
        WHERE pid=pg_backend_pid() AND relation IN ('ebay.ebay_oauth_tokens'::regclass,'catalog.product_variants'::regclass)`)).rows;
      expect(locks).toEqual([]); order.push("account-locks");
    };
    const callback: typeof followUp = async (client, receipt) => { order.push("job"); return followUp(client, receipt); };
    await withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW, callback, before);
    await withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW, callback, before);
    expect(order).toEqual(["account-locks", "job", "job"]);
  });
  it("serializes a concurrent stale refusal behind an in-flight successful Apply", async () => {
    const command = await input();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const applying = withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW,
      async (client, receipt) => { entered(); await gate; return followUp(client, receipt); });
    await inside;
    let rejectedSettled = false;
    const rejecting = rejectEbayPublicationReadinessCommand(database.pool, { channelId: 67, productId: 20, commandKey: command.commandKey,
      actor: "operator", contextHash: command.contextHash, code: "EBAY_PUBLICATION_STOCK_SOURCE_CHANGED", message: "Old request saw stale source." }, WALMART_INVENTORY_NOW)
      .finally(() => { rejectedSettled = true; });
    await database.pool.query("SELECT pg_sleep(0.05)");
    expect(rejectedSettled).toBe(false);
    release(); await applying;
    expect(await rejecting).toMatchObject({ commandKey: command.commandKey, alreadyApplied: true });
    expect(await counts()).toEqual({ mappings: 1, members: 0, updates: 1, receipts: 1, jobs: 1 });
  });
  it.each(["P5", "NEW"])("rolls back enrollment while exact group member %s has a busy provider scope", async sku => {
    const selected = await retainedSource();
    const command = { source: selected, commandKey: randomUUID(), contextHash: "a".repeat(64),
      expectedReviewHash: (await reviewEbayPublicationReadiness(database.pool, selected)).reviewHash };
    const other = await database.pool.connect();
    const key = quantityPublicationScopeLockKey({ destinationKind: "channel_connection", connectionId: 9, providerKey: "ebay",
      providerScopeType: "account", externalScopeId: "seller-36", externalInventoryItemId: sku, productId: null, productVariantId: null });
    try {
      await other.query("SELECT pg_advisory_lock(hashtextextended($1,$2))", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED]);
      await expect(withEbayPublicationReadinessApplied(database.pool, command, "operator", WALMART_INVENTORY_NOW, followUp))
        .rejects.toMatchObject({ code: "STOCK_MAPPING_PROVIDER_BUSY" });
      expect(await counts()).toEqual({ mappings: 0, members: 0, updates: 0, receipts: 0, jobs: 0 });
    } finally { await other.query("SELECT pg_advisory_unlock(hashtextextended($1,$2))", [key, PUBLICATION_TARGET_SCOPE_LOCK_SEED]); other.release(); }
  });
});
