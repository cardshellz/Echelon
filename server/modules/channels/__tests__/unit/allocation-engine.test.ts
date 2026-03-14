/**
 * Unit Tests — Allocation Engine
 *
 * Tests priority drawdown math, per-variant caps/floors,
 * product line gates, channel priority ordering, and override behavior.
 * Uses mocked DB and ATP service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAllocationEngine } from "../../allocation-engine.service";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDb(config: {
  activeChannels?: any[];
  productLineRows?: any[];
  channelLineRows?: any[];
  productAllocations?: any[];
  reservations?: any[];
} = {}) {
  /**
   * Creates a thenable chain that mimics Drizzle's query builder.
   * The chain is both chainable (has .from(), .where(), etc.) and
   * thenable (can be awaited directly to get the data array).
   */
  function thenableChain(data: any[]) {
    const chain: any = {};

    // Make it a thenable (Promise-compatible)
    chain.then = (resolve: any, reject?: any) => Promise.resolve(data).then(resolve, reject);
    chain.catch = (fn: any) => Promise.resolve(data).catch(fn);

    // Drizzle chain methods — all return the same thenable chain
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => chain);

    return chain;
  }

  let selectCallCount = 0;

  // Build sequence dynamically based on actual control flow:
  // 1. Active channels
  // 2. Product line products
  // 3. Channel product lines (ONLY if productLineRows is non-empty)
  // 4. Product allocations
  // 5. Reservations
  const selectSequence: any[][] = [
    config.activeChannels ?? [],       // 1: active channels
    config.productLineRows ?? [],      // 2: product line products
  ];
  if ((config.productLineRows ?? []).length > 0) {
    selectSequence.push(config.channelLineRows ?? []); // 3: channel product lines (conditional)
  }
  selectSequence.push(config.productAllocations ?? []); // 4: product allocations
  selectSequence.push(config.reservations ?? []);       // 5: reservations

  return {
    select: vi.fn(() => {
      const idx = selectCallCount;
      selectCallCount++;
      return thenableChain(selectSequence[idx] ?? []);
    }),
    insert: vi.fn(() => thenableChain([])),
    update: vi.fn(() => thenableChain([])),
    delete: vi.fn(() => thenableChain([])),
    transaction: vi.fn((fn: any) => fn({
      select: vi.fn(() => thenableChain([])),
      insert: vi.fn(() => thenableChain([])),
    })),
  };
}

