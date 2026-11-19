import { describe, expect, it, vi } from "vitest";
import type { StockLinkDestination } from "@shared/types/stock-link";
import { STOCK_LINK_ERROR_CODES as C, classifyStockLinkFailure } from "../../../inventory-planning/domain/stock-link-errors";
import { createWalmartStockLinkAdapter } from "../../adapters/walmart/walmart-stock-link.adapter";
import { WalmartApiError } from "../../adapters/walmart/walmart-client";
import { createChannelEbayStockLinkAdapter } from "../../adapters/ebay/ebay-stock-link.adapter";
import { EbayApiRequestError } from "../../adapters/ebay/ebay-api-error";
import { EbayInventoryQuantityError } from "../../adapters/ebay/ebay-inventory-quantity";
import { InventoryPublicationConfigurationError } from "../../channel-adapter.interface";

// Channels PR4: the Walmart and Card Shellz eBay stock-link adapters, provider I/O mocked.

const NOW = new Date("2026-10-28T12:00:00.000Z");
const signal = new AbortController().signal;
const walmartDestination: StockLinkDestination = { publicationTargetId: 2, destinationKind: "channel_connection", providerKey: "walmart",
  channelId: 36, channelConnectionId: 8, dropshipStoreConnectionId: null, providerScopeType: "location", externalScopeId: "node", targetRevision: "1" };
const ebayDestination: StockLinkDestination = { ...walmartDestination, providerKey: "ebay", providerScopeType: "account", externalScopeId: "seller" };

function walmart(item: (sku: string) => Promise<unknown>) {
  const account = vi.fn(async () => ({ partnerId: "p", nodes: [{ shipNode: "node", shipNodeName: "n", nodeType: "VIRTUAL", status: "ACTIVE" }] }));
  const channels = { connection: vi.fn(async () => ({ channel_id: 36, connection_id: 8, partner_id: "p", ship_node_id: "node",
    environment: "production", revision: 1 })), requireRuntime: vi.fn(), api: vi.fn(() => ({ account, catalogItem: vi.fn(item) })) };
  return { adapter: createWalmartStockLinkAdapter({ channels: channels as never, clock: () => NOW }), account, channels };
}
const walmartItem = (sku: string, overrides: Record<string, unknown> = {}) => ({ sku, title: sku, externalProductId: `WPID-${sku}`,
  externalVariantId: sku, externalInventoryItemId: sku, lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED", ...overrides });

describe("Walmart stock-link adapter", () => {
  it("reports an ACTIVE + PUBLISHED item with a WPID as one on-sale offer whose id is the SKU", async () => {
    const { adapter } = walmart(async sku => walmartItem(sku));
    expect(await adapter.findOffersBySku(walmartDestination, "P5", { signal })).toEqual({ observedAt: NOW.toISOString(), sku: "P5",
      marketplaceId: "WALMART_US", offers: [{ offerId: "P5", sku: "P5", status: "PUBLISHED", listingId: "WPID-P5" }] });
  });
  it.each([{ publishedStatus: "SYSTEM_PROBLEM" }, { lifecycleStatus: "RETIRED" }, { externalProductId: null }])(
    "anything else is never on sale: %j", async overrides => {
      const { adapter } = walmart(async sku => walmartItem(sku, overrides));
      expect((await adapter.findOffersBySku(walmartDestination, "P5", { signal })).offers[0]!.status).toBe("UNPUBLISHED");
    });
  it("a 404 is a complete empty answer (not listed)", async () => {
    const { adapter } = walmart(async () => { throw new WalmartApiError("WALMART_NOT_FOUND", "missing", false, 404); });
    expect((await adapter.findOffersBySku(walmartDestination, "P5", { signal })).offers).toEqual([]);
  });
  it("another inventory identity is this SKU's refusal (row permanent), never trusted", async () => {
    const { adapter } = walmart(async () => walmartItem("OTHER"));
    await expect(adapter.findOffersBySku(walmartDestination, "P5", { signal })).rejects.toMatchObject({ code: C.lookupRejected });
  });
  it.each([
    [401, C.storeAuthRefused], [429, C.providerThrottled], [503, C.providerUnavailable], [400, C.lookupRejected],
  ])("HTTP %i is classified %s", async (status, code) => {
    const { adapter } = walmart(async () => { throw new WalmartApiError("WALMART_REQUEST_FAILED", "x", status >= 500, status); });
    await expect(adapter.findOffersBySku(walmartDestination, "P5", { signal })).rejects.toMatchObject({ code });
  });
  it("a changed account pauses the store; a verified account is read once per minute", async () => {
    const changed = walmart(async sku => walmartItem(sku));
    changed.account.mockResolvedValue({ partnerId: "other", nodes: [] });
    await expect(changed.adapter.findOffersBySku(walmartDestination, "P5", { signal })).rejects.toMatchObject({ code: C.storeAuthRefused });
    expect(classifyStockLinkFailure(new Error("x")).kind).toBe("fatal");
    const ok = walmart(async sku => walmartItem(sku));
    await ok.adapter.findOffersBySku(walmartDestination, "P5", { signal });
    await ok.adapter.findOffersBySku(walmartDestination, "P6", { signal });
    expect(ok.account).toHaveBeenCalledTimes(1);
  });
  it("refuses a destination of another kind as a contract break", async () => {
    const { adapter } = walmart(async sku => walmartItem(sku));
    await expect(adapter.findOffersBySku(ebayDestination, "P5", { signal })).rejects.toMatchObject({ code: C.adapterContract });
  });
});

describe("Card Shellz eBay stock-link adapter", () => {
  const ebay = (discover: () => Promise<unknown>) => createChannelEbayStockLinkAdapter({ ebay: { discoverStockLinkOffers: discover as never },
    clock: () => NOW });
  it("returns every offer of the SKU as discovery read it", async () => {
    const adapter = ebay(async () => ({ marketplaceId: "EBAY_US", offers: [
      { offerId: "1", sku: "A", marketplaceId: "EBAY_US", status: "PUBLISHED", listingId: "L1" },
      { offerId: "2", sku: "A", marketplaceId: "EBAY_US", status: "UNPUBLISHED", listingId: null }] }));
    expect(await adapter.findOffersBySku(ebayDestination, "A", { signal })).toMatchObject({ sku: "A", marketplaceId: "EBAY_US",
      offers: [{ offerId: "1", status: "PUBLISHED", listingId: "L1" }, { offerId: "2", status: "UNPUBLISHED", listingId: null }] });
  });
  it.each([
    ["401", new EbayApiRequestError(401, "x", "{}"), C.storeAuthRefused],
    ["429", new EbayApiRequestError(429, "x", "{}"), C.providerThrottled],
    ["400", new EbayApiRequestError(400, "x", "{}"), C.lookupRejected],
    ["incomplete discovery", new EbayInventoryQuantityError("EBAY_INVENTORY_OFFERS_INCOMPLETE", "x", true), C.lookupIncomplete],
    ["another SKU in the answer", new EbayInventoryQuantityError("EBAY_INVENTORY_OFFER_SCOPE_INVALID", "x"), C.adapterContract],
    ["another verified account", new InventoryPublicationConfigurationError("EBAY_PUBLICATION_ACCOUNT_CHANGED", "x"), C.storeAuthRefused],
    ["eBay down after retries", new Error("failed after 3 retries (503)"), C.storeUnavailable],
  ])("%s is classified", async (_label, error, code) => {
    await expect(ebay(async () => { throw error; }).findOffersBySku(ebayDestination, "A", { signal })).rejects.toMatchObject({ code });
  });
});
