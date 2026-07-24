import { describe, expect, it } from "vitest";
import {
  ChannelShippingCapabilityRegistry,
  MANUAL_CHANNEL_SHIPPING_CAPABILITY_DECLARATION,
} from "../../channel-shipping-capability.registry";

describe("ChannelShippingCapabilityRegistry", () => {
  it("normalizes provider keys and returns immutable declarations", () => {
    const registry = new ChannelShippingCapabilityRegistry();
    registry.register({
      providerKey: " Shopify ",
      shippingCapabilities: {
        acceptsEngineQuotes: true,
        managesOwnRates: true,
        enforcesDestinationEligibility: true,
      },
    });

    const capabilities = registry.resolve("SHOPIFY");

    expect(capabilities).toEqual({
      acceptsEngineQuotes: true,
      managesOwnRates: true,
      enforcesDestinationEligibility: true,
    });
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(registry.registeredProviders()).toEqual(["shopify"]);
  });

  it("rejects duplicate and blank provider declarations", () => {
    const registry = new ChannelShippingCapabilityRegistry();
    registry.register(MANUAL_CHANNEL_SHIPPING_CAPABILITY_DECLARATION);

    expect(() => registry.register({
      ...MANUAL_CHANNEL_SHIPPING_CAPABILITY_DECLARATION,
      providerKey: "MANUAL",
    })).toThrow(/already registered/);
    expect(() => registry.register({
      providerKey: " ",
      shippingCapabilities: {
        acceptsEngineQuotes: false,
        managesOwnRates: false,
        enforcesDestinationEligibility: false,
      },
    })).toThrow(/provider key is required/);
  });

  it("returns null for a provider without a registered adapter", () => {
    const registry = new ChannelShippingCapabilityRegistry();

    expect(registry.resolve("amazon")).toBeNull();
    expect(registry.resolve(" ")).toBeNull();
  });
});
