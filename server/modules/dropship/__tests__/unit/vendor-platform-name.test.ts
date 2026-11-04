import { describe, expect, it } from "vitest";
import { vendorPlatformName } from "../../domain/vendor-platform-name";

describe("vendorPlatformName", () => {
  it("names the marketplace as a vendor reads it in an alert", () => {
    expect(vendorPlatformName("ebay")).toBe("eBay");
    expect(vendorPlatformName("shopify")).toBe("Shopify");
  });

  it("says 'marketplace' for a platform it does not know, never the stored code", () => {
    expect(vendorPlatformName("amazon")).toBe("marketplace");
    expect(vendorPlatformName(null)).toBe("marketplace");
    expect(vendorPlatformName(undefined)).toBe("marketplace");
    expect(vendorPlatformName("")).toBe("marketplace");
  });
});
