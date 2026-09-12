import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyShopifyOwnershipRepair,
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
        remoteExists: true,
        remoteTitle: "100PT Toploader",
        remoteStatus: "ACTIVE",
        remoteShippingGroupCode: "protection",
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
            mappingFingerprint: "fingerprint-10",
            activeVariantCount: 2,
            activeVariantIssueCount: 0,
            hasChannelEvidence: true,
            hasCanonicalChannelProductEvidence: true,
          },
          {
            productId: 11,
            productName: "Archived duplicate",
            productSku: null,
            shopifyProductId: null,
            shippingGroupCode: "protection",
            mappingStatus: "channel_only",
            mappingFingerprint: "fingerprint-11",
            activeVariantCount: 0,
            activeVariantIssueCount: 0,
            hasChannelEvidence: true,
            hasCanonicalChannelProductEvidence: true,
          },
        ],
        decision: "canonical_owner_recommended",
        reason: "single_active_owner_with_matching_evidence",
        recommendedProductId: 10,
        nonCanonicalProductIds: [11],
        previewHash: "a".repeat(64),
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

  it("submits and validates an idempotent ownership repair command", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: 1,
      commandId: 71,
      channelId: 36,
      shopDomain: "cardshellz.myshopify.com",
      previewHash: "b".repeat(64),
      resolvedGroupCount: 1,
      recommendedProductIds: [10],
      detachedProductIds: [11, 12],
      resolvedGroups: [{
        shopifyProductId: "9001",
        recommendedProductId: 10,
        detachedProductIds: [11, 12],
      }],
      clearedCatalogProductCount: 2,
      clearedCatalogVariantCount: 2,
      detachedFeedCount: 2,
      resetListingCount: 2,
      completedAt: "2026-07-26T12:00:00.000Z",
      idempotentReplay: false,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      expectedShopDomain: "cardshellz.myshopify.com",
      recommendations: [{
        shopifyProductId: "9001",
        expectedPreviewHash: "a".repeat(64),
      }],
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      reason: "Detach reviewed inactive duplicates",
    };

    await expect(applyShopifyOwnershipRepair({
      channelId: 36,
      request,
    })).resolves.toMatchObject({
      commandId: 71,
      detachedProductIds: [11, 12],
      idempotentReplay: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/channels/36/shopify-mapping-reconciliation/ownership-review/apply",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  });

  it("rejects a repair receipt whose group manifest omits a detached owner", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      contractVersion: 1,
      commandId: 71,
      channelId: 36,
      shopDomain: "cardshellz.myshopify.com",
      previewHash: "b".repeat(64),
      resolvedGroupCount: 1,
      recommendedProductIds: [10],
      detachedProductIds: [11, 12],
      resolvedGroups: [{
        shopifyProductId: "9001",
        recommendedProductId: 10,
        detachedProductIds: [11],
      }],
      clearedCatalogProductCount: 2,
      clearedCatalogVariantCount: 0,
      detachedFeedCount: 0,
      resetListingCount: 0,
      completedAt: "2026-07-26T12:00:00.000Z",
      idempotentReplay: false,
    })));

    await expect(applyShopifyOwnershipRepair({
      channelId: 36,
      request: {
        expectedShopDomain: "cardshellz.myshopify.com",
        recommendations: [{
          shopifyProductId: "9001",
          expectedPreviewHash: "a".repeat(64),
        }],
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174009",
        reason: "Detach reviewed inactive duplicates",
      },
    })).rejects.toThrow("Ownership repair returned an invalid response");
  });

  it("preserves the classified repair error code for recovery decisions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: "Shopify ownership evidence changed after review.",
      code: "SHOPIFY_OWNERSHIP_REPAIR_PREVIEW_STALE",
    }, 409)));

    await expect(applyShopifyOwnershipRepair({
      channelId: 36,
      request: {
        expectedShopDomain: "cardshellz.myshopify.com",
        recommendations: [{
          shopifyProductId: "9001",
          expectedPreviewHash: "a".repeat(64),
        }],
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
        reason: "Detach reviewed inactive duplicates",
      },
    })).rejects.toMatchObject({
      status: 409,
      code: "SHOPIFY_OWNERSHIP_REPAIR_PREVIEW_STALE",
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}
