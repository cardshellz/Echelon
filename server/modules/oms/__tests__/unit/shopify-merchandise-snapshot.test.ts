import { describe, expect, it, vi } from "vitest";
import { readShopifyMerchandiseSnapshot } from "../../infrastructure/shopify-merchandise-snapshot";

const input = { orderId: "1", shopDomain: "synthetic.myshopify.com" };
function page(overrides: Record<string, unknown> = {}) {
  return { shop: { myshopifyDomain: input.shopDomain }, order: { id: "gid://shopify/Order/1",
    updatedAt: "2026-10-24T12:00:00.000Z", cancelledAt: null,
    lineItems: { nodes: [{ id: "gid://shopify/LineItem/11", quantity: 2, currentQuantity: 1, unfulfilledQuantity: 1 }],
      pageInfo: { hasNextPage: false, endCursor: null } }, ...overrides } };
}
describe("Shopify merchandise readback", () => {
  it("reads quantities without executing a financial or cancellation command", async () => {
    const request = vi.fn().mockResolvedValue(page());
    expect(await readShopifyMerchandiseSnapshot({ request }, input)).toMatchObject({
      orderId: "gid://shopify/Order/1", cancelled: false, lines: [{ quantity: 2, currentQuantity: 1 }],
    });
    expect(request.mock.calls[0][0]).toMatch(/^query /);
    expect(request.mock.calls[0][0]).not.toMatch(/mutation|refundCreate|orderCancel/);
  });
  it("collects all pages from one source version", async () => {
    const first = page();
    first.order.lineItems.pageInfo = { hasNextPage: true, endCursor: "next" } as typeof first.order.lineItems.pageInfo;
    const second = page(); second.order.lineItems.nodes[0].id = "gid://shopify/LineItem/12";
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect((await readShopifyMerchandiseSnapshot({ request }, input)).lines).toHaveLength(2);
    expect(request.mock.calls[1][1].after).toBe("next");
  });
  it.each([ { id: "gid://shopify/Order/2" }, { updatedAt: "invalid" }, { lineItems: null } ])(
    "rejects malformed or mismatched evidence: %j", async override => {
      await expect(readShopifyMerchandiseSnapshot({ request: vi.fn().mockResolvedValue(page(override)) }, input)).rejects.toThrow();
    });
  it("rejects another shop and partial snapshots", async () => {
    const wrongShop = page(); wrongShop.shop.myshopifyDomain = "other.myshopify.com";
    await expect(readShopifyMerchandiseSnapshot({ request: vi.fn().mockResolvedValue(wrongShop) }, input)).rejects.toThrow();
    const first = page(); first.order.lineItems.pageInfo = { hasNextPage: true, endCursor: "next" } as typeof first.order.lineItems.pageInfo;
    const changed = page({ updatedAt: "2026-10-24T12:01:00.000Z" });
    await expect(readShopifyMerchandiseSnapshot({ request: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(changed) }, input)).rejects.toThrow();
    await expect(readShopifyMerchandiseSnapshot({ request: vi.fn().mockResolvedValue(first) }, input)).rejects.toThrow();
  });
});
