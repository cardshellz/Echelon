/**
 * Integration Tests — Source Lock System
 *
 * Tests against the real test database:
 * - CRUD operations on source_lock_config
 * - Lock enforcement with real data
 * - Channel defaults initialization
 *
 * Updated 2026-03-15: Nearly all fields now always-locked.
 * Only "barcodes" remains toggleable.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  getTestDb,
  runMigrations,
  truncateTestData,
  closeTestDb,
} from "../../../../../test/setup-integration";
import { createSourceLockService } from "../../source-lock.service";
import { channels, sourceLockConfig } from "@shared/schema";

describe("Source Lock System (Integration)", () => {
  let db: ReturnType<typeof getTestDb>;
  let service: ReturnType<typeof createSourceLockService>;
  let testChannelId: number;

  beforeAll(async () => {
    db = getTestDb();
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateTestData();
    service = createSourceLockService(db);

    // Create a test channel
    const [channel] = await db
      .insert(channels)
      .values({
        name: "Test Shopify Store",
        type: "internal",
        provider: "shopify",
        status: "active",
        priority: 10,
      })
      .returning();
    testChannelId = channel.id;
  });

  // -----------------------------------------------------------------------
  // CRUD operations
  // -----------------------------------------------------------------------

  describe("CRUD operations", () => {
    it("should create lock config for barcodes and read it back", async () => {
      const result = await service.setFieldLock(
        testChannelId,
        "barcodes",
        true,
        "admin",
        "GS1 generator built",
      );

      expect(result.channelId).toBe(testChannelId);
      expect(result.fieldType).toBe("barcodes");
      expect(result.isLocked).toBe(1);
      expect(result.lockedBy).toBe("admin");
      expect(result.notes).toBe("GS1 generator built");

      // Read it back
      const isLocked = await service.isFieldLocked(testChannelId, "barcodes");
      expect(isLocked).toBe(true);
    });

    it("should update existing lock config", async () => {
      // Create
      await service.setFieldLock(testChannelId, "barcodes", true, "admin");

      // Update
      const updated = await service.setFieldLock(
        testChannelId,
        "barcodes",
        false,
        "admin",
        "Reopening for manual entry",
      );

      expect(updated.isLocked).toBe(0);
      expect(updated.notes).toBe("Reopening for manual entry");

      // Verify
      const isLocked = await service.isFieldLocked(testChannelId, "barcodes");
      expect(isLocked).toBe(false);
    });

    it("should initialize channel defaults and create config rows", async () => {
      const created = await service.initializeChannelDefaults(testChannelId, "setup-wizard");

      // Should create 1 row (barcodes) — all others are always-locked
      expect(created).toBe(1);

      // Verify defaults
      const status = await service.getChannelLockStatus(testChannelId);
      expect(status.barcodes).toBe(false);     // Default: unlocked
      expect(status.inventory).toBe(true);     // Always locked
      expect(status.pricing).toBe(true);       // Always locked
      expect(status.variants).toBe(true);      // Always locked
      expect(status.sku).toBe(true);           // Always locked
      expect(status.title).toBe(true);         // Always locked
      expect(status.description).toBe(true);   // Always locked
      expect(status.images).toBe(true);        // Always locked
      expect(status.weight).toBe(true);        // Always locked
      expect(status.tags).toBe(true);          // Always locked
    });

    it("should be idempotent on repeated initialization", async () => {
      const first = await service.initializeChannelDefaults(testChannelId);
      expect(first).toBe(1);

      const second = await service.initializeChannelDefaults(testChannelId);
      expect(second).toBe(0); // Nothing new to create

      // Verify DB has exactly 1 config row (barcodes)
      const rows = await db
        .select()
        .from(sourceLockConfig)
        .where(eq(sourceLockConfig.channelId, testChannelId));
      expect(rows).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Lock enforcement
  // -----------------------------------------------------------------------

  describe("lock enforcement", () => {
    const alwaysLockedFields = [
      "inventory", "pricing", "variants", "sku",
      "title", "description", "images", "weight", "tags",
    ] as const;

    for (const field of alwaysLockedFields) {
      it(`should always report ${field} as locked even without config row`, async () => {
        const isLocked = await service.isFieldLocked(testChannelId, field);
        expect(isLocked).toBe(true);
      });

      it(`should reject attempts to unlock ${field}`, async () => {
        await expect(
          service.setFieldLock(testChannelId, field, false),
        ).rejects.toThrow(/Cannot unlock/);
      });
    }

    it("should correctly report locked vs syncable fields", async () => {
      await service.initializeChannelDefaults(testChannelId);

      const locked = await service.getLockedFields(testChannelId);
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

      const syncable = await service.getSyncableFields(testChannelId);
      expect(syncable.has("barcodes")).toBe(true);
      expect(syncable.has("inventory")).toBe(false);
      expect(syncable.has("title")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-channel isolation
  // -----------------------------------------------------------------------

  describe("multi-channel isolation", () => {
    it("should maintain separate lock configs per channel", async () => {
      // Create a second channel
      const [channel2] = await db
        .insert(channels)
        .values({
          name: "eBay Store",
          type: "internal",
          provider: "ebay",
          status: "active",
          priority: 5,
        })
        .returning();

      // Lock barcodes on channel 1, leave unlocked on channel 2
      await service.setFieldLock(testChannelId, "barcodes", true, "admin");
      await service.initializeChannelDefaults(channel2.id);

      // Verify isolation
      expect(await service.isFieldLocked(testChannelId, "barcodes")).toBe(true);
      expect(await service.isFieldLocked(channel2.id, "barcodes")).toBe(false);
    });
  });
});
