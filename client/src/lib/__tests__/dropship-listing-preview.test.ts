import { describe, expect, it } from "vitest";
import { formatListingPreviewIssue, pageListingPreviews, safeListingImageUrl } from "../dropship-listing-preview";
import type { DropshipListingPreviewRow } from "../dropship-ops-surface";

describe("product-cost preview issues", () => {
  it.each([
    ["vendor_unavailable", "Your Shellz Club account is unavailable. Contact support."],
    ["plan_unavailable", "Your .ops price list is unavailable. Contact support."],
    ["entitlement_inactive", "Your Shellz Club .ops access is inactive. Contact support."],
    ["variant_unmapped", "This product is not linked to your .ops price list. Contact support."],
    ["variant_ambiguous", "The .ops product mapping needs support review."],
    ["variant_identity_mismatch", "The product identity does not match your .ops price list. Contact support."],
    ["override_ambiguous", "The .ops product price has conflicting entries. Contact support."],
    ["override_invalid", "The .ops product price needs support review."],
    ["retail_unavailable", "The catalog retail price is unavailable. Contact support."],
    ["pricing_configuration_invalid", "Your .ops price list configuration needs support review."],
    ["source_read_failed", "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues."],
    ["product_cost_source_unavailable", "The .ops product cost could not be loaded. Refresh the preview; contact support if this continues."],
  ])("gives an actionable pricing explanation for %s", (code, label) => {
    expect(formatListingPreviewIssue(code)).toBe(label);
    expect(formatListingPreviewIssue(code)).not.toMatch(/reauth|eBay|channel discount/i);
  });
  it("retains existing setup labels and readable fallback for unrelated issues", () => {
    expect(formatListingPreviewIssue("missing_config:businessPolicies.paymentPolicyId")).toBe("eBay setup: Payment policy");
    expect(formatListingPreviewIssue("unrecognized_issue")).toBe("Unrecognized Issue");
  });
});

describe("listing preview rendering bounds", () => {
  const rows = Array.from({ length: 10000 }, (_, index) => ({ productVariantId: index + 1, title: `Product ${index + 1}`, sku: `SKU-${index + 1}` } as DropshipListingPreviewRow));
  it("mounts one bounded page without mutating or sorting the source", () => {
    expect(pageListingPreviews(rows, "", 2)).toMatchObject({ page: 2, pages: 200, total: 10000, start: 51, end: 100 });
    expect(pageListingPreviews(rows, "", 2).rows).toHaveLength(50);
    expect(rows[0].productVariantId).toBe(1);
  });
  it("clamps pages after filtering and handles no results/invalid page numbers", () => {
    expect(pageListingPreviews(rows, " sku-10000 ", 200)).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(pageListingPreviews(rows, "no match", 200)).toMatchObject({ page: 1, start: 0, end: 0, total: 0 });
    expect(pageListingPreviews(rows, "", NaN).page).toBe(1);
  });
});

describe("preview media URL boundary", () => {
  it.each(["https://images.example.test/photo.jpg", "http://images.example.test/photo.jpg", "/api/dropship/listings/stores/1/variants/2/assets/3/file"])("accepts intended image route %s", (url) => {
    expect(safeListingImageUrl(url)).toBe(url);
  });
  it.each(["javascript:alert(1)", "data:image/svg+xml,<svg/>", "//images.example.test/a", "/api/product-assets/3/file", "/api/dropship/settings", "https://user:secret@example.test/a", " https://example.test/a", "https://example.test/\na", "https:\\example.test/a", "", null])("rejects unsafe/unauthorized URL %s", (url) => {
    expect(safeListingImageUrl(url)).toBeNull();
  });
});
