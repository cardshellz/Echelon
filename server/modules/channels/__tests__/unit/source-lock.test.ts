/**
 * Unit Tests — Source Lock Service
 *
 * Tests lock/unlock behavior, always-locked field enforcement,
 * default initialization, and in-memory cache behavior using mocked DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSourceLockService, type SourceLockService } from "../../source-lock.service";

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function createMockDb() {
  /**
   * Creates a thenable chain that mimics Drizzle's query builder.
   * Can be awaited directly (returns data array) or chained further.
   */
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
    return chain;
  }

  return {
    _selectResult: null as any,
    _insertResult: null as any,
    _updateResult: null as any,

    select: vi.fn(function (this: any) {
      return thenableChain(this._selectResult ?? []);
    }),
    insert: vi.fn(function (this: any) {
      return thenableChain(this._insertResult ?? []);
    }),
    update: vi.fn(function (this: any) {
      return thenableChain(this._updateResult ?? []);
    }),
    delete: vi.fn(function (this: any) {
      return thenableChain([]);
    }),

    setSelectResult(result: any) {
      this._selectResult = result;
    },
    setInsertResult(result: any) {
      this._insertResult = result;
    },
    setUpdateResult(result: any) {
      this._updateResult = result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Source Lock Service", () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SourceLockService;

  beforeEach(() => {
    db = createMockDb();
    service = createSourceLockService(db);
  });

  // -----------------------------------------------------------------------
  // Always-locked fields
  // -----------------------------------------------------------------------

  describe("always-locked fields", () => {
    it("should always return true for inventory regardless of config", async () => {
      // Even with no DB rows, inventory is always locked
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "inventory")).toBe(true);
      // DB should NOT be queried for always-locked fields
      expect(db.select).not.toHaveBeenCalled();
    });

    it("should always return true for pricing regardless of config", async () => {
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "pricing")).toBe(true);
      expect(db.select).not.toHaveBeenCalled();
    });

    it("should always return true for variants regardless of config", async () => {
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "variants")).toBe(true);
      expect(db.select).not.toHaveBeenCalled();
    });

    it("should throw when trying to unlock an always-locked field", async () => {
      await expect(
        service.setFieldLock(1, "inventory", false),
      ).rejects.toThrow(/Cannot unlock field type "inventory"/);
    });

    it("should throw for unlocking pricing", async () => {
      await expect(
        service.setFieldLock(1, "pricing", false),
      ).rejects.toThrow(/Cannot unlock field type "pricing"/);
    });

    it("should throw for unlocking variants", async () => {
      await expect(
        service.setFieldLock(1, "variants", false),
      ).rejects.toThrow(/Cannot unlock field type "variants"/);
    });
  });

  // -----------------------------------------------------------------------
  // Default lock states (no config row)
  // -----------------------------------------------------------------------

  describe("default lock states", () => {
    it("should return false (unlocked) for title by default", async () => {
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "title")).toBe(false);
    });

    it("should return false (unlocked) for description by default", async () => {
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "description")).toBe(false);
    });

    it("should return true (locked) for images by default", async () => {
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "images")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Lock/unlock toggleable fields
  // -----------------------------------------------------------------------

  describe("lock/unlock toggleable fields", () => {
    it("should return locked=true when config row has isLocked=1", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "title", isLocked: 1 }]);
      expect(await service.isFieldLocked(1, "title")).toBe(true);
    });

    it("should return locked=false when config row has isLocked=0", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "images", isLocked: 0 }]);
      expect(await service.isFieldLocked(1, "images")).toBe(false);
    });

    it("should allow locking a toggleable field (title)", async () => {
      db.setSelectResult([]);
      db.setInsertResult([{
        id: 1,
        channelId: 1,
        fieldType: "title",
        isLocked: 1,
        lockedBy: "admin",
        notes: "Migration complete",
      }]);

      const result = await service.setFieldLock(1, "title", true, "admin", "Migration complete");
      expect(result.isLocked).toBe(1);
      expect(db.insert).toHaveBeenCalled();
    });

    it("should update existing config when setting lock on existing row", async () => {
      db.setSelectResult([{ id: 42, channelId: 1, fieldType: "title", isLocked: 0 }]);
      db.setUpdateResult([{
        id: 42,
        channelId: 1,
        fieldType: "title",
        isLocked: 1,
        lockedBy: "admin",
      }]);

      const result = await service.setFieldLock(1, "title", true, "admin");
      expect(result.isLocked).toBe(1);
      expect(db.update).toHaveBeenCalled();
    });

    it("should allow re-locking an always-locked field (no-op but allowed)", async () => {
      // Locking inventory (already always-locked) should not throw
      db.setSelectResult([]);
      db.setInsertResult([{
        id: 1,
        channelId: 1,
        fieldType: "inventory",
        isLocked: 1,
      }]);

      // Should not throw
      await expect(
        service.setFieldLock(1, "inventory", true),
      ).resolves.toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Cache behavior
  // -----------------------------------------------------------------------

  describe("cache behavior", () => {
    it("should cache results and not query DB on second call", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "title", isLocked: 0 }]);

      // First call — hits DB
      const first = await service.isFieldLocked(1, "title");
      expect(first).toBe(false);
      expect(db.select).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      const second = await service.isFieldLocked(1, "title");
      expect(second).toBe(false);
      expect(db.select).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it("should invalidate cache after setFieldLock", async () => {
      // Pre-populate cache
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "title", isLocked: 0 }]);
      await service.isFieldLocked(1, "title");
      expect(db.select).toHaveBeenCalledTimes(1);

      // Set lock (invalidates cache)
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "title", isLocked: 0 }]);
      db.setUpdateResult([{ id: 1, channelId: 1, fieldType: "title", isLocked: 1 }]);
      await service.setFieldLock(1, "title", true);

      // Next call should hit DB again
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "title", isLocked: 1 }]);
      const result = await service.isFieldLocked(1, "title");
      expect(result).toBe(true);
    });

    it("should clear all cache on clearCache()", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "title", isLocked: 0 }]);
      await service.isFieldLocked(1, "title");
      expect(db.select).toHaveBeenCalledTimes(1);

      service.clearCache();

      // Should query DB again
      await service.isFieldLocked(1, "title");
      expect(db.select).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Convenience methods
  // -----------------------------------------------------------------------

  describe("convenience methods", () => {
    it("isFieldSyncable should be inverse of isFieldLocked", async () => {
      // Inventory: always locked → never syncable
      expect(await service.isFieldSyncable(1, "inventory")).toBe(false);

      // Title: default unlocked → syncable
      db.setSelectResult([]);
      expect(await service.isFieldSyncable(1, "title")).toBe(true);
    });

    it("getChannelLockStatus should return all field types", async () => {
      db.setSelectResult([]); // No config rows → all defaults
      const status = await service.getChannelLockStatus(1);

      expect(status.inventory).toBe(true);
      expect(status.pricing).toBe(true);
      expect(status.variants).toBe(true);
      expect(status.title).toBe(false);
      expect(status.description).toBe(false);
      expect(status.images).toBe(true);
    });

    it("getLockedFields should return set of locked field types", async () => {
      db.setSelectResult([]);
      const locked = await service.getLockedFields(1);

      expect(locked.has("inventory")).toBe(true);
      expect(locked.has("pricing")).toBe(true);
      expect(locked.has("variants")).toBe(true);
      expect(locked.has("images")).toBe(true);
      expect(locked.has("title")).toBe(false);
      expect(locked.has("description")).toBe(false);
    });

    it("getSyncableFields should return set of unlocked field types", async () => {
      db.setSelectResult([]);
      const syncable = await service.getSyncableFields(1);

      expect(syncable.has("title")).toBe(true);
      expect(syncable.has("description")).toBe(true);
      expect(syncable.has("inventory")).toBe(false);
      expect(syncable.has("pricing")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Channel defaults initialization
  // -----------------------------------------------------------------------

  describe("initializeChannelDefaults", () => {
    it("should create config rows for toggleable fields only", async () => {
      db.setSelectResult([]); // No existing config
      db.setInsertResult([{ id: 1 }]);

      const created = await service.initializeChannelDefaults(1, "system");

      // Should insert for title, description, images (3 toggleable fields)
      // Always-locked fields (inventory, pricing, variants) are skipped
      expect(created).toBe(3);
    });

    it("should skip fields that already have config (idempotent)", async () => {
      // Simulate: title already has config
      let callCount = 0;
      db.select = vi.fn(() => {
        callCount++;
        // First call returns existing config, rest return empty
        const result = callCount === 1
          ? [{ id: 1, channelId: 1, fieldType: "title", isLocked: 0 }]
          : [];
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => Promise.resolve(result)),
            })),
          })),
        };
      });
      db.setInsertResult([{ id: 2 }]);

      const created = await service.initializeChannelDefaults(1);
      // Only 2 created (description + images), title was skipped
      expect(created).toBe(2);
    });
  });
});
