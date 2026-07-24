import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareChannelPolicyToLegacy,
  createChannelPolicyDraft,
  discardChannelPolicyDraft,
  saveChannelPolicyDraft,
} from "../channel-routing/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channel routing API contract", () => {
  it("creates a dynamic channel/purpose draft without provider-specific fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 12,
      channelId: 103,
      purpose: "vendor_fulfillment_charge",
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await createChannelPolicyDraft({
      channelId: 103,
      purpose: "vendor_fulfillment_charge",
      cloneActive: true,
      notes: null,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/channel-policies/drafts",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          channelId: 103,
          purpose: "vendor_fulfillment_charge",
          cloneActive: true,
          notes: null,
        }),
      }),
    );
  });

  it("sends the optimistic version and complete route replacement on save", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 12 }));
    vi.stubGlobal("fetch", fetchMock);
    const routes = [{
      originWarehouseId: null,
      destinationScopeId: 7,
      mode: "engine_quoted" as const,
      eligibilityMode: "intersection" as const,
      rateBookId: 5,
    }];

    await saveChannelPolicyDraft({
      policyId: 12,
      expectedLockVersion: 4,
      notes: "Lower 48 only",
      routes,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/channel-policies/12/draft",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          expectedLockVersion: 4,
          notes: "Lower 48 only",
          routes,
        }),
      }),
    );
  });

  it("uses the explicit compatibility profile only for recorded shadow evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      matchesLegacy: true,
      differences: [],
      snapshotId: 91,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await compareChannelPolicyToLegacy({
      policyId: 12,
      originWarehouseId: 1,
      destination: {
        country: "US",
        region: "PA",
        postalCode: "16066",
      },
      legacyProfile: "shopify",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/channel-policies/12/shadow-compare",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          originWarehouseId: 1,
          destination: {
            country: "US",
            region: "PA",
            postalCode: "16066",
          },
          legacyProfile: "shopify",
        }),
      }),
    );
  });

  it("sends the optimistic version when discarding a draft revision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 12,
      status: "retired",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await discardChannelPolicyDraft({
      policyId: 12,
      expectedLockVersion: 5,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/channel-policies/12/discard",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedLockVersion: 5 }),
      }),
    );
  });

  it("surfaces classified server details instead of discarding them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      error: {
        code: "SHIPPING_CHANNEL_POLICY_NOT_READY",
        message: "Resolve validation errors.",
        details: ["Fallback missing.", "No live rates."],
      },
    }, 409)));

    await expect(createChannelPolicyDraft({
      channelId: 36,
      purpose: "customer_checkout",
      cloneActive: false,
      notes: null,
    })).rejects.toThrow(
      "Resolve validation errors.\nFallback missing.\nNo live rates.",
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
