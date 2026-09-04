import { describe, expect, it, vi } from "vitest";

import {
  InventoryPublicationTransportRegistry,
  type InventoryPublicationTransportAdapter,
} from "../../application/inventory-publication-transport";
import { ChannelInventoryPublicationTransportAdapter } from "../../../channels/channel-inventory-publication-transport.adapter";

describe("InventoryPublicationTransportRegistry", () => {
  it("keys adapters by exact destination owner kind and provider", () => {
    const channel = adapter("channel_connection", "ebay");
    const dropship = adapter("dropship_store_connection", "ebay");
    const registry = new InventoryPublicationTransportRegistry();
    registry.register(channel);
    registry.register(dropship);

    expect(registry.get("channel_connection", "ebay")).toBe(channel);
    expect(registry.get("dropship_store_connection", "EBAY")).toBe(dropship);
  });

  it("rejects duplicate exact destination registrations", () => {
    const registry = new InventoryPublicationTransportRegistry();
    registry.register(adapter("channel_connection", "shopify"));

    expect(() => registry.register(adapter("channel_connection", "shopify")))
      .toThrow(expect.objectContaining({ code: "PUBLICATION_ADAPTER_DUPLICATE" }));
  });
});

describe("ChannelInventoryPublicationTransportAdapter", () => {
  it("passes one absolute quantity through the exact Channels connection context", async () => {
    const channelAdapter = {
      providerKey: "shopify",
      inventoryPublicationScopeTypes: ["location"] as const,
      pushInventory: vi.fn(async () => [{
        variantId: 101,
        pushedQty: 7,
        status: "success" as const,
      }]),
      readInventory: vi.fn(async () => [{
        variantId: 101,
        observedQty: 7,
        status: "success" as const,
      }]),
    };
    const transport = new ChannelInventoryPublicationTransportAdapter(channelAdapter as never);

    await expect(transport.publishAbsolute({
      ...request(),
      desiredQuantity: 7,
    })).resolves.toMatchObject({ publishedQuantity: 7 });
    await expect(transport.readAbsolute(request())).resolves.toMatchObject({ observedQuantity: 7 });

    expect(channelAdapter.pushInventory).toHaveBeenCalledWith(3, [expect.objectContaining({
      variantId: 101,
      allocatedQty: 7,
    })], {
      authority: "canonical_outbox",
      channelConnectionId: 33,
      providerScopeType: "location",
      externalScopeId: "location-9",
    });
  });
});

function adapter(
  destinationKind: InventoryPublicationTransportAdapter["destinationKind"],
  providerKey: string,
): InventoryPublicationTransportAdapter {
  return {
    destinationKind,
    providerKey,
    supportedScopeTypes: ["account"],
    publishAbsolute: vi.fn(),
    readAbsolute: vi.fn(),
  };
}

function request() {
  return {
    destination: {
      kind: "channel_connection" as const,
      channelConnectionId: 33,
      dropshipStoreConnectionId: null,
    },
    channelId: 3,
    providerScopeType: "location" as const,
    externalScopeId: "location-9",
    productVariantId: 101,
    externalInventoryItemId: "inventory-item-101",
    externalSku: "SKU-101",
  };
}
