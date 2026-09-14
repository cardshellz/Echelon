import { describe, it, expect } from "vitest";
import { classifyCommerceOrigin } from "../../archon-commerce-origin";
describe("commerce origin", () => {
  it("preserves Shopify connector identity while classifying TikTok in direct and bridged payloads", () => {
    for (const raw of [
      { source_name: "tiktok" },
      { order: { source_name: "tiktok" } },
    ])
      expect(classifyCommerceOrigin("shopify", {}, raw)).toMatchObject({
        connector: "shopify",
        salesChannel: "tiktok_shop",
      });
  });
  it("does not mistake paid TikTok clicks or unknown app ids for TikTok Shop", () => {
    expect(
      classifyCommerceOrigin(
        "shopify",
        {},
        { source_name: "web", utm_source: "tiktok", tags: ["tiktok"] },
      ),
    ).toMatchObject({ salesChannel: "shopify_online" });
    expect(
      classifyCommerceOrigin("shopify", {}, { source_name: "3890849" }),
    ).toMatchObject({ salesChannel: "shopify_other", sourceName: "3890849" });
    expect(classifyCommerceOrigin("shopify", {}, {})).toMatchObject({
      salesChannel: "shopify_unknown",
    });
  });
  it("keeps eBay, dropship and unknown connectors separate", () => {
    expect(classifyCommerceOrigin("ebay", {}, {})).toMatchObject({
      connector: "ebay",
      salesChannel: "ebay",
    });
    expect(
      classifyCommerceOrigin("manual", { dropship: { omsChannel: true } }, {}),
    ).toMatchObject({ connector: "dropship" });
    expect(
      classifyCommerceOrigin("manual", {}, { dropship: { vendorId: 1 } }),
    ).toMatchObject({ connector: "dropship" });
    expect(classifyCommerceOrigin("manual", {}, {})).toMatchObject({
      connector: "unknown",
    });
  });
});
