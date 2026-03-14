/**
 * Integration Tests — Allocation Engine
 *
 * Tests against the real test database:
 * - Allocation with real inventory data
 * - Priority drawdown with real channel configs
 * - Audit log persistence
 * - Full flow: create product → allocate → verify ATP per channel
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  getTestDb,
  runMigrations,
  truncateTestData,
  closeTestDb,
} from "../../../../../test/setup-integration";
import { createAllocationEngine } from "../../allocation-engine.service";
import {
  channels,
  products,
  productVariants,
  productLines,
  productLineProducts,
  channelProductLines,
  channelProductAllocation,
  channelReservations,
  allocationAuditLog,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// Mock ATP service that reads from real DB
// ---------------------------------------------------------------------------

function createTestAtpService(atpData: {
  variants: Array<{
    productVariantId: number;
    sku: string;
    name: string;
    unitsPerVariant: number;
    atpUnits: number;
    atpBase: number;
  }>;
}) {
  return {
    getAtpBase: async () => atpData.variants.length > 0 ? atpData.variants[0].atpBase : 0,
    getAtpPerVariant: async () => atpData.variants,
    getAtpPerVariantByWarehouse: async () => atpData.variants,
  };
}

describe("Allocation Engine (Integration)", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    db = getTestDb();
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateTestData();
  });

  // -----------------------------------------------------------------------
  // Helper: seed test data
  // -----------------------------------------------------------------------

  async function seedProduct() {
    const [product] = await db
      .insert(products)
      .values({
        name: "Premium UV Shield Toploaders",
        sku: "TL-UV",
        status: "active",
      })
      .returning();

    const [variant100] = await db
      .insert(productVariants)
      .values({
        productId: product.id,
        name: "100ct",
        sku: "TL-UV-100",
        unitsPerVariant: 100,
        priceCents: 1499,
        isActive: true,
      })
      .returning();

    const [variant200] = await db
      .insert(productVariants)
      .values({
        productId: product.id,
        name: "200ct",
        sku: "TL-UV-200",
        unitsPerVariant: 200,
        priceCents: 2499,
        isActive: true,
      })
      .returning();

    return { product, variant100, variant200 };
  }

  async function seedChannels() {
    const [shopify] = await db
      .insert(channels)
      .values({
        name: "Card Shellz Shopify",
        type: "internal",
        provider: "shopify",
        status: "active",
        priority: 10,
        allocationPct: null,
        allocationFixedQty: null,
      })
      .returning();

    const [ebay] = await db
      .insert(channels)
      .values({
        name: "Card Shellz eBay",
        type: "internal",
        provider: "ebay",
        status: "active",
        priority: 5,
        allocationPct: null,
        allocationFixedQty: null,
      })
      .returning();

    return { shopify, ebay };
  }

  // -----------------------------------------------------------------------
  // Basic allocation with real data
  // -----------------------------------------------------------------------

  describe("allocation with real inventory data", () => {
    it("should allocate all inventory to highest priority channel (uncapped)", async () => {
      const { product, variant100 } = await seedProduct();
      const { shopify, ebay } = await seedChannels();

      const atpService = createTestAtpService({
        variants: [{
          productVariantId: variant100.id,
          sku: "TL-UV-100",
          name: "100ct",
          unitsPerVariant: 100,
          atpUnits: 10,
          atpBase: 1000,
        }],
      });

      const engine = createAllocationEngine(db, atpService);
      const result = await engine.allocateProduct(product.id, "test");

      expect(result.totalAtpBase).toBe(1000);

      const shopifyAlloc = result.allocations.find(a => a.channelId === shopify.id);
      expect(shopifyAlloc).toBeDefined();
      expect(shopifyAlloc!.allocatedUnits).toBe(10); // 1000 / 100

      const ebayAlloc = result.allocations.find(a => a.channelId === ebay.id);
      expect(ebayAlloc).toBeDefined();
      expect(ebayAlloc!.allocatedUnits).toBe(0); // Pool exhausted
    });

    it("should split inventory by percentage when configured", async () => {
      const { product, variant100 } = await seedProduct();

      // Create channels with percentage allocation
      const [shopify] = await db
        .insert(channels)
        .values({
          name: "Shopify",
          type: "internal",
          provider: "shopify",
          status: "active",
          priority: 10,
          allocationPct: 70,
        })
        .returning();

      const [ebay] = await db
        .insert(channels)
        .values({
          name: "eBay",
          type: "internal",
          provider: "ebay",
          status: "active",
          priority: 5,
          allocationPct: 30,
        })
        .returning();

      const atpService = createTestAtpService({
        variants: [{
          productVariantId: variant100.id,
          sku: "TL-UV-100",
          name: "100ct",
          unitsPerVariant: 1,
          atpUnits: 1000,
          atpBase: 1000,
        }],
      });

      const engine = createAllocationEngine(db, atpService);
      const result = await engine.allocateProduct(product.id);

      const shopifyAlloc = result.allocations.find(a => a.channelId === shopify.id);
      expect(shopifyAlloc!.allocatedUnits).toBe(700);

      const ebayAlloc = result.allocations.find(a => a.channelId === ebay.id);
      expect(ebayAlloc!.allocatedUnits).toBe(300);
    });
  });

  // -----------------------------------------------------------------------
  // Audit log persistence
  // -----------------------------------------------------------------------

  describe("audit logging", () => {
    it("should persist allocation decisions to audit log", async () => {
      const { product, variant100 } = await seedProduct();
      const { shopify } = await seedChannels();

      const atpService = createTestAtpService({
        variants: [{
          productVariantId: variant100.id,
          sku: "TL-UV-100",
          name: "100ct",
          unitsPerVariant: 1,
          atpUnits: 500,
          atpBase: 500,
        }],
      });

      const engine = createAllocationEngine(db, atpService);
      await engine.allocateProduct(product.id, "inventory_change");

      // Check audit log
      const logs = await db
        .select()
        .from(allocationAuditLog)
        .where(eq(allocationAuditLog.productId, product.id));

      expect(logs.length).toBeGreaterThan(0);

      const shopifyLog = logs.find((l: any) => l.channelId === shopify.id);
      expect(shopifyLog).toBeDefined();
      expect(shopifyLog!.totalAtpBase).toBe(500);
      expect(shopifyLog!.triggeredBy).toBe("inventory_change");
    });
  });

  // -----------------------------------------------------------------------
  // Product line gates with real DB
  // -----------------------------------------------------------------------

  describe("product line gates", () => {
    it("should block channels not carrying the product line", async () => {
      const { product, variant100 } = await seedProduct();
      const { shopify, ebay } = await seedChannels();

      // Create a product line and assign the product to it
      const [line] = await db
        .insert(productLines)
        .values({ code: "toploaders", name: "Toploaders" })
        .returning();

      await db.insert(productLineProducts).values({
        productLineId: line.id,
        productId: product.id,
      });

      // Only Shopify carries the "Toploaders" line
      await db.insert(channelProductLines).values({
        channelId: shopify.id,
        productLineId: line.id,
        isActive: true,
      });

      const atpService = createTestAtpService({
        variants: [{
          productVariantId: variant100.id,
          sku: "TL-UV-100",
          name: "100ct",
          unitsPerVariant: 1,
          atpUnits: 1000,
          atpBase: 1000,
        }],
      });

      const engine = createAllocationEngine(db, atpService);
      const result = await engine.allocateProduct(product.id);

      // Shopify should get inventory
      const shopifyAlloc = result.allocations.find(a => a.channelId === shopify.id);
      expect(shopifyAlloc!.allocatedUnits).toBe(1000);

      // eBay should be blocked
      expect(result.blocked.some(b => b.channelId === ebay.id)).toBe(true);
      const ebayAlloc = result.allocations.find(a => a.channelId === ebay.id);
      expect(ebayAlloc).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Full flow: create product → configure channels → allocate → verify
  // -----------------------------------------------------------------------

  describe("full allocation flow", () => {
    it("should allocate inventory correctly across multiple channels with different configs", async () => {
      // 1. Create product with variants
      const { product, variant100, variant200 } = await seedProduct();

      // 2. Create channels
      const [shopify] = await db
        .insert(channels)
        .values({
          name: "Shopify DTC",
          type: "internal",
          provider: "shopify",
          status: "active",
          priority: 10,
          allocationPct: 70,
        })
        .returning();

      const [ebay] = await db
        .insert(channels)
        .values({
          name: "eBay Marketplace",
          type: "internal",
          provider: "ebay",
          status: "active",
          priority: 5,
          allocationPct: 30,
        })
        .returning();

      // 3. Set up variant reservation (eBay override for 200ct)
      await db.insert(channelReservations).values({
        channelId: ebay.id,
        productVariantId: variant200.id,
        overrideQty: 50, // Fixed 50 base units on eBay for 200ct
      });

      // 4. Simulate ATP
      const atpService = createTestAtpService({
        variants: [
          {
            productVariantId: variant100.id,
            sku: "TL-UV-100",
            name: "100ct",
            unitsPerVariant: 100,
            atpUnits: 10,
            atpBase: 1000,
          },
          {
            productVariantId: variant200.id,
            sku: "TL-UV-200",
            name: "200ct",
            unitsPerVariant: 200,
            atpUnits: 5,
            atpBase: 1000,
          },
        ],
      });

      // 5. Run allocation
      const engine = createAllocationEngine(db, atpService);
      const { allocation, syncTargets } = await engine.allocateAndGetSyncTargets(
        product.id,
        "test_flow",
      );

      // 6. Verify results
      expect(allocation.totalAtpBase).toBe(1000);

      // Shopify should get 70% of pool for 100ct variant
      const shopify100 = allocation.allocations.find(
        a => a.channelId === shopify.id && a.productVariantId === variant100.id,
      );
      expect(shopify100!.allocatedUnits).toBe(7); // floor(700/100)
      expect(shopify100!.method).toBe("percentage");

      // eBay 200ct should use override
      const ebay200 = allocation.allocations.find(
        a => a.channelId === ebay.id && a.productVariantId === variant200.id,
      );
      expect(ebay200!.allocatedUnits).toBe(0); // floor(50/200) = 0
      expect(ebay200!.method).toBe("override");

      // Sync targets should be grouped by channel
      expect(syncTargets.length).toBeGreaterThan(0);
      const shopifyTarget = syncTargets.find(t => t.provider === "shopify");
      expect(shopifyTarget).toBeDefined();

      // Audit log should be written
      const logs = await db
        .select()
        .from(allocationAuditLog)
        .where(eq(allocationAuditLog.productId, product.id));
      expect(logs.length).toBeGreaterThan(0);
    });
  });
});
