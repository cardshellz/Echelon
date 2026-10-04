import { describe, expect, it } from "vitest";
import { memberKeyForChannelOrder, MEMBERSHIP_CHANNEL_PROVIDERS } from "../../domain/member-key";

describe("memberKeyForChannelOrder", () => {
  it("keys a Shopify order by its Shopify customer id", () => {
    expect(memberKeyForChannelOrder({ channelProvider: "shopify", externalCustomerId: "23325275357343" }))
      .toEqual({ kind: "shopify_customer", shopifyCustomerId: "23325275357343" });
  });

  it("normalizes the id the way the membership app does", () => {
    expect(memberKeyForChannelOrder({
      channelProvider: "shopify",
      externalCustomerId: "gid://shopify/Customer/23325275357343",
    })).toEqual({ kind: "shopify_customer", shopifyCustomerId: "23325275357343" });
  });

  it("reads the provider without regard to case or surrounding spaces", () => {
    expect(memberKeyForChannelOrder({ channelProvider: " Shopify ", externalCustomerId: "1" }))
      .toEqual({ kind: "shopify_customer", shopifyCustomerId: "1" });
  });

  it("never keys a marketplace order to a member, even with a customer id", () => {
    for (const channelProvider of ["ebay", "walmart", "amazon", "etsy", "manual"]) {
      expect(memberKeyForChannelOrder({ channelProvider, externalCustomerId: "buyer-123" }))
        .toEqual({ kind: "none", reason: "channel_without_membership" });
    }
  });

  it("treats an unknown or missing channel as one without membership", () => {
    for (const channelProvider of [null, undefined, "", "   ", "shopify-plus"]) {
      expect(memberKeyForChannelOrder({ channelProvider, externalCustomerId: "23325275357343" }))
        .toEqual({ kind: "none", reason: "channel_without_membership" });
    }
  });

  it("reports a Shopify order without a usable customer id, such as a guest checkout", () => {
    for (const externalCustomerId of [null, undefined, "", "   ", "gid://shopify/Customer/"]) {
      expect(memberKeyForChannelOrder({ channelProvider: "shopify", externalCustomerId }))
        .toEqual({ kind: "none", reason: "no_customer_id" });
    }
  });

  it("limits membership to the Shopify storefront", () => {
    expect([...MEMBERSHIP_CHANNEL_PROVIDERS]).toEqual(["shopify"]);
  });
});
