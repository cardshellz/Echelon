/**
 * Destination derivation decides what publication targets get created in bulk,
 * so its conservatism is the safety property under test: it must never invent a
 * location or an account, because a quantity written to the wrong one is a
 * financial error that a disabled state does not undo.
 */
import { describe, expect, it } from "vitest";

import {
  deriveChannelDestinations,
  type DerivableChannelConnection,
  type DerivableDropshipStore,
} from "../../domain/inventory-channel-exposure";

function connection(overrides: Partial<DerivableChannelConnection> = {}): DerivableChannelConnection {
  return {
    id: 33,
    provider: "shopify",
    shopifyLocationId: "gid://shopify/Location/1",
    verifiedAccountId: null,
    label: "us-store.myshopify.com",
    ...overrides,
  };
}

function store(overrides: Partial<DerivableDropshipStore> = {}): DerivableDropshipStore {
  return {
    id: 90,
    platform: "ebay",
    verifiedExternalAccountId: "vendor-user-1",
    label: "Vendor Co",
    ...overrides,
  };
}

function derive(input: Partial<Parameters<typeof deriveChannelDestinations>[0]> = {}) {
  return deriveChannelDestinations({
    connections: [],
    dropshipStores: [],
    registered: [],
    ...input,
  });
}

describe("deriveChannelDestinations", () => {
  it("derives a Shopify destination from the location already stored on the connection", () => {
    const result = derive({ connections: [connection()] });

    expect(result.create).toEqual([{
      destinationKind: "channel_connection",
      channelConnectionId: 33,
      dropshipStoreConnectionId: null,
      providerScopeType: "location",
      externalScopeId: "gid://shopify/Location/1",
      label: "us-store.myshopify.com",
    }]);
    expect(result.skipped).toEqual([]);
  });

  it("derives an eBay destination from the provider-verified seller account", () => {
    const result = derive({
      connections: [connection({ id: 44, provider: "ebay", shopifyLocationId: null, verifiedAccountId: "ebay-user-9", label: "cardshellz" })],
    });

    expect(result.create).toMatchObject([{ providerScopeType: "account", externalScopeId: "ebay-user-9" }]);
  });

  it("derives a dropship storefront from its verified account", () => {
    const result = derive({ dropshipStores: [store()] });

    expect(result.create).toEqual([{
      destinationKind: "dropship_store_connection",
      channelConnectionId: null,
      dropshipStoreConnectionId: 90,
      providerScopeType: "account",
      externalScopeId: "vendor-user-1",
      label: "Vendor Co",
    }]);
  });

  it("scales to many storefronts without asking anything extra per store", () => {
    const stores = Array.from({ length: 100 }, (_, index) => store({
      id: 1000 + index,
      verifiedExternalAccountId: `vendor-user-${index}`,
      label: `Vendor ${index}`,
    }));

    const result = derive({ dropshipStores: stores });

    expect(result.create).toHaveLength(100);
    expect(new Set(result.create.map((entry) => entry.externalScopeId)).size).toBe(100);
    expect(result.skipped).toEqual([]);
  });

  describe("refuses to guess", () => {
    it("skips a Shopify connection with no stored location rather than defaulting one", () => {
      const result = derive({ connections: [connection({ shopifyLocationId: null })] });

      expect(result.create).toEqual([]);
      expect(result.skipped).toMatchObject([{ reason: "no_shopify_location", providerScopeType: "location" }]);
    });

    it("skips an eBay connection whose credential carries no verified account", () => {
      const result = derive({
        connections: [connection({ id: 44, provider: "ebay", shopifyLocationId: null, verifiedAccountId: null })],
      });

      expect(result.create).toEqual([]);
      expect(result.skipped).toMatchObject([{ reason: "no_verified_account", providerScopeType: "account" }]);
    });

    it("treats a blank scope id exactly like a missing one", () => {
      const result = derive({ dropshipStores: [store({ verifiedExternalAccountId: "   " })] });

      expect(result.create).toEqual([]);
      expect(result.skipped).toMatchObject([{ reason: "no_verified_account" }]);
    });

    it("skips a provider with no publishing adapter instead of assuming a scope", () => {
      const result = derive({
        connections: [connection({ id: 66, provider: "amazon", shopifyLocationId: null })],
        dropshipStores: [store({ id: 91, platform: "tiktok" })],
      });

      expect(result.create).toEqual([]);
      expect(result.skipped.map((entry) => entry.reason)).toEqual(["no_publishing_adapter", "no_publishing_adapter"]);
      expect(result.skipped.every((entry) => entry.providerScopeType === undefined)).toBe(true);
    });
  });

  describe("idempotence against what already exists", () => {
    it("reports an exactly-registered destination as already registered, never recreated", () => {
      const result = derive({
        connections: [connection()],
        registered: [{
          destinationKind: "channel_connection",
          connectionId: 33,
          providerScopeType: "location",
          externalScopeId: "gid://shopify/Location/1",
        }],
      });

      expect(result.create).toEqual([]);
      expect(result.skipped).toMatchObject([{ reason: "already_registered" }]);
    });

    it("does not treat a different location on the same connection as registered", () => {
      const result = derive({
        connections: [connection()],
        registered: [{
          destinationKind: "channel_connection",
          connectionId: 33,
          providerScopeType: "location",
          externalScopeId: "gid://shopify/Location/2",
        }],
      });

      expect(result.create).toHaveLength(1);
    });

    // A storefront id and a channel connection id come from different tables and
    // can collide numerically; the kind must be part of the identity.
    it("does not confuse a dropship store with a channel connection of the same id", () => {
      const result = derive({
        dropshipStores: [store({ id: 33, verifiedExternalAccountId: "gid://shopify/Location/1" })],
        registered: [{
          destinationKind: "channel_connection",
          connectionId: 33,
          providerScopeType: "location",
          externalScopeId: "gid://shopify/Location/1",
        }],
      });

      expect(result.create).toHaveLength(1);
      expect(result.create[0]).toMatchObject({ destinationKind: "dropship_store_connection" });
    });

    it("derives nothing at all when there is nothing connected", () => {
      expect(derive()).toEqual({ create: [], skipped: [] });
    });
  });

  it("trims a scope id so stored whitespace cannot fork an identity", () => {
    const result = derive({ dropshipStores: [store({ verifiedExternalAccountId: " vendor-user-1 " })] });

    expect(result.create).toMatchObject([{ externalScopeId: "vendor-user-1" }]);
  });
});
