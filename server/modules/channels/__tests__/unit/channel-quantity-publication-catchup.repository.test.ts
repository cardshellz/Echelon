import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresChannelQuantityPublicationCatchupRepository } from "../../infrastructure/channel-quantity-publication-catchup.repository";

const shopify = { destinationKind: "channel_connection", connectionId: 7, providerKey: "shopify", providerScopeType: "location",
  externalScopeId: "2222", externalInventoryItemId: "1111", productId: null, productVariantId: null };
const ebay = { ...shopify, providerKey: "ebay", providerScopeType: "account", externalScopeId: "verified-account", externalInventoryItemId: "EXT-P5" };
const owner = { channel_id: 36, provider: "shopify", status: "active", sync_enabled: true, connection_count: 1 };

describe("exact current legacy channel catch-up resolver", () => {
  const query = vi.fn();
  const release = vi.fn();
  const connect = vi.fn();
  const repository = new PostgresChannelQuantityPublicationCatchupRepository({ connect });
  beforeEach(() => { query.mockReset(); release.mockReset(); connect.mockReset(); connect.mockResolvedValue({ query, release }); });
  function mapping(provider = "shopify", rows = [{ product_id: 20, product_variant_id: 101 }]) {
    query.mockResolvedValueOnce({ rows: [{ ...owner, provider }] }).mockResolvedValueOnce({ rows });
  }
  it("resolves a Shopify inventory item/location through current channel feed ownership", async () => {
    mapping();
    await expect(repository.resolve(shopify)).resolves.toEqual({ scope: shopify, channelId: 36, productId: 20, productVariantId: 101 });
    expect(query.mock.calls[1][1]).toEqual([36, "1111", "2222"]);
    const sql = query.mock.calls[1][0];
    expect(sql).toContain("feed.is_active=1 AND feed.quarantined_at IS NULL");
    expect(sql).toContain("assignment.enabled=true");
    expect(sql).toContain("gid://shopify/InventoryItem/");
    expect(sql).not.toContain("publication_variant_mapping_versions");
    expect(release).toHaveBeenCalledOnce();
  });
  it("uses the same eBay effective external SKU precedence as the current publisher", async () => {
    mapping("ebay");
    await expect(repository.resolve(ebay)).resolves.toMatchObject({ channelId: 36, productVariantId: 101 });
    expect(query.mock.calls[1][0]).toContain("COALESCE(listing.external_sku,feed.channel_sku,variant.sku)=$2");
    expect(query.mock.calls[1][0]).toContain("feed.id IS NOT NULL OR listing.id IS NOT NULL");
    expect(query.mock.calls[1][1]).toEqual([36, "EXT-P5"]);
  });
  it.each([
    { ...shopify, connectionId: 0 }, { ...shopify, providerScopeType: "account" },
    { ...shopify, destinationKind: "dropship_store_connection" }, { ...shopify, externalInventoryItemId: "abc" },
    { ...shopify, externalInventoryItemId: "0" }, { ...shopify, externalScopeId: "9007199254740992" },
    { ...shopify, externalInventoryItemId: "gid://shopify/InventoryItem/1111" },
    { ...ebay, externalInventoryItemId: "group:old" }, { ...ebay, externalInventoryItemId: "batch:old" },
    { ...ebay, externalInventoryItemId: "offer:old:publish" },
  ])("rejects unsupported or malformed identities before querying: %j", async input => {
    await expect(repository.resolve(input)).rejects.toHaveProperty("code");
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [{ ...owner, status: "paused" }] }, { rows: [{ ...owner, sync_enabled: false }] }, { rows: [{ ...owner, provider: "ebay" }] },
    { rows: [{ ...owner, connection_count: 2 }] }, { rows: [] }, { rows: [{ ...owner, channel_id: -1 }] },
  ])("rejects unavailable, ambiguous or malformed connection evidence", async ({ rows }) => {
    query.mockResolvedValueOnce({ rows });
    await expect(repository.resolve(shopify)).rejects.toHaveProperty("code");
    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
  it("rejects missing mappings instead of treating catalog SKU or historical models as ownership", async () => {
    mapping("ebay", []);
    await expect(repository.resolve(ebay)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_MISSING" });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("rejects duplicate evidence even for the same catalog variant", async () => {
    mapping("shopify", [{ product_id: 20, product_variant_id: 101 }, { product_id: 20, product_variant_id: 101 }]);
    await expect(repository.resolve(shopify)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_AMBIGUOUS" });
  });
  it.each([{ productId: 30 }, { productVariantId: 102 }])("rejects stale catalog hints %j", async hints => {
    mapping();
    await expect(repository.resolve({ ...shopify, ...hints })).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_CHANGED" });
  });
  it("accepts matching catalog hints without using them as the mapping resolver", async () => {
    mapping();
    await expect(repository.resolve({ ...shopify, productId: 20, productVariantId: 101 })).resolves.toMatchObject({ productId: 20, productVariantId: 101 });
    expect(query.mock.calls[1][1]).toEqual([36, "1111", "2222"]);
  });
  it("releases its borrowed connection when the mapping query fails", async () => {
    query.mockResolvedValueOnce({ rows: [owner] }).mockRejectedValueOnce(new Error("Connection interrupted"));
    await expect(repository.resolve(shopify)).rejects.toThrow("Connection interrupted");
    expect(release).toHaveBeenCalledOnce();
  });
});
