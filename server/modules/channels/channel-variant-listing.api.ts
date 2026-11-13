/**
 * Internal API facade for per-channel variant listing state.
 *
 * Peer modules (e.g. `catalog`) must import `markChannelVariantNotListed`
 * through this facade rather than writing `channels.channel_variant_overrides`.
 */

export { markChannelVariantNotListed } from "./channel-variant-listing.repository";
