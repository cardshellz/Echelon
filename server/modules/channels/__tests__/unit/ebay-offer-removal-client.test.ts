import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayApiClient } from "../../adapters/ebay/ebay-api.client";
import type { EbayQuantityRequestAdmission } from "../../quantity-publication-request";

const admission: EbayQuantityRequestAdmission = {
  item: async (_sku, work) => work(null),
  group: async (_key, _skus, work) => work(null),
  reducing: async (_identity, work) => work(),
};
function client(request: typeof fetch): EbayApiClient {
  return new EbayApiClient({ getAccessToken: async () => "test-token" }, 67, "production",
    { request, quantityAdmission: async () => admission });
}
afterEach(() => vi.restoreAllMocks());

describe("exact eBay offer removal sends once before lifecycle observation", () => {
  it.each([500, 503, 429])("returns HTTP %i to its operation owner without repeating DELETE", async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ sku: "EXACT-SKU" }))
      .mockResolvedValue(new Response("provider failure", { status }));
    await expect(client(request).deleteOffer("offer/exact")).rejects.toThrow();
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE"]);
    expect(request).toHaveBeenLastCalledWith("https://api.ebay.com/sell/inventory/v1/offer/offer%2Fexact",
      expect.objectContaining({ method: "DELETE" }));
  });
  it.each(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "fetch failed"])("returns %s without repeating DELETE", async code => {
    const failure = Object.assign(new Error(code), { code });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ sku: "EXACT-SKU" })).mockRejectedValue(failure);
    await expect(client(request).deleteOffer("offer-exact")).rejects.toBe(failure);
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE"]);
  });
  it("preserves successful deletion and typed absence for the operation owner", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ sku: "EXACT-SKU" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(client(request).deleteOffer("offer-exact")).resolves.toBeUndefined();
    await expect(client(request).deleteOffer("offer-exact")).rejects.toMatchObject({ statusCode: 404 });
    expect(request.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE", "GET"]);
  });
  it("preserves existing retry behavior for a provider read", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(Response.json({ offerId: "offer-exact" }));
    await expect(client(request).getOffer("offer-exact")).resolves.toEqual({ offerId: "offer-exact" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
