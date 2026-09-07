/** Provider-agnostic boundary: inventory receives validated item observations. */
export interface ExternalInventorySnapshot {
  channelId: number;
  connectionId: number;
  externalLocationId: string;
  externalAccountId: string;
  items: Array<{ externalInventoryItemId: string; productVariantId: number | null; quantity: number }>;
}

export interface ExternalInventoryImportDependencies {
  read(config: Record<string, unknown>, locationId: string | null): Promise<ExternalInventorySnapshot>;
  validateSnapshot(tx: unknown, snapshot: ExternalInventorySnapshot): Promise<void>;
  withWarehouseLock<T>(warehouseId: number, work: () => Promise<T>): Promise<T>;
  clock(): Date;
}

export interface WarehouseInventorySyncResult {
  warehouseId: number;
  warehouseCode: string;
  synced: number;
  skipped: number;
  errors: string[];
}
