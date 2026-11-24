/**
 * Source Lock Initialization
 *
 * Sets up default source lock configuration for channels.
 * Called during initial setup or when a new channel is created.
 *
 * Default lock config (all channels):
 *   inventory:   🔒 LOCKED (always)
 *   pricing:     🔒 LOCKED (always)
 *   variants:    🔒 LOCKED (always)
 *   sku:         🔒 LOCKED (always) — SKU drift caused dupes, locked 2026-03-15
 *   title:       🔒 LOCKED (always) — per-channel overrides via channel_product_attributes
 *   description: 🔒 LOCKED (always) — per-channel overrides
 *   images:      🔒 LOCKED (always)
 *   weight:      🔒 LOCKED (always)
 *   tags:        🔒 LOCKED (always) — per-channel overrides
 *   barcodes:    🔓 UNLOCKED (GS1 generator not yet built)
 */

import { eq } from "drizzle-orm";
import { channels, type Channel } from "@shared/schema";
import type { SourceLockService } from "./source-lock.service";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

export interface SourceLockInitResult {
  channelId: number;
  channelName: string;
  fieldsInitialized: number;
  lockStatus: Record<string, boolean>;
}

/**
 * Initialize source lock defaults for a specific channel.
 */
export async function initializeSourceLockDefaults(
  db: DrizzleDb,
  sourceLockService: SourceLockService,
  channelId: number,
): Promise<SourceLockInitResult> {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) {
    throw new Error(`Channel ${channelId} not found`);
  }

  console.log(`[SourceLockInit] Initializing defaults for channel "${channel.name}" (${channelId})`);

  const fieldsInitialized = await sourceLockService.initializeChannelDefaults(channelId, "system_init");
  const lockStatus = await sourceLockService.getChannelLockStatus(channelId);

  console.log(`[SourceLockInit] Initialized ${fieldsInitialized} field configs for channel "${channel.name}"`);
  console.log(`[SourceLockInit] Lock status:`, lockStatus);

  return {
    channelId,
    channelName: channel.name,
    fieldsInitialized,
    lockStatus: lockStatus as Record<string, boolean>,
  };
}

/**
 * Initialize source lock defaults for ALL active channels.
 */
export async function initializeAllChannelDefaults(
  db: DrizzleDb,
  sourceLockService: SourceLockService,
): Promise<SourceLockInitResult[]> {
  const activeChannels: Channel[] = await db
    .select()
    .from(channels)
    .where(eq(channels.status, "active"));

  const results: SourceLockInitResult[] = [];

  for (const channel of activeChannels) {
    try {
      const result = await initializeSourceLockDefaults(db, sourceLockService, channel.id);
      results.push(result);
    } catch (err: any) {
      console.error(`[SourceLockInit] Failed for channel ${channel.name}: ${err.message}`);
    }
  }

  return results;
}
