import { describe, expect, it, vi } from "vitest";
vi.mock("../../../../infrastructure/auditLogger", () => ({ persistAuditEvent: vi.fn().mockResolvedValue(undefined) }));
import { persistAuditEvent } from "../../../../infrastructure/auditLogger";
import { ChannelIdentityService } from "../../channel-identity.service";
import { ShopifyIdentityReader } from "../../adapters/shopify-identity.reader";

const account = { id: 7, channelId: 2, shopDomain: "second.myshopify.com", accessToken: "test", apiVersion: "2024-01", shopifyLocationId: "20" };
const listing = { productVariantId: 1, externalVariantId: "3", externalProductId: "4", externalSku: "SKU" };
const evidence = { id: "3", product_id: "4", inventory_item_id: "5", sku: "SKU" };
function database(queue: unknown[][]) {
  const chain = (rows: unknown[]) => {
    const query: Record<string, unknown> = { then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
    for (const method of ["from", "where", "limit", "innerJoin", "for", "values", "set", "returning"]) query[method] = vi.fn(() => query);
    return query;
  };
  const db = {
    select: vi.fn(() => chain(queue.shift() ?? [])),
    insert: vi.fn(() => chain([{ id: 10, channelId: 2, productVariantId: 1 }])),
    update: vi.fn(() => chain([{ id: 10, channelId: 2, productVariantId: 1 }])),
    transaction: vi.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(db)),
  };
  return db;
}
const input = { channelId: 2, productVariantId: 1, sku: "SKU", actor: "test-operator" };

describe("verified feed creation", () => {
  it("classifies an active feed without a remote variant identity as corrupt", async () => {
    const db = database([[
      {
        productVariantId: 1,
        externalVariantId: null,
        externalProductId: null,
        externalInventoryItemId: null,
        externalSku: "SKU",
      },
    ]]);

    await expect(new ChannelIdentityService(db as never).inventoryIdentities(2))
      .rejects.toMatchObject({ code: "CHANNEL_IDENTITY_CORRUPT" });
  });

  it("creates a provider-verified mapping and persists its audit through the same transaction", async () => {
    const db = database([[account], [listing], [], [{ id: 2 }], [account], [listing], []]);
    const reader = new ShopifyIdentityReader();
    vi.spyOn(reader, "variant").mockResolvedValue(evidence);
    const clock = () => new Date("2026-09-07T00:00:00Z");
    await new ChannelIdentityService(db as never, reader, clock).ensureShopifyFeed(input);
    expect(reader.variant).toHaveBeenCalledWith(account, "3");
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(persistAuditEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      actor: "test-operator", action: "channel_identity.verified_feed", context: { channelId: 2, connectionId: 7, externalVariantId: "3" },
    }), { timestamp: clock() });
  });
  it("never calls the provider without a destination mapping", async () => {
    const db = database([[account], [], []]);
    const reader = new ShopifyIdentityReader();
    const read = vi.spyOn(reader, "variant");
    await expect(new ChannelIdentityService(db as never, reader).ensureShopifyFeed(input)).rejects.toMatchObject({ code: "CHANNEL_IDENTITY_REQUIRED" });
    expect(read).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it("does not write when SKU verification fails", async () => {
    const db = database([[account], [listing], []]);
    const reader = new ShopifyIdentityReader();
    vi.spyOn(reader, "variant").mockResolvedValue({ ...evidence, sku: "OTHER" });
    await expect(new ChannelIdentityService(db as never, reader).ensureShopifyFeed(input)).rejects.toMatchObject({ code: "CHANNEL_IDENTITY_EVIDENCE_MISMATCH" });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
  it("rejects a connection added during provider verification", async () => {
    const db = database([[account], [listing], [], [{ id: 2 }], [account, { ...account, id: 8 }]]);
    const reader = new ShopifyIdentityReader();
    vi.spyOn(reader, "variant").mockResolvedValue(evidence);
    await expect(new ChannelIdentityService(db as never, reader).ensureShopifyFeed(input)).rejects.toMatchObject({ code: "CHANNEL_CONNECTION_CHANGED" });
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("rejects a listing edited during provider verification", async () => {
    const db = database([[account], [listing], [], [{ id: 2 }], [account], [{ ...listing, externalVariantId: "99" }]]);
    const reader = new ShopifyIdentityReader();
    vi.spyOn(reader, "variant").mockResolvedValue(evidence);
    await expect(new ChannelIdentityService(db as never, reader).ensureShopifyFeed(input)).rejects.toMatchObject({ code: "CHANNEL_IDENTITY_CHANGED" });
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("rejects multiple accounts even if an inbound caller supplies one explicit ID", async () => {
    const db = database([[account, { ...account, id: 8 }]]);
    const reader = new ShopifyIdentityReader();
    const read = vi.spyOn(reader, "inventoryLevels");
    await expect(new ChannelIdentityService(db as never, reader).externalInventory(2, "20", 7)).rejects.toMatchObject({ code: "CHANNEL_CONNECTION_UNRESOLVED" });
    expect(read).not.toHaveBeenCalled();
  });
  it("separates unmapped untracked items from quantities without blocking mapped numeric stock", async () => {
    const db = database([[account], [{ ...listing, externalInventoryItemId: "5" }]]);
    const reader = new ShopifyIdentityReader();
    vi.spyOn(reader, "inventoryLevels").mockResolvedValue(new Map<string, number | null>([["5", 0], ["6", null]]));
    await expect(new ChannelIdentityService(db as never, reader).externalInventory(2)).resolves.toEqual({
      channelId: 2, connectionId: 7, externalLocationId: "20",
      items: [{ externalInventoryItemId: "5", productVariantId: 1, quantity: 0 }],
      unavailableItems: [{ externalInventoryItemId: "6", reason: "untracked" }],
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("fails closed if an untracked Shopify item has an active mapping", async () => {
    const db = database([[account], [{ ...listing, externalInventoryItemId: "5" }]]);
    const reader = new ShopifyIdentityReader();
    vi.spyOn(reader, "inventoryLevels").mockResolvedValue(new Map([["5", null]]));
    await expect(new ChannelIdentityService(db as never, reader).externalInventory(2))
      .rejects.toMatchObject({ code: "SHOPIFY_MAPPED_INVENTORY_UNTRACKED" });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
  it("returns mapped stock from all fallback-version pages without mutating configuration or quantities", async () => {
    const db = database([[account], [{ ...listing, externalInventoryItemId: "5" }]]);
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ inventory_levels: [
        { inventory_item_id: 6, location_id: 20, available: null },
      ] }), { headers: { "X-Shopify-API-Version": "2025-10",
        Link: '<https://second.myshopify.com/admin/api/2024-01/inventory_levels.json?limit=250&page_info=next>; rel="next"' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ inventory_levels: [
        { inventory_item_id: 5, location_id: 20, available: 42 },
      ] }), { headers: { "X-Shopify-API-Version": "2025-10" } }));
    const reader = new ShopifyIdentityReader(request);
    await expect(new ChannelIdentityService(db as never, reader).externalInventory(2)).resolves.toEqual({
      channelId: 2, connectionId: 7, externalLocationId: "20",
      items: [{ externalInventoryItemId: "5", productVariantId: 1, quantity: 42 }],
      unavailableItems: [{ externalInventoryItemId: "6", reason: "untracked" }],
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![0]).toBe("https://second.myshopify.com/admin/api/2025-10/inventory_levels.json?page_info=next&limit=250");
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(account.apiVersion).toBe("2024-01");
  });
});
