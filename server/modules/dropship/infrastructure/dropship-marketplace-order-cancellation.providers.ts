import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceOrderCancellationProvider,
  DropshipMarketplaceOrderCancellationRequest,
  DropshipMarketplaceOrderCancellationResult,
} from "../application/dropship-marketplace-order-cancellation-provider";
import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import { EbayDropshipOrderCancellationProvider } from "./dropship-ebay-order-cancellation.provider";
import { PgDropshipMarketplaceCredentialRepository } from "./dropship-marketplace-credentials";
import { ShopifyDropshipOrderCancellationProvider } from "./dropship-shopify-order-cancellation.provider";

export class DropshipMarketplaceOrderCancellationProviderRouter implements DropshipMarketplaceOrderCancellationProvider {
  constructor(
    private readonly providers: Partial<Record<DropshipSourcePlatform, DropshipMarketplaceOrderCancellationProvider>>,
  ) {}

  async cancelOrder(
    input: DropshipMarketplaceOrderCancellationRequest,
  ): Promise<DropshipMarketplaceOrderCancellationResult> {
    const provider = this.providers[input.platform];
    if (!provider) {
      throw new DropshipError(
        "DROPSHIP_ORDER_CANCELLATION_PROVIDER_NOT_CONFIGURED",
        "Dropship marketplace order cancellation provider is not configured.",
        { platform: input.platform, retryable: false },
      );
    }
    return provider.cancelOrder(input);
  }
}

export function createDropshipMarketplaceOrderCancellationProviderFromEnv(): DropshipMarketplaceOrderCancellationProvider {
  const credentials = new PgDropshipMarketplaceCredentialRepository();
  return new DropshipMarketplaceOrderCancellationProviderRouter({
    ebay: new EbayDropshipOrderCancellationProvider(credentials),
    shopify: new ShopifyDropshipOrderCancellationProvider(credentials),
  });
}
