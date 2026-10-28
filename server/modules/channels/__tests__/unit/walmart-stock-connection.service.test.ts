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
    connection: vi.fn(async () => ({ channel_id: 104, connection_id: 67, partner_id: "seller", ship_node_id: "node", environment: "production", revision: 1 })),
    withListingWrites: vi.fn(async (_account: unknown, _skus: readonly string[], work: () => Promise<unknown>) => work()),
    observeListingPresence: vi.fn(async (_account: unknown, sku: string) => ({ sku, state: "present" as "present" | "missing", externalProductId: `WPID-${sku}`, checkedAt: now.toISOString() })),
    requireRuntime: vi.fn(), api: vi.fn(() => ({ account, catalogItem })) };
  const inventory = { pending: vi.fn(async (_channel: number, _connection: number, ids: number[]) => ids) };
  const nudge = vi.fn(async (input: { channelConnectionId: number; productVariantIds: number[] }) => input.productVariantIds);
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const service = new WalmartStockConnectionService(channels as unknown as WalmartChannelService, inventory, nudge, logger);
  return { service, channels, inventory, account, catalogItem, mappings, item, logger, nudge };
}

// Channels PR4: the scan detects presence and PUBLISHED and nudges the stock-link engine; it never links itself.
describe("Walmart stock connection scan", () => {
  it("nudges only published exact identities and skips rejected or retired items; it never links", async () => {
    const f = fixture();
    f.catalogItem.mockImplementation(async sku => ({ ...f.item(sku),
      publishedStatus: sku === "SKU-2" ? "SYSTEM_PROBLEM" : "PUBLISHED", lifecycleStatus: sku === "SKU-3" ? "RETIRED" : "ACTIVE" }));
    expect(await f.service.processDue()).toEqual({ nudged: 1, failed: 0 });
    expect(f.nudge).toHaveBeenCalledExactlyOnceWith({ channelConnectionId: 67, productVariantIds: [1] });
    expect(f.channels.withListingWrites).not.toHaveBeenCalled();
  });
  it("checks established listings for deletion even when stock is already connected", async () => {
    const f = fixture();
    f.inventory.pending.mockResolvedValue([]);
    expect(await f.service.processDue()).toEqual({ nudged: 0, failed: 0 });
    expect(f.channels.observeListingPresence.mock.calls.map(([, sku]) => sku)).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
    expect(f.catalogItem).not.toHaveBeenCalled();
    expect(f.nudge).not.toHaveBeenCalled();
  });
  it("never nudges a missing or stopped listing and continues checking other SKUs", async () => {
    const f = fixture();
    f.channels.observeListingPresence.mockResolvedValueOnce({ sku: "SKU-1", state: "missing", externalProductId: "WPID-SKU-1", checkedAt: now.toISOString() });
    f.channels.observeListingPresence.mockRejectedValueOnce(Object.assign(new Error("Stopped"), { code: "LISTING_PUBLICATION_STOPPED" }));
    expect(await f.service.processDue()).toEqual({ nudged: 1, failed: 0 });
    expect(f.catalogItem.mock.calls.map(([sku]) => sku)).toEqual(["SKU-3"]);
    expect(f.nudge).toHaveBeenCalledExactlyOnceWith({ channelConnectionId: 67, productVariantIds: [3] });
    expect(f.logger.warn).not.toHaveBeenCalled();
  });
  it("rejects a different seller account or an unavailable fulfillment center with one WARN, no reads, no nudge", async () => {
    for (const nodes of [[], [{ shipNode: "node", shipNodeName: "Seller", nodeType: "VIRTUAL", status: "INACTIVE" }]]) {
      const f = fixture();
      f.account.mockResolvedValue({ partnerId: nodes.length ? "seller" : "another-seller", nodes });
      expect(await f.service.processDue()).toEqual({ nudged: 0, failed: 1 });
      expect(f.catalogItem).not.toHaveBeenCalled();
      expect(f.nudge).not.toHaveBeenCalled();
      expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith("channels.walmart.stock_scan", expect.objectContaining({
        outcome: "channel_failed", error_code: "WALMART_ACCOUNT_CHANGED" }));
    }
  });
  it("isolates provider failures and changed SKU identities in one WARN per pass", async () => {
    const f = fixture();
    f.catalogItem.mockImplementation(async sku => {
      if (sku === "SKU-1") throw Object.assign(new Error("unavailable"), { code: "WALMART_REQUEST_FAILED" });
      return sku === "SKU-2" ? f.item("different-sku") : f.item(sku);
    });
    expect(await f.service.processDue()).toEqual({ nudged: 1, failed: 1 });
    expect(f.nudge).toHaveBeenCalledExactlyOnceWith({ channelConnectionId: 67, productVariantIds: [3] });
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
  });
  it("rotates bounded batches so rejected SKUs cannot starve later listings", async () => {
    const f = fixture();
    f.catalogItem.mockImplementation(async sku => ({ ...f.item(sku), publishedStatus: sku === "SKU-3" ? "PUBLISHED" : "SYSTEM_PROBLEM" }));
    await f.service.processDue(1);
    await f.service.processDue(1);
    expect(await f.service.processDue(1)).toEqual({ nudged: 1, failed: 0 });
    expect(f.catalogItem.mock.calls.map(([sku]) => sku)).toEqual(["SKU-1", "SKU-2", "SKU-3"]);
  });
  it("a failed nudge is one WARN for the channel and never a link", async () => {
    const f = fixture();
    f.nudge.mockRejectedValueOnce(Object.assign(new Error("db"), { code: "57P01" }));
    expect(await f.service.processDue()).toEqual({ nudged: 0, failed: 1 });
    expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith("channels.walmart.stock_scan", expect.objectContaining({ outcome: "channel_failed" }));
  });
});

describe("verified inventory observation validation", () => {
  const input = { channelId: 104, connectionId: 67, accountId: "seller", environment: "production", externalScopeId: "node",
    productVariantId: 1, sku: "SKU-1", externalProductId: "WPID", lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED",
    observedAt: now.toISOString() };
  it.each([
    { publishedStatus: "SYSTEM_PROBLEM" }, { externalProductId: "" }, { productVariantId: -1 },
    { observedAt: "2026-10-08T13:54:59Z" }, { observedAt: "2026-10-08T14:00:01Z" }, { quantity: 999 },
    // Channels PR4: a SKU-change relink names another SKU and is never part of a listing recreation.
    { replacesSku: "SKU-1" }, { replacesSku: "OLD", setupOperationId: "00000000-0000-4000-8000-000000000001" },
  ])("rejects invalid or stale evidence before entering the inventory transaction: %j", change => {
    const store = { connect: vi.fn(), pending: vi.fn() } satisfies VerifiedListingStockStore;
    const service = new VerifiedListingStockService(store, () => now);
    expect(() => service.connect({ ...input, ...change })).toThrow();
    expect(store.connect).not.toHaveBeenCalled();
  });
});
