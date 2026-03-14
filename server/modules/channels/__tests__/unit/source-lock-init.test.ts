/**
 * Unit Tests — Source Lock Initialization
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { initializeSourceLockDefaults, initializeAllChannelDefaults } from "../../source-lock-init";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function createMockDb() {
  function thenableChain(data: any[]) {
    const chain: any = {};
    chain.then = (resolve: any, reject?: any) => Promise.resolve(data).then(resolve, reject);
    chain.catch = (fn: any) => Promise.resolve(data).catch(fn);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
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
      return thenableChain([]);
    }),
    delete: vi.fn(function (this: any) {
      return thenableChain([]);
    }),
  };
}

function createMockSourceLockService() {
  return {
    initializeChannelDefaults: vi.fn().mockResolvedValue(3), // 3 toggleable fields initialized
    getChannelLockStatus: vi.fn().mockResolvedValue({
      inventory: true,
      pricing: true,
      variants: true,
      title: false,
      description: false,
      images: true,
    }),
    isFieldLocked: vi.fn(),
    isFieldSyncable: vi.fn(),
    getLockedFields: vi.fn(),
    getSyncableFields: vi.fn(),
    setFieldLock: vi.fn(),
    clearCache: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Source Lock Initialization", () => {
  let db: ReturnType<typeof createMockDb>;
  let sourceLock: ReturnType<typeof createMockSourceLockService>;

  beforeEach(() => {
    db = createMockDb();
    sourceLock = createMockSourceLockService();
  });

  describe("initializeSourceLockDefaults", () => {
    it("should throw if channel not found", async () => {
      db._selectResult = [];

      await expect(
        initializeSourceLockDefaults(db as any, sourceLock as any, 999),
      ).rejects.toThrow("Channel 999 not found");
    });

    it("should initialize defaults and return status", async () => {
      db._selectResult = [{ id: 1, name: "Shopify DTC", provider: "shopify", status: "active" }];

      const result = await initializeSourceLockDefaults(db as any, sourceLock as any, 1);

      expect(sourceLock.initializeChannelDefaults).toHaveBeenCalledWith(1, "system_init");
      expect(result.channelId).toBe(1);
      expect(result.channelName).toBe("Shopify DTC");
      expect(result.fieldsInitialized).toBe(3);
      expect(result.lockStatus.inventory).toBe(true);
      expect(result.lockStatus.title).toBe(false);
      expect(result.lockStatus.description).toBe(false);
      expect(result.lockStatus.images).toBe(true);
    });
  });

  describe("initializeAllChannelDefaults", () => {
    it("should initialize all active channels", async () => {
      db._selectResult = [
        { id: 1, name: "Shopify DTC", provider: "shopify", status: "active" },
        { id: 2, name: "eBay", provider: "ebay", status: "active" },
      ];

      // Need to return channel data on subsequent calls too
      const selectMock = vi.fn()
        // First call: get active channels
        .mockReturnValueOnce({
          then: (resolve: any) => Promise.resolve([
            { id: 1, name: "Shopify DTC", provider: "shopify", status: "active" },
            { id: 2, name: "eBay", provider: "ebay", status: "active" },
          ]).then(resolve),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
        })
        // Subsequent calls: return channel by ID
        .mockReturnValue({
          then: (resolve: any) => Promise.resolve([
            { id: 1, name: "Shopify DTC", provider: "shopify", status: "active" },
          ]).then(resolve),
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
        });

      db.select = selectMock;

      const results = await initializeAllChannelDefaults(db as any, sourceLock as any);

      expect(results.length).toBe(2);
      expect(sourceLock.initializeChannelDefaults).toHaveBeenCalledTimes(2);
    });
  });
});
