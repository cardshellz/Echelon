import { describe, expect, it, vi } from "vitest";
import { ChannelCatalogService, matchChannelCatalog, type ChannelCatalogRepository, type ChannelCatalogProvider } from "../../channel-catalog.service";
import { WalmartUsApi } from "../../adapters/walmart/walmart-us-api";
import type { ChannelCatalogItem, ChannelCatalogVariant } from "@shared/types/channel-catalog";

const item = (sku = "SKU-1"): ChannelCatalogItem => ({ sku, title: "Product", externalProductId: "WPID",
  externalVariantId: sku, externalInventoryItemId: sku, lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED" });
const variant = (id = 11, sku = "SKU-1"): ChannelCatalogVariant => ({ id, sku, name: "Local product", eligible: true });
const account = { channelId: 7, connectionId: 9, provider: "walmart" };
const now = new Date("2026-09-22T12:00:00Z");
function setup() {
  const repository = { candidates: vi.fn<ChannelCatalogRepository["candidates"]>(async () => ({ variants: [variant()], mappings: [] })),
    searchVariants: vi.fn<ChannelCatalogRepository["searchVariants"]>(async () => []), saveMappings: vi.fn<ChannelCatalogRepository["saveMappings"]>() };
  const provider = { account: vi.fn(async () => account), item: vi.fn<ChannelCatalogProvider["item"]>(async (_account, sku) => item(sku)),
    list: vi.fn<ChannelCatalogProvider["list"]>(async () => ({ items: [item()], nextCursor: "next", total: 2 })) };
  return { repository, provider, service: new ChannelCatalogService(repository, provider, () => now) };
}
describe("shared channel catalog identity", () => {
  it("matches exact identities and refuses ambiguous, unavailable and occupied variants", () => {
    expect(matchChannelCatalog([item()], [variant()], [])[0].mappingStatus).toBe("matched");
    expect(matchChannelCatalog([item()], [variant(11, "sku-1")], [])[0].mappingStatus).toBe("unmatched");
    expect(matchChannelCatalog([item()], [variant(), variant(12)], [])[0].mappingStatus).toBe("conflict");
    expect(matchChannelCatalog([item()], [{ ...variant(), eligible: false }], [])[0].mappingStatus).toBe("unavailable");
    const mapping = { productVariantId: 11, sku: "SKU-1", externalVariantId: "SKU-1", externalInventoryItemId: "SKU-1", active: true };
    expect(matchChannelCatalog([item()], [variant()], [mapping])[0].mappingStatus).toBe("linked");
    expect(matchChannelCatalog([item()], [variant()], [{ ...mapping, active: false }])[0].mappingStatus).toBe("conflict");
    expect(matchChannelCatalog([item()], [variant()], [{ ...mapping, sku: "OTHER" }])[0].mappingStatus).toBe("conflict");
  });
  it("preserves provider pagination and fails closed on duplicate or invalid responses", async () => {
    const s = setup();
    expect(await s.service.list(7, { cursor: "token" })).toMatchObject({ nextCursor: "next", total: 2, items: [{ mappingStatus: "matched" }] });
    expect(s.provider.list).toHaveBeenCalledWith(account, { cursor: "token" });
    s.provider.list.mockResolvedValue({ items: [item(), item()], nextCursor: null, total: 2 });
    await expect(s.service.list(7, {})).rejects.toMatchObject({ code: "CHANNEL_CATALOG_DUPLICATE_SKU" });
    await expect(s.service.list(7, { cursor: "" })).rejects.toThrow();
  });
  it("verifies every provider identity before saving one atomic batch with actor and clock", async () => {
    const s = setup();
    await expect(s.service.link(7, { mappings: [{ sku: "SKU-1", productVariantId: 11 }, { sku: "SKU-2", productVariantId: 12 }] }, "operator")).resolves.toEqual({ linked: 2 });
    expect(s.repository.saveMappings).toHaveBeenCalledExactlyOnceWith(account, [
      { item: item(), productVariantId: 11, expectedLocalSku: null }, { item: item("SKU-2"), productVariantId: 12, expectedLocalSku: null },
    ], "operator", now);
  });
  it.each(["wrong identity", "provider failure"])("saves nothing on %s", async failure => {
    const s = setup();
    if (failure === "wrong identity") s.provider.item.mockResolvedValue(item("WRONG"));
    else s.provider.item.mockRejectedValue(new Error("unavailable"));
    await expect(s.service.link(7, { mappings: [{ sku: "SKU-1", productVariantId: 11 }] }, "operator")).rejects.toThrow();
    expect(s.repository.saveMappings).not.toHaveBeenCalled();
  });
  it.each([
    [{ sku: "SKU-1", productVariantId: 11 }, { sku: "SKU-1", productVariantId: 12 }],
    [{ sku: "SKU-1", productVariantId: 11 }, { sku: "SKU-2", productVariantId: 11 }],
    [], [{ sku: "SKU-1", productVariantId: 0 }],
  ])("rejects invalid batches before provider calls: %j", async (...mappings) => {
    const s = setup();
    await expect(s.service.link(7, { mappings }, "operator")).rejects.toThrow();
    expect(s.provider.account).not.toHaveBeenCalled();
  });
  it("automatically links only unique exact unoccupied variants with a write-time SKU guard", async () => {
    const s = setup();
    s.repository.candidates.mockResolvedValue({ variants: [variant(), variant(12, "DUP"), variant(13, "DUP"),
      { ...variant(14, "INACTIVE"), eligible: false }, variant(15, "OCCUPIED")], mappings: [
        { productVariantId: 15, sku: "OLD", externalVariantId: "OLD", externalInventoryItemId: "OLD", active: true },
      ] });
    await s.service.linkExactSkus(7, ["SKU-1", "SKU-1", "DUP", "INACTIVE", "OCCUPIED", "MISSING"], "intake");
    expect(s.provider.item).toHaveBeenCalledExactlyOnceWith(account, "SKU-1");
    expect(s.repository.saveMappings).toHaveBeenCalledWith(account, [{ item: item(), productVariantId: 11, expectedLocalSku: "SKU-1" }], "intake", now);
  });
});

describe("Walmart thin catalog translation", () => {
  it("translates documented ItemResponse fields and cursor without importing price floats", async () => {
    const request = vi.fn(async () => ({ ItemResponse: [{ sku: "A/B", productName: "Title", wpid: "W1", price: { amount: 1.23 }, mart: "WALMART_US" }], nextCursor: "abc+/=", totalItems: 51 }));
    const api = new WalmartUsApi({ request } as never);
    const result = await api.catalogPage({ cursor: "abc+/=" });
    expect(request).toHaveBeenCalledWith("GET", "/v3/items?limit=50&nextCursor=abc%2B%2F%3D");
    expect(result).toEqual({ items: [{ ...item("A/B"), title: "Title", externalProductId: "W1", lifecycleStatus: "UNKNOWN", publishedStatus: "UNKNOWN" }], nextCursor: "abc+/=", total: 51 });
  });
  it("uses exact encoded SKU lookup and rejects a mismatched identity", async () => {
    const request = vi.fn(async () => ({ ItemResponse: [{ sku: "A/B" }] }));
    const api = new WalmartUsApi({ request } as never);
    await api.catalogPage({ sku: "A/B" });
    expect(request).toHaveBeenCalledWith("GET", "/v3/items/A%2FB?productIdType=SKU");
    await expect(api.catalogItem("WRONG")).rejects.toMatchObject({ code: "WALMART_SKU_MISMATCH" });
  });
  it.each([{ ItemResponse: [{ sku: "SKU", mart: "WALMART_CA" }] }, { ItemResponse: [{}] }, {}])("rejects malformed or non-US catalog data", async payload => {
    await expect(new WalmartUsApi({ request: vi.fn(async () => payload) } as never).catalogPage({})).rejects.toMatchObject({ code: "WALMART_RESPONSE_INVALID" });
  });
  it("handles an empty catalog and refuses truncated pagination", async () => {
    const request = vi.fn(async (): Promise<unknown> => ({ ItemResponse: [], totalItems: 0 }));
    const api = new WalmartUsApi({ request } as never);
    expect(await api.catalogPage({})).toEqual({ items: [], nextCursor: null, total: 0 });
    request.mockResolvedValue({ ItemResponse: Array.from({ length: 50 }, (_, i) => ({ sku: `SKU-${i}` })), totalItems: 51 });
    await expect(api.catalogPage({})).rejects.toMatchObject({ code: "WALMART_CATALOG_CURSOR_MISSING" });
  });
});
