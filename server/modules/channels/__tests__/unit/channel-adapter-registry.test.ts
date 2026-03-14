/**
 * Unit Tests — Channel Adapter Registry
 *
 * Tests adapter registration, lookup, duplicate prevention,
 * and registry enumeration.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ChannelAdapterRegistry,
  type IChannelAdapter,
  type ChannelListingPayload,
  type ListingPushResult,
  type InventoryPushItem,
  type InventoryPushResult,
  type PricingPushItem,
  type PricingPushResult,
  type ChannelOrder,
  type FulfillmentPayload,
  type FulfillmentPushResult,
  type CancellationPayload,
  type CancellationPushResult,
} from "../../channel-adapter.interface";

// ---------------------------------------------------------------------------
// Stub adapters for testing
// ---------------------------------------------------------------------------

function createStubAdapter(name: string, providerKey: string): IChannelAdapter {
  return {
    adapterName: name,
    providerKey,
    pushListings: async () => [],
    pushInventory: async () => [],
    pushPricing: async () => [],
    pullOrders: async () => [],
    receiveOrder: async () => null,
    pushFulfillment: async () => [],
    pushCancellation: async () => [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Channel Adapter Registry", () => {
  let registry: ChannelAdapterRegistry;

  beforeEach(() => {
    registry = new ChannelAdapterRegistry();
  });

  describe("registration", () => {
    it("should register an adapter successfully", () => {
      const adapter = createStubAdapter("Shopify", "shopify");
      registry.register(adapter);

      expect(registry.has("shopify")).toBe(true);
    });

    it("should register multiple adapters", () => {
      registry.register(createStubAdapter("Shopify", "shopify"));
      registry.register(createStubAdapter("eBay", "ebay"));
      registry.register(createStubAdapter("Amazon", "amazon"));

      expect(registry.getRegisteredProviders()).toEqual(
        expect.arrayContaining(["shopify", "ebay", "amazon"]),
      );
    });

    it("should throw when registering duplicate provider key", () => {
      registry.register(createStubAdapter("Shopify", "shopify"));

      expect(() => {
        registry.register(createStubAdapter("Shopify 2", "shopify"));
      }).toThrow(/already registered/);
    });
  });

  describe("lookup", () => {
    it("should retrieve registered adapter by provider key", () => {
      const adapter = createStubAdapter("Shopify", "shopify");
      registry.register(adapter);

      const retrieved = registry.get("shopify");
      expect(retrieved).toBe(adapter);
      expect(retrieved?.adapterName).toBe("Shopify");
    });

    it("should return undefined for unregistered provider", () => {
      expect(registry.get("tiktok")).toBeUndefined();
    });

    it("should throw on getOrThrow for unregistered provider", () => {
      expect(() => registry.getOrThrow("tiktok")).toThrow(
        /No adapter registered for provider "tiktok"/,
      );
    });

    it("should return adapter on getOrThrow for registered provider", () => {
      registry.register(createStubAdapter("Shopify", "shopify"));
      const adapter = registry.getOrThrow("shopify");
      expect(adapter.adapterName).toBe("Shopify");
    });
  });

  describe("enumeration", () => {
    it("should return empty arrays when no adapters registered", () => {
      expect(registry.getAll()).toHaveLength(0);
      expect(registry.getRegisteredProviders()).toHaveLength(0);
    });

    it("should return all registered adapters", () => {
      registry.register(createStubAdapter("Shopify", "shopify"));
      registry.register(createStubAdapter("eBay", "ebay"));

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(a => a.adapterName)).toEqual(
        expect.arrayContaining(["Shopify", "eBay"]),
      );
    });

    it("should return all registered provider keys", () => {
      registry.register(createStubAdapter("Shopify", "shopify"));
      registry.register(createStubAdapter("eBay", "ebay"));

      const keys = registry.getRegisteredProviders();
      expect(keys).toHaveLength(2);
      expect(keys).toContain("shopify");
      expect(keys).toContain("ebay");
    });

    it("has() should return false for unregistered provider", () => {
      expect(registry.has("shopify")).toBe(false);
    });

    it("has() should return true for registered provider", () => {
      registry.register(createStubAdapter("Shopify", "shopify"));
      expect(registry.has("shopify")).toBe(true);
    });
  });
});
