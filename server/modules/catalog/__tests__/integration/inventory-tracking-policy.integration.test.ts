import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { inventoryTrackingPolicyBaseFixture } from "../fixtures/inventory-tracking-policy.fixture";
import { PickingUseCases } from "../../../orders/picking.use-cases";
import { createShopifyProductMappingService } from "../../shopify-product-mapping.service";
import { createReservationService } from "../../../channels/reservation.service";
import { createCatalogBackfillService, type BackfillResult } from "../../../channels/catalog-backfill.service";
import { removeChannelProductIdentities, upsertChannelProductIdentity } from "../../../channels/channel-product-identity.repository";
import { PostgresInventoryAvailabilityClaimRepository } from "../../../inventory-planning/infrastructure/inventory-availability-claim.repository";
import { productMethods } from "../../catalog.storage";
import { updateProductInventoryTracking } from "../../inventory-tracking-policy.repository";
import { resolveOrderLineCatalogIdentity } from "../../../oms/order-line-catalog-identity.service";
import { createOmsService } from "../../../oms/oms.service";
import { normalizeShopifyLineItems } from "../../../oms/shopify-line-item-normalizer";
import { buildWmsLineItemFromOmsLine } from "../../../oms/wms-sync.service";
import { decideChannelFulfillmentInventoryPosting } from "../../../oms/domain/channel-fulfillment-inventory-policy";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

