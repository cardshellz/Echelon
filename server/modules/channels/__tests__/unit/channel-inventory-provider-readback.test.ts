import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyAdapter } from "../../adapters/shopify.adapter";
import { EbayAdapter } from "../../adapters/ebay.adapter";
import { ChannelInventoryPublicationTransportAdapter } from "../../channel-inventory-publication-transport.adapter";

const database = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
const destination = { kind: "channel_connection" as const, channelConnectionId: 22, dropshipStoreConnectionId: null };
const ebayRequest = { destination, channelId: 2, productVariantId: 101, providerScopeType: "account" as const,
  externalScopeId: "seller-1", externalInventoryItemId: "SKU-101", externalSku: "SKU-101" };
const shopifyRequest = { ...ebayRequest, providerScopeType: "location" as const, externalScopeId: "20", externalInventoryItemId: "5" };
const offer = { sku: "SKU-101", marketplaceId: "EBAY_US", offerId: "offer-1", status: "PUBLISHED", availableQuantity: 38 };

function ebayFixture() {
  const adapter = new EbayAdapter(database, { resolve: vi.fn(async () => ({ byVariantId: new Map(), groupImageUrls: [] })) });
  const client = {
    getInventoryItem: vi.fn(async () => ({ sku: "SKU-101", availability: { shipToLocationAvailability: { quantity: 50 } } })),
    getInventoryOffersPage: vi.fn(async () => ({ total: 1, offers: [offer] })),
    bulkUpdatePriceQuantity: vi.fn(async () => ({ responses: [{ sku: "SKU-101", offerId: "offer-1", statusCode: 200 }] })),
    createOrReplaceInventoryItem: vi.fn(), updateOffer: vi.fn(), getOffers: vi.fn(),
  };
  const getApiClient = vi.spyOn(adapter as unknown as { getApiClient(): Promise<typeof client> }, "getApiClient").mockResolvedValue(client);
  vi.spyOn(adapter as unknown as { getConnectionMetadata(): Promise<{ siteId: string }> }, "getConnectionMetadata").mockResolvedValue({ siteId: "EBAY_US" });
  return { adapter, client, getApiClient, transport: new ChannelInventoryPublicationTransportAdapter(adapter) };
}

afterEach(() => vi.restoreAllMocks());

