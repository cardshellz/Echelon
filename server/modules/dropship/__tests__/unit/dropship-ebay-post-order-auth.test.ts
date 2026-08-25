import { describe, expect, it } from "vitest";
import {
  buildEbayPostOrderAuthorization,
} from "../../infrastructure/dropship-ebay-post-order-auth";

describe("buildEbayPostOrderAuthorization", () => {
  it("uses the IAF scheme required by eBay Post-Order APIs", () => {
    expect(buildEbayPostOrderAuthorization("access-token")).toBe("IAF access-token");
  });

  it("rejects a blank access token before issuing an HTTP request", () => {
    expect(() => buildEbayPostOrderAuthorization("   ")).toThrowError(expect.objectContaining({
      code: "DROPSHIP_EBAY_ACCESS_TOKEN_REQUIRED",
    }));
  });
});
