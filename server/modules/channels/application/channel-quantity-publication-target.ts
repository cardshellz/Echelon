import type { QuantityPublicationScope } from "../../inventory-planning/quantity-publication-admission.api";

/** Current legacy mapping ownership. This is not a quantity or provider credential snapshot. */
export interface ChannelQuantityPublicationTarget {
  scope: QuantityPublicationScope;
  channelId: number;
  productId: number;
  productVariantId: number;
}
