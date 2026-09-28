import { describe, expect, it } from "vitest";
import { EBAY_SELL_LOCALE, ebaySellRequestHeaders } from "../../infrastructure/ebay-sell-headers";

describe("ebaySellRequestHeaders", () => {
  it("sends the locale on every call and the content locale on writes, as the channel client does", () => {
    expect(ebaySellRequestHeaders({ accessToken: "tok", method: "GET", marketplaceId: "EBAY_US" })).toEqual({
      Authorization: "Bearer tok",
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    });
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      expect(ebaySellRequestHeaders({ accessToken: "tok", method, marketplaceId: "EBAY_US" })).toMatchObject({
        "Accept-Language": EBAY_SELL_LOCALE,
        "Content-Language": EBAY_SELL_LOCALE,
      });
    }
  });

  it("leaves the marketplace header out of a call that is not marketplace-scoped", () => {
    const headers = ebaySellRequestHeaders({ accessToken: "tok", method: "POST" });
    expect(headers).not.toHaveProperty("X-EBAY-C-MARKETPLACE-ID");
    expect(ebaySellRequestHeaders({ accessToken: "tok", method: "GET", marketplaceId: null })).not.toHaveProperty("X-EBAY-C-MARKETPLACE-ID");
  });
});
