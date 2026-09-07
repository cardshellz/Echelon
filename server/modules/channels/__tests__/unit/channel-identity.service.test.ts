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
    const read = vi.spyOn(reader, "inventory");
    await expect(new ChannelIdentityService(db as never, reader).externalInventory(2, "20", 7)).rejects.toMatchObject({ code: "CHANNEL_CONNECTION_UNRESOLVED" });
    expect(read).not.toHaveBeenCalled();
  });
});
