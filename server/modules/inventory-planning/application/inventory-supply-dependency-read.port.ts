/** Invalidation scope only. This does not authorize supply or calculate ATP. */
export interface InventorySupplyDependencyReader {
  getAffectedProductIds(changedVariantId: number): Promise<readonly number[]>;
}
