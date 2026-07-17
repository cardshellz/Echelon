import { describe, expect, it } from "vitest";
import { normalizeShopifyOrderGid } from "../../shopify-order-id";

describe("normalizeShopifyOrderGid", () => {
  it("converts REST numeric IDs to the canonical database GID", () => {
    expect(normalizeShopifyOrderGid(12161715011743)).toBe(
      "gid://shopify/Order/12161715011743",
    );
    expect(normalizeShopifyOrderGid("12161715011743")).toBe(
      "gid://shopify/Order/12161715011743",
    );
  });

  it("preserves a valid order GID", () => {
    expect(normalizeShopifyOrderGid("gid://shopify/Order/12161715011743")).toBe(
      "gid://shopify/Order/12161715011743",
    );
  });

  it("rejects malformed and non-order identifiers", () => {
    expect(() => normalizeShopifyOrderGid("not-an-id")).toThrow(RangeError);
    expect(() =>
      normalizeShopifyOrderGid("gid://shopify/Product/12161715011743"),
    ).toThrow(RangeError);
  });
});
