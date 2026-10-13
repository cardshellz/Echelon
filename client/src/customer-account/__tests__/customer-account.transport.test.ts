import { describe, it, expect, vi } from "vitest";
import { createCustomerAccountTransport } from "../customer-account.transport";

const config = { themeId: "174740308127", customerId: "100", proxyPath: "/apps/echelon-returns" };
const connection = { connectionId: 4, channelId: 2, name: "Shopify", shopDomain: "fixture.myshopify.com", enabled: true, paymentWindowMinutes: 30 };
const key = "a".repeat(43);
const bootstrap = { session: { authenticated: true, privateTesting: true, sessionKey: key }, connection };
describe("storefront transport reuses canonical clients", () => {
  it("sends every call through the dedicated same-origin proxy with JSON inputs and account binding", async () => {
    const request = vi.fn(async () => Response.json(bootstrap));
    const api = createCustomerAccountTransport(config, request);
    await api.bootstrap();
    request.mockImplementation(async () => Response.json({ omsOrderId: 9, connectionId: 4, externalOrderId: "99" }));
    await api.resolve({ orderReference: "#10", externalOrderId: "99" });
    const [url, options] = request.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/apps/echelon-returns/account"); expect(options.credentials).toBe("same-origin");
    expect(JSON.parse(String(options.body))).toEqual({ themeId: config.themeId, expectedCustomerId: "100", method: "POST", path: "/account/resolve", query: {}, body: { orderReference: "#10", externalOrderId: "99" }, sessionKey: key });
  });
  it("preserves catalog context and variant response validation instead of calculating member prices", async () => {
    const request = vi.fn(async () => Response.json(bootstrap)); const api = createCustomerAccountTransport(config, request); await api.bootstrap();
    request.mockImplementation(async () => Response.json({ connectionId: 4, input: { after: null }, categories: ["Toploaders"], pageInfo: { hasNextPage: false, endCursor: null } }));
    expect((await api.edits.catalogCategories(4, { after: null })).categories).toEqual(["Toploaders"]);
    const body = JSON.parse(String((request.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(body.path).toBe("/order-edits/catalog/categories"); expect(body.query).toEqual({ connectionId: "4" });
    expect(body.sessionKey).toBe(key);
  });
  it("rejects external requests and unsupported methods before network calls", async () => {
    const request = vi.fn(); const api = createCustomerAccountTransport(config, request);
    await expect(api.request("https://evil.test/api/returns/customer/returns/1")).rejects.toThrow();
    await expect(api.request("/api/order-edits/admin/settings/4", { method: "PUT" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
