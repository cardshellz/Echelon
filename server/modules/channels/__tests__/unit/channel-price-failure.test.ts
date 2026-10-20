import { describe, expect, it } from "vitest";
import { ChannelPricingResolutionError } from "../../channel-pricing-resolver";
import { syncFailure } from "../../ebay-listing-sync.domain";
import { resolveEbayListingIssue } from "@shared/ebay-listing-issue";

describe("price source failures through the existing sync owner", () => {
  it("stops automatic replay and keeps the concrete correction instead of a generic sync failure", () => {
    const failure = new ChannelPricingResolutionError("RETAIL_PRICE_SOURCE_REQUIRED",
      "Multiple retail variants match this SKU. Select the exact Shopify variant link.", { variantId: 101 });
    const result = syncFailure(failure, 1, new Date("2026-10-19T12:00:00Z"));
    expect(result).toMatchObject({ state: "needs_attention", code: failure.code, message: failure.message, resetAttempts: false });
    expect(resolveEbayListingIssue({ ...result, productId: 20 })).toMatchObject({
      message: failure.message, retryable: false,
      action: { kind: "edit_listing", href: "/catalog/variants" },
    });
  });

  it("does not expose an arbitrary database error as a safe price diagnostic", () => {
    const result = syncFailure(new Error("private query and connection diagnostic"), 1, new Date("2026-10-19T12:00:00Z"));
    expect(result.message).not.toContain("private");
  });
});
