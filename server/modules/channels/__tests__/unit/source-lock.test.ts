/**
 * Unit Tests — Source Lock Service
 *
 * Tests lock/unlock behavior, always-locked field enforcement,
 * default initialization, and in-memory cache behavior using mocked DB.
 *
 * Updated 2026-03-15: Nearly all fields now always-locked.
 * Only "barcodes" remains toggleable (GS1 generator not yet built).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSourceLockService, type SourceLockService } from "../../source-lock.service";

// ---------------------------------------------------------------------------
// Mock DB
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
    const alwaysLockedFields = [
      "inventory", "pricing", "variants", "sku",
      "title", "description", "images", "weight", "tags",
    ] as const;

    for (const field of alwaysLockedFields) {
      it(`should always return true for ${field} regardless of config`, async () => {
        db.setSelectResult([]);
        expect(await service.isFieldLocked(1, field)).toBe(true);
        expect(db.select).not.toHaveBeenCalled();
      });

      it(`should throw when trying to unlock ${field}`, async () => {
        await expect(
          service.setFieldLock(1, field, false),
        ).rejects.toThrow(new RegExp(`Cannot unlock field type "${field}"`));
      });

      it(`should allow re-locking ${field} (no-op but allowed)`, async () => {
        db.setSelectResult([]);
        db.setInsertResult([{ id: 1, channelId: 1, fieldType: field, isLocked: 1 }]);
        await expect(service.setFieldLock(1, field, true)).resolves.toBeDefined();
      });
    }
  });

  // -----------------------------------------------------------------------
  // Default lock states (no config row)
  // -----------------------------------------------------------------------

  describe("default lock states", () => {
    it("should return true (locked) for all always-locked fields by default", async () => {
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "inventory")).toBe(true);
      expect(await service.isFieldLocked(1, "pricing")).toBe(true);
      expect(await service.isFieldLocked(1, "variants")).toBe(true);
      expect(await service.isFieldLocked(1, "sku")).toBe(true);
      expect(await service.isFieldLocked(1, "title")).toBe(true);
      expect(await service.isFieldLocked(1, "description")).toBe(true);
      expect(await service.isFieldLocked(1, "images")).toBe(true);
      expect(await service.isFieldLocked(1, "weight")).toBe(true);
      expect(await service.isFieldLocked(1, "tags")).toBe(true);
    });

    it("should return false (unlocked) for barcodes by default", async () => {
      db.setSelectResult([]);
      expect(await service.isFieldLocked(1, "barcodes")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Lock/unlock toggleable fields (only barcodes is toggleable now)
  // -----------------------------------------------------------------------

  describe("lock/unlock toggleable fields", () => {
    it("should return locked=true when barcodes config row has isLocked=1", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 1 }]);
      expect(await service.isFieldLocked(1, "barcodes")).toBe(true);
    });

    it("should return locked=false when barcodes config row has isLocked=0", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 0 }]);
      expect(await service.isFieldLocked(1, "barcodes")).toBe(false);
    });

    it("should allow locking barcodes", async () => {
      db.setSelectResult([]);
      db.setInsertResult([{
        id: 1, channelId: 1, fieldType: "barcodes", isLocked: 1,
        lockedBy: "admin", notes: "GS1 generator built",
      }]);

      const result = await service.setFieldLock(1, "barcodes", true, "admin", "GS1 generator built");
      expect(result.isLocked).toBe(1);
      expect(db.insert).toHaveBeenCalled();
    });

    it("should allow unlocking barcodes", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 1 }]);
      db.setUpdateResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 0 }]);

      const result = await service.setFieldLock(1, "barcodes", false, "admin");
      expect(result.isLocked).toBe(0);
      expect(db.update).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Cache behavior (using barcodes as the toggleable field)
  // -----------------------------------------------------------------------

  describe("cache behavior", () => {
    it("should cache results and not query DB on second call", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 0 }]);

      const first = await service.isFieldLocked(1, "barcodes");
      expect(first).toBe(false);
      expect(db.select).toHaveBeenCalledTimes(1);

      const second = await service.isFieldLocked(1, "barcodes");
      expect(second).toBe(false);
      expect(db.select).toHaveBeenCalledTimes(1); // Still 1, cached
    });

    it("should invalidate cache after setFieldLock", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 0 }]);
      await service.isFieldLocked(1, "barcodes");
      expect(db.select).toHaveBeenCalledTimes(1);

      // Set lock (invalidates cache)
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 0 }]);
      db.setUpdateResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 1 }]);
      await service.setFieldLock(1, "barcodes", true);

      // Next call should hit DB again
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 1 }]);
      const result = await service.isFieldLocked(1, "barcodes");
      expect(result).toBe(true);
    });

    it("should clear all cache on clearCache()", async () => {
      db.setSelectResult([{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 0 }]);
      await service.isFieldLocked(1, "barcodes");
      expect(db.select).toHaveBeenCalledTimes(1);

      service.clearCache();

      await service.isFieldLocked(1, "barcodes");
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

      // Barcodes: default unlocked → syncable
      db.setSelectResult([]);
      expect(await service.isFieldSyncable(1, "barcodes")).toBe(true);
    });

    it("getChannelLockStatus should return all field types", async () => {
      db.setSelectResult([]);
      const status = await service.getChannelLockStatus(1);

      // All always-locked
      expect(status.inventory).toBe(true);
      expect(status.pricing).toBe(true);
      expect(status.variants).toBe(true);
      expect(status.sku).toBe(true);
      expect(status.title).toBe(true);
      expect(status.description).toBe(true);
      expect(status.images).toBe(true);
      expect(status.weight).toBe(true);
      expect(status.tags).toBe(true);
      // Only barcodes unlocked by default
      expect(status.barcodes).toBe(false);
    });

    it("getLockedFields should return set of locked field types", async () => {
      db.setSelectResult([]);
      const locked = await service.getLockedFields(1);

      expect(locked.has("inventory")).toBe(true);
      expect(locked.has("pricing")).toBe(true);
      expect(locked.has("variants")).toBe(true);
      expect(locked.has("sku")).toBe(true);
      expect(locked.has("title")).toBe(true);
      expect(locked.has("description")).toBe(true);
      expect(locked.has("images")).toBe(true);
      expect(locked.has("weight")).toBe(true);
      expect(locked.has("tags")).toBe(true);
      expect(locked.has("barcodes")).toBe(false);
    });

    it("getSyncableFields should return set of unlocked field types", async () => {
      db.setSelectResult([]);
      const syncable = await service.getSyncableFields(1);

      expect(syncable.has("barcodes")).toBe(true);
      // Everything else locked
      expect(syncable.has("inventory")).toBe(false);
      expect(syncable.has("pricing")).toBe(false);
      expect(syncable.has("title")).toBe(false);
      expect(syncable.has("description")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Channel defaults initialization
  // -----------------------------------------------------------------------

  describe("initializeChannelDefaults", () => {
    it("should create config rows for toggleable fields only", async () => {
      db.setSelectResult([]);
      db.setInsertResult([{ id: 1 }]);

      const created = await service.initializeChannelDefaults(1, "system");

      // Only 1 toggleable field: barcodes
      // All always-locked fields are skipped
      expect(created).toBe(1);
    });

    it("should skip fields that already have config (idempotent)", async () => {
      // Simulate: barcodes already has config
      let callCount = 0;
      db.select = vi.fn(() => {
        callCount++;
        const result = callCount === 1
          ? [{ id: 1, channelId: 1, fieldType: "barcodes", isLocked: 0 }]
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
      // 0 created — barcodes already exists, no other toggleable fields
      expect(created).toBe(0);
    });
  });
});
