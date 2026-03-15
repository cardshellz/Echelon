/**
 * Source Lock Service
 *
 * Controls per-field-type, per-channel sync direction.
 * Locked = Echelon → channel only (channel edits overwritten on next push)
 * Unlocked = 2-way sync (channel edits flow back to Echelon)
 *
 * Some field types are ALWAYS locked by design:
 *   - inventory: always locked (Echelon is the inventory authority)
 *   - pricing: always locked (Echelon owns base price + channel markups)
 *   - variants: always locked (SKU structure owned by Echelon)
 *
 * Toggleable field types:
 *   - title: default unlocked (2-way) during migration, lock later
 *   - description: default unlocked (2-way) during migration, lock later
 *   - images: default locked (1-way push)
 */

import { eq, and } from "drizzle-orm";
import {
  sourceLockConfig,
  type SourceLockConfig,
  type SourceLockFieldType,
  sourceLockFieldTypeEnum,
} from "@shared/schema";

// Field types that are ALWAYS locked regardless of configuration.
// Changed 2026-03-15: Nearly all fields now locked. Echelon is the single source of truth.
// Per-channel content differences handled via channel_product_attributes overrides, not 2-way sync.
const ALWAYS_LOCKED_FIELDS: ReadonlySet<SourceLockFieldType> = new Set([
  "inventory",
  "pricing",
  "variants",
  "sku",          // SKU drift from Shopify caused duplicate products — locked permanently
  "title",        // Per-channel overrides via channel_product_attributes (null = master)
  "description",  // Per-channel overrides (eBay HTML ≠ Shopify copy)
  "images",
  "weight",
  "tags",         // Per-channel overrides
]);

