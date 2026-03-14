/**
 * Unit Tests — Echelon Sync Orchestrator
 *
 * Tests the orchestration layer that wires allocation engine,
 * source lock, and channel adapters together.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEchelonSyncOrchestrator, type EchelonSyncOrchestrator } from "../../echelon-sync-orchestrator.service";
import { ChannelAdapterRegistry, type IChannelAdapter } from "../../channel-adapter.interface";

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
    chain.returning = vi.fn(() => chain);
    chain.groupBy = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    return chain;
  }

  return {
    _selectResult: [] as any[],
    _insertResult: [] as any[],
    _updateResult: [] as any[],
    select: vi.fn(function (this: any) {
      return thenableChain(this._selectResult);
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
  let orchestrator: EchelonSyncOrchestrator;

  beforeEach(() => {
    db = createMockDb();
    allocationEngine = createMockAllocationEngine();
    sourceLockService = createMockSourceLockService();
    adapterRegistry = new ChannelAdapterRegistry();
    mockAdapter = createMockAdapter();
    adapterRegistry.register(mockAdapter);
    productPushService = createMockProductPushService();
    orchestrator = createEchelonSyncOrchestrator(
      db as any,
      allocationEngine as any,
      sourceLockService as any,
      adapterRegistry,
      productPushService,
    );
  });

  // -----------------------------------------------------------------------
  // Inventory Sync
  // -----------------------------------------------------------------------

  describe("syncInventoryForProduct", () => {
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
        { id: 100, sku: "TEST-P50", shopifyVariantId: "ext-100", shopifyInventoryItemId: "inv-100" },
      ];

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

    it("should skip variants without shopifyInventoryItemId", async () => {
      db._selectResult = [
        { id: 100, sku: "TEST-P50", shopifyVariantId: "ext-100", shopifyInventoryItemId: null },
      ];

      const results = await orchestrator.syncInventoryForProduct(1, { dryRun: false });

      expect(mockAdapter.pushInventory).not.toHaveBeenCalled();
      expect(results[0].variantsSkipped).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Pricing Sync
  // -----------------------------------------------------------------------

  describe("syncPricingForChannel", () => {
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
});