describeDatabase.sequential("product inventory policy migration and transactions", () => {
  let database: InventoryCutoverTestDatabase;
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  let migration: string;
  const now = new Date("2026-09-21T12:00:00Z");
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, inventoryTrackingPolicyBaseFixture);
    migration = await readFile(resolve("migrations/0693_product_inventory_tracking_policy.sql"), "utf8");
    await database.pool.query(`INSERT INTO catalog.products(id,name) VALUES(1,'Existing');
      INSERT INTO catalog.product_variants(id,product_id,name,track_inventory)
      VALUES(1,1,'Tracked',true),(2,1,'Untracked',false),(3,1,'Legacy null',null);`);
    await database.pool.query(migration);
    expect((await database.pool.query("SELECT inventory_tracking_override FROM catalog.product_variants ORDER BY id")).rows)
      .toEqual([{ inventory_tracking_override: null }, { inventory_tracking_override: false }, { inventory_tracking_override: null }]);
    orm = drizzle(database.pool, { schema });
  });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE catalog.products, catalog.product_variants, channels.channels,
      channels.channel_product_identities, channels.channel_listings, channels.channel_feeds,
      oms.oms_orders, oms.oms_order_lines, oms.oms_order_events, oms.oms_order_line_authority_events,
      wms.orders, wms.order_items, wms.picking_logs, wms.allocation_exceptions, inventory.inventory_levels, inventory.inventory_lots,
      inventory.availability_claim_lines, inventory.availability_claim_resources,
      inventory.inventory_publication_outbox, inventory.availability_runtime_authority, inventory.availability_claim_commands,
      public.audit_events RESTART IDENTITY CASCADE;
      INSERT INTO catalog.products(id,name,sku) VALUES(1,'Product','PRODUCT');
      INSERT INTO channels.channels(id,name,provider) VALUES(36,'Store','shopify'),(37,'Other store','shopify');`);
  });
  afterAll(async () => { await database?.close(); });

  const createVariant = (override?: boolean | null) => orm.transaction(tx => productMethods.createProductVariant({
    productId: 1, name: "Variant", sku: `V-${String(override).toUpperCase()}`,
    ...(override === undefined ? {} : { inventoryTrackingOverride: override }),
  }, tx));

  const importVariant = async (sku: string, requiresShipping: boolean) => {
    const result: BackfillResult = {
      success: true, dryRun: false,
      products: { total: 1, created: 0, updated: 0, skipped: 0 },
      variants: { total: 1, created: 0, updated: 0, skipped: 0 },
      feeds: { created: 0, updated: 0 }, listings: { created: 0, updated: 0 },
      pricing: { created: 0, updated: 0 }, assets: { created: 0 },
      inventory: { imported: 0, skipped: 0, noShopifyData: 0 },
      errors: [], mappingConflicts: [], mappings: [], reconciliation: [],
    };
    const imported = await orm.transaction(tx => {
      const importer = createCatalogBackfillService(tx);
      // Exercise the real per-variant import and Catalog writer without fetching
      // a remote catalog. Keep this private seam out of the production API.
      return importer["processVariant"](1, "1000", {
        id: 1001, title: "Default Title", sku, price: "1.00", compare_at_price: null,
        barcode: null, weight: null, weight_unit: null, inventory_item_id: 1002,
        requires_shipping: requiresShipping, position: 1,
        option1: null, option2: null, option3: null,
      }, 36, false, result, false, 1, 1);
    });
    expect(result.errors).toEqual([]);
    expect(imported).not.toBeNull();
    return imported!;
  };

  it.each([true, false].flatMap(productDefault => [true, false].map(requiresShipping => ({
    productDefault, requiresShipping,
  }))))("imports a new variant with product default $productDefault and shipping $requiresShipping, preserving inheritance on replay", async ({ productDefault, requiresShipping }) => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, productDefault, "user:test", now));
    const imported = await importVariant("IMPORTED", requiresShipping);
    expect(await importVariant("IMPORTED", requiresShipping)).toEqual(imported);
    expect(await orm.select().from(schema.productVariants)).toMatchObject([{
      id: imported.echelonVariantId, inventoryTrackingOverride: null,
      trackInventory: requiresShipping && productDefault, requiresShipping,
    }]);
    expect(await orm.select().from(schema.channelFeeds)).toMatchObject([{
      productVariantId: imported.echelonVariantId, isActive: requiresShipping && productDefault ? 1 : 0,
    }]);
    expect(await orm.select().from(schema.channelListings)).toHaveLength(1);
  });

  it.each([true, false].flatMap(productDefault => [null, true, false].map(override => ({
    productDefault, override,
  }))))("preserves override $override under product default $productDefault through physical, digital and physical imports", async ({ productDefault, override }) => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, productDefault, "user:test", now));
    const variant = await createVariant(override);
    for (const requiresShipping of [true, false, true]) {
      const imported = await importVariant(variant.sku!, requiresShipping);
      expect(imported.echelonVariantId).toBe(variant.id);
      const expectedTracking = requiresShipping && (override ?? productDefault);
      expect(await orm.select().from(schema.productVariants)).toMatchObject([{
        id: variant.id, inventoryTrackingOverride: override, trackInventory: expectedTracking, requiresShipping,
      }]);
      expect(await orm.select().from(schema.channelFeeds)).toMatchObject([{
        productVariantId: variant.id, isActive: expectedTracking ? 1 : 0,
      }]);
      expect(await orm.select().from(schema.channelListings)).toHaveLength(1);
    }
  });

  it("keeps binding upserts idempotent and removals scoped to their channel and product inside the caller transaction", async () => {
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'Other product')");
    const identity = { channelId: 36, productId: 1, externalProductId: "1000" };
    await orm.transaction(async tx => {
      await upsertChannelProductIdentity(tx, identity);
      await upsertChannelProductIdentity(tx, identity);
      await upsertChannelProductIdentity(tx, { ...identity, channelId: 37 });
      await upsertChannelProductIdentity(tx, { ...identity, productId: 2, externalProductId: "2000" });
      await removeChannelProductIdentities(tx, { channelId: 36, productIds: [] });
    });
    expect(await orm.select().from(schema.channelProductIdentities)).toHaveLength(3);
    await expect(orm.transaction(async tx => {
      await removeChannelProductIdentities(tx, { channelId: 36, productIds: [1] });
      throw new Error("Abort repair");
    })).rejects.toThrow("Abort repair");
    expect(await orm.select().from(schema.channelProductIdentities)).toHaveLength(3);
    await orm.transaction(tx => removeChannelProductIdentities(tx, { channelId: 36, productIds: [1] }));
    expect((await orm.select().from(schema.channelProductIdentities))
      .map(row => [row.channelId, row.productId]).sort()).toEqual([[36, 2], [37, 1]]);
  });

  it("rejects malformed bindings and competing external owners without changing the established identity", async () => {
    const identity = { channelId: 36, productId: 1, externalProductId: "1000" };
    await database.pool.query("INSERT INTO catalog.products(id,name) VALUES(2,'Other product')");
    await orm.transaction(tx => upsertChannelProductIdentity(tx, identity));
    await expect(orm.transaction(tx => upsertChannelProductIdentity(tx, { ...identity, productId: 2 })))
      .rejects.toMatchObject({ code: "23505" });
    await expect(orm.transaction(tx => upsertChannelProductIdentity(tx, { ...identity, externalProductId: " " })))
      .rejects.toMatchObject({ name: "ZodError" });
    await expect(orm.transaction(tx => removeChannelProductIdentities(tx, { channelId: 0, productIds: [1] })))
      .rejects.toMatchObject({ name: "ZodError" });
    expect(await orm.select().from(schema.channelProductIdentities)).toMatchObject([identity]);
  });

  it("inherits both defaults while explicit overrides survive product changes and migration replay", async () => {
    const inherited = await createVariant();
    const tracked = await createVariant(true);
    const untracked = await createVariant(false);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    expect((await orm.select().from(schema.productVariants).orderBy(schema.productVariants.id)).map(v => [v.id, v.trackInventory]))
      .toEqual([[inherited.id, false], [tracked.id, true], [untracked.id, false]]);
    await database.pool.query(migration);
    expect((await orm.select().from(schema.productVariants).where(eq(schema.productVariants.id, inherited.id)))[0].inventoryTrackingOverride).toBeNull();
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "user:test", now));
    expect((await orm.select().from(schema.productVariants).orderBy(schema.productVariants.id)).map(v => [v.id, v.trackInventory]))
      .toEqual([[inherited.id, true], [tracked.id, true], [untracked.id, false]]);
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(2);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "user:test", now));
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(2);
  });

  it("new variants inherit an untracked product and an explicit true overrides it", async () => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    expect(await createVariant()).toMatchObject({ trackInventory: false, inventoryTrackingOverride: null });
    expect(await createVariant(true)).toMatchObject({ trackInventory: true, inventoryTrackingOverride: true });
  });

  it("resets an explicit variant override to the product default without ambiguity", async () => {
    const variant = await createVariant(false);
    const updated = await orm.transaction(tx => productMethods.updateProductVariant(variant.id,
      { inventoryTrackingOverride: null }, tx));
    expect(updated).toMatchObject({ trackInventory: true, inventoryTrackingOverride: null });
    await expect(orm.transaction(tx => productMethods.updateProductVariant(variant.id,
      { inventoryTrackingOverride: false, trackInventory: true }, tx)))
      .rejects.toMatchObject({ code: "INVENTORY_POLICY_INVALID" });
    expect((await orm.select().from(schema.productVariants))[0]).toMatchObject({ trackInventory: true, inventoryTrackingOverride: null });
  });

  it("rejects bypassing the projection owner and rolls back a blocked family change", async () => {
    const variant = await createVariant();
    await expect(database.pool.query("UPDATE catalog.products SET inventory_tracking_default=false WHERE id=1"))
      .rejects.toMatchObject({ code: "23514" });
    await database.pool.query(`INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty)
      VALUES($1,1,2)`, [variant.id]);
    await expect(orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now)))
      .rejects.toMatchObject({ code: "INVENTORY_POLICY_HAS_DEPENDENCIES" });
    expect((await orm.select().from(schema.products))[0].inventoryTrackingDefault).toBe(true);
    expect(await orm.select().from(schema.auditEvents)).toHaveLength(0);
  });

  it("serializes a concurrent stock receipt with disabling tracking", async () => {
    const variant = await createVariant();
    const owner = await database.pool.connect();
    const receipt = await database.pool.connect();
    try {
      await owner.query("BEGIN");
      await owner.query("SELECT id FROM catalog.products WHERE id=1 FOR UPDATE");
      await owner.query("SELECT id FROM catalog.product_variants WHERE id=$1 FOR UPDATE", [variant.id]);
      await owner.query("UPDATE catalog.products SET inventory_tracking_default=false WHERE id=1");
      await owner.query("UPDATE catalog.product_variants SET track_inventory=false WHERE id=$1", [variant.id]);
      const attempt = receipt.query(`INSERT INTO inventory.inventory_levels(product_variant_id,warehouse_location_id,variant_qty)
        VALUES($1,1,1)`, [variant.id]).then(() => null, error => error);
      await owner.query("COMMIT");
      expect(await attempt).toMatchObject({ code: "23514" });
      expect(await orm.select().from(schema.inventoryLevels)).toHaveLength(0);
    } finally { await owner.query("ROLLBACK"); owner.release(); receipt.release(); }
  });

  it("matches a product without variants by channel identity despite a reused SKU, preserving policy on replay", async () => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    await database.pool.query(`INSERT INTO catalog.products(id,name) VALUES(2,'Other product');
      INSERT INTO catalog.product_variants(id,product_id,name,sku) VALUES(418,2,'Wrong item','REUSED');
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_product_id,external_variant_id)
      VALUES(36,418,'other-product','other-variant');
      INSERT INTO channels.channel_product_identities(channel_id,product_id,external_product_id) VALUES(36,1,'1000');`);
    const source = { channelId: 36, externalProductId: "1000", externalVariantId: "1001", sku: "REUSED" };
    expect(await resolveOrderLineCatalogIdentity(orm, source)).toMatchObject({ id: null, productId: 1, inventoryTracking: false, matchedBy: "channel_product_id" });
    await expect(resolveOrderLineCatalogIdentity(orm, { ...source, externalProductId: "unmapped" }))
      .rejects.toMatchObject({ code: "ORDER_LINE_PRODUCT_IDENTITY_CONFLICT" });
    expect(await resolveOrderLineCatalogIdentity(orm, { ...source, channelId: 37, sku: null })).toBeNull();
    const data = { orderedAt: now, sourceTopic: "orders/paid", sourceEventId: "fixture-paid", financialStatus: "paid",
      lineItems: normalizeShopifyLineItems([{ id: 20, product_id: 1000, variant_id: 1001, sku: "REUSED", title: "Stickers", quantity: 5, price: "1.00", requires_shipping: true }], []) };
    const service = createOmsService(orm);
    await service.ingestOrder(36, "combined-source-1", data);
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, true, "user:test", now));
    await service.ingestOrder(36, "combined-source-1", data);
    const [line] = await orm.select().from(schema.omsOrderLines);
    expect(line).toMatchObject({ productVariantId: null, catalogProductId: 1, inventoryTracking: false, quantity: 5 });
    expect((await orm.select().from(schema.omsOrderEvents)).filter(event => event.eventType === "line_catalog_identity_resolved")).toHaveLength(1);
    const item = await buildWmsLineItemFromOmsLine(orm, line, 5, 1);
    expect(item).toMatchObject({ productId: null, catalogProductId: 1, inventoryTracking: false, pickedQuantity: 0, requiresShipping: 1 });
    expect(decideChannelFulfillmentInventoryPosting({ omsRequiresShipping: true, wmsRequiresShipping: 1,
      omsInventoryTracking: line.inventoryTracking, wmsInventoryTracking: item.inventoryTracking,
      omsCatalogProductId: line.catalogProductId, wmsCatalogProductId: item.catalogProductId,
      productVariantId: null, catalogVariantId: null, catalogRequiresShipping: null, catalogTrackInventory: null,
    })).toMatchObject({ status: "resolved", requiresInventoryPosting: false });
    // An already-existing pre-migration line keeps its legacy classification on replay.
    await orm.update(schema.omsOrderLines).set({ catalogProductId: null, inventoryTracking: null });
    await service.ingestOrder(36, "combined-source-1", data);
    expect((await orm.select().from(schema.omsOrderLines))[0]).toMatchObject({ catalogProductId: null, inventoryTracking: null });
  });
  it.each([null, 69].flatMap(combinedGroupId => ["legacy", "canonical"].map(authority => ({ combinedGroupId, authority }))))(
    "confirms, replays and reverses a product-only pick in group $combinedGroupId under $authority without stock writes", async ({ combinedGroupId, authority }) => {
    await orm.transaction(tx => updateProductInventoryTracking(tx, 1, false, "user:test", now));
    const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "#63300", customerName: "Test", combinedGroupId, warehouseStatus: "ready" }).returning();
    const [item] = await orm.insert(schema.wmsOrderItems).values({ orderId: order.id, sku: "PRODUCT", name: "Stickers", quantity: 5,
      catalogProductId: 1, inventoryTracking: false, requiresShipping: 1, location: "UNASSIGNED" }).returning();
    const storage = {
      getOrderItemById: async (id: number) => (await orm.select().from(schema.wmsOrderItems).where(eq(schema.wmsOrderItems.id, id)))[0],
      getOrderById: async (id: number) => (await orm.select().from(schema.wmsOrders).where(eq(schema.wmsOrders.id, id)))[0],
      getOrderItems: async (id: number) => orm.select().from(schema.wmsOrderItems).where(eq(schema.wmsOrderItems.orderId, id)),
      getAllWarehouseSettings: async () => [],
      getUser: async () => ({ id: "picker", username: "picker", role: "picker" }),
      createPickingLog: async (row: typeof schema.pickingLogs.$inferInsert) => orm.insert(schema.pickingLogs).values(row),
      updateOrderProgress: vi.fn(async () => undefined),
      getProductVariantBySku: vi.fn(async () => undefined),
    };
    const inventoryCore = { withTx: () => inventoryCore, pickItem: vi.fn(), unpickItem: vi.fn() };
    const getLatestClaim = vi.fn();
    const runtime = authority === "canonical" ? { execute: async (work: (context: unknown) => Promise<unknown>) =>
      work({ authority: "canonical", getLatestClaim }) } : undefined;
    const service = new PickingUseCases(orm as never, inventoryCore as never, {} as never, storage as never,
      undefined, undefined, false, runtime as never);
    const request = { status: "completed", pickedQuantity: 5, userId: "picker", pickMethod: "pick_all" };
    expect(await service.pickItem(item.id, request)).toMatchObject({ success: true, item: { pickedQuantity: 5, status: "completed" } });
    expect(storage.updateOrderProgress).toHaveBeenLastCalledWith(order.id, "ready_to_ship");
    expect(await service.pickItem(item.id, request)).toMatchObject({ success: true });
    expect((await orm.select().from(schema.pickingLogs)).filter(log => log.actionType === "item_picked")).toHaveLength(1);
    expect((await orm.select().from(schema.auditEvents)).filter(event => event.action === "wms.non_inventory_pick_confirmed")).toHaveLength(1);
    expect(await service.unpickItem(item.id, { qty: 5, userId: "picker", reason: "Reconfirm physical goods" })).toMatchObject({ success: true, item: { pickedQuantity: 0 } });
    expect((await orm.select().from(schema.auditEvents)).filter(event => event.action === "wms.non_inventory_pick_reversed")).toHaveLength(1);
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(inventoryCore.unpickItem).not.toHaveBeenCalled();
    expect(getLatestClaim).not.toHaveBeenCalled();
    expect(await orm.select().from(schema.inventoryLevels)).toHaveLength(0);
    expect(await orm.select().from(schema.inventoryLots)).toHaveLength(0);
  });

  it("verifies and links a product without creating variants, and replay is idempotent", async () => {
    const verifyShopifyProduct = vi.fn(async () => ({ id: "1000", title: "Stickers", variants: [
      { id: "1001", sku: "REUSED", inventoryItemId: "1002", barcode: null },
    ] }));
    const mapping = createShopifyProductMappingService({ database: orm as never, verifyShopifyProduct });
    const request = { productId: 1, channelId: 36, targetProductId: "1000", actor: "user:catalog", allowProductOnlyAdoption: true };
    expect(await mapping.repair(request)).toMatchObject({ alreadyConsistent: false, mappedVariantCount: 0 });
    expect(verifyShopifyProduct).toHaveBeenCalledWith(36, "1000");
    expect(await orm.select().from(schema.productVariants)).toHaveLength(0);
    expect(await orm.select().from(schema.channelProductIdentities)).toMatchObject([{ productId: 1, channelId: 36, externalProductId: "1000" }]);
    expect(await mapping.repair(request)).toMatchObject({ alreadyConsistent: true });
    expect((await orm.select().from(schema.auditEvents)).filter(event => event.action === "catalog.shopify_product_mapping_repaired")).toHaveLength(1);
  });

  it("excludes a product-only physical line from legacy reservations and canonical stock claims", async () => {
    const [order] = await orm.insert(schema.wmsOrders).values({ orderNumber: "#NONSTOCK", customerName: "Test", warehouseStatus: "ready" }).returning();
    await orm.insert(schema.wmsOrderItems).values({ orderId: order.id, sku: "PRODUCT", name: "Stickers", quantity: 5,
      catalogProductId: 1, inventoryTracking: false, requiresShipping: 1 });
    const reservation = createReservationService(orm, {}, {}, {}, undefined, () => now);
    expect(await reservation.reserveOrder(order.id)).toMatchObject({ reserved: 0, promised: 0, failed: [] });
    await orm.insert(schema.inventoryAvailabilityRuntimeAuthority).values({ authority: "canonical", activationRunId: BigInt(1),
      changedBy: "test", changeReason: "Disposable policy test" });
    const claims = new PostgresInventoryAvailabilityClaimRepository({} as never, database.pool, () => now);
    const request = { orderId: order.id, idempotencyKey: "product-only-claim", actor: "test", reason: "Confirm no stock demand" };
    expect(await claims.claimOrder(request)).toMatchObject({ outcome: "no_claim_required", idempotentReplay: false });
    expect(await claims.claimOrder(request)).toMatchObject({ outcome: "no_claim_required", idempotentReplay: true });
    expect(await orm.select().from(schema.inventoryAvailabilityClaimLines)).toHaveLength(0);
    expect(await orm.select().from(schema.inventoryAvailabilityClaimResources)).toHaveLength(0);
  });

});
