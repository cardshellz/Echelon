import { createShopifyProductConnectionService } from "../modules/catalog/shopify-product-connection.service";
import { createShopifyProductConnectionRepository } from "../modules/catalog/shopify-product-connection.repository";
import { createShopifyProductConnectionProvider } from "../modules/catalog/shopify-product-connection.provider";
import { createShopifyProductMappingService } from "../modules/catalog/shopify-product-mapping.service";

/** Shared composition for HTTP admission and durable background recovery. */
export function createDefaultShopifyProductConnectionService(input: {
  onConnected?: (productId: number, trackedVariantIds: readonly number[]) => Promise<void>;
  now?: () => Date;
} = {}) {
  const now = input.now ?? (() => new Date());
  return createShopifyProductConnectionService({
    repository: createShopifyProductConnectionRepository({ now }),
    provider: createShopifyProductConnectionProvider(),
    mappingOwner: createShopifyProductMappingService({ now }),
    onConnected: input.onConnected,
  });
}
