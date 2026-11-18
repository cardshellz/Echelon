/**
 * Internal API facade for channel product identity bindings (CI-03 / CHN-2).
 *
 * Peer modules (e.g. `catalog`) must import `upsertChannelProductIdentity` and
 * `removeChannelProductIdentities` through this facade rather than reaching
 * into `channel-product-identity.repository.ts`.
 */

export {
  upsertChannelProductIdentity,
  removeChannelProductIdentities,
} from "./channel-product-identity.repository";
