import { ChannelIdentityService } from "../../channels/channel-identity.service";
import { CustomerReturnCustomerProfileService } from "../application/customer-return-customer-profile.service";
import { ShopifyCustomerReturnCustomerProfileReader } from "./customer-return-customer-profile.reader";

/** Separate composition keeps profile provider latency out of session/orders. */
export async function createCustomerReturnCustomerProfileService() {
  const { db } = await import("../../../db");
  const channels = new ChannelIdentityService(db);
  return new CustomerReturnCustomerProfileService(new ShopifyCustomerReturnCustomerProfileReader({
    resolveConnection: channelId => channels.shopifyConnection(channelId), request: fetch,
  }));
}
