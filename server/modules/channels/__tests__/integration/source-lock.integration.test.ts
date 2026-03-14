/**
 * Integration Tests — Source Lock System
 *
 * Tests against the real test database:
 * - CRUD operations on source_lock_config
 * - Lock enforcement with real data
 * - Channel defaults initialization
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
    it("should create lock config and read it back", async () => {
      const result = await service.setFieldLock(
        testChannelId,
        "title",
        true,
        "admin",
        "Migration complete",
      );

      expect(result.channelId).toBe(testChannelId);
      expect(result.fieldType).toBe("title");
      expect(result.isLocked).toBe(1);
      expect(result.lockedBy).toBe("admin");
      expect(result.notes).toBe("Migration complete");

      // Read it back
      const isLocked = await service.isFieldLocked(testChannelId, "title");
      expect(isLocked).toBe(true);
    });

    it("should update existing lock config", async () => {
      // Create
      await service.setFieldLock(testChannelId, "title", true, "admin");

      // Update
      const updated = await service.setFieldLock(
        testChannelId,
        "title",
        false,
        "admin",
        "Reopening for edits",
      );

      expect(updated.isLocked).toBe(0);
      expect(updated.notes).toBe("Reopening for edits");

      // Verify
      const isLocked = await service.isFieldLocked(testChannelId, "title");
      expect(isLocked).toBe(false);
    });

    it("should initialize channel defaults and create config rows", async () => {
      const created = await service.initializeChannelDefaults(testChannelId, "setup-wizard");

      // Should create 3 rows (title, description, images)
      expect(created).toBe(3);

      // Verify defaults
      const status = await service.getChannelLockStatus(testChannelId);
      expect(status.title).toBe(false);       // Default: unlocked
      expect(status.description).toBe(false);  // Default: unlocked
      expect(status.images).toBe(true);        // Default: locked
      expect(status.inventory).toBe(true);     // Always locked
      expect(status.pricing).toBe(true);       // Always locked
      expect(status.variants).toBe(true);      // Always locked
    });

    it("should be idempotent on repeated initialization", async () => {
      const first = await service.initializeChannelDefaults(testChannelId);
      expect(first).toBe(3);

      const second = await service.initializeChannelDefaults(testChannelId);
      expect(second).toBe(0); // Nothing new to create

      // Verify DB has exactly 3 config rows
      const rows = await db
        .select()
        .from(sourceLockConfig)
        .where(eq(sourceLockConfig.channelId, testChannelId));
      expect(rows).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Lock enforcement
  // -----------------------------------------------------------------------

  describe("lock enforcement", () => {
    it("should always report inventory as locked even without config row", async () => {
      const isLocked = await service.isFieldLocked(testChannelId, "inventory");
      expect(isLocked).toBe(true);
    });

    it("should always report pricing as locked even without config row", async () => {
      const isLocked = await service.isFieldLocked(testChannelId, "pricing");
      expect(isLocked).toBe(true);
    });

    it("should always report variants as locked even without config row", async () => {
      const isLocked = await service.isFieldLocked(testChannelId, "variants");
      expect(isLocked).toBe(true);
    });

    it("should reject attempts to unlock always-locked fields", async () => {
      await expect(
        service.setFieldLock(testChannelId, "inventory", false),
      ).rejects.toThrow(/Cannot unlock/);

      await expect(
        service.setFieldLock(testChannelId, "pricing", false),
      ).rejects.toThrow(/Cannot unlock/);

      await expect(
        service.setFieldLock(testChannelId, "variants", false),
      ).rejects.toThrow(/Cannot unlock/);
    });

    it("should correctly report locked vs syncable fields", async () => {
      await service.initializeChannelDefaults(testChannelId);

      const locked = await service.getLockedFields(testChannelId);
      expect(locked.has("inventory")).toBe(true);
      expect(locked.has("pricing")).toBe(true);
      expect(locked.has("variants")).toBe(true);
      expect(locked.has("images")).toBe(true);
      expect(locked.has("title")).toBe(false);
      expect(locked.has("description")).toBe(false);

      const syncable = await service.getSyncableFields(testChannelId);
      expect(syncable.has("title")).toBe(true);
      expect(syncable.has("description")).toBe(true);
      expect(syncable.has("inventory")).toBe(false);
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

      // Lock title on channel 1, leave unlocked on channel 2
      await service.setFieldLock(testChannelId, "title", true, "admin");
      await service.initializeChannelDefaults(channel2.id);

      // Verify isolation
      expect(await service.isFieldLocked(testChannelId, "title")).toBe(true);
      expect(await service.isFieldLocked(channel2.id, "title")).toBe(false);
    });
  });
});