function createMockAtpService(variants: any[]) {
  return {
    getAtpBase: vi.fn(async () => variants.length > 0 ? variants[0].atpBase : 0),
    getAtpPerVariant: vi.fn(async () => variants),
    getAtpPerVariantByWarehouse: vi.fn(async () => variants),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Allocation Engine", () => {
  // -----------------------------------------------------------------------
  // Basic priority drawdown
  // -----------------------------------------------------------------------

  describe("priority drawdown", () => {
    it("should allocate all inventory to highest-priority channel when uncapped", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: null, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      expect(result.totalAtpBase).toBe(1000);

      // Shopify (priority 10) should get everything
      const shopifyAlloc = result.allocations.find(a => a.channelId === 1);
      expect(shopifyAlloc?.allocatedUnits).toBe(1000);

      // eBay (priority 5) should get nothing (pool exhausted)
      const ebayAlloc = result.allocations.find(a => a.channelId === 2);
      expect(ebayAlloc?.allocatedUnits).toBe(0);
    });

    it("should split inventory by percentage allocation", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: 70, allocationFixedQty: null },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: 30, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const shopifyAlloc = result.allocations.find(a => a.channelId === 1);
      expect(shopifyAlloc?.allocatedUnits).toBe(700);
      expect(shopifyAlloc?.method).toBe("percentage");

      const ebayAlloc = result.allocations.find(a => a.channelId === 2);
      expect(ebayAlloc?.allocatedUnits).toBe(300);
      expect(ebayAlloc?.method).toBe("percentage");
    });

    it("should respect fixed quantity allocation", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: 200 },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: null, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const shopifyAlloc = result.allocations.find(a => a.channelId === 1);
      expect(shopifyAlloc?.allocatedUnits).toBe(200);
      expect(shopifyAlloc?.method).toBe("fixed");

      // eBay gets the remainder
      const ebayAlloc = result.allocations.find(a => a.channelId === 2);
      expect(ebayAlloc?.allocatedUnits).toBe(800);
    });
  });

  // -----------------------------------------------------------------------
  // Variant caps and floors
  // -----------------------------------------------------------------------

  describe("variant caps and floors", () => {
    it("should zero out when allocated qty is below variant floor", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 10, atpBase: 10 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];
      // Variant floor: minimum 50 base units
      const reservations = [
        { channelId: 1, productVariantId: 1, minStockBase: 50, maxStockBase: null, overrideQty: null },
      ];

      const db = createMockDb({ activeChannels: channels, reservations });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(0);
      expect(alloc?.method).toBe("zero");
    });

    it("should cap allocation at variant max", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];
      const reservations = [
        { channelId: 1, productVariantId: 1, minStockBase: null, maxStockBase: 500, overrideQty: null },
      ];

      const db = createMockDb({ activeChannels: channels, reservations });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // Variant overrides
  // -----------------------------------------------------------------------

  describe("variant overrides", () => {
    it("should use exact override qty and skip pool consumption", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: null, allocationFixedQty: null },
        { id: 2, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];
      const reservations = [
        { channelId: 1, productVariantId: 1, minStockBase: null, maxStockBase: null, overrideQty: 50 },
      ];

      const db = createMockDb({ activeChannels: channels, reservations });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      const ebayAlloc = result.allocations.find(a => a.channelId === 1);
      expect(ebayAlloc?.allocatedUnits).toBe(50);
      expect(ebayAlloc?.method).toBe("override");

      // Override doesn't consume from pool — Shopify still gets full pool
      const shopifyAlloc = result.allocations.find(a => a.channelId === 2);
      expect(shopifyAlloc!.allocatedUnits).toBeGreaterThan(0);
    });

    it("should handle override qty of 0 (stop selling)", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: null, allocationFixedQty: null },
      ];
      const reservations = [
        { channelId: 1, productVariantId: 1, minStockBase: null, maxStockBase: null, overrideQty: 0 },
      ];

      const db = createMockDb({ activeChannels: channels, reservations });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(0);
      expect(alloc?.method).toBe("override");
      expect(alloc?.reason).toContain("stop selling");
    });
  });

  // -----------------------------------------------------------------------
  // Product-level gates
  // -----------------------------------------------------------------------

  describe("product-level gates", () => {
    it("should zero out allocation when product is unlisted on channel", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: null, allocationFixedQty: null },
      ];
      const productAllocations = [
        { channelId: 1, productId: 1, isListed: 0, minAtpBase: null, maxAtpBase: null },
      ];

      const db = createMockDb({ activeChannels: channels, productAllocations });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(0);
      expect(alloc?.method).toBe("zero");
      expect(result.blocked.length).toBeGreaterThan(0);
    });

    it("should zero out when product ATP is below product floor", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 50, atpBase: 50 },
      ];
      const channels = [
        { id: 1, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: null, allocationFixedQty: null },
      ];
      const productAllocations = [
        { channelId: 1, productId: 1, isListed: 1, minAtpBase: 100, maxAtpBase: null },
      ];

      const db = createMockDb({ activeChannels: channels, productAllocations });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(0);
      expect(alloc?.reason).toContain("Product floor");
    });

    it("should cap allocation at product max", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];
      const productAllocations = [
        { channelId: 1, productId: 1, isListed: 1, minAtpBase: null, maxAtpBase: 300 },
      ];

      const db = createMockDb({ activeChannels: channels, productAllocations });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(300);
    });
  });

  // -----------------------------------------------------------------------
  // Product line gates
  // -----------------------------------------------------------------------

  describe("product line gates", () => {
    it("should block channels not assigned to the product's line", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: null, allocationFixedQty: null },
      ];
      // Product belongs to product line 100
      const productLineRows = [{ productLineId: 100 }];
      // Only Shopify carries product line 100
      const channelLineRows = [
        { channelId: 1, productLineId: 100 },
      ];

      const db = createMockDb({
        activeChannels: channels,
        productLineRows,
        channelLineRows,
      });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);

      // Shopify should get inventory
      const shopifyAlloc = result.allocations.find(a => a.channelId === 1);
      expect(shopifyAlloc?.allocatedUnits).toBe(1000);

      // eBay should be blocked
      const ebayAlloc = result.allocations.find(a => a.channelId === 2);
      expect(ebayAlloc).toBeUndefined(); // Not in allocations at all
      expect(result.blocked.some(b => b.channelId === 2)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-variant allocation
  // -----------------------------------------------------------------------

  describe("multi-variant allocation", () => {
    it("should handle unitsPerVariant > 1 correctly", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-50", name: "50ct", unitsPerVariant: 50, atpUnits: 20, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      // 1000 base units / 50 per variant = 20 sellable units
      expect(alloc?.allocatedUnits).toBe(20);
      expect(alloc?.allocatedBase).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("should return empty result when no variants exist", async () => {
      const db = createMockDb();
      const atp = createMockAtpService([]);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      expect(result.allocations).toHaveLength(0);
      expect(result.totalAtpBase).toBe(0);
    });

    it("should return empty result when no active channels exist", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const db = createMockDb({ activeChannels: [] });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      expect(result.allocations).toHaveLength(0);
    });

    it("should handle zero ATP gracefully", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 0, atpBase: 0 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const result = await engine.allocateProduct(1);
      const alloc = result.allocations.find(a => a.channelId === 1);
      expect(alloc?.allocatedUnits).toBe(0);
    });

    it("should not fail when audit logging throws", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 100, atpBase: 100 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      // Make insert throw to simulate audit log failure
      db.insert = vi.fn(() => {
        throw new Error("DB connection lost");
      });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      // Should not throw despite audit log failure
      const result = await engine.allocateProduct(1);
      expect(result.allocations.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Convenience methods
  // -----------------------------------------------------------------------

  describe("getAllocatedQty", () => {
    it("should return allocated units for a specific variant+channel", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: null, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const qty = await engine.getAllocatedQty(1, 1, 1);
      expect(qty).toBe(1000);
    });

    it("should return 0 for non-existent variant+channel combo", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const db = createMockDb({ activeChannels: [] });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const qty = await engine.getAllocatedQty(1, 999, 999);
      expect(qty).toBe(0);
    });
  });

  describe("allocateAndGetSyncTargets", () => {
    it("should group allocations by channel for sync", async () => {
      const variants = [
        { productVariantId: 1, sku: "TL-100", name: "100ct", unitsPerVariant: 1, atpUnits: 1000, atpBase: 1000 },
      ];
      const channels = [
        { id: 1, name: "Shopify", provider: "shopify", status: "active", priority: 10, allocationPct: 70, allocationFixedQty: null },
        { id: 2, name: "eBay", provider: "ebay", status: "active", priority: 5, allocationPct: 30, allocationFixedQty: null },
      ];

      const db = createMockDb({ activeChannels: channels });
      const atp = createMockAtpService(variants);
      const engine = createAllocationEngine(db, atp);

      const { syncTargets } = await engine.allocateAndGetSyncTargets(1);

      expect(syncTargets).toHaveLength(2);
      const shopifyTarget = syncTargets.find(t => t.provider === "shopify");
      expect(shopifyTarget?.variantAllocations).toHaveLength(1);
      expect(shopifyTarget?.variantAllocations[0].allocatedUnits).toBe(700);
    });
  });
});
