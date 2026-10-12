import type { ListingAccount } from "@shared/types/channel-listing-publication";
import type { ListingLifecycleProvider } from "../../../marketplace-listings/application/listing-lifecycle-ports";
import { listingAccountKey } from "../../../marketplace-listings/domain/listing-publication";
import type { InventoryPublicationTargetVariantHoldService } from "../../../inventory-planning/application/inventory-publication-target-variant-hold.service";
import {
  walmartListingAccount,
  type WalmartChannelService,
} from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";

/** Retirement applies to the seller SKU for the account, not just one ship node.
 * Stock holds stay with the inventory owner; this adapter never calculates ATP. */
export class WalmartListingLifecycleProvider
  implements ListingLifecycleProvider
{
  constructor(
    private readonly channels: WalmartChannelService,
    private readonly stock: Pick<
      InventoryPublicationTargetVariantHoldService,
      "holdVariants"
    >,
  ) {}

  async account(channelId: number): Promise<ListingAccount> {
    return walmartListingAccount(await this.channels.connection(channelId));
  }

  private async connection(account: ListingAccount) {
    const connection = await this.channels.connection(
      account.channelId,
      account.connectionId,
    );
    const current = walmartListingAccount(connection);
    if (
      listingAccountKey(current) !== listingAccountKey(account) ||
      current.scopeId !== account.scopeId ||
      current.revision !== account.revision
    ) {
      throw new WalmartApiError(
        "WALMART_ACCOUNT_CHANGED",
        "The Walmart connection changed. Refresh before continuing.",
        false,
      );
    }
    this.channels.requireRuntime(connection);
    return connection;
  }

  async observe(account: ListingAccount, sku: string) {
    const connection = await this.connection(account);
    const item = await this.channels.listingApi(connection).observe(sku);
    return {
      sku: item.sku,
      title: item.productName?.trim() || sku,
      // UNPUBLISHED, SYSTEM_PROBLEM, and a missing item do not prove retirement.
      retired:
        item.lifecycleStatus === "RETIRED" &&
        item.publishedStatus !== "PUBLISHED",
    };
  }

  async holdStock(
    account: ListingAccount,
    sku: string,
    operationId: string,
    actor: string,
  ): Promise<void> {
    await this.connection(account);
    const mappings = await this.channels.repository.mappings(account.channelId);
    for (const mapping of mappings.filter((item) => item.channel_sku === sku)) {
      await this.stock.holdVariants(
        {
          destination: {
            destinationKind: "channel_connection",
            connectionId: account.connectionId,
          },
          productVariantIds: [mapping.product_variant_id],
          reason: "Listing unpublished from Echelon",
          idempotencyKey: `listing-stop:${operationId}:${mapping.product_variant_id}`,
        },
        actor,
      );
    }
  }

  async retire(
    account: ListingAccount,
    sku: string,
    correlationId: string,
  ): Promise<void> {
    // Connection changes and inventory dispatch share this lock. The lifecycle
    // owner already holds this seller SKU's publication lock before entering here.
    await this.channels.repository.withLock(account.channelId, async () => {
      const connection = await this.connection(account);
      await this.channels.listingApi(connection).retire(sku, correlationId);
    });
  }
}
