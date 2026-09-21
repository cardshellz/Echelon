export interface InventoryPublicationSupplyScope {
  channelId: number;
  channelConnectionId: number;
  providerScopeType: "location";
  externalScopeId: string;
}
export interface InventoryPublicationSourceWarehouse {
  warehouseId: number | null;
  isActive: boolean;
}
/** Read-only planning API. Empty, inactive or non-warehouse supply must not authorize a promise. */
export interface InventoryPublicationSupplyReader {
  getSourceWarehouses(scope: InventoryPublicationSupplyScope): Promise<ReadonlyArray<InventoryPublicationSourceWarehouse>>;
}
