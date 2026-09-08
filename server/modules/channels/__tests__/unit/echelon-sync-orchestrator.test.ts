/**
 * Unit Tests — Echelon Sync Orchestrator
 *
 * Tests the orchestration layer that wires allocation engine,
 * source lock, and channel adapters together.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createEchelonSyncOrchestrator,
  isPermanentInventoryPushError,
  PERMANENT_FAILURE_QUARANTINE_THRESHOLD,
  type EchelonSyncOrchestrator,
} from "../../echelon-sync-orchestrator.service";
import { ChannelAdapterRegistry, type IChannelAdapter } from "../../channel-adapter.interface";
import { PgDialect } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  function thenableChain(data: any[]) {
    const chain: any = {};
    chain.then = (resolve: any, reject?: any) => Promise.resolve(data).then(resolve, reject);
    chain.catch = (fn: any) => Promise.resolve(data).catch(fn);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.onConflictDoUpdate = vi.fn(() => chain);
    chain.returning = vi.fn(() => chain);
    chain.groupBy = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    return chain;
  }

  return {
    _selectResult: [] as any[],
    _selectQueue: [] as any[][],
    _insertResult: [] as any[],
    _updateResult: [] as any[],
    select: vi.fn(function (this: any, _fields?: unknown) {
      return thenableChain(this._selectQueue.length > 0 ? this._selectQueue.shift() : this._selectResult);
    }),
    insert: vi.fn(function (this: any) {
      return thenableChain(this._insertResult);
    }),
    update: vi.fn(function (this: any) {
      return thenableChain(this._updateResult);
    }),
    delete: vi.fn(function (this: any) {
      return thenableChain([]);
    }),
    execute: vi.fn(function (this: any) {
      return Promise.resolve({ rows: this._executeResult || [{ variantId: 100 }] });
    }),
    transaction: vi.fn(async (fn: any) => fn({})),
  };
}

function createMockAllocationEngine() {
  return {
    allocateProduct: vi.fn().mockResolvedValue({
      productId: 1,
      totalAtpBase: 1000,
      allocations: [
        {
          channelId: 1,
          channelName: "Shopify DTC",
          channelProvider: "shopify",
          channelPriority: 10,
          productVariantId: 100,
          sku: "TEST-P50",
          unitsPerVariant: 50,
          allocatedUnits: 20,
          allocatedBase: 1000,
          method: "priority",
          reason: "Priority drawdown",
        },
      ],
      blocked: [],
    }),
    allocateAndGetSyncTargets: vi.fn(),
    getAllocatedQty: vi.fn(),
  };
}

function createMockSourceLockService() {
  return {
    isFieldLocked: vi.fn().mockResolvedValue(true),
    isFieldSyncable: vi.fn().mockResolvedValue(false),
    getChannelLockStatus: vi.fn().mockResolvedValue({
      inventory: true,
      pricing: true,
      variants: true,
      title: false,
      description: false,
      images: true,
    }),
    getLockedFields: vi.fn().mockResolvedValue(new Set(["inventory", "pricing", "variants", "images"])),
    getSyncableFields: vi.fn().mockResolvedValue(new Set(["title", "description"])),
    setFieldLock: vi.fn(),
    initializeChannelDefaults: vi.fn(),
    clearCache: vi.fn(),
  };
}

function createMockAdapter(): IChannelAdapter {
  return {
    adapterName: "MockShopify",
    providerKey: "shopify",
    shippingCapabilities: {
      acceptsEngineQuotes: true,
      managesOwnRates: true,
      enforcesDestinationEligibility: true,
    },
    pushListings: vi.fn().mockResolvedValue([]),
    pushInventory: vi.fn().mockResolvedValue([
      { variantId: 100, pushedQty: 20, status: "success" },
    ]),
    pushPricing: vi.fn().mockResolvedValue([
      { variantId: 100, status: "success" },
    ]),
    pullOrders: vi.fn().mockResolvedValue([]),
    receiveOrder: vi.fn().mockResolvedValue(null),
    pushFulfillment: vi.fn().mockResolvedValue([]),
    pushCancellation: vi.fn().mockResolvedValue([]),
  };
}

function createMockProductPushService() {
  return {
    getResolvedProductForChannel: vi.fn().mockResolvedValue({
      productId: 1,
      title: "Test Product",
      description: "Test description",
      category: "Supplies",
      tags: ["test"],
      status: "active",
      isListed: true,
      variants: [
        {
          id: 100,
          sku: "TEST-P50",
          name: "Pack of 50",
          barcode: null,
          gtin: null,
          mpn: null,
          weight: null,
          price: 999,
          compareAtPrice: null,
          shopifyVariantId: "ext-100",
          isListed: true,
        },
      ],
      images: [],
      shopifyProductId: "shop-1",
    }),
  };
}

function createMockAtpService() {
  return {
    getAtpPerVariantByWarehouse: vi.fn().mockResolvedValue([
      { productVariantId: 100, atpUnits: 20 }
    ]),
  };
}

function createMockInventoryPublication() {
  return {
    publishProduct: vi.fn(async (_input: unknown, legacyPublisher: () => Promise<unknown>) => ({
      authority: "legacy" as const,
      legacyResult: await legacyPublisher(),
    })),
    listProductIds: vi.fn(async (legacyReader: () => Promise<number[]>) => legacyReader()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EchelonSyncOrchestrator", () => {
  let db: ReturnType<typeof createMockDb>;
  let allocationEngine: ReturnType<typeof createMockAllocationEngine>;
  let sourceLockService: ReturnType<typeof createMockSourceLockService>;
  let adapterRegistry: ChannelAdapterRegistry;
  let mockAdapter: IChannelAdapter;
  let productPushService: ReturnType<typeof createMockProductPushService>;
  let atpService: ReturnType<typeof createMockAtpService>;
  let orchestrator: EchelonSyncOrchestrator;

  beforeEach(() => {
    db = createMockDb();
    allocationEngine = createMockAllocationEngine();
    sourceLockService = createMockSourceLockService();
    adapterRegistry = new ChannelAdapterRegistry();
    mockAdapter = createMockAdapter();
    adapterRegistry.register(mockAdapter);
    productPushService = createMockProductPushService();
    atpService = createMockAtpService();
    orchestrator = createEchelonSyncOrchestrator(
      db as any,
      allocationEngine as any,
      sourceLockService as any,
      adapterRegistry,
      productPushService,
      atpService as any,
      createMockInventoryPublication() as any,
    );
  });

  // -----------------------------------------------------------------------
  // Inventory Sync
  // -----------------------------------------------------------------------

  describe("exact publication catch-up", () => {
    const target = {
      channelId: 1, productId: 1, productVariantId: 100,
      scope: { destinationKind: "channel_connection" as const, connectionId: 4,
        providerKey: "shopify" as const, providerScopeType: "location" as const,
        externalScopeId: "11", externalInventoryItemId: "123", productId: null, productVariantId: null },
    };

    function queueScopedShopify(feed: Record<string, unknown> = {}) {
      allocationEngine.allocateProduct.mockResolvedValue({ productId: 1, totalAtpBase: 20,
        allocations: [
          { channelId: 1, channelName: "Shopify", channelProvider: "shopify", productVariantId: 100,
            sku: "P5", allocatedUnits: 20, warehouseBreakdown: [{ warehouseId: 1, qty: 7 }, { warehouseId: 2, qty: 13 }] },
          { channelId: 1, channelName: "Shopify", channelProvider: "shopify", productVariantId: 101, sku: "C25", allocatedUnits: 4 },
          { channelId: 67, channelName: "Ebay", channelProvider: "ebay", productVariantId: 100, sku: "P5", allocatedUnits: 20 },
          { channelId: 103, channelName: "Dropship OMS", channelProvider: "manual", productVariantId: 100, sku: "P5", allocatedUnits: 20 },
        ], blocked: [] } as any);
      db._selectQueue = [
        [{ warehouseId: 1, shopifyLocationId: "11" }, { warehouseId: 2, shopifyLocationId: "22" }],
        [{ id: 100, sku: "P5", requiresShipping: 1, trackInventory: 1 }],
        [{ productVariantId: 100, isActive: 1, channelVariantId: "456", channelInventoryItemId: "gid://shopify/InventoryItem/123", lastSyncedQty: 7, ...feed }],
      ];
      vi.mocked(mockAdapter.pushInventory).mockResolvedValue([{ variantId: 100, pushedQty: 7, status: "success" }]);
    }

    it("recalculates all allocations but publishes only one item/location and invalidates the aggregate watermark", async () => {
      queueScopedShopify();
      await orchestrator.syncInventoryForPublicationTarget(target);
      expect(allocationEngine.allocateProduct).toHaveBeenCalledWith(1, "quantity_publication_catchup");
      expect(mockAdapter.pushInventory).toHaveBeenCalledExactlyOnceWith(1, [expect.objectContaining({
        variantId: 100, allocatedQty: 7, externalInventoryItemId: "123",
        warehouseBreakdown: [{ warehouseId: 1, externalLocationId: "11", qty: 7 }],
      })]);
      expect(db.update.mock.results[0].value.set).toHaveBeenCalledWith(expect.objectContaining({ lastSyncedQty: null }));
    });

    it("sends zero only to the retained location when current allocation is zero", async () => {
      queueScopedShopify();
      const allocation = await allocationEngine.allocateProduct();
      allocation.allocations[0].warehouseBreakdown = [];
      allocation.allocations[0].allocatedUnits = 0;
      (db as any)._executeResult = [];
      vi.mocked(mockAdapter.pushInventory).mockResolvedValue([{ variantId: 100, pushedQty: 0, status: "success" }]);
      await orchestrator.syncInventoryForPublicationTarget(target);
      expect(mockAdapter.pushInventory).toHaveBeenCalledWith(1, [expect.objectContaining({ allocatedQty: 0,
        warehouseBreakdown: [{ warehouseId: 1, externalLocationId: "11", qty: 0 }] })]);
    });

    it("sends an explicit zero breakdown even after the last physical placement disappears", async () => {
      queueScopedShopify();
      const allocation = await allocationEngine.allocateProduct();
      allocation.allocations[0].warehouseBreakdown = [{ warehouseId: 1, qty: 0 }, { warehouseId: 2, qty: 20 }];
      (db as any)._executeResult = [];
      vi.mocked(mockAdapter.pushInventory).mockResolvedValue([{ variantId: 100, pushedQty: 0, status: "success" }]);
      await orchestrator.syncInventoryForPublicationTarget(target);
      expect(mockAdapter.pushInventory).toHaveBeenCalledWith(1, [expect.objectContaining({ allocatedQty: 0,
        warehouseBreakdown: [{ warehouseId: 1, externalLocationId: "11", qty: 0 }] })]);
    });

    it("does not invent a zero for a positive allocation with a missing warehouse plan", async () => {
      queueScopedShopify();
      const allocation = await allocationEngine.allocateProduct();
      allocation.allocations[0].warehouseBreakdown = [];
      await expect(orchestrator.syncInventoryForPublicationTarget(target)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_PLAN_INCOMPLETE" });
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
    });

    it.each([
      ["item remapped", { channelInventoryItemId: "999" }],
      ["mapping inactive", { isActive: 0 }],
      ["mapping quarantined", { quarantinedAt: new Date("2026-09-01T00:00:00Z") }],
    ])("keeps %s unresolved without sending", async (_name, feed) => {
      queueScopedShopify(feed as Record<string, unknown>);
      await expect(orchestrator.syncInventoryForPublicationTarget(target)).rejects.toBeInstanceOf(Error);
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
    });

    it("does not broaden to another warehouse if the retained location is no longer assigned", async () => {
      queueScopedShopify();
      await expect(orchestrator.syncInventoryForPublicationTarget({ ...target,
        scope: { ...target.scope, externalScopeId: "33" } })).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_LOCATION_CHANGED" });
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
    });

    it.each([{ response: [] }, { response: [{ variantId: 100, status: "skipped", pushedQty: 0 }] },
      { response: [{ variantId: 100, status: "error", pushedQty: 0, error: "Provider timeout" }] },
      { response: [{ variantId: 999, status: "success", pushedQty: 7 }] },
      { response: [{ variantId: 100, status: "success", pushedQty: 999 }] },
    ])("does not report successful catch-up for an incomplete or mismatched adapter result %#", async ({ response }) => {
      queueScopedShopify();
      vi.mocked(mockAdapter.pushInventory).mockResolvedValue(response as any);
      await expect(orchestrator.syncInventoryForPublicationTarget(target)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_FAILED" });
      expect(db.update).not.toHaveBeenCalled();
    });

    it("does not treat an omitted current allocation as delivered", async () => {
      queueScopedShopify();
      await expect(orchestrator.syncInventoryForPublicationTarget({ ...target, productVariantId: 999 })).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_PLAN_OMITTED" });
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
    });

    it("retries only the eBay SKU despite sibling SKUs, Shopify and internal manual allocations", async () => {
      queueScopedShopify();
      const ebayAdapter = { ...createMockAdapter(), adapterName: "MockEbay", providerKey: "ebay",
        pushInventory: vi.fn().mockResolvedValue([{ variantId: 100, pushedQty: 20, status: "success" }]) };
      adapterRegistry.register(ebayAdapter);
      db._selectQueue = [[], [{ productVariantId: 100, listingId: 50,
        listingExternalVariantId: "offer-100", listingExternalSku: "EXTERNAL-P5", feedLastSyncedQty: 20 }]];
      await orchestrator.syncInventoryForPublicationTarget({ ...target, channelId: 67,
        scope: { ...target.scope, connectionId: 34, providerKey: "ebay", providerScopeType: "account",
          externalScopeId: "verified-account", externalInventoryItemId: "EXTERNAL-P5" } });
      expect(ebayAdapter.pushInventory).toHaveBeenCalledExactlyOnceWith(67, [expect.objectContaining({
        variantId: 100, sku: "EXTERNAL-P5", externalVariantId: "offer-100", allocatedQty: 20,
      })]);
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
    });

    it("rejects an eBay remapping before the adapter can publish a different SKU", async () => {
      queueScopedShopify();
      const ebayAdapter = { ...createMockAdapter(), adapterName: "MockEbay", providerKey: "ebay" };
      adapterRegistry.register(ebayAdapter);
      db._selectQueue = [[], [{ productVariantId: 100, listingId: 50, listingExternalSku: "DIFFERENT" }]];
      await expect(orchestrator.syncInventoryForPublicationTarget({ ...target, channelId: 67,
        scope: { ...target.scope, connectionId: 34, providerKey: "ebay", providerScopeType: "account",
          externalScopeId: "verified-account", externalInventoryItemId: "EXTERNAL-P5" } })).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_CHANGED" });
      expect(ebayAdapter.pushInventory).not.toHaveBeenCalled();
    });
  });

  describe("syncInventoryForProduct", () => {
    function queueShopifyInventory(mapping: Record<string, unknown> | null) {
      db._selectQueue = [
        [{ warehouseId: 1, warehouseName: "Warehouse A", shopifyLocationId: "loc-1" }],
        [{ id: 100, sku: "TEST-P50", shopifyVariantId: "wrong-store-variant", shopifyInventoryItemId: "wrong-store-item" }],
        mapping ? [{ productVariantId: 100, isActive: 1, channelVariantId: "store-variant", channelInventoryItemId: "store-item", lastSyncedQty: null, ...mapping }] : [],
      ];
    }

    it("uses only this channel's inventory mapping and batches identity reads", async () => {
      queueShopifyInventory({});
      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: false });
      expect(mockAdapter.pushInventory).toHaveBeenCalledWith(1, [expect.objectContaining({
        variantId: 100, externalVariantId: "store-variant", externalInventoryItemId: "store-item",
      })]);
      expect(results[0].variantsPushed).toBe(1);
      // Three planning queries plus the existing product/feed audit lookups.
      expect(db.select).toHaveBeenCalledTimes(5);
      expect(db.select.mock.calls[1][0]).not.toHaveProperty("shopifyVariantId");
      expect(db.select.mock.calls[1][0]).not.toHaveProperty("shopifyInventoryItemId");
      const predicate = db.select.mock.results[2].value.where.mock.calls[0][0];
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toContain('"channel_feeds"."channel_id" = $1');
      expect(query.params).toEqual([1, 100]);
    });

    it.each([
      ["missing", null, "No active inventory mapping"],
      ["disabled", { isActive: 0 }, "No active inventory mapping"],
      ["missing item ID", { channelInventoryItemId: null }, "No channel inventory item ID"],
      ["quarantined", { quarantinedAt: new Date("2026-01-01T00:00:00Z") }, "Mapping quarantined"],
    ] as const)("does not use catalog IDs when the channel mapping is %s", async (_name, mapping, error) => {
      queueShopifyInventory(mapping);
      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: false });
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({ variantsSkipped: 1, variantsPushed: 0 });
      expect(results[0].details[0].error).toContain(error);
    });

    it("keeps dry runs read-only with a valid destination mapping", async () => {
      queueShopifyInventory({});
      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: true });
      expect(results[0].details[0].status).toBe("dry_run");
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("routes canonical authority only to the durable outbox result", async () => {
      const inventoryPublication = {
        publishProduct: vi.fn(async () => ({
          authority: "canonical" as const,
          publication: canonicalPublication(1),
        })),
        listProductIds: vi.fn(),
      };
      orchestrator = createEchelonSyncOrchestrator(
        db as any,
        allocationEngine as any,
        sourceLockService as any,
        adapterRegistry,
        productPushService,
        atpService as any,
        inventoryPublication as any,
      );

      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: false }, "test");

      expect(results).toEqual([expect.objectContaining({
        channelId: 1,
        variantsPushed: 0,
        variantsQueued: 1,
        variantsCoalesced: 0,
        publicationAuthority: "canonical_outbox",
        details: [expect.objectContaining({
          variantId: 100,
          allocatedQty: 4,
          status: "canonical_publication_queued",
        })],
      })]);
      expect(inventoryPublication.publishProduct).toHaveBeenCalledWith(
        { productId: 1, dryRun: false, triggeredBy: "test" },
        expect.any(Function),
      );
      expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("should run allocation and push to channel", async () => {
      // Mock DB responses for variant lookup and feed lookup
      db._selectResult = [
        { id: 100, sku: "TEST-P50", shopifyVariantId: "ext-100", shopifyInventoryItemId: "inv-100" },
      ];

      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: false }, "test");

      expect(allocationEngine.allocateProduct).toHaveBeenCalledWith(1, "test");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].channelName).toBe("Shopify DTC");
    });

    it("should NOT push to channel in dry run mode", async () => {
      db._selectResult = [
        { warehouseId: 1, shopifyLocationId: "loc-1" },
      ];
      (db as any)._executeResult = [{ variantId: 100 }];

      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: true }, "test");

      expect(allocationEngine.allocateProduct).toHaveBeenCalled();
      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
      expect(results[0].dryRun).toBe(true);
    });

    it("should handle empty allocations gracefully", async () => {
      allocationEngine.allocateProduct.mockResolvedValue({
        productId: 1,
        totalAtpBase: 0,
        allocations: [],
        blocked: [],
      });

      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: false });
      expect(results).toEqual([]);
    });

    it("should push computed eBay allocation through listing offer ids", async () => {
      const ebayAdapter: IChannelAdapter = {
        ...createMockAdapter(),
        adapterName: "MockEbay",
        providerKey: "ebay",
        pushInventory: vi.fn().mockResolvedValue([
          { variantId: 67, pushedQty: 292, status: "success" },
        ]),
      };
      adapterRegistry.register(ebayAdapter);
      allocationEngine.allocateProduct.mockResolvedValue({
        productId: 33,
        totalAtpBase: 204400,
        allocations: [
          {
            channelId: 67,
            channelName: "Ebay",
            channelProvider: "ebay",
            channelPriority: 0,
            productVariantId: 67,
            sku: "ARM-ENV-SGL-C700",
            unitsPerVariant: 700,
            allocatedUnits: 292,
            allocatedBase: 204400,
            method: "mirror",
            reason: "Mirror ATP",
          },
        ],
        blocked: [],
      });
      db._selectQueue = [
        [],
        [{
          productVariantId: 67,
          feedId: null,
          feedLastSyncedQty: null,
          channelVariantId: null,
          channelSku: null,
          channelInventoryItemId: null,
          listingId: 663,
          listingExternalVariantId: "136412217011",
          listingExternalSku: "ARM-ENV-SGL-C700",
          listingLastSyncedQty: null,
        }],
        [],
        [{ productId: 33 }],
        [],
      ];

      const results = await orchestrator.syncInventoryForProduct(33, { dryRun: false }, "test");

      expect(ebayAdapter.pushInventory).toHaveBeenCalledWith(67, [
        expect.objectContaining({
          variantId: 67,
          sku: "ARM-ENV-SGL-C700",
          externalVariantId: "136412217011",
          allocatedQty: 292,
        }),
      ]);
      expect(results[0].variantsPushed).toBe(1);
      expect(results[0].variantsErrored).toBe(0);
      expect(db.insert).toHaveBeenCalled();
    });

    it("persists a refreshed external variant id when the adapter healed a stale offer", async () => {
      const ebayAdapter: IChannelAdapter = {
        ...createMockAdapter(),
        adapterName: "MockEbay",
        providerKey: "ebay",
        pushInventory: vi.fn().mockResolvedValue([
          {
            variantId: 67,
            pushedQty: 292,
            status: "success",
            // Adapter re-resolved a dead offerId to the live one — the
            // orchestrator must write it back or every sync re-fails.
            refreshedExternalVariantId: "999888777",
          },
        ]),
      };
      adapterRegistry.register(ebayAdapter);
      allocationEngine.allocateProduct.mockResolvedValue({
        productId: 33,
        totalAtpBase: 204400,
        allocations: [
          {
            channelId: 67,
            channelName: "Ebay",
            channelProvider: "ebay",
            channelPriority: 0,
            productVariantId: 67,
            sku: "SHLZ-TOP-180PT-BLU",
            unitsPerVariant: 700,
            allocatedUnits: 292,
            allocatedBase: 204400,
            method: "mirror",
            reason: "Mirror ATP",
          },
        ],
        blocked: [],
      });
      db._selectQueue = [
        [],
        [{
          productVariantId: 67,
          feedId: null,
          feedLastSyncedQty: null,
          channelVariantId: null,
          channelSku: null,
          channelInventoryItemId: null,
          listingId: 663,
          listingExternalVariantId: "offer-stale",
          listingExternalSku: "SHLZ-TOP-180PT-BLU",
          listingLastSyncedQty: null,
        }],
        [],
        [{ productId: 33 }],
        [],
      ];

      const results = await orchestrator.syncInventoryForProduct(33, { dryRun: false }, "test");

      expect(results[0].variantsPushed).toBe(1);
      const updateSetValues = db.update.mock.results.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any[]) => c[0]),
      );
      expect(
        updateSetValues.some((v: any) => v.externalVariantId === "999888777"),
      ).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Permanent-failure quarantine (CLAUDE.md §6 — never retry a permanent error)
  // -----------------------------------------------------------------------

  describe("permanent-failure quarantine", () => {
    it("classifies gone-resource errors as permanent, transient ones as retryable", () => {
      expect(
        isPermanentInventoryPushError(
          "Shopify API POST /inventory_levels/set.json failed (404): Not Found",
        ),
      ).toBe(true);
      expect(
        isPermanentInventoryPushError("[25710] We didn't find the entity you are requesting."),
      ).toBe(true);
      expect(isPermanentInventoryPushError("[25713] This offerId is invalid.")).toBe(true);
      expect(
        isPermanentInventoryPushError("A user error has occurred. Please enter a valid offerId."),
      ).toBe(true);
      expect(
        isPermanentInventoryPushError("Shopify API POST /inventory_levels/set.json failed (500): boom"),
      ).toBe(false);
      expect(isPermanentInventoryPushError("fetch failed: ECONNRESET")).toBe(false);
      expect(isPermanentInventoryPushError(undefined)).toBe(false);
    });

    function setupEbayErrorScenario(pushError: string) {
      const ebayAdapter: IChannelAdapter = {
        ...createMockAdapter(),
        adapterName: "MockEbay",
        providerKey: "ebay",
        pushInventory: vi.fn().mockResolvedValue([
          { variantId: 67, pushedQty: 0, status: "error", error: pushError },
        ]),
      };
      adapterRegistry.register(ebayAdapter);
      allocationEngine.allocateProduct.mockResolvedValue({
        productId: 33,
        totalAtpBase: 204400,
        allocations: [
          {
            channelId: 67,
            channelName: "Ebay",
            channelProvider: "ebay",
            channelPriority: 0,
            productVariantId: 67,
            sku: "ARM-ENV-SGL-C700",
            unitsPerVariant: 700,
            allocatedUnits: 292,
            allocatedBase: 204400,
            method: "mirror",
            reason: "Mirror ATP",
          },
        ],
        blocked: [],
      });
      db._selectQueue = [
        [],
        [{
          productVariantId: 67,
          feedId: 663,
          feedLastSyncedQty: null,
          feedQuarantinedAt: null,
          channelVariantId: "offer-dead",
          channelSku: "ARM-ENV-SGL-C700",
          channelInventoryItemId: null,
          listingId: 663,
          listingExternalVariantId: "offer-dead",
          listingExternalSku: "ARM-ENV-SGL-C700",
          listingLastSyncedQty: null,
        }],
        [],
        [{ productId: 33 }],
        [],
      ];
      return ebayAdapter;
    }

    const quarantineStamps = () =>
      db.update.mock.results.flatMap((r: any) =>
        r.value.set.mock.calls.map((c: any[]) => c[0]),
      ).filter((v: any) => v.quarantinedAt instanceof Date);

    const failureCounterUpserts = () =>
      db.insert.mock.results.filter(
        (r: any) => r.value.onConflictDoUpdate.mock.calls.length > 0,
      );

    it("counts a permanent failure but does NOT quarantine below the threshold", async () => {
      setupEbayErrorScenario(
        "eBay API POST /sell/inventory/v1/bulk_update_price_quantity failed (404): [25710] not found",
      );
      db._insertResult = [{ failures: 1, quarantinedAt: null }];

      const results = await orchestrator.syncInventoryForProduct(33, { dryRun: false }, "test");

      expect(results[0].variantsErrored).toBe(1);
      expect(failureCounterUpserts().length).toBe(1);
      expect(quarantineStamps()).toEqual([]);
    });

    it("quarantines the mapping at the consecutive-failure threshold", async () => {
      setupEbayErrorScenario(
        "eBay API POST /sell/inventory/v1/bulk_update_price_quantity failed (404): [25710] not found",
      );
      db._insertResult = [
        { failures: PERMANENT_FAILURE_QUARANTINE_THRESHOLD, quarantinedAt: null },
      ];

      await orchestrator.syncInventoryForProduct(33, { dryRun: false }, "test");

      const stamps = quarantineStamps();
      expect(stamps.length).toBe(1);
      expect(stamps[0].quarantineReason).toContain("CHANNELS_PUSH_PERMANENT");
    });

    it("does not touch the failure counter on transient errors", async () => {
      setupEbayErrorScenario("eBay API POST ... failed (503): upstream unavailable");
      const results = await orchestrator.syncInventoryForProduct(33, { dryRun: false }, "test");

      expect(results[0].variantsErrored).toBe(1);
      expect(failureCounterUpserts()).toEqual([]);
      expect(quarantineStamps()).toEqual([]);
    });

    it("skips quarantined mappings without calling the adapter", async () => {
      const ebayAdapter = setupEbayErrorScenario("unused");
      db._selectQueue[1] = [
        {
          ...db._selectQueue[1][0],
          feedQuarantinedAt: new Date("2026-07-01T00:00:00Z"),
        },
      ];

      const results = await orchestrator.syncInventoryForProduct(33, { dryRun: false }, "test");

      expect(ebayAdapter.pushInventory).not.toHaveBeenCalled();
      expect(results[0].variantsSkipped).toBe(1);
      expect(results[0].variantsErrored).toBe(0);
    });

    it("should skip variants without shopifyInventoryItemId", async () => {
      db._selectResult = [
        { warehouseId: 1, shopifyLocationId: "loc-1", id: 100, sku: "TEST-P50", shopifyVariantId: "ext-100", shopifyInventoryItemId: null },
      ];
      (db as any)._executeResult = [{ variantId: 100 }];

      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: false });

      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
      expect(results[0].variantsSkipped).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Pricing Sync
  // -----------------------------------------------------------------------

  describe("syncPricingForChannel", () => {
    function queuePricing(channelId: number, externalVariantId: string | null, lastSyncedPrice: number | null = null) {
      db._selectQueue = [
        [{ id: channelId, name: `Store ${channelId}`, provider: "shopify", status: "active" }],
        [{ productVariantId: 100, variantSku: "TEST-P50", price: 999, compareAtPrice: null,
          currency: "USD", shopifyVariantId: "wrong-store-variant", listingExternalVariantId: externalVariantId,
          listingExternalSku: "STORE-SKU", listingLastSyncedPrice: lastSyncedPrice }],
      ];
    }

    it("publishes the same Echelon variant through each store's own listing ID", async () => {
      for (const channelId of [1, 2]) {
        queuePricing(channelId, `store-${channelId}-variant`);
        const result = await orchestrator.syncPricingForChannel(channelId, { dryRun: false });
        expect(result.variantsPushed).toBe(1);
        expect(mockAdapter.pushPricing).toHaveBeenCalledWith(channelId, [expect.objectContaining({
          variantId: 100, externalVariantId: `store-${channelId}-variant`, priceCents: 999,
        })]);
      }
      expect(db.select).toHaveBeenCalledTimes(4);
      const pricingQuery = db.select.mock.results[3].value;
      const join = new PgDialect().sqlToQuery(pricingQuery.leftJoin.mock.calls[0][1]);
      expect(join.sql).toContain('"channel_listings"."channel_id" = $1');
      expect(join.params).toEqual([2]);
    });

    it("skips pricing without a destination listing even when catalog Shopify ID exists", async () => {
      queuePricing(2, null);
      const result = await orchestrator.syncPricingForChannel(2, { dryRun: false });
      expect(result).toMatchObject({ variantsSkipped: 1, variantsPushed: 0 });
      expect(result.details[0].error).toContain("No external variant id");
      expect(mockAdapter.pushPricing).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("skips an unchanged mapped price without an additional per-item query", async () => {
      queuePricing(1, "store-variant", 999);
      const result = await orchestrator.syncPricingForChannel(1, { dryRun: false });
      expect(result.details[0].error).toBe("Price unchanged");
      expect(mockAdapter.pushPricing).not.toHaveBeenCalled();
      expect(db.select).toHaveBeenCalledTimes(2);
    });

    it("should check source lock before pushing pricing", async () => {
      db._selectResult = [
        { id: 1, name: "Shopify DTC", provider: "shopify", status: "active" },
      ];

      await orchestrator.syncPricingForChannel(1, { dryRun: false });

      expect(sourceLockService.isFieldLocked).toHaveBeenCalledWith(1, "pricing");
    });

    it("should skip pricing push if field is not locked", async () => {
      sourceLockService.isFieldLocked.mockResolvedValue(false);
      db._selectResult = [
        { id: 1, name: "Shopify DTC", provider: "shopify", status: "active" },
      ];

      const result = await orchestrator.syncPricingForChannel(1, { dryRun: false });

      expect(mockAdapter.pushPricing).not.toHaveBeenCalled();
      expect(result.variantsPushed).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Listings Sync
  // -----------------------------------------------------------------------

  describe("syncListingsForChannel", () => {
    it("should determine push/pull direction from source locks", async () => {
      db._selectResult = [
        { id: 1, name: "Shopify DTC", provider: "shopify", status: "active" },
      ];

      await orchestrator.syncListingsForChannel(1, { dryRun: true });

      expect(sourceLockService.getLockedFields).toHaveBeenCalledWith(1);
      expect(sourceLockService.getSyncableFields).toHaveBeenCalledWith(1);
    });
  });

  // -----------------------------------------------------------------------
  // Event-triggered sync
  // -----------------------------------------------------------------------

  describe("onInventoryChange", () => {
    it("should look up product from variant and trigger sync", async () => {
      db._selectResult = [{ productId: 1 }];

      await orchestrator.onInventoryChange(100, "receiving");

      expect(allocationEngine.allocateProduct).toHaveBeenCalledWith(1, "receiving");
    });

    it("should handle unknown variant gracefully", async () => {
      db._selectResult = [];

      const results = await orchestrator.onInventoryChange(999, "test");
      expect(results).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Full Sync
  // -----------------------------------------------------------------------

  describe("runFullSync", () => {
    it("should run inventory, pricing, and listings sync for all channels", async () => {
      // Mock active channels
      db._selectResult = [
        { id: 1, name: "Shopify DTC", provider: "shopify", status: "active" },
      ];

      const result = await orchestrator.runFullSync({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.startedAt).toBeInstanceOf(Date);
      expect(result.completedAt).toBeInstanceOf(Date);
    });
  });

  describe("syncInventoryForAllProducts", () => {
    it("uses canonical active mappings instead of legacy feed discovery", async () => {
      const inventoryPublication = {
        listProductIds: vi.fn(async () => [91]),
        publishProduct: vi.fn(async ({ productId }: { productId: number }) => ({
          authority: "canonical" as const,
          publication: canonicalPublication(productId),
        })),
      };
      orchestrator = createEchelonSyncOrchestrator(
        db as any,
        allocationEngine as any,
        sourceLockService as any,
        adapterRegistry,
        productPushService,
        atpService as any,
        inventoryPublication as any,
      );
      vi.spyOn(orchestrator as any, "delay").mockResolvedValue(undefined);

      const results = await orchestrator.syncInventoryForAllProducts({ dryRun: false }, "manual");

      expect(inventoryPublication.listProductIds).toHaveBeenCalledWith(expect.any(Function));
      expect(inventoryPublication.publishProduct).toHaveBeenCalledWith(
        { productId: 91, dryRun: false, triggeredBy: "manual" },
        expect.any(Function),
      );
      expect(results[0]).toMatchObject({ products: 1, variantsQueued: 1 });
      expect(allocationEngine.allocateProduct).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it("should include products with channel listings even when channel feeds are missing", async () => {
      allocationEngine.allocateProduct.mockResolvedValue({
        productId: 33,
        totalAtpBase: 0,
        allocations: [],
        blocked: [],
      });
      db._selectQueue = [
        [],
        [{ productId: 33 }],
      ];

      await orchestrator.syncInventoryForAllProducts({ dryRun: true }, "test");

      expect(allocationEngine.allocateProduct).toHaveBeenCalledWith(33, "test");
    });
  });
});

function canonicalPublication(productId: number) {
  return {
    authority: "canonical" as const,
    authorityRevision: "9",
    activationRunId: "44",
    dryRun: false,
    productId,
    rows: [{
      publicationTargetId: 5,
      publicationTargetRevision: "2",
      productVariantId: 100,
      sku: "TEST-P50",
      desiredQuantity: "4",
      channelId: 1,
      channelName: "Shopify DTC",
      channelConnectionId: 33,
      providerKey: "shopify",
      providerScopeType: "location" as const,
      externalScopeId: "location-1",
      externalInventoryItemId: "inventory-item-100",
      externalSku: "TEST-P50",
      sourceWarehouseIds: [1],
      blockerCodes: [],
    }],
    enqueuedRows: 1,
    coalescedRows: 0,
    enqueuedPublicationKeys: ["5:100"],
    coalescedPublicationKeys: [],
  };
}
