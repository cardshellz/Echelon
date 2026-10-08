import { describe, expect, it, vi } from "vitest";
import type { WalmartChannelService } from "../../adapters/walmart/walmart-channel.service";
import { WalmartStockConnectionService } from "../../adapters/walmart/walmart-stock-connection.service";
import { VerifiedListingStockService, type VerifiedListingStockStore } from "../../../inventory-planning/application/verified-listing-stock.service";

const now = new Date("2026-10-08T14:00:00Z");
function fixture() {
  const item = (sku: string) => ({ sku, title: sku, externalProductId: `WPID-${sku}`, externalVariantId: sku,
    externalInventoryItemId: sku, lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED" });
  const account = vi.fn(async () => ({ partnerId: "seller", nodes: [
    { shipNode: "node", shipNodeName: "Seller", nodeType: "VIRTUAL", status: "ACTIVE" },
  ] }));
  const catalogItem = vi.fn(async (sku: string) => item(sku));
  const mappings = vi.fn(async () => [1, 2, 3].map(id => ({ product_variant_id: id, channel_sku: `SKU-${id}` })));
  const channels = { repository: { enabledChannels: vi.fn(async () => [104]), mappings },
    connection: vi.fn(async () => ({ connection_id: 67, partner_id: "seller", ship_node_id: "node", environment: "production" })),
    requireRuntime: vi.fn(), api: vi.fn(() => ({ account, catalogItem })) };
  const inventory = { pending: vi.fn(async (_channel: number, _connection: number, ids: number[]) => ids),
    connect: vi.fn(async () => ({ state: "connected" as const, dryRun: false, receipt: null, quantities: [] })) };
  const logger = { info: vi.fn(), error: vi.fn() };
  const service = new WalmartStockConnectionService(channels as unknown as WalmartChannelService, inventory, () => now, logger);
  return { service, channels, inventory, account, catalogItem, mappings, item, logger };
}

describe("Walmart stock connection scan", () => {
  it("hands published exact identities to the inventory owner and skips rejected or retired items", async () => {
    const f = fixture();
    f.catalogItem.mockImplementation(async sku => ({ ...f.item(sku),
      publishedStatus: sku === "SKU-2" ? "SYSTEM_PROBLEM" : "PUBLISHED", lifecycleStatus: sku === "SKU-3" ? "RETIRED" : "ACTIVE" }));
    expect(await f.service.processDue()).toEqual({ processed: 1, failed: 0 });
    expect(f.inventory.connect).toHaveBeenCalledExactlyOnceWith({ channelId: 104, connectionId: 67, accountId: "seller",
      environment: "production", externalScopeId: "node", productVariantId: 1, sku: "SKU-1", externalProductId: "WPID-SKU-1",
      lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED", observedAt: now.toISOString() });
  });
  it("makes no provider calls when inventory reports no pending enabled listings", async () => {
    const f = fixture();
    f.inventory.pending.mockResolvedValue([]);
    expect(await f.service.processDue()).toEqual({ processed: 0, failed: 0 });
    expect(f.account).not.toHaveBeenCalled();
    expect(f.inventory.connect).not.toHaveBeenCalled();
  });
  it("rejects a different seller account", async () => {
    const f = fixture();
    f.account.mockResolvedValue({ partnerId: "another-seller", nodes: [] });
    expect(await f.service.processDue()).toEqual({ processed: 0, failed: 1 });
    expect(f.inventory.connect).not.toHaveBeenCalled();
    expect(f.catalogItem).not.toHaveBeenCalled();
  });
  it("rejects an unavailable fulfillment center", async () => {
    const f = fixture();
    f.account.mockResolvedValue({ partnerId: "seller", nodes: [
      { shipNode: "node", shipNodeName: "Seller", nodeType: "VIRTUAL", status: "INACTIVE" },
    ] });
    expect(await f.service.processDue()).toEqual({ processed: 0, failed: 1 });
    expect(f.inventory.connect).not.toHaveBeenCalled();
  });
  it("isolates provider failures and rejects changed SKU identities", async () => {
    const f = fixture();
    f.catalogItem.mockImplementation(async sku => {
      if (sku === "SKU-1") throw Object.assign(new Error("unavailable"), { code: "WALMART_REQUEST_FAILED" });
      return sku === "SKU-2" ? f.item("different-sku") : f.item(sku);
    });
    expect(await f.service.processDue()).toEqual({ processed: 1, failed: 2 });
    expect(f.inventory.connect).toHaveBeenCalledTimes(1);
    expect(f.logger.error).toHaveBeenCalledTimes(2);
  });
  it("rotates bounded batches so rejected SKUs cannot starve later listings", async () => {
    const f = fixture();
    f.catalogItem.mockImplementation(async sku => ({ ...f.item(sku), publishedStatus: sku === "SKU-3" ? "PUBLISHED" : "SYSTEM_PROBLEM" }));
    await f.service.processDue(1);
    await f.service.processDue(1);
    expect(await f.service.processDue(1)).toEqual({ processed: 1, failed: 0 });
    expect(f.catalogItem.mock.calls.map(([sku]) => sku)).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
  });
  it("retains owner errors for a later retry without claiming stock was sent", async () => {
    const f = fixture();
    f.inventory.connect.mockRejectedValueOnce(Object.assign(new Error("held"), { code: "STOCK_LISTING_HELD" }));
    expect(await f.service.processDue(1)).toEqual({ processed: 0, failed: 1 });
    expect(f.logger.info).not.toHaveBeenCalled();
    expect(f.logger.error.mock.calls[0][0]).toContain("STOCK_LISTING_HELD");
  });
});

describe("verified inventory observation validation", () => {
  const input = { channelId: 104, connectionId: 67, accountId: "seller", environment: "production", externalScopeId: "node",
    productVariantId: 1, sku: "SKU-1", externalProductId: "WPID", lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED",
    observedAt: now.toISOString() };
  it.each([
    { publishedStatus: "SYSTEM_PROBLEM" }, { externalProductId: "" }, { productVariantId: -1 },
    { observedAt: "2026-10-08T13:54:59Z" }, { observedAt: "2026-10-08T14:00:01Z" }, { quantity: 999 },
  ])("rejects invalid or stale evidence before entering the inventory transaction: %j", change => {
    const store = { connect: vi.fn(), pending: vi.fn() } satisfies VerifiedListingStockStore;
    const service = new VerifiedListingStockService(store, () => now);
    expect(() => service.connect({ ...input, ...change })).toThrow();
    expect(store.connect).not.toHaveBeenCalled();
  });
});
