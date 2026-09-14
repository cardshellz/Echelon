import type { Pool } from "pg";

import { pool as defaultPool } from "../../../../db";
import type { InventoryAtpServiceContract } from "../../../inventory/atp.service";
import type { InventoryChannelQuantityRuntimeService } from "../../../inventory-planning/application/inventory-channel-quantity-runtime.service";
import { createAuthorityAwareInventoryAtpService } from "../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import { createInventoryChannelQuantityRuntimeService } from "../../../inventory-planning/infrastructure/inventory-availability-runtime-publication.repository";

export interface EbayChannelVariantQuantity {
  productVariantId: number;
  atpUnits: number;
}

/**
 * Read model shared by direct eBay listing screens, maintenance, and marketplace
 * registration. Before cutover it preserves the deployed raw-ATP behavior.
 * After cutover it returns only the direct-channel publication target quantity,
 * including the active source binding and channel dial.
 */
export class EbayChannelQuantityReader {
  constructor(
    private readonly runtime: InventoryChannelQuantityRuntimeService,
    private readonly legacyAtp: Pick<InventoryAtpServiceContract, "getAtpPerVariant">,
  ) {}

  async getAtpPerVariant(
    productId: number,
    channelId: number,
  ): Promise<readonly EbayChannelVariantQuantity[]> {
    const result = await this.runtime.readProduct({
      productId,
      channelId,
      target: {
        destinationKind: "channel_connection",
        providerKey: "ebay",
      },
      triggeredBy: "ebay_listing_quantity_read",
    }, async () => (await this.legacyAtp.getAtpPerVariant(productId)).map((row) => ({
      productVariantId: row.productVariantId,
      quantity: row.atpUnits,
    })));
    return result.rows.map((row) => ({
      productVariantId: row.productVariantId,
      atpUnits: row.quantity,
    }));
  }
}

export function createEbayChannelQuantityReader(
  connectionPool: Pool = defaultPool,
): EbayChannelQuantityReader {
  return new EbayChannelQuantityReader(
    createInventoryChannelQuantityRuntimeService(connectionPool),
    createAuthorityAwareInventoryAtpService(connectionPool),
  );
}
