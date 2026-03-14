/**
 * Unit Tests — Catalog Backfill Service
 *
 * Tests the Shopify → Echelon catalog import/sync job.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCatalogBackfillService, type CatalogBackfillService } from "../../catalog-backfill.service";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function createMockDb() {
  const mockData: Record<string, any[]> = {};
  let selectResult: any[] = [];

  function thenableChain(data: any[]) {
    const chain: any = {};
    chain.then = (resolve: any, reject?: any) => Promise.resolve(data).then(resolve, reject);
    chain.catch = (fn: any) => Promise.resolve(data).catch(fn);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => {
      // Return a thenable with mock data for inserts
      return thenableChain([{ id: Math.floor(Math.random() * 10000) }]);
    });
    chain.innerJoin = vi.fn(() => chain);
    chain.groupBy = vi.fn(() => chain);
    return chain;
  }

  return {
    _selectResult: [] as any[],
    select: vi.fn(function (this: any) {
      return thenableChain(this._selectResult);
    }),
    insert: vi.fn(function (this: any) {
      return thenableChain([]);
    }),
    update: vi.fn(function (this: any) {
      return thenableChain([{ id: 1 }]);
    }),
    delete: vi.fn(function (this: any) {
      return thenableChain([]);
    }),
    transaction: vi.fn(async (fn: any) => fn({})),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CatalogBackfillService", () => {
  let db: ReturnType<typeof createMockDb>;
  let service: CatalogBackfillService;

  beforeEach(() => {
    db = createMockDb();
    service = createCatalogBackfillService(db as any);
  });

  it("should return error if channel not found", async () => {
    db._selectResult = []; // No channel found

    const result = await service.run({ channelId: 999 });

    expect(result.success).toBe(false);
    expect(result.errors).toContain("Channel 999 not found");
  });

  it("should return error if channel is not Shopify", async () => {
    db._selectResult = [{ id: 1, name: "eBay", provider: "ebay", status: "active" }];

    const result = await service.run({ channelId: 1 });

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('expected "shopify"');
  });

  it("should handle dry run mode", async () => {
    db._selectResult = [{ id: 1, name: "Shopify DTC", provider: "shopify", status: "active" }];

    // Mock the fetchShopifyProducts to throw (since we don't have real credentials)
    // In dry run, it still needs to fetch — but that's an integration concern.
    // For unit test, we just verify the service correctly passes through dryRun.
    const result = await service.run({ channelId: 1, dryRun: true });

    expect(result.dryRun).toBe(true);
  });

  it("should initialize with correct result structure", async () => {
    db._selectResult = [{ id: 1, name: "Shopify DTC", provider: "shopify", status: "active" }];

    // Will fail to fetch Shopify products (no credentials), but structure should be right
    const result = await service.run({ channelId: 1 });

    expect(result).toHaveProperty("products");
    expect(result).toHaveProperty("variants");
    expect(result).toHaveProperty("feeds");
    expect(result).toHaveProperty("listings");
    expect(result).toHaveProperty("pricing");
    expect(result).toHaveProperty("assets");
    expect(result).toHaveProperty("mappings");
    expect(result).toHaveProperty("errors");
  });
});
