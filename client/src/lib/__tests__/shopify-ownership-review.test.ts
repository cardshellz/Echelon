import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchShopifyOwnershipReview,
} from "../shopify-ownership-review";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Shopify ownership review API", () => {
  it("requests one bounded read-only ownership page", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      generatedAt: "2026-07-26T12:00:00.000Z",
      readOnly: true,
      channel: {
        id: 36,
        name: "Shopify",
        shopDomain: "cardshellz.myshopify.com",
      },
      summary: {
        duplicateOwnershipGroupCount: 1,
        canonicalOwnerRecommendationCount: 1,
        manualReviewOwnershipGroupCount: 0,
      },
      filter: "canonical_owner_recommended",
      pagination: {
        page: 2,
        pageSize: 20,
        totalItems: 21,
        totalPages: 2,
      },
      items: [{
        shopifyProductId: "9001",
        remoteTitle: "100PT Toploader",
        remoteStatus: "ACTIVE",
        shippingGroupCode: "protection",
        ownerProductIds: [10, 11],
        owners: [
          {
            productId: 10,
            productName: "100PT Toploader",
            productSku: "SHLZ-TOP-100PT",
            shopifyProductId: "9001",
            shippingGroupCode: "protection",
            mappingStatus: "consistent",
            activeVariantCount: 2,
            activeVariantIssueCount: 0,
            hasChannelEvidence: true,
          },
          {
            productId: 11,
            productName: "Archived duplicate",
            productSku: null,
            shopifyProductId: null,
            shippingGroupCode: "protection",
            mappingStatus: "channel_only",
            activeVariantCount: 0,
            activeVariantIssueCount: 0,
            hasChannelEvidence: true,
          },
        ],
        decision: "canonical_owner_recommended",
        reason: "single_active_owner_with_matching_evidence",
        recommendedProductId: 10,
        nonCanonicalProductIds: [11],
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchShopifyOwnershipReview({
      channelId: 36,
      filter: "canonical_owner_recommended",
      page: 2,
      pageSize: 20,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/36/shopify-mapping-reconciliation/ownership-review?filter=canonical_owner_recommended&page=2&pageSize=20",
      { credentials: "include" },
    );
    expect(result.readOnly).toBe(true);
    expect(result.items[0].recommendedProductId).toBe(10);
  });

  it("rejects an invalid success payload at the client boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      readOnly: false,
      items: [],
    })));

    await expect(fetchShopifyOwnershipReview({
      channelId: 36,
      filter: "all",
      page: 1,
      pageSize: 20,
    })).rejects.toThrow("Ownership review returned an invalid response");
  });

  it("surfaces a classified server message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: "Shopify mapping verification remained rate limited",
      code: "SHOPIFY_MAPPING_LOOKUP_RATE_LIMITED",
    }, 503)));

    await expect(fetchShopifyOwnershipReview({
      channelId: 36,
      filter: "all",
      page: 1,
      pageSize: 20,
    })).rejects.toThrow(
      "Shopify mapping verification remained rate limited",
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
