import { eq, and, sql } from "drizzle-orm";
import {
  warehouses,
  warehouseLocations,
  inventoryLevels,
  inventoryTransactions,
  productVariants,
  channelConnections,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: <T = any>(query: any) => Promise<{ rows: T[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface InventorySnapshot {
  /** Map of shopifyInventoryItemId → available quantity */
  items: Map<string, number>;
  syncedAt: Date;
}

export interface InventorySourceAdapter {
  pull(warehouseId: number, config: Record<string, any>): Promise<InventorySnapshot>;
}

export interface SyncResult {
  warehouseId: number;
  warehouseCode: string;
  synced: number;
  skipped: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Shopify Channel Adapter
// ---------------------------------------------------------------------------

/**
 * Pulls inventory levels from a Shopify location.
 * Used when warehouse.inventorySourceType = 'channel' and the channel is Shopify.
 */
class ShopifyChannelAdapter implements InventorySourceAdapter {
  constructor(private readonly db: DrizzleDb) {}

  async pull(warehouseId: number, config: Record<string, any>): Promise<InventorySnapshot> {
    const items = new Map<string, number>();

    // Get warehouse's Shopify location ID
    const [wh] = await this.db.select().from(warehouses).where(eq(warehouses.id, warehouseId)).limit(1);
    if (!wh?.shopifyLocationId) {
      throw new Error(`Warehouse ${warehouseId} has no shopifyLocationId configured`);
    }

    // Get channel credentials from inventorySourceConfig.channelId
    const channelId = config?.channelId;
    if (!channelId) {
      throw new Error(`Warehouse ${warehouseId} has no channelId in inventorySourceConfig`);
    }

    const [conn] = await this.db
      .select()
      .from(channelConnections)
      .where(eq(channelConnections.channelId, channelId))
      .limit(1);

    if (!conn?.shopDomain || !conn?.accessToken) {
      throw new Error(`Channel ${channelId} has no Shopify credentials configured`);
    }

    // Fetch inventory levels from Shopify for this location
    const shopifyLocationId = wh.shopifyLocationId;
    const apiVersion = conn.apiVersion || "2024-01";
    let pageInfo: string | null = null;
    let hasMore = true;

    while (hasMore) {
      const url = pageInfo
        ? `https://${conn.shopDomain}/admin/api/${apiVersion}/inventory_levels.json?page_info=${pageInfo}&limit=250`
        : `https://${conn.shopDomain}/admin/api/${apiVersion}/inventory_levels.json?location_ids=${shopifyLocationId}&limit=250`;

      const response = await fetch(url, {
        headers: {
          "X-Shopify-Access-Token": conn.accessToken,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const levels = data.inventory_levels || [];

      for (const level of levels) {
        items.set(String(level.inventory_item_id), level.available ?? 0);
      }

      // Handle pagination via Link header
      const linkHeader = response.headers.get("Link");
      if (linkHeader?.includes('rel="next"')) {
        const match = linkHeader.match(/<[^>]*page_info=([^>&]*).*?>;\s*rel="next"/);
        pageInfo = match?.[1] || null;
        hasMore = !!pageInfo;
      } else {
        hasMore = false;
      }
    }

    return { items, syncedAt: new Date() };
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Inventory source service.
 *
 * Pulls inventory from external sources (Shopify, 3PL APIs) and reconciles
 * with Echelon's inventory levels. Each warehouse with inventorySourceType
 * != 'internal' can be synced via the appropriate adapter.
 *
 * Adapter pattern: add new adapters for new source types without changing
 * core logic.
 */
class InventorySourceService {
  private adapters: Record<string, InventorySourceAdapter>;

  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: any,
  ) {
    this.adapters = {
      channel: new ShopifyChannelAdapter(db),
      // Future: integration: new ThreePLIntegrationAdapter(db),
    };
  }

  /**
   * Sync inventory for a single external warehouse.
   * Pulls from the configured source and sets inventory levels at the
   * warehouse's 3pl_virtual location.
   */
  async syncWarehouse(warehouseId: number): Promise<SyncResult> {
    const [wh] = await this.db
      .select()
      .from(warehouses)
      .where(eq(warehouses.id, warehouseId))
      .limit(1);

    if (!wh) throw new Error(`Warehouse ${warehouseId} not found`);

    const result: SyncResult = {
      warehouseId: wh.id,
      warehouseCode: wh.code,
      synced: 0,
      skipped: 0,
      errors: [],
    };

    if (wh.inventorySourceType === "internal" || wh.inventorySourceType === "manual") {
      result.errors.push(`Warehouse ${wh.code} has source type '${wh.inventorySourceType}' — nothing to pull`);
      return result;
    }

    const adapter = this.adapters[wh.inventorySourceType];
    if (!adapter) {
      result.errors.push(`No adapter for source type '${wh.inventorySourceType}'`);
      return result;
    }

    // Update sync status
    await this.db.update(warehouses)
      .set({ inventorySyncStatus: "syncing", updatedAt: new Date() })
      .where(eq(warehouses.id, warehouseId));

    try {
      const config = (wh.inventorySourceConfig as Record<string, any>) || {};
      const snapshot = await adapter.pull(warehouseId, config);

      // Ensure a 3pl_virtual location exists for this warehouse
      const virtualLocation = await this.ensureVirtualLocation(warehouseId, wh.code);

      // Map shopifyInventoryItemId → productVariantId
      const inventoryItemIds = Array.from(snapshot.items.keys());
      if (inventoryItemIds.length === 0) {
        await this.db.update(warehouses)
          .set({
            inventorySyncStatus: "ok",
            lastInventorySyncAt: snapshot.syncedAt,
            updatedAt: new Date(),
          })
          .where(eq(warehouses.id, warehouseId));
        return result;
      }

      // Batch lookup variants by shopifyInventoryItemId
      const variants = await this.db.execute<{
        id: number;
        shopify_inventory_item_id: string;
      }>(sql`
        SELECT id, shopify_inventory_item_id FROM product_variants
        WHERE shopify_inventory_item_id IN (${sql.join(inventoryItemIds.map(id => sql`${id}`), sql`, `)})
      `);

      const variantMap = new Map(variants.rows.map(v => [v.shopify_inventory_item_id, v.id]));

      // Set inventory levels for each item
      for (const [inventoryItemId, qty] of snapshot.items) {
        const variantId = variantMap.get(inventoryItemId);
        if (!variantId) {
          result.skipped++;
          continue;
        }

        try {
          await this.setInventoryLevel(virtualLocation.id, variantId, qty, warehouseId);
          result.synced++;
        } catch (err: any) {
          result.errors.push(`Variant ${variantId}: ${err.message}`);
        }
      }

      await this.db.update(warehouses)
        .set({
          inventorySyncStatus: "ok",
          lastInventorySyncAt: snapshot.syncedAt,
          updatedAt: new Date(),
        })
        .where(eq(warehouses.id, warehouseId));

    } catch (err: any) {
      await this.db.update(warehouses)
        .set({
          inventorySyncStatus: "error",
          updatedAt: new Date(),
        })
        .where(eq(warehouses.id, warehouseId));
      result.errors.push(err.message);
    }

    return result;
  }

  /**
   * Sync all external warehouses (where inventorySourceType != 'internal' and != 'manual').
   */
  async syncAll(): Promise<SyncResult[]> {
    const externalWarehouses = await this.db
      .select()
      .from(warehouses)
      .where(
        and(
          eq(warehouses.isActive, 1),
          sql`${warehouses.inventorySourceType} NOT IN ('internal', 'manual')`,
        ),
      );

    const results: SyncResult[] = [];
    for (const wh of externalWarehouses) {
      const result = await this.syncWarehouse(wh.id);
      results.push(result);
    }
    return results;
  }

  /**
   * Ensure a 3pl_virtual location exists for the given warehouse.
   * Auto-creates one if not found.
   */
  private async ensureVirtualLocation(warehouseId: number, warehouseCode: string) {
    const virtualCode = `${warehouseCode}-VIRTUAL`;
    const [existing] = await this.db
      .select()
      .from(warehouseLocations)
      .where(
        and(
          eq(warehouseLocations.warehouseId, warehouseId),
          eq(warehouseLocations.locationType, "3pl_virtual"),
        ),
      )
      .limit(1);

    if (existing) return existing;

    // Create virtual location
    const [created] = await this.db
      .insert(warehouseLocations)
      .values({
        warehouseId,
        code: virtualCode,
        name: `${warehouseCode} Virtual Inventory`,
        locationType: "3pl_virtual",
        binType: "floor",
        isPickable: 0,
      })
      .returning();

    return created;
  }

  /**
   * Absolute SET of inventory level (not delta).
   * Calculates delta from current, updates level, logs transaction.
   */
  private async setInventoryLevel(
    locationId: number,
    variantId: number,
    newQty: number,
    warehouseId: number,
  ): Promise<void> {
    // Upsert the inventory level
    const [existing] = await this.db
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.warehouseLocationId, locationId),
          eq(inventoryLevels.productVariantId, variantId),
        ),
      )
      .limit(1);

    const oldQty = existing?.variantQty ?? 0;
    const delta = newQty - oldQty;

    if (delta === 0) return; // No change

    if (existing) {
      await this.db
        .update(inventoryLevels)
        .set({ variantQty: newQty, updatedAt: new Date() })
        .where(eq(inventoryLevels.id, existing.id));
    } else {
      await this.db
        .insert(inventoryLevels)
        .values({
          warehouseLocationId: locationId,
          productVariantId: variantId,
          variantQty: newQty,
          reservedQty: 0,
          pickedQty: 0,
          packedQty: 0,
          backorderQty: 0,
        });
    }

    // Log the sync transaction
    await this.db.insert(inventoryTransactions).values({
      productVariantId: variantId,
      warehouseLocationId: locationId,
      transactionType: "3pl_sync",
      qty: delta,
      referenceId: `warehouse-${warehouseId}`,
      notes: `Synced from external source (set to ${newQty}, delta ${delta > 0 ? "+" : ""}${delta})`,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInventorySourceService(db: any, inventoryCore: any) {
  return new InventorySourceService(db, inventoryCore);
}
