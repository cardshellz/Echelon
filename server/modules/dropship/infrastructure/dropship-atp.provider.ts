import type { DropshipAtpProvider } from "../application/dropship-selection-atp-service";

interface InventoryAtpServiceLike {
  getBulkAtp(productIds: number[]): Promise<Map<number, number>>;
}

export class InventoryServiceDropshipAtpProvider implements DropshipAtpProvider {
  constructor(private readonly inventoryAtpService: InventoryAtpServiceLike) {}

  async getBaseAtpByProductIds(productIds: readonly number[]): Promise<Map<number, number>> {
    if (productIds.length === 0) {
      return new Map();
    }
    return this.inventoryAtpService.getBulkAtp([...productIds]);
  }
}
