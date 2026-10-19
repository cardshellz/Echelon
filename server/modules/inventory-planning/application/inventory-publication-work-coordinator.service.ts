import type { InventorySyncResult } from "../../channels/echelon-sync-orchestrator.service";
import type {
  EffectiveChannelSyncState,
  GlobalSyncSettingsView,
} from "../../channels/sync-settings.service";
import type { InventoryAvailabilityRuntimeAuthority } from "./inventory-availability-runtime-atp.service";

interface RuntimeAuthorityReader {
  readAuthority(): Promise<InventoryAvailabilityRuntimeAuthority>;
}

interface EffectiveStateReader {
  getGlobalSettings(): Promise<GlobalSyncSettingsView>;
  listEffectiveSyncStates(): Promise<EffectiveChannelSyncState[]>;
}

interface InventoryPublicationOrchestrator {
  syncInventoryForProduct(
    productId: number,
    config: { dryRun: boolean },
    triggeredBy: string,
  ): Promise<InventorySyncResult[]>;
  syncInventoryForChannelProduct(
    channelId: number,
    productId: number,
    config: { dryRun: boolean },
    triggeredBy: string,
  ): Promise<InventorySyncResult[]>;
  syncInventoryForAllProducts(
    config: { dryRun: boolean },
    triggeredBy: string,
    channelId?: number,
  ): Promise<InventorySyncResult[]>;
}

/** Durable "this product's stock changed" marker; the publication worker drains it. */
export interface InventoryPublicationChangeMarker {
  markProductsChanged(productIds: readonly number[]): Promise<void>;
}

export type InventoryChangeRecordResult =
  | { mode: "marked"; productIds: number[] }
  | { mode: "published"; productIds: number[]; results: InventoryPublicationWorkResult[] };

export interface InventoryPublicationWorkResult {
  authority: InventoryAvailabilityRuntimeAuthority | null;
  inventory: InventorySyncResult[];
  skippedReason: string | null;
}

/**
 * Sole pre-I/O work-creation authority for manual, scheduled, and event-driven
 * inventory publication. The provider admission fence remains the final,
 * transaction-pinned defense against control changes after this plan is read.
 */
export class InventoryPublicationWorkCoordinator {
  constructor(
    private readonly authority: RuntimeAuthorityReader,
    private readonly effectiveState: EffectiveStateReader,
    private readonly orchestrator: InventoryPublicationOrchestrator,
    private readonly changeMarker?: InventoryPublicationChangeMarker,
  ) {}

  /**
   * Inventory-change entry point for every warehouse operation. Under canonical
   * authority it only records the change durably and returns: the publication
   * worker plans, isolates broken listings and retries, so channel trouble can
   * never fail or slow the custody operation that changed stock. Legacy
   * authority has no worker-owned planner, so it keeps publishing inline.
   */
  async recordInventoryChange(productIds: readonly number[], triggeredBy: string): Promise<InventoryChangeRecordResult> {
    const ids = [...new Set(productIds.map(id => positiveInteger(id, "productId")))].sort((a, b) => a - b);
    if (ids.length === 0) return { mode: "marked", productIds: [] };
    if (this.changeMarker && await this.authority.readAuthority() === "canonical") {
      await this.changeMarker.markProductsChanged(ids);
      return { mode: "marked", productIds: ids };
    }
    const results: InventoryPublicationWorkResult[] = [];
    for (const productId of ids) results.push(await this.syncProduct(productId, triggeredBy));
    return { mode: "published", productIds: ids, results };
  }

  async syncProduct(productId: number, triggeredBy: string): Promise<InventoryPublicationWorkResult> {
    positiveInteger(productId, "productId");
    return this.execute(
      (channel) => this.orchestrator.syncInventoryForChannelProduct(
        channel.channelId,
        productId,
        { dryRun: channel.dryRun },
        triggeredBy,
      ),
      () => this.orchestrator.syncInventoryForProduct(productId, { dryRun: false }, triggeredBy),
    );
  }

  async syncAllProducts(triggeredBy: string): Promise<InventoryPublicationWorkResult> {
    return this.execute(
      (channel) => this.orchestrator.syncInventoryForAllProducts(
        { dryRun: channel.dryRun },
        triggeredBy,
        channel.channelId,
      ),
      () => this.orchestrator.syncInventoryForAllProducts({ dryRun: false }, triggeredBy),
    );
  }

  async syncChannelProducts(
    channelId: number,
    triggeredBy: string,
  ): Promise<InventoryPublicationWorkResult> {
    positiveInteger(channelId, "channelId");
    return this.execute(
      (channel) => this.orchestrator.syncInventoryForAllProducts(
        { dryRun: channel.dryRun },
        triggeredBy,
        channel.channelId,
      ),
      () => this.orchestrator.syncInventoryForAllProducts(
        { dryRun: false },
        triggeredBy,
        channelId,
      ),
      channelId,
    );
  }

  private async execute(
    legacyRun: (channel: EffectiveChannelSyncState) => Promise<InventorySyncResult[]>,
    canonicalRun: () => Promise<InventorySyncResult[]>,
    selectedChannelId?: number,
  ): Promise<InventoryPublicationWorkResult> {
    const global = await this.effectiveState.getGlobalSettings();
    if (!global.globalEnabled) {
      return { authority: null, inventory: [], skippedReason: "PUBLICATION_GLOBAL_STOP_ACTIVE" };
    }
    const authority = await this.authority.readAuthority();
    if (authority === "canonical") {
      return { authority, inventory: await canonicalRun(), skippedReason: null };
    }
    const states = await this.effectiveState.listEffectiveSyncStates();
    const selected = selectedChannelId == null
      ? states
      : states.filter((state) => state.channelId === selectedChannelId);
    if (selectedChannelId != null && selected.length === 0) {
      return { authority, inventory: [], skippedReason: "CHANNEL_NOT_FOUND_OR_INACTIVE" };
    }
    const runnable = selected.filter((state) => state.shouldSync);
    if (runnable.length === 0) {
      return {
        authority,
        inventory: [],
        skippedReason: selected[0]?.reason ?? "NO_EFFECTIVE_LEGACY_CHANNELS",
      };
    }
    const inventory: InventorySyncResult[] = [];
    for (const channel of runnable) inventory.push(...await legacyRun(channel));
    return { authority, inventory, skippedReason: null };
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${field} must be a positive PostgreSQL integer`);
  }
  return value;
}
