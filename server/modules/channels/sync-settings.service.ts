/**
 * Sync Settings Service
 *
 * Manages global sync settings, per-channel sync config, and the sync log.
 * This is the control plane for the Echelon sync engine.
 */

import { eq, and, sql, desc, gte, lte, inArray } from "drizzle-orm";
import {
  syncSettings,
  syncLog,
  channels,
  warehouses,
  type SyncSettings,
  type SyncLogEntry,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
};

export interface SyncLogWriteParams {
  channelId: number | null;
  channelName: string;
  action: string;
  sku?: string | null;
  productVariantId?: number | null;
  previousValue?: string | null;
  newValue?: string | null;
  status: string;
  errorMessage?: string | null;
  source: string;
}

export interface SyncLogQueryParams {
  channelId?: number;
  status?: string;
  dateFrom?: Date;
  dateTo?: Date;
  limit?: number;
  offset?: number;
}

export interface SyncLogSummary {
  pushed: number;
  dryRun: number;
  errors: number;
  skipped: number;
}

export type GlobalSyncSettingsView = Omit<SyncSettings, "revision"> & { revision: string };

export interface EffectiveChannelSyncState {
  channelId: number;
  channelName: string;
  provider: string;
  shouldSync: boolean;
  dryRun: boolean;
  reason: string;
}

class SyncSettingsService {
  constructor(private readonly db: DrizzleDb) {}

  // =========================================================================
  // GLOBAL SETTINGS
  // =========================================================================

  async getGlobalSettings(): Promise<GlobalSyncSettingsView> {
    const settingsRows = await this.db
      .select()
      .from(syncSettings)
      .where(eq(syncSettings.singletonKey, true))
      .limit(2);

    if (settingsRows.length !== 1) {
      throw new Error("Exactly one global sync-settings row is required");
    }
    return serializeGlobalSettings(settingsRows[0]!);
  }

  async updateLastSweep(durationMs: number): Promise<void> {
    const settings = await this.getGlobalSettings();
    await this.db
      .update(syncSettings)
      .set({
        lastSweepAt: new Date(),
        lastSweepDurationMs: durationMs,
        updatedAt: new Date(),
      })
      .where(eq(syncSettings.id, settings.id));
  }

  // =========================================================================
  // PER-CHANNEL SYNC CONFIG
  // =========================================================================

  async getChannelSyncConfig(channelId: number): Promise<{
    syncEnabled: boolean;
    syncMode: string;
    sweepIntervalMinutes: number;
  } | null> {
    const [channel] = await this.db
      .select({
        syncEnabled: channels.syncEnabled,
        syncMode: channels.syncMode,
        sweepIntervalMinutes: channels.sweepIntervalMinutes,
      })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1);

    if (!channel) return null;

