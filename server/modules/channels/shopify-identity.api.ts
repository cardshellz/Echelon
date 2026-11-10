/**
 * Internal API facade for Shopify channel identity & provider reads (CI-03 / CHN-2).
 *
 * Peer modules (e.g. `returns`) must import `ShopifyIdentityReader` and
 * `ShopifyIdentityConnection` through this facade rather than reaching into
 * `channels/adapters/*`.
 */

export {
  ShopifyIdentityReader,
  type ShopifyIdentityConnection,
  type ShopifyVariantIdentity,
} from "./adapters/shopify-identity.reader";
export { ChannelIdentityService } from "./channel-identity.service";
export {
  ChannelIdentityError,
  type ChannelItemIdentity,
} from "./channel-identity.domain";
