/**
 * Which identity, if any, ties an order to a Card Shellz member. Pure.
 *
 * Membership belongs to Card Shellz's own storefront customers: a Shopify order
 * names its member by the Shopify customer id. Marketplace buyers (eBay,
 * Walmart, ...) are never members for Card Shellz purposes, even when their
 * email happens to match one (owner decision, 2026-10-03). Dropship orders
 * belong to the vendor and are keyed by the vendor's member id, which
 * acceptance records (resolver plan step 4).
 */

import { normalizeShopifyCustomerId } from "./shopify-customer-id";

/** channels.channels.provider values whose customers can be members. */
export const MEMBERSHIP_CHANNEL_PROVIDERS: ReadonlySet<string> = new Set(["shopify"]);

export type MemberKeyAbsenceReason =
  /** The order's channel never carries membership (eBay, Walmart, ...). */
  | "channel_without_membership"
  /** A membership channel, but the order names no usable customer id (e.g. guest checkout). */
  | "no_customer_id";

export type MemberKey =
  | { kind: "shopify_customer"; shopifyCustomerId: string }
  | { kind: "member"; memberId: string }
  | { kind: "none"; reason: MemberKeyAbsenceReason };

export function memberKeyForChannelOrder(input: {
  channelProvider: string | null | undefined;
  externalCustomerId: string | null | undefined;
}): MemberKey {
  const provider = typeof input.channelProvider === "string"
    ? input.channelProvider.trim().toLowerCase()
    : "";
  if (!MEMBERSHIP_CHANNEL_PROVIDERS.has(provider)) {
    return { kind: "none", reason: "channel_without_membership" };
  }
  const shopifyCustomerId = normalizeShopifyCustomerId(input.externalCustomerId);
  return shopifyCustomerId === null
    ? { kind: "none", reason: "no_customer_id" }
    : { kind: "shopify_customer", shopifyCustomerId };
}
