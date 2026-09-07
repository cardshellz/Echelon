import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { channelConnections, channelFeeds, channelListings, channels, inventoryLevels, inventoryTransactions, products, productVariants, warehouses, warehouseLocations } from "@shared/schema";
import { InventoryUseCases } from "../../../inventory/application/inventory.use-cases";
import { createInventoryMethods } from "../../../inventory/infrastructure/inventory.repository";
import { createSessionAdvisoryLockRunner } from "../../../../infrastructure/session-advisory-lock";
import { closeTestDb, describeWithDisposableDb, getTestDb, getTestPool, runMigrations, truncateTestData } from "../../../../../test/setup-integration";
import { ChannelIdentityService } from "../../channel-identity.service";
import { ChannelIdentityRepairService } from "../../channel-identity-repair.service";
import { ShopifyIdentityReader } from "../../adapters/shopify-identity.reader";

describeWithDisposableDb("Channel identity PostgreSQL guarantees", () => {
  const clock = () => new Date("2026-09-07T12:00:00.000Z");
  let db: ReturnType<typeof getTestDb>;
  let channelId: number;
  let otherChannelId: number;
  let variantId: number;
  let feedId: number;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  let service: ChannelIdentityRepairService;
  const providerResponse = () => new Response(JSON.stringify({ variant: {
    id: "101", product_id: "201", inventory_item_id: "301", sku: "SHARED-SKU",
  } }));
  const preview = async () => (await service.preview(channelId, [feedId])).plans[0];
  const apply = async (key = "apply") => service.apply({ channelId, feedId,
    expectedHash: (await preview()).expectedHash, actor: "user:test-operator", idempotencyKey: key });
  const feeds = () => db.select().from(channelFeeds).orderBy(channelFeeds.id);

  beforeAll(async () => {
    db = getTestDb();
    await runMigrations();
    for (const path of ["test/fixtures/channel-identity-integration.sql", "migrations/136_financial_command_results.sql", "migrations/140_financial_command_operations.sql"]) {
      await getTestPool().query(readFileSync(resolve(process.cwd(), path), "utf8"));
    }
  }, 30_000);
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await truncateTestData();
    await getTestPool().query("TRUNCATE public.financial_command_results, public.audit_events RESTART IDENTITY CASCADE");
    await getTestPool().query("DELETE FROM inventory.availability_runtime_authority; INSERT INTO inventory.availability_runtime_authority DEFAULT VALUES");
    [channelId, otherChannelId] = (await db.insert(channels).values([
      { name: "First store", type: "internal", provider: "shopify", status: "active" },
      { name: "Second store", type: "internal", provider: "shopify", status: "active" },
    ]).returning()).map((row) => row.id);
    await db.insert(channelConnections).values([
      { channelId, shopDomain: "first-store.myshopify.com", accessToken: "test-first", apiVersion: "2024-01", shopifyLocationId: "10" },
      { channelId: otherChannelId, shopDomain: "second-store.myshopify.com", accessToken: "test-second", apiVersion: "2024-01", shopifyLocationId: "20" },
    ]);
    const [product] = await db.insert(products).values({ name: "Shared product" }).returning({ id: products.id });
    const [variant] = await db.insert(productVariants).values({ productId: product.id, name: "Each", sku: "SHARED-SKU" }).returning({ id: productVariants.id });
    variantId = variant.id;
    const saved = await db.insert(channelFeeds).values([
      { channelId, productVariantId: variantId, channelVariantId: "101", channelProductId: "wrong", channelSku: "OLD", channelInventoryItemId: null },
      { channelId: otherChannelId, productVariantId: variantId, channelVariantId: "102", channelProductId: "202", channelSku: "SHARED-SKU", channelInventoryItemId: "302" },
    ]).returning();
    feedId = saved[0].id;
    await db.insert(channelListings).values({ channelId, productVariantId: variantId, externalVariantId: "101", externalProductId: "201", externalSku: "SHARED-SKU" });
    request = vi.fn<typeof fetch>().mockImplementation(async () => providerResponse());
    service = new ChannelIdentityRepairService(db as never, new ShopifyIdentityReader(request), clock);
  });

  it("previews without writes, repairs only one store, and replays the exact durable result", async () => {
    const before = await feeds();
    const plan = await preview();
    expect(plan).toMatchObject({ action: "repair", evidence: { inventory_item_id: "301" } });
    expect(await feeds()).toEqual(before);
    expect((await getTestPool().query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(0);
    const command = { channelId, feedId, expectedHash: plan.expectedHash, actor: "user:test-operator", idempotencyKey: "exact-replay" };
    const result = await service.apply(command);
    expect(result).toMatchObject({ terminalState: "succeeded", replayed: false, body: { action: "repair", after: { channelInventoryItemId: "301" } } });
    const replay = await service.apply(command);
    expect(replay).toEqual({ ...result, replayed: true });
    expect(request).toHaveBeenCalledTimes(2);
    expect((await feeds())[1]).toEqual(before[1]);
    expect((await getTestPool().query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(1);
  });

  it("rejects changed provider evidence and stale database previews without writes", async () => {
    const plan = await preview();
    await db.update(channelFeeds).set({ channelSku: "OPERATOR-EDIT" }).where(eq(channelFeeds.id, feedId));
    const before = await feeds();
    expect(await service.apply({ channelId, feedId, expectedHash: plan.expectedHash, actor: "user:test", idempotencyKey: "stale" }))
      .toMatchObject({ terminalState: "rejected", body: { code: "CHANNEL_IDENTITY_PREVIEW_STALE" } });
    expect(await feeds()).toEqual(before);
    const fresh = await preview();
    request.mockImplementation(async () => new Response(JSON.stringify({ variant: { id: "101", product_id: "201", inventory_item_id: "999", sku: "SHARED-SKU" } })));
    expect(await service.apply({ channelId, feedId, expectedHash: fresh.expectedHash, actor: "user:test", idempotencyKey: "provider-stale" }))
      .toMatchObject({ terminalState: "rejected", body: { code: "CHANNEL_IDENTITY_PREVIEW_STALE" } });
    expect(await feeds()).toEqual(before);
  });

  it("rolls back both mappings when audit persistence fails", async () => {
    const before = await feeds();
    const listingsBefore = await db.select().from(channelListings);
    await getTestPool().query("ALTER TABLE public.audit_events ADD CONSTRAINT test_reject_identity_audit CHECK (action <> 'channel_identity.repair')");
    try { await expect(apply()).rejects.toMatchObject({ code: "23514", constraint: "test_reject_identity_audit" }); }
    finally { await getTestPool().query("ALTER TABLE public.audit_events DROP CONSTRAINT test_reject_identity_audit"); }
    expect(await feeds()).toEqual(before);
    expect(await db.select().from(channelListings)).toEqual(listingsBefore);
    expect((await getTestPool().query("SELECT status FROM public.financial_command_results")).rows).toEqual([{ status: "retryable" }]);
  });

  it("disables a missing destination without touching another store or recreating a product", async () => {
    request.mockImplementation(async () => new Response(null, { status: 404 }));
    const before = await feeds();
    expect(await apply()).toMatchObject({ terminalState: "succeeded", body: { action: "disable", after: { isActive: 0, quarantineReason: "DESTINATION_VARIANT_MISSING" } } });
    expect((await feeds())[1]).toEqual(before[1]);
    expect((await db.select().from(channelListings))[0].syncStatus).toBe("requires_review");
    expect(request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it("recovers from a JSONB receipt into disabled review state, with idempotent replay", async () => {
    const result = await apply();
    const command = { channelId, applyCommandId: result.commandId, actor: "user:test-operator", idempotencyKey: "recover" };
    const recovered = await service.recover(command);
    expect(recovered).toMatchObject({ terminalState: "succeeded", body: { status: "recovered_disabled", after: { channelInventoryItemId: null, isActive: 0, quarantineReason: "IDENTITY_REPAIR_RECOVERY_REVIEW" } } });
    expect(await service.recover(command)).toEqual({ ...recovered, replayed: true });
    await expect(new ChannelIdentityService(db, new ShopifyIdentityReader(request), clock).ensureShopifyFeed({ channelId, productVariantId: variantId, sku: "SHARED-SKU", actor: "test" }))
      .rejects.toMatchObject({ code: "CHANNEL_LISTING_REQUIRES_REVIEW" });
  });

  it("refuses recovery over an intervening mapping edit", async () => {
    const result = await apply();
    await db.update(channelFeeds).set({ channelSku: "LATER-EDIT" }).where(eq(channelFeeds.id, feedId));
    const before = await feeds();
    expect(await service.recover({ channelId, applyCommandId: result.commandId, actor: "user:test", idempotencyKey: "recover-stale" }))
      .toMatchObject({ terminalState: "rejected", body: { code: "CHANNEL_RECOVERY_STALE" } });
    expect(await feeds()).toEqual(before);
  });

  it("serializes competing repair commands so only one applies", async () => {
    const plan = await preview();
    const results = await Promise.all(["one", "two"].map((idempotencyKey) => service.apply({ channelId, feedId, expectedHash: plan.expectedHash, actor: "user:test", idempotencyKey })));
    expect(results.map((result) => result.terminalState).sort()).toEqual(["rejected", "succeeded"]);
    expect((await getTestPool().query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(1);
  });

  it("serializes concurrent feed creation without duplicate mappings or audits", async () => {
    await db.delete(channelFeeds).where(eq(channelFeeds.id, feedId));
    const identities = new ChannelIdentityService(db, new ShopifyIdentityReader(request), clock);
    const command = { channelId, productVariantId: variantId, sku: "SHARED-SKU", actor: "test" };
    const results = await Promise.all([identities.ensureShopifyFeed(command), identities.ensureShopifyFeed(command)]);
    expect(results[0].id).toBe(results[1].id);
    expect((await getTestPool().query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(1);
  });

  it("blocks repairs when canonical runtime or an active target owns publication", async () => {
    await getTestPool().query("UPDATE inventory.availability_runtime_authority SET authority = 'canonical'");
    expect(await apply("canonical")).toMatchObject({ terminalState: "rejected", body: { code: "CHANNEL_IDENTITY_AUTHORITY_BLOCKED" } });
    await getTestPool().query("UPDATE inventory.availability_runtime_authority SET authority = 'legacy'");
    await getTestPool().query("INSERT INTO inventory.inventory_publication_targets (channel_id, state) VALUES ($1, 'active')", [channelId]);
    expect(await apply("target")).toMatchObject({ terminalState: "rejected", body: { code: "CHANNEL_IDENTITY_AUTHORITY_BLOCKED" } });
    expect((await feeds())[0].channelInventoryItemId).toBeNull();
  });

  it("rejects a duplicate external owner without changing either internal mapping", async () => {
    const [original] = await db.select().from(productVariants).where(eq(productVariants.id, variantId));
    const [other] = await db.insert(productVariants).values({ productId: original.productId, name: "Other", sku: "OTHER" }).returning();
    await db.insert(channelFeeds).values({ channelId, productVariantId: other.id, channelVariantId: "103", channelInventoryItemId: "301" });
    const before = await feeds();
    expect(await apply()).toMatchObject({ terminalState: "rejected", body: { code: "CHANNEL_IDENTITY_CONFLICT" } });
    expect(await feeds()).toEqual(before);
  });

  it("preserves disabled mappings and refuses to clear an existing quarantine", async () => {
    await db.update(channelFeeds).set({ isActive: 0 }).where(eq(channelFeeds.id, feedId));
    expect(await apply()).toMatchObject({ terminalState: "succeeded", body: { after: { isActive: 0 } } });
    await db.update(channelFeeds).set({ quarantinedAt: clock(), quarantineReason: "PREEXISTING" }).where(eq(channelFeeds.id, feedId));
    expect(await preview()).toMatchObject({ action: "blocked", code: "QUARANTINED_MAPPING_REQUIRES_REVIEW" });
    expect(await apply("quarantined")).toMatchObject({ terminalState: "rejected" });
    expect((await feeds())[0].quarantineReason).toBe("PREEXISTING");
  });

  it("keeps a temporary provider failure retryable instead of disabling a mapping", async () => {
    const plan = await preview();
    const before = await feeds();
    request.mockImplementation(async () => new Response(null, { status: 429 }));
    await expect(service.apply({ channelId, feedId, expectedHash: plan.expectedHash, actor: "user:test", idempotencyKey: "throttled" }))
      .rejects.toMatchObject({ failureClass: "transient", code: "SHOPIFY_IDENTITY_READ_REJECTED" });
    expect(await feeds()).toEqual(before);
    expect((await getTestPool().query("SELECT status FROM public.financial_command_results")).rows).toEqual([{ status: "retryable" }]);
  });

  it("imports the same internal variant through independent store and location identities", async () => {
    await apply();
    request.mockImplementation(async (url) => {
      const first = String(url).includes("first-store");
      return new Response(JSON.stringify({ inventory_levels: [{ inventory_item_id: first ? "301" : "302", location_id: first ? "10" : "20", available: first ? 4 : 9 }] }));
    });
    const identities = new ChannelIdentityService(db, new ShopifyIdentityReader(request), clock);
    const first = await identities.externalInventory(channelId);
    const second = await identities.externalInventory(otherChannelId);
    expect(first.items).toEqual([{ externalInventoryItemId: "301", productVariantId: variantId, quantity: 4 }]);
    expect(second.items).toEqual([{ externalInventoryItemId: "302", productVariantId: variantId, quantity: 9 }]);
    await db.transaction(async (tx) => { await new ChannelIdentityService(tx).validateInventorySnapshot(first); });
    await db.update(channelFeeds).set({ isActive: 0 }).where(eq(channelFeeds.id, feedId));
    await expect(db.transaction(async (tx) => new ChannelIdentityService(tx).validateInventorySnapshot(first)))
      .rejects.toMatchObject({ code: "CHANNEL_IDENTITY_CHANGED" });
  });

  it("writes warehouse stock and its ledger atomically, serializes retries, and notifies only after commit", async () => {
    await apply();
    const [warehouse] = await db.insert(warehouses).values({ code: "SOURCE", name: "External source", inventorySourceType: "channel", inventorySourceConfig: { channelId } }).returning();
    const lock = createSessionAdvisoryLockRunner(getTestPool());
    const identities = new ChannelIdentityService(db, new ShopifyIdentityReader(request), clock);
    request.mockImplementation(async () => new Response(JSON.stringify({ inventory_levels: [{ inventory_item_id: "301", location_id: "10", available: 4 }] })));
    const inventory = new InventoryUseCases(db, createInventoryMethods(db), null, null, {
      clock, read: async () => identities.externalInventory(channelId),
      validateSnapshot: (tx, snapshot) => new ChannelIdentityService(tx).validateInventorySnapshot(snapshot),
      withWarehouseLock: (warehouseId, work) => lock({ namespace: 731903, key: warehouseId, label: "inventory.external_source_import" }, work),
    });
    const committedReads: Array<Promise<number>> = [];
    inventory.onInventoryChange(() => { committedReads.push(getTestPool().query("SELECT count(*)::int AS count FROM inventory.inventory_transactions").then((result) => result.rows[0].count)); });
    const results = await Promise.all([inventory.syncWarehouse(warehouse.id), inventory.syncWarehouse(warehouse.id)]);
    expect(results).toEqual([expect.objectContaining({ synced: 1, errors: [] }), expect.objectContaining({ synced: 1, errors: [] })]);
    expect(await Promise.all(committedReads)).toEqual([1]);
    expect(await db.select({ quantity: inventoryLevels.variantQty }).from(inventoryLevels)).toEqual([{ quantity: 4 }]);
    expect(await db.select({ delta: inventoryTransactions.variantQtyDelta }).from(inventoryTransactions)).toEqual([{ delta: 4 }]);
  });

  it("rolls back an entire import batch when its later item would consume reserved stock", async () => {
    await apply();
    const [firstVariant] = await db.select().from(productVariants).where(eq(productVariants.id, variantId));
    const [secondVariant] = await db.insert(productVariants).values({ productId: firstVariant.productId, name: "Second", sku: "SECOND" }).returning();
    await db.insert(channelFeeds).values({ channelId, productVariantId: secondVariant.id, channelVariantId: "103", channelInventoryItemId: "303" });
    const [warehouse] = await db.insert(warehouses).values({ code: "RESERVED", name: "External source", inventorySourceType: "channel", inventorySourceConfig: { channelId } }).returning();
    const [location] = await db.insert(warehouseLocations).values({ warehouseId: warehouse.id, code: "RESERVED-VIRTUAL", name: "Virtual", locationType: "3pl_virtual" }).returning();
    await db.insert(inventoryLevels).values([
      { warehouseLocationId: location.id, productVariantId: variantId, variantQty: 10 },
      { warehouseLocationId: location.id, productVariantId: secondVariant.id, variantQty: 10, reservedQty: 5 },
    ]);
    request.mockImplementation(async () => new Response(JSON.stringify({ inventory_levels: [
      { inventory_item_id: "301", location_id: "10", available: 4 }, { inventory_item_id: "303", location_id: "10", available: 2 },
    ] })));
    const identities = new ChannelIdentityService(db, new ShopifyIdentityReader(request), clock);
    const lock = createSessionAdvisoryLockRunner(getTestPool());
    const inventory = new InventoryUseCases(db, createInventoryMethods(db), null, null, {
      clock, read: async () => identities.externalInventory(channelId),
      validateSnapshot: (tx, snapshot) => new ChannelIdentityService(tx).validateInventorySnapshot(snapshot),
      withWarehouseLock: (warehouseId, work) => lock({ namespace: 731903, key: warehouseId, label: "inventory.external_source_import" }, work),
    });
    const notified = vi.fn();
    inventory.onInventoryChange(notified);
    const result = await inventory.syncWarehouse(warehouse.id);
    expect(result.synced).toBe(0);
    expect(result.errors).toEqual([expect.stringContaining("below reserved stock")]);
    expect(await db.select({ quantity: inventoryLevels.variantQty }).from(inventoryLevels)).toEqual([{ quantity: 10 }, { quantity: 10 }]);
    expect(await db.select().from(inventoryTransactions)).toEqual([]);
    expect(notified).not.toHaveBeenCalled();
  });
});
