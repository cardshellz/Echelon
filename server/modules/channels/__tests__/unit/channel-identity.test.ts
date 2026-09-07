import { describe, expect, it, vi } from "vitest";
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
  it("rejects a different warehouse location before returning any observations", async () => {
    const request = vi.fn().mockResolvedValue(response({ inventory_levels: [{ inventory_item_id: 5, location_id: 21, available: 3 }] }));
    await expect(new ShopifyIdentityReader(request).inventory(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_SCOPE_AMBIGUOUS" });
  });
  it("classifies rate limits as retryable without exposing response content", async () => {
    const request = vi.fn().mockResolvedValue(new Response("private provider response", { status: 429 }));
    await expect(new ShopifyIdentityReader(request).variant(connection, "3")).rejects.toMatchObject({ code: "SHOPIFY_IDENTITY_READ_REJECTED", failureClass: "transient" });
  });
  it("classifies malformed JSON without exposing provider content", async () => {
    const request = vi.fn().mockResolvedValue(new Response("private invalid JSON"));
    await expect(new ShopifyIdentityReader(request).variant(connection, "3")).rejects.toMatchObject({ code: "SHOPIFY_IDENTITY_RESPONSE_INVALID" });
  });
  it("rejects malformed pagination before making another request", async () => {
    const request = vi.fn().mockResolvedValue(response({ inventory_levels: [] }, { Link: '<not-a-url>; rel="next"' }));
    await expect(new ShopifyIdentityReader(request).inventory(connection, "20")).rejects.toMatchObject({ code: "SHOPIFY_INVENTORY_PAGINATION_INVALID" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