    return {
      syncEnabled: channel.syncEnabled ?? false,
      syncMode: channel.syncMode ?? "dry_run",
      sweepIntervalMinutes: channel.sweepIntervalMinutes ?? 15,
    };
  }

  async updateChannelSyncConfig(
    channelId: number,
    updates: {
      syncEnabled?: boolean;
      syncMode?: string;
      sweepIntervalMinutes?: number;
    },
  ): Promise<void> {
    await this.db
      .update(channels)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId));
  }

  // =========================================================================
  // WAREHOUSE FEED TOGGLE
  // =========================================================================

  async getWarehouseFeedEnabled(warehouseId: number): Promise<boolean> {
    const [wh] = await this.db
      .select({ feedEnabled: warehouses.feedEnabled })
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .limit(1);

    return wh?.feedEnabled ?? true;
  }

  async updateWarehouseFeedEnabled(
    warehouseId: number,
    feedEnabled: boolean,
  ): Promise<void> {
    await this.db
      .update(warehouses)
      .set({ feedEnabled, updatedAt: new Date() })
      .where(eq(warehouses.id, warehouseId));
  }

  // =========================================================================
  // SYNC LOG
  // =========================================================================

  async writeSyncLog(entry: SyncLogWriteParams): Promise<void> {
    try {
      await this.db.insert(syncLog).values({
        channelId: entry.channelId,
        channelName: entry.channelName,
        action: entry.action,
        sku: entry.sku ?? null,
        productVariantId: entry.productVariantId ?? null,
        previousValue: entry.previousValue ?? null,
        newValue: entry.newValue ?? null,
        status: entry.status,
        errorMessage: entry.errorMessage ?? null,
        source: entry.source,
      });
    } catch (err: any) {
      console.warn(`[SyncSettings] Failed to write sync log: ${err.message}`);
    }
  }

  async getSyncLog(params: SyncLogQueryParams): Promise<{
    entries: SyncLogEntry[];
    total: number;
  }> {
    const conditions: any[] = [];

    if (params.channelId) {
      conditions.push(eq(syncLog.channelId, params.channelId));
    }
    if (params.status) {
      conditions.push(eq(syncLog.status, params.status));
    }
    if (params.dateFrom) {
      conditions.push(gte(syncLog.createdAt, params.dateFrom));
    }
    if (params.dateTo) {
      conditions.push(lte(syncLog.createdAt, params.dateTo));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const entries = await this.db
      .select()
      .from(syncLog)
      .where(whereClause)
      .orderBy(desc(syncLog.createdAt))
      .limit(params.limit ?? 50)
      .offset(params.offset ?? 0);

    // Get total count
    const [{ count }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(syncLog)
      .where(whereClause);

    return { entries, total: count };
  }

  async getSyncLogSummary(hoursBack: number = 24): Promise<SyncLogSummary> {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        status: syncLog.status,
        count: sql<number>`count(*)::int`,
      })
      .from(syncLog)
      .where(gte(syncLog.createdAt, since))
      .groupBy(syncLog.status);

    const summary: SyncLogSummary = { pushed: 0, dryRun: 0, errors: 0, skipped: 0 };
    for (const row of rows) {
      switch (row.status) {
        case "pushed":
          summary.pushed = row.count;
          break;
        case "dry_run":
          summary.dryRun = row.count;
          break;
        case "error":
          summary.errors = row.count;
          break;
        case "skipped":
          summary.skipped = row.count;
          break;
      }
    }

    return summary;
  }

  // =========================================================================
  // HIERARCHY CHECK
  // =========================================================================

  /**
   * Determine effective sync state for a channel, considering the full hierarchy:
   * - Global OFF → nothing
   * - Channel sync_enabled OFF → skipped
   * - Channel mode = dry_run → log only
   * - Channel mode = live → push for real
   */
  async getEffectiveSyncState(channelId: number): Promise<{
    shouldSync: boolean;
    dryRun: boolean;
    reason: string;
  }> {
    const states = await this.listEffectiveSyncStates();
    const state = states.find((candidate) => candidate.channelId === channelId);
    if (!state) {
      return { shouldSync: false, dryRun: false, reason: "Channel not found" };
    }
    return {
      shouldSync: state.shouldSync,
      dryRun: state.dryRun,
      reason: state.reason,
    };
  }

  /**
   * Sole legacy work-creation resolver. Scheduled, event-driven, and manual
   * inventory sync callers consume this same snapshot before creating work;
   * provider admission independently rechecks the exact channel at I/O time.
   */
  async listEffectiveSyncStates(): Promise<EffectiveChannelSyncState[]> {
    const globalSettings = await this.getGlobalSettings();
    const channelRows = await this.db
      .select({
        id: channels.id,
        name: channels.name,
        provider: channels.provider,
        syncEnabled: channels.syncEnabled,
        syncMode: channels.syncMode,
      })
      .from(channels)
      .where(eq(channels.status, "active"));
    return channelRows.map((channel: any) => {
      const identity = {
        channelId: channel.id,
        channelName: channel.name,
        provider: channel.provider,
      };
      if (!globalSettings.globalEnabled) {
        return { ...identity, shouldSync: false, dryRun: false, reason: "Global sync disabled" };
      }
      if (channel.syncEnabled !== true) {
        return { ...identity, shouldSync: false, dryRun: false, reason: "Channel sync disabled" };
      }
      if (channel.syncMode === "dry_run") {
        return { ...identity, shouldSync: true, dryRun: true, reason: "Channel in dry-run mode" };
      }
      if (channel.syncMode === "live") {
        return { ...identity, shouldSync: true, dryRun: false, reason: "Live sync active" };
      }
      return { ...identity, shouldSync: false, dryRun: false, reason: "Channel sync mode invalid" };
    });
  }

  /**
   * Get all warehouses with feed_enabled status for allocation filtering.
   */
  async getDisabledWarehouseIds(): Promise<number[]> {
    const rows = await this.db
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(eq(warehouses.feedEnabled, false));

    return rows.map((r: any) => r.id);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSyncSettingsService(db: any) {
  return new SyncSettingsService(db);
}

function serializeGlobalSettings(settings: SyncSettings): GlobalSyncSettingsView {
  return { ...settings, revision: settings.revision.toString() };
}

export type { SyncSettingsService };