describe("actual provider adapters through the canonical transport", () => {
  it("does not confirm eBay item 50 as listing 50 when its offer remains 38", async () => {
    const { client, getApiClient, transport } = ebayFixture();
    await expect(transport.readAbsolute(ebayRequest)).resolves.toMatchObject({
      observedQuantity: 38, providerResponse: { providerResponse: { inventoryItemQuantity: 50, offerQuantity: 38, offerId: "offer-1" } },
    });
    expect(getApiClient).toHaveBeenCalledWith(2, 22, "seller-1");
    expect(client.getInventoryItem).toHaveBeenCalledExactlyOnceWith("SKU-101");
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
  });
  it("resolves the offer omitted by canonical transport and updates both limits, with no item replacement", async () => {
    const { client, transport } = ebayFixture();
    await expect(transport.publishAbsolute({ ...ebayRequest, desiredQuantity: 7 })).resolves.toMatchObject({ publishedQuantity: 7 });
    expect(client.bulkUpdatePriceQuantity).toHaveBeenCalledExactlyOnceWith({ requests: [{
      sku: "SKU-101", shipToLocationAvailability: { quantity: 7 }, offers: [{ offerId: "offer-1", availableQuantity: 7 }],
    }] }, "EBAY_US");
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.getOffers).not.toHaveBeenCalled();
    expect(client.updateOffer).not.toHaveBeenCalled();
  });
  it("replaces a published eBay offer's old zero with ATP instead of capping the update", async () => {
    const { client, transport } = ebayFixture();
    client.getInventoryOffersPage.mockResolvedValue({ total: 1, offers: [{ ...offer, availableQuantity: 0 }] });
    client.getInventoryItem.mockResolvedValue({ sku: "SKU-101", availability: { shipToLocationAvailability: { quantity: 0 } } });
    await expect(transport.publishAbsolute({ ...ebayRequest, desiredQuantity: 14 })).resolves.toMatchObject({ publishedQuantity: 14 });
    expect(client.bulkUpdatePriceQuantity).toHaveBeenCalledExactlyOnceWith({ requests: [{
      sku: "SKU-101", shipToLocationAvailability: { quantity: 14 }, offers: [{ offerId: "offer-1", availableQuantity: 14 }],
    }] }, "EBAY_US");
    client.getInventoryOffersPage.mockResolvedValue({ total: 1, offers: [{ ...offer, availableQuantity: 14 }] });
    client.getInventoryItem.mockResolvedValue({ sku: "SKU-101", availability: { shipToLocationAvailability: { quantity: 14 } } });
    await expect(transport.readAbsolute(ebayRequest)).resolves.toMatchObject({ observedQuantity: 14 });
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.updateOffer).not.toHaveBeenCalled();
  });
  it("preserves nonretryable ambiguity through both publication and readback transports", async () => {
    const { client, transport } = ebayFixture();
    client.getInventoryOffersPage.mockResolvedValue({ total: 2, offers: [offer, { ...offer, offerId: "other" }] });
    await expect(transport.readAbsolute(ebayRequest)).rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFER_AMBIGUOUS", retryable: false });
    await expect(transport.publishAbsolute({ ...ebayRequest, desiredQuantity: 7 })).rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFER_AMBIGUOUS", retryable: false });
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
  });
  it("does not fall back to item-only publication after an incomplete acknowledgement", async () => {
    const { client, transport } = ebayFixture();
    client.bulkUpdatePriceQuantity.mockResolvedValue({ responses: [] });
    await expect(transport.publishAbsolute({ ...ebayRequest, desiredQuantity: 7 })).rejects.toMatchObject({ code: "EBAY_INVENTORY_ACKNOWLEDGEMENT_INVALID", retryable: true });
    expect(client.bulkUpdatePriceQuantity).toHaveBeenCalledTimes(1);
    expect(client.createOrReplaceInventoryItem).not.toHaveBeenCalled();
    expect(client.updateOffer).not.toHaveBeenCalled();
  });

  function shopifyFixture(levels: unknown[]) {
    const adapter = new ShopifyAdapter(database);
    vi.spyOn(adapter as unknown as { getCredentials(): Promise<object> }, "getCredentials").mockResolvedValue({});
    const get = vi.spyOn(adapter as unknown as { shopifyGet(): Promise<unknown> }, "shopifyGet").mockResolvedValue({ inventory_levels: levels });
    return { adapter, get, transport: new ChannelInventoryPublicationTransportAdapter(adapter) };
  }
  it.each([0, 14])("sets Shopify ATP %i without requiring its old negative stock to be readable", async (desiredQuantity) => {
    const { adapter, get, transport } = shopifyFixture([{ inventory_item_id: 5, location_id: 20, available: -18 }]);
    vi.spyOn(adapter as unknown as { delay(milliseconds: number): Promise<void> }, "delay").mockResolvedValue(undefined);
    const post = vi.spyOn(adapter as unknown as {
      shopifyPost(credentials: unknown, path: string, body: { location_id: number; inventory_item_id: number; available: number }): Promise<unknown>;
    }, "shopifyPost").mockImplementation(async (_credentials, _path, body) => {
      get.mockResolvedValue({ inventory_levels: [{ inventory_item_id: body.inventory_item_id, location_id: body.location_id, available: body.available }] });
      return { inventory_level: { available: body.available } };
    });
    await expect(transport.publishAbsolute({ ...shopifyRequest, desiredQuantity })).resolves.toMatchObject({ publishedQuantity: desiredQuantity });
    expect(post).toHaveBeenCalledExactlyOnceWith({}, "/inventory_levels/set.json", {
      location_id: 20, inventory_item_id: 5, available: desiredQuantity,
    });
    expect(get).not.toHaveBeenCalled();
    await expect(transport.readAbsolute(shopifyRequest)).resolves.toMatchObject({ observedQuantity: desiredQuantity });
  });
  it.each([null, undefined, "", "7", false, true, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects Shopify quantity %s without coercion", async (available) => {
      const { transport } = shopifyFixture([{ inventory_item_id: 5, location_id: 20, available }]);
      await expect(transport.readAbsolute(shopifyRequest)).rejects.toMatchObject({ code: "PROVIDER_READBACK_FAILED" });
    },
  );
  it.each([0, 7, Number.MAX_SAFE_INTEGER])("preserves actual Shopify numeric %i", async (available) => {
    const { transport, get } = shopifyFixture([{ inventory_item_id: "5", location_id: 20, available }]);
    await expect(transport.readAbsolute(shopifyRequest)).resolves.toMatchObject({ observedQuantity: available });
    expect(get).toHaveBeenCalledWith({}, "/inventory_levels.json?inventory_item_ids=5&location_ids=20");
  });
  it.each([
    [],
    [{ inventory_item_id: 5, location_id: 20, available: 7 }, { inventory_item_id: 5, location_id: 20, available: 7 }],
    [{ inventory_item_id: 5, location_id: 21, available: 7 }],
    [{ inventory_item_id: 6, location_id: 20, available: 7 }],
    [{ inventory_item_id: 5, location_id: 20, available: 7 }, { inventory_item_id: 6, location_id: 20, available: 7 }],
  ].map((levels) => ({ levels })))("rejects missing, duplicate or wrong-scope Shopify evidence", async ({ levels }) => {
    const { transport } = shopifyFixture(levels);
    await expect(transport.readAbsolute(shopifyRequest)).rejects.toMatchObject({ code: "PROVIDER_READBACK_FAILED" });
  });
  it("rejects Shopify item/context disagreement before a provider request", async () => {
    const { adapter, get } = shopifyFixture([]);
    await expect(adapter.readInventory(2, [{ variantId: 101, sku: null, externalInventoryItemId: "5", providerScopeType: "location", externalScopeId: "21" }], {
      authority: "canonical_outbox", channelConnectionId: 22, providerScopeType: "location", externalScopeId: "20",
    })).resolves.toMatchObject([{ status: "error", errorCode: "SHOPIFY_INVENTORY_SCOPE_MISMATCH", retryable: false }]);
    expect(get).not.toHaveBeenCalled();
  });
});
