/**
 * Default Channel Order Intake Adapter Registry (`P3.1`)
 *
 * Registers Echelon's first-party `ChannelOrderAdapter` implementations
 * (`shopify`, `ebay`) on `ChannelOrderAdapterRegistry`.
 */

import { ChannelOrderAdapterRegistry } from "../../channels/channel-adapter.interface";
import type { EbayApiClient } from "../../channels/ebay-connector.api";
import {
  createEbayOrderIntakeAdapter,
  type EbayOrderIntakeAdapterOptions,
} from "./ebay-order-intake.adapter";
import {
  createShopifyOrderIntakeAdapter,
  type ShopifyOrderIntakeAdapterOptions,
} from "./shopify-order-intake.adapter";

export interface DefaultChannelOrderAdapterRegistryOptions {
  shopify?: ShopifyOrderIntakeAdapterOptions;
  ebay?: EbayOrderIntakeAdapterOptions & { ebayApiClient?: EbayApiClient };
}

export function createDefaultChannelOrderAdapterRegistry(
  options: DefaultChannelOrderAdapterRegistryOptions = {},
): ChannelOrderAdapterRegistry {
  const registry = new ChannelOrderAdapterRegistry();
  registry.register(createShopifyOrderIntakeAdapter(options.shopify));
  registry.register(createEbayOrderIntakeAdapter(options.ebay));
  return registry;
}
