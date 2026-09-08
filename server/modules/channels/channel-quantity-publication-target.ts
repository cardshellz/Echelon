import type { QuantityPublicationScope } from "../inventory-planning/domain/quantity-publication-admission";

/** Current legacy mapping ownership. This is not a quantity or provider credential snapshot. */
export interface ChannelQuantityPublicationTarget {
  scope: QuantityPublicationScope;
  channelId: number;
  productId: number;
  productVariantId: number;
}