// Default lock state for toggleable fields (when no config row exists)
const DEFAULT_LOCK_STATE: Record<SourceLockFieldType, boolean> = {
  inventory: true,    // Always locked
  pricing: true,      // Always locked
  variants: true,     // Always locked
  sku: true,          // Always locked
  title: true,        // Always locked (per-channel overrides, not 2-way)
  description: true,  // Always locked (per-channel overrides, not 2-way)
  images: true,       // Always locked
  weight: true,       // Always locked
  tags: true,         // Always locked (per-channel overrides, not 2-way)
  barcodes: false,    // Unlocked — GS1 barcode generator not yet built
};

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class SourceLockService {
  /** In-memory cache: channelId:fieldType → isLocked */
  private cache = new Map<string, boolean>();

  constructor(private readonly db: DrizzleDb) {}

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Check if a field type is locked for a specific channel.
   * Locked = Echelon is the authority, channel edits are overwritten.
   *
   * @returns true if the field is locked (1-way push from Echelon)
   */
  async isFieldLocked(channelId: number, fieldType: SourceLockFieldType): Promise<boolean> {
    // Always-locked fields bypass config lookup entirely
    if (ALWAYS_LOCKED_FIELDS.has(fieldType)) {
      return true;
    }

    const cacheKey = `${channelId}:${fieldType}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const [config] = await this.db
      .select()
      .from(sourceLockConfig)
      .where(
        and(
          eq(sourceLockConfig.channelId, channelId),
          eq(sourceLockConfig.fieldType, fieldType),
        ),
      )
      .limit(1);

    const isLocked = config ? config.isLocked === 1 : DEFAULT_LOCK_STATE[fieldType];
    this.cache.set(cacheKey, isLocked);
    return isLocked;
  }

  /**
   * Check if a field type allows 2-way sync (channel edits flow back).
   * Convenience inverse of isFieldLocked.
   */
  async isFieldSyncable(channelId: number, fieldType: SourceLockFieldType): Promise<boolean> {
    return !(await this.isFieldLocked(channelId, fieldType));
  }

  /**
   * Get the lock status for ALL field types on a channel.
   * Returns a map of fieldType → isLocked.
   */
  async getChannelLockStatus(channelId: number): Promise<Record<SourceLockFieldType, boolean>> {
    const configs = await this.db
      .select()
      .from(sourceLockConfig)
      .where(eq(sourceLockConfig.channelId, channelId));

    const configMap = new Map(configs.map((c: SourceLockConfig) => [c.fieldType, c.isLocked === 1]));

    const result = {} as Record<SourceLockFieldType, boolean>;
    for (const fieldType of sourceLockFieldTypeEnum) {
      if (ALWAYS_LOCKED_FIELDS.has(fieldType)) {
        result[fieldType] = true;
      } else {
        result[fieldType] = configMap.get(fieldType) ?? DEFAULT_LOCK_STATE[fieldType];
      }
    }

    return result;
  }

  /**
   * Set the lock status for a toggleable field type on a channel.
   * Throws if attempting to unlock an always-locked field.
   */
  async setFieldLock(
    channelId: number,
    fieldType: SourceLockFieldType,
    isLocked: boolean,
    lockedBy?: string,
    notes?: string,
  ): Promise<SourceLockConfig> {
    if (ALWAYS_LOCKED_FIELDS.has(fieldType) && !isLocked) {
      throw new Error(
        `Cannot unlock field type "${fieldType}" — it is always locked by design. ` +
        `Inventory, pricing, and variant data must always flow from Echelon to channels.`,
      );
    }

    const now = new Date();

    // Upsert
    const existing = await this.db
      .select()
      .from(sourceLockConfig)
      .where(
        and(
          eq(sourceLockConfig.channelId, channelId),
          eq(sourceLockConfig.fieldType, fieldType),
        ),
      )
      .limit(1);

    let result: SourceLockConfig;

    if (existing.length > 0) {
      const [updated] = await this.db
        .update(sourceLockConfig)
        .set({
          isLocked: isLocked ? 1 : 0,
          lockedBy: lockedBy ?? null,
          lockedAt: now,
          notes: notes ?? null,
          updatedAt: now,
        })
        .where(eq(sourceLockConfig.id, existing[0].id))
        .returning();
      result = updated;
    } else {
      const [created] = await this.db
        .insert(sourceLockConfig)
        .values({
          channelId,
          fieldType,
          isLocked: isLocked ? 1 : 0,
          lockedBy: lockedBy ?? null,
          lockedAt: now,
          notes: notes ?? null,
        })
        .returning();
      result = created;
    }

    // Invalidate cache
    this.cache.delete(`${channelId}:${fieldType}`);

    return result;
  }

  /**
   * Initialize default lock config for a new channel.
   * Creates config rows for all toggleable field types with their defaults.
   * Idempotent — skips fields that already have config.
   */
  async initializeChannelDefaults(channelId: number, lockedBy?: string): Promise<number> {
    let created = 0;

    for (const fieldType of sourceLockFieldTypeEnum) {
      if (ALWAYS_LOCKED_FIELDS.has(fieldType)) continue; // Always-locked don't need config rows

      const existing = await this.db
        .select()
        .from(sourceLockConfig)
        .where(
          and(
            eq(sourceLockConfig.channelId, channelId),
            eq(sourceLockConfig.fieldType, fieldType),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        await this.db.insert(sourceLockConfig).values({
          channelId,
          fieldType,
          isLocked: DEFAULT_LOCK_STATE[fieldType] ? 1 : 0,
          lockedBy: lockedBy ?? "system",
          notes: "Default configuration",
        });
        created++;
      }
    }

    return created;
  }

  /**
   * Check multiple field locks at once for a sync operation.
   * Returns only the fields that should be synced (pushed) from Echelon.
   *
   * Usage in sync operations:
   *   const pushable = await sourceLock.getLockedFields(channelId);
   *   if (pushable.has('title')) { /* push title * / }
   *   if (pushable.has('images')) { /* push images * / }
   */
  async getLockedFields(channelId: number): Promise<Set<SourceLockFieldType>> {
    const status = await this.getChannelLockStatus(channelId);
    const locked = new Set<SourceLockFieldType>();
    for (const [field, isLocked] of Object.entries(status)) {
      if (isLocked) locked.add(field as SourceLockFieldType);
    }
    return locked;
  }

  /**
   * Get fields that allow 2-way sync (unlocked fields).
   * These are fields where channel edits should flow back to Echelon.
   */
  async getSyncableFields(channelId: number): Promise<Set<SourceLockFieldType>> {
    const status = await this.getChannelLockStatus(channelId);
    const syncable = new Set<SourceLockFieldType>();
    for (const [field, isLocked] of Object.entries(status)) {
      if (!isLocked) syncable.add(field as SourceLockFieldType);
    }
    return syncable;
  }

  /**
   * Clear the in-memory cache. Call after bulk config changes.
   */
  clearCache(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSourceLockService(db: any) {
  return new SourceLockService(db);
}

export type { SourceLockService };
