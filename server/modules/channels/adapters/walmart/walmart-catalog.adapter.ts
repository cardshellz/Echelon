import type { ChannelCatalogQuery } from "@shared/types/channel-catalog";
import type { ChannelCatalogAccount, ChannelCatalogProvider } from "../../channel-catalog.service";
import type { WalmartChannelService } from "./walmart-channel.service";
import { WalmartApiError } from "./walmart-client";

/** Walmart translates catalog reads; the channel catalog service owns matching and writes. */
export class WalmartCatalogAdapter implements ChannelCatalogProvider {
  constructor(private readonly channels: WalmartChannelService) {}
  async account(channelId: number): Promise<ChannelCatalogAccount> {
    const connection = await this.channels.connection(channelId);
    const account = await this.channels.api(connection).account();
    if (account.partnerId !== connection.partner_id) {
      throw new WalmartApiError("WALMART_ACCOUNT_CHANGED", "The connected Walmart account changed; reconnect before linking listings", false);
    }
    return { channelId, connectionId: connection.connection_id, provider: "walmart" };
  }
  private async api(account: ChannelCatalogAccount) {
    if (account.provider !== "walmart") throw new WalmartApiError("WALMART_ACCOUNT_CHANGED", "Catalog account provider does not match", false);
    return this.channels.api(await this.channels.connection(account.channelId, account.connectionId));
  }
  async list(account: ChannelCatalogAccount, query: ChannelCatalogQuery) {
    return (await this.api(account)).catalogPage(query);
  }
  async item(account: ChannelCatalogAccount, sku: string) {
    return (await this.api(account)).catalogItem(sku);
  }
}
