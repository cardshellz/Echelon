import { describe, expect, it, vi } from "vitest";
import { insertChannelFeedSchema } from "@shared/schema";
import { indexInventoryIdentities } from "../../channel-identity.domain";
import { ShopifyIdentityReader, type ShopifyIdentityConnection } from "../../adapters/shopify-identity.reader";

const connection: ShopifyIdentityConnection = {
  id: 7, channelId: 2, shopDomain: "second-store.myshopify.com", accessToken: "test-only",
  apiVersion: "2024-01", shopifyLocationId: "20",
};
const item = (variantId: number, itemId: string) => ({ productVariantId: variantId, externalInventoryItemId: itemId,
  externalVariantId: `variant-${variantId}`, externalProductId: null, externalSku: "SAME-SKU" });
const response = (body: unknown, headers?: HeadersInit) => new Response(JSON.stringify(body), { headers });

describe("channel-scoped identity boundary", () => {
  it("permits a null identity only for an inactive retained feed", () => {
    const base = {
      channelId: 2,
      productVariantId: 1,
      channelType: "shopify",
      channelVariantId: null,
    };
    expect(insertChannelFeedSchema.safeParse({
      ...base,
      isActive: 0,
    }).success).toBe(true);
    expect(insertChannelFeedSchema.safeParse({
      ...base,
      isActive: 1,
    }).success).toBe(false);
  });

  it("uses internal IDs, not shared SKU text, for reverse mapping", () => {
    expect([...indexInventoryIdentities([item(1, "101"), item(2, "102")])]).toEqual([["101", 1], ["102", 2]]);
  });
  it.each([[item(1, "101"), item(2, "101")], [item(1, "101"), item(1, "102")]])("rejects ambiguous reverse identities", (...identities) => {
    expect(() => indexInventoryIdentities(identities)).toThrow("not one-to-one");
  });
  it("verifies a variant only against its selected store", async () => {
    const request = vi.fn().mockResolvedValue(response({ variant: { id: 3, product_id: 4, inventory_item_id: 5, sku: "SKU" } }));
    const result = await new ShopifyIdentityReader(request).variant(connection, "3");
    expect(result).toEqual({ id: "3", product_id: "4", inventory_item_id: "5", sku: "SKU" });
    expect(request).toHaveBeenCalledWith("https://second-store.myshopify.com/admin/api/2024-01/variants/3.json", expect.objectContaining({ method: "GET", redirect: "error" }));
  });
  it("rejects a different returned variant", async () => {
    const reader = new ShopifyIdentityReader(vi.fn().mockResolvedValue(response({ variant: { id: 99, product_id: 4, inventory_item_id: 5, sku: "SKU" } })));
    await expect(reader.variant(connection, "3")).rejects.toMatchObject({ code: "SHOPIFY_IDENTITY_RESPONSE_INVALID" });
  });
  it.each([-1, null, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe quantity %s instead of converting it to zero", async (available) => {
    const reader = new ShopifyIdentityReader(vi.fn().mockResolvedValue(response({ inventory_levels: [{ inventory_item_id: 5, location_id: 20, available }] })));
    await expect(reader.inventory(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_RESPONSE_INVALID" });
  });
  it("reads all pages and preserves actual zero quantities", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 5, location_id: 20, available: 0 }] }, { Link: '<https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=next>; rel="next"' }))
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 6, location_id: 20, available: 8 }] }));
    expect([...await new ShopifyIdentityReader(request).inventory(connection, "20")]).toEqual([["5", 0], ["6", 8]]);
    expect(request.mock.calls[1][0]).toContain("page_info=next");
  });
  it("does not follow provider pagination onto another host", async () => {
    const request = vi.fn().mockResolvedValue(response({ inventory_levels: [] }, { Link: '<https://attacker.example/inventory_levels.json?page_info=next>; rel="next"' }));
    await expect(new ShopifyIdentityReader(request).inventory(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_PAGINATION_INVALID" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["2024-01", "2025-10"])("pins the served version when the next link uses %s", async (linkVersion) => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 5, location_id: 20, available: null }] }, {
        "X-Shopify-API-Version": "2025-10", Link: `<https://second-store.myshopify.com/admin/api/${linkVersion}/inventory_levels.json?limit=1&page_info=next&location_ids=999>; rel="next"`,
      }))
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 6, location_id: 20, available: 0 }] }, { "X-Shopify-API-Version": "2025-10" }));
    expect([...await new ShopifyIdentityReader(request).inventoryLevels(connection, "20")]).toEqual([["5", null], ["6", 0]]);
    expect(request.mock.calls[1]![0]).toBe("https://second-store.myshopify.com/admin/api/2025-10/inventory_levels.json?page_info=next&limit=250");
    expect(request.mock.calls[1]![1]).toMatchObject({ redirect: "error", method: "GET" });
    expect(connection.apiVersion).toBe("2024-01");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("continues on the pinned version across three pages after a retired-version link", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 5, location_id: 20, available: 8 }] }, {
        "X-Shopify-API-Version": "2025-10", Link: '<https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=first>; rel="next"',
      }))
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 6, location_id: 20, available: null }] }, {
        "X-Shopify-API-Version": "2025-10", Link: '<https://second-store.myshopify.com/admin/api/2025-10/inventory_levels.json?page_info=second>; rel="next"',
      }))
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 7, location_id: 20, available: 0 }] }, { "X-Shopify-API-Version": "2025-10" }));
    expect([...await new ShopifyIdentityReader(request).inventoryLevels(connection, "20")]).toEqual([["5", 8], ["6", null], ["7", 0]]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?location_ids=20&limit=250",
      "https://second-store.myshopify.com/admin/api/2025-10/inventory_levels.json?page_info=first&limit=250",
      "https://second-store.myshopify.com/admin/api/2025-10/inventory_levels.json?page_info=second&limit=250",
    ]);
  });
  it.each([
    "https://second-store.myshopify.com/admin/api/2026-01/inventory_levels.json?page_info=next",
    "https://second-store.myshopify.com/admin/api/2024-01/products.json?page_info=next",
    "https://other-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=next",
    "http://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=next",
    "https://second-store.myshopify.com:8443/admin/api/2024-01/inventory_levels.json?page_info=next",
    "https://user:password@second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=next",
    "https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=next#fragment",
    "https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?limit=250",
    "https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=",
    "https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=a&page_info=b",
  ])("retains pagination scope protections during version fallback: %s", async (href) => {
    const request = vi.fn().mockResolvedValueOnce(response({ inventory_levels: [] }, {
      "X-Shopify-API-Version": "2025-10", Link: `<${href}>; rel="next"`,
    }));
    await expect(new ShopifyIdentityReader(request).inventoryLevels(connection, "20"))
      .rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_PAGINATION_INVALID" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { version: "2025-10", linkVersion: "2025-10", cursor: "same", reason: "repeated cursor" },
    { version: "2026-01", linkVersion: "2026-01", cursor: "different", reason: "changed served version" },
    { version: "2025-10", linkVersion: "2024-01", cursor: "different", reason: "old version after pinning" },
  ])("rejects $reason on a subsequent page without returning partial stock", async ({ version, linkVersion, cursor }) => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 5, location_id: 20, available: 8 }] }, {
        "X-Shopify-API-Version": "2025-10", Link: '<https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=same>; rel="next"',
      }))
      .mockResolvedValueOnce(response({ inventory_levels: [{ inventory_item_id: 6, location_id: 20, available: 0 }] }, {
        "X-Shopify-API-Version": version, Link: `<https://second-store.myshopify.com/admin/api/${linkVersion}/inventory_levels.json?page_info=${cursor}>; rel="next"`,
      }));
    await expect(new ShopifyIdentityReader(request).inventoryLevels(connection, "20"))
      .rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_PAGINATION_INVALID" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    '<https://second-store.myshopify.com/admin/api/2025-10/inventory_levels.json?page_info=next>; rel="next"',
    '<https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=a&page_info=b>; rel="next"',
    '<not-a-url>; rel="next"',
    '<https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=a>; rel="next", <https://second-store.myshopify.com/admin/api/2024-01/inventory_levels.json?page_info=b>; rel="next"',
  ])("rejects untrusted version changes and ambiguous next links", async (Link) => {
    const request = vi.fn().mockResolvedValue(response({ inventory_levels: [] }, { Link }));
    await expect(new ShopifyIdentityReader(request).inventoryLevels(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_PAGINATION_INVALID" });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects a served version changing between pages", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(response({ inventory_levels: [] }, { "X-Shopify-API-Version": "2025-10", Link: '<https://second-store.myshopify.com/admin/api/2025-10/inventory_levels.json?page_info=next>; rel="next"' }))
      .mockResolvedValueOnce(response({ inventory_levels: [] }, { "X-Shopify-API-Version": "2026-01" }));
    await expect(new ShopifyIdentityReader(request).inventoryLevels(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_PAGINATION_INVALID" });
  });
  it("rejects duplicate identities even when the first quantity is unknown", async () => {
    const request = vi.fn().mockResolvedValue(response({ inventory_levels: [
      { inventory_item_id: 5, location_id: 20, available: null }, { inventory_item_id: 5, location_id: 20, available: 0 },
    ] }));
    await expect(new ShopifyIdentityReader(request).inventoryLevels(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_SCOPE_AMBIGUOUS" });
  });
  it("rejects a different warehouse location before returning any observations", async () => {
    const request = vi.fn().mockResolvedValue(response({ inventory_levels: [{ inventory_item_id: 5, location_id: 21, available: 3 }] }));
    await expect(new ShopifyIdentityReader(request).inventory(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_SCOPE_AMBIGUOUS" });
  });
  it("classifies rate limits as retryable without exposing response content", async () => {
    const request = vi.fn().mockResolvedValue(new Response("private provider response", { status: 429 }));
    await expect(new ShopifyIdentityReader(request).variant(connection, "3")).rejects.toMatchObject({ code: "SHOPIFY_IDENTITY_READ_REJECTED", failureClass: "transient" });
  });
});
